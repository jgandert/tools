Motif.setTempo(120);
Motif.master({ gain: .1, limiter: true });
const t = Track("tone").synth("sine").freq([440]).stepLength(8).envelope({
    attack: .01,
    decay: .01,
    sustain: 1,
    release: .01,
});
const signal = LFO.sine({ min: .04, max: .09, frequency: 1 });
t.pan(0).gain(Ramp(.1, .1, 1)).gain(Ramp(.2, .6, 1));
Arrange([{ tracks: [t], bars: 1 }, { tracks: [t], bars: 2 }]);
Motif.schedule(.5, () => t.gain(signal));
