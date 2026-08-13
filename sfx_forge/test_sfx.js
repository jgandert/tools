import {
    PARAM_KEYS,
    PARAM_RANGES,
    PRESET_NAMES,
    WAVEFORMS,
    clampParams,
    defaultParams,
    encodeWav,
    inferSoundType,
    kebabCase,
    mutate,
    randomPreset,
    rng,
    sampleSlug,
    synthesize,
    toMotifSample,
    toMotifTrack,
} from "./sfx.js";

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(msg);
        console.log(`  FAIL: ${msg}`);
    }
}

const SAMPLE_RATE = 44100;
const MAX_SAMPLES = SAMPLE_RATE * 10;

function readAscii(view, offset, length) {
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
    return out;
}

function peak(samples) {
    let max = 0;
    for (const s of samples) max = Math.max(max, Math.abs(s));
    return max;
}

// =============================================================================
// determinism
// =============================================================================
console.log("\n=== determinism ===");
{
    const params = randomPreset("explosion", rng(4242), 4242);
    const a = synthesize(params);
    const b = synthesize(params);

    assert(a.length === b.length, `determinism: same length (${a.length} vs ${b.length})`);

    let identical = true;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            identical = false;
            break;
        }
    }
    assert(identical, "determinism: identical noise output for the same params+seed");

    const other = synthesize({ ...params, seed: params.seed + 1 });
    let differs = other.length !== a.length;
    for (let i = 0; i < a.length && !differs; i++) differs = other[i] !== a[i];
    assert(differs, "determinism: a different seed changes the noise output");

    const presetA = randomPreset("laser", rng(99), 99);
    const presetB = randomPreset("laser", rng(99), 99);
    assert(JSON.stringify(presetA) === JSON.stringify(presetB), "determinism: randomPreset is a pure function of its rng seed");
}

// =============================================================================
// clampParams
// =============================================================================
console.log("\n=== clampParams ===");
{
    const clamped = clampParams({
        waveform: "triangle",
        startFreq: 5,
        minFreq: -3,
        slide: -9,
        dutySweep: 4,
        volume: Number.NaN,
        decay: "0.25",
        seed: 12.9,
        bogusKey: 1,
    });

    assert(clamped.waveform === "square", "clamp: unknown waveform falls back to square");
    assert(clamped.startFreq === 1, "clamp: startFreq clamps to 1");
    assert(clamped.minFreq === 0, "clamp: unipolar minFreq clamps to 0");
    assert(clamped.slide === -1, "clamp: bipolar slide clamps to -1");
    assert(clamped.dutySweep === 1, "clamp: bipolar dutySweep clamps to 1");
    assert(clamped.volume === defaultParams().volume, "clamp: NaN volume falls back to the default");
    assert(clamped.decay === 0.25, "clamp: numeric strings are coerced");
    assert(clamped.seed === 12, "clamp: seed truncates to an integer");
    assert(!("bogusKey" in clamped), "clamp: unknown keys are dropped");

    const empty = clampParams({});
    assert(Object.keys(empty).length === PARAM_KEYS.length + 2, "clamp: result holds every known key plus waveform and seed");
    assert(JSON.stringify(empty) === JSON.stringify(defaultParams()), "clamp: an empty object yields the defaults");
    assert(JSON.stringify(clampParams(undefined)) === JSON.stringify(defaultParams()), "clamp: undefined yields the defaults");

    for (const waveform of WAVEFORMS) {
        assert(clampParams({ waveform }).waveform === waveform, `clamp: keeps waveform ${waveform}`);
    }
}

// =============================================================================
// presets
// =============================================================================
console.log("\n=== presets ===");
{
    for (const name of PRESET_NAMES) {
        for (let seed = 1; seed <= 25; seed++) {
            const params = randomPreset(name, rng(seed), seed);
            const samples = synthesize(params);

            assert(samples.length > 0 && samples.length <= MAX_SAMPLES, `${name}#${seed}: length ${samples.length} within the 10 s cap`);

            let finite = true;
            for (const s of samples) {
                if (!Number.isFinite(s) || s < -1 || s > 1) {
                    finite = false;
                    break;
                }
            }
            assert(finite, `${name}#${seed}: all samples finite and inside [-1, 1]`);
            assert(peak(samples) > 0.001, `${name}#${seed}: output is not silent (peak ${peak(samples).toFixed(4)})`);
            assert(samples[samples.length - 1] === 0, `${name}#${seed}: ends at exactly zero`);
            assert(samples[0] === 0, `${name}#${seed}: starts at exactly zero`);
        }
    }

    let threw = false;
    try {
        randomPreset("nope", rng(1));
    } catch (e) {
        threw = true;
    }
    assert(threw, "presets: an unknown preset name throws");
}

