// Behavioral expectations checked against real Chromium renders, without Web Audio mocks.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const base = process.argv[2] ? `${resolve(process.argv[2])}/` : fileURLToPath(new URL("output/", import.meta.url));

function wav(name) {
    const bytes = readFileSync(`${base}audio/${name}.wav`);
    return {
        samples: new Int16Array(bytes.buffer, bytes.byteOffset + 44, bytes.readUInt32LE(40) / 2),
        rate: bytes.readUInt32LE(24),
    };
}

function rms(audio, start, end, channel = 0) {
    let sum = 0;
    const first = Math.round(start * audio.rate);
    const last = Math.round(end * audio.rate);
    for (let frame = first; frame < last; frame++) sum += (audio.samples[frame * 2 + channel] / 32768) ** 2;
    return Math.sqrt(sum / (last - first));
}

function crossingFrequency(audio, start, end, channel = 0) {
    const positions = [];
    for (let frame = Math.round(start * audio.rate) + 1; frame < Math.round(end * audio.rate); frame++) {
        const previous = audio.samples[(frame - 1) * 2 + channel];
        const current = audio.samples[frame * 2 + channel];
        if (previous < 0 && current >= 0) positions.push(frame - 1 - previous / (current - previous));
    }
    return (positions.length - 1) * audio.rate / (positions.at(-1) - positions[0]);
}

function difference(a, b) {
    let sum = 0;
    for (let i = 0; i < a.samples.length; i++) sum += ((a.samples[i] - b.samples[i]) / 32768) ** 2;
    return Math.sqrt(sum / a.samples.length);
}

const checks = [];

function check(name, pass, measured) {
    checks.push({ name, pass, measured });
}

const before = wav("custom-gain-before-pan");
const after = wav("custom-gain-after-pan");
const gainRatio = rms(after, 0.1, 1.9) / rms(before, 0.1, 1.9);
check("Gain is independent of effect initialization order", Math.abs(gainRatio - 1) < 0.001, {
    afterToBeforeRatio: gainRatio,
    expected: 1,
});

const unity = wav("custom-gain-unity");
const lfo = wav("custom-gain-lfo");
const lfoDifference = difference(unity, lfo);
check("Gain LFO changes the waveform", lfoDifference > 0.005, { differenceRms: lfoDifference });

const tied = wav("custom-chord-tie");
const untied = wav("custom-chord-tie-reference");
const tieTail = rms(tied, 2, 9);
const tieRest = rms(tied, 1.2, 1.8);
check("Tied chord releases every voice", tieRest < 0.0001 && tieTail < 0.0001, {
    restBeforeArrangementEndRms: tieRest,
    tailRms: tieTail,
    referenceTailRms: rms(untied, 2, 9),
});

const ramp = wav("custom-scale-ramp");
const rampReference = wav("custom-scale-ramp-reference");
const scaledFrequency = crossingFrequency(ramp, 0.2, 1.8);
const referenceFrequency = crossingFrequency(rampReference, 0.2, 1.8);
check("Scale-degree glide matches equivalent MIDI glide", Math.abs(scaledFrequency / referenceFrequency - 1) < 0.02, {
    scaledFrequency,
    referenceFrequency,
});

const split = wav("custom-split-arrange");
const outsideLeft = rms(split, 0.1, 1.9, 0);
const outsideRight = rms(split, 0.1, 1.9, 1);
check("Split stereo obeys parent arrangement boundaries", outsideLeft < 0.0001 && outsideRight < 0.0001, {
    outsideLeft,
    outsideRight,
});

const dsp = wav("custom-dsp-documented");
check("Documented per-sample DSP generates audio", rms(dsp, 0, 10) > 0.001, {
    documentedRms: rms(dsp, 0, 10),
    inputPassthroughRms: rms(wav("custom-dsp-block-reference"), 0, 10),
});

const stretch = wav("custom-sample-48000-stretch");
let stereoDifference = 0;
for (let frame = 0; frame < stretch.samples.length / 2; frame++) stereoDifference += (stretch.samples[frame * 2] - stretch.samples[frame * 2 + 1]) ** 2;
check("Granular stretching preserves distinct stereo channels", stereoDifference > 0, { summedChannelDifferenceSquared: stereoDifference });

const wrongRate = wav("custom-sample-24000-stretch");
const wrongFrequency = crossingFrequency(wrongRate, 0.015, 0.04);
check("Granular stretching preserves pitch with a different buffer sample rate", Math.abs(wrongFrequency - 440) < 10, {
    frequency: wrongFrequency,
    expected: 440,
});

const flatSlices = wav("custom-slices-flat");
const nestedSlices = wav("custom-slices-nested");
const nestedEnergy = rms(nestedSlices, 1.1, 1.4);
check("Nested slice indices produce subdivided audio", nestedEnergy > 0.001, {
    nestedRms: nestedEnergy,
    flatRms: rms(flatSlices, 1.1, 1.4),
});

const stolen = wav("custom-voice-limit-1");
const polyphonic = wav("custom-voice-limit-8");
const preOnsetEnergy = rms(stolen, 0.45, 0.48);
check("Voice stealing preserves audio until the replacement onset", preOnsetEnergy > 0.02, {
    preOnsetRms: preOnsetEnergy,
    referenceRms: rms(polyphonic, 0.45, 0.48),
});

writeFileSync(`${base}checks.json`, JSON.stringify(checks, null, 2) + "\n");
for (const result of checks) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.measured)}`);
process.exitCode = checks.some(result => !result.pass) ? 1 : 0;
