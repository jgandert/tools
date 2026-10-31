import { Motif, Bus } from "../motif.js";
import {
    trackRegistry,
    applyParamModulation,
    disconnectParamModulation,
    disposeModulationBindings,
    safeDisconnect,
    reconnectNodes,
    CONSTANTS,
    notifySourceReadinessChange,
} from "./helpers.js";

import { ensureSynthWorklet } from "./TrackVoiceManager.js";
let _feedbackWarned = false;

// Wet-mix level for the internal feedback-delay send created by Track.delay().
// Kept below unity so the (undelayed) dry copy passing through the send bus
// doesn't overpower the original signal.
const DELAY_SEND_AMOUNT = 0.5;

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
    (inst, ctx) => {
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
        this._dspCallback = null;
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

        const internalNodes = [
            "trackInputNode", "preFaderNode", "muteGainNode",
            "filterNode", "pannerNode", "volumeNode",
            "eqLowNode", "eqMidNode", "eqHighNode",
            "compressorNode", "distortionNode",
            "duckGainNode", "_mergerNode", "_gainSignalGate",
        ];

        const disconnectInternalNodes = (track) => {
            track._clearGainSignal();
            disposeModulationBindings(track);
            for (const prop of internalNodes) {
                if (track[prop]) safeDisconnect(track[prop]);
            }
        };

        const stopTrack = (track) => {
            if (typeof track._stopAllVoices === "function") {
                track._stopAllVoices();
            } else if (typeof track._resetScheduling === "function") {
                track._resetScheduling();
            }
        };

        const oldMuteGain = this.muteGainNode;
        const rightTrack = this._rightTrack;
        setTimeout(() => {
            safeDisconnect(oldMuteGain, dest);
            stopTrack(this);
            disconnectInternalNodes(this);

            if (this._sends) {
                for (const sendGainNode of this._sends.values()) {
                    safeDisconnect(sendGainNode);
                }
            }

            if (rightTrack) {
                stopTrack(rightTrack);
                disconnectInternalNodes(rightTrack);
                if (rightTrack._sends) {
                    for (const sendGainNode of rightTrack._sends.values()) {
                        safeDisconnect(sendGainNode);
                    }
                }
                if (trackRegistry.get(rightTrack.id) === rightTrack) {
                    trackRegistry.delete(rightTrack.id);
                    notifySourceReadinessChange();
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

        this.trackInputNode = ctx.createGain();
        this._applyGainLevel();

        this.preFaderNode = ctx.createGain();
        this.preFaderNode.gain.setValueAtTime(1.0, ctx.currentTime);

        this.muteGainNode = ctx.createGain();
        this.muteGainNode.gain.setValueAtTime(this._isMuted ? 0 : 1.0, ctx.currentTime);

        this._rebuildSignalChain();
    },

    _applyGainLevel() {
        const ctx = Motif.ctx;
        const param = this.trackInputNode.gain;
        this._clearGainSignal();
        param.cancelScheduledValues?.(ctx.currentTime);
        const level = this._gainLevel;
        const signal = level && (typeof level.connect === "function" ? level : level.output);
        if (signal && typeof signal.connect === "function") {
            // A gate preserves modulation until a future arranged Ramp actually starts.
            this._gainSignalGate = ctx.createGain();
            param.setValueAtTime(0, ctx.currentTime);
            applyParamModulation(this, this._gainSignalGate, signal, "_gainSignal");
            this._gainSignalGate.connect(param);
            return;
        }
        param.setValueAtTime(typeof level === "number" && !isNaN(level) ? level : 1, ctx.currentTime);
    },

    _clearGainSignal() {
        if (!this._gainSignalGate) return;
        disconnectParamModulation(this, "_gainSignal");
        safeDisconnect(this._gainSignalGate);
        this._gainSignalGate = null;
        this._gainSignal = null;
        this._gainSignalStopTime = null;
        this._gainSignalRamp = null;
    },

    _suspendGainSignal(time, ramp) {
        if (!this._gainSignalGate) return;
        if (time <= Motif.ctx.currentTime) {
            this._clearGainSignal();
            return;
        }
        if (this._gainSignalRamp !== ramp && time >= (this._gainSignalStopTime ?? Infinity)) return;
        const gate = this._gainSignalGate.gain;
        gate.cancelScheduledValues(Motif.ctx.currentTime);
        gate.setValueAtTime(1, Motif.ctx.currentTime);
        gate.setValueAtTime(0, time);
        this._gainSignalStopTime = time;
        this._gainSignalRamp = ramp;
    },

    /**
     * Sets the track gain level using scalar values, decibel strings, signals, or Ramps.
     * @param {number|string|Object} level - Linear gain, decibel string, Signal, or Ramp.
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

        // Track gain owns level changes for both active and future voices.
        if ((typeof targetLevel === "number" && !isNaN(targetLevel)) ||
            (targetLevel && (typeof targetLevel.connect === "function" || typeof targetLevel.output?.connect === "function"))) {
            if (this.trackInputNode) this._applyGainLevel();
            for (const ramp of this._scheduledRamps || []) {
                if (ramp.scheduled) ramp.overridden = true;
            }
            this._gainRampsQueue = [];
        }

        return this;
    },

    /**
     * Decouples stereophonic channels into separate signal paths (Left on main, Right on shadow track).
     * @param {(rightTrack: Object) => void} [modifier] - Optional custom modifier to configure the shadow track.
     * @returns {TrackAudioChain} this
     */
    splitStereo(modifier) {
        const rightId = this.id + "_right";
        const existingRight = trackRegistry.get(rightId);
        if (existingRight && existingRight !== this._rightTrack && existingRight._splitParent?.id !== this.id) {
            throw new Error(`splitStereo reserves Track ID "${rightId}"; choose another Track ID.`);
        }
        this._useSplitStereo = true;
        this._monoChannel = 0; // Main track becomes Left
        this._mergerIndex = 0;

        // Replacement crossfades can initialize audio before stereo routing.
        Motif.init();
        if (!this._mergerNode) {
            this._mergerNode = Motif.ctx.createChannelMerger(2);
            this._mergerNode.connect(Motif.masterGain);
        }
        this._initAudio();

        if (!this._rightTrack) {
            this._rightTrack = new this.constructor(rightId);
        }

        this._rightTrack._splitParent = this;
        this._rightTrack._monoChannel = 1; // Right
        this._rightTrack._mergerIndex = 1;
        this._rightTrack._outputNode = this._mergerNode;
        this._rightTrack._useSplitStereo = false;

        // Sync patterns and types
        if (this._hasPitchPattern && this._freqPattern === null) this._rightTrack.note(this._notePattern);
        if (this._freqPattern) this._rightTrack.freq(this._freqPattern);
        this._rightTrack.synth(this._synthType);
        if (this._dspCallback) this._rightTrack.dsp(this._dspCallback);

        this._rightTrack._copySplitSource(this);
        if (this._sliceIndices !== null) this._rightTrack.pattern(this._sliceIndices);

        this._rightTrack._initAudio();

        // Route both to merger
        this._outputNode = this._mergerNode;
        this._rebuildSignalChain();
        this._rightTrack._rebuildSignalChain();

        // Register shadow track for independent scheduling
        trackRegistry.set(this._rightTrack.id, this._rightTrack);
        notifySourceReadinessChange();

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
            safeDisconnect(prev.sourceNode, prev.depthGain);
            safeDisconnect(prev.depthGain);
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

        let targetTrack = target;
        if (typeof target === "string") {
            targetTrack = trackRegistry.get(target);
            if (!targetTrack) {
                if (!globalThis._pendingSidechains) {
                    globalThis._pendingSidechains = new Map();
                }
                if (!globalThis._pendingSidechains.has(target)) {
                    globalThis._pendingSidechains.set(target, []);
                }
                globalThis._pendingSidechains.get(target).push(listener);
            }
        }

        if (targetTrack && targetTrack._isTrack) {
            if (!Array.isArray(targetTrack._sidechainListeners)) {
                targetTrack._sidechainListeners = [];
            }
            targetTrack._sidechainListeners.push(listener);
        }

        this._sidechainConnections.push({ target: targetTrack || target, listener });

        return this;
    },

    /**
     * Sentinel placeholder: feedback delay is only implemented on Bus, not Track.
     * Warns once (across all tracks) so callers notice the no-op instead of silently
     * losing the effect.
     * @param {Object} options - Feedback options (ignored).
     * @returns {TrackAudioChain} this
     */
    feedback(options) {
        if (!_feedbackWarned) {
            _feedbackWarned = true;
            console.warn("[Motif] feedback() is only supported on Bus; Track.feedback() is a no-op.");
        }
        return this;
    },

    /**
     * Sugar for a feedback-delay (echo) effect. Lazily creates an internal,
     * per-track Bus (`<id>__delay`) carrying a feedback loop, then routes this
     * track into it via a send. Repeated calls reuse the same bus; omitted time
     * preserves its current delay while an explicit time updates it.
     * @param {Object} [options] - Delay options.
     * @param {number|string} [options.time] - Delay time (seconds, or a musical duration string like "3/16"); initially defaults to "3/16".
     * @param {number} [options.feedback=0.3] - Feedback amount (0..0.95); higher = longer tail.
     * @returns {TrackAudioChain} this
     */
    delay({ time, feedback = 0.3 } = {}) {
        this._initAudio();

        let amount = typeof feedback === "number" ? feedback : 0.3;
        if (!Number.isFinite(amount)) amount = 0.3;
        amount = Math.min(Math.max(amount, 0), 0.95);

        const delayBusId = `${this.id}__delay`;
        const liveBus = Bus(delayBusId);
        const requestedTime = time === undefined && !liveBus.feedbackDelayNode ? "3/16" : time;

        // A live-coder hot reload may have pruned+disposed the previous internal
        // delay bus and replaced it with a fresh registry entry. If our stored
        // reference is stale, drop the orphaned send (still wired to the disposed
        // bus input) so we re-route to the live bus instead of a dead one.
        if (this._delayBus && this._delayBus !== liveBus) {
            const staleSend = this._sends.get(delayBusId);
            if (staleSend) {
                safeDisconnect(staleSend);
                this._sends.delete(delayBusId);
            }
        }

        this._delayBus = liveBus;

        // Mark the bus as this track's internal delay bus so Bus.pruneExcept keeps
        // it alive while the owner track survives a hot reload, and disposeTrack
        // tears it down when the owner track is pruned.
        this._delayBus._isInternalDelayBus = true;
        this._delayBus._ownerTrackId = this.id;

        this._delayBus.feedback({ amount, time: requestedTime });

        this.send(this._delayBus, DELAY_SEND_AMOUNT);
        return this;
    },

    /**
     * Transforms each voice sample before its envelope and track effects.
     * @param {Function} callback - Receives {t, p, i, freq, state, sampleRate, channel}; returns a finite sample number.
     * @returns {TrackAudioChain} this
     */
    dsp(callback) {
        if (typeof callback !== "function") throw new TypeError("DSP callback must be a function");
        this._dspCallback = callback;
        if (Motif.ctx) {
            this._dspReady = ensureSynthWorklet(Motif.ctx);
            Motif._loadingSamples.push(this._dspReady);
        }
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