// =============================================================================
// mutate
// =============================================================================
console.log("\n=== mutate ===");
{
    for (let seed = 1; seed <= 40; seed++) {
        const base = randomPreset("coin", rng(seed), seed);
        const random = rng(seed * 7 + 1);
        let current = base;
        for (let step = 0; step < 20; step++) current = mutate(current, random, 0.05);

        let inRange = true;
        for (const key of PARAM_KEYS) {
            const [min, max] = PARAM_RANGES[key];
            if (current[key] < min || current[key] > max || !Number.isFinite(current[key])) inRange = false;
        }
        assert(inRange, `mutate#${seed}: every parameter stays inside its legal range`);
        assert(current.waveform === base.waveform, `mutate#${seed}: waveform is preserved`);
        assert(current.seed === base.seed, `mutate#${seed}: seed is preserved`);
        assert(current.volume === base.volume, `mutate#${seed}: volume is left alone`);
    }

    const extreme = clampParams({ ...defaultParams(), startFreq: 1, slide: -1 });
    const nudged = mutate(extreme, rng(3), 0.5);
    assert(nudged.startFreq <= 1 && nudged.slide >= -1, "mutate: nudging past a boundary is clamped back");

    const untouched = mutate(defaultParams(), rng(5), 0);
    assert(JSON.stringify(untouched) === JSON.stringify(clampParams(defaultParams())), "mutate: amount 0 changes nothing");
}

// =============================================================================
// envelope sanity
// =============================================================================
console.log("\n=== envelope ===");
{
    const params = clampParams({
        ...defaultParams(),
        waveform: "square",
        attack: 0.3,
        sustain: 0.2,
        punch: 0,
        decay: 0.4,
        startFreq: 0.5,
        volume: 1,
    });
    const samples = synthesize(params);

    const window = (from, to) => peak(samples.subarray(from, to));
    const attackSamples = Math.floor(0.3 * 0.3 * 100000);

    assert(window(0, attackSamples * 0.2) < window(attackSamples * 0.6, attackSamples), "envelope: attack rises over time");
    assert(window(samples.length - 200, samples.length) < 0.02, "envelope: decay lands at ~0");
    assert(samples[samples.length - 1] === 0, "envelope: last sample is exactly 0");

    const expected = attackSamples + Math.floor(0.2 * 0.2 * 100000) + Math.floor(0.4 * 0.4 * 100000);
    assert(Math.abs(samples.length - expected) <= 4, `envelope: length matches attack+sustain+decay (${samples.length} vs ${expected})`);

    const quiet = synthesize({ ...params, volume: 0.25 });
    assert(peak(quiet) < peak(samples), "envelope: a lower volume parameter lowers the peak");

    const limited = synthesize({ ...params, startFreq: 0.9, minFreq: 0.8, slide: -0.5 });
    assert(limited.length < samples.length, "envelope: the minFreq cutoff ends the sound early");
}

