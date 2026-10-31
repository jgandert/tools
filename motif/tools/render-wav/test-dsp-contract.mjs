import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { once } from "node:events";

const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, "http://localhost").pathname;
        if (path === "/") {
            res.end();
            return;
        }
        const resolved = await realpath(path);
        if (!["/motif/", "/renderer/"].some(root => resolved.startsWith(root))) throw new Error("Unknown path");
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(await readFile(resolved));
    } catch {
        res.writeHead(404);
        res.end();
    }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
const results = [];
const prefix = process.argv[2];
assert(/^f7-[a-zA-Z0-9_-]+$/.test(prefix));
await mkdir("/audit/output/audio", { recursive: true });
try {
    browser = await chromium.launch({
        chromiumSandbox: true,
        ignoreDefaultArgs: ["--disable-dev-shm-usage"],
    });
    for (const name of ["phase", "time", "input", "source", "zero", "glide", "stereo", "tie", "feature"]) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const source = `
            Motif.setTempo(120);
            Motif.master({gain: .1, limiter: true});
            const callback = ${name === "time" ? "c => Math.sin(c.t * c.freq * 2 * Math.PI)" : name === "input" || name === "source" || name === "stereo" ? "c => c.i" : name === "zero" ? "c => c.t < .15 ? 0 : Math.sin(c.p * 2 * Math.PI)" : name === "feature" ? "c => Math.abs(Math.sin(c.p * Math.PI * 2)) * 2 - 1" : "c => Math.sin(c.p * 2 * Math.PI)"};
            const track = Track('tone').dsp(callback).freq([null, 440, null, 660]).stepLength(.5);
            if ('${name}' === 'source') track._dspCallback = null;
            if ('${name}' === 'glide') track.freq([null, Ramp(440, 880, .4), null, 660]);
            if ('${name}' === 'tie') track.freq([null, 440, Tie, null]);
            if ('${name}' === 'stereo') {
                const buffer = Motif.ctx.createBuffer(2, 48000, 48000);
                for (let c = 0; c < 2; c++) {
                    const channel = buffer.getChannelData(c);
                    for (let i = 0; i < channel.length; i++) channel[i] = .5 * Math.sin(i / 48000 * (c ? 660 : 440) * 2 * Math.PI);
                }
                Motif.sampleRegistry.set('stereo', buffer);
                track.sample('stereo').note([null, 60, null, 60]);
            }
            Arrange([{tracks: [], bars: .25}, {tracks: [track], bars: 1}, {tracks: [], bars: .25}]);
        `;
        const result = await page.evaluate(async source => {
            globalThis.ended = 0;
            const Original = AudioWorkletNode;
            globalThis.AudioWorkletNode = class extends Original {
                constructor(...args) {
                    super(...args);
                    this.port.addEventListener("message", ({ data }) => {
                        if (data.type === "VOICE_ENDED") globalThis.ended++;
                    });
                    this.port.start();
                }
            };
            const runner = await import("/renderer/offline.mjs");
            await runner.prepare(source, 4 * 48000, 48000);
            await runner.render();
            const channels = [0, 1].map(c => Array.from(renderedAudio.getChannelData(c)));
            return { channels, ended: globalThis.ended };
        }, source);
        assert.deepEqual(errors, [], `${name}: browser errors`);
        const channels = result.channels;
        console.log(name, "ended", result.ended);
        const rate = 48000;
        const delay = (Math.ceil(rate * .005) + 128) / rate;
        const rms = (a, b, c = 0) => {
            const values = channels[c].slice(Math.round((a + delay) * rate), Math.round((b + delay) * rate));
            return Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
        };
        const pitch = (a, b, c = 0) => {
            const values = channels[c].slice(Math.round((a + delay) * rate), Math.round((b + delay) * rate));
            const crossings = [];
            for (let i = 1; i < values.length; i++) if (values[i - 1] < 0 && values[i] >= 0) crossings.push(i - values[i] / (values[i] - values[i - 1]));
            return (crossings.length - 1) * rate / (crossings.at(-1) - crossings[0]);
        };
        assert(rms(.1, .4) < 1e-8 && rms(2.6, 3.5) < 1e-8, `${name}: no audio outside notes`);
        assert(rms(.7, .9) > .025, `${name}: audible output after zero samples`);
        if (name !== "glide") assert(Math.abs(pitch(.7, .9) - (name === "feature" ? 880 : 440)) < 1, `${name}: expected pitch`);
        if (name === "zero") assert(rms(.51, .64) < 1e-8, "zero returns survive before later audible samples");
        if (name === "stereo") assert(Math.abs(pitch(.7, .9, 1) - 660) < 1, "stereo input preserved");
        if (name === "tie") assert(rms(1.1, 1.4) > .05 && rms(1.6, 2.4) < 1e-8, "tie holds then releases all DSP audio");
        else assert(rms(1.1, 1.4) < 1e-8, `${name}: rest is silent`);
        if (name === "glide") assert(Math.abs(pitch(.91, .98) - 880) < 1, "glide reaches target at explicit duration");
        if (name === "phase") globalThis.reference = channels[0];
        if (name === "input") globalThis.inputReference = channels[0];
        if (name === "source") {
            const error = Math.sqrt(channels[0].reduce((sum, x, i) => sum + (x - inputReference[i]) ** 2, 0) / channels[0].length);
            assert(error < .0001, `input passthrough preserves native source waveform: ${error}`);
        }
        if (name !== "source") assert.equal(result.ended, name === "tie" ? 1 : 2, "processor lifetime ends for every scheduled voice");
        if (name === "time") {
            const difference = Math.sqrt(channels[0].reduce((sum, x, i) => sum + (x - reference[i]) ** 2, 0) / channels[0].length);
            assert(difference < .0001, `${name}: expected sine waveform, note-local time/phase ${difference}`);
        }
        const pcm = Buffer.alloc(channels[0].length * 4);
        for (let i = 0; i < channels[0].length; i++) for (let c = 0; c < 2; c++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), (i * 2 + c) * 2);
        const header = Buffer.alloc(44);
        header.write("RIFF");
        header.writeUInt32LE(36 + pcm.length, 4);
        header.write("WAVEfmt ", 8);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(2, 22);
        header.writeUInt32LE(rate, 24);
        header.writeUInt32LE(rate * 4, 28);
        header.writeUInt16LE(4, 32);
        header.writeUInt16LE(16, 34);
        header.write("data", 36);
        header.writeUInt32LE(pcm.length, 40);
        await writeFile(`/audit/output/audio/${prefix}-${name}.wav`, Buffer.concat([header, pcm]), { flag: "wx" });
        results.push({ name, rms: rms(.7, .9), pitch: pitch(.7, .9), ended: result.ended });
        console.log(`${name}: passed`);
        await page.close();
    }
    await writeFile(`/audit/output/${prefix}-checks.json`, JSON.stringify(results, null, 2), { flag: "wx" });
} finally {
    await browser?.close();
    server.close();
    await once(server, "close");
}
