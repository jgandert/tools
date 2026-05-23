Motif.setTempo(135);

Motif.master({
    gain: 0.8,
    limiter: true,
    eq: { low: 2.0, mid: 0.0, high: 1.5 },
});

const chiptuneDelay = Bus("echo")
    .pan(LFO.square({ min: -0.75, max: 0.75, speed: "1/2" }))
    .filter({ type: "lowpass", cutoff: 3500, resonance: 0.5 })
    .feedback({ amount: 0.35 });

// ==========================================
// DRUMS
// ==========================================

const kick = Track("kick")
    .synth("triangle")
    .note(["C2", null, "C2", null])
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0, release: 0 })
    .volume(-5);

const kick_sparse = Track("kick_sparse")
    .synth("triangle")
    .note(["C2", null, null, null])
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0, release: 0 })
    .volume(-5);

const snare = Track("snare")
    .synth("noise")
    .note([null, "C4", null, "C4"])
    .envelope({ attack: 0.01, decay: 0.12, sustain: 0, release: 0 })
    .volume(-12);

const hats = Track("hats")
    .synth("noise")
    .note(["C4", "C4", ["C4", "C4"], "C4"])
    .envelope({ attack: 0.01, decay: 0.02, sustain: 0, release: 0 })
    .volume(-18);

const hats_fast = Track("hats_fast")
    .synth("noise")
    .note(["C4", ["C4", "C4"], "C4", ["C4", "C4"]])
    .envelope({ attack: 0.01, decay: 0.02, sustain: 0, release: 0 })
    .volume(-17);

// A long noise burst used as a crash cymbal. 
// stepLength('8b') ensures it only triggers exactly once every 8 bars.
const crash = Track("crash")
    .synth("noise")
    .note(["C4"])
    .stepLength("8b")
    .envelope({ attack: 0.01, decay: 2.5, sustain: 0, release: 0 })
    .filter({ type: "highpass", cutoff: 2000 })
    .volume(-14);

// ==========================================
// BASSLINES (4 bars long each)
// ==========================================

const bassMainPat = [
    "C2", "C2", "C3", "C2", "C2", "C2", "G2", "C2",   // Cm
    "Ab1", "Ab1", "Ab2", "Ab1", "Ab1", "Ab1", "Eb2", "Ab1", // Ab
    "Eb2", "Eb2", "Eb3", "Eb2", "Eb2", "Eb2", "Bb2", "Eb2", // Eb
    "Bb1", "Bb1", "Bb2", "Bb1", "Bb1", "Bb1", "F2", "Bb1",   // Bb
];

const bass = Track("bass")
    .synth("triangle")
    .note(bassMainPat)
    .stepLength("1/8")
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.1 })
    .volume(-7);

const bassBridgePat = [
    "F1", "F1", "F2", "F1", "F1", "F1", "C2", "F1",   // Fm
    "C2", "C2", "C3", "C2", "C2", "C2", "G2", "C2",   // Cm
    "Ab1", "Ab1", "Ab2", "Ab1", "Ab1", "Ab1", "Eb2", "Ab1", // Ab
    "G1", "G1", "G2", "G1", "G1", "G1", "D2", "G1",    // G (Tension)
];

const bassBridge = Track("bass_bridge")
    .synth("triangle")
    .note(bassBridgePat)
    .stepLength("1/8")
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.1 })
    .volume(-7);

// ==========================================
// ARPEGGIOS (4 bars long each)
// ==========================================

const arpMainPat = [
    ...["C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5"], // Cm
    ...["Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4"], // Ab
    ...["Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5"], // Eb
    ...["Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4"], // Bb
];

const arp = Track("arp")
    .synth("square")
    .note(arpMainPat)
    .stepLength("1/16")
    .envelope({ attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 })
    .volume(-19)
    .pan(0.3)
    .send(chiptuneDelay, 0.35);

