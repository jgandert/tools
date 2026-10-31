import {
    Motif,
    MotifEventArray,
    copyPatternEvent,
    PatternParser,
    parseDurationToFraction,
    parseDurationToSeconds,
    musicalDurationBeats,
    degreeToMidi,
    noteToMidi,
    midiToNote,
    midiToHz,
    Tie,
} from "../motif.js";
import { trackRegistry, mulberry32, bjorklund, safeStop, safeDisconnect } from "./helpers.js";

/**
 * Mixin object providing pattern scheduling, Euclidean rhythms, arpeggiation,
 * and step-based transport modification capabilities.
 */
export const TrackScheduler = {
    /**
     * Initializes structural scheduling counters, cycles, modifiers, and registry state.
     * @private
     */
    _initScheduler() {
        this._notePattern = null;
        this._freqPattern = null;
        this._hasPitchPattern = false;
        this._parsedEvents = [];
        this._patternTopLevelSteps = 0;
        this._stepLengthFraction = null;
        this._loopLengthFraction = null;
        this._scheduledUntil = null;
        this._currentCycle = null;
        this._currentCycleStartTime = null;
        this._currentCycleStartBeat = null;
        this._cycleEvents = null;
        this._pendingCycles = new Map();
        this._modifiers = [];
        this._seed = 12345;
        this._activeSegments = [];
        this._pendingStart = undefined;
        this._playbackStartTime = null;
        this._swingAmount = null;
        this._scaleRoot = undefined;
        this._scaleName = "major";
        this._tuningSystem = null;
        this._prevVoicingNotes = [];
        this._isSolo = false;
    },

    /**
     * Records a pending playback boundary start position time.
     * @param {number} time - Start time offset in seconds.
     * @returns {TrackScheduler} this
     */
    start(time) {
        this._pendingStart = typeof time === "number" ? time : 0;
        return this;
    },

    /**
     * Commits a scheduling segment spanning from the pending start time to stop time.
     * @param {number} time - Stop time offset in seconds.
     * @returns {TrackScheduler} this
     */
    stop(time) {
        const start = this._pendingStart !== undefined ? this._pendingStart : 0;
        const stop = typeof time === "number" ? time : Infinity;
        this._activeSegments.push({ start, stop });
        this._pendingStart = undefined;
        return this;
    },

    _arrangedTime(beat) {
        const origin = this._playbackStartTime ?? 0;
        return Motif._timeAtBeat(Motif._beatAtTime(origin) + beat) - origin;
    },

    /**
     * Checks if the given absolute clock time falls within any active scheduled segment.
     * @param {number} t - Absolute context clock time in seconds.
     * @returns {boolean} True if the time is active.
     * @private
     */
    _isTimeActive(t) {
        if (this._splitParent) return this._splitParent._isTimeActive(t);
        if (this._activeSegments.length === 0) return true;
        const refTime = this._playbackStartTime !== null && this._playbackStartTime !== undefined ? this._playbackStartTime : 0;
        const elapsed = t - refTime;
        for (const seg of this._activeSegments) {
            if (elapsed >= seg.start - 1e-9 && elapsed < seg.stop - 1e-9) return true;
        }
        return false;
    },

    /**
     * Clears all recorded start/stop active playback segments.
     * @private
     */
    _clearActiveSegments() {
        this._activeSegments = [];
        this._pendingStart = undefined;
        this._scheduledRamps = [];
    },

    /**
     * Registers a custom pseudo-random seed integer for probabilistic modifiers.
     * @param {number} val - Seed value.
     * @returns {TrackScheduler} this
     */
    seed(val) {
        if (typeof val === "number") {
            this._seed = val;
        }
        return this;
    },

    _setPatternEvents(pattern) {
        const slices = this._sliceIndices;
        if (slices === null || slices === undefined) {
            this._parsedEvents = pattern === null ? new MotifEventArray() : PatternParser.parse(pattern);
        } else {
            const pitches = this._hasPitchPattern ? PatternParser.parse(pattern) : null;
            this._parsedEvents = new MotifEventArray();
            for (const slice of PatternParser.parse(slices)) {
                const active = pitches === null ? [{ value: 60 }] : pitches.filter(pitch =>
                    pitch.startTime <= slice.startTime + 1e-9 &&
                    pitch.startTime + pitch.duration > slice.startTime + 1e-9);
                for (const pitch of active) {
                    this._parsedEvents.push({
                        ...slice,
                        value: slice.value === null ? null : pitch.value,
                        sliceIndex: slice.value,
                        nativeSlicePitch: pitches === null,
                        tieScope: pitch.tieScope || slice.tieScope,
                    });
                }
            }
            PatternParser._postProcessTies(this._parsedEvents);
        }
        this._parsedEvents.forEach((ev, idx) => {
            ev.index = idx;
        });
        const rhythm = slices ?? pattern;
        this._patternTopLevelSteps = Array.isArray(rhythm) ? rhythm.length : 1;
    },

    /**
     * Defines a note-based pattern to be flat parsed and scheduled.
     * @param {Array|*} pattern - Sequential/parallel note symbols or strings.
     * @returns {TrackScheduler} this
     */
    note(pattern) {
        this._hasPitchPattern = true;
        this._notePattern = pattern;
        this._freqPattern = null;
        this._setPatternEvents(pattern);
        return this;
    },

    /**
     * Defines a frequency-based (Hz) pattern to be flat parsed and scheduled.
     * @param {Array|*} pattern - Sequential/parallel frequency numbers.
     * @returns {TrackScheduler} this
     */
    freq(pattern) {
        this._hasPitchPattern = true;
        this._freqPattern = pattern;
        this._notePattern = null;
        this._setPatternEvents(pattern);
        return this;
    },

    /**
     * Decouples the default beat-based step length into custom subdivisions.
     * @param {string|number} fraction - String duration fraction (e.g. "1/16") or numeric equivalent.
     * @returns {TrackScheduler} this
     */
    stepLength(fraction) {
        this._stepLengthFraction = fraction !== undefined && fraction !== null ? fraction : null;
        return this;
    },

    /**
     * Customizes the repetition loop window bounds within the parsed pattern structure.
     * @param {string|number} fraction - Loop bounds duration fraction representation.
     * @returns {TrackScheduler} this
     */
    loopLength(fraction) {
        this._loopLengthFraction = fraction !== undefined && fraction !== null ? fraction : null;
        return this;
    },

    /**
     * Registers a callback modifier triggered every `n` transport cycle bars.
     * @param {number} n - Cycle interval.
     * @param {Function} modifier - Callback taking array of events.
     * @returns {TrackScheduler} this
     */
    every(n, modifier) {
        if (typeof n !== "number" || n <= 0) return this;
        if (typeof modifier !== "function") return this;
        this._modifiers.push({ type: "every", n, modifier });
        return this;
    },

    /**
     * Applies a conditional boolean mask pattern sequence over active steps.
     * @param {Array<boolean>} booleanArray - True/false mask.
     * @param {Function} [modifier] - Optional value transformation modifier.
     * @returns {TrackScheduler} this
     */
    mask(booleanArray, modifier) {
        if (!Array.isArray(booleanArray)) return this;
        this._modifiers.push({ type: "mask", mask: booleanArray, modifier });
        return this;
    },

    /**
     * Recursively subdivides sequential events into faster micro-timing division slices.
     * @param {number} divisions - Number of divisions.
     * @param {Function} modifier - Transform callback.
     * @returns {TrackScheduler} this
     */
    subdivide(divisions, modifier) {
        if (typeof divisions !== "number" || divisions <= 0) return this;
        if (typeof modifier !== "function") return this;
        this._modifiers.push({ type: "subdivide", divisions, modifier });
        return this;
    },

    /**
     * Offsets scheduled event start times forward or backward by a specific fraction step.
     * @param {string|number} timeShift - Shift duration string fraction.
     * @param {Function} [modifier] - Optional transform filter.
     * @returns {TrackScheduler} this
     */
    offset(timeShift, modifier) {
        if (timeShift === undefined || timeShift === null) return this;
        this._modifiers.push({ type: "offset", timeShift, modifier });
        return this;
    },

    /**
     * Customizes track-specific swing offset multipliers.
     * @param {number} amount - Swing depth from 0.0 to 1.0.
     * @returns {TrackScheduler} this
     */
    swing(amount) {
        this._swingAmount = typeof amount === "number" ? Math.max(0, Math.min(1, amount)) : null;
        return this;
    },

    /**
     * Generates standard or rotated mathematical Euclidean rhythm note arrangements.
     * @param {number|Object} pulses - Number of active pulses, or configuration object.
     * @param {number} [steps] - Total rhythm grid steps.
     * @param {number} [rotate=0] - Right-shift step rotation index offset.
     * @returns {TrackScheduler} this
     */
    euclid(pulses, steps, rotate = 0) {
        let p, s, r = rotate;
        if (typeof pulses === "object" && pulses !== null && !Array.isArray(pulses)) {
            p = pulses.pulses;
            s = pulses.steps;
            r = pulses.rotate || 0;
        } else {
            p = pulses;
            s = steps;
        }

        if (typeof p !== "number" || typeof s !== "number") return this;

        let rhythm = bjorklund(p, s);
        if (r !== 0) {
            r = ((r % s) + s) % s;
            rhythm = [...rhythm.slice(r), ...rhythm.slice(0, r)];
        }

        // Convert false to null so they are treated as rests
        const pattern = rhythm.map(v => v ? true : null);
        return this.note(pattern);
    },

    /**
     * Probabilistically drops note triggers from the active playback sequence.
     * @param {number} probability - Drop rate probability from 0.0 to 1.0.
     * @returns {TrackScheduler} this
     */
    degrade(probability) {
        if (typeof probability !== "number") return this;
        this._modifiers.push({ type: "degrade", probability });
        return this;
    },

    /**
     * Randomly morphs sequence structure applying ratchet speedups, reversals, or functions.
     * @param {Object} options - Mutator actions configuration parameters.
     * @returns {TrackScheduler} this
     */
    mutate(options) {
        if (!options || typeof options !== "object") return this;
        this._modifiers.push({ type: "mutate", options });
        return this;
    },

    /**
     * Standardizes modal scale degree degreeToMidi resolutions.
     * @param {string} root - Scale root note name (e.g. "C3").
     * @param {string} [name='major'] - Scale name (e.g. 'minor', 'pentatonic').
     * @returns {TrackScheduler} this
     */
    scale(root, name = "major") {
        this._scaleRoot = root;
        this._scaleName = name;
        return this;
    },

    /**
     * Arranges overlapping chords sequentially upward, downward, or randomly.
     * @param {string} [mode='up'] - Arpeggio direction mode ('up', 'down', 'upDown', 'random').
     * @returns {TrackScheduler} this
     */
    arp(mode) {
        this._modifiers.push({ type: "arp", mode: mode || "up" });
        return this;
    },

    /**
     * Activates non-standard Equal Division of the Octave (EDO) scale conversions.
     * @param {string|Object} system - Tuning string name (e.g. "19-EDO") or settings mapping.
     * @returns {TrackScheduler} this
     */
    tuning(system) {
        this._tuningSystem = system;
        return this;
    },

    /**
     * Sets automatic chord voicing smoothings and drop-note rules.
     * @param {Object} options - Drop indexing and voice styling rules.
     * @returns {TrackScheduler} this
     */
    chordVoicing(options) {
        this._modifiers.push({ type: "chordVoicing", options: options || {} });
        return this;
    },

    /**
     * Solos the track, making it bypass the Arrangement and play infinitely.
     * @returns {TrackScheduler} this
     */
    solo() {
        this._isSolo = true;
        this._clearActiveSegments();
        return this;
    },

    /**
     * Alias for solo().
     * @returns {TrackScheduler} this
     */
    s() {
        return this.solo();
    },

    /**
     * Halts all scheduled audio voices and resets active transport positions.
     * @private
     */
    _resetScheduling() {
        this._scheduledUntil = null;
        this._currentCycle = null;
        this._currentCycleStartTime = null;
        this._currentCycleStartBeat = null;
        this._cycleEvents = null;
        this._pendingCycles = new Map();
        this._playbackStartTime = null;
        this._prevVoicingNotes = [];
        if (this._scheduledRamps) {
            for (const ramp of this._scheduledRamps) {
                ramp.scheduled = false;
                ramp.overridden = false;
            }
        }
        if (this._activeVoices) {
            for (const voice of [...this._activeVoices.values(), ...(this._retiredVoices || [])]) {
                safeStop(voice.oscillator);
                safeDisconnect(voice.oscillator);
                safeDisconnect(voice.gainNode);
            }
            this._activeVoices.clear();
            this._retiredVoices?.clear();
        }
    },

    /**
     * Converts a tuning step or note symbol to absolute hertz frequencies.
     * @param {string|number} val - Note or EDO step index representation.
     * @returns {number} Hertz value.
     * @private
     */
    _convertToTuningHz(val) {
        let step = typeof val === "string" ? noteToMidi(val) : val;
        if (typeof step !== "number" || isNaN(step)) return NaN;

        const system = this._tuningSystem;
        if (typeof system === "string") {
            const match = system.match(/^(\d+)-EDO$/i);
            if (match) {
                const n = parseInt(match[1], 10);
                return 440 * Math.pow(2, (step - 69) / n);
            }
        } else if (system && typeof system === "object") {
            const n = system.n || 12;
            const refHz = system.refHz || 440;
            const refStep = system.refStep !== undefined ? system.refStep : 69;
            return refHz * Math.pow(2, (step - refStep) / n);
        }

        return midiToHz(val);
    },

    /**
     * Applies the 'every' bar modifier rule.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Modifier metadata.
     * @param {number} cycleIndex - Current cycle index.
     * @returns {Array<Object>} Modified events.
     * @private
     */
    _applyEveryModifier(events, mod, cycleIndex) {
        if (cycleIndex % mod.n === 0) {
            const result = mod.modifier(new MotifEventArray(...events));
            if (Array.isArray(result)) return result;
        }
        return events;
    },

    /**
     * Applies the boolean 'mask' modifier sequence.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Mask modifier options.
     * @returns {Array<Object>} Masked events.
     * @private
     */
    _applyMaskModifier(events, mod) {
        if (mod.modifier) {
            return events.map(e => {
                const stepIndex = e.index !== undefined ? e.index : 0;
                if (mod.mask[stepIndex % mod.mask.length]) {
                    const res = mod.modifier(e);
                    return res !== undefined ? res : e;
                }
                return e;
            });
        }
        return events.filter(e => {
            const stepIndex = e.index !== undefined ? e.index : 0;
            return mod.mask[stepIndex % mod.mask.length];
        });
    },

    /**
     * Applies recursive time 'subdivision' slices.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Subdivision settings.
     * @returns {Array<Object>} Subdivided events.
     * @private
     */
    _applySubdivideModifier(events, mod) {
        const divisions = mod.divisions;
        const modifier = mod.modifier;
        const chunkSize = 1.0 / divisions;

        // Group events by their chunk index in a single pass O(N)
        const chunkGroups = Array.from({ length: divisions }, () => []);
        const outsideEvents = [];

        for (const e of events) {
            const chunkIndex = Math.floor((e.startTime + 1e-9) / chunkSize);
            if (chunkIndex >= 0 && chunkIndex < divisions) {
                chunkGroups[chunkIndex].push(e);
            } else {
                outsideEvents.push(e);
            }
        }

        let newEvents = [];
        for (let i = 0; i < divisions; i++) {
            const chunkEvents = chunkGroups[i];
            const result = modifier(chunkEvents, i);
            if (Array.isArray(result)) {
                newEvents.push(...result);
            } else {
                newEvents.push(...chunkEvents);
            }
        }

        if (outsideEvents.length > 0) {
            newEvents.push(...outsideEvents);
        }

        return newEvents;
    },

    /**
     * Applies step 'degrade' drop probabilities.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Degradation options.
     * @param {number} cycleIndex - Current cycle index.
     * @returns {Array<Object>} Remaining events.
     * @private
     */
    _applyDegradeModifier(events, mod, cycleIndex) {
        const prob = mod.probability;
        return events.filter((e) => {
            const seed = (this._seed ^ (cycleIndex * 1337)) ^ (Math.floor(e.startTime * 10000));
            const rng = mulberry32(seed);
            return rng() >= prob;
        });
    },

    /**
     * Applies micro-timing 'offset' shifts.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Offset details.
     * @returns {Array<Object>} Shifted events.
     * @private
     */
    _applyOffsetModifier(events, mod) {
        const shift = parseDurationToFraction(mod.timeShift);
        const modifier = mod.modifier;

        const offsetEvents = events.map(e => {
            const clone = copyPatternEvent(e);
            clone.startTime += shift;
            if (modifier) {
                const res = modifier(clone);
                return res !== undefined ? res : clone;
            }
            return clone;
        }).filter(e => e !== null && e !== undefined);

        const combined = [...events, ...offsetEvents];
        combined.sort((a, b) => a.startTime - b.startTime);
        return combined;
    },

    /**
     * Applies procedural morphing 'mutate' rules.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Mutator parameters.
     * @param {number} cycleIndex - Cycle index.
     * @returns {Array<Object>} Morphed events.
     * @private
     */
    _applyMutateModifier(events, mod, cycleIndex) {
        const { chance = 0.5, actions = {} } = mod.options;
        const seed = (this._seed ^ (cycleIndex * 1234)) + 7;
        const rng = mulberry32(seed);

        if (rng() < chance) {
            const actionNames = Object.keys(actions);
            if (actionNames.length > 0) {
                let totalWeight = 0;
                for (const name of actionNames) {
                    totalWeight += typeof actions[name] === "number" ? actions[name] : 1.0;
                }

                let r = rng() * totalWeight;
                let chosenAction = actionNames[0];
                for (const name of actionNames) {
                    r -= typeof actions[name] === "number" ? actions[name] : 1.0;
                    if (r <= 0) {
                        chosenAction = name;
                        break;
                    }
                }

                if (chosenAction === "reverse") {
                    return events.map(e => {
                        const clone = copyPatternEvent(e);
                        clone.startTime = 1.0 - (e.startTime + e.duration);
                        return clone;
                    }).sort((a, b) => a.startTime - b.startTime);
                } else if (chosenAction === "ratchet") {
                    const newEvents = [];
                    for (const e of events) {
                        const e1 = copyPatternEvent(e);
                        e1.duration /= 2;
                        const e2 = copyPatternEvent(e1);
                        e2.startTime += e1.duration;
                        newEvents.push(e1, e2);
                    }
                    return newEvents;
                } else if (typeof actions[chosenAction] === "function") {
                    const result = actions[chosenAction](events);
                    if (Array.isArray(result)) return result;
                }
            }
        }
        return events;
    },

    /**
     * Applies arpeggiation patterns to chord clusters.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Arpeggiator options.
     * @param {number} cycleIndex - Cycle index.
     * @returns {Array<Object>} Arpeggiated events.
     * @private
     */
    _applyArpModifier(events, mod, cycleIndex) {
        const mode = mod.mode;
        const groups = new Map();
        for (const e of events) {
            const key = `${e.startTime.toFixed(9)}_${e.duration.toFixed(9)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }

        let newEvents = [];
        for (let [key, group] of groups.entries()) {
            if (group.length <= 1) {
                newEvents.push(...group);
                continue;
            }

            const sorted = [...group].sort((a, b) => {
                const getMidiVal = (v) => {
                    if (typeof v === "symbol" || v === Tie) return -Infinity;
                    const m = typeof v === "number" ? v : noteToMidi(v);
                    return (typeof m === "number" && !isNaN(m)) ? m : 0;
                };
                return getMidiVal(a.value) - getMidiVal(b.value);
            });

            let arpNotes = [];
            if (mode === "up") arpNotes = sorted;
            else if (mode === "down") arpNotes = [...sorted].reverse();
            else if (mode === "upDown") arpNotes = sorted.length > 2 ? [...sorted, ...sorted.slice(1, -1).reverse()] : sorted;
            else if (mode === "random") {
                const startTimeVal = parseFloat(key.split("_")[0]);
                const seed = (this._seed ^ (cycleIndex * 5678)) ^ (Math.floor(startTimeVal * 10000));
                const rng = mulberry32(seed);
                arpNotes = [...sorted];
                for (let i = arpNotes.length - 1; i > 0; i--) {
                    const j = Math.floor(rng() * (i + 1));
                    [arpNotes[i], arpNotes[j]] = [arpNotes[j], arpNotes[i]];
                }
            } else arpNotes = sorted;

            const originalDuration = group[0].duration;
            const originalStartTime = group[0].startTime;
            const stepDuration = originalDuration / arpNotes.length;

            for (let i = 0; i < arpNotes.length; i++) {
                const ev = { ...arpNotes[i] };
                ev.startTime = originalStartTime + i * stepDuration;
                ev.duration = stepDuration;
                newEvents.push(ev);
            }
        }
        return newEvents.sort((a, b) => a.startTime - b.startTime);
    },

    /**
     * Applies drop-voicing styles or smooth inversions over chord events.
     * @param {Array<Object>} events - Array of events.
     * @param {Object} mod - Voicing options.
     * @returns {Array<Object>} Voiced events.
     * @private
     */
    _applyChordVoicingModifier(events, mod) {
        const { mode, drop } = mod.options;
        const groups = new Map();
        for (const e of events) {
            const key = `${e.startTime.toFixed(9)}_${e.duration.toFixed(9)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        }

        let newEvents = [];
        if (!this._prevVoicingNotes) this._prevVoicingNotes = [];
        const sortedGroupKeys = [...groups.keys()].sort((a, b) => parseFloat(a.split("_")[0]) - parseFloat(b.split("_")[0]));

        for (const key of sortedGroupKeys) {
            const group = groups.get(key);
            if (group.length <= 1) {
                newEvents.push(...group);
                if (group.length === 1 && typeof group[0].value !== "symbol") {
                    const m = typeof group[0].value === "number" ? group[0].value : noteToMidi(group[0].value);
                    if (typeof m === "number" && !isNaN(m)) this._prevVoicingNotes = [m];
                }
                continue;
            }

            let notes = group.map(e => {
                const m = typeof e.value === "number" ? e.value : noteToMidi(e.value);
                return {
                    event: e,
                    midi: (typeof m === "number" && !isNaN(m)) ? m : 0,
                };
            });

            if (drop !== undefined) {
                notes.sort((a, b) => (a.midi || 0) - (b.midi || 0));
                const dropIndices = Array.isArray(drop) ? drop : [drop];
                for (const d of dropIndices) {
                    const idx = notes.length - d;
                    if (idx >= 0 && idx < notes.length) notes[idx].midi -= 12;
                }
            }

            if (mode === "smooth" && this._prevVoicingNotes.length > 0) {
                notes.sort((a, b) => (a.midi % 12) - (b.midi % 12));
                const prevSorted = [...this._prevVoicingNotes].sort((a, b) => a - b);
                for (let i = 0; i < notes.length; i++) {
                    const targetVoiceIdx = Math.min(i, prevSorted.length - 1);
                    const refMidi = prevSorted[targetVoiceIdx];
                    const pc = notes[i].midi % 12;
                    let bestMidi = pc + 12 * Math.floor(refMidi / 12);
                    let minDiff = Math.abs(bestMidi - refMidi);
                    const above = bestMidi + 12;
                    if (Math.abs(above - refMidi) < minDiff) {
                        bestMidi = above;
                        minDiff = Math.abs(above - refMidi);
                    }
                    const below = bestMidi - 12;
                    if (Math.abs(below - refMidi) < minDiff) bestMidi = below;
                    notes[i].midi = bestMidi;
                }
            }

            this._prevVoicingNotes = [];
            for (const n of notes) {
                if (typeof n.midi === "number" && !isNaN(n.midi)) {
                    n.event.value = typeof n.event.value === "string" ? midiToNote(n.midi) : n.midi;
                    this._prevVoicingNotes.push(n.midi);
                }
                newEvents.push(n.event);
            }
        }
        return newEvents.sort((a, b) => a.startTime - b.startTime);
    },

    _cycleInputsUnchanged(cycle) {
        return cycle.pattern === this._parsedEvents && cycle.modifierCount === this._modifiers.length &&
            cycle.seed === this._seed && cycle.stepLength === this._stepLengthFraction &&
            cycle.loopLength === this._loopLengthFraction && cycle.beatsPerBar === Motif.beatsPerBar;
    },

    // Retain one transformed sequence while a cycle's pattern and modifiers are unchanged.
    _getCycleEvents(cycleIndex) {
        const previous = this._cycleEvents;
        const sameCycle = previous && previous.cycleIndex === cycleIndex;
        if (sameCycle && this._cycleInputsUnchanged(previous)) {
            return previous.events;
        }

        // Live edits rebuild remaining events from the voicing state at cycle entry.
        const voicingBefore = sameCycle ? previous.voicingBefore : [...this._prevVoicingNotes];
        this._prevVoicingNotes = [...voicingBefore];
        let eventsToPlay = this._parsedEvents.map(copyPatternEvent);
        for (const mod of this._modifiers) {
            const modifierName = `_apply${mod.type.charAt(0).toUpperCase() + mod.type.slice(1)}Modifier`;
            if (typeof this[modifierName] !== "function") continue;

            try {
                eventsToPlay = this[modifierName](eventsToPlay, mod, cycleIndex);
            } catch (err) {
                console.error(`[Motif] Modifier "${mod.type}" threw on track "${this.id}", keeping unmodified events:`, err);
            }
        }

        // Clones give duplicated events distinct Tie IDs while retaining branch ancestry.
        eventsToPlay = eventsToPlay.map(copyPatternEvent);
        PatternParser._postProcessTies(eventsToPlay);
        eventsToPlay.sort((a, b) => a.startTime - b.startTime);

        // A setter inside a cycle callback also cancels older pending snapshots.
        if (previous && !this._cycleInputsUnchanged(previous)) this._pendingCycles.clear();

        // Capture inputs after callbacks so a setter inside a callback does not retrigger it.
        this._cycleEvents = {
            cycleIndex,
            pattern: this._parsedEvents,
            modifierCount: this._modifiers.length,
            seed: this._seed,
            stepLength: this._stepLengthFraction,
            loopLength: this._loopLengthFraction,
            beatsPerBar: Motif.beatsPerBar,
            voicingBefore,
            events: eventsToPlay,
        };
        return eventsToPlay;
    },

    /**
     * Looks ahead and schedules parsed note/frequency events up to the time horizon.
     * @param {number} horizon - Absolute context horizon time in seconds.
     * @private
     */
    _schedule(horizon) {
        this._cleanupActiveVoices();
        if (this._gainSignalStopTime != null && this._gainSignalStopTime <= Motif.ctx.currentTime) {
            this._clearGainSignal();
        }
        if (this._scheduledUntil === null || this._scheduledUntil === undefined) {
            const origin = this._playbackStartTime ?? this._splitParent?._playbackStartTime ?? Motif.ctx.currentTime;
            this._currentCycle = 0;
            this._currentCycleStartTime = origin;
            this._currentCycleStartBeat = Motif._beatAtTime(origin);
            this._playbackStartTime = origin;
            this._scheduledUntil = Motif.ctx.currentTime;
        }

        // A late tick skips missed onsets without moving the musical timeline.
        this._scheduledUntil = Math.max(this._scheduledUntil, Motif.ctx.currentTime);

        if (this._scheduledRamps && this._scheduledRamps.length > 0) {
            const refTime = this._playbackStartTime !== null && this._playbackStartTime !== undefined ? this._playbackStartTime : Motif.ctx.currentTime;
            for (const ramp of this._scheduledRamps) {
                if (!ramp.scheduled && !ramp.overridden) {
                    const absStart = refTime + ramp.start;
                    if (absStart < horizon) {
                        if (this.trackInputNode) {
                            const gainParam = this.trackInputNode.gain;
                            const start = Math.max(absStart, this._scheduledUntil);
                            const end = absStart + ramp.duration;
                            if (end <= start && ramp.startBeat !== undefined) {
                                ramp.scheduled = true;
                                continue;
                            }
                            const musical = ramp.durationBeats != null;
                            const originBeat = Motif._beatAtTime(refTime);
                            const progressAt = time => musical
                                ? Math.min(1, Math.max(0, (Motif._beatAtTime(time) - originBeat - ramp.startBeat) / ramp.durationBeats))
                                : ramp.duration > 0 ? Math.min(1, (time - absStart) / ramp.duration) : 1;
                            const valueAt = time => time >= end ? ramp.to : ramp.from + (ramp.to - ramp.from) * progressAt(time);
                            if (ramp.startBeat !== undefined) {
                                if (gainParam.cancelAndHoldAtTime) gainParam.cancelAndHoldAtTime(start);
                                else gainParam.cancelScheduledValues?.(start);
                            }
                            this._suspendGainSignal(start, ramp);
                            gainParam.setValueAtTime(valueAt(start), start);
                            if (end > start) {
                                if (musical) {
                                    // Linear BPM creates quadratic beat progress. Short linear audio segments
                                    // follow that curve and preserve exact endpoints at tempo discontinuities.
                                    for (let i = 0; i < Motif._tempoMap.length; i++) {
                                        const segment = Motif._tempoMap[i];
                                        const left = Math.max(start, segment.time);
                                        const right = Math.min(end, Motif._tempoMap[i + 1]?.time ?? end);
                                        if (right <= left) continue;
                                        const count = segment.slope === 0 ? 1 : Math.ceil((right - left) / 0.025);
                                        for (let n = 1; n <= count; n++) {
                                            const time = left + (right - left) * n / count;
                                            gainParam.linearRampToValueAtTime(valueAt(time), time);
                                        }
                                    }
                                } else {
                                    gainParam.linearRampToValueAtTime(ramp.to, end);
                                }
                            }
                        } else {
                            console.warn(`[Motif] gain(Ramp(...)) called before audio is initialized on track "${this.id}". Ramp ignored.`);
                        }
                        ramp.scheduled = true;
                    }
                }
            }
        }
        if (this._gainRampsQueue && this._gainRampsQueue.length > 0) {
            const refTime = this._playbackStartTime !== null && this._playbackStartTime !== undefined ? this._playbackStartTime : Motif.ctx.currentTime;
            while (this._gainRampsQueue.length > 0) {
                const rampNode = this._gainRampsQueue.shift();
                if (this.trackInputNode) {
                    const gainParam = this.trackInputNode.gain;
                    const from = typeof rampNode.from === "number" ? rampNode.from : 1.0;
                    const to = typeof rampNode.to === "number" ? rampNode.to : 0.0;
                    const d = rampNode.duration !== undefined
                        ? parseDurationToSeconds(rampNode.duration, Motif.tempo, Motif.beatsPerBar)
                        : 0.05;
                    const start = Math.max(refTime, Motif.ctx.currentTime);
                    this._suspendGainSignal(start);
                    gainParam.cancelScheduledValues?.(start);
                    gainParam.setValueAtTime(from, start);
                    gainParam.linearRampToValueAtTime(to, start + d);
                } else {
                    console.warn(`[Motif] gain(Ramp(...)) called before audio is initialized on track "${this.id}". Ramp ignored.`);
                }
            }
        }

        // Structural edits cancel unscheduled copies from older cycles. The current
        // cycle is rebuilt below, preserving the existing submitted-time boundary.
        if (this._cycleEvents && !this._cycleInputsUnchanged(this._cycleEvents)) {
            this._pendingCycles.clear();
        }
        if (!this._parsedEvents || this._parsedEvents.length === 0) return;

        let anySoloed = false;
        for (const t of trackRegistry.values()) {
            if (t._isSolo) {
                anySoloed = true;
                break;
            }
        }
        if (anySoloed && !this._isSolo) return;

        const stepBeats = this._stepLengthFraction == null ? Motif.beatsPerBar
            : musicalDurationBeats(this._stepLengthFraction, Motif.beatsPerBar);
        const patternBeats = stepBeats === null ? null
            : stepBeats * (this._stepLengthFraction == null ? 1 : this._patternTopLevelSteps);
        const patternSeconds = patternBeats === null
            ? parseDurationToSeconds(this._stepLengthFraction, Motif.tempo, Motif.beatsPerBar) * this._patternTopLevelSteps : null;
        const hasLoopLength = this._loopLengthFraction != null;
        const loopBeats = hasLoopLength ? musicalDurationBeats(this._loopLengthFraction, Motif.beatsPerBar) : patternBeats;
        const loopSeconds = hasLoopLength && loopBeats === null
            ? parseDurationToSeconds(this._loopLengthFraction, Motif.tempo, Motif.beatsPerBar) : patternSeconds;
        if (!((patternBeats ?? patternSeconds) > 0) || !((loopBeats ?? loopSeconds) > 0)) {
            this._scheduledUntil = horizon;
            return;
        }

        const windowStart = this._scheduledUntil;
        while (this._scheduledUntil < horizon) {
            const cycleBeat = this._currentCycleStartBeat;
            const cycleStart = loopBeats === null ? this._currentCycleStartTime : Motif._timeAtBeat(cycleBeat);
            const nextCycleStart = loopBeats === null ? cycleStart + loopSeconds : Motif._timeAtBeat(cycleBeat + loopBeats);

            // Skip complete missed cycles without running their callbacks.
            if (nextCycleStart > windowStart) {
                this._getCycleEvents(this._currentCycle);
                const cycle = this._cycleEvents;
                if (this._pendingCycles.get(this._currentCycle) !== cycle) {
                    Object.assign(cycle, {
                        startTime: this._currentCycleStartTime,
                        startBeat: cycleBeat,
                        patternBeats,
                        patternSeconds,
                        loopBeats,
                        loopSeconds,
                        hasLoopLength,
                        steps: this._patternTopLevelSteps || 1,
                        pending: new Set(cycle.events),
                    });
                    this._pendingCycles.set(this._currentCycle, cycle);
                }
            }
            if (nextCycleStart <= horizon) {
                this._currentCycle++;
                this._currentCycleStartTime = nextCycleStart;
                this._currentCycleStartBeat = loopBeats === null ? Motif._beatAtTime(nextCycleStart) : cycleBeat + loopBeats;
                this._scheduledUntil = Math.max(this._scheduledUntil, nextCycleStart);
            } else {
                this._scheduledUntil = horizon;
            }
        }

        const swing = this._swingAmount ?? Motif._swingAmount ?? 0;
        const submissions = [];
        for (const [cycleIndex, cycle] of this._pendingCycles) {
            const cycleStart = cycle.loopBeats === null ? cycle.startTime : Motif._timeAtBeat(cycle.startBeat);
            const patternTime = fraction => cycle.patternBeats === null ? cycleStart + fraction * cycle.patternSeconds
                : Motif._timeAtBeat(Motif._beatAtTime(cycleStart) + fraction * cycle.patternBeats);
            const nextCycleStart = cycle.loopBeats === null ? cycleStart + cycle.loopSeconds
                : Motif._timeAtBeat(cycle.startBeat + cycle.loopBeats);
            const swingFraction = event => Math.floor(event.startTime * cycle.steps + 1e-9) % 2 === 1
                ? event.startTime + swing * (2 / 3) / cycle.steps : event.startTime;
            const tieStarts = new Map();
            for (const event of cycle.events) {
                if (event.value !== Tie || !(event.duration > 0)) continue;
                if (cycle.hasLoopLength && patternTime(event.startTime) >= nextCycleStart - 1e-9) continue;
                const start = patternTime(swingFraction(event));
                if ((!cycle.hasLoopLength || start < nextCycleStart - 1e-9) && this._isTimeActive(start)) {
                    tieStarts.set(event.tieId, start);
                }
            }

            // Refresh pending continuations even after their originating cycle ends.
            for (const voice of this._activeVoices.values()) {
                if (voice.tieCycle !== cycleIndex || !voice.tieTargets?.length) continue;
                let releaseTime = voice.tieEndTime;
                for (const id of voice.tieTargets) releaseTime = Math.max(releaseTime, tieStarts.get(id) ?? releaseTime);
                if (Math.abs(releaseTime - voice.tieReleaseTime) < 1e-9) continue;
                const holdTime = Math.max(Motif.ctx.currentTime, voice.tieEndTime);
                this._scheduleTieRelease(voice, holdTime, Math.max(holdTime, releaseTime));
            }
            for (const event of cycle.pending) {
                const unswungStart = patternTime(event.startTime);
                if (cycle.hasLoopLength && unswungStart >= nextCycleStart - 1e-9) {
                    cycle.pending.delete(event);
                    continue;
                }
                const fraction = swingFraction(event);
                const eventStart = patternTime(fraction);
                if (eventStart >= horizon - 1e-9) continue;
                cycle.pending.delete(event);
                if (eventStart < windowStart - 1e-9 || !this._isTimeActive(eventStart)) continue;
                let eventEnd = patternTime(fraction + event.duration);
                if (cycle.hasLoopLength) eventEnd = Math.min(eventEnd, nextCycleStart);

                // Swing may delay a continuation past the original gate. Bound the
                // fallback at that onset so intact ties survive the timing gap.
                let tieReleaseTime = eventEnd;
                for (const id of event.tieTargets || []) {
                    tieReleaseTime = Math.max(tieReleaseTime, tieStarts.get(id) ?? eventEnd);
                }
                submissions.push({ event: { ...event, tieCycle: cycleIndex, tieReleaseTime },
                    start: eventStart, duration: Math.max(0, eventEnd - eventStart) });
            }
            if (cycle.pending.size === 0 && cycleIndex !== this._currentCycle) {
                this._pendingCycles.delete(cycleIndex);
            }
        }

        // Older delayed notes and current events can overlap within one lookahead.
        // Submit by onset so every Tie sees all earlier voices in its own cycle.
        submissions.sort((a, b) => a.start - b.start);
        for (const { event, start, duration } of submissions) {
            try {
                this._playEvent(event, start, duration);
            } catch (err) {
                console.error(`[Motif] _playEvent threw on track "${this.id}":`, err);
            }
        }
    },
};
