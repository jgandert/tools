import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { once } from 'node:events';

const output = process.argv[2];
if (!output?.startsWith('/audit/output/')) throw new Error('Supply an unused /audit/output/ JSON output path');
await mkdir('/audit/output', { recursive: true });

const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/') {
            res.end();
            return;
        }
        const resolved = await realpath(path);
        if (!['/motif/', '/renderer/'].some(root => resolved.startsWith(root))) throw new Error('Unknown path');
        res.writeHead(200, { 'Content-Type': resolved.endsWith('.html') ? 'text/html' : 'text/javascript' });
        res.end(await readFile(resolved));
    } catch {
        res.writeHead(404);
        res.end();
    }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const results = {};
let browser;
const probe = async (name, callback, arg) => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async () => {
            Object.assign(globalThis, await import('/motif/motif.js'));
        });
        results[name] = { ...await page.evaluate(callback, arg), pageErrors };
    } finally {
        await page.close();
    }
};

try {
    browser = await chromium.launch({ chromiumSandbox: true, ignoreDefaultArgs: ['--disable-dev-shm-usage'] });
    for (const mode of ['direct', 'arranged', 'loop']) {
        await probe(`sliceCompletion_${mode}`, async ({ mode }) => {
            Motif.init();
            Motif.setTempo(120);
            const ctx = Motif.ctx;
            const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
            buffer.getChannelData(0).fill(.25);
            Motif.sampleRegistry.set('completion-buffer', buffer);
            const track = Track('completion').sample('completion-buffer').chop(2).pattern([0, 1]).gain(.01);
            if (mode === 'direct') track.start(0).stop(.2);
            else Arrange([{ tracks: [track], bars: .1 }, { tracks: [], bars: .1 }], { loop: mode === 'loop' });
            let finished = 0;
            let looped;
            let stoppedAt;
            let origin;
            let restarts = 0;
            const startScheduler = Motif._startScheduler.bind(Motif);
            Motif._startScheduler = () => { restarts++; startScheduler(); };
            const completion = new Promise(resolve => {
                Motif.onPlaybackFinished = result => {
                    finished++;
                    looped = result.looped;
                    stoppedAt = ctx.currentTime;
                    resolve();
                };
            });
            await Motif.start();
            origin = track._playbackStartTime;
            await Promise.race([completion, new Promise((_, reject) => setTimeout(() => reject(new Error('Slice transport did not finish')), 2000))]);
            await new Promise(resolve => setTimeout(resolve, 60));
            const playing = Motif.isPlaying;
            const elapsed = stoppedAt - origin;
            const expected = mode === 'direct' ? .2 : .4;
            const passed = finished === 1 && looped === (mode === 'loop') && playing === (mode === 'loop')
                && restarts === (mode === 'loop' ? 2 : 1) && elapsed >= expected - 1e-7 && elapsed < expected + .08;
            Motif.stop();
            Track.clearRegistry();
            await ctx.close();
            return { finished, looped, playing, restarts, elapsed, expected, passed };
        }, { mode });
    }
    for (const tempoChange of [false, true]) {
        const source = `
            Motif.setTempo(120);
            const buffer = Motif.ctx.createBuffer(1, 48000, 48000);
            buffer.getChannelData(0).fill(.25);
            Motif.sampleRegistry.set('slice-probe-buffer', buffer);
            const track = Track('slice-probe').sample('slice-probe-buffer').chop(2).pattern([0, 1]).gain(.01);
            Arrange([{ tracks: [track], bars: .5 }, { tracks: [], bars: .5 }]);
            globalThis.changedAt = null;
            ${tempoChange ? "Motif.schedule(.25, () => { changedAt = Motif._tempoChangeTime(); Motif.setTempo(60); });" : ''}
        `;
        await probe(`sliceDuration_probe_${tempoChange}`, async ({ source, tempoChange }) => {
            const runner = await import('/renderer/offline.mjs');
            await runner.prepare(source, 1, 48000);
            const duration = await runner.inferDuration();
            const expected = tempoChange ? 4 - changedAt : 2;
            return { duration, expected, changedAt, passed: Math.abs(duration - expected) < 1e-7 && !Motif.isPlaying };
        }, { source, tempoChange });
        const inferred = results[`sliceDuration_probe_${tempoChange}`].duration;
        await probe(`sliceDuration_offline_${tempoChange}`, async ({ source, inferred }) => {
            const runner = await import('/renderer/offline.mjs');
            await runner.prepare(source, Math.ceil((inferred + .1) * 48000), 48000);
            await runner.render();
            const audio = renderedAudio.getChannelData(0);
            let peak = 0;
            let trailingPeak = 0;
            for (let index = 0; index < audio.length; index++) {
                peak = Math.max(peak, Math.abs(audio[index]));
                if (index / 48000 > inferred - .2) trailingPeak = Math.max(trailingPeak, Math.abs(audio[index]));
            }
            const duration = Motif._arrangementDuration();
            return { inferred, duration, peak, trailingPeak,
                passed: Math.abs(duration - inferred) < 1e-7 && peak > .0001 && trailingPeak === 0 && !Motif.isPlaying };
        }, { source, inferred });
    }
    for (const kind of ['sample', 'sampler']) {
        for (const mode of ['success', 'failure', 'replace', 'remove', 'live']) {
            await probe(`sourceReadiness_${kind}_${mode}`, async ({ kind, mode }) => {
                Motif.init();
                await Motif.ctx.resume();
                await Motif._masterLimiterReady;
                const ctx = Motif.ctx;
                const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
                buffer.getChannelData(0).fill(.25);
                let resolve, reject;
                const pending = new Promise((res, rej) => { resolve = res; reject = rej; });
                Motif._loadAndCacheBuffer = () => pending;
                Motif._startScheduler = () => {};
                const track = Track('readiness').note([60]).gain(.01);
                const configure = path => kind === 'sample'
                    ? track.sample(path)
                    : track.sampler({ urls: { C4: path } });
                let oscillators = 0, buffers = 0;
                const createOscillator = ctx.createOscillator.bind(ctx);
                const createBufferSource = ctx.createBufferSource.bind(ctx);
                ctx.createOscillator = () => { oscillators++; return createOscillator(); };
                ctx.createBufferSource = () => { buffers++; return createBufferSource(); };
                if (mode === 'live') {
                    Motif.sampleRegistry.set('ready-buffer', buffer);
                    configure('ready-buffer');
                    await Motif.start();
                }
                configure('pending.wav');
                let started = mode === 'live';
                const starting = mode === 'live' ? Promise.resolve() : Motif.start().then(() => { started = true; });
                await new Promise(resolve => setTimeout(resolve, 20));
                const waited = mode === 'live' ? Motif.isPlaying : !started && !Motif.isPlaying;
                track._playEvent(track._parsedEvents[0], ctx.currentTime + .01, .05);
                const skipped = oscillators === 0 && buffers === 0;
                if (mode === 'failure') reject(new Error('expected source failure'));
                else if (mode === 'replace') {
                    Motif.sampleRegistry.set('replacement-buffer', buffer);
                    configure('replacement-buffer');
                } else if (mode === 'remove') Track.pruneExcept([]);
                else resolve(buffer);
                const completed = await Promise.race([
                    starting.then(() => true),
                    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
                ]);
                await new Promise(resolve => setTimeout(resolve, 0));
                track._playEvent(track._parsedEvents[0], ctx.currentTime + .01, .05);
                const finalSource = mode === 'failure' || mode === 'remove' ? buffers === 0 : buffers === 1;
                const passed = waited && skipped && completed && started && Motif.isPlaying && finalSource && oscillators === 0;
                Track.clearRegistry();
                await ctx.close();
                return { waited, skipped, completed, started, buffers, oscillators, passed };
            }, { kind, mode });
        }
    }
    await probe('sourceReadiness_partialSampler', async () => {
        Motif.init();
        await Motif.ctx.resume();
        await Motif._masterLimiterReady;
        const ctx = Motif.ctx;
        const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        let resolveGood, rejectBad;
        const good = new Promise(resolve => { resolveGood = resolve; });
        const bad = new Promise((resolve, reject) => { rejectBad = reject; });
        Motif._loadAndCacheBuffer = path => path === 'good.wav' ? good : bad;
        Motif._startScheduler = () => {};
        const track = Track('partial').sampler({ urls: { C4: 'good.wav', G4: 'bad.wav' } }).note([67]);
        let started = false;
        const starting = Motif.start().then(() => { started = true; });
        resolveGood(buffer);
        await new Promise(resolve => setTimeout(resolve, 20));
        const waitedForAllZones = !started && !Motif.isPlaying;
        rejectBad(new Error('expected failed zone'));
        await starting;
        track._playEvent(track._parsedEvents[0], ctx.currentTime + .01, .05);
        const voice = [...track._activeVoices.values()][0];
        await new Promise(resolve => setTimeout(resolve, 50));
        const actualRate = voice?.oscillator.playbackRate.value;
        const passed = waitedForAllZones && started && Math.abs(actualRate - Math.pow(2, 7 / 12)) < 1e-7;
        Track.clearRegistry();
        await ctx.close();
        return { waitedForAllZones, started, actualRate, passed };
    });

    for (const action of ['stop', 'pause']) {
        for (const waitingFor of ['resources', 'source', 'resume']) {
            for (const outcome of ['resolve', 'reject', 'pending']) {
                await probe(`startCancel_${action}_${waitingFor}_${outcome}`, async ({ action, waitingFor, outcome }) => {
                    Motif.init();
                    await Motif.ctx.resume();
                    await Motif._masterLimiterReady;
                    await Promise.allSettled(Motif._loadingSamples);
                    Motif._loadingSamples = [];
                    const ctx = Motif.ctx;
                    let resolve, reject;
                    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
                    let starts = 0;
                    Motif._startScheduler = () => { starts++; };
                    const reported = [];
                    const savedError = console.error;
                    const savedWarn = console.warn;
                    console.error = (...args) => { reported.push(args.map(String).join(' ')); };
                    console.warn = (...args) => { reported.push(args.map(String).join(' ')); };
                    try {
                        if (waitingFor === 'resources') Motif._loadingSamples = [pending];
                        if (waitingFor === 'source') {
                            Motif._loadAndCacheBuffer = () => pending;
                            Track('cancel-source').sample('pending.wav').note([60]);
                        }
                        if (waitingFor === 'resume') {
                            Motif.pause();
                            await Motif._suspendPromise;
                            ctx.resume = () => pending;
                        }
                        let settled = false;
                        const starting = Motif.start().then(value => { settled = value === undefined; });
                        await new Promise(resolve => setTimeout(resolve, 10));
                        Motif.position = 5;
                        Motif[action]();
                        await new Promise(resolve => setTimeout(resolve, 10));
                        const settledBeforeDependency = settled;
                        if (outcome === 'resolve') resolve(ctx.createBuffer(1, 128, ctx.sampleRate));
                        if (outcome === 'reject') reject(new Error('expected late cancelled failure'));
                        await new Promise(resolve => setTimeout(resolve, 20));
                        if (settled) await starting;
                        const positionCorrect = Motif.position === (action === 'pause' ? 5 : 0);
                        const failureReported = outcome !== 'reject' || reported.some(text => text.includes('expected late cancelled failure'));
                        return { settledBeforeDependency, starts, playing: Motif.isPlaying, positionCorrect, failureReported,
                            passed: settledBeforeDependency && starts === 0 && !Motif.isPlaying && positionCorrect && failureReported };
                    } finally {
                        console.error = savedError;
                        console.warn = savedWarn;
                        Track.clearRegistry();
                        await ctx.close();
                    }
                }, { action, waitingFor, outcome });
            }
        }
    }
    await probe('startCancel_superseded', async () => {
        Motif.init();
        await Motif.ctx.resume();
        await Motif._masterLimiterReady;
        await Promise.allSettled(Motif._loadingSamples);
        const ctx = Motif.ctx;
        let oldReady, newReady;
        Motif._loadingSamples = [new Promise(resolve => { oldReady = resolve; })];
        let starts = 0, oldSettled = false;
        Motif._startScheduler = () => { starts++; };
        const oldStart = Motif.start().then(() => { oldSettled = true; });
        Motif._loadingSamples = [new Promise(resolve => { newReady = resolve; })];
        const newStart = Motif.start();
        await new Promise(resolve => setTimeout(resolve, 10));
        const settledBeforeDependency = oldSettled;
        newReady();
        await newStart;
        oldReady();
        await oldStart;
        const passed = settledBeforeDependency && starts === 1 && Motif.isPlaying;
        await ctx.close();
        return { settledBeforeDependency, starts, playing: Motif.isPlaying, passed };
    });

    await probe('shortGateAdsr', async () => {
        const ctx = new OfflineAudioContext(1, 48000, 48000);
        Motif.ctx = ctx;
        Motif.masterGain = ctx.createGain();
        const gain = ctx.createGain();
        const input = ctx.createConstantSource();
        input.offset.value = 1;
        input.connect(gain);
        gain.connect(ctx.destination);
        input.start(.1);
        input.stop(.4);
        Track('adsr').envelope({ attack: 1, decay: .1, sustain: .5, release: .2 })
            ._scheduleAdsrGain(gain, .1, .1, 1, false);
        const audio = (await ctx.startRendering()).getChannelData(0);
        const actualAtMidAttack = audio[7200];
        const expectedAtMidAttack = .0001 + (1 - .0001) * .05;
        return {
            actualAtMidAttack,
            expectedAtMidAttack,
            actualBeforeGateOff: audio[9599],
            actualAtGateOff: audio[9600],
            passed: Math.abs(actualAtMidAttack - expectedAtMidAttack) < 1e-5 &&
                Math.abs(audio[9600] - audio[9599]) < 1e-4,
        };
    });

    const adsrCases = [
        { name: 'attack', attack: 1, decay: .1, gate: .1 },
        { name: 'decay', attack: .1, decay: .4, gate: .3 },
        { name: 'sustain', attack: .1, decay: .1, gate: .4 },
        { name: 'attackBoundary', attack: .1, decay: .2, gate: .1 },
        { name: 'decayBoundary', attack: .1, decay: .2, gate: .3 },
        { name: 'zeroAttack', attack: 0, decay: .4, gate: .2 },
        { name: 'zeroDecay', attack: .2, decay: 0, gate: .3 },
        { name: 'zeroAttackDecay', attack: 0, decay: 0, gate: .2 },
        { name: 'zeroRelease', attack: .1, decay: .4, gate: .3, release: 0 },
        { name: 'tiedAttack', attack: 1, decay: .1, gate: .1, tied: true },
        { name: 'tiedDecay', attack: .1, decay: .4, gate: .3, tied: true },
        { name: 'continuedTieAttack', attack: 1, decay: .1, gate: .1, continued: true },
        { name: 'continuedTieDecay', attack: .1, decay: .4, gate: .3, continued: true },
    ];
    for (const config of adsrCases) {
        await probe(`adsrInterpolation_${config.name}`, async ({ attack, decay, gate, release = .2, tied, continued }) => {
            const sampleRate = 48000;
            const ctx = new OfflineAudioContext(1, sampleRate * 2, sampleRate);
            Motif.ctx = ctx;
            Motif.masterGain = ctx.createGain();
            const gain = ctx.createGain();
            const input = ctx.createConstantSource();
            input.offset.value = 1;
            input.connect(gain);
            gain.connect(ctx.destination);
            const onset = .1;
            const off = onset + gate;
            const releaseTime = off + (tied || continued ? .2 : 0);
            const peak = .3;
            const floor = peak * .0001;
            const sustain = peak * .5;
            const levelAt = time => {
                if (time < onset + attack) return floor + (peak - floor) * (time - onset) / attack;
                if (time < onset + attack + decay) return peak * Math.pow(sustain / peak, (time - onset - attack) / decay);
                return sustain;
            };
            const holdValue = levelAt(off);
            const track = Track('adsr-phases').envelope({ attack, decay, sustain: .5, release });
            const envelope = track._scheduleAdsrGain(gain, onset, gate, peak, !!(tied || continued), tied ? releaseTime : off);
            input.start(onset);
            input.stop(1.9);
            if (continued) {
                track._scheduleTieRelease({
                    gainNode: gain,
                    oscillator: input,
                    gainValue: peak,
                    tieGainValue: envelope.holdValue,
                }, off, releaseTime);
            }
            const audio = (await ctx.startRendering()).getChannelData(0);
            let maxError = 0;
            let worstTime = 0;
            for (let frame = 0; frame < audio.length; frame++) {
                const time = frame / sampleRate;
                let expected = 0;
                if (time >= onset && time < off) expected = levelAt(time);
                else if (time >= off && time < releaseTime) expected = holdValue;
                else if (time >= releaseTime && time < releaseTime + release) {
                    expected = holdValue * Math.pow(floor / holdValue, (time - releaseTime) / release);
                }

                // Source stops and AudioParam events can round opposite ways at
                // a fractional release-end frame; either floor or zero is valid there.
                const atReleaseEnd = release > 0 && Math.abs(time - releaseTime - release) < .5 / sampleRate;
                const error = atReleaseEnd
                    ? Math.min(Math.abs(audio[frame]), Math.abs(audio[frame] - floor))
                    : Math.abs(audio[frame] - expected);
                if (error > maxError) {
                    maxError = error;
                    worstTime = time;
                }
            }
            return { maxError, worstTime, holdValue, releaseTime, passed: maxError < 2e-5 };
        }, config);
    }

    for (const source of ['sine', 'custom', 'dsp', 'sample', 'sampler', 'granular', 'sinePlain', 'samplePlain', 'slowAttack']) {
        const modes = source === 'slowAttack' ? ['intact', 'stall'] : ['masked', 'laterRemoved', 'intact', 'stall', 'inactive', 'swung', 'tempo'];
        for (const mode of modes) {
            await probe(`boundedTie_${source}_${mode}`, async ({ source, mode }) => {
                const useEnvelope = !source.endsWith('Plain');
                const slowAttack = source === 'slowAttack';
                source = slowAttack ? 'sine' : source.replace('Plain', '');
                const ctx = new OfflineAudioContext(2, mode === 'tempo' ? 76800 : 45696, 48000);
                Motif.ctx = ctx;
                Motif.masterGain = ctx.createGain();
                Motif.masterGain.connect(ctx.destination);
                Motif.tempo = 120;
                Motif._tempoMap = null;
                const { ensureSynthWorklet } = await import('/motif/src/TrackVoiceManager.js');
                const { ensureGranularStretcher } = await import('/motif/src/helpers.js');
                await Promise.all([ensureSynthWorklet(ctx), ensureGranularStretcher(ctx)]);
                Motif.synthRegistry.set('bounded-tie-test', ({ p }) => Math.sin(p));
                const track = Track('bounded').synth(source === 'custom' ? 'bounded-tie-test' : 'sine')
                    .note([60, Tie, Tie, null]).stepLength(mode === 'tempo' ? '1/8' : .25).gain(.1)
                    .envelope({ attack: slowAttack ? .5 : .005, decay: .005, sustain: .5, release: .05 });
                if (!useEnvelope) track._envelope = null;
                if (source === 'dsp') track.dsp(context => context.i);
                if (['sample', 'sampler', 'granular'].includes(source)) {
                    const buffer = ctx.createBuffer(1, 96000, 48000);
                    buffer.getChannelData(0).fill(.5);
                    if (source === 'sampler') {
                        track._useSampler = true;
                        track._samplerBuffers.set(60, buffer);
                        track._samplerKeys = [60];
                    } else {
                        track._useSample = true;
                        track._sampleBuffer = buffer;
                    }
                    if (source === 'granular') {
                        track._fitDuration = 2;
                        track._fitOptions = { mode: 'stretch' };
                    }
                }
                if (mode === 'masked') track.mask([true, false, false, true]);
                if (mode === 'laterRemoved') track.mask([true, true, false, true]);
                if (mode === 'inactive') track.start(0).stop(.2);
                if (mode === 'swung') track.swing(1);
                let tempoEdited = false;
                const tick = () => {
                    if (mode === 'tempo' && !tempoEdited && ctx.currentTime > .12) {
                        Motif.setTempo(60);
                        tempoEdited = true;
                    }
                    if (mode === 'stall' && ctx.currentTime > .12 && ctx.currentTime < .65) return;
                    track._schedule(ctx.currentTime + .1);
                };
                tick();
                const stepFrames = 1024;
                let nextFrame = stepFrames;
                let suspended = ctx.suspend(nextFrame / ctx.sampleRate);
                const completed = ctx.startRendering();
                while (suspended) {
                    await suspended;
                    tick();
                    nextFrame += stepFrames;
                    suspended = nextFrame < ctx.length ? ctx.suspend(nextFrame / ctx.sampleRate) : null;
                    await ctx.resume();
                }
                const audio = (await completed).getChannelData(0);
                const rms = (start, end) => {
                    const from = Math.round(start * ctx.sampleRate);
                    const to = Math.round(end * ctx.sampleRate);
                    let sum = 0;
                    for (let i = from; i < to; i++) sum += audio[i] ** 2;
                    return Math.sqrt(sum / (to - from));
                };
                const beforeTie = rms(.1, .15);
                const firstContinuation = rms(.35, .4);
                const secondContinuation = rms(.65, .7);
                const silence = mode === 'tempo' ? rms(1.45, 1.5) : rms(.85, .9);
                const needsFirst = ['laterRemoved', 'intact', 'swung', 'tempo'].includes(mode);
                const needsSecond = ['intact', 'swung', 'tempo'].includes(mode);
                const sustainReference = slowAttack ? rms(.23, .24) : beforeTie;
                const sustains = value => value / sustainReference > .75 && value / sustainReference < 1.25;
                const lateContinuation = mode === 'tempo' ? rms(1, 1.05) : null;
                return {
                    beforeTie, firstContinuation, secondContinuation, lateContinuation, silence,
                    remainingVoices: [...track._activeVoices.values()].filter(voice => voice.startTime < .8).length,
                    passed: beforeTie > .001 && silence < 1e-8 && [...track._activeVoices.values()].every(voice => voice.startTime >= .8) &&
                        (needsFirst ? sustains(firstContinuation) : firstContinuation < 1e-8) &&
                        (needsSecond ? sustains(secondContinuation) : secondContinuation < 1e-8) &&
                        (mode !== 'tempo' || sustains(lateContinuation)),
                };
            }, { source, mode });
        }
    }

    for (const kind of ['sample', 'sampler']) {
        for (const mode of ['registered', 'external', 'resolved', 'failure', 'parentReplace', 'repeat', 'rightOverride', 'partial']) {
            if (mode === 'partial' && kind !== 'sampler') continue;
            await probe(`splitLoad_${kind}_${mode}`, async ({ kind, mode }) => {
                const ctx = new OfflineAudioContext(2, 14400, 48000);
                Motif.ctx = ctx;
                Motif.masterGain = ctx.createGain();
                Motif.masterGain.connect(ctx.destination);
                const makeBuffer = left => {
                    const buffer = ctx.createBuffer(2, 9600, 48000);
                    buffer.getChannelData(0).fill(left);
                    buffer.getChannelData(1).fill(left * 2);
                    return buffer;
                };
                const original = makeBuffer(.2);
                const replacement = makeBuffer(.1);
                let resolve, reject;
                const pending = new Promise((res, rej) => { resolve = res; reject = rej; });
                Motif._loadAndCacheBuffer = () => pending;
                Motif.sampleRegistry.set('new', replacement);
                if (mode === 'registered' || mode === 'resolved') Motif.sampleRegistry.set('old', original);
                const configure = (track, path) => kind === 'sample'
                    ? track.sample(path)
                    : track.sampler({ urls: mode === 'partial' ? { C4: path, G4: 'new' } : { C4: path } });
                const parent = configure(Track('splitLoad').note([60]).gain(.1), 'old');
                if (mode === 'resolved') {
                    await parent._sampleLoading;
                    await parent._samplerLoading;
                }
                parent.splitStereo(right => right.gain(.1));
                const right = parent._rightTrack;
                const splitLoad = kind === 'sample' ? right._sampleLoading : right._samplerLoading;
                if (mode === 'parentReplace') configure(parent, 'new');
                if (mode === 'repeat') configure(parent, 'new').splitStereo();
                if (mode === 'rightOverride') configure(right, 'new');
                if (mode === 'failure' || mode === 'partial') reject(new Error('expected split source rejection'));
                else resolve(original);
                await splitLoad;
                await parent._sampleLoading?.catch(() => {});
                await parent._samplerLoading;
                await right._sampleLoading;
                await right._samplerLoading;
                const adopted = kind === 'sample' ? right._sampleBuffer : right._samplerBuffers.get(right._findNearestSamplerKey(60));
                const expected = mode === 'failure' ? undefined : ['repeat', 'rightOverride', 'partial'].includes(mode) ? replacement : original;
                const stateCorrect = expected === undefined ? adopted == null : adopted === expected;
                const pitch = mode === 'partial' ? 67 : 60;
                for (const track of [parent, right]) {
                    track.note([pitch]);
                    track._playEvent(track._parsedEvents[0], .02, .1);
                }
                const audio = await ctx.startRendering();
                const energies = [0, 1].map(channel => audio.getChannelData(channel).reduce((sum, value) => sum + value * value, 0));
                const expectedRatio = mode === 'parentReplace' ? 16 : mode === 'rightOverride' ? 1 : 4;
                const rendered = mode === 'failure' ? energies.every(value => value === 0)
                    : energies[0] > .01 && Math.abs(energies[1] / energies[0] - expectedRatio) < .001;
                return { energies, expectedRatio, stateCorrect, pending: right._sourcePending, passed: stateCorrect && !right._sourcePending && rendered };
            }, { kind, mode });
        }
    }

    for (const mode of ['split', 'sharedTrackLfo', 'sharedBusLfo']) {
        for (const prune of [false, true]) {
            await probe(`${mode}_${prune}`, async ({ mode, prune }) => {
                globalThis.renderMarkdownFileToElement = async () => {};
            const ctx = new OfflineAudioContext(2, 24000, 48000);
                Motif.ctx = ctx;
                Motif.masterGain = ctx.createGain();
                Motif.masterGain.connect(ctx.destination);
                if (mode === 'split') {
                    // Match the editor's AsyncFunction and declared-ID pruning.
                    const ids = new Set();
                    const wrappedTrack = id => {
                        ids.add(id);
                        return Track(id);
                    };
                    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
                    await new AsyncFunction('Track', "Track('stereo').synth('sine').note([60]).gain(.1).splitStereo(right => right.gain(.1));")(wrappedTrack);
                    if (prune) Track.pruneExcept(ids);
                } else {
                    const shared = LFO.sine({ min: 1, max: 1, frequency: 1 });
                    if (mode === 'sharedTrackLfo') Track('drop').note([null]).pan(shared);
                    if (mode === 'sharedBusLfo') Bus('drop-bus').pan(shared);
                    Track('keep').note([60]).gain(.1).pan(shared);
                    if (prune && mode === 'sharedTrackLfo') Track.pruneExcept(['keep']);
                    if (prune && mode === 'sharedBusLfo') Bus.pruneExcept([]);
                }
                for (const track of trackRegistry.values()) track._schedule(.1);
                const audio = await ctx.startRendering();
                const energies = [0, 1].map(channel => audio.getChannelData(channel).reduce((sum, value) => sum + value * value, 0));
                const passed = mode === 'split'
                    ? energies[0] > 1 && Math.abs(energies[0] - energies[1]) < 1e-5
                    : energies[1] > 1 && energies[0] < 1e-10;
                return { energies, registeredTracks: [...trackRegistry.keys()], passed };
            }, { mode, prune });
        }
    }

    for (const consumer of ['track', 'bus']) {
        for (const action of ['scalar', 'ramp', 'missingEdge', 'clear', 'crossfade', 'additive', 'gain']) {
            if (consumer === 'bus' && ['crossfade', 'additive', 'gain'].includes(action)) continue;
            await probe(`sharedLfo_${consumer}_${action}`, async ({ consumer, action }) => {
                globalThis.renderMarkdownFileToElement = async () => {};
            const ctx = new OfflineAudioContext(2, 24000, 48000);
                Motif.ctx = ctx;
                Motif.masterGain = ctx.createGain();
                Motif.masterGain.connect(ctx.destination);
                const shared = LFO.sine({ min: 1, max: 1, frequency: 1 });
                const keep = Track(action === 'clear' && consumer === 'track' ? undefined : 'keep').note([60]).gain(.1).pan(shared);
                const drop = consumer === 'track' ? Track('drop').note([null]) : Bus('drop');
                drop.pan(shared);
                if (action === 'scalar') drop.pan(0);
                if (action === 'ramp') drop.pan(Ramp(0, .5, .1));
                if (action === 'missingEdge') {
                    shared.disconnect(drop.pannerNode.pan);
                    drop.pan(0);
                    drop.pan(0);
                }
                if (action === 'additive') {
                    drop.modulate('pan', shared);
                    drop.modulate('pan', shared, { depth: .5 });
                }
                if (action === 'gain') {
                    drop.gain(shared);
                    drop.gain(.2);
                    drop.gain(shared);
                }
                if (action === 'crossfade') {
                    const replacement = Track('replacement').note([null]);
                    drop._crossfadeOut(replacement, 0);
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                if (consumer === 'track') {
                    if (action === 'clear') Track.clearRegistry();
                    else Track.pruneExcept(['keep']);
                    Track.pruneExcept(['keep']);
                } else {
                    if (action === 'clear') Bus.clearRegistry();
                    else Bus.pruneExcept([]);
                    Bus.pruneExcept([]);
                }
                keep._schedule(.1);
                const audio = await ctx.startRendering();
                const energies = [0, 1].map(channel => audio.getChannelData(channel).reduce((sum, value) => sum + value * value, 0));
                const passed = energies[1] > 1 && energies[0] < 1e-10;
                return { energies, passed };
            }, { consumer, action });
        }
    }

    for (const lookahead of [.03, .1, 1.2]) {
        for (const clockSteps of [false, true]) {
            await probe(`offsetOverflow_${lookahead}_${clockSteps ? 'clock' : 'musical'}`, async ({ lookahead, clockSteps }) => {
                const ctx = new OfflineAudioContext(2, 115200, 48000);
                Motif.ctx = ctx;
                Motif.masterGain = ctx.createGain();
                Motif.masterGain.connect(ctx.destination);
                Motif.tempo = 120;
                Motif._tempoMap = null;
                let calls = 0;
                const track = Track('offset-overflow').synth('sine')
                    .note([Parallel([60, Tie], [64, null]), null]).stepLength(clockSteps ? .25 : '1/8')
                    .every(1, events => ++calls === 1 ? events : []).offset(1.75).gain(.1)
                    .envelope({ attack: .005, decay: .005, sustain: .5, release: .05 });
                const submissions = [];
                const play = track._playEvent.bind(track);
                track._playEvent = (event, time, duration) => {
                    submissions.push({ value: event.value === Tie ? 'Tie' : event.value, time, cycle: event.tieCycle });
                    play(event, time, duration);
                };
                let edited = false;
                const tick = () => {
                    if (!edited && ctx.currentTime >= .35) {
                        Motif.setTempo(60);
                        edited = true;
                    }
                    track._schedule(ctx.currentTime + lookahead);
                };
                tick();
                let nextFrame = 1024;
                let suspended = ctx.suspend(nextFrame / ctx.sampleRate);
                const rendered = ctx.startRendering();
                while (suspended) {
                    await suspended;
                    tick();
                    nextFrame += 1024;
                    suspended = nextFrame < ctx.length ? ctx.suspend(nextFrame / ctx.sampleRate) : null;
                    await ctx.resume();
                }
                const audio = (await rendered).getChannelData(0);
                const rms = (start, end) => {
                    const left = Math.round(start * ctx.sampleRate);
                    const right = Math.round(end * ctx.sampleRate);
                    let sum = 0;
                    for (let i = left; i < right; i++) sum += audio[i] ** 2;
                    return Math.sqrt(sum / (right - left));
                };
                const copyStart = clockSteps ? .875 : Motif._timeAtBeat(1.75);
                const copyTie = clockSteps ? 1 : Motif._timeAtBeat(2);
                const copyEnd = clockSteps ? 1.125 : Motif._timeAtBeat(2.25);
                const audible = rms(copyTie + .06, copyEnd - .01);
                const silence = rms(copyEnd + .06, copyEnd + .12);
                const copies = submissions.filter(event => event.time >= copyStart - 1e-9);
                const expected = [[60, copyStart], [64, copyStart], ['Tie', copyTie], [null, copyTie], [null, copyEnd]];
                const correct = copies.length === expected.length && copies.every((event, index) =>
                    event.cycle === 0 && event.value === expected[index][0] && Math.abs(event.time - expected[index][1]) < 1e-9);
                return { submissions, copyStart, copyTie, copyEnd, audible, silence, calls,
                    passed: correct && audible > .02 && silence < 1e-8 };
            }, { lookahead, clockSteps });
        }
    }

    const html = await readFile('/motif/index.html', 'utf8');
    const inline = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import\s+[\s\S]*?;/, '');
    const skeleton = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
    for (const mode of ['repeat', 'remove', 'plain']) {
        await probe(`editorSplit_${mode}`, async ({ skeleton, inline, mode }) => {
            document.open();
            document.write(skeleton);
            document.close();
            // Isolate the editor lifecycle from absent vendored storage/dialogs.
            globalThis.one = {
                storage: { get: async () => null, set: async () => {} },
                prompt: async () => null, confirm: async () => false, alert: () => {},
            };
            globalThis.renderMarkdownFileToElement = async () => {};
            const ctx = new OfflineAudioContext(2, 24000, 48000);
            Motif.ctx = ctx;
            Motif.masterGain = ctx.createGain();
            Motif.masterGain.connect(ctx.destination);
            await new Function(inline)();
            // loadPersistedState restores the editor asynchronously.
            await new Promise(resolve => setTimeout(resolve, 100));
            Track.clearRegistry();
            Motif.isPlaying = true;
            const editor = document.querySelector('#code-editor');
            const compile = async code => {
                editor.value = code;
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 100));
            };
            const code = "Track('stereo').synth('sine').note([60]).gain(.1).splitStereo(right => right.note([72]).gain(.05));";
            const pairs = [];
            let previous;
            for (let i = 0; i < 3; i++) {
                await compile(code);
                const parent = trackRegistry.get('stereo');
                const right = trackRegistry.get('stereo_right');
                pairs.push(!!parent && !!right && parent._rightTrack === right && right._splitParent === parent
                    && right !== previous && right._notePattern[0] === 72 && right._gainLevel === .05);
                previous = right;
            }
            if (mode === 'remove') await compile('');
            if (mode === 'plain') await compile("Track('stereo').synth('sine').note([60]).gain(.1);");
            for (const track of trackRegistry.values()) track._schedule(.1);
            const audio = await ctx.startRendering();
            const energies = [0, 1].map(channel => audio.getChannelData(channel).reduce((sum, value) => sum + value * value, 0));
            const registry = [...trackRegistry.keys()];
            const lifecycle = mode === 'repeat' ? registry.length === 2
                : mode === 'remove' ? registry.length === 0
                : registry.length === 1 && registry[0] === 'stereo';
            const audible = mode === 'repeat' ? energies.every(value => value > 1)
                : mode === 'remove' ? energies.every(value => value === 0)
                : energies.every(value => value > 1);
            const consoleText = document.querySelector('#console-logs').innerText;
            const errors = consoleText.includes('[Error]');
            Motif.isPlaying = false;
            return { pairs, energies, registry, errors, consoleText, passed: pairs.every(Boolean) && lifecycle && audible && !errors };
        }, { skeleton, inline, mode });
    }

    for (const mode of ['missing', 'partial', 'full', 'rejecting']) {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        try {
            // Fixtures supply only external vendor globals; the served page and
            // its native module imports, controls, and audio engine run intact.
            await page.addInitScript(({ mode }) => {
                if (mode === 'missing') return;
                globalThis.one = {
                    prompt: async () => { throw new Error('fixture dialog failure'); },
                    confirm: async () => false,
                    alert: () => {},
                };
                if (mode !== 'partial') {
                    globalThis.one.storage = {
                        get: async () => {
                            if (mode === 'rejecting') throw new Error('fixture storage failure');
                            return null;
                        },
                        set: async () => {},
                    };
                    globalThis.renderMarkdownFileToElement = async () => {
                        if (mode === 'rejecting') throw new Error('fixture documentation failure');
                        document.querySelector('#modal-info-content').textContent = 'Fixture documentation';
                    };
                }
            }, { mode });
            await page.goto(`http://127.0.0.1:${server.address().port}/motif/index.html`);
            await page.waitForFunction(() => !document.querySelector('#code-editor').disabled
                && document.querySelector('#preset-select').options.length > 0);
            const warning = await page.locator('#console-logs').innerText();
            await page.locator('#add-preset-btn').click();
            await page.locator('#open-modal').click();
            await page.evaluate(() => document.querySelector('#modal-info').close());
            await page.locator('#code-editor').fill("Track('vendor-check').synth('sine').note([60]).stepLength('1/1').gain(.01);");
            await page.locator('#code-editor').press('Control+Enter');
            await page.waitForFunction(() => document.querySelector('#play-pause-btn').textContent === 'pause');
            const playing = await page.evaluate(async () => {
                const { Motif, trackRegistry } = await import('/motif/motif.js');
                const track = trackRegistry.get('vendor-check');
                return { isPlaying: Motif.isPlaying, registered: !!track, runningContext: Motif.ctx.state === "running" };
            });
            await page.locator('#play-pause-btn').click();
            await page.waitForFunction(() => document.querySelector('#play-pause-btn').textContent === 'play_arrow');
            const consoleText = await page.locator('#console-logs').innerText();
            const warned = warning.includes('Missing vendor file(s):');
            const contained = consoleText.includes('[Error] Error:');
            const documentationFailure = mode !== 'rejecting' || consoleText.includes('fixture documentation failure');
            const persistenceFailure = mode !== 'rejecting' || consoleText.includes('fixture storage failure');
            const name = mode === 'missing' ? 'playgroundMissingVendors' : `playgroundVendors_${mode}`;
            results[name] = {
                warned, contained, playing, documentationFailure, persistenceFailure, consoleText, pageErrors,
                passed: warned === ['missing', 'partial'].includes(mode) && contained && playing.isPlaying && playing.registered && playing.runningContext
                    && documentationFailure && persistenceFailure && pageErrors.length === 0,
            };
        } finally {
            await page.close();
        }
    }

} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}

await writeFile(output, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([, result]) => !result.passed || result.pageErrors.length);
console.log(`Review browser regressions: ${failed.length} failed out of ${Object.keys(results).length}`);
process.exitCode = failed.length ? 1 : 0;
