/**
 * Motif: Declarative, native-JavaScript DSL for algorithmic composition.
 */

import {
    sampleBufferCache,
    trackRegistry,
    applyParamModulation,
    SimplexNoise,
    safeDisconnect,
    reconnectNodes,
} from "./src/helpers.js";
import { TrackAudioChain } from "./src/TrackAudioChain.js";
import { TrackVoiceManager } from "./src/TrackVoiceManager.js";
import { TrackScheduler } from "./src/TrackScheduler.js";

export { SimplexNoise, trackRegistry, busRegistry };

export class ParallelNode {
    constructor(items) {
        this.items = items;
        this.isParallel = true;
    }
}

/**
 * Creates a parallel primitive that tags grouped items to share the same startTime fraction.
 * @param {...*} items - The items to be executed in parallel.
 * @returns {ParallelNode} The parallel node.
 */
export function Parallel(...items) {
    return new ParallelNode(items);
}

export class RampNode {
    constructor(from, to, duration) {
        this.from = from;
        this.to = to;
        this.duration = duration;
        this.isRamp = true;
    }
}

/**
 * Creates a ramp primitive that tags a step for linear interpolation between two values over the step's duration.
 * @param {*} from - The starting value.
 * @param {*} to - The ending value.
 * @param {string|number} [duration] - Optional duration for the ramp.
 * @returns {RampNode} The ramp node.
 */
export function Ramp(from, to, duration) {
    return new RampNode(from, to, duration);
}

/**
 * Global arrangement helper.
 * Schedules track boundaries across sequential sections.
 * @param {Array<Object>} sections - Array of { tracks: [], bars: number } objects.
 */
export function Arrange(sections) {
    if (!Array.isArray(sections)) return;

    // Clear previously set active segments on all tracks defined in this arrangement
    const tracksToReset = new Set();
    for (const section of sections) {
        if (section.tracks && Array.isArray(section.tracks)) {
            for (const track of section.tracks) {
                if (track) {
                    tracksToReset.add(track);
                }
            }
        }
    }
    for (const track of tracksToReset) {
        if (typeof track._clearActiveSegments === "function") {
            track._clearActiveSegments();
        }
    }

    let currentTime = 0;
    // Note: Arrange uses the Motif global transport settings
    const bpm = Motif.tempo;
    const beatsPerBar = Motif.beatsPerBar;
    const barDuration = (60 / bpm) * beatsPerBar;

    for (const section of sections) {
        const sectionDuration = (section.bars || 0) * barDuration;
        const sectionStart = currentTime;
        const sectionEnd = sectionStart + sectionDuration;

        if (section.tracks && Array.isArray(section.tracks)) {
            const uniqueTracks = new Set(section.tracks);
            for (const track of uniqueTracks) {
                if (track && typeof track.start === "function" && typeof track.stop === "function") {
                    track.start(sectionStart).stop(sectionEnd);
                }
            }
        }
        currentTime = sectionEnd;
    }
}


export const Tie = Symbol("Tie");


export class MotifEventArray extends Array {
    transpose(semitones) {
        this.forEach(e => {
            if (e && e.value !== undefined && e.value !== null) {
                if (e.value.isRamp === true) {
                    if (typeof e.value.from === "string" && e.value.from !== "Tie") {
                        const m = noteToMidi(e.value.from);
                        if (m !== undefined && !isNaN(m)) e.value.from = midiToNote(m + semitones);
                    } else if (typeof e.value.from === "number") {
                        e.value.from += semitones;
                    }
                    if (typeof e.value.to === "string" && e.value.to !== "Tie") {
                        const m = noteToMidi(e.value.to);
                        if (m !== undefined && !isNaN(m)) e.value.to = midiToNote(m + semitones);
                    } else if (typeof e.value.to === "number") {
                        e.value.to += semitones;
                    }
                } else if (typeof e.value === "string" && e.value !== "Tie") {
                    const m = noteToMidi(e.value);
                    if (m !== undefined && !isNaN(m)) e.value = midiToNote(m + semitones);
                } else if (typeof e.value === "number") {
                    e.value += semitones;
                }
            }
        });
        return this;
    }

    fast(factor) {
        if (factor <= 0) return this;
        this.forEach(e => {
            e.startTime /= factor;
            e.duration /= factor;
        });
        return this;
    }

    rev() {
        this.forEach(e => {
            e.startTime = 1.0 - (e.startTime + e.duration);
        });
        this.sort((a, b) => a.startTime - b.startTime);
        return this;
    }
}


export class PatternParser {
    /**
     * Converts nested arrays into a flat array of discrete event objects with startTime and duration fractions.
     * @param {Array|*} pattern - The nested pattern array or a primitive value.
     * @param {number} [startTime=0] - The start time fraction of the current pattern context.
     * @param {number} [duration=1] - The duration fraction of the current pattern context.
     * @returns {MotifEventArray} A flat array of event objects.
     */
    static parse(pattern, startTime = 0, duration = 1) {
        const events = PatternParser._parseRecursive(pattern, startTime, duration);
        PatternParser._postProcessTies(events);
        return new MotifEventArray(...events);
    }

    /**
     * Internal recursive helper to parse patterns.
     * @param {Array|*} pattern - The nested pattern array or primitive value.
     * @param {number} startTime - Start time fraction.
     * @param {number} duration - Duration fraction.
     * @returns {Array<Object>} Flat array of parsed event objects.
     * @private
     */
    static _parseRecursive(pattern, startTime, duration) {
        if (pattern && pattern.isParallel) {
            return PatternParser._parseParallel(pattern.items, startTime, duration);
        }

        if (!Array.isArray(pattern)) {
            return [{ value: pattern, startTime, duration }];
        }

        return PatternParser._parseSequential(pattern, startTime, duration);
    }

    /**
     * Parses parallel elements at a shared start time and duration context.
     * @param {Array} items - The parallel items to parse.
     * @param {number} startTime - Start time fraction.
     * @param {number} duration - Duration fraction.
     * @returns {Array<Object>} Flat array of parsed event objects.
     * @private
     */
    static _parseParallel(items, startTime, duration) {
        const events = [];
        for (const item of items) {
            events.push(...PatternParser._parseRecursive(item, startTime, duration));
        }
        return events;
    }

    /**
     * Parses sequential elements subdivided across a start time and duration context.
     * @param {Array} pattern - The pattern array to parse sequentially.
     * @param {number} startTime - Start time fraction.
     * @param {number} duration - Duration fraction.
     * @returns {Array<Object>} Flat array of parsed event objects.
     * @private
     */
    static _parseSequential(pattern, startTime, duration) {
        const length = pattern.length;
        if (length === 0) return [];

        const stepDuration = duration / length;
        const events = [];

        for (let i = 0; i < length; i++) {
            const element = pattern[i];
            const elementStartTime = startTime + i * stepDuration;
            events.push(...PatternParser._parseRecursive(element, elementStartTime, stepDuration));
        }

        return events;
    }

    /**
     * Post-processes events to flag those that are tied to a subsequent Tie symbol.
     * @param {Array<Object>} events - Flat array of event objects.
     * @private
     */
    static _postProcessTies(events) {
        const tieStartTimes = new Set();
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (ev.value === Tie) {
                tieStartTimes.add(Math.round(ev.startTime * 1e9));
            }
        }

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const end = ev.startTime + ev.duration;
            ev.tied = tieStartTimes.has(Math.round(end * 1e9));
        }
    }
}

const NOTE_MAP = {
    c: 0,
    "c#": 1,
    db: 1,
    d: 2,
    "d#": 3,
    eb: 3,
    e: 4,
    f: 5,
    "f#": 6,
    gb: 6,
    g: 7,
    "g#": 8,
    ab: 8,
    a: 9,
    "a#": 10,
    bb: 10,
    b: 11,
};

/**
 * Converts a standard note string (e.g. "C3", "F#4") into a MIDI number.
 * @param {string|number} note - The note representation.
 * @returns {number} The MIDI number, or the value as-is.
 */
