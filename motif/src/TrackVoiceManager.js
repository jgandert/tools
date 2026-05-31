import {
    Motif,
    noteToMidi,
    midiToHz,
    parseDurationToSeconds,
    Tie,
    degreeToMidi,
} from "../motif.js";
import {
    sampleBufferCache,
    getNoiseBuffer,
    applyParamModulation,
    safeStop,
    safeDisconnect,
    CONSTANTS,
} from "./helpers.js";

const MOTIF_SYNTH_PROCESSOR_SRC = `
globalThis.TWO_PI = Math.PI * 2.0;

class MotifSynthProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{ name: 'frequency', defaultValue: 440, minValue: 20, maxValue: 20000, automationRate: 'a-rate' }];
    }

    constructor() {
        super();
        this._synthFn = null;
        this._phase = 0;
        this._time = 0;
        this._state = {};
        this._startTime = null;
        this._endTime = null;
        this._done = false;

        this.port.onmessage = ({ data }) => {
            if (data.type === 'REGISTER_SYNTH') {
                this._synthFn = (new Function('return ' + data.code))();
            } else if (data.type === 'START') {
                this._startTime = data.startTime;
            } else if (data.type === 'STOP_AT') {
                this._endTime = data.endTime;
            } else if (data.type === 'STOP') {
                this._done = true;
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (this._done) return false;
        if (!this._synthFn || this._startTime === null) return true;

        const output = outputs[0];
        if (!output || !output[0]) return true;

        const ch = output[0];
        const freqArr = parameters.frequency;
        const isARate = freqArr.length > 1;

        for (let i = 0; i < ch.length; i++) {
            const t = currentTime + i / sampleRate;

            if (t < this._startTime) {
                ch[i] = 0;
                continue;
            }

            if (this._endTime !== null && t >= this._endTime) {
                ch[i] = 0;
                if (!this._done) {
                    this._done = true;
                    this.port.postMessage({ type: 'VOICE_ENDED' });
                }
                continue;
            }

            const freq = isARate ? freqArr[i] : freqArr[0];
            ch[i] = this._synthFn({ t: this._time, p: this._phase, freq, state: this._state, sampleRate });
            this._time += 1 / sampleRate;
            this._phase = (this._phase + freq / sampleRate) % 1.0;
        }

        for (let c = 1; c < output.length; c++) output[c].set(ch);

        return !this._done;
    }
}

registerProcessor('motif-synth-voice', MotifSynthProcessor);
`;

let _synthWorkletCtx = null;
let _synthWorkletPromise = null;
let _synthWorkletLoaded = false;

