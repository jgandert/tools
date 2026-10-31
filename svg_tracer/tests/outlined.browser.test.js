/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global process */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { makeOutlinedArtwork } from "./outlined-artwork.js";
import { makeJunctionArtwork } from "./junction-artwork.js";
import { measureOutlinedTrace } from "./outline-metrics.js";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
let browser;
let page;
const measurements = [];

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(new URL("../index.html", import.meta.url).href);
    await page.addScriptTag({ content: `window.makeOutlinedArtwork = ${makeOutlinedArtwork}; window.makeJunctionArtwork = ${makeJunctionArtwork}; window.measureOutlinedTrace = ${measureOutlinedTrace};` });
});

afterAll(async () => {
    await browser?.close();
});

const cases = Array.from({ length: 96 }, (_, index) => {
    const seed = index + 1;
    const format = seed % 3 === 0 ? "jpeg" : "png";
    return {
        seed,
        format,
        background: format === "png" && seed % 4 === 0 ? "transparent" : "white",
    };
});

test.each(cases)("complex outlined $format artwork, seed $seed", async config => {
    const result = await page.evaluate(async config => {
        const artwork = await window.makeOutlinedArtwork(config);
        const input = {
            width: artwork.width,
            height: artwork.height,
            data: new Uint8ClampedArray(artwork.data),
        };
        const result = window.FlatLogoTracer.trace(input);
        const metrics = await window.measureOutlinedTrace({ artwork, result });
        return { metrics, stats: result.stats, junctions: artwork.junctions.length };
    }, config);
    const { metrics, stats } = result;
    measurements.push(metrics);
    const context = JSON.stringify({ config, metrics });
    expect(result.junctions, context).toBeGreaterThan(0);
    expect(metrics.junctionPixels, context).toBeGreaterThan(100);
    expect(metrics.outlinePixels, context).toBeGreaterThan(200);
    expect(stats.colors, context).toBe(config.background === "transparent" ? 4 : 5);
    expect(stats.validation, context).toStartWith("passed");
    const jpeg = config.format === "jpeg";
    expect(metrics.error, context).toBeLessThan(jpeg ? 2.4 : 1.45);
    expect(metrics.edgeError, context).toBeLessThan(jpeg ? 19.5 : 17.5);
    expect(metrics.junctionError, context).toBeLessThan(jpeg ? 15 : 11);
    expect(metrics.displayError, context).toBeLessThan(jpeg ? 2.6 : 1.8);
    expect(metrics.darkBackgroundError, context).toBeLessThan(jpeg ? 2.6 : 1.8);
    expect(metrics.missingOutline, context).toBeLessThan(.01);
    expect(metrics.outlineMassError, context).toBeLessThan(.13);
    expect(metrics.worstJunctionMissingOutline, context).toBeLessThan(.03);
    expect(metrics.worstJunctionMassError, context).toBeLessThan(.3);
});

test("the outlined corpus retains its aggregate edge and intersection fidelity", () => {
    expect(measurements.length).toBe(cases.length);
    const mean = key => measurements.reduce((sum, metrics) => sum + metrics[key], 0) / measurements.length;
    expect(mean("error")).toBeLessThan(1.2);
    expect(mean("edgeError")).toBeLessThan(12);
    expect(mean("junctionError")).toBeLessThan(8.4);
});

const junctionCases = ["acute", "obtuse", "shared", "tangent"].flatMap(kind =>
    Array.from({ length: 16 }, (_, index) => ({
        kind,
        seed: index + 1,
        rotation: index * Math.PI / 8,
        format: index % 3 === 0 ? "jpeg" : "png",
    })),
);

test.each(junctionCases)("$kind outline contact, angle seed $seed ($format)", async config => {
    const { metrics, stats, junctions } = await page.evaluate(async config => {
        const artwork = await window.makeJunctionArtwork(config);
        const result = window.FlatLogoTracer.trace({
            width: artwork.width,
            height: artwork.height,
            data: new Uint8ClampedArray(artwork.data),
        });
        const metrics = await window.measureOutlinedTrace({ artwork, result });
        return { metrics, stats: result.stats, junctions: artwork.junctions.length };
    }, config);
    const context = JSON.stringify({ config, metrics });
    expect(stats.colors, context).toBe(4);
    expect(stats.validation, context).toStartWith("passed");
    expect(metrics.error, context).toBeLessThan(config.format === "jpeg" ? 1.8 : 1.4);
    expect(metrics.edgeError, context).toBeLessThan(config.format === "jpeg" ? 20.5 : 18);
    expect(metrics.missingOutline, context).toBeLessThan(.01);
    expect(metrics.outlineMassError, context).toBeLessThan(.15);
    if (config.kind === "tangent") {
        expect(junctions, context).toBe(0);
        expect(metrics.gapPoints, context).toBeGreaterThan(0);
        expect(metrics.gapRetention, context).toBeGreaterThan(.6);
    } else {
        expect(junctions, context).toBeGreaterThan(0);
        expect(metrics.junctionPixels, context).toBeGreaterThan(100);
        expect(metrics.junctionError, context).toBeLessThan(config.format === "jpeg" ? 17.5 : 16);
        expect(metrics.worstJunctionMissingOutline, context).toBeLessThan(.03);
        expect(metrics.worstJunctionMassError, context).toBeLessThan(.3);
    }
});

test.each(["#d520b7", "#172238"])("short one-pixel %s marks survive automatic paint recovery", async paint => {
    const { stats, pixel } = await page.evaluate(async paint => {
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = 60;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, 80, 60);
        ctx.fillStyle = paint;
        ctx.fillRect(20, 30, 20, 1);
        const result = window.FlatLogoTracer.trace(ctx.getImageData(0, 0, 80, 60));
        const image = new Image();
        image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
        await image.decode();
        ctx.clearRect(0, 0, 80, 60);
        ctx.drawImage(image, 0, 0);
        return { stats: result.stats, pixel: Array.from(ctx.getImageData(30, 30, 1, 1).data) };
    }, paint);
    expect(stats.colors).toBe(2);
    expect(stats.palette).toContain(paint);
    expect(pixel).toEqual([...[1, 3, 5].map(i => parseInt(paint.slice(i, i + 2), 16)), 255]);
});
