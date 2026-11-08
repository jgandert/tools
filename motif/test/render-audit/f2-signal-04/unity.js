Motif.setTempo(120);
Motif.master({ gain: .1, limiter: true });
const t = Track("tone").synth("sine").freq([440]).stepLength(8).envelope({
    attack: .01,
    decay: .01,
    sustain: 1,
    release: .01,
});
t.pan(0);