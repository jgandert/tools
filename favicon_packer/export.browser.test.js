import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let server;
let browser;

beforeAll(async () => {
    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const pathname = new URL(request.url).pathname;
            const allowedPaths = ["/favicon_packer/index.html", "/favicon_packer/ico.js", "/one.js", "/one.css"];
            if (!allowedPaths.includes(pathname)) {
                return new Response(null, { status: 404 });
            }
            return new Response(Bun.file(new URL(`..${pathname}`, import.meta.url)));
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
    print(json.dumps({name: base64.b64encode(archive.read(name)).decode() for name in archive.namelist()}))
`], { stdin: bytes });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}

const exportCases = [false, true].flatMap(background => ["http", "file"].flatMap(protocol => [false, true].map(fallback => [background, protocol, fallback])));

test.each(exportCases)("native ZIP contains a decodable 32x32 ICO with background=%j over %s, STORE fallback=%s", async (background, protocol, fallback) => {
    const context = await browser.newContext({ acceptDownloads: true });
    try {
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://**", route => route.abort());
        if (fallback) {
            await page.addInitScript(() => { window.CompressionStream = undefined; });
        }
        const url = protocol === "file" ? new URL("index.html", import.meta.url) : new URL("favicon_packer/index.html", server.url);
        await page.goto(url.href);
        const image = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 32;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ff0000";
            ctx.fillRect(8, 8, 16, 16);
            ctx.fillStyle = "rgba(0, 0, 255, 0.5)";
            ctx.fillRect(2, 2, 4, 4);
            return canvas.toDataURL("image/png").split(",")[1];
        });
        await page.locator("#file-input").setInputFiles({
            name: "transparent.png",
            mimeType: "image/png",
            buffer: Buffer.from(image, "base64"),
        });
        await page.locator("#editor-section").waitFor({ state: "visible" });
        if (background) {
            await page.locator("#cl-mode-bg").check();
        }
        const downloadPromise = page.waitForEvent("download");
        await page.locator("#generate-btn").click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        expect(await download.failure()).toBeNull();
        const entries = readZip(Buffer.concat(chunks));
        expect(Object.keys(entries).sort()).toEqual([
            "apple-touch-icon.png", "favicon-96x96.png", "favicon.ico", "favicon.svg",
            "site.webmanifest", "web-app-manifest-192x192.png", "web-app-manifest-512x512.png",
        ]);

        // Read the container independently of the encoder, then use Chromium's image decoder.
        const ico = Buffer.from(entries["favicon.ico"], "base64");
        expect(ico.readUInt16LE(0)).toBe(0);
        expect(ico.readUInt16LE(2)).toBe(1);
        expect(ico.readUInt16LE(4)).toBe(1);
        expect([...ico.subarray(6, 10)]).toEqual([32, 32, 0, 0]);
        expect(ico.readUInt16LE(10)).toBe(1);
        expect(ico.readUInt16LE(12)).toBe(32);
        const payloadSize = ico.readUInt32LE(14);
        const payloadOffset = ico.readUInt32LE(18);
        expect(payloadOffset).toBe(22);
        expect(payloadOffset + payloadSize).toBe(ico.length);
        expect([...ico.subarray(payloadOffset, payloadOffset + 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

        const decoded = await page.evaluate(async entries => {
            async function decode(base64, type) {
                const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
                const bitmap = await createImageBitmap(new Blob([bytes], { type }));
                const canvas = document.createElement("canvas");
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(bitmap, 0, 0);
                const result = {
                    width: bitmap.width,
                    height: bitmap.height,
                    corner: [...ctx.getImageData(0, 0, 1, 1).data],
                    center: [...ctx.getImageData(16, 16, 1, 1).data],
                    translucent: [...ctx.getImageData(3, 3, 1, 1).data],
                };
                bitmap.close();
                return result;
            }
            return {
                ico: await decode(entries["favicon.ico"], "image/vnd.microsoft.icon"),
                pngs: await Promise.all([
                    "favicon-96x96.png", "apple-touch-icon.png", "web-app-manifest-192x192.png", "web-app-manifest-512x512.png",
                ].map(async name => [name, await decode(entries[name], "image/png")])),
            };
        }, entries);
        expect([decoded.ico.width, decoded.ico.height]).toEqual([32, 32]);
        expect(decoded.ico.center).toEqual([255, 0, 0, 255]);
        expect(decoded.ico.corner).toEqual(background ? [255, 255, 255, 255] : [0, 0, 0, 0]);
        if (!background) {
            expect(decoded.ico.translucent.slice(0, 3)).toEqual([0, 0, 255]);
            expect(decoded.ico.translucent[3]).toBeGreaterThanOrEqual(127);
            expect(decoded.ico.translucent[3]).toBeLessThanOrEqual(128);
        }
        expect(decoded.pngs.map(([name, value]) => [name, value.width, value.height])).toEqual([
            ["favicon-96x96.png", 96, 96], ["apple-touch-icon.png", 180, 180],
            ["web-app-manifest-192x192.png", 192, 192], ["web-app-manifest-512x512.png", 512, 512],
        ]);
        expect(errors).toEqual([]);
    } finally {
        await context.close();
    }
}, 15000);
