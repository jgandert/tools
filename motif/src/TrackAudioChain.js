import { Motif, Bus, parseDurationToSeconds } from "../motif.js";
import {
    trackRegistry,
    applyParamModulation,
    safeDisconnect,
    reconnectNodes,
    CONSTANTS,
} from "./helpers.js";

let _dspProcCounter = 0;

/**
 * Registry of dynamic parameter initializers and resolvers for dynamic target modulation.
 * Maps string keys (e.g. 'filter.cutoff') to initializer and resolver functions.
 * @type {Map<string, {init: (inst: Object, ctx: AudioContext, time: number) => void, resolve: (inst: Object) => AudioParam}>}
 * @private
 */
const PARAM_RESOLVERS = new Map();

/**
 * Defines a set of parameters with an initialization function and a resolver function.
 * @param {Array<string>} keys - Parameter string identifiers.
 * @param {(inst: Object, ctx: AudioContext, time: number) => void} initFn - Node initializer.
 * @param {(inst: Object, key: string) => AudioParam} resolveFnMap - Maps instance and key to AudioParam.
 * @private
 */
function defineParams(keys, initFn, resolveFnMap) {
    for (const key of keys) {
        PARAM_RESOLVERS.set(key, {
            init: initFn,
            resolve: (inst) => resolveFnMap(inst, key),
        });
    }
}

// 1. Filter parameters
defineParams(
    ["filter.cutoff", "filter.frequency", "filter.resonance", "filter.Q", "filter.gain"],
    (inst, ctx, time) => {
        if (!inst.filterNode) {
            inst.filterNode = ctx.createBiquadFilter();
            inst.filterNode.type = CONSTANTS.FILTER.DEFAULT_TYPE;
            inst.filterNode.frequency.setValueAtTime(CONSTANTS.FILTER.DEFAULT_CUTOFF, time);
            inst.filterNode.Q.setValueAtTime(CONSTANTS.FILTER.DEFAULT_Q, time);
            inst._rebuildSignalChain();
        }
    },
    (inst, key) => {
        if (key === "filter.resonance" || key === "filter.Q") return inst.filterNode.Q;
        if (key === "filter.gain") return inst.filterNode.gain;
        return inst.filterNode.frequency;
    },
);

// 2. Stereo Panner
defineParams(
    ["pan"],
    (inst, ctx, time) => {
        if (!inst.pannerNode) {
            if (typeof ctx.createStereoPanner !== "function") return;
            inst.pannerNode = ctx.createStereoPanner();
            inst.pannerNode.pan.setValueAtTime(CONSTANTS.PANNER.DEFAULT_PAN, time);
            inst._rebuildSignalChain();
        }
    },
    (inst) => inst.pannerNode ? inst.pannerNode.pan : null,
);

// 3. Volume / Gain parameters
defineParams(
    ["volume", "gain"],
    (inst, ctx, time) => {
        if (!inst.volumeNode) {
            inst.volumeNode = ctx.createGain();
            inst.volumeNode.gain.setValueAtTime(CONSTANTS.VOLUME.DEFAULT_GAIN, time);
            inst._rebuildSignalChain();
        }
    },
    (inst) => inst.volumeNode.gain,
);

// 4. EQ parameters
defineParams(
    ["eq.low", "eq.mid", "eq.high"],
    (inst, ctx, time) => {
        if (!inst.eqLowNode) {
            inst.eqLowNode = ctx.createBiquadFilter();
            inst.eqLowNode.type = "lowshelf";
            inst.eqLowNode.frequency.setValueAtTime(CONSTANTS.EQ.LOW_FREQ, time);
            inst.eqLowNode.gain.setValueAtTime(CONSTANTS.EQ.DEFAULT_GAIN, time);
            inst.eqMidNode = ctx.createBiquadFilter();
            inst.eqMidNode.type = "peaking";
            inst.eqMidNode.frequency.setValueAtTime(CONSTANTS.EQ.MID_FREQ, time);
            inst.eqMidNode.Q.setValueAtTime(CONSTANTS.EQ.MID_Q, time);
            inst.eqMidNode.gain.setValueAtTime(CONSTANTS.EQ.DEFAULT_GAIN, time);
            inst.eqHighNode = ctx.createBiquadFilter();
            inst.eqHighNode.type = "highshelf";
            inst.eqHighNode.frequency.setValueAtTime(CONSTANTS.EQ.HIGH_FREQ, time);
            inst.eqHighNode.gain.setValueAtTime(CONSTANTS.EQ.DEFAULT_GAIN, time);
            inst._rebuildSignalChain();
        }
    },
    (inst, key) => {
        if (key === "eq.mid") return inst.eqMidNode.gain;
        if (key === "eq.high") return inst.eqHighNode.gain;
        return inst.eqLowNode.gain;
    },
);

