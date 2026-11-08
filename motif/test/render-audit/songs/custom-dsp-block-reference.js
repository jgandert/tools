Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").freq([440]).dsp(context => context.i);
