Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
const buffer = Motif.ctx.createBuffer(1, 48000 * 6, 48000);
const pcm = buffer.getChannelData(0);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
Motif.sampleRegistry.set("tone", buffer);
const t = Track("tone").synth("sine").freq([440]).stepLength(2).envelope({
    attack: .01,
    decay: .02,
    sustain: .7,
    release: .05,
});
t.pan(0);
