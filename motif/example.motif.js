// =============================================================================
// An Algorithmic Composition for Motif.js
// =============================================================================
//
// This track showcases the native algorithmic power, routing depth, and complex
// modulation systems of Motif.js:
// - Spatial audio and reactive parameter sweeps using custom LFO signals
// - Dynamic chord progressions with smooth voice-leading (chordVoicing)
// - Subdivided arpeggiators (arp, stepLength, loopLength)
// - Polyrhythmic, generative drum patterns (euclid, mutate, ratchet)
// - Advanced mixing & sidechain compression (sidechain, volume, distort, eq)
// - Complex global FX sends and feedback delays (Bus, send, feedback)
// - Declarative arrangement modeling structural evolution (Arrange)

// -----------------------------------------------------------------------------
// 1. Global Engine Setup
// -----------------------------------------------------------------------------
Motif.setTempo(118);
Motif.swing(0.06); // Add a subtle, organic swing/groove
Motif.master({
    gain: 0.85,
    limiter: true,
    eq: { low: 1.0, mid: 0.95, high: 1.1 },
});

// -----------------------------------------------------------------------------
// 2. Global FX Routing (Spatial Feedback Delay)
// -----------------------------------------------------------------------------
const dubDelay = Bus("dubDelay")
    .filter({ type: "bandpass", cutoff: 850, resonance: 1.2 })
    .volume(-6)
    .pan(LFO.sine({ min: -0.5, max: 0.5, speed: "8b" }));

// 1-sample feedback delay loop on the Bus itself
dubDelay.feedback({ amount: 0.65 });

// -----------------------------------------------------------------------------
// 3. Track Definitions
// -----------------------------------------------------------------------------

// Pad: Lush, evolving chordal foundation
const pad = Track("pad")
    .synth("sine")
    .voices(4, "oldest")
    .note([
        Parallel("C3", "E3", "G3", "B3"),   // Cmaj7
        Parallel("A2", "C3", "E3", "G3"),   // Amin7
        Parallel("F2", "A2", "C3", "E3"),   // Fmaj7
        Parallel("G2", "B2", "D3", "F3"),    // G7
    ])
    .chordVoicing({ mode: "smooth" })
    .envelope({ attack: 0.4, decay: 0.8, sustain: 0.7, release: 1.2 })
    .filter({
        type: "lowpass",
        cutoff: LFO.sine({ min: 250, max: 1300, speed: "4b" }),
        resonance: 1.5,
    })
    .pan(LFO.triangle({ min: -0.7, max: 0.7, speed: "12b" }))
    .gain(0.45)
    .send(dubDelay, 0.4);

// Kick: Heavy synthesized kick drum using a pitch-swept Ramp
const kick = Track("kick")
    .synth("sine")
    .note([Ramp("C3", "C1"), null, Ramp("C3", "C1"), null])
    .envelope({ attack: 0.005, decay: 0.12, sustain: 0.0, release: 0.12 })
    .gain(0.9);

// Clap: Warm filtered noise snap on the backbeats
const clap = Track("clap")
    .synth("square")
    .note([null, "C4", null, "C4"])
    .envelope({ attack: 0.001, decay: 0.07, sustain: 0.0, release: 0.07 })
    .filter({ type: "highpass", cutoff: 1200, resonance: 1.2 })
    .gain(0.35)
    .send(dubDelay, 0.25);

// Hi-Hat: Polyrhythmic, generative metal patterns using mutational ratchets
const hihat = Track("hihat")
    .synth("square")
    .euclid(5, 8) // E(5,8) polyrhythm
    .envelope({ attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.03 })
    .filter({ type: "highpass", cutoff: 7500 })
    .gain(0.12)
    .mutate({
        chance: 0.35,
        actions: {
            ratchet: 1, // Subdivide note triggers
        },
    });

// Bass: Deep, warm analog bassline with cycle-incremented transpositions & sidechain pumping
let bassCycle = 0;
const bass = Track("bass")
    .synth("saw")
    .note(["C2", Tie, "G2", null, "C2", null, "G1", "Bb1"])
    .every(1, (events) => {
        // Progress the bass notes algorithmically every bar to follow the chord movement
        const bar = bassCycle % 4;
        bassCycle++;
        events.forEach(e => {
            let diff = 0;
            if (bar === 1) diff = -3;      // Amin7 -> Root A1
            else if (bar === 2) diff = -7; // Fmaj7 -> Root F1
            else if (bar === 3) diff = -5; // G7    -> Root G1

            if (typeof e.value === "string" && e.value !== "Tie") {
                const midi = noteToMidi(e.value);
                e.value = midiToNote(midi + diff);
            }
        });
        return events;
    })
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.35 })
    .filter({ type: "lowpass", cutoff: 380, resonance: 1.2 })
    .distort(0.08) // Add warm, harmonic analog distortion
    .gain(0.75)
    .sidechain(kick, { attack: 0.01, release: 0.18 }); // Pumping ducking!

// Melody: Evolving, shimmering lead with decoupled timing (polymeter arpeggiator)
const melody = Track("melody")
    .synth("triangle")
    .note([
        Parallel("C4", "E4", "G4", "B4"),
        Parallel("A3", "C4", "E4", "G4"),
        Parallel("F3", "A3", "C4", "E4"),
        Parallel("G3", "B3", "D4", "F4"),
    ])
    .arp("upDown")
    .stepLength("1/8") // Runs 8th notes, decoupled from global cycle duration
    .loopLength("1b")  // Aligns loop perfectly back to 1-bar cycle boundaries
    .envelope({ attack: 0.01, decay: 0.1, sustain: 0.4, release: 0.3 })
    .filter({
        type: "lowpass",
        cutoff: LFO.sine({ min: 500, max: 2800, speed: "6b" }),
        resonance: 2.0,
    })
    .pan(LFO.sine({ min: -0.75, max: 0.75, speed: "4b" }))
    .gain(0.38)
    .send(dubDelay, 0.55);

// -----------------------------------------------------------------------------
// 4. Macro Structure Arrangement
// -----------------------------------------------------------------------------
Arrange([
    { bars: 4, tracks: [pad] },                          // Intro: Lush ambient pad only
    { bars: 4, tracks: [pad, bass] },                    // Add the deep sidechained bass
    { bars: 4, tracks: [pad, bass, kick, hihat] },       // Drop the groove (kick + hats)
    { bars: 8, tracks: [pad, bass, kick, hihat, clap, melody] }, // Climax: Full arpeggiated symphony
    { bars: 4, tracks: [pad, melody, hihat] },            // Outro: Ambient wind-down
]);
