/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const usage = "Usage: bun tests/quality-study.js --input IMAGE [--input IMAGE ...] [--core tracer.js] [--out JSON] [--noise 0,10,20,40] [--colors 0] [--max-size 1024] [--jpeg-quality 0.9] [--svg-dir DIR]";

function parseArgs(args) {
    const config = {
        inputs: [],
        core: resolve(import.meta.dir, "../tracer.js"),
        out: resolve(".quality-work/quality-study.json"),
        noises: [0, 10, 20, 40],
        colors: 0,
        maxSize: 1024,
        jpegQuality: null,
        svgDir: null,
        help: false,
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
        if (flag === "--input") {
            config.inputs.push(resolve(value(i, flag)));
            i++;
            continue;
        }
        if (flag === "--core") {
            config.core = resolve(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--out") {
            config.out = resolve(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--noise") {
            const list = value(i, flag).split(",");
            config.noises = list.map(Number);
            if (list.some(part => !/^\d+$/.test(part))) {
                throw Error("--noise expects comma-separated integers from 0 to 40.");
            }
            i++;
            continue;
        }
        if (flag === "--max-size") {
            config.maxSize = Number(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--colors") {
            config.colors = Number(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--jpeg-quality") {
            config.jpegQuality = Number(value(i, flag));
            i++;
            continue;
        }
        if (flag === "--svg-dir") {
            config.svgDir = resolve(value(i, flag));
            i++;
            continue;
        }
        throw Error(`Unknown option: ${flag}`);
    }

    if (config.help) {
        return config;
    }
    if (!config.inputs.length) {
        throw Error("At least one --input is required.");
    }
    if (!config.noises.length || config.noises.some(noise => !Number.isInteger(noise) || noise < 0 || noise > 40) || new Set(config.noises).size !== config.noises.length) {
        throw Error("--noise expects unique comma-separated integers from 0 to 40.");
    }
    if (!Number.isInteger(config.maxSize) || config.maxSize < 32 || config.maxSize > 2000) {
        throw Error("--max-size must be an integer from 32 to 2000.");
    }
    if (!Number.isInteger(config.colors) || config.colors < 0 || config.colors > 64) {
        throw Error("--colors must be an integer from 0 (Auto) to 64.");
    }
    if (config.jpegQuality !== null && (!Number.isFinite(config.jpegQuality) || config.jpegQuality < 0 || config.jpegQuality > 1)) {
        throw Error("--jpeg-quality must be a number from 0 to 1.");
    }
    if (config.inputs.includes(config.out) || config.out === config.core) {
        throw Error("--out must not overwrite an input image or tracer source.");
    }
    return config;
}

function mimeType(file, data) {
    const extension = extname(file).toLowerCase();
    const known = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".avif": "image/avif",
        ".svg": "image/svg+xml",
    };
    if (known[extension]) {
        return known[extension];
    }
    if (data[0] === 0x89 && data.toString("ascii", 1, 4) === "PNG") {
        return "image/png";
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
        return "image/jpeg";
    }
    if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
        return "image/webp";
    }
    if (data.toString("ascii", 0, 3) === "GIF") {
        return "image/gif";
    }
    if (data.toString("ascii", 0, 2) === "BM") {
        return "image/bmp";
    }
    return "application/octet-stream";
}

function caseResult(inputIndex, input, noise, status, details = {}) {
    return { inputIndex, input, noise, status, ...details };
}

function svgFilename(inputIndex, input, noise) {
    const stem = basename(input, extname(input)).replace(/[^a-zA-Z0-9._-]+/g, "_") || "image";
    return `${String(inputIndex + 1).padStart(2, "0")}-${stem}-noise-${noise}.svg`;
}

function summarize(results) {
    const failed = results.filter(result => result.status === "error").length;
    return { cases: results.length, completed: results.length - failed, failed };
}

async function runStudy(config) {
    const outputs = [config.out];
    if (config.svgDir) {
        for (let i = 0; i < config.inputs.length; i++) {
            outputs.push(...config.noises.map(noise => resolve(config.svgDir, svgFilename(i, config.inputs[i], noise))));
        }
    }
    if (new Set(outputs).size !== outputs.length) {
        throw Error("Report and SVG output paths must be distinct.");
    }
    for (const path of outputs) {
        try {
            await stat(path);
        } catch (error) {
            if (error.code === "ENOENT") {
                continue;
            }
            throw error;
        }
        throw Error(`Output already exists; choose an unused path: ${path}`);
    }
    const core = await readFile(config.core, "utf8");
    const coreSHA256 = createHash("sha256").update(core).digest("hex");
    const metadata = {
        browser: null,
        core: config.core,
        coreSHA256,
        inputs: config.inputs,
        inputSHA256: {},
        noise: config.noises,
        maxSize: config.maxSize,
        jpegQuality: config.jpegQuality,
        jpegMethod: config.jpegQuality === null
            ? "No additional JPEG encoding; compare with the browser-decoded source bitmap."
            : "Draw the browser-decoded source at native size to canvas, encode as JPEG at the requested quality with Chromium's default transparent-pixel handling, decode in Chromium, then resize with high-quality canvas smoothing; compare with the original browser-decoded RGBA bitmap.",
        comparison: "Native-resolution SVG raster versus original browser-decoded RGBA bitmap; mean absolute premultiplied RGBA error on a 0-255 scale.",
        options: { colors: config.colors, tolerance: 1.25, minArea: 6, removeBackground: false },
    };
    const results = [];

    await mkdir(dirname(config.out), { recursive: true });
    if (config.svgDir) {
        await mkdir(config.svgDir, { recursive: true });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        metadata.browser = browser.version();
        const page = await browser.newPage();
        try {
            await page.addScriptTag({ content: `${core}\nwindow.qualityStudyTracer = createTracer();` });
            const tracerReady = await page.evaluate(() => typeof window.qualityStudyTracer?.trace === "function");
            if (!tracerReady) {
                throw Error("Could not load createTracer() from the selected core.");
            }

            for (let inputIndex = 0; inputIndex < config.inputs.length; inputIndex++) {
                const input = config.inputs[inputIndex];
                let bytes;
                try {
                    bytes = await readFile(input);
                    metadata.inputSHA256[input] = createHash("sha256").update(bytes).digest("hex");
                } catch (error) {
                    for (const noise of config.noises) {
                        results.push(caseResult(inputIndex, input, noise, "error", {
                            stage: "read",
                            message: String(error.message || error),
                        }));
                    }
                    continue;
                }

                let cases;
                try {
                    cases = await page.evaluate(async ({
                                                           inputIndex,
                                                           input,
                                                           source,
                                                           mime,
                                                           noises,
                                                           colors,
                                                           maxSize,
                                                           jpegQuality,
                                                           includeSvg,
                                                       }) => {
                        const failed = (noise, stage, error) => ({
                            inputIndex,
                            input,
                            noise,
                            status: "error",
                            stage,
                            message: String(error?.message || error),
                        });
                        const decode = async url => {
                            const image = new Image();
                            image.src = url;
                            await image.decode();
                            return image;
                        };
                        let originalImage;
                        let originalPixels;
                        try {
                            originalImage = await decode(`data:${mime};base64,${source}`);
                            const originalCanvas = document.createElement("canvas");
                            originalCanvas.width = originalImage.naturalWidth;
                            originalCanvas.height = originalImage.naturalHeight;
                            const originalContext = originalCanvas.getContext("2d", { willReadFrequently: true });
                            originalContext.drawImage(originalImage, 0, 0);
                            originalPixels = originalContext.getImageData(0, 0, originalCanvas.width, originalCanvas.height).data;
                        } catch (error) {
                            return noises.map(noise => failed(noise, "decode", error));
                        }

                        let traceImage = originalImage;
                        if (jpegQuality !== null) {
                            try {
                                const jpegCanvas = document.createElement("canvas");
                                jpegCanvas.width = originalImage.naturalWidth;
                                jpegCanvas.height = originalImage.naturalHeight;
                                jpegCanvas.getContext("2d").drawImage(originalImage, 0, 0);
                                const blob = await new Promise((resolve, reject) => {
                                    jpegCanvas.toBlob(result => result ? resolve(result) : reject(Error("Canvas JPEG encoding returned no data.")), "image/jpeg", jpegQuality);
                                });
                                const url = URL.createObjectURL(blob);
                                try {
                                    traceImage = await decode(url);
                                } finally {
                                    URL.revokeObjectURL(url);
                                }
                            } catch (error) {
                                return noises.map(noise => failed(noise, "jpeg-recompression", error));
                            }
                        }

                        const originalWidth = originalImage.naturalWidth;
                        const originalHeight = originalImage.naturalHeight;
                        const scale = Math.min(1, maxSize / Math.max(originalWidth, originalHeight));
                        const workingWidth = Math.max(1, Math.round(originalWidth * scale));
                        const workingHeight = Math.max(1, Math.round(originalHeight * scale));
                        const workingCanvas = document.createElement("canvas");
                        workingCanvas.width = workingWidth;
                        workingCanvas.height = workingHeight;
                        const workingContext = workingCanvas.getContext("2d", { willReadFrequently: true });
                        workingContext.imageSmoothingEnabled = true;
                        workingContext.imageSmoothingQuality = "high";
                        workingContext.drawImage(traceImage, 0, 0, workingWidth, workingHeight);
                        const workingPixels = workingContext.getImageData(0, 0, workingWidth, workingHeight);
                        const tracer = window.qualityStudyTracer;
                        const records = [];

                        for (const noise of noises) {
                            let svgUrl;
                            try {
                                const traced = tracer.trace(workingPixels, {
                                    colors,
                                    noise,
                                    tolerance: 1.25,
                                    minArea: 6,
                                    removeBackground: false,
                                    outputWidth: originalWidth,
                                    outputHeight: originalHeight,
                                });
                                svgUrl = URL.createObjectURL(new Blob([traced.svg], { type: "image/svg+xml" }));
                                const svgImage = await decode(svgUrl);
                                const raster = document.createElement("canvas");
                                raster.width = originalWidth;
                                raster.height = originalHeight;
                                const context = raster.getContext("2d", { willReadFrequently: true });
                                context.drawImage(svgImage, 0, 0, originalWidth, originalHeight);
                                const actual = context.getImageData(0, 0, originalWidth, originalHeight).data;
                                let sum = 0;
                                for (let pixel = 0; pixel < actual.length; pixel += 4) {
                                    for (let channel = 0; channel < 3; channel++) {
                                        sum += Math.abs(actual[pixel + channel] * actual[pixel + 3] / 255 - originalPixels[pixel + channel] * originalPixels[pixel + 3] / 255);
                                    }
                                    sum += Math.abs(actual[pixel + 3] - originalPixels[pixel + 3]);
                                }
                                records.push({
                                    inputIndex,
                                    input,
                                    noise,
                                    status: "ok",
                                    requestedColors: colors,
                                    original: { width: originalWidth, height: originalHeight },
                                    working: { width: workingWidth, height: workingHeight },
                                    jpegQuality,
                                    traceSource: jpegQuality === null ? "original decoded image" : "JPEG recompression decoded from native-size canvas",
                                    error: sum / actual.length,
                                    errorMethod: "native-resolution mean absolute premultiplied RGBA error against original decoded input",
                                    stats: {
                                        colors: traced.stats.colors,
                                        palette: traced.stats.palette,
                                        regions: traced.stats.regions,
                                        visibleRegions: traced.stats.visibleRegions,
                                        segments: traced.stats.segments,
                                        svgBytes: new TextEncoder().encode(traced.svg).length,
                                        fallbackChains: traced.stats.fallbackChains,
                                        recoveredPaints: traced.stats.recoveredPaints,
                                        ms: traced.stats.ms,
                                    },
                                });
                                if (includeSvg) {
                                    records.at(-1).svg = traced.svg;
                                }
                            } catch (error) {
                                records.push(failed(noise, "trace-or-render", error));
                            } finally {
                                if (svgUrl) {
                                    URL.revokeObjectURL(svgUrl);
                                }
                            }
                        }
                        return records;
                    }, {
                        inputIndex,
                        input,
                        source: Buffer.from(bytes).toString("base64"),
                        mime: mimeType(input, bytes),
                        noises: config.noises,
                        colors: config.colors,
                        maxSize: config.maxSize,
                        jpegQuality: config.jpegQuality,
                        includeSvg: Boolean(config.svgDir),
                    });
                } catch (error) {
                    cases = config.noises.map(noise => ({
                        inputIndex,
                        input,
                        noise,
                        status: "error",
                        stage: "browser",
                        message: String(error.message || error),
                    }));
                }

                for (const result of cases) {
                    if (result.status === "ok" && config.svgDir) {
                        const filename = svgFilename(inputIndex, input, result.noise);
                        try {
                            await writeFile(resolve(config.svgDir, filename), result.svg, {
                                encoding: "utf8",
                                flag: "wx",
                            });
                            result.svgFile = filename;
                        } catch (error) {
                            result.status = "error";
                            result.stage = "write-svg";
                            result.message = String(error.message || error);
                        }
                    }
                    delete result.svg;
                    results.push(result);
                }
            }
        } finally {
            await page.close();
        }
    } catch (error) {
        const message = String(error.message || error);
        for (let inputIndex = 0; inputIndex < config.inputs.length; inputIndex++) {
            const input = config.inputs[inputIndex];
            for (const noise of config.noises) {
                const exists = results.some(result => result.inputIndex === inputIndex && result.noise === noise);
                if (!exists) {
                    results.push(caseResult(inputIndex, input, noise, "error", {
                        stage: "browser-setup",
                        message,
                    }));
                }
            }
        }
    } finally {
        await browser?.close();
    }

    const ordered = config.inputs.flatMap((input, inputIndex) => config.noises.map(noise =>
        results.find(result => result.inputIndex === inputIndex && result.noise === noise) || caseResult(inputIndex, input, noise, "error", {
            stage: "unknown",
            message: "No result was recorded.",
        })));
    const report = { metadata, summary: summarize(ordered), results: ordered };
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({
        ...report.summary,
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
        process.stdout.write(`${usage}\nOutput paths must be unused; existing reports and SVGs are never overwritten.\n`);
        return;
    }
    await runStudy(config);
}

if (import.meta.main) {
    await main();
}