export function noteToMidi(note) {
    if (typeof note === "number") return note;
    if (typeof note !== "string") return note;

    const cleaned = note.trim().toLowerCase();
    const match = cleaned.match(/^([a-g]#?|db|eb|gb|ab|bb)(-?\d+)$/);
    if (!match) return note;

    const name = match[1];
    const octave = parseInt(match[2], 10);
    const semitones = NOTE_MAP[name];

    return (octave + 1) * 12 + semitones;
}

/**
 * Converts a MIDI number back into a standard note string representation.
 * @param {number} midi - The MIDI number.
 * @returns {string|number} The note string, or the value as-is.
 */
export function midiToNote(midi) {
    if (typeof midi !== "number" || isNaN(midi)) return midi;
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[((midi % 12) + 12) % 12];
    return name + octave;
}

function evaluateOp(a, b, op) {
    const isANoteString = typeof a === "string" && typeof noteToMidi(a) === "number" && !isNaN(noteToMidi(a));
    const isBNoteString = typeof b === "string" && typeof noteToMidi(b) === "number" && !isNaN(noteToMidi(b));

    const valA = typeof a === "string" ? noteToMidi(a) : a;
    const valB = typeof b === "string" ? noteToMidi(b) : b;

    const res = op(valA, valB);

    if ((isANoteString || isBNoteString) && typeof res === "number" && Number.isInteger(res) && res >= 0 && res <= 127) {
        return midiToNote(res);
    }
    return res;
}

function crossProduct(arr, other, op) {
    const otherArr = Array.isArray(other) ? other : [other];
    const result = [];
    for (const x of arr) {
        for (const y of otherArr) {
            result.push(op(x, y));
        }
    }
    return result;
}

// Extend Array prototype with arithmetic methods utilizing cross-product evaluation.
if (!Array.prototype.add) {
    Array.prototype.add = function(other) {
        return crossProduct(this, other, (x, y) => evaluateOp(x, y, (a, b) => a + b));
    };
}

if (!Array.prototype.sub) {
    Array.prototype.sub = function(other) {
        return crossProduct(this, other, (x, y) => evaluateOp(x, y, (a, b) => a - b));
    };
}

if (!Array.prototype.mul) {
    Array.prototype.mul = function(other) {
        return crossProduct(this, other, (x, y) => evaluateOp(x, y, (a, b) => a * b));
    };
}

if (!Array.prototype.div) {
    Array.prototype.div = function(other) {
        return crossProduct(this, other, (x, y) => evaluateOp(x, y, (a, b) => a / b));
    };
}


export const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    ionian: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    melodicMinor: [0, 2, 3, 5, 7, 9, 11],
    pentatonicMajor: [0, 2, 4, 7, 9],
    pentatonicMinor: [0, 3, 5, 7, 10],
};

/**
 * Maps an integer scale degree and a root note/pitch to a absolute MIDI note number.
 * @param {number} degree - The 0-indexed scale degree.
 * @param {string|number} root - The root note (e.g. "C3" or MIDI 48).
 * @param {string} [scaleName="major"] - The diatonic scale name.
 * @returns {number} The absolute MIDI note number.
 */
export function degreeToMidi(degree, root, scaleName = "major") {
    const rootMidi = typeof root === "string" ? noteToMidi(root) : root;
    if (typeof rootMidi !== "number" || isNaN(rootMidi)) return NaN;
    if (typeof degree !== "number" || isNaN(degree)) return degree;

    const intervals = SCALES[scaleName.toLowerCase()] || SCALES.major;
    const len = intervals.length;
    const octaveOffset = Math.floor(degree / len);
    const index = ((degree % len) + len) % len;

    return rootMidi + intervals[index] + 12 * octaveOffset;
}

/**
 * Converts a MIDI note number to its equivalent frequency in Hz.
 * @param {number|string} midi - The MIDI note number or note string.
 * @returns {number} The frequency in Hz.
 */
export function midiToHz(midi) {
    let m = typeof midi === "string" ? noteToMidi(midi) : midi;
    if (typeof m !== "number" || isNaN(m)) return NaN;
    return 440 * Math.pow(2, (m - 69) / 12);
}

export function parseDurationToFraction(duration) {
    if (typeof duration === "number") return duration;
    if (typeof duration !== "string") return 0;
    const cleaned = duration.trim().toLowerCase();
    const fractionMatch = cleaned.match(/^(\d+)\/(\d+)$/);
    if (fractionMatch) {
        return parseInt(fractionMatch[1], 10) / parseInt(fractionMatch[2], 10);
    }
    const valMatch = cleaned.match(/^(\d+(?:\.\d+)?)$/);
    if (valMatch) {
        return parseFloat(valMatch[1]);
    }
    return 0;
}


export function parseDurationToSeconds(duration, bpm, beatsPerBar = 4) {
    if (typeof duration === "number") {
        return duration;
    }
    if (typeof duration !== "string") {
        return 0;
    }

    const cleaned = duration.trim().toLowerCase();

    // Check for fractions e.g. '1/16', '1/8' with optional unit (e.g. '1/16b')
    const fractionMatch = cleaned.match(/^(\d+)\/(\d+)\s*([a-z]+)?$/);
    if (fractionMatch) {
        const numerator = parseInt(fractionMatch[1], 10);
        const denominator = parseInt(fractionMatch[2], 10);
        const fraction = numerator / denominator;
        const unit = fractionMatch[3];
        const beatDuration = 60 / bpm;
        if (unit === "b" || unit === "bar" || unit === "bars" || !unit) {
            return fraction * beatDuration * beatsPerBar;
        }
        if (unit === "beat" || unit === "beats") {
            return fraction * beatDuration;
        }
        return fraction;
    }

    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
    if (match) {
        const val = parseFloat(match[1]);
        const unit = match[2];
        const beatDuration = 60 / bpm;
        if (unit === "b" || unit === "bar" || unit === "bars") {
            return val * beatDuration * beatsPerBar;
        }
        if (unit === "beat" || unit === "beats") {
            return val * beatDuration;
        }
        if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds" || !unit) {
            return val;
        }
        if (unit === "ms" || unit === "millis" || unit === "milliseconds") {
            return val / 1000;
        }
        return val;
    }

    return 0;
}

const LOOKAHEAD_INTERVAL_MS = 25;
const LOOKAHEAD_WINDOW_S = 0.1;

