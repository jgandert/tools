Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });

const sampler = Track("docs-sampler")
    .sampler({
        urls: { 48: "tone.wav", C4: "tone.wav", G4: "tone.wav" },
        baseUrl: "./",
        release: "100ms",
    })
    .stepLength("1/4")
    .note(["C3", "E3", "C4", "E4"]);

Arrange([
    { bars: 1, tracks: [sampler] },
]);
