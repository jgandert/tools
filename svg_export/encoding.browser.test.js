/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process, formatsReady, formatInput, canvas, processFileToBlob, handleFiles, zipToggle */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
const toolUrl = new URL("index.html", import.meta.url).href;
const svgText = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><rect width=\"32\" height=\"32\" fill=\"red\"/></svg>";

let browser;
let context;
let page;
let pageErrors;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await loadTool();
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
});

async function loadTool() {
    await page.goto(toolUrl);
    await page.waitForFunction(() => formatsReady);
    await page.locator("#width-input").fill("32");
    await page.locator("#height-input").fill("32");
}

async function readDownload(download) {
    const chunks = [];
    for await (const chunk of await download.createReadStream()) {
        chunks.push(chunk);
    }
    expect(await download.failure()).toBeNull();
    return Buffer.concat(chunks);
}

function readZipEntries(archive) {
    const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(end).toBeGreaterThanOrEqual(0);
    const count = archive.readUInt16LE(end + 10);
    let offset = archive.readUInt32LE(end + 16);
    const entries = [];
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
        const content = archive.subarray(start, start + size);
        entries.push({
            name: archive.subarray(offset + 46, offset + 46 + nameLength).toString(),
            bytes: method === 8 ? inflateRawSync(content) : content,
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

async function expectImage(bytes, format) {
    if (format === "png") {
        expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    } else if (format === "jpeg") {
        expect(Array.from(bytes.subarray(0, 3))).toEqual([255, 216, 255]);
    } else if (format === "webp") {
        expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
    }
    const dimensions = await page.evaluate(async ({ bytes, format }) => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: `image/${format}` }));
        const result = [image.width, image.height];
        image.close();
        return result;
    }, { bytes: Array.from(bytes), format });
    expect(dimensions).toEqual([32, 32]);
}

const nativeCases = ["png", "jpeg", "webp"].flatMap(format => [false, true].map(zip => [format, zip, false]));
nativeCases.push(["png", true, true]);

test.each(nativeCases)("native %s downloads have correct bytes and names, ZIP=%s, STORE fallback=%s", async (format, zip, fallback) => {
    if (fallback) {
        await page.evaluate(() => {
            window.CompressionStream = undefined;
        });
    }
    await page.locator("#format-input").selectOption(format);
    await page.locator("#zip-toggle").setChecked(zip);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#file-input").setInputFiles((zip ? ["first", "second"] : ["first"]).map(name => ({
        name: `${name}.svg`,
        mimeType: "image/svg+xml",
        buffer: Buffer.from(svgText),
    })));
    const download = await downloadPromise;
    const bytes = await readDownload(download);
    const extension = format === "jpeg" ? "jpg" : format;
    if (zip) {
        expect(download.suggestedFilename()).toMatch(/^converted_svgs_\d{4}-\d{2}-\d{2}\.zip$/);
        const entries = readZipEntries(bytes);
        expect(entries.map(entry => entry.name)).toEqual([`first_32x32.${extension}`, `second_32x32.${extension}`]);
        for (const entry of entries) {
            await expectImage(entry.bytes, format);
        }
    } else {
        expect(download.suggestedFilename()).toBe(`first_32x32.${extension}`);
        await expectImage(bytes, format);
    }
    await page.waitForFunction(() => !document.getElementById("action-btn").disabled);
    expect(await page.locator("#file-input").inputValue()).toBe("");
});

test("format options follow native canvas encoding support, including optional encoders", async () => {
    const formats = await page.evaluate(async () => {
        const probe = document.createElement("canvas");
        probe.width = 2;
        probe.height = 2;
        const results = [];
        for (const option of formatInput.options) {
            const type = await new Promise(resolve => probe.toBlob(blob => resolve(blob?.type), `image/${option.value}`));
            results.push({ value: option.value, disabled: option.disabled, type });
        }
        return results;
    });
    for (const format of formats) {
        expect(format.disabled).toBe(format.type !== `image/${format.value}`);
        if (!format.disabled) {
            expect(await page.locator("#format-support").textContent()).toContain(
                format.value === "jpeg" ? "JPG" : format.value === "webp" ? "WebP" : format.value.toUpperCase(),
            );
        }
    }
});

test.each(["heic", "avif"])("stored unsupported %s selection is replaced with PNG", async format => {
    await page.addInitScript(format => localStorage.setItem("svg_fmt", format), format);
    await page.reload();
    await page.waitForFunction(() => formatsReady);
    const unavailable = await page.locator(`#format-input option[value="${format}"]`).evaluate(option => option.disabled);
    expect(await page.locator("#format-input").inputValue()).toBe(unavailable ? "png" : format);
    expect(await page.evaluate(() => localStorage.getItem("svg_fmt"))).toBe(unavailable ? "png" : format);
});

