/**
 * Motif: Declarative, native-JavaScript DSL for algorithmic composition.
 */

import {
    sampleBufferCache,
    trackRegistry,
    applyParamModulation,
    disposeModulationBindings,
    SimplexNoise,
    safeDisconnect,
    reconnectNodes,
    ensureGranularStretcher,
    sourceReadinessListeners,
    notifySourceReadinessChange,
} from "./src/helpers.js";
import { TrackAudioChain } from "./src/TrackAudioChain.js";
import { TrackVoiceManager, ensureSynthWorklet } from "./src/TrackVoiceManager.js";
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
 * Creates a ramp primitive for interpolation; pitched synth steps use the explicit duration or their gate duration.
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
export function Arrange(sections, options = {}) {
    if (!Array.isArray(sections)) return;

    Motif._arrangementSections = sections;
    if (options && typeof options === "object") {
        Motif._arrangementOptions = options;
    } else {
        Motif._arrangementOptions = {};
    }

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

    let startIndex = -1;
    for (let i = sections.length - 1; i >= 0; i--) {
        if (sections[i].s || sections[i].start) {
            startIndex = i;
            break;
        }
    }

    const activeSections = startIndex !== -1 ? sections.slice(startIndex) : sections;

    const activeTracks = new Set();
    for (const section of activeSections) {
        if (section.tracks && Array.isArray(section.tracks)) {
            for (const track of section.tracks) {
                if (track) {
                    activeTracks.add(track);
                }
            }
        }
    }

    for (const track of tracksToReset) {
        if (!activeTracks.has(track)) {
            if (track._activeSegments) {
                track._activeSegments = [{ start: 0, stop: 0 }];
            }
        }
    }

    let currentBeat = 0;
    const beatsPerBar = Motif.beatsPerBar;

    for (const section of activeSections) {
        const sectionDuration = (section.bars || 0) * beatsPerBar;
        const sectionStart = currentBeat;
        const sectionEnd = sectionStart + sectionDuration;

        if (section.tracks && Array.isArray(section.tracks)) {
            const uniqueTracks = new Set(section.tracks);
            for (const track of uniqueTracks) {
                if (!track) continue;
                if (track._isSolo) continue;
                if (typeof track.start === "function" && typeof track.stop === "function") {
                    track._activeSegments.push({
                        startBeat: sectionStart,
                        stopBeat: sectionEnd,
                        get start() {
                            return track._arrangedTime(sectionStart);
                        },
                        get stop() {
                            return track._arrangedTime(sectionEnd);
                        },
                    });

                    if (track._gainRampsQueue && track._gainRampsQueue.length > 0) {
                        const rampNode = track._gainRampsQueue.shift();
                        track._scheduledRamps = track._scheduledRamps || [];

                        const duration = rampNode.duration;

                        track._scheduledRamps.push({
                            startBeat: sectionStart,
                            durationBeats: duration === undefined ? sectionDuration : musicalDurationBeats(duration, beatsPerBar),
                            durationSeconds: duration === undefined ? null : parseDurationToSeconds(duration, Motif.tempo, beatsPerBar),
                            get start() {
                                return track._arrangedTime(sectionStart);
                            },
                            get duration() {
                                return this.durationBeats === null ? this.durationSeconds : track._arrangedTime(sectionStart + this.durationBeats) - this.start;
                            },
                            from: typeof rampNode.from === "number" ? rampNode.from : 1.0,
                            to: typeof rampNode.to === "number" ? rampNode.to : 0.0,
                            scheduled: false,
                        });
                    }
                }
            }
        }
        currentBeat = sectionEnd;
    }
    Motif._arrangementEndBeat = currentBeat;
}


export const Tie = Symbol("Tie");

function copyRampValue(value) {
    if (value?.isRamp !== true) return value;

    return Object.assign(Object.create(Object.getPrototypeOf(value)), value);
}

export function copyPatternEvent(event) {
    return { ...event, value: copyRampValue(event.value) };
}