// =============================================================================
// WAV encoding
// =============================================================================
console.log("\n=== WAV ===");
{
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buffer = encodeWav(samples, SAMPLE_RATE, 16);
    const view = new DataView(buffer);

    assert(readAscii(view, 0, 4) === "RIFF", "wav: RIFF magic");
    assert(readAscii(view, 8, 4) === "WAVE", "wav: WAVE magic");
    assert(readAscii(view, 12, 4) === "fmt ", "wav: fmt chunk magic");
    assert(readAscii(view, 36, 4) === "data", "wav: data chunk magic");
    assert(view.getUint32(16, true) === 16, "wav: PCM fmt chunk size is 16");
    assert(view.getUint16(20, true) === 1, "wav: PCM format tag");
    assert(view.getUint16(22, true) === 1, "wav: mono channel count");
    assert(view.getUint32(24, true) === SAMPLE_RATE, "wav: sample rate field");
    assert(view.getUint32(28, true) === SAMPLE_RATE * 2, "wav: byte rate field");
    assert(view.getUint16(32, true) === 2, "wav: block align field");
    assert(view.getUint16(34, true) === 16, "wav: bit depth field");
    assert(view.getUint32(40, true) === samples.length * 2, "wav: data chunk size");
    assert(view.getUint32(4, true) === buffer.byteLength - 8, "wav: RIFF size equals file size minus 8");
    assert(buffer.byteLength === 44 + samples.length * 2, "wav: 16-bit file size");

    assert(view.getInt16(44, true) === 0, "wav: sample 0 round-trips");
    assert(view.getInt16(46, true) === Math.round(0.5 * 32767), "wav: sample 0.5 round-trips");
    assert(view.getInt16(48, true) === Math.round(-0.5 * 32767), "wav: sample -0.5 round-trips");
    assert(view.getInt16(50, true) === 32767, "wav: sample 1 maps to 32767");
    assert(view.getInt16(52, true) === -32767, "wav: sample -1 maps to -32767");

    const clipped = new DataView(encodeWav(new Float32Array([9, -9, Number.NaN]), SAMPLE_RATE, 16));
    assert(clipped.getInt16(44, true) === 32767, "wav: out-of-range positive clips to 32767");
    assert(clipped.getInt16(46, true) === -32767, "wav: out-of-range negative clips to -32767");
    assert(clipped.getInt16(48, true) === 0, "wav: NaN becomes silence");

    const eight = encodeWav(samples, SAMPLE_RATE, 8);
    const eightView = new DataView(eight);
    assert(eight.byteLength === 44 + samples.length + (samples.length % 2), "wav: 8-bit file size includes the odd-length pad byte");
    assert(eightView.getUint32(40, true) === samples.length, "wav: 8-bit data size excludes the pad byte");
    assert(eightView.getUint32(4, true) === eight.byteLength - 8, "wav: 8-bit RIFF size covers the pad byte");
    assert(eightView.getUint16(34, true) === 8, "wav: 8-bit depth field");
    assert(eightView.getUint8(44) === 128, "wav: 8-bit silence is 128");
    assert(eightView.getUint8(47) === 255, "wav: 8-bit full scale is 255");
    assert(eightView.getUint8(48) === 1, "wav: 8-bit negative full scale is 1");

    const even = encodeWav(new Float32Array(4), SAMPLE_RATE, 8);
    assert(even.byteLength === 48, "wav: even 8-bit payload needs no pad byte");

    const sound = synthesize(randomPreset("jump", rng(7), 7));
    const soundWav = encodeWav(sound, SAMPLE_RATE, 16);
    assert(new DataView(soundWav).getUint32(40, true) / 2 === sound.length, "wav: sample count round-trips through the header");

    let threw = false;
    try {
        encodeWav(samples, SAMPLE_RATE, 24);
    } catch (e) {
        threw = true;
    }
    assert(threw, "wav: an unsupported bit depth throws");
}

// =============================================================================
// kebabCase
// =============================================================================
console.log("\n=== kebabCase ===");
{
    assert(kebabCase("Coin Pickup 3") === "coin-pickup-3", "kebab: spaces and digits");
    assert(kebabCase("  __Laser!! Shot  ") === "laser-shot", "kebab: punctuation collapses");
    assert(kebabCase("myLaserShot") === "my-laser-shot", "kebab: camelCase splits");
    assert(kebabCase("") === "sfx-sound", "kebab: empty input falls back");
    assert(kebabCase("!!!") === "sfx-sound", "kebab: punctuation-only input falls back");
}

// =============================================================================
// Motif sample export
// =============================================================================
console.log("\n=== toMotifSample ===");
{
    function evaluateSnippet(snippet, key) {
        const factory = new Function("createBuffer", "sampleRate", `return ({\n${snippet}\n});`);
        const created = [];
        const createBuffer = (duration) => {
            const data = new Float32Array(Math.floor(duration * SAMPLE_RATE));
            created.push(duration);
            return { getChannelData: () => data };
        };
        const generators = factory(createBuffer, SAMPLE_RATE);
        return { buffer: generators[key](), duration: created[0], generators };
    }

    for (const name of PRESET_NAMES) {
        const seed = 1234 + name.length;
        const params = randomPreset(name, rng(seed), seed);
        const key = sampleSlug(`${name} test`, seed, params);
        const snippet = toMotifSample(params, seed, `${name} test`);

        assert(snippet.startsWith("    // "), `motif/${name}: starts with the descriptive comment`);
        assert(snippet.includes(`'${key}': () => {`), `motif/${name}: uses the kebab-cased generator name`);
        assert(snippet.includes("if (!buffer) return null;"), `motif/${name}: keeps the createBuffer null guard`);
        assert(!snippet.includes("import"), `motif/${name}: no imports`);
        assert(!snippet.includes("Math.random"), `motif/${name}: no Math.random`);
        assert(snippet.trimEnd().endsWith("},"), `motif/${name}: emitted as an object entry`);

        const { buffer, duration } = evaluateSnippet(snippet, key);
        const data = buffer.getChannelData(0);
        const expected = synthesize({ ...params, seed }, SAMPLE_RATE);

        assert(data.length === expected.length, `motif/${name}: buffer length ${data.length} matches synthesize ${expected.length}`);
        assert(Math.abs(duration * SAMPLE_RATE - expected.length) < 1, `motif/${name}: emitted duration matches the rendered length`);

        let sameSamples = data.length === expected.length;
        for (let i = 0; i < expected.length && sameSamples; i++) sameSamples = data[i] === expected[i];
        assert(sameSamples, `motif/${name}: inlined loop reproduces synthesize() sample for sample`);

        assert(data[data.length - 1] === 0, `motif/${name}: buffer ends at exactly 0`);
        assert(data[0] === 0, `motif/${name}: buffer starts at exactly 0`);
        assert(peak(data) <= 1, `motif/${name}: buffer stays within +-1.0`);
        assert(peak(data) > 0.001, `motif/${name}: buffer is not silent`);
    }

    const nullSafe = new Function("createBuffer", "sampleRate", `return ({\n${toMotifSample(defaultParams(), 1, "quiet")}\n});`)(
        () => null,
        SAMPLE_RATE,
    );
    assert(nullSafe["quiet-0001"]() === null, "motif: a missing audio context yields null instead of throwing");
}

