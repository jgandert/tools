/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global process */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeClippedBinaryCapsule, makeEdgeArtifactArtwork } from "./artwork.js";
import { measureSamplerOutline } from "./sampler-outline-metrics.js";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", import.meta.url)));
const limits = JSON.parse(readFileSync(new URL("raster-comparison.json", import.meta.url)));
let browser;
let page;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(new URL("../index.html", import.meta.url).href);
    await page.addScriptTag({ content: `window.measureSamplerOutline = ${measureSamplerOutline};` });
});

afterAll(async () => {
    await browser?.close();
});

// Compare premultiplied RGBA, so invisible RGB cannot hide alpha errors or
// unfairly penalize correct transparent output. The source pixels are fixed;
// rendering the exported SVG exercises the actual serialized geometry.
test.each(fixtures)("$name retains raster fidelity", async fixture => {
    const data = Array.from(readFileSync(new URL(`fixtures/${fixture.name}.rgba`, import.meta.url)));
    const expected = fixture.name === "edge_artifacts" ? (await page.evaluate(makeEdgeArtifactArtwork)).clean : data;
    const error = await page.evaluate(async ({ fixture, data, expected }) => {
        const { width, height } = fixture;
        const result = window.FlatLogoTracer.trace({
            width,
            height,
            data: new Uint8ClampedArray(data),
        }, {
            colors: fixture.colors, noise: 10, tolerance: 1.25, minArea: 6, ...fixture.options,
            // Background removal has separate semantic checks in test.cjs.
            removeBackground: false,
        });
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const actual = ctx.getImageData(0, 0, width, height).data;
        let sum = 0;
        for (let p = 0; p < actual.length; p += 4) {
            for (let channel = 0; channel < 3; channel++) {
                sum += Math.abs(actual[p + channel] * actual[p + 3] / 255 - expected[p + channel] * expected[p + 3] / 255);
            }
            sum += Math.abs(actual[p + 3] - expected[p + 3]);
        }
        return sum / actual.length;
    }, { fixture, data, expected });
    expect(error).toBeLessThanOrEqual(limits.find(item => item.name === fixture.name).maxError);
});

