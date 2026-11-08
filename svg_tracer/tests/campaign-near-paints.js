#!/usr/bin/env bun
/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/*
 * Independent near-base paint challenge. Inputs are 64x64 source rasters with
 * a true square accent fully inside base A, plus a separate base-B field.
 * Accent identity is measured from source masks and output labels relative to
 * same-column base references; no nearest-palette RGB radius defines a hit.
 *
 * Run after a candidate is frozen:
 *   bun tests/campaign-near-paints.js \
 *     --core PATH_TO_BASELINE --core PATH_TO_CANDIDATE \
 *     --out .quality-work/near-paints-results.json
 *
 * The matrix has 480 trace configurations per core: 4 square sizes, 5 source
 * contrast directions, 3 contrast magnitudes, 4 clean/correlated source
 * variation profiles, and Auto or explicit-three-paint tracing. Each source
 * condition is traced once with an algorithm noise setting paired to the
 * generated variation profile. Source-color ambiguity is reported separately
 * from output recognition, including same-column exact color overlap and the
 * availability of a reference pixel with the same noise key.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";

const width = 64;
const height = 64;
const baseA = [72, 104, 136];
const baseB = [200, 168, 72];
const columnNoiseVector = [1, 0.7, 0.35];
const noiseSeed = 38171;
const sizes = [3, 4, 6, 8];
const directions = [
    { name: "red", vector: [1, 0, 0] },
    { name: "green", vector: [0, 1, 0] },
    { name: "blue", vector: [0, 0, 1] },
    { name: "neutral", vector: [1, 1, 1] },
    { name: "red-green", vector: [1, -1, 0] },
];
const magnitudes = [4, 8, 16];
const sourceProfiles = [
    { name: "clean", pattern: "none", amplitude: 0, traceNoise: 0 },
    { name: "columns12", pattern: "columns2", amplitude: 12, traceNoise: 10 },
    { name: "columns28", pattern: "columns2", amplitude: 28, traceNoise: 40 },
    { name: "tiles12", pattern: "tiles4", amplitude: 12, traceNoise: 20 },
];
const colorOptions = [0, 3];

function help() {
    process.stdout.write(
        "Usage: bun tests/campaign-near-paints.js --core PATH [--core PATH ...] --out UNUSED.json\n" +
        "       bun tests/campaign-near-paints.js --describe\n" +
        "Example: bun tests/campaign-near-paints.js --core PATH_TO_BASELINE --core PATH_TO_CANDIDATE --out .quality-work/near-paints-results.json\n\n" +
        "Each core must be a standalone source file defining createTracer(). The first core is the baseline for paired summaries.\n" +
        "The output path must not already exist. The fixed matrix runs 480 trace configurations per core.\n");
}

function parseArgs(argv) {
    const args = { cores: [], out: null, help: false, describe: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") args.help = true;
        else if (arg === "--describe") args.describe = true;
        else if (arg === "--core") {
            if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--core requires a source path");
            args.cores.push(resolve(argv[++i]));
        } else if (arg === "--out") {
            if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--out requires an unused output path");
            args.out = resolve(argv[++i]);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.help && !args.describe && !args.cores.length) throw new Error("Provide at least one --core PATH");
    if (!args.help && !args.describe && !args.out) throw new Error("Provide --out UNUSED.json");
    return args;
}

function hash01(x, y, seed) {
    let value = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x119de1f3) ^ seed;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967296;
}

function noiseKey(profile, x, y) {
    if (profile.pattern === "columns2") return `c${Math.floor(x / 2)}`;
    if (profile.pattern === "tiles4") return `t${Math.floor(x / 4)},${Math.floor(y / 4)}`;
    return "clean";
}

function noiseAt(profile, x, y) {
    if (profile.pattern === "none") return [0, 0, 0];
    const key = profile.pattern === "columns2"
        ? [Math.floor(x / 2), 0]
        : [Math.floor(x / 4), Math.floor(y / 4)];
    const scalar = Math.round((hash01(key[0], key[1], noiseSeed) * 2 - 1) * profile.amplitude);
    if (profile.pattern === "columns2") return columnNoiseVector.map(scale => Math.round(scalar * scale));
    return [scalar, scalar, scalar];
}

function accentMask(size) {
    const x0 = 16 - Math.floor(size / 2);
    const y0 = 32 - Math.floor(size / 2);
    const pixels = [];
    for (let y = y0; y < y0 + size; y++) {
        for (let x = x0; x < x0 + size; x++) pixels.push(y * width + x);
    }
    return { x0, y0, pixels };
}

function makeImage(size, direction, magnitude, profile) {
    const maskInfo = accentMask(size);
    const mask = new Uint8Array(width * height);
    for (const p of maskInfo.pixels) mask[p] = 1;
    const target = baseA.map((channel, c) => channel + direction.vector[c] * magnitude);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            const source = mask[p] ? target : (x < 32 ? baseA : baseB);
            const perturbation = noiseAt(profile, x, y);
            const i = p * 4;
            data[i] = Math.max(0, Math.min(255, Math.round(source[0] + perturbation[0])));
            data[i + 1] = Math.max(0, Math.min(255, Math.round(source[1] + perturbation[1])));
            data[i + 2] = Math.max(0, Math.min(255, Math.round(source[2] + perturbation[2])));
            data[i + 3] = 255;
        }
    }
    return {
        width, height, data, mask, maskPixels: maskInfo.pixels,
        targetSourceRgb: target,
        sourceDelta: direction.vector.map(value => value * magnitude),
        sourceProfile: profile,
    };
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rgbAt(data, p) {
    const i = 4 * p;
    return [data[i], data[i + 1], data[i + 2]];
}

function rgbKey(rgb) {
    return `${rgb[0]},${rgb[1]},${rgb[2]}`;
}

function distance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sourceEvidence(image) {
    const targetPixels = image.maskPixels;
    const sameColumnExactOverlap = [];
    const nearestSameColumnDistance = [];
    const sameNoiseKeyCoverage = [];
    const pairedReferenceDelta = [[], [], []];
    let missingSameKeyReferences = 0;
    for (const p of targetPixels) {
        const x = p % width;
        const y = Math.floor(p / width);
        const targetRgb = rgbAt(image.data, p);
        const sameColumn = [];
        const sameKey = [];
        for (let ry = 0; ry < height; ry++) {
            const rp = ry * width + x;
            if (image.mask[rp]) continue;
            const reference = rgbAt(image.data, rp);
            sameColumn.push(reference);
            if (noiseKey(image.sourceProfile, x, ry) === noiseKey(image.sourceProfile, x, y)) sameKey.push(reference);
        }
        const exact = sameColumn.some(reference => rgbKey(reference) === rgbKey(targetRgb));
        sameColumnExactOverlap.push(exact ? 1 : 0);
        nearestSameColumnDistance.push(Math.min(...sameColumn.map(reference => distance(targetRgb, reference))));
        if (!sameKey.length) {
            missingSameKeyReferences++;
            sameNoiseKeyCoverage.push(0);
        } else {
            sameNoiseKeyCoverage.push(1);
            const localBase = [0, 1, 2].map(channel => median(sameKey.map(reference => reference[channel])));
            for (let channel = 0; channel < 3; channel++) pairedReferenceDelta[channel].push(targetRgb[channel] - localBase[channel]);
        }
    }
    const measuredDelta = pairedReferenceDelta.map(median);
    const expected = image.sourceDelta;
    const measuredNorm = measuredDelta.every(Number.isFinite) ? Math.hypot(...measuredDelta) : null;
    const expectedNorm = Math.hypot(...expected);
    const cosine = measuredNorm && measuredNorm > 0 ? dot(measuredDelta, expected) / (measuredNorm * expectedNorm) : null;
    const overlapCount = sameColumnExactOverlap.reduce((sum, value) => sum + value, 0);
    const nearestSorted = [...nearestSameColumnDistance].sort((a, b) => a - b);
    return {
        sameColumnReferenceExactColorOverlapFraction: overlapCount / targetPixels.length,
        sameColumnReferenceExactColorOverlapPixels: overlapCount,
        nearestSameColumnSourceColorDistance: {
            minimum: Math.min(...nearestSorted),
            median: median(nearestSorted),
            maximum: Math.max(...nearestSorted),
            targetPixelsWithin1RgbUnitOfAnyReference: nearestSorted.filter(value => value <= 1).length,
            targetPixelsWithin2RgbUnitsOfAnyReference: nearestSorted.filter(value => value <= 2).length,
            targetPixelsWithin4RgbUnitsOfAnyReference: nearestSorted.filter(value => value <= 4).length,
            targetPixelsWithinOneDesignedContrastOfAnyReference: nearestSorted.filter(value => value < expectedNorm).length,
        },
        sameNoiseKeyReferenceCoverage: sameNoiseKeyCoverage.reduce((sum, value) => sum + value, 0) / targetPixels.length,
        targetPixelsWithoutSameNoiseKeyReference: missingSameKeyReferences,
        measuredTargetMinusPairedReferenceMedianRgb: measuredDelta.every(Number.isFinite) ? measuredDelta : null,
        measuredContrastCosineToDesignedDirection: cosine,
        designedSourceDeltaRgb: expected,
    };
}

function mode(values) {
    const counts = new Map();
    for (const value of values) if (Number.isInteger(value) && value >= 0) counts.set(value, (counts.get(value) || 0) + 1);
    if (!counts.size) return { label: -1, share: 0, counts: [] };
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return {
        label: ordered[0][0],
        share: ordered[0][1] / values.length,
        counts: ordered.map(([label, count]) => ({ label, count })),
    };
}

function connectedComponentSize(mask, labels, targetPixels, wantedLabel) {
    const targetSet = new Set(targetPixels);
    const seen = new Set();
    let largest = 0;
    for (const start of targetPixels) {
        if (seen.has(start) || labels[start] !== wantedLabel) continue;
        let count = 0;
        const stack = [start];
        seen.add(start);
        while (stack.length) {
            const p = stack.pop();
            count++;
            const x = p % width;
            const neighbors = [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width];
            for (const q of neighbors) {
                if (q < 0 || q >= width * height || !targetSet.has(q) || seen.has(q) || labels[q] !== wantedLabel) continue;
                seen.add(q);
                stack.push(q);
            }
        }
        largest = Math.max(largest, count);
    }
    return largest;
}

function evaluateOutput(result, image) {
    const labels = result.debug?.labels;
    if (!labels || labels.length !== width * height) throw new Error("Core must return debug labels for the full raster");
    const palette = result.stats.palette.map(hex => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)));
    const targetLabels = image.maskPixels.map(p => labels[p]);
    const targetMode = mode(targetLabels);
    const baseModesByX = new Map();
    const xColumns = [...new Set(image.maskPixels.map(p => p % width))];
    for (const x of xColumns) {
        const referenceLabels = [];
        for (let y = 0; y < height; y++) {
            const p = y * width + x;
            if (!image.mask[p]) referenceLabels.push(labels[p]);
        }
        baseModesByX.set(x, mode(referenceLabels));
    }
    const baseMode = mode([...baseModesByX.values()].map(item => item.label));
    let distinctFromColumnBase = 0;
    for (const p of image.maskPixels) {
        const x = p % width;
        const baseLabel = baseModesByX.get(x)?.label ?? -1;
        if (labels[p] >= 0 && baseLabel >= 0 && labels[p] !== baseLabel) distinctFromColumnBase++;
    }
    const largestComponent = targetMode.label >= 0
        ? connectedComponentSize(image.mask, labels, image.maskPixels, targetMode.label)
        : 0;
    const targetColor = palette[targetMode.label] || null;
    const correspondingBaseColors = image.maskPixels
        .map(p => palette[baseModesByX.get(p % width)?.label ?? -1])
        .filter(Boolean);
    const baseColor = correspondingBaseColors.length
        ? [0, 1, 2].map(channel => median(correspondingBaseColors.map(rgb => rgb[channel])))
        : null;
    const outputDelta = targetColor && baseColor ? targetColor.map((value, channel) => value - baseColor[channel]) : null;
    const expectedDelta = image.sourceDelta;
    const expectedNorm = Math.hypot(...expectedDelta);
    const outputNorm = outputDelta ? Math.hypot(...outputDelta) : 0;
    const projectionRatio = outputDelta ? dot(outputDelta, expectedDelta) / (expectedNorm * expectedNorm) : null;
    const directionCosine = outputDelta && outputNorm > 0 ? dot(outputDelta, expectedDelta) / (outputNorm * expectedNorm) : null;
    const distinctShare = distinctFromColumnBase / image.maskPixels.length;
    const coherentShare = largestComponent / image.maskPixels.length;
    const targetDistinctPaint = targetMode.label >= 0 && baseMode.label >= 0 && targetMode.label !== baseMode.label && !!outputDelta && outputDelta.some(value => value !== 0);
    const recognized = targetDistinctPaint && targetMode.share >= 0.6 && distinctShare >= 0.6 && coherentShare >= 0.5 && directionCosine >= 0.5 && projectionRatio >= 0.25;
    const paletteHexForLabel = label => Number.isInteger(label) && label >= 0 ? result.stats.palette[label] : null;
    const targetPaintSequence = targetLabels.map(paletteHexForLabel);
    const targetBaseOwnershipSequence = image.maskPixels.map(p => {
        const targetHex = paletteHexForLabel(labels[p]);
        const baseHex = paletteHexForLabel(baseModesByX.get(p % width)?.label ?? -1);
        return targetHex !== null && baseHex !== null && targetHex !== baseHex;
    });
    const sameColumnReferenceColorSequence = [];
    for (const x of xColumns) for (let y = 0; y < height; y++) {
        const p = y * width + x;
        if (!image.mask[p]) sameColumnReferenceColorSequence.push(paletteHexForLabel(labels[p]));
    }
    return {
        recognizedAccent: recognized,
        targetLabel: targetMode.label,
        targetLabelShare: targetMode.share,
        targetLabelCounts: targetMode.counts,
        targetLabelLargest4ConnectedComponentPixels: largestComponent,
        targetLabelLargest4ConnectedComponentShare: coherentShare,
        targetPixelsDistinctFromSameColumnBaseMode: distinctFromColumnBase,
        targetPixelsDistinctFromSameColumnBaseModeShare: distinctShare,
        sameColumnBaseModeLabel: baseMode.label,
        sameColumnBaseModeShare: baseMode.share,
        sameColumnBaseLabelsByX: [...baseModesByX.entries()].map(([x, value]) => ({ x, ...value })),
        distinctPaletteEntryFromBase: targetDistinctPaint,
        outputTargetPaintRgb: targetColor,
        outputSameColumnBasePaintRgb: baseColor,
        outputContrastRgb: outputDelta,
        outputContrastProjectionRatioAlongDesignedSourceDelta: projectionRatio,
        outputContrastDirectionCosineToDesignedSourceDelta: directionCosine,
        targetPaintColorSequenceSha256: createHash("sha256").update(JSON.stringify(targetPaintSequence)).digest("hex"),
        targetBaseOwnershipSequenceSha256: createHash("sha256").update(JSON.stringify(targetBaseOwnershipSequence)).digest("hex"),
        sameColumnReferenceColorSequenceSha256: createHash("sha256").update(JSON.stringify(sameColumnReferenceColorSequence)).digest("hex"),
        palette: result.stats.palette,
        colors: result.stats.colors,
        regions: result.stats.visibleRegions,
        recoveredPaints: result.stats.recoveredPaints,
        relabeledPixels: result.stats.relabeledPixels,
        fallbackChains: result.stats.fallbackChains,
    };
}

async function loadCores(paths) {
    const seenNames = new Map();
    const cores = [];
    for (const path of paths) {
        const source = await readFile(path, "utf8");
        const tracer = new Function(`${source}\nreturn createTracer();`)();
        if (!tracer || typeof tracer.trace !== "function") throw new Error(`Core does not define a tracer: ${path}`);
        const base = basename(path, extname(path));
        const count = (seenNames.get(base) || 0) + 1;
        seenNames.set(base, count);
        cores.push({
            name: count === 1 ? base : `${base}-${count}`,
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

function configs() {
    const rows = [];
    for (const size of sizes) for (const direction of directions) for (const magnitude of magnitudes) {
        for (const profile of sourceProfiles) for (const colors of colorOptions) {
            rows.push({ size, direction, magnitude, profile, colors });
        }
    }
    return rows;
}

function summarizePairs(rows, cores) {
    if (cores.length < 2) return null;
    const byKey = new Map(rows.map(row => [`${row.core}\0${row.caseId}`, row]));
    return cores.slice(1).map(candidate => {
        let baselineRecognized = 0;
        let candidateRecognized = 0;
        let retained = 0;
        let lost = 0;
        let gained = 0;
        let targetPaintAssignmentChanges = 0;
        let targetOwnershipChanges = 0;
        let sameColumnReferenceAssignmentChanges = 0;
        let ambiguousLosses = 0;
        let lossWithSameColumnOverlap = 0;
        const losses = [];
        for (const row of rows) {
            if (row.core !== cores[0].name) continue;
            const other = byKey.get(`${candidate.name}\0${row.caseId}`);
            if (!other) throw new Error(`Missing paired result for ${row.caseId} in ${candidate.name}`);
            if (row.metrics.recognizedAccent) baselineRecognized++;
            if (other.metrics.recognizedAccent) candidateRecognized++;
            if (row.metrics.recognizedAccent && other.metrics.recognizedAccent) retained++;
            if (!row.metrics.recognizedAccent && other.metrics.recognizedAccent) gained++;
            if (row.metrics.recognizedAccent && !other.metrics.recognizedAccent) {
                lost++;
                const overlap = row.sourceEvidence.sameColumnReferenceExactColorOverlapFraction;
                if (overlap > 0 || row.sourceEvidence.sameNoiseKeyReferenceCoverage < 1) ambiguousLosses++;
                if (overlap > 0) lossWithSameColumnOverlap++;
                losses.push({
                    caseId: row.caseId,
                    sourceEvidence: row.sourceEvidence,
                    baseline: row.metrics,
                    candidate: other.metrics,
                });
            }
            if (row.metrics.targetPaintColorSequenceSha256 !== other.metrics.targetPaintColorSequenceSha256) targetPaintAssignmentChanges++;
            if (row.metrics.targetBaseOwnershipSequenceSha256 !== other.metrics.targetBaseOwnershipSequenceSha256) targetOwnershipChanges++;
            if (row.metrics.sameColumnReferenceColorSequenceSha256 !== other.metrics.sameColumnReferenceColorSequenceSha256) sameColumnReferenceAssignmentChanges++;
        }
        return {
            baseline: cores[0].name,
            candidate: candidate.name,
            baselineRecognizedAccentConfigurations: baselineRecognized,
            candidateRecognizedAccentConfigurations: candidateRecognized,
            baselineRecognizedAccentsRetained: retained,
            baselineRecognizedAccentsLost: lost,
            previouslyUnrecognizedAccentsGained: gained,
            targetPaintPixelAssignmentChanges: targetPaintAssignmentChanges,
            targetBaseOwnershipChanges: targetOwnershipChanges,
            sameColumnReferencePixelColorAssignmentChanges: sameColumnReferenceAssignmentChanges,
            lostAccentsWithSourceOverlapOrMissingSameNoiseKeyReference: ambiguousLosses,
            lostAccentsWithAnySameColumnExactColorOverlap: lossWithSameColumnOverlap,
            losses,
        };
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return help();
    const matrix = configs();
    if (args.describe) {
        process.stdout.write(`${JSON.stringify({
            width,
            height,
            sizes,
            directions,
            magnitudes,
            sourceProfiles,
            colorOptions,
            sourceConditions: matrix.length / colorOptions.length,
            traceConfigurationsPerCore: matrix.length,
        }, null, 2)}\n`);
        return;
    }
    await assertUnused(args.out);
    const cores = await loadCores(args.cores);
    const rows = [];
    for (let i = 0; i < matrix.length; i++) {
        const config = matrix[i];
        const image = makeImage(config.size, config.direction, config.magnitude, config.profile);
        const caseId = [config.size, config.direction.name, config.magnitude, config.profile.name, config.colors].join("-");
        const evidence = sourceEvidence(image);
        for (const core of cores) {
            const result = core.tracer.trace({
                width,
                height,
                data: image.data,
            }, {
                colors: config.colors,
                noise: config.profile.traceNoise,
                minArea: 0,
                debug: true,
            });
            const metrics = evaluateOutput(result, image);
            rows.push({
                core: core.name,
                caseId,
                size: config.size,
                direction: config.direction.name,
                directionVector: config.direction.vector,
                magnitude: config.magnitude,
                targetSourceRgb: image.targetSourceRgb,
                sourceProfile: config.profile.name,
                sourcePattern: config.profile.pattern,
                sourceAmplitude: config.profile.amplitude,
                tracerNoise: config.profile.traceNoise,
                colorsOption: config.colors,
                targetMaskPixels: image.maskPixels.length,
                sourceEvidence: evidence,
                metrics,
            });
        }
        if ((i + 1) % 24 === 0) process.stderr.write(`Generated and traced ${i + 1}/${matrix.length} source/color configurations\n`);
    }
    const output = {
        schema: "campaign-near-base-accent-challenge-v1",
        dimensions: { width, height },
        paletteSources: { baseA, baseB },
        recognitionRule: {
            description: "A source-mask accent is recognized only when one coherent output label is distinct from the same-column base mode and its output paint contrast follows the designed source contrast direction.",
            targetLabelShareMinimum: 0.6,
            distinctFromSameColumnBaseShareMinimum: 0.6,
            largest4ConnectedTargetComponentShareMinimum: 0.5,
            outputContrastDirectionCosineMinimum: 0.5,
            outputContrastProjectionRatioMinimum: 0.25,
            lossDenominator: "Only configurations recognized by the first (baseline) core count as baseline-preserved accent controls; source ambiguity is reported separately and does not silently remove rows from the denominator.",
        },
        matrix: {
            sizes,
            directions,
            magnitudes,
            sourceProfiles,
            colorOptions,
            sourceConditions: matrix.length / colorOptions.length,
            traceConfigurationsPerCore: matrix.length,
            pairedReference: "For each target pixel, use base-A source pixels at the same x outside the mask; separately record exact RGB overlap over all such rows and reference availability under the same deterministic noise key.",
        },
        cores: cores.map(({ name, path, sha256 }) => ({ name, path, sha256 })),
        pairedSummary: summarizePairs(rows, cores),
        results: rows,
    };
    await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    const summary = {
        cores: output.cores.map(({ name, sha256 }) => ({ name, sha256 })),
        traceConfigurationsPerCore: matrix.length,
        rows: rows.length,
        paired: output.pairedSummary?.map(({
                                               baseline,
                                               candidate,
                                               baselineRecognizedAccentConfigurations,
                                               candidateRecognizedAccentConfigurations,
                                               baselineRecognizedAccentsRetained,
                                               baselineRecognizedAccentsLost,
                                               previouslyUnrecognizedAccentsGained,
                                               targetPaintPixelAssignmentChanges,
                                               targetBaseOwnershipChanges,
                                               sameColumnReferencePixelColorAssignmentChanges,
                                               lostAccentsWithSourceOverlapOrMissingSameNoiseKeyReference,
                                               lostAccentsWithAnySameColumnExactColorOverlap,
                                           }) => ({
            baseline,
            candidate,
            baselineRecognizedAccentConfigurations,
            candidateRecognizedAccentConfigurations,
            baselineRecognizedAccentsRetained,
            baselineRecognizedAccentsLost,
            previouslyUnrecognizedAccentsGained,
            targetPaintPixelAssignmentChanges,
            targetBaseOwnershipChanges,
            sameColumnReferencePixelColorAssignmentChanges,
            lostAccentsWithSourceOverlapOrMissingSameNoiseKeyReference,
            lostAccentsWithAnySameColumnExactColorOverlap,
        })),
        output: args.out,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
