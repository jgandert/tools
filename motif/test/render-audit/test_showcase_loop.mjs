import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const tag = process.argv[2];
if (!tag || !/^[a-z0-9-]+$/.test(tag)) {
    throw new Error("Usage: bun test/render-audit/test_showcase_loop.mjs <unused-tag>");
}

const outputDir = resolve(import.meta.dir, "output");
const audioDir = resolve(outputDir, "audio");
const logDir = resolve(outputDir, `f12-${tag}-logs`);
const metricsPath = resolve(outputDir, `f12-${tag}-checks.json`);
const wavPath = resolve(audioDir, `f12-${tag}-feature-24.wav`);
mkdirSync(audioDir, { recursive: true });
mkdirSync(logDir);

async function run(command) {
    const process = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
}

const probe = await run(["bun", resolve(import.meta.dir, "probe-showcase-loop.mjs")]);
writeFileSync(resolve(logDir, "generator.log"), probe.output, { flag: "wx" });
if (probe.exitCode !== 0) throw new Error(`generator assertions failed with exit code ${probe.exitCode}`);
const generator = JSON.parse(probe.output);

const render = await run([
    "python3",
    resolve(root, "render_wav.py"),
    resolve(import.meta.dir, "songs/feature-24.js"),
    wavPath,
    "--seconds",
    "10",
]);
writeFileSync(resolve(logDir, "feature-24.log"), render.output, { flag: "wx" });
if (render.exitCode !== 0) throw new Error(`feature-24 render failed with exit code ${render.exitCode}`);

const bytes = readFileSync(wavPath);
if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("feature-24 output is not a WAV file");
}
const channels = bytes.readUInt16LE(22);
const rate = bytes.readUInt32LE(24);
const bitsPerSample = bytes.readUInt16LE(34);
const dataBytes = bytes.readUInt32LE(40);
if (channels !== 2 || bitsPerSample !== 16) throw new Error("feature-24 output must be 16-bit stereo PCM");

let peak = 0;
let squareSum = 0;
let nonzeroSamples = 0;
let railSamples = 0;
const samples = dataBytes / 2;
for (let index = 0; index < samples; index++) {
    const sample = bytes.readInt16LE(44 + index * 2) / 32768;
    peak = Math.max(peak, Math.abs(sample));
    squareSum += sample * sample;
    if (sample !== 0) nonzeroSamples++;
    if (Math.abs(sample) >= 32767 / 32768) railSamples++;
}
const rendered = {
    seconds: dataBytes / (channels * 2) / rate,
    peak,
    rms: Math.sqrt(squareSum / samples),
    nonzeroSamples,
    railSamples,
};
const checks = [
    {
        name: "showcase generator has bounded decays and intended onsets",
        pass: generator.nonFinite === 0
            && generator.overRange === 0
            && generator.expArgumentRange[1] <= 0
            && generator.expArgumentRange[0] >= -6
            && generator.beatOnsets.length === 8
            && generator.hihatResiduals.length === 8,
        measured: generator,
    },
    {
        name: "showcase feature 24 renders audible unclipped slice audio",
        pass: rendered.rms > 0.005
            && rendered.peak > 0.05
            && rendered.peak < 1
            && rendered.nonzeroSamples > rate
            && rendered.railSamples === 0,
        measured: rendered,
    },
];

writeFileSync(metricsPath, JSON.stringify(checks, null, 2) + "\n", { flag: "wx" });
for (const check of checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}: ${JSON.stringify(check.measured)}`);
}
if (checks.some(check => !check.pass)) process.exitCode = 1;