test("the sampler preserves straight and curved thin outlines", async () => {
    await page.locator("#shape-example").dispatchEvent("click");
    await page.waitForFunction(() => !document.querySelector("#trace").disabled);
    const metrics = await page.evaluate(async () => {
        const source = document.querySelector("#source");
        const input = source.getContext("2d").getImageData(0, 0, source.width, source.height);
        const result = window.FlatLogoTracer.trace(input);
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        // The sampled straight portions border white and red. Solve their RGB
        // mixture with the dark outline, then integrate its paint coverage
        // across each normal. This measures outline weight, including AA.
        const red = [223 - 255, 67 - 255, 94 - 255];
        const dark = [33 - 255, 44 - 255, 56 - 255];
        const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
        const rr = dot(red, red);
        const rd = dot(red, dark);
        const dd = dot(dark, dark);
        const determinant = rr * dd - rd * rd;
        const thickness = (data, x, y, dx, dy) => {
            let sum = 0;
            for (let i = -4; i <= 4; i++) {
                const p = (Math.floor(y + i * dy) * canvas.width + Math.floor(x + i * dx)) * 4;
                const pixel = [data[p] - 255, data[p + 1] - 255, data[p + 2] - 255];
                const weight = (dot(pixel, dark) * rr - dot(pixel, red) * rd) / determinant;
                sum += Math.max(0, Math.min(1, weight));
            }
            return sum;
        };
        const samples = [];
        for (let y = 140; y < 213; y += 3) {
            for (const x of [157.4, 331.6]) {
                samples.push([x, y, 1, 0]);
            }
        }
        for (let x = 187; x < 307; x += 3) {
            samples.push([x, 238.4, 0, 1]);
        }
        const widths = samples.map(p => thickness(actual, ...p));
        const widthError = samples.reduce((sum, p, i) => sum + Math.abs(widths[i] - thickness(input.data, ...p)), 0) / samples.length;
        const rasterError = actual.reduce((sum, value, i) => sum + Math.abs(value - input.data[i]), 0) / actual.length;

        // Render at eight times the source dimensions and area-average before
        // normal integration. Native nonoverlapping-fill AA seams otherwise
        // dominate apparent dark weight despite an accurate geometric width.
        const actualScale = 8;
        canvas.width = source.width * actualScale;
        canvas.height = source.height * actualScale;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const outlines = window.measureSamplerOutline({
            width: source.width,
            height: source.height,
            actual: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            expected: input.data,
            actualScale,
            nativeActual: actual,
        });
        return {
            widthError,
            rasterError,
            minimumWidth: Math.min(...widths),
            colors: result.stats.colors,
            outlines,
        };
    });
    expect(metrics.colors).toBe(6);
    expect(metrics.widthError).toBeLessThan(.13);
    expect(metrics.minimumWidth).toBeGreaterThan(1.35);
    expect(metrics.rasterError).toBeLessThan(.57);

    // Width errors are measured against each source profile, preserving the
    // generator's two-pixel circle/red and 1.5-pixel ellipse stroke weights.
    for (const name of ["circle", "topLeft", "topRight", "bottomRight", "bottomLeft", "ellipse"]) {
        const outline = metrics.outlines[name];
        const context = JSON.stringify({ name, ...outline });
        expect(outline.samples, context).toBeGreaterThan(20);
        expect(outline.meanWidthError, context).toBeLessThan(.13);
        expect(outline.maxWidthError, context).toBeLessThan(.26);
        expect(outline.meanCenterError, context).toBeLessThan(.1);
        expect(outline.maxCenterError, context).toBeLessThan(.3);
    }

    // A similarly displaced pair of edges can preserve width while bowing.
    // Compare center variation with the independently flat source top edge.
    const top = metrics.outlines.redTop;
    expect(top.samples).toBeGreaterThan(12);
    expect(top.sourceCenterRange).toBeLessThan(.01);
    expect(top.centerErrorRange).toBeLessThan(.08);
    expect(top.maxCenterError).toBeLessThan(.12);
    expect(top.meanWidthError).toBeLessThan(.08);
    for (const junction of metrics.outlines.junctions) {
        expect(junction.pixels, JSON.stringify(junction)).toBeGreaterThan(100);
        expect(junction.error, JSON.stringify(junction)).toBeLessThan(12);
    }
});

// Native sampler rasters move the shapes after painting the white background:
// Firefox 155 on Linux x86_64 by (+0.7, +0.7), Chromium by (+0.8, 0).
// Fixed pixels preserve both failures independently of the test rasterizer.
test.each([
    { name: "Firefox", file: "firefox-sampler.png", rings: 3, lineLimit: 40 },
    { name: "Chromium", file: "chromium-sampler.png", rings: 4, lineLimit: 100 },
])("the $name sampler keeps a smooth outline after local topology repairs", async fixture => {
    const source = readFileSync(new URL(`fixtures/${fixture.file}`, import.meta.url)).toString("base64");
    const metrics = await page.evaluate(async source => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const input = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.FlatLogoTracer.trace(input);
        const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
        const luminance = hex => [.2126, .7152, .0722].reduce((sum, weight, i) =>
            sum + weight * parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16), 0);
        const outline = [...svg.querySelectorAll("path[fill]")].sort((a, b) =>
            luminance(a.getAttribute("fill")) - luminance(b.getAttribute("fill")))[0];
        const rings = (outline?.getAttribute("d") || "").match(/M[^M]+/g) || [];
        const geometry = rings.map(ring => ({
            curves: (ring.match(/[AC]/g) || []).length,
            lines: (ring.match(/L/g) || []).length,
        }));
        return { stats: result.stats, geometry };
    }, source);

    expect(metrics.stats.colors).toBe(6);
    expect(metrics.geometry.length).toBe(fixture.rings);
    for (const ring of metrics.geometry) {
        const context = JSON.stringify(ring);
        expect(ring.curves, context).toBeGreaterThan(0);
        expect(ring.lines, context).toBeLessThan(fixture.lineLimit);
    }
    expect(metrics.stats.fallbackChains).toBe(0);
});