const arpBridgePat = [
    ...["F3", "Ab3", "C4", "F4", "F3", "Ab3", "C4", "F4", "F3", "Ab3", "C4", "F4", "F3", "Ab3", "C4", "F4"], // Fm
    ...["C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5"], // Cm
    ...["Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4"], // Ab
    ...["G3", "B3", "D4", "G4", "G3", "B3", "D4", "G4", "G3", "B3", "D4", "G4", "G3", "B3", "D4", "G4"], // G
];

const arpBridge = Track("arp_bridge")
    .synth("square")
    .note(arpBridgePat)
    .stepLength("1/16")
    .envelope({ attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 })
    .volume(-19)
    .pan(0.3)
    .send(chiptuneDelay, 0.35);

// ==========================================
// LEADS (4 bars long each)
// ==========================================

const leadPatA = [
    "C5", Tie, "G4", Tie, "Eb4", Tie, "F4", "G4",
    "Ab4", Tie, "G4", Tie, "Eb4", Tie, null, "C4",
    Ramp("Bb3", "Eb4"), Tie, "G4", Tie, "Bb4", Tie, "G4", Tie,
    "F4", Tie, Tie, null, "G4", "F4", "Eb4", "D4",
];

const leadA = Track("lead_A")
    .synth("square")
    .note(leadPatA)
    .stepLength("1/8")
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.1 })
    .volume(-12)
    .pan(-0.3)
    .send(chiptuneDelay, 0.5);

// Higher energy variation for choruses
const leadPatB = [
    "C5", Tie, "G4", Tie, "Eb5", Tie, "D5", "C5",
    "Ab4", Tie, "C5", Tie, "G4", Tie, "F4", "Eb4",
    Ramp("G4", "Bb4"), Tie, "Eb5", Tie, "G5", Tie, "F5", "Eb5",
    "D5", Tie, Tie, null, "G5", "F5", "Eb5", "D5",
];

const leadB = Track("lead_B")
    .synth("square")
    .note(leadPatB)
    .stepLength("1/8")
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.1 })
    .volume(-12)
    .pan(-0.3)
    .send(chiptuneDelay, 0.5);

const leadBridgePat = [
    "F4", Tie, "C5", Tie, "Ab4", Tie, Tie, "G4",
    "Eb4", Tie, "G4", Tie, "C5", Tie, Tie, null,
    "C4", Tie, "Eb4", Tie, "Ab4", Tie, Tie, "G4",
    "B4", Tie, "D5", Tie, "G5", Tie, Tie, null,
];

const leadBridge = Track("lead_bridge")
    .synth("square")
    .note(leadBridgePat)
    .stepLength("1/8")
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.1 })
    .volume(-12)
    .pan(-0.3)
    .send(chiptuneDelay, 0.5);

// ==========================================
// MACRO ARRANGEMENT (64 Bars Total)
// ==========================================

Arrange([
    // Phase 1: Intro (8 bars)
    { bars: 8, tracks: [arp, leadA] },

    // Phase 2: Build Up (8 bars)
    { bars: 8, tracks: [arp, leadA, hats, kick_sparse, crash] },

    // Phase 3: Chorus 1 (8 bars)
    { bars: 8, tracks: [arp, leadA, bass, hats, kick, snare, crash] },

    // Phase 4: Chorus 2 / High Energy (8 bars)
    { bars: 8, tracks: [arp, leadB, bass, hats_fast, kick, snare] },

    // Phase 5: Emotional Bridge / Breakdown (8 bars)
    { bars: 8, tracks: [arpBridge, leadBridge, bassBridge, hats, crash] },

    // Phase 6: Bridge Build Up (8 bars)
    { bars: 8, tracks: [arpBridge, leadBridge, bassBridge, hats_fast, kick, snare] },

    // Phase 7: Final Drop / Massive Chorus (8 bars)
    { bars: 8, tracks: [arp, leadB, bass, hats_fast, kick, snare, crash] },

    // Phase 8: Outro (8 bars, stripped back to fade out)
    { bars: 8, tracks: [arp, bass, crash] },
]);