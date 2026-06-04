import { Motif, parseDurationToSeconds } from "../motif.js";

/**
 * Safely disconnects a Web Audio API node, catching potential disconnect errors gracefully.
 * @param {AudioNode} node - The audio node to disconnect.
 * @param {AudioNode|AudioParam} [target] - Specific target connection destination.
 */
export function safeDisconnect(node, target) {
    if (!node || typeof node.disconnect !== "function") return;
    try {
        if (target !== undefined) {
            node.disconnect(target);
        } else {
            node.disconnect();
        }
    } catch (e) {
        if (target !== undefined) {
            try {
                node.disconnect();
            } catch (err) {
            }
        }
    }
}

/**
 * Disconnects and reconnects an ordered array of audio nodes in series to a final destination.
 * @param {Array<AudioNode>} nodes - Sequence of audio nodes to chain.
 * @param {AudioNode} [destination] - Final destination audio node.
 * @param {number} [outputIndex] - Output index channel of last node.
 * @param {number} [inputIndex] - Input index channel of target destination.
 */
export function reconnectNodes(nodes, destination, outputIndex, inputIndex) {
    const activeNodes = nodes.filter(Boolean);

    for (const node of activeNodes) {
        if (typeof node.disconnect === "function") {
            try {
                node.disconnect();
            } catch (e) {
            }
        }
    }

    for (let i = 0; i < activeNodes.length - 1; i++) {
        activeNodes[i].connect(activeNodes[i + 1]);
    }

    if (activeNodes.length > 0 && destination) {
        const lastNode = activeNodes[activeNodes.length - 1];
        if (outputIndex !== undefined && inputIndex !== undefined) {
            lastNode.connect(destination, outputIndex, inputIndex);
        } else {
            lastNode.connect(destination);
        }
    }
}

/**
 * Safely calls stop() on an oscillator or buffer source node at a specific time.
 * @param {AudioScheduledSourceNode} node - The audio source node to halt.
 * @param {number} [time] - Absolute time in seconds to stop playback.
 */
export function safeStop(node, time) {
    if (!node || typeof node.stop !== "function") return;
    try {
        if (time !== undefined) {
            node.stop(time);
        } else {
            node.stop();
        }
    } catch (e) {
    }
}

/**
 * Global sample buffer cache mapping file URLs to decodable AudioBuffer promises.
 * @type {Map<string, Promise<AudioBuffer>>}
 */
export const sampleBufferCache = new Map();

/**
 * Global registry mapping unique track IDs to track class instances.
 * @type {Map<string, Object>}
 */
export const trackRegistry = new Map();

/**
 * Cached noise buffer instance.
 * @type {AudioBuffer|null}
 * @private
 */
let _noiseBuffer = null;

/**
 * Generates or retrieves a cached 2-second stereo/mono white noise audio buffer.
 * @param {AudioContext} ctx - Active Web Audio context.
 * @returns {AudioBuffer} Decoded noise buffer.
 */
export function getNoiseBuffer(ctx) {
    if (_noiseBuffer) return _noiseBuffer;
    const bufferSize = ctx.sampleRate * 2;
    _noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = _noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    return _noiseBuffer;
}

/**
 * Dynamically binds numerical values, decibel strings, LFOs, or envelope ramps to an AudioParam.
 * @param {Object} instance - The source object hosting the parameters and modulator properties.
 * @param {AudioParam} param - Target Web Audio parameter to modulate.
 * @param {*} value - The input value, modulator, envelope ramp, or string DB level to apply.
 * @param {string} modulatorPropName - Instance property name key to register active modulator nodes.
 * @param {Function} [mapValueFn] - Custom scalar transformation function (e.g. dB to linear gain).
 * @param {number} [duration] - Step duration in seconds.
 * @param {number} [startTime] - Absolute clock trigger start time in seconds.
 */