export class MotifEventArray extends Array {
    transpose(semitones) {
        this.forEach(e => {
            if (e && e.value !== undefined && e.value !== null) {
                if (e.value.isRamp === true) {
                    e.value = copyRampValue(e.value);
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

    degrade(prob) {
        const kept = this.filter(() => Math.random() >= prob);
        this.length = 0;
        this.push(...kept);
        return this;
    }

    mutate(options) {
        const { chance = 0.5, actions = {} } = options || {};
        if (Math.random() < chance) {
            const actionNames = Object.keys(actions);
            if (actionNames.length > 0) {
                let totalWeight = 0;
                for (const name of actionNames) {
                    totalWeight += typeof actions[name] === "number" ? actions[name] : 1.0;
                }

                let r = Math.random() * totalWeight;
                let chosenAction = actionNames[0];
                for (const name of actionNames) {
                    r -= typeof actions[name] === "number" ? actions[name] : 1.0;
                    if (r <= 0) {
                        chosenAction = name;
                        break;
                    }
                }

                if (chosenAction === "reverse") {
                    this.forEach(e => {
                        e.startTime = 1.0 - (e.startTime + e.duration);
                    });
                    this.sort((a, b) => a.startTime - b.startTime);
                } else if (chosenAction === "ratchet") {
                    const newEvents = [];
                    for (const e of this) {
                        const e1 = copyPatternEvent(e);
                        e1.duration /= 2;
                        const e2 = copyPatternEvent(e1);
                        e2.startTime += e1.duration;
                        newEvents.push(e1, e2);
                    }
                    this.length = 0;
                    this.push(...newEvents);
                } else if (typeof actions[chosenAction] === "function") {
                    const result = actions[chosenAction](this);
                    if (Array.isArray(result)) {
                        this.length = 0;
                        this.push(...result);
                    }
                }
            }
        }
        return this;
    }

    offset(timeShift, modifier) {
        const shift = parseDurationToFraction(timeShift);
        const offsetEvents = this.map(e => {
            const clone = copyPatternEvent(e);
            clone.startTime += shift;
            if (modifier) {
                const res = modifier(clone);
                return res !== undefined ? res : clone;
            }
            return clone;
        }).filter(e => e !== null && e !== undefined);

        this.push(...offsetEvents);
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
    static _parseRecursive(pattern, startTime, duration, tieScope = new Map()) {
        if (pattern && pattern.isParallel) {
            return PatternParser._parseParallel(pattern.items, startTime, duration, tieScope);
        }

        if (!Array.isArray(pattern)) {
            return [{ value: pattern, startTime, duration, tieScope }];
        }

        return PatternParser._parseSequential(pattern, startTime, duration, tieScope);
    }

    /**
     * Parses parallel elements at a shared start time and duration context.
     * @param {Array} items - The parallel items to parse.
     * @param {number} startTime - Start time fraction.
     * @param {number} duration - Duration fraction.
     * @returns {Array<Object>} Flat array of parsed event objects.
     * @private
     */
    static _parseParallel(items, startTime, duration, tieScope) {
        const events = [];
        const group = Symbol("parallel");
        for (const [index, item] of items.entries()) {
            const branchScope = new Map(tieScope);
            branchScope.set(group, index);
            events.push(...PatternParser._parseRecursive(item, startTime, duration, branchScope));
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
    static _parseSequential(pattern, startTime, duration, tieScope) {
        const length = pattern.length;
        if (length === 0) return [];

        const stepDuration = duration / length;
        const events = [];

        for (let i = 0; i < length; i++) {
            const element = pattern[i];
            const elementStartTime = startTime + i * stepDuration;
            events.push(...PatternParser._parseRecursive(element, elementStartTime, stepDuration, tieScope));
        }

        return events;
    }

    /**
     * Post-processes events to flag those that are tied to a subsequent Tie symbol.
     * @param {Array<Object>} events - Flat array of event objects.
     * @private
     */
    static _postProcessTies(events) {
        const tiesAt = new Map();
        for (const event of events) {
            if (event.value !== Tie) continue;
            event.tieId = Symbol("tie");
            const time = Math.round(event.startTime * 1e9);
            if (!tiesAt.has(time)) tiesAt.set(time, []);
            tiesAt.get(time).push(event);
        }

        for (const event of events) {
            const end = Math.round((event.startTime + event.duration) * 1e9);
            const candidates = tiesAt.get(end) || [];

            // A Tie inside a Parallel branch cannot hold a sibling branch's notes.

            event.tieTargets = candidates.filter(tie => {
                for (const [group, branch] of event.tieScope || []) {
                    if (tie.tieScope?.has(group) && tie.tieScope.get(group) !== branch) return false;
                }
                return true;
            }).map(tie => tie.tieId);
            event.tied = event.tieTargets.length > 0;
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
    if (typeof a === "symbol" || typeof b === "symbol") {
        return a === Tie || b === Tie ? Tie : a;
    }

    const valA = typeof a === "string" ? noteToMidi(a) : a;
    const valB = typeof b === "string" ? noteToMidi(b) : b;

    const isANoteString = typeof a === "string" && typeof valA === "number" && !isNaN(valA);
    const isBNoteString = typeof b === "string" && typeof valB === "number" && !isNaN(valB);

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
// Defined via defineProperty (non-enumerable) so `for...in` over any array in a
// host page does not pick up add/sub/mul/div.
function defineArrayOp(name, opFn) {
    if (Array.prototype[name]) return;
    Object.defineProperty(Array.prototype, name, {
        value: function(other) {
            return crossProduct(this, other, (x, y) => evaluateOp(x, y, opFn));
        },
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

defineArrayOp("add", (a, b) => a + b);
defineArrayOp("sub", (a, b) => a - b);
defineArrayOp("mul", (a, b) => a * b);
defineArrayOp("div", (a, b) => a / b);


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

const SCALES_LOWER = Object.fromEntries(Object.entries(SCALES).map(([k, v]) => [k.toLowerCase(), v]));

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

    const intervals = SCALES_LOWER[scaleName.toLowerCase()] || SCALES.major;
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

// Musical durations are beat counts; numbers and explicit seconds stay on the audio clock.
export function musicalDurationBeats(duration, beatsPerBar = 4) {
    if (typeof duration !== "string") return null;
    const value = duration.trim().toLowerCase();
    if (!/^(?:\d+\/\d+\s*(?:b|bar|bars|beat|beats)?|\d+(?:\.\d+)?\s*(?:b|bar|bars|beat|beats))$/.test(value)) return null;
    return parseDurationToSeconds(duration, 60, beatsPerBar);
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
        this.masterLimiter = null;
        this._masterLimiterEnabled = true;
        this._masterCompressorEnabled = false;
        this._masterLimiterSettings = { ceiling: -1, release: 0.1 };
        this._masterLimiterReady = null;
        this._masterLimiterError = null;
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
        this._arrangementSections = null;
        this._arrangementOptions = null;
        this._loopTimeout = null;
        this._debugPlaybackStart = null;
        this._naturalCompletionDrains = new Map();
        this._suspendedByEngine = false;
        this._suspendPromise = null;
        this._startGeneration = 0;
        this._pendingStart = null;
        this._sampleSeed = 0;
    }

    /**
     * Gets/sets the global seed mixed into every procedural sample generator.
     * State 0 (default) yields the canonical, deterministic sound.
     * @param {number} [n] - Seed to set. Omit to pick and set a random seed.
     * @returns {number} The seed now in effect (useful to log/reuse).
     */
    sampleSeed(n) {
        const seed = (n === undefined)
            ? (Math.random() * 0x100000000) >>> 0
            : (n >>> 0);

        const changed = seed !== this._sampleSeed;
        this._sampleSeed = seed;
        if (changed) this._invalidateProceduralSamples();
        return seed;
    }

    /**
     * Restores every procedural generator into the registry, dropping any
     * buffers already rendered from a prior seed so the next play re-renders.
     */
    _invalidateProceduralSamples() {
        if (typeof MotifSamples === "undefined") return;
        for (const [id, generator] of Object.entries(MotifSamples)) {
            this.sampleRegistry.set(id, generator);
        }
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
        p.then(undefined, () => sampleBufferCache.delete(path));
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

        // The final limiter is connected only after its worklet is ready.
        this.masterGain.connect(this.masterLowFilter);
        this.masterLowFilter.connect(this.masterMidFilter);
        this.masterMidFilter.connect(this.masterHighFilter);
        this.masterLimiter = null;
        this._masterLimiterError = null;
        this._prepareMasterLimiter();
        this._updateMasterRouting();

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

        if (this.ctx.audioWorklet) {
            const p1 = ensureGranularStretcher(this.ctx).catch(() => {
            });
            this._loadingSamples.push(p1);
            // Pre-warm the synth voice worklet so it's ready before the first tick fires.
            const p2 = ensureSynthWorklet(this.ctx).catch(() => {
            });
            this._loadingSamples.push(p2);
        }
    }

    /**
     * Starts the transport after a user gesture or an engine-initiated suspend.
     * Resolves on launch, or promptly without launching when cancelled.
     */
    start() {
        this._cancelPendingStart();
        const request = { generation: this._startGeneration };
        request.cancelled = new Promise(resolve => {
            request.cancel = resolve;
        });
        this._pendingStart = request;

        const launch = async () => {
            if (this._suspendedByEngine && typeof this.ctx.resume === "function") {
                await Promise.race([this._suspendPromise, request.cancelled]);
                if (!this._isCurrentStart(request)) return;
                if (this.ctx.state !== "running") {
                    const resumed = Promise.resolve(this.ctx.resume()).catch(error => {
                        if (this._isCurrentStart(request)) throw error;
                        console.warn("Cancelled Motif.start() resume failed:", error);
                    });
                    await Promise.race([resumed, request.cancelled]);
                    if (!this._isCurrentStart(request)) return;
                }
            }
            this._suspendedByEngine = false;
            return this._launchTransport(request);
        };

        if (this.ctx.state !== "running" && !(this._suspendedByEngine && typeof this.ctx.resume === "function")) {
            this._pendingStart = null;
            throw new Error("AudioContext is suspended. Motif.start() must be called after a user gesture has resumed the AudioContext.");
        }

        return launch().finally(() => {
            if (this._pendingStart === request) this._pendingStart = null;
        });
    }

    _cancelPendingStart() {
        this._startGeneration++;
        this._pendingStart?.cancel();
        this._pendingStart = null;
    }

    _isCurrentStart(request) {
        return request.generation === this._startGeneration;
    }

    /**
     * Starts scheduling only while this launch request remains current.
     * @private
     */
    async _launchTransport(request) {
        if (!this._isCurrentStart(request)) return;
        if (this._loadingSamples.length > 0 || this._hasPendingTrackSources()) {
            const resources = Promise.allSettled(this._loadingSamples).then(results => {
                const failed = results.find(result => result.status === "rejected");
                if (failed) {
                    console.error("Failed to load some resources/samples:", failed.reason);
                }
            });
            await Promise.race([resources, request.cancelled]);
            if (!this._isCurrentStart(request)) return;
            this._loadingSamples = [];
            this._assertMasterReady();
            await this._awaitTrackSources(request);
            if (!this._isCurrentStart(request)) return;
        }

        this._assertMasterReady();
        this._loadingSamples = [];
        this._debugPlaybackStart = this._debugPlaybackStart !== null ? this._debugPlaybackStart : this.ctx.currentTime;
        this.isPlaying = true;
        this._startScheduler();
    }

    _hasPendingTrackSources() {
        for (const track of trackRegistry.values()) {
            if (typeof track._schedule !== "function" || !track._sourcePending) continue;
            return true;
        }
        return false;
    }

    async _awaitTrackSources(request) {
        while (this._isCurrentStart(request) && this._hasPendingTrackSources()) {
            let changed;
            const sourceChanged = new Promise(resolve => {
                changed = resolve;
            });
            sourceReadinessListeners.add(changed);
            try {
                // Replacements and removals must wake startup even when an old
                // fetch never settles. Load completion also signals this change.
                await Promise.race([sourceChanged, request.cancelled]);
            } finally {
                sourceReadinessListeners.delete(changed);
            }
        }
    }

    /**
     * Suspends the transport without resetting position.
     */
    pause() {
        this._cancelPendingStart();
        this.isPlaying = false;
        this._stopScheduler();
        if (this._loopTimeout) {
            clearTimeout(this._loopTimeout);
            this._loopTimeout = null;
        }
        this._suspendedByEngine = true;
        if (this.ctx && typeof this.ctx.suspend === "function") {
            this._suspendPromise = Promise.resolve(this.ctx.suspend()).catch(err => {
                console.warn("Failed to suspend AudioContext inside Motif.pause():", err);
            });
        }
    }

    /**
     * Stops the transport and resets playhead/position to zero.
     */
    stop() {
        this._cancelPendingStart();
        this.isPlaying = false;
        this.position = 0;
        this._debugPlaybackStart = null;
        this._naturalCompletionDrains.clear();
        this._stopScheduler();
        this._schedQueue = [];
        this._tempoRamp = null;
        this._tempoMap = null;

        if (this._loopTimeout) {
            clearTimeout(this._loopTimeout);
            this._loopTimeout = null;
        }

        // Reset tracks' scheduling states
        for (const track of trackRegistry.values()) {
            if (typeof track._resetScheduling === "function") {
                track._resetScheduling();
            }
        }

        this._suspendedByEngine = true;
        if (this.ctx && typeof this.ctx.suspend === "function") {
            this._suspendPromise = Promise.resolve(this.ctx.suspend()).catch(err => {
                console.warn("Failed to suspend AudioContext inside Motif.stop():", err);
            });
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
        if (this.ctx.state && this.ctx.state !== "running") return;

        this._tick();
    }

    // Offline renderers advance the same scheduler while the audio clock is suspended.

    _tick() {
        const wasRamping = !!this._tempoRamp;
        if (this._tempoRamp) {
            const now = this.ctx.currentTime;
            const { startBpm, targetBpm, startTime, endTime } = this._tempoRamp;
            if (now >= endTime) {
                this.tempo = targetBpm;
                this._tempoRamp = null;
            } else if (now > startTime) {
                const pct = (now - startTime) / (endTime - startTime);
                this.tempo = startBpm + pct * (targetBpm - startBpm);
            }
        }

        if (wasRamping) this._mappedTempo = this.tempo;
        const horizon = this.ctx.currentTime + this.lookaheadWindowS;
        const shouldLoop = !!this._arrangementOptions?.loop;
        const limiterLatency = this._masterLimiterEnabled && this.masterLimiter && this.ctx.sampleRate > 0
            ? (Math.ceil(this.ctx.sampleRate * 0.005) + 128) / this.ctx.sampleRate
            : 0;
        const tracksWithFiniteVoices = new Set();

        // Capture final audio before scheduling removes ended voices. The limiter
        // still holds its lookahead frames after their source graphs disconnect.

        if (this.isPlaying && !shouldLoop) {
            for (const track of this._naturalCompletionDrains.keys()) {
                if (trackRegistry.get(track.id) !== track) this._naturalCompletionDrains.delete(track);
            }
            for (const track of trackRegistry.values()) {
                if (track.id === "__temp_probe__") continue;
                for (const pool of [track._activeVoices, track._retiredVoices]) {
                    for (const voice of pool?.values() || []) {
                        if (!Number.isFinite(voice.endTime)) continue;
                        tracksWithFiniteVoices.add(track);
                        if (voice.endTime <= this.ctx.currentTime) {
                            const previousDrain = this._naturalCompletionDrains.get(track) ?? 0;
                            this._naturalCompletionDrains.set(track, Math.max(previousDrain, voice.endTime + limiterLatency));
                        }
                    }
                }
            }
        }

        // Schedule track-specific events
        for (const track of trackRegistry.values()) {
            if (typeof track._schedule !== "function") continue;
            try {
                track._schedule(horizon);
            } catch (err) {
                console.error(`[Motif] Error scheduling track "${track.id}":`, err);
            }
        }

        const remaining = [];
        for (const evt of this._schedQueue) {
            if (evt.fired) continue;
            if (evt.time <= horizon) {
                evt.fired = true;
                try {
                    evt.callback(evt.time);
                } catch (err) {
                    console.error("[Motif] Error in scheduled callback:", err);
                }
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
                if (track.id === "__temp_probe__") continue;

                // Live edits can empty a pattern while its submitted notes still sound.

                if (!shouldLoop) {
                    maxStopTime = Math.max(maxStopTime, this._naturalCompletionDrains.get(track) ?? 0);
                    for (const pool of [track._activeVoices, track._retiredVoices]) {
                        for (const voice of pool?.values() || []) {
                            if (!Number.isFinite(voice.endTime)) continue;
                            tracksWithFiniteVoices.add(track);
                            maxStopTime = Math.max(maxStopTime, voice.endTime + limiterLatency);
                        }
                    }
                }

                let boundaryTrack = track;
                while (boundaryTrack._splitParent) boundaryTrack = boundaryTrack._splitParent;

                // Empty patterns participate only while draining submitted audio
                // under finite activity boundaries. Imperative previews stay open.

                if (!track._parsedEvents?.length) {
                    const hasSubmittedAudio = tracksWithFiniteVoices.has(track) || this._naturalCompletionDrains.has(track);
                    if (shouldLoop || !hasSubmittedAudio) continue;
                    const hasFiniteActivity = boundaryTrack._activeSegments.length > 0
                        && boundaryTrack._activeSegments.every(segment => Number.isFinite(segment.stop));
                    if (!hasFiniteActivity) continue;
                }

                hasTracks = true;
                if (boundaryTrack._activeSegments.length === 0) {
                    allFinished = false;
                    break;
                }

                const refTime = boundaryTrack._playbackStartTime !== null && boundaryTrack._playbackStartTime !== undefined ? boundaryTrack._playbackStartTime : this.ctx.currentTime;
                let trackMaxStop = 0;
                for (const seg of boundaryTrack._activeSegments) {
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

            if (allFinished && this._arrangementEndBeat !== undefined) {
                const first = [...trackRegistry.values()].find(track => track._playbackStartTime != null);
                const origin = first?._playbackStartTime ?? this._debugPlaybackStart ?? this.ctx.currentTime;
                maxStopTime = Math.max(maxStopTime, this._timeAtBeat(this._beatAtTime(origin) + this._arrangementEndBeat));
            }

            if (hasTracks && allFinished && this.ctx.currentTime >= maxStopTime) {
                const options = this._arrangementOptions || {};

                // Diagnostic: log if arrangement ends much earlier than expected.
                const elapsed = this.ctx.currentTime - (this._debugPlaybackStart || this.ctx.currentTime);
                if (elapsed < 5 && maxStopTime > 0) {
                    console.warn("[Motif] Arrangement ended after only", elapsed.toFixed(2), "s. maxStopTime:", maxStopTime.toFixed(2), "currentTime:", this.ctx.currentTime.toFixed(2), "- check track patterns and arrangement boundaries.");
                }

                this.stop();

                if (typeof this.onPlaybackFinished === "function") {
                    this.onPlaybackFinished({ looped: shouldLoop });
                }

                if (shouldLoop) {
                    let delayMs = 0;
                    if (options.loopDelay !== undefined) {
                        const delaySeconds = parseDurationToSeconds(options.loopDelay, this.tempo, this.beatsPerBar);
                        delayMs = Math.max(0, delaySeconds * 1000);
                    }

                    this._loopTimeout = setTimeout(() => {
                        if (!this._loopTimeout) return;

                        // Wait for the suspend started by stop() to actually land before
                        // resuming. Checking ctx.state here would race: it can still read
                        // "running" while the suspend is pending, so a resume would be
                        // skipped and the late suspend would silence playback forever.
                        Promise.resolve(this._suspendPromise)
                            .catch(() => {
                            })
                            .then(() => {
                                if (this._loopTimeout) return this.start();
                            })
                            .catch(err => {
                                console.error("Motif auto-loop restart failed:", err);
                            });
                    }, delayMs);
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

    _ensureTempoMap() {
        if (this._tempoMapContext === this.ctx && this._tempoMap) {
            if (this._mappedTempo === this.tempo) return;
            // Public tempo assignments before playback also configure the transport.
            this._tempoMap = null;
        }
        this._mappedTempo = this.tempo;
        this._tempoMapContext = this.ctx;
        this._tempoMap = [{ time: 0, beat: 0, bpm: this.tempo, slope: 0 }];
    }

    _beatAtTime(time) {
        this._ensureTempoMap();
        let segment = this._tempoMap[0];
        for (const entry of this._tempoMap) {
            if (entry.time > time) break;
            segment = entry;
        }
        const elapsed = time - segment.time;
        return segment.beat + (segment.bpm * elapsed + segment.slope * elapsed * elapsed / 2) / 60;
    }

    _timeAtBeat(beat) {
        this._ensureTempoMap();
        if (!Number.isFinite(beat)) return beat;
        let segment = this._tempoMap[0];
        for (const entry of this._tempoMap) {
            if (entry.beat > beat) break;
            segment = entry;
        }
        const area = (beat - segment.beat) * 60;
        const elapsed = segment.slope === 0 ? area / segment.bpm
            : 2 * area / (segment.bpm + Math.sqrt(segment.bpm ** 2 + 2 * segment.slope * area));
        return segment.time + elapsed;
    }

    _tempoChangeTime() {
        // Already submitted audio cannot be recalled. Change at the committed lookahead edge.
        let time = this.ctx.currentTime;
        for (const track of trackRegistry.values()) {
            if (track._playbackStartTime !== null) time = Math.max(time, track._scheduledUntil || 0);
        }
        return time;
    }

    _mapTempoChange(bpm, time, seconds = 0) {
        this._ensureTempoMap();
        const beat = this._beatAtTime(time);
        let previous = this._tempoMap[0];
        for (const entry of this._tempoMap) {
            if (entry.time > time) break;
            previous = entry;
        }
        const startBpm = previous.bpm + previous.slope * (time - previous.time);
        this._tempoMap = this._tempoMap.filter(entry => entry.time < time);
        this._tempoMap.push({
            time,
            beat,
            bpm: seconds > 0 ? startBpm : bpm,
            slope: seconds > 0 ? (bpm - startBpm) / seconds : 0,
        });
        if (seconds > 0) this._tempoMap.push({
            time: time + seconds,
            beat: beat + (startBpm + bpm) * seconds / 120,
            bpm,
            slope: 0,
        });
        for (const track of trackRegistry.values()) {
            for (const ramp of track._scheduledRamps || []) {
                if (ramp.startBeat !== undefined) ramp.scheduled = false;
            }
        }
        return startBpm;
    }

    _arrangementDuration() {
        return this._arrangementEndBeat === undefined ? null : this._timeAtBeat(this._beatAtTime(0) + this._arrangementEndBeat);
    }

    /**
     * Sets the global tempo (BPM).
     * @param {number} bpm - The target tempo.
     */
    setTempo(bpm) {
        if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm <= 0) {
            throw new Error("Tempo must be a positive number.");
        }
        const time = this._tempoChangeTime();
        this._mapTempoChange(bpm, time);
        this._tempoRamp = null;
        this.tempo = bpm;
        this._mappedTempo = bpm;
        if (this.bpmParam) {
            this.bpmParam.cancelScheduledValues?.(time);
            this.bpmParam.setValueAtTime(bpm, time);
        }
    }

    /**
     * Smoothly interpolates the global tempo to bpm over duration.
     * @param {number} bpm - The target tempo.
     * @param {string|number} duration - The duration over which to ramp.
     * @param {Object} [options] - Additional options. Pass { smooth: true } to interpolate scheduler tempo.
     */
    rampTempo(bpm, duration, options = {}) {
        if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm <= 0) {
            throw new Error("Target tempo must be a positive number.");
        }

        // Use average tempo for duration parsing to ensure ramp ends exactly at target beat
        const avgBpm = (this.tempo + bpm) / 2;
        const seconds = parseDurationToSeconds(duration, avgBpm, this.beatsPerBar);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Tempo ramp duration must be finite and non-negative.");
        const startTime = this._tempoChangeTime();
        const endTime = startTime + seconds;
        const startBpm = this._mapTempoChange(bpm, startTime, options.smooth === true ? seconds : 0);
        this._tempoRamp = options.smooth === true && seconds > 0 ? {
            startBpm,
            targetBpm: bpm,
            startTime,
            endTime,
        } : null;

        if (this.bpmParam) {
            // Anchor the ramp at the current value and current time
            this.bpmParam.cancelScheduledValues?.(startTime);
            this.bpmParam.setValueAtTime(startBpm, startTime);
            this.bpmParam.linearRampToValueAtTime(bpm, endTime);

        }
        if (!this._tempoRamp) this.tempo = bpm;
        this._mappedTempo = this.tempo;
    }

    _prepareMasterLimiter() {
        const ctx = this.ctx;
        this._masterLimiterReady = Promise.resolve().then(async () => {
            if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
                throw new Error("The master limiter requires AudioWorklet support.");
            }
            await ctx.audioWorklet.addModule(new URL("./src/worklets/MasterLimiterProcessor.js", import.meta.url).href);
            if (this.ctx !== ctx) return;
            this.masterLimiter = new AudioWorkletNode(ctx, "master-limiter", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                channelCount: 2,
                channelCountMode: "explicit",
                parameterData: this._masterLimiterSettings,
            });
            this.masterLimiter.onprocessorerror = () => {
                if (this.ctx !== ctx) return;
                this._masterLimiterError = new Error("The master limiter processor failed.");
                this._updateMasterRouting();
                if (this._masterLimiterEnabled) {
                    this.isPlaying = false;
                    this._stopScheduler();
                }
                console.error(this._masterLimiterError);
            };
            this._updateMasterRouting();
        }).catch(error => {
            if (this.ctx === ctx) this._masterLimiterError = error;
        });
        this._loadingSamples.push(this._masterLimiterReady);
    }

    _assertMasterReady() {
        if (!this._masterLimiterEnabled) return;
        if (this._masterLimiterError) throw this._masterLimiterError;
        if (!this.masterLimiter) throw new Error("The master limiter is not ready.");
    }

    _updateMasterRouting() {
        if (!this.ctx) return;

        this.masterHighFilter.disconnect();
        this.masterCompressor.disconnect();
        if (this.masterLimiter) this.masterLimiter.disconnect();

        let output = this.masterHighFilter;
        if (this._masterCompressorEnabled) {
            this.masterHighFilter.connect(this.masterCompressor);
            output = this.masterCompressor;
        }
        if (this._masterLimiterEnabled) {
            if (!this.masterLimiter || this._masterLimiterError) return;
            output.connect(this.masterLimiter);
            output = this.masterLimiter;
        }
        output.connect(this.ctx.destination);
    }

    /**
     * Configures gain, EQ, optional compression, and final true-peak limiting.
     * @param {Object} options - Master configuration options.
     * @param {number} [options.gain] - Master gain level.
     * @param {boolean|Object} [options.limiter] - Limiter enable state or configuration object.
     * @param {boolean|Object} [options.compressor] - Optional DynamicsCompressor configuration.
     * @param {Object} [options.eq] - Three-band EQ configuration.
     * @param {number} [options.eq.low] - Low band gain in dB.
     * @param {number} [options.eq.mid] - Mid band gain in dB.
     * @param {number} [options.eq.high] - High band gain in dB.
     */
    master({ gain, limiter, compressor, eq } = {}) {
        if (limiter !== undefined && typeof limiter !== "boolean" && (!limiter || typeof limiter !== "object" || Array.isArray(limiter))) {
            throw new TypeError("limiter must be a boolean or { ceiling, release }.");
        }
        if (limiter && typeof limiter === "object") {
            for (const [key, value] of Object.entries(limiter)) {
                if (key !== "ceiling" && key !== "release") throw new TypeError(`Unknown limiter option '${key}'; compression options belong in compressor.`);
                const [min, max] = key === "ceiling" ? [-24, -1] : [0.01, 2];
                if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`limiter.${key} must be between ${min} and ${max}.`);
            }
        }
        if (compressor !== undefined && typeof compressor !== "boolean" && (!compressor || typeof compressor !== "object" || Array.isArray(compressor))) {
            throw new TypeError("compressor must be a boolean or a compression settings object.");
        }
        if (compressor && typeof compressor === "object") {
            const ranges = {
                threshold: [-100, 0],
                knee: [0, 40],
                ratio: [1, 20],
                attack: [0, 1],
                release: [0, 1],
            };
            for (const [key, value] of Object.entries(compressor)) {
                if (!Object.hasOwn(ranges, key)) throw new TypeError(`Unknown compressor option '${key}'.`);
                const [min, max] = ranges[key];
                if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`compressor.${key} must be between ${min} and ${max}.`);
            }
        }
        const time = this.ctx.currentTime;

        if (typeof gain === "number") {
            this.masterGain.gain.setValueAtTime(gain, time);
        }

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

        if (compressor !== undefined) {
            this._masterCompressorEnabled = compressor !== false;
            if (compressor && typeof compressor === "object") {
                for (const key of ["threshold", "knee", "ratio", "attack", "release"]) {
                    if (typeof compressor[key] === "number") this.masterCompressor[key].setValueAtTime(compressor[key], time);
                }
            }
        }
        if (limiter !== undefined) {
            this._masterLimiterEnabled = limiter !== false;
            if (typeof limiter === "object") Object.assign(this._masterLimiterSettings, limiter);
            if (this.masterLimiter) {
                for (const [key, value] of Object.entries(this._masterLimiterSettings)) {
                    this.masterLimiter.parameters.get(key).setValueAtTime(value, time);
                }
            }
        }
        if (limiter !== undefined || compressor !== undefined) this._updateMasterRouting();
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
                    freqVal = bandData.frequency !== undefined ? bandData.frequency : bandData.freq;
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
const MAX_FEEDBACK_DELAY_SECONDS = 60;

class BusClass extends EffectChain {
    constructor(id) {
        super();
        this.id = id || `bus_${Math.random().toString(36).substr(2, 9)}`;
        this.input = null;
        this.output = null;
        this.feedbackGainNode = null;
        this.feedbackDelayNode = null;
        this._isInternalDelayBus = false;
        this._ownerTrackId = null;

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

    feedback({ amount = 0.5, time } = {}) {
        const ctx = Motif.ctx;
        const sampleRate = ctx.sampleRate || 44100;
        const minDelay = 128 / sampleRate;
        const hasTime = time !== undefined;
        const seconds = hasTime
            ? parseDurationToSeconds(time, Motif.tempo, Motif.beatsPerBar)
            : minDelay;

        if (hasTime && (!Number.isFinite(seconds) || seconds < minDelay || seconds > MAX_FEEDBACK_DELAY_SECONDS)) {
            throw new RangeError(`delay time must be between ${minDelay} and ${MAX_FEEDBACK_DELAY_SECONDS} seconds.`);
        }

        if (!this.feedbackDelayNode) {
            this.feedbackDelayNode = ctx.createDelay(MAX_FEEDBACK_DELAY_SECONDS);
            this.feedbackDelayNode.delayTime.setValueAtTime(seconds, ctx.currentTime);
            this.feedbackGainNode = ctx.createGain();
            this.feedbackGainNode.gain.setValueAtTime(amount, ctx.currentTime);

            this.output.connect(this.feedbackGainNode);
            this.feedbackGainNode.connect(this.feedbackDelayNode);
            this.feedbackDelayNode.connect(this.input);
        } else {
            this.feedbackGainNode.gain.setValueAtTime(amount, ctx.currentTime);
            if (hasTime) {
                this.feedbackDelayNode.delayTime.setValueAtTime(seconds, ctx.currentTime);
            }
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

function disposeBus(bus) {
    safeDisconnect(bus.input);
    safeDisconnect(bus.output);
    safeDisconnect(bus.feedbackDelayNode);
    safeDisconnect(bus.feedbackGainNode);
    disposeModulationBindings(bus);
}

function disposeTrack(track) {
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
    track._clearGainSignal();
    disposeModulationBindings(track);
    const internalNodes = [
        "filterNode", "pannerNode", "volumeNode",
        "eqLowNode", "eqMidNode", "eqHighNode",
        "compressorNode", "distortionNode",
        "duckGainNode", "_mergerNode",
    ];
    for (const prop of internalNodes) {
        safeDisconnect(track[prop]);
    }

    // Tear down the track's internal delay bus (Track.delay) so a pruned track
    // never leaks its feedback loop. Safe because disposeTrack runs only on
    // registry-present tracks, i.e. the current owner of this bus.
    if (track._delayBus) {
        disposeBus(track._delayBus);
        if (track._delayBus.id) busRegistry.delete(track._delayBus.id);
        track._delayBus = null;
    }
}

Bus.clearRegistry = function() {
    for (const bus of busRegistry.values()) {
        disposeBus(bus);
    }
    busRegistry.clear();
};

Bus.pruneExcept = function(activeIds) {
    const ids = new Set(activeIds || []);
    for (const [id, bus] of busRegistry.entries()) {
        if (ids.has(id)) continue;

        // Internal per-track delay buses (created by Track.delay, not by user
        // code) never appear in the declared set. Keep them while their owner
        // track survives so hot-reload echo isn't silenced.
        if (bus._isInternalDelayBus && trackRegistry.has(bus._ownerTrackId)) continue;

        disposeBus(bus);
        busRegistry.delete(id);
    }
};

export function Track(id) {
    let newTrack;
    if (id && trackRegistry.has(id)) {
        const oldTrack = trackRegistry.get(id);
        newTrack = new TrackClass(id);
        if (oldTrack && Array.isArray(oldTrack._sidechainListeners)) {
            newTrack._sidechainListeners = [...oldTrack._sidechainListeners];
        }
        trackRegistry.set(id, newTrack);
        oldTrack._crossfadeOut(newTrack);
    } else {
        newTrack = new TrackClass(id);
        if (id) {
            trackRegistry.set(id, newTrack);
        }
    }
    if (id && globalThis._pendingSidechains && globalThis._pendingSidechains.has(id)) {
        if (!Array.isArray(newTrack._sidechainListeners)) {
            newTrack._sidechainListeners = [];
        }
        newTrack._sidechainListeners.push(...globalThis._pendingSidechains.get(id));
        globalThis._pendingSidechains.delete(id);
    }
    notifySourceReadinessChange();
    return newTrack;
}

Track.clearRegistry = function() {
    for (const track of trackRegistry.values()) {
        disposeTrack(track);
    }
    trackRegistry.clear();
    notifySourceReadinessChange();
};

Track.pruneExcept = function(activeIds) {
    const ids = new Set(activeIds || []);
    const retainedParents = new Set();
    for (const [id, track] of trackRegistry.entries()) {
        if (id === "__temp_probe__" || ids.has(id)) retainedParents.add(track);
    }
    for (const [id, track] of trackRegistry.entries()) {
        const parent = track._splitParent;

        // Compiler declarations contain the parent ID, not its internal shadow.
        const retained = parent
            ? retainedParents.has(parent) && parent._rightTrack === track
            : retainedParents.has(track);
        if (retained) continue;

        disposeTrack(track);
        trackRegistry.delete(id);
    }
    notifySourceReadinessChange();
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
                frequency = options.speed > 0 ? 1 / options.speed : 1.0;
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

    if (!Number.isFinite(frequency)) frequency = 1.0;
    if (!Number.isFinite(depth)) depth = 1.0;
    if (!Number.isFinite(offset)) offset = 0.0;

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

export function LFO(frequencyOrOptions, min, max) {
    let options = frequencyOrOptions;
    if (typeof frequencyOrOptions === "number") {
        options = { frequency: frequencyOrOptions };
        if (typeof min === "number" && typeof max === "number") {
            options.min = min;
            options.max = max;
        }
    }
    return createLFO("sine", options);
}

LFO.sine = function(options) {
    return createLFO("sine", options);
};
LFO.triangle = function(options) {
    return createLFO("triangle", options);
};
LFO.square = function(options) {
    return createLFO("square", options);
};
LFO.saw = function(options) {
    return createLFO("saw", options);
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

// Seeded PRNG factory for offline sample generation. Pure int32 ops (Math.imul,
// >>> 0) keep the whole state under 2^32, avoiding the >2^53 float-precision
// loss of hand-rolled LCGs. Returns a function yielding floats in [0, 1).
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

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
    // Self-contained PolyBLEP oscillators survive worklet callback serialization.


    // Narrow, DC-compensated PolyBLEP pulse: tiny pitch drift, restrained PWM and a decaying TPT low-pass filter.
    "arp-narrow-drift": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        if (!(sr > 0.0) || !Number.isFinite(sr)
            || !(ctx.freq > 0.0) || !Number.isFinite(ctx.freq)) return 0.0;
        const invSr = 1.0 / sr;
        const f0 = Math.min(ctx.freq, sr * 0.49);
        const topGain = Math.max(0.0, Math.min(1.0, (0.49 - ctx.freq * invSr) / 0.09));

        if (s._darkVoice !== 1 || s._darkRate !== sr) {
            s._darkVoice = 1;
            s._darkRate = sr;

            // Randomize only at note initialization; set driftPhase for reproducible notes.
            const driftPhase = Number.isFinite(s.driftPhase)
                ? ((s.driftPhase % 1.0) + 1.0) % 1.0 : Math.random();
            s.mdPhaseA = Number.isFinite(ctx.p) ? ((ctx.p % 1.0) + 1.0) % 1.0 : 0.0;
            s.mdLfoA = (0.13 + driftPhase) % 1.0;
            s.mdLfoB = (0.61 + driftPhase) % 1.0;
            s.mdLfoC = (0.17 + driftPhase) % 1.0;
            s.mdRatioA = 1.0;
            s.mdWidth = 0.14;
            s.mdG = -1.0;
            s.mdIc1 = 0.0;
            s.mdIc2 = 0.0;
            s.mdDcInput = 0.0;
            s.mdDcOutput = 0.0;
            s.mdDcPole = Math.exp(-TWO_PI * Math.min(12.0, sr / 6.0) * invSr);
            s.mdSmooth = 1.0 - Math.exp(-invSr / 0.003);
            s.mdControl = 0;
        }


        // Expensive modulation and tangent calculations run once per 32 samples.
        if (s.mdControl <= 0) {
            const age = Number.isFinite(ctx.t) ? Math.max(0.0, ctx.t) : 0.0;
            const brightness = Number.isFinite(s.brightness)
                ? Math.max(0.0, Math.min(1.0, s.brightness)) : 0.5;
            const driftCents = 2.2 * Math.sin(TWO_PI * s.mdLfoA)
                + 0.7 * Math.sin(TWO_PI * s.mdLfoB);
            s.mdRatioTargetA = Math.exp(driftCents * 0.0005776226504666211);
            s.mdWidthTarget = 0.14 + 0.011 * Math.sin(TWO_PI * s.mdLfoC);
            const filterEnv = Math.exp(-age / 0.135);
            const cutoff = Math.min(sr / 6.0, Math.max(25.0,
                180.0 + f0 * (0.8 + 1.4 * brightness)
                + (500.0 + 1800.0 * brightness) * filterEnv));
            s.mdGTarget = Math.tan(Math.PI * cutoff * invSr);
            if (s.mdG < 0.0) {
                s.mdG = s.mdGTarget;
                s.mdRatioA = s.mdRatioTargetA;
                s.mdWidth = s.mdWidthTarget;
            }
            s.mdLfoA = (s.mdLfoA + 32.0 * 0.19 * invSr) % 1.0;
            s.mdLfoB = (s.mdLfoB + 32.0 * 0.71 * invSr) % 1.0;
            s.mdLfoC = (s.mdLfoC + 32.0 * 0.11 * invSr) % 1.0;
            s.mdControl = 32;
        }
        s.mdControl -= 1;
        s.mdRatioA += s.mdSmooth * (s.mdRatioTargetA - s.mdRatioA);
        s.mdWidth += s.mdSmooth * (s.mdWidthTarget - s.mdWidth);
        s.mdG += s.mdSmooth * (s.mdGTarget - s.mdG);

        const step = Math.min(0.49, f0 * invSr * s.mdRatioA);
        s.mdPhaseA = (s.mdPhaseA + step) % 1.0;
        const fallingPhase = (s.mdPhaseA + 1.0 - s.mdWidth) % 1.0;
        let risingBlep = 0.0;
        let fallingBlep = 0.0;
        if (s.mdPhaseA < step) {
            const x = s.mdPhaseA / step;
            risingBlep = x + x - x * x - 1.0;
        } else if (s.mdPhaseA > 1.0 - step) {
            const x = (s.mdPhaseA - 1.0) / step;
            risingBlep = x * x + x + x + 1.0;
        }
        if (fallingPhase < step) {
            const x = fallingPhase / step;
            fallingBlep = x + x - x * x - 1.0;
        } else if (fallingPhase > 1.0 - step) {
            const x = (fallingPhase - 1.0) / step;
            fallingBlep = x * x + x + x + 1.0;
        }
        let pulse = (s.mdPhaseA < s.mdWidth ? 1.0 : -1.0)
            + risingBlep - fallingBlep - (2.0 * s.mdWidth - 1.0);
        if (step > 0.10) {
            const fundamental = 1.2732395447351628 * Math.sin(Math.PI * s.mdWidth)
                * Math.cos(TWO_PI * (s.mdPhaseA - s.mdWidth * 0.5));
            const blend = Math.min(1.0, (step - 0.10) * 10.0);
            pulse += blend * (fundamental - pulse);
        }
        const input = pulse * topGain;


        // Complete topology-preserving SVF; damping k = 1/Q. Interpolate g, then

        // derive the denominator each sample so all filter coefficients agree.
        const g = s.mdG;
        const a1 = 1.0 / (1.0 + g * (g + 1.05));
        const band = a1 * (s.mdIc1 + g * (input - s.mdIc2));
        const low = s.mdIc2 + g * band;
        s.mdIc1 = 2.0 * band - s.mdIc1;
        s.mdIc2 = 2.0 * low - s.mdIc2;


        // Saturating an asymmetric pulse can reintroduce DC; block it afterward.
        const driven = Math.tanh(low * 1.55);
        s.mdDcOutput = driven - s.mdDcInput + s.mdDcPole * s.mdDcOutput;
        s.mdDcInput = driven;

        // |DC output| <= 2 for an input bounded by 1; leave headroom without clipping.
        return s.mdDcOutput * 0.48;
    },


    // Compact two-saw bass: +/-3-cent PolyBLEP unison, a short filter contour and a separately accumulated clean octave sub.
    "bass-compact-saw": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        if (!(sr > 0.0) || !Number.isFinite(sr)
            || !(ctx.freq > 0.0) || !Number.isFinite(ctx.freq)) return 0.0;
        const invSr = 1.0 / sr;
        const f0 = Math.min(ctx.freq, sr * 0.49);
        const topGain = Math.max(0.0, Math.min(1.0, (0.49 - ctx.freq * invSr) / 0.09));

        if (s._darkVoice !== 2 || s._darkRate !== sr) {
            s._darkVoice = 2;
            s._darkRate = sr;
            const driftPhase = Number.isFinite(s.driftPhase)
                ? ((s.driftPhase % 1.0) + 1.0) % 1.0 : Math.random();
            s.mdPhaseA = Number.isFinite(ctx.p) ? ((ctx.p % 1.0) + 1.0) % 1.0 : 0.0;
            s.mdPhaseB = (s.mdPhaseA + 0.19) % 1.0;
            s.mdPhaseSub = 0.0;
            s.mdLfoA = (0.23 + driftPhase) % 1.0;
            s.mdRatioA = 1.0;
            s.mdG = -1.0;
            s.mdIc1 = 0.0;
            s.mdIc2 = 0.0;
            s.mdSmooth = 1.0 - Math.exp(-invSr / 0.003);
            s.mdControl = 0;
        }

        if (s.mdControl <= 0) {
            const age = Number.isFinite(ctx.t) ? Math.max(0.0, ctx.t) : 0.0;
            const brightness = Number.isFinite(s.brightness)
                ? Math.max(0.0, Math.min(1.0, s.brightness)) : 0.5;
            s.mdRatioTargetA = Math.exp(0.65 * Math.sin(TWO_PI * s.mdLfoA)
                * 0.0005776226504666211);
            const filterEnv = Math.exp(-age / 0.13);
            const cutoff = Math.min(sr / 6.0, Math.max(25.0,
                110.0 + f0 * (1.6 + 2.4 * brightness)
                + (100.0 + 600.0 * brightness) * filterEnv));
            s.mdGTarget = Math.tan(Math.PI * cutoff * invSr);
            if (s.mdG < 0.0) {
                s.mdG = s.mdGTarget;
                s.mdRatioA = s.mdRatioTargetA;
            }
            s.mdLfoA = (s.mdLfoA + 32.0 * 0.17 * invSr) % 1.0;
            s.mdControl = 32;
        }
        s.mdControl -= 1;
        s.mdRatioA += s.mdSmooth * (s.mdRatioTargetA - s.mdRatioA);
        s.mdG += s.mdSmooth * (s.mdGTarget - s.mdG);

        const baseStep = f0 * invSr;
        const stepA = Math.min(0.49, baseStep * s.mdRatioA * 0.9982686325973925);
        const stepB = Math.min(0.49, baseStep * s.mdRatioA * 1.001734370234696);
        s.mdPhaseA = (s.mdPhaseA + stepA) % 1.0;
        s.mdPhaseB = (s.mdPhaseB + stepB) % 1.0;
        s.mdPhaseSub = (s.mdPhaseSub + baseStep * 0.5) % 1.0;
        let saws = 0.0;
        for (let oscillator = 0; oscillator < 2; oscillator++) {
            const phase = oscillator === 0 ? s.mdPhaseA : s.mdPhaseB;
            const step = oscillator === 0 ? stepA : stepB;
            let blep = 0.0;
            if (phase < step) {
                const x = phase / step;
                blep = x + x - x * x - 1.0;
            } else if (phase > 1.0 - step) {
                const x = (phase - 1.0) / step;
                blep = x * x + x + x + 1.0;
            }
            let saw = phase * 2.0 - 1.0 - blep;
            if (step > 0.10) {
                const fundamental = -0.6366197723675814 * Math.sin(TWO_PI * phase);
                const blend = Math.min(1.0, (step - 0.10) * 10.0);
                saw += blend * (fundamental - saw);
            }
            saws += saw * 0.5;
        }
        const input = saws * topGain;

        const g = s.mdG;
        const a1 = 1.0 / (1.0 + g * (g + 1.25));
        const band = a1 * (s.mdIc1 + g * (input - s.mdIc2));
        const low = s.mdIc2 + g * band;
        s.mdIc1 = 2.0 * band - s.mdIc1;
        s.mdIc2 = 2.0 * low - s.mdIc2;


        // The sub bypasses the saw drive and low-pass, preserving a steady low end.
        const sub = Math.sin(TWO_PI * s.mdPhaseSub) * topGain;
        return Math.tanh(low * 1.65) * 0.62 + sub * 0.28;
    },


    // Warm three-saw pad: restrained detune and slow drift into a gently breathing TPT low-pass; the host supplies attack and release.
    "pad-dusk-saws": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        if (!(sr > 0.0) || !Number.isFinite(sr)
            || !(ctx.freq > 0.0) || !Number.isFinite(ctx.freq)) return 0.0;
        const invSr = 1.0 / sr;
        const f0 = Math.min(ctx.freq, sr * 0.49);
        const topGain = Math.max(0.0, Math.min(1.0, (0.49 - ctx.freq * invSr) / 0.09));

        if (s._darkVoice !== 3 || s._darkRate !== sr) {
            s._darkVoice = 3;
            s._darkRate = sr;
            const driftPhase = Number.isFinite(s.driftPhase)
                ? ((s.driftPhase % 1.0) + 1.0) % 1.0 : Math.random();
            s.mdPhaseA = Number.isFinite(ctx.p) ? ((ctx.p % 1.0) + 1.0) % 1.0 : 0.0;
            s.mdPhaseB = (s.mdPhaseA + 0.19) % 1.0;
            s.mdPhaseC = (s.mdPhaseA + 0.43) % 1.0;
            s.mdLfoA = (0.17 + driftPhase) % 1.0;
            s.mdLfoB = (0.63 + driftPhase) % 1.0;
            s.mdRatioA = 1.0;
            s.mdRatioB = 0.9971160533345892;
            s.mdRatioC = 1.0028922878693671;
            s.mdG = -1.0;
            s.mdIc1 = 0.0;
            s.mdIc2 = 0.0;
            s.mdSmooth = 1.0 - Math.exp(-invSr / 0.005);
            s.mdControl = 0;
        }

        if (s.mdControl <= 0) {
            const age = Number.isFinite(ctx.t) ? Math.max(0.0, ctx.t) : 0.0;
            const brightness = Number.isFinite(s.brightness)
                ? Math.max(0.0, Math.min(1.0, s.brightness)) : 0.5;
            const drift = 0.7 * Math.sin(TWO_PI * s.mdLfoA);
            const spread = 5.0 + 0.8 * Math.sin(TWO_PI * s.mdLfoB);
            s.mdRatioTargetA = Math.exp(drift * 0.0005776226504666211);
            s.mdRatioTargetB = Math.exp((drift - spread) * 0.0005776226504666211);
            s.mdRatioTargetC = Math.exp((drift + spread) * 0.0005776226504666211);
            const breath = 1.0 + 0.12 * Math.sin(TWO_PI * s.mdLfoB);
            const opening = 0.72 + 0.28 * (1.0 - Math.exp(-age / 1.1));
            const cutoff = Math.min(sr / 6.0, Math.max(25.0,
                (220.0 + f0 * (2.8 + 5.0 * brightness)) * breath * opening));
            s.mdGTarget = Math.tan(Math.PI * cutoff * invSr);
            if (s.mdG < 0.0) {
                s.mdG = s.mdGTarget;
                s.mdRatioA = s.mdRatioTargetA;
                s.mdRatioB = s.mdRatioTargetB;
                s.mdRatioC = s.mdRatioTargetC;
            }
            s.mdLfoA = (s.mdLfoA + 32.0 * 0.083 * invSr) % 1.0;
            s.mdLfoB = (s.mdLfoB + 32.0 * 0.117 * invSr) % 1.0;
            s.mdControl = 32;
        }
        s.mdControl -= 1;
        s.mdRatioA += s.mdSmooth * (s.mdRatioTargetA - s.mdRatioA);
        s.mdRatioB += s.mdSmooth * (s.mdRatioTargetB - s.mdRatioB);
        s.mdRatioC += s.mdSmooth * (s.mdRatioTargetC - s.mdRatioC);
        s.mdG += s.mdSmooth * (s.mdGTarget - s.mdG);

        const baseStep = f0 * invSr;
        const stepA = Math.min(0.49, baseStep * s.mdRatioA);
        const stepB = Math.min(0.49, baseStep * s.mdRatioB);
        const stepC = Math.min(0.49, baseStep * s.mdRatioC);
        s.mdPhaseA = (s.mdPhaseA + stepA) % 1.0;
        s.mdPhaseB = (s.mdPhaseB + stepB) % 1.0;
        s.mdPhaseC = (s.mdPhaseC + stepC) % 1.0;
        let saws = 0.0;
        for (let oscillator = 0; oscillator < 3; oscillator++) {
            const phase = oscillator === 0 ? s.mdPhaseA : oscillator === 1 ? s.mdPhaseB : s.mdPhaseC;
            const step = oscillator === 0 ? stepA : oscillator === 1 ? stepB : stepC;
            let blep = 0.0;
            if (phase < step) {
                const x = phase / step;
                blep = x + x - x * x - 1.0;
            } else if (phase > 1.0 - step) {
                const x = (phase - 1.0) / step;
                blep = x * x + x + x + 1.0;
            }
            let saw = phase * 2.0 - 1.0 - blep;
            if (step > 0.10) {
                const fundamental = -0.6366197723675814 * Math.sin(TWO_PI * phase);
                const blend = Math.min(1.0, (step - 0.10) * 10.0);
                saw += blend * (fundamental - saw);
            }
            saws += saw * (oscillator === 0 ? 0.46 : 0.27);
        }
        const input = saws * topGain;

        const g = s.mdG;
        const a1 = 1.0 / (1.0 + g * (g + 1.4142135623730951));
        const band = a1 * (s.mdIc1 + g * (input - s.mdIc2));
        const low = s.mdIc2 + g * band;
        s.mdIc1 = 2.0 * band - s.mdIc1;
        s.mdIc2 = 2.0 * low - s.mdIc2;
        return Math.tanh(low * 1.35) * 0.70;
    },

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

    // Sustained sub sine with a pitch-sweep transient: frequency starts at 2× ctx.freq and falls to ctx.freq, then holds at full level — caller shapes amplitude via envelope
    "sub-sweep": (ctx) => {
        const sweepFreq = ctx.freq + ctx.freq * Math.exp(-ctx.t * 4.0);
        ctx.state.phase = ((ctx.state.phase || 0) + sweepFreq / ctx.sampleRate) % 1.0;
        const sub = Math.sin(ctx.state.phase * TWO_PI);
        return Math.tanh(sub * 1.5);
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

    // 'Acid Bass HQ': Modern, high-fidelity recreation of the classic silver bass box.
    // Features a cascaded 4-pole (24dB/oct) resonant lowpass filter for a squelch effect.
    "bass-acid-hq": (ctx) => {
        ctx.state.phase = ((ctx.state.phase || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        const saw = (ctx.state.phase * 2.0) - 1.0;

        // Snappy internal envelope for the filter sweep
        const env = Math.exp(-ctx.t * 4.0);
        const cutoff = Math.min(200 + (ctx.freq * 4.0 * env), ctx.sampleRate / 6.0);

        // Initialize two-stage SVF states to create a 24dB slope
        ctx.state.lp1 = ctx.state.lp1 || 0;
        ctx.state.bp1 = ctx.state.bp1 || 0;
        ctx.state.lp2 = ctx.state.lp2 || 0;
        ctx.state.bp2 = ctx.state.bp2 || 0;
        const f = 2.0 * Math.sin(Math.PI * cutoff / ctx.sampleRate);

        // High resonance for the acid sound
        const q = 0.4;

        // First filter stage (12dB)
        const hp1 = saw - ctx.state.lp1 - (q * ctx.state.bp1);
        ctx.state.bp1 += f * hp1;
        ctx.state.lp1 += f * ctx.state.bp1;

        // Second filter stage (24dB) cascading from the first stage
        const hp2 = ctx.state.lp1 - ctx.state.lp2 - (q * ctx.state.bp2);
        ctx.state.bp2 += f * hp2;
        ctx.state.lp2 += f * ctx.state.bp2;

        // Drive and saturate the output
        return Math.tanh(ctx.state.lp2 * 3.0);
    },

    // 'Rubber Bass': An aggressive, squelchy FM bass favored in complex breakbeat music.
    // Bounces rapidly with a highly exponential envelope.
    "bass-rubber-idm": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Sub modulator
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 0.5) / ctx.sampleRate) % 1.0;

        // Extremely tight, punchy envelope
        const punch = Math.exp(-ctx.t * 25.0);
        const sustain = Math.exp(-ctx.t * 3.0);

        // Modulator index peaks at the transient
        const modIndex = 1.0 + (punch * 5.0);
        const mod = Math.sin(ctx.state.p2 * TWO_PI) * modIndex;
        const carrier = Math.sin(ctx.state.p1 * TWO_PI + mod);

        // Hard clipping for aggression
        return Math.tanh(carrier * 2.0) * sustain;
    },

    // Reese bass: three detuned saws (+-7 cents) beat into a slow phasing growl, an ~0.85 Hz LFO sweeps a state-variable low-pass over the stack, tanh drive adds grit, and a clean sub sine one octave down is summed after the drive for weight.
    "bass-reese": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        const f0 = ctx.freq;

        if (s.init !== 1) {
            s.init = 1;
            s.ph1 = 0.0;
            s.ph2 = 0.33;
            s.ph3 = 0.67;
            s.phSub = 0.0;
            s.lfo = 0.0;
            s.lp = 0.0;
            s.bp = 0.0;
        }

        // Detuned saw stack, ratios 2^(+-7/1200), phases wrapped mod 1
        s.ph1 = (s.ph1 + f0 * 0.99596 / sr) % 1.0;
        s.ph2 = (s.ph2 + f0 / sr) % 1.0;
        s.ph3 = (s.ph3 + f0 * 1.00405 / sr) % 1.0;
        const saws = (s.ph1 * 2 - 1) + (s.ph2 * 2 - 1) + (s.ph3 * 2 - 1);

        // 0.85 Hz LFO sweeps cutoff exponentially over roughly 2x..10x the fundamental
        s.lfo = (s.lfo + 0.85 / sr) % 1.0;
        let fc = f0 * Math.exp(0.6931471805599453 * (2.2 + 1.2 * Math.sin(TWO_PI * s.lfo)));
        const fcMax = sr / 8.0;
        if (fc > fcMax) fc = fcMax;
        if (fc < 40.0) fc = 40.0;

        // Chamberlin SVF low-pass; fc <= sr/8 keeps f <= 0.765, stable with damping 0.8
        const f = 2.0 * Math.sin(Math.PI * fc / sr);
        s.lp = s.lp + f * s.bp;
        const hp = saws * 0.3333 - s.lp - 0.8 * s.bp;
        s.bp = s.bp + f * hp;

        // Saturate the filtered growl, then add the untouched sub so the low end stays clean
        const driven = Math.tanh(s.lp * 2.2);
        s.phSub = (s.phSub + f0 * 0.5 / sr) % 1.0;
        const sub = Math.sin(TWO_PI * s.phSub);

        return driven * 0.55 + sub * 0.42;
    },

    // Phase distortion lead. Uses Casio-style phase distortion to warp a sine wave into a variable pulse width, avoiding the aliasing of a standard square wave.
    "chip-lead-pd": (ctx) => {
        // Continuous phase accumulator wrapped at 1.0 to prevent floating-point precision loss
        ctx.state.phase = ((ctx.state.phase || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Low frequency oscillator for pulse-width modulation varying between 0.2 and 0.8
        const pw = 0.5 + 0.3 * Math.sin(ctx.t * 4.0);
        const p = ctx.state.phase;

        // Phase Distortion: bend the linear phase into two distinct slopes
        const warpedPhase = p < pw
            ? (p / pw) * 0.5
            : 0.5 + ((p - pw) / (1.0 - pw)) * 0.5;

        // Read the sine table using warped phase, naturally bounded -1.0 to 1.0
        return Math.sin(warpedPhase * TWO_PI);
    },

    // FM sub bass. Sine carrier with a fast-decaying 2x-ratio FM transient for percussive articulation.
    "chip-bass-fm": (ctx) => {
        // Independent phase accumulators for Carrier (1x) and Modulator (2x ratio)
        ctx.state.pCar = ((ctx.state.pCar || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.pMod = ((ctx.state.pMod || 0) + (ctx.freq * 2.0) / ctx.sampleRate) % 1.0;

        // Fast exponential decay envelope applied to the FM index
        const fmEnv = Math.exp(-ctx.t * 8.0);
        const modIndex = fmEnv * 2.5;

        // Two-operator FM calculation
        const modulator = Math.sin(ctx.state.pMod * TWO_PI) * modIndex;
        const carrier = Math.sin(ctx.state.pCar * TWO_PI + modulator);

        // Soft-clip saturation for harmonic presence, bounded to -1.0 to 1.0
        return Math.tanh(carrier * 1.5);
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

    // 'Drift Keys': A warm, melancholic electric piano (like a Rhodes) with analog pitch instability (wow/flutter) and soft saturation.
    "keys-drift": (ctx) => {
        // Wow (slow drift) and Flutter (fast wobble)
        const drift = Math.sin(ctx.t * 0.5) * 0.02 + Math.sin(ctx.t * 6.0) * 0.005;
        const actualFreq = ctx.freq * (1.0 + drift);
        ctx.state.phase = ((ctx.state.phase || 0) + actualFreq / ctx.sampleRate) % 1.0;

        // Mix of sine body and softened triangle bite
        const sine = Math.sin(ctx.state.phase * TWO_PI);
        const tri = Math.abs(ctx.state.phase * 4.0 - 2.0) - 1.0;

        // Soft clip to give it taped warmth
        return Math.tanh((sine * 0.8 + tri * 0.4) * 1.2);
    },

    // 'Pad Hauntology': A dusty, degraded analog synth pad.
    // Emulates the sound of a vintage synthesizer recorded onto heavily worn magnetic tape.
    // Features pitch drift, integrated noise floor, and a warm, muffled low-pass filter.
    "pad-hauntology": (ctx) => {
        // Wow and Flutter pitch instability
        const wow = Math.sin(ctx.t * TWO_PI * 0.3) * 0.015;
        const flutter = Math.sin(ctx.t * TWO_PI * 4.5) * 0.005;
        const actualFreq = ctx.freq * (1.0 + wow + flutter);
        ctx.state.phase = ((ctx.state.phase || 0) + actualFreq / ctx.sampleRate) % 1.0;

        // Base Waveform (Sawtooth mixed with a Sub Triangle)
        const saw = (ctx.state.phase * 2.0) - 1.0;

        // Keep the sub's cycle across main-phase wraps so it sounds an octave below.
        ctx.state.subPhase = ((ctx.state.subPhase || 0) + actualFreq * 0.5 / ctx.sampleRate) % 1.0;
        const sub = Math.abs(ctx.state.subPhase * 4.0 - 2.0) - 1.0;
        let rawMix = (saw * 0.6) + (sub * 0.4);

        // Inject tape hiss (Brown noise) directly into the pre-filter signal
        ctx.state.noise = ((ctx.state.noise || 0) * 0.8) + ((Math.random() * 2.0 - 1.0) * 0.2);
        rawMix += ctx.state.noise * 0.15;

        // Muffled Low-Pass Filter (SVF) clamped safely
        ctx.state.lp = ctx.state.lp || 0;
        ctx.state.bp = ctx.state.bp || 0;
        const cutoff = Math.min(800 + Math.sin(ctx.t * 0.5) * 200, ctx.sampleRate / 6.0);
        const f = 2.0 * Math.sin(Math.PI * cutoff / ctx.sampleRate);
        const hp = rawMix - ctx.state.lp - (0.4 * ctx.state.bp);
        ctx.state.bp += f * hp;
        ctx.state.lp += f * ctx.state.bp;

        // Gentle attack and tape saturation
        const attack = Math.min(1.0, ctx.t * 1.5);
        return Math.tanh(ctx.state.lp * 1.5) * attack;
    },

    // 'Vintage Board Lead': A drifting, nostalgic melody synth.
    // Features a distinct pitch slur on the attack, mimicking analog portamento and failing capacitors.
    "lead-vintage-board": (ctx) => {
        // Pitch envelope: starts flat, slides up to pitch over 150ms
        const pitchSlur = 1.0 - (0.05 * Math.exp(-ctx.t * 15.0));

        // Slow detune
        const drift = Math.sin(ctx.t * 2.0) * 0.01;
        const freq = ctx.freq * pitchSlur * (1.0 + drift);
        ctx.state.phase = ((ctx.state.phase || 0) + freq / ctx.sampleRate) % 1.0;

        // Softened hexagon-style wave (Pulse + Triangle)
        const pulse = ctx.state.phase < 0.3 ? 1.0 : -1.0;
        const tri = Math.abs(ctx.state.phase * 4.0 - 2.0) - 1.0;
        return Math.tanh((pulse * 0.4 + tri * 0.6) * 1.2);
    },

    // 'Drone Abyss': A massive, rumbling dark ambient drone.
    // Combines a sub-sine, a detuned sawtooth, and an ultra-slow breathing lowpass filter.
    // Evolves when held for minutes at a time.
    "drone-abyss": (ctx) => {
        // Independent phase accumulators wrapped safely
        ctx.state.pSub = ((ctx.state.pSub || 0) + (ctx.freq * 0.5) / ctx.sampleRate) % 1.0;
        ctx.state.pSaw = ((ctx.state.pSaw || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // An ultra-slow detuned oscillator drifting around the fundamental
        const driftFreq = ctx.freq * (1.0 + Math.sin(ctx.t * TWO_PI * 0.05) * 0.005);
        ctx.state.pDrift = ((ctx.state.pDrift || 0) + driftFreq / ctx.sampleRate) % 1.0;

        // Waveforms
        const sub = Math.sin(ctx.state.pSub * TWO_PI);
        const saw = (ctx.state.pSaw * 2.0) - 1.0;
        const drift = (ctx.state.pDrift * 2.0) - 1.0;
        const mix = (sub * 0.6) + (saw * 0.2) + (drift * 0.2);

        // Ultra-slow breathing LFO for the filter completing a cycle every 20 seconds
        const breath = (Math.sin(ctx.t * TWO_PI * 0.05) + 1.0) * 0.5;

        // Lowpass Filter (SVF)
        ctx.state.lp = ctx.state.lp || 0;
        ctx.state.bp = ctx.state.bp || 0;

        // Filter sweeps slowly between 100Hz and 600Hz
        const cutoff = Math.min(100 + (breath * 500), ctx.sampleRate / 6.0);
        const f = 2.0 * Math.sin(Math.PI * cutoff / ctx.sampleRate);
        const hp = mix - ctx.state.lp - (0.3 * ctx.state.bp);
        ctx.state.bp += f * hp;
        ctx.state.lp += f * ctx.state.bp;

        // Glacial Attack taking 4 seconds to reach full volume
        const attack = Math.min(1.0, ctx.t * 0.25);
        return Math.tanh(ctx.state.lp * 2.0) * attack;
    },

    // 'Pad Shimmer': Ethereal, angelic high-end texture.
    // Uses high-ratio FM synthesis where the modulation index slowly swells, creating a shimmering, cascading upper-harmonic effect.
    "pad-shimmer": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Modulator is set to 4x the fundamental (two octaves up)
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 4.0) / ctx.sampleRate) % 1.0;

        // Secondary Modulator at 8x (three octaves up)
        ctx.state.p3 = ((ctx.state.p3 || 0) + (ctx.freq * 8.0) / ctx.sampleRate) % 1.0;

        // Slow LFO controls the brightness shimmer
        const shimmerLFO = (Math.sin(ctx.t * TWO_PI * 0.1) + 1.0) * 0.5;
        const mod8 = Math.sin(ctx.state.p3 * TWO_PI) * (0.5 * shimmerLFO);
        const mod4 = Math.sin(ctx.state.p2 * TWO_PI + mod8) * (1.5 * shimmerLFO);
        const carrier = Math.sin(ctx.state.p1 * TWO_PI + mod4);

        // Glacial Attack
        const attack = Math.min(1.0, ctx.t * 0.5);
        return carrier * attack * 0.6;
    },

    // 'Binaural Beating': Meditative sine waves.
    // By playing two sines that are exactly 1Hz apart, it creates a deep acoustic beating effect that pulses naturally without an LFO. A staple of meditation and drone music.
    "drone-beating": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Exactly 1 Hz difference creates a one-second amplitude throb
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq + 1.0) / ctx.sampleRate) % 1.0;
        const s1 = Math.sin(ctx.state.p1 * TWO_PI);
        const s2 = Math.sin(ctx.state.p2 * TWO_PI);
        const attack = Math.min(1.0, ctx.t * 0.5);
        return ((s1 + s2) * 0.5) * attack;
    },

    // Deep, evolving dual-sine FM pad. Uses a sub-octave modulator and a slow LFO to gently shift the FM index, creating a warm, bioluminescent alien glow.
    "alien-glow-pad": (ctx) => {
        const s = ctx.state;

        // Independent phase accumulators with strict modulo wrapping
        s.pMod = ((s.pMod || 0) + (ctx.freq * 0.5) / ctx.sampleRate) % 1.0;

        // Slow LFO (0.15 Hz)
        s.pLfo = ((s.pLfo || 0) + 0.15 / ctx.sampleRate) % 1.0;

        // Slow LFO (0.15 Hz) mapped from 0.2 to 1.2
        const lfo = Math.sin(s.pLfo * TWO_PI) * 0.5 + 0.7;

        // Gentle FM modulation. The low modulation index keeps it mellow.
        const modulator = Math.sin(s.pMod * TWO_PI) * (1.2 * lfo);

        // Carrier oscillator phase-modulated by the sub-octave
        const out = Math.sin(ctx.p * TWO_PI + modulator);
        return Math.tanh(out * 0.8);
    },

    // A smooth, hovering magnetic drone. Uses detuned smoothed-triangle waves pushed through a strictly clamped, low-resonance State Variable Filter (SVF).
    "magnetic-hover": (ctx) => {
        const s = ctx.state;
        s.p1 = ((s.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Subtle detuning
        s.p2 = ((s.p2 || 0) + (ctx.freq * 1.008) / ctx.sampleRate) % 1.0;

        // Triangle wave approximation with no sharp aliasing edges
        const tri1 = Math.abs((s.p1 * 2.0) - 1.0) * 2.0 - 1.0;
        const tri2 = Math.abs((s.p2 * 2.0) - 1.0) * 2.0 - 1.0;
        const mix = (tri1 + tri2) * 0.5;

        // Stable SVF Lowpass Filter
        const targetCutoff = ctx.freq * 1.5;

        // Very dark, muffled cutoff
        const cutoff = Math.min(targetCutoff, ctx.sampleRate / 6.0);
        const g = Math.tan(Math.PI * cutoff / ctx.sampleRate);

        // High damping = low resonance (mellow sound)
        const damp = 1.4;
        s.ic1eq = s.ic1eq || 0;
        s.ic2eq = s.ic2eq || 0;
        const v3 = mix - s.ic2eq;
        const v1 = s.ic1eq * (1.0 - damp * g) + v3 * g;
        const v2 = s.ic2eq + s.ic1eq * g;
        s.ic1eq = v1;
        s.ic2eq = v2;

        // Soften and scale
        return Math.tanh(v2 * 1.5) * 0.7;
    },

    // A deep, tectonic rumble. Uses two heavily detuned low-frequency waves passed through a dark, low-resonance State Variable Filter to simulate shifting tectonic plates.
    "tectonic-drone": (ctx) => {
        const s = ctx.state;

        // Deep earth detuning
        s.p1 = ((s.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        s.p2 = ((s.p2 || 0) + (ctx.freq * 0.985) / ctx.sampleRate) % 1.0;

        // Pseudo-sawtooth generation summing sines to avoid sharp edges or aliasing
        const wave1 = Math.sin(s.p1 * TWO_PI) + Math.sin(s.p1 * TWO_PI * 2.0) * 0.5;
        const wave2 = Math.sin(s.p2 * TWO_PI) + Math.sin(s.p2 * TWO_PI * 2.0) * 0.5;
        const mix = (wave1 + wave2) * 0.5;

        // Stable SVF Lowpass Filter with a very dark cutoff
        const cutoff = Math.min(ctx.freq * 1.8, ctx.sampleRate / 6.0);
        const g = Math.tan(Math.PI * cutoff / ctx.sampleRate);

        // High damping prevents resonance whistling
        const damp = 1.6;
        s.ic1eq = s.ic1eq || 0;
        s.ic2eq = s.ic2eq || 0;
        const v3 = mix - s.ic2eq;
        const v1 = s.ic1eq * (1.0 - damp * g) + v3 * g;
        const v2 = s.ic2eq + s.ic1eq * g;
        s.ic1eq = v1;
        s.ic2eq = v2;

        // Saturate to glue the sub frequencies together
        return Math.tanh(v2 * 1.2) * 0.75;
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

    // 'Ambient Wind': Generative wind texture that swells slowly over time.
    // Suitable for background atmosphere in survival games.
    "ambient-wind": (ctx) => {
        ctx.state.b0 = ctx.state.b0 || 0;
        ctx.state.low = ctx.state.low || 0;
        ctx.state.band = ctx.state.band || 0;

        // Generate brown noise
        const white = Math.random() * 2.0 - 1.0;
        ctx.state.b0 = (ctx.state.b0 * 0.9) + (white * 0.1);

        // Slow LFO to sweep the filter simulating wind gusts
        const lfo = (Math.sin(ctx.t * 0.2) + 1.0) * 0.5;

        // Sweeping filter cutoff clamped safely
        const cutoff = Math.min(150 + lfo * 800, ctx.sampleRate / 6.0);
        const f = 2.0 * Math.sin(Math.PI * cutoff / ctx.sampleRate);

        // High resonance for howling wind effect
        const q = 0.6;
        const high = ctx.state.b0 - ctx.state.low - (q * ctx.state.band);
        ctx.state.band += f * high;
        ctx.state.low += f * ctx.state.band;

        // Smooth fade in
        const attack = Math.min(1.0, ctx.t * 0.5);
        return ctx.state.band * 3.0 * attack;
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

    // 'Neuro Fold': An aggressive IDM bass that uses wavefolding.
    // The sound folds back on itself, creating harsh metallic harmonics.
    "neuro-fold": (ctx) => {
        ctx.state.phase = ((ctx.state.phase || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        const base = Math.sin(ctx.state.phase * TWO_PI);

        // Modulate the drive over time to create a wobble
        const drive = 2.0 + Math.sin(ctx.t * TWO_PI * 2.0) * 1.5;

        // Wavefolding math: Math.sin() naturally folds signals greater than 1.0
        return Math.sin(base * drive * Math.PI) * 0.8;
    },

    // 'Glitch Scatter': Probability-based bit crushing.
    // Randomly drops sample rate to create algorithmic tearing sounds.
    "glitch-scatter": (ctx) => {
        ctx.state.phase = ((ctx.state.phase || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.hold = ctx.state.hold || 0;

        // A five percent chance per sample to freeze the audio, simulating buffer underruns
        if (Math.random() > 0.95) {
            // Quantize amplitude to 4 bits
            const raw = Math.sin(ctx.state.phase * TWO_PI);
            ctx.state.hold = Math.round(raw * 4) / 4.0;
        }
        return ctx.state.hold;
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
        const delayLength = Math.max(1, Math.floor(ctx.sampleRate / ctx.freq));

        if (!ctx.state.buffer) {
            // Initialize delay line with burst of white noise (the "pluck")
            const bufLength = Math.max(4096, delayLength);
            ctx.state.buffer = new Float32Array(bufLength);
            for (let i = 0; i < delayLength; i++) {
                ctx.state.buffer[i] = Math.random() * 2.0 - 1.0;
            }
            ctx.state.ptr = 0;
            ctx.state.bufferLength = bufLength;
        } else if (delayLength > ctx.state.bufferLength) {
            // Resize buffer to accommodate a lower frequency / longer delay line
            const newBuf = new Float32Array(delayLength);
            newBuf.set(ctx.state.buffer);
            ctx.state.buffer = newBuf;
            ctx.state.bufferLength = delayLength;
        }

        ctx.state.ptr = ctx.state.ptr % ctx.state.bufferLength;

        // Read current sample
        const currentSample = ctx.state.buffer[ctx.state.ptr];

        // Lowpass filter & dampen (simulates energy loss in a string)
        const nextPtr = (ctx.state.ptr + 1) % delayLength;
        const safeNextPtr = nextPtr < ctx.state.bufferLength ? nextPtr : 0;
        const nextSample = ctx.state.buffer[safeNextPtr];
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

    // Additive tonewheel organ: four sine drawbars (888800000 jazz registration) driven off one half-rate wrapped phase, 3rd-harmonic percussion pop decaying ~0.2s, 6 Hz rotary vibrato/tremolo, tanh drive for warmth
    "organ-drawbar": (ctx) => {
        const s = ctx.state;

        // Rotary-speaker LFO ~6 Hz, shared by pitch vibrato and tremolo
        s.lph = ((s.lph || 0) + 6.1 / ctx.sampleRate) % 1.0;
        const lfo = Math.sin(TWO_PI * s.lph);

        // Half-rate master phase so every drawbar (16' sub, 5-1/3' quint included) is an integer multiple; subtle pitch wobble on the increment
        s.ph = ((s.ph || 0) + (ctx.freq * 0.5 / ctx.sampleRate) * (1.0 + 0.004 * lfo)) % 1.0;
        const w = TWO_PI * s.ph;

        // Drawbars 16' / 8' / 5-1/3' / 4' pulled full out
        let mix = 0.9 * Math.sin(w)
            + 1.0 * Math.sin(w * 2.0)
            + 0.8 * Math.sin(w * 3.0)
            + 0.7 * Math.sin(w * 4.0);

        // Percussion: 3rd harmonic of the fundamental, effectively gone after ~0.2s
        mix += 0.9 * Math.sin(w * 6.0) * Math.exp(-ctx.t * 18.0);

        // Tonewheel saturation, then rotary tremolo; peak stays safely below 1
        return Math.tanh(mix * 0.55) * (0.84 + 0.10 * lfo);
    },

    // Solina-style string machine: 4 detuned saws with independent triangle-LFO pitch chorus, one-pole spectral tilt, band-filtered bow-noise shimmer, 0.5s swell into steady sustain
    "strings-ensemble": (ctx) => {
        const s = ctx.state;
        const inv = 1.0 / ctx.sampleRate;

        if (!s.init) {
            s.init = 1;

            // Stagger saw phases so layers never start click-aligned
            s.p1 = 0.0;
            s.p2 = 0.17;
            s.p3 = 0.43;
            s.p4 = 0.71;

            // Chorus LFO phases, spread so vibratos never line up
            s.l1 = 0.0;
            s.l2 = 0.31;
            s.l3 = 0.57;
            s.l4 = 0.83;

            // Filter states
            s.f1 = 0.0;
            s.f2 = 0.0;
            s.nz1 = 0.0;
            s.nz2 = 0.0;

            // One-pole tilt coefficient, cutoff clamped to sr/6 to guarantee stability
            const cutoff = Math.min(ctx.freq * 7.0 + 1500.0, ctx.sampleRate / 6.0);
            s.lpk = 1.0 - Math.exp(-TWO_PI * cutoff * inv);
        }

        // Independent slow chorus LFOs (0.7-5.6 Hz), cheap triangle shape from wrapped phase
        s.l1 = (s.l1 + 0.7 * inv) % 1.0;
        s.l2 = (s.l2 + 2.3 * inv) % 1.0;
        s.l3 = (s.l3 + 4.1 * inv) % 1.0;
        s.l4 = (s.l4 + 5.6 * inv) % 1.0;
        const t1 = Math.abs(s.l1 * 4.0 - 2.0) - 1.0;
        const t2 = Math.abs(s.l2 * 4.0 - 2.0) - 1.0;
        const t3 = Math.abs(s.l3 * 4.0 - 2.0) - 1.0;
        const t4 = Math.abs(s.l4 * 4.0 - 2.0) - 1.0;

        // Four saw layers, static detune spread (about +/-8 cents) plus ~3 cent LFO vibrato each
        const base = ctx.freq * inv;
        s.p1 = (s.p1 + base * (0.9955 + 0.0018 * t1)) % 1.0;
        s.p2 = (s.p2 + base * (0.9985 + 0.0018 * t2)) % 1.0;
        s.p3 = (s.p3 + base * (1.0015 + 0.0018 * t3)) % 1.0;
        s.p4 = (s.p4 + base * (1.0045 + 0.0018 * t4)) % 1.0;
        const saws = (s.p1 * 2.0 - 1.0) + (s.p2 * 2.0 - 1.0) + (s.p3 * 2.0 - 1.0) + (s.p4 * 2.0 - 1.0);

        // Gentle 12 dB/oct tilt tames saw buzz while staying bright
        s.f1 += s.lpk * (saws * 0.25 - s.f1);
        s.f2 += s.lpk * (s.f1 - s.f2);

        // Bow-noise shimmer: band-limited noise (fast LP minus slow LP), amplitude wobbled by slowest LFO
        const white = Math.random() * 2.0 - 1.0;
        s.nz1 += 0.25 * (white - s.nz1);
        s.nz2 += 0.04 * (white - s.nz2);
        const bowNoise = (s.nz1 - s.nz2) * 0.015 * (1.0 + 0.3 * t1);

        // 0.5s smoothstep attack swell, then exactly 1.0 forever: steady sustain, engine handles release
        let env = ctx.t * 2.0;
        if (env > 1.0) env = 1.0;
        env = env * env * (3.0 - 2.0 * env);

        return Math.tanh((s.f2 + bowNoise) * env * 1.4);
    },

    // 'Glass Mallet': A highly resonant, woody/glassy pluck.
    // Uses inharmonic FM ratios (1 : 3.14) to mimic a xylophone or glass marimba.
    "glass-mallet": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Modulator at Pi ratio creates a metallic/glassy overtone
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 3.1415) / ctx.sampleRate) % 1.0;

        // Fast transient decay for the glass click sound
        const modIndex = 1.5 * Math.exp(-ctx.t * 20.0);
        const mod = Math.sin(ctx.state.p2 * TWO_PI) * modIndex;
        return Math.sin(ctx.state.p1 * TWO_PI + mod) * Math.exp(-ctx.t * 3.0);
    },

    // 'FM Keys HQ': An FM electric piano.
    // Crystal clear transients, wide harmonic content, anti-aliased via pure math.
    "keys-fm-hq": (ctx) => {
        ctx.state.p1 = ((ctx.state.p1 || 0) + ctx.freq / ctx.sampleRate) % 1.0;

        // Modulator at exactly 2x ratio (Octave)
        ctx.state.p2 = ((ctx.state.p2 || 0) + (ctx.freq * 2.0) / ctx.sampleRate) % 1.0;

        // Modulator at 14x ratio (High glassy harmonic)
        ctx.state.p3 = ((ctx.state.p3 || 0) + (ctx.freq * 14.0) / ctx.sampleRate) % 1.0;

        // Complex Envelopes
        const envBody = Math.exp(-ctx.t * 1.5);
        const envTine = Math.exp(-ctx.t * 15.0);
        const modHigh = Math.sin(ctx.state.p3 * TWO_PI) * envTine * 0.8;
        const modLow = Math.sin(ctx.state.p2 * TWO_PI) * envBody * 2.0;
        const carrier = Math.sin(ctx.state.p1 * TWO_PI + modLow + modHigh);
        return carrier * envBody * 0.8;
    },

    // FM pluck. Rapidly decaying inharmonic FM pluck using a 3.5x ratio, designed for fast arpeggios.
    "chip-arp-pluck": (ctx) => {
        // Carrier phase and inharmonic Modulator phase
        ctx.state.pCar = ((ctx.state.pCar || 0) + ctx.freq / ctx.sampleRate) % 1.0;
        ctx.state.pMod = ((ctx.state.pMod || 0) + (ctx.freq * 3.5) / ctx.sampleRate) % 1.0;

        // Dual fast-decay envelopes for amplitude and modulation index
        const ampEnv = Math.exp(-ctx.t * 10.0);
        const fmEnv = Math.exp(-ctx.t * 15.0);
        const modulator = Math.sin(ctx.state.pMod * TWO_PI) * fmEnv * 3.0;
        const out = Math.sin(ctx.state.pCar * TWO_PI + modulator) * ampEnv;
        return out;
    },

    // A warm, breathy wooden flute. Uses a pure sine wave fundamental mixed with a gently filtered, low-volume triangle wave for organic woody overtones, driven by a subtle vibrato.
    "hollow-wood-flute": (ctx) => {
        const s = ctx.state;

        // Slow LFO for organic breath/pitch drift at approximately 4.5 Hz
        s.pLfo = ((s.pLfo || 0) + 4.5 / ctx.sampleRate) % 1.0;

        // 2Hz pitch drift
        const vibrato = Math.sin(s.pLfo * TWO_PI) * 2.0;
        const trueFreq = ctx.freq + vibrato;

        // Phase accumulators
        s.p1 = ((s.p1 || 0) + trueFreq / ctx.sampleRate) % 1.0;

        // First overtone
        s.p2 = ((s.p2 || 0) + (trueFreq * 2.0) / ctx.sampleRate) % 1.0;
        const fund = Math.sin(s.p1 * TWO_PI);

        // Triangle wave for the overtone to give a hollow woody shape
        const tri = Math.abs((s.p2 * 2.0) - 1.0) * 2.0 - 1.0;

        // Lowpass filter on the triangle overtone to keep it warm and muffled
        const cutoff = Math.min(ctx.freq * 2.5, ctx.sampleRate / 6.0);
        const alpha = Math.tan(Math.PI * cutoff / ctx.sampleRate);
        s.lp = s.lp || 0;

        // Simple 1-pole lowpass
        s.lp += (tri - s.lp) * alpha;
        const mix = (fund * 0.8) + (s.lp * 0.2);
        return Math.tanh(mix);
    },

    // Inharmonic FM synthesis modeling a bronze Saron or Gender metallophone.
    // Uses specific non-integer ratios to generate a metallic, bell-like strike.
    "gamelan-saron": (ctx) => {
        const sr = ctx.sampleRate;
        const f = ctx.freq;
        const s = ctx.state;
        const t = ctx.t;

        // Dual-stage exponential decay for the mallet strike and the long ringing body
        const strikeEnv = Math.exp(-t * 12.0);
        const bodyEnv = Math.exp(-t * 1.5);

        // Modulator 1: High inharmonic overtone
        s.pM1 = ((s.pM1 || 0) + (f * 3.46) / sr) % 1.0;
        const mod1 = Math.sin(s.pM1 * TWO_PI) * strikeEnv * 2.5;

        // Modulator 2: Low inharmonic overtone chained with the first modulator
        s.pM2 = ((s.pM2 || 0) + (f * 1.52) / sr) % 1.0;
        const mod2 = Math.sin(s.pM2 * TWO_PI + mod1) * bodyEnv * 1.8;

        // Carrier: Fundamental tone
        s.pC = ((s.pC || 0) + f / sr) % 1.0;
        const carrier = Math.sin(s.pC * TWO_PI + mod2);
        return Math.tanh(carrier * bodyEnv) * 0.8;
    },

    // Physical modeling estimation of a Suling (traditional bamboo ring flute).
    // Combines a sine vibrato core with a noise-excited, tightly clamped State Variable Filter.
    "suling-flute": (ctx) => {
        const sr = ctx.sampleRate;
        const f = ctx.freq;
        const s = ctx.state;

        // Smooth attack mimicking breath pressure
        const attackEnv = Math.min(ctx.t * 8.0, 1.0);

        // LFO for breath vibrato at approximately 5.5 Hz
        s.pLfo = ((s.pLfo || 0) + 5.5 / sr) % 1.0;
        const vibrato = Math.sin(s.pLfo * TWO_PI) * 0.015;

        // Fundamental tone with vibrato applied
        s.pC = ((s.pC || 0) + (f * (1.0 + vibrato)) / sr) % 1.0;
        const tone = Math.sin(s.pC * TWO_PI);

        // Breath noise excitation
        const noise = Math.random() * 2.0 - 1.0;

        // Chamberlin SVF Bandpass Filter for the breath noise
        // Cutoff clamped to sr / 6.0 to prevent SVF blowout
        const cutoff = Math.min(f * 2.0, sr / 6.0);
        const w = 2.0 * Math.sin(Math.PI * cutoff / sr);
        s.lp = s.lp || 0;
        s.bp = s.bp || 0;

        // Calculate Highpass with damping factor of 0.6 for moderate resonance
        const hp = noise - s.lp - 0.6 * s.bp;
        s.bp += w * hp;
        s.lp += w * s.bp;

        // Mix the pure tone and the filtered breath noise
        const out = (tone * 0.65) + (s.bp * 0.35);
        return Math.tanh(out * attackEnv) * 0.8;
    },

    // Solo orchestral voices use scalar state and unrolled harmonic recurrences.

    // Solo violin: sixteen body-weighted harmonics, bow noise, and delayed pitch/timbre vibrato.

    "orch-violin": (ctx) => {
        const s = ctx.state, sr = ctx.sampleRate, inputFreq = ctx.freq;
        if (!(sr > 0) || !Number.isFinite(sr) || !(inputFreq > 0) || !Number.isFinite(inputFreq)) return 0;
        const f = Math.min(inputFreq, sr * 0.49);
        if (s.init !== 1) {
            s.init = 1;
            s.phase = 0;
            const suppliedSeed = Number.isFinite(s.seed);
            const initialSeed = suppliedSeed ? (s.seed | 0) : 194731;
            const phaseOffset = suppliedSeed ? (initialSeed >>> 0) / 4294967296 : 0;
            s.seed = initialSeed || 194731;
            s.vPhase = phaseOffset;
            s.dPhase = (0.17 + phaseOffset) % 1.0;
            s.v = 0;
            s.drift = 0;
            s.vDelta = 0;
            s.dDelta = 0;
            s.control = 0;
            s.attack = 0;
            s.brightness = 0;
            s.vDepth = 0;
            s.noiseLo = 0;
            s.noiseHi = 0;
            s.rate = 0;
            s.profileFreq = f;
            s.profileTick = 0;
            s.lastProfileFreq = -1;
            s.maskProfile = -2;
            s.maskFreq = -1;
        }
        if (s.rate !== sr) {
            s.rate = sr;
            s.invSr = 1 / sr;
            s.control = 0;
            s.profileA = 1 - Math.exp(-TWO_PI * Math.min(32, sr / 6) / sr);
            s.fullBandLimit = sr * 0.36 / (16 * 1.0131);
            s.profileTick = 0;
            s.lastProfileFreq = -1;
            s.maskProfile = -2;
            s.maskFreq = -1;
            s.aC = 1 - Math.exp(-1 / (0.017 * sr));
            s.bC = 1 - Math.exp(-1 / (0.055 * sr));
            s.vC = 1 - Math.exp(-1 / (0.16 * sr));
            s.nLoC = 1 - Math.exp(-TWO_PI * Math.min(640, sr / 6) / sr);
            s.nHiC = 1 - Math.exp(-TWO_PI * Math.min(4600, sr / 6) / sr);
        }
        s.profileFreq += s.profileA * (f - s.profileFreq);
        s.profileTick--;
        if (s.profileTick <= 0) {
            s.profileTick = 64;
            if (Math.abs(s.profileFreq - s.lastProfileFreq) > 0.0001) {
                s.lastProfileFreq = s.profileFreq;
                const f = s.profileFreq;
                let x, u, v, w, a, b, c, h, d, q, total = 0;
                // The body-response slope links harmonic color to the slow pitch vibrato.

                x = 1 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 1.000000000 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h1 = h;
                s.d1 = d;
                total += h + Math.abs(d);
                x = 2 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.473028823 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h2 = h;
                s.d2 = d;
                total += h + Math.abs(d);
                x = 3 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.305287516 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h3 = h;
                s.d3 = d;
                total += h + Math.abs(d);
                x = 4 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.223756268 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h4 = h;
                s.d4 = d;
                total += h + Math.abs(d);
                x = 5 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.175837862 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h5 = h;
                s.d5 = d;
                total += h + Math.abs(d);
                x = 6 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.144409794 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h6 = h;
                s.d6 = d;
                total += h + Math.abs(d);
                x = 7 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.122262738 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h7 = h;
                s.d7 = d;
                total += h + Math.abs(d);
                x = 8 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.105843164 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h8 = h;
                s.d8 = d;
                total += h + Math.abs(d);
                x = 9 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.093200467 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h9 = h;
                s.d9 = d;
                total += h + Math.abs(d);
                x = 10 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.083176377 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h10 = h;
                s.d10 = d;
                total += h + Math.abs(d);
                x = 11 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.075040531 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h11 = h;
                s.d11 = d;
                total += h + Math.abs(d);
                x = 12 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.068309995 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h12 = h;
                s.d12 = d;
                total += h + Math.abs(d);
                x = 13 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.062652900 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h13 = h;
                s.d13 = d;
                total += h + Math.abs(d);
                x = 14 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.057833799 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h14 = h;
                s.d14 = d;
                total += h + Math.abs(d);
                x = 15 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.053681104 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h15 = h;
                s.d15 = d;
                total += h + Math.abs(d);
                x = 16 * f;
                u = (x - 290) / 65;
                v = (x - 560) / 125;
                w = (x - 2550) / 650;
                a = 1 / (1 + u * u);
                b = 1 / (1 + v * v);
                c = 1 / (1 + w * w);
                q = 0.050066867 / (1 + (x / 9000) * (x / 9000));
                h = q * (0.24 + 1.20 * a + 1.05 * b + 1.15 * c);
                d = -0.0125 * x * q * (0.0369230769 * u * a * a + 0.0168000000 * v * b * b + 0.0035384615 * w * c * c);
                s.h16 = h;
                s.d16 = d;
                total += h + Math.abs(d);
                s.norm = 1 / total;
            }
        }
        // Body color updates at control rate; harmonic guards follow pitch immediately.

        if (s.maskProfile !== s.lastProfileFreq ||
            (s.maskFreq !== f && (f > s.fullBandLimit || s.maskFreq > s.fullBandLimit))) {
            s.maskProfile = s.lastProfileFreq;
            s.maskFreq = f;
            const guardedStep = f * 1.0131 / sr;
            let cutoff = guardedStep, gate;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w1 = s.h1 * gate;
            s.e1 = s.d1 * gate;
            s.audible = gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w2 = s.h2 * gate;
            s.e2 = s.d2 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w3 = s.h3 * gate;
            s.e3 = s.d3 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w4 = s.h4 * gate;
            s.e4 = s.d4 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w5 = s.h5 * gate;
            s.e5 = s.d5 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w6 = s.h6 * gate;
            s.e6 = s.d6 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w7 = s.h7 * gate;
            s.e7 = s.d7 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w8 = s.h8 * gate;
            s.e8 = s.d8 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w9 = s.h9 * gate;
            s.e9 = s.d9 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w10 = s.h10 * gate;
            s.e10 = s.d10 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w11 = s.h11 * gate;
            s.e11 = s.d11 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w12 = s.h12 * gate;
            s.e12 = s.d12 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w13 = s.h13 * gate;
            s.e13 = s.d13 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w14 = s.h14 * gate;
            s.e14 = s.d14 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w15 = s.h15 * gate;
            s.e15 = s.d15 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.36 ? 1 : Math.max(0, (0.46 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w16 = s.h16 * gate;
            s.e16 = s.d16 * gate;
        }
        if (s.control === 0) {
            const v = Math.sin(TWO_PI * s.vPhase), d = Math.sin(TWO_PI * s.dPhase);
            s.vDelta = (v - s.v) / 64;
            s.dDelta = (d - s.drift) / 64;
            s.control = 64;
            s.vPhase = (s.vPhase + (5.8 + 0.16 * d) * 64 * s.invSr) % 1.0;
            s.dPhase = (s.dPhase + 0.37 * 64 * s.invSr) % 1.0;
        }
        s.v += s.vDelta;
        s.drift += s.dDelta;
        s.control--;
        const attack = s.attack, bright = s.brightness, vibrato = s.v * s.vDepth;
        s.attack += s.aC * (1 - s.attack);
        s.brightness += s.bC * (1 - s.brightness);
        if (bright > 0.82) s.vDepth += s.vC * (1 - s.vDepth);
        s.phase = (s.phase + f * s.invSr * (1 + 0.0125 * vibrato + 0.00055 * s.drift - 0.001 * (1 - attack))) % 1.0;
        // Unrolled sin(n*x) recurrence: one audio-rate sine/cosine pair, no oscillator banks or allocation.

        const twiceCos = 2 * Math.cos(TWO_PI * s.phase);
        let previous = 0, current = Math.sin(TWO_PI * s.phase), next, low = 0, mid = 0, high = 0;
        low += current * (s.w1 + vibrato * s.e1);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        low += current * (s.w2 + vibrato * s.e2);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        low += current * (s.w3 + vibrato * s.e3);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        mid += current * (s.w4 + vibrato * s.e4);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        mid += current * (s.w5 + vibrato * s.e5);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        mid += current * (s.w6 + vibrato * s.e6);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        mid += current * (s.w7 + vibrato * s.e7);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w8 + vibrato * s.e8);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w9 + vibrato * s.e9);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w10 + vibrato * s.e10);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w11 + vibrato * s.e11);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w12 + vibrato * s.e12);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w13 + vibrato * s.e13);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w14 + vibrato * s.e14);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w15 + vibrato * s.e15);
        next = twiceCos * current - previous;
        previous = current;
        current = next;
        high += current * (s.w16 + vibrato * s.e16);
        s.seed = (Math.imul(s.seed, 1664525) + 1013904223) | 0;
        const white = s.seed / 2147483648;
        s.noiseLo += s.nLoC * (white - s.noiseLo);
        s.noiseHi += s.nHiC * (white - s.noiseHi);
        const noise = 0.5 * (s.noiseHi - s.noiseLo) * s.audible;
        const tone = (low + (0.45 + 0.55 * bright) * mid + (0.18 + 0.82 * bright * bright) * high) * s.norm;
        const output = attack * (0.88 * (0.99 + 0.01 * s.drift) * tone + (0.005 + 0.021 * (1 - bright)) * noise);
        return output;
    },

    // Solo cello: thirty-two bowed harmonics retain low-register body and bridge color.

    "orch-cello": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        const inputFreq = ctx.freq;
        if (!(sr > 0) || !Number.isFinite(sr) || !(inputFreq > 0) || !Number.isFinite(inputFreq)) return 0;
        const baseFreq = Math.min(inputFreq, sr * 0.49);
        const age = ctx.t > 0 && Number.isFinite(ctx.t) ? ctx.t : 0;
        if (s.ready !== 1) {
            s.ready = 1;
            s.phase = 0.0;
            const suppliedSeed = Number.isFinite(s.seed);
            const initialSeed = suppliedSeed ? (s.seed | 0) : 0x68e31da4;
            const phaseOffset = suppliedSeed ? (initialSeed >>> 0) / 4294967296 : 0;
            s.seed = initialSeed || 0x68e31da4;
            s.vibratoPhase = phaseOffset;
            s.breathPhase = (0.19 + phaseOffset) % 1.0;
            s.noiseLow = 0.0;
            s.noiseHigh = 0.0;
            s.drift = 0.0;
            s.profileFreq = baseFreq;
            s.profileTick = 0;
            s.lastProfileFreq = -1.0;
            s.rate = 0;
            s.maskProfile = -2;
            s.maskFreq = -1;
        }

        // Fixed coefficients change only with sample rate; every cutoff is <= sr / 6.

        if (s.rate !== sr) {
            s.rate = sr;
            s.noiseLowA = 1.0 - Math.exp(-TWO_PI * Math.min(900.0, sr / 6.0) / sr);
            s.noiseHighA = 1.0 - Math.exp(-TWO_PI * Math.min(4200.0, sr / 6.0) / sr);
            s.driftA = 1.0 - Math.exp(-TWO_PI * Math.min(13.0, sr / 6.0) / sr);
            s.profileA = 1.0 - Math.exp(-TWO_PI * Math.min(32.0, sr / 6.0) / sr);
            s.profileTick = 0;
            s.lastProfileFreq = -1.0;
            s.maskProfile = -2;
            s.maskFreq = -1;
            s.fullBandLimit = sr * 0.35 / (32 * 1.012);
        }
        s.profileFreq += s.profileA * (baseFreq - s.profileFreq);
        s.profileTick -= 1;
        if (s.profileTick <= 0) {
            s.profileTick = 64;
            if (Math.abs(s.profileFreq - s.lastProfileFreq) > 0.0001) {
                s.lastProfileFreq = s.profileFreq;
                let sum = 0.0;
                let ripplePrevious = 1.0;
                let rippleCosine = 0.7384685587295879;
                for (let n = 1; n <= 32; n += 1) {
                    const hz = s.profileFreq * n;

                    // Tuned broad body/bridge contours; these are not measured cello modes.

                    const lowBody = (hz - 185.0) / 115.0;
                    const midBody = (hz - 510.0) / 230.0;
                    const bridge = (hz - 2100.0) / 1100.0;
                    const loss = hz / 4900.0;
                    const body = 0.48 + 0.78 / (1.0 + lowBody * lowBody)
                        + 0.95 / (1.0 + midBody * midBody) + 0.36 / (1.0 + bridge * bridge);
                    // A modest bow-position ripple avoids a uniform textbook saw spectrum.

                    const ripple = 0.79 + 0.21 * rippleCosine;
                    const rippleNext = 1.4769371174591758 * rippleCosine - ripplePrevious;
                    ripplePrevious = rippleCosine;
                    rippleCosine = rippleNext;
                    const a = body * ripple / (n * (1.0 + loss * loss));
                    sum += a;
                    switch (n) {
                        case 1:
                            s.h1 = a;
                            break;
                        case 2:
                            s.h2 = a;
                            break;
                        case 3:
                            s.h3 = a;
                            break;
                        case 4:
                            s.h4 = a;
                            break;
                        case 5:
                            s.h5 = a;
                            break;
                        case 6:
                            s.h6 = a;
                            break;
                        case 7:
                            s.h7 = a;
                            break;
                        case 8:
                            s.h8 = a;
                            break;
                        case 9:
                            s.h9 = a;
                            break;
                        case 10:
                            s.h10 = a;
                            break;
                        case 11:
                            s.h11 = a;
                            break;
                        case 12:
                            s.h12 = a;
                            break;
                        case 13:
                            s.h13 = a;
                            break;
                        case 14:
                            s.h14 = a;
                            break;
                        case 15:
                            s.h15 = a;
                            break;
                        case 16:
                            s.h16 = a;
                            break;
                        case 17:
                            s.h17 = a;
                            break;
                        case 18:
                            s.h18 = a;
                            break;
                        case 19:
                            s.h19 = a;
                            break;
                        case 20:
                            s.h20 = a;
                            break;
                        case 21:
                            s.h21 = a;
                            break;
                        case 22:
                            s.h22 = a;
                            break;
                        case 23:
                            s.h23 = a;
                            break;
                        case 24:
                            s.h24 = a;
                            break;
                        case 25:
                            s.h25 = a;
                            break;
                        case 26:
                            s.h26 = a;
                            break;
                        case 27:
                            s.h27 = a;
                            break;
                        case 28:
                            s.h28 = a;
                            break;
                        case 29:
                            s.h29 = a;
                            break;
                        case 30:
                            s.h30 = a;
                            break;
                        case 31:
                            s.h31 = a;
                            break;
                        case 32:
                            s.h32 = a;
                            break;
                    }
                }
                s.toneGain = 0.84 / Math.max(sum, 0.000000001);
            }
        }

        let random = s.seed | 0;
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        s.seed = random;
        const white = random * 4.656612873077393e-10;
        s.drift += s.driftA * (white - s.drift);
        s.noiseLow += s.noiseLowA * (white - s.noiseLow);
        s.noiseHigh += s.noiseHighA * (white - s.noiseHigh);

        s.breathPhase = (s.breathPhase + 0.27 / sr) % 1.0;
        const slow = Math.sin(TWO_PI * s.breathPhase);
        s.vibratoPhase = (s.vibratoPhase + (5.15 + 0.11 * slow) / sr) % 1.0;
        const vibDepth = Math.min(1.0, Math.max(0.0, (age - 0.17) / 0.42));
        const deviation = 0.0063 * vibDepth * Math.sin(TWO_PI * s.vibratoPhase) + 0.0007 * s.drift;
        s.phase = (s.phase + baseFreq * (1.0 + deviation) / sr) % 1.0;

        // Body color updates at control rate; harmonic guards follow pitch immediately.

        if (s.maskProfile !== s.lastProfileFreq ||
            (s.maskFreq !== baseFreq && (baseFreq > s.fullBandLimit || s.maskFreq > s.fullBandLimit))) {
            s.maskProfile = s.lastProfileFreq;
            s.maskFreq = baseFreq;
            const guardedStep = baseFreq * 1.012 / sr;
            let cutoff = guardedStep, gate;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w1 = s.h1 * gate;
            s.audible = gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w2 = s.h2 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w3 = s.h3 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w4 = s.h4 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w5 = s.h5 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w6 = s.h6 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w7 = s.h7 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w8 = s.h8 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w9 = s.h9 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w10 = s.h10 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w11 = s.h11 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w12 = s.h12 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w13 = s.h13 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w14 = s.h14 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w15 = s.h15 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w16 = s.h16 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w17 = s.h17 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w18 = s.h18 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w19 = s.h19 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w20 = s.h20 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w21 = s.h21 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w22 = s.h22 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w23 = s.h23 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w24 = s.h24 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w25 = s.h25 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w26 = s.h26 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w27 = s.h27 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w28 = s.h28 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w29 = s.h29 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w30 = s.h30 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w31 = s.h31 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w32 = s.h32 * gate;
        }
        const sine = Math.sin(TWO_PI * s.phase);
        const twiceCos = 2.0 * Math.cos(TWO_PI * s.phase);
        let previous = 0, harmonic = sine, next, core = 0, edge = 0;
        core += harmonic * s.w1;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        core += harmonic * s.w2;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        core += harmonic * s.w3;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        core += harmonic * s.w4;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w5;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w6;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w7;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w8;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w9;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w10;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w11;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w12;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w13;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w14;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w15;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w16;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w17;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w18;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w19;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w20;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w21;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w22;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w23;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w24;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w25;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w26;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w27;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w28;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w29;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w30;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w31;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w32;
        let attack = Math.min(1.0, age / 0.045);
        attack = attack * attack * (3.0 - 2.0 * attack);
        let bloom = Math.min(1.0, age / 0.11);
        bloom = bloom * bloom * (3.0 - 2.0 * bloom);
        const tone = (core + edge * (0.68 + 0.32 * bloom)) * s.toneGain;
        const rosin = (s.noiseHigh - s.noiseLow) * s.audible * (0.007 + 0.018 * (1.0 - bloom));
        const finalOutput = attack * (tone * (0.982 + 0.018 * slow) + rosin);
        return finalOutput;
    },

    // French horn: twenty-four lip harmonics, a rounded bell contour, and a gradual brass bloom.

    "orch-french-horn": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        const inputFreq = ctx.freq;
        if (!(sr > 0) || !Number.isFinite(sr) || !(inputFreq > 0) || !Number.isFinite(inputFreq)) return 0;
        const baseFreq = Math.min(inputFreq, sr * 0.49);
        const age = ctx.t > 0 && Number.isFinite(ctx.t) ? ctx.t : 0;
        if (s.ready !== 1) {
            s.ready = 1;
            s.phase = 0.0;
            const suppliedSeed = Number.isFinite(s.seed);
            const initialSeed = suppliedSeed ? (s.seed | 0) : 0x7f4a7c15;
            const phaseOffset = suppliedSeed ? (initialSeed >>> 0) / 4294967296 : 0;
            s.seed = initialSeed || 0x7f4a7c15;
            s.vibratoPhase = phaseOffset;
            s.breathPhase = (0.19 + phaseOffset) % 1.0;
            s.noiseLow = 0.0;
            s.noiseHigh = 0.0;
            s.drift = 0.0;
            s.profileFreq = baseFreq;
            s.profileTick = 0;
            s.lastProfileFreq = -1.0;
            s.rate = 0;
            s.maskProfile = -2;
            s.maskFreq = -1;
        }

        // Fixed coefficients change only with sample rate; every cutoff is <= sr / 6.

        if (s.rate !== sr) {
            s.rate = sr;
            s.noiseLowA = 1.0 - Math.exp(-TWO_PI * Math.min(500.0, sr / 6.0) / sr);
            s.noiseHighA = 1.0 - Math.exp(-TWO_PI * Math.min(2300.0, sr / 6.0) / sr);
            s.driftA = 1.0 - Math.exp(-TWO_PI * Math.min(13.0, sr / 6.0) / sr);
            s.profileA = 1.0 - Math.exp(-TWO_PI * Math.min(32.0, sr / 6.0) / sr);
            s.profileTick = 0;
            s.lastProfileFreq = -1.0;
            s.maskProfile = -2;
            s.maskFreq = -1;
            s.fullBandLimit = sr * 0.35 / (24 * 1.006);
        }
        s.profileFreq += s.profileA * (baseFreq - s.profileFreq);
        s.profileTick -= 1;
        if (s.profileTick <= 0) {
            s.profileTick = 64;
            if (Math.abs(s.profileFreq - s.lastProfileFreq) > 0.0001) {
                s.lastProfileFreq = s.profileFreq;
                let sum = 0.0;
                let rolloff = 0.8780954309205613;
                for (let n = 1; n <= 24; n += 1) {
                    const hz = s.profileFreq * n;

                    // Tuned mouthpiece/bell emphasis and progressively damped lip harmonics.

                    const bell = (hz - 700.0) / 700.0;
                    const loss = hz / 2700.0;
                    const a = n * rolloff * (0.5 + 0.9 / (1.0 + bell * bell))
                        / ((1.6 + n * n) * (1.0 + loss * loss * loss * loss));
                    rolloff *= 0.8780954309205613;
                    sum += a;
                    switch (n) {
                        case 1:
                            s.h1 = a;
                            break;
                        case 2:
                            s.h2 = a;
                            break;
                        case 3:
                            s.h3 = a;
                            break;
                        case 4:
                            s.h4 = a;
                            break;
                        case 5:
                            s.h5 = a;
                            break;
                        case 6:
                            s.h6 = a;
                            break;
                        case 7:
                            s.h7 = a;
                            break;
                        case 8:
                            s.h8 = a;
                            break;
                        case 9:
                            s.h9 = a;
                            break;
                        case 10:
                            s.h10 = a;
                            break;
                        case 11:
                            s.h11 = a;
                            break;
                        case 12:
                            s.h12 = a;
                            break;
                        case 13:
                            s.h13 = a;
                            break;
                        case 14:
                            s.h14 = a;
                            break;
                        case 15:
                            s.h15 = a;
                            break;
                        case 16:
                            s.h16 = a;
                            break;
                        case 17:
                            s.h17 = a;
                            break;
                        case 18:
                            s.h18 = a;
                            break;
                        case 19:
                            s.h19 = a;
                            break;
                        case 20:
                            s.h20 = a;
                            break;
                        case 21:
                            s.h21 = a;
                            break;
                        case 22:
                            s.h22 = a;
                            break;
                        case 23:
                            s.h23 = a;
                            break;
                        case 24:
                            s.h24 = a;
                            break;
                    }
                }
                s.toneGain = 0.84 / Math.max(sum, 0.000000001);
            }
        }

        let random = s.seed | 0;
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        s.seed = random;
        const white = random * 4.656612873077393e-10;
        s.drift += s.driftA * (white - s.drift);
        s.noiseLow += s.noiseLowA * (white - s.noiseLow);
        s.noiseHigh += s.noiseHighA * (white - s.noiseHigh);

        s.breathPhase = (s.breathPhase + 0.27 / sr) % 1.0;
        const slow = Math.sin(TWO_PI * s.breathPhase);
        s.vibratoPhase = (s.vibratoPhase + (4.65 + 0.11 * slow) / sr) % 1.0;
        const vibDepth = Math.min(1.0, Math.max(0.0, (age - 0.32) / 0.6));
        const settle = Math.max(0.0, 1.0 - age / 0.09);
        const deviation = 0.0018 * vibDepth * Math.sin(TWO_PI * s.vibratoPhase)
            + 0.00035 * s.drift - 0.0022 * settle * settle;
        s.phase = (s.phase + baseFreq * (1.0 + deviation) / sr) % 1.0;

        // Body color updates at control rate; harmonic guards follow pitch immediately.

        if (s.maskProfile !== s.lastProfileFreq ||
            (s.maskFreq !== baseFreq && (baseFreq > s.fullBandLimit || s.maskFreq > s.fullBandLimit))) {
            s.maskProfile = s.lastProfileFreq;
            s.maskFreq = baseFreq;
            const guardedStep = baseFreq * 1.006 / sr;
            let cutoff = guardedStep, gate;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w1 = s.h1 * gate;
            s.audible = gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w2 = s.h2 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w3 = s.h3 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w4 = s.h4 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w5 = s.h5 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w6 = s.h6 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w7 = s.h7 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w8 = s.h8 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w9 = s.h9 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w10 = s.h10 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w11 = s.h11 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w12 = s.h12 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w13 = s.h13 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w14 = s.h14 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w15 = s.h15 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w16 = s.h16 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w17 = s.h17 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w18 = s.h18 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w19 = s.h19 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w20 = s.h20 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w21 = s.h21 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w22 = s.h22 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w23 = s.h23 * gate;
            cutoff += guardedStep;
            gate = cutoff <= 0.35 ? 1 : Math.max(0, (0.45 - cutoff) / 0.1);
            gate *= gate * (3 - 2 * gate);
            s.w24 = s.h24 * gate;
        }
        const sine = Math.sin(TWO_PI * s.phase);
        const twiceCos = 2.0 * Math.cos(TWO_PI * s.phase);
        let previous = 0, harmonic = sine, next, core = 0, edge = 0;
        core += harmonic * s.w1;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        core += harmonic * s.w2;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w3;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w4;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w5;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w6;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w7;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w8;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w9;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w10;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w11;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w12;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w13;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w14;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w15;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w16;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w17;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w18;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w19;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w20;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w21;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w22;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w23;
        next = twiceCos * harmonic - previous;
        previous = harmonic;
        harmonic = next;
        edge += harmonic * s.w24;
        let attack = Math.min(1.0, age / 0.055);
        attack = attack * attack * (3.0 - 2.0 * attack);
        let bloom = Math.min(1.0, age / 0.16);
        bloom = bloom * bloom * (3.0 - 2.0 * bloom);
        const tone = (core + edge * (0.35 + 0.65 * bloom)) * s.toneGain;
        const breath = (s.noiseHigh - s.noiseLow) * s.audible * (0.003 + 0.009 * (1.0 - bloom));
        const finalOutput = attack * (tone * (0.99 + 0.01 * slow) + breath);
        return finalOutput;
    },

    // Eight tapered flute partials with breath onset, pressure bloom, and delayed vibrato.

    "orch-flute": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        const f = ctx.freq;
        if (!(sr > 0) || !Number.isFinite(sr) || !(f > 0) || !Number.isFinite(f)) return 0;
        if (f >= sr * 0.5) return 0;
        if (s.fluteReady !== 1) {
            s.fluteReady = 1;
            s.rate = 0;
            s.profileTick = 0;
            s.lastProfile = -1;
            s.maskFreq = -1;
            s.profileFreq = Math.max(8, f);
            s.phase = 0;
            s.vPhase = 0;
            s.dPhase = 0.37;
            s.v = 0;
            s.drift = 0;
            s.vDelta = 0;
            s.dDelta = 0;
            s.control = 0;
            s.amplitude = 0;
            s.airAmplitude = 0;
            s.pressure = 0;
            s.vibratoDepth = 0;
            s.transient = 1;
            s.airLow = 0;
            s.airHigh = 0;
            s.rng = (s.seed | 0) || 0x6d2b79f5;
            if (Number.isFinite(s.seed)) {
                s.vPhase = (s.rng >>> 0) / 4294967296;
                s.dPhase = (s.vPhase + 0.37) % 1.0;
            }
        }
        if (s.rate !== sr) {
            s.rate = sr;
            s.invSr = 1 / sr;
            s.profileTick = 0;
            s.lastProfile = -1;
            s.maskFreq = -1;
            s.control = 0;
            s.attackC = 1 - Math.exp(-1 / (0.018 * sr));
            s.airAttackC = 1 - Math.exp(-1 / (0.004 * sr));
            s.pressureC = 1 - Math.exp(-1 / (0.065 * sr));
            s.vibratoC = 1 - Math.exp(-1 / (0.085 * sr));
            s.transientDecay = Math.exp(-1 / (0.050 * sr));
            s.profileC = 1 - Math.exp(-TWO_PI * Math.min(32, sr / 6.0) / sr);
        }
        // Body and air color follow a smoothed pitch at control rate; oscillator pitch stays current.

        s.profileFreq += s.profileC * (Math.max(8, f) - s.profileFreq);
        let profileChanged = false;
        if (s.profileTick === 0) {
            s.profileTick = 64;
            if (Math.abs(s.profileFreq - s.lastProfile) > 0.0001) {
                s.lastProfile = s.profileFreq;
                const register = Math.max(0, Math.min(1, Math.log2(s.profileFreq / 440) / 2.5));
                s.a1 = 1 - 0.22 * register;
                s.a2 = 0.235 + 0.11 * register;
                s.a3 = 0.082 + 0.025 * register;
                s.a4 = 0.031 + 0.009 * register;
                s.a5 = 0.018;
                s.a6 = 0.009;
                s.a7 = 0.005;
                s.a8 = 0.003;
                s.norm = 1 / (s.a1 + s.a2 + s.a3 + s.a4 + s.a5 + s.a6 + s.a7 + s.a8);
                const lowCutoff = Math.min(440 + 0.4 * s.profileFreq, 1400, sr / 6.0);
                const highCutoff = Math.min(3300 + 2.1 * s.profileFreq, 6200, sr / 6.0);
                s.airLowC = 1 - Math.exp(-TWO_PI * lowCutoff / sr);
                s.airHighC = 1 - Math.exp(-TWO_PI * highCutoff / sr);
                profileChanged = true;
            }
        }
        s.profileTick--;
        // Masks follow every external pitch change, including abrupt register jumps.

        if (s.maskFreq !== f || profileChanged) {
            s.maskFreq = f;
            const step = f * 1.012 * s.invSr;
            let edge;
            edge = Math.max(0, Math.min(1, (0.45 - 1 * step) * 10));
            s.audible = edge * edge * (3 - 2 * edge);
            s.w1 = s.a1 * s.norm * s.audible;
            edge = Math.max(0, Math.min(1, (0.45 - 2 * step) * 10));
            s.w2 = s.a2 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 3 * step) * 10));
            s.w3 = s.a3 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 4 * step) * 10));
            s.w4 = s.a4 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 5 * step) * 10));
            s.w5 = s.a5 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 6 * step) * 10));
            s.w6 = s.a6 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 7 * step) * 10));
            s.w7 = s.a7 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 8 * step) * 10));
            s.w8 = s.a8 * s.norm * edge * edge * (3 - 2 * edge);
        }
        if (s.control === 0) {
            const v = Math.sin(TWO_PI * s.vPhase);
            const d = Math.sin(TWO_PI * s.dPhase);
            s.vDelta = (v - s.v) / 64;
            s.dDelta = (d - s.drift) / 64;
            s.control = 64;
            s.vPhase = (s.vPhase + (5.25 + 0.11 * d) * 64 * s.invSr) % 1.0;
            s.dPhase = (s.dPhase + 0.19 * 64 * s.invSr) % 1.0;
        }
        s.v += s.vDelta;
        s.drift += s.dDelta;
        s.control--;
        const amplitude = s.amplitude;
        const airAmplitude = s.airAmplitude;
        s.amplitude += s.attackC * (1 - s.amplitude);
        s.airAmplitude += s.airAttackC * (1 - s.airAmplitude);
        s.pressure += s.pressureC * (1 - s.pressure);
        s.vibratoDepth += s.vibratoC * ((ctx.t > 0.24 ? 1 : 0) - s.vibratoDepth);
        s.transient = s.transient > 1e-8 ? s.transient * s.transientDecay : 0;
        const vibrato = s.v * s.vibratoDepth;
        const motion = 1 + 0.0037 * vibrato + 0.00045 * s.drift - 0.0016 * s.transient;
        s.phase = (s.phase + f * s.invSr * motion) % 1.0;
        // A sine/cosine pair supplies the entire harmonic series by recurrence.

