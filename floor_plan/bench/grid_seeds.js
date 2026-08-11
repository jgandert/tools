// Aggregate grid_optimizer metrics over seeds: required satisfaction, quota
// deviation, rect-ness of rect-flagged rooms, runtime.
// Usage: bun bench/grid_seeds.js [k=20 seeds...] (default seeds 1..20)
import { parseDSL } from "../parser.js";
import { optimizeGrid } from "../grid_optimizer.js";
import { readFileSync } from "fs";

const args = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
const seeds = args.length ? args : Array.from({ length: 20 }, (_, i) => i + 1);
const dsl = readFileSync(new URL("./user.dsl", import.meta.url), "utf8");

let reqSat = 0;
let reqTotal = 0;
let devSum = 0;
let devWorst = 0;
let nonRect = 0;
let rectTotal = 0;
let timeSum = 0;
const fails = [];

for (const seed of seeds) {
    const parsed = parseDSL(dsl);
    const t0 = performance.now();
    const res = optimizeGrid(parsed, { seed });
    timeSum += performance.now() - t0;
    if (res.error) {
        fails.push(`seed ${seed}: ${res.error}`);
        continue;
    }
    const { state, activeIdxs } = res;
    const sizes = new Array(state.rooms.length).fill(0);
    for (const c of state.cells) {
        if (c >= 0) sizes[c]++;
    }
    let req = 0;
    for (const r of activeIdxs) {
        for (const c of state.rooms[r].rules) {
            if (c.required) req++;
        }
        const room = state.rooms[r];
        const dev = Math.abs(sizes[r] - room.quota) / room.quota;
        devSum += dev;
        if (dev > devWorst) devWorst = dev;
        if (room.rect) {
            rectTotal++;
            let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
            for (let i = 0; i < state.cells.length; i++) {
                if (state.cells[i] !== r) continue;
                const x = i % state.W, y = (i / state.W) | 0;
                n++;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
            if (n !== (x1 - x0 + 1) * (y1 - y0 + 1)) {
                nonRect++;
                fails.push(`seed ${seed}: ${room.id} not rect (${n}/${(x1 - x0 + 1) * (y1 - y0 + 1)})`);
            }
        }
    }
    // inside-block parents (e.g. 'loud') own no cells once replaced by their
    // children in activeIdxs, but still carry their own required rules
    for (const room of state.rooms) {
        if (room.childIdxs) {
            req += room.rules.filter(c => c.required).length;
        }
    }
    reqTotal += req;
    reqSat += req - res.unsatisfied.length;
    if (res.unsatisfied.length) {
        fails.push(`seed ${seed}: unsat ${res.unsatisfied.join("; ")}`);
    }
}

console.log(`seeds: ${seeds.length}`);
console.log(`required: ${reqSat}/${reqTotal}`);
console.log(`avg quota dev: ${(devSum / (seeds.length * 14)).toFixed(3)}  worst: ${devWorst.toFixed(3)}`);
console.log(`non-rect rect-rooms: ${nonRect}/${rectTotal}`);
console.log(`avg runtime: ${(timeSum / seeds.length).toFixed(0)} ms`);
for (const f of fails) console.log("  " + f);