export function applyParamModulation(instance, param, value, modulatorPropName, mapValueFn, duration, startTime) {
    if (!param) return;
    const ctx = Motif.ctx;
    const time = startTime !== undefined ? startTime : ctx.currentTime;

    if (instance[modulatorPropName]) {
        safeDisconnect(instance[modulatorPropName], param);
        instance[modulatorPropName] = null;
    }

    // Handle objects by attempting to extract a primary value (gain, value, cutoff, etc.)
    if (value && typeof value === "object" && !value.connect && !value.output && !value.isRamp && !Array.isArray(value)) {
        if (value.gain !== undefined) value = value.gain;
        else if (value.value !== undefined) value = value.value;
        else if (value.cutoff !== undefined) value = value.cutoff;
        else if (value.frequency !== undefined) value = value.frequency;
        else if (value.amplitude !== undefined) value = value.amplitude;
    }

    let valNode = null;
    if (value && typeof value.connect === "function") {
        valNode = value;
    } else if (value && value.output && typeof value.output.connect === "function") {
        valNode = value.output;
    }

    if (typeof value === "string") {
        const cleaned = value.trim().replace("−", "-");
        const dbMatch = cleaned.match(/^(-?(?:\d+(?:\.\d+)?|inf(?:inity)?))\s*dB$/i);
        if (dbMatch) {
            const valStr = dbMatch[1].toLowerCase();
            let db;
            if (valStr.includes("inf")) {
                db = valStr.startsWith("-") ? -Infinity : Infinity;
            } else {
                db = parseFloat(dbMatch[1]);
            }
            value = db;
        } else {
            // Strictly parse as scalar only if it's a pure number string
            if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
                value = parseFloat(cleaned);
            } else if (/^-?inf(?:inity)?$/i.test(cleaned)) {
                value = cleaned.startsWith("-") ? -Infinity : Infinity;
            } else {
                // Prevent dangerous fallback like parseFloat('-3dB') -> -3.0
                return;
            }
        }
    }

    if (valNode) {
        valNode.connect(param);
        instance[modulatorPropName] = valNode;
    } else if (value && value.isRamp === true) {
        const fromVal = mapValueFn ? mapValueFn(value.from) : value.from;
        const toVal = mapValueFn ? mapValueFn(value.to) : value.to;
        const d = duration !== undefined ? duration : (value.duration !== undefined ? parseDurationToSeconds(value.duration, Motif.tempo, Motif.beatsPerBar) : 0.05);

        param.setValueAtTime(fromVal, time);
        param.linearRampToValueAtTime(toVal, time + d);
    } else if (typeof value === "number" && !isNaN(value)) {
        const finalVal = mapValueFn ? mapValueFn(value) : value;
        param.setValueAtTime(finalVal, time);
    }
}

/**
 * Seeded 32-bit pseudo-random number generator (Mulberry32).
 * @param {number} a - 32-bit integer seed value.
 * @returns {() => number} Random float generator between 0.0 (inclusive) and 1.0 (exclusive).
 */