        const h1 = Math.sin(TWO_PI * s.phase);
        const c = 2 * Math.cos(TWO_PI * s.phase);
        const h2 = c * h1;
        const h3 = c * h2 - h1;
        const h4 = c * h3 - h2;
        const h5 = c * h4 - h3;
        const h6 = c * h5 - h4;
        const h7 = c * h6 - h5;
        const h8 = c * h7 - h6;
        const upper = s.w2 * h2 + s.w3 * h3 + s.w4 * h4 + s.w5 * h5
            + s.w6 * h6 + s.w7 * h7 + s.w8 * h8;
        const tone = s.w1 * h1 + (0.72 + 0.28 * s.pressure) * upper;
        s.rng ^= s.rng << 13;
        s.rng ^= s.rng >>> 17;
        s.rng ^= s.rng << 5;
        const noise = s.rng / 2147483648;
        s.airLow += s.airLowC * (noise - s.airLow);
        s.airHigh += s.airHighC * (noise - s.airHigh);
        const breath = (s.airHigh - s.airLow) * (0.85 + 0.15 * h1);
        const air = 0.055 * breath * airAmplitude * (0.55 + 0.45 * s.transient) * s.audible;
        const finalOutput = 0.74 * (tone * amplitude * (0.97 + 0.025 * vibrato) + air);
        return finalOutput;
    },

    // Sixteen formant-weighted oboe partials with a focused reed attack and delayed vibrato.

    "orch-oboe": (ctx) => {
        const s = ctx.state;
        const sr = ctx.sampleRate;
        const f = ctx.freq;
        if (!(sr > 0) || !Number.isFinite(sr) || !(f > 0) || !Number.isFinite(f)) return 0;
        if (f >= sr * 0.5) return 0;
        if (s.oboeReady !== 1) {
            s.oboeReady = 1;
            s.rate = 0;
            s.profileTick = 0;
            s.lastProfile = -1;
            s.maskFreq = -1;
            s.profileFreq = Math.max(8, f);
            s.phase = 0;
            s.vPhase = 0.07;
            s.dPhase = 0.41;
            s.v = 0;
            s.drift = 0;
            s.vDelta = 0;
            s.dDelta = 0;
            s.control = 0;
            s.env = 0;
            s.air = 0;
            s.bloom = 0;
            s.tongue = 1;
            s.noiseLo = 0;
            s.noiseHi = 0;
            s.rng = (s.seed | 0) || 1367130551;
            if (Number.isFinite(s.seed)) {
                s.vPhase = (s.rng >>> 0) / 4294967296;
                s.dPhase = (s.vPhase + 0.41) % 1.0;
            }
        }
        if (s.rate !== sr) {
            s.rate = sr;
            s.invSr = 1 / sr;
            s.profileTick = 0;
            s.lastProfile = -1;
            s.maskFreq = -1;
            s.control = 0;
            s.attackC = 1 - Math.exp(-1 / (0.012 * sr));
            s.airC = 1 - Math.exp(-1 / (0.003 * sr));
            s.bloomC = 1 - Math.exp(-1 / (0.025 * sr));
            s.tongueDecay = Math.exp(-1 / (0.025 * sr));
            s.noiseLoC = 1 - Math.exp(-TWO_PI * Math.min(700, sr / 6.0) / sr);
            s.noiseHiC = 1 - Math.exp(-TWO_PI * Math.min(4300, sr / 6.0) / sr);
            s.profileC = 1 - Math.exp(-TWO_PI * Math.min(32, sr / 6.0) / sr);
        }
        s.profileFreq += s.profileC * (Math.max(8, f) - s.profileFreq);
        let profileChanged = false;
        if (s.profileTick === 0) {
            s.profileTick = 64;
            if (Math.abs(s.profileFreq - s.lastProfile) > 0.0001) {
                s.lastProfile = s.profileFreq;
                let total = 0;
                // Broad hand-voiced spectral peaks; these are not measured instrument responses.

                for (let n = 1; n <= 16; n++) {
                    const hz = n * s.profileFreq;
                    const a = (hz - 1150) / 650;
                    const b = (hz - 2900) / 1200;
                    const rolloff = hz / 5800;
                    const weight = (0.15 + 1.9 / (1 + a * a) + 0.28 / (1 + b * b))
                        * (hz / (hz + 450)) / (n * (1 + rolloff * rolloff));
                    total += weight;
                    switch (n) {
                        case 1:
                            s.a1 = weight;
                            break;
                        case 2:
                            s.a2 = weight;
                            break;
                        case 3:
                            s.a3 = weight;
                            break;
                        case 4:
                            s.a4 = weight;
                            break;
                        case 5:
                            s.a5 = weight;
                            break;
                        case 6:
                            s.a6 = weight;
                            break;
                        case 7:
                            s.a7 = weight;
                            break;
                        case 8:
                            s.a8 = weight;
                            break;
                        case 9:
                            s.a9 = weight;
                            break;
                        case 10:
                            s.a10 = weight;
                            break;
                        case 11:
                            s.a11 = weight;
                            break;
                        case 12:
                            s.a12 = weight;
                            break;
                        case 13:
                            s.a13 = weight;
                            break;
                        case 14:
                            s.a14 = weight;
                            break;
                        case 15:
                            s.a15 = weight;
                            break;
                        case 16:
                            s.a16 = weight;
                            break;
                    }
                }
                s.norm = 1 / total;
                profileChanged = true;
            }
        }
        s.profileTick--;
        // Normalize before the current-pitch taper so near-Nyquist harmonics fade away.

        if (s.maskFreq !== f || profileChanged) {
            s.maskFreq = f;
            const step = f * 1.012 * s.invSr;
            let edge;
            edge = Math.max(0, Math.min(1, (0.45 - 1 * step) * 10));
            s.audible = edge * edge * (3 - 2 * edge);
            s.w1 = s.a1 * s.norm * s.audible;
            edge = Math.max(0, Math.min(1, (0.45 - 2 * step) * 10));
            s.w2 = s.a2 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 3 * step) * 10));
            s.w3 = s.a3 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 4 * step) * 10));
            s.w4 = s.a4 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 5 * step) * 10));
            s.w5 = s.a5 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 6 * step) * 10));
            s.w6 = s.a6 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 7 * step) * 10));
            s.w7 = s.a7 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 8 * step) * 10));
            s.w8 = s.a8 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 9 * step) * 10));
            s.w9 = s.a9 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 10 * step) * 10));
            s.w10 = s.a10 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 11 * step) * 10));
            s.w11 = s.a11 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 12 * step) * 10));
            s.w12 = s.a12 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 13 * step) * 10));
            s.w13 = s.a13 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 14 * step) * 10));
            s.w14 = s.a14 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 15 * step) * 10));
            s.w15 = s.a15 * s.norm * edge * edge * (3 - 2 * edge);
            edge = Math.max(0, Math.min(1, (0.45 - 16 * step) * 10));
            s.w16 = s.a16 * s.norm * edge * edge * (3 - 2 * edge);
        }
        if (s.control === 0) {
            const v = Math.sin(TWO_PI * s.vPhase);
            const d = Math.sin(TWO_PI * s.dPhase);
            s.vDelta = (v - s.v) / 64;
            s.dDelta = (d - s.drift) / 64;
            s.control = 64;
            s.vPhase = (s.vPhase + (5.35 + 0.14 * d) * 64 * s.invSr) % 1.0;
            s.dPhase = (s.dPhase + 0.29 * 64 * s.invSr) % 1.0;
        }
        s.v += s.vDelta;
        s.drift += s.dDelta;
        s.control--;
        const env = s.env;
        const air = s.air;
        s.env += s.attackC * (1 - s.env);
        s.air += s.airC * (1 - s.air);
        s.bloom += s.bloomC * (1 - s.bloom);
        s.tongue = s.tongue > 1e-8 ? s.tongue * s.tongueDecay : 0;
        let depth = Math.max(0, Math.min(1, (ctx.t - 0.22) / 0.40));
        depth *= depth * (3 - 2 * depth);
        const motion = 1 + depth * (0.0045 * s.v + 0.0003 * s.drift) + 0.0015 * s.tongue;
        s.phase = (s.phase + f * s.invSr * motion) % 1.0;
        const h1 = Math.sin(TWO_PI * s.phase);
        const c = 2 * Math.cos(TWO_PI * s.phase);
        const h2 = c * h1;
        const h3 = c * h2 - h1;
        const h4 = c * h3 - h2;
        const h5 = c * h4 - h3;
        const h6 = c * h5 - h4;
        const h7 = c * h6 - h5;
        const h8 = c * h7 - h6;
        const h9 = c * h8 - h7;
        const h10 = c * h9 - h8;
        const h11 = c * h10 - h9;
        const h12 = c * h11 - h10;
        const h13 = c * h12 - h11;
        const h14 = c * h13 - h12;
        const h15 = c * h14 - h13;
        const h16 = c * h15 - h14;
        const low = s.w1 * h1 + s.w2 * h2;
        const upper = s.w3 * h3 + s.w4 * h4 + s.w5 * h5 + s.w6 * h6
            + s.w7 * h7 + s.w8 * h8 + s.w9 * h9 + s.w10 * h10 + s.w11 * h11
            + s.w12 * h12 + s.w13 * h13 + s.w14 * h14 + s.w15 * h15 + s.w16 * h16;
        const tone = low + (0.65 + 0.35 * s.bloom) * upper;
        s.rng ^= s.rng << 13;
        s.rng ^= s.rng >>> 17;
        s.rng ^= s.rng << 5;
        const white = s.rng / 2147483648;
        s.noiseLo += s.noiseLoC * (white - s.noiseLo);
        s.noiseHi += s.noiseHiC * (white - s.noiseHi);
        const reedNoise = 0.5 * (s.noiseHi - s.noiseLo);
        const tremolo = 1 - 0.010 * depth + 0.010 * depth * s.v;
        const finalOutput = 0.82 * env * tremolo * tone
            + air * (0.012 + 0.068 * s.tongue) * reedNoise * s.audible;
        return finalOutput;
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
        // Sine pitch fall, briefly emphasized low harmonics, and a muted bandpassed beater; smooth weighted DC removal and a 0.76 peak.
        "dark-thud": () => {
            const buffer = createBuffer(0.46);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const sr = sampleRate;
            const end = (data.length - 1) / sr;
            const weights = new Float64Array(data.length);
            const smooth = x => {
                x = Math.max(0, Math.min(1, x));
                return x * x * (3 - 2 * x);
            };
            const fastA = 1 - Math.exp(-TWO_PI * Math.min(1450, sr * 0.22) / sr);
            const slowA = 1 - Math.exp(-TWO_PI * 180 / sr);
            const noiseScale = Math.sqrt(sr / 44100);
            let seed = (0x6D2B79F5 ^ Motif._sampleSeed) || 1;
            let phase = 0;
            let fast = 0;
            let slow = 0;
            let sum = 0;
            let weightSum = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = ((seed >>> 0) / 2147483648 - 1) * noiseScale;
                fast += fastA * (noise - fast);
                slow += slowA * (noise - slow);
                const freq = 48 + 92 * Math.exp(-t / 0.010) + 20 * Math.exp(-t / 0.040);
                phase += freq / sr;
                phase -= Math.floor(phase);
                const angle = TWO_PI * phase;
                const body = Math.sin(angle)
                    + 0.17 * Math.sin(2 * angle) * Math.exp(-t / 0.045)
                    + 0.035 * Math.sin(3 * angle) * Math.exp(-t / 0.020);
                const beater = 0.14 * (fast - slow) * Math.exp(-t / 0.008);
                const weight = Math.exp(-t / 0.110) * smooth(t / 0.002) * smooth((end - t) / 0.035);
                weights[i] = weight;
                data[i] = (body + beater) * weight;
                sum += data[i];
                weightSum += weight;
            }

            // Subtract through the same envelope: silence and the smooth endpoints stay silent.
            const dc = weightSum > 0 ? sum / weightSum : 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                data[i] -= dc * weights[i];
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.76 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },


        // Two falling sine shell modes under filtered seeded noise; a rounded 40 ms gate closes the dry tail, with a 0.58 peak.
        "dark-gated-snare": () => {
            const buffer = createBuffer(0.22);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const sr = sampleRate;
            const weights = new Float64Array(data.length);
            const smooth = x => {
                x = Math.max(0, Math.min(1, x));
                return x * x * (3 - 2 * x);
            };
            const hpA = 1 - Math.exp(-TWO_PI * Math.min(650, sr * 0.10) / sr);
            const lpA = 1 - Math.exp(-TWO_PI * Math.min(4400, sr * 0.30) / sr);
            const noiseScale = Math.sqrt(sr / 44100);
            let seed = (0xA341316C ^ Motif._sampleSeed) || 1;
            let phase1 = 0;
            let phase2 = 0;
            let low = 0;
            let lp1 = 0;
            let lp2 = 0;
            let sum = 0;
            let weightSum = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = ((seed >>> 0) / 2147483648 - 1) * noiseScale;
                low += hpA * (noise - low);
                lp1 += lpA * (noise - low - lp1);
                lp2 += lpA * (lp1 - lp2);
                const fall = Math.exp(-t / 0.012);
                phase1 += (174 + 42 * fall) / sr;
                phase2 += (311 + 37 * fall) / sr;
                phase1 -= Math.floor(phase1);
                phase2 -= Math.floor(phase2);
                const body = (0.34 * Math.sin(TWO_PI * phase1) + 0.16 * Math.sin(TWO_PI * phase2))
                    * Math.exp(-t / 0.035);
                const wire = 0.82 * lp2 * Math.exp(-t / 0.068);
                const edge = smooth(t / 0.0008) * smooth((0.200 - t) / 0.040);
                const weight = Math.exp(-t / 0.068) * edge;
                weights[i] = weight;
                data[i] = (body + wire) * edge;
                sum += data[i];
                weightSum += weight;
            }
            const dc = weightSum > 0 ? sum / weightSum : 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                data[i] -= dc * weights[i];
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.58 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },


        // Nyquist-limited inharmonic sine modes plus softly bandpassed noise; short exponential damping gives a dark metallic tick at a 0.29 peak.
        "dark-shadow-hat": () => {
            const buffer = createBuffer(0.145);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const sr = sampleRate;
            const end = (data.length - 1) / sr;
            const weights = new Float64Array(data.length);
            const smooth = x => {
                x = Math.max(0, Math.min(1, x));
                return x * x * (3 - 2 * x);
            };
            const freqs = [1379, 1847, 2389, 2837, 3491, 4271, 5231, 6299, 7541, 8819];
            const phases = new Float64Array(freqs.length);
            const amps = new Float64Array(freqs.length);
            let seed = (0xC8013EA4 ^ Motif._sampleSeed) || 1;
            let ampSum = 0;
            for (let k = 0; k < freqs.length; k++) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                phases[k] = (seed >>> 0) / 4294967296;

                // Modes fade out between 0.35 and 0.43 times the sample rate; never fold them down.
                amps[k] = Math.sqrt(1379 / freqs[k]) * smooth((0.43 * sr - freqs[k]) / (0.08 * sr));
                ampSum += amps[k];
            }
            const modeGain = ampSum > 0 ? 0.78 / ampSum : 0;
            const hpA = 1 - Math.exp(-TWO_PI * Math.min(1200, sr * 0.15) / sr);
            const lpA = 1 - Math.exp(-TWO_PI * Math.min(6200, sr * 0.32) / sr);
            const noiseScale = Math.sqrt(sr / 44100);
            let low = 0;
            let top = 0;
            let sum = 0;
            let weightSum = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let metal = 0;
                for (let k = 0; k < freqs.length; k++) {
                    if (amps[k] === 0) continue;
                    phases[k] += freqs[k] / sr;
                    phases[k] -= Math.floor(phases[k]);
                    metal += amps[k] * Math.sin(TWO_PI * phases[k]) * Math.exp(-t * freqs[k] / 360);
                }
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = ((seed >>> 0) / 2147483648 - 1) * noiseScale;
                const raw = metal * modeGain + 0.22 * noise;
                low += hpA * (raw - low);
                top += lpA * (raw - low - top);
                const weight = Math.exp(-t / 0.027) * smooth(t / 0.0005) * smooth((end - t) / 0.025);
                weights[i] = weight;
                data[i] = top * weight;
                sum += data[i];
                weightSum += weight;
            }
            const dc = weightSum > 0 ? sum / weightSum : 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                data[i] -= dc * weights[i];
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.29 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },


        // Inharmonic glass modes and an opening filtered-noise breath rise through a curved envelope; a 45 ms rounded exit ends at silence, with a 0.42 peak.
        "dark-reverse-glass": () => {
            const buffer = createBuffer(1.20);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const sr = sampleRate;
            const end = (data.length - 1) / sr;
            const weights = new Float64Array(data.length);
            const smooth = x => {
                x = Math.max(0, Math.min(1, x));
                return x * x * (3 - 2 * x);
            };
            const freqs = [440, 617, 997, 1591, 2477, 3851, 5923];
            const phases = new Float64Array(freqs.length);
            const amps = new Float64Array(freqs.length);
            let seed = (0xAD90777D ^ Motif._sampleSeed) || 1;
            let ampSum = 0;
            for (let k = 0; k < freqs.length; k++) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                phases[k] = (seed >>> 0) / 4294967296;
                amps[k] = Math.pow(440 / freqs[k], 0.45) * smooth((0.43 * sr - freqs[k]) / (0.08 * sr));
                ampSum += amps[k];
            }
            const modeGain = ampSum > 0 ? 0.82 / ampSum : 0;
            const hpA = 1 - Math.exp(-TWO_PI * 420 / sr);
            const noiseScale = Math.sqrt(sr / 44100);
            let low = 0;
            let air1 = 0;
            let air2 = 0;
            let sum = 0;
            let weightSum = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const progress = i / (data.length - 1);
                let glass = 0;
                for (let k = 0; k < freqs.length; k++) {
                    if (amps[k] === 0) continue;
                    phases[k] += freqs[k] / sr;
                    phases[k] -= Math.floor(phases[k]);
                    const brightness = 0.25 + 0.75 * Math.pow(progress, 0.35 + freqs[k] / 4000);
                    glass += amps[k] * brightness * Math.sin(TWO_PI * phases[k]);
                }
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = ((seed >>> 0) / 2147483648 - 1) * noiseScale;
                low += hpA * (noise - low);
                const cutoff = Math.min(750 + 3400 * progress * progress, sr * 0.30);
                const lpA = 1 - Math.exp(-TWO_PI * cutoff / sr);
                air1 += lpA * (noise - low - air1);
                air2 += lpA * (air1 - air2);
                const weight = Math.pow(progress, 2.5) * smooth(t / 0.025) * smooth((end - t) / 0.045);
                weights[i] = weight;
                data[i] = (glass * modeGain + 0.32 * air2) * weight;
                sum += data[i];
                weightSum += weight;
            }
            const dc = weightSum > 0 ? sum / weightSum : 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                data[i] -= dc * weights[i];
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.42 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },

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
            const rand = mulberry32(0x9E3779B1 ^ Motif._sampleSeed);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const tone = Math.sin(TWO_PI * 220 * t) + Math.sin(TWO_PI * 340 * t);
                const noise = rand() * 2 - 1;

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

        // Six square oscillators at the classic 808 inharmonic frequencies plus white noise, double high-passed and gently low-passed for a bright sustained open-hat sizzle
        "hihat-open": () => {
            const buffer = createBuffer(0.7);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
            const dt = 1 / sampleRate;
            const hpRC = 1 / (TWO_PI * 7000);
            const hpA = hpRC / (hpRC + dt);
            const lpRC = 1 / (TWO_PI * 11000);
            const lpA = dt / (lpRC + dt);
            const dur = data.length / sampleRate;
            const rand = mulberry32(0x85EBCA77 ^ Motif._sampleSeed);
            let hp1x = 0, hp1y = 0, hp2x = 0, hp2y = 0, lpY = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let osc = 0;
                for (let k = 0; k < freqs.length; k++) {
                    osc += Math.sin(TWO_PI * freqs[k] * t) >= 0 ? 1 : -1;
                }
                osc /= freqs.length;
                const noise = rand() * 2 - 1;
                // Slow body decay plus a fast transient snap for the stick attack
                const env = Math.exp(-9 * t);
                const snap = Math.exp(-60 * t);
                const attack = Math.min(1, i / 8);
                const x = (osc * (env + 0.4 * snap) + noise * (0.7 * env + 0.5 * snap)) * attack;
                // Two-stage one-pole high-pass strips lows and DC, one-pole low-pass tames the extreme top
                hp1y = hpA * (hp1y + x - hp1x);
                hp1x = x;
                hp2y = hpA * (hp2y + hp1y - hp2x);
                hp2x = hp1y;
                lpY += lpA * (hp2y - lpY);
                // Short linear fade guarantees a silent tail
                const fade = Math.min(1, (dur - t) / 0.01);
                data[i] = lpY * 0.55 * fade;
            }
            return buffer;
        },

        // Same 808-style metallic square bank with heavier noise, single darker high-pass and lower low-pass, fast decay for the dull foot-chick between closed and open
        "hihat-pedal": () => {
            const buffer = createBuffer(0.13);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
            const dt = 1 / sampleRate;
            const hpRC = 1 / (TWO_PI * 4500);
            const hpA = hpRC / (hpRC + dt);
            const lpRC = 1 / (TWO_PI * 6500);
            const lpA = dt / (lpRC + dt);
            const dur = data.length / sampleRate;
            const rand = mulberry32(0xC2B2AE3D ^ Motif._sampleSeed);
            let hpX = 0, hpY = 0, lpY = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let osc = 0;
                for (let k = 0; k < freqs.length; k++) {
                    osc += Math.sin(TWO_PI * freqs[k] * t) >= 0 ? 1 : -1;
                }
                osc /= freqs.length;
                const noise = rand() * 2 - 1;
                // Fast body decay with an even faster chick transient on top
                const env = Math.exp(-40 * t);
                const snap = Math.exp(-150 * t);
                const attack = Math.min(1, i / 6);
                const x = (osc * (0.7 * env + 0.3 * snap) + noise * (0.9 * env + 0.3 * snap)) * attack;
                // One-pole high-pass removes DC and body, low-pass dulls the top for the muted pedal character
                hpY = hpA * (hpY + x - hpX);
                hpX = x;
                lpY += lpA * (hpY - lpY);
                // Short linear fade guarantees a silent tail
                const fade = Math.min(1, (dur - t) / 0.008);
                data[i] = lpY * 0.55 * fade;
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

        // Additive bank of 48 log-spaced inharmonic partials plus differentiated noise burst, exponential per-partial decay; explosive bright crash with long shimmering tail
        "cymbal-crash": () => {
            const buffer = createBuffer(2.2);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);

            const rand = mulberry32(0x428A2F98 ^ Motif._sampleSeed);

            // Inharmonic partials: log-distributed 400 Hz .. 14 kHz, random phases,
            // gentle spectral tilt, faster decay for higher partials
            const PARTIALS = 48;
            const freqs = new Float64Array(PARTIALS);
            const amps = new Float64Array(PARTIALS);
            const decays = new Float64Array(PARTIALS);
            const phases = new Float64Array(PARTIALS);
            const nyquistCap = sampleRate * 0.45;
            let ampSum = 0;
            for (let p = 0; p < PARTIALS; p++) {
                let f = 400 * Math.pow(35, rand());
                if (f > nyquistCap) f = nyquistCap * (0.6 + 0.4 * rand());
                freqs[p] = f;
                amps[p] = Math.pow(400 / f, 0.25);
                decays[p] = 2.5 + f / 2500;
                phases[p] = rand() * TWO_PI;
                ampSum += amps[p];
            }
            const partialScale = 0.6 / ampSum;

            // One-pole leaky high-pass state kills DC drift from dense summation
            let hpPrevIn = 0;
            let hpPrevOut = 0;
            let noisePrev = 0;
            const fadeSamples = 256;
            const fadeStart = data.length - fadeSamples;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                let partials = 0;
                for (let p = 0; p < PARTIALS; p++) {
                    partials += amps[p] * Math.exp(-decays[p] * t) * Math.sin(TWO_PI * freqs[p] * t + phases[p]);
                }
                partials *= partialScale;

                // First-difference noise: high-passed sizzle for the attack plus a softer wash
                const white = rand() * 2 - 1;
                const brightNoise = white - noisePrev;
                noisePrev = white;
                const noise = brightNoise * (0.3 * Math.exp(-9 * t) + 0.08 * Math.exp(-3 * t));

                let out = partials + noise;
                hpPrevOut = out - hpPrevIn + 0.995 * hpPrevOut;
                hpPrevIn = out;
                out = hpPrevOut;

                // Few-sample attack ramp and short terminal fade guarantee click-free edges
                if (i < 32) out *= i / 32;
                if (i >= fadeStart) out *= (data.length - 1 - i) / fadeSamples;
                data[i] = out * 0.9;
            }
            return buffer;
        },

        // Same inharmonic partial bank driven by a cubic swell and an opening one-pole low-pass, then a 6 ms terminal fade to exactly zero; reverse-cymbal riser from silence to bright peak
        "cymbal-reverse": () => {
            const buffer = createBuffer(1.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);

            const rand = mulberry32(0x71374491 ^ Motif._sampleSeed);

            const PARTIALS = 40;
            const freqs = new Float64Array(PARTIALS);
            const amps = new Float64Array(PARTIALS);
            const phases = new Float64Array(PARTIALS);
            const nyquistCap = sampleRate * 0.45;
            let ampSum = 0;
            for (let p = 0; p < PARTIALS; p++) {
                let f = 350 * Math.pow(34, rand());
                if (f > nyquistCap) f = nyquistCap * (0.6 + 0.4 * rand());
                freqs[p] = f;
                amps[p] = Math.pow(350 / f, 0.2);
                phases[p] = rand() * TWO_PI;
                ampSum += amps[p];
            }
            const partialScale = 0.55 / ampSum;

            // Peak sits right before a very fast final fade so the buffer ends at exactly 0.0
            const fadeSamples = Math.max(1, Math.round(sampleRate * 0.006));
            const riseSamples = data.length - fadeSamples;
            let lpState = 0;
            let hpPrevIn = 0;
            let hpPrevOut = 0;
            let noisePrev = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const progress = Math.min(1, i / riseSamples);
                const swell = progress * progress * progress;

                let partials = 0;
                for (let p = 0; p < PARTIALS; p++) {
                    partials += amps[p] * Math.sin(TWO_PI * freqs[p] * t + phases[p]);
                }
                partials *= partialScale;

                const white = rand() * 2 - 1;
                const brightNoise = white - noisePrev;
                noisePrev = white;
                const noise = brightNoise * 0.35 * progress * progress;

                // Time-varying one-pole low-pass opens with the swell: dark rumble grows into bright shimmer
                const lpCoef = 0.05 + 0.85 * progress;
                lpState += lpCoef * (partials + noise - lpState);

                let out = lpState * swell;
                hpPrevOut = out - hpPrevIn + 0.995 * hpPrevOut;
                hpPrevIn = out;
                out = hpPrevOut;

                if (i >= riseSamples) out *= (data.length - 1 - i) / fadeSamples;
                data[i] = out * 0.9;
            }
            return buffer;
        },

        // A very soft, filtered noise sweep, like sand or a gentle shaker
        "shaker-soft": () => {
            const buffer = createBuffer(0.25);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0x27D4EB2F ^ Motif._sampleSeed);
            let b0 = 0; // Filter state

            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = rand() * 2 - 1;

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
            const rand = mulberry32(0x165667B1 ^ Motif._sampleSeed);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = rand() * 2 - 1;
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

        // 'Micro Snare': Extremely short, high-passed snare.
        // Staple of IDM and fast breakbeats.
        "snare-micro": () => {
            // Only 100ms
            const buffer = createBuffer(0.1);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0xD3A2646C ^ Motif._sampleSeed);
            let b0 = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = rand() * 2 - 1;

                // Highpass filter at 2000Hz
                const cutoff = 2000 / sampleRate;
                b0 += cutoff * (noise - b0);
                const hp = noise - b0;

                // FM click at the start
                const click = Math.sin(TWO_PI * 1500 * t) * Math.exp(-t * 250);
                data[i] = (hp * 0.8 + click) * Math.exp(-t * 40);
            }
            return buffer;
        },

        // 'Analog Cowbell': Classic TR-808 style cowbell.
        // Uses two detuned square waves through a bandpass filter.
        "cowbell-808": () => {
            const buffer = createBuffer(0.4);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let low = 0;
            let band = 0;

            // 800Hz filter cutoff
            const f = 2.0 * Math.sin(Math.PI * 800 / sampleRate);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // 540Hz and 800Hz square waves
                const sq1 = Math.sin(TWO_PI * 540 * t) > 0 ? 1 : -1;
                const sq2 = Math.sin(TWO_PI * 800 * t) > 0 ? 1 : -1;
                const raw = (sq1 + sq2) * 0.5;

                // SVF Bandpass
                const high = raw - low - (0.5 * band);
                band += f * high;
                low += f * band;
                data[i] = band * Math.exp(-t * 12);
            }
            return buffer;
        },

        // 'Perc Stutter': A randomized digital burst, mimicking a skipping CD.
        "perc-stutter": () => {
            const buffer = createBuffer(0.4);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0xFD7046C5 ^ Motif._sampleSeed);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const noise = rand() * 2 - 1;

                // Amplitude is multiplied by a square LFO that speeds up exponentially
                const lfoSpeed = 10 + Math.exp(t * 8);
                const stutter = Math.sin(TWO_PI * lfoSpeed * t) > 0 ? 1 : 0;
                data[i] = noise * stutter * Math.exp(-t * 5);
            }
            return buffer;
        },

        // 'Deep Impact': A massive cinematic sub-drop for boss arrivals or heavy events.
        "impact-deep": () => {
            const buffer = createBuffer(3.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0xB55A4F09 ^ Motif._sampleSeed);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Pitch drops from 150Hz down to a rumbling 30Hz
                const freq = 30 + 120 * Math.exp(-t * 3);
                phase += freq / sampleRate;
                const sub = Math.sin(TWO_PI * phase);
                const noise = (rand() * 2 - 1) * Math.exp(-t * 6) * 0.1;

                // Saturate the sub heavily at the beginning, smooth out later
                const drive = 1.0 + Math.exp(-t * 2) * 4.0;
                data[i] = Math.tanh((sub + noise) * drive) * Math.exp(-t * 1.5) * 0.8;
            }
            return buffer;
        },

        // 'Ghost Break Snare': A hyper-compressed, metallic snare designed to be chopped at 200 BPM.
        // Has a distinct resonant ping characteristic of processed breakbeats.
        "break-snare-ghost": () => {
            const buffer = createBuffer(0.2);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0x1B873593 ^ Motif._sampleSeed);
            let b0 = 0;
            let b1 = 0;

            // High-pass filter math to remove the mud
            const cutoff = 800 / sampleRate;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // The ping representing a tight snare skin
                const ping = Math.sin(TWO_PI * 380 * t) * Math.exp(-t * 40.0);

                // The rattle representing white noise
                const noise = (rand() * 2.0 - 1.0);

                // Filter the noise to make it sharp and thin
                b0 += cutoff * (noise - b0);
                b1 += cutoff * (b0 - b1);
                const hpNoise = (noise - b1) * Math.exp(-t * 25.0);

                // Mix and apply hyper-compression
                const mix = (ping * 1.5) + (hpNoise * 1.5);
                data[i] = Math.tanh(mix) * 0.7;
            }
            return buffer;
        },

        // 'Data Burst': A chaotic, localized glitch effect.
        // Sounds like a machine attempting to read a scratched CD-ROM.
        "glitch-data-burst": () => {
            const buffer = createBuffer(0.3);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Frequency jumps between massive extremes rapidly
                // 60 steps per second
                const stepTime = Math.floor(t * 60.0);

                // Pseudo-random frequency jumping
                const freq = 100 + ((stepTime * 853) % 2000);
                phase += freq / sampleRate;

                // Square wave generator
                const sq = Math.sin(TWO_PI * phase) > 0 ? 1.0 : -1.0;

                // Harsh gating envelope to make it stutter
                const gate = Math.sin(TWO_PI * 30 * t) > 0 ? 1.0 : 0.0;
                data[i] = sq * gate * Math.exp(-t * 10.0) * 0.5;
            }
            return buffer;
        },

        // 'Sub Boom': The classic cinematic / ambient transition impact.
        // A massive, 3-second long pure sub-bass drop that rattles the floor.
        "sub-boom": () => {
            const buffer = createBuffer(3.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Pitch starts at 90Hz and quickly drops and settles at a rumbling 40Hz
                const freq = 40 + (50 * Math.exp(-t * 4.0));
                phase += freq / sampleRate;

                // Pure, floor-shaking sine wave
                const sub = Math.sin(TWO_PI * phase);

                // Gentle saturation to ensure it translates on smaller speakers
                const saturated = Math.tanh(sub * 1.5);

                // Long decay ensuring it reaches absolute zero by 3 seconds
                const env = Math.exp(-t * 2.5);
                data[i] = saturated * env;
            }
            return buffer;
        },

        // FM kick drum. Uses an exponential pitch drop and a subtracted amplitude envelope to ensure an exact zero-crossing finish.
        "chip-kick-laser": () => {
            const duration = 0.6;
            const buffer = createBuffer(duration);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Exponential pitch envelope from approximately 900Hz down to 45Hz
                const currentFreq = 45.0 + 855.0 * Math.exp(-t * 35.0);
                phase += currentFreq / sampleRate;
                phase %= 1.0;

                // Envelope calculation: Subtract the exact value at the end of the tail to force the amplitude to exactly 0.0 at the final sample.
                let amp = Math.exp(-t * 6.0) - Math.exp(-duration * 6.0);
                if (amp < 0) {
                    amp = 0;
                }

                // Fast phase modulation at the start for transient articulation
                const transientFM = Math.exp(-t * 80.0) * Math.sin(phase * TWO_PI * 2.0);
                data[i] = Math.tanh(Math.sin(phase * TWO_PI + transientFM) * amp * 1.2);
            }
            return buffer;
        },

        // Synthesized snare. Tightly filtered white noise burst layered over a pitched sine body, utilizing a downward sweeping SVF.
        "chip-snare-burst": () => {
            const duration = 0.4;
            const buffer = createBuffer(duration);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0xCC9E2D51 ^ Motif._sampleSeed);

            // Flat SVF state variables
            let lp = 0;
            let bp = 0;
            let phaseBody = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Tonal Body
                const bodyFreq = 180 + 120 * Math.exp(-t * 40.0);
                phaseBody = (phaseBody + bodyFreq / sampleRate) % 1.0;

                // Additive approximation of a triangle wave using two odd harmonics
                const bodyWave = Math.sin(phaseBody * TWO_PI) - 0.11 * Math.sin(3 * phaseBody * TWO_PI);
                let bodyAmp = Math.exp(-t * 12.0) - Math.exp(-duration * 12.0);
                if (bodyAmp < 0) {
                    bodyAmp = 0;
                }
                const bodyOut = bodyWave * bodyAmp;

                // Noise Burst
                const noise = (rand() * 2.0 - 1.0);
                let noiseAmp = Math.exp(-t * 8.0) - Math.exp(-duration * 8.0);
                if (noiseAmp < 0) {
                    noiseAmp = 0;
                }

                // SVF Bandpass frequency envelope
                const cutoffFreq = 1000 + 6000 * Math.exp(-t * 25.0);

                // Clamp SVF cutoff to sampleRate / 6.0 to prevent filter instability
                const safeCutoff = Math.min(cutoffFreq, sampleRate / 6.0);

                // SVF calculation (Bandpass isolates frequency and removes DC offset from noise)
                const q = 0.8;
                const f = 2.0 * Math.sin((Math.PI * safeCutoff) / sampleRate);
                lp = lp + f * bp;
                const hp = noise - lp - q * bp;
                bp = bp + f * hp;
                const noiseOut = bp * noiseAmp;

                // Sum, scale the mix, and apply soft-clipping
                data[i] = Math.tanh((bodyOut * 0.8 + noiseOut * 1.5) * 0.7);
            }
            return buffer;
        },

        // A deep, smooth gravitational hum. Uses a slow 3Hz FM wobble and a symmetrical sine-window envelope to guarantee zero clicking and zero DC offset.
        "gravitational-ripple": () => {
            const buffer = createBuffer(4.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            let lfoPhase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Symmetrical zero-crossing envelope: half-sine wave covering the exact duration
                const env = Math.sin((i / data.length) * Math.PI);

                // 3Hz slow wobble that fades out smoothly over time
                const fmEnv = Math.exp(-t * 1.0);
                lfoPhase += 3.0 / sampleRate;
                const mod = Math.sin(lfoPhase * TWO_PI) * 12.0 * fmEnv;

                // Deep fundamental tone at approximately 55Hz
                phase += (55.0 + mod) / sampleRate;
                const wave = Math.sin(phase * TWO_PI);
                data[i] = wave * env * 0.8;
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
            const rand = mulberry32(0x7FEB352D ^ Motif._sampleSeed);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const freq = 55 + 60 * Math.exp(-t * 15); // Subtle pitch drop
                phase += freq / sampleRate;

                // Muffled resonance + click of the beater hitting the skin
                const body = Math.sin(TWO_PI * phase);
                const beater = (rand() * 2 - 1) * Math.exp(-t * 200) * 0.1;

                data[i] = (body + beater) * Math.exp(-t * 8);
            }
            return buffer;
        },

        // Two detuned shell modes with fast downward pitch settle plus bandpassed snare-wire noise; dry, punchy acoustic snare
        "snare-acoustic": () => {
            const buffer = createBuffer(0.32);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const duration = data.length / sampleRate;

            // TPT integration keeps the resonant bandpass stable at low sample rates.

            const cutoff = Math.min(3800, sampleRate * 0.4);
            const svfG = Math.tan(Math.PI * cutoff / sampleRate);
            const svfDamp = 1 / 1.1;
            const svfA = 1 / (1 + svfG * (svfG + svfDamp));
            const rand = mulberry32(0x846CA68B ^ Motif._sampleSeed);
            let phase1 = 0;
            let phase2 = 0;
            let low = 0;
            let band = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                // Shell modes strike sharp and settle to pitch within ~10 ms
                const settle = 1 + 0.5 * Math.exp(-t / 0.007);
                phase1 += TWO_PI * 192 * settle / sampleRate;
                phase2 += TWO_PI * 331 * settle / sampleRate;
                const body = Math.sin(phase1) * Math.exp(-t / 0.085) * 0.62
                    + Math.sin(phase2) * Math.exp(-t / 0.05) * 0.34;
                // State-variable bandpass around 3.8 kHz shapes white noise into the wire rattle, decaying faster than the shell
                const excite = (rand() * 2 - 1) * Math.exp(-t / 0.042);
                const bandOutput = svfA * (band + svfG * (excite - low));
                const lowOutput = low + svfG * bandOutput;
                band = 2 * bandOutput - band;
                low = 2 * lowOutput - low;
                const attack = Math.min(1, t / 0.0015);
                const fade = Math.min(1, (duration - t) / 0.008);
                data[i] = (body + bandOutput * 0.45) * 0.5 * attack * fade;
            }
            return buffer;
        },

        // Cluster of inharmonic 5-9 kHz ring-mode partials with staggered onsets over highpassed noise; bright short jingle hit
        "tambourine": () => {
            const buffer = createBuffer(0.28);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const duration = data.length / sampleRate;
            const freqs = [5087, 5423, 5811, 6178, 6544, 6931, 7302, 7715, 8156, 8542, 8967, 9311];
            const onsets = [0, 0.0016, 0.0031, 0.0009, 0.0048, 0.0024, 0.0067, 0.0041, 0.0083, 0.0058, 0.0102, 0.0075];
            const taus = [0.09, 0.065, 0.078, 0.055, 0.083, 0.06, 0.072, 0.05, 0.068, 0.047, 0.058, 0.044];
            const amps = [1, 0.85, 0.9, 0.7, 0.8, 0.65, 0.75, 0.55, 0.6, 0.5, 0.45, 0.4];
            let ampSum = 0;
            for (let p = 0; p < amps.length; p++) {
                ampSum += amps[p];
            }
            const partialGain = 0.72 / ampSum;
            const rand = mulberry32(0x2545F491 ^ Motif._sampleSeed);
            let hp = 0;
            let prevNoise = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let jingles = 0;
                for (let p = 0; p < freqs.length; p++) {
                    const tl = t - onsets[p];
                    if (tl < 0) continue;
                    // Each partial gets its own onset, decay, and soft sub-ms attack to mimic separate jingles landing
                    const env = Math.exp(-tl / taus[p]) * (1 - Math.exp(-tl / 0.0007));
                    jingles += Math.sin(TWO_PI * freqs[p] * tl) * amps[p] * env;
                }
                // One-pole highpass keeps the noise as sizzle above the cluster and blocks DC
                const noise = (rand() * 2 - 1) * Math.exp(-t / 0.025) * Math.min(1, t / 0.002);
                hp = 0.62 * (hp + noise - prevNoise);
                prevNoise = noise;
                const fade = Math.min(1, (duration - t) / 0.008);
                data[i] = (jingles * partialGain + hp * 0.18) * fade;
            }
            return buffer;
        },

        // Phase-accumulated 205 Hz membrane fundamental with fast downward pitch settle, two inharmonic overtones (1.5x, 2.2x) on shorter decays, plus a low-passed slap noise burst in the first 10 ms; warm woody open conga tone
        "conga": () => {
            const buffer = createBuffer(0.4);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const duration = data.length / sampleRate;
            const baseFreq = 205;
            const rand = mulberry32(0x9E3779B9 ^ Motif._sampleSeed);
            let phase1 = 0;
            let phase2 = 0;
            let phase3 = 0;
            let noiseLP = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // struck head starts sharp and settles down to pitch within ~15 ms
                const glide = 1 + 0.14 * Math.exp(-t / 0.012);
                const f = baseFreq * glide;
                phase1 += TWO_PI * f / sampleRate;
                phase2 += TWO_PI * f * 1.5 / sampleRate;
                phase3 += TWO_PI * f * 2.2 / sampleRate;

                const fundamental = Math.sin(phase1) * Math.exp(-t / 0.11);
                const mode2 = Math.sin(phase2) * Math.exp(-t / 0.05) * 0.45;
                const mode3 = Math.sin(phase3) * Math.exp(-t / 0.028) * 0.28;

                // one-pole low-passed noise keeps the slap dark and skin-like, gone by ~10 ms
                noiseLP += 0.25 * ((rand() * 2 - 1) - noiseLP);
                const slap = noiseLP * Math.exp(-t / 0.004) * 0.9;

                const attack = Math.min(1, t / 0.0015);
                const fadeOut = Math.min(1, (duration - t) / 0.03);
                data[i] = (fundamental + mode2 + mode3 + slap) * attack * fadeOut * 0.45;
            }
            return buffer;
        },

        // Same modal recipe a register up: 470 Hz fundamental with quick pitch settle, inharmonic 1.5x/2.2x overtones on tight decays, and a high-passed skin snap transient; dry bright bongo pop
        "bongo": () => {
            const buffer = createBuffer(0.2);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const duration = data.length / sampleRate;
            const baseFreq = 470;
            const rand = mulberry32(0x6C078965 ^ Motif._sampleSeed);
            let phase1 = 0;
            let phase2 = 0;
            let phase3 = 0;
            let noiseLP = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // tighter head, shorter pitch settle than the conga
                const glide = 1 + 0.12 * Math.exp(-t / 0.008);
                const f = baseFreq * glide;
                phase1 += TWO_PI * f / sampleRate;
                phase2 += TWO_PI * f * 1.5 / sampleRate;
                phase3 += TWO_PI * f * 2.2 / sampleRate;

                const fundamental = Math.sin(phase1) * Math.exp(-t / 0.045);
                const mode2 = Math.sin(phase2) * Math.exp(-t / 0.022) * 0.5;
                const mode3 = Math.sin(phase3) * Math.exp(-t / 0.012) * 0.3;

                // high-passed noise (white minus its low-passed self) makes the snap bright
                const white = rand() * 2 - 1;
                noiseLP += 0.35 * (white - noiseLP);
                const snap = (white - noiseLP) * Math.exp(-t / 0.003) * 0.8;

                const attack = Math.min(1, t / 0.001);
                const fadeOut = Math.min(1, (duration - t) / 0.015);
                data[i] = (fundamental + mode2 + mode3 + snap) * attack * fadeOut * 0.45;
            }
            return buffer;
        },

        // Standard Kalimba pluck. Bright transient, pure resonant body.
        "kalimba-pluck": () => {
            const buffer = createBuffer(0.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0x5BD1E995 ^ Motif._sampleSeed);
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                const click = rand() * Math.exp(-t * 400) * 0.15; // Tine pluck
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

        // Additive inharmonic cantilever tine model: four beam-mode partials with a gear-pluck transient
        "music-box": () => {
            const buffer = createBuffer(0.9);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const f0 = 1046.5; // C6 — classic high music-box register
            const rand = mulberry32(0xA24BAED4 ^ Motif._sampleSeed);
            let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Sub-millisecond broadband gear-tooth pluck transient
                const click = (rand() * 2 - 1) * Math.exp(-t * 3000) * 0.18;

                // Inharmonic cantilever beam partial ratios; higher modes decay faster
                p0 += f0 / sampleRate;
                p1 += (f0 * 2.756) / sampleRate;
                p2 += (f0 * 5.404) / sampleRate;
                p3 += (f0 * 8.933) / sampleRate;

                const tine =
                    Math.sin(TWO_PI * p0) * 0.70 * Math.exp(-t * 5.5) +
                    Math.sin(TWO_PI * p1) * 0.25 * Math.exp(-t * 14.0) +
                    Math.sin(TWO_PI * p2) * 0.08 * Math.exp(-t * 28.0) +
                    Math.sin(TWO_PI * p3) * 0.02 * Math.exp(-t * 50.0);

                // 0.125ms gate ramp prevents DC click at buffer start
                const gate = Math.min(1.0, t * 8000);
                data[i] = (click + tine) * gate * 0.55;
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

        // D2 timpani: air-loaded diametric modes, felt impact, and an integrated tension-settling glide.

        "timpani": () => {
            const buffer = createBuffer(3.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const root = 73.41619197935188;
            // Ratio to the practical (1,1) principal tone; amplitude; decay rate; glide depth.

            const specifications = [
                [1.000, 1.000, 1.95, 0.018], [1.501, 0.400, 1.72, 0.015],
                [1.998, 0.305, 1.94, 0.012], [2.443, 0.145, 3.20, 0.011],
                [2.905, 0.073, 4.35, 0.010], [3.340, 0.034, 5.90, 0.009],
                [0.810, 0.170, 18.0, 0.025], [1.650, 0.105, 12.5, 0.021],
                [2.070, 0.090, 15.0, 0.018], [2.730, 0.057, 20.0, 0.015],
                [3.760, 0.040, 24.0, 0.012], [5.230, 0.028, 33.0, 0.010],
                [7.370, 0.018, 46.0, 0.008], [10.410, 0.012, 65.0, 0.006],
            ];
            const modes = [];
            const glideStep = Math.exp(-1 / (sampleRate * 0.060));
            const glideIntegral = 0.060 * sampleRate * (1 - glideStep);
            for (let k = 0; k < specifications.length; k++) {
                const specification = specifications[k];
                const frequency = root * specification[0];
                const upperFrequency = frequency * (1 + specification[3]);
                if (upperFrequency >= sampleRate * 0.43) continue;
                const edge = Math.max(0, Math.min(1, (sampleRate * 0.43 - upperFrequency) / (sampleRate * 0.09)));
                modes.push({
                    phase: k < 6 ? 0 : 0.19 * (k - 6),
                    step: TWO_PI * frequency / sampleRate,
                    amplitude: specification[1] * edge * edge * (3 - 2 * edge),
                    decay: Math.exp(-specification[2] / sampleRate),
                    glideArea: specification[3] * glideIntegral,
                });
            }
            const noiseDecay = Math.exp(-1 / (sampleRate * 0.016));
            const noiseLowCoefficient = 1 - Math.exp(-TWO_PI * Math.min(1750, sampleRate * 0.20) / sampleRate);
            const noiseHighCoefficient = 1 - Math.exp(-TWO_PI * Math.min(140, sampleRate * 0.035) / sampleRate);
            const dcPole = Math.exp(-TWO_PI * 6 / sampleRate);
            const last = data.length - 1;
            const tailSamples = sampleRate * 0.50;
            let seed = (0x2974bc15 ^ Motif._sampleSeed) || 0x2974bc15;
            let glide = 1;
            let noiseEnvelope = 0.19;
            let noiseLow = 0;
            let noiseLow2 = 0;
            let noiseHigh = 0;
            let previousInput = 0;
            let dcOutput = 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let value = 0;
                for (let k = 0; k < modes.length; k++) {
                    const mode = modes[k];
                    value += mode.amplitude * Math.sin(mode.phase);
                    mode.phase += mode.step * (1 + mode.glideArea * glide);
                    if (mode.phase >= TWO_PI) mode.phase -= TWO_PI;
                    mode.amplitude *= mode.decay;
                }
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = (seed >>> 0) / 2147483648 - 1;
                noiseLow += noiseLowCoefficient * (noise - noiseLow);
                noiseLow2 += noiseLowCoefficient * (noiseLow - noiseLow2);
                noiseHigh += noiseHighCoefficient * (noiseLow2 - noiseHigh);
                value += (noiseLow2 - noiseHigh) * noiseEnvelope;
                const attackPosition = Math.min(1, t / 0.0018);
                const attack = attackPosition * attackPosition * (3 - 2 * attackPosition);
                const dcInput = value * attack;
                dcOutput = dcInput - previousInput + dcPole * dcOutput;
                previousInput = dcInput;
                const tailPosition = Math.max(0, Math.min(1, (last - i) / tailSamples));
                const tail = tailPosition * tailPosition * (3 - 2 * tailPosition);
                const finalOutput = dcOutput * tail;
                data[i] = finalOutput;
                peak = Math.max(peak, Math.abs(data[i]));
                glide *= glideStep;
                noiseEnvelope *= noiseDecay;
            }
            const gain = peak > 0 ? 0.78 / peak : 1;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[last] = 0;
            return buffer;
        },

        // 'UI Blip': A clean, menu sine-blip for selection or typing.
        "ui-blip": () => {
            const buffer = createBuffer(0.15);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let phase = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Fast pitch drop (an octave + a fifth)
                const freq = 880 + 1000 * Math.exp(-t * 80);
                phase += freq / sampleRate;

                // Mix sine with a tiny bit of square for a retro edge
                const sine = Math.sin(TWO_PI * phase);
                const sq = sine > 0 ? 1 : -1;
                data[i] = (sine * 0.8 + sq * 0.2) * Math.exp(-t * 30);
            }
            return buffer;
        },

        // 'Pickup Chime': A crystalline, high-pitched FM bell with a randomized micro-detune and a bright transient.
        "pickup-chime": () => {
            const buffer = createBuffer(0.4);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const rand = mulberry32(0x8DA6B343 ^ Motif._sampleSeed);

            // Randomize the base frequency slightly to give it an organic, overlapping feel
            const baseFreq = 1200 + (rand() * 400);
            let phaseC = 0;
            let phaseM = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Pitch envelope: starts slightly high and drops into place within 20ms
                const pitchEnv = 1.0 + Math.exp(-t * 150.0) * 0.5;
                phaseC += (baseFreq * pitchEnv) / sampleRate;

                // Inharmonic ratio for a glassy edge
                phaseM += (baseFreq * 2.1 * pitchEnv) / sampleRate;

                // FM Synthesis
                const modIndex = Math.exp(-t * 20.0) * 1.5;
                const mod = Math.sin(TWO_PI * phaseM) * modIndex;
                const tone = Math.sin(TWO_PI * phaseC + mod);

                // Fast, sharp decay typical of tiny glowing objects
                const env = Math.exp(-t * 12.0);
                data[i] = tone * env * 0.6;
            }
            return buffer;
        },

        // 'Tibetan Gong': A massive, deeply resonant struck metal bowl.
        // Lasts for 5 seconds. Relies on inharmonic overtones and acoustic beating.
        "gong-tibetan": () => {
            const duration = 5.0;
            const buffer = createBuffer(duration);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let p1 = 0;
            let p2 = 0;
            let p3 = 0;
            let p4 = 0;

            // A deep fundamental and three inharmonic overtones common in bronze bowls
            const f1 = 110.0;

            // 0.5Hz offset creates a slow undulating throb
            const f2 = 110.5;
            const f3 = f1 * 2.76;
            const f4 = f1 * 5.41;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                p1 += f1 / sampleRate;
                p2 += f2 / sampleRate;
                p3 += f3 / sampleRate;
                p4 += f4 / sampleRate;
                const body = (Math.sin(TWO_PI * p1) + Math.sin(TWO_PI * p2)) * 0.5;
                const tone1 = Math.sin(TWO_PI * p3) * Math.exp(-t * 1.5) * 0.3;
                const tone2 = Math.sin(TWO_PI * p4) * Math.exp(-t * 3.0) * 0.15;

                // Soft mallet strike
                const mallet = Math.sin(TWO_PI * 40 * t) * Math.exp(-t * 30.0) * 0.5;

                // Long, smooth exponential tail out to zero
                const masterEnv = Math.exp(-t * 0.8);
                data[i] = (body + tone1 + tone2 + mallet) * masterEnv * 0.7;
            }
            return buffer;
        },

        // A muffled, alien chime. Uses additive synthesis with inharmonic ratios tuned specifically to low registers, simulating a large resonant alien structure.
        "void-chime": () => {
            const buffer = createBuffer(5.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let p1 = 0;
            let p2 = 0;
            let p3 = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Independent exponential decays for each harmonic layer. Higher modes decay faster.
                const env1 = Math.exp(-t * 0.8);
                const env2 = Math.exp(-t * 1.5);
                const env3 = Math.exp(-t * 2.5);

                // Base frequency sits at 82Hz (approx E2)
                p1 += 82.0 / sampleRate;

                // Inharmonic lower-mid
                p2 += (82.0 * 2.76) / sampleRate;

                // Inharmonic mid (decays fastest)
                p3 += (82.0 * 5.40) / sampleRate;
                const s1 = Math.sin(p1 * TWO_PI) * env1 * 1.0;
                const s2 = Math.sin(p2 * TWO_PI) * env2 * 0.4;
                const s3 = Math.sin(p3 * TWO_PI) * env3 * 0.15;
                const mix = (s1 + s2 + s3);

                // Rapid linear attack (5ms) to prevent start clicks
                const attack = Math.min(1.0, t * 200.0);

                // Final scale and soft-clip to keep dynamics smooth
                data[i] = Math.tanh(mix * 0.7) * attack;
            }
            return buffer;
        },

        // A soothing, distant ocean swell. Uses white noise sculpted by a symmetrical half-sine envelope and a gently sweeping 1-pole lowpass filter, ensuring zero clicks and natural flow.
        "ocean-swell": () => {
            // 6 second long rolling wave
            const buffer = createBuffer(6.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);

            // 1-pole filter state
            const rand = mulberry32(0x243F6A88 ^ Motif._sampleSeed);
            let lp = 0;
            for (let i = 0; i < data.length; i++) {
                // Symmetrical zero-crossing envelope for volume
                const env = Math.sin((i / data.length) * Math.PI);
                const noise = rand() * 2.0 - 1.0;

                // Sweeping cutoff frequency peaking in the middle of the sample
                const targetCutoff = 150.0 + (env * 600.0);
                const cutoff = Math.min(targetCutoff, sampleRate / 6.0);
                const alpha = Math.tan(Math.PI * cutoff / sampleRate);

                // Extremely smooth 1-pole lowpass filter
                lp += (noise - lp) * alpha;
                data[i] = lp * env * 1.5;
            }
            return buffer;
        },

        // A muffled, earthy struck log or mossy stone. Uses additive synthesis with non-integer overtones of a stiff wooden bar, decaying rapidly into the earth.
        "mossy-stone-strike": () => {
            const buffer = createBuffer(2.0);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            let p1 = 0;
            let p2 = 0;
            let p3 = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;

                // Exponential decays for organic damping. Higher modes decay faster.
                const env1 = Math.exp(-t * 3.0);
                const env2 = Math.exp(-t * 8.0);
                const env3 = Math.exp(-t * 15.0);

                // Base frequency tuned to a low, resonant 130Hz
                p1 += 130.0 / sampleRate;

                // Wood/stone stiffness mode 1
                p2 += (130.0 * 2.56) / sampleRate;

                // Wood/stone stiffness mode 2
                p3 += (130.0 * 4.15) / sampleRate;
                const s1 = Math.sin(p1 * TWO_PI) * env1 * 1.0;
                const s2 = Math.sin(p2 * TWO_PI) * env2 * 0.5;
                const s3 = Math.sin(p3 * TWO_PI) * env3 * 0.2;
                const mix = s1 + s2 + s3;

                // Rapid linear attack (2ms) simulating a mallet strike without a digital click
                const attack = Math.min(1.0, t * 500.0);

                // Final zero-crossing safeguard fade at the very end of the buffer
                const tailFade = Math.max(0.0, 1.0 - (i / data.length));
                data[i] = Math.tanh(mix * 0.8) * attack * tailFade;
            }
            return buffer;
        },

        // Finger-plucked concert harp: almost harmonic strings, two decay polarizations, and a quiet soundboard bloom; C4 root.

        "orch-harp-c4": () => {
            const buffer = createBuffer(5.5);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            // Sounding C4, MIDI 60; playbackRate = desiredHz / root.

            const root = 261.6255653005986;
            const modes = [];
            let seed = (0x47a91c25 ^ Motif._sampleSeed) || 0x47a91c25;
            const noise = () => {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                return (seed >>> 0) / 2147483648 - 1;
            };
            const addMode = (frequency, amplitude, t60, phase, riseSeconds = 0) => {
                if (frequency >= sampleRate * 0.4) return;
                const edge = Math.min(1, (sampleRate * 0.4 - frequency) / (sampleRate * 0.08));
                const radius = Math.exp(-6.907755278982137 / (t60 * sampleRate));
                const angle = TWO_PI * frequency / sampleRate;
                modes.push({
                    x: amplitude * edge * Math.cos(phase),
                    y: amplitude * edge * Math.sin(phase),
                    c: radius * Math.cos(angle),
                    s: radius * Math.sin(angle),
                    framesLeft: Math.ceil(t60 * sampleRate * 3),
                    rise: riseSeconds > 0 ? 1 : 0,
                    riseDecay: riseSeconds > 0 ? Math.exp(-1 / (sampleRate * riseSeconds)) : 0,
                });
            };

            // A pluck-position comb and gentle stiffness leave the upper partials recognizably string-like.

            for (let harmonic = 1; harmonic <= 28; harmonic++) {
                const frequency = root * harmonic * Math.sqrt((1 + 0.0000035 * harmonic * harmonic) / 1.0000035);
                const amplitude = Math.sin(Math.PI * 0.19 * harmonic) * Math.exp(-Math.pow(harmonic / 21, 2)) / Math.pow(harmonic, 1.38);
                const damping = 1 + 0.06 * (harmonic - 1) + 0.012 * Math.pow(harmonic - 1, 2);
                addMode(frequency, amplitude * 0.86, 4.7 / damping, 0.08 * harmonic);
                // The weak second polarization survives longer and is only a fraction of a cent away.

                addMode(frequency * (1.00023 + 0.00006 * Math.sin(harmonic * 1.7)), amplitude * 0.14, 5.65 / damping, 0.38 + 0.08 * harmonic, 0.012);
            }
            [[184, 0.032, 0.28], [331, 0.022, 0.2], [579, 0.018, 0.14], [967, 0.01, 0.095], [1543, 0.006, 0.065]].forEach(([frequency, amplitude, t60]) => {
                addMode(frequency, amplitude, t60, noise() * Math.PI, 0.0015);
            });
            // Small delayed components approximate sympathetic response through the soundboard.

            [[1.0008, 0.007], [1.9995, 0.009], [2.9991, 0.005], [3.9992, 0.003]].forEach(([ratio, amplitude]) => {
                addMode(root * ratio, amplitude, 4.9, noise() * Math.PI, 0.045);
            });

            const fingerFast = 1 - Math.exp(-TWO_PI * Math.min(3500, sampleRate * 0.22) / sampleRate);
            const fingerSlow = 1 - Math.exp(-TWO_PI * Math.min(520, sampleRate * 0.08) / sampleRate);
            const dcPole = Math.exp(-TWO_PI * 7 / sampleRate);
            const attackFrames = Math.max(1, Math.round(sampleRate * 0.0018));
            const tailFrames = Math.max(1, Math.round(sampleRate * 0.2));
            let fingerLP = 0, fingerLow = 0, previousRaw = 0, previousHP = 0, peak = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let strings = 0;
                for (let j = 0; j < modes.length; j++) {
                    const mode = modes[j];
                    if (mode.framesLeft-- <= 0) continue;
                    strings += mode.y * (1 - mode.rise);
                    const nextX = mode.c * mode.x - mode.s * mode.y;
                    mode.y = mode.s * mode.x + mode.c * mode.y;
                    mode.x = nextX;
                    mode.rise = mode.rise > 1e-9 ? mode.rise * mode.riseDecay : 0;
                }
                const white = noise();
                fingerLP += fingerFast * (white - fingerLP);
                fingerLow += fingerSlow * (fingerLP - fingerLow);
                const finger = (fingerLP - fingerLow) * (0.045 * Math.exp(-t / 0.0045) + 0.012 * Math.exp(-t / 0.022));
                const raw = strings + finger;
                const attack = i < attackFrames ? 0.5 - 0.5 * Math.cos(Math.PI * i / attackFrames) : 1;
                const dcInput = raw * attack;
                const highPassed = dcInput - previousRaw + dcPole * previousHP;
                previousRaw = dcInput;
                previousHP = highPassed;
                const remaining = data.length - 1 - i;
                const tail = remaining < tailFrames ? 0.5 - 0.5 * Math.cos(Math.PI * remaining / tailFrames) : 1;
                const finalOutput = highPassed * tail;
                data[i] = finalOutput;
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.74 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },

        // Soft felt celesta strike: an inharmonic steel-plate attack settling into its tuned wooden resonator; sounding C5 root.

        "orch-celesta-c5": () => {
            const buffer = createBuffer(5.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            // Sounding C5, MIDI 72; written celesta pitch would be C4.

            const root = 523.2511306011972;
            const modes = [];
            let seed = (0x6ce19a37 ^ Motif._sampleSeed) || 0x6ce19a37;
            const noise = () => {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                return (seed >>> 0) / 2147483648 - 1;
            };
            const addMode = (frequency, amplitude, t60, phase, riseSeconds = 0) => {
                if (frequency >= sampleRate * 0.4) return;
                const edge = Math.min(1, (sampleRate * 0.4 - frequency) / (sampleRate * 0.08));
                const radius = Math.exp(-6.907755278982137 / (t60 * sampleRate));
                const angle = TWO_PI * frequency / sampleRate;
                modes.push({
                    x: amplitude * edge * Math.cos(phase),
                    y: amplitude * edge * Math.sin(phase),
                    c: radius * Math.cos(angle),
                    s: radius * Math.sin(angle),
                    framesLeft: Math.ceil(t60 * sampleRate * 3),
                    rise: riseSeconds > 0 ? 1 : 0,
                    riseDecay: riseSeconds > 0 ? Math.exp(-1 / (sampleRate * riseSeconds)) : 0,
                });
            };

            // Idealized bending-mode ratios, voiced for a soft celesta; these are not measurements of a particular instrument.

            [[1, 0.76, 4.65], [2.756, 0.145, 2.35], [5.404, 0.065, 1.3], [8.933, 0.024, 0.85], [13.347, 0.009, 0.5], [18.639, 0.003, 0.3]].forEach(([ratio, amplitude, t60], index) => {
                addMode(root * ratio, amplitude, t60, 0.11 + index * 0.63, 0.0008 + index * 0.00015);
            });
            // The fundamental is reinforced as the tuned soundbox takes up energy; no vibraphone-like tremolo.

            addMode(root, 0.27, 4.1, 0.08, 0.013);
            addMode(root * 1.00035, 0.035, 4.7, 0.5, 0.025);
            addMode(root * 2.004, 0.014, 0.8, 0.7, 0.003);
            [[193, 0.009, 0.075], [817, 0.008, 0.065], [1337, 0.004, 0.045]].forEach(([frequency, amplitude, t60]) => {
                addMode(frequency, amplitude, t60, noise() * Math.PI, 0.001);
            });

            const feltFast = 1 - Math.exp(-TWO_PI * Math.min(2600, sampleRate * 0.2) / sampleRate);
            const feltSlow = 1 - Math.exp(-TWO_PI * Math.min(700, sampleRate * 0.09) / sampleRate);
            const dcPole = Math.exp(-TWO_PI * 7 / sampleRate);
            const attackFrames = Math.max(1, Math.round(sampleRate * 0.0012));
            const tailFrames = Math.max(1, Math.round(sampleRate * 0.22));
            let feltLP = 0, feltLow = 0, previousRaw = 0, previousHP = 0, peak = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let metalAndBox = 0;
                for (let j = 0; j < modes.length; j++) {
                    const mode = modes[j];
                    if (mode.framesLeft-- <= 0) continue;
                    metalAndBox += mode.y * (1 - mode.rise);
                    const nextX = mode.c * mode.x - mode.s * mode.y;
                    mode.y = mode.s * mode.x + mode.c * mode.y;
                    mode.x = nextX;
                    mode.rise = mode.rise > 1e-9 ? mode.rise * mode.riseDecay : 0;
                }
                const white = noise();
                feltLP += feltFast * (white - feltLP);
                feltLow += feltSlow * (feltLP - feltLow);
                const contact = 0.055 * Math.exp(-t / 0.0028) + 0.012 * Math.exp(-t / 0.013);
                const raw = metalAndBox + (feltLP - feltLow) * contact;
                const attack = i < attackFrames ? 0.5 - 0.5 * Math.cos(Math.PI * i / attackFrames) : 1;
                const dcInput = raw * attack;
                const highPassed = dcInput - previousRaw + dcPole * previousHP;
                previousRaw = dcInput;
                previousHP = highPassed;
                const remaining = data.length - 1 - i;
                const tail = remaining < tailFrames ? 0.5 - 0.5 * Math.cos(Math.PI * remaining / tailFrames) : 1;
                const finalOutput = highPassed * tail;
                data[i] = finalOutput;
                peak = Math.max(peak, Math.abs(data[i]));
            }
            const gain = peak > 0 ? 0.73 / peak : 0;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[data.length - 1] = 0;
            return buffer;
        },

        // C5 tubular bell: capped-tube flexural modes with a C5 residue pitch and a hard mallet strike.

        "orch-tubular-bells-c5": () => {
            const buffer = createBuffer(5.8);
            if (!buffer) return null;
            const data = buffer.getChannelData(0);
            const root = 523.2511306011972;
            // P4-P6 support the strike pitch near 2:3:4; the lower and upper modes remain inharmonic.

            const specifications = [
                [0.236, 0.010, 1.65], [0.635, 0.034, 1.48], [1.216, 0.125, 1.36],
                [2.000, 0.720, 1.34], [2.988, 0.440, 1.56], [4.018, 0.250, 1.88],
                [5.280, 0.150, 2.35], [6.680, 0.105, 3.00], [8.220, 0.078, 3.90],
                [9.910, 0.055, 4.95], [11.780, 0.040, 6.20], [13.820, 0.027, 7.70],
                [16.030, 0.018, 9.40], [18.400, 0.012, 11.2],
            ];
            const modes = [];
            for (let k = 0; k < specifications.length; k++) {
                const specification = specifications[k];
                const frequency = root * specification[0];
                const splitRatio = 1 + 0.00048 + 0.000025 * k;
                const upperFrequency = frequency * splitRatio;
                if (upperFrequency >= sampleRate * 0.43) continue;
                const edge = Math.max(0, Math.min(1, (sampleRate * 0.43 - upperFrequency) / (sampleRate * 0.09)));
                const amplitude = specification[1] * edge * edge * (3 - 2 * edge);
                modes.push({
                    phase: 0.16 * Math.sin(k * 2.31),
                    phase2: 0.16 * Math.sin(k * 2.31) + 0.12,
                    step: TWO_PI * frequency / sampleRate,
                    step2: TWO_PI * frequency * splitRatio / sampleRate,
                    amplitude: amplitude * 0.80,
                    amplitude2: amplitude * 0.20,
                    decay: Math.exp(-specification[2] / sampleRate),
                    decay2: Math.exp(-(specification[2] * 0.79 + 0.08) / sampleRate),
                });
            }
            const noiseDecay = Math.exp(-1 / (sampleRate * 0.0031));
            const noiseLowCoefficient = 1 - Math.exp(-TWO_PI * Math.min(6800, sampleRate * 0.24) / sampleRate);
            const noiseHighCoefficient = 1 - Math.exp(-TWO_PI * Math.min(1450, sampleRate * 0.10) / sampleRate);
            const dcPole = Math.exp(-TWO_PI * 8 / sampleRate);
            const last = data.length - 1;
            const tailSamples = sampleRate * 0.75;
            let seed = (0x6c187be9 ^ Motif._sampleSeed) || 0x6c187be9;
            let noiseEnvelope = 0.23;
            let noiseLow = 0;
            let noiseLow2 = 0;
            let noiseHigh = 0;
            let previousInput = 0;
            let dcOutput = 0;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                const t = i / sampleRate;
                let value = 0;
                for (let k = 0; k < modes.length; k++) {
                    const mode = modes[k];
                    value += mode.amplitude * Math.sin(mode.phase) + mode.amplitude2 * Math.sin(mode.phase2);
                    mode.phase += mode.step;
                    mode.phase2 += mode.step2;
                    if (mode.phase >= TWO_PI) mode.phase -= TWO_PI;
                    if (mode.phase2 >= TWO_PI) mode.phase2 -= TWO_PI;
                    mode.amplitude *= mode.decay;
                    mode.amplitude2 *= mode.decay2;
                }
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                const noise = (seed >>> 0) / 2147483648 - 1;
                noiseLow += noiseLowCoefficient * (noise - noiseLow);
                noiseLow2 += noiseLowCoefficient * (noiseLow - noiseLow2);
                noiseHigh += noiseHighCoefficient * (noiseLow2 - noiseHigh);
                value += (noiseLow2 - noiseHigh) * noiseEnvelope;
                const attackPosition = Math.min(1, t / 0.0009);
                const attack = attackPosition * attackPosition * (3 - 2 * attackPosition);
                const dcInput = value * attack;
                dcOutput = dcInput - previousInput + dcPole * dcOutput;
                previousInput = dcInput;
                const tailPosition = Math.max(0, Math.min(1, (last - i) / tailSamples));
                const tail = tailPosition * tailPosition * (3 - 2 * tailPosition);
                const finalOutput = dcOutput * tail;
                data[i] = finalOutput;
                peak = Math.max(peak, Math.abs(data[i]));
                noiseEnvelope *= noiseDecay;
            }
            const gain = peak > 0 ? 0.78 / peak : 1;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            data[0] = 0;
            data[last] = 0;
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
