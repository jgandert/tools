Motif.setTempo(135);

// Crisp, punchy mastering with a slight low-end boost
Motif.master({
    gain: 0.8,
    limiter: true,
    eq: { low: 2.0, mid: 0.0, high: 1.5 },
});

// A strict, retro echo effect (short decay, hard left/right panning)
const chiptuneDelay = Bus("echo")
    .pan(LFO.square({ min: -0.75, max: 0.75, speed: "1/2" }))
    .filter({ type: "lowpass", cutoff: 3500, resonance: 0.5 })
    .feedback({ amount: 0.35 });

// ==========================================
// DRUMS (Synthesized natively)
// ==========================================

// Punchy triangle kick (4-on-the-floor)
Track("kick")
    .synth("triangle")
    .note(["C2", null, "C2", null])
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0, release: 0 })
    .volume(-5);

// Snappy noise snare
Track("snare")
    .synth("noise")
    .note([null, "C4", null, "C4"])
    .envelope({ attack: 0.01, decay: 0.12, sustain: 0, release: 0 })
    .volume(-12);

// Rapid, ticking hi-hats (with a quick 16th-note double hit on the 3rd beat)
Track("hats")
    .synth("noise")
    .note(["C4", "C4", ["C4", "C4"], "C4"])
    .envelope({ attack: 0.01, decay: 0.02, sustain: 0, release: 0 })
    .volume(-18);

// ==========================================
// BASS
// ==========================================

// Bouncy triangle bass with classic octave jumps
const bassPattern = [
    // C minor
    "C2", "C2", "C3", "C2", "C2", "C2", "G2", "C2",
    // Ab Major
    "Ab1", "Ab1", "Ab2", "Ab1", "Ab1", "Ab1", "Eb2", "Ab1",
    // Eb Major
    "Eb2", "Eb2", "Eb3", "Eb2", "Eb2", "Eb2", "Bb2", "Eb2",
    // Bb Major
    "Bb1", "Bb1", "Bb2", "Bb1", "Bb1", "Bb1", "F2", "Bb1",
];

Track("bass")
    .synth("triangle")
    .note(bassPattern)
    .stepLength("1/8") // 8th notes, making this sequence exactly 4 bars long
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.1 })
    .volume(-7);

// ==========================================
// ARPEGGIO CHORDS
// ==========================================

// The quintessential 8-bit sound: blazing fast arpeggiated chords
const arpPattern = [
    ...["C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5", "C4", "Eb4", "G4", "C5"],
    ...["Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4", "Ab3", "C4", "Eb4", "Ab4"],
    ...["Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5", "Eb4", "G4", "Bb4", "Eb5"],
    ...["Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4", "Bb3", "D4", "F4", "Bb4"],
];

Track("arp")
    .synth("square")
    .note(arpPattern)
    .stepLength("1/16") // 16th notes
    .envelope({ attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 }) // Highly staccato
    .volume(-17)
    .pan(0.3)
    .send(chiptuneDelay, 0.35);

// ==========================================
// LEAD MELODY
// ==========================================

// Heroic, nostalgic melody utilizing Ties to hold notes across sequencer steps
const leadPattern = [
    // Bar 1 (Cmin)
    "C5", Tie, "G4", Tie, "Eb4", Tie, "F4", "G4",
    // Bar 2 (Abmaj)
    "Ab4", Tie, "G4", Tie, "Eb4", Tie, null, "C4",
    // Bar 3 (Ebmaj) - Features a continuous pitch slide (Ramp) up to Eb4
    Ramp("Bb3", "Eb4"), Tie, "G4", Tie, "Bb4", Tie, "G4", Tie,
    // Bar 4 (Bbmaj)
    "F4", Tie, Tie, null, "G4", "F4", "Eb4", "D4",
];

Track("lead")
    .synth("square")
    .note(leadPattern)
    .stepLength("1/8")
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.1 })
    .volume(-12)
    .pan(-0.3)
    .send(chiptuneDelay, 0.5);