export function mulberry32(a) {
    return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Computes a mathematically spaced Euclidean pulse distribution using the Bjorklund algorithm.
 * @param {number} pulses - Active pulses to fit.
 * @param {number} steps - Total subdivision slots.
 * @returns {Array<boolean>} Array containing the Euclidean rhythm mask list.
 */
export function bjorklund(pulses, steps) {
    if (pulses <= 0) return Array(steps).fill(false);
    if (pulses >= steps) return Array(steps).fill(true);

    let ones = [];
    for (let i = 0; i < pulses; i++) ones.push([true]);
    let zeros = [];
    for (let i = 0; i < steps - pulses; i++) zeros.push([false]);

    while (zeros.length > 0) {
        let numToProcess = Math.min(ones.length, zeros.length);
        for (let i = 0; i < numToProcess; i++) {
            ones[i] = ones[i].concat(zeros.pop());
        }

        if (ones.length > numToProcess) {
            zeros = ones.splice(numToProcess);
        } else {
            // zeros already contains the leftovers if numToProcess was ones.length
        }
        if (zeros.length <= 1) break;
    }

    let result = [];
    for (let g of ones) result.push(...g);
    for (let g of zeros) result.push(...g);
    return result;
}

/**
 * 1D and 2D Simplex Noise generator based on standard gradients.
 */
export class SimplexNoise {
    /**
     * Initializes permutation and gradient lookup arrays using an optional seed or random number generator.
     * @param {number|(() => number)} [randomOrSeed=Math.random] - RNG function or numeric seed.
     */
    constructor(randomOrSeed = Math.random) {
        const randomFunc = typeof randomOrSeed === "function"
            ? randomOrSeed
            : mulberry32(randomOrSeed);

        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            p[i] = i;
        }

        for (let i = 255; i > 0; i--) {
            const j = Math.floor(randomFunc() * (i + 1));
            const temp = p[i];
            p[i] = p[j];
            p[j] = temp;
        }

        this.perm = new Uint8Array(512);
        this.permMod12 = new Uint8Array(512);

        for (let i = 0; i < 512; i++) {
            this.perm[i] = p[i & 255];
            this.permMod12[i] = (this.perm[i] % 12);
        }

        this.grad3 = new Float32Array([
            1, 1, 0,
            -1, 1, 0,
            1, -1, 0,
            -1, -1, 0,
            1, 0, 1,
            -1, 0, 1,
            1, 0, -1,
            -1, 0, -1,
            0, 1, 1,
            0, -1, 1,
            0, 1, -1,
            0, -1, -1,
        ]);
    }

    /**
     * Computes a 1D Simplex Noise value at coordinate x.
     * @param {number} x - Coordinate x.
     * @returns {number} Noise value between -1.0 and 1.0.
     */
    noise1D(x) {
        const i0 = Math.floor(x);
        const i1 = i0 + 1;
        const x0 = x - i0;
        const x1 = x0 - 1.0;

        let t0 = 1.0 - x0 * x0;
        t0 *= t0;
        const gi0 = this.perm[i0 & 255] & 1;
        const n0 = t0 * t0 * (gi0 === 0 ? x0 : -x0);

        let t1 = 1.0 - x1 * x1;
        t1 *= t1;
        const gi1 = this.perm[i1 & 255] & 1;
        const n1 = t1 * t1 * (gi1 === 0 ? x1 : -x1);

        return 0.395 * (n0 + n1);
    }

    /**
     * Computes a 2D Simplex Noise value at coordinates (x, y).
     * @param {number} x - Coordinate x.
     * @param {number} y - Coordinate y.
     * @returns {number} Noise value between -1.0 and 1.0.
     */
    noise2D(x, y) {
        const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
        const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

        const s = (x + y) * F2;
        const i = Math.floor(x + s);
        const j = Math.floor(y + s);

        const t = (i + j) * G2;
        const X0 = i - t;
        const Y0 = j - t;

        const x0 = x - X0;
        const y0 = y - Y0;

        let i1, j1;
        if (x0 > y0) {
            i1 = 1;
            j1 = 0;
        } else {
            i1 = 0;
            j1 = 1;
        }

        const x1 = x0 - i1 + G2;
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1.0 + 2.0 * G2;
        const y2 = y0 - 1.0 + 2.0 * G2;

        const ii = i & 255;
        const jj = j & 255;

        let n0 = 0.0, n1 = 0.0, n2 = 0.0;

        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 >= 0) {
            const gi0 = this.permMod12[ii + this.perm[jj]] * 3;
            t0 *= t0;
            n0 = t0 * t0 * (this.grad3[gi0] * x0 + this.grad3[gi0 + 1] * y0);
        }

        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 >= 0) {
            const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]] * 3;
            t1 *= t1;
            n1 = t1 * t1 * (this.grad3[gi1] * x1 + this.grad3[gi1 + 1] * y1);
        }

        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 >= 0) {
            const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]] * 3;
            t2 *= t2;
            n2 = t2 * t2 * (this.grad3[gi2] * x2 + this.grad3[gi2 + 1] * y2);
        }

        return 70.0 * (n0 + n1 + n2);
    }
}

/**
 * Preset values and default settings for filter type/gain/resonance, volume levels, and dynamics.
 */
export const CONSTANTS = {
    FILTER: {
        DEFAULT_CUTOFF: 350,
        DEFAULT_Q: 1,
        DEFAULT_GAIN: 0,
        DEFAULT_TYPE: "lowpass",
    },
    PANNER: {
        DEFAULT_PAN: 0,
    },
    VOLUME: {
        DEFAULT_GAIN: 1.0,
    },
    EQ: {
        LOW_FREQ: 320,
        MID_FREQ: 1000,
        HIGH_FREQ: 3200,
        DEFAULT_GAIN: 0,
        MID_Q: 1,
    },
    ENVELOPE: {
        DEFAULT_ATTACK: 0.01,
        DEFAULT_DECAY: 0.1,
        DEFAULT_SUSTAIN: 1.0,
        DEFAULT_RELEASE: 0.1,
    },
    LFO: {
        DEFAULT_FREQUENCY: 1.0,
        DEFAULT_DEPTH: 1.0,
        DEFAULT_OFFSET: 0.0,
    },
};

let _granularStretcherPromise = null;

/**
 * Ensures that the GranularStretcherProcessor worklet is loaded in the given AudioContext.
 * @param {AudioContext} ctx - Active Web Audio context.
 * @returns {Promise<void>} Resolves when loaded.
 */
export function ensureGranularStretcher(ctx) {
    if (!ctx || !ctx.audioWorklet) return Promise.reject(new Error("AudioWorklet not supported"));
    if (_granularStretcherPromise) return _granularStretcherPromise;

    const url = new URL("./worklets/GranularStretcherProcessor.js", import.meta.url).href;
    _granularStretcherPromise = ctx.audioWorklet.addModule(url)
        .catch(err => {
            console.error("GranularStretcherProcessor load failed:", err);
            _granularStretcherPromise = null;
            throw err;
        });

    return _granularStretcherPromise;
}

