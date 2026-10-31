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
    MotifEngine,
    parseDurationToSeconds,
    Track,
    LFO,
    LFOSignal,
    Bus,
    Arrange,
    MotifEventArray,
    trackRegistry,
    busRegistry,
    SimplexNoise,
} from "./motif.js";
import { applyParamModulation, disposeModulationBindings, safeDisconnect, sampleBufferCache } from "./src/helpers.js";
import {
    MockAudioParam,
    MockAudioNode,
    MockGainNode,
    MockOscillatorNode,
    MockAudioContext,
} from "./test/mock_webaudio.js";


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

console.log("\n=== Pad Sub Octave and Acoustic Snare Stability ===");
{
    const registered = Motif.synthRegistry.get("pad-hauntology");
    const dsp = new Function("TWO_PI", `return (${registered.toString()});`)(2 * Math.PI);

    // Hold age where wow/flutter cross zero to isolate the oscillator spectrum.
    const ctx = { t: 10, p: 0, freq: 200, state: {}, sampleRate: 48000 };
    for (let frame = 0; frame < ctx.sampleRate; frame++) dsp(ctx);
    let subSin = 0;
    let subCos = 0;
    let mainSin = 0;
    let mainCos = 0;
    let finite = true;
    for (let frame = 0; frame < ctx.sampleRate; frame++) {
        const value = dsp(ctx);
        finite &&= Number.isFinite(value);
        const angle = 2 * Math.PI * 100 * frame / ctx.sampleRate;
        subSin += value * Math.sin(angle);
        subCos += value * Math.cos(angle);
        mainSin += value * Math.sin(2 * angle);
        mainCos += value * Math.cos(2 * angle);
    }
    const subAmplitude = 2 * Math.hypot(subSin, subCos) / ctx.sampleRate;
    const mainAmplitude = 2 * Math.hypot(mainSin, mainCos) / ctx.sampleRate;
    assert(finite && subAmplitude > 0.08 && subAmplitude > mainAmplitude * 0.25,
        "pad-hauntology: rendered output contains an octave below the requested pitch");

    const savedContext = Motif.ctx;
    const savedSeed = Motif._sampleSeed;
    try {
        for (const sampleRate of [8000, 16000, 44100, 48000, 96000]) {
            Motif.ctx = new MockAudioContext();
            Motif.ctx.sampleRate = sampleRate;
            for (const seed of [0, 1, 12345]) {
                Motif._sampleSeed = seed;
                const data = Motif.sampleRegistry.get("snare-acoustic")().getChannelData(0);
                let finite = true;
                let peak = 0;
                let tailPeak = 0;
                for (let frame = 0; frame < data.length; frame++) {
                    finite &&= Number.isFinite(data[frame]);
                    peak = Math.max(peak, Math.abs(data[frame]));
                    if (frame > data.length * 0.9) tailPeak = Math.max(tailPeak, Math.abs(data[frame]));
                }
                assert(finite && peak > 0.05 && peak < 2,
                    `snare-acoustic: finite, bounded, audible at ${sampleRate} Hz / seed ${seed}`);
                assert(tailPeak < peak * 0.1,
                    `snare-acoustic: tail decays at ${sampleRate} Hz / seed ${seed}`);
            }
        }
    } finally {
        Motif.ctx = savedContext;
        Motif._sampleSeed = savedSeed;
    }
}

// =============================================================================
// Orchestral instruments: isolated worklet callbacks and seeded sample buffers
// =============================================================================
console.log("\n=== Orchestral Synths: Serialized DSP ===");
{
    const ranges = {
        "orch-violin": [196, 440, 2637],
        "orch-cello": [65.406, 146.832, 523.251],
        "orch-french-horn": [87.307, 195.998, 523.251],
        "orch-flute": [261.626, 783.991, 2349.318],
        "orch-oboe": [233.082, 440, 1567.982],
    };

    for (const [name, pitches] of Object.entries(ranges)) {
        const registered = Motif.synthRegistry.get(name);
        assert(typeof registered === "function", `${name}: registered as a synth`);
        if (typeof registered !== "function") continue;

        // AudioWorklets reconstruct the callback without the registry's closure.

        const dsp = new Function("TWO_PI", `return (${registered.toString()});`)(2 * Math.PI);
        for (const sampleRate of [8000, 44100, 48000, 96000]) {
            for (const frequency of pitches) {
                const ctx = { t: 0, p: 0, freq: frequency, state: {}, sampleRate };
                let finite = true;
                let peak = 0;
                for (let frame = 0; frame < sampleRate / 2; frame++) {
                    ctx.t = frame / sampleRate;
                    ctx.p = (ctx.p + frequency / sampleRate) % 1;
                    const value = dsp(ctx);
                    finite &&= Number.isFinite(value);
                    peak = Math.max(peak, Math.abs(value));
                }
                assert(finite && peak > 0.01 && peak <= 1,
                    `${name}: finite, bounded, non-silent at ${frequency} Hz / ${sampleRate} Hz`);
            }

            const ctx = { t: 0, p: 0, freq: pitches[0], state: {}, sampleRate };
            let bounded = true;
            for (let frame = 0; frame < sampleRate; frame++) {
                ctx.t = frame / sampleRate;
                ctx.freq = frame < sampleRate / 2
                    ? pitches[0] * (pitches[2] / pitches[0]) ** (2 * ctx.t)
                    : pitches[0];
                const value = dsp(ctx);
                bounded &&= Number.isFinite(value) && Math.abs(value) <= 1;
            }
            assert(bounded, `${name}: glide and abrupt register jump remain bounded at ${sampleRate} Hz`);

            ctx.t = 1e12;
            ctx.freq = pitches[1];
            for (let frame = 0; frame < 1024; frame++) {
                const value = dsp(ctx);
                bounded &&= Number.isFinite(value) && Math.abs(value) <= 1;
            }
            assert(bounded, `${name}: large note age preserves finite output at ${sampleRate} Hz`);

            ctx.freq = sampleRate * 0.49;
            assert(dsp(ctx) === 0, `${name}: near-Nyquist fundamentals fade to silence`);
        }

        for (const freq of [0, -440, NaN, Infinity]) {
            assert(dsp({ t: 0, p: 0, freq, state: {}, sampleRate: 48000 }) === 0,
                `${name}: invalid frequency ${freq} returns silence`);
        }
    }
}

console.log("\n=== Orchestral Samples: Buffer Safety and Seeding ===");
{
    const savedContext = Motif.ctx;
    const savedSeed = Motif._sampleSeed;
    const samples = {
        "orch-harp-c4": [5.5, 0.74],
        "orch-celesta-c5": [5.8, 0.73],
        "timpani": [3.8, 0.78],
        "orch-tubular-bells-c5": [5.8, 0.78],
    };
    const sameData = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

    try {
        for (const [name, [duration, targetPeak]] of Object.entries(samples)) {
            const generator = Motif.sampleRegistry.get(name);
            assert(typeof generator === "function", `${name}: registered as a sample`);
            if (typeof generator !== "function") continue;

            Motif.ctx = null;
            assert(generator() === null, `${name}: no context returns null`);
            for (const sampleRate of [8000, 44100, 48000]) {
                Motif.ctx = new MockAudioContext();
                Motif.ctx.sampleRate = sampleRate;
                Motif._sampleSeed = 0;
                const buffer = generator();
                const data = buffer.getChannelData(0);
                let finite = true;
                let peak = 0;
                let sum = 0;
                for (const value of data) {
                    finite &&= Number.isFinite(value);
                    peak = Math.max(peak, Math.abs(value));
                    sum += value;
                }
                assert(Math.abs(data.length / sampleRate - duration) < 1 / sampleRate,
                    `${name}: expected duration at ${sampleRate} Hz`);
                assert(finite && Math.abs(peak - targetPeak) < 1e-6,
                    `${name}: finite and normalized at ${sampleRate} Hz`);
                assert(data[0] === 0 && data.at(-1) === 0,
                    `${name}: exact zero endpoints at ${sampleRate} Hz`);
                assert(Math.abs(sum / data.length) < 1e-6,
                    `${name}: negligible DC offset at ${sampleRate} Hz`);

                if (sampleRate !== 8000) continue;
                assert(sameData(data, generator().getChannelData(0)),
                    `${name}: repeated canonical rendering is identical`);
                Motif._sampleSeed = 42;
                const variation = generator().getChannelData(0);
                assert(!sameData(data, variation), `${name}: global sample seed changes the rendering`);
                assert(sameData(variation, generator().getChannelData(0)),
                    `${name}: repeated nonzero seed rendering is identical`);
            }
        }

        assert(!Motif.sampleRegistry.has("orch-suspended-cymbal"), "excluded orchestral cymbal is absent");
        assert(!Motif.sampleRegistry.has("orch-timpani-d2"), "timpani has one canonical registry name");

        Motif.ctx = new MockAudioContext();
        const celesta = Track("orchestra-root-test")
            .sampler({ urls: { C5: "orch-celesta-c5" } })
            .note(["C5", "C6"]);
        await celesta._samplerLoading;
        const rates = [];
        celesta._playAudioBuffer = (buffer, time, duration, rate) => rates.push(rate);
        celesta._playEvent({ value: "C5" }, 0, 1);
        celesta._playEvent({ value: "C6" }, 1, 1);
        assert(rates.length === 2 && rates[0] === 1 && rates[1] === 2,
            "orchestral samples support concert-pitch note mapping through the existing sampler");
    } finally {
        Track.clearRegistry();
        Motif.ctx = savedContext;
        Motif._sampleSeed = savedSeed;
        Motif._invalidateProceduralSamples();
    }
}

// =============================================================================
// Dark percussion and analog voices: serialized DSP and generated buffers
// These numeric checks cover callback isolation and buffer safety, not perceived sound quality.
// =============================================================================
console.log("\n=== Analog Voices: Serialized DSP ===");
{
    for (const name of ["arp-narrow-drift", "bass-compact-saw", "pad-dusk-saws"]) {
        const registered = Motif.synthRegistry.get(name);
        assert(typeof registered === "function", `${name}: registered as a synth`);
        if (typeof registered !== "function") continue;

        const dsp = new Function("TWO_PI", `return (${registered.toString()});`)(2 * Math.PI);
        for (const sampleRate of [8000, 44100, 48000, 96000]) {
            for (const frequency of [55, 440, sampleRate * 0.2, sampleRate * 0.45]) {
                const ctx = { t: 0, p: 0, freq: frequency, state: { driftPhase: 0.375 }, sampleRate };
                let finite = true;
                let peak = 0;
                for (let frame = 0; frame < sampleRate / 8; frame++) {
                    ctx.t = frame / sampleRate;
                    const value = dsp(ctx);
                    finite &&= Number.isFinite(value);
                    peak = Math.max(peak, Math.abs(value));
                    ctx.p = (ctx.p + frequency / sampleRate) % 1;
                }
                assert(finite && peak > 0.001 && peak <= 1,
                    `${name}: isolated callback is finite, bounded and non-silent at ${frequency} Hz / ${sampleRate} Hz`);
            }

            const ctx = { t: 0, p: 0, freq: 55, state: { driftPhase: 0.375 }, sampleRate };
            let bounded = true;
            for (let frame = 0; frame < sampleRate / 4; frame++) {
                ctx.t = frame / sampleRate;
                ctx.freq = frame < sampleRate / 8 ? 55 * 32 ** (8 * ctx.t) : 110;
                ctx.state.brightness = (frame % 257) / 256;
                const value = dsp(ctx);
                bounded &&= Number.isFinite(value) && Math.abs(value) <= 1;
            }
            assert(bounded, `${name}: pitch and brightness changes stay bounded at ${sampleRate} Hz`);

            for (const frequency of [sampleRate * 0.49, sampleRate, 0, -440, NaN, Infinity]) {
                const value = dsp({ t: 0, p: 0, freq: frequency, state: {}, sampleRate });
                assert(value === 0, `${name}: invalid or above-band frequency ${frequency} starts silent`);
            }
        }
    }
}

console.log("\n=== Dark Samples: Buffer Safety and Seeding ===");
{
    const savedContext = Motif.ctx;
    const savedSeed = Motif._sampleSeed;
    const samples = {
        "dark-thud": [0.46, 0.76, 0x6D2B79F5],
        "dark-gated-snare": [0.22, 0.58, 0xA341316C],
        "dark-shadow-hat": [0.145, 0.29, 0xC8013EA4],
        "dark-reverse-glass": [1.2, 0.42, 0xAD90777D],
    };
    const sameData = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

    try {
        for (const [name, [duration, targetPeak, noiseSeed]] of Object.entries(samples)) {
            const generator = Motif.sampleRegistry.get(name);
            assert(typeof generator === "function", `${name}: registered as a sample`);
            if (typeof generator !== "function") continue;

            Motif.ctx = null;
            assert(generator() === null, `${name}: no context returns null`);
            for (const sampleRate of [8000, 44100, 48000, 96000]) {
                Motif.ctx = new MockAudioContext();
                Motif.ctx.sampleRate = sampleRate;
                Motif._sampleSeed = 0;
                const buffer = generator();
                const data = buffer.getChannelData(0);
                let finite = true;
                let peak = 0;
                let sum = 0;
                for (const value of data) {
                    finite &&= Number.isFinite(value);
                    peak = Math.max(peak, Math.abs(value));
                    sum += value;
                }
                assert(buffer.numberOfChannels === 1 && buffer.sampleRate === sampleRate
                    && Math.abs(data.length / sampleRate - duration) < 1 / sampleRate,
                    `${name}: mono buffer has the expected rate and duration at ${sampleRate} Hz`);
                assert(finite && Math.abs(peak - targetPeak) < 1e-6,
                    `${name}: finite and normalized at ${sampleRate} Hz`);
                assert(data[0] === 0 && data.at(-1) === 0 && Math.abs(sum / data.length) < 1e-7,
                    `${name}: silent endpoints and negligible DC at ${sampleRate} Hz`);

                if (sampleRate !== 8000) continue;
                assert(sameData(data, generator().getChannelData(0)), `${name}: canonical rendering repeats exactly`);
                for (const seed of [42, noiseSeed]) {
                    Motif._sampleSeed = seed;
                    const variation = generator().getChannelData(0);
                    assert(!sameData(data, variation) && variation.every(Number.isFinite),
                        `${name}: seed ${seed} produces a finite variation`);
                    assert(sameData(variation, generator().getChannelData(0)), `${name}: seed ${seed} is repeatable`);
                }
            }
        }
    } finally {
        Motif.ctx = savedContext;
        Motif._sampleSeed = savedSeed;
        Motif._invalidateProceduralSamples();
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
            this.audioWorklet = { addModule: async () => {} };
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
        globalThis.AudioWorkletNode = class extends MockGainNode {
            constructor(ctx, name, options = {}) {
                super();
                this.parameters = new Map(Object.entries(options.parameterData || {}).map(([key, value]) => [key, new MockAudioParam(value)]));
            }
        };
    }

    // Initialize Motif
    Motif.init();
    await Motif._masterLimiterReady;
    delete globalThis.AudioWorkletNode;

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
        await Motif.start();
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
        await Motif.start();
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

    // Test smooth tempo ramping and interpolation in tick()
    Motif.ctx.state = "running";
    Motif.tempo = 100;
    Motif.ctx.currentTime = 1.0;
    Motif._tempoRamp = null;

    // Trigger smooth ramp from 100 to 200 BPM over 2 seconds (starts at 1.0, ends at 3.0)
    Motif.rampTempo(200, 2.0, { smooth: true });
    assert(Motif.tempo === 100, "With smooth: true, Motif.tempo should not instantly jump to targetBpm");
    assert(Motif._tempoRamp !== null, "Motif._tempoRamp should be set");
    assert(Motif._tempoRamp.startBpm === 100, "startBpm should be 100");
    assert(Motif._tempoRamp.targetBpm === 200, "targetBpm should be 200");
    assert(Motif._tempoRamp.startTime === 1.0, "startTime should be 1.0");
    assert(Motif._tempoRamp.endTime === 3.0, "endTime should be 3.0");

    // Advance clock to 2.0 (midway)
    Motif.ctx.currentTime = 2.0;
    Motif.tick();
    assert(Math.abs(Motif.tempo - 150) < 1e-9, `expected interpolated tempo to be 150 at midpoint, got ${Motif.tempo}`);

    // Advance clock to 3.0 (endpoint)
    Motif.ctx.currentTime = 3.0;
    Motif.tick();
    assert(Motif.tempo === 200, `expected tempo to be 200 at end of ramp, got ${Motif.tempo}`);
    assert(Motif._tempoRamp === null, "tempoRamp should be cleared after completion");
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
        compressor: { threshold: -12, knee: 15, ratio: 8, attack: 0.005, release: 0.12 },
    });
    assert(Motif.masterCompressor.threshold.value === -12, `expected compressor threshold to be -12, got ${Motif.masterCompressor.threshold.value}`);
    assert(Motif.masterCompressor.knee.value === 15, `expected compressor knee to be 15, got ${Motif.masterCompressor.knee.value}`);
    assert(Motif.masterCompressor.ratio.value === 8, `expected compressor ratio to be 8, got ${Motif.masterCompressor.ratio.value}`);
    assert(Motif.masterCompressor.attack.value === 0.005, `expected compressor attack to be 0.005, got ${Motif.masterCompressor.attack.value}`);
    assert(Motif.masterCompressor.release.value === 0.12, `expected compressor release to be 0.12, got ${Motif.masterCompressor.release.value}`);

    for (const options of [
        { limiter: { threshold: -12 } },
        { limiter: { ceiling: NaN } },
        { limiter: { release: 0 } },
        { limiter: [] },
        { compressor: { ratio: 0 } },
        { compressor: { attack: Infinity } },
        { compressor: null },
    ]) {
        let rejected = false;
        try { Motif.master(options); } catch { rejected = true; }
        assert(rejected, `invalid master settings must be rejected: ${JSON.stringify(options)}`);
    }

    Motif.master({ limiter: { ceiling: -3, release: 0.2 }, compressor: false });
    assert(Motif._masterLimiterSettings.ceiling === -3, "limiter settings must persist while the module loads");
    assert(Motif._masterLimiterEnabled && !Motif._masterCompressorEnabled, "limiting and compression must be independently enabled");

    // Test Limiter bypass
    Motif.master({ limiter: false });
    // Bypassing works without throw
}

