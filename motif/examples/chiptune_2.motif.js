Motif.setTempo(152);

Motif.master({
    gain: 0.8,
    limiter: true,
    eq: { low: 2.5, mid: -0.5, high: 1.0 },
});

const tapeDelay = Bus("tape_delay")
    .pan(LFO.sine({ min: -0.15, max: 0.15, speed: "4b" }))
    .filter({ type: "lowpass", cutoff: 2200, resonance: 1.2 })
    .feedback({ amount: 0.55 });

// ==========================================
// DRUMS & SIDECHAINING
// ==========================================
// A silent kick that runs all the time to make the ambient layers "breathe" evenly
const ghost_kick = Track("ghost")
    .synth("triangle")
    .note(["C2", null, "C2", null])
    .stepLength("1/4")
    .volume(-100); // Silent, but triggers the sidechain compressor

const kick_sparse = Track("kick_s")
    .synth("triangle")
    .note(["C2", null, null, null])
    .volume(-7);

const kick_main = Track("kick_m")
    .synth("triangle")
    .note(["C2", null, null, "C2", null, null, "C2", null, null, "C2", null, "C2", null, null, "C2", null])
    .stepLength("1/16")
    .envelope({ attack: 0.01, decay: 0.2, sustain: 0, release: 0 })
    .volume(-4);

const snare = Track("snare")
    .synth("noise")
    .note([null, null, null, null, "C4", null, null, null])
    .stepLength("1/8")
    .envelope({ attack: 0.01, decay: 0.15, sustain: 0, release: 0 })
    .volume(-14);

const hats = Track("hats").synth("noise").note(["C4", ["C4", "C4"], "C4", "C4"]).stepLength("1/4").volume(-22);
const hats_fast = Track("hats_f").synth("noise").note(["C4", "C4", ["C4", "C4"], "C4"]).stepLength("1/8").volume(-20);

const crash = Track("crash")
    .synth("noise")
    .note(["C4"])
    .stepLength("8b")
    .envelope({ attack: 0.01, decay: 4.0, sustain: 0, release: 0 })
    .filter({ type: "highpass", cutoff: 1200 })
    .volume(-15)
    .send(tapeDelay, 0.6);

// ==========================================
// PROCEDURAL DUST
// ==========================================
const dustPat = ["Eb6", "G6", "F6", "Bb6", "C7", "Eb6", "D6", "F6"];
const dust = Track("dust")
    .synth("sine")
    .note(dustPat)
    .stepLength("1/16")
    .envelope({ attack: 0.05, decay: 0.15, sustain: 0.1, release: 0.5 })
    .gain(0.05)
    .pan(LFO.sine({ min: -0.15, max: 0.15, speed: "2b" }))
    .degrade(0.75)
    .sidechain(ghost_kick, { attack: 0.02, release: 0.25 }) // Sidechained to the silent ghost kick!
    .send(tapeDelay, 0.5);

// ==========================================
// THEME A: Eb LYDIAN
// ==========================================
const padPatA = [
    Parallel("Eb3", "G3", "Bb3", "D4"),
    Parallel("F3", "A3", "C4", "G4"),
    Parallel("D3", "F3", "A3", "C4"),
    Parallel("G2", "Bb2", "D3", "F3"),
];
const pad_A = Track("pad_a")
    .synth("sine")
    .voices(4)
    .note(padPatA)
    .stepLength("1b")
    .envelope({ attack: 0.5, decay: 0, sustain: 1.0, release: 0.5 })
    .volume(-22)
    .sidechain(ghost_kick, { attack: 0.05, release: 0.3 })
    .send(tapeDelay, 0.4);

const arpPatA = [
    ...["Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5"],
    ...["F4", "A4", "C5", "G5", "F4", "A4", "C5", "G5", "F4", "A4", "C5", "G5", "F4", "A4", "C5", "G5"],
    ...["D4", "F4", "A4", "C5", "D4", "F4", "A4", "C5", "D4", "F4", "A4", "C5", "D4", "F4", "A4", "C5"],
    ...["G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5"],
];
const arp_A = Track("arp_a").synth("pluck").note(arpPatA).stepLength("1/16").volume(-18).pan(-0.2).send(tapeDelay, 0.3);

