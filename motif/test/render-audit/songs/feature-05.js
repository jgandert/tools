Motif.setTempo(120);
Motif.sampleSeed(123);
Motif.master({ gain: 0.8, limiter: true });
const sampleRate = Motif.ctx ? Motif.ctx.sampleRate : 44100;

const createMockKick = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(1, sampleRate * 0.3, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const freq = 130 * Math.exp(-t * 22) + 38;
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 12);
    }
    return buffer;
};

const createMockSnare = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(1, sampleRate * 0.25, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const noise = Math.random() * 2 - 1;
        const sine = Math.sin(2 * Math.PI * 180 * t);
        data[i] = (noise * 0.7 + sine * 0.3) * Math.exp(-t * 9);
    }
    return buffer;
};

const createMockLoop = () => {
    const ctx = Motif.ctx;
    if (!ctx) return null;
    const beatDuration = 0.25;
    const subdivisionDuration = 0.125;
    const buffer = ctx.createBuffer(1, sampleRate * 2.0, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const beatIndex = Math.floor(t / beatDuration);
        const timeWithinBeat = t - beatIndex * beatDuration;

        let sampleVal = 0;
        if (beatIndex % 2 === 0) {
            const freq = 90 * Math.exp(-timeWithinBeat * 24) + 42;
            sampleVal = Math.sin(2 * Math.PI * freq * timeWithinBeat) * Math.exp(-timeWithinBeat * 14);
        } else {
            const noise = Math.random() * 2 - 1;
            sampleVal = noise * Math.exp(-timeWithinBeat * 8) * 0.45;
        }

        // Add hihat ticks on subdivisions
        const subdivisionIndex = Math.floor(t / subdivisionDuration);
        if (subdivisionIndex % 2 === 1) {
            const timeWithinSubdivision = t - subdivisionIndex * subdivisionDuration;
            sampleVal += (Math.random() * 2 - 1) * Math.exp(-timeWithinSubdivision * 45) * 0.12;
        }

        data[i] = sampleVal;
    }
    return buffer;
};

if (Motif.ctx) {
    Motif.sampleRegistry.set("mock-kick", createMockKick());
    Motif.sampleRegistry.set("mock-snare", createMockSnare());
    Motif.sampleRegistry.set("mock-loop", createMockLoop());
}


const midi = noteToMidi("A4");
const note = midiToNote(60);
const deg = degreeToMidi(2, "C3", "major"); // E3 (MIDI 52)
const hz = midiToHz(69); // 440

console.log(`  [Helpers] noteToMidi('A4') = ${midi} (expected 69)`);
console.log(`  [Helpers] midiToNote(60) = '${note}' (expected 'C4')`);
console.log(`  [Helpers] degreeToMidi(2, 'C3', 'major') = ${deg} (expected 52)`);
console.log(`  [Helpers] midiToHz(69) = ${hz}Hz (expected 440Hz)`);

Track("helpers")
    .synth("sine")
    .note([midi, note, deg, midiToNote(Math.round(12 * Math.log2(hz / 440) + 69))])
    .gain(0.5);
