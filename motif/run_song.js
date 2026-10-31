// Headless validator for Motif song files.
// Usage: bun run_song.js [song.js ... | directory] (defaults to game/)
//
// Executes the song against the mock Web Audio context, then drives each
// registered track's scheduler across the full arrangement span and reports
// per-track event counts, pitch ranges, NaN pitches, warnings and errors.

import { installMockAudioContext } from "./test/mock_webaudio.js";

import { readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "--worker") {
    const inputs = args.length ? args : [resolve(dirname(fileURLToPath(import.meta.url)), "game")];
    const songs = new Set();
    let failed = 0;
    for (const input of inputs) {
        try {
            const path = resolve(input);
            if (statSync(path).isDirectory()) {
                for (const name of readdirSync(path).sort()) {
                    if (name.endsWith(".js") && statSync(resolve(path, name)).isFile()) songs.add(resolve(path, name));
                }
            } else {
                songs.add(path);
            }
        } catch (error) {
            console.error(`INPUT ERROR: ${input}: ${error.message}`);
            failed++;
        }
    }
    for (const song of songs) {
        // A fresh process isolates registries, globals, audio state, and song mutations.
        const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), "--worker", song], {
            stdout: "inherit", stderr: "inherit", timeout: 120000,
        });
        if (child.exitCode !== 0 || child.signalCode) failed++;
    }
    if (!songs.size) {
        console.error("INPUT ERROR: no JavaScript songs found");
        failed++;
    }
    console.log(`\nLINT COVERAGE: ${songs.size} songs executed; ${failed} failed inputs/songs. Mock scheduling does not prove audible output.`);
    process.exit(failed ? 1 : 0);
}
const songPath = args[1];

const MockCtx = installMockAudioContext({ verbose: false });
globalThis.OfflineAudioContext = MockCtx;

// Synth voices and .dsp() tracks instantiate AudioWorkletNode; stub it so the
// real voice-allocation path runs instead of throwing.
class MockAudioWorkletNode {
    constructor(ctx, name, options = {}) {
        this.context = ctx;
        this.name = name;
        this.options = options;
        this.port = {
            postMessage: () => {
            }, onmessage: null,
        };
        const params = new Map();
        this.parameters = {
            get: (key) => {
                if (!params.has(key)) {
                    params.set(key, {
                        value: 0,
                        setValueAtTime(v) {
                            this.value = v;
                            return this;
                        },
                        linearRampToValueAtTime(v) {
                            this.value = v;
                            return this;
                        },
                        exponentialRampToValueAtTime(v) {
                            this.value = v;
                            return this;
                        },
                        setTargetAtTime() {
                            return this;
                        },
                        cancelScheduledValues() {
                            return this;
                        },
                        cancelAndHoldAtTime() {
                            return this;
                        },
                    });
                }
                return params.get(key);
            },
        };
    }

    connect(dest) {
        return dest;
    }

    disconnect() {
    }
}

globalThis.AudioWorkletNode = MockAudioWorkletNode;

const motif = await import("./motif.js");
const { Motif, trackRegistry, busRegistry } = motif;

const DSL_GLOBALS = [
    "Motif", "Track", "Bus", "Arrange", "Parallel", "Ramp", "Tie", "LFO", "SimplexNoise",
    "noteToMidi", "midiToNote", "midiToHz", "degreeToMidi",
    "parseDurationToFraction", "parseDurationToSeconds", "SCALES",
];
for (const name of DSL_GLOBALS) globalThis[name] = motif[name];

Motif.ctx = null;
Motif.init();

const warnings = [];
const errors = [];
const origWarn = console.warn;
const origError = console.error;
console.warn = (...a) => warnings.push(a.map(String).join(" "));
console.error = (...a) => errors.push(a.map(String).join(" "));

const source = await Bun.file(songPath).text();
const registryIssues = [];
const trackIdCounts = new Map();
const creationOrder = new WeakMap();
let createdTracks = 0;
const builtins = new Set(["sine", "square", "sawtooth", "triangle", "saw", "noise", "fm", "pluck"]);
const scaleNames = new Set(Object.keys(motif.SCALES).map(name => name.toLowerCase()));

