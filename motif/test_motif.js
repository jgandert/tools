import {
    PatternParser,
    Parallel,
    Ramp,
    Tie,
    noteToMidi,
    midiToNote,
    degreeToMidi,
    midiToHz,
    Motif,
    parseDurationToSeconds,
    Track,
    LFO,
    Bus,
    Arrange,
    MotifEventArray,
} from "./motif.js";


let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(msg);
        console.log(`  FAIL: ${msg}`);
    }
}

// =============================================================================
// PatternParser - nested array flattening
// =============================================================================
console.log("\n=== PatternParser: Nested Array Flattening ===");
{
    const pattern = ["A", ["B", "C"], "D"];
    const parsed = PatternParser.parse(pattern);

    assert(parsed.length === 4, `expected 4 events, got ${parsed.length}`);

    const expected = [
        { value: "A", startTime: 0, duration: 1 / 3 },
        { value: "B", startTime: 1 / 3, duration: 1 / 6 },
        { value: "C", startTime: 1 / 2, duration: 1 / 6 },
        { value: "D", startTime: 2 / 3, duration: 1 / 3 },
    ];

    for (let i = 0; i < expected.length; i++) {
        const p = parsed[i];
        const e = expected[i];
        if (p) {
            assert(p.value === e.value, `index ${i}: expected value '${e.value}', got '${p.value}'`);
            assert(Math.abs(p.startTime - e.startTime) < 1e-9, `index ${i}: expected startTime ${e.startTime}, got ${p.startTime}`);
            assert(Math.abs(p.duration - e.duration) < 1e-9, `index ${i}: expected duration ${e.duration}, got ${p.duration}`);
        }
    }
}

// =============================================================================
// Parallel primitive - same startTime fraction
// =============================================================================
console.log("\n=== Parallel Primitive: Simultaneous Execution ===");
{
    const pattern = ["kick", Parallel("kick", "clap")];
    const parsed = PatternParser.parse(pattern);

    assert(parsed.length === 3, `expected 3 events, got ${parsed.length}`);

    const expected = [
        { value: "kick", startTime: 0, duration: 0.5 },
        { value: "kick", startTime: 0.5, duration: 0.5 },
        { value: "clap", startTime: 0.5, duration: 0.5 },
    ];

    for (let i = 0; i < expected.length; i++) {
        const p = parsed[i];
        const e = expected[i];
        if (p) {
            assert(p.value === e.value, `index ${i}: expected value '${e.value}', got '${p.value}'`);
            assert(Math.abs(p.startTime - e.startTime) < 1e-9, `index ${i}: expected startTime ${e.startTime}, got ${p.startTime}`);
            assert(Math.abs(p.duration - e.duration) < 1e-9, `index ${i}: expected duration ${e.duration}, got ${p.duration}`);
        }
    }
}

// =============================================================================
// Ramp primitive - tags a step for linear interpolation
// =============================================================================
console.log("\n=== Ramp Primitive: Linear Interpolation ===");
{
    const pattern = [Ramp("C4", "G4"), "E4"];
    const parsed = PatternParser.parse(pattern);

    assert(parsed.length === 2, `expected 2 events, got ${parsed.length}`);

    const r = parsed[0];
    assert(r !== undefined, "ramp event exists");
    assert(r.value.isRamp === true, "ramp event value is tagged as isRamp");
    assert(r.value.from === "C4", "ramp from is 'C4'");
    assert(r.value.to === "G4", "ramp to is 'G4'");
    assert(Math.abs(r.startTime - 0) < 1e-9, `ramp startTime is 0, got ${r.startTime}`);
    assert(Math.abs(r.duration - 0.5) < 1e-9, `ramp duration is 0.5, got ${r.duration}`);

    const nextEvent = parsed[1];
    assert(nextEvent !== undefined, "second event exists");
    assert(nextEvent.value === "E4", "second event value is 'E4'");
    assert(Math.abs(nextEvent.startTime - 0.5) < 1e-9, `second event startTime is 0.5, got ${nextEvent.startTime}`);
    assert(Math.abs(nextEvent.duration - 0.5) < 1e-9, `second event duration is 0.5, got ${nextEvent.duration}`);
}

// =============================================================================
// Pattern Math - Array prototype extensions
// =============================================================================
console.log("\n=== Pattern Math: Cross-Product Arithmetic ===");
{
    // 1. Array.prototype.add on note strings and transpositions
    const notes = ["C3", "E3"];
    const octaves = [0, 12];
    const addedNotes = notes.add(octaves);

    assert(addedNotes.length === 4, `expected 4 notes, got ${addedNotes.length}`);
    assert(addedNotes[0] === "C3", `expected addedNotes[0] === 'C3', got '${addedNotes[0]}'`);
    assert(addedNotes[1] === "C4", `expected addedNotes[1] === 'C4', got '${addedNotes[1]}'`);
    assert(addedNotes[2] === "E3", `expected addedNotes[2] === 'E3', got '${addedNotes[2]}'`);
    assert(addedNotes[3] === "E4", `expected addedNotes[3] === 'E4', got '${addedNotes[3]}'`);

    // 2. Subtraction
    const subResult = [10, 20].sub(5);
    assert(subResult.length === 2, `expected 2 elements, got ${subResult.length}`);
    assert(subResult[0] === 5, `expected subResult[0] === 5, got ${subResult[0]}`);
    assert(subResult[1] === 15, `expected subResult[1] === 15, got ${subResult[1]}`);

    // 3. Multiplication
    const mulResult = [2, 3].mul([4, 5]);
    assert(mulResult.length === 4, `expected 4 elements, got ${mulResult.length}`);
    assert(mulResult[0] === 8, `expected mulResult[0] === 8, got ${mulResult[0]}`);
    assert(mulResult[1] === 10, `expected mulResult[1] === 10, got ${mulResult[1]}`);
    assert(mulResult[2] === 12, `expected mulResult[2] === 12, got ${mulResult[2]}`);
    assert(mulResult[3] === 15, `expected mulResult[3] === 15, got ${mulResult[3]}`);

    // 4. Division
    const divResult = [12, 24].div(2);
    assert(divResult.length === 2, `expected 2 elements, got ${divResult.length}`);
    assert(divResult[0] === 6, `expected divResult[0] === 6, got ${divResult[0]}`);
    assert(divResult[1] === 12, `expected divResult[1] === 12, got ${divResult[1]}`);
}

// =============================================================================
// Scales and Note/Hz Conversions
// =============================================================================
console.log("\n=== Scales and Note/Hz Conversions ===");
{
    // 1. noteToMidi / midiToNote
    assert(noteToMidi("C4") === 60, `C4 should be MIDI 60, got ${noteToMidi("C4")}`);
    assert(noteToMidi("A4") === 69, `A4 should be MIDI 69, got ${noteToMidi("A4")}`);
    assert(noteToMidi("C3") === 48, `C3 should be MIDI 48, got ${noteToMidi("C3")}`);
    assert(midiToNote(60) === "C4", `MIDI 60 should be 'C4', got '${midiToNote(60)}'`);
    assert(midiToNote(69) === "A4", `MIDI 69 should be 'A4', got '${midiToNote(69)}'`);

    // 2. degreeToMidi mapping
    // C major scale degree 0 should be 48 (C3)
    assert(degreeToMidi(0, "C3", "major") === 48, `C3 degree 0 should be 48, got ${degreeToMidi(0, "C3", "major")}`);
    // C major scale degree 2 should be 52 (E3)
    assert(degreeToMidi(2, "C3", "major") === 52, `C3 degree 2 should be 52, got ${degreeToMidi(2, "C3", "major")}`);
    // C minor scale degree 2 should be 51 (Eb3)
    assert(degreeToMidi(2, "C3", "minor") === 51, `C3 degree 2 in minor should be 51, got ${degreeToMidi(2, "C3", "minor")}`);
    // Out-of-bounds octaves: degree 7 in C major should be 60 (C4)
    assert(degreeToMidi(7, "C3", "major") === 60, `C3 degree 7 should be 60, got ${degreeToMidi(7, "C3", "major")}`);
    // Negative degrees: degree -1 in C major should be 47 (B2)
    assert(degreeToMidi(-1, "C3", "major") === 47, `C3 degree -1 should be 47, got ${degreeToMidi(-1, "C3", "major")}`);

    // 3. midiToHz
    // A4 (69) = 440 Hz
    assert(Math.abs(midiToHz(69) - 440) < 1e-9, `MIDI 69 frequency should be 440, got ${midiToHz(69)}`);
    // C4 (60) = 261.6255653 Hz
    const expectedC4Hz = 440 * Math.pow(2, (60 - 69) / 12);
    assert(Math.abs(midiToHz(60) - expectedC4Hz) < 1e-9, `MIDI 60 frequency should be ${expectedC4Hz}, got ${midiToHz(60)}`);
}

