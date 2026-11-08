#!/usr/bin/env bun
/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

// These source parameters were reserved before the exact-support experiment.
// Synthetic block offsets exercise correlation; they are not JPEG encoding.
const protocol = {
    width: 88,
    height: 80,
    scale: 4,
    paints: [[29, 57, 88], [208, 158, 65]],
    shapes: [
        {
            name: "notched-pale-chevron",
            kind: "chevron",
            center: [19.25, 28.5],
            scale: 5,
            paint: [178, 192, 180],
        },
        {
            name: "near-blue-slanted-lozenge",
            kind: "lozenge",
            center: [23.5, 56.25],
            scale: 8,
            paint: [35, 65, 101],
        },
        {
            name: "off-mixture-offset-hairline-segments",
            kind: "offset-segments",
            center: [64.25, 25.5],
            scale: 12,
            paint: [121, 116, 104],
        },
        {
            name: "midpoint-offset-triangle",
            kind: "triangle",
            center: [44.25, 56.75],
            scale: 5,
            paint: [119, 108, 77],
        },
    ],
    profiles: ["clean", "independent-jitter6", "columns10", "synthetic-blocks10"],
    noises: [0, 10, 20, 40],
    colors: [0, 6],
};
const { width, height, scale } = protocol;

function inside(shape, x, y) {
    const u = x - shape.center[0], v = y - shape.center[1], s = shape.scale;
    if (shape.kind === "chevron") return Math.abs(u) < s && Math.abs(v) < s && !(u > 0 && Math.abs(v) < u * .7);
    if (shape.kind === "lozenge") return Math.abs(u + v * .32) + Math.abs(v) * .8 < s;
    if (shape.kind === "offset-segments") return u >= -s && u < s && Math.abs(v - (u > 0 ? 2 : 0)) < .6;
    return v >= -s && v < s && Math.abs(u) < (v + s) * .45;
}

function perturbation(profile, x, y, channel) {
    let value = Math.imul(x + 3, 73856093) ^ Math.imul(y + 5, 19349663) ^ Math.imul(channel + 7, 83492791);
    if (profile === "columns10") value = Math.imul(x + 3, 73856093);
    if (profile === "synthetic-blocks10") value = Math.imul(Math.floor(x / 8) + 3, 73856093) ^ Math.imul(Math.floor(y / 8) + 5, 19349663) ^ Math.imul(channel + 7, 83492791);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    if (profile === "clean") return 0;
    return Math.round(((value >>> 0) / 4294967296 * 2 - 1) * (profile === "independent-jitter6" ? 6 : 10));
}

function source(profile, accents) {
    const data = new Uint8ClampedArray(width * height * 4), owners = new Int8Array(width * height);
    const masks = protocol.shapes.map(() => []), edgePixels = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const pixel = y * width + x, sum = [0, 0, 0], coverage = protocol.shapes.map(() => 0);
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const xx = x + (dx + .5) / scale, yy = y + (dy + .5) / scale;
            let rgb = protocol.paints[xx < width / 2 ? 0 : 1];
            for (let index = 0; index < protocol.shapes.length; index++) if (inside(protocol.shapes[index], xx, yy)) {
                if (accents) rgb = protocol.shapes[index].paint;
                coverage[index]++;
            }
            for (let channel = 0; channel < 3; channel++) sum[channel] += rgb[channel];
        }
        for (let channel = 0; channel < 3; channel++) data[4 * pixel + channel] = Math.max(0, Math.min(255, Math.round(sum[channel] / scale ** 2) + perturbation(profile, x, y, channel)));
        data[4 * pixel + 3] = 255;
        owners[pixel] = x + .5 < width / 2 ? 0 : 1;
        for (let index = 0; index < coverage.length; index++) if (coverage[index] >= .75 * scale ** 2) masks[index].push(pixel);
        if (coverage.some(value => value > 0)) edgePixels.push(pixel);
    }
    // Keep the same measurement area in the paired accent-free source.
    const excluded = new Set();
    for (const pixel of edgePixels) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (pixel % width + dx < 0 || pixel % width + dx >= width || Math.floor(pixel / width) + dy < 0 || Math.floor(pixel / width) + dy >= height) continue;
        excluded.add(pixel + dy * width + dx);
    }
    return { image: { width, height, data }, owners, masks, excluded };
}

function mode(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0];
}

