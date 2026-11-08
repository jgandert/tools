Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
await Motif.loadSamples("samples.json");
Track("sample").sample("audit-tone").note([60, null]).stepLength("1/1");
