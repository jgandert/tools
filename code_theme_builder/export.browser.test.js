/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let browser;
let server;

beforeAll(async () => {
    const files = new Map(["code_theme_builder/index.html", "one.js", "one.css"].map(name => [
        `/${name}`, new URL(`../${name}`, import.meta.url),
    ]));
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

const exportCases = ["file", "http"].flatMap(protocol => ["light", "dark"].flatMap(mode => [false, true].map(fallback => [protocol, mode, fallback])));

test.each(exportCases)("IntelliJ JAR exports complete theme metadata over %s in %s mode, STORE fallback=%s", async (protocol, mode, fallback) => {
    const context = await browser.newContext({ acceptDownloads: true, colorScheme: mode });
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
        await page.route("**/*", route => {
            const url = new URL(route.request().url());
            return url.protocol === "file:" || url.origin === server.url.origin ? route.continue() : route.abort();
        });
        if (fallback) {
            await page.addInitScript(() => {
                window.CompressionStream = undefined;
            });
        }
        const url = protocol === "file" ? new URL("index.html", import.meta.url) : new URL("code_theme_builder/index.html", server.url);
        await page.goto(url.href);
        await page.locator("#custom-theme-title").fill("Winter Blue");
        await page.locator(`#theme-${mode}`).check();
        await page.evaluate(() => {
            window.activeDownloadUrls = new Set();
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => {
                const url = create(blob);
                window.activeDownloadUrls.add(url);
                return url;
            };
            URL.revokeObjectURL = url => {
                window.activeDownloadUrls.delete(url);
                revoke(url);
            };
        });
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("[data-tooltip=\"IntelliJ IDEs\"]").click(),
        ]);
        expect(await download.failure()).toBeNull();
        const slug = `winter-blue-${mode}`;
        expect(download.suggestedFilename()).toBe(`${slug}.ij.theme.jar`);
        const entries = readZip(await Bun.file(await download.path()).arrayBuffer());
        expect(Object.keys(entries).sort()).toEqual([
            "META-INF/MANIFEST.MF", "META-INF/plugin.xml", "META-INF/pluginIcon.svg",
            `theme/${slug}-editor-theme.xml`, `theme/${slug}.theme.json`,
        ]);
        const text = name => Buffer.from(entries[name].content, "base64").toString();
        expect(text("META-INF/MANIFEST.MF")).toBe("Manifest-Version: 1.0\r\nCreated-By: Code Theme Builder\r\n\r\n");
        const theme = JSON.parse(text(`theme/${slug}.theme.json`));
        expect(theme.name).toBe(`Winter Blue ${mode === "light" ? "Light" : "Dark"}`);
        expect(theme.dark).toBe(mode === "dark");
        expect(theme.editorScheme).toBe(`/theme/${slug}-editor-theme.xml`);
        const metadata = await page.evaluate(({ plugin, editor, icon }) => {
            const parser = new DOMParser();
            const docs = [plugin, editor, icon].map(text => parser.parseFromString(text, "application/xml"));
            return {
                invalid: docs.some(doc => doc.querySelector("parsererror")),
                pluginId: docs[0].querySelector("idea-plugin > id").textContent,
                themePath: docs[0].querySelector("themeProvider").getAttribute("path"),
                editorName: docs[1].documentElement.getAttribute("name"),
                iconType: docs[2].documentElement.localName,
            };
        }, {
            plugin: text("META-INF/plugin.xml"),
            editor: text(`theme/${slug}-editor-theme.xml`),
            icon: text("META-INF/pluginIcon.svg"),
        });
        expect(metadata).toEqual({
            invalid: false,
            pluginId: `${slug}-theme`,
            themePath: `/theme/${slug}.theme.json`,
            editorName: `${theme.name} Editor`,
            iconType: "svg",
        });
        const methods = Object.values(entries).map(entry => entry.method);
        expect(methods.every(method => [0, 8].includes(method))).toBe(true);
        expect(methods.includes(8)).toBe(!fallback);
        await page.waitForFunction(() => window.activeDownloadUrls.size === 0);
        expect(await page.locator("a[download]").count()).toBe(0);
        expect(scripts).toEqual(["one.js"]);
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
}, 15000);