test.each([.45, .6].flatMap(slope => [0, 1, 2, 3].map(quarterTurns => ({ slope, quarterTurns }))))(
    "a clipped binary capsule stays smooth at slope $slope after $quarterTurns quarter turns", async config => {
        const input = makeClippedBinaryCapsule(config);
        const metrics = await page.evaluate(async input => {
            const result = window.FlatLogoTracer.trace({
                ...input,
                data: new Uint8ClampedArray(input.data),
            });
            const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
            const paths = [...svg.querySelectorAll("path")].map(path => path.getAttribute("d")).join("");
            const image = new Image();
            image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = input.width;
            canvas.height = input.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let error = 0;
            for (let pixel = 0; pixel < actual.length; pixel += 4) {
                for (let channel = 0; channel < 3; channel++) {
                    error += Math.abs(actual[pixel + channel] * actual[pixel + 3] / 255 -
                        input.data[pixel + channel] * input.data[pixel + 3] / 255);
                }
                error += Math.abs(actual[pixel + 3] - input.data[pixel + 3]);
            }
            return {
                colors: result.stats.colors,
                fallbackChains: result.stats.fallbackChains,
                rings: (paths.match(/M/g) || []).length,
                lines: (paths.match(/L/g) || []).length,
                curves: (paths.match(/[AC]/g) || []).length,
                error: error / actual.length,
            };
        }, input);
        const context = JSON.stringify({ config, ...metrics });
        expect(metrics.colors, context).toBe(1);
        expect(metrics.rings, context).toBe(1);
        expect(metrics.curves, context).toBeGreaterThan(0);
        expect(metrics.lines, context).toBeLessThanOrEqual(8);
        expect(metrics.lines + metrics.curves, context).toBeLessThanOrEqual(16);
        expect(metrics.fallbackChains, context).toBe(0);

        // Smoothing a center-sampled binary edge necessarily differs from its
        // staircase pixels. Bound that change while rejecting contour loss.
        expect(metrics.error, context).toBeLessThan(2.2);
    });

// Fully contained capsules exercise free loops rather than frame-anchored
// chains. The analytic source is independent of the tracer and its fitters.
test.each([.3, .8].flatMap(slope => [0, 1, 2, 3].map(quarterTurns => ({ slope, quarterTurns }))))(
    "a free binary capsule stays compact at slope $slope after $quarterTurns quarter turns", async config => {
        const input = makeClippedBinaryCapsule({ ...config, clipped: false });
        const metrics = await page.evaluate(async ({ input, config }) => {
            const result = window.FlatLogoTracer.trace({
                ...input,
                data: new Uint8ClampedArray(input.data),
            }, { debug: true });
            const paintedChains = result.debug.chains.filter(chain => [chain.right, chain.left].some(id => result.debug.faces[id]?.color >= 0));
            const endY = config.slope * 90 + 18 * Math.hypot(1, config.slope) + .05;
            const originalWidth = config.quarterTurns % 2 ? input.height : input.width;
            const originalHeight = config.quarterTurns % 2 ? input.width : input.height;
            const rotate = (x, y) => config.quarterTurns === 1 ? [originalHeight - y, x] : config.quarterTurns === 2 ? [originalWidth - x, originalHeight - y] : config.quarterTurns === 3 ? [y, originalWidth - x] : [x, y];
            const sideErrors = [];
            for (const sign of [-1, 1]) for (const t of [.2, .4, .6, .8]) {
                const x = 24 + 66 * t - sign * 18 * config.slope / Math.hypot(1, config.slope);
                const y = endY - config.slope * 66 * (1 - t) + sign * 18 / Math.hypot(1, config.slope);
                const [px, py] = rotate(x, y);
                let best = Infinity;
                for (const chain of paintedChains) for (let i = 1; i < chain.flat.length; i++) {
                    const a = chain.flat[i - 1];
                    const b = chain.flat[i];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const u = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
                    best = Math.min(best, Math.hypot(px - a.x - u * dx, py - a.y - u * dy));
                }
                sideErrors.push(best);
            }
            const image = new Image();
            image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = input.width;
            canvas.height = input.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            const actual = context.getImageData(0, 0, input.width, input.height).data;
            let error = 0;
            for (let p = 0; p < actual.length; p += 4) {
                for (let c = 0; c < 3; c++) error += Math.abs(actual[p + c] * actual[p + 3] / 255 - input.data[p + c] * input.data[p + 3] / 255);
                error += Math.abs(actual[p + 3] - input.data[p + 3]);
            }
            return {
                stats: result.stats, sideErrors,
                touchesFrame: paintedChains.some(chain => chain.raw.some(p => p.x === 0 || p.y === 0 || p.x === input.width || p.y === input.height)),
                error: error / actual.length,
            };
        }, { input, config });
        const context = JSON.stringify({ config, ...metrics });
        expect(metrics.stats.colors, context).toBe(1);
        expect(metrics.stats.visibleRegions, context).toBe(1);
        expect(metrics.stats.fallbackChains, context).toBe(0);
        expect(metrics.touchesFrame, context).toBe(false);
        for (const error of metrics.sideErrors) expect(error, context).toBeLessThan(1.25);
        expect(metrics.stats.segments, context).toBeLessThanOrEqual(16);
        expect(metrics.error, context).toBeLessThan(2.2);
    });

