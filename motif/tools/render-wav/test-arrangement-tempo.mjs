import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { once } from "node:events";

// Run in the renderer container with the engine mounts used by render_wav.py.
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;
        if (pathname === "/") {
            res.end();
            return;
        }
        const resolved = await realpath(pathname);
        if (!["/motif/", "/renderer/"].some(root => resolved.startsWith(root))) throw new Error("Unknown path");
        let data = await readFile(resolved);
        if (url.searchParams.has("fault") && resolved.endsWith("/MasterLimiterProcessor.js")) {
            data = data.toString().replace("const input = inputs[0];", "throw new Error(\"test processor failure\");");
        }
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await mkdir("/audit/output/audio", { recursive: true });
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
const results = [];
try {
    browser = await chromium.launch({
        chromiumSandbox: true,
        ignoreDefaultArgs: ["--disable-dev-shm-usage"],
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ["constant", "immediate", "smooth"]) {
        const source = `
            Motif.setTempo(120);
            const a = Track('tempo-a').synth('sine').note([60, 61, 62, 63]).gain(Ramp(0.05, 0.1));
            const b = Track('tempo-b').synth('sine').note([64, 65, 66, 67]).gain(0.05);
            a.gain(Ramp(0.1, 0.05));
            globalThis.onsets = [];
            globalThis.change = null;
            for (const track of [a, b]) {
                const play = track._playEvent.bind(track);
                track._playEvent = (event, time, duration) => {
                    globalThis.onsetOrigin ??= track._playbackStartTime;
                    onsets.push({ id: track.id, time, duration });
                    play(event, time, duration);
                };
            }
            Arrange([{ tracks: [a], bars: .5 }, { tracks: [b], bars: .5 }, { tracks: [a], bars: .5 }, { tracks: [], bars: .5 }]);
            if ('${mode}' !== 'constant') Motif.schedule(Motif.ctx.currentTime + .4, () => {
                globalThis.change = Motif._tempoChangeTime();
                if ('${mode}' === 'smooth') Motif.rampTempo(60, 2, { smooth: true });
                else Motif.setTempo(60);
            });
        `;
        let inferred;
        for (const kind of ["probe", "offline", "real-time"]) {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", error => errors.push(error.message));
            page.on("console", message => {
                if (message.type() === "error") errors.push(message.text());
            });
            await page.goto(base);
            const result = await page.evaluate(async ({ source, kind, inferred }) => {
                if (kind === "probe" || kind === "offline") {
                    const runner = await import("/renderer/offline.mjs");
                    await runner.prepare(source, kind === "probe" ? 1 : Math.ceil((inferred + .3) * 48000), 48000);
                    if (kind === "probe") return { duration: await runner.inferDuration() };
                    await runner.render();
                    const audio = globalThis.renderedAudio.getChannelData(0);
                    let peak = 0;
                    for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
                    return {
                        onsets,
                        origin: onsetOrigin,
                        change,
                        duration: Motif._arrangementDuration(),
                        peak,
                        pcm: runner.pcmChunk(0, audio.length).data,
                        frames: audio.length,
                    };
                }
                const motif = await import("/motif/motif.js");
                Object.assign(globalThis, motif);
                Motif.init();
                await new Function(source)();
                await Motif.ctx.resume();
                const finished = new Promise(resolve => {
                    Motif.onPlaybackFinished = () => resolve(Motif.ctx.currentTime);
                });
                await Motif.start();
                const stopTime = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("Transport did not finish")), 12000))]);
                await Motif.ctx.close();
                return { onsets, origin: onsetOrigin, change, stopTime };
            }, { source, kind, inferred });
            assert.deepEqual(errors, [], `${mode} ${kind}: no browser errors`);
            if (kind === "probe") inferred = result.duration;
            else {
                const c = result.change === null ? null : result.change - result.origin;
                const timeAt = beat => {
                    if (c === null || beat <= c * 2) return beat / 2;
                    const after = beat - c * 2;
                    if (mode === "immediate") return c + after;
                    return after <= 3 ? c + 2 * (2 - Math.sqrt(4 - after)) : c + 2 + after - 3;
                };
                assert.equal(result.onsets.length, 6, `${mode} ${kind}: active steps`);
                for (let beat = 0; beat < 6; beat++) {
                    assert(Math.abs(result.onsets[beat].time - result.origin - timeAt(beat)) < 1e-7, `${mode} ${kind}: beat ${beat}`);
                    assert.equal(result.onsets[beat].id, beat >= 2 && beat < 4 ? "tempo-b" : "tempo-a");
                }
                if (kind === "offline") {
                    assert(result.peak > .001, "real rendered audio is nonzero");
                    assert(Math.abs(result.duration - timeAt(8)) < 1e-7, "offline final boundary follows the tempo map");
                    assert(Math.abs(result.duration - inferred) < 1e-7, "probe duration includes scheduled tempo callback");
                    const pcm = Buffer.from(result.pcm, "base64");
                    const header = Buffer.alloc(44);
                    header.write("RIFF");
                    header.writeUInt32LE(36 + pcm.length, 4);
                    header.write("WAVEfmt ", 8);
                    header.writeUInt32LE(16, 16);
                    header.writeUInt16LE(1, 20);
                    header.writeUInt16LE(2, 22);
                    header.writeUInt32LE(48000, 24);
                    header.writeUInt32LE(192000, 28);
                    header.writeUInt16LE(4, 32);
                    header.writeUInt16LE(16, 34);
                    header.write("data", 36);
                    header.writeUInt32LE(pcm.length, 40);
                    await writeFile(`/audit/output/audio/arrangement-tempo-${mode}.wav`, Buffer.concat([header, pcm]));
                    delete result.pcm;
                } else {
                    const error = result.stopTime - result.origin - timeAt(8);
                    assert(error >= -1e-7 && error < .08, `real-time final stop error ${error}`);
                }
            }
            results.push({ mode, kind, ...result });
            console.log(`${mode} ${kind}: passed`);
            await page.close();
        }
    }
    await writeFile("/audit/output/arrangement-tempo-checks.json", JSON.stringify(results, null, 2));
} finally {
    await browser?.close();
    server.close();
    await once(server, "close");
}
