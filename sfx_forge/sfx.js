// SFX Forge synthesis engine: a pure params -> Float32Array port of the classic
// sfxr sample loop. No DOM, no Web Audio, so it runs under bun for tests.

const MAX_SECONDS = 10;
const REFERENCE_SAMPLE_RATE = 44100;

export const WAVEFORMS = ["square", "saw", "sine", "noise"];

export const PRESET_NAMES = [
    "coin",
    "laser",
    "explosion",
    "powerup",
    "hurt",
    "jump",
    "blip",
    "random",
];

// [min, max] per parameter; bipolar parameters use -1..1.
export const PARAM_RANGES = {
    attack: [0, 1],
    sustain: [0, 1],
    punch: [0, 1],
    decay: [0, 1],
    startFreq: [0, 1],
    minFreq: [0, 1],
    slide: [-1, 1],
    deltaSlide: [-1, 1],
    vibratoDepth: [0, 1],
    vibratoSpeed: [0, 1],
    arpMod: [-1, 1],
    arpSpeed: [0, 1],
    duty: [0, 1],
    dutySweep: [-1, 1],
    repeatSpeed: [0, 1],
    phaserOffset: [-1, 1],
    phaserSweep: [-1, 1],
    lpfCutoff: [0, 1],
    lpfSweep: [-1, 1],
    lpfResonance: [0, 1],
    hpfCutoff: [0, 1],
    hpfSweep: [-1, 1],
    volume: [0, 1],
};

export const PARAM_KEYS = Object.keys(PARAM_RANGES);

const DEFAULTS = {
    waveform: "square",
    attack: 0,
    sustain: 0.3,
    punch: 0,
    decay: 0.4,
    startFreq: 0.3,
    minFreq: 0,
    slide: 0,
    deltaSlide: 0,
    vibratoDepth: 0,
    vibratoSpeed: 0,
    arpMod: 0,
    arpSpeed: 0,
    duty: 0,
    dutySweep: 0,
    repeatSpeed: 0,
    phaserOffset: 0,
    phaserSweep: 0,
    lpfCutoff: 1,
    lpfSweep: 0,
    lpfResonance: 0,
    hpfCutoff: 0,
    hpfSweep: 0,
    volume: 0.5,
    seed: 0,
};

const MAX_SEED = 4294967295;

// Parameters mutate() is allowed to nudge; waveform and seed stay untouched.
const MUTABLE_KEYS = PARAM_KEYS.filter((key) => key !== "volume");

