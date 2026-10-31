globalThis.songLintIsolation = true;
Motif.synthRegistry.set("song-lint-private", "sentinel");
Track("isolation").synth("sine").note([60]);
