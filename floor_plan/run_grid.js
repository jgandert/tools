// run_grid.js — run the grid optimizer on a DSL file and print the ASCII result.
// Usage: bun run_grid.js [dslFile] [--seed N] [--thorough]
// --thorough evaluates the whole attempt pool (~2-3x slower, better balance).
// Default DSL: bench/user.dsl

import { readFileSync } from "fs";
import { parseDSL } from "./parser.js";
import { optimizeGrid } from "./grid_optimizer.js";

const args = process.argv.slice(2);
let dslFile = `${import.meta.dir}/bench/user.dsl`;
let seed;
let lookahead;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed") {
        seed = parseInt(args[++i], 10);
    } else if (args[i] === "--thorough") {
        lookahead = 999;
    } else {
        dslFile = args[i];
    }
}

const dsl = readFileSync(dslFile, "utf8");
const parsed = parseDSL(dsl);

if (parsed.errors.length) {
    console.error("DSL errors:");
    for (const e of parsed.errors) {
        console.error("  " + e);
    }
    process.exit(1);
}
for (const w of parsed.warnings) {
    console.warn("DSL warning: " + w);
}

const t0 = performance.now();
const gridOpts = {};
if (seed !== undefined) gridOpts.seed = seed;
if (lookahead !== undefined) gridOpts.lookahead = lookahead;
const result = optimizeGrid(parsed, gridOpts);
const ms = (performance.now() - t0).toFixed(0);

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

for (const w of result.warnings) {
    console.warn("grid warning: " + w);
}
console.log(result.ascii);
console.log(`\nCoarse attempt used: ${result.attempt}, runtime ${ms} ms`);
if (result.unsatisfied.length) {
    console.log("UNSATISFIED: " + result.unsatisfied.join("; "));
}
