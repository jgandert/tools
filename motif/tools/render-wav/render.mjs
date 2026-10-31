import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

const [song, requestedSeconds, requestedTail, requestedRate] = process.argv.slice(2);
const sampleRate = Number(requestedRate);
const tail = Number(requestedTail);
const explicitSeconds = requestedSeconds === "auto" ? null : Number(requestedSeconds);
if (![44100, 48000, 96000].includes(sampleRate)) throw new Error("Sample rate must be 44100, 48000, or 96000.");
if (!Number.isFinite(tail) || tail < 0 || tail > 60) throw new Error("Tail must be between 0 and 60 seconds.");

function frameCount(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 1800) {
        throw new Error("Render duration must be greater than zero and at most 1800 seconds.");
    }
    return Math.ceil(seconds * sampleRate);
}

if (explicitSeconds !== null) frameCount(explicitSeconds);
if (!song || path.basename(song) !== song) throw new Error("Expected a song filename.");
const source = await readFile(path.join("/song", song), "utf8");
const browserErrors = [];

// Serve only the engine, renderer, and song directory on container loopback.

const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        if (pathname === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (pathname === `/song/${song}`) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end();
            return;
        }
        const root = ["/motif/", "/song/", "/renderer/"].find(prefix => pathname.startsWith(prefix));
        if (!root) throw new Error("Unknown path");
        const resolved = await realpath(pathname);
        if (!resolved.startsWith(root)) throw new Error("Path escapes served directory");
        const data = await readFile(resolved);
        res.writeHead(200, { "Content-Type": /\.(m?js)$/.test(resolved) ? "text/javascript" : "application/octet-stream" });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
    browser = await chromium.launch({
        chromiumSandbox: true,
        ignoreDefaultArgs: ["--disable-dev-shm-usage"],
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function prepare(frames) {
        const page = await browser.newPage({ serviceWorkers: "block" });
        page.on("pageerror", error => browserErrors.push(error.message));
        page.on("console", message => {
            console.error(`[browser ${message.type()}] ${message.text()}`);
            if (message.type() === "error") browserErrors.push(message.text());
        });
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin === base) return route.continue();
            browserErrors.push(`Blocked external request: ${route.request().url()}`);
            return route.abort();
        });
        await page.goto(`${base}/song/${encodeURIComponent(song)}`);
        const duration = await page.evaluate(async ({ source, frames, sampleRate }) => {
            const runner = await import("/renderer/offline.mjs");
            return runner.prepare(source, frames, sampleRate);
        }, { source, frames, sampleRate });
        return { page, duration };
    }

    let seconds = explicitSeconds;
    if (seconds === null) {
        const probe = await prepare(1);
        seconds = await probe.page.evaluate(async () => (await import("/renderer/offline.mjs")).inferDuration());
        await probe.page.close();
        if (seconds === null) throw new Error("Cannot infer duration. Add Arrange() or pass --seconds N.");
        seconds += tail;
    }
    const { page } = await prepare(frameCount(seconds));
    if (browserErrors.length) throw new Error(browserErrors.join("\n"));
    console.error(`Rendering ${seconds.toFixed(3)} seconds at ${sampleRate} Hz...`);
    const result = await page.evaluate(async () => (await import("/renderer/offline.mjs")).render());
    if (browserErrors.length) throw new Error(browserErrors.join("\n"));

    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + result.frames * 4, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(result.frames * 4, 40);

    async function write(bytes) {
        if (!process.stdout.write(bytes)) await once(process.stdout, "drain");
    }

    await write(header);
    let peak = 0;
    let clipped = 0;
    for (let start = 0; start < result.frames; start += 16384) {
        const chunk = await page.evaluate(async ({ start, count }) => {
            return (await import("/renderer/offline.mjs")).pcmChunk(start, count);
        }, { start, count: Math.min(16384, result.frames - start) });
        peak = Math.max(peak, chunk.peak);
        clipped += chunk.clipped;
        await write(Buffer.from(chunk.data, "base64"));
    }
    console.error(`Peak: ${peak.toFixed(4)}; clipped samples: ${clipped}.`);
    if (peak === 0) console.error("Warning: rendered audio is silent.");
} finally {
    try {
        if (browser) await browser.close();
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
