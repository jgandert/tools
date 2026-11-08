Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
const t = Track("tone").synth("sine").note([Parallel("C4", "E4", "G4"), Tie, null, null]).stepLength("1/4").envelope({
    attack: 0.01,
    decay: 0.01,
    sustain: 1,
    release: 0.05,
});
Arrange([{ bars: 1, tracks: [t] }]);