// =============================================================================
// Sound name inference and slug generation
// =============================================================================
console.log("\n=== sampleSlug & inferSoundType ===");
{
    assert(inferSoundType({ waveform: "noise" }) === "noise-burst", "slug: noise infers noise-burst");
    assert(inferSoundType({
        waveform: "square",
        slide: -0.3,
    }) === "square-laser", "slug: downward slide infers laser");
    assert(inferSoundType({
        waveform: "square",
        slide: 0.3,
    }) === "square-jump", "slug: upward slide infers jump");
    assert(inferSoundType({
        waveform: "saw",
        arpMod: 0.5,
        arpSpeed: 0.5,
    }) === "coin-arp", "slug: arpeggio infers coin-arp");
    assert(inferSoundType(defaultParams()) === "square-tone", "slug: default params infers square-tone");

    assert(sampleSlug("default", 0, defaultParams()) === "square-tone-0000", "slug: default name uses inferred sound type with seed suffix");
    assert(sampleSlug("laser", 0x4d1a) === "laser-4d1a", "slug: preset name appends hex seed suffix");
    assert(sampleSlug("My Super Sound", 42) === "my-super-sound-002a", "slug: custom name kebab-cases and appends hex seed");
    assert(sampleSlug("laser-4d1a", 0x4d1a) === "laser-4d1a", "slug: does not duplicate existing seed suffix");
}

// =============================================================================
// Motif track snippet export
// =============================================================================
console.log("\n=== toMotifTrack ===");
{
    for (const name of PRESET_NAMES) {
        const seed = 4321 + name.length;
        const params = randomPreset(name, rng(seed), seed);
        const key = sampleSlug(`${name} track`, seed, params);
        const snippet = toMotifTrack(params, seed, `${name} track`);

        assert(!snippet.includes("//"), `motif-track/${name}: contains no comments`);
        assert(snippet.startsWith(`Motif.sampleRegistry.set('${key}', () => {`), `motif-track/${name}: starts with sampleRegistry.set`);
        assert(snippet.endsWith(`Track('${key}').sample('${key}').note(['C4']);`), `motif-track/${name}: ends with Track playback call`);

        const sampleRegistry = new Map();
        const mockMotif = {
            ctx: {
                sampleRate: SAMPLE_RATE,
                createBuffer: (channels, length, sampleRate) => {
                    const data = new Float32Array(length);
                    return { length, sampleRate, getChannelData: () => data };
                },
            },
            sampleRegistry,
        };
        const trackCalls = [];
        const mockTrack = (id) => ({
            sample: (sampleName) => ({
                note: (notes) => {
                    trackCalls.push({ id, sampleName, notes });
                },
            }),
        });

        const runner = new Function("Motif", "Track", snippet);
        runner(mockMotif, mockTrack);

        assert(sampleRegistry.has(key), `motif-track/${name}: registers sample in sampleRegistry`);
        const buffer = sampleRegistry.get(key)();
        const data = buffer.getChannelData(0);
        const expected = synthesize({ ...params, seed }, SAMPLE_RATE);

        assert(data.length === expected.length, `motif-track/${name}: buffer length ${data.length} matches synthesize ${expected.length}`);
        assert(trackCalls.length === 1 && trackCalls[0].id === key && trackCalls[0].sampleName === key, `motif-track/${name}: Track call chained correctly`);
    }

    const fallbackRunner = new Function(
        "Motif",
        "Track",
        "createBuffer",
        toMotifTrack(defaultParams(), 1, "quiet-track"),
    );
    const fallbackRegistry = new Map();
    fallbackRunner(
        { ctx: null, sampleRegistry: fallbackRegistry },
        () => ({
            sample: () => ({
                note: () => {
                },
            }),
        }),
        () => null,
    );
    assert(fallbackRegistry.get("quiet-track-0001")() === null, "motif-track: fallback to createBuffer returns null safely");
}

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
