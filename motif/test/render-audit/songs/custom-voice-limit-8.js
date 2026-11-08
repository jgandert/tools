Motif.setTempo(120);
Motif.master({ gain: 0.1, limiter: true });
Track("tone").synth("sine").freq([440, 660, 440, 660]).stepLength("1/4").envelope({
    attack: 0.01,
    decay: 0.01,
    sustain: 1,
    release: 0.1,
}).voices(8, "oldest");
