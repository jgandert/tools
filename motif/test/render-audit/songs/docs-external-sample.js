Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
await Motif.loadSamples("docs-samples.json");

const hit = Track("docs-external-hit")
    .sample("docs-hit")
    .stepLength("1/1")
    .note([60]);

Arrange([
    { bars: 1, tracks: [hit] },
]);