// 5. Compressor parameters
defineParams(
    ["compress.threshold", "compress.ratio", "compress.knee", "compress.attack", "compress.release"],
    (inst, ctx, time) => {
        if (!inst.compressorNode) {
            inst.compressorNode = ctx.createDynamicsCompressor();
            inst._rebuildSignalChain();
        }
    },
    (inst, key) => {
        if (key === "compress.ratio") return inst.compressorNode.ratio;
        if (key === "compress.knee") return inst.compressorNode.knee;
        if (key === "compress.attack") return inst.compressorNode.attack;
        if (key === "compress.release") return inst.compressorNode.release;
        return inst.compressorNode.threshold;
    },
);

/**
 * Mixin object containing audio chain construction, processing, parameters, and routing methods.
 */
export const TrackAudioChain = {
    /**
     * Initializes structural states, buffers, properties, and map registers for the audio chain.
     * @private
     */
    _initAudioChain() {
        this._isMuted = false;
        this._preMuteGain = 1.0;
        this.trackInputNode = null;
        this.muteGainNode = null;
        this.preFaderNode = null;
        this._sends = new Map();
        this._modulators = new Map();
        this.duckGainNode = null;
        this._sidechainListeners = [];
        this._sidechainConnections = [];
        this._outputNode = null;
        this._mergerIndex = null;
        this._useSplitStereo = false;
        this._rightTrack = null;
        this._mergerNode = null;
        this._monoChannel = null;
        this._gainLevel = 1.0;
        this.dspNode = null;
        this._dspReady = null;
    },

    /**
     * Rebuilds and connects the sequence of active audio nodes in the track's signal chain.
     * @private
     */
    _rebuildSignalChain() {
        if (!this.trackInputNode) return;

        const nodes = [
            this.trackInputNode,
            this.filterNode,
            this.distortionNode,
            this.dspNode,
            this.pannerNode,
            this.eqLowNode,
            this.eqMidNode,
            this.eqHighNode,
            this.compressorNode,
            this.preFaderNode,
            this.volumeNode,
            this.duckGainNode,
            this.muteGainNode,
        ];

        const destination = this._outputNode || Motif.masterGain;
        this._currentDestination = destination;

        const mergerIndex = (this._mergerIndex !== null && this._mergerIndex !== undefined) ? this._mergerIndex : 0;
        reconnectNodes(nodes, destination, 0, mergerIndex);

        if (this._sends && this.preFaderNode) {
            for (const sendGainNode of this._sends.values()) {
                this.preFaderNode.connect(sendGainNode);
            }
        }
    },

    /**
     * Smoothly crossfades out the current track's signal while fading in a new track instance.
     * @param {Object} newTrack - The new TrackClass instance to crossfade in.
     * @param {number} [duration=1.0] - The duration of the crossfade in seconds.
     * @private
     */
    _crossfadeOut(newTrack, duration = 1.0) {
        if (!this.muteGainNode || !Motif.ctx) return;

        const ctx = Motif.ctx;
        const now = ctx.currentTime;
        const dest = this._currentDestination || Motif.masterGain;

        newTrack._initAudio();
        newTrack.muteGainNode.gain.setValueAtTime(0, now);
        newTrack.muteGainNode.gain.linearRampToValueAtTime(newTrack._isMuted ? 0 : 1, now + duration);

        const currentGain = this.muteGainNode.gain.value;
        this.muteGainNode.gain.cancelScheduledValues(now);
        this.muteGainNode.gain.setValueAtTime(currentGain, now);
        this.muteGainNode.gain.linearRampToValueAtTime(0, now + duration);

        const oldMuteGain = this.muteGainNode;
        setTimeout(() => {
            safeDisconnect(oldMuteGain, dest);
            if (typeof this._stopAllVoices === "function") {
                this._stopAllVoices();
            } else if (typeof this._resetScheduling === "function") {
                this._resetScheduling();
            }
            const internalNodes = [
                "trackInputNode", "preFaderNode", "muteGainNode",
                "filterNode", "pannerNode", "volumeNode",
                "eqLowNode", "eqMidNode", "eqHighNode",
                "compressorNode", "distortionNode", "dspNode",
                "duckGainNode", "_mergerNode"
            ];
            for (const prop of internalNodes) {
                if (this[prop]) {
                    safeDisconnect(this[prop]);
                }
            }
        }, duration * 1000);
    },

    /**
     * Instantiates base gain nodes, faders, and routing configurations for the Web Audio graph.
     * @private
     */
    _initAudio() {
        if (this.muteGainNode) return;
        Motif.init();
        const ctx = Motif.ctx;

        if (this._useSplitStereo && !this._mergerNode) {
            this._mergerNode = ctx.createChannelMerger(2);
            this._mergerNode.connect(Motif.masterGain);
        }

        this.trackInputNode = ctx.createGain();
        this.trackInputNode.gain.setValueAtTime(1.0, ctx.currentTime);

        this.preFaderNode = ctx.createGain();
        this.preFaderNode.gain.setValueAtTime(1.0, ctx.currentTime);

        this.muteGainNode = ctx.createGain();
        this.muteGainNode.gain.setValueAtTime(this._isMuted ? 0 : 1.0, ctx.currentTime);

        this._rebuildSignalChain();
    },

    /**
     * Sets the track gain level using scalar float values, infinity, or decibel strings.
     * @param {number|string} level - Scalar gain level, -Infinity, or decibel string (e.g. "-3dB").
     * @returns {TrackAudioChain} this
     */
    gain(level) {
        if (level && level.isRamp === true) {
            this._gainRampsQueue = this._gainRampsQueue || [];
            this._gainRampsQueue.push(level);
            return this;
        }

        let targetLevel = level;
        if (typeof level === "string") {
            const cleaned = level.trim().replace("−", "-");
            const match = cleaned.match(/^(-?(?:\d+(?:\.\d+)?|inf(?:inity)?))\s*dB$/i);
            if (match) {
                const valStr = match[1].toLowerCase();
                let db;
                if (valStr.includes("inf")) {
                    db = valStr.startsWith("-") ? -Infinity : Infinity;
                } else {
                    db = parseFloat(match[1]);
                }
                targetLevel = db === -Infinity ? 0 : Math.pow(10, db / 20);
            } else {
                // Strictly parse as scalar only if it's a pure number string
                if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
                    targetLevel = parseFloat(cleaned);
                } else if (/^-?inf(?:inity)?$/i.test(cleaned)) {
                    targetLevel = cleaned.startsWith("-") ? 0 : Infinity;
                } else {
                    // Fallback to 1.0 for invalid strings to avoid dangerous values
                    targetLevel = 1.0;
                }
            }
        }

        this._gainLevel = targetLevel;

        // Apply immediately to the track's input gain node if it exists
        if (this.trackInputNode && typeof targetLevel === "number" && !isNaN(targetLevel)) {
            const ctx = Motif.ctx;
            this.trackInputNode.gain.setValueAtTime(targetLevel, ctx.currentTime);
        }

        return this;
    },

    /**
     * Decouples stereophonic channels into separate signal paths (Left on main, Right on shadow track).
     * @param {(rightTrack: Object) => void} [modifier] - Optional custom modifier to configure the shadow track.
     * @returns {TrackAudioChain} this
     */
    splitStereo(modifier) {
        this._useSplitStereo = true;
        this._monoChannel = 0; // Main track becomes Left
        this._mergerIndex = 0;

        this._initAudio();

        if (!this._rightTrack) {
            this._rightTrack = new this.constructor(this.id + "_right");
        }

        this._rightTrack._monoChannel = 1; // Right
        this._rightTrack._mergerIndex = 1;
        this._rightTrack._outputNode = this._mergerNode;
        this._rightTrack._useSplitStereo = false;

        // Sync patterns and types
        if (this._notePattern) this._rightTrack.note(this._notePattern);
        if (this._freqPattern) this._rightTrack.freq(this._freqPattern);
        this._rightTrack.synth(this._synthType);

        // Sync sampler/sample state
        this._rightTrack._useSample = this._useSample;
        this._rightTrack._sampleUrl = this._sampleUrl;
        this._rightTrack._sampleBuffer = this._sampleBuffer;
        this._rightTrack._useSampler = this._useSampler;
        this._rightTrack._samplerBuffers = this._samplerBuffers;
        this._rightTrack._samplerKeys = this._samplerKeys;
        this._rightTrack._samplerRelease = this._samplerRelease;

        this._rightTrack._initAudio();

        // Route both to merger
        this._outputNode = this._mergerNode;
        this._rebuildSignalChain();
        this._rightTrack._rebuildSignalChain();

        // Register shadow track for independent scheduling
        trackRegistry.set(this._rightTrack.id, this._rightTrack);

        if (typeof modifier === "function") {
            modifier(this._rightTrack);
        }

        return this;
    },

    /**
     * Connects a pre-fader auxiliary send signal to an effects bus with adjustable gain.
     * @param {string|Object} bus - Bus identifier or bus instance to send signal to.
     * @param {number} [amount=1.0] - Send gain amount.
     * @returns {TrackAudioChain} this
     */
    send(bus, amount) {
        const ctx = Motif.ctx;

        let busInstance;
        if (typeof bus === "string") {
            busInstance = Bus(bus);
        } else {
            busInstance = bus;
        }

        if (!busInstance) {
            throw new Error("Invalid bus passed to send().");
        }

        const key = busInstance.id;
        let sendGainNode = this._sends.get(key);

        if (!sendGainNode) {
            sendGainNode = ctx.createGain();
            this._sends.set(key, sendGainNode);

            // Connect pre-fader signal to sendGainNode
            this.preFaderNode.connect(sendGainNode);

            // Connect sendGainNode to bus input
            sendGainNode.connect(busInstance.input);
        }

        // Set amount
        const gainVal = typeof amount === "number" ? amount : 1.0;
        sendGainNode.gain.setValueAtTime(gainVal, ctx.currentTime);

        return this;
    },

    /**
     * Helper to resolve an AudioParam object by string key name.
     * @param {string|AudioParam} parameter - Name key (e.g. 'filter.cutoff') or native AudioParam.
     * @returns {AudioParam|null} The resolved AudioParam.
     * @private
     */
    _resolveParam(parameter) {
        if (parameter && typeof parameter.setValueAtTime === "function") {
            return parameter;
        }
        if (typeof parameter !== "string") return null;

        const resolver = PARAM_RESOLVERS.get(parameter);
        if (!resolver) return null;

        const ctx = Motif.ctx;
        const time = ctx.currentTime;

        resolver.init(this, ctx, time);
        return resolver.resolve(this);
    },

    /**
     * Connects a dynamic modulator (LFO, another Track, or custom node) to a specific AudioParam.
     * @param {string|AudioParam} parameter - Target parameter string key or native AudioParam.
     * @param {Object} source - The modulator track or node source to connect.
     * @param {Object} [options] - Modulation options.
     * @param {number} [options.depth=1] - Modulation depth multiplier.
     * @returns {TrackAudioChain} this
     */
    modulate(parameter, source, { depth = 1 } = {}) {
        const ctx = Motif.ctx;

        const param = this._resolveParam(parameter);
        if (!param) return this;

        let sourceNode = null;
        if (source && source._isTrack) {
            source._initAudio();
            sourceNode = source.preFaderNode;
        } else if (source && source.output && typeof source.output.connect === "function") {
            sourceNode = source.output;
        } else if (source && typeof source.connect === "function") {
            sourceNode = source;
        }
        if (!sourceNode) return this;

        const key = parameter;
        if (this._modulators.has(key)) {
            const prev = this._modulators.get(key);
            safeDisconnect(prev.depthGain, prev.param);
        }

        const depthGain = ctx.createGain();
        depthGain.gain.setValueAtTime(depth, ctx.currentTime);
        sourceNode.connect(depthGain);
        depthGain.connect(param);

        this._modulators.set(key, { depthGain, sourceNode, param });

        return this;
    },

    /**
     * Enqueues sidechain compression ducking on this track when triggered by target events.
     * @param {Object} target - The source track triggers triggering the sidechain ducking.
     * @param {Object} [options] - Ducking attack and release parameters.
     * @param {number} [options.attack=0.005] - Sidechain envelope attack in seconds.
     * @param {number} [options.release=0.2] - Sidechain envelope release in seconds.
     * @returns {TrackAudioChain} this
     */
    sidechain(target, { attack = 0.005, release = 0.2 } = {}) {
        const ctx = Motif.ctx;

        if (!this.duckGainNode) {
            this.duckGainNode = ctx.createGain();
            this.duckGainNode.gain.setValueAtTime(1.0, ctx.currentTime);
            this._rebuildSignalChain();
        }

        const duckGain = this.duckGainNode.gain;
        const listener = (eventTime) => {
            const t = eventTime;
            if (typeof duckGain.cancelAndHoldAtTime === "function") {
                duckGain.cancelAndHoldAtTime(t);
            } else {
                duckGain.cancelScheduledValues(t);
            }
            duckGain.setValueAtTime(1, t);
            duckGain.exponentialRampToValueAtTime(0.0001, t + attack);
            duckGain.exponentialRampToValueAtTime(1, t + attack + release);
        };

        if (target && target._isTrack) {
            target._sidechainListeners.push(listener);
        }

        this._sidechainConnections.push({ target, listener });

        return this;
    },

    /**
     * Feedback control sentinel placeholder.
     * @param {Object} options - Feedback options.
     * @returns {TrackAudioChain} this
     */
    feedback(options) {
        return this;
    },

    /**
     * Registers a custom AudioWorklet DSP callback to process multi-channel inputs and outputs directly.
     * @param {Function} callback - AudioWorklet process method block callback.
     * @returns {TrackAudioChain} this
     */
    dsp(callback) {
        if (typeof callback !== "function") return this;
        const ctx = Motif.ctx;
        if (!ctx || !ctx.audioWorklet) return this;

        const name = `dsp-proc-${_dspProcCounter++}`;
        const src = callback.toString();
        const code = [
            `class DspProcessor extends AudioWorkletProcessor {`,
            `  process(inputs, outputs, parameters) {`,
            `    return (${src}).call(this, inputs, outputs, parameters);`,
            `  }`,
            `}`,
            `registerProcessor('${name}', DspProcessor);`,
        ].join("\n");

        const blob = new Blob([code], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);

        this._dspReady = ctx.audioWorklet.addModule(url).then(() => {
            URL.revokeObjectURL(url);
            this.dspNode = new AudioWorkletNode(ctx, name);
            this._rebuildSignalChain();
        }).catch(err => {
            URL.revokeObjectURL(url);
            console.error("AudioWorklet DSP load failed:", err);
        });

        return this;
    },

    /**
     * Mutes or unmutes the track by ramping the output gain.
     * @param {boolean} [state] - Desired mute state. Toggles current state if omitted.
     * @returns {TrackAudioChain} this
     */
    mute(state) {
        const ctx = Motif.ctx;
        const shouldMute = typeof state === "boolean" ? state : !this._isMuted;

        if (shouldMute) {
            if (!this._isMuted) {
                this._preMuteGain = this.muteGainNode.gain.value;
                this.muteGainNode.gain.setValueAtTime(0, ctx.currentTime);
                this._isMuted = true;
            }
        } else {
            if (this._isMuted) {
                this.muteGainNode.gain.setValueAtTime(this._preMuteGain, ctx.currentTime);
                this._isMuted = false;
            }
        }
        return this;
    },

    /**
     * Unmutes the track (alias to mute(false)).
     * @returns {TrackAudioChain} this
     */
    unmute() {
        return this.mute(false);
    },
};
