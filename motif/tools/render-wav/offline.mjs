async function resourcesReady() {
    const { Motif, trackRegistry, busRegistry } = globalThis;
    await Promise.all(Motif._loadingSamples);
    await Promise.all([...trackRegistry.values(), ...busRegistry.values()].flatMap(node => [
        node._sampleLoading, node._samplerLoading, node._dspReady,
    ]));
    await Motif._masterLimiterReady;
    Motif._assertMasterReady();
}

export async function prepare(source, frames, sampleRate) {
    const ctx = new OfflineAudioContext(2, frames, sampleRate);
    window.AudioContext = function() {
        return ctx;
    };
    const motif = await import("/motif/motif.js");
    const { Motif, trackRegistry } = motif;
    Object.assign(globalThis, motif);
    Motif.init();

    // Transport is driven by the offline clock, never by wall-clock timers.

    Motif.start = async () => {
    };
    for (const name of ["stop", "pause"]) {
        Motif[name] = () => {
            throw new Error(`Motif.${name}() is unsupported during offline rendering.`);
        };
    }
    window.setTimeout = window.setInterval = () => {
        throw new Error("Wall-clock timers are unsupported. Use Motif.schedule() or Arrange().");
    };
    await new Function(`return (async () => {\n${source}\n})()`)();
    await resourcesReady();

    // init() deliberately swallows worklet failures; exports must fail instead.

    const { ensureSynthWorklet } = await import("/motif/src/TrackVoiceManager.js");
    const { ensureGranularStretcher } = await import("/motif/src/helpers.js");
    await Promise.all([ensureSynthWorklet(ctx), ensureGranularStretcher(ctx)]);
    if (!trackRegistry.size) throw new Error("Song created no tracks.");

    let end = Motif._arrangementDuration() || 0;
    for (const track of trackRegistry.values()) {
        for (const segment of track._activeSegments) end = Math.max(end, segment.stop);
    }
    globalThis.renderState = { ctx, Motif };
    return Motif._arrangementSections?.length && Number.isFinite(end) && end > 0 ? end : null;
}

// Duration probing runs in its own page and submits no voices. Advancing the same
// scheduler also evaluates tempo changes inside scheduled callbacks and modifiers.
export async function inferDuration() {
    const { ctx, Motif } = globalThis.renderState;
    if (!Motif._arrangementSections?.length) return null;
    let clock = 0;
    Object.defineProperty(ctx, "currentTime", { configurable: true, get: () => clock });
    const step = Math.max(128, Math.floor(Motif.lookaheadIntervalMs * ctx.sampleRate / 128000) * 128) / ctx.sampleRate;
    while (clock <= 1800) {
        for (const track of globalThis.trackRegistry.values()) track._playEvent = () => {
        };
        Motif._tick();
        await resourcesReady();
        let end = Motif._arrangementDuration() || 0;
        for (const track of globalThis.trackRegistry.values()) {
            for (const segment of track._activeSegments) end = Math.max(end, segment.stop);
        }
        if (!Number.isFinite(end) || end <= 0) return null;
        if (clock >= end) return end;
        clock += step;
    }
    throw new Error("Inferred arrangement exceeds 1800 seconds.");
}

export async function render() {
    const { ctx, Motif } = globalThis.renderState;

    // Advance in render-quantum multiples so suspend times never round backward.
    // Scheduling the whole song at once would prematurely steal pooled voices.

    const stepFrames = Math.max(128, Math.floor(Motif.lookaheadIntervalMs * ctx.sampleRate / 128000) * 128);
    const tick = async () => {
        Motif._tick();
        await resourcesReady();
    };
    await tick();
    let nextFrame = stepFrames;
    let suspended = nextFrame < ctx.length ? ctx.suspend(nextFrame / ctx.sampleRate) : null;
    const completed = ctx.startRendering();
    while (suspended) {
        await suspended;
        await tick();
        nextFrame += stepFrames;
        suspended = nextFrame < ctx.length ? ctx.suspend(nextFrame / ctx.sampleRate) : null;
        await ctx.resume();
    }
    globalThis.renderedAudio = await completed;
    return { frames: ctx.length, sampleRate: ctx.sampleRate };
}

export function pcmChunk(start, count) {
    const buffer = globalThis.renderedAudio;
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const bytes = new Uint8Array(count * 4);
    const view = new DataView(bytes.buffer);
    let peak = 0;
    let clipped = 0;
    for (let frame = 0; frame < count; frame++) {
        for (let channel = 0; channel < 2; channel++) {
            const value = (channel ? right : left)[start + frame];
            if (!Number.isFinite(value)) throw new Error("Audio contains non-finite samples.");
            peak = Math.max(peak, Math.abs(value));
            if (Math.abs(value) > 1) clipped++;
            const sample = Math.max(-1, Math.min(1, value));
            view.setInt16(frame * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        }
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return { data: btoa(binary), peak, clipped };
}