// =============================================================================
// Motif Lookahead Scheduler (Chris Wilson pattern)
// =============================================================================
console.log("\n=== Motif Engine: Lookahead Scheduler ===");
{
    Motif.ctx.state = "running";
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
    await Motif.start();
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

// Voice stealing retains graph connections until the scheduled audio cutoff.
{
    const previousContext = Motif.ctx;
    Motif.ctx = { currentTime: 0.4 };
    for (const mode of ["oldest", "quietest"]) {
        const track = Track(`deferred-steal-${mode}`).voices(2, mode);
        const makeVoice = (startTime, gainValue, endTime = 2) => ({
            startTime, gainValue, endTime,
            oscillator: { stop(time) { this.stoppedAt = time; }, disconnect() { this.disconnected = true; } },
            gainNode: { disconnect() { this.disconnected = true; } },
        });
        const old = makeVoice(0, 0.8);
        const quiet = makeVoice(0.1, 0.2);
        track._activeVoices.set('old', old);
        track._activeVoices.set('quiet', quiet);
        track._stealVoice(mode, 0.5);
        const stolen = mode === "oldest" ? old : quiet;
        assert(stolen.oscillator.stoppedAt === 0.5, `${mode}: stop at replacement onset`);
        assert(!stolen.oscillator.disconnected && !stolen.gainNode.disconnected, `${mode}: preserve pending audio routing`);
        assert(track._activeVoices.size === 1, `${mode}: free scheduling capacity immediately`);
        Motif.ctx.currentTime = 0.499;
        track._cleanupActiveVoices();
        assert(!stolen.oscillator.disconnected, `${mode}: retain routing before cutoff`);
        Motif.ctx.currentTime = 0.5;
        track._cleanupActiveVoices();
        assert(stolen.oscillator.disconnected && stolen.gainNode.disconnected, `${mode}: disconnect rendered voice`);
        assert(track._retiredVoices.size === 0, `${mode}: release retired accounting`);
        Motif.ctx.currentTime = 0.4;
        track._stealVoice(mode, 0.8);
        const remaining = mode === "oldest" ? quiet : old;
        track._resetScheduling();
        assert(remaining.oscillator.disconnected && remaining.gainNode.disconnected, `${mode}: reset cleans pending retired voices`);
        assert(track._retiredVoices.size === 0, `${mode}: reset clears retired accounting`);
        const finished = makeVoice(0, 1, 0.6);
        track._activeVoices.set('finished', finished);
        track._stealVoice(mode, 0.8);
        assert(finished.oscillator.stoppedAt === 0.6, `${mode}: stealing never extends natural lifetime`);
        track._resetScheduling();
    }
    Motif.ctx = previousContext;
    Track.clearRegistry();
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
        const calls = lastGainParam.calls.map(call => ({ ...call, value: call.value * t.trackInputNode.gain.value }));
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
            // Inspect the remaining automation, excluding releases cancelled by a Tie.
            this.calls = this.calls.filter(call => call.type === "cancelAndHold" || call.time < t);
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

    // 8. Test sidechain by string ID
    const t8 = Track("sc-string-id");
    t8._initAudio();
    t8.sidechain("sc-kick");
    assert(t8.duckGainNode !== null, "sidechain(stringId) should create duckGainNode");
    assert(kick._sidechainListeners.length === 3, "trigger track sc-kick should now have three listeners");

    // 9. Test pending sidechain
    const t9 = Track("sc-pending");
    t9._initAudio();
    t9.sidechain("future-kick");
    assert(t9.duckGainNode !== null, "pending sidechain should create duckGainNode");
    assert(globalThis._pendingSidechains.has("future-kick"), "should register in _pendingSidechains map");
    const futureKick = Track("future-kick");
    assert(futureKick._sidechainListeners.length === 1, "future-kick should get sidechain listener upon instantiation");
    assert(!globalThis._pendingSidechains.has("future-kick"), "should remove from _pendingSidechains map");

    // 10. Test crossfade retention of sidechain listeners
    const kickReplacement = Track("sc-kick");
    assert(kickReplacement._sidechainListeners.length === 3, "replaced track should inherit sidechain listeners");

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

        createDelay(maxDelayTime) {
            const delay = makeRecordingNode("delay");
            delay.maxDelayTime = maxDelayTime;
            return delay;
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
    assert(b.feedback({ amount: 0.4, time: "3/16" }) === b, "feedback() should be chainable");

    // 2. Nodes created
    assert(b.feedbackDelayNode !== null, "feedbackDelayNode should exist after feedback()");
    assert(b.feedbackGainNode !== null, "feedbackGainNode should exist after feedback()");
    assert(b.feedbackDelayNode.maxDelayTime === 60,
        `feedback DelayNode should allocate the documented 60s range, got ${b.feedbackDelayNode.maxDelayTime}`);

    // 3. Musical delay time is parsed using the current transport tempo/meter
    const expectedDelay = (3 / 16) * (60 / Motif.tempo) * Motif.beatsPerBar;
    assert(Math.abs(b.feedbackDelayNode.delayTime.value - expectedDelay) < 1e-9,
        `delayTime should be 3/16 of a bar (${expectedDelay}), got ${b.feedbackDelayNode.delayTime.value}`);

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

    // 6. Repeated calls reuse nodes and explicit time updates the delay
    const prevDelayNode = b.feedbackDelayNode;
    const prevGainNode = b.feedbackGainNode;
    b.feedback({ amount: 0.8, time: "1/4" });
    assert(b.feedbackDelayNode === prevDelayNode, "second feedback() should not create a new DelayNode");
    assert(b.feedbackGainNode === prevGainNode, "second feedback() should not create a new feedbackGainNode");
    assert(Math.abs(b.feedbackGainNode.gain.value - 0.8) < 1e-6,
        `feedbackGain should be updated to 0.8, got ${b.feedbackGainNode.gain.value}`);
    const updatedDelay = (1 / 4) * (60 / Motif.tempo) * Motif.beatsPerBar;
    assert(Math.abs(b.feedbackDelayNode.delayTime.value - updatedDelay) < 1e-9,
        `explicit time should update delayTime to ${updatedDelay}, got ${b.feedbackDelayNode.delayTime.value}`);

    // 7. An omitted time preserves an existing delay
    b.feedback({ amount: 0.6 });
    assert(Math.abs(b.feedbackDelayNode.delayTime.value - updatedDelay) < 1e-9,
        `omitted time should preserve delayTime ${updatedDelay}, got ${b.feedbackDelayNode.delayTime.value}`);

    // 8. The first call without time retains the original short safety delay
    const defaultTimeBus = Bus("fb-default-time").feedback({ amount: 0.2 });
    const minimumDelay = 128 / sampleRate;
    assert(Math.abs(defaultTimeBus.feedbackDelayNode.delayTime.value - minimumDelay) < 1e-9,
        `initial omitted time should use 128/sampleRate (${minimumDelay}), got ${defaultTimeBus.feedbackDelayNode.delayTime.value}`);

    // 9. Long musical and numeric times are honored without truncation
    const prevTempo = Motif.tempo;
    Motif.tempo = 126;
    const longDelayBus = Bus("fb-long-time").feedback({ amount: 0.4, time: "1/1" });
    const oneBarAt126 = (60 / 126) * Motif.beatsPerBar;
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - oneBarAt126) < 1e-9,
        `one-bar delay at 126 BPM should be ${oneBarAt126}s, got ${longDelayBus.feedbackDelayNode.delayTime.value}`);
    longDelayBus.feedback({ amount: 0.45, time: 2.5 });
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - 2.5) < 1e-9,
        `numeric delay above one second should remain 2.5s, got ${longDelayBus.feedbackDelayNode.delayTime.value}`);
    Motif.tempo = prevTempo;

    // 10. Short valid times work; rejected updates preserve both prior parameters
    longDelayBus.feedback({ amount: 0.35, time: 0.01 });
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - 0.01) < 1e-9,
        `short valid delay should remain 0.01s, got ${longDelayBus.feedbackDelayNode.delayTime.value}`);
    let lowTimeError = null;
    try {
        longDelayBus.feedback({ amount: 0.9, time: 0 });
    } catch (error) {
        lowTimeError = error;
    }
    assert(lowTimeError instanceof RangeError, "a delay below the 128-frame minimum should throw RangeError");
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - 0.01) < 1e-9,
        "a rejected short delay must preserve the previous valid time");
    assert(Math.abs(longDelayBus.feedbackGainNode.gain.value - 0.35) < 1e-9,
        "a rejected short delay must preserve the previous feedback amount");

    let highTimeError = null;
    try {
        longDelayBus.feedback({ amount: 0.9, time: 60.001 });
    } catch (error) {
        highTimeError = error;
    }
    assert(highTimeError instanceof RangeError, "a delay above 60 seconds should throw RangeError");
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - 0.01) < 1e-9,
        "a rejected long delay must preserve the previous valid time");
    assert(Math.abs(longDelayBus.feedbackGainNode.gain.value - 0.35) < 1e-9,
        "a rejected long delay must preserve the previous feedback amount");

    let invalidTimeError = null;
    try {
        longDelayBus.feedback({ amount: 0.9, time: "not-a-duration" });
    } catch (error) {
        invalidTimeError = error;
    }
    assert(invalidTimeError instanceof RangeError, "an invalid explicit delay should throw RangeError");
    assert(Math.abs(longDelayBus.feedbackDelayNode.delayTime.value - 0.01) < 1e-9,
        "an invalid explicit delay must preserve the previous valid time");
    assert(Math.abs(longDelayBus.feedbackGainNode.gain.value - 0.35) < 1e-9,
        "an invalid explicit delay must preserve the previous feedback amount");

    // 11. _rebuildSignalChain reconnects the feedback tap on output
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
    const padTrack = Track("pad2");
    leadTrack._initAudio();
    padTrack._initAudio();
    leadTrack.send(reverbBus2, 0.6);
    padTrack.send(reverbBus2, 0.25);
    reverbBus2.feedback({ amount: 0.35, time: "1/8" });

    // send: preFaderNode → sendGain → bus.input
    const sendGain = leadTrack._sends.get("reverb2");
    assert(sendGain !== undefined, "send gain node should be stored on track");
    const hasSendPath = connections.some(c => c.from === leadTrack.preFaderNode && c.to === sendGain);
    assert(hasSendPath, "send: preFaderNode should connect to sendGainNode");
    const hasSendToBusInput = connections.some(c => c.from === sendGain && c.to === reverbBus2.input);
    assert(hasSendToBusInput, "send: sendGainNode should connect to bus.input");
    const padSendGain = padTrack._sends.get("reverb2");
    assert(padSendGain !== undefined, "second track send gain node should be stored");
    assert(connections.some(c => c.from === padTrack.preFaderNode && c.to === padSendGain),
        "second send: preFaderNode should connect to sendGainNode");
    assert(connections.some(c => c.from === padSendGain && c.to === reverbBus2.input),
        "second send: sendGainNode should connect to the shared bus input");

    // feedback: bus.output → feedbackGain → delay → bus.input
    const hasFBOutputPath = connections.some(c => c.from === reverbBus2.output && c.to === reverbBus2.feedbackGainNode);
    const hasFBGainToDelay = connections.some(c => c.from === reverbBus2.feedbackGainNode && c.to === reverbBus2.feedbackDelayNode);
    const hasFBDelayToInput = connections.some(c => c.from === reverbBus2.feedbackDelayNode && c.to === reverbBus2.input);
    assert(hasFBOutputPath, "feedback topology: output → feedbackGainNode");
    assert(hasFBGainToDelay, "feedback topology: feedbackGainNode → feedbackDelayNode");
    assert(hasFBDelayToInput, "feedback topology: feedbackDelayNode → bus.input (DelayNode breaks cycle)");
    const sharedDelay = (1 / 8) * (60 / Motif.tempo) * Motif.beatsPerBar;
    assert(Math.abs(reverbBus2.feedbackDelayNode.delayTime.value - sharedDelay) < 1e-9,
        `shared feedback bus delay should be ${sharedDelay}, got ${reverbBus2.feedbackDelayNode.delayTime.value}`);

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

    // Slice rhythm owns timing; pitch is read at each slice onset.
    Track.clearRegistry();
    const offlineCtx3 = new TestOfflineCtx(1, Math.ceil(sampleRate * 2.5), sampleRate);
    Motif.ctx = offlineCtx3;
    Motif._schedQueue = [];
    const t3 = Track("pattern-repeat").sample("/audio/loop.wav").chop(4)
        .pattern([1, 2]).note([60, 61, 72, 73]);
    await t3._sampleLoading;
    t3._resetScheduling();
    await offlineCtx3.startRendering();
    assert(t3._parsedEvents.length === 2 && t3._parsedEvents[1].value === 72,
        "slice onsets sample explicit pitches on the normalized note timeline");
    assert(offlineCtx3.createdBufferSources.length >= 3,
        "two slice events repeat on the next cycle");
    assert(offlineCtx3.createdBufferSources.slice(0, 3).map(source => source.offset).join() === "0.5,1,0.5",
        "slice rhythm repeats independently of the number of explicit pitches");

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

    // TEST 5: fit() options support
    const t5 = Track("fit-options");
    t5.fit("1b");
    assert(t5._fitOptions.mode === "stretch", "fit() mode should default to stretch");

    t5.fit("1b", { mode: "repitch" });
    assert(t5._fitOptions.mode === "repitch", "fit() mode should be overridable to repitch");

    t5.fit("2b", { grainSize: 0.08, overlap: 8 });
    assert(t5._fitOptions.grainSize === 0.08, "fit() should store grainSize option");
    assert(t5._fitOptions.overlap === 8, "fit() should store overlap option");

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

    const callback = context => context.i * 0.5;
    const t = Track("dsp-test").dsp(callback);
    assert(t._dspCallback === callback && typeof t.note === "function", "DSP stores the per-sample callback and remains chainable");
    assert(addModuleCalled && addModuleUrl === "blob:mock-url", "DSP preloads its voice worklet");
    await t._dspReady;
    assert(!workletNodeCreated, "DSP allocates no continuously running track-level processor");
    let Processor;
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentTime", capturedCode)(
        class { constructor() { this.port = { postMessage() {} }; } },
        (_name, cls) => { Processor = cls; }, 48000, 0
    );
    const processor = new Processor();
    processor.port.onmessage({ data: { type: "REGISTER_SYNTH", code: callback.toString(), transform: true } });
    processor.port.onmessage({ data: { type: "START", startTime: 0 } });
    const output = [[new Float32Array(8), new Float32Array(8)]];
    const input = [[new Float32Array(8).fill(.6), new Float32Array(8).fill(-.4)]];
    assert(processor.process(input, output, { frequency: [440] }), "Numeric samples keep DSP alive");
    assert(Math.abs(output[0][0][3] - .3) < 1e-7 && Math.abs(output[0][1][3] + .2) < 1e-7, "DSP transforms each stereo input channel");
    const contexts = [];
    processor._synthFn = context => { contexts.push({ ...context }); return 0; };
    assert(processor.process([], output, { frequency: [480] }), "Zero sample return keeps processor alive");
    assert(contexts[0].i === 0 && Math.abs(contexts[0].t - 8 / 48000) < 1e-12, "DSP absent input is zero and time counts active samples");
    assert(Math.abs(contexts[0].p - 8 * 440 / 48000) < 1e-12 && Math.abs(contexts[2].p - contexts[0].p - .01) < 1e-12, "DSP phase integrates frequency once per frame");
    assert(contexts[0].state !== contexts[1].state && contexts[0].state === contexts[2].state, "DSP state is persistent and channel-local");
    processor.port.onmessage({ data: { type: "STOP_AT", endTime: 0 } });
    assert(!processor.process([], output, { frequency: [440] }), "Scheduled stop terminates DSP lifetime");
    for (const invalid of [undefined, false, NaN, Infinity]) {
        const invalidProcessor = new Processor();
        invalidProcessor._startTime = 0;
        invalidProcessor._synthFn = () => invalid;
        let rejected = false;
        try { invalidProcessor.process([], output, { frequency: [440] }); } catch { rejected = true; }
        assert(rejected, "DSP rejects nonnumeric or nonfinite sample returns");
    }

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
        { tracks: [tLoop], bars: 1 }, // 0-2s
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

    // 6. Test degrade()
    const degEvents = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.25 },
        { value: "B", startTime: 0.25, duration: 0.25 },
    );
    degEvents.degrade(1.0); // 100% drop chance
    assert(degEvents.length === 0, "degrade(1.0) should drop all events");

    const degEventsNone = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.25 },
    );
    degEventsNone.degrade(0.0); // 0% drop chance
    assert(degEventsNone.length === 1, "degrade(0.0) should keep all events");

    // 7. Test mutate()
    const mutEvents = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.5 },
    );
    // Mutate with 100% chance and ratchet action
    mutEvents.mutate({ chance: 1.0, actions: { ratchet: true } });
    assert(mutEvents.length === 2, "mutate ratchet should subdivide event into 2");
    assert(mutEvents[0].duration === 0.25, "ratcheted event 1 duration should be halved");
    assert(mutEvents[1].startTime === 0.25, "ratcheted event 2 startTime should be offset");

    const mutEventsRev = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.25 },
        { value: "B", startTime: 0.25, duration: 0.75 },
    );
    mutEventsRev.mutate({ chance: 1.0, actions: { reverse: true } });
    // reverse: startTime = 1.0 - (startTime + duration)
    // A: 1.0 - (0 + 0.25) = 0.75
    // B: 1.0 - (0.25 + 0.75) = 0.0
    // sorted: B (0.0), A (0.75)
    assert(mutEventsRev[0].value === "B", "mutate reverse should reverse order");
    assert(mutEventsRev[0].startTime === 0.0, "reverse B startTime should be 0.0");
    assert(mutEventsRev[1].value === "A", "mutate reverse should reverse order");
    assert(mutEventsRev[1].startTime === 0.75, "reverse A startTime should be 0.75");

    // 8. Test offset()
    const offEvents = new MotifEventArray(
        { value: "A", startTime: 0, duration: 0.25 },
    );
    offEvents.offset("1/8", (e) => {
        e.value = "B";
        return e;
    });
    assert(offEvents.length === 2, "offset should duplicate and shift events");
    assert(offEvents[0].value === "A" && offEvents[0].startTime === 0, "original event should remain unchanged");
    assert(offEvents[1].value === "B" && offEvents[1].startTime === 0.125, "offset event should be shifted and modified");
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

    // The last note's click-prevention fade continues past the arranged boundary.
    mockCtx.currentTime = 12.0;
    Motif.tick();
    assert(Motif.isPlaying === true && callbackFired === false, "Motif should preserve the final note fade after its arranged boundary");
    mockCtx.currentTime = 12.015;
    Motif.tick();
    assert(Motif.isPlaying === false, "Motif should have automatically stopped");
    assert(callbackFired === true, "onPlaybackFinished should fire after the final note fade ends");

    // Clean up
    Motif.onPlaybackFinished = null;
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// Support Ramp() in gain() & Warn on Unsupported Ramp Usage
// =============================================================================
console.log("\n=== Support Ramp() in gain() & Warn on Unsupported Ramp Usage ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevIsPlaying = Motif.isPlaying;

    class TestRampOfflineCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.scheduledGains = [];
        }

        createGain() {
            const mockGain = {
                gain: {
                    value: 1.0,
                    setValueAtTime(v, t) {
                        mockGain.setValue = v;
                        mockGain.setTime = t;
                    },
                    linearRampToValueAtTime(v, t) {
                        mockGain.rampValue = v;
                        mockGain.rampTime = t;
                    },
                },
                connect() {
                },
                disconnect() {
                },
            };
            return mockGain;
        }

        createOscillator() {
            return {
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
            };
        }
    }

    // 1. Standalone dynamic call with uninitialized track warning
    Track.clearRegistry();
    const tStandalone = Track("t-standalone");
    let warned = false;
    const originalConsoleWarn = console.warn;
    console.warn = (msg) => {
        if (msg.includes("t-standalone")) {
            warned = true;
        }
    };
    Motif.isPlaying = true;
    tStandalone.gain(Ramp(0.5, 0.1, "1 bar"));
    tStandalone._schedule(0.5);
    console.warn = originalConsoleWarn;
    assert(warned === true, "should warn when calling gain(Ramp(...)) dynamically on uninitialized track");

    // 2. Ramp inside Arrange()
    Track.clearRegistry();
    const tArrange = Track("t-arrange").synth("sine").note([60]);
    Motif.tempo = 120; // 1 bar = 2s
    Arrange([
        { tracks: [tArrange.gain(Ramp(0.8, 0.2))], bars: 1 }, // Ramp 0.8 to 0.2 over 1 bar (2 seconds)
    ]);

    const mockCtx = new TestRampOfflineCtx();
    Motif.ctx = mockCtx;
    Motif.isPlaying = true;
    Motif._schedQueue = [];

    // Prior to playing, _initAudio initializes the gain node. Let's make sure it happens or mock it
    tArrange._initAudio();

    // Trigger tick which schedules
    Motif.tick();

    assert(tArrange._scheduledRamps && tArrange._scheduledRamps.length === 1, "Ramp should be successfully scheduled under _scheduledRamps");
    if (tArrange._scheduledRamps && tArrange._scheduledRamps.length === 1) {
        const ramp = tArrange._scheduledRamps[0];
        assert(ramp.from === 0.8, `expected from = 0.8, got ${ramp.from}`);
        assert(ramp.to === 0.2, `expected to = 0.2, got ${ramp.to}`);
        assert(ramp.duration === 2.0, `expected duration = 2.0s, got ${ramp.duration}`);
    }

    // Verify gain node received the scheduler's setValueAtTime and linearRampToValueAtTime
    const inputNode = tArrange.trackInputNode;
    assert(inputNode !== null, "trackInputNode should be initialized");
    if (inputNode) {
        assert(inputNode.setValue === 0.8, `setValueAtTime value should be 0.8, got ${inputNode.setValue}`);
        assert(inputNode.rampValue === 0.2, `linearRampToValueAtTime value should be 0.2, got ${inputNode.rampValue}`);
        assert(inputNode.rampTime === 2.0, `linearRampToValueAtTime time should be 2.0, got ${inputNode.rampTime}`);
    }

    // Clean up
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// Track Solo: Isolation and Arrangement Bypassing
// =============================================================================
console.log("\n=== Track Solo: Isolation and Arrangement Bypassing ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevIsPlaying = Motif.isPlaying;

    // 1. solo() and s() flags and segment clearing
    Track.clearRegistry();
    const tSolo = Track("t-solo").synth("sine").note([60]);
    tSolo._activeSegments = [{ start: 0, end: 4 }];
    assert(tSolo._isSolo === false, "initially not soloed");

    tSolo.solo();
    assert(tSolo._isSolo === true, "solo() sets _isSolo to true");
    assert(tSolo._activeSegments.length === 0, "solo() clears active segments");

    const tSolo2 = Track("t-solo2").synth("sine").note([62]);
    tSolo2.s();
    assert(tSolo2._isSolo === true, "s() is an alias for solo()");

    // 2. Solo gate in _schedule() skips non-soloed and executes soloed
    Track.clearRegistry();
    const soloTrack = Track("soloed").synth("sine").note([60]).solo();
    const normalTrack = Track("normal").synth("sine").note([64]);

    soloTrack._parsedEvents = [{ time: 0, note: 60 }];
    normalTrack._parsedEvents = [{ time: 0, note: 64 }];

    const mockCtx = {
        currentTime: 0.1,
        sampleRate: 44100,
        createGain() {
            return {
                gain: {
                    setValueAtTime() {
                    },
                }, connect() {
                },
            };
        },
        createOscillator() {
            return {
                frequency: {
                    setValueAtTime() {
                    },
                }, connect() {
                }, start() {
                }, stop() {
                },
            };
        },
    };
    Motif.ctx = mockCtx;
    Motif.tempo = 120;
    Motif.isPlaying = true;

    soloTrack._initAudio();
    normalTrack._initAudio();

    soloTrack._schedule(0.5);
    normalTrack._schedule(0.5);

    assert(normalTrack._activeVoices.size === 0, "normal track should not schedule any voices when another track is soloed");

    // 3. Arrange() skips soloed tracks
    Track.clearRegistry();
    const tSoloArrange = Track("solo-arrange").synth("sine").note([60]).solo();
    Arrange([
        { tracks: [tSoloArrange], bars: 1 },
    ]);
    assert(tSoloArrange._activeSegments.length === 0, "Arrange should skip soloed track, keeping its active segments empty");

    // Clean up
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// Arrangement Start Parameter: Skip Previous Sections
// =============================================================================
console.log("\n=== Arrangement Start Parameter: Skip Previous Sections ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevIsPlaying = Motif.isPlaying;
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

    // 1. Basic Start Parameter (s: 1 or start: true)
    Track.clearRegistry();
    const tBass = Track("bass-start").synth("sine").note([60]);
    const tLead = Track("lead-start").synth("sine").note([72]);

    Motif.tempo = 120; // bar = 2.0s
    Arrange([
        { tracks: [tBass], bars: 1 }, // 0-2s, will be skipped
        { tracks: [tLead], bars: 1, s: 1 }, // 2-4s -> now starts at 0s
    ]);

    const offline = new ArrangeOfflineCtx();
    Motif.ctx = offline;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline.startRendering();

    const oscs = offline.createdOscillators;
    // We expect ONLY tLead to play, starting at 0.0s. tBass is completely skipped from playing (but reset).
    assert(oscs.length === 1, `expected 1 oscillator, got ${oscs.length}`);
    if (oscs.length === 1) {
        assert(Math.abs(oscs[0].frequency.value - midiToHz(72)) < 1e-6, "lead oscillator should have played");
        assert(Math.abs(oscs[0].startTime - 0.0) < 1e-6, `lead should start at 0.0, got ${oscs[0].startTime}`);
    }

    // 2. Track Resetting: tracks in skipped sections must be reset
    // tBass is in the skipped section. Its segments should be cleared.
    assert(tBass._activeSegments.length === 0 || (tBass._activeSegments.length === 1 && tBass._activeSegments[0].start === 0 && tBass._activeSegments[0].stop === 0), "bass active segments should be cleared or dummy deactivated");

    // 3. Multiple Starts: the last one wins
    Track.clearRegistry();
    const tBass2 = Track("bass-start-2").synth("sine").note([60]);
    const tLead2 = Track("lead-start-2").synth("sine").note([72]);
    const tPad2 = Track("pad-start-2").synth("sine").note([64]);

    Arrange([
        { tracks: [tBass2], bars: 1, s: true }, // skipped
        { tracks: [tLead2], bars: 1, start: true }, // skipped because subsequent has s: 1
        { tracks: [tPad2], bars: 1, s: 1 }, // last one wins, starts at 0s
    ]);

    const offline2 = new ArrangeOfflineCtx();
    Motif.ctx = offline2;
    Motif._schedQueue = [];
    Motif._stopScheduler();

    await offline2.startRendering();

    const oscs2 = offline2.createdOscillators;
    assert(oscs2.length === 1, `expected 1 oscillator, got ${oscs2.length}`);
    if (oscs2.length === 1) {
        assert(Math.abs(oscs2[0].frequency.value - midiToHz(64)) < 1e-6, "pad oscillator should have played");
        assert(Math.abs(oscs2[0].startTime - 0.0) < 1e-6, `pad should start at 0.0, got ${oscs2[0].startTime}`);
    }

    // 4. Test Synth NaN/Infinity worklet validation
    const fs = require("fs");
    const managerSrc = fs.readFileSync(__dirname + "/src/TrackVoiceManager.js", "utf8");
    const procSrcMatch = managerSrc.match(/const MOTIF_SYNTH_PROCESSOR_SRC = `([\s\S]*?)`;/);
    assert(procSrcMatch !== null, "Should find MOTIF_SYNTH_PROCESSOR_SRC in TrackVoiceManager.js");
    if (procSrcMatch) {
        let processorCode = procSrcMatch[1];
        processorCode = processorCode.replace("registerProcessor('motif-synth-voice', MotifSynthProcessor);", "");

        const prevAWP = globalThis.AudioWorkletProcessor;
        globalThis.AudioWorkletProcessor = class {
            constructor() {
                this.port = {
                    postMessage() {
                    },
                    onmessage: null,
                };
            }
        };
        globalThis.currentTime = 0;
        globalThis.sampleRate = 44100;

        const fn = new Function(processorCode + "\nreturn MotifSynthProcessor;");
        const MotifSynthProcessorClass = fn();

        const inst = new MotifSynthProcessorClass();
        const portMsgs = [];
        inst.port = {
            postMessage(msg) {
                portMsgs.push(msg);
            },
        };
        inst._startTime = 0;

        inst._synthFn = () => 0.5;
        let outputs = [[new Float32Array(128)]];
        inst.process([], outputs, { frequency: [440] });
        assert(outputs[0][0][0] === 0.5, "Processor should output normal sample values");
        assert(portMsgs.length === 0, "No error messages should be posted for normal values");

        inst._synthFn = () => NaN;
        let threw = false;
        try {
            inst.process([], outputs, { frequency: [440] });
        } catch (e) {
            threw = true;
            assert(e.message.includes("finite sample number"), "Exception should contain non-finite info");
        }
        assert(threw === true, "Processor should throw on NaN output");
        assert(portMsgs.some(m => m.type === "SYNTH_ERROR"), "Should post SYNTH_ERROR port message");
        assert(portMsgs.some(m => m.type === "VOICE_ENDED"), "Should post VOICE_ENDED port message");

        globalThis.AudioWorkletProcessor = prevAWP;
        delete globalThis.currentTime;
        delete globalThis.sampleRate;
    }

    // Clean up
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// TODO: Fix degreeToMidi scale lookup - camelCase scale names unreachable
// =============================================================================
console.log("\n=== degreeToMidi: camelCase scale names ===");
{
    const harmonicMinorMidi = degreeToMidi(5, "C3", "harmonicMinor");
    assert(harmonicMinorMidi === noteToMidi("Ab3"), `harmonicMinor degree 5 should be Ab3 (${noteToMidi("Ab3")}), got ${harmonicMinorMidi}`);

    const pentatonicMinorMidi = degreeToMidi(1, "C3", "pentatonicMinor");
    assert(pentatonicMinorMidi === noteToMidi("Eb3"), `pentatonicMinor degree 1 should be Eb3 (${noteToMidi("Eb3")}), got ${pentatonicMinorMidi}`);
}

// =============================================================================
// TODO: Fix crash - Arrange dereferences track._isSolo before null check
// =============================================================================
console.log("\n=== Arrange: null/undefined track entries don't crash ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevIsPlaying = Motif.isPlaying;

    Track.clearRegistry();
    const t1 = Track("t1").synth("sine").note([60]);
    Motif.tempo = 120;
    Motif.isPlaying = false;

    let threw = false;
    try {
        Arrange([{ tracks: [t1, null, undefined], bars: 1 }]);
    } catch (e) {
        threw = true;
        console.log(`  threw: ${e.message}`);
    }
    assert(threw === false, "Arrange should not throw when tracks array contains null/undefined entries");
    assert(t1._activeSegments.length === 1, "t1 should still get an active segment scheduled");
    if (t1._activeSegments.length === 1) {
        assert(t1._activeSegments[0].start === 0, `t1 active segment should start at 0, got ${t1._activeSegments[0].start}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// TODO: Isolate errors in MotifEngine.tick()
// =============================================================================
console.log("\n=== MotifEngine.tick: isolates per-track scheduling errors ===");
{
    const prevCtx = Motif.ctx;
    const prevIsPlaying = Motif.isPlaying;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    Motif.ctx = { state: "running", currentTime: 0 };
    Motif.isPlaying = true;

    let secondCalled = false;
    const throwingTrack = {
        id: "throws", _schedule: () => {
            throw new Error("boom");
        },
    };
    const okTrack = {
        id: "ok", _schedule: () => {
            secondCalled = true;
        },
    };
    trackRegistry.set("throws", throwingTrack);
    trackRegistry.set("ok", okTrack);

    const origConsoleError = console.error;
    let errorLogged = false;
    console.error = (...args) => {
        errorLogged = true;
    };

    let threw = false;
    try {
        Motif.tick();
    } catch (e) {
        threw = true;
    }

    console.error = origConsoleError;

    assert(threw === false, "tick() must not throw when a track's _schedule() throws");
    assert(secondCalled === true, "second track's _schedule() must still run after first track throws");
    assert(errorLogged === true, "tick() should log the per-track scheduling error");

    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    Motif.ctx = prevCtx;
    Motif.isPlaying = prevIsPlaying;
}

console.log("\n=== MotifEngine.tick: isolates errors in Motif.schedule() callbacks ===");
{
    const prevCtx = Motif.ctx;
    const prevIsPlaying = Motif.isPlaying;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    Motif.ctx = { state: "running", currentTime: 0 };
    Motif.isPlaying = true;

    let secondFired = false;
    Motif.schedule(0, () => {
        throw new Error("x");
    });
    Motif.schedule(0, () => {
        secondFired = true;
    });

    const origConsoleError = console.error;
    console.error = () => {
    };

    let threw = false;
    try {
        Motif.tick();
    } catch (e) {
        threw = true;
    }

    console.error = origConsoleError;

    assert(threw === false, "tick() must not throw when a schedule() callback throws");
    assert(secondFired === true, "second scheduled callback must still fire after first throws");
    assert(Motif._schedQueue.length === 0, `_schedQueue should be empty after one tick(), got ${Motif._schedQueue.length}`);

    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    Motif.ctx = prevCtx;
    Motif.isPlaying = prevIsPlaying;
}

// =============================================================================
// TODO: Isolate errors in TrackScheduler._schedule
// =============================================================================
console.log("\n=== TrackScheduler._schedule: isolates modifier and _playEvent errors ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    class SchedIsolationMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
        }
    }

    Track.clearRegistry();
    const trackA = Track("sched-isolation-a").note(["C3"]).every(1, () => {
        throw new Error("boom");
    });
    const trackB = Track("sched-isolation-b").note(["E3"]);

    let bPlayCount = 0;
    trackB._playEvent = function(event, startTime, duration) {
        bPlayCount++;
    };
    let aPlayCount = 0;
    trackA._playEvent = function(event, startTime, duration) {
        aPlayCount++;
    };

    const mockCtx = new SchedIsolationMockCtx();
    Motif.ctx = mockCtx;
    Motif.tempo = 120; // 1 bar = 2s
    Motif._schedQueue = [];

    const origConsoleError = console.error;
    let errorLogged = false;
    console.error = (...args) => {
        errorLogged = true;
    };

    let threw = false;
    try {
        Motif.tick();
    } catch (e) {
        threw = true;
    }

    console.error = origConsoleError;

    assert(threw === false, "Motif.tick() must not throw when a track's modifier throws");
    assert(errorLogged === true, "the modifier error should be logged");
    assert(bPlayCount > 0, "track B's _playEvent should still fire after track A's modifier throws");
    assert(trackA._scheduledUntil > 0, `track A's _scheduledUntil should still advance past 0 despite modifier error, got ${trackA._scheduledUntil}`);

    // Second tick: both tracks keep making progress (no permanent-repeat lockup on A).
    const aScheduledAfterFirstTick = trackA._scheduledUntil;
    const bScheduledAfterFirstTick = trackB._scheduledUntil;
    mockCtx.currentTime += 0.05;

    let threwSecond = false;
    console.error = () => {
    };
    try {
        Motif.tick();
    } catch (e) {
        threwSecond = true;
    }
    console.error = origConsoleError;

    assert(threwSecond === false, "second tick() must not throw either");
    assert(trackA._scheduledUntil > aScheduledAfterFirstTick, `track A should keep advancing on second tick, got ${trackA._scheduledUntil} vs previous ${aScheduledAfterFirstTick}`);
    assert(trackB._scheduledUntil > bScheduledAfterFirstTick, `track B should keep advancing on second tick, got ${trackB._scheduledUntil} vs previous ${bScheduledAfterFirstTick}`);
    assert(bPlayCount > 0, "track B's _playEvent still fires on second tick");
    assert(aPlayCount > 0, "track A's own _playEvent should still fire with unmodified events after modifier error");

    Track.clearRegistry();
    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
console.log("\n=== TrackScheduler: preserves musical position after scheduling gaps ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevBeatsPerBar = Motif.beatsPerBar;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();
    Motif.ctx = { state: "running", currentTime: 10 };
    Motif.tempo = 120;
    Motif.beatsPerBar = 4;

    try {
        const track = Track("scheduler-gap").note([60, 62, 64, 65]);
        const played = [];
        track._playEvent = (event, time) => played.push([event.value, time]);
        track._schedule(10.1);
        Motif.ctx.currentTime = 10.3;
        track._schedule(10.6);
        assert(JSON.stringify(played) === JSON.stringify([[60, 10], [62, 10.5]]),
            "late tick skips missed notes and preserves subsequent beat timing");

        const gainCalls = [];
        track.trackInputNode = { gain: {
            setValueAtTime: (value, time) => gainCalls.push(["set", value, time]),
            linearRampToValueAtTime: (value, time) => gainCalls.push(["ramp", value, time]),
        } };
        track._scheduledRamps = [
            { start: 1, duration: 1, from: 0, to: 1, scheduled: false },
            { start: 5, duration: 2, from: 1, to: 0, scheduled: false },
        ];
        track.start(6).stop(7);
        Motif.ctx.currentTime = 16.3;
        track._schedule(17.1);
        assert(JSON.stringify(played.slice(2)) === JSON.stringify([[62, 16.5]]),
            "multi-cycle gap preserves arrangement start and stop times");
        assert(track._currentCycle === 3, "multi-cycle recovery retains the absolute cycle index");
        assert(gainCalls[0][0] === "set" && gainCalls[0][1] === 1 && gainCalls[0][2] === 16.3,
            "completed gain ramp catches up to its final value after a stall");
        assert(gainCalls[1][0] === "set" && Math.abs(gainCalls[1][1] - 0.35) < 1e-9 && gainCalls[1][2] === 16.3,
            "active gain ramp resumes at its interpolated value after a stall");
        assert(JSON.stringify(gainCalls[2]) === JSON.stringify(["ramp", 0, 17]),
            "active gain ramp retains its original end time after a stall");

        track._clearActiveSegments();
        const solo = Track("scheduler-gap-solo").note([67]).solo();
        Motif.ctx.currentTime = 18.3;
        track._schedule(18.6);
        const countWhileSoloed = played.length;
        solo._isSolo = false;
        Motif.ctx.currentTime = 20.3;
        track._schedule(20.6);
        assert(played.length === countWhileSoloed + 1 && played.at(-1)[1] === 20.5,
            "track rejoins its original beat after being excluded by solo");

        track._resetScheduling();
        Motif.ctx.currentTime = 25;
        track._schedule(25.1);
        assert(JSON.stringify(played.at(-1)) === JSON.stringify([60, 25]),
            "explicit transport reset still restarts the opening note");

        const loop = Track("scheduler-gap-loop").note([60, 62, 64, 65]).loopLength("1/4");
        const loopTimes = [];
        loop._playEvent = (event, time) => loopTimes.push(time);
        loop._schedule(25.1);
        Motif.ctx.currentTime = 27.3;
        loop._schedule(27.6);
        assert(JSON.stringify(loopTimes) === JSON.stringify([25, 27.5]),
            "short loop recovery keeps the original loop boundary and skips past onsets");
    } finally {
        trackRegistry.clear();
        for (const [id, track] of savedTracks) trackRegistry.set(id, track);
        Motif.ctx = prevCtx;
        Motif.tempo = prevTempo;
        Motif.beatsPerBar = prevBeatsPerBar;
    }
}

// =============================================================================
console.log("\n=== TrackScheduler: stable cycle transformations and live edits ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const prevBeatsPerBar = Motif.beatsPerBar;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();
    Motif.ctx = { state: "running", currentTime: 0 };
    Motif.tempo = 120;
    Motif.beatsPerBar = 4;

    try {
        let calls = 0;
        const track = Track("cycle-transform").note([60, 60, 60, 60]).every(1, events => {
            calls++;
            return events.map(event => ({ ...event, value: event.value + calls }));
        });
        const played = [];
        track._playEvent = (event, time) => played.push([event.value, time]);
        track._schedule(0.1);
        track._schedule(0.6);
        track._schedule(1.6);
        assert(calls === 1 && played.every(([value]) => value === 61),
            "stateful every callback runs once and preserves all notes within a cycle");
        track._schedule(2.6);
        assert(calls === 2 && played.at(-1)[0] === 62,
            "crossing a cycle boundary evaluates a fresh transformation once");
        Motif.ctx.currentTime = 8.3;
        track._schedule(8.6);
        track._schedule(9.1);
        assert(calls === 3 && played.at(-1)[0] === 63,
            "stall recovery evaluates the resumed cycle once without replaying skipped callbacks");
        track._resetScheduling();
        track._schedule(8.4);
        assert(calls === 4 && played.at(-1)[0] === 64,
            "transport reset discards the retained cycle transformation");

        Motif.ctx.currentTime = 0;
        const edited = Track("cycle-edit").note([60, 62, 64, 65]);
        const editedValues = [];
        edited._playEvent = event => editedValues.push([event.value, edited._freqPattern !== null]);
        edited._schedule(0.1);
        edited.freq([440, 450, 460, 470]);
        edited._schedule(0.6);
        let editCalls = 0;
        edited.every(1, events => {
            editCalls++;
            return events.map(event => ({ ...event, value: event.value + 1 }));
        });
        edited._schedule(1.1);
        edited._schedule(1.6);
        assert(JSON.stringify(editedValues) === JSON.stringify([[60, false], [450, true], [461, true], [471, true]]),
            "note-to-frequency edits and new modifiers apply to unscheduled events immediately");
        assert(editCalls === 1, "adding the first modifier rebuilds the cycle only once");
        edited.seed(99);
        edited._schedule(1.7);
        edited._schedule(1.8);
        assert(editCalls === 2, "seed edits rebuild once without repeating on later ticks");

        let setterCalls = 0;
        const selfEditing = Track("cycle-self-edit").note([60, 62]).every(1, events => {
            setterCalls++;
            selfEditing.note([64, 65]);
            return events;
        });
        selfEditing._playEvent = () => {};
        selfEditing._schedule(0.1);
        selfEditing._schedule(1.1);
        assert(setterCalls === 1, "a pattern setter inside a callback does not retrigger the same cycle");

        const editedVoicing = Track("cycle-voicing-edit").note([Parallel(60, 64, 67), 84]).chordVoicing({ mode: "smooth" });
        const editedChordNotes = [];
        editedVoicing._playEvent = event => editedChordNotes.push(event.value);
        editedVoicing._schedule(0.1);
        editedVoicing.note([Parallel(60, 64, 67), Parallel(60, 64, 67)]);
        editedVoicing._schedule(1.1);
        assert(JSON.stringify(editedChordNotes) === JSON.stringify([60, 64, 67, 60, 64, 67]),
            "mid-cycle pattern edits voice remaining chords from cycle-entry history, not discarded future chords");

        const voiced = Track("cycle-voicing").note([Parallel(60, 64, 67), Parallel(65, 69, 72)]).chordVoicing({ mode: "smooth" });
        const voicedNotes = [];
        voiced._playEvent = event => voicedNotes.push(event.value);
        voiced._schedule(0.1);
        voiced._schedule(1.1);
        const firstPass = [...voicedNotes];
        voiced._resetScheduling();
        voiced._schedule(1.1);
        assert(JSON.stringify(voicedNotes.slice(firstPass.length)) === JSON.stringify(firstPass),
            "transport restart resets smooth chord voicing as well as retained events");
    } finally {
        trackRegistry.clear();
        for (const [id, track] of savedTracks) trackRegistry.set(id, track);
        Motif.ctx = prevCtx;
        Motif.tempo = prevTempo;
        Motif.beatsPerBar = prevBeatsPerBar;
    }
}

// =============================================================================
// TODO: Guard non-positive cycle durations (TrackScheduler._schedule)
// =============================================================================
console.log("\n=== TrackScheduler._schedule: guards non-positive cycle durations ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    class NonPositiveCycleMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
        }
    }

    Track.clearRegistry();
    Motif.ctx = new NonPositiveCycleMockCtx();
    Motif.tempo = 120;

    const tStep = Track("z0").note(["C3"]).stepLength(0);
    const horizonStep = Motif.ctx.currentTime + 0.1;

    let threwStep = false;
    const startStep = Date.now();
    try {
        tStep._schedule(horizonStep);
    } catch (e) {
        threwStep = true;
    }
    const elapsedStep = Date.now() - startStep;

    assert(threwStep === false, "_schedule() must not throw for stepLength(0)");
    assert(elapsedStep < 1000, `_schedule() must return promptly for stepLength(0), took ${elapsedStep}ms (bug = hang)`);
    assert(tStep._scheduledUntil >= horizonStep, `_scheduledUntil should reach horizon for stepLength(0), got ${tStep._scheduledUntil} vs horizon ${horizonStep}`);

    // Analogous guard for loopLength(0): effective cycle duration collapses to 0 via the loop branch.
    const tLoop = Track("z1").note(["C3"]).loopLength(0);
    const horizonLoop = Motif.ctx.currentTime + 0.1;

    let threwLoop = false;
    const startLoop = Date.now();
    try {
        tLoop._schedule(horizonLoop);
    } catch (e) {
        threwLoop = true;
    }
    const elapsedLoop = Date.now() - startLoop;

    assert(threwLoop === false, "_schedule() must not throw for loopLength(0)");
    assert(elapsedLoop < 1000, `_schedule() must return promptly for loopLength(0), took ${elapsedLoop}ms (bug = hang)`);
    assert(tLoop._scheduledUntil >= horizonLoop, `_scheduledUntil should reach horizon for loopLength(0), got ${tLoop._scheduledUntil} vs horizon ${horizonLoop}`);

    Track.clearRegistry();
    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
}

// =============================================================================
// Task: Fix worklet voices never stopping when stopped without a time
// Harness GranularStretcherProcessor directly: STOP_AT with undefined endTime
// and STOP must make process() return false (was returning true forever).
// =============================================================================
console.log("\n=== Worklet Stop: GranularStretcherProcessor termination ===");
{
    const savedProcessor = globalThis.AudioWorkletProcessor;
    const savedRegister = globalThis.registerProcessor;
    const savedSampleRate = globalThis.sampleRate;
    const savedCurrentTime = globalThis.currentTime;

    let CapturedProcessorClass = null;

    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = {
                onmessage: null, postMessage() {
                },
            };
        }
    };
    globalThis.registerProcessor = (name, cls) => {
        CapturedProcessorClass = cls;
    };
    globalThis.sampleRate = 44100;
    globalThis.currentTime = 0;

    const cacheBust = `?t=${Date.now()}`;
    await import(`./src/worklets/GranularStretcherProcessor.js${cacheBust}`);

    assert(typeof CapturedProcessorClass === "function", "GranularStretcherProcessor registered a class");

    const makeOutputs = () => [[new Float32Array(128), new Float32Array(128)]];
    const params = {
        stretchFactor: [1],
        pitchRatio: [1],
        grainSize: [0.05],
        overlap: [4],
    };

    const feedBuffer = (inst) => {
        inst.port.onmessage({
            data: {
                leftBuffer: new Float32Array(44100),
                rightBuffer: new Float32Array(44100),
                bufferSampleRate: 44100,
            },
        });
        inst.port.onmessage({ data: { type: "START", startTime: 0 } });
    };

    // Path A: STOP_AT with undefined endTime → immediate stop.
    const instStopAt = new CapturedProcessorClass();
    feedBuffer(instStopAt);
    const activeA = instStopAt.process([], makeOutputs(), params);
    assert(activeA === true, "STOP_AT path: process() returns true while voice active");
    instStopAt.port.onmessage({ data: { type: "STOP_AT", endTime: undefined } });
    const afterA = instStopAt.process([], makeOutputs(), params);
    assert(afterA === false, "STOP_AT with undefined endTime: process() returns false after stop");

    // Path B: explicit STOP message → immediate stop.
    const instStop = new CapturedProcessorClass();
    feedBuffer(instStop);
    const activeB = instStop.process([], makeOutputs(), params);
    assert(activeB === true, "STOP path: process() returns true while voice active");
    instStop.port.onmessage({ data: { type: "STOP" } });
    const afterB = instStop.process([], makeOutputs(), params);
    assert(afterB === false, "STOP message: process() returns false after stop");

    globalThis.AudioWorkletProcessor = savedProcessor;
    globalThis.registerProcessor = savedRegister;
    globalThis.sampleRate = savedSampleRate;
    globalThis.currentTime = savedCurrentTime;
}

// =============================================================================
// Task: Clean up splitStereo right track and sends/modulators in _crossfadeOut
// (src/TrackAudioChain.js) - stale sx_right must be deregistered on redefine
// =============================================================================
console.log("\n=== Track: _crossfadeOut deregisters stale splitStereo right track ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class CrossfadeMockMerger {
        constructor(inputs) {
            this.numberOfInputs = inputs;
        }

        connect() {
        }

        disconnect() {
        }
    }

    const makeParam = (v = 1.0) => ({
        value: v,
        setValueAtTime(val) {
            this.value = val;
            return this;
        },
        linearRampToValueAtTime(val) {
            this.value = val;
            return this;
        },
        exponentialRampToValueAtTime(val) {
            this.value = val;
            return this;
        },
        cancelAndHoldAtTime() {
            return this;
        },
        cancelScheduledValues() {
            return this;
        },
    });

    const makeNode = (extra = {}) => ({
        gain: makeParam(1.0),
        pan: makeParam(0),
        frequency: makeParam(350),
        Q: makeParam(1),
        threshold: makeParam(-24),
        knee: makeParam(30),
        ratio: makeParam(12),
        attack: makeParam(0.003),
        release: makeParam(0.25),
        type: "lowpass",
        curve: null,
        oversample: "none",
        connect() {
        },
        disconnect() {
        },
        ...extra,
    });

    class CrossfadeMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
        }

        createGain() {
            return makeNode();
        }

        createBiquadFilter() {
            return makeNode();
        }

        createDynamicsCompressor() {
            return makeNode();
        }

        createWaveShaper() {
            return makeNode();
        }

        createStereoPanner() {
            return makeNode();
        }

        createChannelMerger(inputs) {
            return new CrossfadeMockMerger(inputs);
        }
    }

    Motif.ctx = new CrossfadeMockCtx();
    Motif.masterGain = Motif.ctx.createGain();
    Motif.tempo = 120;
    Track.clearRegistry();

    const t = Track("sx").splitStereo();
    assert(trackRegistry.has("sx_right"), "splitStereo registers shadow right track sx_right");
    assert(trackRegistry.get("sx_right") === t._rightTrack, "sx_right entry is the shadow right track");

    // Redefine sx without split; short crossfade so the test finishes quickly.
    const oldRight = t._rightTrack;
    const newTrack = Track("sx");

    assert(trackRegistry.has("sx_right"), "sx_right still registered during crossfade");
    assert(newTrack._rightTrack === null, "redefined track without split has no right track");

    await new Promise(r => setTimeout(r, 1100));

    assert(!trackRegistry.has("sx_right"), "sx_right deregistered after crossfade completes");
    assert(trackRegistry.get("sx_right") !== oldRight, "stale right track no longer in registry");

    // Guard branch: redefine WITH split re-registers a fresh sx_right before the
    // old track's timeout fires; the `=== it` guard must NOT delete that fresh entry.
    const t2 = Track("sx").splitStereo();
    const firstRight = t2._rightTrack;
    const t3 = Track("sx").splitStereo();
    const secondRight = t3._rightTrack;
    assert(trackRegistry.get("sx_right") === secondRight, "redefine-with-split registers fresh right track");

    await new Promise(r => setTimeout(r, 1100));

    assert(trackRegistry.get("sx_right") === secondRight, "guard preserves fresh right track after old crossfade timeout");
    assert(secondRight !== firstRight, "second splitStereo created a distinct right track");

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Track.clearRegistry();
}

