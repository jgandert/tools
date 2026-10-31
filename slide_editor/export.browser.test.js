/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
const importedMarkdown = "# Imported deck\n\nOriginal source.\n\n---\n\n# Second slide\n\nKeep every asset.\n";
const importedCss = ".slide { color: #123456; }\n";
const binary = Buffer.from([0, 1, 127, 128, 254, 255]);
const assetName = "assets/read me (1),\u65e5\u672c\u8a9e.bin";
let browser;
let server;

beforeAll(async () => {
    const files = new Map([
        ["/one.js", new URL("../one.js", import.meta.url)],
        ["/one.css", new URL("../one.css", import.meta.url)],
        ...["index.html", "md-renderer.js", "zip-reader.js", "asset-loader.js", "app.js"].map(name => [
            `/slide_editor/${name}`, new URL(name, import.meta.url),
        ]),
    ]);
    server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const file = files.get(new URL(request.url).pathname);
            return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

function fixtureZip(extra = []) {
    const files = [
        ["slides.md", Buffer.from(importedMarkdown).toString("base64")],
        ["slides.css", Buffer.from(importedCss).toString("base64")],
        [assetName, binary.toString("base64")],
        ...extra,
    ];
    const result = Bun.spawnSync(["python3", "-c", `
import base64, io, json, sys, zipfile
files = json.load(sys.stdin)
output = io.BytesIO()
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
    for name, content in files:
        archive.writestr(name, base64.b64decode(content))
sys.stdout.buffer.write(output.getvalue())
`], { stdin: Buffer.from(JSON.stringify(files)) });
    expect(result.exitCode).toBe(0);
    return Buffer.from(result.stdout);
}

function readZip(bytes) {
    const result = Bun.spawnSync(["python3", "-c", `
import base64, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    print(json.dumps({entry.filename: {
        "content": base64.b64encode(archive.read(entry)).decode(),
        "method": entry.compress_type,
    } for entry in archive.infolist()}))
`], { stdin: bytes });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}

async function loadTool(page, protocol) {
    const url = protocol === "file" ? new URL("index.html", import.meta.url) : new URL("slide_editor/index.html", server.url);
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.protocol === "file:" || url.origin === server.url.origin ? route.continue() : route.abort();
    });
    await page.goto(url.href);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
}

async function importDeck(page, bytes, name = "Original Deck.zip") {
    await page.locator("#zip-input").setInputFiles({
        name,
        mimeType: "application/zip",
        buffer: bytes,
    });
    await page.waitForFunction(() => document.getElementById("zip-input").value === "" && !document.getElementById("download-zip").disabled);
    expect(await page.locator("#markdown-source").inputValue()).toBe(importedMarkdown);
    expect(await page.locator("#css-source").inputValue()).toBe(importedCss);
}

const exportCases = ["file", "http"].flatMap(protocol => [false, true].map(unavailable => [protocol, unavailable]));