test.each(["heic", "avif"])("an available optional %s encoder stays selectable and returns its requested MIME", async format => {
    await page.addInitScript(format => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
            if (type === `image/${format}`) {
                queueMicrotask(() => callback(new Blob(["modeled optional encoder output"], { type })));
                return;
            }
            original.call(this, callback, type, quality);
        };
    }, format);
    await loadTool();
    expect(await page.locator(`#format-input option[value="${format}"]`).evaluate(option => option.disabled)).toBe(false);
    await page.locator("#format-input").selectOption(format);
    const result = await page.evaluate(async svgText => {
        const result = await processFileToBlob(new File([svgText], "icon.svg", { type: "image/svg+xml" }));
        return { name: result.name, type: result.content.type };
    }, svgText);
    expect(result).toEqual({ name: `icon_32x32.${format}`, type: `image/${format}` });
});

test.each(["null", "throw"])("an optional encoder with %s probe output is disabled", async failure => {
    await page.addInitScript(failure => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
            if (type === "image/heic" || type === "image/avif") {
                if (failure === "throw") throw new Error("Encoder unavailable");
                queueMicrotask(() => callback(null));
                return;
            }
            original.call(this, callback, type, quality);
        };
    }, failure);
    await loadTool();
    for (const format of ["heic", "avif"]) {
        expect(await page.locator(`#format-input option[value="${format}"]`).evaluate(option => option.disabled)).toBe(true);
    }
    expect(await page.locator("#action-btn").isEnabled()).toBe(true);
});

const failureCases = ["mismatch", "null", "throw", "unsupported"].flatMap(failure => [false, true].map(zip => [failure, zip]));

test.each(["unsafe", "duplicate"])("ZIP %s filenames prevent download and restore controls/resources", async failure => {
    const downloads = [];
    page.on("download", download => downloads.push(download));
    const remainingUrls = await page.evaluate(async ({ failure, svgText }) => {
        const active = new Set();
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            const url = create(blob);
            active.add(url);
            return url;
        };
        URL.revokeObjectURL = url => {
            active.delete(url);
            revoke(url);
        };
        zipToggle.checked = true;
        const names = failure === "unsafe" ? ["unsafe:name.svg"] : ["same.svg", "same.svg"];
        try {
            await handleFiles(names.map(name => new File([svgText], name, { type: "image/svg+xml" })));
            return active.size;
        } finally {
            URL.createObjectURL = create;
            URL.revokeObjectURL = revoke;
        }
    }, { failure, svgText });
    expect(downloads).toEqual([]);
    expect(remainingUrls).toBe(0);
    expect(await page.locator("#action-btn").isEnabled()).toBe(true);
    expect(await page.locator("#action-btn").textContent()).toContain("Select SVGs & Download");
    expect(await page.locator("#file-input").inputValue()).toBe("");
    expect(await page.locator(".toast-error").textContent()).toContain(failure === "unsafe" ? "Unsafe entry path" : "Duplicate entry");
});

test.each(failureCases)("%s encoding failure prevents download and restores UI/resources, ZIP=%s", async (failure, zip) => {
    const downloads = [];
    page.on("download", download => downloads.push(download));
    const state = await page.evaluate(async ({ failure, zip, svgText }) => {
        const created = new Set();
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = blob => {
            const url = originalCreate(blob);
            created.add(url);
            return url;
        };
        URL.revokeObjectURL = url => {
            created.delete(url);
            originalRevoke(url);
        };
        zipToggle.checked = zip;
        formatInput.value = failure === "unsupported" ? "heic" : "webp";
        const originalToBlob = canvas.toBlob;
        if (failure !== "unsupported") {
            canvas.toBlob = callback => {
                if (failure === "throw") throw new Error("Encoder failed");
                queueMicrotask(() => callback(failure === "null" ? null : new Blob(["PNG fallback"], { type: "image/png" })));
            };
        }
        try {
            await handleFiles([new File([svgText], "icon.svg", { type: "image/svg+xml" })]);
            return {
                activeUrls: created.size,
                buttonDisabled: document.getElementById("action-btn").disabled,
                buttonText: document.getElementById("action-btn").textContent,
                fileValue: document.getElementById("file-input").value,
            };
        } finally {
            canvas.toBlob = originalToBlob;
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
        }
    }, { failure, zip, svgText });
    expect(downloads).toEqual([]);
    expect(state.activeUrls).toBe(0);
    expect(state.buttonDisabled).toBe(failure === "unsupported");
    expect(state.buttonText).toContain("Select SVGs & Download");
    expect(state.fileValue).toBe("");
    const message = await page.locator(".toast-error").textContent();
    if (failure === "throw") {
        expect(message).toBe("Encoder failed");
    } else {
        expect(message).toContain(failure === "unsupported" ? "HEIC" : "WEBP");
        expect(message).toContain("PNG, JPG, WebP");
        expect(message).toContain(failure === "null" ? "smaller dimensions" : "Choose a supported output format");
    }
});

test.each([[375, "light"], [1280, "dark"]])("supported-format guidance stays visible at %s px in %s mode", async (width, colorScheme) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const geometry = await page.locator("#format-support").evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            width: element.clientWidth,
            contentWidth: element.scrollWidth,
        };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
    await page.locator("#format-input").focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    expect(await page.locator("#format-input").inputValue()).toBe("jpeg");
});