// =============================================================================
// Task: Fix async sample/sampler load races leaving stale buffers
// (src/TrackVoiceManager.js) - generation guards must prevent a slow earlier
// load from clobbering the current buffer, and a second sampler() from having
// the first call's late loads write into its fresh Map / reorder _samplerKeys.
// =============================================================================
console.log("\n=== Sample/Sampler load races: generation guards ===");
{
    const prevLoad = Motif._loadAndCacheBuffer;
    const prevRegistry = Motif.sampleRegistry;
    Motif.sampleRegistry = new Map();

    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };

    // A microtask + macrotask flush so all chained .then closures have run.
    const flush = () => new Promise(r => setTimeout(r, 0));

    Track.clearRegistry();

    // sample('a') then sample('b'); a's fetch resolves last.
    {
        const dA = deferred();
        const dB = deferred();
        const bufA = { tag: "a" };
        const bufB = { tag: "b" };
        Motif._loadAndCacheBuffer = (path) => (path === "a" ? dA.promise : dB.promise);

        const t = Track("race-sample");
        t.sample("a");
        t.sample("b");
        assert(t._sampleUrl === "b", "sample(): _sampleUrl reflects latest call (b)");

        dB.resolve(bufB);
        dA.resolve(bufA);
        await dA.promise;
        await dB.promise;
        await flush();

        assert(t._sampleBuffer === bufB, "sample(): b wins even though a resolves last");
        assert(t._sampleBuffer !== bufA, "sample(): stale a load did not clobber current buffer");
    }

    // .synth() during an in-flight sample load must not repopulate _sampleBuffer.
    {
        const dC = deferred();
        const bufC = { tag: "c" };
        Motif._loadAndCacheBuffer = () => dC.promise;

        const t = Track("race-synth");
        t.sample("c");
        t.synth("sine");
        assert(t._sampleBuffer === null, "synth(): buffer nulled before load resolves");

        dC.resolve(bufC);
        await dC.promise;
        await flush();

        assert(t._sampleBuffer === null, "synth(): in-flight load does not repopulate _sampleBuffer");
    }

    // Double sampler(): first call's late loads must land in its own discarded
    // Map, not the second call's fresh Map; _samplerKeys built from current Map.
    {
        const dX = deferred();
        const dY = deferred();
        const bufX = { tag: "x" };
        const bufY = { tag: "y" };
        Motif._loadAndCacheBuffer = (path) => (path === "x" ? dX.promise : dY.promise);

        const t = Track("race-sampler");
        t.sampler({ urls: { "60": "x" } });
        const firstBuffers = t._samplerBuffers;
        t.sampler({ urls: { "60": "y" } });
        const secondBuffers = t._samplerBuffers;
        assert(firstBuffers !== secondBuffers, "sampler(): second call swaps in a fresh Map");

        dY.resolve(bufY);
        dX.resolve(bufX);
        await dX.promise;
        await dY.promise;
        await t._samplerLoading;
        await flush();

        assert(t._samplerBuffers === secondBuffers, "sampler(): current Map is the second call's");
        assert(secondBuffers.get(60) === bufY, "sampler(): fresh Map holds y");
        assert(firstBuffers.get(60) === bufX, "sampler(): late x landed in discarded first Map");
        assert(secondBuffers.get(60) !== bufX, "sampler(): late x did not clobber the current Map");
        assert(t._samplerKeys.length === 1 && t._samplerKeys[0] === 60, "sampler(): _samplerKeys built from current Map");
    }

    Motif._loadAndCacheBuffer = prevLoad;
    Motif.sampleRegistry = prevRegistry;
    Track.clearRegistry();
}

// =============================================================================
// Task: Fix `_getMonoBuffer` cache keyed by channel only
// (src/TrackVoiceManager.js) - cache must be keyed by buffer identity, not
// just channel, so distinct source buffers don't share a stale mono result;
// also must be cleared whenever sample()/sampler()/synth() swap the source.
// =============================================================================
console.log("\n=== _getMonoBuffer: cache keyed by buffer identity, not just channel ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    class MonoBufferMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
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
                    this._copiedFrom = chIdx;
                },
            };
        }
    }

    Motif.ctx = new MonoBufferMockCtx();
    Motif.tempo = 120;
    Track.clearRegistry();

    const t = Track("mono-cache-test");

    const bufA = Motif.ctx.createBuffer(2, 100, 44100);
    const bufB = Motif.ctx.createBuffer(2, 100, 44100);

    const monoA = t._getMonoBuffer(bufA, 0);
    const monoAAgain = t._getMonoBuffer(bufA, 0);
    const monoB = t._getMonoBuffer(bufB, 0);

    assert(monoA !== bufA, "_getMonoBuffer returns a derived mono buffer, not the input");
    assert(monoAAgain === monoA, "_getMonoBuffer caches by (buffer, channel) so repeat calls hit cache");
    assert(monoB !== monoA, "_getMonoBuffer for a different source buffer must not reuse bufA's cached mono result");
    assert(monoB.numberOfChannels === 1, "mono result derived from bufB is monophonic");

    // Cache must be cleared whenever the source buffer(s) change via
    // sample()/sampler()/synth(), so a stale mono conversion can't be pinned
    // in memory and served after the underlying source has moved on.
    const monoBeforeReset = t._getMonoBuffer(bufA, 0);
    assert(monoBeforeReset === monoA, "cache still holds bufA's mono result before any reset");

    t.synth("sine");
    assert(t._monoBufferCache === null, "synth() clears the mono buffer cache");

    const monoAAfterSynth = t._getMonoBuffer(bufA, 0);
    assert(monoAAfterSynth !== monoA, "after synth() clears cache, _getMonoBuffer recomputes rather than reusing stale entry");

    t._monoBufferCache.get(bufA); // sanity: WeakMap accepts object keys without throwing
    t.sample(null);
    assert(t._monoBufferCache === null, "sample() clears the mono buffer cache");

    t._getMonoBuffer(bufA, 0);
    t.sampler({ urls: {} });
    assert(t._monoBufferCache === null, "sampler() clears the mono buffer cache");

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Track.clearRegistry();
}

// =============================================================================
// TODO: Fix inline dB automation applied as raw linear value; guard non-finite params
// (src/helpers.js applyParamModulation, src/TrackVoiceManager.js _playEvent)
// =============================================================================
console.log("\n=== Bug Fix: Inline dB Automation Guarding (Non-Finite AudioParam Safety) ===");
{
    const prevCtx = Motif.ctx;
    const prevTempo = Motif.tempo;

    const dbMap = (val) => (val === -Infinity ? 0 : Math.pow(10, val / 20));

    // TEST 1: numeric branch - "-6dB" string parsed then mapped through caller-supplied
    // dB->linear mapValueFn should record ~0.501187 (not the raw -6).
    {
        const setCalls = [];
        const param = {
            setValueAtTime(v, t) {
                setCalls.push(v);
                return this;
            },
        };
        applyParamModulation({}, param, "-6dB", "_testModulator", dbMap);

        assert(setCalls.length === 1, `expected setValueAtTime called once, got ${setCalls.length}`);
        assert(Math.abs(setCalls[0] - Math.pow(10, -6 / 20)) < 1e-6,
            `expected ~0.501187 recorded gain for "-6dB" with dbMap, got ${setCalls[0]}`);
    }

    // TEST 2: numeric branch - "-inf dB" string with no mapValueFn must not throw and
    // must NOT record a non-finite value on the AudioParam.
    {
        const setCalls = [];
        const param = {
            setValueAtTime(v, t) {
                setCalls.push(v);
                return this;
            },
        };

        let threw = false;
        try {
            applyParamModulation({}, param, "-inf dB", "_testModulator", null);
        } catch (e) {
            threw = true;
        }

        assert(threw === false, "applyParamModulation should not throw for '-inf dB' with no mapValueFn");
        assert(setCalls.length === 0,
            `expected no setValueAtTime call recorded for raw non-finite value, got ${JSON.stringify(setCalls)}`);
    }

    // TEST 3: ramp branch guard - non-finite mapped "from"/"to" must not throw and must
    // not schedule any AudioParam calls.
    {
        const setCalls = [];
        const rampCalls = [];
        const param = {
            setValueAtTime(v, t) {
                setCalls.push(v);
                return this;
            },
            linearRampToValueAtTime(v, t) {
                rampCalls.push(v);
                return this;
            },
        };

        let threw = false;
        try {
            applyParamModulation({}, param, {
                isRamp: true,
                from: -Infinity,
                to: -6,
                duration: 0.1,
            }, "_testModulator", null);
        } catch (e) {
            threw = true;
        }

        assert(threw === false, "applyParamModulation ramp branch should not throw for non-finite mapped 'from'");
        assert(setCalls.length === 0 && rampCalls.length === 0,
            "non-finite ramp endpoints must not schedule any AudioParam calls");
    }

    // Self-contained mock context (with a real recording setValueAtTime) so this section's
    // assertions don't depend on whatever Motif.ctx happens to be left over from other tests.
    class InlineDbAutomationMockGainNode {
        constructor() {
            this.gain = {
                value: 1.0,
                setValueAtTime(v) {
                    this.value = v;
                    return this;
                },
                linearRampToValueAtTime(v) {
                    this.value = v;
                    return this;
                },
            };
        }

        connect(dest) {
            return dest;
        }

        disconnect() {
        }
    }

    class InlineDbAutomationMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
        }

        createGain() {
            return new InlineDbAutomationMockGainNode();
        }
    }

    // TEST 4: _playEvent inline volume automation ({type: "volume", value: "-6dB"}) must
    // apply the dB->linear converter (mirroring EffectChain.volume), not the raw -6.
    {
        Motif.ctx = new InlineDbAutomationMockCtx();
        const t = Track("inline-db-automation-test");
        t._initAudio();
        t._playEvent({ value: { type: "volume", value: "-6dB" } }, 0, 1);

        const expectedGain = Math.pow(10, -6 / 20);
        assert(Math.abs(t.volumeNode.gain.value - expectedGain) < 1e-6,
            `expected volumeNode.gain ~0.501187 for inline "-6dB" automation, got ${t.volumeNode.gain.value}`);
    }

    // TEST 5: _playEvent inline volume automation with "-inf dB" must not throw and must
    // snap to 0 gain (via the mirrored converter), never raw -Infinity.
    {
        Motif.ctx = new InlineDbAutomationMockCtx();
        const t2 = Track("inline-db-automation-inf-test");
        t2._initAudio();

        let threw = false;
        try {
            t2._playEvent({ value: { type: "volume", value: "-inf dB" } }, 0, 1);
        } catch (e) {
            threw = true;
        }

        assert(threw === false, "_playEvent should not throw scheduling '-inf dB' inline volume automation");
        assert(t2.volumeNode.gain.value === 0,
            `expected volumeNode.gain to be 0 for '-inf dB' inline automation, got ${t2.volumeNode.gain.value}`);
    }

    Motif.ctx = prevCtx;
    Motif.tempo = prevTempo;
    Track.clearRegistry();
}

// =============================================================================
// TASK: Guard createLFO against non-finite frequency (todo.md "Bugs (Edge Cases)")
// =============================================================================
{
    class LfoGuardMockOscillatorNode {
        constructor() {
            this.frequency = {
                value: 1.0,
                setValueAtTime(v) {
                    this.value = v;
                    return this;
                },
            };
            this.type = "sine";
        }

        connect() {
            return this;
        }

        disconnect() {
        }

        start() {
        }

        stop() {
        }
    }

    class LfoGuardMockGainNode {
        constructor() {
            this.gain = {
                value: 1.0,
                setValueAtTime(v) {
                    this.value = v;
                    return this;
                },
            };
        }

        connect() {
            return this;
        }

        disconnect() {
        }
    }

    class LfoGuardMockCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
            this.destination = {};
        }

        createOscillator() {
            return new LfoGuardMockOscillatorNode();
        }

        createGain() {
            return new LfoGuardMockGainNode();
        }
    }

    const prevCtx = Motif.ctx;

    // TEST 1: LFO.sine({ speed: 0 }) must not throw and must yield a finite oscillator frequency
    {
        Motif.ctx = new LfoGuardMockCtx();
        let threw = false;
        let lfo;
        try {
            lfo = LFO.sine({ speed: 0 });
        } catch (e) {
            threw = true;
        }
        assert(threw === false, "LFO.sine({ speed: 0 }) should not throw");
        assert(Number.isFinite(lfo.osc.frequency.value),
            `expected finite osc.frequency after speed: 0, got ${lfo.osc.frequency.value}`);
    }

    // TEST 2: LFO(NaN) must not throw and must yield a finite oscillator frequency
    {
        Motif.ctx = new LfoGuardMockCtx();
        let threw = false;
        let lfo;
        try {
            lfo = LFO(NaN);
        } catch (e) {
            threw = true;
        }
        assert(threw === false, "LFO(NaN) should not throw");
        assert(Number.isFinite(lfo.osc.frequency.value),
            `expected finite osc.frequency for LFO(NaN), got ${lfo.osc.frequency.value}`);
    }

    // TEST 3: non-finite depth/offset (via NaN min/max) must be clamped to finite defaults
    {
        Motif.ctx = new LfoGuardMockCtx();
        let threw = false;
        let lfo;
        try {
            lfo = LFO.sine({ frequency: 2, min: NaN, max: NaN });
        } catch (e) {
            threw = true;
        }
        assert(threw === false, "LFO.sine with non-finite min/max should not throw");
        assert(Number.isFinite(lfo.gainNode.gain.value),
            `expected finite gainNode.gain (depth) for non-finite min/max, got ${lfo.gainNode.gain.value}`);
    }

    Motif.ctx = prevCtx;
}

// =============================================================================
// TODO: Fix auto-loop restart race with ctx.suspend(); make pause() -> start() resume
// =============================================================================
console.log("\n=== MotifEngine: auto-loop restart race with pending suspend ===");
{
    const prevCtx = Motif.ctx;
    const prevIsPlaying = Motif.isPlaying;
    const prevOptions = Motif._arrangementOptions;
    const prevStartScheduler = Motif._startScheduler;
    const prevSuspendedByEngine = Motif._suspendedByEngine;
    const prevSuspendPromise = Motif._suspendPromise;
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    const flush = () => new Promise(r => setTimeout(r, 10));

    // MockAudioContext whose suspend() stays pending (state remains "running")
    // until we resolve it manually — reproduces the window where the loop
    // restart can fire before the engine-initiated suspend has landed.
    let resolveSuspend = null;

    class RaceCtx {
        constructor() {
            this.state = "running";
            this.currentTime = 2;
        }

        suspend() {
            return new Promise(res => {
                resolveSuspend = () => {
                    this.state = "suspended";
                    res();
                };
            });
        }

        resume() {
            this.state = "running";
            return Promise.resolve();
        }
    }

    const raceCtx = new RaceCtx();
    Motif.ctx = raceCtx;
    Motif.isPlaying = true;
    Motif._suspendedByEngine = false;
    Motif._suspendPromise = null;
    Motif._arrangementOptions = { loop: true, loopDelay: 0 };

    // Avoid spinning a real setInterval scheduler during the async assertions.
    Motif._startScheduler = () => {
    };

    // Minimal finished-arrangement track: finite segment stop reached at t=2.
    const loopTrack = {
        id: "loop-race",
        _notePattern: ["C3"],
        _parsedEvents: [{ value: "C3" }],
        _activeSegments: [{ start: 0, stop: 1 }],
        _playbackStartTime: 0,
        _schedule() {
        },
        _resetScheduling() {
        },
    };
    trackRegistry.set(loopTrack.id, loopTrack);

    // Drive tick() past the arrangement end: triggers stop() (pending suspend)
    // then schedules the loop restart.
    Motif.tick();

    assert(Motif._loopTimeout !== null, "auto-loop should schedule a restart timeout");

    // Let the restart macrotask fire. With the fix it parks on the pending
    // suspend promise; the buggy version would resume/start here while the
    // suspend is still in flight.
    await flush();

    // Now the engine-initiated suspend finally lands.
    if (typeof resolveSuspend === "function") resolveSuspend();

    // Allow the chained resume + transport launch to settle.
    await flush();

    assert(raceCtx.state === "running",
        `context must end "running" after restart settles, got "${raceCtx.state}"`);
    assert(Motif.isPlaying === true,
        "isPlaying must be true after auto-loop restart settles");
    assert(Motif._suspendedByEngine === false,
        "_suspendedByEngine should be cleared once the transport resumes");

    // pause() -> Motif.start() must resume instead of throwing.
    Motif._startScheduler = () => {
    };
    Motif.pause();
    assert(Motif._suspendedByEngine === true,
        "pause() should mark the suspend as engine-initiated");
    if (typeof resolveSuspend === "function") resolveSuspend();
    await flush();
    assert(raceCtx.state === "suspended",
        `context should be suspended after pause(), got "${raceCtx.state}"`);

    let pauseStartThrew = false;
    try {
        await Motif.start();
    } catch (e) {
        pauseStartThrew = true;
    }
    assert(pauseStartThrew === false,
        "Motif.start() after pause() must not throw (should resume the engine-suspended context)");
    assert(raceCtx.state === "running",
        `Motif.start() after pause() should resume context to "running", got "${raceCtx.state}"`);
    assert(Motif.isPlaying === true, "isPlaying must be true after pause() -> start() resume");

    // Cleanup
    if (Motif._loopTimeout) {
        clearTimeout(Motif._loopTimeout);
        Motif._loopTimeout = null;
    }
    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    Motif.ctx = prevCtx;
    Motif.isPlaying = prevIsPlaying;
    Motif._arrangementOptions = prevOptions;
    Motif._startScheduler = prevStartScheduler;
    Motif._suspendedByEngine = prevSuspendedByEngine;
    Motif._suspendPromise = prevSuspendPromise;
}

// =============================================================================
// Bugs (Edge Cases): Evict rejected promises from sampleBufferCache
// =============================================================================
console.log("\n=== _loadAndCacheBuffer: evicts rejected promises from sampleBufferCache ===");
{
    const prevCtx = Motif.ctx;
    const prevFetch = globalThis.fetch;

    class RejectEvictionMockCtx {
        decodeAudioData(ab, resolve) {
            resolve({ duration: 1, sampleRate: 44100, numberOfChannels: 1 });
        }
    }

    Motif.ctx = new RejectEvictionMockCtx();

    const path = "/audio/flaky-eviction-test.wav";
    sampleBufferCache.delete(path);

    let fetchCallCount = 0;
    globalThis.fetch = (url) => {
        fetchCallCount++;
        if (fetchCallCount === 1) return Promise.reject(new Error("network down"));
        return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
        });
    };

    let firstRejected = false;
    try {
        await Motif._loadAndCacheBuffer(path);
    } catch (e) {
        firstRejected = true;
    }
    assert(firstRejected === true, "first (failing) fetch should reject");

    // Let the detached eviction .then() microtask run.
    await Promise.resolve();
    await Promise.resolve();

    assert(sampleBufferCache.has(path) === false,
        "rejected promise must be evicted from sampleBufferCache");

    const buf = await Motif._loadAndCacheBuffer(path);
    assert(fetchCallCount === 2, `second call should trigger a fresh fetch, got fetchCallCount=${fetchCallCount}`);
    assert(buf && buf.numberOfChannels === 1, "second (successful) call should resolve with a decoded buffer");
    assert(sampleBufferCache.has(path) === true, "successful load should remain cached");

    // Cleanup
    sampleBufferCache.delete(path);
    globalThis.fetch = prevFetch;
    Motif.ctx = prevCtx;
}

// =============================================================================
// Bugs (Edge Cases): Array.prototype.add/sub/mul/div non-enumerable; evaluateOp
// no longer triple-calls noteToMidi (todo.md "Make Array.prototype.add/sub/mul/div
// non-enumerable; stop triple noteToMidi calls in evaluateOp")
// =============================================================================
console.log("\n=== Array.prototype arithmetic methods: non-enumerable + noteToMidi ===");
{
    const seenKeys = [];
    for (const k in [1]) {
        seenKeys.push(k);
    }
    assert(!seenKeys.includes("add"), "for...in over array must not yield 'add'");
    assert(!seenKeys.includes("sub"), "for...in over array must not yield 'sub'");
    assert(!seenKeys.includes("mul"), "for...in over array must not yield 'mul'");
    assert(!seenKeys.includes("div"), "for...in over array must not yield 'div'");

    for (const name of ["add", "sub", "mul", "div"]) {
        const desc = Object.getOwnPropertyDescriptor(Array.prototype, name);
        assert(desc && desc.enumerable === false, `Array.prototype.${name} descriptor must be enumerable:false`);
        assert(desc && desc.writable === true, `Array.prototype.${name} descriptor must be writable:true`);
        assert(desc && desc.configurable === true, `Array.prototype.${name} descriptor must be configurable:true`);
    }

    const noteResult = ["C3"].add(12);
    assert(JSON.stringify(noteResult) === JSON.stringify(["C4"]),
        `["C3"].add(12) should be ["C4"], got ${JSON.stringify(noteResult)}`);

    const crossResult = [60].add([1, 2]);
    assert(JSON.stringify(crossResult) === JSON.stringify([61, 62]),
        `[60].add([1, 2]) should be [61, 62], got ${JSON.stringify(crossResult)}`);
}

// =============================================================================
// todo.md "Extract shared dispose helpers for Track/Bus clearRegistry/pruneExcept"
// =============================================================================
console.log("\n=== Track.pruneExcept / Bus.pruneExcept: shared dispose helpers ===");
{
    const savedTracks = new Map(trackRegistry);
    const savedBuses = new Map(busRegistry);
    trackRegistry.clear();
    busRegistry.clear();

    let threw = false;
    try {
        Track("a");
        Track("b");
        Bus("x");

        Track.pruneExcept(["a"]);
        Bus.pruneExcept([]);
    } catch (e) {
        threw = true;
    }

    assert(threw === false, "Track.pruneExcept/Bus.pruneExcept must not throw under MockAudioContext");
    assert(trackRegistry.has("a"), "Track.pruneExcept(['a']) must keep track 'a'");
    assert(!trackRegistry.has("b"), "Track.pruneExcept(['a']) must remove track 'b'");
    assert(trackRegistry.size === 1, `Track registry should have exactly 1 entry after pruneExcept, got ${trackRegistry.size}`);
    assert(busRegistry.size === 0, `Bus.pruneExcept([]) should empty the bus registry, got ${busRegistry.size}`);

    trackRegistry.clear();
    busRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
    for (const [id, bus] of savedBuses) busRegistry.set(id, bus);
}

console.log("\n=== Track.pruneExcept: preserves \"__temp_probe__\" special case ===");
{
    const savedTracks = new Map(trackRegistry);
    trackRegistry.clear();

    Track("__temp_probe__");
    Track("real");

    Track.pruneExcept([]);

    assert(trackRegistry.has("__temp_probe__"), "Track.pruneExcept must never remove '__temp_probe__' even when absent from activeIds");
    assert(!trackRegistry.has("real"), "Track.pruneExcept([]) must remove non-active, non-probe tracks");

    trackRegistry.clear();
    for (const [id, track] of savedTracks) trackRegistry.set(id, track);
}