// Compactness and pixel error do not detect a polygon guide replacing a round
// end. Check the serialized curve requirement independently of those metrics.
test.each([.3, .8].map(slope => ({ slope })))("a free capsule at slope $slope retains curved ends after one quarter turn", async ({ slope }) => {
    const input = makeClippedBinaryCapsule({ slope, quarterTurns: 1, clipped: false });
    const stats = await page.evaluate(input => window.FlatLogoTracer.trace({
        ...input,
        data: new Uint8ClampedArray(input.data),
    }).stats, input);
    const curves = stats.elements.cubics + stats.elements.arcs + stats.primitives.circle + stats.primitives.ellipse + stats.primitives.roundedRect;
    expect(curves).toBeGreaterThan(0);
});

test.each([10, 20].map(noise => ({ noise })))("the parrot wing arm uses its neighboring paints at noise $noise", async ({ noise }) => {
    await page.locator("#max-size").fill("1024");
    await page.locator("#file").setInputFiles(fileURLToPath(new URL("./parrot.jpg", import.meta.url)));
    await page.waitForFunction(() => document.querySelector("#source-name").textContent === "parrot.jpg" && !document.querySelector("#trace").disabled);
    const metrics = await page.evaluate(noise => {
        const canvas = document.querySelector("#source");
        const input = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        const result = window.FlatLogoTracer.trace(input, { noise, debug: true });
        const palette = result.stats.palette.map(hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)));
        const closest = target => {
            const distances = palette.map(rgb => Math.hypot(...rgb.map((value, channel) => value - target[channel])));
            const label = distances.indexOf(Math.min(...distances));
            return { label, distance: distances[label] };
        };
        const red = closest([221, 30, 35]);
        const blue = closest([43, 81, 155]);
        const brown = closest([130, 91, 67]);
        const arm = Array.from({ length: 17 }, (_, offset) => result.debug.labels[(329 + offset) * input.width + 562]);
        const holder = document.createElement("div");
        holder.innerHTML = result.svg;
        document.body.append(holder);
        try {
            const brownShapes = [...holder.querySelectorAll("path,circle,ellipse,rect,polygon")].filter(shape =>
                shape.getAttribute("fill") === result.stats.palette[brown.label]);
            return {
                width: input.width,
                height: input.height,
                red,
                blue,
                brown,
                arm,
                remainingBrown: result.debug.labels.filter(label => label === brown.label).length,
                brownOnArm: [337, 338, 339, 340, 341].some(y => brownShapes.some(shape => shape.isPointInFill(new DOMPoint(562.5, y + .5)))),
                fallbackChains: result.stats.fallbackChains,
            };
        } finally {
            holder.remove();
        }
    }, noise);
    expect([metrics.width, metrics.height]).toEqual([1024, 1024]);
    for (const paint of [metrics.red, metrics.blue, metrics.brown]) expect(paint.distance).toBeLessThan(12);
    for (const label of metrics.arm) expect([metrics.red.label, metrics.blue.label]).toContain(label);
    expect(metrics.remainingBrown).toBeGreaterThan(500);
    expect(metrics.brownOnArm).toBe(false);
    expect(metrics.fallbackChains).toBe(0);
});