// Instrument real calls instead of scanning source: comments, string bodies, array
// operations, and local helpers cannot be mistaken for Motif API calls.
globalThis.Track = Object.assign(function(id) {
    if (id) trackIdCounts.set(id, (trackIdCounts.get(id) || 0) + 1);
    const track = motif.Track(id);
    creationOrder.set(track, ++createdTracks);
    const sidechain = track.sidechain;
    Object.defineProperty(track, "sidechain", {
        configurable: true,
        get() {
            // JavaScript resolves the method before evaluating its arguments.
            const beforeArguments = createdTracks;
            return function(target, options) {
                if (creationOrder.get(target) > beforeArguments) registryIssues.push(`${id}: sidechain(Track(...)) constructs a new trigger; pass an existing Track instance or its ID`);
                return sidechain.call(this, target, options);
            };
        },
    });
    for (const kind of ["sample", "synth", "sound"]) {
        const original = track[kind];
        track[kind] = function(name) {
            const sample = Motif.sampleRegistry.has(name);
            const synth = builtins.has(name) || Motif.synthRegistry.has(name);
            if (kind === "sample" && synth && !sample) registryIssues.push(`${id}: .sample("${name}") is a synth (cross-registry call)`);
            if (kind === "synth" && sample && !synth) registryIssues.push(`${id}: .synth("${name}") is a sample (cross-registry call)`);
            // Explicit paths/URLs are supported sample sources; loading determines validity.
            if (name && !sample && !synth && !/[./:]/.test(name)) registryIssues.push(`${id}: unknown ${kind} source "${name}"`);
            return original.apply(this, arguments);
        };
    }
    const scale = track.scale;
    track.scale = function(root, name = "major") {
        if (!Number.isFinite(motif.noteToMidi(root))) registryIssues.push(`${id}: invalid scale root "${root}"`);
        if (typeof name !== "string" || !scaleNames.has(name.toLowerCase())) registryIssues.push(`${id}: invalid scale name "${name}"`);
        return scale.apply(this, arguments);
    };
    return track;
}, motif.Track);

let execError = null;
try {
    await new Function(`return (async () => {\n${source}\n})()`)();
    await Promise.allSettled([...trackRegistry.values()].flatMap(track => [track._sampleLoading, ...(track._samplerLoading ? [track._samplerLoading] : [])]));
    await Motif._masterLimiterReady;
    Motif._assertMasterReady();
} catch (err) {
    execError = err;
}

console.warn = origWarn;
console.error = origError;

const duplicateIds = [...trackIdCounts].filter(([, n]) => n > 1);
for (const [id, track] of trackRegistry) {
    if (track._useSampler && !track._samplerBuffers.size) registryIssues.push(`${id}: sampler has no loaded buffers`);
    if (track._stepLengthFraction == null && track._patternTopLevelSteps && (track._patternTopLevelSteps > 16 || (track._patternTopLevelSteps & (track._patternTopLevelSteps - 1)))) {
        warnings.push(`${id}: ${track._patternTopLevelSteps} pattern steps without explicit stepLength; the whole pattern occupies one bar`);
    }
}

// --- Arrangement span ---

const sections = Motif._arrangementSections || [];
const bpm = Motif.tempo;
const beatsPerBar = Motif.beatsPerBar;
const barDuration = (60 / bpm) * beatsPerBar;
const totalBars = sections.reduce((sum, s) => sum + (s.bars || 0), 0);
const totalSeconds = Motif._arrangementDuration() ?? totalBars * barDuration;

// --- Drive every track's scheduler across the full span ---

const collectPitches = (value, out) => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") {
        out.push(value);
        return;
    }
    if (typeof value === "string") {
        out.push(motif.noteToMidi(value));
        return;
    }
    if (value && Array.isArray(value.items)) {
        value.items.forEach(v => collectPitches(v, out));
        return;
    }
    if (value && value.from !== undefined && value.to !== undefined) {
        collectPitches(value.from, out);
        collectPitches(value.to, out);
    }
};

const stats = [];
for (const [id, track] of trackRegistry) {
    const rec = {
        id,
        count: 0,
        attempts: 0,
        nan: 0,
        min: Infinity,
        max: -Infinity,
        first: null,
        last: null,
        thrown: null,
    };
    stats.push(rec);
    const original = track._playEvent.bind(track);
    track._playEvent = (event, startTime, duration) => {
        rec.count++;
        const isNote = event.value != null && event.value !== motif.Tie && !(typeof event.value === "object" && event.value.type && event.value.type !== "Parallel" && event.value.value !== undefined);
        if (isNote && duration > 0) rec.attempts++;
        if (rec.first === null) rec.first = startTime;
        rec.last = startTime;
        const pitches = [];
        if (isNote) collectPitches(event.value, pitches);
        if (track._scaleRoot !== undefined && !track._freqPattern) {
            for (let i = 0; i < pitches.length; i++) {
                if (typeof event.value === "number") pitches[i] = motif.degreeToMidi(pitches[i], track._scaleRoot, track._scaleName);
            }
        }
        for (const p of pitches) {
            if (!Number.isFinite(p)) {
                rec.nan++;
                continue;
            }
            rec.min = Math.min(rec.min, p);
            rec.max = Math.max(rec.max, p);
        }
        try {
            return original(event, startTime, duration);
        } catch (err) {
            if (!rec.thrown) rec.thrown = err.message;
        }
    };
}