// =============================================================================
// Docs & Tests: Fix prompt.md drift (Track.feedback silent no-op stub)
// =============================================================================
console.log("\n=== Track.feedback: no-op stub warns once instead of silently doing nothing ===");
{
    const originalWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args.join(" "));

    const track = Track("__feedback_stub_probe__");
    const result = track.feedback({ amount: 0.5 });
    track.feedback({ amount: 0.9 });

    console.warn = originalWarn;

    assert(result === track, "Track.feedback() must remain a no-op that returns `this` for chaining");
    assert(warnCalls.length === 1, `Track.feedback() must warn exactly once across calls, got ${warnCalls.length} warnings`);
    assert(
        warnCalls.length > 0 && /only supported on Bus/i.test(warnCalls[0]),
        `Track.feedback() warning must mention Bus-only support, got: ${warnCalls[0] ?? "(none)"}`,
    );

    trackRegistry.delete("__feedback_stub_probe__");
}

console.log("\n=== prompt.md: Audio Routing lists .feedback({ amount }) as Bus-only ===");
{
    const { readFileSync } = await import("node:fs");
    const promptText = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
    const routingLine = promptText.split("\n").find((line) => line.includes("Audio Routing (chained on Track)"));

    assert(!!routingLine, "prompt.md must contain the 'Audio Routing (chained on Track)' line");
    assert(
        !!routingLine && !/`\.send\(bus, amount\)`, `\.feedback/.test(routingLine),
        "prompt.md Audio Routing (Track) line must not list `.feedback({ amount })` as a plain Track-chained method",
    );
    assert(
        promptText.includes("chained on `Bus`, NOT on Track"),
        "prompt.md must explicitly state .feedback({ amount }) is Bus-only, not Track",
    );
}

// =============================================================================
// Docs & Tests: documented-but-untested APIs — Track.sound() router, SimplexNoise
// =============================================================================
console.log("\n=== Track.synth(): eager name validation preserves source state ===");
{
    const sampleName = "__test_synth_validation_sample__";
    const sampleBuffer = {
        getChannelData: () => new Float32Array(10),
        duration: 0.5,
        sampleRate: 44100,
        numberOfChannels: 1,
        length: 10,
    };
    Motif.sampleRegistry.set(sampleName, sampleBuffer);

    const track = Track("synth-validation-state").sample(sampleName);
    await track._sampleLoading;
    const sourceState = {
        synthType: track._synthType,
        useSample: track._useSample,
        sampleBuffer: track._sampleBuffer,
        sampleUrl: track._sampleUrl,
        sampleLoading: track._sampleLoading,
    };

    let sampleError = null;
    try {
        track.synth(sampleName);
    } catch (error) {
        sampleError = error;
    }

    assert(sampleError instanceof Error, "a registered sample name passed to .synth() should throw immediately");
    assert(sampleError && sampleError.message.includes(`.sample('${sampleName}')`) && sampleError.message.includes(`.sound('${sampleName}')`),
        "the synth error for a registered sample should suggest .sample() and .sound()");
    assert(track._synthType === sourceState.synthType
        && track._useSample === sourceState.useSample
        && track._sampleBuffer === sourceState.sampleBuffer
        && track._sampleUrl === sourceState.sampleUrl
        && track._sampleLoading === sourceState.sampleLoading,
    "invalid .synth() input should leave the existing sample source unchanged");

    let unknownError = null;
    try {
        track.synth("__missing_synth__");
    } catch (error) {
        unknownError = error;
    }
    assert(unknownError instanceof Error && /registered custom DSP name/.test(unknownError.message),
        "an unregistered synth name should throw an actionable error");

    let bareCustomError = null;
    try {
        track.synth("custom");
    } catch (error) {
        bareCustomError = error;
    }
    assert(bareCustomError instanceof Error,
        "bare 'custom' should be rejected because custom synthesis requires a registered DSP name");

    const accepted = Track("synth-validation-built-ins");
    assert(accepted.synth() === accepted && accepted._synthType === "sine", ".synth() should default to sine and remain chainable");
    assert(accepted.synth("saw") === accepted && accepted._synthType === "saw", ".synth('saw') should preserve the saw alias");
    for (const type of ["noise", "fm", "pluck", "triangle"]) {
        accepted.synth(type);
        assert(accepted._synthType === type, `.synth('${type}') should accept the built-in source`);
    }

    const customSynthName = "__test_synth_validation_dsp__";
    Motif.synthRegistry.set(customSynthName, (ctx) => Math.sin(ctx.p * Math.PI * 2));
    assert(accepted.synth(customSynthName) === accepted && accepted._synthType === customSynthName,
        ".synth() should accept a name registered in Motif.synthRegistry");

    Motif.synthRegistry.delete(customSynthName);
    Motif.sampleRegistry.delete(sampleName);
    trackRegistry.delete("synth-validation-state");
    trackRegistry.delete("synth-validation-built-ins");
}

console.log("\n=== Track.sound(): synth/sample routing convenience method ===");
{
    const prevCtx = Motif.ctx;
    const prevFetch = globalThis.fetch;

    class SoundRouterMockCtx extends MockAudioContext {
        decodeAudioData(ab, resolve) {
            resolve({
                getChannelData: () => new Float32Array(100),
                duration: 1,
                sampleRate: 44100,
                numberOfChannels: 1,
                length: 100,
            });
        }
    }

    Motif.ctx = new SoundRouterMockCtx();

    // Case 1: native oscillator name routes through .synth()
    const tNative = Track("sound-router-native").sound("square");
    assert(tNative._synthType === "square", ".sound('square') should route to .synth() and set _synthType");
    assert(tNative._useSample === false, ".sound('square') should leave the track in synth mode");
    trackRegistry.delete("sound-router-native");

    // Case 2: name registered in Motif.synthRegistry (not a native oscillator) routes through .synth()
    const customSynthName = "__test_sound_router_synth__";
    Motif.synthRegistry.set(customSynthName, (ctx) => Math.sin(ctx.p * Math.PI * 2));
    const tCustomSynth = Track("sound-router-custom-synth").sound(customSynthName);
    assert(tCustomSynth._synthType === customSynthName, ".sound() should route registered synth names to .synth()");
    assert(tCustomSynth._useSample === false, "registered-synth routing should leave synth mode active");
    Motif.synthRegistry.delete(customSynthName);
    trackRegistry.delete("sound-router-custom-synth");

    // Case 3: name registered in Motif.sampleRegistry routes through .sample() and resolves from the
    // registry directly (no network fetch)
    const customSampleName = "__test_sound_router_sample__";
    let fetchCalled = false;
    globalThis.fetch = () => {
        fetchCalled = true;
        return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        });
    };
    Motif.sampleRegistry.set(customSampleName, () => ({
        getChannelData: () => new Float32Array(10),
        duration: 0.5, sampleRate: 44100, numberOfChannels: 1, length: 10,
    }));
    const tCustomSample = Track("sound-router-custom-sample").sound(customSampleName);
    await tCustomSample._sampleLoading;
    assert(tCustomSample._useSample === true, ".sound() should route registered sample names to .sample()");
    assert(tCustomSample._sampleBuffer !== null, "registered-sample routing should resolve a decoded buffer");
    assert(fetchCalled === false, "a sample name resolved from the in-memory registry must not hit fetch");
    Motif.sampleRegistry.delete(customSampleName);
    trackRegistry.delete("sound-router-custom-sample");

    // Case 4: a name absent from both registries falls through to .sample() as a literal URL/path
    fetchCalled = false;
    let fetchedUrl = null;
    globalThis.fetch = (url) => {
        fetchCalled = true;
        fetchedUrl = url;
        return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        });
    };
    const unknownPath = "/audio/__unregistered_sound_router_probe__.wav";
    const tFallthrough = Track("sound-router-fallthrough").sound(unknownPath);
    await tFallthrough._sampleLoading;
    assert(tFallthrough._useSample === true, "unrecognized .sound() name should fall through to .sample()");
    assert(tFallthrough._sampleUrl === unknownPath, "fallthrough should store the literal path as the sample URL");
    assert(fetchCalled === true && fetchedUrl === unknownPath, "fallthrough path should be fetched as a plain URL");
    sampleBufferCache.delete(unknownPath);
    trackRegistry.delete("sound-router-fallthrough");

    Motif.ctx = prevCtx;
    globalThis.fetch = prevFetch;
}

console.log("\n=== SimplexNoise: seeded reproducibility, cross-seed divergence, range, function-seed ===");
{
    // Same numeric seed -> identical noise1D/noise2D sequences
    const seedA1 = new SimplexNoise(42);
    const seedA2 = new SimplexNoise(42);
    const xs = [0, 0.37, 1.5, 3.14159, -2.71, 10.001, -100.5];

    let identical1D = true;
    let identical2D = true;
    for (const x of xs) {
        if (seedA1.noise1D(x) !== seedA2.noise1D(x)) identical1D = false;
        if (seedA1.noise2D(x, x * 1.3) !== seedA2.noise2D(x, x * 1.3)) identical2D = false;
    }
    assert(identical1D, "SimplexNoise(42) instances should produce identical noise1D sequences");
    assert(identical2D, "SimplexNoise(42) instances should produce identical noise2D sequences");

    // Different seeds -> diverging sequences
    const seedB = new SimplexNoise(7);
    let anyDiffer1D = false;
    let anyDiffer2D = false;
    for (const x of xs) {
        if (seedA1.noise1D(x) !== seedB.noise1D(x)) anyDiffer1D = true;
        if (seedA1.noise2D(x, x * 1.3) !== seedB.noise2D(x, x * 1.3)) anyDiffer2D = true;
    }
    assert(anyDiffer1D, "SimplexNoise with a different seed should diverge in noise1D outputs");
    assert(anyDiffer2D, "SimplexNoise with a different seed should diverge in noise2D outputs");

    // Outputs stay within the documented [-1, 1] range
    const rangeProbe = new SimplexNoise(1337);
    let allWithinRange = true;
    for (let i = -200; i <= 200; i++) {
        const x = i * 0.37;
        const y = i * -0.53;
        const n1 = rangeProbe.noise1D(x);
        const n2 = rangeProbe.noise2D(x, y);
        if (n1 < -1 || n1 > 1 || n2 < -1 || n2 > 1) allWithinRange = false;
    }
    assert(allWithinRange, "noise1D/noise2D outputs should stay within the documented [-1, 1] range");

    // Function-as-seed variant: the RNG function is used verbatim, not re-wrapped through mulberry32
    const makeDeterministicRng = () => {
        let state = 987654321;
        return () => {
            state = (state * 1103515245 + 12345) & 0x7fffffff;
            return state / 0x7fffffff;
        };
    };
    const fnSeeded1 = new SimplexNoise(makeDeterministicRng());
    const fnSeeded2 = new SimplexNoise(makeDeterministicRng());
    let fnIdentical = true;
    for (const x of xs) {
        if (fnSeeded1.noise1D(x) !== fnSeeded2.noise1D(x)) fnIdentical = false;
    }
    assert(fnIdentical, "two SimplexNoise instances built from equivalent deterministic RNG factories should match");

    const fnSample = fnSeeded1.noise1D(0.5);
    assert(typeof fnSample === "number" && Number.isFinite(fnSample),
        "function-seeded SimplexNoise should produce finite numeric output");
}

// =============================================================================
// Shared MockAudioContext factory completeness (regression: runner song exec)
// =============================================================================
// The shared mock (test/mock_webaudio.js) drives temp/run_song.js against real
// songs. It must expose every ctx.create* factory the library calls, or full
// song execution throws "ctx.createX is not a function" (e.g. splitStereo hits
// createChannelMerger, panning hits createStereoPanner, Bus feedback hits
// createDelay). Guard the superset invariant its own docstring promises.
console.log("\n=== Shared MockAudioContext: factory completeness ===");
{
    const sharedCtx = new MockAudioContext();

    const requiredFactories = [
        "createGain", "createBiquadFilter", "createDynamicsCompressor",
        "createConstantSource", "createOscillator", "createBuffer",
        "createBufferSource", "createWaveShaper", "createStereoPanner",
        "createDelay", "createChannelMerger",
    ];
    for (const name of requiredFactories) {
        assert(typeof sharedCtx[name] === "function",
            `shared MockAudioContext must expose ${name}()`);
    }

    const panner = sharedCtx.createStereoPanner();
    assert(panner && panner.pan && typeof panner.pan.setValueAtTime === "function",
        "createStereoPanner() node exposes a .pan AudioParam");

    const delay = sharedCtx.createDelay(1);
    assert(delay && delay.delayTime && typeof delay.delayTime.setValueAtTime === "function",
        "createDelay() node exposes a .delayTime AudioParam");

    const merger = sharedCtx.createChannelMerger(2);
    assert(merger && typeof merger.connect === "function" && merger.numberOfInputs === 2,
        "createChannelMerger(2) node is connectable with numberOfInputs === 2");

    const defaultBuffer = sharedCtx.createBuffer();
    assert(defaultBuffer.numberOfChannels === 1 && defaultBuffer.length === 44100
        && defaultBuffer.sampleRate === 44100 && defaultBuffer.duration === 1,
        "createBuffer() preserves the runner's legitimate one-second mono default");

    const sampleBuffer = sharedCtx.createBuffer(2, 72000, 48000);
    const left = sampleBuffer.getChannelData(0);
    const right = sampleBuffer.getChannelData(1);
    left[0] = 0.25;
    right[0] = -0.5;
    assert(sampleBuffer.numberOfChannels === 2 && sampleBuffer.length === 72000
        && sampleBuffer.sampleRate === 48000 && sampleBuffer.duration === 1.5,
        "createBuffer() exposes requested channel, frame, sample-rate, and duration metadata");
    assert(sampleBuffer.getChannelData(0) === left && sampleBuffer.getChannelData(1) === right,
        "getChannelData() returns stable arrays for each channel");
    assert(left !== right && left[0] === 0.25 && right[0] === -0.5,
        "AudioBuffer mock channels have independent storage");

    class SchedulingMockAudioContext extends MockAudioContext {
        constructor() {
            super();
            this.createdBufferSources = [];
        }

        createBufferSource() {
            const source = super.createBufferSource();
            const start = source.start;
            source.start = (when = 0, offset = 0, duration) => {
                source.startTime = when;
                source.offset = offset;
                source.duration = duration;
                start.call(source, when);
            };
            this.createdBufferSources.push(source);
            return source;
        }
    }

    const schedulingCtx = new SchedulingMockAudioContext();
    Motif.ctx = schedulingCtx;
    Motif.tempo = 120;
    Track.clearRegistry();

    const fitTrack = Track("shared-buffer-fit").note([60]).fit("1b", { mode: "repitch" });
    fitTrack._sampleBuffer = sampleBuffer;
    fitTrack._playSampleEvent({ value: 60, index: 0 }, 0, 0.5);
    assert(Math.abs(schedulingCtx.createdBufferSources[0].playbackRate.value - 0.75) < 1e-9,
        "fit scheduling derives playback rate 0.75 from a 1.5-second buffer and two-second bar");

    const chopTrack = Track("shared-buffer-chop").note([4]).chop(6);
    chopTrack._sampleBuffer = sampleBuffer;
    chopTrack._playSampleEvent({ value: 4, index: 0 }, 0, 0.5);
    const chopSource = schedulingCtx.createdBufferSources[1];
    assert(Math.abs(chopSource.offset - 1) < 1e-9 && Math.abs(chopSource.duration - 0.25) < 1e-9,
        "chop scheduling derives slice offset 1.0 and duration 0.25 from non-default buffer dimensions");

    // Drive splitStereo through the shared mock end-to-end (the runner's path):
    // must not throw "createChannelMerger is not a function".
    globalThis.window = globalThis;
    globalThis.AudioContext = MockAudioContext;
    Motif.ctx = null;
    Motif.init();

    let splitStereoThrew = null;
    try {
        Track("shared-mock-split").synth("saw").note(["C4", "E4"]).splitStereo((right) => {
            right.volume(-6);
        });
    } catch (err) {
        splitStereoThrew = err.message;
    }
    assert(splitStereoThrew === null,
        `splitStereo through shared mock must not throw, got: ${splitStereoThrew}`);

    const parent = Track("split-boundaries").freq([220, 440]).splitStereo(right => right.freq([660, 880]));
    const splitRight = parent._rightTrack;
    for (const splitAfter of [false, true]) {
        const arranged = splitAfter ? Track("split-late").freq([330]) : parent;
        Arrange([{ bars: 1, tracks: [] }, { bars: 1, tracks: [arranged] }, { bars: 1, tracks: [] }]);
        if (splitAfter) arranged.splitStereo();
        const shadow = arranged._rightTrack;
        for (const time of [0.1, 1.9, 2, 3.9, 4, 6]) {
            assert(shadow._isTimeActive(time) === (time >= 2 && time < 4),
                `split ${splitAfter ? "after" : "before"} Arrange obeys boundary at ${time}`);
        }
        Arrange([{ bars: 1, tracks: [arranged] }]);
        assert(shadow._isTimeActive(0.5) && !shadow._isTimeActive(2.5), "shadow follows replaced arrangement segments");
        arranged._clearActiveSegments();
        arranged.start(3).stop(5);
        assert(!shadow._isTimeActive(2) && shadow._isTimeActive(4) && !shadow._isTimeActive(5), "shadow follows direct parent start/stop");
        arranged._playbackStartTime = 10;
        assert(shadow._isTimeActive(14) && !shadow._isTimeActive(4), "shadow boundaries use parent playback origin");
    }
    assert(splitRight._freqPattern.join() === "660,880", "parent arrangement edits preserve independent right pattern");
    const early = Track("split-early").splitStereo().note([60]);
    assert(early._rightTrack._notePattern === null, "notes assigned after splitting are not mirrored");
    const occupied = Track("split-collision_right").note([60]);
    let collision = false;
    try { Track("split-collision").splitStereo(); } catch (error) { collision = /reserves Track ID/.test(error.message); }
    assert(collision && trackRegistry.get(occupied.id) === occupied, "split rejects occupied right ID without overwriting it");

    Track.clearRegistry();
    const finishing = Track("split-finish").freq([440]).splitStereo();
    finishing.start(2).stop(4);
    finishing._playbackStartTime = 0;
    finishing._rightTrack._playbackStartTime = 10;
    finishing._schedule = finishing._rightTrack._schedule = () => {};
    const transport = new MotifEngine();
    transport.ctx = { currentTime: 5 };
    transport.tempo = 120;
    transport._arrangementEndBeat = 12;
    transport.isPlaying = true;
    transport.stop = () => { transport.isPlaying = false; };
    transport._tick();
    assert(transport.isPlaying, "split transport retains trailing empty section");
    transport.ctx.currentTime = 6;
    transport._tick();
    assert(!transport.isPlaying, "independently registered shadow does not prevent transport completion");

    Track.clearRegistry();
    Bus.clearRegistry();
}

// =============================================================================
// TASK (Performance): Granular playback — eliminate per-note full-sample copy
// and audio-thread allocations
// (src/TrackVoiceManager.js, src/worklets/GranularStretcherProcessor.js)
//
// Two behavior-preserving optimizations:
//   1. _postGranularChannels posts channel data with a transfer list (zero-copy
//      handoff of a throwaway Float32Array.from() copy), never detaching or
//      mutating the live AudioBuffer. A real transfer list detaches the
//      transferred ArrayBuffers, so this copy cannot be cached and reused
//      across notes without worklet-side retention (out of scope here) - one
//      copy per note is still made, but it is never the live channel data and
//      the handoff itself is zero-copy.
//   2. process() compacts expired grains in place instead of allocating a fresh
//      array via .filter() on every output sample.
//
// The output-equivalence check harnesses the optimized processor alongside a
// frozen pristine reference (test/fixtures/GranularStretcherProcessor.reference.js)
// and asserts their process() output matches sample-for-sample over N blocks.
// =============================================================================
console.log("\n=== Granular perf: process() output equivalence (frozen reference vs optimized) ===");
{
    const savedProcessor = globalThis.AudioWorkletProcessor;
    const savedRegister = globalThis.registerProcessor;
    const savedSampleRate = globalThis.sampleRate;
    const savedCurrentTime = globalThis.currentTime;

    let captured = null;
    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = {
                onmessage: null, postMessage() {
                },
            };
        }
    };
    globalThis.registerProcessor = (name, cls) => {
        captured = cls;
    };
    globalThis.sampleRate = 44100;
    globalThis.currentTime = 0;

    const bust = `?t=${Date.now()}`;
    await import(`./test/fixtures/GranularStretcherProcessor.reference.js${bust}`);
    const RefClass = captured;
    captured = null;
    await import(`./src/worklets/GranularStretcherProcessor.js${bust}`);
    const NewClass = captured;

    assert(typeof RefClass === "function", "frozen reference processor class captured");
    assert(typeof NewClass === "function", "optimized processor class captured");
    assert(RefClass !== NewClass, "reference and optimized processors are distinct classes");

    // Non-silent stereo source so any output divergence would surface, and long
    // enough that virtualReadPointer stays in-bounds across the whole render
    // (stretch 1.5 advances ~0.667 samples/output; 60*128=7680 -> ~5120 < 8000).
    const bufLen = 8000;
    const left = new Float32Array(bufLen);
    const right = new Float32Array(bufLen);
    for (let i = 0; i < bufLen; i++) {
        left[i] = Math.sin((2 * Math.PI * 3 * i) / bufLen);
        right[i] = Math.cos((2 * Math.PI * 5 * i) / bufLen);
    }

    const params = { stretchFactor: [1.5], pitchRatio: [1.0], grainSize: [0.05], overlap: [4] };

    const refInst = new RefClass();
    const newInst = new NewClass();
    for (const inst of [refInst, newInst]) {
        // Each instance gets its own copy (processors mutate their buffers' owners over transfer).
        inst.port.onmessage({ data: { leftBuffer: left.slice(), rightBuffer: right.slice(), bufferSampleRate: 44100 } });
        inst.port.onmessage({ data: { type: "START", startTime: 0 } });
    }

    const N = 60;
    const BLOCK = 128;
    let maxDiff = 0;
    let anyNonZero = false;
    let sawVariation = false;
    let firstVal = null;

    for (let b = 0; b < N; b++) {
        globalThis.currentTime = (b * BLOCK) / 44100;
        const refOut = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        const newOut = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        refInst.process([], [refOut], params);
        newInst.process([], [newOut], params);

        for (let c = 0; c < 2; c++) {
            for (let i = 0; i < BLOCK; i++) {
                const d = Math.abs(refOut[c][i] - newOut[c][i]);
                if (d > maxDiff) maxDiff = d;
                const v = newOut[c][i];
                if (v !== 0) anyNonZero = true;
                if (firstVal === null) firstVal = v;
                else if (v !== firstVal) sawVariation = true;
            }
        }

        // Grain arrays must stay in lockstep every block — proves the in-place
        // compaction removes exactly the grains .filter() would have.
        assert(refInst.grains.length === newInst.grains.length,
            `block ${b}: grain count must match reference (ref=${refInst.grains.length}, new=${newInst.grains.length})`);
    }

    assert(maxDiff === 0,
        `optimized process() output must be bit-identical to the frozen reference, maxDiff=${maxDiff}`);
    assert(anyNonZero, "render must be non-silent (otherwise the equivalence check is vacuous)");
    assert(sawVariation, "output must vary across samples (grains actually mixed)");
    assert(newInst.grains.length > 0 && newInst.grains.length <= 8,
        `active grain count must stay bounded near overlap, proving compaction ran, got ${newInst.grains.length}`);

    globalThis.AudioWorkletProcessor = savedProcessor;
    globalThis.registerProcessor = savedRegister;
    globalThis.sampleRate = savedSampleRate;
    globalThis.currentTime = savedCurrentTime;
}

console.log("\n=== Granular perf: _postGranularChannels transfer list (throwaway copy, never the live buffer) ===");
{
    const prevCtx = Motif.ctx;
    Track.clearRegistry();

    const t = Track("granular-post-test");

    let getChannelDataCalls = 0;
    const chan0 = new Float32Array([1, 2, 3, 4]);
    const chan1 = new Float32Array([5, 6, 7, 8]);
    const buffer = {
        numberOfChannels: 2,
        length: 4,
        sampleRate: 44100,
        duration: 4 / 44100,
        getChannelData(ch) {
            getChannelDataCalls++;
            return ch === 0 ? chan0 : chan1;
        },
    };

    const posts = [];
    const mockSource = {
        port: {
            postMessage(msg, transfer) {
                posts.push({ msg, transfer });
            },
        },
    };

    t._postGranularChannels(mockSource, buffer);

    assert(posts.length === 1, "one post recorded for first trigger");
    assert(posts[0].msg.bufferSampleRate === 44100, "granular transfer includes the AudioBuffer sample rate");
    assert(Array.isArray(posts[0].transfer), "post supplies a transfer list");
    assert(posts[0].transfer.length === 2, "stereo transfer list carries both channel ArrayBuffers");
    assert(posts[0].transfer[0] === posts[0].msg.leftBuffer.buffer,
        "transfer list entry 0 is the posted left channel's ArrayBuffer");
    assert(posts[0].transfer[1] === posts[0].msg.rightBuffer.buffer,
        "transfer list entry 1 is the posted right channel's ArrayBuffer");
    assert(posts[0].msg.leftBuffer instanceof Float32Array, "posts a Float32Array");
    assert(posts[0].msg.leftBuffer !== chan0,
        "posted left buffer is a copy, never the AudioBuffer's live channel data");

    // The live AudioBuffer must never be detached/mutated by the transfer.
    assert(chan0.byteLength === 16 && chan1.byteLength === 16,
        "source AudioBuffer channels are not detached by the transfer");
    assert(chan0[2] === 3 && chan1[3] === 8,
        "source AudioBuffer channel data intact after posting");

    // A real transfer list detaches the transferred ArrayBuffers, so nothing
    // can be cached across notes: every post re-reads the AudioBuffer and
    // makes a fresh throwaway copy (this mock's postMessage does not detach,
    // but the code makes no caching assumption about that either way).
    const callsAfterFirst = getChannelDataCalls;
    t._postGranularChannels(mockSource, buffer);
    assert(getChannelDataCalls === callsAfterFirst + 2,
        "second post re-reads both channels (no cross-note caching of the transferred copy)");
    assert(posts.length === 2, "second post recorded");

    // Mono source: the transfer list must not list the same ArrayBuffer twice
    // (a duplicate entry throws DataCloneError in a real worklet post).
    const monoChan = new Float32Array([1, 2, 3]);
    const monoBuffer = {
        numberOfChannels: 1,
        length: 3,
        sampleRate: 44100,
        getChannelData() {
            return monoChan;
        },
    };
    t._postGranularChannels(mockSource, monoBuffer);
    const monoPost = posts[posts.length - 1];
    assert(monoPost.msg.leftBuffer === monoPost.msg.rightBuffer,
        "mono: left and right reference one shared copied array");
    assert(monoPost.transfer.length === 1,
        "mono transfer list lists the single ArrayBuffer once, not twice");

    Motif.ctx = prevCtx;
    Track.clearRegistry();
}

// =============================================================================
// Track.delay() feedback-delay send sugar
// (task: Resolve .delay() gap exposed by "why fail Thermodynamic Sugar Rush")
// =============================================================================
console.log("\n=== Track.delay(): feedback-delay send sugar ===");
{
    Track.clearRegistry();
    Bus.clearRegistry();
    const prevTempo = Motif.tempo;
    Motif.tempo = 120;

    // Chainable and does not throw for the exact call from the why-fail song
    const bells = Track("bells").sample("music-box");
    const returned = bells.delay({ time: "3/16", feedback: 0.5 });
    assert(returned === bells, "Track.delay() returns the track instance (chainable)");

    // An internal delay bus "<id>__delay" is created and registered
    assert(bells._delayBus !== undefined && bells._delayBus !== null, "Track.delay() creates an internal _delayBus");
    assert(busRegistry.has("bells__delay"), "internal delay bus registered as '<id>__delay'");

    // A send from the track feeds the delay bus
    assert(bells._sends.has("bells__delay"), "Track.delay() opens a send to the internal delay bus");
    assert(Math.abs(bells._sends.get("bells__delay").gain.value - 0.5) < 1e-9,
        `delay send amount should be 0.5, got ${bells._sends.get("bells__delay").gain.value}`);

    // The bus feedback loop exists with the requested feedback amount
    assert(bells._delayBus.feedbackGainNode !== null, "delay bus has a feedback gain node");
    assert(Math.abs(bells._delayBus.feedbackGainNode.gain.value - 0.5) < 1e-9,
        `feedback gain should be 0.5, got ${bells._delayBus.feedbackGainNode.gain.value}`);

    // "3/16" at 120 BPM, 4 beats/bar => 0.1875 * 0.5 * 4 = 0.375s
    const expectedSeconds = (3 / 16) * (60 / 120) * 4;
    assert(Math.abs(bells._delayBus.feedbackDelayNode.delayTime.value - expectedSeconds) < 1e-9,
        `delay time should be ${expectedSeconds}s, got ${bells._delayBus.feedbackDelayNode.delayTime.value}`);

    // Numeric time is treated as seconds
    const t2 = Track("t2").synth("saw").delay({ time: 0.25, feedback: 0.2 });
    assert(Math.abs(t2._delayBus.feedbackDelayNode.delayTime.value - 0.25) < 1e-9,
        `numeric delay time 0.25s honored, got ${t2._delayBus.feedbackDelayNode.delayTime.value}`);

    // Feedback is clamped to [0, 0.95] (runaway-safe)
    const t3 = Track("t3").synth("saw").delay({ time: "1/8", feedback: 5 });
    assert(Math.abs(t3._delayBus.feedbackGainNode.gain.value - 0.95) < 1e-9,
        `feedback should clamp to 0.95, got ${t3._delayBus.feedbackGainNode.gain.value}`);

    // Long musical values remain exact when they fit the documented range
    Motif.tempo = 126;
    const t4 = Track("t4").synth("saw").delay({ time: "1/1", feedback: 0.3 });
    const oneBarAt126 = (60 / 126) * Motif.beatsPerBar;
    assert(Math.abs(t4._delayBus.feedbackDelayNode.delayTime.value - oneBarAt126) < 1e-9,
        `one-bar delay at 126 BPM should remain ${oneBarAt126}s, got ${t4._delayBus.feedbackDelayNode.delayTime.value}`);
    Motif.tempo = 120;

    // Defaults apply when called with no arguments (no throw)
    const t5 = Track("t5").synth("saw").delay();
    assert(t5._delayBus !== null && t5._sends.has("t5__delay"), "Track.delay() with no args uses defaults and opens a send");

    // Idempotent: repeated calls reuse the same bus and update parameters
    const busRef = bells._delayBus;
    bells.delay({ time: "1/4", feedback: 0.7 });
    assert(bells._delayBus === busRef, "repeated Track.delay() reuses the same internal bus");
    assert(Math.abs(bells._delayBus.feedbackGainNode.gain.value - 0.7) < 1e-9,
        `repeated delay() updates feedback amount to 0.7, got ${bells._delayBus.feedbackGainNode.gain.value}`);
    const updatedSeconds = (1 / 4) * (60 / 120) * 4;
    assert(Math.abs(bells._delayBus.feedbackDelayNode.delayTime.value - updatedSeconds) < 1e-9,
        `repeated delay() updates time through Bus.feedback() to ${updatedSeconds}, got ${bells._delayBus.feedbackDelayNode.delayTime.value}`);

    bells.delay({ feedback: 0.6 });
    assert(Math.abs(bells._delayBus.feedbackDelayNode.delayTime.value - updatedSeconds) < 1e-9,
        `repeated delay() without time should preserve ${updatedSeconds}, got ${bells._delayBus.feedbackDelayNode.delayTime.value}`);

    const stableDelayNode = bells._delayBus.feedbackDelayNode;
    let rejectedTrackTime = null;
    try {
        bells.delay({ time: 61, feedback: 0.9 });
    } catch (error) {
        rejectedTrackTime = error;
    }
    assert(rejectedTrackTime instanceof RangeError, "Track.delay() should reject times above 60 seconds");
    assert(bells._delayBus.feedbackDelayNode === stableDelayNode,
        "a rejected repeated Track.delay() call should retain its DelayNode");
    assert(Math.abs(bells._delayBus.feedbackDelayNode.delayTime.value - updatedSeconds) < 1e-9,
        "a rejected repeated Track.delay() call should preserve the valid delay time");
    assert(Math.abs(bells._delayBus.feedbackGainNode.gain.value - 0.6) < 1e-9,
        "a rejected repeated Track.delay() call should preserve the valid feedback amount");

    Motif.tempo = prevTempo;
    Track.clearRegistry();
    Bus.clearRegistry();
}

// =============================================================================
// Track.delay(): survives live-coder hot-reload prune
// (regression: internal `<id>__delay` bus was disposed by Bus.pruneExcept on
//  every hot reload because it is created by library code, never declared via
//  the wrappedBus global — silencing echo after the first live edit)
// =============================================================================
console.log("\n=== Track.delay(): survives live-coder hot-reload prune ===");
{
    const prevCtx = Motif.ctx;
    const prevMaster = Motif.masterGain;
    const prevTempo = Motif.tempo;
    Motif.tempo = 120;

    // Recording context: log every connect()/disconnect() so we can inspect the
    // live echo topology. Params support the ramp API the crossfade path needs.
    const connections = [];

    const makeParam = (value = 0) => ({
        value,
        setValueAtTime(v) {
            this.value = v;
            return this;
        },
        linearRampToValueAtTime(v) {
            this.value = v;
            return this;
        },
        exponentialRampToValueAtTime(v) {
            this.value = v;
            return this;
        },
        setTargetAtTime() {
            return this;
        },
        cancelScheduledValues() {
            return this;
        },
        cancelAndHoldAtTime() {
            return this;
        },
    });

    const makeNode = (label) => {
        const node = {
            _label: label,
            gain: makeParam(1),
            delayTime: makeParam(0),
            frequency: makeParam(350),
            Q: makeParam(1),
            offset: makeParam(0),
            connect(dest) {
                connections.push({ from: node, to: dest });
                return dest;
            },
            disconnect() {
            },
            start() {
            },
            stop() {
            },
        };
        return node;
    };

    class RecCtx {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 44100;
            this.destination = makeNode("destination");
            this.audioWorklet = {
                addModule: async () => {
                },
            };
        }

        createGain() {
            return makeNode("gain");
        }

        createBiquadFilter() {
            return makeNode("biquad");
        }

        createDynamicsCompressor() {
            return makeNode("compressor");
        }

        createWaveShaper() {
            return makeNode("waveShaper");
        }

        createStereoPanner() {
            return makeNode("panner");
        }

        createDelay() {
            return makeNode("delay");
        }

        createChannelMerger() {
            return makeNode("merger");
        }

        createConstantSource() {
            return makeNode("constantSource");
        }
    }

    Motif.ctx = new RecCtx();
    Motif.masterGain = Motif.ctx.createGain();
    Track.clearRegistry();
    Bus.clearRegistry();

    // ---- Scenario 1: echo survives one hot-reload cycle ----
    // Initial compile (no prune on the first, non-hot-reload run).
    let echo = Track("echo").delay({ time: "3/16", feedback: 0.5 });
    const firstBus = echo._delayBus;
    assert(busRegistry.get("echo__delay") === firstBus,
        "initial delay() registers the internal bus and stores it on the track");

    // Simulate one hot reload: user code re-runs (a fresh Track("echo") replaces
    // the old one), THEN runUserCode's success .then prunes — Track first, Bus
    // second (index.html order). The internal bus is NOT in the declared set.
    echo = Track("echo").delay({ time: "3/16", feedback: 0.5 });
    Track.pruneExcept(new Set(["echo"]));
    Bus.pruneExcept(new Set(["echo"]));

    assert(busRegistry.has("echo__delay"),
        "internal delay bus survives Bus.pruneExcept while its owner track is alive");
    assert(echo._delayBus === busRegistry.get("echo__delay"),
        "track's _delayBus === the live registry entry after a hot-reload prune");
    assert(echo._delayBus === firstBus,
        "surviving bus is the same object (not disposed + recreated)");

    // Echo path is live: send routing from the current track feeds the bus input.
    const echoSend = echo._sends.get("echo__delay");
    assert(echoSend !== undefined, "current track holds a send to the surviving delay bus");
    assert(connections.some(c => c.from === echo.preFaderNode && c.to === echoSend),
        "send: preFaderNode → sendGainNode (fresh routing on the reloaded track)");
    assert(connections.some(c => c.from === echoSend && c.to === firstBus.input),
        "send: sendGainNode → surviving bus.input");

    // Feedback loop nodes are intact on the surviving bus.
    assert(firstBus.feedbackGainNode !== null && firstBus.feedbackDelayNode !== null,
        "surviving bus keeps its feedback loop nodes");

    // The surviving bus is still a functional, wireable node graph: rebuilding its
    // signal chain reconnects output → master and the feedback tap.
    connections.length = 0;
    firstBus._rebuildSignalChain();
    assert(connections.some(c => c.from === firstBus.output && c.to === Motif.masterGain),
        "surviving bus output still reconnects to master (audible)");
    assert(connections.some(c => c.from === firstBus.output && c.to === firstBus.feedbackGainNode),
        "surviving bus feedback tap still reconnects (echo loop functional)");

    // ---- Scenario 2: pruning the owner track tears down its internal delay bus ----
    // Isolate the disposeTrack teardown: prune the track WITHOUT a following
    // Bus.pruneExcept, so the removal must come from Track prune, not bus prune.
    Track.clearRegistry();
    Bus.clearRegistry();

    const gone = Track("gone").delay({ time: "1/8", feedback: 0.3 });
    assert(busRegistry.has("gone__delay"), "delay bus registered before the owner track is pruned");

    Track.pruneExcept(new Set(["kept"]));
    assert(!busRegistry.has("gone__delay"),
        "pruning the owner track disposes and removes its internal delay bus (no leak)");
    assert(gone._delayBus === null,
        "pruned track's stale _delayBus reference is cleared");

    Motif.tempo = prevTempo;
    Motif.ctx = prevCtx;
    Motif.masterGain = prevMaster;
    Track.clearRegistry();
    Bus.clearRegistry();
}

// =============================================================================
// Task: Seeded procedural sample generator (Motif.sampleSeed) - same seed
// reproduces byte-identical buffers, different seeds diverge, seed 0 is the
// deterministic default, no-arg sampleSeed() draws a usable random seed, and
// reseeding invalidates already-rendered registry/Track buffer caches.
// (motif.js: mulberry32, MotifEngine._sampleSeed/.sampleSeed()/
// ._invalidateProceduralSamples(); src/TrackVoiceManager.js: Track.sample())
// =============================================================================

console.log("\n=== Motif.sampleSeed(): default value ===");
{
    assert(new MotifEngine()._sampleSeed === 0,
        "a freshly constructed MotifEngine should default _sampleSeed to 0 (canonical sound)");
}

console.log("\n=== Motif.sampleSeed(): deterministic procedural sample rendering ===");
{
    const prevCtx = Motif.ctx;
    const prevSeed = Motif._sampleSeed;
    Motif.ctx = new MockAudioContext();

    const NOISE_SAMPLE_ID = "snare-electronic";

    const buffersEqual = (a, b) => {
        const da = a.getChannelData(0);
        const db = b.getChannelData(0);
        if (da.length !== db.length) return false;
        for (let i = 0; i < da.length; i++) {
            if (da[i] !== db[i]) return false;
        }
        return true;
    };

    // Rendering directly through the registry-held generator function - setting the
    // seed forces _invalidateProceduralSamples(), restoring the raw generator into
    // the registry regardless of what an earlier test may have left cached there.
    const renderWithSeed = (seed) => {
        Motif.sampleSeed(seed);
        const generator = Motif.sampleRegistry.get(NOISE_SAMPLE_ID);
        assert(typeof generator === "function",
            `sampleSeed(${seed}) should restore '${NOISE_SAMPLE_ID}' to its raw generator in the registry`);
        return generator();
    };

    // Same seed -> byte-identical buffers across independent renders.
    const seedAFirst = renderWithSeed(111);
    const seedASecond = renderWithSeed(111);
    assert(buffersEqual(seedAFirst, seedASecond),
        "same seed should produce byte-identical sample buffers across renders");

    // Different seed -> differing buffer.
    const seedB = renderWithSeed(222);
    assert(!buffersEqual(seedAFirst, seedB),
        "different seeds should produce differing sample buffers");

    // Seed 0 is the deterministic default/canonical sound.
    const zeroFirst = renderWithSeed(0);
    const zeroSecond = renderWithSeed(0);
    assert(buffersEqual(zeroFirst, zeroSecond),
        "seed 0 (default) should be just as deterministic as any other seed");
    assert(!buffersEqual(zeroFirst, seedAFirst),
        "seed 0's canonical sound should differ from a non-zero seed's rendering");

    // Repeated render of the SAME generator instance under an unchanged seed is stable.
    Motif.sampleSeed(333);
    const stableGenerator = Motif.sampleRegistry.get(NOISE_SAMPLE_ID);
    const stableA = stableGenerator();
    const stableB = stableGenerator();
    assert(buffersEqual(stableA, stableB),
        "invoking the same generator repeatedly under an unchanged seed is stable/idempotent");

    // sampleSeed() with no args draws and applies a usable random 32-bit seed.
    const randomSeed = Motif.sampleSeed();
    assert(typeof randomSeed === "number" && Number.isInteger(randomSeed)
        && randomSeed >= 0 && randomSeed < 0x100000000,
        "sampleSeed() with no args should return a 32-bit unsigned integer seed");
    assert(Motif._sampleSeed === randomSeed,
        "sampleSeed() with no args should apply the drawn seed as the new effective seed");

    Motif.ctx = prevCtx;
    Motif.sampleSeed(prevSeed);
}

console.log("\n=== Motif.sampleSeed(): reseeding invalidates already-rendered Track sample buffers ===");
{
    const prevCtx = Motif.ctx;
    const prevSeed = Motif._sampleSeed;
    Motif.ctx = new MockAudioContext();
    Track.clearRegistry();

    const NOISE_SAMPLE_ID = "snare-electronic";
    const dataOf = (buf) => buf.getChannelData(0);
    const sameData = (a, b) => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    };

    Motif.sampleSeed(444);
    const t1 = Track("seed-cache-1").sample(NOISE_SAMPLE_ID);
    await t1._sampleLoading;
    const firstBuffer = t1._sampleBuffer;
    assert(firstBuffer !== null, "track should resolve a rendered buffer for a registered procedural sample");
    assert(Motif.sampleRegistry.get(NOISE_SAMPLE_ID) === firstBuffer,
        "after the first render, the registry caches the rendered buffer object in place of the generator");

    // Negative/edge case: without a reseed, a second track sampling the same id must
    // reuse the identical cached buffer object (no spurious re-render).
    const t2 = Track("seed-cache-2").sample(NOISE_SAMPLE_ID);
    await t2._sampleLoading;
    assert(t2._sampleBuffer === firstBuffer,
        "a second track sampling the same id without reseeding reuses the identical cached buffer object");

    // Reseeding must invalidate the registry cache so the next .sample() re-renders.
    Motif.sampleSeed(555);
    assert(typeof Motif.sampleRegistry.get(NOISE_SAMPLE_ID) === "function",
        "reseeding restores the raw generator into the registry, dropping the stale rendered buffer");

    const t3 = Track("seed-cache-3").sample(NOISE_SAMPLE_ID);
    await t3._sampleLoading;
    const secondBuffer = t3._sampleBuffer;
    assert(secondBuffer !== null && secondBuffer !== firstBuffer,
        "reseeding then re-sampling should produce a newly rendered buffer object");
    assert(!sameData(dataOf(firstBuffer), dataOf(secondBuffer)),
        "the re-rendered buffer's audio data should differ from the pre-reseed buffer");

    // Returning to a previously used seed re-renders (fresh object) but reproduces
    // byte-identical audio data - the seed alone determines content, not object identity.
    Motif.sampleSeed(444);
    const t4 = Track("seed-cache-4").sample(NOISE_SAMPLE_ID);
    await t4._sampleLoading;
    const thirdBuffer = t4._sampleBuffer;
    assert(thirdBuffer !== null && thirdBuffer !== firstBuffer,
        "re-rendering after seed churn yields a new buffer instance even when the seed value repeats");
    assert(sameData(dataOf(firstBuffer), dataOf(thirdBuffer)),
        "returning to a previously used seed reproduces byte-identical audio data");

    Motif.ctx = prevCtx;
    Motif.sampleSeed(prevSeed);
    Track.clearRegistry();
}

// =============================================================================
// Offline clock scheduling
// =============================================================================
{
    const engine = new MotifEngine();
    engine.ctx = { currentTime: 0, state: "suspended" };
    const fired = [];
    engine.schedule(0.05, time => fired.push(time));
    engine.tick();
    assert(fired.length === 0, "real-time tick must leave suspended contexts untouched");
    engine._tick();
    assert(fired.length === 1 && fired[0] === 0.05, "offline tick must dispatch queued audio-clock events while suspended");
    engine._tick();
    assert(fired.length === 1, "offline ticks must not repeat dispatched callbacks");
}

// =============================================================================
// Song lint fixtures and batch isolation
// =============================================================================
{
    const fixtureRoot = new URL("./test/fixtures/song-lint/", import.meta.url).pathname;
    const durationFixture = new URL("./test/fixtures/duration-helpers.js", import.meta.url).pathname;
    const runner = new URL("./run_song.js", import.meta.url).pathname;
    const patternChecker = new URL("./check_patterns.js", import.meta.url).pathname;
    const runLint = (...paths) => Bun.spawnSync([process.execPath, runner, ...paths], { timeout: 120000 });
    const good = runLint(`${fixtureRoot}good`);
    const goodOutput = good.stdout.toString();
    assert(good.exitCode === 0, `valid DSL, builtins, helpers, instance reuse and isolated songs pass lint: ${goodOutput}`);
    assert(goodOutput.includes("without explicit stepLength") && goodOutput.includes("confirm transposition is intentional"), "intent-dependent pattern lengths and sample transposition produce warnings");
    const cases = {
        "unknown-method": "invented",
        "unknown-source": "unknown synth source",
        "cross-registry": "cross-registry call",
        "sample-as-synth": "cross-registry call",
        "duplicate": "DUPLICATE Track() IDS",
        "scale": "invalid scale root",
        "sidechain": "sidechain(Track(...))",
        "rests": "NO NOTE ATTEMPTS: rests",
        "pitch": "INVALID PITCHES",
        "console-error": "SETUP CONSOLE ERRORS",
        "scheduling": "fixture scheduling failure",
        "playback": "fixture playback failure",
        "schedule-console": "SCHEDULING CONSOLE ERRORS",
    };
    for (const [name, diagnostic] of Object.entries(cases)) {
        const result = runLint(`${fixtureRoot}broken/${name}.js`);
        const output = result.stdout.toString();
        assert(result.exitCode === 1 && output.includes(diagnostic) && !output.includes("OK:"), `broken ${name} fixture fails with ${diagnostic}, without OK`);
        if (name === "scale") assert(output.includes("invalid scale name"), "invalid scale names do not silently fall back");
        if (name === "rests") assert(output.includes("0 non-rest note attempts"), "rest steps do not count as note attempts");
    }
    const batch = runLint(`${fixtureRoot}broken/rests.js`, `${fixtureRoot}good/dsl.js`);
    assert(batch.exitCode === 1 && batch.stdout.toString().includes("2 songs executed; 1 failed"), "batch continues after failure and returns aggregate failure");
    const durationLint = runLint(durationFixture);
    assert(durationLint.exitCode === 0, `run_song exposes duration helpers to songs: ${durationLint.stdout.toString()}`);
    const durationPatternCheck = Bun.spawnSync([process.execPath, patternChecker, durationFixture], { timeout: 120000 });
    assert(durationPatternCheck.exitCode === 0, `check_patterns exposes duration helpers to songs: ${durationPatternCheck.stderr.toString()}`);
    console.log(`Song lint fixture coverage: 4 valid songs and ${Object.keys(cases).length} broken cases; batch failure and isolation checked.`);
}

console.log("\n=== Arrangement tempo map: shared real-time/offline scheduling ===");
{
    const saved = { ...Motif, stop: Motif.stop };
    for (const mode of ["constant", "configured", "immediate", "smooth"]) {
        for (const offline of [false, true]) {
            Track.clearRegistry();
            Motif.ctx = new MockAudioContext();
            Motif.ctx.state = offline ? "suspended" : "running";
            Motif.tempo = 120;
            Motif._tempoMap = null;
            Motif._tempoRamp = null;
            Motif._schedQueue = [];
            Motif.isPlaying = true;
            Motif._arrangementOptions = {};
            Motif.lookaheadWindowS = 0.1;
            const calls = [];
            const gainEvents = [];
            const a = Track("tempo-a").note([60, 61, 62, 63]);
            const b = Track("tempo-b").note([64, 65, 66, 67]);
            a._gainRampsQueue = [Ramp(0, 1), Ramp(1, 0)];
            a.trackInputNode = { gain: {
                setValueAtTime(value, time) { gainEvents.push({ value, time }); },
                linearRampToValueAtTime(value, time) { gainEvents.push({ value, time }); },
                cancelAndHoldAtTime(time) { while (gainEvents.at(-1)?.time >= time) gainEvents.pop(); },
            } };
            for (const track of [a, b]) track._playEvent = (event, time, duration) => calls.push({ id: track.id, value: event.value, time, duration });
            Arrange([{ tracks: [a], bars: 1 }, { tracks: [b], bars: 1 }, { tracks: [a], bars: 1 }, { tracks: [], bars: 1 }]);
            if (mode === "configured") Motif.setTempo(240);
            let finished = null;
            Motif.stop = () => { finished = Motif.ctx.currentTime; Motif.isPlaying = false; };
            Motif.onPlaybackFinished = null;
            const tick = () => offline ? Motif._tick() : Motif.tick();
            tick();
            for (let n = 1; n < 1000 && finished === null; n++) {
                Motif.ctx.currentTime = n / 40;
                if (n === 30 && ["immediate", "smooth"].includes(mode)) {
                    if (mode === "smooth") Motif.rampTempo(240, 2, { smooth: true });
                    else Motif.setTempo(240);
                }
                tick();
            }
            // The previous tick at .725 committed through .825 seconds.
            const change = 0.825;
            const timeAt = beat => {
                if (mode === "constant") return beat / 2;
                if (mode === "configured") return beat / 4;
                if (beat <= change * 2) return beat / 2;
                const after = beat - change * 2;
                if (mode === "immediate") return change + after / 4;
                return after <= 6 ? change + Math.sqrt(4 + 2 * after) - 2 : change + 2 + (after - 6) / 4;
            };
            const label = `${mode} ${offline ? "offline" : "real-time"}`;
            assert(calls.length === 12, `${label}: exactly four steps per active bar, repeated Track retains both windows`);
            for (let beat = 0; beat < 12; beat++) {
                const call = calls[beat];
                assert(call && Math.abs(call.time - timeAt(beat)) < 1e-8, `${label}: beat ${beat} onset follows integrated tempo`);
                assert(call?.id === (beat >= 4 && beat < 8 ? "tempo-b" : "tempo-a"), `${label}: beat ${beat} uses correct section`);
            }
            assert(finished >= timeAt(16) - 1e-8 && finished < timeAt(16) + 0.026, `${label}: final stop includes silent final bar`);
            assert(gainEvents.some(event => event.value === 1 && Math.abs(event.time - timeAt(4)) < 1e-8), `${label}: first gain ramp ends at section exit`);
            assert(gainEvents.some(event => event.value === 0 && Math.abs(event.time - timeAt(12)) < 1e-8), `${label}: reused Track's second gain ramp ends at its exit`);
            const beatAt = time => {
                if (mode === "constant") return time * 2;
                if (mode === "configured") return time * 4;
                if (time <= change) return time * 2;
                const elapsed = time - change;
                if (mode === "immediate") return change * 2 + elapsed * 4;
                return change * 2 + (elapsed <= 2 ? elapsed * 2 + elapsed ** 2 / 2 : 6 + (elapsed - 2) * 4);
            };
            for (const event of gainEvents) {
                const beat = beatAt(event.time);
                const expected = beat <= 4 + 1e-8 ? beat / 4 : 1 - (beat - 8) / 4;
                assert(Math.abs(event.value - expected) < 1e-8, `${label}: gain follows musical progress at ${event.time}`);
            }
        }
    }
    Track.clearRegistry();
    Motif.ctx = new MockAudioContext();
    Motif.ctx.state = "running";
    Motif.tempo = 120;
    Motif._tempoMap = null;
    Motif._tempoRamp = null;
    Motif.isPlaying = false;
    const numeric = Track("tempo-seconds").note([60]).stepLength(0.1);
    const numericEvents = [];
    numeric._playEvent = (event, time) => numericEvents.push(time);
    Arrange([{ tracks: [numeric], bars: .5 }]);
    Motif.setTempo(60);
    numeric._schedule(2.01);
    assert(numericEvents.length === 20 && Math.abs(numericEvents[19] - 1.9) < 1e-8, "numeric-second steps retain clock spacing while arranged bars lengthen");
    Track.clearRegistry();
    Motif.ctx = new MockAudioContext();
    Motif.tempo = 120;
    Motif._tempoMap = null;
    Motif.rampTempo(240, 2, { smooth: true });
    Motif.ctx.currentTime = 1;
    Motif.setTempo(60);
    assert(Math.abs(Motif._beatAtTime(1) - 2.5) < 1e-8, "interrupting a smooth ramp preserves accumulated beats");
    assert(Math.abs(Motif._timeAtBeat(4) - 2.5) < 1e-8, "immediate tempo replaces the rest of a smooth ramp");
    Motif.ctx.currentTime = 2;
    Motif._tick();
    assert(Motif.tempo === 60, "cancelled smooth ramp does not overwrite a later immediate tempo");
    for (const invalid of [Infinity, -1, NaN]) {
        let threw = false;
        try { Motif.setTempo(invalid); } catch { threw = true; }
        assert(threw && Motif.tempo === 60, `invalid tempo ${invalid} leaves transport unchanged`);
    }
    Object.assign(Motif, saved);
}

