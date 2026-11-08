#!/usr/bin/env bun
/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { makeSeedlessPaintArtwork } from "./seedless-paints.js";
import { correlatedColumnAccent } from "./campaign-paints.js";
import { makeSharedBoundaryArtwork } from "./shared-boundary-artwork.js";
import { sharedBoundaryModel } from "./shared-boundary-model.js";

const { createTracer } = createRequire(import.meta.url)("../tracer.js");
const configurations = [
    { degree: 2, robust: false },
    { degree: 3, robust: false },
    { degree: 2, robust: true },
    { degree: 3, robust: true },
];
const hexRGB = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function nominalPaint(rgb, paints) {
    const distances = paints.map((paint) => paint.reduce((sum, value, channel) => sum + (value - rgb[channel]) ** 2, 0));
    return distances.indexOf(Math.min(...distances));
}

function parseArgs(args) {
    const config = { input: null, out: null };
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--help") return { help: true };
        if (!["--input", "--out"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) {
            throw Error(`Expected --input IMAGE or --out UNUSED.json; received ${flag}.`);
        }
        config[flag.slice(2)] = resolve(args[++index]);
    }
    if (!config.out) throw Error("Provide --out UNUSED.json.");
    return config;
}

function analyze(image, baseline, noise, options) {
    const labels = baseline.debug.labels;
    const model = sharedBoundaryModel({
        ...image,
        labels,
        palette: baseline.stats.palette.map(hexRGB),
        noise,
    }, options);
    const diff = Array.from(model.labels).flatMap((color, pixel) =>
        color === labels[pixel] ? [] : [{ pixel, before: labels[pixel], after: color }],
    );
    return { model, diff };
}

