#!/usr/bin/env bun
// Paired clean-read benchmark for SA move-neighborhood changes.
// Usage: BASE_PATH=<snapshot> [CANDIDATE_PATH=<optimizer>] bun bench/long_range_ab.js [seed...]
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE_PATH = process.env.BASE_PATH;
const CANDIDATE_PATH = process.env.CANDIDATE_PATH || path.join(ROOT, "sa_optimized.js");
const DEFAULT_SEEDS = [42, 43, 44, 45, 46, 47, 48, 49];

if (!BASE_PATH) {
    throw new Error("BASE_PATH must point to a pre-change optimizer snapshot");
}

const baseline = require(path.resolve(BASE_PATH));
const candidate = require(path.resolve(CANDIDATE_PATH));
const { parseDSL } = require(path.join(ROOT, "parser.js"));
const seeds = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : DEFAULT_SEEDS;

if (seeds.some(seed => !Number.isFinite(seed))) {
    throw new Error("Seeds must be finite numbers");
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dsl = html.match(/<textarea[^>]*id="rules-input"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
if (!dsl) {
    throw new Error("Could not find #rules-input in index.html");
}

function softenRequiredRules(modules) {
    return modules.map(module => ({
        ...module,
        rules: (module.rules ?? []).map(rule => ({ ...rule, required: false })),
    }));
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2) {
        return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

async function withoutLogs(run) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
        return await run();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
}

async function measure(optimizer, modules, config, seed) {
    const started = performance.now();
    const result = await withoutLogs(() => optimizer.wongLiuSimulatedAnnealing(modules, {
        ...config,
        seed,
        k: 2,
        iter: 1,
        requiredMaxRetries: 0,
        disableWorkers: true,
    }));
    return {
        cost: result.cost,
        ms: performance.now() - started,
        unsatisfied: result.unsatisfied?.length ?? 0,
    };
}

function summarize(name, rows) {
    const baseCosts = rows.map(row => row.base.cost);
    const candidateCosts = rows.map(row => row.candidate.cost);
    const sum = values => values.reduce((total, value) => total + value, 0);
    const baseAverage = sum(baseCosts) / rows.length;
    const candidateAverage = sum(candidateCosts) / rows.length;
    const result = {
        scenario: name,
        seeds: seeds.join("/"),
        runs: rows.length,
        baseAverage: Math.round(baseAverage),
        candidateAverage: Math.round(candidateAverage),
        averageDeltaPct: Number((((candidateAverage / baseAverage) - 1) * 100).toFixed(2)),
        baseMedian: Math.round(median(baseCosts)),
        candidateMedian: Math.round(median(candidateCosts)),
        wins: rows.filter(row => row.candidate.cost < row.base.cost).length,
        ties: rows.filter(row => row.candidate.cost === row.base.cost).length,
        losses: rows.filter(row => row.candidate.cost > row.base.cost).length,
        baseSatisfied: rows.filter(row => row.base.unsatisfied === 0).length,
        candidateSatisfied: rows.filter(row => row.candidate.unsatisfied === 0).length,
        baseUnsatisfiedTotal: sum(rows.map(row => row.base.unsatisfied)),
        candidateUnsatisfiedTotal: sum(rows.map(row => row.candidate.unsatisfied)),
        baseMs: Math.round(sum(rows.map(row => row.base.ms))),
        candidateMs: Math.round(sum(rows.map(row => row.candidate.ms))),
    };
    console.log(`AGG ${JSON.stringify(result)}`);
}

async function runScenario(name, modules, config) {
    const rows = [];
    for (let index = 0; index < seeds.length; index++) {
        const seed = seeds[index];
        let baseResult;
        let candidateResult;
        if (index % 2 === 0) {
            baseResult = await measure(baseline, modules, config, seed);
            candidateResult = await measure(candidate, modules, config, seed);
        } else {
            candidateResult = await measure(candidate, modules, config, seed);
            baseResult = await measure(baseline, modules, config, seed);
        }
        rows.push({ seed, base: baseResult, candidate: candidateResult });
        console.log(`PAIR ${name} seed=${seed} base=${Math.round(baseResult.cost)}`
            + ` candidate=${Math.round(candidateResult.cost)}`
            + ` unsat=${baseResult.unsatisfied}/${candidateResult.unsatisfied}`);
    }
    summarize(name, rows);
}

async function main() {
    const parsed = parseDSL(dsl);
    await runScenario("default-required", parsed.modules, parsed.config);
    await runScenario("default-softened", softenRequiredRules(parsed.modules), parsed.config);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
