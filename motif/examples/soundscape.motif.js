Motif.setTempo(48);
Motif.master({
    gain: 0.7,
    limiter: true,
    eq: { low: 2.0, mid: -0.5, high: 1.0 },
});

const verb = Bus("verb")
    .filter({ type: "lowpass", cutoff: 1400, resonance: 0.1 })
    .pan(LFO.sine({ min: -0.4, max: 0.4, speed: "8b" }))
    .feedback({ amount: 0.4 });

// Textural noise floor (Using the proper global `Tie` variable without quotes)
Track("noise_floor")
    .synth("noise")
    .note(["C3", Tie, Tie, Tie])
    .stepLength("2b")
    .envelope({ attack: 4.0, decay: 0, sustain: 1.0, release: 4.0 })
    .filter({
        type: "bandpass",
        cutoff: LFO.sine({ min: 100, max: 800, speed: "16b" }),
        resonance: 1.0,
    })
    .pan(LFO.triangle({ min: -0.6, max: 0.6, speed: "12b" }))
    .volume(-28)
    .send(verb, 0.4); // FIX 3: Lowered bus send

// Extended voicings
const voicings = [
    Parallel("F2", "C3", "G3", "A3", "E4"),
    Parallel("D2", "A2", "E3", "F3", "C4"),
    Parallel("A1", "E2", "B2", "C3", "G3"),
    Parallel("C2", "G2", "D3", "E3", "B3"),
];

// Slow-moving harmonic foundation
Track("pads")
    .synth("saw")
    .voices(12, "oldest")
    .note(voicings)
    .stepLength("4b")
    .envelope({ attack: 8.0, decay: 2.0, sustain: 0.85, release: 12.0 })
    .filter({
        type: "lowpass",
        cutoff: LFO.sine({ min: 120, max: 650, speed: "24b" }),
        resonance: 0.5,
    })
    .pan(LFO.triangle({ min: -0.2, max: 0.2, speed: "14b" }))
    .volume(-18)
    .send(verb, 0.4);

// Generative sequencer mapped to F Lydian
const sim = new SimplexNoise(1123);
const seq = Array.from({ length: 64 }, (_, i) => {
    const n = sim.noise1D(i * 0.15);
    if (sim.noise1D(i * 0.4 + 100) < -0.1) return null;

    let deg = Math.floor((n + 1) * 3);
    if (sim.noise1D(i * 0.2 + 200) > 0.6) deg += 7;
    return deg;
});

// Sparse, algorithmic counterpoint
Track("gen_pluck")
    .synth("fm")
    .note(seq)
    .scale("F3", "lydian")
    .stepLength("1/4")
    .envelope({ attack: 0.02, decay: 1.5, sustain: 0.1, release: 4.0 })
    .filter({
        type: "lowpass",
        cutoff: LFO.sine({ min: 400, max: 2200, speed: "6b" }),
        resonance: 1.5,
    })
    .pan(LFO.sine({ min: -0.75, max: 0.75, speed: "5b" }))
    .volume(-20)
    .send(verb, 0.3)
    .offset("3/8", (e) => {
        if (typeof e.value === "number") e.value += 4;
        return e;
    })
    .mutate({ chance: 0.15, actions: { ratchet: 2 } });