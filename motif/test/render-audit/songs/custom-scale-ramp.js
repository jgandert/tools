Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").scale("C4", "major").note([Ramp(0, 7)]).stepLength("1/1");
