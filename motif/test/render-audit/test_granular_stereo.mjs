import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const tag = process.argv[2];
if (!tag || !/^[a-z0-9-]+$/.test(tag)) {
    throw new Error("Usage: bun test/render-audit/test_granular_stereo.mjs <unused-tag>");
}

const cases = {
    stereo: "custom-sample-48000-stretch.js",
    mono: "f8-granular-mono.js",
    repeated: "f8-granular-repeated.js",
    split: "f8-granular-split.js",
};
const outputDir = resolve(import.meta.dir, "output");
const audioDir = resolve(outputDir, "audio");
const logDir = resolve(outputDir, `f8-${tag}-logs`);
const metricsPath = resolve(outputDir, `f8-${tag}-checks.json`);
mkdirSync(audioDir, { recursive: true });
mkdirSync(logDir);

for (const [name, fixture] of Object.entries(cases)) {
    const wavPath = resolve(audioDir, `f8-${tag}-${name}.wav`);
    const process = Bun.spawn([
        "python3",
        resolve(root, "render_wav.py"),
        resolve(import.meta.dir, "songs", fixture),
        wavPath,
        "--seconds",
        "3",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    writeFileSync(resolve(logDir, `${name}.log`), stdout + stderr);
    if (exitCode !== 0) throw new Error(`${name} render failed with exit code ${exitCode}`);
}

function wav(name) {
    const bytes = readFileSync(resolve(audioDir, `f8-${tag}-${name}.wav`));
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`${name} is not a WAV file`);
    }
    const channels = bytes.readUInt16LE(22);
    const rate = bytes.readUInt32LE(24);
    const dataBytes = bytes.readUInt32LE(40);
    if (channels !== 2 || bytes.readUInt16LE(34) !== 16) throw new Error(`${name} must be 16-bit stereo PCM`);
    return {
        samples: new Int16Array(bytes.buffer, bytes.byteOffset + 44, dataBytes / 2),
        channels,
        rate,
    };
}

function rms(audio, start, end, channel) {
    let sum = 0;
    const first = Math.round(start * audio.rate);
    const last = Math.round(end * audio.rate);
    for (let frame = first; frame < last; frame++) {
        const sample = audio.samples[frame * audio.channels + channel] / 32768;
        sum += sample * sample;
    }
    return Math.sqrt(sum / (last - first));
}

function differenceRms(audio, start, end) {
    let sum = 0;
    const first = Math.round(start * audio.rate);
    const last = Math.round(end * audio.rate);
    for (let frame = first; frame < last; frame++) {
        const offset = frame * audio.channels;
        const difference = (audio.samples[offset] - audio.samples[offset + 1]) / 32768;
        sum += difference * difference;
    }
    return Math.sqrt(sum / (last - first));
}

function spectralMagnitude(audio, start, end, channel, targetHz) {
    let real = 0;
    let imaginary = 0;
    const first = Math.round(start * audio.rate);
    const last = Math.round(end * audio.rate);
    for (let frame = first; frame < last; frame++) {
        const sample = audio.samples[frame * audio.channels + channel] / 32768;
        const phase = 2 * Math.PI * targetHz * frame / audio.rate;
        real += sample * Math.cos(phase);
        imaginary -= sample * Math.sin(phase);
    }
    return 2 * Math.hypot(real, imaginary) / (last - first);
}

const results = [];

function check(name, pass, measured) {
    results.push({ name, pass, measured });
}

function checkStereo(name, audio, start, end) {
    const measured = {
        left440Magnitude: spectralMagnitude(audio, start, end, 0, 440),
        left660Magnitude: spectralMagnitude(audio, start, end, 0, 660),
        right440Magnitude: spectralMagnitude(audio, start, end, 1, 440),
        right660Magnitude: spectralMagnitude(audio, start, end, 1, 660),
        leftRms: rms(audio, start, end, 0),
        rightRms: rms(audio, start, end, 1),
        differenceRms: differenceRms(audio, start, end),
    };
    check(name,
        measured.left440Magnitude > measured.left660Magnitude * 5
        && measured.right660Magnitude > measured.right440Magnitude * 5
        && measured.leftRms > 0.02
        && measured.rightRms > 0.02
        && measured.differenceRms > 0.02,
        measured);
}

checkStereo("stereo source preserves 440 Hz left and 660 Hz right", wav("stereo"), 0.1, 0.4);
const mono = wav("mono");
const monoMeasured = {
    left440Magnitude: spectralMagnitude(mono, 0.1, 0.4, 0, 440),
    left660Magnitude: spectralMagnitude(mono, 0.1, 0.4, 0, 660),
    right440Magnitude: spectralMagnitude(mono, 0.1, 0.4, 1, 440),
    right660Magnitude: spectralMagnitude(mono, 0.1, 0.4, 1, 660),
    leftRms: rms(mono, 0.1, 0.4, 0),
    rightRms: rms(mono, 0.1, 0.4, 1),
    differenceRms: differenceRms(mono, 0.1, 0.4),
};
check("mono source reaches both output channels", monoMeasured.left440Magnitude > monoMeasured.left660Magnitude * 5
    && monoMeasured.right440Magnitude > monoMeasured.right660Magnitude * 5
    && monoMeasured.leftRms > 0.02 && monoMeasured.rightRms > 0.02
    && monoMeasured.differenceRms === 0, monoMeasured);
const repeated = wav("repeated");
for (const [index, start] of [0.1, 0.6, 1.1].entries()) {
    checkStereo(`repeated stereo note ${index + 1} preserves both channels`, repeated, start, start + 0.3);
}
checkStereo("splitStereo routes selected source channels to opposite sides", wav("split"), 0.1, 0.4);

writeFileSync(metricsPath, JSON.stringify(results, null, 2) + "\n", { flag: "wx" });
for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.measured)}`);
if (results.some(result => !result.pass)) process.exitCode = 1;
