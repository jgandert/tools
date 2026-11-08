Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const buffer = Motif.ctx.createBuffer(2, 48000, 48000);
for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / 48000);
}
Motif.sampleRegistry.set("tone", buffer);
Track("slices").sample("tone").chop(4).pattern([0, 1, [2, 2], 3]).note([60, 60, 60, 60]).stepLength("1/4").fit(2);