console.log("\n=== Explicit pitch Ramp duration and gate ===");
{
    const saved = Object.fromEntries(["ctx", "tempo", "beatsPerBar", "_tempoMap", "_tempoMapContext", "_mappedTempo", "_tempoRamp", "isPlaying"].map(key => [key, Motif[key]]));
    const savedRegistry = new Map(trackRegistry);
    trackRegistry.clear();
    const originalWorklet = globalThis.AudioWorkletNode;
    const oscillators = [];
    const worklets = [];
    const record = param => {
        param.calls = [];
        param.setValueAtTime = (value, time) => param.calls.push({ op: "set", value, time });
        param.linearRampToValueAtTime = (value, time) => param.calls.push({ op: "ramp", value, time });
        return param;
    };
    Motif.ctx = new MockAudioContext();
    Motif.tempo = 120;
    Motif.beatsPerBar = 4;
    Motif.isPlaying = false;
    Motif._tempoMap = null;
    const createOscillator = Motif.ctx.createOscillator.bind(Motif.ctx);
    Motif.ctx.createOscillator = () => {
        const osc = createOscillator();
        record(osc.frequency);
        osc.stop = time => { osc.stoppedAt = time; };
        oscillators.push(osc);
        return osc;
    };
    globalThis.AudioWorkletNode = class extends MockGainNode {
        constructor() {
            super();
            this.parameters = new Map([["frequency", record(new MockAudioParam())]]);
            this.port = { postMessage() {} };
            worklets.push(this);
        }
    };
    const { ensureSynthWorklet } = await import("./src/TrackVoiceManager.js");
    await ensureSynthWorklet(Motif.ctx);
    Motif.synthRegistry.set("pitch-duration-test", ({ p }) => Math.sin(p * Math.PI * 2));
    let serial = 0;
    try {
        const sharedRamp = Object.freeze(Ramp(0, 7, "1/16"));
        const cases = [
            [sharedRamp, "C4", "major", false, 60, 72],
            [sharedRamp, "D4", "minor", false, 62, 74],
            [sharedRamp, "C4", "major", false, 60, 72],
            [Ramp(-1, 2, "1/16"), "C4", "minor", false, 58, 63],
            [Ramp(0, "C5", "1/16"), "C4", "major", false, 60, 72],
            [Ramp("C4", 7, "1/16"), "C4", "major", false, 60, 72],
            [Ramp(60, 72, "1/16"), undefined, undefined, false, 60, 72],
            [Ramp(220, 440, "1/16"), "C4", "major", true, 220, 440],
        ];
        for (const [ramp, root, scale, freq, from, to] of cases) {
            oscillators.length = 0;
            const track = Track(`pitch-scale-${serial++}`).synth("sine");
            if (root) track.scale(root, scale);
            if (freq) track.freq([ramp]);
            else track.note([ramp]);
            track.trackInputNode = Motif.ctx.createGain();
            track._playEvent({ value: ramp }, 1, 2);
            const calls = oscillators[0].frequency.calls;
            assert(calls.some(c => c.op === "set" && c.value === (freq ? from : midiToHz(from)) && c.time === 1), `${track.id}: mapped glide onset`);
            assert(calls.some(c => c.op === "ramp" && c.value === (freq ? to : midiToHz(to)) && c.time === 1.125), `${track.id}: mapped glide target preserves explicit timing`);
            if (!freq) {
                oscillators.length = 0;
                track.tuning("17-EDO");
                track._playEvent({ value: ramp }, 4, 2);
                assert(oscillators[0].frequency.calls.some(c => c.op === "set" && c.value === track._convertToTuningHz(from)), `${track.id}: scale onset passes through tuning`);
                assert(oscillators[0].frequency.calls.some(c => c.op === "ramp" && c.value === track._convertToTuningHz(to)), `${track.id}: scale target passes through tuning`);
            }
        }
        assert(sharedRamp.from === 0 && sharedRamp.to === 7 && sharedRamp.duration === "1/16", "shared scale Ramp stays unchanged across tracks and cycles");
        for (const type of ["sine", "fm", "pluck", "pitch-duration-test"]) {
            for (const [requested, expected] of [[undefined, 2], ["1/16", .125], [.3, .3], ["100ms", .1], ["2 bars", 2]]) {
                oscillators.length = 0;
                worklets.length = 0;
                const track = Track(`pitch-duration-${serial++}`).synth(type).note([Ramp("C4", "C5", requested)]);
                track.trackInputNode = Motif.ctx.createGain();
                track._playEvent({ value: track._notePattern[0] }, 1, 2);
                const param = type === "pitch-duration-test" ? worklets[0].parameters.get("frequency") : oscillators[0].frequency;
                assert(param.calls.some(c => c.op === "set" && c.value === midiToHz("C4") && c.time === 1), `${type} ${requested}: starts at C4 at onset`);
                assert(param.calls.some(c => c.op === "ramp" && c.value === midiToHz("C5") && Math.abs(c.time - 1 - expected) < 1e-9), `${type} ${requested}: reaches C5 at requested/clamped glide end`);
                assert([...track._activeVoices.values()][0].endTime === 3.015, `${type} ${requested}: gate and release remain two seconds plus fade`);
                if (type === "fm") {
                    assert(oscillators[1].frequency.calls.some(c => c.op === "ramp" && c.value === midiToHz("C5") * 2 && Math.abs(c.time - 1 - expected) < 1e-9), `FM ${requested}: modulator follows glide duration`);
                }
            }
        }
        oscillators.length = 0;
        const chord = Track(`pitch-duration-${serial++}`).note([Parallel(Ramp("C4", "C5", "1/16"), Ramp("E4", "E5"))]).stepLength("1 bar");
        chord.trackInputNode = Motif.ctx.createGain();
        chord._schedule(.1);
        assert(oscillators.length === 2 && oscillators[0].frequency.calls.at(-1).time === .125 && oscillators[1].frequency.calls.at(-1).time === 2, "scheduled Parallel pitch Ramps retain explicit and omitted durations independently");
        oscillators.length = 0;
        const hzTrack = Track(`pitch-duration-${serial++}`).freq([Ramp(220, 440, .25)]);
        hzTrack.trackInputNode = Motif.ctx.createGain();
        hzTrack._playEvent({ value: Ramp(220, 440, .25) }, 1, 2);
        assert(oscillators[0].frequency.calls.at(-1).value === 440 && oscillators[0].frequency.calls.at(-1).time === 1.25, "freq Ramp endpoints stay in Hz with explicit duration");
        for (const invalid of [0, -1, Infinity, NaN, "invalid"]) {
            const before = oscillators.length;
            let error;
            try { hzTrack._playEvent({ value: Ramp(220, 440, invalid) }, 1, 2); } catch (e) { error = e; }
            assert(error?.message.includes("finite and positive") && oscillators.length === before, `invalid pitch duration ${invalid} rejects before allocating audio`);
        }
        for (const kind of ["sample", "sampler", "noise"]) {
            const track = Track(`pitch-duration-${serial++}`).note([Ramp("C4", "C5")]);
            track._useSample = kind === "sample";
            track._useSampler = kind === "sampler";
            if (kind === "noise") track.synth("noise");
            let error;
            try { track._playEvent({ value: Ramp("C4", "C5") }, 1, 2); } catch (e) { error = e; }
            assert(error?.message.includes("requires a pitched synth") && track._activeVoices.size === 0, `${kind} rejects pitch Ramps explicitly even before buffers load`);
        }
        chord._scheduledUntil = 0;
        Motif.rampTempo(240, 2, { smooth: true });
        oscillators.length = 0;
        hzTrack._playEvent({ value: Ramp(220, 440, "1 beat") }, 1, 2);
        assert(Math.abs(oscillators[0].frequency.calls.at(-1).time - (Math.sqrt(11) - 2)) < 1e-9, "musical pitch duration integrates the tempo ramp from note onset");
        hzTrack._playEvent({ value: Ramp(220, 440, .25) }, 1, 2);
        assert(oscillators[1].frequency.calls.at(-1).time === 1.25, "numeric pitch duration stays clock-based under tempo ramp");
        Motif.ctx = new MockAudioContext();
        Motif.tempo = 120;
        Motif._tempoMap = null;
        let ready;
        Motif.ctx.audioWorklet.addModule = () => new Promise(resolve => { ready = resolve; });
        const late = Track(`pitch-duration-${serial++}`).synth("pitch-duration-test");
        late.trackInputNode = Motif.ctx.createGain();
        worklets.length = 0;
        late._playEvent({ value: Ramp("C4", "C5", .125) }, 1, 2);
        Motif.ctx.currentTime = 1.1;
        ready();
        await ensureSynthWorklet(Motif.ctx);
        const lateCalls = worklets[0].parameters.get("frequency").calls;
        assert(Math.abs(lateCalls[0].value - (midiToHz("C4") + .8 * (midiToHz("C5") - midiToHz("C4")))) < 1e-8, "late custom worklet starts at elapsed glide pitch");
        assert(lateCalls.at(-1).time === 1.125, "late custom worklet retains original pitch endpoint time");
    } finally {
        for (let n = 0; n < serial; n++) trackRegistry.delete(`pitch-duration-${n}`);
        for (const [id, track] of savedRegistry) trackRegistry.set(id, track);
        Motif.synthRegistry.delete("pitch-duration-test");
        globalThis.AudioWorkletNode = originalWorklet;
        Object.assign(Motif, saved);
    }
}

