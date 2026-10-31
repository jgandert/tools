import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { once } from 'node:events';

// Run in the renderer container with the engine mounts used by render_wav.py.
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;
        if (pathname === '/') {
            res.end();
            return;
        }
        const resolved = await realpath(pathname);
        if (!['/motif/', '/renderer/'].some(root => resolved.startsWith(root))) throw new Error('Unknown path');
        let data = await readFile(resolved);
        if (url.searchParams.has('fault') && resolved.endsWith('/MasterLimiterProcessor.js')) {
            data = data.toString().replace('const input = inputs[0];', 'throw new Error("test processor failure");');
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end();
    }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
    browser = await chromium.launch({ chromiumSandbox: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'] });
    for (const rate of [44100, 48000, 96000]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async rate => {
            const ctx = new OfflineAudioContext(2, rate, rate);
            window.AudioContext = function () { return ctx; };
            const { Motif } = await import('/motif/motif.js');
            Motif.init();
            Motif.master({ limiter: { ceiling: -3, release: 0.02 } });
            await Motif._masterLimiterReady;
            Motif._assertMasterReady();
            const buffer = ctx.createBuffer(2, rate / 2, rate);
            for (let i = 0; i < buffer.length; i++) {
                const value = i < 1024 ? 0.05 * Math.sin(i / 10) : 3 * Math.sin(i * Math.PI / 2 + Math.PI / 4);
                buffer.getChannelData(0)[i] = value;
                buffer.getChannelData(1)[i] = value / 4;
            }
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(Motif.masterGain);
            source.start();
            const output = await ctx.startRendering();
            const left = output.getChannelData(0);
            const right = output.getChannelData(1);
            const latency = Math.ceil(rate * 0.005) + 128;
            let peak = 0;
            let stereoError = 0;
            let quietError = 0;
            for (let i = 0; i < left.length; i++) {
                peak = Math.max(peak, Math.abs(left[i]));
                stereoError = Math.max(stereoError, Math.abs(right[i] - left[i] / 4));
                if (i < 128) quietError = Math.max(quietError, Math.abs(left[i + latency] - buffer.getChannelData(0)[i]));
            }
            return { peak, stereoError, quietError, nonzero: left.some(value => value !== 0) };
        }, rate);
        assert(result.nonzero, 'worklet must produce audio');
        assert(result.peak <= Math.pow(10, -3 / 20), 'custom limiter ceiling must reach the real worklet');
        assert.equal(result.stereoError, 0, 'real worklet must preserve stereo ratio');
        assert.equal(result.quietError, 0, 'real worklet must preserve quiet audio');
        assert.deepEqual(errors, []);
        console.log(`Real AudioWorklet ${rate} Hz: peak ${result.peak.toFixed(6)}, stereo and transparency passed.`);
        await page.close();
    }

    for (const bypass of [false, true]) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async bypass => {
            const ctx = new AudioContext();
            const addModule = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
            ctx.audioWorklet.addModule = url => url.includes('MasterLimiterProcessor') ? Promise.reject(new Error('test limiter load failure')) : addModule(url);
            window.AudioContext = function () { return ctx; };
            const { Motif } = await import('/motif/motif.js');
            Motif.init();
            if (bypass) Motif.master({ limiter: false });
            await ctx.resume();
            let error = null;
            try { await Motif.start(); } catch (failure) { error = failure.message; }
            const playing = Motif.isPlaying;
            Motif._stopScheduler();
            await ctx.close();
            return { error, playing };
        }, bypass);
        assert.equal(result.playing, bypass, 'failed limiter must block playback unless explicitly bypassed');
        assert.equal(result.error, bypass ? null : 'test limiter load failure');
        await page.close();
    }
    console.log('Limiter startup failure and explicit bypass checks passed.');

    for (const bypass of [false, true]) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const error = await page.evaluate(async bypass => {
            const NativeOfflineContext = OfflineAudioContext;
            window.OfflineAudioContext = function (...args) {
                const ctx = new NativeOfflineContext(...args);
                const addModule = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
                ctx.audioWorklet.addModule = url => url.includes('MasterLimiterProcessor') ? Promise.reject(new Error('test export limiter failure')) : addModule(url);
                return ctx;
            };
            const { prepare } = await import('/renderer/offline.mjs');
            try {
                await prepare(`Motif.master({limiter:${!bypass}}); Track('probe').synth('sine').note('C4');`, 4800, 48000);
                return null;
            } catch (failure) {
                return failure.message;
            }
        }, bypass);
        assert.equal(error, bypass ? null : 'test export limiter failure', 'offline exports must enforce limiter readiness');
        await page.close();
    }
    console.log('Offline limiter failure and explicit bypass checks passed.');

    const faultPage = await browser.newPage();
    await faultPage.goto(`http://127.0.0.1:${server.address().port}/`);
    const fault = await faultPage.evaluate(async () => {
        const ctx = new OfflineAudioContext(2, 48000, 48000);
        const addModule = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
        ctx.audioWorklet.addModule = url => addModule(url.includes('MasterLimiterProcessor') ? `${url}?fault=1` : url);
        window.AudioContext = function () { return ctx; };
        const { Motif } = await import('/motif/motif.js');
        Motif.init();
        await Motif._masterLimiterReady;
        const failed = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Missing processorerror event')), 5000);
            const handleError = Motif.masterLimiter.onprocessorerror;
            Motif.masterLimiter.onprocessorerror = event => {
                handleError(event);
                clearTimeout(timeout);
                resolve();
            };
        });
        const oscillator = Motif.ctx.createOscillator();
        oscillator.connect(Motif.masterGain);
        oscillator.start(Motif.ctx.currentTime + 0.05);
        Motif.isPlaying = true;
        await Promise.all([ctx.startRendering(), failed]);
        const result = { playing: Motif.isPlaying, scheduler: Motif._schedInterval, error: Motif._masterLimiterError?.message };
        Motif._stopScheduler();
        return result;
    });
    assert.equal(fault.playing, false, 'a processor exception must stop protected playback');
    assert.equal(fault.scheduler, null);
    assert.equal(fault.error, 'The master limiter processor failed.');
    await faultPage.close();
    console.log('Real processor exception stops protected playback.');
} finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