const scheduleWarnings = [];
const scheduleErrors = [];
console.warn = (...a) => scheduleWarnings.push(a.map(String).join(" "));
console.error = (...a) => scheduleErrors.push(a.map(String).join(" "));

Motif.ctx.currentTime = 0;
for (const [, track] of trackRegistry) {
    try {
        track._schedule((totalSeconds || barDuration) + 0.001);
    } catch (err) {
        console.error(`_schedule threw on "${track.id}": ${err.message}`);
    }
}

console.warn = origWarn;
console.error = origError;

// --- Report ---

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

console.log(`\nSONG: ${songPath}`);
console.log(`tempo ${bpm} bpm | beatsPerBar ${beatsPerBar} | bar ${barDuration.toFixed(3)}s`);
console.log(`sections ${sections.length} | bars ${totalBars} | duration ${totalSeconds.toFixed(1)}s (${mmss(totalSeconds)})`);
console.log(`tracks ${trackRegistry.size} | buses ${busRegistry.size}`);

console.log(`\nSECTIONS (bar offsets):`);
let bar = 0;
sections.forEach((s, i) => {
    const ids = (s.tracks || []).map(t => t && t.id).filter(Boolean);
    console.log(`  ${String(bar).padStart(3)}-${String(bar + (s.bars || 0)).padStart(3)} [${String(s.bars).padStart(2)} bars] ${ids.length} tracks: ${ids.join(", ")}`);
    bar += s.bars || 0;
});

console.log(`\nTRACK EVENTS:`);
const silent = [];
for (const r of stats.sort((a, b) => b.count - a.count)) {
    const range = r.count && r.min !== Infinity ? `midi ${r.min}-${r.max}` : "no pitch";
    const span = r.count ? `${mmss(r.first)}..${mmss(r.last)}` : "-";
    console.log(`  ${r.id.padEnd(22)} ${String(r.count).padStart(5)} scheduled steps / ${r.attempts} non-rest note attempts  ${range.padEnd(14)} ${span}${r.nan ? `  NaN:${r.nan}` : ""}${r.thrown ? `  THREW: ${r.thrown}` : ""}`);
    if (r.attempts === 0) silent.push(r.id);
    const track = trackRegistry.get(r.id);
    if (track._useSample && track._scaleRoot === undefined && r.min < 24) warnings.push(`${r.id}: low MIDI sample pitches (${r.min}); MIDI 60 is native pitch, confirm transposition is intentional`);
}

const problems = [];
if (execError) problems.push(`SETUP ERROR: ${execError.message}`);
if (errors.length) problems.push(`SETUP CONSOLE ERRORS: ${uniqMessages(errors)}`);
if (scheduleErrors.length) problems.push(`SCHEDULING CONSOLE ERRORS: ${uniqMessages(scheduleErrors)}`);
if (!stats.length) problems.push("NO TRACKS: no note-attempt coverage");
function uniqMessages(messages) {
    return [...new Set(messages)].slice(0, 20).join(" | ");
}
if (silent.length) problems.push(`NO NOTE ATTEMPTS: ${silent.join(", ")}`);
if (registryIssues.length) problems.push(`REGISTRY: ${registryIssues.join(" | ")}`);
if (duplicateIds.length) problems.push(`DUPLICATE Track() IDS: ${duplicateIds.map(([id, n]) => `${id}×${n}`).join(", ")}`);
const nanTracks = stats.filter(r => r.nan > 0);
if (nanTracks.length) problems.push(`INVALID PITCHES: ${nanTracks.map(r => `${r.id}(${r.nan})`).join(", ")}`);
const thrownTracks = stats.filter(r => r.thrown);
if (thrownTracks.length) problems.push(`PLAY ERRORS: ${thrownTracks.map(r => `${r.id}: ${r.thrown}`).join(" | ")}`);

const uniq = (arr) => [...new Set(arr)];
if (warnings.length) console.log(`\nSETUP WARNINGS:\n  ${uniq(warnings).slice(0, 20).join("\n  ")}`);
if (errors.length) console.log(`\nSETUP ERRORS:\n  ${uniq(errors).slice(0, 20).join("\n  ")}`);
if (scheduleWarnings.length) console.log(`\nSCHEDULE WARNINGS (${scheduleWarnings.length}):\n  ${uniq(scheduleWarnings).slice(0, 20).join("\n  ")}`);
if (scheduleErrors.length) console.log(`\nSCHEDULE ERRORS (${scheduleErrors.length}):\n  ${uniq(scheduleErrors).slice(0, 20).join("\n  ")}`);

console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join("\n  ")}` : `\nOK: setup and mock scheduling checks passed; ${stats.length} tracks, ${stats.reduce((n, r) => n + r.count, 0)} scheduled steps, ${stats.reduce((n, r) => n + r.attempts, 0)} non-rest note attempts. This does not prove audible output.`);

process.exit(problems.length ? 1 : 0);
