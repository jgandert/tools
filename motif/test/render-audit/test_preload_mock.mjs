import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const tag = process.argv[2];
if (!tag || !/^[a-z0-9-]+$/.test(tag)) {
    throw new Error("Usage: bun test/render-audit/test_preload_mock.mjs <unused-tag>");
}

const cases = {
    feature: resolve(import.meta.dir, "songs/feature-37.js"),
    failure: resolve(import.meta.dir, "f11-failure-cleanup.motif.js"),
};
const outputDir = resolve(import.meta.dir, "output");
const audioDir = resolve(outputDir, "audio");
const logDir = resolve(outputDir, `f11-${tag}-logs`);
const metricsPath = resolve(outputDir, `f11-${tag}-checks.json`);
mkdirSync(audioDir, { recursive: true });
mkdirSync(logDir);

for (const [name, fixture] of Object.entries(cases)) {
    const wavPath = resolve(audioDir, `f11-${tag}-${name}.wav`);
    const process = Bun.spawn([
        "python3",
        resolve(root, "render_wav.py"),
        fixture,
        wavPath,
        "--seconds",
        name === "feature" ? "10" : "2",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    writeFileSync(resolve(logDir, `${name}.log`), stdout + stderr);
    if (exitCode !== 0) throw new Error(`${name} render failed with exit code ${exitCode}`);
}

function metrics(name) {
    const bytes = readFileSync(resolve(audioDir, `f11-${tag}-${name}.wav`));
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`${name} is not a WAV file`);
    }
    const channels = bytes.readUInt16LE(22);
    const frames = bytes.readUInt32LE(40) / (channels * 2);
    let peak = 0;
    let square = 0;
    let nonzeroSamples = 0;
    for (let index = 0; index < frames * channels; index++) {
        const sample = bytes.readInt16LE(44 + index * 2) / 32768;
        peak = Math.max(peak, Math.abs(sample));
        square += sample * sample;
        if (sample !== 0) nonzeroSamples++;
    }
    return {
        seconds: frames / bytes.readUInt32LE(24),
        peak,
        rms: Math.sqrt(square / (frames * channels)),
        nonzeroSamples,
    };
}

const results = [
    {
        name: "showcase manifest sample decodes and produces audio",
        measured: metrics("feature"),
    },
    {
        name: "decode failure propagates and restores preload mocks",
        measured: metrics("failure"),
    },
];
for (const result of results) {
    result.pass = result.measured.rms > 0.001 && result.measured.nonzeroSamples > 0;
}

writeFileSync(metricsPath, JSON.stringify(results, null, 2) + "\n", { flag: "wx" });
for (const result of results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.measured)}`);
}
if (results.some(result => !result.pass)) process.exitCode = 1;
