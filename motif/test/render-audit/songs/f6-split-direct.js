Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const t = Track("direct").synth("sine").freq([440]).stepLength("1/1").splitStereo(right => right.freq([660]).stepLength("1/1"));
t.start(2).stop(4);