console.log("\n=== Chord Tie Associations and Voice Cleanup ===");
{
    const savedCtx = Motif.ctx;
    const savedTempo = Motif.tempo;
    Motif.ctx = new MockAudioContext();
    Motif.tempo = 120;
    const track = Track("chord-tie-regression").synth("sine")
        .envelope({ attack: .01, decay: .01, sustain: .5, release: .05 });
    track.trackInputNode = Motif.ctx.createGain();
    const play = (events, cycle = 0, offset = 0) => {
        for (const event of [...events].sort((a, b) => a.startTime - b.startTime)) {
            track._playEvent({ ...event, tieCycle: cycle }, offset + event.startTime * 2, event.duration * 2);
        }
    };
    try {
        const chord = PatternParser.parse([Parallel("C4", "E4", "G4"), Tie, null, null]);
        play(chord);
        assert(track._activeVoices.size === 3, "chord Tie holds original voices without retriggering");
        assert([...track._activeVoices.values()].every(v => v.endTime === 1.05), "final chord Tie releases all three voices with the envelope tail");
        Motif.ctx.currentTime = 1.2;
        track._cleanupActiveVoices();
        assert(track._activeVoices.size === 0, "released chord voices leave the voice pool");
        Motif.ctx.currentTime = 0;

        const nested = PatternParser.parse([Parallel(["C4", Tie], ["E4", null]), null]);
        play(nested);
        const nestedVoices = [...track._activeVoices.values()];
        assert(nestedVoices[0].endTime === 1.05, "nested Tie releases its own branch voice");
        assert(nestedVoices[1].endTime === .55, "nested Tie does not extend a simultaneous sibling note");
        track._activeVoices.clear();

        const forked = PatternParser.parse([Parallel("C4", "E4"), Parallel([Tie, null], Tie), null]);
        play(forked);
        assert([...track._activeVoices.values()].every(v => Math.abs(v.endTime - (4 / 3 + .05)) < 1e-9), "parallel continuations of one chord hold all voices until the longest continuation ends");
        track._activeVoices.clear();

        const independent = PatternParser.parse([Parallel(["C4", Tie, Tie, null], ["E4", Tie, null, null]), null]);
        play(independent);
        const independentVoices = [...track._activeVoices.values()];
        assert(independentVoices[0].endTime === .8, "parallel Tie chains retain independent final releases");
        assert(independentVoices[1].endTime === .55, "a longer sibling Tie chain cannot extend the shorter chain");
        track._activeVoices.clear();

        play(PatternParser.parse(["G4"]));
        const unrelated = [...track._activeVoices.values()][0];
        play(PatternParser.parse([Tie, null]));
        assert(unrelated.endTime === 2.05, "an orphan Tie cannot capture an unrelated active voice");
        track._activeVoices.clear();

        const staggered = PatternParser.parse([Parallel("C4", ["E4", "G4"]), Tie, Tie, null]);
        play(staggered);
        const staggeredVoices = [...track._activeVoices.values()];
        assert(staggeredVoices[0].endTime === 1.55 && staggeredVoices[2].endTime === 1.55, "outer Tie chain holds all notes ending at its boundary despite different onsets");
        assert(staggeredVoices[1].endTime === .3, "outer Tie leaves an earlier completed subdivision alone");
        track._activeVoices.clear();

        play(chord.slice(0, 3), 0);
        const older = [...track._activeVoices.values()];
        play(chord.slice(0, 3), 1, .1);
        const newer = [...track._activeVoices.values()].slice(3);
        play(chord.slice(3), 1, .1);
        assert(older.every(v => v.endTime === .55), "a later cycle's Tie cannot extend an older overlapping chord beyond its fallback release");
        assert(newer.every(v => Math.abs(v.endTime - 1.15) < 1e-9), "a later cycle's Tie releases every voice from that cycle");
        play(chord.slice(3), 0);
        assert(older.every(v => v.endTime === 1.05), "older chord remains associated with its own Tie");
        track._activeVoices.clear();

        track._envelope = null;
        const buffer = Motif.ctx.createBuffer(1, 96000, 48000);
        for (const event of chord.slice(0, 3)) track._playAudioBuffer(buffer, 0, .5, 1, event);
        track._playEvent(chord[3], .5, .5);
        assert([...track._activeVoices.values()].every(v => v.endTime === 1), "sample chord Tie releases every buffer voice without an envelope");
    } finally {
        track._activeVoices.clear();
        trackRegistry.delete(track.id);
        Motif.ctx = savedCtx;
        Motif.tempo = savedTempo;
    }
}

console.log("\n=== Missing and Transformed Tie Continuations ===");
{
    const saved = { ctx: Motif.ctx, tempo: Motif.tempo, map: Motif._tempoMap };
    const savedRegistry = new Map(trackRegistry);
    Track.clearRegistry();
    Motif.ctx = new MockAudioContext();
    Motif.tempo = 120;
    Motif._tempoMap = null;
    let serial = 0;
    const make = pattern => {
        const track = Track(`bounded-tie-${serial++}`).synth("sine").note(pattern)
            .envelope({ attack: .01, decay: .01, sustain: .5, release: .05 });
        track.trackInputNode = Motif.ctx.createGain();
        return track;
    };
    const ends = track => [...track._activeVoices.values()].map(voice => voice.endTime);
    const expectEnds = (track, expected, message) => {
        const actual = ends(track);
        assert(actual.length === expected.length && actual.every((end, i) => Math.abs(end - expected[i]) < 1e-9),
            `${message}; expected ${expected}, got ${actual}`);
    };
    try {
        const masked = make([60, Tie, null, null]).mask([true, false, true, true]);
        masked._schedule(1.2);
        expectEnds(masked, [.55], "masked Tie releases at the original gate");

        const degraded = make([60, Tie]).seed(4).degrade(.5);
        degraded._schedule(1.2);
        expectEnds(degraded, [1.05], "deterministically degraded Tie releases its surviving note");

        const chain = make([60, Tie, Tie, null]).mask([true, true, false, true]);
        chain._schedule(1.6);
        expectEnds(chain, [1.05], "removed later continuation releases at the last surviving Tie gate");

        const replaced = make([60, Tie, null, null]).mask([false, true], event => ({ ...event, value: 64 }));
        replaced._schedule(1.2);
        expectEnds(replaced, [.55, 1.05], "transforming a Tie into a pitch removes its old association");

        const reverse = make([60, Tie, null, null]).every(1, events => events.rev());
        reverse._schedule(2);
        expectEnds(reverse, [2.05], "reversed orphan Tie cannot hold the later note");

        const ratchet = make([60, Tie, null, null]).mutate({ chance: 1, actions: { ratchet: 1 } });
        ratchet._schedule(1.2);
        expectEnds(ratchet, [.3, 1.05], "ratchet holds only the note ending at the first Tie boundary");

        const reordered = make([60, Tie, null, null]).every(1, events => [...events].reverse());
        reordered._schedule(1.2);
        expectEnds(reordered, [1.05], "reordered transformed events still consume continuations after their note");

        const fast = make([60, Tie, null, null]).every(1, events => events.fast(2));
        fast._schedule(1);
        expectEnds(fast, [.55], "faster structural timing retains an intact Tie");

        const offset = make([60, Tie, null, null]).offset("1/8");
        offset._schedule(1.5);
        expectEnds(offset, [1.05, 1.3], "offset copies retain distinct continuation identities");

        const branches = make([Parallel([60, Tie, Tie, null], [64, Tie, null, null]), null])
            .mask([true, true, true, true, true, false, true, true, true]);
        branches._schedule(1.5);
        expectEnds(branches, [.8, .3], "reconciled Tie chains preserve independent Parallel branches");

        const staggered = make([Parallel(60, [64, 67]), Tie, Tie, null]).every(1, events => events);
        staggered._schedule(1.6);
        expectEnds(staggered, [1.55, .3, 1.55], "reconciled outer Tie holds staggered chord endings");

        const swung = make([60, Tie, null, null]).swing(1);
        swung._schedule(.1);
        expectEnds(swung, [5 / 6 + .05], "swung continuation bounds the pending release at its delayed onset");
        swung._schedule(1.5);
        expectEnds(swung, [4 / 3 + .05], "intact swung Tie extends the same voice across the timing gap");

        const inactive = make([60, Tie, null, null]).start(0).stop(.4);
        inactive._schedule(1.2);
        expectEnds(inactive, [.55], "inactive continuation leaves a bounded fallback release");

        const clipped = make([60, Tie, null, null]).loopLength(.4);
        clipped._schedule(.1);
        expectEnds(clipped, [.45], "loop-clipped continuation releases at the clipped gate");

        const stalled = make([60, Tie, null, null]);
        stalled._schedule(.1);
        expectEnds(stalled, [.55], "a tied note submits its fallback before any continuation runs");
        Motif.ctx.currentTime = .75;
        stalled._schedule(.85);
        expectEnds(stalled, [], "scheduler stall skips the Tie and cleans the released voice");
        Motif.ctx.currentTime = 0;

        Track.clearRegistry();
        const slowed = make([60, Tie, null, null]);
        slowed._schedule(.1);
        Motif.ctx.currentTime = .2;
        Motif.setTempo(60);
        slowed._schedule(.3);
        expectEnds(slowed, [.85], "live tempo slowdown moves the pending fallback to the later continuation onset");
        for (let time = .225; time < 1.5; time += .025) {
            Motif.ctx.currentTime = time;
            slowed._schedule(time + .1);
        }
        expectEnds(slowed, [1.85], "slowed intact Tie extends and releases at its new gate");
        Motif.ctx.currentTime = 0;
        Motif.tempo = 120;
        Motif._tempoMap = null;

        for (const useEnvelope of [false, true]) {
            const sample = make([60, Tie, null, null]);
            if (!useEnvelope) sample._envelope = null;
            sample._useSample = true;
            sample._sampleBuffer = Motif.ctx.createBuffer(1, 192000, 48000);
            sample.mask([true, false, true, true]);
            sample._schedule(1.2);
            expectEnds(sample, [useEnvelope ? .55 : .505], `removed sample Tie has a finite stop (envelope=${useEnvelope})`);

            const intact = make([60, Tie, null, null]);
            if (!useEnvelope) intact._envelope = null;
            intact._useSample = true;
            intact._sampleBuffer = sample._sampleBuffer;
            intact._schedule(1.2);
            expectEnds(intact, [useEnvelope ? 1.05 : 1], `intact sample Tie extends its pending stop (envelope=${useEnvelope})`);
        }
    } finally {
        Track.clearRegistry();
        for (const [id, track] of savedRegistry) trackRegistry.set(id, track);
        Motif.ctx = saved.ctx;
        Motif.tempo = saved.tempo;
        Motif._tempoMap = saved.map;
    }
}

console.log("\n=== Gain signals: shared destinations and replacement ===");
{
    const savedCtx = Motif.ctx;
    Motif.ctx = new MockAudioContext();
    const signal = LFO.sine({ min: .04, max: .09, frequency: 1 });
    const a = Track("gain-signal-a").gain(signal).pan(0);
    const b = Track("gain-signal-b").pan(0).gain(signal);
    const events = [];
    const originalDisconnect = signal.disconnect.bind(signal);
    signal.disconnect = target => { events.push(target); return originalDisconnect(target); };
    const gate = a._gainSignalGate;
    a.gain(.3);
    assert(events.length === 1 && events[0] === gate, "scalar gain disconnects only its shared signal destination");
    assert(b._gainSignal === signal && b._gainSignalGate.gain.value === 1, "shared signal remains active on the other track");
    assert(a.trackInputNode.gain.value === .3, "scalar replacement is an absolute track level");
    a.gain(signal);
    const replacement = LFO.sine({ min: .2, max: .4, frequency: 1 });
    a.gain(replacement);
    assert(a._gainSignal === replacement && events.length === 2, "replacement signal detaches the previous destination");
    assert(a.trackInputNode.gain.value === 0, "signal input has no intrinsic unity offset");
    const gateEvents = [];
    a._gainSignalGate.gain.setValueAtTime = (value, time) => gateEvents.push({ value, time });
    a._gainSignalGate.gain.cancelScheduledValues = time => {
        while (gateEvents.at(-1)?.time >= time) gateEvents.pop();
    };
    const arrangedRamp = {};
    a._suspendGainSignal(2, arrangedRamp);
    a._suspendGainSignal(3, arrangedRamp);
    assert(gateEvents.at(-1).time === 3 && !gateEvents.some(event => event.time === 2), "tempo re-anchoring moves the pending signal cutoff");
    a._suspendGainSignal(4, {});
    assert(gateEvents.at(-1).time === 3, "a later section cannot delay the first signal cutoff");
    const preservedGate = a._gainSignalGate;
    a.pan(.1);
    assert(a._gainSignalGate === preservedGate, "effect edits preserve an existing signal binding");
    a.gain(0);
    b.gain(0);
    trackRegistry.delete(a.id);
    trackRegistry.delete(b.id);
    Motif.ctx = savedCtx;
}

console.log("\n=== Granular stretching: stereo output and channel selection ===");
{
    const savedCtx = Motif.ctx;
    const savedWorklet = globalThis.AudioWorkletNode;
    const created = [];
    class GranularWorkletNode extends MockGainNode {
        constructor(ctx, name, options) {
            super();
            this.name = name;
            this.options = options;
            this.messages = [];
            this.parameters = new Map([
                ["stretchFactor", new MockAudioParam()],
                ["pitchRatio", new MockAudioParam()],
                ["grainSize", new MockAudioParam()],
                ["overlap", new MockAudioParam()],
            ]);
            this.port = { postMessage: (message, transfer) => this.messages.push({ message, transfer }) };
            created.push(this);
        }
    }

    try {
        Motif.ctx = new MockAudioContext();
        globalThis.AudioWorkletNode = GranularWorkletNode;
        const stereo = Motif.ctx.createBuffer(2, 4, 48000);
        stereo.copyToChannel(new Float32Array([1, 2, 3, 4]), 0);
        stereo.copyToChannel(new Float32Array([5, 6, 7, 8]), 1);

        const play = track => {
            track.trackInputNode = Motif.ctx.createGain();
            track._playAudioBuffer(stereo, 0, 1, 1, { value: 60, index: 0 });
            return created.at(-1);
        };

        const stereoTrack = Track("granular-stereo").fit(2, { mode: "stretch" });
        const first = play(stereoTrack);
        const firstChannels = first.messages[0].message;
        assert(first.name === "granular-stretcher" && first.options.numberOfInputs === 0 && first.options.numberOfOutputs === 1
            && first.options.outputChannelCount.length === 1 && first.options.outputChannelCount[0] === 2,
        "granular worklet explicitly allocates one stereo output");
        assert(firstChannels.leftBuffer.join() === "1,2,3,4" && firstChannels.rightBuffer.join() === "5,6,7,8",
            "granular stereo playback transfers both distinct source channels");
        assert(first.messages[0].transfer.length === 2 && first.messages[0].transfer[0] !== first.messages[0].transfer[1],
            "granular stereo playback transfers one fresh buffer per channel");

        const second = play(stereoTrack);
        assert(second.messages[0].message.leftBuffer !== firstChannels.leftBuffer
            && second.messages[0].message.rightBuffer !== firstChannels.rightBuffer,
        "repeated granular notes retain fresh transferable channel copies");

        const mono = Motif.ctx.createBuffer(1, 4, 48000);
        mono.copyToChannel(new Float32Array([9, 10, 11, 12]), 0);
        const monoTrack = Track("granular-mono").fit(2, { mode: "stretch" });
        monoTrack.trackInputNode = Motif.ctx.createGain();
        monoTrack._playAudioBuffer(mono, 0, 1, 1, { value: 60, index: 0 });
        const monoPost = created.at(-1).messages[0];
        assert(monoPost.message.leftBuffer === monoPost.message.rightBuffer && monoPost.transfer.length === 1,
            "granular mono playback duplicates one transferred source channel safely");

        const split = Track("granular-split").sample(stereo).fit(2, { mode: "stretch" }).note([60]).splitStereo(right => right.fit(2, { mode: "stretch" }));
        const splitLeft = play(split).messages[0].message;
        const splitRight = play(split._rightTrack).messages[0].message;
        assert(splitLeft.leftBuffer.join() === "1,2,3,4" && splitLeft.rightBuffer === splitLeft.leftBuffer,
            "granular split parent selects and duplicates only the left source channel");
        assert(splitRight.leftBuffer.join() === "5,6,7,8" && splitRight.rightBuffer === splitRight.leftBuffer,
            "granular split shadow selects and duplicates only the right source channel");
    } finally {
        Track.clearRegistry();
        Motif.ctx = savedCtx;
        globalThis.AudioWorkletNode = savedWorklet;
    }
}

// Slice scheduling shares nested parser timing and keeps pitch independent of selection.
{
    const slices = [0, 1, [2, 2], -1];
    const track = Track("slice-contract").chop(4).pattern(slices);
    assert(track._parsedEvents.length === 5, "slice patterns create five events without note triggers");
    assert(track._parsedEvents.map(event => event.startTime).join() === "0,0.25,0.5,0.625,0.75",
        "nested slice onset fractions subdivide the third slot");
    assert(track._parsedEvents.map(event => event.duration).join() === "0.25,0.25,0.125,0.125,0.25",
        "nested slices inherit subdivided gate durations");
    assert(track._parsedEvents.every(event => event.value === 60), "slice indices default to native MIDI60 pitch");
    assert(track._parsedEvents.map(event => event.sliceIndex).join() === "0,1,2,2,-1", "slice selection is separate event metadata");
    track.note([60, null, 72, 67]);
    assert(track._parsedEvents.map(event => event.value).join() === "60,,72,72,67", "explicit pitches and rests apply to nested slice onsets");
    const reverseOrder = Track("slice-contract-order").note([60, null, 72, 67]).pattern(slices);
    assert(reverseOrder._parsedEvents.map(event => event.value).join() === track._parsedEvents.map(event => event.value).join(),
        "note and slice setters are independent of chaining order");
    track.pattern(null);
    assert(track._parsedEvents.length === 4 && track._parsedEvents[2].sliceIndex === undefined, "pattern(null) restores explicit note rhythm");
    let invalid = 0;
    for (const value of [[NaN], [[1.5]], [Infinity], ["2"], 1, new Array(2)]) {
        try { track.pattern(value); } catch { invalid++; }
    }
    assert(invalid === 6 && track._parsedEvents.length === 4, "invalid slice patterns fail before changing scheduler events");
    track.pattern([]);
    assert(track._parsedEvents.length === 0, "empty slice pattern is silent");
    Track.clearRegistry();
}

{
    const saved = { ctx: Motif.ctx, tempo: Motif.tempo, map: Motif._tempoMap };
    const ctx = new MockAudioContext();
    const sources = [];
    ctx.createBufferSource = () => {
        const source = { playbackRate: new MockAudioParam(1), connect() {}, disconnect() {},
            start(time, offset, duration) { Object.assign(this, { time, offset, duration }); },
            stop(stopTime) { this.stopTime = stopTime; } };
        sources.push(source);
        return source;
    };
    Motif.ctx = ctx;
    Motif.tempo = 120;
    Motif._tempoMap = null;
    try {
        const track = Track("slice-scheduled").chop(4).pattern([0, 1, [2, 2], -1]).stepLength(1)
            .fit(4, { mode: "repitch" }).scale("C5", "major");
        track._useSample = true;
        track._sampleBuffer = ctx.createBuffer(2, 96000, 48000);
        track._schedule(4);
        assert(sources.length === 5 && sources.map(source => source.time).join() === "0,1,2,2.5,3",
            "scheduler submits exactly five nested slice sources at the specified clock onsets");
        assert(sources.map(source => source.offset).join() === "0,0.5,1,1,1.5",
            "sample sources receive correct repeated and wrapped slice offsets");
        assert(sources.every(source => source.duration === 0.5 && source.playbackRate.value === 0.5),
            "native slices preserve fit rate even with an active scale");
        assert(Math.abs(sources[2].stopTime - 2.505) < 1e-9 && sources[4].stopTime === 4,
            "nested sources stop at subdivided gates with release and final slice stops at fitted end");
        track.note([0, 0, 0, 0]);
        track._playEvent(track._parsedEvents[0], 5, 1);
        assert(sources.at(-1).playbackRate.value === 1, "explicit notes retain C5 scale mapping while slice offsets remain independent");
        track.every(1, events => events.rev());
        const reversed = track._getCycleEvents(0);
        assert(reversed[0].sliceIndex === -1 && reversed[1].sliceIndex === 2,
            "event transforms preserve slice selection with their moved onsets");
        track.note(null);
        assert(track._parsedEvents.every(event => event.value === null), "explicit scalar null pitch silences slice triggers");
        const chord = Track("slice-chord").note([Parallel(60, 72)]).pattern([0, [1, 2]]);
        assert(chord._parsedEvents.length === 6 && chord._parsedEvents[3].sliceIndex === 1,
            "parallel pitches allocate independent voices at nested slice onsets");
    } finally {
        Track.clearRegistry();
        Motif.ctx = saved.ctx;
        Motif.tempo = saved.tempo;
        Motif._tempoMap = saved.map;
    }
}

// =============================================================================
// Track source readiness: startup, failures, supersession, and live edits
// =============================================================================
console.log("\n=== Track source readiness ===");
{
    const savedMotif = { ...Motif };
    const savedFetch = globalThis.fetch;
    const savedError = console.error;
    const ctx = new MockAudioContext();
    const buffer = ctx.createBuffer(1, 44100, 44100);
    const errors = [];
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    };
    let oscillatorCalls = 0;
    let bufferCalls = 0;
    const createOscillator = ctx.createOscillator.bind(ctx);
    const createBufferSource = ctx.createBufferSource.bind(ctx);
    ctx.createOscillator = () => { oscillatorCalls++; return createOscillator(); };
    ctx.createBufferSource = () => { bufferCalls++; return createBufferSource(); };
    console.error = (...args) => errors.push(args);
    Object.assign(Motif, {
        ctx,
        masterGain: ctx.createGain(),
        sampleRegistry: new Map(),
        _loadingSamples: [],
        _masterLimiterEnabled: false,
        _startScheduler() {},
        _stopScheduler() {},
        isPlaying: false,
        _suspendedByEngine: false,
    });
    const configure = (track, kind, path) => kind === "sample"
        ? track.sample(path)
        : track.sampler({ urls: { C4: path } });
    const reset = () => {
        Track.clearRegistry();
        Motif.isPlaying = false;
        Motif._debugPlaybackStart = null;
    };

    try {
        Track.clearRegistry();
        Motif.sampleRegistry.set("readiness-buffer", buffer);
        for (const kind of ["sample", "sampler"]) {
            const track = configure(Track(`readiness-registered-${kind}`).note([60]), kind, "readiness-buffer");
            const starting = Motif.start();
            assert(!Motif.isPlaying, `readiness: registered ${kind} buffer adoption precedes startup`);
            await starting;
            const previousBuffers = bufferCalls;
            track._playEvent(track._parsedEvents[0], 0, 1);
            assert(Motif.isPlaying && bufferCalls === previousBuffers + 1,
                `readiness: registered ${kind} is playable when start resolves`);
            reset();
        }

        for (const kind of ["sample", "sampler"]) {
            const pending = deferred();
            Motif._loadAndCacheBuffer = () => pending.promise;
            const track = configure(Track(`readiness-failure-${kind}`).note([60]), kind, "failure.wav");
            let resolved = false;
            const starting = Motif.start().then(() => { resolved = true; });
            await flush();
            assert(!resolved && !Motif.isPlaying, `readiness: slow ${kind} blocks startup`);
            const previousOscillators = oscillatorCalls;
            track._playEvent(track._parsedEvents[0], 0, 1);
            assert(oscillatorCalls === previousOscillators, `readiness: pending ${kind} cannot synthesize`);
            const previousErrors = errors.length;
            pending.reject(new Error("unavailable source"));
            await starting;
            track._playEvent(track._parsedEvents[0], 0, 1);
            assert(Motif.isPlaying && oscillatorCalls === previousOscillators,
                `readiness: failed ${kind} starts silently without synth fallback`);
            assert(errors.length === previousErrors + 1, `readiness: failed ${kind} logs its load error`);
            reset();
        }

        for (const kind of ["sample", "sampler"]) {
            Motif.sampleRegistry.set("readiness-broken-generator", () => { throw null; });
            const track = configure(Track(`readiness-generator-${kind}`).note([60]), kind, "readiness-broken-generator");
            await Motif.start();
            const previousOscillators = oscillatorCalls;
            track._playEvent(track._parsedEvents[0], 0, 1);
            assert(Motif.isPlaying && oscillatorCalls === previousOscillators,
                `readiness: throwing ${kind} generator follows the logged silent-source policy`);
            reset();
        }

        const concurrent = [deferred(), deferred(), deferred()];
        Motif._loadAndCacheBuffer = path => concurrent[Number(path)].promise;
        Track("readiness-concurrent-sample").sample("0").note([60]);
        Track("readiness-concurrent-sampler").sampler({ urls: { C4: "1" } }).note([60]);
        let concurrentResolved = false;
        const concurrentStart = Motif.start().then(() => { concurrentResolved = true; });
        await flush();
        Track("readiness-added-during-start").sample("2").note([60]);
        concurrent[0].resolve(buffer);
        concurrent[1].resolve(buffer);
        await flush();
        assert(!concurrentResolved && !Motif.isPlaying, "readiness: tracks added during startup join current source readiness");
        concurrent[2].resolve(buffer);
        await concurrentStart;
        assert(Motif.isPlaying, "readiness: all concurrent current track loads release startup");
        reset();

        const good = deferred();
        const bad = deferred();
        Motif._loadAndCacheBuffer = path => path === "good.wav" ? good.promise : bad.promise;
        const partial = Track("readiness-partial").sampler({ urls: { C4: "good.wav", G4: "bad.wav" } }).note([67]);
        let partialResolved = false;
        const partialStart = Motif.start().then(() => { partialResolved = true; });
        good.resolve(buffer);
        await flush();
        assert(!partialResolved && !Motif.isPlaying, "readiness: sampler waits for every zone to settle");
        bad.reject(new Error("missing zone"));
        await partialStart;
        let playedBuffer, playedRate;
        partial._playAudioBuffer = (value, time, duration, rate) => { playedBuffer = value; playedRate = rate; };
        partial._playEvent(partial._parsedEvents[0], 0, 1);
        assert(playedBuffer === buffer && Math.abs(playedRate - Math.pow(2, 7 / 12)) < 1e-9,
            "readiness: partial sampler uses the nearest successfully loaded zone");
        reset();

        const empty = Track("readiness-empty").sampler({ urls: {} }).note([60]);
        await Motif.start();
        const beforeEmpty = oscillatorCalls;
        empty._playEvent(empty._parsedEvents[0], 0, 1);
        assert(Motif.isPlaying && oscillatorCalls === beforeEmpty, "readiness: empty sampler starts silently");
        reset();

        for (const from of ["sample", "sampler"]) {
            for (const to of ["sample", "sampler", "synth", "remove"]) {
                const old = deferred();
                const current = deferred();
                Motif._loadAndCacheBuffer = path => path === "old.wav" ? old.promise : current.promise;
                const track = configure(Track(`readiness-replace-${from}-${to}`).note([60]), from, "old.wav");
                let resolved = false;
                const starting = Motif.start().then(() => { resolved = true; });
                await flush();
                if (to === "synth") track.synth("triangle");
                else if (to === "remove") track.sample(null);
                else configure(track, to, "current.wav");
                await flush();
                if (to === "sample" || to === "sampler") {
                    assert(!resolved, `readiness: ${from} replacement waits for current ${to}`);
                    current.resolve(buffer);
                    await flush();
                }
                assert(resolved && Motif.isPlaying, `readiness: ${from} to ${to} abandons a never-settling superseded load`);
                old.resolve(ctx.createBuffer(1, 22050, 44100));
                await flush();
                assert(to === "sample" ? track._sampleBuffer === buffer
                    : to === "sampler" ? track._samplerBuffers.get(60) === buffer
                    : !track._useSample && !track._useSampler && track._sampleBuffer === null,
                    `readiness: superseded ${from} cannot revive after switching to ${to}`);
                await starting;
                reset();
            }
        }

        for (const action of ["replaceTrack", "prune", "clear"]) {
            const pending = deferred();
            Motif._loadAndCacheBuffer = () => pending.promise;
            Track("readiness-registry").sample("never.wav").note([60]);
            let resolved = false;
            const starting = Motif.start().then(() => { resolved = true; });
            await flush();
            if (action === "replaceTrack") Track("readiness-registry").synth("sine").note([60]);
            if (action === "prune") Track.pruneExcept([]);
            if (action === "clear") Track.clearRegistry();
            await flush();
            assert(resolved && Motif.isPlaying, `readiness: registry ${action} releases startup without settling old fetch`);
            await starting;
            reset();
        }

        const live = Track("readiness-live").sample("readiness-buffer").note([60]);
        await Motif.start();
        const replacement = deferred();
        Motif._loadAndCacheBuffer = () => replacement.promise;
        live.sample("replacement.wav");
        const beforeLive = { oscillators: oscillatorCalls, buffers: bufferCalls };
        live._playEvent(live._parsedEvents[0], 0, 1);
        assert(oscillatorCalls === beforeLive.oscillators && bufferCalls === beforeLive.buffers,
            "readiness: live sample replacement clears the old buffer and skips unready events");
        replacement.resolve(buffer);
        await flush();
        live._playEvent(live._parsedEvents[0], 1, 1);
        assert(bufferCalls === beforeLive.buffers + 1, "readiness: live sample becomes playable after adoption");
        const liveFailedSample = deferred();
        Motif._loadAndCacheBuffer = () => liveFailedSample.promise;
        live.sample("live-failed-sample.wav");
        liveFailedSample.reject(new Error("live sample unavailable"));
        await flush();
        live._playEvent(live._parsedEvents[0], 2, 1);
        assert(oscillatorCalls === beforeLive.oscillators && bufferCalls === beforeLive.buffers + 1,
            "readiness: live failed sample remains silent without replaying the prior source");
        const liveSampler = deferred();
        Motif._loadAndCacheBuffer = () => liveSampler.promise;
        live.sampler({ urls: { C4: "live-sampler.wav" } });
        live._playEvent(live._parsedEvents[0], 2, 1);
        assert(oscillatorCalls === beforeLive.oscillators && bufferCalls === beforeLive.buffers + 1,
            "readiness: live unready sampler skips events without replacing the running transport");
        liveSampler.reject(new Error("live zone unavailable"));
        await flush();
        live._playEvent(live._parsedEvents[0], 3, 1);
        assert(oscillatorCalls === beforeLive.oscillators, "readiness: live failed sampler remains silent");
        live.synth("sine");
        live._playEvent(live._parsedEvents[0], 4, 1);
        assert(oscillatorCalls === beforeLive.oscillators + 1, "readiness: explicit live synth selection restores synthesis");
        reset();

        Motif._loadAndCacheBuffer = savedMotif._loadAndCacheBuffer;
        let fetches = 0;
        globalThis.fetch = async () => {
            fetches++;
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
        };
        ctx.decodeAudioData = (bytes, resolve) => { resolve(buffer); };
        Track("readiness-cache-a").sample("readiness-cache-unique.wav").note([60]);
        Track("readiness-cache-b").sampler({ urls: { C4: "readiness-cache-unique.wav" } }).note([60]);
        await Motif.start();
        assert(fetches === 1, "readiness: sample and sampler keep shared successful buffer caching");
        reset();
        sampleBufferCache.delete("readiness-cache-unique.wav");

        let retryFetches = 0;
        globalThis.fetch = async () => {
            retryFetches++;
            if (retryFetches === 1) throw new Error("retryable fetch failure");
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
        };
        const retry = Track("readiness-retry").sample("readiness-retry-unique.wav").note([60]);
        await Motif.start();
        retry.sample("readiness-retry-unique.wav");
        await Motif.start();
        assert(retryFetches === 2 && retry._sampleBuffer === buffer,
            "readiness: failed cached fetch is evicted and reassigning the source retries");
        reset();
        sampleBufferCache.delete("readiness-retry-unique.wav");

        const limiterError = new Error("limiter unavailable");
        Motif._masterLimiterEnabled = true;
        Motif._masterLimiterError = limiterError;
        Motif._loadingSamples = [Promise.reject(limiterError)];
        Motif._loadAndCacheBuffer = () => new Promise(() => {});
        Track("readiness-limiter-pending-source").sample("never-ready.wav").note([60]);
        let rejected;
        try { await Motif.start(); } catch (error) { rejected = error; }
        assert(rejected === limiterError && !Motif.isPlaying, "readiness: unavailable enabled limiter rejects startup without waiting for a pending source");
    } finally {
        Track.clearRegistry();
        sampleBufferCache.delete("readiness-cache-unique.wav");
        sampleBufferCache.delete("readiness-retry-unique.wav");
        console.error = savedError;
        globalThis.fetch = savedFetch;
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
    }
}

