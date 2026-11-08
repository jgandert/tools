Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const rate = 24000;
const buffer = Motif.ctx.createBuffer(1, rate, rate);
const data = buffer.getChannelData(0);
for (let i = 0; i < data.length; i++) {
    const frequency = i < rate / 2 ? 220 : 440;
    data[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / rate);
}
Motif.sampleRegistry.set("tone", buffer);
Track("sample").sample("tone").fit(2, { mode: "stretch" }).chop(2).pattern([1]).note([60, null]).stepLength(3);
