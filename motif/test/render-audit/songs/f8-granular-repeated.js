Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const buffer = Motif.ctx.createBuffer(2, 24000, 48000);
for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const frequency = channel === 0 ? 440 : 660;
    for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / 48000);
}
Motif.sampleRegistry.set("tone", buffer);
Track("sample").sample("tone").fit(0.5, { mode: "stretch" }).note([60, 60, 60, null]).stepLength("1/4");
