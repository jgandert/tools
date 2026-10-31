import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/') { res.end(); return; }
        const resolved = await realpath(path);
        if (!['/motif/', '/renderer/'].some(root => resolved.startsWith(root))) throw new Error('Unknown path');
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(await readFile(resolved));
    } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
const results = [];
const prefix = process.argv[2] || 'f4';
assert(/^f4(?:-[a-zA-Z0-9_-]+)?$/.test(prefix), 'Use an f4 prefix');
await mkdir('/audit/output/audio', { recursive: true });
try {
    browser = await chromium.launch({ chromiumSandbox: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'] });
    for (const kind of ['offline', 'real-time']) {
        for (const window of [.03, .1, .8]) {
            for (const policy of ['oldest', 'quietest']) {
                for (const faulty of [false, ...(window === .1 && policy === 'oldest' ? [true] : [])]) {
                    const page = await browser.newPage();
                    const errors = [];
                    page.on('pageerror', error => errors.push(error.message));
                    await page.goto(`http://127.0.0.1:${server.address().port}`);
                    const result = await page.evaluate(async ({ kind, window, policy, faulty }) => {
                        const source = `
                            Motif.setTempo(120);
                            Motif.lookaheadWindowS = ${window};
                            Motif.lookaheadIntervalMs = 10;
                            Motif.master({ gain: .1, limiter: true });
                            globalThis.tone = Track('tone').synth('sine').freq([440, 660]).stepLength(.5)
                                .envelope({ attack: .001, decay: .001, sustain: 1, release: .1 }).voices(1, '${policy}');
                            ${faulty ? `tone._stealVoice = function(mode, time) {
                                const voice = [...this._activeVoices.values()].find(v => Math.abs(v.startTime - time) >= 1e-6);
                                if (!voice) return;
                                voice.oscillator.stop(Motif.ctx.currentTime);
                                voice.oscillator.disconnect(); voice.gainNode.disconnect();
                                for (const [key, value] of this._activeVoices) if (value === voice) this._activeVoices.delete(key);
                            };` : ''}
                        `;
                        let audio;
                        if (kind === 'offline') {
                            const runner = await import('/renderer/offline.mjs');
                            await runner.prepare(source, 96000, 48000);
                            await runner.render();
                            audio = renderedAudio.getChannelData(0);
                        } else {
                            Object.assign(globalThis, await import('/motif/motif.js'));
                            Motif.init();
                            await new Function(source)();
                            await Motif._masterLimiterReady;
                            await Motif.ctx.resume();
                            const chunks = [];
                            const capture = Motif.ctx.createScriptProcessor(1024, 2, 2);
                            capture.onaudioprocess = event => chunks.push(Float32Array.from(event.inputBuffer.getChannelData(0)));
                            Motif.masterLimiter.connect(capture);
                            capture.connect(Motif.ctx.destination);
                            await Motif.start();
                            await new Promise(resolve => setTimeout(resolve, 2100));
                            Motif.stop();
                            capture.disconnect();
                            audio = new Float32Array(chunks.length * 1024);
                            chunks.forEach((chunk, i) => audio.set(chunk, i * 1024));
                        }
                        const sampleRate = Motif.ctx.sampleRate;
                        const first = audio.findIndex(value => Math.abs(value) > .002);
                        const rms = (start, end) => {
                            const from = first + Math.round(start * sampleRate);
                            const to = first + Math.round(end * sampleRate);
                            let sum = 0;
                            for (let i = from; i < to; i++) sum += audio[i] ** 2;
                            return Math.sqrt(sum / (to - from));
                        };
                        const energies = [.5, 1, 1.5].map(onset => rms(onset - .06, onset - .03));
                        const pcm = new Int16Array(audio.length);
                        for (let i = 0; i < audio.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767);
                        const bytes = new Uint8Array(pcm.buffer);
                        let encoded = '';
                        for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
                        if (kind === 'real-time') await Motif.ctx.close();
                        return { first, sampleRate, energies, pcm: btoa(encoded) };
                    }, { kind, window, policy, faulty });
                    assert.deepEqual(errors, []);
                    const { pcm: encoded, ...metrics } = result;
                    const name = `${prefix}-${kind}-${window}-${policy}${faulty ? '-fault' : ''}`;
                    const pcm = Buffer.from(encoded, 'base64');
                    const header = Buffer.alloc(44);
                    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
                    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
                    header.writeUInt32LE(result.sampleRate, 24); header.writeUInt32LE(result.sampleRate * 2, 28);
                    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
                    await writeFile(`/audit/output/audio/${name}.wav`, Buffer.concat([header, pcm]), { flag: 'wx' });
                    const preserves = result.first >= 0 && result.energies.every(value => value > .05);
                    assert.equal(preserves, !faulty, `${name}: audio before replacement ${result.energies}`);
                    results.push({ name, ...metrics, expectedFailure: faulty });
                    console.log(`${name}: passed ${result.energies}`);
                    await page.close();
                }
            }
        }
    }
    await writeFile(`/audit/output/${prefix}-checks.json`, JSON.stringify(results, null, 2), { flag: 'wx' });
} finally {
    await browser?.close();
    server.close();
    await once(server, 'close');
}
