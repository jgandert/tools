/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CAMPAIGN_NOISES, getCampaignRound } from "./campaign-artwork.js";
import {
    instrumentValidationCore,
    validationDiagnosticFactories,
} from "./validation-diagnostics.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const usage = "Usage: bun tests/campaign-study.js [--core PATH] [--round diagnostic|validation1|validation2|validation3|validation4] [--diagnose] [--out UNUSED.json] [--svg-dir UNUSED_DIR] [--crop-dir UNUSED_DIR]";

function parseArgs(args) {
    const config = {
        core: resolve(scriptDir, "../tracer.js"),
        round: "diagnostic",
        out: null,
        svgDir: null,
        cropDir: null,
        help: false,
        diagnose: false,
    };
    const value = (index, flag) => {
        if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
            throw Error(`Missing value for ${flag}.`);
        }
        return args[index + 1];
    };

    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--help" || flag === "-h") {
            config.help = true;
            continue;
        }
        if (flag === "--diagnose") {
            config.diagnose = true;
            continue;
        }
        if (flag === "--core") {
            config.core = resolve(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--round") {
            config.round = value(i, flag);
            i++;
            continue;
        }
        if (flag === "--out") {
            config.out = resolve(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--svg-dir") {
            config.svgDir = resolve(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--crop-dir") {
            config.cropDir = resolve(value(i, flag));
            i++;
            continue;
        }
        throw Error(`Unknown option: ${flag}`);
    }

    if (config.help) {
        return config;
    }
    if (!Object.hasOwn(CAMPAIGN_NOISES, config.round)) {
        throw Error("--round must be diagnostic, validation1, validation2, validation3, or validation4.");
    }
    config.out ||= resolve(process.cwd(), `.quality-work/campaign/harness/${config.round}.json`);
    if (config.out === config.core) {
        throw Error("--out must not overwrite the selected core.");
    }
    return config;
}

function isPathInside(parent, candidate) {
    const fromParent = relative(parent, candidate);
    return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith(`..${sep}`));
}

