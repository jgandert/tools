// Track('duplicate').invented().synth('imaginary'); bass.sidechain(Track('kick'));
const text = "Track('duplicate').invented().sample('fm')";
const template = `Track('duplicate').invented()`;
const sparse = (length, entries) => Array.from({ length }, (_, i) => entries[i] ?? null);
const pattern = sparse(4, { 0: 60, 2: 64 }).map(v => v == null ? v : v + 1);
const tracks = ['sine', 'square', 'sawtooth', 'triangle', 'saw', 'noise', 'fm', 'pluck'].map((source, i) => Track(`builtin-${i}`).sound(source).note(pattern));
const kick = Track('kick').sample('kick-lofi').note([60, null]);
const bass = Track('bass').synth('sine').note([0, 2]).scale('C3', 'minor').sidechain(kick);
Arrange([{ bars: 1, tracks: [...tracks, kick, bass] }, { bars: 1, tracks: [bass, kick] }]);
