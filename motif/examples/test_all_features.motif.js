// ============================================
// Comprehensive Motif.js Test Suite & Showcase
// ============================================
//
// This script systematically runs through EVERY feature of Motif.js one by one,
// with a 3-second silent pause between each test case.
//
// It tests:
// 1. Core Primitives (Nested Sequential Arrays, Rests, Ties)
// 2. Parallel chord triggers (Parallel)
// 3. Ramp continuous glides (Ramp)
// 4. Pattern Arithmetic (.add, .sub, .mul, .div)
// 5. Utility Conversions (noteToMidi, midiToNote, degreeToMidi, midiToHz)
// 6. Global Transport Controls & Tempo Ramping (Motif.setTempo, Motif.rampTempo)
// 7. Master Output Configuration (Motif.master EQ, limiter)
// 8. Synthesizer Types (sine, saw, fm, pluck, noise)
// 9. Envelope Configuration (envelope)
// 10. Track Gain & Volume (.gain, .volume)
// 11. Track Stereo Panning & LFO sweeps (.pan, LFO)
// 12. Waveshaper Distortion (.distort)
// 13. Track EQ (.eq)
// 14. Track Compression (.compress)
// 15. Voice Limits & Voice Stealing (.voices)
// 16. Polymeters & Time Stretching (.stepLength, .loopLength)
// 17. Higher-Order Transforms (.every, .mask, .offset)
// 18. Beat Subdivisions (.subdivide)
// 19. Global & Track Swing (.swing)
// 20. Generative Euclid Patterns (.euclid)
// 21. Stochastic Degrade & Markov Mutation (.degrade, .mutate)
// 22. Sample Playback & Global Registry Cache (.sample)
// 23. Pitch-shifting Multi-Samplers (.sampler)
// 24. Sample Chopping, Slicing & Time-Warping (.chop, .pattern, .fit)
// 25. Stereo Juxtaposition (.splitStereo)
// 26. Dynamic Signal Filter Control (.filter)
// 27. Audio-Rate Frequency Modulation (.modulate)
// 28. Sidechain Ducking (.sidechain)
// 29. Global FX Buses & Routing (Bus, .send)
// 30. Bus Feedback Delay Loops (bus.feedback)
// 31. Custom DSP AudioWorklets (.dsp)
// 32. Scale Degree Mapping (.scale)
// 33. Polyphonic Arpeggiation (.arp)
// 34. Microtonal Snapping & EDO (.tuning)
// 35. Algorithmic Voice Leading (.chordVoicing)
// 36. Macro Structure Arrangements (Arrange)
// 37. Asynchronous Preloading (Motif.loadSamples)
// 38. Generative Simplex Noise Modulation (SimplexNoise)
//
// -----------------------------------------------------------------------------
// INSTRUCTIONS:
// Paste this entire file into the "Motif Live Coder" playground editor.
// Open the browser console (Ctrl+Shift+I or Cmd+Opt+I) to watch the logs
// and listen to each feature playing sequentially!
// =============================================================================

// -----------------------------------------------------------------------------
// 1. Teardown System & Active Tracker
// -----------------------------------------------------------------------------
// Prevent overlapping loops if the code is recompiled or hot-reloaded
if (globalThis.__motif_test_suite_cancel__) {
    globalThis.__motif_test_suite_cancel__();
}

let active = true;

const cleanup = () => {
    Track.clearRegistry();
    Bus.clearRegistry();
};

globalThis.__motif_test_suite_cancel__ = () => {
    active = false;
    cleanup();
    console.log("%c[-] Terminated previous running test suite.", "color: #ef4444; font-weight: bold;");
};

// -----------------------------------------------------------------------------
// 2. High-Fidelity Mock Sample Generator
// -----------------------------------------------------------------------------
// Populate the Motif registry with high-fidelity synthetically generated mock drum
// samples, enabling immediate sample-based and slicing tests without any network requests!
const sampleRate = Motif.ctx ? Motif.ctx.sampleRate : 44100;

const createMockKick = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(1, sampleRate * 0.3, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const freq = 130 * Math.exp(-t * 22) + 38;
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 12);
    }
    return buffer;
};

const createMockSnare = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(1, sampleRate * 0.25, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const noise = Math.random() * 2 - 1;
        const sine = Math.sin(2 * Math.PI * 180 * t);
        data[i] = (noise * 0.7 + sine * 0.3) * Math.exp(-t * 9);
    }
    return buffer;
};

