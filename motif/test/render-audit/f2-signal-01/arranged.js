Motif.setTempo(120);
Motif.master({ gain: .1, limiter: true });
const t = Track("tone").synth("sine").freq([440]).stepLength(8).envelope({
    attack: .01,
    decay: .01,
    sustain: 1,
    release: .01,
});
t.gain(LFO.sine({ min: .04, max: .09, frequency: 1 })).pan(0);
Arrange([{ tracks: [t], bars: 1 }, { tracks: [t.gain(Ramp(.2, .6, 1))], bars: 2 }]);
