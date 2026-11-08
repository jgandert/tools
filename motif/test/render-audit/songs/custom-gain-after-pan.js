Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").freq([440]).stepLength("1/1").pan(0).gain(0.5);
