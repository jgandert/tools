import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const base = process.argv[2] ? `${resolve(process.argv[2])}/` : fileURLToPath(new URL("output/", import.meta.url));
const results = [];
for (const name of readdirSync(`${base}audio`).filter(name => name.endsWith(".wav"))) {
    const bytes = readFileSync(`${base}audio/${name}`);
    if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") continue;
    const rate = bytes.readUInt32LE(24);
    const frames = bytes.readUInt32LE(40) / 4;
    if (bytes.length !== frames * 4 + 44) continue;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset + 44, frames * 2);
    const windows = [];
    const width = Math.round(rate / 10);
    let peak = 0, sum = 0, square = 0, left = 0, right = 0, cross = 0, jump = 0, rails = 0;
    for (let start = 0; start < frames; start += width) {
        const end = Math.min(frames, start + width);
        let energy = 0;
        for (let i = start; i < end; i++) {
            const l = samples[i * 2] / 32768;
            const r = samples[i * 2 + 1] / 32768;
            peak = Math.max(peak, Math.abs(l), Math.abs(r));
            sum += l + r;
            left += l * l;
            right += r * r;
            cross += l * r;
            energy += l * l + r * r;
            if (Math.abs(samples[i * 2]) >= 32767) rails++;
            if (Math.abs(samples[i * 2 + 1]) >= 32767) rails++;
            if (i) jump = Math.max(jump, Math.abs(l - samples[(i - 1) * 2] / 32768), Math.abs(r - samples[(i - 1) * 2 + 1] / 32768));
        }
        square += energy;
        windows.push(Math.sqrt(energy / ((end - start) * 2)));
    }
    results.push({
        name,
        seconds: frames / rate,
        rate,
        peak,
        rms: Math.sqrt(square / (frames * 2)),
        dc: sum / (frames * 2),
        leftRms: Math.sqrt(left / frames),
        rightRms: Math.sqrt(right / frames),
        correlation: cross / Math.sqrt(left * right),
        maxAdjacentJump: jump,
        rails,
        silentWindows: windows.filter(rms => rms < 0.0001).length,
        rms100ms: windows,
    });
}
writeFileSync(`${base}metrics.json`, JSON.stringify(results, null, 2) + "\n");
for (const { rms100ms, ...result } of results) console.log(JSON.stringify(result));