export class MotifEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.masterLowFilter = null;
        this.masterMidFilter = null;
        this.masterHighFilter = null;
        this.masterCompressor = null;
        this.isPlaying = false;
        this.tempo = 120;
        this.beatsPerBar = 4;
        this.position = 0;
        this.bpmParam = null;
        this.bpmNode = null;
        this._schedQueue = [];
        this._schedInterval = null;
        this.lookaheadIntervalMs = LOOKAHEAD_INTERVAL_MS;
        this.lookaheadWindowS = LOOKAHEAD_WINDOW_S;
        this._swingAmount = 0;
        this.sampleRegistry = new Map();
        this.synthRegistry = new Map();
        this._loadingSamples = [];
        this.onPlaybackFinished = null;
    }

    /**
     * Fetches a JSON manifest of samples and pre-loads them into the registry.
     * @param {string} url - URL to the JSON manifest (e.g., { "kick": "samples/kick.wav" })
     * @returns {Promise} Resolves when all samples are loaded and decoded.
     */
    loadSamples(url) {
        const p = fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`Failed to load sample manifest: ${res.status}`);
                return res.json();
            })
            .then(manifest => {
                const entries = Object.entries(manifest);
                for (const [key, path] of entries) {
                    if (!this.sampleRegistry.has(key)) {
                        this.sampleRegistry.set(key, path);
                    }
                }
            });
        this._loadingSamples.push(p);
        return p;
    }

    _loadAndCacheBuffer(path) {
        if (sampleBufferCache.has(path)) return sampleBufferCache.get(path);

        const p = fetch(path)
            .then(res => {
                if (!res.ok) throw new Error(`Failed to fetch sample: ${path}`);
                return res.arrayBuffer();
            })
            .then(ab => {
                return new Promise((resolve, reject) => {
                    try {
                        const result = this.ctx.decodeAudioData(ab, resolve, reject);
                        if (result && typeof result.then === "function") {
                            result.then(resolve, reject);
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        sampleBufferCache.set(path, p);
        return p;
    }

    /**
     * Initializes the Web Audio graph (AudioContext, Master Gain, Master DynamicsCompressor).
     */
    init() {
        if (this.ctx) return;

        const AudioContextClass = (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) || (typeof globalThis !== "undefined" && globalThis.AudioContext);
        if (!AudioContextClass) {
            throw new Error("Web Audio API AudioContext is not supported/available in this environment.");
        }

        this.ctx = new AudioContextClass();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(1.0, this.ctx.currentTime);

        // Three-band EQ Filters
        this.masterLowFilter = this.ctx.createBiquadFilter();
        this.masterLowFilter.type = "lowshelf";
        this.masterLowFilter.frequency.setValueAtTime(320, this.ctx.currentTime);
        this.masterLowFilter.gain.setValueAtTime(0, this.ctx.currentTime);

        this.masterMidFilter = this.ctx.createBiquadFilter();
        this.masterMidFilter.type = "peaking";
        this.masterMidFilter.frequency.setValueAtTime(1000, this.ctx.currentTime);
        this.masterMidFilter.gain.setValueAtTime(0, this.ctx.currentTime);

        this.masterHighFilter = this.ctx.createBiquadFilter();
        this.masterHighFilter.type = "highshelf";
        this.masterHighFilter.frequency.setValueAtTime(3200, this.ctx.currentTime);
        this.masterHighFilter.gain.setValueAtTime(0, this.ctx.currentTime);

        this.masterCompressor = this.ctx.createDynamicsCompressor();

        // Default Chain routing: masterGain -> low -> mid -> high -> masterCompressor -> destination
        this.masterGain.connect(this.masterLowFilter);
        this.masterLowFilter.connect(this.masterMidFilter);
        this.masterMidFilter.connect(this.masterHighFilter);
        this.masterHighFilter.connect(this.masterCompressor);
        this.masterCompressor.connect(this.ctx.destination);

        // Initialize sample-accurate BPM param using ConstantSourceNode if available
        if (typeof this.ctx.createConstantSource === "function") {
            this.bpmNode = this.ctx.createConstantSource();
            this.bpmNode.start();
            this.bpmParam = this.bpmNode.offset;
        } else {
            this.bpmParam = {
                value: this.tempo,
                setValueAtTime(val, time) {
                    this.value = val;
                    return this;
                },
                linearRampToValueAtTime(val, time) {
                    this.value = val;
                    return this;
                },
            };
        }
        this.bpmParam.setValueAtTime(this.tempo, this.ctx.currentTime);
    }

    /**
     * Starts the transport.
     * Guards execution with a check that the AudioContext is running (i.e. resumed by a user gesture).
     * Returns a Promise that resolves when the transport actually starts (after any pending samples load).
     */
    start() {
        if (this.ctx.state !== "running") {
            throw new Error("AudioContext is suspended. Motif.start() must be called after a user gesture has resumed the AudioContext.");
        }

        const onReady = () => {
            this.isPlaying = true;
            this._startScheduler();
        };

        if (this._loadingSamples && this._loadingSamples.length > 0) {
            return Promise.all(this._loadingSamples).then(onReady);
        } else {
            onReady();
            return Promise.resolve();
        }
    }

    /**
     * Suspends the transport without resetting position.
     */
    async pause() {
        this.isPlaying = false;
        this._stopScheduler();
        if (this.ctx && typeof this.ctx.suspend === "function") {
            await this.ctx.suspend();
        }
    }

    /**
     * Stops the transport and resets playhead/position to zero.
     */
    async stop() {
        this.isPlaying = false;
        this.position = 0;
        this._stopScheduler();
        this._schedQueue = [];

        // Reset tracks' scheduling states
        for (const track of trackRegistry.values()) {
            if (typeof track._resetScheduling === "function") {
                track._resetScheduling();
            }
        }

        if (this.ctx && typeof this.ctx.suspend === "function") {
            await this.ctx.suspend();
        }
    }

    /**
     * Enqueues a callback to be fired when the audio clock approaches `time`.
     * @param {number} time - Absolute AudioContext time (seconds) to fire the callback at.
     * @param {(audioTime: number) => void} callback - Receives the absolute audio time.
     */
    schedule(time, callback) {
        if (typeof time !== "number" || isNaN(time)) {
            throw new Error("schedule() time must be a finite number.");
        }
        if (typeof callback !== "function") {
            throw new Error("schedule() callback must be a function.");
        }
        this._schedQueue.push({ time, callback, fired: false });
    }

    /**
     * Advances the lookahead scheduler by one tick.
     * Dispatches all queued events whose target time falls within the lookahead window.
     */
    tick() {
        if (!this.ctx) return;
        const horizon = this.ctx.currentTime + this.lookaheadWindowS;

        // Schedule track-specific events
        for (const track of trackRegistry.values()) {
            if (typeof track._schedule === "function") {
                track._schedule(horizon);
            }
        }

        const remaining = [];
        for (const evt of this._schedQueue) {
            if (evt.fired) continue;
            if (evt.time <= horizon) {
                evt.fired = true;
                evt.callback(evt.time);
                continue;
            }
            remaining.push(evt);
        }
        this._schedQueue = remaining;

        // Check if all arranged tracks have finished playback
        if (this.isPlaying) {
            let allFinished = true;
            let hasTracks = false;
            let maxStopTime = 0;

            for (const track of trackRegistry.values()) {
                if (track.id === "__temp_probe__" || (!track._notePattern && !track._freqPattern)) {
                    continue;
                }

                hasTracks = true;
                if (track._activeSegments.length === 0) {
                    allFinished = false;
                    break;
                }

                const refTime = track._playbackStartTime !== null && track._playbackStartTime !== undefined ? track._playbackStartTime : this.ctx.currentTime;
                let trackMaxStop = 0;
                for (const seg of track._activeSegments) {
                    if (seg.stop === Infinity) {
                        allFinished = false;
                        break;
                    }
                    if (seg.stop > trackMaxStop) {
                        trackMaxStop = seg.stop;
                    }
                }

                if (!allFinished) break;

                const absTrackStop = refTime + trackMaxStop;
                if (absTrackStop > maxStopTime) {
                    maxStopTime = absTrackStop;
                }
            }

            if (hasTracks && allFinished && this.ctx.currentTime >= maxStopTime) {
                this.stop();
                if (typeof this.onPlaybackFinished === "function") {
                    this.onPlaybackFinished();
                }
            }
        }
    }

    /**
     * Begins the setInterval-driven lookahead scheduler loop.
     * @private
     */
    _startScheduler() {
        if (this._schedInterval !== null) return;
        if (typeof setInterval !== "function") return;
        this._schedInterval = setInterval(() => this.tick(), this.lookaheadIntervalMs);
    }

    /**
     * Halts the lookahead scheduler loop.
     * @private
     */
    _stopScheduler() {
        if (this._schedInterval === null) return;
        if (typeof clearInterval === "function") clearInterval(this._schedInterval);
        this._schedInterval = null;
    }

    /**
     * Sets the global tempo (BPM).
     * @param {number} bpm - The target tempo.
     */
    setTempo(bpm) {
        if (typeof bpm !== "number" || isNaN(bpm) || bpm <= 0) {
            throw new Error("Tempo must be a positive number.");
        }
        this.tempo = bpm;
        if (this.bpmParam) {
            this.bpmParam.setValueAtTime(bpm, this.ctx.currentTime);
        }
    }

    /**
     * Smoothly interpolates the global tempo to bpm over duration.
     * @param {number} bpm - The target tempo.
     * @param {string|number} duration - The duration over which to ramp.
     */
    rampTempo(bpm, duration) {
        if (typeof bpm !== "number" || isNaN(bpm) || bpm <= 0) {
            throw new Error("Target tempo must be a positive number.");
        }

        const seconds = parseDurationToSeconds(duration, this.tempo, this.beatsPerBar);
        const startTime = this.ctx.currentTime;
        const endTime = startTime + seconds;

        if (this.bpmParam) {
            // Anchor the ramp at the current value and current time
            this.bpmParam.setValueAtTime(this.tempo, startTime);
            this.bpmParam.linearRampToValueAtTime(bpm, endTime);
        }

        this.tempo = bpm;
    }

    /**
     * Internal helper to dynamically route the output graph based on limiter status.
     * @private
     */
    _updateMasterRouting(limiterEnabled) {
        if (!this.ctx) return;

        // Disconnect all filters and compressors to ensure clean state
        this.masterHighFilter.disconnect();
        this.masterCompressor.disconnect();

        if (limiterEnabled) {
            this.masterHighFilter.connect(this.masterCompressor);
            this.masterCompressor.connect(this.ctx.destination);
        } else {
            this.masterHighFilter.connect(this.ctx.destination);
        }
    }

    /**
     * Configures the master output stage (gain, EQ, and dynamics compressor/limiter).
     * @param {Object} options - Master configuration options.
     * @param {number} [options.gain] - Master gain level.
     * @param {boolean|Object} [options.limiter] - Limiter enable state or configuration object.
     * @param {Object} [options.eq] - Three-band EQ configuration.
     * @param {number} [options.eq.low] - Low band gain in dB.
     * @param {number} [options.eq.mid] - Mid band gain in dB.
     * @param {number} [options.eq.high] - High band gain in dB.
     */
    master({ gain, limiter, eq } = {}) {
        const time = this.ctx.currentTime;

        // 1. Configure master gain
        if (typeof gain === "number") {
            this.masterGain.gain.setValueAtTime(gain, time);
        }

        // 2. Configure EQ
        if (eq) {
            if (typeof eq.low === "number") {
                this.masterLowFilter.gain.setValueAtTime(eq.low, time);
            }
            if (typeof eq.mid === "number") {
                this.masterMidFilter.gain.setValueAtTime(eq.mid, time);
            }
            if (typeof eq.high === "number") {
                this.masterHighFilter.gain.setValueAtTime(eq.high, time);
            }
        }

        // 3. Configure limiter / Dynamics Compressor
        if (limiter === true || (limiter && typeof limiter === "object")) {
            this._updateMasterRouting(true);
            if (typeof limiter === "object") {
                if (typeof limiter.threshold === "number") this.masterCompressor.threshold.setValueAtTime(limiter.threshold, time);
                if (typeof limiter.knee === "number") this.masterCompressor.knee.setValueAtTime(limiter.knee, time);
                if (typeof limiter.ratio === "number") this.masterCompressor.ratio.setValueAtTime(limiter.ratio, time);
                if (typeof limiter.attack === "number") this.masterCompressor.attack.setValueAtTime(limiter.attack, time);
                if (typeof limiter.release === "number") this.masterCompressor.release.setValueAtTime(limiter.release, time);
            }
        } else if (limiter === false) {
            this._updateMasterRouting(false);
        }

        return this;
    }

    /**
     * Sets the global swing amount.
     * @param {number} amount - Swing amount from 0 (straight) to 1 (full triplet swing).
     * @returns {MotifEngine} this
     */
    swing(amount) {
        this._swingAmount = typeof amount === "number" ? Math.max(0, Math.min(1, amount)) : 0;
        return this;
    }

    /**
     * Environment-agnostic logger. In browser playground, redirected to sidebar;
     * in terminal, defaults to console.log.
     * @param {...*} args - Arguments to log.
     */
    log(...args) {
        console.log(...args);
    }
}

export const Motif = new MotifEngine();


class EffectChain {
    constructor() {
        this.filterNode = null;
        this._filterCutoffModulator = null;
        this.distortionNode = null;
        this.pannerNode = null;
        this._panModulator = null;
        this.eqLowNode = null;
        this.eqMidNode = null;
        this.eqHighNode = null;
        this._eqLowModulator = null;
        this._eqMidModulator = null;
        this._eqHighModulator = null;
        this.volumeNode = null;
        this._volumeModulator = null;
        this.compressorNode = null;
        this._compressorThresholdModulator = null;
        this._compressorKneeModulator = null;
        this._compressorRatioModulator = null;
        this._compressorAttackModulator = null;
        this._compressorReleaseModulator = null;
    }

    filter(options = {}) {
        const ctx = Motif.ctx;

        if (!this.filterNode) {
            this.filterNode = ctx.createBiquadFilter();
            this.filterNode.type = "lowpass";
            this.filterNode.frequency.setValueAtTime(350, ctx.currentTime);
            this.filterNode.Q.setValueAtTime(1, ctx.currentTime);
            this._rebuildSignalChain();
        }

        if (options) {
            const { type, cutoff, resonance } = options;

            if (type !== undefined) {
                this.filterNode.type = type;
            }

            if (cutoff !== undefined) {
                applyParamModulation(this, this.filterNode.frequency, cutoff, "_filterCutoffModulator");
            }

            if (resonance !== undefined && typeof resonance === "number") {
                this.filterNode.Q.setValueAtTime(resonance, ctx.currentTime);
            }
        }

        return this;
    }

    distort(amount) {
        const ctx = Motif.ctx;

        if (!this.distortionNode) {
            this.distortionNode = ctx.createWaveShaper();
            this.distortionNode.oversample = "4x";
            this._rebuildSignalChain();
        }

        if (amount === 0 || amount === null || amount === undefined) {
            this.distortionNode.curve = null;
        } else {
            const n = 44100;
            const curve = new Float32Array(n);
            const k = amount;
            for (let i = 0; i < n; i++) {
                const x = (i * 2) / n - 1;
                curve[i] = ((3 + k) * x) / (Math.PI + k * Math.abs(x));
            }
            this.distortionNode.curve = curve;
        }

        return this;
    }

    pan(amount) {
        const ctx = Motif.ctx;

        if (!this.pannerNode) {
            if (typeof ctx.createStereoPanner === "function") {
                this.pannerNode = ctx.createStereoPanner();
                this.pannerNode.pan.setValueAtTime(0, ctx.currentTime);
            }
            this._rebuildSignalChain();
        }

        if (this.pannerNode) {
            applyParamModulation(this, this.pannerNode.pan, amount, "_panModulator");
        }

        return this;
    }

    volume(db) {
        const ctx = Motif.ctx;

        if (!this.volumeNode) {
            this.volumeNode = ctx.createGain();
            this.volumeNode.gain.setValueAtTime(1.0, ctx.currentTime);
            this._rebuildSignalChain();
        }

        applyParamModulation(this, this.volumeNode.gain, db, "_volumeModulator", (val) => {
            return val === -Infinity ? 0 : Math.pow(10, val / 20);
        });

        return this;
    }

    eq(options = {}) {
        const ctx = Motif.ctx;

        if (!this.eqLowNode) {
            this.eqLowNode = ctx.createBiquadFilter();
            this.eqLowNode.type = "lowshelf";
            this.eqLowNode.frequency.setValueAtTime(320, ctx.currentTime);
            this.eqLowNode.gain.setValueAtTime(0, ctx.currentTime);

            this.eqMidNode = ctx.createBiquadFilter();
            this.eqMidNode.type = "peaking";
            this.eqMidNode.frequency.setValueAtTime(1000, ctx.currentTime);
            this.eqMidNode.Q.setValueAtTime(1, ctx.currentTime);
            this.eqMidNode.gain.setValueAtTime(0, ctx.currentTime);

            this.eqHighNode = ctx.createBiquadFilter();
            this.eqHighNode.type = "highshelf";
            this.eqHighNode.frequency.setValueAtTime(3200, ctx.currentTime);
            this.eqHighNode.gain.setValueAtTime(0, ctx.currentTime);

            this._rebuildSignalChain();
        }

        if (options) {
            const { low, mid, high } = options;

            const handleBand = (bandNode, bandData, modulatorKey) => {
                if (bandData === undefined) return;

                let gainVal = undefined;
                let freqVal = undefined;
                let qVal = undefined;

                if (typeof bandData === "number" || (bandData && (typeof bandData.connect === "function" || (bandData.output && typeof bandData.output.connect === "function")))) {
                    gainVal = bandData;
                } else if (bandData && typeof bandData === "object") {
                    gainVal = bandData.gain;
                    freqVal = bandData.frequency;
                    qVal = bandData.Q;
                }

                if (gainVal !== undefined) {
                    applyParamModulation(this, bandNode.gain, gainVal, modulatorKey);
                }

                if (freqVal !== undefined && typeof freqVal === "number") {
                    bandNode.frequency.setValueAtTime(freqVal, ctx.currentTime);
                }

                if (qVal !== undefined && typeof qVal === "number") {
                    bandNode.Q.setValueAtTime(qVal, ctx.currentTime);
                }
            };

            handleBand(this.eqLowNode, low, "_eqLowModulator");
            handleBand(this.eqMidNode, mid, "_eqMidModulator");
            handleBand(this.eqHighNode, high, "_eqHighModulator");
        }

        return this;
    }

    compress(options = {}) {
        const ctx = Motif.ctx;

        if (!this.compressorNode) {
            this.compressorNode = ctx.createDynamicsCompressor();
            this._rebuildSignalChain();
        }

        if (options) {
            const { threshold, knee, ratio, attack, release } = options;

            const handleParam = (param, value, modulatorKey) => {
                applyParamModulation(this, param, value, modulatorKey);
            };

            handleParam(this.compressorNode.threshold, threshold, "_compressorThresholdModulator");
            handleParam(this.compressorNode.knee, knee, "_compressorKneeModulator");
            handleParam(this.compressorNode.ratio, ratio, "_compressorRatioModulator");
            handleParam(this.compressorNode.attack, attack, "_compressorAttackModulator");
            handleParam(this.compressorNode.release, release, "_compressorReleaseModulator");
        }

        return this;
    }
}

class TrackClass extends EffectChain {
    constructor(id) {
        super();
        this.id = id || `track_${Math.random().toString(36).substr(2, 9)}`;
        this._initAudioChain();
        this._initVoiceManager();
        this._initScheduler();
    }

    get _isTrack() {
        return true;
    }
}

Object.assign(TrackClass.prototype, TrackAudioChain);
Object.assign(TrackClass.prototype, TrackVoiceManager);
Object.assign(TrackClass.prototype, TrackScheduler);

const busRegistry = new Map();

class BusClass extends EffectChain {
    constructor(id) {
        super();
        this.id = id || `bus_${Math.random().toString(36).substr(2, 9)}`;
        this.input = null;
        this.output = null;
        this.feedbackGainNode = null;
        this.feedbackDelayNode = null;

        this._initAudio();
    }

    _initAudio() {
        if (this.input) return;
        Motif.init();
        const ctx = Motif.ctx;
        this.input = ctx.createGain();
        this.input.gain.setValueAtTime(1.0, ctx.currentTime);
        this.output = ctx.createGain();
        this.output.gain.setValueAtTime(1.0, ctx.currentTime);

        this._rebuildSignalChain();
    }

    _rebuildSignalChain() {
        if (!this.input) return;

        const nodes = [
            this.input,
            this.filterNode,
            this.distortionNode,
            this.pannerNode,
            this.eqLowNode,
            this.eqMidNode,
            this.eqHighNode,
            this.compressorNode,
            this.volumeNode,
            this.output,
        ];

        reconnectNodes(nodes, Motif.masterGain);

        if (this.feedbackGainNode) {
            this.output.connect(this.feedbackGainNode);
        }
    }

    feedback({ amount = 0.5 } = {}) {
        const ctx = Motif.ctx;
        const sampleRate = ctx.sampleRate || 44100;
        const minDelay = 128 / sampleRate;

        if (!this.feedbackDelayNode) {
            this.feedbackDelayNode = ctx.createDelay ? ctx.createDelay(1) : ctx.createDelay();
            this.feedbackDelayNode.delayTime.setValueAtTime(minDelay, ctx.currentTime);
            this.feedbackGainNode = ctx.createGain();
            this.feedbackGainNode.gain.setValueAtTime(amount, ctx.currentTime);

            this.output.connect(this.feedbackGainNode);
            this.feedbackGainNode.connect(this.feedbackDelayNode);
            this.feedbackDelayNode.connect(this.input);
        } else {
            this.feedbackGainNode.gain.setValueAtTime(amount, ctx.currentTime);
        }

        return this;
    }
}

export function Bus(id) {
    if (id && busRegistry.has(id)) {
        return busRegistry.get(id);
    }
    const b = new BusClass(id);
    if (id) {
        busRegistry.set(id, b);
    }
    return b;
}

Bus.clearRegistry = function() {
    for (const bus of busRegistry.values()) {
        safeDisconnect(bus.input);
        safeDisconnect(bus.output);
        safeDisconnect(bus.feedbackDelayNode);
        safeDisconnect(bus.feedbackGainNode);
        const modulators = [
            "_filterCutoffModulator",
            "_panModulator",
            "_eqLowModulator",
            "_eqMidModulator",
            "_eqHighModulator",
            "_volumeModulator",
            "_compressorThresholdModulator",
            "_compressorKneeModulator",
            "_compressorRatioModulator",
            "_compressorAttackModulator",
            "_compressorReleaseModulator",
        ];
        for (const prop of modulators) {
            safeDisconnect(bus[prop]);
        }
    }
    busRegistry.clear();
};

Bus.pruneExcept = function(activeIds) {
    const ids = new Set(activeIds || []);
    for (const [id, bus] of busRegistry.entries()) {
        if (!ids.has(id)) {
            safeDisconnect(bus.input);
            safeDisconnect(bus.output);
            safeDisconnect(bus.feedbackDelayNode);
            safeDisconnect(bus.feedbackGainNode);
            const modulators = [
                "_filterCutoffModulator",
                "_panModulator",
                "_eqLowModulator",
                "_eqMidModulator",
                "_eqHighModulator",
                "_volumeModulator",
                "_compressorThresholdModulator",
                "_compressorKneeModulator",
                "_compressorRatioModulator",
                "_compressorAttackModulator",
                "_compressorReleaseModulator",
            ];
            for (const prop of modulators) {
                safeDisconnect(bus[prop]);
            }
            busRegistry.delete(id);
        }
    }
};

export function Track(id) {
    if (id && trackRegistry.has(id)) {
        const oldTrack = trackRegistry.get(id);
        const newTrack = new TrackClass(id);
        trackRegistry.set(id, newTrack);
        oldTrack._crossfadeOut(newTrack);
        return newTrack;
    }
    const t = new TrackClass(id);
    if (id) {
        trackRegistry.set(id, t);
    }
    return t;
}

Track.clearRegistry = function() {
    for (const track of trackRegistry.values()) {
        if (typeof track._stopAllVoices === "function") {
            track._stopAllVoices();
        }
        if (typeof track._resetScheduling === "function") {
            track._resetScheduling();
        }
        safeDisconnect(track.trackInputNode);
        safeDisconnect(track.muteGainNode);
        safeDisconnect(track.preFaderNode);
        if (track._sends) {
            for (const sendGainNode of track._sends.values()) {
                safeDisconnect(sendGainNode);
            }
        }
        if (track._modulators) {
            for (const prev of track._modulators.values()) {
                safeDisconnect(prev.depthGain);
            }
        }
        const modulators = [
            "_filterCutoffModulator",
            "_panModulator",
            "_eqLowModulator",
            "_eqMidModulator",
            "_eqHighModulator",
            "_volumeModulator",
            "_compressorThresholdModulator",
            "_compressorKneeModulator",
            "_compressorRatioModulator",
            "_compressorAttackModulator",
            "_compressorReleaseModulator",
        ];
        for (const prop of modulators) {
            safeDisconnect(track[prop]);
        }
    }
    trackRegistry.clear();
};

Track.pruneExcept = function(activeIds) {
    const ids = new Set(activeIds || []);
    for (const [id, track] of trackRegistry.entries()) {
        if (id !== "__temp_probe__" && !ids.has(id)) {
            if (typeof track._stopAllVoices === "function") {
                track._stopAllVoices();
            }
            if (typeof track._resetScheduling === "function") {
                track._resetScheduling();
            }
            safeDisconnect(track.trackInputNode);
            safeDisconnect(track.muteGainNode);
            safeDisconnect(track.preFaderNode);
            if (track._sends) {
                for (const sendGainNode of track._sends.values()) {
                    safeDisconnect(sendGainNode);
                }
            }
            if (track._modulators) {
                for (const prev of track._modulators.values()) {
                    safeDisconnect(prev.depthGain);
                }
            }
            const modulators = [
                "_filterCutoffModulator",
                "_panModulator",
                "_eqLowModulator",
                "_eqMidModulator",
                "_eqHighModulator",
                "_volumeModulator",
                "_compressorThresholdModulator",
                "_compressorKneeModulator",
                "_compressorRatioModulator",
                "_compressorAttackModulator",
                "_compressorReleaseModulator",
            ];
            for (const prop of modulators) {
                safeDisconnect(track[prop]);
            }
            trackRegistry.delete(id);
        }
    }
};

export class LFOSignal {
    constructor(osc, gainNode, constantSource) {
        this.osc = osc;
        this.gainNode = gainNode;
        this.constantSource = constantSource;
        this.output = constantSource || gainNode;
    }

    connect(param) {
        if (param && typeof param.setValueAtTime === "function") {
            param.setValueAtTime(0, Motif.ctx.currentTime);
        }
        this.output.connect(param);
        return this;
    }

    disconnect(param) {
        if (param) {
            this.output.disconnect(param);
        } else {
            this.output.disconnect();
        }
        return this;
    }
}

function createLFO(type, options) {
    Motif.init();
    const ctx = Motif.ctx;

    let frequency = 1.0;
    let depth = 1.0;
    let offset = 0.0;

    if (typeof options === "number") {
        frequency = options;
    } else if (options && typeof options === "object") {
        if (options.frequency !== undefined) {
            frequency = options.frequency;
        } else if (options.speed !== undefined) {
            if (typeof options.speed === "number") {
                frequency = 1 / options.speed;
            } else {
                const seconds = parseDurationToSeconds(options.speed, Motif.tempo, Motif.beatsPerBar);
                frequency = seconds > 0 ? 1 / seconds : 1.0;
            }
        }

        if (options.min !== undefined && options.max !== undefined) {
            depth = (options.max - options.min) / 2;
            offset = (options.max + options.min) / 2;
        } else {
            if (options.depth !== undefined) {
                depth = options.depth;
            } else if (options.gain !== undefined) {
                depth = options.gain;
            }
            if (options.offset !== undefined) {
                offset = options.offset;
            }
        }
    }

    const osc = ctx.createOscillator();
    osc.type = type === "saw" ? "sawtooth" : type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(depth, ctx.currentTime);

    osc.connect(gainNode);

    let constantSource = null;
    if (typeof ctx.createConstantSource === "function") {
        constantSource = ctx.createConstantSource();
        constantSource.offset.setValueAtTime(offset, ctx.currentTime);
        gainNode.connect(constantSource.offset);
        constantSource.start();
    }

    osc.start();

    return new LFOSignal(osc, gainNode, constantSource);
}

export const LFO = {
    sine(options) {
        return createLFO("sine", options);
    },
    triangle(options) {
        return createLFO("triangle", options);
    },
    square(options) {
        return createLFO("square", options);
    },
    saw(options) {
        return createLFO("saw", options);
    },
};

// ============================================================================
// Audio Initialization Decorators / Wrappers
// ============================================================================

/**
 * Ensures that the global MotifEngine (or target instance) is initialized
 * before executing the wrapped method.
 */
function ensureInit(fn) {
    return function(...args) {
        if (typeof this.init === "function") {
            this.init();
        } else {
            Motif.init();
        }
        return fn.apply(this, args);
    };
}

/**
 * Ensures that the track or bus instance has its audio nodes initialized
 * before executing the wrapped method.
 */
function ensureAudio(fn) {
    return function(...args) {
        this._initAudio();
        return fn.apply(this, args);
    };
}

// Wrap MotifEngine prototype methods to automatically call init()
const motifMethodsToEnsure = [
    "start",
    "pause",
    "stop",
    "schedule",
    "setTempo",
    "rampTempo",
    "master",
    "_loadAndCacheBuffer",
];
for (const method of motifMethodsToEnsure) {
    if (MotifEngine.prototype[method]) {
        MotifEngine.prototype[method] = ensureInit(MotifEngine.prototype[method]);
    }
}

// Wrap EffectChain prototype methods to automatically call _initAudio()
const effectChainMethodsToEnsure = [
    "filter",
    "distort",
    "pan",
    "volume",
    "eq",
    "compress",
];
for (const method of effectChainMethodsToEnsure) {
    if (EffectChain.prototype[method]) {
        EffectChain.prototype[method] = ensureAudio(EffectChain.prototype[method]);
    }
}

// Wrap TrackClass prototype methods to automatically call _initAudio() or ensureInit()
const trackMethodsToEnsure = [
    "send",
    "modulate",
    "sidechain",
    "dsp",
    "mute",
    "_playEvent",
];
for (const method of trackMethodsToEnsure) {
    if (TrackClass.prototype[method]) {
        TrackClass.prototype[method] = ensureAudio(TrackClass.prototype[method]);
    }
}

const trackMethodsToEnsureInit = [
    "sample",
    "sampler",
];
for (const method of trackMethodsToEnsureInit) {
    if (TrackClass.prototype[method]) {
        TrackClass.prototype[method] = ensureInit(TrackClass.prototype[method]);
    }
}


/**
 * Motif Procedural Instrument & Sample Library
 *
 * Section 1: Generative DSP Synths (Real-time calculation per-sample)
 * Section 2: Static Audio Samples (Pre-rendered buffers for percussion and one-shots)
 */

// Global DSP Constant caching for optimization
const TWO_PI = Math.PI * 2.0;

// ==============================================================================
// 1. SYNTH REGISTRY (Real-time Generative DSP Functions)
// ==============================================================================
// These functions evaluate per-sample. The engine passes a `ctx` object:
// - t: time in seconds since the note began
// - p: normalized phase (0.0 to 1.0) of the current cycle
// - freq: current target frequency in Hz
// - state: object for persisting continuous state (e.g., filters, noise memory)
// - sampleRate: the audio context sample rate

const MotifSynths = {
    // ------------------------------------------
    // CLASSIC ANALOG & RETRO WAVEFORMS
    // ------------------------------------------

    "sine": (ctx) => Math.sin(ctx.p * TWO_PI),

    "sawtooth": (ctx) => (ctx.p * 2.0) - 1.0,

    "square": (ctx) => ctx.p < 0.5 ? 1.0 : -1.0,

    "triangle": (ctx) => Math.abs(ctx.p * 4.0 - 2.0) - 1.0,

    "pulse": (ctx) => ctx.p < 0.15 ? 1.0 : -1.0, // 15% narrow duty cycle

    // A blocky, retro 25% duty cycle pulse wave, perfect for nostalgic chiptune leads
    "chip-pulse": (ctx) => ctx.p < 0.25 ? 1.0 : -1.0,

    // Thick, sweeping pulse width modulation
    "pwm-sweep": (ctx) => {
        // LFO sweeping between 10% and 90% duty cycle
        const lfo = 0.5 + Math.sin(ctx.t * 3.0) * 0.4;
        return ctx.p < lfo ? 1.0 : -1.0;
    },

    // Heavy sub bass with upper harmonics for audibility on small speakers
    "sub-bass": (ctx) => {
        const sine = Math.sin(ctx.p * TWO_PI);
        const tri = Math.abs(ctx.p * 4.0 - 2.0) - 1.0;
        // Tanh adds subtle analog drive
        return Math.tanh((sine * 0.7 + tri * 0.3) * 1.5);
    },

    // Multiple detuned sawtooths for massive trance/pad leads
    "supersaw": (ctx) => {
        // Calculate independent continuous phases to allow organic detuning and pitch-bending.
        // Safely wrapped % 1.0 to prevent 64-bit float precision degradation on long notes.
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 1.007) / ctx.sampleRate) % 1.0;
        ctx.state.p3 = ((ctx.state.p3 || 0) + (ctx.freq * 0.993) / ctx.sampleRate) % 1.0;
        ctx.state.p4 = ((ctx.state.p4 || 0) + (ctx.freq * 1.015) / ctx.sampleRate) % 1.0;
        ctx.state.p5 = ((ctx.state.p5 || 0) + (ctx.freq * 0.985) / ctx.sampleRate) % 1.0;

        const s1 = ctx.state.p1 * 2.0 - 1.0;
        const s2 = ctx.state.p2 * 2.0 - 1.0;
        const s3 = ctx.state.p3 * 2.0 - 1.0;
        const s4 = ctx.state.p4 * 2.0 - 1.0;
        const s5 = ctx.state.p5 * 2.0 - 1.0;
        return (s1 + s2 + s3 + s4 + s5) / 5.0;
    },

    // Softened square wave built from additive harmonics (fundamental + 3rd + 5th)
    // Much warmer and less harsh than a pure digital square wave
    "soft-square": (ctx) => {
        const w = ctx.p * TWO_PI;
        const h1 = Math.sin(w);
        const h3 = Math.sin(w * 3) / 3;
        const h5 = Math.sin(w * 5) / 5;
        return (h1 + h3 + h5) * 1.2;
    },

    // ------------------------------------------
    // TAPE, LO-FI, AND AMBIENT TEXTURES
    // ------------------------------------------

    // A pure sine wave but with slow, randomized pitch flutter mimicking old VHS tapes
    "tape-sine": (ctx) => {
        // Continuous phase tracking
        ctx.state.phase = ctx.state.phase || 0;
        ctx.state.phase = (ctx.state.phase + ctx.freq / ctx.sampleRate) % 1.0;

        // Wow and flutter calculated in radians
        const wow = Math.sin(ctx.t * 2.0) * 0.05;
        const flutter = Math.sin(ctx.t * 8.0) * 0.01;
        const tapeMod = wow + flutter;

        // Notice tapeMod is added directly to the base phase, unaffected by pitch
        return Math.sin((ctx.state.phase * TWO_PI) + tapeMod);
    },

    // A warm, melancholic pad using heavily low-passed, slightly detuned sines
    "ambient-pad": (ctx) => {
        // Initialize continuous independent phases
        ctx.state.p1 = ctx.state.p1 || 0;
        ctx.state.p2 = ctx.state.p2 || 0;

        // Accumulate phase based on the CURRENT sample's frequency
        ctx.state.p1 = (ctx.state.p1 + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.p2 = (ctx.state.p2 + (ctx.freq * 1.004) / ctx.sampleRate) % 1.0;

        const s1 = Math.sin(TWO_PI * ctx.state.p1);
        const s2 = Math.sin(TWO_PI * ctx.state.p2);

        // Simulate a gentle, slow-opening filter via amplitude
        const swell = Math.min(1.0, ctx.t * 0.5);
        return ((s1 + s2) / 2.0) * swell;
    },

    // ------------------------------------------
    // NOISE & TEXTURE
    // ------------------------------------------

    // Pure random digital static
    "noise-white": (ctx) => Math.random() * 2.0 - 1.0,

    // True Pink Noise (-3dB/octave) using Paul Kellett's cascaded filter approximation
    "noise-pink": (ctx) => {
        // Flattened object properties are much faster than array indexing in V8 hot loops
        ctx.state.b0 = ctx.state.b0 || 0;
        ctx.state.b1 = ctx.state.b1 || 0;
        ctx.state.b2 = ctx.state.b2 || 0;
        ctx.state.b3 = ctx.state.b3 || 0;
        ctx.state.b4 = ctx.state.b4 || 0;
        ctx.state.b5 = ctx.state.b5 || 0;
        ctx.state.b6 = ctx.state.b6 || 0;

        const white = Math.random() * 2.0 - 1.0;

        // Kellett's Magic Coefficients
        ctx.state.b0 = 0.99886 * ctx.state.b0 + white * 0.0555179;
        ctx.state.b1 = 0.99332 * ctx.state.b1 + white * 0.0750759;
        ctx.state.b2 = 0.96900 * ctx.state.b2 + white * 0.1538520;
        ctx.state.b3 = 0.86650 * ctx.state.b3 + white * 0.3104856;
        ctx.state.b4 = 0.55000 * ctx.state.b4 + white * 0.5329522;
        ctx.state.b5 = -0.7616 * ctx.state.b5 - white * 0.0168980;

        // Sum the cascading filters
        const pink = ctx.state.b0 + ctx.state.b1 + ctx.state.b2 +
            ctx.state.b3 + ctx.state.b4 + ctx.state.b5 +
            ctx.state.b6 + (white * 0.5362);

        ctx.state.b6 = white * 0.115926;

        return pink * 0.15; // Scale down, as summing increases gain drastically
    },

    // 1-pole lowpass filtered white noise
    "noise-brown": (ctx) => {
        ctx.state.b0 = ctx.state.b0 || 0;
        const white = Math.random() * 2.0 - 1.0;
        ctx.state.b0 = (ctx.state.b0 * 0.8) + (white * 0.2);
        return ctx.state.b0 * 1.5;
    },

    // Deep, rumbling noise (leaky integrator)
    "noise-brown-deep": (ctx) => {
        ctx.state.val = ctx.state.val || 0;
        const white = Math.random() * 2.0 - 1.0;
        ctx.state.val = (ctx.state.val * 0.95) + (white * 0.05);
        return ctx.state.val * 2.0;
    },

    // Sparse, randomized spikes mimicking vinyl dust or broken cables
    "crackle": (ctx) => {
        // Goal: 5 random pops per second based on sample rate
        const threshold = 1.0 - (5 / ctx.sampleRate);

        let rawSpike = 0;
        if (Math.random() > threshold) {
            rawSpike = Math.random() * 2.0 - 1.0;
        }

        // Soften the digital 1-sample spike into a warm "thump/pop"
        ctx.state.filter = ctx.state.filter || 0;
        ctx.state.filter = (ctx.state.filter * 0.8) + (rawSpike * 0.2);

        return ctx.state.filter * 5.0; // Boost gain to compensate for filtering
    },

    // ------------------------------------------
    // MATHEMATICAL & GENERATIVE GLITCH
    // ------------------------------------------

    // Algorithmic fractal tearing. Interprets continuous time as an 8kHz bitwise integer
    "bytebeat": (ctx) => {
        const tInt = Math.floor(ctx.t * 8000);
        const val = (tInt * (ctx.freq / 100)) & (tInt >> 4) & (tInt >> 8);
        return (val % 256) / 128.0 - 1.0;
    },

    // A harsh, highly compressed downsampled sine wave (pseudo-bitcrush)
    "bit-crush-sine": (ctx) => {
        // Quantize the amplitude to 8 discrete levels
        const levels = 8;
        const raw = Math.sin(ctx.p * TWO_PI);
        return Math.round(raw * levels) / levels;
    },

    // Pure tangent wave, heavily clamped to avoid audio graph blowouts
    "math-tan": (ctx) => {
        const val = Math.tan(ctx.p * Math.PI);
        return Math.max(-1.0, Math.min(1.0, val * 0.2)); // Clamped & attenuated
    },

    // A sine wave that frequency-modulates itself based on phase
    "math-fold": (ctx) => {
        const base = Math.sin(ctx.p * TWO_PI);
        return Math.sin((ctx.p + base * 0.5) * TWO_PI);
    },

    // ------------------------------------------
    // INSTRUMENT MODELING (Plucks, Bells & Keys)
    // ------------------------------------------

    // 4-Operator style electric piano with sharp transient
    "fm-epiano": (ctx) => {
        ctx.state.phase = ((ctx.state.phase || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        const modIndex = 2.5 * Math.exp(-ctx.t * 8);
        const modulator = Math.sin(TWO_PI * ctx.state.phase);
        const carrier = Math.sin(TWO_PI * ctx.state.phase + modIndex * modulator);
        return carrier * 0.6;
    },

    // A gentle, floating bell sound using Frequency Modulation.
    // Melancholic and perfect for slow ambient arpeggios.
    "ambient-bell": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 2.0) / ctx.sampleRate) % 1.0;
        // Modulator is 2x the frequency (an octave up)
        const mod = Math.sin(TWO_PI * ctx.state.p2) * Math.exp(-ctx.t * 3.0);
        const carrier = Math.sin(TWO_PI * ctx.state.p1 + mod * 1.5);
        return carrier * Math.exp(-ctx.t * 0.5) * 0.8;
    },

    // Generative Kalimba: Physically modeled thumb piano using non-integer harmonics
    "tine-fm": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 2.73) / ctx.sampleRate) % 1.0;
        // A tine has a fundamental and a sharp, metallic inharmonic overtone (approx 2.7x)
        const fundamental = Math.sin(TWO_PI * ctx.state.p1);
        const overtone = Math.sin(TWO_PI * ctx.state.p2) * Math.exp(-ctx.t * 15);
        // The initial strike click of the thumbnail
        const click = Math.random() * Math.exp(-ctx.t * 300) * 0.1;

        return (fundamental * Math.exp(-ctx.t * 2.5) + overtone * 0.4 + click) * 0.8;
    },

    // Physically modeled plucked string (Acoustic Guitar / Harp)
    "karplus-strong": (ctx) => {
        // Calculate required delay line length for frequency
        const delayLength = Math.floor(ctx.sampleRate / ctx.freq);

        if (!ctx.state.buffer) {
            // Initialize delay line with burst of white noise (the "pluck")
            ctx.state.buffer = new Float32Array(delayLength);
            for (let i = 0; i < delayLength; i++) {
                ctx.state.buffer[i] = Math.random() * 2.0 - 1.0;
            }
            ctx.state.ptr = 0;
        }

        // Read current sample
        const currentSample = ctx.state.buffer[ctx.state.ptr];

        // Lowpass filter & dampen (simulates energy loss in a string)
        const nextPtr = (ctx.state.ptr + 1) % delayLength;
        const nextSample = ctx.state.buffer[nextPtr];
        const filtered = (currentSample + nextSample) * 0.5 * 0.995; // 0.995 is decay factor

        // Write back to delay line
        ctx.state.buffer[ctx.state.ptr] = filtered;
        ctx.state.ptr = nextPtr;

        return currentSample;
    },

    // Warm, slow-attacking choral/vocal pad using formants
    "pad-choir": (ctx) => {
        // 1. Generate a rich harmonic source (Sawtooth)
        const source = (ctx.p * 2.0) - 1.0;

        // 2. Initialize filter states
        ctx.state.f1_bp = ctx.state.f1_bp || 0;
        ctx.state.f1_low = ctx.state.f1_low || 0;
        ctx.state.f2_bp = ctx.state.f2_bp || 0;
        ctx.state.f2_low = ctx.state.f2_low || 0;

        // 3. Fixed Formant Frequencies for an "Ah" vowel
        const formant1 = 730;
        const formant2 = 1090;

        // Filter 1 (SVF math)
        const q = 0.2; // Resonance bandwidth
        const w1 = 2.0 * Math.sin(Math.PI * formant1 / ctx.sampleRate);
        const high1 = source - ctx.state.f1_low - (q * ctx.state.f1_bp);
        ctx.state.f1_bp += w1 * high1;
        ctx.state.f1_low += w1 * ctx.state.f1_bp;

        // Filter 2 (SVF math)
        const w2 = 2.0 * Math.sin(Math.PI * formant2 / ctx.sampleRate);
        const high2 = source - ctx.state.f2_low - (q * ctx.state.f2_bp);
        ctx.state.f2_bp += w2 * high2;
        ctx.state.f2_low += w2 * ctx.state.f2_bp;

        const attack = Math.min(1.0, ctx.t * 2.0);

        // Mix the two formants together
        return (ctx.state.f1_bp + ctx.state.f2_bp) * attack * 1.5;
    },

    // Synthesized brass section (Sawtooth with built-in lowpass sweep)
    "synth-brass": (ctx) => {
        const saw = (ctx.p * 2.0) - 1.0;

        // Internal ADSR sweeping a lowpass filter
        const env = Math.min(1.0, ctx.t * 10) * Math.exp(-ctx.t * 1.5);

        // Clamped cutoff to safely max at sampleRate/6 to prevent mathematical SVF blowout
        const cutoff = Math.min(200 + (3000 * env), ctx.sampleRate / 6.0);

        ctx.state.low = ctx.state.low || 0;
        ctx.state.band = ctx.state.band || 0;
        const f = 2.0 * Math.sin(Math.PI * cutoff / ctx.sampleRate);

        const high = saw - ctx.state.low - (0.5 * ctx.state.band);
        ctx.state.band += f * high;
        ctx.state.low += f * ctx.state.band;

        return ctx.state.low;
    },
};