const bassPatA = [
    "Eb2", null, "Eb3", null, "Bb1", null, "D2", "Eb2",
    "F2", null, "C3", null, "A1", null, "C2", "F2",
    "D2", null, "A2", null, "F1", null, "A1", "C2",
    "G1", null, "G2", null, "D2", null, "F2", "G2",
];
const bass_A = Track("bass_a").synth("triangle").note(bassPatA).stepLength("1/8").envelope({
    attack: 0.01,
    decay: 0.2,
    sustain: 0.4,
    release: 0.1,
}).volume(-6);

const leadPatA = [
    "G4", Tie, "F4", Tie, "Eb4", Tie, "F4", "G4", "A4", Tie, "C5", Tie, "G4", Tie, Tie, null,
    "F4", Tie, "Eb4", Tie, "D4", Tie, "F4", "Bb3", "C4", Tie, Tie, null, null, null, null, null,
    "G4", Tie, "F4", Tie, "Eb4", Tie, "F4", "G4", "A4", Tie, "D5", Tie, "C5", Tie, Tie, null,
    Ramp("C5", "A4"), Tie, "G4", Tie, "F4", Tie, "D4", Tie, "F4", Tie, "G4", Tie, Tie, null, null, null,
];
const lead_A = Track("lead_a")
    .synth("square")
    .voices(1, "oldest")
    .note(leadPatA)
    .stepLength("1/8")
    .envelope({ attack: 0.02, decay: 0.15, sustain: 0.7, release: 0.1 })
    .volume(-13)
    .send(tapeDelay, 0.4);

// ==========================================
// BRIDGE
// ==========================================
const padBridgePat = [
    Parallel("Bb2", "F3", "A3", "D4"),
    Parallel("A2", "E3", "G3", "C4"),
    Parallel("D2", "F#3", "A3", "C4"),
    Parallel("D2", "F#3", "C4", "Eb4"),
];
const pad_bridge = Track("pad_b")
    .synth("saw")
    .note(padBridgePat)
    .stepLength("2b")
    .envelope({ attack: 1.0, decay: 1.0, sustain: 0.8, release: 2.0 })
    .filter({ type: "lowpass", cutoff: 800 })
    .volume(-18)
    .sidechain(ghost_kick, { attack: 0.05, release: 0.3 });

const bassBridgePat = ["Bb1", null, null, null, "A1", null, null, null, "D1", null, null, null, "D1", null, "Eb1", null];
const bass_bridge = Track("bass_b").synth("triangle").note(bassBridgePat).stepLength("1/2").volume(-6);

const leadBridgePat = [
    "F5", Tie, Tie, Tie, "D5", Tie, Tie, Tie, "C5", Tie, "Bb4", Tie, "C5", Tie, "D5", Tie,
    "E5", Tie, Tie, Tie, "C5", Tie, Tie, Tie, "A4", Tie, "G4", Tie, "A4", Tie, "C5", Tie,
    "F#5", Tie, Tie, Tie, "D5", Tie, Tie, Tie, "C5", Tie, "A4", Tie, "C5", Tie, "D5", Tie,
    "Eb5", Tie, "D5", Tie, "C5", Tie, "Bb4", Tie, "A4", Tie, "G4", Tie, "F#4", Tie, "D4", Tie,
];
const lead_bridge = Track("lead_bridge")
    .synth("square")
    .voices(1, "oldest")
    .note(leadBridgePat)
    .stepLength("1/8")
    .volume(-13)
    .send(tapeDelay, 0.6);

