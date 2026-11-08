Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const buffer = Motif.ctx.createBuffer(2, 48000, 48000);
for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / 48000);
}
Motif.sampleRegistry.set("tone", buffer);
Track("sample").sample("tone").fit(2, { mode: "repitch" }).note([60, null]).stepLength("1/1");
