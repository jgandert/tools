Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
const t = Track("tone").synth("sine").freq([440]).stepLength("1/1").splitStereo();
Arrange([{ bars: 1, tracks: [] }, { bars: 1, tracks: [t] }, { bars: 1, tracks: [] }]);
