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
t.gain(.5).pan(0);
Motif.schedule(1, () => t.gain(.25));
Motif.schedule(2.5, () => t.gain(Ramp(.2, .6, 1)));
Motif.schedule(3, () => t.gain(.3));
Motif.schedule(3.5, () => Motif.setTempo(90));
Motif.schedule(4.5, () => t.gain(0));