const createMockLoop = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(1, sampleRate * 2.0, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const beatIndex = Math.floor(t * 4);
        const timeWithinBeat = t - (beatIndex * 0.5);

        let sampleVal = 0;
        if (beatIndex % 2 === 0) {
            const freq = 90 * Math.exp(-timeWithinBeat * 24) + 42;
            sampleVal = Math.sin(2 * Math.PI * freq * timeWithinBeat) * Math.exp(-timeWithinBeat * 14);
        } else {
            const noise = Math.random() * 2 - 1;
            sampleVal = noise * Math.exp(-timeWithinBeat * 8) * 0.45;
        }

        // Add hihat ticks on subdivisions
        const subBeat = Math.floor(t * 8) % 2;
        if (subBeat === 1) {
            const timeWithinSub = t - (Math.floor(t * 8) * 0.25);
            sampleVal += (Math.random() * 2 - 1) * Math.exp(-timeWithinSub * 45) * 0.12;
        }

        data[i] = sampleVal;
    }
    return buffer;
};

if (Motif.ctx) {
    Motif.sampleRegistry.set("mock-kick", createMockKick());
    Motif.sampleRegistry.set("mock-snare", createMockSnare());
    Motif.sampleRegistry.set("mock-loop", createMockLoop());
}

// -----------------------------------------------------------------------------
// 3. Test Runner Framework
// -----------------------------------------------------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const runTest = async (id, name, callback) => {
    if (!active) return;
    console.log(`\n%c[TEST ${id}/38] RUNNING: ${name}`, "color: #3b82f6; font-weight: bold; font-size: 13px;");

    cleanup();

    // Restore basic defaults
    Motif.setTempo(120);
    Motif.swing(0);
    Motif.master({
        gain: 0.8,
        limiter: false,
        eq: { low: 0, mid: 0, high: 0 },
    });

    // Set up the specific test
    await callback();

    // Play for 4 seconds
    await sleep(4000);

    if (!active) return;

    // Silence all sounds and enter the silent pause
    cleanup();
    console.log(`%c[TEST ${id}/38] SILENT PAUSE (3s)...`, "color: #6b7280; font-style: italic;");
    await sleep(3000);
};

