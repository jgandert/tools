Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const t = Track("late").synth("sine").freq([440]).stepLength("1/1");
Arrange([{ bars: 1, tracks: [] }, { bars: 1, tracks: [t] }, { bars: 1, tracks: [] }]);
t.splitStereo(right => right.freq([660]).stepLength("1/1"));
