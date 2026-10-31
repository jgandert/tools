import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/worklets/MasterLimiterProcessor.js", import.meta.url), "utf8");
const ceiling = Math.pow(10, -1 / 20);

function render(rate, left, right = left, options = {}) {
    let Processor;
    vm.runInNewContext(source, {
        sampleRate: rate,
        AudioWorkletProcessor: class {},
        registerProcessor: (name, value) => { Processor = value; },
    });
    const processor = new Processor();
    const length = Math.ceil((left.length + processor.latency + 128) / 128) * 128;
    const output = [new Float32Array(length), new Float32Array(length)];
    for (let offset = 0; offset < length; offset += 128) {
        const inputs = [left, right].map(samples => {
            const block = new Float32Array(128);
            block.set(samples.subarray(offset, offset + 128));
            return block;
        });
        processor.process([inputs], [output.map(samples => samples.subarray(offset, offset + 128))], {
            ceiling: [typeof options.ceiling === "function" ? options.ceiling(offset) : options.ceiling ?? -1],
            release: [options.release ?? 0.1],
        });
    }
    return { output, latency: processor.latency };
}

// Independent, longer 16x reconstruction catches intersample overshoot that a
// sample-peak assertion or the worklet's own detector would miss.

function truePeak(samples) {
    let peak = 0;
    for (const sample of samples) {
        assert(Number.isFinite(sample));
        peak = Math.max(peak, Math.abs(sample));
    }
    for (let phase = 1; phase < 16; phase++) {
        const coefficients = [];
        for (let tap = -127; tap <= 128; tap++) {
            const x = tap - phase / 16;
            coefficients.push(Math.sin(Math.PI * x) / (Math.PI * x) * (0.42 + 0.5 * Math.cos(Math.PI * x / 128) + 0.08 * Math.cos(2 * Math.PI * x / 128)));
        }
        const sum = coefficients.reduce((a, b) => a + b, 0);
        for (let i = 0; i < samples.length; i++) {
            let value = 0;
            for (let j = 0; j < coefficients.length; j++) value += (samples[i + j - 127] || 0) * coefficients[j] / sum;
            peak = Math.max(peak, Math.abs(value));
        }
    }
    return peak;
}

for (const rate of [44100, 48000, 96000]) {
    const quiet = Float32Array.from({ length: 2048 }, (_, i) => 0.1 * Math.sin(i * 0.137));
    const unchanged = render(rate, quiet);
    assert.deepEqual(unchanged.output[0].subarray(unchanged.latency, unchanged.latency + quiet.length), quiet, "below-ceiling audio must be bit-exact after latency");
    assert(unchanged.output[0].subarray(0, unchanged.latency).every(value => value === 0), "lookahead must delay the signal");

    const signals = [
        ["impulses", Float32Array.from({ length: 2048 }, (_, i) => i % 257 === 0 ? (i % 2 ? -8 : 8) : 0)],
        ["square", Float32Array.from({ length: 2048 }, (_, i) => i % 80 < 40 ? 2 : -2)],
        ["bursts", Float32Array.from({ length: 2048 }, (_, i) => i % 503 < 60 ? 4 * Math.sin(i * 1.618) + 3 * Math.sin(i * 0.71) : 0)],
        ...[0.02, 0.25, 0.4, 0.45, 0.49, 0.499].map(frequency => [
            `sine ${frequency} Fs`,
            Float32Array.from({ length: 2048 }, (_, i) => 2 * Math.sin(2 * Math.PI * frequency * i + Math.PI / 4)),
        ]),
    ];
    for (const [name, signal] of signals) {
        const right = Float32Array.from(signal, value => value * -0.25);
        const { output } = render(rate, signal, right);
        const peak = truePeak(output[0]);
        assert(peak <= ceiling + 1e-5, `${rate} ${name}: true peak ${20 * Math.log10(peak)} dBTP exceeds -1`);
        for (let i = 0; i < output[0].length; i++) assert(output[1][i] === output[0][i] * -0.25, "stereo channels must share gain");
    }
    const loudRight = Float32Array.from(quiet, value => value * 40);
    const rightLimited = render(rate, quiet, loudRight);
    assert(truePeak(rightLimited.output[1]) <= ceiling, "right-channel peaks must control limiting");
    for (let i = 0; i < rightLimited.output[0].length; i++) {
        assert(Math.abs(rightLimited.output[0][i] * 40 - rightLimited.output[1][i]) < 1e-6, "a loud right channel must also attenuate the left");
    }
}

const recovery = new Float32Array(48000);
recovery.fill(4, 0, 1024);
recovery.fill(0.1, 1024);
const recovered = render(48000, recovery);
assert(recovered.output[0][recovered.latency + 47000] > 0.0999, "gain must recover after overload");
const invalid = render(48000, new Float32Array([NaN, Infinity, -Infinity, 0.1]));
assert(invalid.output[0].every(Number.isFinite), "non-finite input must not poison subsequent output");
const lower = render(48000, new Float32Array(2048).fill(2), undefined, { ceiling: -6, release: 0.02 });
assert(truePeak(lower.output[0]) <= Math.pow(10, -6 / 20) + 1e-5, "custom ceiling must apply");
const changing = render(48000, new Float32Array(4096).fill(4), undefined, { ceiling: frame => frame < 2048 ? -1 : -12 });
assert(changing.output[0].subarray(2048).every(value => Math.abs(value) <= Math.pow(10, -12 / 20)), "lowering the ceiling must also update the pending gain envelope");
console.log("Master limiter DSP checks passed.");
