Motif.setTempo(120);
const lead = Track("tempo-cli-lead").synth("sine").note([60, 62, 64, 67]).gain(0.08);
Arrange([{ tracks: [lead], bars: 1 }, { tracks: [], bars: 1 }]);
Motif.schedule(0.4, () => Motif.rampTempo(60, 2, { smooth: true }));