export function defaultParams() {
    return { ...DEFAULTS };
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export function clampParams(params) {
    const source = params ?? {};
    const out = { waveform: WAVEFORMS.includes(source.waveform) ? source.waveform : DEFAULTS.waveform };

    for (const key of PARAM_KEYS) {
        const [min, max] = PARAM_RANGES[key];
        out[key] = clampNumber(source[key], min, max, DEFAULTS[key]);
    }

    out.seed = Math.floor(clampNumber(source.seed, 0, MAX_SEED, DEFAULTS.seed));
    return out;
}

// mulberry32: tiny, fast, good enough for sound design and fully reproducible.
export function rng(seed) {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The two functions below are stringified by toMotifSample(), so they must not
// reference anything outside their own bodies except data/sampleRate/p/seed.

function synthCore(data, sampleRate, p, seed) {
    const rateScale = sampleRate / 44100;

    let noiseState = seed | 0;
    const nextNoise = () => {
        noiseState = (noiseState + 0x6d2b79f5) | 0;
        let t = Math.imul(noiseState ^ (noiseState >>> 15), 1 | noiseState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };

    const envelopeLengths = [
        Math.max(1, Math.floor(p.attack * p.attack * 100000 * rateScale)),
        Math.max(1, Math.floor(p.sustain * p.sustain * 100000 * rateScale)),
        Math.max(1, Math.floor(p.decay * p.decay * 100000 * rateScale)),
    ];

    const arpMod = p.arpMod >= 0 ? 1 - p.arpMod * p.arpMod * 0.9 : 1 + p.arpMod * p.arpMod * 10;
    const arpLimit = p.arpSpeed === 1 ? 0 : Math.floor(p.arpSpeed * p.arpSpeed * 20000 * rateScale) + 32;
    const repeatLimit = p.repeatSpeed === 0 ? 0 : Math.floor((1 - p.repeatSpeed) * (1 - p.repeatSpeed) * 20000 * rateScale) + 32;
    const maxPeriod = (100 / (p.minFreq * p.minFreq + 0.001)) * rateScale;

    let fperiod = 0;
    let fslide = 0;
    let fdslide = 0;
    let squareDuty = 0;
    let squareSlide = 0;
    let arpTime = 0;
    let arpCountdown = 0;

    // Also used by the repeat-speed retrigger, which restarts pitch and duty only.
    const restartTone = () => {
        fperiod = (100 / (p.startFreq * p.startFreq + 0.001)) * rateScale;
        fslide = 1 - (p.slide * p.slide * p.slide * 0.01) / rateScale;
        fdslide = (-p.deltaSlide * p.deltaSlide * p.deltaSlide * 0.000001) / (rateScale * rateScale);
        squareDuty = 0.5 - p.duty * 0.5;
        squareSlide = (-p.dutySweep * 0.00005) / rateScale;
        arpTime = 0;
        arpCountdown = arpLimit;
    };

    restartTone();

    const noiseBuffer = new Float32Array(32);
    for (let n = 0; n < 32; n++) noiseBuffer[n] = nextNoise();
    const phaserBuffer = new Float32Array(1024);

    let phase = 0;
    let phaserPos = 0;
    let fphase = p.phaserOffset * p.phaserOffset * 1020 * (p.phaserOffset < 0 ? -1 : 1);
    let fdphase = (p.phaserSweep * p.phaserSweep * (p.phaserSweep < 0 ? -1 : 1)) / rateScale;
    let iphase = Math.min(1023, Math.abs(Math.floor(fphase)));

    let fltp = 0;
    let fltdp = 0;
    let fltphp = 0;
    let fltw = (p.lpfCutoff * p.lpfCutoff * p.lpfCutoff * 0.1) / rateScale;
    const fltwd = 1 + (p.lpfSweep * 0.0001) / rateScale;
    const lpfEnabled = p.lpfCutoff !== 1;
    let fltdmp = (5 / (1 + p.lpfResonance * p.lpfResonance * 20)) * (0.01 + fltw);
    if (fltdmp > 0.8) fltdmp = 0.8;
    let flthp = (p.hpfCutoff * p.hpfCutoff * 0.1) / rateScale;
    const flthpd = 1 + (p.hpfSweep * 0.0003) / rateScale;

    let vibPhase = 0;
    const vibSpeed = (p.vibratoSpeed * p.vibratoSpeed * 0.01) / rateScale;
    const vibAmp = p.vibratoDepth * 0.5;

    let envStage = 0;
    let envTime = 0;
    let envVol = 0;
    let repeatTime = 0;
    let written = data.length;

    for (let i = 0; i < data.length; i++) {
        repeatTime++;
        if (repeatLimit !== 0 && repeatTime >= repeatLimit) {
            repeatTime = 0;
            restartTone();
        }

        arpTime++;
        if (arpCountdown !== 0 && arpTime >= arpCountdown) {
            arpCountdown = 0;
            fperiod *= arpMod;
        }

        fslide += fdslide;
        fperiod *= fslide;
        if (fperiod > maxPeriod) {
            fperiod = maxPeriod;
            if (p.minFreq > 0) {
                written = i;
                break;
            }
        }

        let rfperiod = fperiod;
        if (vibAmp > 0) {
            vibPhase += vibSpeed;
            rfperiod = fperiod * (1 + Math.sin(vibPhase) * vibAmp);
        }

        let period = Math.floor(rfperiod);
        if (period < 8) period = 8;

        squareDuty += squareSlide;
        if (squareDuty < 0) squareDuty = 0;
        if (squareDuty > 0.5) squareDuty = 0.5;

        envTime++;
        while (envStage < 3 && envTime > envelopeLengths[envStage]) {
            envTime = 0;
            envStage++;
        }
        if (envStage >= 3) {
            written = i;
            break;
        }
        if (envStage === 0) envVol = envTime / envelopeLengths[0];
        else if (envStage === 1) envVol = 1 + (1 - envTime / envelopeLengths[1]) * 2 * p.punch;
        else envVol = 1 - envTime / envelopeLengths[2];

        fphase += fdphase;
        iphase = Math.abs(Math.floor(fphase));
        if (iphase > 1023) iphase = 1023;

        if (flthpd !== 0) {
            flthp *= flthpd;
            if (flthp < 0.00001) flthp = 0.00001;
            if (flthp > 0.1) flthp = 0.1;
        }

        // 8x supersampling, exactly as the original sfxr renderer does it
        let sample = 0;
        for (let s = 0; s < 8; s++) {
            phase++;
            if (phase >= period) {
                phase %= period;
                if (p.waveform === "noise") {
                    for (let n = 0; n < 32; n++) noiseBuffer[n] = nextNoise();
                }
            }

            const fp = phase / period;
            let sub = 0;
            if (p.waveform === "square") sub = fp < squareDuty ? 0.5 : -0.5;
            else if (p.waveform === "saw") sub = 1 - fp * 2;
            else if (p.waveform === "sine") sub = Math.sin(fp * Math.PI * 2);
            else sub = noiseBuffer[Math.floor(fp * 32) & 31];

            const previous = fltp;
            fltw *= fltwd;
            if (fltw < 0) fltw = 0;
            if (fltw > 0.1) fltw = 0.1;
            if (lpfEnabled) {
                fltdp += (sub - fltp) * fltw;
                fltdp -= fltdp * fltdmp;
            } else {
                fltp = sub;
                fltdp = 0;
            }
            fltp += fltdp;

            fltphp += fltp - previous;
            fltphp -= fltphp * flthp;
            sub = fltphp;

            phaserBuffer[phaserPos & 1023] = sub;
            sub += phaserBuffer[(phaserPos - iphase + 1024) & 1023];
            phaserPos = (phaserPos + 1) & 1023;

            sample += sub * envVol;
        }

        sample = (sample / 8) * p.volume;
        data[i] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    }

    return written;
}

function applyEdgeFades(data, sampleRate) {
    const fadeIn = Math.min(Math.round(sampleRate * 0.0008), data.length >> 2);
    const fadeOut = Math.min(Math.round(sampleRate * 0.004), data.length >> 1);

    for (let i = 0; i < fadeIn; i++) data[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) data[data.length - 1 - i] *= i / fadeOut;

    // Guarantees the click-free zero ending even for degenerate buffer lengths
    data[data.length - 1] = 0;
}

// Reused across calls so dragging a slider does not allocate a 10 s buffer per event.
// Safe because only the [0, written) range is ever read back.
let scratchBuffer = new Float32Array(0);

function scratchFor(length) {
    if (scratchBuffer.length < length) scratchBuffer = new Float32Array(length);
    return scratchBuffer.subarray(0, length);
}

export function synthesize(params, sampleRate = REFERENCE_SAMPLE_RATE) {
    const p = clampParams(params);
    const scratch = scratchFor(Math.floor(MAX_SECONDS * sampleRate));
    const written = synthCore(scratch, sampleRate, p, p.seed);
    const out = scratch.slice(0, Math.max(1, written));

    applyEdgeFades(out, sampleRate);
    return out;
}

function presetCoin(p, frnd, rnd) {
    p.startFreq = 0.4 + frnd(0.5);
    p.attack = 0;
    p.sustain = frnd(0.1);
    p.decay = 0.1 + frnd(0.4);
    p.punch = 0.3 + frnd(0.3);
    if (!rnd(1)) return;

    p.arpSpeed = 0.5 + frnd(0.2);
    p.arpMod = 0.2 + frnd(0.4);
}

function presetLaser(p, frnd, rnd) {
    p.waveform = WAVEFORMS[rnd(2)];
    if (p.waveform === "sine" && rnd(1)) p.waveform = WAVEFORMS[rnd(1)];

    p.startFreq = 0.5 + frnd(0.5);
    p.minFreq = Math.max(0.2, p.startFreq - 0.2 - frnd(0.6));
    p.slide = -0.15 - frnd(0.2);

    if (rnd(2) === 0) {
        p.startFreq = 0.3 + frnd(0.6);
        p.minFreq = frnd(0.1);
        p.slide = -0.35 - frnd(0.3);
    }

    if (rnd(1)) {
        p.duty = frnd(0.5);
        p.dutySweep = frnd(0.2);
    } else {
        p.duty = 0.4 + frnd(0.5);
        p.dutySweep = -frnd(0.7);
    }

    p.sustain = 0.1 + frnd(0.2);
    p.decay = frnd(0.4);
    if (rnd(1)) p.punch = frnd(0.3);
    if (rnd(2) === 0) {
        p.phaserOffset = frnd(0.2);
        p.phaserSweep = -frnd(0.2);
    }
    if (rnd(1)) p.hpfCutoff = frnd(0.3);
}

function presetExplosion(p, frnd, rnd) {
    p.waveform = "noise";

    if (rnd(1)) {
        p.startFreq = 0.1 + frnd(0.4);
        p.slide = -0.1 + frnd(0.4);
    } else {
        p.startFreq = 0.2 + frnd(0.7);
        p.slide = -0.2 - frnd(0.2);
    }
    p.startFreq *= p.startFreq;

    if (rnd(4) === 0) p.slide = 0;
    if (rnd(2) === 0) p.repeatSpeed = 0.3 + frnd(0.5);

    p.attack = 0;
    p.sustain = 0.1 + frnd(0.3);
    p.decay = frnd(0.5);
    p.punch = 0.2 + frnd(0.6);

    if (rnd(1) === 0) {
        p.phaserOffset = -0.3 + frnd(0.9);
        p.phaserSweep = -frnd(0.3);
    }
    if (rnd(1)) {
        p.vibratoDepth = frnd(0.7);
        p.vibratoSpeed = frnd(0.6);
    }
    if (rnd(2) === 0) {
        p.arpSpeed = 0.6 + frnd(0.3);
        p.arpMod = 0.8 - frnd(1.6);
    }
}

function presetPowerup(p, frnd, rnd) {
    if (rnd(1)) p.waveform = "saw";
    else p.duty = frnd(0.6);

    p.startFreq = 0.2 + frnd(0.3);

    if (rnd(1)) {
        p.slide = 0.1 + frnd(0.4);
        p.repeatSpeed = 0.4 + frnd(0.4);
    } else {
        p.slide = 0.05 + frnd(0.2);
        if (rnd(1)) {
            p.vibratoDepth = frnd(0.7);
            p.vibratoSpeed = frnd(0.6);
        }
    }

    p.attack = 0;
    p.sustain = frnd(0.4);
    p.decay = 0.1 + frnd(0.4);
}

function presetHurt(p, frnd, rnd) {
    p.waveform = WAVEFORMS[rnd(2)];
    if (p.waveform === "sine") p.waveform = "noise";
    if (p.waveform === "square") p.duty = frnd(0.6);

    p.startFreq = 0.2 + frnd(0.6);
    p.slide = -0.3 - frnd(0.4);
    p.attack = 0;
    p.sustain = frnd(0.1);
    p.decay = 0.1 + frnd(0.2);
    if (rnd(1)) p.hpfCutoff = frnd(0.3);
}

function presetJump(p, frnd, rnd) {
    p.waveform = "square";
    p.duty = frnd(0.6);
    p.startFreq = 0.3 + frnd(0.3);
    p.slide = 0.1 + frnd(0.2);
    p.attack = 0;
    p.sustain = 0.1 + frnd(0.3);
    p.decay = 0.1 + frnd(0.2);
    if (rnd(1)) p.hpfCutoff = frnd(0.3);
    if (rnd(1)) p.lpfCutoff = 1 - frnd(0.6);
}

function presetBlip(p, frnd, rnd) {
    p.waveform = WAVEFORMS[rnd(1)];
    if (p.waveform === "square") p.duty = frnd(0.6);
    p.startFreq = 0.2 + frnd(0.4);
    p.attack = 0;
    p.sustain = 0.1 + frnd(0.1);
    p.decay = frnd(0.2);
    p.hpfCutoff = 0.1;
}

function presetRandom(p, frnd, rnd) {
    const bipolar = () => frnd(2) - 1;
    const signedPow = (exp) => Math.pow(bipolar(), exp);

    p.waveform = WAVEFORMS[rnd(3)];
    p.startFreq = rnd(1) ? signedPow(3) + 0.5 : signedPow(2);
    p.minFreq = 0;
    p.slide = signedPow(5);
    if (p.startFreq > 0.7 && p.slide > 0.2) p.slide = -p.slide;
    if (p.startFreq < 0.2 && p.slide < -0.05) p.slide = -p.slide;
    p.deltaSlide = signedPow(3);

    p.duty = bipolar();
    p.dutySweep = signedPow(3);
    p.vibratoDepth = signedPow(3);
    p.vibratoSpeed = bipolar();

    p.attack = signedPow(3);
    p.sustain = signedPow(2);
    p.decay = bipolar();
    p.punch = Math.pow(frnd(0.8), 2);
    if (p.attack + p.sustain + p.decay < 0.2) {
        p.sustain += 0.2 + frnd(0.3);
        p.decay += 0.2 + frnd(0.3);
    }

    p.lpfResonance = bipolar();
    p.lpfCutoff = 1 - Math.pow(frnd(1), 3);
    p.lpfSweep = signedPow(3);
    if (p.lpfCutoff < 0.1 && p.lpfSweep < -0.05) p.lpfSweep = -p.lpfSweep;
    p.hpfCutoff = Math.pow(frnd(1), 5);
    p.hpfSweep = signedPow(5);

    p.phaserOffset = signedPow(3);
    p.phaserSweep = signedPow(3);
    p.repeatSpeed = bipolar();
    p.arpSpeed = bipolar();
    p.arpMod = bipolar();
}

const PRESET_BUILDERS = {
    coin: presetCoin,
    laser: presetLaser,
    explosion: presetExplosion,
    powerup: presetPowerup,
    hurt: presetHurt,
    jump: presetJump,
    blip: presetBlip,
    random: presetRandom,
};

export function randomPreset(name, random, seed = 0) {
    const build = PRESET_BUILDERS[name];
    if (!build) throw new Error(`Unknown preset: ${name}`);

    const frnd = (range) => random() * range;
    const rnd = (max) => Math.floor(random() * (max + 1));

    const p = defaultParams();
    p.volume = 0.5;
    build(p, frnd, rnd);
    p.seed = seed;
    return clampParams(p);
}

export function mutate(params, random, amount = 0.05) {
    const p = clampParams(params);

    for (const key of MUTABLE_KEYS) {
        if (random() < 0.5) continue;
        p[key] += random() * amount * 2 - amount;
    }

    return clampParams(p);
}

function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(samples, sampleRate = REFERENCE_SAMPLE_RATE, bitDepth = 16) {
    if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unsupported bit depth: ${bitDepth}`);

    const bytesPerSample = bitDepth / 8;
    const dataBytes = samples.length * bytesPerSample;

    // RIFF chunks are word-aligned: an odd data chunk needs a trailing pad byte
    const padding = dataBytes % 2;
    const buffer = new ArrayBuffer(44 + dataBytes + padding);
    const view = new DataView(buffer);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes + padding, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, bitDepth, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i] || 0));
        if (bitDepth === 16) {
            view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true);
            continue;
        }
        view.setUint8(44 + i, Math.max(0, Math.min(255, Math.round(s * 127) + 128)));
    }

    return buffer;
}

export function kebabCase(text) {
    const slug = String(text ?? "")
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "sfx-sound";
}

function inlineBody(fn, indent) {
    const source = fn.toString();
    const lines = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}")).split("\n");

    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

    // The inlined copy lives inside an arrow function that must return the buffer
    if (lines.length && /^\s*return\b/.test(lines[lines.length - 1])) lines.pop();

    const filled = lines.filter((line) => line.trim() !== "");
    const baseIndent = Math.min(...filled.map((line) => line.length - line.trimStart().length));
    const pad = " ".repeat(indent);
    return lines.map((line) => (line.trim() === "" ? "" : pad + line.slice(baseIndent))).join("\n");
}

function describeSound(p, name) {
    const traits = [];
    if (p.slide < -0.05) traits.push("a downward pitch slide");
    else if (p.slide > 0.05) traits.push("a rising pitch sweep");
    if (p.arpMod !== 0 && p.arpSpeed > 0) traits.push("an arpeggio step");
    if (p.vibratoDepth > 0.05) traits.push("vibrato");
    if (p.repeatSpeed > 0) traits.push("a retriggering repeat");
    if (p.phaserOffset !== 0 || p.phaserSweep !== 0) traits.push("a flanger tap");
    if (p.lpfCutoff !== 1 || p.hpfCutoff > 0) traits.push("filter shaping");
    if (traits.length === 0) traits.push("no modulation");

    const envelope = p.punch > 0.3 ? "punchy" : p.attack > 0.2 ? "soft-attack" : "tight";
    return `Retro sfxr-style ${name}: ${p.waveform} oscillator with ${traits.join(", ")}, ${envelope} attack-decay envelope`;
}

export function toMotifSample(params, seed = 0, name = "sfx-sound") {
    const p = clampParams({ ...params, seed });
    const samples = synthesize(p, REFERENCE_SAMPLE_RATE);

    // Half a sample of slack so createBuffer's truncation lands on the exact length
    const duration = ((samples.length + 0.5) / REFERENCE_SAMPLE_RATE).toFixed(6);
    const key = kebabCase(name);
    const paramLines = JSON.stringify(p, null, 2)
        .split("\n")
        .map((line, index) => (index === 0 ? line : "      " + line))
        .join("\n");

    return `    // ${describeSound(p, key)}
    '${key}': () => {
      const buffer = createBuffer(${duration});
      if (!buffer) return null;
      const data = buffer.getChannelData(0);

      const p = ${paramLines};
      const seed = ${p.seed};

${inlineBody(synthCore, 6)}

${inlineBody(applyEdgeFades, 6)}

      return buffer;
    },`;
}

export function toMotifTrack(params, seed = 0, name = "sfx-sound") {
    const p = clampParams({ ...params, seed });
    const samples = synthesize(p, REFERENCE_SAMPLE_RATE);
    const duration = ((samples.length + 0.5) / REFERENCE_SAMPLE_RATE).toFixed(6);
    const key = kebabCase(name);
    const paramLines = JSON.stringify(p, null, 2)
        .split("\n")
        .map((line, index) => (index === 0 ? line : "  " + line))
        .join("\n");

    return `Motif.sampleRegistry.set('${key}', () => {
  const ctx = Motif.ctx;
  const sampleRate = ctx ? ctx.sampleRate : 44100;
  const buffer = ctx ? ctx.createBuffer(1, Math.floor(${duration} * sampleRate), sampleRate) : (typeof createBuffer === "function" ? createBuffer(${duration}) : null);
  if (!buffer) return null;
  const data = buffer.getChannelData(0);

  const p = ${paramLines};
  const seed = ${p.seed};

${inlineBody(synthCore, 2)}

${inlineBody(applyEdgeFades, 2)}

  return buffer;
});

Track('${key}').sample('${key}').note(['C4']);`;
}
