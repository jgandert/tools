Motif.setTempo(120);
Motif.master({ gain: 0.2, limiter: true });
const buffer = Motif.ctx.createBuffer(2, 96000, 48000);
for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
        const slice = Math.floor(i / 24000);
        data[i] = 0.3 * Math.sin(2 * Math.PI * (200 + slice * 200) * (i % 24000) / 48000);
    }
}
Motif.sampleRegistry.set("slice-tones", buffer);
Track("slices").sample("slice-tones").chop(4)
    .pattern([0, 1, [2, 2], 3])
    .note([60, 60, 72, 60])
    .stepLength(1).fit(4, { mode: "repitch", grainSize: 0.04, overlap: 4 })
    .start(0).stop(4);