// ==============================================================================
// 2. SAMPLE REGISTRY (Static Audio Buffers)
// ==============================================================================
// Evaluated ONCE at startup to populate memory. Ideal for precise, rigid 
// drum transients, percussion, and static one-shots.

const MotifSamples = (() => {
    let sampleRate = 44100;
    const createBuffer = (durationSeconds) => {
        if (!Motif.ctx) return null;
        sampleRate = Motif.ctx.sampleRate;
        return Motif.ctx.createBuffer(1, sampleRate * durationSeconds, sampleRate);
    };

    return {
        // ------------------------------------------
        // ELECTRONIC & SYNTHESIZED DRUMS
        // ------------------------------------------

        "kick-electronic": () => {
            const buffer = createBuffer(0.5);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const freq = 45 + 800 * Math.exp(-t * 50); // Massive pitch envelope
                phase += freq / sampleRate;

                const sine = Math.sin(TWO_PI * phase);
                const env = Math.exp(-t * 6);
                data[i] = Math.tanh(sine * 2.0) * env; // Saturated
            }
            return buffer;
        },

        // A muffled, deep, nostalgic kick drum with no harsh top-end
        "kick-lofi": () => {
            const buffer = createBuffer(0.4);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const freq = 50 + 100 * Math.exp(-t * 30); // Very subtle pitch drop
                phase += freq / sampleRate;

                // Pure sine, rapidly decaying, completely clean
                data[i] = Math.sin(TWO_PI * phase) * Math.exp(-t * 12);
            }
            return buffer;
        },

        "snare-electronic": () => {
            const buffer = createBuffer(0.35);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const tone = Math.sin(TWO_PI * 220 * t) + Math.sin(TWO_PI * 340 * t);
                const noise = Math.random() * 2 - 1;

                const toneEnv = Math.exp(-t * 20);
                const noiseEnv = Math.exp(-t * 12);
                data[i] = (tone * toneEnv * 0.4 + noise * noiseEnv * 0.6);
            }
            return buffer;
        },

        "tom-electronic": () => {
            const buffer = createBuffer(0.6);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Pitch drops from high to a resting mid-tone
                const freq = 110 + 200 * Math.exp(-t * 20);
                phase += freq / sampleRate;

                data[i] = Math.sin(TWO_PI * phase) * Math.exp(-t * 5);
            }
            return buffer;
        },

        "rimshot": () => {
            const buffer = createBuffer(0.15);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Two very high FM-style oscillators tightly enveloped
                const tone = Math.sin(TWO_PI * 800 * t) * Math.exp(-t * 40);
                const click = Math.sin(TWO_PI * 1800 * t) * Math.exp(-t * 120);
                data[i] = (tone + click) * 0.8;
            }
            return buffer;
        },

        "hihat-closed": () => {
            const buffer = createBuffer(0.15);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let b0 = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Interleaved square waves (classic 808 style ring)
                const sq1 = Math.sin(TWO_PI * 400 * t) > 0 ? 1 : -1;
                const sq2 = Math.sin(TWO_PI * 600 * t) > 0 ? 1 : -1;
                const sq3 = Math.sin(TWO_PI * 800 * t) > 0 ? 1 : -1;

                // Highpass the ring
                const raw = (sq1 + sq2 + sq3) / 3;
                b0 += 0.5 * (raw - b0);
                const hp = raw - b0;

                data[i] = hp * Math.exp(-t * 40); // Very tight decay
            }
            return buffer;
        },

        "cymbal-ride": () => {
            const buffer = createBuffer(1.5);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);

            // 6 inharmonic frequencies common in TR-series cymbals
            const freqs = [205.3, 289.5, 334.4, 412.1, 543.2, 693.4];
            let b0 = 0, b1 = 0; // Highpass filter state

            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Sum inharmonic square waves
                let oscs = 0;
                for (let f of freqs) {
                    oscs += Math.sin(TWO_PI * f * t) > 0 ? 1 : -1;
                }
                oscs /= freqs.length;

                // 2-pole Highpass Filter at ~6000Hz (creates the metallic "tsss")
                const cutoff = 6000 / sampleRate;
                b0 += cutoff * (oscs - b0);
                b1 += cutoff * (b0 - b1);
                const highpass = oscs - b1;

                // Fast attack, long smooth tail
                const env = Math.exp(-t * 3.5);
                data[i] = highpass * env * 1.2;
            }
            return buffer;
        },

        // A very soft, filtered noise sweep, like sand or a gentle shaker
        "shaker-soft": () => {
            const buffer = createBuffer(0.25);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let b0 = 0; // Filter state

            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = Math.random() * 2 - 1;

                // 1-pole highpass filter at ~4000Hz to make it "sandy"
                const cutoff = 4000 / sampleRate;
                b0 += cutoff * (noise - b0);
                const highpass = noise - b0;

                // Smooth rounded attack mimicking a wrist motion
                let env = 0;
                if (t < 0.03) {
                    env = Math.sin((t / 0.03) * (Math.PI / 2)); // Quarter-sine attack
                } else {
                    env = Math.exp(-(t - 0.03) * 20); // Decay
                }

                data[i] = highpass * env * 1.5;
            }
            return buffer;
        },

        "clap-vintage": () => {
            const buffer = createBuffer(0.3);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = Math.random() * 2 - 1;
                // Three staggered amplitude spikes to simulate group clapping
                let env = 0;
                if (t < 0.010) env = Math.exp(-t * 200);
                else if (t < 0.020) env = Math.exp(-(t - 0.01) * 200);
                else if (t < 0.030) env = Math.exp(-(t - 0.02) * 200);
                else env = Math.exp(-(t - 0.03) * 15); // Long tail

                data[i] = noise * env;
            }
            return buffer;
        },

        // ------------------------------------------
        // AMBIENT & ORGANIC PERCUSSION
        // ------------------------------------------

        // A resonant, pitch-rising sine sweep mimicking a water droplet falling in a cave
        "water-drop": () => {
            const buffer = createBuffer(0.15);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Pitch rockets UPWARD rapidly
                const freq = 400 + 1500 * (1.0 - Math.exp(-t * 40));
                phase += freq / sampleRate;

                data[i] = Math.sin(TWO_PI * phase) * Math.exp(-t * 25);
            }
            return buffer;
        },

        // A heavily resonant, hollow wood tap (like a marimba bar or empty log)
        "block-hollow": () => {
            const buffer = createBuffer(0.3);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const body = Math.sin(TWO_PI * 350 * t);
                const over = Math.sin(TWO_PI * 750 * t) * 0.4;
                data[i] = (body + over) * Math.exp(-t * 18);
            }
            return buffer;
        },

        // ------------------------------------------
        // ACOUSTIC & PHYSICAL MODELING (Plucks & Mallets)
        // ------------------------------------------

        "kick-acoustic": () => {
            const buffer = createBuffer(0.5);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const freq = 55 + 60 * Math.exp(-t * 15); // Subtle pitch drop
                phase += freq / sampleRate;

                // Muffled resonance + click of the beater hitting the skin
                const body = Math.sin(TWO_PI * phase);
                const beater = (Math.random() * 2 - 1) * Math.exp(-t * 200) * 0.1;

                data[i] = (body + beater) * Math.exp(-t * 8);
            }
            return buffer;
        },

        // Standard Kalimba pluck. Bright transient, pure resonant body.
        "kalimba-pluck": () => {
            const buffer = createBuffer(0.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const click = Math.random() * Math.exp(-t * 400) * 0.15; // Tine pluck
                const body = Math.sin(TWO_PI * 440 * t) + (Math.sin(TWO_PI * 880 * t) * 0.1);
                data[i] = (click + body) * Math.exp(-t * 3);
            }
            return buffer;
        },

        // A much softer, warmer kalimba with a rounded attack, mimicking a wooden thumb piano
        "kalimba-warm": () => {
            const buffer = createBuffer(1.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Softened attack ramp
                const attack = t < 0.01 ? (t / 0.01) : 1.0;
                const body = Math.sin(TWO_PI * 320 * t) * 0.8;
                const overtone = Math.sin(TWO_PI * 870 * t) * 0.2; // Inharmonic resonance
                data[i] = (body + overtone) * attack * Math.exp(-t * 2);
            }
            return buffer;
        },

        // A tiny, high-pitched, fragile tinkling sound
        "music-box": () => {
            const buffer = createBuffer(0.6);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const click = (Math.random() * 2 - 1) * Math.exp(-t * 800) * 0.2; // Gear plucking comb
                const fundamental = Math.sin(TWO_PI * 1200 * t); // High pitch
                data[i] = (click + fundamental) * Math.exp(-t * 8) * 0.5;
            }
            return buffer;
        },

        "wineglass": () => {
            const buffer = createBuffer(2.0); // Long sustained buffer
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0; // The accumulator

            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // 1. Calculate current frequency
                const vibrato = Math.sin(TWO_PI * 5 * t) * 2.0;
                const currentFreq = 880 + vibrato;

                // 2. Accumulate phase step-by-step
                phase += currentFreq / sampleRate;

                // 3. Generate wave using the accumulated phase
                const tone = Math.sin(TWO_PI * phase);
                const attack = Math.min(1.0, t * 1.5);
                const decay = Math.exp(-t * 0.8);

                data[i] = tone * attack * decay * 0.4;
            }
            return buffer;
        },

        "timpani": () => {
            const buffer = createBuffer(1.5);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Large drum body dropping into pitch slightly
                const freq = 80 + 20 * Math.exp(-t * 10);
                phase += freq / sampleRate;

                const skin = Math.sin(TWO_PI * phase);
                const mallet = (Math.random() * 2 - 1) * Math.exp(-t * 80) * 0.05; // Soft strike
                const attack = Math.min(1.0, t * 50); // slight ramping so it doesn't click

                data[i] = (skin + mallet) * attack * Math.exp(-t * 2.5);
            }
            return buffer;
        },
    };
})();

// ==============================================================================
// 3. REGISTRATION / INITIALIZATION
// ==============================================================================

// Push live generative expressions into the Synth Engine
Object.entries(MotifSynths).forEach(([id, dspFunction]) => {
    Motif.synthRegistry.set(id, dspFunction);
});

// Render and cache static audio arrays into the Sample Engine
Object.entries(MotifSamples).forEach(([id, bufferGenerator]) => {
    Motif.sampleRegistry.set(id, bufferGenerator);
});

console.log("Motif: Loaded Procedural Synths & Acoustic Samples.");