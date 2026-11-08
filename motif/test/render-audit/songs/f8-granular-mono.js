Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const buffer = Motif.ctx.createBuffer(1, 48000, 48000);
const channel = buffer.getChannelData(0);
for (let i = 0; i < channel.length; i++) channel[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
Motif.sampleRegistry.set("tone", buffer);
Track("sample").sample("tone").fit(2, { mode: "stretch" }).note([60, null]).stepLength("1/1");