function _ensureSynthWorklet(ctx) {
    if (!ctx.audioWorklet) return Promise.reject(new Error("AudioWorklet not supported"));
    if (_synthWorkletCtx === ctx && _synthWorkletPromise) return _synthWorkletPromise;
    _synthWorkletCtx = ctx;
    _synthWorkletLoaded = false;
    const blob = new Blob([MOTIF_SYNTH_PROCESSOR_SRC], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    _synthWorkletPromise = ctx.audioWorklet.addModule(url).then(() => {
        URL.revokeObjectURL(url);
        _synthWorkletLoaded = true;
    });
    return _synthWorkletPromise;
}

/**
 * Mixin object managing synthesis type, envelope settings, sample playing,
 * voice stealing algorithms, and monophonic/polyphonic Web Audio routing.
 */
export const TrackVoiceManager = {
    /**
     * Initializes voice configuration properties, buffers, arrays, and map registers.
     * @private
     */
    _initVoiceManager() {
        this._synthType = "sine";
        this._voiceLimit = Infinity;
        this._voiceMode = "none";
        this._activeVoices = new Map();
        this._envelope = null;
        this._sampleUrl = null;
        this._sampleBuffer = null;
        this._sampleLoading = null;
        this._useSample = false;
        this._samplerBuffers = new Map();
        this._samplerKeys = [];
        this._samplerRelease = 0.1;
        this._samplerLoading = null;
        this._useSampler = false;
        this._slices = null;
        this._sliceIndices = null;
        this._fitDuration = null;
        this._monoBufferCache = null;
    },

    /**
     * Configures the synthesis oscillator type (e.g., 'sine', 'sawtooth', 'fm', 'pluck', 'noise').
     * @param {string} type - Oscillator or custom synthesis name.
     * @returns {TrackVoiceManager} this
     */
    synth(type) {
        this._synthType = type || "sine";
        this._useSample = false;
        this._sampleBuffer = null;
        this._sampleUrl = null;
        this._sampleLoading = null;
        this._useSampler = false;
        this._samplerBuffers = new Map();
        this._samplerKeys = [];
        this._samplerLoading = null;
        this._sliceIndices = null;
        this._fitDuration = null;
        return this;
    },

    /**
     * Loads a single audio sample path into the track.
     * @param {string} path - Sample audio file URL.
     * @returns {TrackVoiceManager} this
     */
    sample(path) {
        this._useSampler = false;
        this._samplerBuffers = new Map();
        this._samplerKeys = [];
        this._samplerLoading = null;
        this._sliceIndices = null;
        this._fitDuration = null;

        if (!path) {
            this._sampleUrl = null;
            this._sampleBuffer = null;
            this._sampleLoading = null;
            this._useSample = false;
            this._slices = null;
            return this;
        }

        this._sampleUrl = path;
        this._useSample = true;
        this._synthType = null;

        const ctx = Motif.ctx;

        let entry = Motif.sampleRegistry.get(path);
        let bufPromise;
        if (entry && typeof entry === "object" && typeof entry.getChannelData === "function") {
            bufPromise = Promise.resolve(entry);
        } else if (typeof entry === "function") {
            const buf = entry();
            Motif.sampleRegistry.set(path, buf);
            bufPromise = Promise.resolve(buf);
        } else {
            const loadPath = typeof entry === "string" ? entry : path;
            bufPromise = Motif._loadAndCacheBuffer(loadPath);
            if (entry !== undefined) {
                bufPromise = bufPromise.then(buf => {
                    Motif.sampleRegistry.set(path, buf);
                    return buf;
                });
            }
        }

        this._sampleLoading = bufPromise;
        bufPromise.then(buf => {
            this._sampleBuffer = buf;
        }).catch(() => {
        });

        return this;
    },

    /**
     * Loads a key-mapped multi-sampler set of samples.
     * @param {Object} options - Sampler options.
     * @param {Object<string, string>} [options.urls={}] - Note-to-URL mappings.
     * @param {string} [options.baseUrl=''] - URL prefix.
     * @param {number} [options.release=0.1] - Default voice release time.
     * @returns {TrackVoiceManager} this
     */
    sampler({ urls = {}, baseUrl = "", release = 0.1 } = {}) {
        this._useSample = false;
        this._sampleUrl = null;
        this._sampleBuffer = null;
        this._sampleLoading = null;
        this._sliceIndices = null;
        this._fitDuration = null;

        this._samplerBuffers = new Map();
        this._samplerKeys = [];
        this._samplerRelease = release;
        this._useSampler = true;
        this._synthType = null;

        const ctx = Motif.ctx;

        const loads = [];
        for (const [rawKey, path] of Object.entries(urls)) {
            const midi = /^-?\d+$/.test(rawKey) ? parseInt(rawKey, 10) : noteToMidi(rawKey);
            if (typeof midi !== "number" || isNaN(midi)) continue;

            const fullUrl = baseUrl ? baseUrl + path : path;

            let entry = Motif.sampleRegistry.get(fullUrl);
            let bufPromise;
            if (entry && typeof entry === "object" && typeof entry.getChannelData === "function") {
                bufPromise = Promise.resolve(entry);
            } else if (typeof entry === "function") {
                const buf = entry();
                Motif.sampleRegistry.set(fullUrl, buf);
                bufPromise = Promise.resolve(buf);
            } else {
                const loadPath = typeof entry === "string" ? entry : fullUrl;
                bufPromise = Motif._loadAndCacheBuffer(loadPath);
                if (entry !== undefined) {
                    bufPromise = bufPromise.then(buf => {
                        Motif.sampleRegistry.set(fullUrl, buf);
                        return buf;
                    });
                }
            }

            const localMidi = midi;
            loads.push(bufPromise.then(buf => {
                this._samplerBuffers.set(localMidi, buf);
            }).catch(() => {
            }));
        }

        this._samplerLoading = Promise.all(loads).then(() => {
            this._samplerKeys = [...this._samplerBuffers.keys()].sort((a, b) => a - b);
        });

        return this;
    },

    /**
     * Binary searches for the nearest sampler MIDI key zone available.
     * @param {number} targetMidi - Desired MIDI note value.
     * @returns {number|null} The closest available MIDI key value.
     * @private
     */
    _findNearestSamplerKey(targetMidi) {
        const keys = this._samplerKeys;
        if (!keys || keys.length === 0) return null;

        let low = 0;
        let high = keys.length - 1;

        if (targetMidi <= keys[low]) return keys[low];
        if (targetMidi >= keys[high]) return keys[high];

        // Binary search to find closest key in sorted keys array
        while (low <= high) {
            const mid = (low + high) >> 1;
            const midVal = keys[mid];

            if (midVal === targetMidi) return midVal;

            if (targetMidi < midVal) {
                if (mid > 0 && targetMidi > keys[mid - 1]) {
                    return Math.abs(keys[mid - 1] - targetMidi) < Math.abs(midVal - targetMidi)
                        ? keys[mid - 1]
                        : midVal;
                }
                high = mid - 1;
            } else {
                if (mid < keys.length - 1 && targetMidi < keys[mid + 1]) {
                    return Math.abs(midVal - targetMidi) < Math.abs(keys[mid + 1] - targetMidi)
                        ? midVal
                        : keys[mid + 1];
                }
                low = mid + 1;
            }
        }

        return keys[low];
    },

    /**
     * Customizes active envelope settings (attack, decay, sustain, release).
     * @param {Object} options - Envelope ADSR configurations.
     * @returns {TrackVoiceManager} this
     */
    envelope(options) {
        this._envelope = options || null;
        return this;
    },

    /**
     * Configures max voice limits and voice stealing modes.
     * @param {number} count - Max simultaneous voice counts.
     * @param {string} [mode='none'] - Voice stealing mode ('none', 'oldest', 'quietest').
     * @returns {TrackVoiceManager} this
     */
    voices(count, mode) {
        this._voiceLimit = (count !== undefined && count !== null) ? count : Infinity;
        this._voiceMode = mode || "none";
        return this;
    },

    /**
     * Mathematically chops/slices loaded audio samples into equal segments.
     * @param {number} slices - Total number of slice regions.
     * @returns {TrackVoiceManager} this
     */
    chop(slices) {
        this._slices = (typeof slices === "number" && slices > 0) ? slices : null;
        return this;
    },

    /**
     * Sets a slice playback pattern mapping index array.
     * @param {Array<number>} sliceIndices - Index mappings.
     * @returns {TrackVoiceManager} this
     */
    pattern(sliceIndices) {
        this._sliceIndices = Array.isArray(sliceIndices) ? sliceIndices : null;
        return this;
    },

    /**
     * Dynamically stretches/compresses playback rates to fit specific bar duration bounds.
     * @param {string|number} duration - Bar fraction or second duration to stretch to.
     * @returns {TrackVoiceManager} this
     */
    fit(duration) {
        this._fitDuration = duration;
        return this;
    },

    /**
     * Isolates a single channel slice from stereophonic buffers.
     * @param {AudioBuffer} buffer - Stereophonic source audio buffer.
     * @param {number} channel - Target channel index.
     * @returns {AudioBuffer} Monophonic audio buffer.
     * @private
     */
    _getMonoBuffer(buffer, channel) {
        if (!buffer || buffer.numberOfChannels <= channel) return buffer;
        if (!this._monoBufferCache) this._monoBufferCache = new Map();
        if (this._monoBufferCache.has(channel)) return this._monoBufferCache.get(channel);

        const ctx = Motif.ctx;
        const mono = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
        mono.copyToChannel(buffer.getChannelData(channel), 0);
        this._monoBufferCache.set(channel, mono);
        return mono;
    },

    /**
     * Disconnects and deletes completed scheduling voices from the pool.
     * @private
     */
    _cleanupActiveVoices() {
        if (!this._activeVoices) return;
        const now = Motif.ctx.currentTime;
        for (const [key, voice] of this._activeVoices.entries()) {
            if (voice.endTime <= now) {
                safeDisconnect(voice.oscillator);
                safeDisconnect(voice.gainNode);
                this._activeVoices.delete(key);
            }
        }
    },

    /**
     * Terminates and steals an active scheduling voice using the configured policy.
     * @param {string} mode - Stealing mode ('oldest', 'quietest').
     * @param {number} [targetStartTime] - Requested start time of the new voice.
     * @private
     */
    _stealVoice(mode, targetStartTime) {
        if (!this._activeVoices || this._activeVoices.size === 0) return;

        let targetKey = null;
        let targetVoice = null;

        if (mode === "oldest") {
            let oldestTime = Infinity;
            for (const [key, voice] of this._activeVoices.entries()) {
                // Prevent stealing voices that are starting at the exact same time as the new one
                if (targetStartTime !== undefined && Math.abs(voice.startTime - targetStartTime) < 1e-6) {
                    continue;
                }
                if (voice.startTime < oldestTime) {
                    oldestTime = voice.startTime;
                    targetKey = key;
                    targetVoice = voice;
                }
            }
        } else if (mode === "quietest") {
            let quietestGain = Infinity;
            for (const [key, voice] of this._activeVoices.entries()) {
                if (targetStartTime !== undefined && Math.abs(voice.startTime - targetStartTime) < 1e-6) {
                    continue;
                }
                if (voice.gainValue < quietestGain) {
                    quietestGain = voice.gainValue;
                    targetKey = key;
                    targetVoice = voice;
                } else if (voice.gainValue === quietestGain) {
                    if (targetVoice && voice.startTime < targetVoice.startTime) {
                        targetKey = key;
                        targetVoice = voice;
                    }
                }
            }
        }

        // If all active voices share the same startTime (simultaneous chord notes),
        // don't steal — let the caller silently drop the excess note instead of
        // creating and immediately destroying voices (which causes choking artifacts).
        if (targetKey === null) return;

        if (targetKey !== null && targetVoice) {
            const ctx = Motif.ctx;
            safeStop(targetVoice.oscillator, ctx.currentTime);
            safeDisconnect(targetVoice.oscillator);
            safeDisconnect(targetVoice.gainNode);
            this._activeVoices.delete(targetKey);
        }
    },

    /**
     * Creates and connects standard or custom (pluck, fm, noise) audio nodes.
     * @param {string} type - Synthesis type name.
     * @param {number} hz - Base frequency in Hertz.
     * @param {number|null} hzTo - Glide target frequency in Hertz.
     * @param {boolean} isRamp - True to enable slide glides.
     * @param {number} startTime - Start time in seconds.
     * @param {number} duration - Step duration in seconds.
     * @returns {Object} Wrapper object containing node outputs, start, stop and disconnect.
     * @private
     */
    _createVoiceSource(type, hz, hzTo, isRamp, startTime, duration) {
        const ctx = Motif.ctx;
        let nodes = [];
        let output;

        if (type === "noise") {
            const source = ctx.createBufferSource();
            source.buffer = getNoiseBuffer(ctx);
            source.loop = true;
            nodes = [source];
            output = source;
        } else if (type === "fm") {
            const carrier = ctx.createOscillator();
            const modulator = ctx.createOscillator();
            const modGain = ctx.createGain();

            carrier.type = "sine";
            modulator.type = "sine";

            const ratio = 2.0;
            const index = hz * 2.0;

            modulator.frequency.setValueAtTime(hz * ratio, startTime);
            modGain.gain.setValueAtTime(index, startTime);
            carrier.frequency.setValueAtTime(hz, startTime);

            if (isRamp && hzTo !== null && !isNaN(hzTo)) {
                carrier.frequency.linearRampToValueAtTime(hzTo, startTime + duration);
                modulator.frequency.linearRampToValueAtTime(hzTo * ratio, startTime + duration);
                modGain.gain.linearRampToValueAtTime(hzTo * 2.0, startTime + duration);
            }

            modulator.connect(modGain);
            modGain.connect(carrier.frequency);

            nodes = [carrier, modulator];
            output = carrier;
        } else if (type === "pluck") {
            const osc = ctx.createOscillator();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(hz, startTime);
            if (isRamp && hzTo !== null && !isNaN(hzTo)) {
                osc.frequency.linearRampToValueAtTime(hzTo, startTime + duration);
            }

            const filter = ctx.createBiquadFilter();
            filter.type = "lowpass";
            const sweepTime = 0.05;
            filter.frequency.setValueAtTime(hz * 15, startTime);
            filter.frequency.exponentialRampToValueAtTime(hz * 1.5, startTime + sweepTime);
            filter.Q.setValueAtTime(1.5, startTime);

            osc.connect(filter);
            nodes = [osc];
            output = filter;
        } else if (!["sine", "square", "sawtooth", "triangle", "saw"].includes(type) && Motif.synthRegistry && Motif.synthRegistry.has(type)) {
            const fnCode = Motif.synthRegistry.get(type).toString();

            _ensureSynthWorklet(ctx);

            const outputGain = ctx.createGain();
            let voiceNode = null;
            let _startTime = null;
            let _endTime = null;

            const _createWorkletNode = () => {
                voiceNode = new AudioWorkletNode(ctx, "motif-synth-voice", {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                });

                voiceNode.port.postMessage({ type: "REGISTER_SYNTH", code: fnCode });

                if (_startTime !== null) {
                    const freqParam = voiceNode.parameters.get("frequency");
                    const schedAt = Math.max(_startTime, ctx.currentTime);
                    freqParam.setValueAtTime(hz, schedAt);
                    if (isRamp && hzTo !== null && !isNaN(hzTo)) {
                        freqParam.linearRampToValueAtTime(hzTo, schedAt + duration);
                    }
                    voiceNode.port.postMessage({ type: "START", startTime: _startTime });
                    if (_endTime !== null) {
                        voiceNode.port.postMessage({ type: "STOP_AT", endTime: _endTime });
                    }
                }

                voiceNode.connect(outputGain);
                voiceNode.port.onmessage = ({ data }) => {
                    if (data.type === "VOICE_ENDED") {
                        safeDisconnect(voiceNode);
                        voiceNode = null;
                    }
                };
            };

            if (_synthWorkletLoaded) {
                _createWorkletNode();
            } else {
                _synthWorkletPromise.then(_createWorkletNode).catch(() => {
                });
            }

            const wrapper = {
                output: outputGain,
                start: (t) => {
                    _startTime = t;
                    if (voiceNode) {
                        const freqParam = voiceNode.parameters.get("frequency");
                        freqParam.setValueAtTime(hz, t);
                        if (isRamp && hzTo !== null && !isNaN(hzTo)) {
                            freqParam.linearRampToValueAtTime(hzTo, t + duration);
                        }
                        voiceNode.port.postMessage({ type: "START", startTime: t });
                    }
                },
                stop: (t) => {
                    _endTime = t;
                    if (voiceNode) {
                        voiceNode.port.postMessage({ type: "STOP_AT", endTime: t });
                    }
                },
                disconnect: () => {
                    if (voiceNode) {
                        safeDisconnect(voiceNode);
                        voiceNode = null;
                    }
                    safeDisconnect(outputGain);
                },
            };
            return wrapper;
        } else {
            const osc = ctx.createOscillator();
            let oscType = type || "sine";
            if (oscType === "saw") oscType = "sawtooth";
            osc.type = oscType;

            osc.frequency.setValueAtTime(hz, startTime);
            if (isRamp && hzTo !== null && !isNaN(hzTo)) {
                osc.frequency.linearRampToValueAtTime(hzTo, startTime + duration);
            }
            nodes = [osc];
            output = osc;
        }

        const wrapper = {
            output: output,
            start: (t) => nodes.forEach(n => {
                try {
                    n.start(t);
                } catch (e) {
                }
            }),
            stop: (t) => nodes.forEach(n => safeStop(n, t)),
            disconnect: () => {
                safeDisconnect(output);
                nodes.forEach(n => safeDisconnect(n));
            },
        };

        const primary = nodes[0];
        if (primary && primary.frequency) {
            Object.defineProperty(wrapper, "frequency", { get: () => primary.frequency });
        }
        if (primary && primary.detune) {
            Object.defineProperty(wrapper, "detune", { get: () => primary.detune });
        }

        return wrapper;
    },

    /**
     * Allocates a buffer source node to play decoded audio samples with custom envelopes.
     * @param {AudioBuffer} buffer - Decoded AudioBuffer.
     * @param {number} startTime - Absolute startTime in seconds.
     * @param {number} duration - Playback duration in seconds.
     * @param {number} [playbackRate=1.0] - Playback rate stretching multiplier.
     * @param {boolean} [isTied=false] - True to hold decay/sustain past bounds.
     * @param {Object} [event=null] - The source scheduling event structure.
     * @private
     */
    _playAudioBuffer(buffer, startTime, duration, playbackRate = 1.0, isTied = false, event = null) {
        const ctx = Motif.ctx;
        this._cleanupActiveVoices();

        if (this._activeVoices.size >= this._voiceLimit) {
            if (this._voiceMode === "none") return;
            this._stealVoice(this._voiceMode, startTime);
            // If steal was a no-op (all voices are same-startTime chord notes), drop this note
            if (this._activeVoices.size >= this._voiceLimit) return;
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        if (this._monoChannel !== null && this._monoChannel !== undefined) {
            source.buffer = this._getMonoBuffer(source.buffer, this._monoChannel);
        }

        if (source.playbackRate && typeof source.playbackRate.setValueAtTime === "function") {
            source.playbackRate.setValueAtTime(playbackRate, startTime);
        } else if (source.playbackRate) {
            source.playbackRate.value = playbackRate;
        }

        const voiceGain = ctx.createGain();
        const currentGainVal = this._gainLevel !== undefined ? this._gainLevel : 1.0;
        let actualDuration = duration;

        if (this._envelope) {
            const env = this._envelope;
            const attack = parseDurationToSeconds(env.attack !== undefined ? env.attack : CONSTANTS.ENVELOPE.DEFAULT_ATTACK, Motif.tempo, Motif.beatsPerBar);
            const decay = parseDurationToSeconds(env.decay !== undefined ? env.decay : CONSTANTS.ENVELOPE.DEFAULT_DECAY, Motif.tempo, Motif.beatsPerBar);
            const sustain = env.sustain !== undefined ? env.sustain : CONSTANTS.ENVELOPE.DEFAULT_SUSTAIN;
            const release = parseDurationToSeconds(env.release !== undefined ? env.release : CONSTANTS.ENVELOPE.DEFAULT_RELEASE, Motif.tempo, Motif.beatsPerBar);

            const peakVal = currentGainVal;
            const sustainLevel = Math.max(0.0001, sustain);
            const sustainVal = sustainLevel * currentGainVal;
            const floorVal = 0.0001 * currentGainVal;
            const off = startTime + duration;

            voiceGain.gain.setValueAtTime(floorVal, startTime);
            voiceGain.gain.linearRampToValueAtTime(peakVal, startTime + attack);
            voiceGain.gain.exponentialRampToValueAtTime(sustainVal, startTime + attack + decay);

            if (isTied) {
                if (typeof voiceGain.gain.cancelAndHoldAtTime === "function") {
                    voiceGain.gain.cancelAndHoldAtTime(off);
                }
                actualDuration = Infinity;
            } else {
                actualDuration = duration + release;
                let valAtOff = sustainVal;
                if (off < startTime + attack) {
                    valAtOff = floorVal + (peakVal - floorVal) * ((off - startTime) / attack);
                } else if (off < startTime + attack + decay) {
                    valAtOff = decay > 0
                        ? peakVal * Math.pow(sustainVal / peakVal, (off - (startTime + attack)) / decay)
                        : sustainVal;
                }
                voiceGain.gain.setValueAtTime(valAtOff, off);
                voiceGain.gain.exponentialRampToValueAtTime(floorVal, off + release);
                voiceGain.gain.setValueAtTime(0, off + release);
            }
        } else {
            voiceGain.gain.setValueAtTime(currentGainVal, startTime);
            if (isTied) {
                actualDuration = Infinity;
            } else {
                const release = (this._useSampler) ? parseDurationToSeconds(this._samplerRelease, Motif.tempo, Motif.beatsPerBar) : 0.005;
                const off = startTime + duration;
                actualDuration = duration + release;
                voiceGain.gain.setValueAtTime(currentGainVal, off);
                voiceGain.gain.exponentialRampToValueAtTime(0.0001 * currentGainVal, off + release);
                voiceGain.gain.setValueAtTime(0, off + release);
            }
        }

        source.connect(voiceGain);
        voiceGain.connect(this.trackInputNode);

        if (this._slices && buffer === this._sampleBuffer && event) {
            const sliceDuration = buffer.duration / this._slices;
            let sliceIndex = 0;

            if (this._sliceIndices && this._sliceIndices.length > 0) {
                const stepIndex = event.index !== undefined ? event.index : 0;
                sliceIndex = this._sliceIndices[stepIndex % this._sliceIndices.length];
            } else if (typeof event.value === "number") {
                sliceIndex = event.value % this._slices;
            } else {
                const stepIndex = event.index !== undefined ? event.index : 0;
                sliceIndex = stepIndex % this._slices;
            }

            sliceIndex = ((sliceIndex % this._slices) + this._slices) % this._slices;

            const offset = sliceIndex * sliceDuration;
            source.start(startTime, offset, sliceDuration);
            if (actualDuration !== Infinity) {
                const realSliceDuration = sliceDuration / playbackRate;
                safeStop(source, startTime + Math.min(actualDuration, realSliceDuration));
            }
        } else {
            source.start(startTime);
            if (actualDuration !== Infinity) {
                safeStop(source, startTime + actualDuration);
            }
        }

        const voiceKey = Symbol("voice");
        this._activeVoices.set(voiceKey, {
            oscillator: source,
            gainNode: voiceGain,
            startTime,
            endTime: actualDuration === Infinity ? Infinity : startTime + actualDuration,
            gainValue: currentGainVal,
        });

        for (const cb of this._sidechainListeners) cb(startTime);
    },

    /**
     * Entry dispatcher allocating audio synthesis oscillators, buffers, or sample zones.
     * @param {Object} event - The flat parsed event to play.
     * @param {number} startTime - Absolute startTime in seconds.
     * @param {number} duration - Playback duration in seconds.
     * @private
     */
    _playEvent(event, startTime, duration) {
        if (event.value === null || event.value === undefined) return;
        if (duration <= 0) return;

        const ctx = Motif.ctx;

        if (typeof event.value === "object" && !event.value.isRamp && event.value.type && event.value.type !== "Parallel" && event.value.value !== undefined) {
            const param = this._resolveParam(event.value.type);
            if (param) {
                applyParamModulation(this, param, event.value.value, `_${event.value.type}Modulator`, null, duration, startTime);
                return;
            }
        }

        if (event.value === Tie) {
            let activeVoice = null;
            let maxStartTime = -1;
            for (const voice of this._activeVoices.values()) {
                if (voice.startTime > maxStartTime) {
                    maxStartTime = voice.startTime;
                    activeVoice = voice;
                }
            }

            if (activeVoice) {
                const off = startTime + duration;
                if (event.tied) {
                    if (typeof activeVoice.gainNode.gain.cancelAndHoldAtTime === "function") {
                        activeVoice.gainNode.gain.cancelAndHoldAtTime(off);
                    }
                } else {
                    const env = this._envelope;
                    if (env) {
                        const release = parseDurationToSeconds(env.release !== undefined ? env.release : 0.1, Motif.tempo, Motif.beatsPerBar);
                        const floorVal = 0.0001 * activeVoice.gainValue;
                        const valAtOff = activeVoice.gainNode.gain.value !== undefined ? activeVoice.gainNode.gain.value : activeVoice.gainValue;

                        activeVoice.gainNode.gain.setValueAtTime(valAtOff, off);
                        activeVoice.gainNode.gain.exponentialRampToValueAtTime(floorVal, off + release);
                        activeVoice.gainNode.gain.setValueAtTime(0, off + release);

                        activeVoice.endTime = off + release;
                        safeStop(activeVoice.oscillator, off + release);
                    } else {
                        activeVoice.gainNode.gain.setValueAtTime(0, off);
                        activeVoice.endTime = off;
                        safeStop(activeVoice.oscillator, off);
                    }
                }
            }
            return;
        }

        if (this._scaleRoot !== undefined && !this._freqPattern &&
            typeof event.value === "number" && !isNaN(event.value)) {
            event = {
                ...event,
                value: degreeToMidi(event.value, this._scaleRoot, this._scaleName || "major"),
            };
        }

        if (this._useSampler && this._samplerBuffers.size > 0) {
            return this._playSamplerEvent(event, startTime, duration);
        }

        if (this._useSample && this._sampleBuffer) {
            return this._playSampleEvent(event, startTime, duration);
        }

        let hz;
        let hzTo = null;
        let isRamp = event.value && event.value.isRamp === true;

        if (isRamp) {
            const ramp = event.value;
            if (this._freqPattern) {
                hz = typeof ramp.from === "number" ? ramp.from : parseFloat(ramp.from);
                hzTo = typeof ramp.to === "number" ? ramp.to : parseFloat(ramp.to);
            } else if (this._tuningSystem) {
                hz = this._convertToTuningHz(ramp.from);
                hzTo = this._convertToTuningHz(ramp.to);
            } else {
                hz = midiToHz(ramp.from === true ? "C3" : ramp.from);
                hzTo = midiToHz(ramp.to === true ? "C3" : ramp.to);
            }
        } else {
            if (this._freqPattern) {
                hz = typeof event.value === "number" ? event.value : parseFloat(event.value);
            } else if (this._tuningSystem) {
                hz = this._convertToTuningHz(event.value);
            } else {
                let noteVal = event.value;
                if (noteVal === true) noteVal = "C3";
                hz = midiToHz(noteVal);
            }
        }

        if (typeof hz !== "number" || isNaN(hz)) return;

        this._cleanupActiveVoices();
        if (this._activeVoices.size >= this._voiceLimit) {
            if (this._voiceMode === "none") return;
            this._stealVoice(this._voiceMode, startTime);
            // If steal was a no-op (all voices are same-startTime chord notes), drop this note
            if (this._activeVoices.size >= this._voiceLimit) return;
        }

        const voice = this._createVoiceSource(this._synthType, hz, hzTo, isRamp, startTime, duration);
        const voiceGain = ctx.createGain();
        const currentGainVal = this._gainLevel !== undefined ? this._gainLevel : 1.0;

        let actualDuration = duration;
        let isTiedNote = event.tied === true;

        if (this._envelope) {
            const env = this._envelope;
            const attack = parseDurationToSeconds(env.attack !== undefined ? env.attack : CONSTANTS.ENVELOPE.DEFAULT_ATTACK, Motif.tempo, Motif.beatsPerBar);
            const decay = parseDurationToSeconds(env.decay !== undefined ? env.decay : CONSTANTS.ENVELOPE.DEFAULT_DECAY, Motif.tempo, Motif.beatsPerBar);
            const sustain = env.sustain !== undefined ? env.sustain : CONSTANTS.ENVELOPE.DEFAULT_SUSTAIN;
            const release = parseDurationToSeconds(env.release !== undefined ? env.release : CONSTANTS.ENVELOPE.DEFAULT_RELEASE, Motif.tempo, Motif.beatsPerBar);

            const peakVal = currentGainVal;
            const sustainLevel = Math.max(0.0001, sustain);
            const sustainVal = sustainLevel * currentGainVal;
            const floorVal = 0.0001 * currentGainVal;
            const off = startTime + duration;

            voiceGain.gain.setValueAtTime(floorVal, startTime);
            voiceGain.gain.linearRampToValueAtTime(peakVal, startTime + attack);
            voiceGain.gain.exponentialRampToValueAtTime(sustainVal, startTime + attack + decay);

            if (isTiedNote) {
                if (typeof voiceGain.gain.cancelAndHoldAtTime === "function") {
                    voiceGain.gain.cancelAndHoldAtTime(off);
                }
                actualDuration = Infinity;
            } else {
                actualDuration = duration + release;
                let valAtOff = sustainVal;
                if (off < startTime + attack) {
                    valAtOff = floorVal + (peakVal - floorVal) * ((off - startTime) / attack);
                } else if (off < startTime + attack + decay) {
                    valAtOff = decay > 0 ? peakVal * Math.pow(sustainVal / peakVal, (off - (startTime + attack)) / decay) : sustainVal;
                }
                voiceGain.gain.setValueAtTime(valAtOff, off);
                voiceGain.gain.exponentialRampToValueAtTime(floorVal, off + release);
                voiceGain.gain.setValueAtTime(0, off + release);
            }
        } else {
            voiceGain.gain.setValueAtTime(currentGainVal, startTime);
            if (isTiedNote) {
                actualDuration = Infinity;
            } else {
                const release = 0.015; // 15ms click preventative fade-out
                const off = startTime + duration;
                if (typeof voiceGain.gain.exponentialRampToValueAtTime === "function") {
                    voiceGain.gain.setValueAtTime(currentGainVal, off);
                    voiceGain.gain.exponentialRampToValueAtTime(0.0001 * currentGainVal, off + release);
                    voiceGain.gain.setValueAtTime(0, off + release);
                } else if (typeof voiceGain.gain.setValueAtTime === "function") {
                    voiceGain.gain.setValueAtTime(currentGainVal, off);
                    voiceGain.gain.setValueAtTime(0, off + release);
                }
                actualDuration = duration + release;
            }
        }

        voice.output.connect(voiceGain);
        voiceGain.connect(this.trackInputNode);
        voice.start(startTime);
        if (actualDuration !== Infinity) {
            voice.stop(startTime + actualDuration);
        }

        const voiceKey = Symbol("voice");
        this._activeVoices.set(voiceKey, {
            oscillator: voice,
            gainNode: voiceGain,
            startTime,
            endTime: actualDuration === Infinity ? Infinity : startTime + actualDuration,
            gainValue: currentGainVal,
        });

        for (const cb of this._sidechainListeners) cb(startTime);
    },

    /**
     * Resolves key maps and routes multi-sampled sampler audio buffers.
     * @param {Object} event - The flat parsed event.
     * @param {number} startTime - Absolute startTime in seconds.
     * @param {number} duration - Step duration in seconds.
     * @private
     */
    _playSamplerEvent(event, startTime, duration) {
        const targetMidi = typeof event.value === "number" ? event.value : noteToMidi(event.value);
        if (typeof targetMidi !== "number" || isNaN(targetMidi)) return;

        const sourceKey = this._findNearestSamplerKey(targetMidi);
        if (sourceKey === null) return;

        const buffer = this._samplerBuffers.get(sourceKey);
        if (!buffer) return;

        let fitMultiplier = 1.0;
        if (this._fitDuration && buffer) {
            const targetSecs = parseDurationToSeconds(this._fitDuration, Motif.tempo, Motif.beatsPerBar);
            if (targetSecs > 0) {
                fitMultiplier = buffer.duration / targetSecs;
            }
        }

        const playbackRate = fitMultiplier * Math.pow(2, (targetMidi - sourceKey) / 12);
        this._playAudioBuffer(buffer, startTime, duration, playbackRate, event.tied === true, event);
    },

    /**
     * Customizes and routes single sample file audio buffers.
     * @param {Object} event - The flat parsed event.
     * @param {number} startTime - Absolute startTime in seconds.
     * @param {number} duration - Step duration in seconds.
     * @private
     */
    _playSampleEvent(event, startTime, duration) {
        if (!this._sampleBuffer) return;

        let baseRate = 1.0;
        if (this._fitDuration && this._sampleBuffer) {
            const targetSecs = parseDurationToSeconds(this._fitDuration, Motif.tempo, Motif.beatsPerBar);
            if (targetSecs > 0) {
                baseRate = this._sampleBuffer.duration / targetSecs;
            }
        }

        let playbackRate = baseRate;
        if (this._notePattern) {
            const midi = noteToMidi(event.value);
            if (typeof midi === "number" && !isNaN(midi)) {
                playbackRate = baseRate * Math.pow(2, (midi - 60) / 12);
            }
        } else if (this._freqPattern) {
            const hz = typeof event.value === "number" ? event.value : parseFloat(event.value);
            if (typeof hz === "number" && !isNaN(hz)) {
                playbackRate = baseRate * (hz / midiToHz(60));
            }
        }

        this._playAudioBuffer(this._sampleBuffer, startTime, duration, playbackRate, event.tied === true, event);
    },
};
