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
Arrange([{ tracks: [t.gain(Ramp(.2, .6, "2 bars"))], bars: 3 }]);
Motif.schedule(1, () => t.gain(.3));
Motif.schedule(1.5, () => Motif.rampTempo(90, 1, { smooth: true }));
