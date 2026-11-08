import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../examples/test_all_features.motif.js", import.meta.url), "utf8");
const bodyStart = source.indexOf("const createMockLoop =");
const bodyEnd = source.indexOf("if (Motif.ctx) {", bodyStart);
assert.notEqual(bodyStart, -1, "createMockLoop() must exist in the showcase");
assert.notEqual(bodyEnd, -1, "the mock sample registry must follow createMockLoop()");
const body = source.slice(bodyStart, bodyEnd);
const ctx = {
    createBuffer(channels, frames, rate) {
        const data = new Float32Array(frames);
        return { getChannelData: () => data };
    },
};
let minimumExpArgument = Infinity;
let maximumExpArgument = -Infinity;
const deterministicMath = Object.create(Math);
deterministicMath.random = () => 0.75;
deterministicMath.exp = value => {
    minimumExpArgument = Math.min(minimumExpArgument, value);
    maximumExpArgument = Math.max(maximumExpArgument, value);
    return Math.exp(value);
};
const buffer = new Function("Motif", "sampleRate", "Math", `${body}\nreturn createMockLoop();`)({ ctx }, 48000, deterministicMath);
const data = buffer.getChannelData(0);
let peak = 0;
let overRange = 0;
let nonFinite = 0;
for (const sample of data) {
    peak = Math.max(peak, Math.abs(sample));
    if (Math.abs(sample) > 1) overRange++;
    if (!Number.isFinite(sample)) nonFinite++;
}

const sampleRate = 48000;
const beatDuration = 0.25;
const subdivisionDuration = 0.125;
const beatOnsets = [];
for (let beatIndex = 0; beatIndex < 8; beatIndex++) {
    const value = data[beatIndex * beatDuration * sampleRate];
    const expected = beatIndex % 2 === 0 ? 0 : 0.225;
    beatOnsets.push(value);
    assert.ok(Math.abs(value - expected) < 1e-6, `beat ${beatIndex} must start its alternating kick/snare voice`);
}

const hihatResiduals = [];
for (let subdivisionIndex = 1; subdivisionIndex < 16; subdivisionIndex += 2) {
    const time = subdivisionIndex * subdivisionDuration;
    const beatIndex = Math.floor(time / beatDuration);
    const timeWithinBeat = time - beatIndex * beatDuration;
    let drumValue;
    if (beatIndex % 2 === 0) {
        const frequency = 90 * Math.exp(-timeWithinBeat * 24) + 42;
        drumValue = Math.sin(2 * Math.PI * frequency * timeWithinBeat) * Math.exp(-timeWithinBeat * 14);
    } else {
        drumValue = 0.5 * Math.exp(-timeWithinBeat * 8) * 0.45;
    }
    const residual = data[time * sampleRate] - drumValue;
    hihatResiduals.push(residual);
    assert.ok(Math.abs(residual - 0.06) < 1e-6, `subdivision ${subdivisionIndex} must start a hihat tick`);
}

assert.equal(data.length, 96000);
assert.equal(nonFinite, 0, "mock loop samples must be finite");
assert.equal(overRange, 0, "mock loop samples must stay within [-1, 1]");
assert.ok(peak > 0.9 && peak < 1, "mock loop must retain a sensible percussive peak");
assert.ok(maximumExpArgument <= 0, "decay exponent elapsed times must not be negative");
assert.ok(minimumExpArgument >= -6, "elapsed times must stay within their beat or subdivision");

console.log(JSON.stringify({
    frames: data.length,
    peak,
    overRange,
    nonFinite,
    expArgumentRange: [minimumExpArgument, maximumExpArgument],
    beatOnsets,
    hihatResiduals,
}, null, 2));