function largestComponent(mask, labels, label) {
    const remaining = new Set(mask.filter(pixel => labels[pixel] === label));
    let largest = 0;
    while (remaining.size) {
        const queue = [remaining.values().next().value];
        remaining.delete(queue[0]);
        let count = 0;
        while (queue.length) {
            const pixel = queue.pop();
            count++;
            for (const neighbor of [pixel % width ? pixel - 1 : -1, pixel % width + 1 < width ? pixel + 1 : -1, pixel - width, pixel + width]) {
                if (remaining.delete(neighbor)) queue.push(neighbor);
            }
        }
        largest = Math.max(largest, count);
    }
    return largest;
}

function metrics(result, input, accents) {
    const labels = result.debug.labels;
    const palette = result.stats.palette.map(hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)));
    const broadPixels = Array.from(input.owners, (_, pixel) => pixel).filter(pixel => !input.excluded.has(pixel));
    const baseModes = protocol.paints.map((_, owner) => mode(broadPixels.filter(pixel => input.owners[pixel] === owner).map(pixel => labels[pixel]))[0]);
    return {
        colorsFound: palette.length,
        regions: result.stats.visibleRegions,
        fallbackChains: result.stats.fallbackChains,
        broadPixelsOutsideOwnBaseMode: broadPixels.filter(pixel => labels[pixel] !== baseModes[input.owners[pixel]]).length,
        targets: accents ? input.masks.map((mask, index) => {
            const [label, count] = mode(mask.map(pixel => labels[pixel])), paint = palette[label];
            const expected = [0, 0, 0], measured = [0, 0, 0];
            for (const pixel of mask) for (let channel = 0; channel < 3; channel++) {
                expected[channel] += (protocol.shapes[index].paint[channel] - protocol.paints[input.owners[pixel]][channel]) / mask.length;
                measured[channel] += (paint[channel] - palette[baseModes[input.owners[pixel]]][channel]) / mask.length;
            }
            const dot = expected.reduce((sum, value, channel) => sum + value * measured[channel], 0);
            const expectedNorm = Math.hypot(...expected), measuredNorm = Math.hypot(...measured);
            const cosine = expectedNorm && measuredNorm ? dot / (expectedNorm * measuredNorm) : 0;
            const projection = expectedNorm ? dot / expectedNorm ** 2 : 0;
            const distinct = mask.filter(pixel => labels[pixel] !== baseModes[input.owners[pixel]]).length / mask.length;
            const coherent = largestComponent(mask, labels, label) / mask.length;
            return {
                shape: protocol.shapes[index].name,
                pixels: mask.length,
                recognized: count / mask.length >= .6 && distinct >= .6 && coherent >= .5 && cosine >= .5 && projection >= .25,
                labelShare: count / mask.length,
                distinct,
                coherent,
                cosine,
                projection,
                paint,
            };
        }) : [],
    };
}

function parseArgs(argv) {
    const config = { cores: [], out: null };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === "--help") return { help: true };
        if (!["--core", "--out"].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith("--")) throw Error(`Expected --core PATH or --out UNUSED.json; received ${flag}.`);
        const value = resolve(argv[++index]);
        if (flag === "--core") config.cores.push(value);
        if (flag === "--out") config.out = value;
    }
    if (!config.cores.length || !config.out) throw Error("Provide at least one --core PATH and --out UNUSED.json.");
    return config;
}

async function main() {
    const config = parseArgs(process.argv.slice(2));
    if (config.help) {
        process.stdout.write("Usage: bun tests/campaign-weak-paints.js --core PATH [--core PATH ...] --out UNUSED.json\n");
        return;
    }
    const output = await Bun.file(config.out).exists();
    if (output) throw Error(`Output already exists: ${config.out}`);
    const rows = [], cores = [];
    for (const [index, path] of config.cores.entries()) {
        const text = await readFile(path, "utf8"), name = `${index + 1}-${basename(path)}`;
        cores.push({ name, path, sha256: createHash("sha256").update(text).digest("hex") });
        const tracer = new Function(`${text}\nreturn createTracer();`)();
        for (const profile of protocol.profiles) for (const noise of protocol.noises) for (const colors of protocol.colors) for (const accents of [false, true]) {
            const input = source(profile, accents);
            const result = tracer.trace(input.image, { noise, colors, minArea: 0, debug: true });
            rows.push({
                core: name,
                profile,
                noise,
                colors,
                accents, ...metrics(result, input, accents),
            });
        }
    }
    const summary = cores.map(({ name }) => ({
        core: name,
        recognizedTargets: rows.filter(row => row.core === name).flatMap(row => row.targets).filter(target => target.recognized).length,
        targetConfigurations: 128,
    }));
    await writeFile(config.out, `${JSON.stringify({
        schema: "campaign-weak-paints-v1",
        protocol,
        cores,
        summary,
        rows,
    }, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ summary, out: config.out })}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