test.each(exportCases)("Slides imports, edits, exports and re-imports over %s, native codecs unavailable=%s", async (protocol, unavailable) => {
    const mobile = protocol === "file";
    const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        colorScheme: mobile ? "dark" : "light",
    });
    try {
        const page = await context.newPage();
        const errors = [];
        const scripts = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            if (request.resourceType() === "script") {
                scripts.push(new URL(request.url()).pathname.split("/").pop());
            }
        });
        if (unavailable) {
            await page.addInitScript(() => {
                window.CompressionStream = undefined;
                window.DecompressionStream = undefined;
            });
        }
        await loadTool(page, protocol);
        await page.clock.install();
        await importDeck(page, fixtureZip());
        if (mobile) {
            await page.locator("label[for=aside-state]").click();
        }
        const markdown = "# Edited deck\n\nLiteral source and caf\u00e9 text.\n";
        const css = "/* Keep this source comment. */\n.slide { color: #654321; }\n";
        await page.locator("#markdown-source").fill(markdown);
        await page.locator("#css-source").fill(css);
        await page.locator("#presentation-name").fill("Edited Deck");
        await page.evaluate(() => {
            window.exportUrls = new Set();
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => {
                const url = create(blob);
                window.exportUrls.add(url);
                return url;
            };
            URL.revokeObjectURL = url => {
                window.exportUrls.delete(url);
                revoke(url);
            };
        });
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("#download-zip").click(),
        ]);
        expect(await download.failure()).toBeNull();
        expect(download.suggestedFilename()).toBe("Edited Deck.zip");
        const bytes = await Bun.file(await download.path()).arrayBuffer();
        const entries = readZip(bytes);
        expect(Object.keys(entries).sort()).toEqual([assetName, "slides.css", "slides.md"]);
        expect(Buffer.from(entries["slides.md"].content, "base64").toString()).toBe(markdown);
        expect(Buffer.from(entries["slides.css"].content, "base64").toString()).toBe(css);
        expect(Buffer.from(entries[assetName].content, "base64")).toEqual(binary);
        expect(Object.values(entries).every(entry => entry.method === 0)).toBe(true);
        await page.clock.fastForward(30_000);
        expect(await page.evaluate(() => window.exportUrls.size)).toBe(0);
        expect(await page.locator("a[download]").count()).toBe(0);
        expect(await page.locator("#download-zip").isEnabled()).toBe(true);
        expect(await page.locator("#content").getAttribute("aria-busy")).toBe("false");
        await page.locator("#zip-input").setInputFiles({
            name: "Edited Deck.zip", mimeType: "application/zip", buffer: Buffer.from(bytes),
        });
        await page.waitForFunction(() => document.getElementById("zip-input").value === "" && !document.getElementById("download-zip").disabled);
        expect(await page.locator("#markdown-source").inputValue()).toBe(markdown);
        expect(await page.locator("#css-source").inputValue()).toBe(css);
        expect(await page.locator("#download-zip").isEnabled()).toBe(true);
        expect(await page.locator("#preview-error").isVisible()).toBe(false);
        expect(scripts).toEqual(["one.js", "md-renderer.js", "zip-reader.js", "asset-loader.js", "app.js"]);
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
}, 20000);

test.each(["nonportable path", "entry limit"])("Slides export rejects %s without losing source or locking controls", async failure => {
    const context = await browser.newContext({ acceptDownloads: true });
    try {
        const page = await context.newPage();
        const downloads = [];
        const errors = [];
        page.on("download", download => downloads.push(download));
        page.on("pageerror", error => errors.push(error.message));
        await loadTool(page, "http");
        const extra = failure === "nonportable path" ? [["assets/a\"b.bin", binary.toString("base64")]] : [];
        await importDeck(page, fixtureZip(extra));
        if (failure === "entry limit") {
            await page.locator("#markdown-source").evaluate(element => {
                element.value = "x".repeat(16 * 1024 * 1024 + 1);
                element.dispatchEvent(new Event("input", { bubbles: true }));
            });
        }
        await page.locator("#download-zip").click();
        await page.waitForFunction(() => document.getElementById("preview-error").textContent.includes("Could not download ZIP:"));
        const message = await page.locator("#preview-error").textContent();
        expect(message).toContain(failure === "entry limit" ? "supported ZIP import limits" : "nonportable");
        expect(downloads).toEqual([]);
        expect(await page.locator("#download-zip").isEnabled()).toBe(true);
        expect(await page.locator("#open-zip").isEnabled()).toBe(true);
        expect(await page.locator("#content").getAttribute("aria-busy")).toBe("false");
        expect(await page.locator("#css-source").inputValue()).toBe(importedCss);
        expect(await page.locator("#markdown-source").evaluate(element => element.value.length)).toBe(
            failure === "entry limit" ? 16 * 1024 * 1024 + 1 : importedMarkdown.length,
        );
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
}, 20000);
