import {
    Motif,
    PatternParser,
    parseDurationToFraction,
    parseDurationToSeconds,
    degreeToMidi,
    noteToMidi,
    midiToNote,
    midiToHz,
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
        this._parsedEvents = [];
        this._patternTopLevelSteps = 0;
        this._stepLengthFraction = null;
        this._loopLengthFraction = null;
        this._scheduledUntil = null;
        this._currentCycle = null;
        this._currentCycleStartTime = null;
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

    /**
     * Checks if the given absolute clock time falls within any active scheduled segment.
     * @param {number} t - Absolute context clock time in seconds.
     * @returns {boolean} True if the time is active.
     * @private
     */
    _isTimeActive(t) {
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

    /**
     * Defines a note-based pattern to be flat parsed and scheduled.
     * @param {Array|*} pattern - Sequential/parallel note symbols or strings.
     * @returns {TrackScheduler} this
     */
    note(pattern) {
        this._notePattern = pattern;
        this._freqPattern = null;
        this._parsedEvents = PatternParser.parse(pattern);
        if (this._parsedEvents) {
            this._parsedEvents.forEach((ev, idx) => {
                ev.index = idx;
            });
        }
        this._patternTopLevelSteps = Array.isArray(pattern) ? pattern.length : 1;
        return this;
    },

    /**
     * Defines a frequency-based (Hz) pattern to be flat parsed and scheduled.
     * @param {Array|*} pattern - Sequential/parallel frequency numbers.
     * @returns {TrackScheduler} this
     */
    freq(pattern) {
        this._freqPattern = pattern;
        this._notePattern = null;
        this._parsedEvents = PatternParser.parse(pattern);
        if (this._parsedEvents) {
            this._parsedEvents.forEach((ev, idx) => {
                ev.index = idx;
            });
        }
        this._patternTopLevelSteps = Array.isArray(pattern) ? pattern.length : 1;
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
     * Halts all scheduled audio voices and resets active transport positions.
     * @private
     */
    _resetScheduling() {
        this._scheduledUntil = null;
        this._currentCycle = null;
        this._currentCycleStartTime = null;
        this._playbackStartTime = null;
        if (this._activeVoices) {
            for (const voice of this._activeVoices.values()) {
                safeStop(voice.oscillator);
                safeDisconnect(voice.oscillator);
                safeDisconnect(voice.gainNode);
            }
            this._activeVoices.clear();
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
            const result = mod.modifier(events);
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
            const clone = { ...e };
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
                        const clone = { ...e };
                        clone.startTime = 1.0 - (e.startTime + e.duration);
                        return clone;
                    }).sort((a, b) => a.startTime - b.startTime);
                } else if (chosenAction === "ratchet") {
                    const newEvents = [];
                    for (const e of events) {
                        const e1 = { ...e };
                        e1.duration /= 2;
                        const e2 = { ...e1 };
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
                const midiA = typeof a.value === "number" ? a.value : noteToMidi(a.value);
                const midiB = typeof b.value === "number" ? b.value : noteToMidi(b.value);
                return (midiA || 0) - (midiB || 0);
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

            let notes = group.map(e => ({
                event: e,
                midi: typeof e.value === "number" ? e.value : noteToMidi(e.value),
            }));

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

    /**
     * Looks ahead and schedules parsed note/frequency events up to the time horizon.
     * @param {number} horizon - Absolute context horizon time in seconds.
     * @private
     */
    _schedule(horizon) {
        if (!this._parsedEvents || this._parsedEvents.length === 0) return;

        if (this._scheduledUntil === null || this._scheduledUntil === undefined || this._scheduledUntil < Motif.ctx.currentTime) {
            this._currentCycle = 0;
            this._currentCycleStartTime = Motif.ctx.currentTime;
            this._playbackStartTime = Motif.ctx.currentTime;
            this._scheduledUntil = Motif.ctx.currentTime;
        }

        let cycleDuration;
        if (this._stepLengthFraction !== null && this._stepLengthFraction !== undefined && this._patternTopLevelSteps > 0) {
            const stepDuration = parseDurationToSeconds(this._stepLengthFraction, Motif.tempo, Motif.beatsPerBar);
            cycleDuration = this._patternTopLevelSteps * stepDuration;
        } else {
            cycleDuration = (60 / Motif.tempo) * Motif.beatsPerBar;
        }

        const hasLoopLength = this._loopLengthFraction !== null && this._loopLengthFraction !== undefined;
        let loopDuration = cycleDuration;
        let loopFraction = 1.0;
        if (hasLoopLength) {
            loopDuration = parseDurationToSeconds(this._loopLengthFraction, Motif.tempo, Motif.beatsPerBar);
            loopFraction = cycleDuration > 0 ? loopDuration / cycleDuration : 1.0;
        }

        const swingAmount = this._swingAmount !== null ? this._swingAmount : (Motif._swingAmount || 0);
        const topLevelSteps = this._patternTopLevelSteps || 1;
        const stepFractionSize = 1.0 / topLevelSteps;
        const perStepDurationS = cycleDuration / topLevelSteps;
        const swingDelayS = swingAmount > 0 ? perStepDurationS * swingAmount * (2 / 3) : 0;

        while (this._scheduledUntil < horizon) {
            const cycleStartTime = this._currentCycleStartTime;
            const cycleIndex = this._currentCycle;

            let eventsToPlay = this._parsedEvents;

            if (this._modifiers && this._modifiers.length > 0) {
                eventsToPlay = eventsToPlay.map(e => ({ ...e }));

                for (const mod of this._modifiers) {
                    const modifierName = `_apply${mod.type.charAt(0).toUpperCase() + mod.type.slice(1)}Modifier`;
                    if (typeof this[modifierName] === "function") {
                        eventsToPlay = this[modifierName](eventsToPlay, mod, cycleIndex);
                    }
                }
            }

            for (const event of eventsToPlay) {
                if (hasLoopLength) {
                    const wrappedFraction = loopFraction > 0 ? event.startTime % loopFraction : 0;

                    if (event.startTime >= loopFraction) continue;

                    let eventStartTime = cycleStartTime + wrappedFraction * cycleDuration;

                    if (swingDelayS > 0) {
                        const stepIndex = Math.floor(event.startTime / stepFractionSize + 1e-9);
                        if (stepIndex % 2 === 1) {
                            eventStartTime += swingDelayS;
                        }
                    }

                    const maxDuration = (loopFraction - wrappedFraction) * cycleDuration;
                    const eventDuration = Math.min(event.duration * cycleDuration, maxDuration);

                    if (eventStartTime >= this._scheduledUntil && eventStartTime < horizon) {
                        if (this._isTimeActive(eventStartTime)) {
                            this._playEvent(event, eventStartTime, eventDuration);
                        }
                    }
                } else {
                    let eventStartTime = cycleStartTime + event.startTime * cycleDuration;
                    const eventDuration = event.duration * cycleDuration;

                    if (swingDelayS > 0) {
                        const stepIndex = Math.floor(event.startTime / stepFractionSize + 1e-9);
                        if (stepIndex % 2 === 1) {
                            eventStartTime += swingDelayS;
                        }
                    }

                    if (eventStartTime >= this._scheduledUntil && eventStartTime < horizon) {
                        if (this._isTimeActive(eventStartTime)) {
                            this._playEvent(event, eventStartTime, eventDuration);
                        }
                    }
                }
            }

            const effectiveCycleDuration = hasLoopLength ? loopDuration : cycleDuration;
            const nextCycleStartTime = cycleStartTime + effectiveCycleDuration;
            if (nextCycleStartTime <= horizon) {
                this._currentCycle++;
                this._currentCycleStartTime = nextCycleStartTime;
                this._scheduledUntil = nextCycleStartTime;
            } else {
                this._scheduledUntil = horizon;
            }
        }
    },
};