// ==========================================
// THEME B (G DORIAN)
// ==========================================
const arpPatB = [
    ...["G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5", "G4", "Bb4", "D5", "F5"],
    ...["F4", "A4", "C5", "E5", "F4", "A4", "C5", "E5", "F4", "A4", "C5", "E5", "F4", "A4", "C5", "E5"],
    ...["Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5", "Eb4", "G4", "Bb4", "D5"],
    ...["C4", "Eb4", "G4", "D5", "C4", "Eb4", "G4", "D5", "C4", "Eb4", "G4", "D5", "C4", "Eb4", "G4", "D5"],
];
const arp_B = Track("arp_b").synth("pluck").note(arpPatB).stepLength("1/16").volume(-17).pan(0.2).send(tapeDelay, 0.4);

const bassPatB = [
    "G1", null, "D2", null, "G2", null, "F2", "D2",
    "F1", null, "C2", null, "F2", null, "E2", "C2",
    "Eb1", null, "Bb1", null, "Eb2", null, "D2", "Bb1",
    "C1", null, "G1", null, "C2", null, "Eb2", "D2",
];
const bass_B = Track("bass_b").synth("triangle").note(bassPatB).stepLength("1/8").volume(-6);

const leadPatB = [
    "G5", Tie, Tie, Tie, "F5", Tie, "D5", Tie, "C5", Tie, Tie, Tie, "D5", Tie, "F5", Tie,
    "Bb4", Tie, Tie, Tie, "A4", Tie, "F4", Tie, "G4", Tie, Tie, Tie, Tie, Tie, Tie, Tie,
    "G5", Tie, Tie, Tie, "A5", Tie, "Bb5", Tie, "C6", Tie, Tie, Tie, "D6", Tie, "F6", Tie,
    "D6", Tie, Tie, Tie, "C6", Tie, "A5", Tie, "G5", Tie, Tie, Tie, Tie, Tie, Tie, Tie,
];
const lead_B = Track("lead_B")
    .synth("square")
    .voices(1, "oldest")
    .note(leadPatB)
    .stepLength("1/8")
    .volume(-12)
    .send(tapeDelay, 0.5);

const counterPatB = ["D6", null, null, "C6", null, null, "A5", null];
const counter_B = Track("counter_b")
    .synth("square")
    .voices(1, "oldest")
    .note(counterPatB)
    .stepLength("1/16")
    .envelope({ attack: 0.01, decay: 0.1, sustain: 0, release: 0.1 })
    .volume(-18)
    .pan(-0.4)
    .send(tapeDelay, 0.6);

// ==========================================
// OUTRO
// ==========================================
const final_chord = Track("final")
    .synth("sine")
    .voices(5)
    .note([Parallel("G2", "D3", "G3", "B3", "D4"), null])
    .stepLength("4b")
    .envelope({ attack: 0.5, decay: 1.0, sustain: 0.6, release: 8.0 })
    .filter({ type: "lowpass", cutoff: LFO.triangle({ min: 300, max: 1500, speed: "8b" }) })
    .volume(-12)
    .send(tapeDelay, 0.8);

// ==========================================
// MACRO ARRANGEMENT (72 Bars Total)
// ==========================================

Arrange([
    { bars: 8, tracks: [ghost_kick, dust, pad_A] },
    { bars: 8, tracks: [ghost_kick, dust, pad_A, arp_A, bass_A, kick_sparse] },
    { bars: 8, tracks: [ghost_kick, arp_A, bass_A, lead_A, kick_main, hats, pad_A, dust, crash] },
    {
        bars: 8,
        tracks: [ghost_kick, arp_A, bass_A, lead_A, kick_main, hats_fast, snare, pad_A, dust],
    },
    {
        bars: 8,
        tracks: [ghost_kick, pad_bridge, bass_bridge, lead_bridge, kick_sparse, dust, crash],
    },
    {
        bars: 8,
        tracks: [ghost_kick, arp_B, bass_B, lead_B, kick_main, hats_fast, snare, dust, crash],
    },
    {
        bars: 8,
        tracks: [ghost_kick, arp_B, bass_B, lead_B, counter_B, kick_main, hats_fast, snare, dust],
    },
    { bars: 8, tracks: [ghost_kick, pad_bridge, dust, crash] },
    { bars: 8, tracks: [ghost_kick, final_chord, dust] },
]);