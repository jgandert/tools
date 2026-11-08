Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").freq([440]).stepLength("1/1").volume(-6.020599913279624);