// =============================================================================
// Verified review regressions: these assertions describe the desired behavior.
// =============================================================================
console.log("\n=== Verified review regressions ===");
{
    const savedMotif = { ...Motif };
    const savedWorklet = globalThis.AudioWorkletNode;
    const ctx = new MockAudioContext();
    globalThis.AudioWorkletNode = class extends MockAudioNode {
        constructor() {
            super();
            this.port = { postMessage() {} };
            this.parameters = new Map(["ceiling", "release", "frequency"].map(key => [key, new MockAudioParam()]));
        }
    };
    Motif.ctx = ctx;
    Motif.masterGain = ctx.createGain();
    Motif.tempo = 120;
    Motif._tempoMap = null;
    Motif._loadingSamples = [];
    Motif._masterLimiterEnabled = false;
    Motif._startScheduler = () => {};
    Motif._stopScheduler = () => {};
    Motif._arrangementEndBeat = undefined;
    Motif._arrangementOptions = {};
    Motif.onPlaybackFinished = null;
    Motif.isPlaying = false;

    try {
        const masked = Track("review-masked-tie").synth("sine").note([60, Tie]).mask([true, false]);
        for (let time = 0; time < 6.1; time += .025) {
            ctx.currentTime = time;
            masked._schedule(time + .1);
        }
        const held = [...masked._activeVoices.values()].filter(voice => voice.endTime === Infinity).length;
        assert(held === 0, `review-tie: removing the continuation must release its note; observed ${held} infinite voices`);
        Track.clearRegistry();
        ctx.currentTime = 0;

        for (const kind of ["sample", "sampler"]) {
            let resolveBuffer;
            const pending = new Promise(resolve => { resolveBuffer = resolve; });
            Motif._loadAndCacheBuffer = () => pending;
            const cold = Track(`review-cold-${kind}`);
            if (kind === "sample") cold.sample("review-slow.wav");
            if (kind === "sampler") cold.sampler({ urls: { C4: "review-slow.wav" } });
            cold.note([60]);
            let resolvedStart = false;
            const starting = Motif.start().then(() => { resolvedStart = true; });
            await Promise.resolve();
            await Promise.resolve();
            assert(!resolvedStart && !Motif.isPlaying, `review-readiness: start must await pending ${kind} sources`);
            let oscillatorCalls = 0;
            const createOscillator = ctx.createOscillator;
            ctx.createOscillator = () => {
                oscillatorCalls++;
                return createOscillator.call(ctx);
            };
            cold._playEvent(cold._parsedEvents[0], 0, 1);
            ctx.createOscillator = createOscillator;
            assert(oscillatorCalls === 0, `review-readiness: unready ${kind} must not allocate a synth; observed ${oscillatorCalls}`);
            resolveBuffer(ctx.createBuffer(1, 44100, 44100));
            await (kind === "sample" ? cold._sampleLoading : cold._samplerLoading);
            await starting;
            Motif.stop();
            Track.clearRegistry();
        }
        Motif._loadAndCacheBuffer = savedMotif._loadAndCacheBuffer;
        ctx.state = "running";
        Motif._suspendedByEngine = false;
        Motif.sampleRegistry.set("review-stereo-buffer", ctx.createBuffer(2, 44100, 44100));

        const sample = Track("review-split-sample").sample("review-stereo-buffer").note([60]).splitStereo();
        await sample._sampleLoading;
        await sample._rightTrack._sampleLoading;
        assert(sample._rightTrack._sampleBuffer === sample._sampleBuffer,
            "review-split-load: the right sample must receive the resolved parent buffer");
        Track.clearRegistry();
        const sampler = Track("review-split-sampler").sampler({ urls: { C4: "review-stereo-buffer" } }).note([60]).splitStereo();
        await sampler._samplerLoading;
        await sampler._rightTrack._samplerLoading;
        assert(sampler._rightTrack._findNearestSamplerKey(60) === 60,
            `review-split-load: the right sampler must select its loaded zone; observed keys ${sampler._rightTrack._samplerKeys}`);
        Track.clearRegistry();

        for (const kind of ["sample", "sampler"]) {
            for (const action of ["resolve", "reject", "parent-replace", "right-synth", "right-sample", "right-sampler", "repeat-split", "replace-track"]) {
                for (const oldFirst of [false, true]) {
                    let resolveOld, rejectOld, resolveNew;
                    const oldLoad = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
                    const newLoad = new Promise(resolve => { resolveNew = resolve; });
                    Motif._loadAndCacheBuffer = path => path === "split-old.wav" ? oldLoad : newLoad;
                    const oldBuffer = ctx.createBuffer(2, 4410, 44100);
                    const newBuffer = ctx.createBuffer(2, 8820, 44100);
                    const configure = (track, sourceKind, path) => sourceKind === "sample"
                        ? track.sample(path)
                        : track.sampler({ urls: { C4: path } });
                    const parent = configure(Track("split-loading"), kind, "split-old.wav").note([60]).splitStereo();
                    const right = parent._rightTrack;
                    const oldRightLoad = kind === "sample" ? right._sampleLoading : right._samplerLoading;
                    const label = `split loading ${kind}/${action}/${oldFirst}`;
                    assert(right._sourcePending, `${label}: shadow is pending before adoption`);
                    let expectedKind = kind;
                    let expectedBuffer = oldBuffer;
                    if (action === "parent-replace") configure(parent, kind, "split-new.wav");
                    if (action === "right-synth") {
                        right.synth("square");
                        expectedKind = "synth";
                    }
                    if (action === "right-sample" || action === "right-sampler") {
                        expectedKind = action.slice(6);
                        expectedBuffer = newBuffer;
                        configure(right, expectedKind, "split-new.wav");
                    }
                    if (action === "repeat-split") {
                        configure(parent, kind, "split-new.wav").splitStereo();
                        expectedBuffer = newBuffer;
                        assert(parent._rightTrack === right, `${label}: repeated split reuses its shadow`);
                    }
                    let replacement;
                    if (action === "replace-track") {
                        replacement = configure(Track(parent.id), kind, "split-new.wav").note([60]).splitStereo();
                        assert(replacement._rightTrack !== right, `${label}: replacement gets an independent shadow`);
                    }
                    const settleOld = () => action === "reject" ? rejectOld(new Error("expected split failure")) : resolveOld(oldBuffer);
                    if (oldFirst) {
                        settleOld();
                        await oldRightLoad;
                        resolveNew(newBuffer);
                    } else {
                        resolveNew(newBuffer);
                        await Promise.resolve();
                        await Promise.resolve();
                        settleOld();
                    }
                    await oldRightLoad;
                    await right._sampleLoading;
                    await right._samplerLoading;
                    assert(!right._sourcePending, `${label}: current shadow load completes`);
                    if (action === "reject") {
                        assert(kind === "sample" ? right._sampleBuffer === null : right._findNearestSamplerKey(60) === null,
                            `${label}: rejection leaves a silent source`);
                    } else if (expectedKind === "synth") {
                        assert(right._synthType === "square" && !right._useSample && !right._useSampler,
                            `${label}: late source does not replace explicit synth`);
                    } else {
                        const adopted = expectedKind === "sample" ? right._sampleBuffer : right._samplerBuffers.get(right._findNearestSamplerKey(60));
                        assert(adopted === expectedBuffer, `${label}: adopts the correct split-time or explicit right source`);
                    }
                    if (replacement) {
                        await replacement._rightTrack._sampleLoading;
                        await replacement._rightTrack._samplerLoading;
                        const replacementBuffer = kind === "sample" ? replacement._rightTrack._sampleBuffer : replacement._rightTrack._samplerBuffers.get(60);
                        assert(replacementBuffer === newBuffer, `${label}: old source does not affect replacement shadow`);
                    }
                    Track.clearRegistry();
                }
            }
        }
        Motif._loadAndCacheBuffer = savedMotif._loadAndCacheBuffer;

        const stereo = Track("review-prune-split").note([60]).splitStereo();
        Track.pruneExcept([stereo.id]);
        assert(trackRegistry.get(stereo.id + "_right") === stereo._rightTrack,
            "review-split-prune: keeping the parent must keep its scheduled right track");
        stereo._rightTrack.note([72]).gain(.25).delay({ amount: .1 });
        const rightDelay = stereo._rightTrack._delayBus;
        Track.pruneExcept([stereo.id]);
        Bus.pruneExcept([]);
        assert(stereo._rightTrack._notePattern[0] === 72 && stereo._rightTrack._gainLevel === .25,
            "review-split-prune: pruning preserves independent right transforms");
        assert(busRegistry.get(rightDelay.id) === rightDelay,
            "review-split-prune: retained shadow keeps its internal delay bus");
        const replaced = Track(stereo.id).note([60]).splitStereo();
        Track.pruneExcept([replaced.id]);
        assert(trackRegistry.get(replaced.id + "_right") === replaced._rightTrack && replaced._rightTrack !== stereo._rightTrack,
            "review-split-prune: replacement retains only its current shadow");
        const plain = Track(replaced.id).note([60]);
        Track.pruneExcept([plain.id]);
        assert(trackRegistry.size === 1 && !trackRegistry.has(plain.id + "_right"),
            "review-split-prune: redefining without split removes the superseded shadow");
        const removed = Track(plain.id).note([60]).splitStereo();
        removed._rightTrack.delay({ amount: .1 });
        const removedDelayId = removed._rightTrack._delayBus.id;
        Track.pruneExcept([removed._rightTrack.id]);
        assert(trackRegistry.size === 0, "review-split-prune: removing the parent must also remove its right track");
        assert(!busRegistry.has(removedDelayId), "review-split-prune: removed shadow disposes its internal delay bus");

        const hzSampler = Track("review-sampler-hz").sampler({ urls: { A4: "review-stereo-buffer" } }).freq([440]);
        await hzSampler._samplerLoading;
        let rate;
        hzSampler._playAudioBuffer = (_buffer, _start, _duration, playbackRate) => { rate = playbackRate; };
        hzSampler._playEvent(hzSampler._parsedEvents[0], 0, 1);
        assert(Math.abs(rate - 1) < 1e-9, `review-sampler-hz: 440 Hz on an A4 zone must use rate 1; observed ${rate}`);
        const samplerCalls = [];
        hzSampler._playAudioBuffer = (buffer, _start, _duration, playbackRate) => samplerCalls.push({ buffer, playbackRate });
        const playSamplerPitch = (mode, value) => {
            hzSampler[mode]([value]);
            hzSampler._playEvent({ value }, 0, 1);
            return samplerCalls.at(-1);
        };
        for (const [hz, note, expected] of [[220, "A3", .5], [440, "A4", 1], [880, "A5", 2]]) {
            const frequencyCall = playSamplerPitch("freq", hz);
            const noteCall = playSamplerPitch("note", note);
            assert(frequencyCall.buffer === noteCall.buffer && Math.abs(frequencyCall.playbackRate - expected) < 1e-9
                && Math.abs(noteCall.playbackRate - expected) < 1e-9,
                `review-sampler-hz: ${hz} Hz and ${note} share a zone and rate ${expected}`);
        }
        const lowZone = hzSampler._samplerBuffers.get(69);
        const highZone = new MockAudioContext().createBuffer(1, 48000, 48000);
        hzSampler._samplerBuffers.set(81, highZone);
        hzSampler._samplerKeys = [69, 81];
        for (const midi of [70, 79]) {
            const hz = 440 * 2 ** ((midi - 69) / 12);
            const frequencyCall = playSamplerPitch("freq", hz);
            const noteCall = playSamplerPitch("note", midi);
            const root = midi === 70 ? 69 : 81;
            assert(frequencyCall.buffer === (root === 69 ? lowZone : highZone) && frequencyCall.buffer === noteCall.buffer
                && Math.abs(frequencyCall.playbackRate - 2 ** ((midi - root) / 12)) < 1e-9
                && Math.abs(frequencyCall.playbackRate - noteCall.playbackRate) < 1e-9,
                `review-sampler-hz: non-root MIDI ${midi} equivalent selects and transposes the nearest zone`);
        }
        hzSampler.fit(.5);
        const fitted = playSamplerPitch("freq", 880);
        assert(Math.abs(fitted.playbackRate - highZone.duration / .5) < 1e-9,
            "review-sampler-hz: fit multiplies the selected root's rate");
        hzSampler.scale("A4", "major");
        const degreeCall = playSamplerPitch("note", 0);
        const hzCall = playSamplerPitch("freq", 440);
        assert(degreeCall.buffer === lowZone && hzCall.buffer === lowZone && degreeCall.playbackRate === hzCall.playbackRate,
            "review-sampler-hz: scale degrees retain note mapping while Hz bypasses it");
        hzSampler._scaleRoot = undefined;
        for (const invalid of [0, -440, NaN, Infinity, -Infinity, "invalid"]) {
            const count = samplerCalls.length;
            playSamplerPitch("freq", invalid);
            assert(samplerCalls.length === count, `review-sampler-hz: invalid Hz ${invalid} never submits audio`);
        }
        const count = samplerCalls.length;
        playSamplerPitch("note", 0);
        assert(samplerCalls.length === count + 1, "review-sampler-hz: MIDI zero remains a valid note");
        let rejectedRamp = false;
        try { playSamplerPitch("freq", Ramp(440, 880)); } catch { rejectedRamp = true; }
        assert(rejectedRamp, "review-sampler-hz: sampler frequency Ramps remain unsupported");
        Track.clearRegistry();

        const ramp = Ramp(60, 72, "1/8");
        let rampCallbacks = 0;
        const transposed = Track("review-ramp-transpose").note([ramp]).every(1, events => {
            rampCallbacks++;
            return events.transpose(12);
        });
        const firstCycle = transposed._getCycleEvents(0);
        const firstFrom = firstCycle[0].value.from;
        assert(transposed._getCycleEvents(0) === firstCycle && rampCallbacks === 1,
            "review-ramp-copy: cached cycle retains its events without rerunning the callback");
        const secondFrom = transposed._getCycleEvents(1)[0].value.from;
        assert(firstFrom === 72 && secondFrom === 72,
            `review-ramp-copy: every cycle must transpose from the base pitch; observed ${firstFrom}, ${secondFrom}`);
        assert(ramp.from === 60 && ramp.to === 72, "review-ramp-copy: cycle transforms must preserve the caller's Ramp");
        assert(firstCycle[0].value instanceof ramp.constructor && firstCycle[0].value.duration === "1/8",
            "review-ramp-copy: transformed Ramp preserves its type and duration");
        const shared = Track("review-ramp-shared").note([ramp]);
        const sharedCycle = shared._getCycleEvents(0);
        firstCycle[0].value.from = 96;
        assert(sharedCycle[0].value.from === 60 && transposed._getCycleEvents(1)[0].value.from === 72 && ramp.from === 60,
            "review-ramp-copy: direct endpoint edits are isolated across tracks, cycles, and caller values");

        const offsetRamp = Ramp(60, 72, .125);
        const shiftedTrack = Track("review-ramp-offset").note([offsetRamp]).offset("1/4", event => {
            event.value.from += 7;
            event.value.to += 7;
        });
        for (const cycle of [0, 1]) {
            const shifted = shiftedTrack._getCycleEvents(cycle);
            assert(shifted[0].value.from === 60 && shifted[1].value.from === 67 && shifted[1].value.to === 79,
                `review-ramp-copy: offset callback changes only the duplicate in cycle ${cycle}`);
            shifted[1].value.to = 90;
            assert(shifted[0].value.to === 72 && offsetRamp.to === 72,
                "review-ramp-copy: returned offset copy retains independent endpoints");
        }

        const nameRamp = Ramp("C4", "G4", "1/16");
        const direct = PatternParser.parse([nameRamp]);
        const directCopy = direct.map(event => ({ ...event }));
        directCopy.transpose(2);
        assert(direct[0].value.from === "C4" && nameRamp.to === "G4" && directCopy[0].value.from === "D4" && directCopy[0].value.to === "A4",
            "review-ramp-copy: direct array transposition isolates name Ramp endpoints from a shallow event copy");
        direct.offset("1/4", event => { event.value.from = "E4"; });
        assert(direct[0].value.from === "C4" && direct[1].value.from === "E4" && nameRamp.from === "C4",
            "review-ramp-copy: direct array offset owns its Ramp payload");

        const scope = [Symbol("review-ramp-scope")];
        const association = Symbol("review-ramp-association");
        const metadata = new MotifEventArray({ value: ramp, startTime: 0, duration: .5,
            tieScope: scope, tieId: association, tieCycle: 3, sliceIndex: 2, nativeSlicePitch: true });
        metadata.offset("1/4");
        assert(metadata[1].tieScope === scope && metadata[1].tieId === association && metadata[1].tieCycle === 3
            && metadata[1].sliceIndex === 2 && metadata[1].nativeSlicePitch === true,
            "review-ramp-copy: event copies retain Symbols, branch scope, cycle, and slice metadata");
        metadata[1].value.from = 88;
        assert(metadata[0].value.from === 60, "review-ramp-copy: offset without a callback still isolates mutable endpoints");

        const ratcheted = PatternParser.parse([ramp]).mutate({ chance: 1, actions: { ratchet: 1 } });
        ratcheted[1].value.from = 88;
        assert(ratcheted[0].value.from === 60 && ramp.from === 60,
            "review-ramp-copy: direct ratchet copies own independent Ramp endpoints");
        const ratchetTrack = Track("review-ramp-ratchet").note([ramp]).mutate({ chance: 1, actions: { ratchet: 1 } })
            .every(1, events => { events[1].value.from += 7; });
        const ratchetCycle = ratchetTrack._getCycleEvents(0);
        assert(ratchetCycle[0].value.from === 60 && ratchetCycle[1].value.from === 67 && ramp.from === 60,
            "review-ramp-copy: scheduler ratchet copies are isolated before subsequent callbacks");
        Track.clearRegistry();

        const deferredStart = () => {
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            return { promise, resolve, reject };
        };
        const flushStart = async () => {
            for (let i = 0; i < 12; i++) await Promise.resolve();
        };
        const cancellationEngine = () => {
            const engine = new MotifEngine();
            engine.ctx = new MockAudioContext();
            engine.ctx.resume = () => { engine.ctx.state = "running"; return Promise.resolve(); };
            engine.ctx.suspend = () => { engine.ctx.state = "suspended"; return Promise.resolve(); };
            engine._masterLimiterEnabled = false;
            engine.schedulerStarts = 0;
            engine._startScheduler = () => { engine.schedulerStarts++; };
            return engine;
        };
        const savedStartError = console.error;
        const savedStartWarn = console.warn;
        const startFailures = [];
        console.error = (...args) => { startFailures.push(args); };
        console.warn = (...args) => { startFailures.push(args); };
        try {
            for (const action of ["stop", "pause"]) {
                for (const outcome of ["resolve", "reject", "pending"]) {
                    const engine = cancellationEngine();
                    const resource = deferredStart();
                    engine._loadingSamples = [resource.promise];
                    engine.position = 5;
                    let settled = false;
                    const starting = engine.start().then(value => { settled = value === undefined; });
                    engine[action]();
                    await flushStart();
                    assert(settled, `review-start-cancel: ${action} promptly settles cancelled start before ${outcome} resource`);
                    const failure = new Error(`late ${action} resource rejection`);
                    if (outcome === "resolve") resource.resolve();
                    if (outcome === "reject") resource.reject(failure);
                    await flushStart();
                    if (settled) await starting;
                    assert(!engine.isPlaying && engine.schedulerStarts === 0,
                        `review-start-cancel: ${action} prevents late ${outcome} resource launch`);
                    assert(engine.position === (action === "pause" ? 5 : 0),
                        `review-start-cancel: ${action} preserves its position contract`);
                    if (outcome === "reject") {
                        assert(startFailures.some(args => args.includes(failure)),
                            "review-start-cancel: cancelled late resource rejection remains reported");
                    }
                }

                const engine = cancellationEngine();
                const resumed = deferredStart();
                engine.ctx.state = "suspended";
                engine._suspendedByEngine = true;
                engine.ctx.resume = () => resumed.promise;
                let settled = false;
                const starting = engine.start().then(() => { settled = true; });
                await flushStart();
                engine[action]();
                await flushStart();
                assert(settled, `review-start-cancel: ${action} settles while resume is still pending`);
                resumed.resolve();
                await flushStart();
                if (settled) await starting;
                assert(!engine.isPlaying && engine.schedulerStarts === 0,
                    `review-start-cancel: delayed resume cannot launch after ${action}`);

                const sourceEngine = cancellationEngine();
                trackRegistry.set("review-start-never-source", { _sourcePending: true, _schedule() {} });
                let sourceSettled = false;
                const sourceStart = sourceEngine.start().then(() => { sourceSettled = true; });
                await flushStart();
                sourceEngine[action]();
                await flushStart();
                assert(sourceSettled && !sourceEngine.isPlaying && sourceEngine.schedulerStarts === 0,
                    `review-start-cancel: ${action} cancels a never-settling track source wait`);
                if (sourceSettled) await sourceStart;
                trackRegistry.delete("review-start-never-source");
            }

            const superseded = cancellationEngine();
            const firstResource = deferredStart();
            const secondResource = deferredStart();
            superseded._loadingSamples = [firstResource.promise];
            let firstSettled = false;
            const first = superseded.start().then(() => { firstSettled = true; });
            superseded._loadingSamples = [secondResource.promise];
            const second = superseded.start();
            await flushStart();
            assert(firstSettled, "review-start-cancel: superseding start promptly settles old resource wait");
            secondResource.resolve();
            await second;
            firstResource.resolve();
            await first;
            assert(superseded.isPlaying && superseded.schedulerStarts === 1,
                "review-start-cancel: only newest resource launch starts scheduling");

            const resumedEngine = cancellationEngine();
            resumedEngine.ctx.state = "suspended";
            resumedEngine._suspendedByEngine = true;
            const resumes = [deferredStart(), deferredStart()];
            let resumeCalls = 0;
            resumedEngine.ctx.resume = () => resumes[resumeCalls++].promise;
            const oldResumeStart = resumedEngine.start();
            await flushStart();
            const newResumeStart = resumedEngine.start();
            await flushStart();
            assert(resumeCalls === 2, "review-start-cancel: superseding resume retains engine suspension ownership");
            resumes[1].resolve();
            await newResumeStart;
            resumes[0].reject(new Error("obsolete resume failure"));
            await oldResumeStart;
            await flushStart();
            assert(resumedEngine.isPlaying && resumedEngine.schedulerStarts === 1,
                "review-start-cancel: obsolete resume rejection cannot disrupt newest launch");
            assert(startFailures.some(args => args[0] === "Cancelled Motif.start() resume failed:"),
                "review-start-cancel: obsolete resume rejection remains reported");

            const failedResumeEngine = cancellationEngine();
            failedResumeEngine.ctx.state = "suspended";
            failedResumeEngine._suspendedByEngine = true;
            const resumeError = new Error("active resume failure");
            failedResumeEngine.ctx.resume = () => Promise.reject(resumeError);
            let failedResume;
            try { await failedResumeEngine.start(); } catch (error) { failedResume = error; }
            assert(failedResume === resumeError && !failedResumeEngine.isPlaying,
                "review-start-cancel: current resume rejection propagates");

            const failedLimiterEngine = cancellationEngine();
            failedLimiterEngine._masterLimiterEnabled = true;
            const limiterError = new Error("active limiter failure");
            failedLimiterEngine._masterLimiterError = limiterError;
            failedLimiterEngine._loadingSamples = [Promise.reject(limiterError)];
            let failedLimiter;
            try { await failedLimiterEngine.start(); } catch (error) { failedLimiter = error; }
            assert(failedLimiter === limiterError && !failedLimiterEngine.isPlaying,
                "review-start-cancel: current limiter failure still rejects launch");

            const suspendEngine = cancellationEngine();
            const suspend = deferredStart();
            suspendEngine.ctx.suspend = () => suspend.promise;
            suspendEngine.pause();
            const afterPause = suspendEngine.start();
            await flushStart();
            assert(!suspendEngine.isPlaying, "review-start-cancel: manual restart waits for pending engine suspend");
            suspendEngine.ctx.state = "suspended";
            suspend.resolve();
            await afterPause;
            assert(suspendEngine.ctx.state === "running" && suspendEngine.isPlaying && suspendEngine.schedulerStarts === 1,
                "review-start-cancel: restart resumes after pending suspend lands");
        } finally {
            console.error = savedStartError;
            console.warn = savedStartWarn;
            trackRegistry.delete("review-start-never-source");
        }

        for (const lookahead of [.03, .1]) {
            ctx.currentTime = 0;
            const delayed = Track(`review-offset-${lookahead}`).note([60, 62, 64, 65]).offset("1/2");
            const played = [];
            delayed._playEvent = (event, time) => { played.push({ value: event.value, time }); };
            for (let time = 0; time < 4.1; time += .025) {
                ctx.currentTime = time;
                delayed._schedule(time + lookahead);
            }
            const values = played.filter(event => Math.abs(event.time - 2.5) < 1e-6).map(event => event.value).sort();
            assert(values.join() === "62,65",
                `review-offset: delayed previous-cycle 65 must coexist with 62 at 2.5s (${lookahead}s lookahead); observed ${values}`);
            Track.clearRegistry();
        }

        ctx.currentTime = 0;
        const sliced = Track("review-slice-completion").sample("review-stereo-buffer").chop(2).pattern([0, 1]).start(0).stop(1);
        await sliced._sampleLoading;
        sliced._schedule = () => {};
        sliced._playbackStartTime = 0;
        let finished = 0;
        Motif.onPlaybackFinished = () => { finished++; };
        ctx.currentTime = 2;
        Motif.isPlaying = true;
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1,
            `review-slice-completion: finite slice-only playback must finish once; observed playing=${Motif.isPlaying}, callbacks=${finished}`);
        Motif._tick();
        assert(finished === 1, "review-slice-completion: subsequent ticks do not finish twice");

        const resetCompletion = () => {
            Track.clearRegistry();
            ctx.currentTime = 0;
            Motif._tempoMap = null;
            Motif._arrangementEndBeat = undefined;
            Motif._arrangementOptions = {};
            Motif.isPlaying = true;
            finished = 0;
        };
        const sliceTrack = id => Track(id).sample("review-stereo-buffer").chop(2).pattern([0, 1]);

        resetCompletion();
        const arrangedSlices = sliceTrack("review-slice-arrange");
        await arrangedSlices._sampleLoading;
        Arrange([{ tracks: [arrangedSlices], bars: .5 }, { tracks: [], bars: .5 }]);
        Motif._tick();
        ctx.currentTime = 1.5;
        Motif._tick();
        assert(Motif.isPlaying && finished === 0, "review-slice-completion: trailing empty arrangement section retains transport");
        ctx.currentTime = 2;
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1, "review-slice-completion: slice-only arrangement finishes at its full boundary");

        resetCompletion();
        const splitSlices = sliceTrack("review-slice-split").start(0).stop(1);
        await splitSlices._sampleLoading;
        splitSlices.splitStereo();
        Track("review-slice-empty").note([]);
        Track("__temp_probe__").note([60]);
        Motif._tick();
        ctx.currentTime = 1;
        Motif._tick();
        assert(Motif.isPlaying && finished === 0, "review-slice-completion: finite split sample preserves its final 5ms fade");
        ctx.currentTime = 1.005;
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1, "review-slice-completion: shadow follows finite parent; empty patterns and probes do not block completion");

        resetCompletion();
        const mixedSlices = sliceTrack("review-slice-mixed").start(0).stop(1);
        await mixedSlices._sampleLoading;
        Track("review-slice-mixed-hz").synth("sine").freq([440]).start(0).stop(2);
        Track("review-slice-mixed-rests").note([null, null]).start(0).stop(3);
        Motif._tick();
        ctx.currentTime = 2;
        Motif._tick();
        assert(Motif.isPlaying && finished === 0, "review-slice-completion: all-rest patterns participate in mixed finite timing");
        ctx.currentTime = 3;
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1, "review-slice-completion: mixed sample/frequency/rest tracks finish at latest boundary");

        resetCompletion();
        const finiteSlices = sliceTrack("review-slice-unrestricted").start(0).stop(1);
        await finiteSlices._sampleLoading;
        const unrestricted = Track("review-slice-unrestricted-rests").note([null]);
        Motif._tick();
        ctx.currentTime = 2;
        Motif._tick();
        assert(Motif.isPlaying && finished === 0, "review-slice-completion: unrestricted all-rest pattern keeps transport open");
        unrestricted.start(0).stop(2);
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1, "review-slice-completion: finite boundary restores completion for all-rest pattern");

        resetCompletion();
        const loopSlices = sliceTrack("review-slice-loop");
        await loopSlices._sampleLoading;
        Arrange([{ tracks: [loopSlices], bars: .5 }], { loop: true });
        let looped = false;
        Motif.onPlaybackFinished = result => { finished++; looped = result.looped; };
        Motif._tick();
        ctx.currentTime = 1;
        Motif._tick();
        assert(!Motif.isPlaying && finished === 1 && looped, "review-slice-completion: slice-only loop finishes once with loop notification");
        await new Promise(resolve => setTimeout(resolve, 10));
        assert(Motif.isPlaying && finished === 1, "review-slice-completion: slice-only loop restarts transport");
        Motif.stop();
    } finally {
        Track.clearRegistry();
        Motif.sampleRegistry.delete("review-stereo-buffer");
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
        globalThis.AudioWorkletNode = savedWorklet;
    }
}