// -----------------------------------------------------------------------------
// 4. Test Suites Execution
// -----------------------------------------------------------------------------
return (async () => {
    console.log("%c==================================================================", "color: #c084fc; font-weight: bold;");
    console.log("%c   STARTING COMPREHENSIVE MOTIF.JS FEATURE SYMPHONY TEST RUNNER   ", "color: #c084fc; font-weight: bold;");
    console.log("%c==================================================================", "color: #c084fc; font-weight: bold;");

    // --- TEST 1: CORE PRIMITIVES (SEQUENTIAL, RESTS, TIES) ---
    await runTest(1, "Core Primitives (Nested Arrays, Rests, Ties)", () => {
        Track("primitives")
            .synth("sine")
            .note(["C4", Tie, "E4", null, "G4", Tie, Tie, null])
            .envelope({ attack: 0.05, decay: 0.1, sustain: 0.8, release: 0.2 })
            .gain(0.5);
    });

    // --- TEST 2: PARALLEL PRIMITIVES (CHORDS) ---
    await runTest(2, "Parallel Primitive (Simultaneous Chord Playback)", () => {
        Track("chords")
            .synth("sine")
            .note([
                Parallel("C4", "E4", "G4"),
                Parallel("F4", "A4", "C5"),
                Parallel("G4", "B4", "D5"),
                Parallel("C4", "E4", "G4"),
            ])
            .envelope({ attack: 0.1, decay: 0.2, sustain: 0.6, release: 0.4 })
            .gain(0.4);
    });

    // --- TEST 3: RAMP PRIMITIVES (PITCH GLIDES) ---
    await runTest(3, "Ramp Primitive (Continuous Pitch/Parameter Glides)", () => {
        Track("glides")
            .synth("saw")
            .note([
                Ramp("C3", "C4"),
                Ramp("C4", "G3"),
                "E4",
                null,
            ])
            .envelope({ attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.2 })
            .gain(0.4);
    });

    // --- TEST 4: PATTERN ARITHMETIC ---
    await runTest(4, "Pattern Mathematics (Cross-Product Arithmetic)", () => {
        const chord = ["C3", "E3", "G3"];
        const octaves = [0, 12];
        const transposed = chord.add(octaves); // Generates sequential C3, C4, E3, E4, G3, G4
        Track("pattern-math")
            .synth("pluck")
            .note(transposed)
            .gain(0.6);
    });

    // --- TEST 5: HELPER CONVERSIONS ---
    await runTest(5, "Helper Functions & Snaps (Note/MIDI/Hz Snaps)", () => {
        const midi = noteToMidi("A4");
        const note = midiToNote(60);
        const deg = degreeToMidi(2, "C3", "major"); // E3 (MIDI 52)
        const hz = midiToHz(69); // 440

        console.log(`  [Helpers] noteToMidi('A4') = ${midi} (expected 69)`);
        console.log(`  [Helpers] midiToNote(60) = '${note}' (expected 'C4')`);
        console.log(`  [Helpers] degreeToMidi(2, 'C3', 'major') = ${deg} (expected 52)`);
        console.log(`  [Helpers] midiToHz(69) = ${hz}Hz (expected 440Hz)`);

        Track("helpers")
            .synth("sine")
            .note([midi, note, deg, midiToNote(Math.round(12 * Math.log2(hz / 440) + 69))])
            .gain(0.5);
    });

    // --- TEST 6: GLOBAL TRANSPORT & TEMPO RAMPING ---
    await runTest(6, "Global Transport & Tempo Ramping", () => {
        Motif.setTempo(80);
        Track("tempo-ramp")
            .synth("square")
            .note(["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"])
            .gain(0.2);

        // Ramp tempo to 240 BPM over 4 seconds
        Motif.rampTempo(240, 4.0);
    });

    // --- TEST 7: MASTER OUTPUT CONFIGURATION ---
    await runTest(7, "Master Output Configuration (EQ, Limiter)", () => {
        Motif.master({
            gain: 0.85,
            limiter: { threshold: -8, knee: 15, ratio: 12, attack: 0.003, release: 0.15 },
            eq: { low: 4.0, mid: -2.0, high: 5.0 },
        });

        Track("master-bus")
            .synth("saw")
            .note(["C3", "Eb3", "G3", "Bb3"])
            .gain(0.7);
    });

    // --- TEST 8: SYNTHESIZER TYPES ---
    await runTest(8, "Synthesizer Types (sine, saw, fm, pluck, noise)", () => {
        Track("sine-showcase").synth("sine").note(["C4", null, null, null]).gain(0.35);
        Track("saw-showcase").synth("saw").note([null, "E4", null, null]).gain(0.2);
        Track("fm-showcase").synth("fm").note([null, null, "G4", null]).gain(0.3);
        Track("pluck-showcase").synth("pluck").note([null, null, null, "C5"]).gain(0.45);
        Track("noise-showcase").synth("noise").note([null, null, null, "C3"]).gain(0.12); // Only play on last beat to avoid bleed
    });

    // --- TEST 9: ENVELOPE CONFIGURATION ---
    await runTest(9, "Envelope Configuration (ADSR shaping)", () => {
        // Left: Fast pluck
        Track("envelope-pluck")
            .synth("saw")
            .note(["C4", "E4", "G4", "C5"])
            .envelope({ attack: 0.001, decay: 0.08, sustain: 0.0, release: 0.08 })
            .pan(-0.6)
            .gain(0.5);

        // Right: Long swelling pad
        Track("envelope-sweller")
            .synth("sine")
            .note([Parallel("C3", "G3")])
            .envelope({ attack: 1.5, decay: 0.5, sustain: 0.8, release: 1.5 })
            .pan(0.6)
            .gain(0.4);
    });

    // --- TEST 10: TRACK GAIN & VOLUME ---
    await runTest(10, "Track Gain & Volume (Scalars vs dB Strings)", () => {
        Track("gain-vol")
            .synth("pluck")
            .note(["C4", "E4", "G4", "C5"])
            .gain("-3dB")       // Decibel string parsing in .gain()!
            .volume("-15dB"); // Decibel level attenuation
    });

    // --- TEST 11: TRACK STEREO PANNING & LFO ---
    await runTest(11, "Track Stereo Panning & Reactive LFO Sweeps", () => {
        Track("pan-lfo")
            .synth("saw")
            .note(["C4", "E4", "G4", "B4", "D5", "B4", "G4", "E4"])
            .envelope({ attack: 0.02, decay: 0.15, sustain: 0.4, release: 0.2 })
            .pan(LFO.sine({ min: -1.0, max: 1.0, speed: "2b" })) // Auto-pan over 2 bars
            .gain(0.4);
    });

    // --- TEST 12: TRACK WAVESHAPER DISTORTION ---
    await runTest(12, "Track Waveshaper Distortion (Saturation)", () => {
        Track("distort")
            .synth("sine")
            .note(["C3", "G3", "C3", "Bb2"])
            .envelope({ attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.3 })
            .distort(45.0) // Heavy saturation generating rich harmonics
            .gain(0.45);
    });

    // --- TEST 13: TRACK EQ ---
    await runTest(13, "Track EQ (3-Band Peaking & Shelving Filter EQ)", () => {
        Track("eq")
            .synth("saw")
            .note(["C3", "G3", "C4", "G4"])
            .eq({
                low: { gain: 10.0, frequency: 160 }, // Massive bass boost
                mid: { gain: -15.0, frequency: 1000, Q: 3.0 }, // Mid-scoop
                high: { gain: 8.0, frequency: 5000 },  // Sparkling treble boost
            })
            .gain(0.3);
    });

    // --- TEST 14: TRACK COMPRESSION ---
    await runTest(14, "Track Compression (Dynamics Shaping)", () => {
        Track("compress")
            .synth("square")
            .note(["C4", "E4", "G4", "C5"])
            .compress({
                threshold: -32,
                ratio: 16,
                attack: 0.002,
                release: 0.06,
            })
            .gain(0.55);
    });

    // --- TEST 15: VOICE LIMITS & VOICE STEALING ---
    await runTest(15, "Voice Limits & Voice Stealing (Polyphony constraints)", () => {
        // 5 notes trigger simultaneously, but voice limit is strictly 2.
        // The engine steals the 'oldest' voice.
        Track("voices")
            .synth("sine")
            .note([Parallel("C4", "E4", "G4", "B4", "D5")])
            .voices(2, "oldest")
            .envelope({ attack: 0.2, decay: 0.8, sustain: 0.8, release: 0.5 })
            .gain(0.5);
    });

    // --- TEST 16: POLYMETERS & TIME STRETCHING ---
    await runTest(16, "Polymeters & Decoupled Loop Timing", () => {
        // A 5-step pattern running on 16th notes.
        // It loops and shifts alignment relative to the global 4/4 grid.
        Track("polymeter")
            .synth("pluck")
            .note(["C4", "D4", "E4", "F4", "G4"])
            .stepLength("1/16")
            .loopLength("1b")
            .gain(0.5);
    });

    // --- TEST 17: HIGHER-ORDER TRANSFORMS (EVERY, MASK, OFFSET) ---
    await runTest(17, "Higher-Order Transforms (Every, Mask, Offset)", () => {
        Track("transforms")
            .synth("pluck")
            .note(["C4", "E4", "G4", "B4"])
            .envelope({ attack: 0.005, decay: 0.12, sustain: 0.2, release: 0.15 })
            // 1. .every(cycles, modifier): Pitch down 1 octave, double speed, and reverse on cycle 2 using chainable MotifEventArray modifiers!
            .every(2, (events) => events.transpose(-12).fast(2).rev())
            // 2. .mask(booleanArray, modifier): Transpose step 0 and 2 up a perfect 5th (7 semitones)
            .mask([true, false, true, false], (e) => {
                if (typeof e.value === "string" && e.value !== "Tie") {
                    const m = noteToMidi(e.value);
                    if (m) e.value = midiToNote(m + 7);
                }
                return e;
            })
            // 3. .offset(timeShift, modifier): Add a pitch-doubled echo offset by an 8th note
            .offset("1/8", (e) => {
                if (typeof e.value === "string" && e.value !== "Tie") {
                    const m = noteToMidi(e.value);
                    if (m) e.value = midiToNote(m + 12);
                }
                return e;
            })
            .gain(0.45);
    });

    // --- TEST 18: BEAT SUBDIVISIONS ---
    await runTest(18, "Beat Subdivisions (Dynamic chunk subdivides)", () => {
        Track("subdivide")
            .synth("sine")
            .note(["C4", "E4"])
            .subdivide(4, (chunkEvents) => {
                // Double trigger the subdivision chunks
                return chunkEvents.flatMap(e => {
                    const e1 = { ...e, duration: e.duration / 2 };
                    const e2 = { ...e1, startTime: e1.startTime + e1.duration };
                    return [e1, e2];
                });
            })
            .envelope({ attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.1 })
            .gain(0.5);
    });

    // --- TEST 19: GLOBAL & TRACK SWING ---
    await runTest(19, "Global & Track Swing (Groove delay)", () => {
        Motif.swing(0.05); // Shift every second beat to introduce mild global shuffle

        Track("swing-test")
            .synth("pluck")
            .note(["C4", "E4", "G4", "B4", "C5", "B4", "G4", "E4"])
            .swing(0.2) // Override global swing with a stronger track-specific swing!
            .gain(0.6);
    });

    // --- TEST 20: GENERATIVE EUCLID PATTERNS ---
    await runTest(20, "Generative Euclid Patterns (Bjorklund Spacing)", () => {
        // 5 pulses evenly distributed across 8 steps E(5,8)
        Track("euclid")
            .synth("pluck")
            .euclid(5, 8)
            .envelope({ attack: 0.002, decay: 0.08, sustain: 0.0, release: 0.08 })
            .gain(0.6);
    });

    // --- TEST 21: STOCHASTIC DEGRADE & MARKKOV MUTATIONS ---
    await runTest(21, "Stochastic Degradation & Mutational Ratchets", () => {
        Track("stochastic")
            .synth("pluck")
            .note(["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"])
            .degrade(0.3) // 30% chance to drop note triggers
            .mutate({
                chance: 0.5,
                actions: {
                    ratchet: 2, // 50% chance to trigger subdivisions
                    reverse: 1,
                },
            })
            .gain(0.55);
    });

    // --- TEST 22: SAMPLE PLAYBACK & REGISTRY ---
    await runTest(22, "Sample Playback (Registry Cached Buffers)", () => {
        Track("sample-kick")
            .sample("mock-kick")
            .note(["C3", null, "C3", null])
            .gain(0.85);

        Track("sample-snare")
            .sample("mock-snare")
            .note([null, "C4", null, "C4"])
            .gain(0.6);
    });

    // --- TEST 23: MULTI-SAMPLE INSTRUMENT SAMPLERS ---
    await runTest(23, "Multi-Sample Instruments (Pitch-shifted sampler maps)", () => {
        Track("sampler")
            .sampler({
                urls: {
                    C3: "mock-kick",
                    C4: "mock-snare",
                },
                release: 0.3,
            })
            .note(["C3", "E3", "G3", "C4", "E4"]) // Gaps are auto pitch-shifted
            .gain(0.75);
    });

    // --- TEST 24: BREAKBEAT SLICING & TIME WARPING ---
    await runTest(24, "Breakbeat Slicing, Re-ordering & Time Warping", () => {
        Track("breakbeat")
            .sample("mock-loop")
            .chop(4)                          // Chop 2-second loop into 4 slices
            .pattern([0, 2, [1, 1], [3, 0]]) // Re-order slices dynamically

            // Warp playback speed with granular time-stretching
            .fit("1b", { mode: "stretch", grainSize: 0.05, overlap: 4 })
            .gain(0.8);
    });

    // --- TEST 25: STEREO JUXTAPOSITION ---
    await runTest(25, "Stereo Juxtaposition (.splitStereo processing)", () => {
        Track("stereo-jux")
            .synth("saw")
            .note(["C4", "D4", "E4", "F4"])
            .splitStereo((rightTrack) => {
                // Shift right channel up 12 semitones
                rightTrack.every(1, (events) => {
                    events.forEach(e => {
                        if (typeof e.value === "string") {
                            const m = noteToMidi(e.value);
                            if (m) e.value = midiToNote(m + 12);
                        }
                    });
                    return events;
                });
            })
            .gain(0.45);
    });

    // --- TEST 26: SIGNAL FILTERS & LFO CUTOFF ---
    await runTest(26, "Signal Filter Sweeps & Reactive LFO Modulation", () => {
        Track("filters")
            .synth("saw")
            .note([Parallel("C3", "E3", "G3")])
            .filter({
                type: "lowpass",
                cutoff: LFO.sine({ min: 150, max: 2000, speed: "4b" }), // Filter sweep over 4 bars
                resonance: 4.0,
            })
            .gain(0.38);
    });

    // --- TEST 27: AUDIO-RATE MODULATION (FM) ---
    await runTest(27, "Audio-Rate Modulation (Modulating parameters with track signal)", () => {
        // Carrier track - use 'saw' to provide harmonics for the filter to modulate!
        const carrier = Track("fm-carrier")
            .synth("saw")
            .note(["C3", "C3"])
            .gain(0.7);

        // Modulator track (muted from main mix, modulates carrier frequency)
        const modulator = Track("fm-modulator")
            .synth("sine")
            .note([120, 250, 400, 180])
            .gain(0.8)
            .mute(true);

        carrier.modulate("filter.cutoff", modulator, { depth: 800 });
    });

    // --- TEST 28: SIDECHAIN DUCKING ---
    await runTest(28, "Sidechain Ducking (Pumping duck compression)", () => {
        const kick = Track("duck-kick")
            .sample("mock-kick")
            .note(["C3", null, "C3", null])
            .gain(0.85);

        const bass = Track("duck-bass")
            .synth("saw")
            .note(["C3", "C3", "C3", "C3"])
            .sidechain(kick, { attack: 0.01, release: 0.18 }) // Duck bass when kick triggers
            .gain(0.65);
    });

    // --- TEST 29: GLOBAL FX BUS ROUTING ---
    await runTest(29, "Global FX Buses & Routing (Sends)", () => {
        const delayBus = Bus("spatial-delay")
            .filter({ type: "bandpass", cutoff: 1200 })
            .pan(LFO.triangle({ min: -0.8, max: 0.8, speed: "4b" }))
            .volume(-4);

        Track("fx-sender")
            .synth("pluck")
            .note(["C4", null, "E4", null, "G4", null, "C5", null])
            .send(delayBus, 0.75) // Send 75% to delay bus
            .gain(0.5);
    });

    // --- TEST 30: BUS FEEDBACK DELAY LOOPS ---
    await runTest(30, "Bus Feedback Delay Loops", () => {
        const feedbackBus = Bus("fb-delay")
            .filter({ type: "lowpass", cutoff: 800 })
            .feedback({ amount: 0.8 }); // 80% feedback decay loop

        Track("feedback-sender")
            .synth("pluck")
            .note(["C4", null, null, null])
            .send(feedbackBus, 0.85)
            .gain(0.55);
    });

    // --- TEST 31: NATIVE AUDIOWORKLET CUSTOM DSP ---
    await runTest(31, "Native AudioWorklet Custom DSP (Mathematical Synthesis)", () => {
        if (Motif.ctx && Motif.ctx.audioWorklet) {
            Track("worklet-dsp")
                .dsp((context) => {
                    // Dynamic folded wave synthesis inside worklet processor
                    let wave = Math.sin(context.p * Math.PI * 2);
                    return Math.abs(wave) * 2.0 - 1.0;
                })
                .note(["C4", "E4", "G4"])
                .gain(0.4);
        } else {
            console.log("  [DSP] AudioWorklet not supported/available in sandbox, running fallback sine.");
            Track("worklet-dsp")
                .synth("sine")
                .note(["C4", "E4", "G4"])
                .gain(0.4);
        }
    });

    // --- TEST 32: DIATONIC SCALE DEGREE SNAP ---
    await runTest(32, "Diatonic Scale Snap (Degree-based chords)", () => {
        Track("diatonic")
            .synth("sine")
            .note([Parallel(0, 2, 4), Parallel(3, 5, 7)]) // Snap steps to C Minor triad degrees
            .scale("C3", "minor")
            .envelope({ attack: 0.1, decay: 0.3, sustain: 0.5, release: 0.4 })
            .gain(0.45);
    });

    // --- TEST 33: POLYPHONIC ARPEGGIATION ---
    await runTest(33, "Polyphonic Arpeggiation (.arp up/down/upDown modes)", () => {
        Track("arpeggiator")
            .synth("pluck")
            .note([Parallel("C4", "E4", "G4", "B4")])
            .arp("upDown") // Unroll chords into arpeggios
            .stepLength("1/8")
            .gain(0.55);
    });

    // --- TEST 34: XENHARMONIC MICROTONALITY & EDO ---
    await runTest(34, "Xenharmonic Microtonality & EDO Tunings (17-EDO / Custom)", () => {
        Track("xenharmonic")
            .synth("sine")
            .note([60.0, 60.5, 61.25, 62.0]) // Microtonal scale degrees
            .tuning("17-EDO") // 17 Equal Divisions of the Octave
            .gain(0.5);
    });

    // --- TEST 35: ALGORITHMIC VOICE LEADING ---
    await runTest(35, "Algorithmic Voice Leading (.chordVoicing options)", () => {
        Track("voicing")
            .synth("sine")
            .note([
                Parallel("C4", "E4", "G4", "B4"), // Cmaj7
                Parallel("F4", "A4", "C5", "E5"),  // Fmaj7
            ])
            .chordVoicing({ mode: "smooth", drop: 2 }) // Smooth voicing and Drop-2 transposition
            .envelope({ attack: 0.1, decay: 0.4, sustain: 0.6, release: 0.5 })
            .gain(0.45);
    });

    // --- TEST 36: MACRO STRUCTURAL ARRANGEMENTS ---
    await runTest(36, "Macro Structural Arrangements (Arrange blocks)", () => {
        const bass = Track("arr-bass").synth("sine").note(["C3", "Eb3"]).gain(0.5);
        const lead = Track("arr-lead").synth("pluck").note([null, "C4", null, "G4"]).gain(0.4);

        Arrange([
            { bars: 1, tracks: [bass] },         // Bar 1: Bass only
            { bars: 1, tracks: [bass, lead] },    // Bar 2: Bass and Lead
        ]);
    });

    // --- TEST 37: ASYNCHRONOUS SAMPLE PRELOADING ---
    await runTest(37, "Asynchronous Sample Manifest Preloads", async () => {
        // Safely mock fetch and decodeAudioData to test preloading manifest flow cleanly!
        const originalFetch = globalThis.fetch;
        const originalDecode = Motif.ctx ? Motif.ctx.decodeAudioData : null;

        globalThis.fetch = async (url) => {
            if (url.includes("manifest.json")) {
                return {
                    ok: true,
                    json: async () => ({ "kick": "kick.wav", "snare": "snare.wav" }),
                };
            }
            return {
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(100),
            };
        };

        if (Motif.ctx && originalDecode) {
            Motif.ctx.decodeAudioData = (ab, resolve) => {
                resolve(createMockKick());
            };
        }

        console.log("  [Preload] Fetching manifest.json...");
        await Motif.loadSamples("manifest.json");
        console.log("  [Preload] Manifest loaded successfully!");

        // Restore original methods immediately
        globalThis.fetch = originalFetch;
        if (Motif.ctx && originalDecode) {
            Motif.ctx.decodeAudioData = originalDecode;
        }

        // Play a sequence using the preloaded asset key
        Track("preload-audio")
            .sample("kick") // Resolves straight to cached kick buffer
            .note(["C3", "C3", "C3", "C3"])
            .gain(0.85);
    });

    // --- TEST 38: GENERATIVE SIMPLEX NOISE MODULATION ---
    await runTest(38, "Generative Simplex Noise Modulation (SimplexNoise)", () => {
        const simplex = new SimplexNoise(12345);
        const pattern = [];
        // Generate 16 steps using 1D Simplex Noise mapped to scale degrees
        for (let i = 0; i < 16; i++) {
            const step = i * 0.35;
            const n = simplex.noise1D(step);

            // 1. Organic Rhythmic Rests
            if (simplex.noise1D(step + 100) < -0.3) {
                pattern.push(null);
                continue;
            }

            // 2. Wide Melodic Span (2 full octaves)
            const expanded = Math.min(Math.max(n * 1.6, -1), 1);
            let degree = Math.floor((expanded + 1) * 7); // 0 to 14

            // 3. Dynamic Octave Accents
            if (simplex.noise1D(step + 200) > 0.5) {
                degree += 7;
            }

            pattern.push(degree);
        }

        Track("simplex-generative")
            .synth("pluck")
            .note(pattern)
            .scale("C3", "major")
            .envelope({ attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.2 })
            .gain(0.25);
    });

    console.log("\n%c==================================================================", "color: #c084fc; font-weight: bold;");
    console.log("%c    COMPREHENSIVE FEATURE SYMPHONY TEST COMPLETED SUCCESSFULLY    ", "color: #c084fc; font-weight: bold;");
    console.log("%c==================================================================", "color: #c084fc; font-weight: bold;");

    return "STOP_MOTIF";
})();
