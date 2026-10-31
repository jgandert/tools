/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Buffer, process */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let browser;
let context;
let page;
let errors;
let externalRequests;
const toolURL = new URL("../index.html", import.meta.url).href;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    errors = [];
    externalRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (/^https?:/.test(request.url())) {
            externalRequests.push(request.url());
        }
    });
    await page.goto(toolURL);
});

afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
});

async function uploadPNG(name = "test-art.png") {
    const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = 60;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 80, 60);
        ctx.fillStyle = "#008c95";
        ctx.fillRect(10, 10, 50, 30);
        return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#file").setInputFiles({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
    });
    await page.waitForFunction(() => !document.getElementById("trace").disabled);
}

async function trace() {
    await page.locator("#trace").click();
    await page.waitForFunction(() => !document.getElementById("download").hidden);
    await page.locator("#preview").evaluate(image => image.decode());
}

test("file URL traces in a worker, preserves export dimensions, and invalidates changed options", async () => {
    await page.locator("#source-options details").evaluate(details => {
        details.open = true;
    });
    await page.locator("#example").click();
    await page.waitForFunction(() => !document.getElementById("trace").disabled);
    await page.locator("#max-size").fill("96");
    await page.locator("#max-size").blur();
    await trace();
    expect(await page.locator("#preview").evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([480, 320]);
    expect(await page.locator("#source").evaluate(canvas => [canvas.width, canvas.height])).toEqual([96, 64]);
    const sourceBounds = await page.locator("#source").boundingBox();
    const resultBounds = await page.locator("#preview").boundingBox();
    expect(sourceBounds.width).toBeCloseTo(resultBounds.width, 0);
    expect(sourceBounds.height).toBeCloseTo(resultBounds.height, 0);
    expect(await page.locator("#content").getAttribute("aria-busy")).toBe("false");
    expect(await page.locator("#options").isDisabled()).toBe(false);
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
    expect(download.suggestedFilename()).toBe("circle-triangle-example.svg");
    const svg = await page.locator("#download").evaluate(async link => (await fetch(link.href)).text());
    expect(svg).toContain("width=\"480\" height=\"320\" viewBox=\"0 0 96 64\"");
    expect(await page.locator("#svg-text").inputValue()).toBe(svg);
    await page.locator("#colors").fill("4");
    expect(await page.locator("#download").isVisible()).toBe(false);
    expect(await page.locator("#preview").isVisible()).toBe(false);
    expect(await page.locator("#svg-text").inputValue()).toBe("");
    await page.locator("#tolerance").fill("0");
    expect(await page.locator("#trace").isDisabled()).toBe(true);
    await page.locator("#tolerance").fill("1.25");
    expect(await page.locator("#trace").isEnabled()).toBe(true);
});

test("failed imports keep the previous image and result, including repeated file selection", async () => {
    await uploadPNG();
    await trace();
    const previous = await page.locator("#svg-text").inputValue();
    for (const file of [
        {
            name: "vector.svg",
            mimeType: "image/svg+xml",
            buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
        },
        { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
    ]) {
        await page.locator("#file").setInputFiles(file);
        await page.waitForFunction(() => !document.getElementById("error").hidden && document.getElementById("content").getAttribute("aria-busy") === "false");
        expect(await page.locator("#svg-text").inputValue()).toBe(previous);
        expect(await page.locator("#download").isVisible()).toBe(true);
        expect(await page.locator("#trace").isEnabled()).toBe(true);
    }
    await uploadPNG();
    expect(await page.locator("#error").isVisible()).toBe(false);
    expect(await page.locator("#download").isVisible()).toBe(false);
});

test("cancel and blocked workers restore controls without publishing stale results", async () => {
    await uploadPNG();
    await page.evaluate(() => {
        const button = document.getElementById("trace");
        button.click();
        if (document.getElementById("content").getAttribute("aria-busy") !== "true") {
            throw Error("Missing busy state");
        }
        if (!document.getElementById("options").disabled) {
            throw Error("Options were not disabled");
        }
        document.getElementById("cancel").click();
    });
    expect(await page.locator("#download").isVisible()).toBe(false);
    expect(await page.locator("#trace").isEnabled()).toBe(true);
    expect(await page.locator("#options").isDisabled()).toBe(false);
    await page.evaluate(() => {
        window.Worker = class {
            constructor() {
                throw Error("Workers blocked by browser policy");
            }
        };
    });
    await page.locator("#trace").click();
    expect(await page.locator("#error").textContent()).toContain("Workers blocked");
    expect(await page.locator("#trace").isEnabled()).toBe(true);
    expect(await page.locator("#progress").isVisible()).toBe(false);
    expect(await page.locator("#content").getAttribute("aria-busy")).toBe("false");
});

test.each(["light", "dark"])("%s layout fits wide, narrow, and zoom-sized viewports with visible results", async colorScheme => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await uploadPNG("a-very-long-source-image-name-that-should-wrap-without-expanding-the-page.png");
    await trace();
    await page.locator("#stats-details, #svg-details").evaluateAll(panels => {
        for (const panel of panels) {
            panel.open = true;
        }
    });
    const colors = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
    expect(colors[0]).not.toBe(colors[1]);
    for (const width of [1440, 900, 720, 375, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const preview = await page.locator("#preview").boundingBox();
        expect(preview.x + preview.width).toBeLessThanOrEqual(width);
        const save = await page.locator("#download").boundingBox();
        expect(save.x + save.width).toBeLessThanOrEqual(width);
        if (await page.locator("#aside-state").isChecked() !== (width < 900)) {
            await page.locator("#aside-state").press("Space");
        }
        await page.waitForFunction(() => {
            const bounds = document.querySelector("aside").getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth;
        });
        const aside = await page.locator("aside").boundingBox();
        expect(aside.x).toBeGreaterThanOrEqual(0);
        expect(aside.x + aside.width).toBeLessThanOrEqual(width);
    }
    await page.locator("#min-area").focus();
    await page.keyboard.press("Escape");
    expect(await page.locator("#aside-state").isChecked()).toBe(false);
    expect(await page.locator("#aside-state").evaluate(input => input === document.activeElement)).toBe(true);
    await page.keyboard.press("Space");
    expect(await page.locator("#aside-state").isChecked()).toBe(true);
});

test("shape sampler and image decoding fallback remain usable without browser permissions", async () => {
    await page.evaluate(() => {
        window.createImageBitmap = undefined;
    });
    await page.locator("#source-options details").evaluate(details => {
        details.open = true;
    });
    await page.locator("#shape-example").click();
    await page.waitForFunction(() => !document.getElementById("trace").disabled);
    await page.locator("#max-size").fill("160");
    await page.locator("#max-size").blur();
    await trace();
    expect(await page.locator("#preview").evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([640, 400]);
});