async function assertUnused(path) {
    try {
        await stat(path);
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    throw Error(`Output already exists; choose an unused path: ${path}`);
}

function fixtureCases(fixtures, noises) {
    return fixtures.flatMap(fixture => noises.flatMap(noise => [
        { fixtureId: fixture.id, noise, colorMode: "auto", colors: 0 },
        {
            fixtureId: fixture.id,
            noise,
            colorMode: "explicit",
            colors: Object.keys(fixture.paints).length,
        },
    ]));
}

function safeName(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "case";
}

function outputNames(fixtures, cases, svgDir, cropDir) {
    const outputs = [];
    if (svgDir) {
        for (const item of cases) {
            outputs.push(resolve(svgDir, `${safeName(item.fixtureId)}-n${item.noise}-${item.colorMode}.svg`));
        }
    }
    if (cropDir) {
        for (const item of cases) {
            const fixture = fixtures.find(candidate => candidate.id === item.fixtureId);
            for (const crop of fixture.crops) {
                outputs.push(resolve(cropDir, `${safeName(item.fixtureId)}-n${item.noise}-${item.colorMode}-${safeName(crop.name)}.png`));
            }
        }
    }
    return outputs;
}

function summarize(results) {
    const completed = results.filter(result => result.status === "ok");
    const byNoiseMode = {};
    for (const result of completed) {
        const key = `n${result.noise}-${result.colorMode}`;
        const group = byNoiseMode[key] ||= {
            cases: 0,
            ownerAccuracy: 0,
            interiorOwnerAccuracy: 0,
            contourMaxPx: 0,
            contourMeanPx: 0,
            missingTransitions: 0,
            extraTransitions: 0,
            missingPaints: 0,
            falsePaints: 0,
            lostAccents: 0,
            probeFailures: 0,
            accentProbes: 0,
            accentProbePasses: 0,
            absoluteComponentDelta: 0,
            absoluteHoleDelta: 0,
            rasterMaeAgainstInput: 0,
            regions: 0,
            segments: 0,
            svgBytes: 0,
            ms: 0,
            fallbackChains: 0,
        };
        group.cases++;
        group.ownerAccuracy += result.ownership.all.accuracy;
        group.interiorOwnerAccuracy += result.ownership.interior.accuracy;
        group.contourMaxPx = Math.max(group.contourMaxPx, result.contour.maxDeviationPx);
        group.contourMeanPx += result.contour.meanDeviationPx;
        group.missingTransitions += result.contour.missingTransitions;
        group.extraTransitions += result.contour.extraTransitions;
        group.missingPaints += result.palette.missing.length;
        group.falsePaints += result.palette.extra.length;
        group.lostAccents += result.probes.lostAccents;
        group.probeFailures += result.probes.failures;
        group.accentProbes += result.probes.results.filter(probe => probe.kind === "accent").length;
        group.accentProbePasses += result.probes.results.filter(probe => probe.kind === "accent" && probe.pass).length;
        for (const delta of Object.values(result.topologyDelta)) {
            group.absoluteComponentDelta += Math.abs(delta.components);
            group.absoluteHoleDelta += Math.abs(delta.holes);
        }
        group.rasterMaeAgainstInput += result.rasterMaeAgainstInput;
        group.regions += result.stats.regions;
        group.segments += result.stats.segments;
        group.svgBytes += result.svgBytes;
        group.ms += result.stats.ms;
        group.fallbackChains += result.stats.fallbackChains;
    }
    for (const group of Object.values(byNoiseMode)) {
        for (const key of ["ownerAccuracy", "interiorOwnerAccuracy", "contourMeanPx", "rasterMaeAgainstInput", "regions", "segments", "svgBytes", "ms"]) {
            group[key] = Number((group[key] / group.cases).toFixed(3));
        }
        group.contourMaxPx = Number(group.contourMaxPx.toFixed(3));
    }
    return {
        cases: results.length,
        completed: completed.length,
        failed: results.length - completed.length,
        byNoiseMode,
    };
}

async function runStudy(config) {
    const fixtures = getCampaignRound(config.round);
    const noises = CAMPAIGN_NOISES[config.round];
    const cases = fixtureCases(fixtures, noises);
    const outputs = outputNames(fixtures, cases, config.svgDir, config.cropDir);
    if (new Set(outputs).size !== outputs.length || outputs.includes(config.out)) {
        throw Error("Report, SVG, and crop output paths must be distinct.");
    }
    for (const directory of [config.svgDir, config.cropDir].filter(Boolean)) {
        if (directory === config.out || isPathInside(directory, config.out) || isPathInside(config.out, directory)) {
            throw Error("Report and export directories must not overlap.");
        }
        await assertUnused(directory);
    }
    await assertUnused(config.out);
    const core = await readFile(config.core, "utf8");
    const coreSHA256 = createHash("sha256").update(core).digest("hex");
    const fixtureSHA256 = createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
    const metadata = {
        round: config.round,
        diagnostics: config.diagnose,
        browser: null,
        core: config.core,
        coreSHA256,
        fixtureSHA256,
        fixtureIds: fixtures.map(fixture => fixture.id),
        noises,
        colorModes: ["auto", "explicit"],
        input: "Original vector paths rendered in Chromium Canvas; the source owner masks use vector-path point queries independently of tracer pixels.",
        rasterVariations: "Fixture-specific subpixel transforms, canvas supersampling and downsampling, deterministic low-amplitude RGB noise, two fixed jittered midpoint-color accents, and native-size JPEG recompression at the qualities recorded per fixture.",
        tracerOptions: {
            tolerance: 1.25,
            minArea: 0,
            removeBackground: false,
            preserveDetails: true,
        },
        measures: "Source ownership uses independent vector-path queries. Traced ownership and pixel-center topology query parsed SVG vector geometry directly. Horizontal/vertical contour offsets compare source and output ownership transitions sampled every 0.125px without dropping short runs or bridging unknown paints. SVG raster MAE against the varied input is retained as a diagnostic only; it is not a vector-quality target.",
    };
    const resultByKey = new Map();

    await mkdir(dirname(config.out), { recursive: true });
    if (config.svgDir) {
        await mkdir(config.svgDir, { recursive: true });
    }
    if (config.cropDir) {
        await mkdir(config.cropDir, { recursive: true });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        metadata.browser = browser.version();
        const page = await browser.newPage();
        try {
            await page.addScriptTag({ content: `${config.diagnose ? instrumentValidationCore(core) : core}\nwindow.campaignTracer = createTracer();` });
            if (config.diagnose) await page.addScriptTag({ content: validationDiagnosticFactories });
            const tracerReady = await page.evaluate(() => typeof window.campaignTracer?.trace === "function");
            if (!tracerReady) {
                throw Error("Could not load createTracer() from the selected core.");
            }
            const browserResults = await page.evaluate(async ({
                                                                  fixtures,
                                                                  noises,
                                                                  cases,
                                                                  includeSvg,
                                                                  includeCrops,
                                                                  diagnose,
                                                              }) => {
                const parseHex = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
                const rgbDistance = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
                const message = error => String(error?.message || error);

                function makePaths(fixture) {
                    const matrix = new DOMMatrix(fixture.transform);
                    const scale = Math.hypot(matrix.a, matrix.b);
                    const paints = Object.keys(fixture.paints);
                    const paintIndex = new Map(paints.map((paint, index) => [paint, index]));
                    const context = document.createElement("canvas").getContext("2d");
                    const layers = fixture.layers.map(layer => {
                        const raw = new Path2D(layer.d);
                        let path = raw;
                        if (!layer.lock) {
                            path = new Path2D();
                            path.addPath(raw, matrix);
                        }
                        return {
                            ...layer,
                            path,
                            lineWidth: (layer.strokeWidth || 1) * (layer.lock ? 1 : scale),
                        };
                    });
                    const ownerAt = (x, y) => {
                        let owner = -1;
                        for (const layer of layers) {
                            let hit;
                            if (layer.strokeWidth) {
                                context.lineWidth = layer.lineWidth;
                                context.lineCap = layer.lineCap || "butt";
                                hit = context.isPointInStroke(layer.path, x, y);
                            } else {
                                hit = context.isPointInPath(layer.path, x, y, layer.fillRule || "nonzero");
                            }
                            if (!hit) {
                                continue;
                            }
                            owner = layer.erase ? -1 : paintIndex.get(layer.paint);
                        }
                        return owner;
                    };
                    return { layers, paints, paintIndex, context, ownerAt };
                }

                function renderVector(fixture, paths) {
                    const scale = fixture.rasterScale || 1;
                    const high = document.createElement("canvas");
                    high.width = fixture.width * scale;
                    high.height = fixture.height * scale;
                    const highContext = high.getContext("2d", { willReadFrequently: true });
                    highContext.scale(scale, scale);
                    for (const layer of paths.layers) {
                        highContext.save();
                        if (layer.erase) {
                            highContext.globalCompositeOperation = "destination-out";
                        } else {
                            highContext.fillStyle = fixture.paints[layer.paint];
                        }
                        if (layer.strokeWidth) {
                            highContext.lineWidth = layer.lineWidth;
                            highContext.lineCap = layer.lineCap || "butt";
                            highContext.strokeStyle = fixture.paints[layer.paint];
                            highContext.stroke(layer.path);
                        } else {
                            highContext.fill(layer.path, layer.fillRule || "nonzero");
                        }
                        highContext.restore();
                    }

                    const result = document.createElement("canvas");
                    result.width = fixture.width;
                    result.height = fixture.height;
                    const resultContext = result.getContext("2d", { willReadFrequently: true });
                    if (scale > 1) {
                        resultContext.imageSmoothingEnabled = true;
                        resultContext.imageSmoothingQuality = "high";
                    }
                    resultContext.drawImage(high, 0, 0, fixture.width, fixture.height);
                    return result;
                }

                async function applySourceVariation(canvas, fixture) {
                    let result = canvas;
                    if (fixture.jpegQuality !== null) {
                        const pixels = result.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, fixture.width, fixture.height).data;
                        for (let index = 3; index < pixels.length; index += 4) {
                            if (pixels[index] !== 255) {
                                throw Error(`JPEG fixture ${fixture.id} must author an opaque background so codec matting cannot introduce an unmodeled paint.`);
                            }
                        }
                        const blob = await new Promise((resolve, reject) => {
                            result.toBlob(value => value ? resolve(value) : reject(Error("Canvas JPEG encoding returned no data.")), "image/jpeg", fixture.jpegQuality);
                        });
                        const url = URL.createObjectURL(blob);
                        try {
                            const image = new Image();
                            image.src = url;
                            await image.decode();
                            const jpegCanvas = document.createElement("canvas");
                            jpegCanvas.width = fixture.width;
                            jpegCanvas.height = fixture.height;
                            jpegCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
                            result = jpegCanvas;
                        } finally {
                            URL.revokeObjectURL(url);
                        }
                    }
                    if (fixture.noiseAmplitude > 0) {
                        const context = result.getContext("2d", { willReadFrequently: true });
                        const image = context.getImageData(0, 0, fixture.width, fixture.height);
                        let state = 0x9e3779b9;
                        for (let index = 0; index < fixture.id.length; index++) {
                            state = Math.imul(state ^ fixture.id.charCodeAt(index), 0x45d9f3b) >>> 0;
                        }
                        for (let pixel = 0; pixel < image.data.length; pixel += 4) {
                            state ^= state << 13;
                            state ^= state >>> 17;
                            state ^= state << 5;
                            for (let channel = 0; channel < 3; channel++) {
                                const delta = (state >>> (channel * 7) & 15) - 7;
                                image.data[pixel + channel] = Math.max(0, Math.min(255, image.data[pixel + channel] + Math.round(delta * fixture.noiseAmplitude / 7)));
                            }
                        }
                        context.putImageData(image, 0, 0);
                    }
                    if (fixture.noisePatches?.length) {
                        const context = result.getContext("2d", { willReadFrequently: true });
                        const image = context.getImageData(0, 0, fixture.width, fixture.height);
                        for (let patchIndex = 0; patchIndex < fixture.noisePatches.length; patchIndex++) {
                            const patch = fixture.noisePatches[patchIndex];
                            let state = (0xa511e9b3 ^ Math.imul(patchIndex + 1, 0x9e3779b9)) >>> 0;
                            for (let y = patch.y; y < patch.y + patch.height; y++) {
                                for (let x = patch.x; x < patch.x + patch.width; x++) {
                                    state ^= state << 13;
                                    state ^= state >>> 17;
                                    state ^= state << 5;
                                    const offset = (y * fixture.width + x) * 4;
                                    for (let channel = 0; channel < 3; channel++) {
                                        state = Math.imul(state ^ (x + 1) ^ ((y + 1) << 8) ^ (channel + 1), 0x45d9f3b) >>> 0;
                                        const delta = state % (patch.amplitude * 2 + 1) - patch.amplitude;
                                        image.data[offset + channel] = Math.max(0, Math.min(255, image.data[offset + channel] + delta));
                                    }
                                }
                            }
                        }
                        context.putImageData(image, 0, 0);
                    }
                    return result;
                }

                function sourceLabels(fixture, paths) {
                    const labels = new Int16Array(fixture.width * fixture.height);
                    for (let y = 0; y < fixture.height; y++) {
                        for (let x = 0; x < fixture.width; x++) {
                            labels[y * fixture.width + x] = paths.ownerAt(x + 0.5, y + 0.5);
                        }
                    }
                    return labels;
                }

                function makeOutputPaths(svg, statsPalette, resultToTarget) {
                    const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
                    if (svgDocument.querySelector("parsererror")) {
                        throw Error("Tracer returned malformed SVG.");
                    }
                    const colorIndices = new Map(statsPalette.map((color, index) => [color.toLowerCase(), index]));
                    const context = window.document.createElement("canvas").getContext("2d");
                    const outputElements = [...svgDocument.documentElement.querySelectorAll("*")];
                    const supportedTags = new Set(["path", "polygon", "rect", "circle", "ellipse"]);
                    if (outputElements.some(element => !supportedTags.has(element.localName))) {
                        throw Error("Tracer SVG contains an unsupported geometry element.");
                    }
                    const shapes = outputElements.map(element => {
                        const tag = element.localName;
                        const path = new Path2D();
                        if (tag === "path") {
                            const parsed = new Path2D(element.getAttribute("d") || "");
                            path.addPath(parsed);
                        } else if (tag === "polygon") {
                            const points = (element.getAttribute("points") || "").match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
                            for (let index = 0; index + 1 < points.length; index += 2) {
                                if (index === 0) {
                                    path.moveTo(points[index], points[index + 1]);
                                } else {
                                    path.lineTo(points[index], points[index + 1]);
                                }
                            }
                            path.closePath();
                        } else if (tag === "rect") {
                            const x = Number(element.getAttribute("x") || 0);
                            const y = Number(element.getAttribute("y") || 0);
                            const width = Number(element.getAttribute("width") || 0);
                            const height = Number(element.getAttribute("height") || 0);
                            const rx = Number(element.getAttribute("rx") || 0);
                            const ry = Number(element.getAttribute("ry") || element.getAttribute("rx") || 0);
                            if (rx || ry) {
                                path.roundRect(x, y, width, height, [rx, ry]);
                            } else {
                                path.rect(x, y, width, height);
                            }
                        } else if (tag === "circle") {
                            path.arc(Number(element.getAttribute("cx") || 0), Number(element.getAttribute("cy") || 0), Number(element.getAttribute("r") || 0), 0, Math.PI * 2);
                        } else if (tag === "ellipse") {
                            path.ellipse(Number(element.getAttribute("cx") || 0), Number(element.getAttribute("cy") || 0), Number(element.getAttribute("rx") || 0), Number(element.getAttribute("ry") || 0), 0, 0, Math.PI * 2);
                        }
                        const fill = (element.getAttribute("fill") || "#000000").toLowerCase();
                        const resultIndex = fill === "none" ? -1 : colorIndices.get(fill);
                        const owner = resultIndex === undefined ? -2 : resultIndex < 0 ? -1 : resultToTarget[resultIndex];
                        return {
                            path,
                            owner,
                            fillRule: element.getAttribute("fill-rule") || "nonzero",
                        };
                    });
                    return {
                        shapes,
                        ownerAt(x, y) {
                            let owner = -1;
                            for (const shape of shapes) {
                                if (shape.owner === -1) {
                                    continue;
                                }
                                if (context.isPointInPath(shape.path, x, y, shape.fillRule)) {
                                    owner = shape.owner;
                                }
                            }
                            return owner;
                        },
                    };
                }

                function matchPaints(fixture, stats) {
                    const targetColors = Object.keys(fixture.paints).map(id => parseHex(fixture.paints[id]));
                    const resultColors = stats.palette.map(parseHex);
                    const threshold = 52;
                    let best = {
                        count: -1,
                        distance: Infinity,
                        mapping: Array(targetColors.length).fill(null),
                    };
                    const used = new Set();
                    const mapping = Array(targetColors.length).fill(null);
                    const search = (targetIndex, count, distance) => {
                        if (targetIndex === targetColors.length) {
                            if (count > best.count || (count === best.count && distance < best.distance)) {
                                best = { count, distance, mapping: [...mapping] };
                            }
                            return;
                        }
                        mapping[targetIndex] = null;
                        search(targetIndex + 1, count, distance);
                        for (let resultIndex = 0; resultIndex < resultColors.length; resultIndex++) {
                            if (used.has(resultIndex)) {
                                continue;
                            }
                            const delta = rgbDistance(targetColors[targetIndex], resultColors[resultIndex]);
                            if (delta > threshold) {
                                continue;
                            }
                            used.add(resultIndex);
                            mapping[targetIndex] = resultIndex;
                            search(targetIndex + 1, count + 1, distance + delta);
                            used.delete(resultIndex);
                        }
                        mapping[targetIndex] = null;
                    };
                    search(0, 0, 0);
                    const resultToTarget = Array(resultColors.length).fill(-2);
                    for (let targetIndex = 0; targetIndex < best.mapping.length; targetIndex++) {
                        const resultIndex = best.mapping[targetIndex];
                        if (resultIndex !== null) {
                            resultToTarget[resultIndex] = targetIndex;
                        }
                    }
                    const matchedTargets = new Set(best.mapping.flatMap((value, index) => value === null ? [] : [index]));
                    return {
                        targetToResult: best.mapping,
                        resultToTarget,
                        missing: fixture.paints && Object.keys(fixture.paints).filter((_, index) => !matchedTargets.has(index)),
                        extra: stats.palette.filter((_, index) => resultToTarget[index] === -2),
                        resultColors,
                    };
                }

                function topology(labels, width, height, target) {
                    const seen = new Uint8Array(labels.length);
                    const queue = new Int32Array(labels.length);
                    const foregroundNeighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
                    const backgroundNeighbors = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
                    let components = 0;
                    let holes = 0;
                    for (let index = 0; index < labels.length; index++) {
                        if (seen[index] || labels[index] !== target) {
                            continue;
                        }
                        components++;
                        let head = 0;
                        let tail = 0;
                        queue[tail++] = index;
                        seen[index] = 1;
                        while (head < tail) {
                            const current = queue[head++];
                            const x = current % width;
                            const y = (current / width) | 0;
                            for (const [dx, dy] of foregroundNeighbors) {
                                const nx = x + dx;
                                const ny = y + dy;
                                if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                                    continue;
                                }
                                const next = ny * width + nx;
                                if (seen[next] || labels[next] !== target) continue;
                                seen[next] = 1;
                                queue[tail++] = next;
                            }
                        }
                    }

                    seen.fill(0);
                    for (let index = 0; index < labels.length; index++) {
                        if (seen[index] || labels[index] === target) {
                            continue;
                        }
                        let head = 0;
                        let tail = 0;
                        let touchesBorder = false;
                        queue[tail++] = index;
                        seen[index] = 1;
                        while (head < tail) {
                            const current = queue[head++];
                            const x = current % width;
                            const y = (current / width) | 0;
                            touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
                            for (const [dx, dy] of backgroundNeighbors) {
                                const nx = x + dx;
                                const ny = y + dy;
                                if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                                    continue;
                                }
                                const next = ny * width + nx;
                                if (seen[next] || labels[next] === target) continue;
                                seen[next] = 1;
                                queue[tail++] = next;
                            }
                        }
                        if (!touchesBorder) {
                            holes++;
                        }
                    }
                    return { components, holes };
                }

                function transitionPositions(getLabel, line, start, end) {
                    const step = 0.125;
                    const labels = [];
                    for (let coordinate = start + step / 2; coordinate < end; coordinate += step) {
                        labels.push(getLabel(coordinate));
                    }
                    const runs = [];
                    for (let index = 0; index < labels.length; index++) {
                        const last = runs.at(-1);
                        if (last && last.label === labels[index]) {
                            last.end = index;
                        } else {
                            runs.push({ label: labels[index], start: index, end: index });
                        }
                    }
                    return runs.slice(1).map((run, index) => ({
                        at: start + run.start * step,
                        from: runs[index].label,
                        to: run.label,
                    }));
                }

                function measureContour(fixture, paths, traceLabel) {
                    const deviations = [];
                    const lines = [];
                    for (const line of fixture.lines) {
                        const sourceLabel = coordinate => line.axis === "h"
                            ? paths.ownerAt(coordinate, line.at)
                            : paths.ownerAt(line.at, coordinate);
                        const tracedLabel = coordinate => {
                            const x = line.axis === "h" ? coordinate : line.at;
                            const y = line.axis === "h" ? line.at : coordinate;
                            return traceLabel(x, y);
                        };
                        const expected = transitionPositions(sourceLabel, line, line.start, line.end);
                        const actual = transitionPositions(tracedLabel, line, line.start, line.end);
                        const offsets = [];
                        const matched = [];
                        const available = new Set(actual.map((_, index) => index));
                        const unmatchedExpected = [];
                        for (const transition of expected) {
                            const candidates = [...available].filter(index =>
                                actual[index].from === transition.from && actual[index].to === transition.to);
                            if (!candidates.length) {
                                unmatchedExpected.push(transition);
                                continue;
                            }
                            const index = candidates.reduce((bestIndex, candidateIndex) =>
                                Math.abs(actual[candidateIndex].at - transition.at) < Math.abs(actual[bestIndex].at - transition.at)
                                    ? candidateIndex
                                    : bestIndex);
                            available.delete(index);
                            const delta = Math.abs(transition.at - actual[index].at);
                            deviations.push(delta);
                            offsets.push(Number(delta.toFixed(3)));
                            matched.push({
                                expected: transition,
                                actual: actual[index],
                                deviationPx: Number(delta.toFixed(3)),
                            });
                        }
                        lines.push({
                            axis: line.axis,
                            at: line.at,
                            expected: expected.length,
                            actual: actual.length,
                            offsetsPx: offsets,
                            matched,
                            unmatchedExpected,
                            unmatchedActual: [...available].map(index => actual[index]),
                        });
                    }
                    return {
                        lines,
                        comparedTransitions: deviations.length,
                        missingTransitions: lines.reduce((sum, line) => sum + line.unmatchedExpected.length, 0),
                        extraTransitions: lines.reduce((sum, line) => sum + line.unmatchedActual.length, 0),
                        meanDeviationPx: deviations.length ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0,
                        maxDeviationPx: deviations.length ? Math.max(...deviations) : 0,
                    };
                }

                function ownership(sourceLabels, outputOwnerAt, width, height) {
                    const resultLabels = new Int16Array(width * height);
                    const confusion = {};
                    let correct = 0;
                    let all = 0;
                    let interiorCorrect = 0;
                    let interior = 0;
                    for (let index = 0; index < resultLabels.length; index++) {
                        const x = index % width;
                        const y = (index / width) | 0;
                        const resultLabel = outputOwnerAt(x + 0.5, y + 0.5);
                        resultLabels[index] = resultLabel;
                        const sourceLabel = sourceLabels[index];
                        const key = `${sourceLabel}->${resultLabel}`;
                        confusion[key] = (confusion[key] || 0) + 1;
                        all++;
                        if (sourceLabel === resultLabel) {
                            correct++;
                        }
                        const interiorPixel = (x === 0 || sourceLabels[index - 1] === sourceLabel) &&
                            (x === width - 1 || sourceLabels[index + 1] === sourceLabel) &&
                            (y === 0 || sourceLabels[index - width] === sourceLabel) &&
                            (y === height - 1 || sourceLabels[index + width] === sourceLabel);
                        if (interiorPixel) {
                            interior++;
                            if (sourceLabel === resultLabel) {
                                interiorCorrect++;
                            }
                        }
                    }
                    return {
                        labels: resultLabels,
                        confusion,
                        all: { correct, pixels: all, accuracy: correct / all },
                        interior: {
                            correct: interiorCorrect,
                            pixels: interior,
                            accuracy: interior ? interiorCorrect / interior : 0,
                        },
                    };
                }

                function probeResults(fixture, paths, getTraceLabel) {
                    const results = fixture.probes.map(probe => {
                        const expected = probe.paint === null ? -1 : paths.paintIndex.get(probe.paint);
                        const sourceOwner = paths.ownerAt(probe.x, probe.y);
                        const actual = getTraceLabel(probe.x, probe.y);
                        return {
                            name: probe.name,
                            kind: probe.kind || "ownership",
                            expected,
                            sourceOwner,
                            actual,
                            pass: expected === sourceOwner && expected === actual,
                        };
                    });
                    const invalidSourceProbes = results.filter(result => result.expected !== result.sourceOwner);
                    if (invalidSourceProbes.length) {
                        throw Error(`Fixture has probes outside their declared source paint: ${invalidSourceProbes.map(result => result.name).join(", ")}.`);
                    }
                    return {
                        count: results.length,
                        failures: results.filter(result => !result.pass).length,
                        lostAccents: results.filter(result => result.kind === "accent" && !result.pass).length,
                        results,
                    };
                }

                function encodeCropPair(sourceCanvas, traceCanvas, crop) {
                    const canvas = document.createElement("canvas");
                    canvas.width = crop.width * 2;
                    canvas.height = crop.height;
                    const context = canvas.getContext("2d");
                    context.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
                    context.drawImage(traceCanvas, crop.x, crop.y, crop.width, crop.height, crop.width, 0, crop.width, crop.height);
                    return canvas.toDataURL("image/png");
                }

                async function rasterizeSvg(svg, width, height, scale) {
                    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
                    try {
                        const image = new Image();
                        image.src = url;
                        await image.decode();
                        const canvas = document.createElement("canvas");
                        canvas.width = width * scale;
                        canvas.height = height * scale;
                        const context = canvas.getContext("2d", { willReadFrequently: true });
                        context.drawImage(image, 0, 0, canvas.width, canvas.height);
                        return {
                            canvas,
                            pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
                        };
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                }

                const results = [];
                const fixtureById = new Map(fixtures.map(fixture => [fixture.id, fixture]));
                for (const fixture of fixtures) {
                    try {
                        const paths = makePaths(fixture);
                        const idealLabels = sourceLabels(fixture, paths);
                        const idealTopology = Object.fromEntries([-1, ...paths.paints.map((_, index) => index)].map(label => [
                            label < 0 ? "transparent" : paths.paints[label],
                            topology(idealLabels, fixture.width, fixture.height, label),
                        ]));
                        const sourceCanvas = await applySourceVariation(renderVector(fixture, paths), fixture);
                        const input = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, fixture.width, fixture.height);
                        const tracer = window.campaignTracer;
                        const diagnosticMasks = diagnose ? window.validationDiagnostics.coverageMasks(fixture, paths.ownerAt) : null;

                        for (const noise of noises) {
                            for (const colorMode of ["auto", "explicit"]) {
                                const colors = colorMode === "auto" ? 0 : paths.paints.length;
                                try {
                                    const traced = tracer.trace(input, {
                                        colors,
                                        debug: diagnose,
                                        noise,
                                        tolerance: 1.25,
                                        minArea: 0,
                                        removeBackground: false,
                                        preserveDetails: true,
                                        outputWidth: fixture.width,
                                        outputHeight: fixture.height,
                                    });
                                    const svgRaster = await rasterizeSvg(traced.svg, fixture.width, fixture.height, 1);
                                    const palette = matchPaints(fixture, traced.stats);
                                    const outputPaths = makeOutputPaths(traced.svg, traced.stats.palette, palette.resultToTarget);
                                    const measure = ownership(idealLabels, outputPaths.ownerAt, fixture.width, fixture.height);
                                    const traceLabel = (x, y) => outputPaths.ownerAt(x, y);
                                    const contour = measureContour(fixture, paths, traceLabel);
                                    const probes = probeResults(fixture, paths, traceLabel);
                                    const outputTopology = Object.fromEntries([-1, ...paths.paints.map((_, index) => index)].map(label => [
                                        label < 0 ? "transparent" : paths.paints[label],
                                        topology(measure.labels, fixture.width, fixture.height, label),
                                    ]));
                                    let absoluteError = 0;
                                    for (let pixel = 0; pixel < input.data.length; pixel += 4) {
                                        for (let channel = 0; channel < 3; channel++) {
                                            absoluteError += Math.abs(svgRaster.pixels[pixel + channel] * svgRaster.pixels[pixel + 3] / 255 - input.data[pixel + channel] * input.data[pixel + 3] / 255);
                                        }
                                        absoluteError += Math.abs(svgRaster.pixels[pixel + 3] - input.data[pixel + 3]);
                                    }
                                    const svgBytes = new TextEncoder().encode(traced.svg).length;
                                    const result = {
                                        fixtureId: fixture.id,
                                        noise,
                                        colorMode,
                                        colors,
                                        status: "ok",
                                        palette: {
                                            intended: fixture.paints,
                                            discovered: traced.stats.palette,
                                            missing: palette.missing,
                                            extra: palette.extra,
                                            matching: palette.targetToResult.map((resultIndex, targetIndex) => ({
                                                paint: paths.paints[targetIndex],
                                                resultIndex,
                                                distance: resultIndex === null ? null : Number(rgbDistance(parseHex(fixture.paints[paths.paints[targetIndex]]), palette.resultColors[resultIndex]).toFixed(2)),
                                            })),
                                        },
                                        sourceTopology: idealTopology,
                                        outputTopology,
                                        topologyDelta: Object.fromEntries(paths.paints.map((paint, index) => [paint, {
                                            components: outputTopology[paint].components - idealTopology[paint].components,
                                            holes: outputTopology[paint].holes - idealTopology[paint].holes,
                                        }])),
                                        ownership: {
                                            all: measure.all,
                                            interior: measure.interior,
                                            confusion: measure.confusion,
                                        },
                                        probes,
                                        contour,
                                        rasterMaeAgainstInput: absoluteError / input.data.length,
                                        svgBytes,
                                        stats: {
                                            colors: traced.stats.colors,
                                            regions: traced.stats.regions,
                                            visibleRegions: traced.stats.visibleRegions,
                                            segments: traced.stats.segments,
                                            fallbackChains: traced.stats.fallbackChains,
                                            recoveredPaints: traced.stats.recoveredPaints,
                                            ms: traced.stats.ms,
                                        },
                                    };
                                    if (diagnose) {
                                        const nativeOutput = makeOutputPaths(traced.svg, traced.stats.palette, traced.stats.palette.map((_, index) => index));
                                        result.diagnostics = window.validationDiagnostics.diagnose({
                                            fixture,
                                            paths,
                                            input,
                                            traced,
                                            stages: window.validationStages,
                                            masks: diagnosticMasks,
                                            contour,
                                            probes,
                                            outputAt: traceLabel,
                                            nativeOutputAt: nativeOutput.ownerAt,
                                            operationalMapping: palette.resultToTarget,
                                        });
                                    }
                                    if (includeSvg) {
                                        result.svg = traced.svg;
                                    }
                                    if (includeCrops) {
                                        result.crops = Object.fromEntries(fixture.crops.map(crop => [crop.name, encodeCropPair(sourceCanvas, svgRaster.canvas, crop)]));
                                    }
                                    results.push(result);
                                } catch (error) {
                                    results.push({
                                        fixtureId: fixture.id,
                                        noise,
                                        colorMode,
                                        colors,
                                        status: "error",
                                        stage: "trace-or-metrics",
                                        message: message(error),
                                    });
                                }
                            }
                        }
                    } catch (error) {
                        for (const noise of noises) {
                            for (const colorMode of ["auto", "explicit"]) {
                                results.push({
                                    fixtureId: fixture.id,
                                    noise,
                                    colorMode,
                                    status: "error",
                                    stage: "fixture",
                                    message: message(error),
                                });
                            }
                        }
                    }
                }
                return results;
            }, {
                fixtures,
                noises,
                cases,
                diagnose: config.diagnose,
                includeSvg: Boolean(config.svgDir),
                includeCrops: Boolean(config.cropDir),
            });

            for (const result of browserResults) {
                if (result.status === "ok") {
                    const fixture = fixtures.find(candidate => candidate.id === result.fixtureId);
                    if (config.svgDir) {
                        const filename = `${safeName(result.fixtureId)}-n${result.noise}-${result.colorMode}.svg`;
                        await writeFile(resolve(config.svgDir, filename), result.svg, {
                            encoding: "utf8",
                            flag: "wx",
                        });
                        result.svgFile = filename;
                    }
                    if (config.cropDir) {
                        const cropNames = Object.keys(result.crops || {});
                        for (const cropName of cropNames) {
                            const filename = `${safeName(result.fixtureId)}-n${result.noise}-${result.colorMode}-${safeName(cropName)}.png`;
                            const base64 = result.crops[cropName].slice("data:image/png;base64,".length);
                            await writeFile(resolve(config.cropDir, filename), Buffer.from(base64, "base64"), { flag: "wx" });
                        }
                        result.cropFiles = cropNames.map(cropName => `${safeName(result.fixtureId)}-n${result.noise}-${result.colorMode}-${safeName(cropName)}.png`);
                    }
                    delete result.svg;
                    delete result.crops;
                }
                resultByKey.set(`${result.fixtureId}:${result.noise}:${result.colorMode}`, result);
            }
        } finally {
            await page.close();
        }
    } catch (error) {
        for (const item of cases) {
            const key = `${item.fixtureId}:${item.noise}:${item.colorMode}`;
            if (!resultByKey.has(key)) {
                resultByKey.set(key, {
                    fixtureId: item.fixtureId,
                    noise: item.noise,
                    colorMode: item.colorMode,
                    status: "error",
                    stage: "browser-setup",
                    message: String(error.message || error),
                });
            }
        }
    } finally {
        await browser?.close();
    }

    const results = cases.map(item => resultByKey.get(`${item.fixtureId}:${item.noise}:${item.colorMode}`) || {
        fixtureId: item.fixtureId,
        noise: item.noise,
        colorMode: item.colorMode,
        status: "error",
        stage: "unknown",
        message: "No result was recorded.",
    });
    const report = { metadata, summary: summarize(results), results };
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({
        round: config.round, ...report.summary,
        browser: metadata.browser,
        out: config.out,
    })}\n`);
    if (report.summary.failed) {
        process.exitCode = 1;
    }
}

async function main() {
    let config;
    try {
        config = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n${usage}\n`);
        process.exitCode = 2;
        return;
    }
    if (config.help) {
        process.stdout.write(`${usage}\nOutput paths must be unused; existing reports and export directories are never overwritten.\n`);
        return;
    }
    await runStudy(config);
}

if (import.meta.main) {
    await main();
}
