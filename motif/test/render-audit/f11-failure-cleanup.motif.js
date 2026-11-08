Motif.setTempo(120);
Motif.master({ gain: 0.8, limiter: true });

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const context = Motif.ctx;
const originalDecode = context.decodeAudioData;
const hadOwnDecode = Object.prototype.hasOwnProperty.call(context, "decodeAudioData");
let caughtError = null;

globalThis.fetch = async (url) => {
    if (url.includes("manifest.json")) {
        return {
            ok: true,
            json: async () => ({ kick: "kick.wav" }),
        };
    }
    return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
    };
};
context.decodeAudioData = (_buffer, _resolve, reject) => {
    reject(new Error("intentional F11 decode failure"));
};
console.error = () => {
};

try {
    await Motif.loadSamples("manifest.json");
    const track = Track("preload-failure").sample("kick");
    await track._sampleLoading;
} catch (error) {
    caughtError = error;

    // Let Track.sample() report its chained rejection while the audit capture is active.
    await Promise.resolve();
} finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (hadOwnDecode) {
        context.decodeAudioData = originalDecode;
    } else {
        delete context.decodeAudioData;
    }
}

if (caughtError?.message !== "intentional F11 decode failure") {
    throw new Error(`Expected decode rejection, received: ${caughtError?.message}`);
}
if (globalThis.fetch !== originalFetch || console.error !== originalConsoleError) {
    throw new Error("Preload failure leaked a global mock");
}
if (context.decodeAudioData !== originalDecode
    || Object.prototype.hasOwnProperty.call(context, "decodeAudioData") !== hadOwnDecode) {
    throw new Error("Preload failure leaked the decoder mock");
}

Track.clearRegistry();
Track("failure-check-audio")
    .synth("sine")
    .note(["A4"])
    .gain(0.1);
