import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BlockTraceDiff } from "./block_trace_diff.js";

// Bounded, deterministic workloads. Timings are observations, never test gates.
// node benchmark_block_trace.mjs [--baseline PATH] [--only CASE] [--profile]
const args = process.argv.slice(2);
const option = name => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} requires a value`);
    return args[i + 1];
};
const baselinePath = option("--baseline");
const selected = option("--only");
const profile = args.includes("--profile");
const methods = ["_normalizeAndIntern", "_findAnchors", "_seedAndExpand", "_greedyMasking", "_fallbackDiffAndReassemble", "_presentOperations"];
const lines = n => Array.from({ length: n }, (_, i) => `line-${i}`);
const sharedLines = (n, seed) => Array.from({ length: n }, () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return `shared-${seed >>> 27}`;
});
const cases = [
    { name: "identical-unique", source: lines(20000), target: lines(20000) },
    { name: "sparse-edits", source: lines(20000), target: lines(20000).map((line, i) => i % 1000 === 500 ? `changed-${i}` : line) },
    { name: "many-small-gaps", source: Array.from({ length: 2000 }, (_, i) => [`A${i}`, `B${i}`, `old${i}`]).flat(), target: Array.from({ length: 2000 }, (_, i) => [`A${i}`, `B${i}`, `new${i}`]).flat(), options: { maxStitchGap: 0 } },
    { name: "reordered-blocks", source: lines(12000), target: lines(12000).slice(6000).concat(lines(12000).slice(0, 6000)) },
    { name: "large-k-grams", source: lines(6000), target: lines(6000).map((line, i) => i === 3000 ? "changed" : line), options: { kGramSize: 128 } },
    { name: "repetitive-lines", source: Array(20000).fill("repeat"), target: Array.from({ length: 20000 }, (_, i) => i === 10000 ? "changed" : "repeat") },
    { name: "unrelated", source: lines(1600), target: lines(1600).map(line => `other-${line}`), options: { maxOccurrences: 0 } },
    { name: "dense-shared-values", source: sharedLines(800, 0x12345678), target: sharedLines(800, 0x87654321), options: { maxOccurrences: 0 } },
    { name: "unbalanced", source: lines(4000), target: ["other", "line-2000", "last"], options: { maxOccurrences: 0 } },
];
if (selected && !cases.some(c => c.name === selected)) throw new Error(`Unknown case: ${selected}`);
const variants = baselinePath
    ? [["baseline", (await import(pathToFileURL(resolve(baselinePath)).href)).BlockTraceDiff], ["current", BlockTraceDiff]]
    : [["current", BlockTraceDiff]];
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];

console.log(JSON.stringify({ runtime: process.version, warmups: 2, samples: 5, unit: "milliseconds", comparisonOrder: "all variants warmed before measurement; interleaved rounds alternate variant order", profile: profile ? "inclusive phase times" : false }));
for (const workload of cases.filter(c => !selected || c.name === selected)) {
    const measurements = variants.map(([variant, Engine]) => ({
        variant, Engine, totals: [], phases: Object.fromEntries(methods.map(name => [name, []])),
    }));
    // Complete both warmup rounds for every implementation before measuring.
    // Alternating each round's order reduces systematic first/second-run bias.
    for (let iteration = -2; iteration < 5; iteration++) {
        const ordered = iteration % 2 === 0 ? measurements : [...measurements].reverse();
        for (const { Engine, totals, phases } of ordered) {
            const engine = new Engine({ skipWhitespaceOps: false, ...workload.options });
            const elapsed = Object.fromEntries(methods.map(name => [name, 0]));
            if (profile) {
                for (const name of methods) {
                    const original = engine[name];
                    engine[name] = function (...values) {
                        const start = performance.now();
                        try { return original.apply(this, values); }
                        finally { elapsed[name] += performance.now() - start; }
                    };
                }
            }
            const start = performance.now();
            const result = engine.diff(workload.source, workload.target);
            const total = performance.now() - start;
            // A bounded independent coverage check catches accidentally timing empty output.
            let sourceCount = 0, targetCount = 0;
            for (const op of result) {
                if (op.type === "EQUAL" || op.type === "REPLACE" || op.type === "DELETE") sourceCount++;
                if (op.type === "EQUAL" || op.type === "REPLACE" || op.type === "INSERT") targetCount++;
                if (op.type === "MOVE_FROM") sourceCount += op.srcEndLine - op.srcStartLine + 1;
                if (op.type === "MOVE_TO") targetCount += op.targetEndLine - op.targetStartLine + 1;
            }
            assert.equal(sourceCount, workload.source.length);
            assert.equal(targetCount, workload.target.length);
            if (iteration >= 0) {
                totals.push(total);
                for (const name of methods) phases[name].push(elapsed[name]);
            }
        }
    }
    for (const { variant, totals, phases } of measurements) {
        const measurement = { case: workload.name, variant, sourceLines: workload.source.length, targetLines: workload.target.length, medianMs: +median(totals).toFixed(3), minMs: +Math.min(...totals).toFixed(3), maxMs: +Math.max(...totals).toFixed(3), samplesMs: totals.map(value => +value.toFixed(3)) };
        if (profile) measurement.phases = Object.fromEntries(methods.map(name => [name, +median(phases[name]).toFixed(3)]));
        console.log(JSON.stringify(measurement));
    }
}