async function main() {
    const config = parseArgs(process.argv.slice(2));
    if (config.help) {
        process.stdout.write("Usage: bun tests/shared-boundary-study.js [--input IMAGE] --out UNUSED.json\n");
        return;
    }
    if (await Bun.file(config.out).exists()) throw Error(`Output already exists: ${config.out}`);
    const paths = [
        "../tracer.js",
        "../index.html",
        "./shared-boundary-study.js",
        "./shared-boundary-model.js",
        "./shared-boundary-artwork.js",
        "./seedless-paints.js",
        "./campaign-paints.js",
    ];
    const sources = await Promise.all(
        paths.map(async (path) => {
            const url = new URL(path, import.meta.url);
            return { path: fileURLToPath(url), sha256: sha256(await readFile(url)) };
        }),
    );
    const tracer = createTracer();
    const rows = [];
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        if (config.input) {
            await page.goto(new URL("../index.html", import.meta.url).href);
            await page.locator("#file").setInputFiles(config.input);
            await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Ready."));
            const decoded = await page.evaluate(() => {
                const canvas = document.querySelector("#source");
                return {
                    width: canvas.width,
                    height: canvas.height,
                    data: Array.from(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data),
                };
            });
            const image = { ...decoded, data: new Uint8ClampedArray(decoded.data) };
            for (const noise of [10, 20]) {
                const baseline = tracer.trace(image, { noise, debug: true });
                for (const options of configurations) {
                    const { model, diff } = analyze(image, baseline, noise, options);
                    rows.push({
                        kind: "input",
                        input: config.input,
                        width: image.width,
                        height: image.height,
                        noise,
                        options,
                        baseline: baseline.stats,
                        changed: diff.length,
                        diff,
                        proposals: model.proposals,
                    });
                }
            }
        }
        const artworkMetadata = [];
        for (const kind of ["edge", "junction"])
            for (const present of [false, true])
                for (const corrupted of [false, true]) {
                    const artwork = makeSharedBoundaryArtwork({ kind, present, corrupted });
                    artworkMetadata.push(artwork.metadata);
                    for (const noise of [10, 20]) {
                        const baseline = tracer.trace(artwork.image, {
                            colors: kind === "edge" ? 3 : 4,
                            noise,
                            minArea: 0,
                            debug: true,
                        });
                        const paint = baseline.debug.labels[artwork.swatchPixel];
                        const beforeHits = artwork.targetPixels.filter((pixel) => baseline.debug.labels[pixel] === paint).length;
                        const beforeFalse = artwork.boundaryPixels.filter(
                            (pixel) => baseline.debug.labels[pixel] === paint && artwork.coverage[2][pixel] === 0,
                        ).length;
                        for (const options of configurations) {
                            const {
                                model,
                                diff,
                            } = analyze(artwork.image, baseline, noise, options);
                            rows.push({
                                kind,
                                present,
                                corrupted,
                                noise,
                                options,
                                mode: "baseline-labels",
                                beforeHits,
                                afterHits: artwork.targetPixels.filter((pixel) => model.labels[pixel] === paint).length,
                                beforeFalse,
                                afterFalse: artwork.boundaryPixels.filter(
                                    (pixel) => model.labels[pixel] === paint && artwork.coverage[2][pixel] === 0,
                                ).length,
                                changed: diff.length,
                                diff: diff.map((change) => ({
                                    ...change,
                                    expected: artwork.sourceLabels[change.pixel],
                                    assigned: nominalPaint(hexRGB(baseline.stats.palette[change.after]), artwork.paints),
                                })),
                                proposals: model.proposals,
                            });
                        }
                    }
                    if (corrupted) {
                        const labels = new Int16Array(artwork.sourceLabels);
                        for (const pixel of artwork.targetPixels) labels[pixel] = 2;
                        for (const options of configurations) {
                            const model = sharedBoundaryModel({
                                ...artwork.image,
                                labels,
                                palette: artwork.paints,
                                noise: 10,
                            }, options);
                            rows.push({
                                kind,
                                present,
                                corrupted,
                                options,
                                mode: "source-labels-plus-proposal",
                                changed: Array.from(model.labels).filter((color, pixel) => color !== labels[pixel]).length,
                                pixels: artwork.targetPixels.length,
                                afterHits: artwork.targetPixels.filter((pixel) => model.labels[pixel] === 2).length,
                                proposals: model.proposals,
                            });
                        }
                    }
                }
        for (const kind of ["branched", "disconnected"])
            for (const present of [false, true]) {
                const artwork = makeSeedlessPaintArtwork({ kind, present });
                for (const jpeg of [false, true]) {
                    let image = artwork.image;
                    if (jpeg) {
                        const data = await page.evaluate(
                            async ({ width, height, data }) => {
                                const canvas = document.createElement("canvas");
                                canvas.width = width;
                                canvas.height = height;
                                const context = canvas.getContext("2d");
                                context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
                                const decoded = new Image();
                                decoded.src = canvas.toDataURL("image/jpeg", 0.85);
                                await decoded.decode();
                                context.drawImage(decoded, 0, 0);
                                return Array.from(context.getImageData(0, 0, width, height).data);
                            },
                            { ...image, data: Array.from(image.data) },
                        );
                        image = { ...image, data: new Uint8ClampedArray(data) };
                    }
                    for (const noise of [10, 20])
                        for (const colors of [0, 3]) {
                            const baseline = tracer.trace(image, {
                                noise,
                                colors,
                                minArea: 0,
                                debug: true,
                            });
                            const paint = baseline.debug.labels[artwork.swatchPixel];
                            const beforeHits = artwork.targetPixels.filter((pixel) => baseline.debug.labels[pixel] === paint).length;
                            for (const options of configurations) {
                                const { model, diff } = analyze(image, baseline, noise, options);
                                rows.push({
                                    kind: "seedless",
                                    geometry: kind,
                                    present,
                                    jpeg,
                                    noise,
                                    colors,
                                    options,
                                    beforeHits,
                                    afterHits: artwork.targetPixels.filter((pixel) => model.labels[pixel] === paint).length,
                                    changed: diff.length,
                                    diff,
                                    proposals: model.proposals,
                                });
                            }
                        }
                }
            }
        for (const diamond of [false, true])
            for (const offMixture of [false, true]) {
                const artwork = correlatedColumnAccent({ diamond, offMixture });
                const baseline = tracer.trace(artwork.image, {
                    noise: 10,
                    minArea: 0,
                    debug: true,
                });
                for (const options of configurations) {
                    const { model, diff } = analyze(artwork.image, baseline, 10, options);
                    rows.push({
                        kind: "correlated-columns",
                        diamond,
                        offMixture,
                        options,
                        changed: diff.length,
                        diff,
                        proposals: model.proposals,
                    });
                }
            }
        const metadata = {
            browser: browser.version(),
            sources,
            configurations,
            input: config.input ? {
                path: config.input,
                sha256: sha256(await readFile(config.input)),
            } : null,
            artwork: artworkMetadata,
            comparison:
                "Baseline cases freeze post-cleanup proposals; source-known isolation cases are identified separately. Shared prediction changes labels only. SVG contour quality is not evaluated.",
        };
        await mkdir(dirname(config.out), { recursive: true });
        await writeFile(config.out, JSON.stringify({
            metadata,
            rows,
        }, null, 2) + "\n", { flag: "wx" });
        process.stdout.write(
            JSON.stringify({
                out: config.out,
                rows: rows.length,
                changed: rows
                    .filter((row) => row.changed)
                    .map(({ kind, mode, noise, present, corrupted, options, changed }) => ({
                        kind,
                        mode,
                        noise,
                        present,
                        corrupted,
                        options,
                        changed,
                    })),
            }) + "\n",
        );
    } finally {
        await browser?.close();
    }
}

await main();