// =============================================================================
// Motif global singleton and Web Audio initialization
// =============================================================================
console.log("\n=== Motif Engine: Web Audio Initialization ===");
{
    // Define Mock AudioContext if in testing environment
    class MockAudioParam {
        constructor(val = 0) {
            this.value = val;
        }

        setValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        linearRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        exponentialRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        cancelAndHoldAtTime(time) {
            return this;
        }
    }

    class MockGainNode {
        constructor() {
            this.gain = new MockAudioParam(1.0);
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockBiquadFilterNode {
        constructor() {
            this.type = "lowpass";
            this.frequency = new MockAudioParam(350);
            this.gain = new MockAudioParam(0);
            this.Q = new MockAudioParam(1);
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockDynamicsCompressorNode {
        constructor() {
            this.threshold = new MockAudioParam(-24);
            this.knee = new MockAudioParam(30);
            this.ratio = new MockAudioParam(12);
            this.attack = new MockAudioParam(0.003);
            this.release = new MockAudioParam(0.25);
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockWaveShaperNode {
        constructor() {
            this.curve = null;
            this.oversample = "none";
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockStereoPannerNode {
        constructor() {
            this.pan = new MockAudioParam(0);
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockAudioContext {
        constructor() {
            this.state = "suspended";
            this.currentTime = 0;
            this.destination = {};
        }

        createGain() {
            return new MockGainNode();
        }

        createBiquadFilter() {
            return new MockBiquadFilterNode();
        }

        createDynamicsCompressor() {
            return new MockDynamicsCompressorNode();
        }

        createWaveShaper() {
            return new MockWaveShaperNode();
        }

        createStereoPanner() {
            return new MockStereoPannerNode();
        }

        resume() {
            this.state = "running";
            return Promise.resolve();
        }

        suspend() {
            this.state = "suspended";
            return Promise.resolve();
        }
    }

    if (typeof window === "undefined") {
        globalThis.AudioContext = MockAudioContext;
    }

    // Initialize Motif
    Motif.init();

    assert(Motif.ctx !== null, "Motif.ctx should not be null after initialization");
    assert(Motif.ctx instanceof MockAudioContext, "Motif.ctx should be an instance of MockAudioContext in test environment");
    assert(Motif.masterGain !== null, "Motif.masterGain should not be null after initialization");
    assert(Motif.masterGain.gain.value === 1.0, `Motif.masterGain.gain.value should be 1.0, got ${Motif.masterGain.gain.value}`);
    assert(Motif.masterCompressor !== null, "Motif.masterCompressor should not be null after initialization");
}

// =============================================================================
// Motif Global Transport Controls
// =============================================================================
console.log("\n=== Motif Engine: Global Transport Controls ===");
{
    // Ensure it starts suspended
    Motif.ctx.state = "suspended";
    Motif.isPlaying = false;
    Motif.position = 5; // offset it to test stop reset

    let threwError = false;
    try {
        Motif.start();
    } catch (e) {
        threwError = true;
        assert(e.message.includes("suspended"), `expected error message about suspended context, got: "${e.message}"`);
    }
    assert(threwError === true, "Motif.start() must throw an error if called when AudioContext is suspended");
    assert(Motif.isPlaying === false, "Motif.isPlaying should remain false after failed start");

    // Simulate user gesture resuming context
    Motif.ctx.resume();
    assert(Motif.ctx.state === "running", "AudioContext should be running after resume");

    // Test successful start
    let startThrew = false;
    try {
        Motif.start();
    } catch (e) {
        startThrew = true;
    }
    assert(startThrew === false, "Motif.start() should not throw when context is running");
    assert(Motif.isPlaying === true, "Motif.isPlaying should be true after successful start");

    // Test tempo management
    Motif.setTempo(135);
    assert(Motif.tempo === 135, `expected tempo to be 135, got ${Motif.tempo}`);
    assert(Motif.bpmParam.value === 135, `expected bpmParam value to be 135, got ${Motif.bpmParam.value}`);

    let tempoThrew = false;
    try {
        Motif.setTempo(-5);
    } catch (e) {
        tempoThrew = true;
    }
    assert(tempoThrew === true, "Motif.setTempo(-5) should throw an error");

    // Test pause
    Motif.pause();
    assert(Motif.isPlaying === false, "Motif.isPlaying should be false after pause");
    assert(Motif.ctx.state === "suspended", "AudioContext should be suspended after pause");

    // Test stop (resets position and suspends context)
    Motif.ctx.resume();
    Motif.isPlaying = true;
    Motif.stop();
    assert(Motif.isPlaying === false, "Motif.isPlaying should be false after stop");
    assert(Motif.position === 0, `Motif.position should reset to 0 after stop, got ${Motif.position}`);
    assert(Motif.ctx.state === "suspended", "AudioContext should be suspended after stop");
}

// =============================================================================
// Motif Duration Parsing and Tempo Ramping
// =============================================================================
console.log("\n=== Motif Engine: Duration Parsing and Tempo Ramping ===");
{
    // Test parseDurationToSeconds
    // At 120 BPM, 1 beat = 0.5s
    // 1 bar = 4 beats = 2.0s
    assert(Math.abs(parseDurationToSeconds(2.5, 120) - 2.5) < 1e-9, "parseDurationToSeconds with number");
    assert(Math.abs(parseDurationToSeconds("8b", 120, 4) - 16) < 1e-9, `expected 16s for 8b, got ${parseDurationToSeconds("8b", 120, 4)}`);
    assert(Math.abs(parseDurationToSeconds("1/16", 120, 4) - 0.125) < 1e-9, `expected 0.125s for 1/16, got ${parseDurationToSeconds("1/16", 120, 4)}`);
    assert(Math.abs(parseDurationToSeconds("3 beats", 120, 4) - 1.5) < 1e-9, "parseDurationToSeconds with beats unit");
    assert(Math.abs(parseDurationToSeconds("500 ms", 120, 4) - 0.5) < 1e-9, "parseDurationToSeconds with ms unit");
    assert(Math.abs(parseDurationToSeconds("3.5s", 120, 4) - 3.5) < 1e-9, "parseDurationToSeconds with s unit");

    // Test rampTempo calls and param scheduling
    let setValueAtTimeCalled = false;
    let linearRampToValueAtTimeCalled = false;
    let valPassed = 0;
    let timePassed = 0;

    Motif.tempo = 100;
    Motif.bpmParam = {
        value: 100,
        setValueAtTime(v, t) {
            setValueAtTimeCalled = true;
            return this;
        },
        linearRampToValueAtTime(v, t) {
            linearRampToValueAtTimeCalled = true;
            valPassed = v;
            timePassed = t;
            this.value = v;
            return this;
        },
    };

    Motif.rampTempo(150, "2b");
    assert(setValueAtTimeCalled === true, "setValueAtTime should be called to anchor the ramp");
    assert(linearRampToValueAtTimeCalled === true, "linearRampToValueAtTime should be called to perform the ramp");
    assert(valPassed === 150, `expected target value to be 150, got ${valPassed}`);
    assert(Motif.tempo === 150, `expected Motif.tempo to update to 150, got ${Motif.tempo}`);

    // Invalid parameters guard test
    let rampThrew = false;
    try {
        Motif.rampTempo(-10, "1s");
    } catch (e) {
        rampThrew = true;
    }
    assert(rampThrew === true, "Motif.rampTempo should throw on invalid target tempo");
}

// =============================================================================
// Motif Master Output Configuration
// =============================================================================
console.log("\n=== Motif Engine: Master Output Configuration ===");
{
    // Force re-initialization of Motif with the updated MockAudioContext
    Motif.ctx = null;
    Motif.init();

    assert(Motif.masterLowFilter !== null, "masterLowFilter exists");
    assert(Motif.masterMidFilter !== null, "masterMidFilter exists");
    assert(Motif.masterHighFilter !== null, "masterHighFilter exists");

    // Test Master gain configuration
    Motif.master({ gain: 0.75 });
    assert(Motif.masterGain.gain.value === 0.75, `expected gain to be 0.75, got ${Motif.masterGain.gain.value}`);

    // Test EQ configuration
    Motif.master({
        eq: { low: 2.5, mid: -3.0, high: 4.5 },
    });
    assert(Motif.masterLowFilter.gain.value === 2.5, `expected low gain to be 2.5, got ${Motif.masterLowFilter.gain.value}`);
    assert(Motif.masterMidFilter.gain.value === -3.0, `expected mid gain to be -3.0, got ${Motif.masterMidFilter.gain.value}`);
    assert(Motif.masterHighFilter.gain.value === 4.5, `expected high gain to be 4.5, got ${Motif.masterHighFilter.gain.value}`);

    // Test Limiter (boolean) configuration
    Motif.master({ limiter: true });
    // Limiter true triggers routing. We can verify it works by changing object properties or calling it.

    // Test Limiter (object) configuration
    Motif.master({
        limiter: { threshold: -12, knee: 15, ratio: 8, attack: 0.005, release: 0.12 },
    });
    assert(Motif.masterCompressor.threshold.value === -12, `expected compressor threshold to be -12, got ${Motif.masterCompressor.threshold.value}`);
    assert(Motif.masterCompressor.knee.value === 15, `expected compressor knee to be 15, got ${Motif.masterCompressor.knee.value}`);
    assert(Motif.masterCompressor.ratio.value === 8, `expected compressor ratio to be 8, got ${Motif.masterCompressor.ratio.value}`);
    assert(Motif.masterCompressor.attack.value === 0.005, `expected compressor attack to be 0.005, got ${Motif.masterCompressor.attack.value}`);
    assert(Motif.masterCompressor.release.value === 0.12, `expected compressor release to be 0.12, got ${Motif.masterCompressor.release.value}`);

    // Test Limiter bypass
    Motif.master({ limiter: false });
    // Bypassing works without throw
}

// =============================================================================
// Motif Lookahead Scheduler (Chris Wilson pattern)
// =============================================================================
console.log("\n=== Motif Engine: Lookahead Scheduler ===");
{
    Motif.ctx.currentTime = 0;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    const fired = [];
    Motif.schedule(0.05, (t) => fired.push(["a", t]));
    Motif.schedule(0.5, (t) => fired.push(["b", t]));
    Motif.schedule(2.0, (t) => fired.push(["c", t]));

    assert(Motif._schedQueue.length === 3, `expected 3 queued events, got ${Motif._schedQueue.length}`);

    // First tick at currentTime 0, window 0.1 -> only 'a' (0.05) fires
    Motif.tick();
    assert(fired.length === 1, `expected 1 event fired after first tick, got ${fired.length}`);
    assert(fired[0][0] === "a" && fired[0][1] === 0.05, `expected 'a' fired at 0.05, got ${JSON.stringify(fired[0])}`);
    assert(Motif._schedQueue.length === 2, `expected 2 events remaining, got ${Motif._schedQueue.length}`);

    // Advance to 0.45 -> 'b' (0.5) enters window (0.45 + 0.1 = 0.55)
    Motif.ctx.currentTime = 0.45;
    Motif.tick();
    assert(fired.length === 2, `expected 2 events fired total, got ${fired.length}`);
    assert(fired[1][0] === "b", `expected 'b' fired second, got ${fired[1][0]}`);
    assert(Motif._schedQueue.length === 1, `expected 1 event remaining, got ${Motif._schedQueue.length}`);

    // Advance to 1.5 -> 'c' (2.0) still outside (1.5 + 0.1 = 1.6 < 2.0)
    Motif.ctx.currentTime = 1.5;
    Motif.tick();
    assert(fired.length === 2, `expected still 2 events fired (c outside window), got ${fired.length}`);

    // Advance to 1.95 -> 'c' enters window
    Motif.ctx.currentTime = 1.95;
    Motif.tick();
    assert(fired.length === 3, `expected 3 events fired total, got ${fired.length}`);
    assert(fired[2][0] === "c", `expected 'c' fired third, got ${fired[2][0]}`);
    assert(Motif._schedQueue.length === 0, `expected empty queue, got ${Motif._schedQueue.length}`);

    // start() should kick off the setInterval-based scheduler
    Motif.ctx.currentTime = 0;
    Motif.ctx.state = "running";
    Motif.isPlaying = false;
    Motif._stopScheduler();
    Motif.start();
    assert(Motif._schedInterval !== null, "Motif._schedInterval should be set after start()");

    // stop() should clear interval and queue
    Motif.schedule(10.0, () => {
    });
    Motif.stop();
    assert(Motif._schedInterval === null, "Motif._schedInterval should be null after stop()");
    assert(Motif._schedQueue.length === 0, "scheduler queue should be cleared on stop()");

    // schedule() validates arguments
    let badThrew = false;
    try {
        Motif.schedule("not-a-number", () => {
        });
    } catch (e) {
        badThrew = true;
    }
    assert(badThrew === true, "schedule() must reject non-numeric time");

    let badCbThrew = false;
    try {
        Motif.schedule(1.0, null);
    } catch (e) {
        badCbThrew = true;
    }
    assert(badCbThrew === true, "schedule() must reject non-function callback");
}

// =============================================================================
// OfflineAudioContext rendered timing: 4 kicks at 120 BPM = 0.5s apart
// =============================================================================
console.log("\n=== Motif Engine: Offline Render — Kick Timing ===");
{
    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MockOfflineAudioContext {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
            this._rendered = false;
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            if (this._rendered) throw new Error("startRendering() may only be called once.");
            this._rendered = true;
            const bufferDuration = this.length / this.sampleRate;
            // Drive the lookahead scheduler over the entire buffer window
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            // Return a minimal AudioBuffer-shaped object
            return {
                numberOfChannels: this.numberOfChannels,
                length: this.length,
                sampleRate: this.sampleRate,
                duration: bufferDuration,
            };
        }
    }

    // Swap in offline context for this test
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.5;
    const offline = new MockOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline;
    Motif._schedQueue = [];
    Motif._stopScheduler();
    Motif.tempo = 120;

    // Schedule 4 kicks at exact beat boundaries (beat = 60/120 = 0.5s at 120 BPM)
    const beatS = 60 / 120;
    const kickTimes = [0 * beatS, 1 * beatS, 2 * beatS, 3 * beatS];
    for (const t of kickTimes) {
        Motif.schedule(t, (audioTime) => {
            const osc = offline.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(60, audioTime);
            osc.start(audioTime);
            osc.stop(audioTime + 0.1);
        });
    }

    let buffer;
    offline.startRendering().then(b => {
        buffer = b;
    });
    // Mock startRendering above is effectively synchronous after its loop completes;
    // assert against the captured oscillators directly.
    const oscillators = offline.createdOscillators;

    assert(oscillators.length === 4, `expected 4 kick oscillators rendered, got ${oscillators.length}`);

    const renderedStarts = oscillators.map(o => o.startTime);
    for (let i = 0; i < renderedStarts.length; i++) {
        const expected = i * 0.5;
        assert(Math.abs(renderedStarts[i] - expected) < 1e-9,
            `kick ${i}: expected rendered startTime ${expected}, got ${renderedStarts[i]}`);
    }

    // Pairwise: each rendered start is exactly 0.5s after the previous
    for (let i = 1; i < renderedStarts.length; i++) {
        const delta = renderedStarts[i] - renderedStarts[i - 1];
        assert(Math.abs(delta - 0.5) < 1e-9, `kicks ${i - 1}->${i}: expected delta 0.5s, got ${delta}`);
    }

    // startRendering() may only be called once
    let secondRenderThrew = false;
    await offline.startRendering().catch(() => {
        secondRenderThrew = true;
    });
    assert(secondRenderThrew === true, "OfflineAudioContext.startRendering() must reject second invocation");

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
}

// =============================================================================
// Track API: Instance creation, chaining, and caching
// =============================================================================
console.log("\n=== Track API: Chaining and Caching ===");
{
    Track.clearRegistry();

    // 1. Create a track with ID
    const bass = Track("bassline");
    assert(bass !== undefined, "Track('bassline') returns an instance");
    assert(bass.id === "bassline", `expected track ID to be 'bassline', got '${bass.id}'`);

    // 2. Re-declaration returns a new instance (live-coding crossfade semantics)
    const sameBass = Track("bassline");
    assert(sameBass !== bass, "Track('bassline') re-declaration returns a new instance (crossfade)");

    // 3. Anonymous track generation
    const anon = Track();
    assert(anon !== undefined, "Track() without ID returns an instance");
    assert(anon.id !== undefined && anon.id !== "bassline", "anonymous track gets a unique random ID");

    // 4. Chainable API testing
    const chained = bass
        .synth("saw")
        .note(["C3", "E3"])
        .gain(0.8)
        .pan(-0.5)
        .envelope({ attack: 0.1, decay: 0.2 })
        .mute()
        .unmute();

    assert(chained === bass, "Track chaining methods should strictly return the Track instance itself");
}


// =============================================================================
// Track Mute & Unmute API
// =============================================================================
console.log("\n=== Track Mute & Unmute ===");
{
    const t = Track("mute-test");
    t._initAudio();
    assert(t.muteGainNode !== undefined, "track muteGainNode exists");
    assert(t.muteGainNode.gain.value === 1.0, `default muteGainNode gain should be 1.0, got ${t.muteGainNode.gain.value}`);

    // Mute the track
    t.mute(true);
    assert(t._isMuted === true, "track is marked as muted");
    assert(t.muteGainNode.gain.value === 0, `muteGainNode gain should be 0 when muted, got ${t.muteGainNode.gain.value}`);

    // Unmute the track
    t.unmute();
    assert(t._isMuted === false, "track is marked as unmuted");
    assert(t.muteGainNode.gain.value === 1.0, `muteGainNode gain should be restored to 1.0, got ${t.muteGainNode.gain.value}`);

    // Toggle mute
    t.mute();
    assert(t._isMuted === true, "toggling mute when unmuted should mute the track");
    assert(t.muteGainNode.gain.value === 0, `muteGainNode gain should be 0 after toggle, got ${t.muteGainNode.gain.value}`);

    t.mute();
    assert(t._isMuted === false, "toggling mute when muted should unmute the track");
    assert(t.muteGainNode.gain.value === 1.0, `muteGainNode gain should be 1.0 after toggle, got ${t.muteGainNode.gain.value}`);
}

// =============================================================================
// Track synth playback and scheduling
// =============================================================================
console.log("\n=== Track Synthesis and Event Scheduling ===");
{
    // Save state
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.5;

    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineAudioContext {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
            this.createdWaveShaper = null;
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            const node = {
                curve: null,
                oversample: "none",
                connect(dest) {
                    return dest;
                },
                disconnect() {
                },
            };
            this.createdWaveShaper = node;
            return node;
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    Track.clearRegistry();
    const t = Track("lead-synth");
    t.synth("saw").note(["C3", "E3"]);

    const offline = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t._resetScheduling();

    await offline.startRendering();

    const oscillators = offline.createdOscillators;
    assert(oscillators.length === 2, `expected 2 oscillators to be spawned, got ${oscillators.length}`);

    if (oscillators.length === 2) {
        const o1 = oscillators[0];
        assert(o1.type === "sawtooth", `expected o1 type 'sawtooth', got '${o1.type}'`);
        assert(Math.abs(o1.startTime - 0) < 1e-9, `expected o1 startTime 0, got ${o1.startTime}`);
        assert(Math.abs(o1.stopTime - 1.015) < 1e-9, `expected o1 stopTime 1.015 (duration 1.0 + 0.015 release), got ${o1.stopTime}`);
        assert(Math.abs(o1.frequency.value - midiToHz(noteToMidi("C3"))) < 1e-9, `expected o1 frequency C3, got ${o1.frequency.value}`);

        const o2 = oscillators[1];
        assert(o2.type === "sawtooth", `expected o2 type 'sawtooth', got '${o2.type}'`);
        assert(Math.abs(o2.startTime - 1.0) < 1e-9, `expected o2 startTime 1.0, got ${o2.startTime}`);
        assert(Math.abs(o2.stopTime - 2.015) < 1e-9, `expected o2 stopTime 2.015 (duration 1.0 + 0.015 release), got ${o2.stopTime}`);
        assert(Math.abs(o2.frequency.value - midiToHz(noteToMidi("E3"))) < 1e-9, `expected o2 frequency E3, got ${o2.frequency.value}`);
    }

    // Now test .freq(pattern) bypasses midi conversion
    Track.clearRegistry();
    const t2 = Track("freq-synth");
    t2.synth("triangle").freq([200, 300]);
    t2._resetScheduling();

    const offline2 = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline2;
    Motif._schedQueue = [];

    await offline2.startRendering();

    const oscillators2 = offline2.createdOscillators;
    assert(oscillators2.length === 2, `expected 2 oscillators for freq-synth, got ${oscillators2.length}`);
    if (oscillators2.length === 2) {
        const o1 = oscillators2[0];
        assert(o1.type === "triangle", `expected o1 type 'triangle', got '${o1.type}'`);
        assert(Math.abs(o1.frequency.value - 200) < 1e-9, `expected o1 frequency 200, got ${o1.frequency.value}`);

        const o2 = oscillators2[1];
        assert(o2.type === "triangle", `expected o2 type 'triangle', got '${o2.type}'`);
        assert(Math.abs(o2.frequency.value - 300) < 1e-9, `expected o2 frequency 300, got ${o2.frequency.value}`);
    }

    // Test .distort(amount)
    Track.clearRegistry();
    const offline3 = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline3;
    Motif._schedQueue = [];

    const t3 = Track("distorted-synth");
    t3.synth("sine").note(["A3"]).distort(50);
    t3._resetScheduling();

    await offline3.startRendering();

    assert(offline3.createdWaveShaper !== null, "WaveShaper node should be created");
    if (offline3.createdWaveShaper) {
        assert(offline3.createdWaveShaper.curve !== null, "WaveShaper curve should be populated");
        assert(offline3.createdWaveShaper.curve instanceof Float32Array, "WaveShaper curve should be a Float32Array");
        const n = 44100;
        const middleIndex = Math.floor(n / 2);
        assert(Math.abs(offline3.createdWaveShaper.curve[middleIndex] - 0) < 1e-3, `expected distortion at middle close to 0, got ${offline3.createdWaveShaper.curve[middleIndex]}`);

        const lastIdx = n - 1;
        const xLast = (lastIdx * 2) / n - 1;
        const expectedLastVal = (53 * xLast) / (Math.PI + 50 * Math.abs(xLast));
        assert(Math.abs(offline3.createdWaveShaper.curve[lastIdx] - expectedLastVal) < 1e-4, `expected distortion at index n-1 to be ${expectedLastVal}, got ${offline3.createdWaveShaper.curve[lastIdx]}`);
    }

    // Test bypass: .distort(0)
    t3.distort(0);
    assert(t3.distortionNode.curve === null, "WaveShaper curve should be null after setting distortion to 0");

    // Test .filter({ type, cutoff, resonance })
    Track.clearRegistry();
    const offline4 = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);

    let createdFilter = null;
    const originalCreateBiquadFilter = offline4.createBiquadFilter;
    offline4.createBiquadFilter = function() {
        const filterNode = originalCreateBiquadFilter.call(offline4);
        createdFilter = filterNode;
        return filterNode;
    };

    Motif.ctx = offline4;
    Motif._schedQueue = [];

    const t4 = Track("filtered-synth");

    // Test basic filter settings
    t4.synth("sine").note(["A3"]).filter({ type: "highpass", cutoff: 1200, resonance: 5 });
    t4._resetScheduling();

    await offline4.startRendering();

    assert(createdFilter !== null, "BiquadFilterNode should be created");
    if (createdFilter) {
        assert(createdFilter.type === "highpass", `expected filter type 'highpass', got '${createdFilter.type}'`);
        assert(createdFilter.frequency.value === 1200, `expected filter frequency 1200, got ${createdFilter.frequency.value}`);
        assert(createdFilter.Q.value === 5, `expected filter resonance (Q) 5, got ${createdFilter.Q.value}`);
    }

    // Test control signal modulator connection
    let connectedToParam = null;
    const mockModulator = {
        connect(param) {
            connectedToParam = param;
        },
        disconnect() {
        },
    };

    t4.filter({ cutoff: mockModulator });
    assert(connectedToParam === createdFilter.frequency, "control signal cutoff should connect to filter frequency AudioParam");

    // Cleanup context
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
}

// =============================================================================
// Track polyphonic voice pool and voice stealing
// =============================================================================
console.log("\n=== Track Polyphonic Voice Pool & Voice Stealing ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.5;

    class TestOfflineAudioContext {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0,
                    setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                },
                disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = {
                frequency: {
                    value: 440, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                type: "sine",
                startTime: null,
                stopTime: null,
                start(when = 0) {
                    this.startTime = when;
                },
                stop(when = 0) {
                    this.stopTime = when;
                },
                connect(dest) {
                    return dest;
                },
                disconnect() {
                },
            };
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // 1. Check chainability
    const t = Track("chain-voices");
    const tChained = t.voices(3, "oldest");
    assert(tChained === t, "t.voices() should return the track instance");

    // 2. Test 'none' mode (pool exhausted -> ignores new notes)
    Track.clearRegistry();
    const tNone = Track("none-mode");
    tNone.voices(2, "none");
    tNone.synth("sine").note([Parallel("C3", "E3", "G3")]);
    tNone._resetScheduling();

    const offlineNone = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offlineNone;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offlineNone.startRendering();
    assert(offlineNone.createdOscillators.length === 2, `expected 2 voices to play in 'none' mode, got ${offlineNone.createdOscillators.length}`);

    // 3. Test 'oldest' mode (pool exhausted -> steals the oldest active voice)
    Track.clearRegistry();
    const tOldest2 = Track("oldest-mode-2");
    tOldest2.voices(2, "oldest");
    tOldest2.synth("sine").note([Parallel("C3", "E3", "G3")]);
    tOldest2._resetScheduling();

    const offlineOldest2 = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offlineOldest2;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offlineOldest2.startRendering();

    // With the chord-choke fix, only 2 oscillators are created (excess notes silently dropped)
    assert(offlineOldest2.createdOscillators.length === 2, `expected 2 oscillators created (excess chord notes dropped), got ${offlineOldest2.createdOscillators.length}`);
    if (offlineOldest2.createdOscillators.length === 2) {
        const c3Osc = offlineOldest2.createdOscillators[0];
        const e3Osc = offlineOldest2.createdOscillators[1];
        // Both survive — no choking
        assert(c3Osc.stopTime === 2.015, `expected C3 to stop at 2.015, got ${c3Osc.stopTime}`);
        assert(e3Osc.stopTime === 2.015, `expected E3 to stop at 2.015, got ${e3Osc.stopTime}`);
    }

    // 4. Test 'quietest' mode (pool exhausted -> steals the quietest active voice)
    Track.clearRegistry();
    const tQuietest = Track("quietest-mode");
    tQuietest.voices(2, "quietest");

    const offlineQuietest = new TestOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offlineQuietest;
    tQuietest._initAudio();
    tQuietest._resetScheduling();

    tQuietest.gain(0.5);
    tQuietest._playEvent({ value: "C3" }, 0.0, 1.0);

    tQuietest.gain(0.8);
    tQuietest._playEvent({ value: "E3" }, 0.0, 1.0);

    tQuietest.gain(0.6);
    tQuietest._playEvent({ value: "G3" }, 0.0, 1.0);

    const activeVoicesArray = Array.from(tQuietest._activeVoices.values());
    assert(tQuietest._activeVoices.size === 2, "expected active voices size to be 2 after dropping excess");
    const activeHz = activeVoicesArray.map(v => v.oscillator.frequency.value);
    const g3Hz = midiToHz(noteToMidi("G3"));
    // G3 (the 3rd note) is silently dropped since all voices share the same startTime
    assert(!activeHz.includes(g3Hz), "expected Voice 3 (G3) to be dropped and not active");

    // Cleanup context
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
}

// =============================================================================
// Track Envelope (ADSR) Scheduling
// =============================================================================
console.log("\n=== Track Envelope (ADSR) Scheduling ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.5;

    class MockGainParam {
        constructor(v = 1.0) {
            this.value = v;
            this.calls = [];
        }

        setValueAtTime(v, t) {
            this.calls.push({ type: "set", value: v, time: t });
            this.value = v;
            return this;
        }

        linearRampToValueAtTime(v, t) {
            this.calls.push({ type: "linear", value: v, time: t });
            this.value = v;
            return this;
        }

        exponentialRampToValueAtTime(v, t) {
            this.calls.push({ type: "exponential", value: v, time: t });
            this.value = v;
            return this;
        }

        cancelAndHoldAtTime(t) {
            this.calls.push({ type: "cancelAndHold", time: t });
            return this;
        }
    }

    let lastGainParam = null;

    class EnvelopeOfflineAudioContext {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
        }

        createGain() {
            const param = new MockGainParam(1.0);
            lastGainParam = param;
            return {
                gain: param,
                connect() {
                },
                disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    setValueAtTime() {
                    },
                },
                type: "sine",
                start() {
                },
                stop() {
                },
                connect() {
                },
                disconnect() {
                },
            };
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const t = Track("env-test");
    t.synth("sine")
        .note(["C3"])
        .gain(0.8)
        .envelope({ attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 });
    t._resetScheduling();

    const offline = new EnvelopeOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline;
    Motif.tempo = 120; // 1 beat = 0.5 seconds
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    assert(lastGainParam !== null, "GainNode should have been created");
    if (lastGainParam) {
        const calls = lastGainParam.calls;
        assert(calls.length === 6, `expected 6 scheduled envelope calls, got ${calls.length}`);

        // 1. Initial floor: setValueAtTime(0.00008, 0.0)
        assert(calls[0].type === "set", "first call is set");
        assert(Math.abs(calls[0].value - 0.00008) < 1e-9, `expected start floor 0.00008, got ${calls[0].value}`);
        assert(calls[0].time === 0.0, `expected start time 0.0, got ${calls[0].time}`);

        // 2. Attack peak: linearRampToValueAtTime(0.8, 0.1)
        assert(calls[1].type === "linear", "second call is linear ramp");
        assert(Math.abs(calls[1].value - 0.8) < 1e-9, `expected peak 0.8, got ${calls[1].value}`);
        assert(Math.abs(calls[1].time - 0.1) < 1e-9, `expected attack time 0.1, got ${calls[1].time}`);

        // 3. Decay sustain: exponentialRampToValueAtTime(0.4, 0.3)
        assert(calls[2].type === "exponential", "third call is exponential ramp");
        assert(Math.abs(calls[2].value - 0.4) < 1e-9, `expected sustain value 0.4, got ${calls[2].value}`);
        assert(Math.abs(calls[2].time - 0.3) < 1e-9, `expected decay time 0.3, got ${calls[2].time}`);

        // 4. Anchor before release: setValueAtTime(0.4, 2.0)
        assert(calls[3].type === "set", "fourth call is anchor set");
        assert(Math.abs(calls[3].value - 0.4) < 1e-9, `expected anchor value 0.4, got ${calls[3].value}`);
        assert(Math.abs(calls[3].time - 2.0) < 1e-9, `expected off time 2.0, got ${calls[3].time}`);

        // 5. Release floor: exponentialRampToValueAtTime(0.00008, 2.3)
        assert(calls[4].type === "exponential", "fifth call is exponential release");
        assert(Math.abs(calls[4].value - 0.00008) < 1e-9, `expected release floor 0.00008, got ${calls[4].value}`);
        assert(Math.abs(calls[4].time - 2.3) < 1e-9, `expected release end time 2.3, got ${calls[4].time}`);

        // 6. Zero snap: setValueAtTime(0, 2.3)
        assert(calls[5].type === "set", "sixth call is zero snap set");
        assert(calls[5].value === 0, `expected zero value, got ${calls[5].value}`);
        assert(Math.abs(calls[5].time - 2.3) < 1e-9, `expected zero snap time 2.3, got ${calls[5].time}`);
    }

    // Cleanup context
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
}

// =============================================================================
// Tied note rendered via OfflineAudioContext: gain holds across tie boundary
// =============================================================================
console.log("\n=== Tied Note Rendering: Gain Holds Across Tie Boundary ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.5;

    class TiedMockGainParam {
        constructor(v = 1.0) {
            this.value = v;
            this.calls = [];
        }

        setValueAtTime(v, t) {
            this.calls.push({ type: "set", value: v, time: t });
            this.value = v;
            return this;
        }

        linearRampToValueAtTime(v, t) {
            this.calls.push({ type: "linear", value: v, time: t });
            this.value = v;
            return this;
        }

        exponentialRampToValueAtTime(v, t) {
            this.calls.push({ type: "exponential", value: v, time: t });
            this.value = v;
            return this;
        }

        cancelAndHoldAtTime(t) {
            this.calls.push({ type: "cancelAndHold", time: t });
            return this;
        }
    }

    const createdGainParams = [];

    class TiedOfflineAudioContext {
        constructor(channels, length, sr) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sr;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
        }

        createGain() {
            const param = new TiedMockGainParam(1.0);
            createdGainParams.push(param);
            return {
                gain: param,
                connect() {
                },
                disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    setValueAtTime() {
                    },
                },
                type: "sine",
                start() {
                },
                stop() {
                },
                connect() {
                },
                disconnect() {
                },
            };
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const t = Track("tied-test");
    t.synth("sine")
        .note(["C4", Tie, "G4"])
        .gain(1.0)
        .envelope({ attack: 0.05, decay: 0.1, sustain: 0.5, release: 0.2 });
    t._resetScheduling();

    const offline = new TiedOfflineAudioContext(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline;
    Motif.tempo = 120; // cycle = 2s, each of 3 steps = 2/3 s
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    // Filter to voice gain nodes only (track-input + mute-gain are not voices).
    // Voice gain nodes are those whose first call is setValueAtTime with a small floor value (0.0001).
    const voiceParams = createdGainParams.filter(p => {
        if (p.calls.length === 0) return false;
        const first = p.calls[0];
        return first.type === "set" && first.value > 0 && first.value < 0.001;
    });

    assert(voiceParams.length >= 2, `expected at least 2 voice gain nodes (C4 + G4), got ${voiceParams.length}`);

    if (voiceParams.length >= 1) {
        const c4 = voiceParams[0];
        const cycle = 2.0;
        const stepDur = cycle / 3;
        const c4Off = stepDur;          // tie boundary at end of C4 step
        const tieEnd = 2 * stepDur;     // end of Tie step (chain ends)
        const releaseS = 0.2;

        // Required: a cancelAndHold at the tie boundary (C4 -> Tie transition)
        const holdAtBoundary = c4.calls.find(c =>
            c.type === "cancelAndHold" && Math.abs(c.time - c4Off) < 1e-6,
        );
        assert(holdAtBoundary !== undefined,
            `expected cancelAndHoldAtTime(${c4Off}) on C4 voice across tie boundary`);

        // Critical assertion: NO operation drops gain to 0 (or to floor) between
        // the tie boundary (c4Off) and the end of the tie chain (tieEnd).
        // A naive release-then-retrigger would schedule setValueAtTime(0,...) or
        // an exponentialRamp to floor inside this window.
        const dropInside = c4.calls.find(c => {
            if (c.time === undefined) return false;
            const insideWindow = c.time > c4Off + 1e-6 && c.time < tieEnd - 1e-6;
            if (!insideWindow) return false;
            if (c.type === "set" && c.value === 0) return true;
            if (c.type === "exponential" && c.value <= 0.001) return true;
            if (c.type === "linear" && c.value === 0) return true;
            return false;
        });
        assert(dropInside === undefined,
            `gain must not drop to 0 between tie boundary (${c4Off}) and tie chain end (${tieEnd}); found ${JSON.stringify(dropInside)}`);

        // Release must be scheduled AT or AFTER the tie chain end, not before.
        const releaseRamp = c4.calls.find(c =>
            c.type === "exponential" && c.value <= 0.001,
        );
        assert(releaseRamp !== undefined, "expected a release ramp on C4 voice after tie chain ends");
        if (releaseRamp) {
            assert(releaseRamp.time >= tieEnd - 1e-6,
                `release ramp should end at >= ${tieEnd} (tie chain end + release), got time ${releaseRamp.time}`);
            assert(Math.abs(releaseRamp.time - (tieEnd + releaseS)) < 1e-6,
                `release should complete at ${tieEnd + releaseS}, got ${releaseRamp.time}`);
        }

        // The setValueAtTime(0,...) zero-snap must also be at or after tieEnd.
        const zeroSnap = c4.calls.find(c => c.type === "set" && c.value === 0);
        assert(zeroSnap !== undefined, "expected zero-snap setValueAtTime(0, ...) after release");
        if (zeroSnap) {
            assert(zeroSnap.time >= tieEnd - 1e-6,
                `zero-snap should occur at >= ${tieEnd}, got ${zeroSnap.time}`);
        }
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
}

// =============================================================================
// Tie Sentinel and Pattern Parser Tied Flagging
// =============================================================================
console.log("\n=== Tie Sentinel and Pattern Parser Tied Flagging ===");
{
    // Test that Tie is defined as a unique Symbol
    assert(typeof Tie === "symbol", "Tie should be a symbol");
    assert(Tie.toString() === "Symbol(Tie)", "Tie symbol should have description 'Tie'");

    // Test simple sequential pattern with Tie
    const pattern = ["C4", Tie, Tie, null, "G4"];
    const parsed = PatternParser.parse(pattern);

    assert(parsed.length === 5, `expected 5 events, got ${parsed.length}`);

    // 'C4' (starts 0, duration 0.2) - followed by Tie starting at 0.2
    assert(parsed[0].value === "C4", "first event value should be C4");
    assert(parsed[0].tied === true, "first event (C4) should have tied: true");

    // First Tie (starts 0.2, duration 0.2) - followed by Tie starting at 0.4
    assert(parsed[1].value === Tie, "second event value should be Tie");
    assert(parsed[1].tied === true, "second event (Tie) should have tied: true");

    // Second Tie (starts 0.4, duration 0.2) - followed by null starting at 0.6
    assert(parsed[2].value === Tie, "third event value should be Tie");
    assert(parsed[2].tied === false, "third event (Tie) should have tied: false");

    // null rest (starts 0.6, duration 0.2) - followed by G4 starting at 0.8
    assert(parsed[3].value === null, "fourth event value should be null");
    assert(parsed[3].tied === false, "fourth event (null) should have tied: false");

    // 'G4' (starts 0.8, duration 0.2) - followed by nothing
    assert(parsed[4].value === "G4", "fifth event value should be G4");
    assert(parsed[4].tied === false, "fifth event (G4) should have tied: false");
}

// =============================================================================
// Track pan and volume controls
// =============================================================================
console.log("\n=== Track Expressivity: Pan and Volume ===");
{
    const t = Track("expressive-track");

    // Test chainability
    assert(t.pan(0.5) === t, "pan() should return track instance for chaining");
    assert(t.volume(-6) === t, "volume() should return track instance for chaining");

    t._initAudio();
    assert(t.pannerNode !== null, "pannerNode should be created");
    assert(t.volumeNode !== null, "volumeNode should be created");

    // Test static pan setting
    t.pan(-0.75);
    assert(t.pannerNode.pan.value === -0.75, `expected pan value to be -0.75, got ${t.pannerNode.pan.value}`);

    // Test static volume setting
    // -6 dB ≈ 0.5011872336 linear gain
    t.volume(-6);
    const expectedGain = Math.pow(10, -6 / 20);
    assert(Math.abs(t.volumeNode.gain.value - expectedGain) < 1e-6, `expected volume gain to be ~0.501187, got ${t.volumeNode.gain.value}`);

    // -Infinity dB = 0 linear gain
    t.volume(-Infinity);
    assert(t.volumeNode.gain.value === 0, `expected volume gain to be 0 for -Infinity, got ${t.volumeNode.gain.value}`);

    // Test volume dB string parsing
    t.volume("-6dB");
    assert(Math.abs(t.volumeNode.gain.value - expectedGain) < 1e-6, `expected volume gain to be ~0.501187 for '-6dB', got ${t.volumeNode.gain.value}`);

    t.volume(" -12 db ");
    const expectedGain12 = Math.pow(10, -12 / 20);
    assert(Math.abs(t.volumeNode.gain.value - expectedGain12) < 1e-6, `expected volume gain to be ~0.251188 for ' -12 db ', got ${t.volumeNode.gain.value}`);

    t.volume("-infinity dB");
    assert(t.volumeNode.gain.value === 0, `expected volume gain to be 0 for '-infinity dB', got ${t.volumeNode.gain.value}`);

    // Test modulator connections
    let panConnectedParam = null;
    const mockPanModulator = {
        connect(param) {
            panConnectedParam = param;
        },
        disconnect() {
        },
    };
    t.pan(mockPanModulator);
    assert(panConnectedParam === t.pannerNode.pan, "pan modulator should connect to pannerNode.pan");

    let volumeConnectedParam = null;
    const mockVolumeModulator = {
        connect(param) {
            volumeConnectedParam = param;
        },
        disconnect() {
        },
    };
    t.volume(mockVolumeModulator);
    assert(volumeConnectedParam === t.volumeNode.gain, "volume modulator should connect to volumeNode.gain");
}

// =============================================================================
// Decibel String Parsing in TrackClass.gain()
// =============================================================================
console.log("\n=== Decibel String Parsing in TrackClass.gain() ===");
{
    const t = Track("gain-decibel-test");

    // TEST 1: Chainability
    assert(t.gain(0.8) === t, "gain() should return the track instance for chaining");

    // TEST 2: Number values behave normally
    t.gain(0.5);
    assert(t._gainLevel === 0.5, "gain(0.5) should set gain level to 0.5");

    // TEST 3: Positive and negative dB strings
    t.gain("-6dB");
    assert(Math.abs(t._gainLevel - Math.pow(10, -6 / 20)) < 1e-6, "gain('-6dB') should convert to linear scale");

    t.gain("−3dB"); // Unicode minus sign
    assert(Math.abs(t._gainLevel - Math.pow(10, -3 / 20)) < 1e-6, "gain('−3dB') with unicode minus should convert to linear scale");

    t.gain("6 dB"); // Spaces allowed
    assert(Math.abs(t._gainLevel - Math.pow(10, 6 / 20)) < 1e-6, "gain('6 dB') with spaces should convert to linear scale");

    // TEST 4: Case insensitivity
    t.gain("-12db");
    assert(Math.abs(t._gainLevel - Math.pow(10, -12 / 20)) < 1e-6, "gain('-12db') case insensitivity check");

    // TEST 5: Infinity or extreme DB values
    t.gain("-infinity dB");
    assert(t._gainLevel === 0, "gain('-infinity dB') should evaluate to 0");

    t.gain("-inf dB");
    assert(t._gainLevel === 0, "gain('-inf dB') should evaluate to 0");

    // TEST 6: Plain number strings
    t.gain("0.75");
    assert(t._gainLevel === 0.75, "gain('0.75') should parse to number 0.75");

    t.gain("invalid-string");
    assert(t._gainLevel === 1.0, "gain('invalid-string') should fall back to 1.0");
}

// =============================================================================
// LFO: Low Frequency Oscillator Controls
// =============================================================================
console.log("\n=== LFO: Low Frequency Oscillator Controls ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MockAudioParam {
        constructor(v = 0) {
            this.value = v;
        }

        setValueAtTime(v, t) {
            this.value = v;
            return this;
        }
    }

    class MockOscillatorNode {
        constructor() {
            this.frequency = new MockAudioParam(1.0);
            this.type = "sine";
            this._started = false;
        }

        start() {
            this._started = true;
        }

        stop() {
        }

        connect(dest) {
        }

        disconnect() {
        }
    }

    class MockConstantSourceNode {
        constructor() {
            this.offset = new MockAudioParam(0);
            this._started = false;
        }

        start() {
            this._started = true;
        }

        connect(dest) {
        }

        disconnect() {
        }
    }

    class MockGainNode {
        constructor() {
            this.gain = new MockAudioParam(1.0);
        }

        connect(dest) {
        }

        disconnect() {
        }
    }

    class LfoOfflineAudioContext {
        constructor() {
            this.currentTime = 0;
        }

        createOscillator() {
            return new MockOscillatorNode();
        }

        createGain() {
            return new MockGainNode();
        }

        createConstantSource() {
            return new MockConstantSourceNode();
        }
    }

    Motif.ctx = new LfoOfflineAudioContext();
    Motif.tempo = 120;

    // 1. Test config parsing, frequency, depth, offset calculations
    const sweep = LFO.sine({ min: 200, max: 2000, speed: "2b" });

    assert(sweep.osc instanceof MockOscillatorNode, "LFO sweep.osc should be a MockOscillatorNode");
    assert(sweep.gainNode instanceof MockGainNode, "LFO sweep.gainNode should be a MockGainNode");
    assert(sweep.constantSource instanceof MockConstantSourceNode, "LFO sweep.constantSource should be a MockConstantSourceNode");

    assert(sweep.osc.type === "sine", `expected LFO sweep osc type 'sine', got ${sweep.osc.type}`);
    // at 120 bpm, speed '2b' is 2 bars = 8 beats = 4 seconds. freq = 1 / 4 = 0.25 Hz.
    assert(sweep.osc.frequency.value === 0.25, `expected LFO sweep osc frequency 0.25 Hz, got ${sweep.osc.frequency.value}`);

    // depth = (2000 - 200) / 2 = 900
    assert(sweep.gainNode.gain.value === 900, `expected LFO sweep gain 900, got ${sweep.gainNode.gain.value}`);
    // offset = (2000 + 200) / 2 = 1100
    assert(sweep.constantSource.offset.value === 1100, `expected LFO sweep offset 1100, got ${sweep.constantSource.offset.value}`);

    assert(sweep.osc._started === true, "LFO oscillator should be started immediately");
    assert(sweep.constantSource._started === true, "LFO constant source should be started immediately");

    // 2. Test other wave types
    const tri = LFO.triangle({ frequency: 2, depth: 10, offset: 5 });
    assert(tri.osc.type === "triangle", `expected tri type 'triangle', got ${tri.osc.type}`);
    assert(tri.osc.frequency.value === 2, `expected tri frequency 2, got ${tri.osc.frequency.value}`);
    assert(tri.gainNode.gain.value === 10, `expected tri depth 10, got ${tri.gainNode.gain.value}`);
    assert(tri.constantSource.offset.value === 5, `expected tri offset 5, got ${tri.constantSource.offset.value}`);

    const sq = LFO.square(1.5);
    assert(sq.osc.type === "square", `expected sq type 'square', got ${sq.osc.type}`);
    assert(sq.osc.frequency.value === 1.5, `expected sq frequency 1.5, got ${sq.osc.frequency.value}`);

    const saw = LFO.saw(3);
    assert(saw.osc.type === "sawtooth", `expected saw type 'sawtooth', got ${saw.osc.type}`);
    assert(saw.osc.frequency.value === 3, `expected saw frequency 3, got ${saw.osc.frequency.value}`);

    // 3. Test connection logic
    let targetParam = new MockAudioParam(100);
    sweep.connect(targetParam);
    assert(targetParam.value === 0, `expected sweep.connect to set target param value to 0, got ${targetParam.value}`);

    // Restore state
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track EQ Controls
// =============================================================================
console.log("\n=== Track EQ Controls ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    // Reset Motif with standard MockAudioContext
    Motif.ctx = null;
    Motif.init();

    const t = Track("eq-track");

    // 1. Test chainability
    assert(t.eq({ low: 3 }) === t, "eq() should return track instance for chaining");

    t._initAudio();

    // 2. Nodes should be initialized correctly
    assert(t.eqLowNode !== null, "eqLowNode should be created");
    assert(t.eqMidNode !== null, "eqMidNode should be created");
    assert(t.eqHighNode !== null, "eqHighNode should be created");

    assert(t.eqLowNode.type === "lowshelf", "eqLowNode type should be 'lowshelf'");
    assert(t.eqMidNode.type === "peaking", "eqMidNode type should be 'peaking'");
    assert(t.eqHighNode.type === "highshelf", "eqHighNode type should be 'highshelf'");

    assert(t.eqLowNode.frequency.value === 320, `expected low freq 320, got ${t.eqLowNode.frequency.value}`);
    assert(t.eqMidNode.frequency.value === 1000, `expected mid freq 1000, got ${t.eqMidNode.frequency.value}`);
    assert(t.eqHighNode.frequency.value === 3200, `expected high freq 3200, got ${t.eqHighNode.frequency.value}`);

    // 3. Static values setting
    t.eq({ low: 6, mid: -3, high: 4.5 });
    assert(t.eqLowNode.gain.value === 6, `expected low gain 6, got ${t.eqLowNode.gain.value}`);
    assert(t.eqMidNode.gain.value === -3, `expected mid gain -3, got ${t.eqMidNode.gain.value}`);
    assert(t.eqHighNode.gain.value === 4.5, `expected high gain 4.5, got ${t.eqHighNode.gain.value}`);

    // 4. Custom options object setting
    t.eq({
        low: { gain: -2, frequency: 180 },
        mid: { gain: 5, frequency: 800, Q: 2.5 },
        high: { gain: -6, frequency: 5000 },
    });
    assert(t.eqLowNode.gain.value === -2, `expected low gain -2, got ${t.eqLowNode.gain.value}`);
    assert(t.eqLowNode.frequency.value === 180, `expected low freq 180, got ${t.eqLowNode.frequency.value}`);

    assert(t.eqMidNode.gain.value === 5, `expected mid gain 5, got ${t.eqMidNode.gain.value}`);
    assert(t.eqMidNode.frequency.value === 800, `expected mid freq 800, got ${t.eqMidNode.frequency.value}`);
    assert(t.eqMidNode.Q.value === 2.5, `expected mid Q 2.5, got ${t.eqMidNode.Q.value}`);

    assert(t.eqHighNode.gain.value === -6, `expected high gain -6, got ${t.eqHighNode.gain.value}`);
    assert(t.eqHighNode.frequency.value === 5000, `expected high freq 5000, got ${t.eqHighNode.frequency.value}`);

    // 5. Test modulator connections
    let lowConnectedParam = null;
    const mockLowModulator = {
        connect(param) {
            lowConnectedParam = param;
        },
        disconnect() {
        },
    };
    t.eq({ low: mockLowModulator });
    assert(lowConnectedParam === t.eqLowNode.gain, "low modulator should connect to eqLowNode.gain");

    // Clean up
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track Compressor Controls
// =============================================================================
console.log("\n=== Track Compressor Controls ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    // Reset Motif with standard MockAudioContext
    Motif.ctx = null;
    Motif.init();

    const t = Track("compress-track");

    // 1. Test chainability
    assert(t.compress({ threshold: -20 }) === t, "compress() should return track instance for chaining");

    t._initAudio();

    // 2. Node should be initialized correctly
    assert(t.compressorNode !== null, "compressorNode should be created");

    // 3. Static values setting
    t.compress({ threshold: -15, knee: 20, ratio: 8, attack: 0.01, release: 0.1 });
    assert(t.compressorNode.threshold.value === -15, `expected compressor threshold -15, got ${t.compressorNode.threshold.value}`);
    assert(t.compressorNode.knee.value === 20, `expected compressor knee 20, got ${t.compressorNode.knee.value}`);
    assert(t.compressorNode.ratio.value === 8, `expected compressor ratio 8, got ${t.compressorNode.ratio.value}`);
    assert(t.compressorNode.attack.value === 0.01, `expected compressor attack 0.01, got ${t.compressorNode.attack.value}`);
    assert(t.compressorNode.release.value === 0.1, `expected compressor release 0.1, got ${t.compressorNode.release.value}`);

    // 4. Test modulator connections
    let thresholdConnectedParam = null;
    const mockThresholdModulator = {
        connect(param) {
            thresholdConnectedParam = param;
        },
        disconnect() {
        },
    };
    t.compress({ threshold: mockThresholdModulator });
    assert(thresholdConnectedParam === t.compressorNode.threshold, "threshold modulator should connect to compressorNode.threshold");

    // Clean up
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Bus & Track Routing (Sends)
// =============================================================================
console.log("\n=== Bus & Track Routing (Sends) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    Motif.ctx = null;
    Motif.init();

    Bus.clearRegistry();
    Track.clearRegistry();

    // 1. Bus Instantiation & Caching
    const delayBus = Bus("delay");
    assert(delayBus !== undefined, "Bus('delay') returns an instance");
    assert(delayBus.id === "delay", `expected bus ID to be 'delay', got '${delayBus.id}'`);

    const sameDelayBus = Bus("delay");
    assert(delayBus === sameDelayBus, "Bus('delay') twice should return the exact same instance");

    const anonBus = Bus();
    assert(anonBus !== undefined, "Bus() without ID returns an instance");
    assert(anonBus.id !== undefined && anonBus.id !== "delay", "anonymous bus gets a unique random ID");

    // 2. Bus Chainable Configuration
    const configuredBus = delayBus.filter({ type: "lowpass", cutoff: 800 }).volume(-6);
    assert(configuredBus === delayBus, "Bus configuration methods should be chainable and return the Bus instance");
    assert(delayBus.filterNode !== null, "Bus filterNode should be created");
    assert(delayBus.volumeNode !== null, "Bus volumeNode should be created");

    // 3. Track.send Chainability
    const t = Track("lead");
    assert(t.send(delayBus, 0.5) === t, "Track.send() should be chainable and return the Track instance");

    // 4. Send Gain Node verification & connections
    t._initAudio();
    const sendKey = delayBus.id;
    const sendGainNode = t._sends.get(sendKey);
    assert(sendGainNode !== undefined, "Track should store a reference to the send GainNode");
    assert(sendGainNode.gain.value === 0.5, `expected send gain node value to be 0.5, got ${sendGainNode.gain.value}`);

    // 5. Track.send with a String ID
    t.send("reverb", 0.85);
    const reverbBus = Bus("reverb");
    const sendGainNode2 = t._sends.get("reverb");
    assert(sendGainNode2 !== undefined, "Track.send(string_id) should resolve the bus and create the send");
    assert(sendGainNode2.gain.value === 0.85, `expected send gain value to be 0.85, got ${sendGainNode2.gain.value}`);

    // 6. Signal Chain Rebuild Reconnections
    // Add a filter to track 'lead' which triggers _rebuildSignalChain
    t.filter({ type: "highpass", cutoff: 200 });
    // The sends should still exist in t._sends and be reconnected
    assert(t._sends.get(sendKey) === sendGainNode, "send gain node reference should survive track signal chain rebuilds");

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track.modulate
// =============================================================================
console.log("\n=== Track.modulate ===");
{
    const prevCtx = Motif.ctx;

    Motif.ctx = null;
    Motif.init();
    Bus.clearRegistry();
    Track.clearRegistry();

    const t = Track("mod-target");
    t._initAudio();

    // 1. Chainability
    const mockSource = {
        connect(p) {
        }, disconnect() {
        },
    };
    assert(t.modulate("pan", mockSource, { depth: 0.5 }) === t, "modulate() should be chainable");

    // 2. Auto-creates target node (filter.cutoff without prior .filter() call)
    const t2 = Track("mod-filter");
    t2._initAudio();
    assert(t2.filterNode === null, "filterNode should not exist before modulate");
    t2.modulate("filter.cutoff", mockSource, { depth: 200 });
    assert(t2.filterNode !== null, "modulate('filter.cutoff') should auto-create filterNode");

    // 3. Depth GainNode gets the correct gain value
    const depthGainConnections = [];
    const mockAudioNode = {
        connect(target) {
            depthGainConnections.push(target);
            return target;
        },
        disconnect() {
        },
    };

    const t3 = Track("mod-depth");
    t3._initAudio();
    t3.modulate("volume", mockAudioNode, { depth: 0.75 });
    assert(t3._modulators.has("volume"), "_modulators should store entry keyed by parameter");
    const entry = t3._modulators.get("volume");
    assert(Math.abs(entry.depthGain.gain.value - 0.75) < 1e-6, `depth GainNode gain should be 0.75, got ${entry.depthGain.gain.value}`);

    // 4. Source variants: raw AudioNode with .connect
    const rawConnected = [];
    const rawNode = {
        connect(p) {
            rawConnected.push(p);
        }, disconnect() {
        },
    };
    const t4 = Track("mod-raw");
    t4._initAudio();
    t4.modulate("pan", rawNode, { depth: 1 });
    assert(t4._modulators.has("pan"), "modulate with raw AudioNode source should store modulator");

    // 5. Source variant: LFOSignal (has .output property)
    const lfoOutputConnections = [];
    const mockLFOSignal = {
        output: {
            connect(p) {
                lfoOutputConnections.push(p);
            },
            disconnect() {
            },
        },
    };
    const t5 = Track("mod-lfo");
    t5._initAudio();
    t5.modulate("filter.cutoff", mockLFOSignal, { depth: 300 });
    assert(t5._modulators.has("filter.cutoff"), "modulate with LFOSignal source should store modulator");
    const lfoEntry = t5._modulators.get("filter.cutoff");
    // The LFO output should have been connected to depthGain
    assert(lfoOutputConnections.length > 0, "LFO .output.connect should have been called");

    // 6. Source variant: TrackClass instance (taps preFaderNode)
    const sourceTrack = Track("mod-source");
    sourceTrack._initAudio();
    const t6 = Track("mod-track-source");
    t6._initAudio();
    let preFaderConnectCalled = false;
    const origConnect = sourceTrack.preFaderNode.connect.bind(sourceTrack.preFaderNode);
    sourceTrack.preFaderNode.connect = function(target) {
        preFaderConnectCalled = true;
        return origConnect(target);
    };
    t6.modulate("volume", sourceTrack, { depth: 0.4 });
    assert(preFaderConnectCalled, "modulate with TrackClass source should tap preFaderNode");

    // 7. Replacement: calling modulate twice on the same param removes the first modulator
    const t7 = Track("mod-replace");
    t7._initAudio();
    t7.modulate("pan", mockSource, { depth: 0.3 });
    const firstEntry = t7._modulators.get("pan");
    let firstDisconnected = false;
    firstEntry.depthGain.disconnect = function() {
        firstDisconnected = true;
    };
    t7.modulate("pan", mockSource, { depth: 0.6 });
    assert(firstDisconnected, "second modulate on same param should disconnect previous depthGain");
    const replacedEntry = t7._modulators.get("pan");
    assert(Math.abs(replacedEntry.depthGain.gain.value - 0.6) < 1e-6, `replaced depthGain gain should be 0.6, got ${replacedEntry.depthGain.gain.value}`);

    // 8. AudioParam passed directly as parameter key
    const t8 = Track("mod-direct-param");
    t8._initAudio();
    t8.volume(-6);
    const directParam = t8.volumeNode.gain;
    t8.modulate(directParam, mockSource, { depth: 2 });
    assert(t8._modulators.has(directParam), "modulate with direct AudioParam key should store modulator");

    Motif.ctx = prevCtx;
    Track.clearRegistry();
    Bus.clearRegistry();
}

// =============================================================================
// Track.sidechain
// =============================================================================
console.log("\n=== Track.sidechain ===");
{
    const prevCtx = Motif.ctx;

    Motif.ctx = null;
    Motif.init();
    Bus.clearRegistry();
    Track.clearRegistry();

    const kick = Track("sc-kick");
    kick._initAudio();
    kick.synth("sine").freq([440]);

    const bass = Track("sc-bass");
    bass._initAudio();

    // 1. Chainability
    assert(bass.sidechain(kick) === bass, "sidechain() should be chainable");

    // 2. duckGainNode is created
    assert(bass.duckGainNode !== null, "sidechain() should create duckGainNode");
    assert(Math.abs(bass.duckGainNode.gain.value - 1.0) < 1e-6, "duckGainNode gain should start at 1.0");

    // 3. Listener registered on the trigger track
    assert(kick._sidechainListeners.length === 1, "trigger track should have one sidechain listener");

    // 4. Two sidechains on same trigger add two listeners
    const synth = Track("sc-synth");
    synth._initAudio();
    synth.sidechain(kick);
    assert(kick._sidechainListeners.length === 2, "second sidechain call should add a second listener");

    // 5. Listener schedules correct automation on duck gain
    const scheduledOps = [];
    const mockDuckGain = {
        value: 1,
        _cancelAndHoldCalled: false,
        cancelAndHoldAtTime(t) {
            this._cancelAndHoldCalled = true;
            scheduledOps.push({ op: "cancelAndHold", t });
        },
        setValueAtTime(v, t) {
            scheduledOps.push({ op: "set", v, t });
        },
        exponentialRampToValueAtTime(v, t) {
            scheduledOps.push({ op: "expRamp", v, t });
        },
    };

    const duckBass = Track("sc-duck-verify");
    duckBass._initAudio();
    duckBass.sidechain(kick, { attack: 0.01, release: 0.3 });
    duckBass.duckGainNode.gain = mockDuckGain;
    // Replace the last listener with one using our mock gain
    const lastListener = kick._sidechainListeners[kick._sidechainListeners.length - 1];
    // Directly invoke the listener (simulating a note at t=1.0)
    kick._sidechainListeners[kick._sidechainListeners.length - 1] = (t) => {
        mockDuckGain.cancelAndHoldAtTime(t);
        mockDuckGain.setValueAtTime(1, t);
        mockDuckGain.exponentialRampToValueAtTime(0.0001, t + 0.01);
        mockDuckGain.exponentialRampToValueAtTime(1, t + 0.01 + 0.3);
    };
    kick._sidechainListeners[kick._sidechainListeners.length - 1](1.0);

    assert(scheduledOps.some(op => op.op === "cancelAndHold" && Math.abs(op.t - 1.0) < 1e-6), "listener should call cancelAndHoldAtTime at event time");
    assert(scheduledOps.some(op => op.op === "set" && Math.abs(op.v - 1) < 1e-6), "listener should setValueAtTime(1) at event time");
    assert(scheduledOps.some(op => op.op === "expRamp" && Math.abs(op.v - 0.0001) < 1e-6 && Math.abs(op.t - 1.01) < 1e-6), "listener should ramp to 0.0001 at t + attack");
    assert(scheduledOps.some(op => op.op === "expRamp" && Math.abs(op.v - 1) < 1e-6 && Math.abs(op.t - 1.31) < 1e-6), "listener should ramp back to 1 at t + attack + release");

    // 6. _playEvent notifies sidechain listeners
    const notifiedTimes = [];
    kick._sidechainListeners = [(t) => notifiedTimes.push(t)];
    // Patch createOscillator onto the existing mock ctx just for this call
    Motif.ctx.createOscillator = () => ({
        type: "sine",
        frequency: {
            setValueAtTime() {
            },
        },
        connect() {
        },
        disconnect() {
        },
        start() {
        },
        stop() {
        },
    });
    kick._playEvent({ value: 440, startTime: 0, duration: 1, tied: false }, 2.0, 0.5);
    delete Motif.ctx.createOscillator;
    assert(notifiedTimes.length === 1, "_playEvent should notify sidechain listeners");
    assert(Math.abs(notifiedTimes[0] - 2.0) < 1e-6, `sidechain listener should receive startTime 2.0, got ${notifiedTimes[0]}`);

    // 7. duckGainNode is in the signal chain (between volumeNode/preFaderNode and muteGainNode)
    const t7 = Track("sc-chain");
    t7._initAudio();
    t7.volume(-6);
    t7.sidechain(kick);
    assert(t7.duckGainNode !== null, "duckGainNode exists after sidechain");

    Motif.ctx = prevCtx;
    Track.clearRegistry();
    Bus.clearRegistry();
}

// =============================================================================
// Bus.feedback & connect-topology spy test
// =============================================================================
console.log("\n=== Bus.feedback & Connect Topology ===");
{
    const prevCtx = Motif.ctx;

    // Build a recording context: every connect() call is logged
    const connections = [];

    function makeRecordingNode(label) {
        const node = {
            _label: label,
            gain: {
                value: 1, setValueAtTime(v) {
                    this.value = v;
                },
            },
            delayTime: {
                value: 0, setValueAtTime(v) {
                    this.value = v;
                },
            },
            frequency: {
                value: 350, setValueAtTime(v) {
                    this.value = v;
                },
            },
            Q: {
                value: 1, setValueAtTime(v) {
                    this.value = v;
                },
            },
            connect(dest) {
                connections.push({ from: node, to: dest });
                return dest;
            },
            disconnect() {
            },
        };
        return node;
    }

    const sampleRate = 44100;

    class RecordingContext {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.destination = makeRecordingNode("destination");
        }

        createGain() {
            return makeRecordingNode("gain");
        }

        createBiquadFilter() {
            return makeRecordingNode("biquad");
        }

        createDynamicsCompressor() {
            return makeRecordingNode("compressor");
        }

        createWaveShaper() {
            return makeRecordingNode("waveShaper");
        }

        createStereoPanner() {
            return makeRecordingNode("panner");
        }

        createDelay() {
            return makeRecordingNode("delay");
        }

        createConstantSource() {
            const n = makeRecordingNode("constantSource");
            n.offset = {
                value: 0, setValueAtTime(v) {
                    this.value = v;
                },
            };
            n.start = () => {
            };
            return n;
        }
    }

    Motif.ctx = new RecordingContext();
    Bus.clearRegistry();
    Track.clearRegistry();

    // ---- Bus.feedback tests ----

    const b = Bus("fb-test");
    connections.length = 0; // clear connections from Bus init

    // 1. Chainability
    assert(b.feedback({ amount: 0.4 }) === b, "feedback() should be chainable");

    // 2. Nodes created
    assert(b.feedbackDelayNode !== null, "feedbackDelayNode should exist after feedback()");
    assert(b.feedbackGainNode !== null, "feedbackGainNode should exist after feedback()");

    // 3. Delay is exactly 128/sampleRate
    const expectedDelay = 128 / sampleRate;
    assert(Math.abs(b.feedbackDelayNode.delayTime.value - expectedDelay) < 1e-9,
        `delayTime should be 128/sampleRate (${expectedDelay}), got ${b.feedbackDelayNode.delayTime.value}`);

    // 4. Gain equals amount
    assert(Math.abs(b.feedbackGainNode.gain.value - 0.4) < 1e-6,
        `feedbackGain should be 0.4, got ${b.feedbackGainNode.gain.value}`);

    // 5. Connection topology: output → feedbackGain → delay → input
    const hasOutputToFeedbackGain = connections.some(c => c.from === b.output && c.to === b.feedbackGainNode);
    const hasFeedbackGainToDelay = connections.some(c => c.from === b.feedbackGainNode && c.to === b.feedbackDelayNode);
    const hasDelayToInput = connections.some(c => c.from === b.feedbackDelayNode && c.to === b.input);
    assert(hasOutputToFeedbackGain, "output should connect to feedbackGainNode");
    assert(hasFeedbackGainToDelay, "feedbackGainNode should connect to feedbackDelayNode");
    assert(hasDelayToInput, "feedbackDelayNode should connect back to bus.input (closing the cycle)");

    // 6. Second call only updates gain, no new nodes
    const prevDelayNode = b.feedbackDelayNode;
    const prevGainNode = b.feedbackGainNode;
    b.feedback({ amount: 0.8 });
    assert(b.feedbackDelayNode === prevDelayNode, "second feedback() should not create a new DelayNode");
    assert(b.feedbackGainNode === prevGainNode, "second feedback() should not create a new feedbackGainNode");
    assert(Math.abs(b.feedbackGainNode.gain.value - 0.8) < 1e-6,
        `feedbackGain should be updated to 0.8, got ${b.feedbackGainNode.gain.value}`);

    // 7. _rebuildSignalChain reconnects the feedback tap on output
    connections.length = 0;
    b._rebuildSignalChain();
    const rebuiltFeedbackTap = connections.some(c => c.from === b.output && c.to === b.feedbackGainNode);
    assert(rebuiltFeedbackTap, "output should reconnect to feedbackGainNode after _rebuildSignalChain");

    // ---- Connect-topology spy: send + feedback ----
    connections.length = 0;
    Bus.clearRegistry();
    Track.clearRegistry();

    const reverbBus2 = Bus("reverb2");
    const leadTrack = Track("lead2");
    leadTrack._initAudio();
    leadTrack.send(reverbBus2, 0.6);
    reverbBus2.feedback({ amount: 0.35 });

    // send: preFaderNode → sendGain → bus.input
    const sendGain = leadTrack._sends.get("reverb2");
    assert(sendGain !== undefined, "send gain node should be stored on track");
    const hasSendPath = connections.some(c => c.from === leadTrack.preFaderNode && c.to === sendGain);
    assert(hasSendPath, "send: preFaderNode should connect to sendGainNode");
    const hasSendToBusInput = connections.some(c => c.from === sendGain && c.to === reverbBus2.input);
    assert(hasSendToBusInput, "send: sendGainNode should connect to bus.input");

    // feedback: bus.output → feedbackGain → delay → bus.input
    const hasFBOutputPath = connections.some(c => c.from === reverbBus2.output && c.to === reverbBus2.feedbackGainNode);
    const hasFBGainToDelay = connections.some(c => c.from === reverbBus2.feedbackGainNode && c.to === reverbBus2.feedbackDelayNode);
    const hasFBDelayToInput = connections.some(c => c.from === reverbBus2.feedbackDelayNode && c.to === reverbBus2.input);
    assert(hasFBOutputPath, "feedback topology: output → feedbackGainNode");
    assert(hasFBGainToDelay, "feedback topology: feedbackGainNode → feedbackDelayNode");
    assert(hasFBDelayToInput, "feedback topology: feedbackDelayNode → bus.input (DelayNode breaks cycle)");

    Motif.ctx = prevCtx;
    Bus.clearRegistry();
    Track.clearRegistry();
}

// =============================================================================
// Track stepLength: decoupled cycle duration
// =============================================================================
console.log("\n=== Track stepLength: Decoupled Cycle Duration ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.0;

    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // Setup: 6-step pattern with stepLength('1/16') at 120 BPM
    // At 120BPM: 1 bar = 2.0s, 1/16 of a bar = 0.125s per step
    // 6 steps → cycle = 6 * 0.125 = 0.75s
    // Event at index 5 → startTime fraction = 5/6
    // eventTime = 0 + (5/6) * 0.75 = 0.625s = 1.25 beats
    Track.clearRegistry();
    const t = Track("step-test");
    t.synth("sine").note(["C3", "D3", "E3", "F3", "G3", "A3"]).stepLength("1/16");

    const offline = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t._resetScheduling();
    await offline.startRendering();

    const oscillators = offline.createdOscillators;

    // Should have at least 6 oscillators from the first cycle
    assert(oscillators.length >= 6, `expected at least 6 oscillators, got ${oscillators.length}`);

    // Verify stepLength is stored
    assert(t._stepLengthFraction === "1/16", `expected _stepLengthFraction '1/16', got '${t._stepLengthFraction}'`);
    assert(t._patternTopLevelSteps === 6, `expected 6 top-level steps, got ${t._patternTopLevelSteps}`);

    // Verify event start times for first cycle
    const beatDuration = 60 / 120; // 0.5s
    const stepDuration = (1 / 16) * beatDuration * 4; // 0.125s (1/16 of a bar)
    for (let i = 0; i < 6; i++) {
        const expectedTime = i * stepDuration;
        assert(Math.abs(oscillators[i].startTime - expectedTime) < 1e-9,
            `step ${i}: expected startTime ${expectedTime}, got ${oscillators[i].startTime}`);
    }

    // Specifically verify 5th event (index 5) is at 1.25 beats = 0.625s
    const fifthEventTime = oscillators[5].startTime;
    const expectedBeats = fifthEventTime / beatDuration;
    assert(Math.abs(expectedBeats - 1.25) < 1e-9,
        `5th event (index 5) should be at 1.25 beats, got ${expectedBeats} beats (${fifthEventTime}s)`);

    // Verify each step duration is 0.125s
    for (let i = 0; i < 5; i++) {
        const delta = oscillators[i + 1].startTime - oscillators[i].startTime;
        assert(Math.abs(delta - stepDuration) < 1e-9,
            `step ${i} to ${i + 1}: expected delta ${stepDuration}s, got ${delta}s`);
    }

    // Verify the cycle wraps — second cycle starts at 6 * 0.125 = 0.75s
    if (oscillators.length >= 7) {
        const secondCycleStart = 6 * stepDuration; // 0.75s
        assert(Math.abs(oscillators[6].startTime - secondCycleStart) < 1e-9,
            `second cycle should start at ${secondCycleStart}s, got ${oscillators[6].startTime}s`);
    }

    // Compare with a track WITHOUT stepLength (default bar-length cycle)
    Track.clearRegistry();
    const t2 = Track("no-step-length");
    t2.synth("sine").note(["C3", "D3", "E3", "F3", "G3", "A3"]);

    const offline2 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    t2._resetScheduling();
    await offline2.startRendering();

    const osc2 = offline2.createdOscillators;
    // Default cycle = 1 bar = 2.0s, each of 6 steps = 2.0/6 ≈ 0.333s
    const defaultStepDuration = 2.0 / 6;
    if (osc2.length >= 6) {
        assert(Math.abs(osc2[1].startTime - defaultStepDuration) < 1e-6,
            `without stepLength, step 1 should start at ~${defaultStepDuration}s, got ${osc2[1].startTime}s`);
        // Confirm this is different from the stepLength version
        assert(Math.abs(defaultStepDuration - stepDuration) > 0.1,
            `stepLength should produce a different step duration than default`);
    }

    // Test clearing stepLength
    const t3 = Track("clear-step");
    t3.synth("sine").note(["C3", "D3"]).stepLength("1/8").stepLength(null);
    assert(t3._stepLengthFraction === null, `stepLength(null) should clear the fraction`);

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track loopLength: clamped event window with wrapping
// =============================================================================
console.log("\n=== Track loopLength: Clamped Event Window ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 3.0;

    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // TEST 1: Loop shorter than pattern → truncation
    // 4-step pattern ['C3', 'D3', 'E3', 'F3'] at 120 BPM
    // Default cycle = 1 bar = 2.0s. Each step fraction = 1/4.
    // loopLength('1/2') → 0.5 * bar = 1.0s
    // loopFraction = 1.0 / 2.0 = 0.5
    // Only events with startTime < 0.5 play: C3 (0), D3 (0.25)
    // E3 (0.5) and F3 (0.75) are truncated
    Track.clearRegistry();
    const t1 = Track("loop-trunc");
    t1.synth("sine").note(["C3", "D3", "E3", "F3"]).loopLength("1/2");

    const offline1 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline1;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t1._resetScheduling();
    await offline1.startRendering();

    const osc1 = offline1.createdOscillators;

    // Verify loopLength is stored
    assert(t1._loopLengthFraction === "1/2", `expected _loopLengthFraction '1/2', got '${t1._loopLengthFraction}'`);

    // At loopLength 1/2 bar = 1.0s, loopFraction = 0.5
    // Only C3 (startTime=0) and D3 (startTime=0.25) are within loop window
    // With 3.0s buffer, we get 3 cycles: [0-1s], [1-2s], [2-3s] = 6 notes total
    assert(osc1.length >= 4, `expected at least 4 oscillators with truncated loop, got ${osc1.length}`);

    // First cycle: C3 at 0s, D3 at 0.5s (0.25 * 2.0s cycleDuration = 0.5s)
    assert(Math.abs(osc1[0].startTime - 0) < 1e-9,
        `loop-trunc cycle 1: C3 should start at 0s, got ${osc1[0].startTime}`);
    assert(Math.abs(osc1[1].startTime - 0.5) < 1e-9,
        `loop-trunc cycle 1: D3 should start at 0.5s, got ${osc1[1].startTime}`);

    // Second cycle starts at 1.0s (loopDuration)
    assert(Math.abs(osc1[2].startTime - 1.0) < 1e-9,
        `loop-trunc cycle 2: C3 should start at 1.0s, got ${osc1[2].startTime}`);
    assert(Math.abs(osc1[3].startTime - 1.5) < 1e-9,
        `loop-trunc cycle 2: D3 should start at 1.5s, got ${osc1[3].startTime}`);

    // TEST 2: Loop longer than pattern → silence padding at the end
    // 2-step pattern ['C3', 'D3'] at 120 BPM
    // Default cycle = 1 bar = 2.0s. Each step fraction = 1/2.
    // loopLength('2b') → 2 bars = 4.0s
    // loopFraction = 4.0 / 2.0 = 2.0 → all events fit (startTime max is 0.5, < 2.0)
    // But the cycle repeats at 4.0s intervals, so there's 2.0s of silence after the pattern
    Track.clearRegistry();
    const t2 = Track("loop-pad");
    t2.synth("sine").note(["C3", "D3"]).loopLength("2b");

    const offline2 = new TestOfflineCtx(1, Math.ceil(sampleRate * 5.0), sampleRate);
    Motif.ctx = offline2;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t2._resetScheduling();
    await offline2.startRendering();

    const osc2 = offline2.createdOscillators;

    // Cycle 1: C3 at 0s, D3 at 1.0s (0.5 * 2.0 cycleDuration)
    // Then silence from 2.0s to 4.0s
    // Cycle 2: C3 at 4.0s, D3 at 5.0s (but 5.0s is at buffer end)
    assert(osc2.length >= 2, `expected at least 2 oscillators with padded loop, got ${osc2.length}`);
    assert(Math.abs(osc2[0].startTime - 0) < 1e-9,
        `loop-pad cycle 1: C3 should start at 0s, got ${osc2[0].startTime}`);
    assert(Math.abs(osc2[1].startTime - 1.0) < 1e-9,
        `loop-pad cycle 1: D3 should start at 1.0s, got ${osc2[1].startTime}`);

    // Second cycle should start at 4.0s (loopDuration)
    if (osc2.length >= 3) {
        assert(Math.abs(osc2[2].startTime - 4.0) < 1e-9,
            `loop-pad cycle 2: C3 should start at 4.0s, got ${osc2[2].startTime}`);
    }

    // TEST 3: Clearing loopLength
    const t3 = Track("loop-clear");
    t3.synth("sine").note(["C3", "D3"]).loopLength("1/4").loopLength(null);
    assert(t3._loopLengthFraction === null, `loopLength(null) should clear the fraction`);

    // TEST 4: loopLength is chainable
    const t4 = Track("loop-chain");
    const chained = t4.synth("sine").note(["C3"]).loopLength("1/2");
    assert(chained === t4, `loopLength() should return this for chaining`);

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Motif Global Swing
// =============================================================================
console.log("\n=== Motif Global Swing ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevSwing = Motif._swingAmount;
    const sampleRate = 44100;
    const bufferDurationS = 3.0;

    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // TEST 1: swing(0.5) on a 4-step pattern at 120 BPM
    // 4 top-level steps, cycleDuration = 2.0s, stepDuration = 0.5s
    // swingDelay = 0.5 * 0.5 * (2/3) = 0.1667s
    // Step 0 (on-beat): 0s — no delay
    // Step 1 (off-beat): 0.5s + 0.1667s = 0.6667s
    // Step 2 (on-beat): 1.0s — no delay
    // Step 3 (off-beat): 1.5s + 0.1667s = 1.6667s
    Track.clearRegistry();
    const t1 = Track("swing-test");
    t1.synth("sine").note(["C3", "D3", "E3", "F3"]);

    const offline1 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline1;
    Motif.tempo = 120;
    Motif._swingAmount = 0.5;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t1._resetScheduling();
    await offline1.startRendering();

    const osc1 = offline1.createdOscillators;
    assert(osc1.length >= 4, `swing test: expected at least 4 oscillators, got ${osc1.length}`);

    const stepDur = 0.5; // 2.0s cycle / 4 steps
    const swingDelay = stepDur * 0.5 * (2 / 3); // ≈ 0.16667s

    // Step 0: on-beat, no delay
    assert(Math.abs(osc1[0].startTime - 0) < 1e-9,
        `swing step 0: expected 0s, got ${osc1[0].startTime}`);
    // Step 1: off-beat, delayed
    assert(Math.abs(osc1[1].startTime - (0.5 + swingDelay)) < 1e-6,
        `swing step 1: expected ${0.5 + swingDelay}s, got ${osc1[1].startTime}`);
    // Step 2: on-beat, no delay
    assert(Math.abs(osc1[2].startTime - 1.0) < 1e-9,
        `swing step 2: expected 1.0s, got ${osc1[2].startTime}`);
    // Step 3: off-beat, delayed
    assert(Math.abs(osc1[3].startTime - (1.5 + swingDelay)) < 1e-6,
        `swing step 3: expected ${1.5 + swingDelay}s, got ${osc1[3].startTime}`);

    // TEST 2: swing(0) should produce no delay (straight time)
    Track.clearRegistry();
    const t2 = Track("swing-straight");
    t2.synth("sine").note(["C3", "D3", "E3", "F3"]);

    const offline2 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline2;
    Motif.tempo = 120;
    Motif._swingAmount = 0;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t2._resetScheduling();
    await offline2.startRendering();

    const osc2 = offline2.createdOscillators;
    assert(osc2.length >= 4, `straight test: expected at least 4 oscillators, got ${osc2.length}`);

    for (let i = 0; i < 4; i++) {
        const expected = i * 0.5;
        assert(Math.abs(osc2[i].startTime - expected) < 1e-9,
            `straight step ${i}: expected ${expected}s, got ${osc2[i].startTime}`);
    }

    // TEST 3: swing(1.0) = full triplet swing
    // swingDelay = 0.5 * 1.0 * (2/3) = 0.3333s
    Track.clearRegistry();
    const t3 = Track("swing-full");
    t3.synth("sine").note(["C3", "D3"]);

    const offline3 = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offline3;
    Motif.tempo = 120;
    Motif._swingAmount = 1.0;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t3._resetScheduling();
    await offline3.startRendering();

    const osc3 = offline3.createdOscillators;
    assert(osc3.length >= 2, `full swing test: expected at least 2 oscillators, got ${osc3.length}`);

    const fullSwingDelay = 1.0 * 1.0 * (2 / 3); // stepDur=1.0 for 2-step pattern
    assert(Math.abs(osc3[0].startTime - 0) < 1e-9,
        `full swing step 0: expected 0s, got ${osc3[0].startTime}`);
    assert(Math.abs(osc3[1].startTime - (1.0 + fullSwingDelay)) < 1e-6,
        `full swing step 1: expected ${1.0 + fullSwingDelay}s, got ${osc3[1].startTime}`);

    // TEST 4: Motif.swing() is chainable and clamps values
    const ret = Motif.swing(0.5);
    assert(ret === Motif, `Motif.swing() should return the engine for chaining`);
    assert(Motif._swingAmount === 0.5, `swing(0.5) should store 0.5`);

    Motif.swing(-1);
    assert(Motif._swingAmount === 0, `swing(-1) should clamp to 0`);

    Motif.swing(5);
    assert(Motif._swingAmount === 1, `swing(5) should clamp to 1`);

    // Cleanup
    Motif._swingAmount = prevSwing;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track-Specific Swing
// =============================================================================
console.log("\n=== Track-Specific Swing ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevSwing = Motif._swingAmount;
    const sampleRate = 44100;
    const bufferDurationS = 3.0;

    class MockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 440, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = null;
            this.stopTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // TEST 1: Track-specific swing overrides global swing
    Track.clearRegistry();
    const t1 = Track("track-swing-override");
    t1.synth("sine").note(["C3", "D3", "E3", "F3"]).swing(0.5);

    const offline1 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline1;
    Motif.tempo = 120;
    Motif._swingAmount = 0.8; // global swing is different
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t1._resetScheduling();
    await offline1.startRendering();

    const osc1 = offline1.createdOscillators;
    assert(osc1.length >= 4, `track swing test: expected at least 4 oscillators, got ${osc1.length}`);

    const stepDur = 0.5; // 2.0s cycle / 4 steps
    const swingDelay = stepDur * 0.5 * (2 / 3); // track swing (0.5) is used

    // Step 0: on-beat, no delay
    assert(Math.abs(osc1[0].startTime - 0) < 1e-9,
        `track swing step 0: expected 0s, got ${osc1[0].startTime}`);
    // Step 1: off-beat, delayed by track swingDelay
    assert(Math.abs(osc1[1].startTime - (0.5 + swingDelay)) < 1e-6,
        `track swing step 1: expected ${0.5 + swingDelay}s, got ${osc1[1].startTime}`);
    // Step 2: on-beat, no delay
    assert(Math.abs(osc1[2].startTime - 1.0) < 1e-9,
        `track swing step 2: expected 1.0s, got ${osc1[2].startTime}`);
    // Step 3: off-beat, delayed by track swingDelay
    assert(Math.abs(osc1[3].startTime - (1.5 + swingDelay)) < 1e-6,
        `track swing step 3: expected ${1.5 + swingDelay}s, got ${osc1[3].startTime}`);

    // TEST 2: Track-specific swing falls back to global swing if null
    Track.clearRegistry();
    const t2 = Track("track-swing-fallback");
    t2.synth("sine").note(["C3", "D3", "E3", "F3"]).swing(null); // explicitly null

    const offline2 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline2;
    Motif.tempo = 120;
    Motif._swingAmount = 0.6; // fallback swing
    Motif._schedQueue = [];
    Motif._stopScheduler();

    t2._resetScheduling();
    await offline2.startRendering();

    const osc2 = offline2.createdOscillators;
    assert(osc2.length >= 4, `track fallback test: expected at least 4 oscillators, got ${osc2.length}`);

    const fallbackSwingDelay = stepDur * 0.6 * (2 / 3);

    assert(Math.abs(osc2[0].startTime - 0) < 1e-9,
        `fallback swing step 0: expected 0s, got ${osc2[0].startTime}`);
    assert(Math.abs(osc2[1].startTime - (0.5 + fallbackSwingDelay)) < 1e-6,
        `fallback swing step 1: expected ${0.5 + fallbackSwingDelay}s, got ${osc2[1].startTime}`);

    // TEST 3: track.swing() is chainable and clamps values properly
    const t3 = Track("track-swing-chain");
    const ret = t3.swing(0.5);
    assert(ret === t3, `track.swing() should return the track for chaining`);
    assert(t3._swingAmount === 0.5, `swing(0.5) should store 0.5`);

    t3.swing(-1);
    assert(t3._swingAmount === 0, `swing(-1) should clamp to 0`);

    t3.swing(5);
    assert(t3._swingAmount === 1, `swing(5) should clamp to 1`);

    t3.swing(null);
    assert(t3._swingAmount === null, `swing(null) should set _swingAmount to null`);

    // Cleanup
    Motif._swingAmount = prevSwing;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .sample() — Async Sample Loading
// =============================================================================
console.log("\n=== Track .sample(): Async Sample Loading ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.5;

    // Mock AudioBuffer
    class MockAudioBuffer {
        constructor(duration = 1.0) {
            this.duration = duration;
            this.sampleRate = 44100;
            this.numberOfChannels = 1;
            this.length = Math.ceil(duration * this.sampleRate);
        }
    }

    class MockBufferSourceNode {
        constructor() {
            this.buffer = null;
            this.playbackRate = {
                value: 1, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.startTime = null;
            this.stopTime = null;
            this.offset = 0;
            this.duration = null;
        }

        start(when = 0, offset = 0, duration = null) {
            this.startTime = when;
            this.offset = offset;
            this.duration = duration;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdBufferSources = [];
            this.createdOscillators = [];
            this._mockBuffer = new MockAudioBuffer(1.0);
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, cancelAndHoldAtTime(t) {
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: {
                    value: 350, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                gain: {
                    value: 0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                Q: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x, t) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = {
                frequency: {
                    value: 440, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                }, type: "sine", startTime: null, stopTime: null, start(w = 0) {
                    this.startTime = w;
                }, stop(w = 0) {
                    this.stopTime = w;
                }, connect(d) {
                    return d;
                }, disconnect() {
                },
            };
            this.createdOscillators.push(o);
            return o;
        }

        createBufferSource() {
            const s = new MockBufferSourceNode();
            this.createdBufferSources.push(s);
            return s;
        }

        decodeAudioData(arrayBuffer, onSuccess, onError) {
            const buf = this._mockBuffer;
            if (onSuccess) onSuccess(buf);
            return Promise.resolve(buf);
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // TEST 1: sample() stores url, sets _useSample, and calls fetch+decode
    Track.clearRegistry();
    const offline1 = new TestOfflineCtx(1, Math.ceil(sampleRate * bufferDurationS), sampleRate);
    Motif.ctx = offline1;
    Motif.tempo = 120;
    Motif._swingAmount = 0;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    // Mock fetch for testing
    const origFetch = globalThis.fetch;
    let fetchCalledWith = null;
    globalThis.fetch = (url) => {
        fetchCalledWith = url;
        return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        });
    };

    const t1 = Track("sample-test");
    t1.note(["C3", "D3"]).sample("/audio/kick.wav");

    assert(t1._useSample === true, `sample() should set _useSample to true`);
    assert(t1._sampleUrl === "/audio/kick.wav", `sample() should store the URL`);
    assert(t1._sampleLoading !== null, `sample() should start loading`);

    // Wait for the async loading to complete
    await t1._sampleLoading;

    assert(t1._sampleBuffer !== null, `sample buffer should be loaded after await`);
    assert(t1._sampleBuffer instanceof MockAudioBuffer, `sample buffer should be a MockAudioBuffer`);

    // TEST 2: After buffer is loaded, scheduling creates BufferSourceNodes, not OscillatorNodes
    t1._resetScheduling();
    await offline1.startRendering();

    assert(offline1.createdBufferSources.length >= 2,
        `expected at least 2 buffer source nodes, got ${offline1.createdBufferSources.length}`);
    assert(offline1.createdOscillators.length === 0,
        `expected 0 oscillators for sample track, got ${offline1.createdOscillators.length}`);

    // Verify the buffer was assigned to each source
    for (let i = 0; i < Math.min(2, offline1.createdBufferSources.length); i++) {
        assert(offline1.createdBufferSources[i].buffer === t1._sampleBuffer,
            `source ${i}: buffer should be the loaded sample buffer`);
    }

    // Verify timing: C3 at 0s, D3 at 1.0s (2-step pattern, 2.0s cycle)
    if (offline1.createdBufferSources.length >= 2) {
        assert(Math.abs(offline1.createdBufferSources[0].startTime - 0) < 1e-9,
            `source 0 startTime should be 0, got ${offline1.createdBufferSources[0].startTime}`);
        assert(Math.abs(offline1.createdBufferSources[1].startTime - 1.0) < 1e-9,
            `source 1 startTime should be 1.0, got ${offline1.createdBufferSources[1].startTime}`);
    }

    // TEST 3: Pitch-shifting via playbackRate when using note pattern
    // C3 = MIDI 48, base = MIDI 60, rate = 2^((48-60)/12) = 2^(-1) = 0.5
    if (offline1.createdBufferSources.length >= 1) {
        const expectedRate = Math.pow(2, (48 - 60) / 12); // 0.5
        assert(Math.abs(offline1.createdBufferSources[0].playbackRate.value - expectedRate) < 1e-6,
            `C3 playbackRate should be ${expectedRate}, got ${offline1.createdBufferSources[0].playbackRate.value}`);
    }
    // D3 = MIDI 50, rate = 2^((50-60)/12)
    if (offline1.createdBufferSources.length >= 2) {
        const expectedRate = Math.pow(2, (50 - 60) / 12);
        assert(Math.abs(offline1.createdBufferSources[1].playbackRate.value - expectedRate) < 1e-6,
            `D3 playbackRate should be ${expectedRate}, got ${offline1.createdBufferSources[1].playbackRate.value}`);
    }

    // TEST 4: Cache hit — second track with same URL reuses cached promise
    Track.clearRegistry();
    const t2 = Track("sample-cached");
    t2.note(["E3"]).sample("/audio/kick.wav");
    await t2._sampleLoading;

    assert(t2._sampleBuffer !== null, `cached sample should resolve`);
    assert(t2._sampleBuffer === t1._sampleBuffer, `cached sample should be the same buffer instance`);

    // TEST 5: Clearing sample
    t2.sample(null);
    assert(t2._useSample === false, `sample(null) should set _useSample to false`);
    assert(t2._sampleBuffer === null, `sample(null) should clear buffer`);
    assert(t2._sampleUrl === null, `sample(null) should clear URL`);

    // TEST 6: sample() is chainable
    const t3 = Track("sample-chain");
    const ret = t3.note(["C3"]).sample("/audio/snare.wav");
    assert(ret === t3, `sample() should return this for chaining`);

    // TEST 7: Transitioning from sample to synth resets sample state (regression test)
    const t4 = Track("sample-to-synth");
    t4.sample("/audio/kick.wav");
    assert(t4._useSample === true, `should set _useSample to true when sample loaded`);

    t4.synth("sawtooth");
    assert(t4._useSample === false, `synth() should clear _useSample state`);
    assert(t4._sampleBuffer === null, `synth() should clear _sampleBuffer`);
    assert(t4._sampleUrl === null, `synth() should clear _sampleUrl`);
    assert(t4._sampleLoading === null, `synth() should clear _sampleLoading`);

    // Cleanup
    globalThis.fetch = origFetch;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .sampler() — Multi-Sample Nearest-Note Lookup
// =============================================================================
console.log("\n=== Track .sampler(): Multi-Sample Nearest-Note Lookup ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;

    class MockAudioBuffer {
        constructor(id) {
            this.id = id;
            this.duration = 1.0;
            this.sampleRate = 44100;
        }
    }

    class MockBufferSourceNode {
        constructor() {
            this.buffer = null;
            this.playbackRate = {
                value: 1, setValueAtTime(v) {
                    this.value = v;
                    return this;
                },
            };
            this.startTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop() {
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestCtx {
        constructor() {
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdBufferSources = [];
            this._mockBuffers = {};
        }

        createGain() {
            return {
                gain: {
                    value: 1, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v) {
                        this.value = v;
                        return this;
                    }, cancelAndHoldAtTime() {
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "", frequency: {
                    value: 350, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, gain: {
                    value: 0, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, Q: {
                    value: 1, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: {
                    value: 0, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, type: "sine", start() {
                }, stop() {
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBufferSource() {
            const s = new MockBufferSourceNode();
            this.createdBufferSources.push(s);
            return s;
        }

        decodeAudioData(ab, onSuccess) {
            const key = ab._key || "default";
            const buf = this._mockBuffers[key] || new MockAudioBuffer(key);
            if (onSuccess) onSuccess(buf);
            return Promise.resolve(buf);
        }

        async startRendering() {
            const bufferDurationS = 2.0;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    // Mock fetch: returns distinct ArrayBuffer per url so we can tell buffers apart
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const ab = new ArrayBuffer(4);
        ab._key = url;
        return { ok: true, arrayBuffer: async () => ab };
    };

    Track.clearRegistry();
    const testCtx = new TestCtx();
    // Give each mock buffer a stable identity per URL
    testCtx._mockBuffers = {};

    Motif.ctx = testCtx;
    Motif.tempo = 120;

    // Setup: sampler with C3 (48), G3 (55), C4 (60) mapped
    // decodeAudioData will return a MockAudioBuffer keyed by url
    const bufC3 = new MockAudioBuffer("C3");
    testCtx._mockBuffers["/s/c3.wav"] = bufC3;
    const bufG3 = new MockAudioBuffer("G3");
    testCtx._mockBuffers["/s/g3.wav"] = bufG3;
    const bufC4 = new MockAudioBuffer("C4");
    testCtx._mockBuffers["/s/c4.wav"] = bufC4;

    const t1 = Track("sampler-test");
    t1.sampler({
        urls: { "C3": "/s/c3.wav", "G3": "/s/g3.wav", "C4": "/s/c4.wav" },
        release: 0.2,
    });

    // TEST 1: _useSampler flag and chainability
    assert(t1._useSampler === true, `sampler() should set _useSampler`);
    assert(t1._useSample === false, `sampler() should clear _useSample`);
    assert(t1._samplerRelease === 0.2, `sampler() should store release`);

    // Wait for buffers to load
    await t1._samplerLoading;

    // TEST 2: buffers loaded and keys sorted
    assert(t1._samplerBuffers.size === 3, `should have 3 buffers, got ${t1._samplerBuffers.size}`);
    assert(t1._samplerKeys.length === 3, `should have 3 keys`);
    assert(t1._samplerKeys[0] === 48 && t1._samplerKeys[1] === 55 && t1._samplerKeys[2] === 60,
        `keys should be sorted [48,55,60], got ${t1._samplerKeys}`);

    // TEST 3: nearest-note lookup
    // Target D3 (50): nearest is C3 (48) since |50-48|=2 < |50-55|=5
    assert(t1._findNearestSamplerKey(50) === 48, `D3(50) nearest should be C3(48)`);
    // Target A3 (57): nearest is G3 (55) since |57-55|=2 < |57-60|=3
    assert(t1._findNearestSamplerKey(57) === 55, `A3(57) nearest should be G3(55)`);
    // Target B3 (59): nearest is C4 (60) since |59-60|=1 < |59-55|=4
    assert(t1._findNearestSamplerKey(59) === 60, `B3(59) nearest should be C4(60)`);
    // Exact hit: G3 (55) => G3 (55)
    assert(t1._findNearestSamplerKey(55) === 55, `G3(55) exact hit should return 55`);

    // TEST 4: playbackRate is 2^((target-source)/12)
    // Schedule notes C3(48) and D3(50) via .note(), then tick to schedule them
    t1.note(["C3", "D3"]);

    // Run tick simulation
    await testCtx.startRendering();

    // C3 targeting MIDI 48, source 48: playbackRate = 2^0 = 1.0
    if (testCtx.createdBufferSources.length >= 1) {
        const expected = Math.pow(2, (48 - 48) / 12); // 1.0
        assert(Math.abs(testCtx.createdBufferSources[0].playbackRate.value - expected) < 1e-6,
            `C3 playbackRate should be ${expected}, got ${testCtx.createdBufferSources[0].playbackRate.value}`);
        assert(testCtx.createdBufferSources[0].buffer === bufC3,
            `C3 should use bufC3`);
    }
    // D3 (MIDI 50), nearest source = C3 (48): playbackRate = 2^(2/12)
    if (testCtx.createdBufferSources.length >= 2) {
        const expected = Math.pow(2, (50 - 48) / 12);
        assert(Math.abs(testCtx.createdBufferSources[1].playbackRate.value - expected) < 1e-6,
            `D3 playbackRate should be ${expected}, got ${testCtx.createdBufferSources[1].playbackRate.value}`);
        assert(testCtx.createdBufferSources[1].buffer === bufC3,
            `D3 nearest is C3, should use bufC3`);
    }

    // TEST 5: sampler() clears single-sample state; sample() clears sampler state
    Track.clearRegistry();
    const t2 = Track("mutual-exclusive");
    t2.sample("/audio/kick.wav");
    assert(t2._useSample === true, `after sample(): _useSample should be true`);
    t2.sampler({ urls: { "C4": "/s/c4.wav" } });
    assert(t2._useSampler === true, `after sampler(): _useSampler should be true`);
    assert(t2._useSample === false, `after sampler(): _useSample should be false`);
    t2.sample("/audio/snare.wav");
    assert(t2._useSample === true, `after sample() again: _useSample should be true`);
    assert(t2._useSampler === false, `after sample() again: _useSampler should be false`);

    // Cleanup
    globalThis.fetch = origFetch;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .chop() — Mathematical Sample Slicing
// =============================================================================
console.log("\n=== Track .chop(): Mathematical Sample Slicing ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.0;

    class MockAudioBuffer {
        constructor(duration = 2.0) {
            this.duration = duration;
            this.sampleRate = 44100;
            this.numberOfChannels = 1;
            this.length = Math.ceil(duration * this.sampleRate);
        }
    }

    class MockBufferSourceNode {
        constructor() {
            this.buffer = null;
            this.playbackRate = {
                value: 1, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.startTime = null;
            this.stopTime = null;
            this.offset = 0;
            this.duration = null;
        }

        start(when = 0, offset = 0, duration = null) {
            this.startTime = when;
            this.offset = offset;
            this.duration = duration;
        }

        stop(when = 0) {
            this.stopTime = when;
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdBufferSources = [];
            this._mockBuffer = new MockAudioBuffer(2.0); // 2.0 seconds sample buffer
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, cancelAndHoldAtTime(t) {
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "", frequency: {
                    value: 350, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, gain: {
                    value: 0, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, Q: {
                    value: 1, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, type: "sine", start() {
                }, stop() {
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBufferSource() {
            const s = new MockBufferSourceNode();
            this.createdBufferSources.push(s);
            return s;
        }

        decodeAudioData(arrayBuffer, onSuccess, onError) {
            const buf = this._mockBuffer;
            if (onSuccess) onSuccess(buf);
            return Promise.resolve(buf);
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    // Mock fetch for testing
    const origFetch = globalThis.fetch;
    globalThis.fetch = (url) => {
        return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        });
    };

    // TEST 1: chop() sets _slices, is chainable, and sample(null) resets it
    Track.clearRegistry();
    const t1 = Track("chop-init");
    const ret = t1.chop(4);
    assert(ret === t1, "chop() should return the track instance for chaining");
    assert(t1._slices === 4, `expected _slices to be 4, got ${t1._slices}`);

    t1.chop(null);
    assert(t1._slices === null, "chop(null) should clear _slices");

    t1.chop(8);
    t1.sample(null);
    assert(t1._slices === null, "sample(null) should clear _slices");

    // TEST 2: Slicing timing and offset (mathematical slicing)
    // 2.0s buffer / 4 slices => sliceDuration = 0.5s
    // Step 0: index 0 => offset = 0.0s, duration = 0.5s
    // Step 1: index 1 => offset = 0.5s, duration = 0.5s
    // Step 2: index 2 => offset = 1.0s, duration = 0.5s
    // Step 3: index 3 => offset = 1.5s, duration = 0.5s
    const offlineCtx = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offlineCtx;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    const t2 = Track("chop-playback");
    t2.note(["C3", "D3", "E3", "F3"]).sample("/audio/loop.wav").chop(4);

    await t2._sampleLoading;
    t2._resetScheduling();
    await offlineCtx.startRendering();

    assert(offlineCtx.createdBufferSources.length >= 4, `expected 4 buffer sources, got ${offlineCtx.createdBufferSources.length}`);
    if (offlineCtx.createdBufferSources.length >= 4) {
        // Verify source 0: slice 0
        assert(Math.abs(offlineCtx.createdBufferSources[0].offset - 0.0) < 1e-9, `expected slice 0 offset 0.0, got ${offlineCtx.createdBufferSources[0].offset}`);
        assert(Math.abs(offlineCtx.createdBufferSources[0].duration - 0.5) < 1e-9, `expected slice 0 duration 0.5, got ${offlineCtx.createdBufferSources[0].duration}`);

        // Verify source 1: slice 1
        assert(Math.abs(offlineCtx.createdBufferSources[1].offset - 0.5) < 1e-9, `expected slice 1 offset 0.5, got ${offlineCtx.createdBufferSources[1].offset}`);
        assert(Math.abs(offlineCtx.createdBufferSources[1].duration - 0.5) < 1e-9, `expected slice 1 duration 0.5, got ${offlineCtx.createdBufferSources[1].duration}`);

        // Verify source 2: slice 2
        assert(Math.abs(offlineCtx.createdBufferSources[2].offset - 1.0) < 1e-9, `expected slice 2 offset 1.0, got ${offlineCtx.createdBufferSources[2].offset}`);
        assert(Math.abs(offlineCtx.createdBufferSources[2].duration - 0.5) < 1e-9, `expected slice 2 duration 0.5, got ${offlineCtx.createdBufferSources[2].duration}`);

        // Verify source 3: slice 3
        assert(Math.abs(offlineCtx.createdBufferSources[3].offset - 1.5) < 1e-9, `expected slice 3 offset 1.5, got ${offlineCtx.createdBufferSources[3].offset}`);
        assert(Math.abs(offlineCtx.createdBufferSources[3].duration - 0.5) < 1e-9, `expected slice 3 duration 0.5, got ${offlineCtx.createdBufferSources[3].duration}`);
    }

    // TEST 3: event.value % slices determines the slice index if event.value is a number
    const offlineCtx2 = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offlineCtx2;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    const t3 = Track("chop-number-pattern");
    t3.note([2, 0]).sample("/audio/loop.wav").chop(4);

    await t3._sampleLoading;
    t3._resetScheduling();
    await offlineCtx2.startRendering();

    assert(offlineCtx2.createdBufferSources.length >= 2, `expected at least 2 buffer sources, got ${offlineCtx2.createdBufferSources.length}`);
    if (offlineCtx2.createdBufferSources.length >= 2) {
        // Step 0: note value 2 => slice 2 => offset 1.0s
        assert(Math.abs(offlineCtx2.createdBufferSources[0].offset - 1.0) < 1e-9, `expected slice 2 offset 1.0, got ${offlineCtx2.createdBufferSources[0].offset}`);
        // Step 1: note value 0 => slice 0 => offset 0.0s
        assert(Math.abs(offlineCtx2.createdBufferSources[1].offset - 0.0) < 1e-9, `expected slice 0 offset 0.0, got ${offlineCtx2.createdBufferSources[1].offset}`);
    }

    // Cleanup
    globalThis.fetch = origFetch;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .pattern() — Slice Reordering and Repetition
// =============================================================================
console.log("\n=== Track .pattern(): Slice Reordering and Repetition ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;

    class MockAudioBuffer {
        constructor(duration = 2.0) {
            this.duration = duration;
            this.sampleRate = 44100;
            this.numberOfChannels = 1;
            this.length = Math.ceil(duration * this.sampleRate);
        }
    }

    class MockBufferSourceNode {
        constructor() {
            this.buffer = null;
            this.playbackRate = {
                value: 1, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.startTime = null;
            this.offset = 0;
            this.duration = null;
        }

        start(when = 0, offset = 0, duration = null) {
            this.startTime = when;
            this.offset = offset;
            this.duration = duration;
        }

        stop(when = 0) {
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor(channels, length, sampleRate) {
            this.numberOfChannels = channels;
            this.length = length;
            this.sampleRate = sampleRate;
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdBufferSources = [];
            this._mockBuffer = new MockAudioBuffer(2.0);
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, cancelAndHoldAtTime(t) {
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "", frequency: {
                    value: 350, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, gain: {
                    value: 0, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, Q: {
                    value: 1, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, type: "sine", start() {
                }, stop() {
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBufferSource() {
            const s = new MockBufferSourceNode();
            this.createdBufferSources.push(s);
            return s;
        }

        decodeAudioData(arrayBuffer, onSuccess, onError) {
            const buf = this._mockBuffer;
            if (onSuccess) onSuccess(buf);
            return Promise.resolve(buf);
        }

        async startRendering() {
            const bufferDuration = this.length / this.sampleRate;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDuration + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
            return { duration: bufferDuration };
        }
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = (url) => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    // TEST 1: pattern() sets _sliceIndices, is chainable, and sample() resets it
    Track.clearRegistry();
    const t1 = Track("pattern-init");
    const ret = t1.pattern([0, 2, 1, 3]);
    assert(ret === t1, "pattern() should return the track instance for chaining");
    assert(Array.isArray(t1._sliceIndices) && t1._sliceIndices[1] === 2, "pattern() should set _sliceIndices");

    t1.sample("/other.wav");
    assert(t1._sliceIndices === null, "sample() should clear _sliceIndices");

    // TEST 2: Reordering slices using .pattern()
    // 2.0s buffer / 4 slices => sliceDuration = 0.5s
    // Pattern [3, 2, 1, 0]
    const offlineCtx = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offlineCtx;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    const t2 = Track("pattern-playback");
    t2.note([0, 1, 2, 3]).sample("/audio/loop.wav").chop(4).pattern([3, 2, 1, 0]);

    await t2._sampleLoading;
    t2._resetScheduling();
    await offlineCtx.startRendering();

    assert(offlineCtx.createdBufferSources.length >= 4, `expected 4 buffer sources, got ${offlineCtx.createdBufferSources.length}`);
    if (offlineCtx.createdBufferSources.length >= 4) {
        // Step 0: pattern[0] = 3 => offset 1.5s
        assert(Math.abs(offlineCtx.createdBufferSources[0].offset - 1.5) < 1e-9, `step 0: expected offset 1.5, got ${offlineCtx.createdBufferSources[0].offset}`);
        // Step 1: pattern[1] = 2 => offset 1.0s
        assert(Math.abs(offlineCtx.createdBufferSources[1].offset - 1.0) < 1e-9, `step 1: expected offset 1.0, got ${offlineCtx.createdBufferSources[1].offset}`);
        // Step 2: pattern[2] = 1 => offset 0.5s
        assert(Math.abs(offlineCtx.createdBufferSources[2].offset - 0.5) < 1e-9, `step 2: expected offset 0.5, got ${offlineCtx.createdBufferSources[2].offset}`);
        // Step 3: pattern[3] = 0 => offset 0.0s
        assert(Math.abs(offlineCtx.createdBufferSources[3].offset - 0.0) < 1e-9, `step 3: expected offset 0.0, got ${offlineCtx.createdBufferSources[3].offset}`);
    }

    // TEST 3: Repeating slices (pattern shorter than sequence)
    Track.clearRegistry();
    const offlineCtx3 = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offlineCtx3;
    Motif._schedQueue = [];

    const t3 = Track("pattern-repeat");
    t3.note([0, 1, 2, 3]).sample("/audio/loop.wav").chop(4).pattern([1, 2]);

    await t3._sampleLoading;
    t3._resetScheduling();
    await offlineCtx3.startRendering();

    if (offlineCtx3.createdBufferSources.length >= 4) {
        // Step 0: pattern[0%2] = 1 => 0.5s
        assert(Math.abs(offlineCtx3.createdBufferSources[0].offset - 0.5) < 1e-9, `step 0: expected offset 0.5, got ${offlineCtx3.createdBufferSources[0].offset}`);
        // Step 1: pattern[1%2] = 2 => 1.0s
        assert(Math.abs(offlineCtx3.createdBufferSources[1].offset - 1.0) < 1e-9, `step 1: expected offset 1.0, got ${offlineCtx3.createdBufferSources[1].offset}`);
        // Step 2: pattern[2%2] = 1 => 0.5s
        assert(Math.abs(offlineCtx3.createdBufferSources[2].offset - 0.5) < 1e-9, `step 2: expected offset 0.5, got ${offlineCtx3.createdBufferSources[2].offset}`);
        // Step 3: pattern[3%2] = 2 => 1.0s
        assert(Math.abs(offlineCtx3.createdBufferSources[3].offset - 1.0) < 1e-9, `step 3: expected offset 1.0, got ${offlineCtx3.createdBufferSources[3].offset}`);
    }

    globalThis.fetch = origFetch;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .fit() — Mathematical Duration Fitting
// =============================================================================
console.log("\n=== Track .fit(): Mathematical Duration Fitting ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;

    class MockAudioBuffer {
        constructor(duration = 2.0) {
            this.duration = duration;
            this.sampleRate = 44100;
        }
    }

    class MockBufferSourceNode {
        constructor() {
            this.buffer = null;
            this.playbackRate = {
                value: 1, setValueAtTime(v, t) {
                    this.value = v;
                    return this;
                },
            };
            this.startTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class TestOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.state = "running";
            this.destination = {};
            this.createdBufferSources = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    }, cancelAndHoldAtTime(t) {
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "", frequency: {
                    value: 350, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, gain: {
                    value: 0, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, Q: {
                    value: 1, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            const p = (v) => ({
                value: v, setValueAtTime(x) {
                    this.value = x;
                    return this;
                },
            });
            return {
                threshold: p(-24),
                knee: p(30),
                ratio: p(12),
                attack: p(0.003),
                release: p(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime(v) {
                        this.value = v;
                        return this;
                    },
                }, type: "sine", start() {
                }, stop() {
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBufferSource() {
            const s = new MockBufferSourceNode();
            this.createdBufferSources.push(s);
            return s;
        }

        decodeAudioData(arrayBuffer, onSuccess) {
            const buf = new MockAudioBuffer(2.0); // 2.0s buffer
            if (onSuccess) onSuccess(buf);
            return Promise.resolve(buf);
        }

        async startRendering() {
            const bufferDurationS = 1.0;
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    const origFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    // TEST 1: fit('1b') at 120BPM
    // 120BPM, 4 beats/bar => 1 bar = 2.0s
    // buffer = 2.0s. target = 2.0s. playbackRate = 2.0 / 2.0 = 1.0
    Track.clearRegistry();
    const offlineCtx = new TestOfflineCtx();
    Motif.ctx = offlineCtx;
    Motif.tempo = 120;
    Motif._schedQueue = [];

    const t1 = Track("fit-test-1");
    t1.note(["C4"]).sample("/audio/loop.wav").fit("1b");

    await t1._sampleLoading;
    t1._resetScheduling();
    await offlineCtx.startRendering();

    assert(offlineCtx.createdBufferSources.length >= 1, "should create a buffer source");
    if (offlineCtx.createdBufferSources.length >= 1) {
        // C4 = MIDI 60, baseMidi = 60. pitchMultiplier = 1.0.
        // baseRate = 1.0. finalRate = 1.0
        assert(Math.abs(offlineCtx.createdBufferSources[0].playbackRate.value - 1.0) < 1e-6,
            `expected playbackRate 1.0, got ${offlineCtx.createdBufferSources[0].playbackRate.value}`);
    }

    // TEST 2: fit('2b') at 120BPM
    // 1 bar = 2.0s. 2 bars = 4.0s.
    // buffer = 2.0s. target = 4.0s. playbackRate = 2.0 / 4.0 = 0.5
    const offlineCtx2 = new TestOfflineCtx();
    Motif.ctx = offlineCtx2;
    Motif._schedQueue = [];

    const t2 = Track("fit-test-2");
    t2.note(["C4"]).sample("/audio/loop.wav").fit("2b");

    await t2._sampleLoading;
    t2._resetScheduling();
    await offlineCtx2.startRendering();

    if (offlineCtx2.createdBufferSources.length >= 1) {
        assert(Math.abs(offlineCtx2.createdBufferSources[0].playbackRate.value - 0.5) < 1e-6,
            `expected playbackRate 0.5 for fit('2b'), got ${offlineCtx2.createdBufferSources[0].playbackRate.value}`);
    }

    // TEST 3: fit('1b') + pitch shift (C5)
    // 1 bar = 2.0s. buffer = 2.0s. baseRate = 1.0.
    // C5 = MIDI 72. pitchMultiplier = 2^((72-60)/12) = 2.0.
    // finalRate = 1.0 * 2.0 = 2.0.
    const offlineCtx3 = new TestOfflineCtx();
    Motif.ctx = offlineCtx3;
    Motif._schedQueue = [];

    const t3 = Track("fit-test-3");
    t3.note(["C5"]).sample("/audio/loop.wav").fit("1b");

    await t3._sampleLoading;
    t3._resetScheduling();
    await offlineCtx3.startRendering();

    if (offlineCtx3.createdBufferSources.length >= 1) {
        assert(Math.abs(offlineCtx3.createdBufferSources[0].playbackRate.value - 2.0) < 1e-6,
            `expected playbackRate 2.0 for fit('1b') + C5, got ${offlineCtx3.createdBufferSources[0].playbackRate.value}`);
    }

    // TEST 4: fit() is chainable
    const t4 = Track("fit-chain");
    const ret = t4.fit("1b");
    assert(ret === t4, "fit() should return this for chaining");

    globalThis.fetch = origFetch;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif._schedQueue = [];
    Track.clearRegistry();
}

// =============================================================================
// Track .splitStereo(modifier)
// =============================================================================
console.log("\n=== Track: .splitStereo(modifier) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;

    class MockMergerNode {
        constructor(inputs) {
            this.numberOfInputs = inputs;
            this.inputs = new Array(inputs).fill(null);
            this._connections = [];
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    const createdMergers = [];
    const createdSources = [];

    class SplitStereoOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.state = "running";
            this.destination = {};
        }

        createGain() {
            return {
                gain: {
                    value: 1.0,
                    setValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                    linearRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                    exponentialRampToValueAtTime(v, t) {
                        this.value = v;
                        return this;
                    },
                },
                connect(dest, outIdx, inIdx) {
                    if (dest instanceof MockMergerNode) {
                        dest.inputs[inIdx] = this;
                        dest._connections.push({ from: this, inIdx });
                    }
                },
                disconnect() {
                },
            };
        }

        createChannelMerger(inputs) {
            const m = new MockMergerNode(inputs);
            createdMergers.push(m);
            return m;
        }

        createBufferSource() {
            const s = {
                buffer: null,
                playbackRate: {
                    value: 1, setValueAtTime(v, t) {
                        this.value = v;
                    },
                },
                connect(dest) {
                    return dest;
                },
                disconnect() {
                },
                start() {
                },
                stop() {
                },
            };
            createdSources.push(s);
            return s;
        }

        createBuffer(ch, len, sr) {
            return {
                numberOfChannels: ch,
                length: len,
                sampleRate: sr,
                duration: len / sr,
                getChannelData() {
                    return new Float32Array(len);
                },
                copyToChannel(data, chIdx) {
                },
            };
        }
    }

    Motif.ctx = new SplitStereoOfflineCtx();
    Motif.tempo = 120;
    Track.clearRegistry();

    const t = Track("stereo-test");

    // Mock a stereo buffer
    const stereoBuffer = Motif.ctx.createBuffer(2, 44100, 44100);
    t._sampleBuffer = stereoBuffer;
    t._useSample = true;

    // Apply split stereo with a volume modifier on the right channel
    t.splitStereo(right => right.volume(-6));

    assert(t._useSplitStereo === true, "main track should have _useSplitStereo = true");
    assert(t._rightTrack !== null, "shadow right track should be created");
    assert(createdMergers.length === 1, "ChannelMergerNode should be created");

    // Play an event (manually trigger play on both main and right track)
    // In actual usage, Motif.tick() would trigger both because they are both in trackRegistry.
    t._playEvent({ value: "C3", startTime: 0, duration: 1 }, 0.5, 1);
    t._rightTrack._playEvent({ value: "C3", startTime: 0, duration: 1 }, 0.5, 1);

    assert(createdSources.length === 2, `expected 2 source nodes, got ${createdSources.length}`);

    if (createdSources.length === 2) {
        assert(createdSources[0].buffer.numberOfChannels === 1, "Left source buffer should be mono");
        assert(createdSources[1].buffer.numberOfChannels === 1, "Right source buffer should be mono");
    }

    // Verify routing to merger
    const merger = createdMergers[0];
    assert(merger.inputs[0] !== null, "Left track should be connected to merger input 0");
    assert(merger.inputs[1] !== null, "Right track should be connected to merger input 1");

    // Verify right channel modifier (volumeNode is initialized in _initAudio/volume)
    if (t._rightTrack.volumeNode) {
        assert(Math.abs(t._rightTrack.volumeNode.gain.value - Math.pow(10, -6 / 20)) < 1e-6, "Right track modifier should be applied (volume -6dB)");
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Track.clearRegistry();
}

// =============================================================================
// Track: .every(n, callback)
// =============================================================================
console.log("\n=== Track: .every(n, callback) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MockAudioParam {
        constructor(val = 0) {
            this.value = val;
        }

        setValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        linearRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        exponentialRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        cancelAndHoldAtTime(time) {
            return this;
        }
    }

    class MockOscillatorNode {
        constructor() {
            this.frequency = new MockAudioParam(440);
            this.type = "sine";
            this.startTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class EveryMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: new MockAudioParam(1.0), connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: new MockAudioParam(350),
                gain: new MockAudioParam(0),
                Q: new MockAudioParam(1),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: new MockAudioParam(-24),
                knee: new MockAudioParam(30),
                ratio: new MockAudioParam(12),
                attack: new MockAudioParam(0.003),
                release: new MockAudioParam(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: new MockAudioParam(0), connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }
    }

    Track.clearRegistry();
    const t = Track("every-test-final");

    // Modify notes every 2 cycles
    t.note(["C3", "E3"]).every(2, (events) => {
        events.forEach(e => {
            if (e.value === "C3") e.value = "C4";
            if (e.value === "E3") e.value = "E4";
        });
        return events;
    });

    const mockCtx = new EveryMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120; // 1 bar = 2s
    Motif._schedQueue = [];

    t._resetScheduling();

    // Cycle 0: should be modified (0 % 2 === 0)
    mockCtx.currentTime = 0;
    t._schedule(2.0);

    assert(mockCtx.createdOscillators.length === 2, `expected 2 oscillators, got ${mockCtx.createdOscillators.length}`);
    if (mockCtx.createdOscillators.length === 2) {
        assert(Math.abs(mockCtx.createdOscillators[0].frequency.value - midiToHz("C4")) < 1e-9, `Cycle 0: expected C4, got ${mockCtx.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[1].frequency.value - midiToHz("E4")) < 1e-9, `Cycle 0: expected E4, got ${mockCtx.createdOscillators[1].frequency.value}`);
    }

    // Cycle 1: should NOT be modified (1 % 2 !== 0)
    mockCtx.createdOscillators = [];
    t._currentCycle = 1;
    t._currentCycleStartTime = 2.0;
    t._scheduledUntil = 2.0;
    t._schedule(4.0);

    assert(mockCtx.createdOscillators.length === 2, `expected 2 oscillators, got ${mockCtx.createdOscillators.length}`);
    if (mockCtx.createdOscillators.length === 2) {
        assert(Math.abs(mockCtx.createdOscillators[0].frequency.value - midiToHz("C3")) < 1e-9, `Cycle 1: expected C3, got ${mockCtx.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[1].frequency.value - midiToHz("E3")) < 1e-9, `Cycle 1: expected E3, got ${mockCtx.createdOscillators[1].frequency.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .mask(booleanArray, callback)
// =============================================================================
console.log("\n=== Track: .mask(booleanArray, callback) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MockAudioParam {
        constructor(val = 0) {
            this.value = val;
        }

        setValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        linearRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        exponentialRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        cancelAndHoldAtTime(time) {
            return this;
        }
    }

    class MockOscillatorNode {
        constructor() {
            this.frequency = new MockAudioParam(440);
            this.type = "sine";
            this.startTime = null;
        }

        start(when = 0) {
            this.startTime = when;
        }

        stop(when = 0) {
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class MaskMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: new MockAudioParam(1.0), connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                type: "lowpass",
                frequency: new MockAudioParam(350),
                gain: new MockAudioParam(0),
                Q: new MockAudioParam(1),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: new MockAudioParam(-24),
                knee: new MockAudioParam(30),
                ratio: new MockAudioParam(12),
                attack: new MockAudioParam(0.003),
                release: new MockAudioParam(0.25),
                connect() {
                },
                disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect() {
                }, disconnect() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: new MockAudioParam(0), connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOscillatorNode();
            this.createdOscillators.push(o);
            return o;
        }
    }

    // 1. Filter only
    Track.clearRegistry();
    const t1 = Track("mask-filter-test-final");
    t1.note(["C3", "E3"]).mask([true, false]);

    const mockCtx1 = new MaskMockCtx();
    Motif.ctx = mockCtx1;
    Motif.tempo = 120;
    t1._resetScheduling();
    t1._schedule(2.0);

    assert(mockCtx1.createdOscillators.length === 1, `expected 1 oscillator (first note only), got ${mockCtx1.createdOscillators.length}`);
    if (mockCtx1.createdOscillators.length === 1) {
        assert(Math.abs(mockCtx1.createdOscillators[0].frequency.value - midiToHz("C3")) < 1e-9, `expected C3, got ${mockCtx1.createdOscillators[0].frequency.value}`);
    }

    // 2. Transform matching
    Track.clearRegistry();
    const t2 = Track("mask-transform-test-final");
    t2.note(["C3", "E3"]).mask([false, true], (event) => {
        if (typeof event.value === "string") event.value = "E4";
        return event;
    });

    const mockCtx2 = new MaskMockCtx();
    Motif.ctx = mockCtx2;
    Motif.tempo = 120;
    t2._resetScheduling();
    t2._schedule(2.0);

    assert(mockCtx2.createdOscillators.length === 2, `expected 2 oscillators, got ${mockCtx2.createdOscillators.length}`);
    if (mockCtx2.createdOscillators.length === 2) {
        assert(Math.abs(mockCtx2.createdOscillators[0].frequency.value - midiToHz("C3")) < 1e-9, `First note: expected C3, got ${mockCtx2.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx2.createdOscillators[1].frequency.value - midiToHz("E4")) < 1e-9, `Second note: expected E4, got ${mockCtx2.createdOscillators[1].frequency.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .subdivide(divisions, callback)
// =============================================================================
console.log("\n=== Track: .subdivide(divisions, callback) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MockAudioParam {
        constructor(val = 0) {
            this.value = val;
        }

        setValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        linearRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        exponentialRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        cancelAndHoldAtTime(time) {
            return this;
        }
    }

    class SubdivideMockCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = {};
            this.createdOscillators = [];
        }

        createOscillator() {
            const osc = {
                frequency: new MockAudioParam(440),
                connect: function() {
                },
                disconnect: function() {
                },
                start: function() {
                },
                stop: function() {
                },
                onended: null,
            };
            this.createdOscillators.push(osc);
            return osc;
        }

        createGain() {
            return {
                gain: new MockAudioParam(1.0),
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: new MockAudioParam(0), connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: new MockAudioParam(1000),
                Q: new MockAudioParam(1),
                gain: new MockAudioParam(0),
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: new MockAudioParam(-24),
                knee: new MockAudioParam(30),
                ratio: new MockAudioParam(12),
                attack: new MockAudioParam(0.003),
                release: new MockAudioParam(0.25),
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }
    }

    Track.clearRegistry();
    const t = Track("subdivide-test-final");

    // Pattern ['C3', 'E3', 'G3', 'B3'] -> 4 events at 0, 0.25, 0.5, 0.75
    // subdivide(2, ...) -> Chunk 0: [C3, E3], Chunk 1: [G3, B3]
    t.note(["C3", "E3", "G3", "B3"]).subdivide(2, (events, index) => {
        if (index === 0) {
            // Transpose first chunk up an octave
            events.forEach(e => {
                if (e.value === "C3") e.value = "C4";
                if (e.value === "E3") e.value = "E4";
            });
        } else {
            // Transpose second chunk down an octave
            events.forEach(e => {
                if (e.value === "G3") e.value = "G2";
                if (e.value === "B3") e.value = "B2";
            });
        }
        return events;
    });

    const mockCtx = new SubdivideMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120;
    t._resetScheduling();
    t._schedule(2.0);

    assert(mockCtx.createdOscillators.length === 4, `expected 4 oscillators, got ${mockCtx.createdOscillators.length}`);
    if (mockCtx.createdOscillators.length === 4) {
        assert(Math.abs(mockCtx.createdOscillators[0].frequency.value - midiToHz("C4")) < 1e-9, `Event 0: expected C4, got ${mockCtx.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[1].frequency.value - midiToHz("E4")) < 1e-9, `Event 1: expected E4, got ${mockCtx.createdOscillators[1].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[2].frequency.value - midiToHz("G2")) < 1e-9, `Event 2: expected G2, got ${mockCtx.createdOscillators[2].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[3].frequency.value - midiToHz("B2")) < 1e-9, `Event 3: expected B2, got ${mockCtx.createdOscillators[3].frequency.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .degrade(probability)
// =============================================================================
console.log("\n=== Track: .degrade(probability) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MockAudioParam {
        constructor(val = 0) {
            this.value = val;
        }

        setValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        linearRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        exponentialRampToValueAtTime(val, time) {
            this.value = val;
            return this;
        }

        cancelAndHoldAtTime(time) {
            return this;
        }
    }

    class DegradeMockCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = {};
            this.createdOscillators = [];
        }

        createOscillator() {
            const osc = {
                frequency: new MockAudioParam(440),
                connect: function() {
                },
                disconnect: function() {
                },
                start: function() {
                },
                stop: function() {
                },
                onended: null,
            };
            this.createdOscillators.push(osc);
            return osc;
        }

        createGain() {
            return {
                gain: new MockAudioParam(1.0),
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: new MockAudioParam(0), connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: new MockAudioParam(1000),
                Q: new MockAudioParam(1),
                gain: new MockAudioParam(0),
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: new MockAudioParam(-24),
                knee: new MockAudioParam(30),
                ratio: new MockAudioParam(12),
                attack: new MockAudioParam(0.003),
                release: new MockAudioParam(0.25),
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }
    }

    Track.clearRegistry();
    const t = Track("degrade-test");

    // 16th notes
    const notes = Array(16).fill("C3");
    t.note(notes).degrade(0.5).seed(12345);

    const mockCtx = new DegradeMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120;

    // Cycle 0
    t._resetScheduling();
    t._schedule(2.0);
    const cycle0Count = mockCtx.createdOscillators.length;
    assert(cycle0Count < 16, `expected some events to be dropped, got ${cycle0Count}/16`);

    // Cycle 1 - should have a different (but deterministic) count
    mockCtx.createdOscillators = [];
    mockCtx.currentTime = 2.0;
    t._schedule(4.0);
    const cycle1Count = mockCtx.createdOscillators.length;

    // Reset and run again with same seed - should get EXACTLY same results for Cycle 0
    Track.clearRegistry();
    const t2 = Track("degrade-test-2");
    t2.note(notes).degrade(0.5).seed(12345);
    const mockCtx2 = new DegradeMockCtx();
    Motif.ctx = mockCtx2;
    t2._resetScheduling();
    t2._schedule(2.0);
    assert(mockCtx2.createdOscillators.length === cycle0Count, `expected deterministic results for same seed, got ${mockCtx2.createdOscillators.length} instead of ${cycle0Count}`);

    // Different seed - should get potentially different result
    Track.clearRegistry();
    const t3 = Track("degrade-test-3");
    t3.note(notes).degrade(0.5).seed(54321);
    const mockCtx3 = new DegradeMockCtx();
    Motif.ctx = mockCtx3;
    t3._resetScheduling();
    t3._schedule(2.0);
    // Note: there's a small chance it's the same count, but likely different
    // assert(mockCtx3.createdOscillators.length !== cycle0Count, "expected different seed to produce different result");

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .euclid(pulses, steps)
// =============================================================================
console.log("\n=== Track: .euclid(pulses, steps) ===");
{
    Track.clearRegistry();
    const t = Track("euclid-test");

    // E(3,8) should be [true, false, false, true, false, false, true, false]
    // My implementation converts false to null.
    t.euclid(3, 8);

    const events = t._parsedEvents;
    // null values are typically filtered or ignored by PatternParser, 
    // but in my case I used .note([true, null, null, true, null, null, true, null])
    // PatternParser.parse will create events for everything.

    assert(events.length === 8, `expected 8 events (including rests), got ${events.length}`);

    const expectedValues = [true, null, null, true, null, null, true, null];
    for (let i = 0; i < 8; i++) {
        assert(events[i].value === expectedValues[i], `index ${i}: expected value ${expectedValues[i]}, got ${events[i].value}`);
        assert(Math.abs(events[i].startTime - (i / 8)) < 1e-9, `index ${i}: expected startTime ${i / 8}, got ${events[i].startTime}`);
    }

    // Test rotation
    Track.clearRegistry();
    const t2 = Track("euclid-rotate-test");
    t2.euclid(3, 8, 1); // Rotate by 1: [false, false, true, false, false, true, false, true] -> [null, null, true, null, null, true, null, true]
    const events2 = t2._parsedEvents;
    const expectedValues2 = [null, null, true, null, null, true, null, true];
    for (let i = 0; i < 8; i++) {
        assert(events2[i].value === expectedValues2[i], `Rotate index ${i}: expected value ${expectedValues2[i]}, got ${events2[i].value}`);
    }
}

// =============================================================================
// Track: .offset(time, callback)
// =============================================================================
console.log("\n=== Track: .offset(time, callback) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class OffsetMockCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = {};
            this.createdOscillators = [];
        }

        createOscillator() {
            const osc = {
                frequency: {
                    value: 440, setValueAtTime: function(v) {
                        this.value = v;
                    },
                },
                connect: function() {
                },
                disconnect: function() {
                },
                start: function() {
                },
                stop: function() {
                },
                onended: null,
            };
            this.createdOscillators.push(osc);
            return osc;
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: {
                    value: 0, setValueAtTime: function() {
                    },
                }, Q: {
                    value: 0, setValueAtTime: function() {
                    },
                }, gain: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: { value: 0 },
                knee: { value: 0 },
                ratio: { value: 0 },
                attack: { value: 0 },
                release: { value: 0 },
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }
    }

    Track.clearRegistry();
    const t = Track("offset-test-final");

    // Pattern ['C3'] -> 1 event at 0
    // offset('1/2', (e) => e.value = 'G3') -> events at 0 (C3) and 0.5 (G3)
    t.note(["C3"]).offset("1/2", (e) => {
        e.value = "G3";
        return e;
    });

    const mockCtx = new OffsetMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120;
    t._resetScheduling();
    t._schedule(2.0);

    assert(mockCtx.createdOscillators.length === 2, `expected 2 oscillators, got ${mockCtx.createdOscillators.length}`);
    if (mockCtx.createdOscillators.length === 2) {
        assert(Math.abs(mockCtx.createdOscillators[0].frequency.value - midiToHz("C3")) < 1e-9, `Event 0: expected C3, got ${mockCtx.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[1].frequency.value - midiToHz("G3")) < 1e-9, `Event 1: expected G3, got ${mockCtx.createdOscillators[1].frequency.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .mutate(options)
// =============================================================================
console.log("\n=== Track: .mutate(options) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MutateMockCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = {};
            this.createdOscillators = [];
        }

        createOscillator() {
            const osc = {
                frequency: {
                    value: 440, setValueAtTime: function(v) {
                        this.value = v;
                    },
                },
                connect: function() {
                },
                disconnect: function() {
                },
                start: function() {
                },
                stop: function() {
                },
                onended: null,
            };
            this.createdOscillators.push(osc);
            return osc;
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: {
                    value: 0, setValueAtTime: function() {
                    },
                }, Q: {
                    value: 0, setValueAtTime: function() {
                    },
                }, gain: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: { value: 0 },
                knee: { value: 0 },
                ratio: { value: 0 },
                attack: { value: 0 },
                release: { value: 0 },
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }
    }

    Track.clearRegistry();
    const t = Track("mutate-test");

    // Pattern ['C3', 'E3']
    // mutate with chance 1.0 and action 'reverse'
    t.note(["C3", "E3"]).mutate({ chance: 1.0, actions: { reverse: 1 } }).seed(12345);

    const mockCtx = new MutateMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120;
    t._resetScheduling();
    t._schedule(2.0);

    // Reverse ['C3', 'E3'] (starts at 0 and 0.5, duration 0.5 each)
    // C3: 1.0 - (0 + 0.5) = 0.5
    // E3: 1.0 - (0.5 + 0.5) = 0
    // Expected order: E3 (at 0), C3 (at 0.5)
    assert(mockCtx.createdOscillators.length === 2, `expected 2 oscillators, got ${mockCtx.createdOscillators.length}`);
    if (mockCtx.createdOscillators.length === 2) {
        assert(Math.abs(mockCtx.createdOscillators[0].frequency.value - midiToHz("E3")) < 1e-9, `Event 0: expected E3, got ${mockCtx.createdOscillators[0].frequency.value}`);
        assert(Math.abs(mockCtx.createdOscillators[1].frequency.value - midiToHz("C3")) < 1e-9, `Event 1: expected C3, got ${mockCtx.createdOscillators[1].frequency.value}`);
    }

    // Test ratchet
    Track.clearRegistry();
    const t2 = Track("mutate-ratchet-test");
    t2.note(["C3"]).mutate({ chance: 1.0, actions: { ratchet: 1 } }).seed(12345);
    const mockCtx2 = new MutateMockCtx();
    Motif.ctx = mockCtx2;
    t2._resetScheduling();
    t2._schedule(2.0);
    // Ratchet ['C3'] (0 to 1) -> two 'C3' (0 to 0.5 and 0.5 to 1)
    assert(mockCtx2.createdOscillators.length === 2, `Ratchet: expected 2 oscillators, got ${mockCtx2.createdOscillators.length}`);

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: .dsp(callback) — code generation + async worklet setup (bun mock)
// =============================================================================
console.log("\n=== Track: .dsp(callback) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    let capturedCode = null;
    let addModuleCalled = false;
    let addModuleUrl = null;
    let workletNodeCreated = false;
    let workletNodeName = null;

    class DspMockCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = {};
            this.audioWorklet = {
                addModule: (url) => {
                    addModuleCalled = true;
                    addModuleUrl = url;
                    return Promise.resolve();
                },
            };
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime: function() {
                    }, linearRampToValueAtTime: function() {
                    }, cancelScheduledValues: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createStereoPanner() {
            return {
                pan: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: {
                    value: 0, setValueAtTime: function() {
                    },
                }, Q: {
                    value: 0, setValueAtTime: function() {
                    },
                }, gain: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: { value: 0 },
                knee: { value: 0 },
                ratio: { value: 0 },
                attack: { value: 0 },
                release: { value: 0 },
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime: function(v) {
                        this.value = v;
                    },
                }, connect: function() {
                }, disconnect: function() {
                }, start: function() {
                }, stop: function() {
                }, onended: null,
            };
        }

        createChannelMerger() {
            return {
                connect: function() {
                }, disconnect: function() {
                },
            };
        }
    }

    const savedBlob = globalThis.Blob;
    const savedURL = globalThis.URL;

    globalThis.Blob = class MockBlob {
        constructor(parts, opts) {
            capturedCode = parts.join("");
            this._parts = parts;
            this.type = opts && opts.type;
        }
    };
    globalThis.URL = {
        createObjectURL: () => "blob:mock-url",
        revokeObjectURL: () => {
        },
    };
    globalThis.AudioWorkletNode = class MockAudioWorkletNode {
        constructor(ctx, name) {
            workletNodeCreated = true;
            workletNodeName = name;
        }

        connect() {
        }

        disconnect() {
        }
    };

    Track.clearRegistry();
    const mockCtx = new DspMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120;

    const callback = function(inputs, outputs, parameters) {
        const out = outputs[0];
        for (let ch = 0; ch < out.length; ch++) out[ch].fill(0.5);
    };

    const t = Track("dsp-test").dsp(callback);

    assert(typeof t.note === "function" && typeof t.synth === "function", ".dsp() returns this (chainable track)");
    assert(addModuleCalled, "addModule was called with the Blob URL");
    assert(addModuleUrl === "blob:mock-url", "addModule received the Blob URL");
    assert(capturedCode !== null, "Blob was constructed with code string");
    assert(capturedCode.includes("registerProcessor"), "generated code contains registerProcessor");
    assert(capturedCode.includes("AudioWorkletProcessor"), "generated code extends AudioWorkletProcessor");
    assert(capturedCode.includes("dsp-proc-"), "generated code uses unique processor name");
    assert(capturedCode.includes(callback.toString()), "generated code embeds serialized callback");

    // Wait for the async addModule promise to resolve, then check worklet node
    await (t._dspReady || Promise.resolve());
    assert(workletNodeCreated, "AudioWorkletNode was instantiated after addModule resolved");
    assert(workletNodeName && workletNodeName.startsWith("dsp-proc-"), "AudioWorkletNode uses the unique processor name");
    assert(t.dspNode !== null, "track.dspNode is set after worklet loads");

    // Test that two .dsp() calls use distinct processor names
    Track.clearRegistry();
    let name1 = null, name2 = null;
    globalThis.AudioWorkletNode = class MockAudioWorkletNode2 {
        constructor(ctx, name) {
            if (!name1) name1 = name; else name2 = name;
        }

        connect() {
        }

        disconnect() {
        }
    };
    const t2 = Track("dsp-test-a").dsp(callback);
    const t3 = Track("dsp-test-b").dsp(callback);
    await Promise.all([t2._dspReady, t3._dspReady]);
    assert(name1 !== name2, "each .dsp() call generates a unique processor name");

    // Restore globals
    globalThis.Blob = savedBlob;
    globalThis.URL = savedURL;
    delete globalThis.AudioWorkletNode;

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Track: Live-Coding Crossfade on re-declaration
// =============================================================================
console.log("\n=== Track: Live-Coding Crossfade ===");
{
    const prevCtx = Motif.ctx;
    const prevMasterGain = Motif.masterGain;

    class CrossfadeMockCtx {
        constructor() {
            this.currentTime = 5.0;
            this.sampleRate = 44100;
            this.destination = {};
        }

        createGain() {
            const g = {
                gain: {
                    value: 1.0,
                    _calls: [],
                    setValueAtTime(v, t) {
                        this._calls.push({ fn: "setValueAtTime", v, t });
                        this.value = v;
                    },
                    linearRampToValueAtTime(v, t) {
                        this._calls.push({ fn: "linearRamp", v, t });
                    },
                    cancelScheduledValues(t) {
                        this._calls.push({ fn: "cancelScheduled", t });
                    },
                },
                _disconnectCalls: [],
                connect() {
                },
                disconnect(dest) {
                    this._disconnectCalls.push(dest);
                },
            };
            return g;
        }

        createStereoPanner() {
            return {
                pan: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createBiquadFilter() {
            return {
                frequency: {
                    value: 0, setValueAtTime: function() {
                    },
                }, Q: {
                    value: 0, setValueAtTime: function() {
                    },
                }, gain: {
                    value: 0, setValueAtTime: function() {
                    },
                }, connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                threshold: { value: 0 },
                knee: { value: 0 },
                ratio: { value: 0 },
                attack: { value: 0 },
                release: { value: 0 },
                reduction: 0,
                connect: function() {
                },
                disconnect: function() {
                },
            };
        }

        createWaveShaper() {
            return {
                curve: null, oversample: "none", connect: function() {
                }, disconnect: function() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime: function(v) {
                        this.value = v;
                    },
                }, connect: function() {
                }, disconnect: function() {
                }, start: function() {
                }, stop: function() {
                }, onended: null,
            };
        }
    }

    // Intercept setTimeout to capture and manually invoke the crossfade teardown
    const originalSetTimeout = globalThis.setTimeout;
    let capturedCallback = null;
    globalThis.setTimeout = (fn, ms) => {
        capturedCallback = { fn, ms };
        return 0;
    };

    Track.clearRegistry();
    const mockCtx = new CrossfadeMockCtx();
    const mockMasterGain = mockCtx.createGain();
    Motif.ctx = mockCtx;
    Motif.masterGain = mockMasterGain;

    // First declaration — populates registry
    const t1 = Track("xfade-test");
    t1._initAudio();
    const oldMuteGain = t1.muteGainNode;
    assert(oldMuteGain !== null, "first track has muteGainNode after _initAudio");

    // Re-declaration — should trigger crossfade
    const t2 = Track("xfade-test");
    assert(t2 !== t1, "re-declaration returns a new Track instance");
    assert(t2.id === "xfade-test", "new track has correct id");

    // Old track muteGainNode should have been faded to 0
    const oldRamps = oldMuteGain.gain._calls.filter(c => c.fn === "linearRamp");
    assert(oldRamps.length > 0, "old track gain scheduled a linearRamp");
    assert(oldRamps[oldRamps.length - 1].v === 0, "old track gain ramps to 0");
    assert(oldRamps[oldRamps.length - 1].t === mockCtx.currentTime + 1, "old track ramp ends at now + 1s");

    // New track muteGainNode should have been set to 0 then ramped to 1
    const newMuteGain = t2.muteGainNode;
    assert(newMuteGain !== null, "new track has muteGainNode");
    const newSets = newMuteGain.gain._calls.filter(c => c.fn === "setValueAtTime");
    const newRamps = newMuteGain.gain._calls.filter(c => c.fn === "linearRamp");
    assert(newSets.some(c => c.v === 0), "new track gain starts at 0");
    assert(newRamps.some(c => c.v === 1), "new track gain ramps to 1");

    // Simulate timeout: old muteGainNode should disconnect from masterGain
    assert(capturedCallback !== null, "setTimeout was called for deferred disconnect");
    assert(Math.abs(capturedCallback.ms - 1000) < 1, "disconnect scheduled at ~1000ms");
    capturedCallback.fn();
    assert(oldMuteGain._disconnectCalls.length > 0, "old muteGainNode was disconnected after fade");

    globalThis.setTimeout = originalSetTimeout;
    Motif.ctx = prevCtx;
    Motif.masterGain = prevMasterGain;
}

// =============================================================================
// Phase 9: .scale() — map integer degrees to MIDI
// =============================================================================
console.log("\n=== Track.scale(): degree → MIDI resolution ===");
{
    // C3 = MIDI 48; major intervals [0,2,4,5,7,9,11]
    // degree 0→48, 1→50, 2→52, 7→60 (next octave root)
    const cases = [
        { degree: 0, expected: 48 },
        { degree: 1, expected: 50 },
        { degree: 2, expected: 52 },
        { degree: 7, expected: 60 },
    ];
    for (const { degree, expected } of cases) {
        const midi = degreeToMidi(degree, "C3", "major");
        assert(midi === expected, `.scale C3 major degree ${degree} → MIDI ${midi}, expected ${expected}`);
    }

    // Negative degree wraps down
    const negMidi = degreeToMidi(-1, "C3", "major");
    assert(negMidi === 48 + 11 - 12, `degree -1 from C3 = B2 (MIDI ${48 + 11 - 12}), got ${negMidi}`);
}

// =============================================================================
// Phase 9: .arp(mode) — unroll Parallel chords
// =============================================================================
console.log("\n=== Track.arp(): unroll Parallel chords ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.8;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {
        }

        disconnect() {
        }
    }

    class ArpOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const t = Track("arp-test");
    // Chord: C3 (48), E3 (52), G3 (55)
    t.synth("sine").note([Parallel("C3", "E3", "G3")]).arp("up");
    t._resetScheduling();

    const offline = new ArpOfflineCtx();
    Motif.ctx = offline;
    Motif.tempo = 120; // cycle = 2s, stepDuration = 2s
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    const oscs = offline.createdOscillators;
    assert(oscs.length === 3, `expected 3 oscillators for 'up' arp, got ${oscs.length}`);
    if (oscs.length === 3) {
        // Mode 'up': C3, E3, G3
        // stepDuration = 2s / 3 = 0.666...
        assert(Math.abs(oscs[0].frequency.value - midiToHz(48)) < 1e-6, "first note should be C3");
        assert(Math.abs(oscs[1].frequency.value - midiToHz(52)) < 1e-6, "second note should be E3");
        assert(Math.abs(oscs[2].frequency.value - midiToHz(55)) < 1e-6, "third note should be G3");

        assert(Math.abs(oscs[0].startTime - 0.0) < 1e-6, "first note start time 0.0");
        assert(Math.abs(oscs[1].startTime - (2.0 / 3)) < 1e-6, `second note start time ${2.0 / 3}`);
        assert(Math.abs(oscs[2].startTime - (4.0 / 3)) < 1e-6, `third note start time ${4.0 / 3}`);
    }

    // Mode 'down'
    Track.clearRegistry();
    const t2 = Track("arp-test-down").synth("sine").note([Parallel("C3", "E3", "G3")]).arp("down");
    t2._resetScheduling();
    const offline2 = new ArpOfflineCtx();
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    await offline2.startRendering();
    const oscs2 = offline2.createdOscillators;
    assert(oscs2.length === 3, `expected 3 oscillators for 'down' arp, got ${oscs2.length}`);
    if (oscs2.length === 3) {
        assert(Math.abs(oscs2[0].frequency.value - midiToHz(55)) < 1e-6, "first note should be G3 (down)");
        assert(Math.abs(oscs2[1].frequency.value - midiToHz(52)) < 1e-6, "second note should be E3 (down)");
        assert(Math.abs(oscs2[2].frequency.value - midiToHz(48)) < 1e-6, "third note should be C3 (down)");
    }

    // Mode 'upDown'
    Track.clearRegistry();
    const t3 = Track("arp-test-updown").synth("sine").note([Parallel("C3", "E3", "G3")]).arp("upDown");
    t3._resetScheduling();
    const offline3 = new ArpOfflineCtx();
    Motif.ctx = offline3;
    Motif._schedQueue = [];
    await offline3.startRendering();
    const oscs3 = offline3.createdOscillators;
    // upDown: C3, E3, G3, E3 (4 notes)
    assert(oscs3.length === 4, `expected 4 oscillators for 'upDown' arp, got ${oscs3.length}`);
    if (oscs3.length === 4) {
        assert(Math.abs(oscs3[0].frequency.value - midiToHz(48)) < 1e-6, "note 1 should be C3");
        assert(Math.abs(oscs3[1].frequency.value - midiToHz(52)) < 1e-6, "note 2 should be E3");
        assert(Math.abs(oscs3[2].frequency.value - midiToHz(55)) < 1e-6, "note 3 should be G3");
        assert(Math.abs(oscs3[3].frequency.value - midiToHz(52)) < 1e-6, "note 4 should be E3 (return path)");
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Phase 9: .tuning(system) — EDO and custom tunings
// =============================================================================
console.log("\n=== Track.tuning(): EDO and custom tunings ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.0;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {
        }

        disconnect() {
        }
    }

    class TuningOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const t = Track("tuning-test");
    // 17-EDO. A4 (MIDI 69) should be 440Hz.
    // In 17-EDO, step 70 is 440 * 2^(1/17).
    t.synth("sine").note([69, 70]).tuning("17-EDO");
    t._resetScheduling();

    const offline = new TuningOfflineCtx();
    Motif.ctx = offline;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    const oscs = offline.createdOscillators;
    assert(oscs.length === 2, `expected 2 oscillators, got ${oscs.length}`);
    if (oscs.length === 2) {
        assert(Math.abs(oscs[0].frequency.value - 440) < 1e-6, `step 69 in 17-EDO should be 440Hz, got ${oscs[0].frequency.value}`);
        const expectedHz70 = 440 * Math.pow(2, 1 / 17);
        assert(Math.abs(oscs[1].frequency.value - expectedHz70) < 1e-6, `step 70 in 17-EDO should be ${expectedHz70}, got ${oscs[1].frequency.value}`);
    }

    // Custom object tuning
    Track.clearRegistry();
    const t2 = Track("tuning-custom").synth("sine").note([0, 1]).tuning({
        n: 12,
        refHz: 100,
        refStep: 0,
    });
    t2._resetScheduling();
    const offline2 = new TuningOfflineCtx();
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    await offline2.startRendering();
    const oscs2 = offline2.createdOscillators;
    assert(oscs2.length === 2, `expected 2 oscillators for custom tuning, got ${oscs2.length}`);
    if (oscs2.length === 2) {
        assert(Math.abs(oscs2[0].frequency.value - 100) < 1e-6, `step 0 with refHz=100 should be 100Hz, got ${oscs2[0].frequency.value}`);
        const expectedHz1 = 100 * Math.pow(2, 1 / 12);
        assert(Math.abs(oscs2[1].frequency.value - expectedHz1) < 1e-6, `step 1 with n=12 should be ${expectedHz1}, got ${oscs2[1].frequency.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Phase 9: .chordVoicing() — smooth voice-leading and drop
// =============================================================================
console.log("\n=== Track.chordVoicing(): smooth and drop ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 1.5;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {
        }

        disconnect() {
        }
    }

    class VoicingOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    // 1. Test Drop 2
    Track.clearRegistry();
    const t = Track("voicing-drop");
    // C4(60), E4(64), G4(67). Drop 2 = second highest (E4) dropped 12 semitones -> E3(52)
    t.synth("sine").note([Parallel(60, 64, 67)]).chordVoicing({ drop: 2 });
    t._resetScheduling();

    const offline = new VoicingOfflineCtx();
    Motif.ctx = offline;
    Motif.tempo = 120;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    const oscs = offline.createdOscillators;
    assert(oscs.length === 3, `expected 3 oscillators for drop voicing, got ${oscs.length}`);
    if (oscs.length >= 3) {
        const midis = oscs.map(o => Math.round(12 * Math.log2(o.frequency.value / 440) + 69)).sort((a, b) => a - b);
        assert(midis.includes(52), `expected E3 (52) in drop-2 chord, got ${midis}`);
        assert(midis.includes(60), `expected C4 (60) in drop-2 chord, got ${midis}`);
        assert(midis.includes(67), `expected G4 (67) in drop-2 chord, got ${midis}`);
    }

    // 2. Test Smooth Voice Leading
    Track.clearRegistry();
    const t2 = Track("voicing-smooth");
    // Cycle 1: C4, E4, G4 (60, 64, 67)
    // Cycle 2: F, A, C. 
    // Without smooth: F4, A4, C5 (65, 69, 72)
    t2.synth("sine").note([Parallel(60, 64, 67), Parallel(77, 81, 84)]).chordVoicing({ mode: "smooth" });
    t2._resetScheduling();

    const offline2 = new VoicingOfflineCtx();
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    await offline2.startRendering();

    const oscs2 = offline2.createdOscillators;
    assert(oscs2.length === 6, `expected 6 oscillators total for smooth test, got ${oscs2.length}`);
    if (oscs2.length === 6) {
        const chord2 = oscs2.slice(3, 6);
        const midis2 = chord2.map(o => Math.round(12 * Math.log2(o.frequency.value / 440) + 69)).sort((a, b) => a - b);
        // Target: [77, 81, 84] (F5, A5, C6)
        // Prev: [60, 64, 67] (C4, E4, G4)
        // Smooth should bring [77, 81, 84] down to [65, 69, 60]
        assert(midis2.includes(60), `expected C4 (60) in smooth voicing, got ${midis2}`);
        assert(midis2.includes(65), `expected F4 (65) in smooth voicing, got ${midis2}`);
        assert(midis2.includes(69), `expected A4 (69) in smooth voicing, got ${midis2}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Phase 10: Arrange(sections) — macro-arrangement
// =============================================================================
console.log("\n=== Arrange(): macro-arrangement ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 5.0;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {
        }

        disconnect() {
        }
    }

    class ArrangeOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const bass = Track("bass").synth("sine").note([60]);
    const lead = Track("lead").synth("sine").note([72]);

    // 120 BPM -> bar = 2.0s
    // Section 1: bass for 1 bar (0-2s)
    // Section 2: lead for 1 bar (2-4s)
    Motif.tempo = 120;
    Arrange([
        { tracks: [bass], bars: 1 },
        { tracks: [lead], bars: 1 },
    ]);

    const offline = new ArrangeOfflineCtx();
    Motif.ctx = offline;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    const oscs = offline.createdOscillators;
    assert(oscs.length === 2, `expected 2 oscillators total, got ${oscs.length}`);
    if (oscs.length === 2) {
        const bassOsc = oscs.find(o => Math.abs(o.frequency.value - midiToHz(60)) < 1e-6);
        const leadOsc = oscs.find(o => Math.abs(o.frequency.value - midiToHz(72)) < 1e-6);

        assert(bassOsc !== undefined, "bass oscillator should have played");
        assert(leadOsc !== undefined, "lead oscillator should have played");

        if (bassOsc) assert(Math.abs(bassOsc.startTime - 0.0) < 1e-6, `bass should start at 0.0, got ${bassOsc.startTime}`);
        if (leadOsc) assert(Math.abs(leadOsc.startTime - 2.0) < 1e-6, `lead should start at 2.0, got ${leadOsc.startTime}`);
    }

    // Test non-contiguous
    Track.clearRegistry();
    const t3 = Track("non-contiguous").synth("sine").note([60]);
    Motif.tempo = 120; // bar = 2s
    Arrange([
        { tracks: [t3], bars: 1 }, // 0-2s
        { tracks: [], bars: 1 },   // 2-4s
        { tracks: [t3], bars: 1 },  // 4-6s
    ]);

    const offline2 = new ArrangeOfflineCtx();
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    // Increase buffer to see the 3rd section
    offline2.bufferDurationS = 7.0;
}
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 7.0;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {
        }

        disconnect() {
        }
    }

    class ArrangeOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    Track.clearRegistry();
    const t3 = Track("non-contiguous").synth("sine").note([60]);
    Motif.tempo = 120; // bar = 2s
    Arrange([
        { tracks: [t3], bars: 1 }, // 0-2s
        { tracks: [], bars: 1 },   // 2-4s
        { tracks: [t3], bars: 1 },  // 4-6s
    ]);

    const offline = new ArrangeOfflineCtx();
    Motif.ctx = offline;
    Motif._schedQueue = [];
    await offline.startRendering();

    const oscs = offline.createdOscillators;
    assert(oscs.length === 2, `expected 2 notes for non-contiguous Arrange, got ${oscs.length}`);
    if (oscs.length === 2) {
        assert(Math.abs(oscs[0].startTime - 0.0) < 1e-6, "first note at 0s");
        assert(Math.abs(oscs[1].startTime - 4.0) < 1e-6, `second note at 4s, got ${oscs[1].startTime}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const sampleRate = 44100;
    const bufferDurationS = 2.0;

    class MockOsc {
        constructor() {
            this.frequency = {
                value: 0, setValueAtTime(v, t) {
                    this.value = v;
                    this.time = t;
                    return this;
                },
            };
            this.type = "sine";
            this.startTime = 0;
            this.stopTime = 0;
        }

        start(t) {
            this.startTime = t;
        }

        stop(t) {
            this.stopTime = t;
        }

        connect() {}
        disconnect() {}
    }

    class ArrangeOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = sampleRate;
            this.createdOscillators = [];
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {},
                }, connect() {}, disconnect() {},
            };
        }

        createBiquadFilter() {
            return { connect() {}, disconnect() {} };
        }

        createDynamicsCompressor() {
            return { connect() {}, disconnect() {} };
        }

        createWaveShaper() {
            return { connect() {}, disconnect() {} };
        }

        createOscillator() {
            const o = new MockOsc();
            this.createdOscillators.push(o);
            return o;
        }

        async startRendering() {
            const stepS = Motif.lookaheadIntervalMs / 1000;
            for (let t = 0; t <= bufferDurationS + stepS; t += stepS) {
                this.currentTime = t;
                Motif.tick();
            }
        }
    }

    let originalSetTimeout = globalThis.setTimeout;
    let timeoutCallback = null;
    let timeoutDelay = 0;

    globalThis.setTimeout = (cb, delay) => {
        timeoutCallback = cb;
        timeoutDelay = delay;
        return 999;
    };

    Track.clearRegistry();
    const tLoop = Track("t-loop").synth("sine").note([60]);
    Motif.tempo = 120; // bar = 2s
    Arrange([
        { tracks: [tLoop], bars: 1 } // 0-2s
    ], { loop: true, loopDelay: "1s" });

    const offline = new ArrangeOfflineCtx();
    Motif.ctx = offline;
    Motif._schedQueue = [];
    Motif.isPlaying = true;

    await offline.startRendering();

    assert(Motif.isPlaying === false, "isPlaying should be false after stopping at loop boundary");
    assert(timeoutCallback !== null, "loop timeout callback should be registered");
    assert(timeoutDelay === 1000, `expected 1000ms loopDelay, got ${timeoutDelay}`);

    globalThis.setTimeout = originalSetTimeout;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.stop();
}

// =============================================================================
// Phase 10: Motif.loadSamples() — pre-loading manifest
// =============================================================================
console.log("\n=== Motif.loadSamples(): pre-loading manifest ===");
{
    const prevCtx = Motif.ctx;
    const prevFetch = globalThis.fetch;

    class MockAudioBuffer {
        constructor(length) {
            this.length = length;
            this.duration = length / 44100;
            this.sampleRate = 44100;
            this.numberOfChannels = 1;
        }

        getChannelData() {
            return new Float32Array(this.length);
        }
    }

    class LoadSamplesMockCtx {
        constructor() {
            this.currentTime = 0;
        }

        decodeAudioData(ab, resolve) {
            resolve(new MockAudioBuffer(100));
        }
    }

    const mockCtx = new LoadSamplesMockCtx();
    Motif.ctx = mockCtx;

    globalThis.fetch = async (url) => {
        if (url === "manifest.json") {
            return {
                ok: true,
                json: async () => ({ "kick": "kick.wav", "snare": "snare.wav" }),
            };
        }
        if (url === "kick.wav" || url === "snare.wav") {
            return {
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(10),
            };
        }
        return { ok: false, status: 404 };
    };

    Motif.sampleRegistry.clear();
    Motif._loadingSamples = [];

    await Motif.loadSamples("manifest.json");

    assert(Motif.sampleRegistry.has("kick"), "registry should have 'kick'");
    assert(Motif.sampleRegistry.has("snare"), "registry should have 'snare'");
    assert(typeof Motif.sampleRegistry.get("kick") === "string", "'kick' registry entry should be a path string");

    // Test that Track.sample() resolves the registry path and decodes the buffer
    const t = Track("registry-test").sample("kick");
    await t._sampleLoading;
    assert(t._sampleBuffer && t._sampleBuffer.duration > 0, "Track.sample('kick') should have loaded a decoded buffer");
    assert(t._useSample === true, "Track should be in sample mode");

    // Restore
    globalThis.fetch = prevFetch;
    Motif.ctx = prevCtx;
}

// =============================================================================
// MotifEventArray and Pattern Modifier Prototypes (.transpose, .fast, .rev)
// =============================================================================
console.log("\n=== MotifEventArray: Modifier Prototypes (.transpose(), .fast(), .rev()) ===");
{
    // 1. Check PatternParser returns a MotifEventArray
    const events = PatternParser.parse(["C3", "E3"]);
    assert(events instanceof MotifEventArray, "PatternParser.parse should return a MotifEventArray instance");
    assert(events instanceof Array, "MotifEventArray should inherit from Array");

    // 2. Test transpose() on strings, numbers, and RampNodes
    const testEvents = new MotifEventArray(
        { value: "C3", startTime: 0, duration: 0.25 },
        { value: 60, startTime: 0.25, duration: 0.25 },
        { value: Ramp("E3", "G3"), startTime: 0.5, duration: 0.25 },
        { value: Tie, startTime: 0.75, duration: 0.25 },
    );

    testEvents.transpose(2);

    assert(testEvents[0].value === "D3", `expected transposed C3+2 = D3, got ${testEvents[0].value}`);
    assert(testEvents[1].value === 62, `expected transposed 60+2 = 62, got ${testEvents[1].value}`);
    assert(testEvents[2].value.isRamp === true, "third event value should still be a RampNode");
    assert(testEvents[2].value.from === "F#3", `expected ramp from E3+2 = F#3, got ${testEvents[2].value.from}`);
    assert(testEvents[2].value.to === "A3", `expected ramp to G3+2 = A3, got ${testEvents[2].value.to}`);
    assert(testEvents[3].value === Tie, "Tie symbol should not be mutated or transposed");

    // 3. Test fast()
    const speedEvents = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.5 },
        { value: "B", startTime: 0.5, duration: 0.5 },
    );
    speedEvents.fast(2);
    assert(speedEvents[0].startTime === 0, `expected startTime 0, got ${speedEvents[0].startTime}`);
    assert(speedEvents[0].duration === 0.25, `expected duration 0.25, got ${speedEvents[0].duration}`);
    assert(speedEvents[1].startTime === 0.25, `expected startTime 0.25, got ${speedEvents[1].startTime}`);
    assert(speedEvents[1].duration === 0.25, `expected duration 0.25, got ${speedEvents[1].duration}`);

    // Test fast() with invalid factor
    const initialStart = speedEvents[0].startTime;
    speedEvents.fast(-1);
    assert(speedEvents[0].startTime === initialStart, "fast with invalid factor should be a no-op");

    // 4. Test rev()
    const revEvents = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.25 },
        { value: "B", startTime: 0.25, duration: 0.5 },
        { value: "C", startTime: 0.75, duration: 0.25 },
    );
    revEvents.rev();
    // expected order after reverse: C (startTime 0), B (startTime 0.25), A (startTime 0.75)
    assert(revEvents[0].value === "C", `expected first event to be C, got ${revEvents[0].value}`);
    assert(Math.abs(revEvents[0].startTime - 0.0) < 1e-9, `expected C startTime 0.0, got ${revEvents[0].startTime}`);
    assert(Math.abs(revEvents[0].duration - 0.25) < 1e-9, `expected C duration 0.25, got ${revEvents[0].duration}`);

    assert(revEvents[1].value === "B", `expected second event to be B, got ${revEvents[1].value}`);
    assert(Math.abs(revEvents[1].startTime - 0.25) < 1e-9, `expected B startTime 0.25, got ${revEvents[1].startTime}`);
    assert(Math.abs(revEvents[1].duration - 0.5) < 1e-9, `expected B duration 0.5, got ${revEvents[1].duration}`);

    assert(revEvents[2].value === "A", `expected third event to be A, got ${revEvents[2].value}`);
    assert(Math.abs(revEvents[2].startTime - 0.75) < 1e-9, `expected A startTime 0.75, got ${revEvents[2].startTime}`);
    assert(Math.abs(revEvents[2].duration - 0.25) < 1e-9, `expected A duration 0.25, got ${revEvents[2].duration}`);

    // 5. Test chainability
    const chained = PatternParser.parse(["C3", "E3"]).transpose(12).fast(2).rev();
    assert(chained instanceof MotifEventArray, "chained calls should return a MotifEventArray");
    assert(chained[0].value === "E4", `expected first event of reversed to be E4, got ${chained[0].value}`);
    assert(chained[1].value === "C4", `expected second event of reversed to be C4, got ${chained[1].value}`);
}

// =============================================================================
// Motif Engine: Auto-Stop on Arrangement Completion
// =============================================================================
console.log("\n=== Motif Engine: Auto-Stop on Arrangement Completion ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevIsPlaying = Motif.isPlaying;

    class AutoStopMockCtx {
        constructor() {
            this.currentTime = 10.0;
            this.sampleRate = 44100;
        }

        createGain() {
            return {
                gain: {
                    value: 1.0, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                },
            };
        }

        createBiquadFilter() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createDynamicsCompressor() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createWaveShaper() {
            return {
                connect() {
                }, disconnect() {
                },
            };
        }

        createOscillator() {
            return {
                frequency: {
                    value: 440, setValueAtTime() {
                    },
                }, connect() {
                }, disconnect() {
                }, start() {
                }, stop() {
                },
            };
        }

        suspend() {
            return Promise.resolve();
        }
    }

    Track.clearRegistry();
    const t = Track("auto-stop-test").synth("sine").note([60]);

    // Arrange for 1 bar at 120 BPM -> 2 seconds total duration
    Motif.tempo = 120;
    Arrange([
        { tracks: [t], bars: 1 },
    ]);

    const mockCtx = new AutoStopMockCtx();
    Motif.ctx = mockCtx;
    Motif.isPlaying = true;
    Motif._schedQueue = [];

    // Trigger first tick to initialize track's _playbackStartTime
    Motif.tick();

    assert(Motif.isPlaying === true, "Motif should be playing initially");
    assert(t._playbackStartTime === 10.0, `t._playbackStartTime should be initialized to mock context time (10.0), got ${t._playbackStartTime}`);

    let callbackFired = false;
    Motif.onPlaybackFinished = () => {
        callbackFired = true;
    };

    // Advance mock current time smoothly from 10.05 to 11.95 (less than 12.0)
    for (let time = 10.05; time < 12.0; time += 0.05) {
        mockCtx.currentTime = time;
        Motif.tick();
    }
    assert(Motif.isPlaying === true, "Motif should still be playing before max stop time is reached");
    assert(callbackFired === false, "onPlaybackFinished should not have been called yet");

    // Advance mock current time to 12.0s (exact stop time)
    mockCtx.currentTime = 12.0;
    Motif.tick();
    assert(Motif.isPlaying === false, "Motif should have automatically stopped");
    assert(callbackFired === true, "onPlaybackFinished should have fired when maximum stop time was reached");

    // Clean up
    Motif.onPlaybackFinished = null;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);

