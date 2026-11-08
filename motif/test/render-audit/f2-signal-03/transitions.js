Motif.setTempo(120);
Motif.master({ gain: .1, limiter: true });
const t = Track("tone").synth("sine").freq([440]).stepLength(8).envelope({
    attack: .01,
    decay: .01,
    sustain: 1,
    release: .01,
});
const shared = LFO.sine({ min: .04, max: .09, frequency: 1 });
t.gain(shared).pan(0);
Motif.schedule(1, () => t.gain(.3));
Motif.schedule(2, () => t.gain(LFO.sine({ min: .2, max: .4, frequency: 1 })));
Motif.schedule(3, () => t.gain(Ramp(.2, .6, 1)));
Motif.schedule(4.2, () => t.gain(0));
