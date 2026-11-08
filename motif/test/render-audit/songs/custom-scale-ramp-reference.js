Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").note([Ramp("C4", "C5")]).stepLength("1/1");
