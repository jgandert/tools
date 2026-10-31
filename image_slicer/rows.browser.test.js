/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process, state, els, drawOverlay */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let server;
let browser;
let context;
let page;
let pageErrors;

beforeAll(async () => {
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const pathname = new URL(request.url).pathname;
            const files = {
                "/image_slicer/": new URL("index.html", import.meta.url),
                "/one.js": new URL("../one.js", import.meta.url),
                "/one.css": new URL("../one.css", import.meta.url),
            };
            return files[pathname]
                ? new Response(Bun.file(files[pathname]))
                : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", route => {
        return new URL(route.request().url()).origin === server.url.origin
            ? route.continue()
            : route.abort();
    });
    await page.goto(new URL("image_slicer/", server.url).href);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

function readZipImages(archive) {
    const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(end).toBeGreaterThanOrEqual(0);
    const count = archive.readUInt16LE(end + 10);
    let offset = archive.readUInt32LE(end + 16);
    const images = [];
    for (let i = 0; i < count; i++) {
        expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
        const method = archive.readUInt16LE(offset + 10);
        expect([0, 8]).toContain(method);
        const size = archive.readUInt32LE(offset + 20);
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const local = archive.readUInt32LE(offset + 42);
        const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
        expect(name).toBe(`slice_${String(i + 1).padStart(3, "0")}.png`);
        const content = archive.subarray(start, start + size);
        images.push(Array.from(method === 8 ? inflateRawSync(content) : content));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return images;
}

const cases = [
    { name: "A4 portrait fractional", preset: "a4", width: 100, height: 1000, expectedSlices: 8 },
    { name: "A4 landscape fractional", preset: "a4", orientation: "landscape", width: 100, height: 1000, expectedSlices: 15 },
    { name: "Letter portrait fractional", preset: "letter", width: 100, height: 1000, expectedSlices: 8 },
    { name: "Letter landscape fractional", preset: "letter", orientation: "landscape", width: 100, height: 1000, expectedSlices: 13 },
    { name: "Letter portrait divisible", preset: "letter", width: 17, height: 88, expectedSlices: 4 },
    { name: "Letter landscape divisible", preset: "letter", orientation: "landscape", width: 22, height: 68, expectedSlices: 4 },
    { name: "custom portrait fractional", preset: "custom", customW: 3, customH: 2, width: 101, height: 501, expectedSlices: 8 },
    { name: "custom landscape fractional", preset: "custom", orientation: "landscape", customW: 3, customH: 2, width: 101, height: 501, expectedSlices: 8 },
    { name: "custom portrait divisible", preset: "custom", customW: 2, customH: 3, width: 100, height: 600, expectedSlices: 4 },
    { name: "custom landscape divisible", preset: "custom", orientation: "landscape", customW: 2, customH: 3, width: 100, height: 600, expectedSlices: 4 },
    { name: "A4 subpixel remainder", preset: "a4", width: 100, height: 990, expectedSlices: 8 },
    { name: "A4 one-row source", preset: "a4", width: 100, height: 1, expectedSlices: 1 },
    { name: "custom one-row remainder", preset: "custom", customW: 1, customH: 2, width: 10, height: 41, expectedSlices: 3 },
    { name: "custom subpixel slice height", preset: "custom", customW: 2, customH: 1, width: 1, height: 4, expectedSlices: 4 },
    { name: "A4 STORE fallback", preset: "a4", width: 100, height: 1000, expectedSlices: 8, fallback: true },
];

test.each(cases)("PNG ZIP preserves every source pixel: $name", async settings => {
    const { width, height, preset, orientation = "portrait", customW = 1, customH = 1 } = settings;
    if (settings.fallback) {
        await page.evaluate(() => { window.CompressionStream = undefined; });
    }
    const png = await page.evaluate(({ width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        const data = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 4;
                data.data.set([y & 255, y >> 8, (x * 17 + y * 7) & 255, 255], offset);
            }
        }
        ctx.putImageData(data, 0, 0);
        return canvas.toDataURL("image/png").split(",")[1];
    }, { width, height });
    await page.locator("#preset-select").selectOption(preset);
    await page.locator("#orientation-select").selectOption(orientation);
    if (preset === "custom") {
        await page.locator("#ratio-w").fill(String(customW));
        await page.locator("#ratio-h").fill(String(customH));
    }
    await page.locator("#format-select").selectOption("image/png");
    await page.locator("#file-input").setInputFiles({
        name: "indexed-rows.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
    });
    await page.waitForFunction(() => state.image !== null);
    const { slices, cutRows } = await page.evaluate(() => {
        const ctx = els.overlayCanvas.getContext("2d");
        const originalMoveTo = ctx.moveTo;
        const cutRows = [];
        ctx.moveTo = (x, y) => {
            cutRows.push(y / (els.previewImg.width / state.width));
            originalMoveTo.call(ctx, x, y);
        };
        try {
            drawOverlay();
        } finally {
            ctx.moveTo = originalMoveTo;
        }
        return { slices: state.slices, cutRows };
    });
    expect(slices.length).toBe(settings.expectedSlices);
    expect(cutRows.length).toBe(slices.length - 1);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download-btn").click();
    const download = await downloadPromise;
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    expect(await download.failure()).toBeNull();
    const images = readZipImages(Buffer.concat(chunks));
    expect(images.length).toBe(slices.length);
    expect(await page.locator("#slice-summary").textContent()).toContain(`Total Slices: ${images.length}.`);
    const decoded = await page.evaluate(async ({ images, width }) => {
        let sourceRow = 0;
        const dimensions = [];
        for (const bytes of images) {
            const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            dimensions.push({ width: image.width, height: image.height });
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            image.close();
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let y = 0; y < canvas.height; y++, sourceRow++) {
                for (let x = 0; x < width; x++) {
                    const offset = (y * width + x) * 4;
                    const expected = [sourceRow & 255, sourceRow >> 8, (x * 17 + sourceRow * 7) & 255, 255];
                    if (expected.some((value, channel) => data[offset + channel] !== value)) {
                        return { mismatch: { row: sourceRow, column: x, actual: Array.from(data.slice(offset, offset + 4)), expected } };
                    }
                }
            }
        }
        return { dimensions, sourceRow };
    }, { images, width });
    expect(decoded.mismatch).toBeUndefined();
    expect(decoded.sourceRow).toBe(height);
    let nextRow = 0;
    for (let i = 0; i < slices.length; i++) {
        expect(slices[i].y).toBe(nextRow);
        expect(Number.isInteger(slices[i].h)).toBe(true);
        expect(slices[i].h).toBeGreaterThan(0);
        expect(decoded.dimensions[i]).toEqual({ width, height: slices[i].h });
        nextRow += slices[i].h;
        if (i < cutRows.length) expect(cutRows[i]).toBeCloseTo(nextRow, 6);
    }
    expect(nextRow).toBe(height);
}, 20000);