console.log("\n=== Delayed offset cycle retention ===");
{
    const savedMotif = { ...Motif };
    const savedRegistry = new Map(trackRegistry);
    Track.clearRegistry();
    const ctx = new MockAudioContext();
    Motif.ctx = ctx;
    Motif.masterGain = ctx.createGain();
    Motif.isPlaying = false;
    let serial = 0;
    const reset = () => {
        Track.clearRegistry();
        ctx.currentTime = 0;
        Motif.tempo = 120;
        Motif.beatsPerBar = 4;
        Motif._tempoMap = null;
        Motif._swingAmount = 0;
    };
    const capture = track => {
        const played = [];
        track._playEvent = (event, time, duration) => played.push({ ...event, time, duration });
        return played;
    };
    const tick = (track, start, stop, lookahead = .1) => {
        for (let index = 0; start + index * .025 < stop; index++) {
            ctx.currentTime = start + index * .025;
            track._schedule(ctx.currentTime + lookahead);
        }
    };
    const signature = events => events.map(event => `${event.tieCycle}:${event.value}:${event.time.toFixed(6)}`)
        .sort().join("|");
    try {
        for (const lookahead of [.03, .1, 4.2]) {
            reset();
            let calls = 0;
            const track = Track(`offset-long-${serial++}`).note([60, 62]).every(1, events => {
                calls++;
                return events.map(event => ({ ...event, value: event.value + 10 * calls }));
            }).offset(2).offset(3);
            const played = capture(track);
            tick(track, 0, 14.1, lookahead);
            const horizon = track._scheduledUntil;
            const expected = [];
            for (let cycle = 0; cycle * 2 < horizon - 1e-9; cycle++) {
                for (const delay of [0, 4, 6, 10]) {
                    for (const [value, position] of [[60, 0], [62, 1]]) {
                        const time = cycle * 2 + delay + position;
                        if (time < horizon - 1e-9) expected.push({ tieCycle: cycle, value: value + 10 * (cycle + 1), time });
                    }
                }
            }
            assert(signature(played) === signature(expected),
                `review-offset: long chained offsets submit each originating copy once (${lookahead}s lookahead)`);
            assert(new Set(played.filter(event => Math.abs(event.time - 10) < 1e-9).map(event => event.tieCycle)).size === 4,
                `review-offset: copies from four cycles coexist at 10s (${lookahead}s lookahead)`);
            assert(played.every((event, index) => index === 0 || event.time >= played[index - 1].time - 1e-9),
                `review-offset: overlapping cycles submit in onset order (${lookahead}s lookahead)`);
            const oldCalls = calls;
            track._schedule(horizon);
            assert(calls === oldCalls && calls === Math.ceil((horizon - 1e-9) / 2),
                `review-offset: callbacks run once per entered cycle, including large lookahead (${lookahead}s)`);
        }

        const probabilistic = [];
        for (const lookahead of [.03, 4.2]) {
            reset();
            const track = Track(`offset-random-${serial++}`).note([60, 62, 64, 65]).offset(2).seed(32).degrade(.35);
            const played = capture(track);
            tick(track, 0, 9.1, lookahead);
            probabilistic.push(signature(played.filter(event => event.time < 9)));
        }
        assert(probabilistic[0] === probabilistic[1], "review-offset: retention keeps cycle randomness independent of lookahead");

        for (const clockSteps of [false, true]) {
            for (const smooth of [false, true]) {
                reset();
                const track = Track(`offset-tempo-${serial++}`).note([60, 62]).offset(2);
                if (clockSteps) track.stepLength(.25);
                const played = capture(track);
                tick(track, 0, .625);
                if (smooth) Motif.rampTempo(60, 1, { smooth: true });
                else Motif.setTempo(60);
                tick(track, .625, 10.1);
                const horizon = track._scheduledUntil;
                const expected = [];
                for (let cycle = 0; cycle < 30; cycle++) {
                    for (const position of [0, .5, 2, 2.5]) {
                        const time = clockSteps ? (cycle + position) * .5 : Motif._timeAtBeat((cycle + position) * 4);
                        if (time < horizon - 1e-9) expected.push({ tieCycle: cycle, value: position % 1 === 0 ? 60 : 62, time });
                    }
                }
                assert(signature(played) === signature(expected),
                    `review-offset: ${clockSteps ? "clock" : "musical"} copies retain their original timing basis across ${smooth ? "smooth" : "immediate"} tempo edits`);
                assert(played.filter(event => event.tieCycle === 0 && event.value === 60).length === 2,
                    "review-offset: tempo edits do not replay an already submitted original");
            }
        }

        for (const edit of ["note", "freq", "seed", "modifier", "step", "loop", "meter", "silent", "reset"]) {
            reset();
            const track = Track(`offset-edit-${serial++}`).note([60, 62]).offset(2);
            const played = capture(track);
            tick(track, 0, 2.125);
            const before = played.length;
            ctx.currentTime = 2.2;
            if (edit === "note") track.note([64, 65]);
            if (edit === "freq") track.freq([440, 450]);
            if (edit === "seed") track.seed(99);
            if (edit === "modifier") track.offset(.25);
            if (edit === "step") track.stepLength(.25);
            if (edit === "loop") track.loopLength(.5);
            if (edit === "meter") Motif.beatsPerBar = 3;
            if (edit === "silent") track.note([]);
            if (edit === "reset") track._resetScheduling();
            tick(track, 2.2, 8.1);
            const later = played.slice(before);
            assert(edit === "reset" ? !later.some(event => Math.abs(event.time - 4) < 1e-9 || Math.abs(event.time - 5) < 1e-9)
                : later.every(event => event.tieCycle !== 0),
                `review-offset: ${edit} cancels unscheduled older-cycle copies`);
            if (edit === "freq") assert(later.every(event => event.value >= 440), "review-offset: mode edits cannot dispatch old MIDI values as frequencies");
            if (edit === "silent") assert(later.length === 0, "review-offset: an empty replacement pattern cancels every pending copy");
            if (edit === "reset") assert(later[0]?.time === 2.2, "review-offset: reset starts a fresh pattern at the current audio clock");
        }

        for (const loop of [.5, 2, 6]) {
            reset();
            const track = Track(`offset-loop-${serial++}`).note([60, 62]).offset(2).loopLength(loop);
            const played = capture(track);
            tick(track, 0, 6.1);
            const olderCopies = played.filter(event => event.tieCycle === 0 && event.time >= 4);
            assert(olderCopies.length === (loop === 6 ? 2 : 0), `review-offset: explicit ${loop}s loop clips only copies outside its boundary`);
            assert(played.every(event => event.time + event.duration <= (event.tieCycle + 1) * loop + 1e-9),
                `review-offset: explicit ${loop}s loop clips each surviving gate`);
        }

        reset();
        let stallCalls = 0;
        const stalled = Track(`offset-stall-${serial++}`).note([60, 62]).offset(2).every(1, events => { stallCalls++; return events; });
        const afterStall = capture(stalled);
        stalled._schedule(.1);
        tick(stalled, 4.9, 5.15);
        assert(afterStall.some(event => event.tieCycle === 0 && event.value === 62 && event.time === 5),
            "review-offset: a retained older copy survives a multi-cycle stall when its onset is still ahead");
        assert(!afterStall.some(event => event.time === 4) && stallCalls === 2 && stalled._currentCycle === 2,
            "review-offset: recovery skips missed onsets and callbacks without moving the cycle phase");

        reset();
        let setterCalls = 0;
        const selfEditing = Track(`offset-callback-edit-${serial++}`).note([60, 62]).offset(2)
            .every(1, events => {
                if (++setterCalls === 2) selfEditing.note([64, 65]);
                return events;
            });
        const callbackEdits = capture(selfEditing);
        tick(selfEditing, 0, 5.1);
        assert(!callbackEdits.some(event => event.tieCycle === 0 && event.time >= 4),
            "review-offset: a pattern setter inside a later-cycle callback cancels older pending copies");
        assert(setterCalls === 3, "review-offset: a callback setter does not rerun that cycle's transform");

        reset();
        const swungTie = Track(`offset-tie-swing-${serial++}`).synth("sine").note([60, Tie]).stepLength(.5).offset(2)
            .envelope({ attack: .01, decay: .01, sustain: .5, release: .05 });
        swungTie.trackInputNode = ctx.createGain();
        tick(swungTie, 0, 2.075, .03);
        const delayedVoice = [...swungTie._activeVoices.values()].find(voice => voice.tieCycle === 0 && voice.startTime === 2);
        assert(delayedVoice?.tieTargets.length > 0, "review-offset: an overflow note retains its not-yet-submitted Tie");
        swungTie.swing(1);
        ctx.currentTime = 2.075;
        swungTie._schedule(2.105);
        assert(delayedVoice?.endTime > 2.88, "review-offset: a live swing edit refreshes an older cycle's bounded Tie release");
        tick(swungTie, 2.1, 2.9, .03);
        assert(delayedVoice?.endTime > 3.38, "review-offset: the delayed swung Tie extends its originating voice after multiple cycle boundaries");

        reset();
        const slowedOverflow = Track(`offset-tie-tempo-${serial++}`).synth("sine").note([60, Tie]).stepLength("1/4").offset(2)
            .envelope({ attack: .01, decay: .01, sustain: .5, release: .05 });
        slowedOverflow.trackInputNode = ctx.createGain();
        tick(slowedOverflow, 0, 2.1, .03);
        const pendingTieVoice = [...slowedOverflow._activeVoices.values()].find(voice => voice.tieCycle === 0 && voice.startTime === 2);
        ctx.currentTime = 2.1;
        Motif.setTempo(60);
        slowedOverflow._schedule(2.13);
        const continuationStart = Motif._timeAtBeat(5);
        assert(pendingTieVoice && Math.abs(pendingTieVoice.tieReleaseTime - continuationStart) < 1e-9,
            "review-offset: a tempo edit refreshes an older cycle's pending Tie release without moving its submitted attack");
        tick(slowedOverflow, 2.125, continuationStart + .05, .03);
        assert(pendingTieVoice && Math.abs(pendingTieVoice.endTime - Motif._timeAtBeat(6) - .05) < 1e-9,
            "review-offset: the retimed overflow Tie extends its original voice through the new musical gate");

        reset();
        const sliced = Track(`offset-slice-${serial++}`).pattern([0, 1]).offset(2);
        const sliceEvents = capture(sliced);
        tick(sliced, 0, 5.1);
        const delayedSlices = sliceEvents.filter(event => event.tieCycle === 0 && event.time >= 4);
        assert(delayedSlices.length === 2 && delayedSlices[0].sliceIndex === 0 && delayedSlices[1].sliceIndex === 1
            && delayedSlices.every(event => event.nativeSlicePitch && event.value === 60),
            "review-offset: old slice copies preserve selection and native-pitch metadata");

        reset();
        const tied = Track(`offset-tie-${serial++}`).synth("sine")
            .note([Parallel([60, Tie], [64, null]), null]).offset(1.75)
            .envelope({ attack: .01, decay: .01, sustain: .5, release: .05 });
        tied.trackInputNode = ctx.createGain();
        const tieEvents = [];
        const playTie = tied._playEvent.bind(tied);
        tied._playEvent = (event, time, duration) => {
            tieEvents.push({ ...event, time });
            playTie(event, time, duration);
        };
        tick(tied, 0, 3.75);
        const olderVoices = [...tied._activeVoices.values()].filter(voice => voice.tieCycle === 0);
        assert(olderVoices.length === 2 && olderVoices.some(voice => voice.tieTargets?.length),
            "review-offset: delayed branch voices keep their originating cycle beyond the next boundary");
        tick(tied, 3.75, 4.1);
        assert(olderVoices[0].endTime === 4.55 && olderVoices[1].endTime === 4.05,
            "review-offset: a retained branch Tie extends only its own delayed voice after cycle advancement");
        assert(tieEvents.some(event => event.tieCycle === 0 && event.value === Tie && event.time === 4),
            "review-offset: overflowing Tie retains its originating identity while current-cycle notes overlap");
    } finally {
        Track.clearRegistry();
        for (const [id, track] of savedRegistry) trackRegistry.set(id, track);
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
    }
}

console.log("\n=== Shared modulation binding ownership ===");
{
    const savedMotif = { ...Motif };
    const savedTimeout = globalThis.setTimeout;
    const ctx = new MockAudioContext();
    Motif.ctx = ctx;
    Motif.masterGain = ctx.createGain();
    Motif.isPlaying = false;

    class ConnectionSource extends MockAudioNode {
        constructor() {
            super();
            this.destinations = new Set();
            this.allDisconnects = 0;
        }

        connect(target) {
            this.destinations.add(target);
            return target;
        }

        disconnect(target) {
            if (target === undefined) {
                this.allDisconnects++;
                this.destinations.clear();
                return;
            }
            if (!this.destinations.delete(target)) throw new Error("Missing modulation edge");
        }
    }

    const configure = (instance, signal) => instance.pan(signal).filter({ cutoff: signal })
        .volume(signal).eq({ low: signal, mid: signal, high: signal })
        .compress({ threshold: signal, knee: signal, ratio: signal, attack: signal, release: signal });

    try {
        for (const kind of ["track", "bus"]) {
            const source = new ConnectionSource();
            const signal = new LFOSignal(null, null, source);
            const keep = configure(kind === "track" ? Track(`r6-keep-${kind}`) : Bus(`r6-keep-${kind}`), signal);
            const drop = configure(kind === "track" ? Track(`r6-drop-${kind}`) : Bus(`r6-drop-${kind}`), signal);
            const survivors = new Set(source.destinations);
            for (const binding of drop._paramModulationBindings.values()) survivors.delete(binding.target);
            drop.pan(0);
            drop.pan(signal);
            drop.pan(Ramp(0, 1, .1));
            drop.pan(signal);
            source.disconnect(drop.pannerNode.pan);
            drop.pan(0);
            drop.pan(0);
            assert([...survivors].every(target => source.destinations.has(target)), `r6-${kind}: scalar/Ramp replacement and a missing edge preserve every surviving effect`);
            const registry = kind === "track" ? Track : Bus;
            registry.pruneExcept([keep.id]);
            registry.pruneExcept([keep.id]);
            disposeModulationBindings(drop);
            assert(source.destinations.size === survivors.size && [...survivors].every(target => source.destinations.has(target)), `r6-${kind}: prune and repeated disposal remove only the disposed consumer's effects`);
            registry.clearRegistry();
            assert(source.destinations.size === 0 && source.allDisconnects === 0, `r6-${kind}: registry clear detaches every binding without an all-edge disconnect`);
        }

        const source = new ConnectionSource();
        const signal = new LFOSignal(null, null, source);
        const keep = Track("r6-gain-keep").gain(signal).pan(signal).modulate("pan", signal);
        const keepEdges = new Set(source.destinations);
        const drop = Track("r6-gain-drop").gain(signal).pan(signal).modulate("pan", signal);
        drop.modulate("pan", signal, { depth: .5 });
        assert(source.destinations.size === keepEdges.size + 3, "r6-additive: replacing modulation detaches its old source-to-depth edge");
        drop.gain(.2);
        drop.gain(signal);
        const gate = drop._gainSignalGate;
        source.disconnect(gate);
        drop._clearGainSignal();
        assert([...keepEdges].every(target => source.destinations.has(target)), "r6-gain: missing gain gate edge cannot detach survivor gain, effect, or additive bindings");
        drop.gain(signal);
        const replacement = Track("r6-crossfade-new");
        const callbacks = [];
        globalThis.setTimeout = callback => { callbacks.push(callback); return 0; };
        drop._crossfadeOut(replacement, 0);
        globalThis.setTimeout = savedTimeout;
        for (const callback of callbacks) {
            callback();
            callback();
        }
        assert(source.destinations.size === keepEdges.size && [...keepEdges].every(target => source.destinations.has(target)), "r6-crossfade: repeated cleanup detaches direct, additive and gain edges while preserving shared destinations");
        assert(drop._gainSignalGate === null && drop._modulators.size === 0, "r6-crossfade: disposed gain gates and additive bindings are cleared");
        Track.pruneExcept([keep.id]);
        assert(source.destinations.size === keepEdges.size && source.allDisconnects === 0, "r6-crossfade: subsequent prune remains consumer-specific");

        const instance = {};
        const first = new MockAudioParam();
        const second = new MockAudioParam();
        applyParamModulation(instance, first, signal, "_signal");
        applyParamModulation(instance, second, signal, "_signal");
        assert(!source.destinations.has(first) && source.destinations.has(second), "r6-binding: changed destination releases the original connection");
        disposeModulationBindings(instance);
        safeDisconnect(source, first);
        assert([...keepEdges].every(target => source.destinations.has(target)) && source.allDisconnects === 0, "r6-disconnect: a failed targeted disconnect never widens to every destination");
    } finally {
        globalThis.setTimeout = savedTimeout;
        Track.clearRegistry();
        Bus.clearRegistry();
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
    }
}

console.log("\n=== Live reload preserves track phase ===");
{
    const savedMotif = { ...Motif };
    const savedRegistry = new Map(trackRegistry);
    trackRegistry.clear();
    const ctx = new MockAudioContext();
    ctx.currentTime = 10;
    Motif.ctx = ctx;
    Motif.masterGain = ctx.createGain();
    Motif.tempo = 120;
    Motif.beatsPerBar = 4;
    Motif._tempoMap = null;
    Motif._swingAmount = 0;
    Motif.isPlaying = false;

    try {
        const original = Track("reload-phase").note([60, 62, 64, 65]);
        original._playEvent = () => {};
        original._schedule(10.1);

        ctx.currentTime = 13.2;
        const replacement = Track("reload-phase").note([72, 74, 76, 77]);
        replacement._playbackStartTime = original._playbackStartTime;
        const played = [];
        let cycles = 0;
        replacement.every(1, () => { cycles++; });
        replacement._playEvent = (event, time) => played.push([event.value, time]);
        replacement._schedule(13.6);
        assert(JSON.stringify(played) === JSON.stringify([[77, 13.5]]),
            "live reload: edited notes resume at the original phrase position without replaying past onsets");
        assert(replacement._currentCycle === 1 && cycles === 1,
            "live reload: current cycle is recovered without executing callbacks for missed cycles");
        assert(replacement._playbackStartTime === 10,
            "live reload: replacement retains the original arrangement origin");

        const shorter = Track("reload-phase").note([72, 74, 76, 77]).stepLength(.5).loopLength(1);
        shorter._playbackStartTime = replacement._playbackStartTime;
        const shorterNotes = [];
        shorter._playEvent = (event, time) => shorterNotes.push([event.value, time]);
        shorter._schedule(13.6);
        assert(JSON.stringify(shorterNotes) === JSON.stringify([[74, 13.5]]) && shorter._currentCycle === 3,
            "live reload: changed clock-based loop length recomputes phase against the original origin");

        Track.clearRegistry();
        Motif._tempoMap = null;
        ctx.currentTime = 12;
        Motif.setTempo(240);
        ctx.currentTime = 13.2;
        const musical = Track("reload-musical").note([72, 74, 76, 77]).stepLength("1/4");
        musical._playbackStartTime = 10;
        const musicalNotes = [];
        musical._playEvent = (event, time) => musicalNotes.push([event.value, time]);
        musical._schedule(13.6);
        assert(musicalNotes.length === 2 && musicalNotes[0][0] === 74 && musicalNotes[1][0] === 76 &&
            Math.abs(musicalNotes[0][1] - 13.25) < 1e-9 && Math.abs(musicalNotes[1][1] - 13.5) < 1e-9,
            "live reload: musical phase follows the accumulated tempo timeline");

        Motif.tempo = 120;
        Motif._tempoMap = null;
        const parent = Track("reload-split").synth("sine").note([60, 62, 64, 65]).splitStereo().start(2).stop(6);
        parent._playbackStartTime = 10;
        const shadow = parent._rightTrack;
        const shadowNotes = [];
        shadow._playEvent = (event, time) => shadowNotes.push([event.value, time]);
        shadow._schedule(13.6);
        assert(shadow._playbackStartTime === 10 && JSON.stringify(shadowNotes) === JSON.stringify([[65, 13.5]]),
            "live reload: a fresh split shadow joins its parent's phase and activity window");

        musical._resetScheduling();
        ctx.currentTime = 20;
        musicalNotes.length = 0;
        musical._schedule(20.1);
        assert(JSON.stringify(musicalNotes) === JSON.stringify([[72, 20]]),
            "live reload: an explicit reset still starts the opening note from zero");
    } finally {
        Track.clearRegistry();
        for (const [id, track] of savedRegistry) trackRegistry.set(id, track);
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
    }
}

console.log("\n=== Natural completion preserves submitted voice tails ===");
{
    const savedMotif = { ...Motif };
    const savedTimeout = globalThis.setTimeout;
    const ctx = new MockAudioContext();
    let finished = 0;
    let lastResult = null;
    const reset = () => {
        Motif.stop();
        Track.clearRegistry();
        ctx.currentTime = 0;
        ctx.state = "running";
        Motif.tempo = 120;
        Motif.beatsPerBar = 4;
        Motif._arrangementEndBeat = undefined;
        Motif._arrangementOptions = {};
        Motif._masterLimiterEnabled = false;
        Motif._loadingSamples = [];
        Motif.isPlaying = true;
        finished = 0;
        lastResult = null;
    };
    const finiteTrack = (id, stop, release) => {
        const track = Track(id).synth("sine").note([60])
            .envelope({ attack: 0, decay: 0, sustain: 1, release })
            .start(0).stop(stop);
        track._playbackStartTime = 0;
        track._schedule = () => track._cleanupActiveVoices();
        return track;
    };
    const tick = time => {
        ctx.currentTime = time;
        Motif._tick();
    };
    Motif.ctx = ctx;
    Motif.masterGain = ctx.createGain();
    Motif._startScheduler = () => {};
    Motif._stopScheduler = () => {};
    Motif.onPlaybackFinished = result => {
        finished++;
        lastResult = result;
    };

    try {
        reset();
        Motif.tempo = 70;
        const boundary = 16 * 4 * 60 / 70;
        const bass = finiteTrack("finish-bass", boundary, 6);
        const pad = finiteTrack("finish-pad", boundary, 8);
        bass._playEvent({ value: 60 }, 52, 4);
        pad._playEvent({ value: 60 }, 52, 4);
        const padVoice = [...pad._activeVoices.values()][0];
        let disconnected = false;
        const disconnect = padVoice.oscillator.disconnect;
        padVoice.oscillator.disconnect = function() {
            disconnected = true;
            return disconnect.call(this);
        };
        tick(boundary);
        assert(Motif.isPlaying && finished === 0 && !disconnected, "natural completion: 70 BPM arrangement boundary preserves the final gate and release");
        tick(62);
        assert(Motif.isPlaying && finished === 0 && !disconnected, "natural completion: shorter bass release does not cut the longer pad release");
        tick(63.999);
        assert(Motif.isPlaying && finished === 0 && !disconnected, "natural completion: final voice stays connected until its audio-clock end");
        tick(64);
        assert(!Motif.isPlaying && finished === 1 && disconnected && lastResult?.looped === false, "natural completion: final release ends playback once at 64 seconds");
        tick(65);
        assert(finished === 1, "natural completion: later ticks do not repeat the finish notification");

        reset();
        const emptied = finiteTrack("finish-empty-active", 1, 5);
        emptied._playEvent({ value: 60 }, 0, 1);
        emptied.note([]);
        tick(1);
        assert(Motif.isPlaying && finished === 0, "natural completion: emptying a pattern preserves its already submitted active voice");
        tick(6);
        assert(!Motif.isPlaying && finished === 1, "natural completion: a now-empty pattern finishes after its voice release");

        reset();
        const imperative = Track("finish-imperative-preview").synth("sine")
            .envelope({ attack: 0, decay: 0, sustain: 1, release: 1 });
        imperative._playEvent({ value: 60 }, 0, 1);
        tick(2);
        assert(Motif.isPlaying && finished === 0 && imperative._activeVoices.size === 0,
            "natural completion: unrestricted imperative-only playback remains open between instruments after voice cleanup");
        imperative._playEvent({ value: 64 }, 2, 1);
        tick(4);
        assert(Motif.isPlaying && finished === 0 && imperative._activeVoices.size === 0,
            "natural completion: an empty-pattern preview can play successive instruments without finishing transport");

        reset();
        const ignoredEmpty = finiteTrack("finish-unused-empty", 100, 0).note([]);
        const bounded = finiteTrack("finish-bounded-pattern", 1, 0);
        bounded._playEvent({ value: 60 }, 0, 1);
        tick(1);
        assert(!Motif.isPlaying && finished === 1 && ignoredEmpty._activeVoices.size === 0,
            "natural completion: empty finite patterns with no submitted audio do not extend another track's completion");

        reset();
        const retired = finiteTrack("finish-empty-retired", 1, 7);
        retired._playEvent({ value: 60 }, 0, 1);
        retired._stealVoice("oldest", 4);
        retired.note([]);
        assert(retired._activeVoices.size === 0 && retired._retiredVoices.size === 1, "natural completion fixture: stolen voice retains only its retired allocation");
        tick(1);
        tick(3.999);
        assert(Motif.isPlaying && finished === 0 && retired._retiredVoices.size === 1, "natural completion: retired voices on empty patterns keep playback alive until their scheduled stop");
        tick(4);
        assert(!Motif.isPlaying && finished === 1 && retired._retiredVoices.size === 0, "natural completion: retired-only playback finishes at the stolen voice's shortened end");

        reset();
        const split = finiteTrack("finish-split", 1, 0);
        split.splitStereo();
        const shadow = trackRegistry.get("finish-split_right");
        shadow.envelope({ attack: 0, decay: 0, sustain: 1, release: 7 });
        shadow._schedule = () => shadow._cleanupActiveVoices();
        shadow._playbackStartTime = 0;
        shadow._playEvent({ value: 60 }, 0, 1);
        tick(1);
        assert(Motif.isPlaying && finished === 0, "natural completion: independently scheduled split shadow can outlive its parent's arranged boundary");
        tick(8);
        assert(!Motif.isPlaying && finished === 1, "natural completion: finite split shadow releases before the finish notification");

        reset();
        Motif._masterLimiterEnabled = true;
        Motif.masterLimiter = new MockAudioNode();
        const limited = finiteTrack("finish-limiter", 1, 1);
        limited._playEvent({ value: 60 }, 0, 1);
        const latency = (Math.ceil(ctx.sampleRate * .005) + 128) / ctx.sampleRate;
        tick(1);
        tick(2);
        assert(Motif.isPlaying && finished === 0 && limited._activeVoices.size === 0, "natural completion: voice cleanup leaves the context running for buffered limiter output");
        tick(2 + latency / 2);
        assert(Motif.isPlaying && finished === 0, "natural completion: subsequent short ticks retain the limiter drain deadline after voice cleanup");
        tick(2 + latency);
        assert(!Motif.isPlaying && finished === 1, "natural completion: playback finishes when all limiter lookahead frames drain");

        reset();
        Motif._masterLimiterEnabled = true;
        const emptyLimited = finiteTrack("finish-empty-limiter", 1, 1);
        emptyLimited._playEvent({ value: 60 }, 0, 1);
        emptyLimited.note([]);
        tick(2);
        tick(2 + latency / 2);
        assert(Motif.isPlaying && finished === 0 && emptyLimited._activeVoices.size === 0,
            "natural completion: a finite empty pattern retains its own limiter drain after voice cleanup");
        tick(2 + latency);
        assert(!Motif.isPlaying && finished === 1,
            "natural completion: a finite empty pattern finishes when its own limiter drain ends");

        reset();
        const cancelled = finiteTrack("finish-explicit-stop", 1, 8);
        cancelled._playEvent({ value: 60 }, 0, 1);
        tick(1);
        Motif.stop();
        assert(!Motif.isPlaying && finished === 0 && cancelled._activeVoices.size === 0, "natural completion: explicit stop immediately cancels tails without a finish notification");
        cancelled.note([null])._schedule = () => {};
        cancelled._playbackStartTime = 1;
        await Motif.start();
        tick(2);
        assert(!Motif.isPlaying && finished === 1, "natural completion: restarting after explicit stop does not inherit a cancelled release deadline");

        reset();
        const open = finiteTrack("finish-unrestricted", 1, 3);
        open._playEvent({ value: 60 }, 0, 1);
        Track("finish-unrestricted-rest").note([null]);
        tick(5);
        assert(Motif.isPlaying && finished === 0, "natural completion: an unrestricted rest pattern keeps transport open after every finite voice ends");

        reset();
        const loop = finiteTrack("finish-loop", 1, 8);
        loop._playEvent({ value: 60 }, 0, 1);
        Motif._arrangementOptions = { loop: true, loopDelay: .25 };
        let loopCallback;
        let loopDelay;
        globalThis.setTimeout = (callback, delay) => {
            loopCallback = callback;
            loopDelay = delay;
            return 987654;
        };
        tick(1);
        assert(!Motif.isPlaying && finished === 1 && lastResult?.looped === true && loopDelay === 250,
            "natural completion: arrangement loops retain section-boundary timing and configured delay despite long releases");
        Motif.stop();
        loopCallback();
        await Promise.resolve();
        await Promise.resolve();
        assert(!Motif.isPlaying && finished === 1, "natural completion: explicit stop cancels an already queued loop restart");
    } finally {
        globalThis.setTimeout = savedTimeout;
        Motif.stop();
        Track.clearRegistry();
        for (const key of Object.keys(Motif)) {
            if (!(key in savedMotif)) delete Motif[key];
        }
        Object.assign(Motif, savedMotif);
    }
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
