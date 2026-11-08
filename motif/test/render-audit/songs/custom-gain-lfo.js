Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").freq([440]).stepLength("1/1").gain(LFO.sine({
    min: 0,
    max: 1,
    frequency: 1,
}));
