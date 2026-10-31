if (globalThis.songLintIsolation || Motif.synthRegistry.has("song-lint-private")) throw new Error("song state leaked");
Track("isolation").synth("sine").note([60]);
