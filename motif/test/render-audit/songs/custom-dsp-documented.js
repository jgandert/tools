Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").dsp(context => Math.sin(context.p * 2 * Math.PI)).freq([440]);
