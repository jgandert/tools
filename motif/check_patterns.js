// Inspects pattern arrays of a loaded song: hocket/theme gap alignment, lengths, ranges.

import { installMockAudioContext } from "./test/mock_webaudio.js";

installMockAudioContext({ verbose: false });

const motif = await import("./motif.js");
const { Motif, trackRegistry } = motif;
for (const name of ["Motif", "Track", "Bus", "Arrange", "Parallel", "Ramp", "Tie", "LFO", "SimplexNoise", "noteToMidi", "midiToNote", "midiToHz", "degreeToMidi", "parseDurationToFraction", "parseDurationToSeconds", "SCALES"]) {
    globalThis[name] = motif[name];
}
globalThis.AudioWorkletNode = class {
    constructor() {
        this.port = {
            postMessage() {
            },
        };
        this.parameters = {
            get: () => ({
                setValueAtTime() {
                }, linearRampToValueAtTime() {
                },
            }),
        };
    }

    connect() {
    }

    disconnect() {
    }
};

Motif.ctx = null;
Motif.init();

const source = await Bun.file(process.argv[2]).text();
const origWarn = console.warn;
console.warn = () => {
};
await new Function(`return (async () => {\n${source}\n})()`)();
console.warn = origWarn;

const pat = (id) => trackRegistry.get(id)._notePattern;

const theme = pat("theme_main");
const hocket = pat("theme_hocket");
const collisions = hocket.map((v, i) => (v !== null && theme[i] !== null ? i : null)).filter(v => v !== null);
console.log(`theme steps ${theme.length}, hocket steps ${hocket.length}`);
console.log(`hocket notes landing on theme notes: ${collisions.length ? collisions.join(",") : "none (pure hocket)"}`);

const numeric = (arr) => arr.filter(v => typeof v === "number");
for (const id of ["theme_main", "theme_dorian", "counter_line", "bass_groove", "bass_friction", "bass_climax", "cascade_arp", "cascade_crest", "stabs_groove", "stabs_climax", "flute_augmented", "outro_pickup"]) {
    const p = pat(id);
    const n = numeric(p);
    console.log(`${id.padEnd(16)} steps ${String(p.length).padStart(4)}  notes ${String(n.length).padStart(4)}  midi ${n.length ? Math.min(...n) + "-" + Math.max(...n) : "-"}`);
}

// Displacement check: THEME_DISPLACED must be THEME rotated by one step with D -> D#.
const dorian = pat("theme_dorian");
const rotated = [theme[theme.length - 1], ...theme.slice(0, -1)].map(v => (v === 74 ? 75 : v));
console.log(`displacement matches rotation+D#: ${JSON.stringify(dorian) === JSON.stringify(rotated)}`);
console.log(`dorian contains D natural (74): ${dorian.includes(74)}`);
