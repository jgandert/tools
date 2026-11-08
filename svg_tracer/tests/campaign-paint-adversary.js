#!/usr/bin/env bun
/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/*
 * Standalone paint-recovery adversary for correlated source variation.
 *
 * Reproduce a comparison by passing any number of self-contained tracer cores:
 *   bun tests/campaign-paint-adversary.js --core BASELINE.js --core CANDIDATE.js --out /tmp/paint-adversary.json
 *
 * Inputs are generated in memory: 64x64 two-color vertical splits, 4x
 * supersampled midpoint or near-midpoint accents, rotated/offset variants,
 * thin strokes, and a blank split. Correlated patterns are column jitter, row
 * jitter, an 8-pixel luminance ramp, and synthetic 8x8 block DC/AC variation;
 * the unperturbed pattern is the clean control. This block pattern is not
 * JPEG encoding. The original sweep uses amplitudes 8/16, phases 0/2, noise
 * options 0/10/20/40, and Auto/explicit-three-color settings. `--smoke` keeps
 * the clean control and the midpoint/near-midpoint and blank column-jitter
 * cases that distinguish promotion-evidence losses from raw-source false
 * paints. It runs 24 inputs per core.
 *
 * A target paint is the nearest output palette entry within RGB distance 48
 * of the mean perturbed source color over ground-truth pixels with >=0.6
 * downsampled feature coverage. Label recall counts those pixels assigned to
 * that palette entry. These metrics test paint identity and assignment, not
 * SVG contour quality. The boundary-touching midpoint square is intentional
 * by construction here; this does not infer whether a boundary tint in real
 * artwork is an intentional paint. Thin strokes are included as controls,
 * but the original baseline rarely recovers them, so this experiment is weak
 * evidence about stroke preservation. In the earlier comparison, the
 * promotion-evidence variant dropped isolated 4x4 midpoint and near-midpoint
 * paints under amplitude-8 column jitter at noise 10 (baseline recall 1 to
 * 0); the source-centroid recoloring variant added two recovered paint shades to the
 * blank two-color control under amplitude-16 column jitter at noise 10. The
 * source-centroid validation variant matched baseline on that matrix. These
 * are recorded challenge signals, not semantic judgments about real boundary
 * tints or a promise that every core will exhibit the same failures.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";

const width = 64, height = 64, scale = 4;
const colorA = [20, 50, 90], colorB = [210, 150, 40];
const midpoint = [115, 100, 65], nearMidpoint = [115, 106, 59];
const targetDistanceLimit = 48;

function help() {
    process.stdout.write(`Usage: bun tests/campaign-paint-adversary.js --core PATH [--core PATH ...] --out UNUSED.json [--smoke]\n\n` +
        `Each --core is a standalone source file defining createTracer(). Repeat --core to compare cores in one run.\n` +
        `--smoke runs 24 clean, correlated-column, and blank-control cases per core. The default runs the full 1,440-case matrix per core.\n` +
        `--out must not already exist; writes the generated inputs' palette and target-label metrics as JSON.\n`);
}

function parseArgs(argv) {
    const parsed = { cores: [], out: null, smoke: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") parsed.help = true;
        else if (arg === "--smoke") parsed.smoke = true;
        else if (arg === "--core") {
            if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--core requires a source path");
            parsed.cores.push(resolve(argv[++i]));
        } else if (arg === "--out") {
            if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--out requires an unused output path");
            parsed.out = resolve(argv[++i]);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!parsed.help && parsed.cores.length === 0) throw new Error("Provide at least one --core PATH");
    if (!parsed.help && !parsed.out) throw new Error("Provide --out UNUSED.json");
    return parsed;
}

function hash01(a, b, seed) {
    let value = Math.imul(a + 1, 0x45d9f3b) ^ Math.imul(b + 1, 0x119de1f3) ^ seed;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967296;
}

function perturbation(pattern, x, y, amp, phase, seed) {
    if (pattern === "none") return [0, 0, 0];
    if (pattern === "column-jitter") {
        const value = Math.round((hash01(x, 0, seed) * 2 - 1) * amp);
        return [value, Math.round(value * .7), Math.round(value * .4)];
    }
    if (pattern === "row-jitter") {
        const value = Math.round((hash01(0, y, seed) * 2 - 1) * amp);
        return [value, value, Math.round(value * .8)];
    }
    if (pattern === "luminance-ramp") {
        const value = Math.round(amp * Math.sin(2 * Math.PI * (x + phase) / 8));
        return [value, value, value];
    }
    if (pattern === "jpeg8x8-blocks") {
        const bx = Math.floor(x / 8), by = Math.floor(y / 8);
        const dc = Math.round((hash01(bx, by, seed) * 2 - 1) * amp);
        const px = x % 8, py = y % 8;
        const ac = Math.round(amp * .18 * Math.cos(Math.PI * px / 4) * Math.cos(Math.PI * py / 4));
        return [dc + ac, Math.round(-dc * .35 + ac * .5), Math.round(-dc * .7 - ac * .5)];
    }
    throw new Error(`Unknown perturbation: ${pattern}`);
}

function makeImage(config) {
    const highWidth = width * scale, highHeight = height * scale;
    const high = new Uint8Array(highWidth * highHeight * 3);
    const highMask = new Uint8Array(highWidth * highHeight);
    const centerX = config.position === "boundary" ? 32 : 17;
    const centerY = 32;
    const cx = scale * (centerX + config.offsetX);
    const cy = scale * (centerY + config.offsetY);
    const angle = config.angle * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const featureColor = config.color === "near" ? nearMidpoint : midpoint;

    for (let y = 0; y < highHeight; y++) {
        for (let x = 0; x < highWidth; x++) {
            const i = 3 * (y * highWidth + x);
            let color = x + .5 < 32 * scale ? colorA : colorB;
            let inside = false;
            if (config.feature === "square") {
                const dx = x + .5 - cx, dy = y + .5 - cy;
                const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
                inside = Math.abs(u) <= config.size * scale / 2 && Math.abs(v) <= config.size * scale / 2;
            } else if (config.feature === "stroke") {
                const dx = x + .5 - cx, dy = y + .5 - cy;
                const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
                inside = Math.abs(u) <= config.length * scale / 2 && Math.abs(v) <= config.strokeWidth * scale / 2;
            }
            if (inside) color = featureColor;
            highMask[y * highWidth + x] = inside ? 1 : 0;
            high[i] = color[0];
            high[i + 1] = color[1];
            high[i + 2] = color[2];
        }
    }

    const data = new Uint8ClampedArray(width * height * 4);
    const coverage = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x, i = 4 * p;
            let sr = 0, sg = 0, sb = 0, count = 0;
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const q = (y * scale + dy) * highWidth + (x * scale + dx), j = 3 * q;
                    sr += high[j];
                    sg += high[j + 1];
                    sb += high[j + 2];
                    coverage[p] += highMask[q];
                    count++;
                }
            }
            data[i] = Math.round(sr / count);
            data[i + 1] = Math.round(sg / count);
            data[i + 2] = Math.round(sb / count);
            data[i + 3] = 255;
            coverage[p] /= count;
        }
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = 4 * (y * width + x);
            const [dr, dg, db] = perturbation(config.pattern, x, y, config.amplitude, config.phase, config.seed);
            data[i] = Math.max(0, Math.min(255, data[i] + dr));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + dg));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + db));
        }
    }
    return { width, height, data, coverage };
}

const geometries = [
    {
        name: "mix-isolated-axis",
        feature: "square",
        color: "mix",
        position: "isolated",
        angle: 0,
        offsetX: 0,
        offsetY: 0,
        size: 4,
    },
    {
        name: "mix-boundary-axis",
        feature: "square",
        color: "mix",
        position: "boundary",
        angle: 0,
        offsetX: 0,
        offsetY: 0,
        size: 4,
    },
    {
        name: "mix-isolated-rotated-half-pixel",
        feature: "square",
        color: "mix",
        position: "isolated",
        angle: 45,
        offsetX: .5,
        offsetY: .5,
        size: 4,
    },
    {
        name: "near-isolated-axis",
        feature: "square",
        color: "near",
        position: "isolated",
        angle: 0,
        offsetX: 0,
        offsetY: 0,
        size: 4,
    },
    {
        name: "near-boundary-rotated-half-pixel",
        feature: "square",
        color: "near",
        position: "boundary",
        angle: 45,
        offsetX: .5,
        offsetY: .5,
        size: 4,
    },
    {
        name: "stroke-mix-horizontal",
        feature: "stroke",
        color: "mix",
        position: "isolated",
        angle: 0,
        offsetX: 0,
        offsetY: .5,
        length: 18,
        strokeWidth: 1,
    },
    {
        name: "stroke-near-diagonal-half-pixel",
        feature: "stroke",
        color: "near",
        position: "isolated",
        angle: 45,
        offsetX: .5,
        offsetY: .5,
        length: 22,
        strokeWidth: 1.5,
    },
    {
        name: "stroke-mix-two-pixel",
        feature: "stroke",
        color: "mix",
        position: "isolated",
        angle: 90,
        offsetX: .5,
        offsetY: 0,
        length: 20,
        strokeWidth: 2,
    },
    {
        name: "blank-boundary",
        feature: "none",
        color: null,
        position: "boundary",
        angle: 0,
        offsetX: 0,
        offsetY: 0,
        size: 0,
    },
];

function rgbFromHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!match) throw new Error(`Unexpected palette color: ${hex}`);
    return [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16));
}

function makeCoreLabel(path, index, pathCounts) {
    const base = basename(path, extname(path)) || `core-${index + 1}`;
    const count = (pathCounts.get(base) || 0) + 1;
    pathCounts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
}

async function loadCores(paths) {
    const pathCounts = new Map(), cores = [];
    for (let index = 0; index < paths.length; index++) {
        const path = paths[index];
        const source = await readFile(path, "utf8");
        const tracer = new Function(`${source}\nreturn createTracer();`)();
        if (!tracer || typeof tracer.trace !== "function") throw new Error(`Core does not define a tracer: ${path}`);
        cores.push({
            name: makeCoreLabel(path, index, pathCounts),
            path,
            sha256: createHash("sha256").update(source).digest("hex"),
            tracer,
        });
    }
    return cores;
}

async function assertUnused(path) {
    try {
        await access(path);
        throw new Error(`Output already exists: ${path}`);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function selectedMatrix(smoke) {
    const selectedGeometries = smoke
        ? geometries.filter(g => ["mix-isolated-axis", "near-isolated-axis", "blank-boundary"].includes(g.name))
        : geometries;
    return {
        geometries: selectedGeometries,
        patterns: smoke ? ["none", "column-jitter"] : ["none", "column-jitter", "row-jitter", "luminance-ramp", "jpeg8x8-blocks"],
        amplitudes: smoke ? [8, 16] : [8, 16],
        phases: smoke ? [0] : [0, 2],
        noises: smoke ? [10] : [0, 10, 20, 40],
        colorOptions: [0, 3],
    };
}

function traceRecord(core, image, geometry, pattern, amplitude, phase, noise, colors) {
    const featurePixels = [];
    for (let p = 0; p < image.coverage.length; p++) if (image.coverage[p] >= .6) featurePixels.push(p);
    const targetRGB = featurePixels.length
        ? [0, 1, 2].map(c => Math.round(featurePixels.reduce((sum, p) => sum + image.data[4 * p + c], 0) / featurePixels.length))
        : null;
    const result = core.tracer.trace({
        width: image.width,
        height: image.height,
        data: image.data,
    }, { colors, noise, minArea: 0, debug: true });
    let nearestIndex = -1, nearestDistance = Infinity;
    if (targetRGB) for (let i = 0; i < result.stats.palette.length; i++) {
        const rgb = rgbFromHex(result.stats.palette[i]);
        const distance = Math.hypot(rgb[0] - targetRGB[0], rgb[1] - targetRGB[1], rgb[2] - targetRGB[2]);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = i;
        }
    }
    const targetPaintPresent = targetRGB !== null && nearestDistance <= targetDistanceLimit;
    const targetLabelPixels = targetPaintPresent
        ? featurePixels.filter(p => result.debug.labels[p] === nearestIndex).length
        : 0;
    return {
        core: core.name,
        case: geometry.name,
        pattern,
        amplitude,
        phase,
        noise,
        colors,
        targetRGB,
        targetPixels: featurePixels.length,
        targetPaintDistance: targetRGB && Number.isFinite(nearestDistance) ? +nearestDistance.toFixed(2) : null,
        targetPaint: targetPaintPresent ? result.stats.palette[nearestIndex] : null,
        targetPaintPresent,
        targetLabelPixels,
        targetLabelRecall: featurePixels.length ? +(targetLabelPixels / featurePixels.length).toFixed(3) : null,
        colorsFound: result.stats.colors,
        regions: result.stats.regions,
        recoveredPaints: result.stats.recoveredPaints,
        palette: result.stats.palette,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        help();
        return;
    }
    await assertUnused(args.out);
    const cores = await loadCores(args.cores);
    const matrix = selectedMatrix(args.smoke);
    const results = [];
    for (const geometry of matrix.geometries) {
        for (const pattern of matrix.patterns) {
            for (const amplitude of matrix.amplitudes) {
                for (const phase of matrix.phases) {
                    for (const noise of matrix.noises) {
                        const image = makeImage({
                            ...geometry,
                            pattern,
                            amplitude,
                            phase,
                            seed: 80731,
                        });
                        for (const colors of matrix.colorOptions) {
                            for (const core of cores) results.push(traceRecord(core, image, geometry, pattern, amplitude, phase, noise, colors));
                        }
                    }
                }
            }
        }
    }
    const output = {
        schema: "campaign-paint-adversary-v1",
        width,
        height,
        supersampling: scale,
        targetDistanceLimit,
        smoke: args.smoke,
        cores: cores.map(({ name, path, sha256 }) => ({ name, path, sha256 })),
        matrix: {
            geometries: matrix.geometries.map(g => g.name),
            patterns: matrix.patterns,
            amplitudes: matrix.amplitudes,
            phases: matrix.phases,
            noises: matrix.noises,
            colorOptions: matrix.colorOptions,
        },
        results,
    };
    await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({
        cores: cores.map(({ name, sha256 }) => ({
            name,
            sha256,
        })), cases: results.length, output: args.out,
    })}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
