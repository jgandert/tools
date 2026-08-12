// Read-only per-stage quality report for grid optimizer runs.
// Usage: bun bench/stage_quality.js [--dsl <file>] [--thorough] [seed...]
import { readFileSync } from "fs";
import { parseDSL } from "../parser.js";
import { optimizeGrid } from "../grid_optimizer.js";
import { GridGeom, computeMetrics } from "./interest_report.js";

const argv = process.argv.slice(2);
let dslPath = new URL("./user.dsl", import.meta.url);
let thorough = false;
const seeds = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dsl") dslPath = argv[++i];
    else if (argv[i] === "--thorough") thorough = true;
    else if (!Number.isNaN(Number(argv[i]))) seeds.push(Number(argv[i]));
}
if (!seeds.length) seeds.push(...Array.from({ length: 10 }, (_, i) => i + 1));

const dslText = readFileSync(dslPath, "utf8");
const stageResults = new Map();

function stageMetrics(state, activeIdxs) {
    const metrics = computeMetrics(new GridGeom(state, activeIdxs), {
        total: 0,
        satisfied: 0,
        unsatisfiedList: [],
    });
    return {
        area: metrics.area.rooms.map(room => room.dev),
        bloat: metrics.area.hallways.map(room => room.bloat),
        aspectViol: metrics.aspect.filter(room => room.violated).length,
        aspectTotal: metrics.aspect.length,
        sideViol: metrics.sideMin.filter(room => room.violated).length,
        sideTotal: metrics.sideMin.length,
        enclosedSat: metrics.soft.enclosed.filter(rule => rule.satisfied).length,
        enclosedTotal: metrics.soft.enclosed.length,
        farSat: metrics.soft.far.filter(rule => rule.satisfied).length,
        farTotal: metrics.soft.far.length,
        advisoryGeometry: metrics.advisoryGeometry,
    };
}

for (const seed of seeds) {
    const parsed = parseDSL(dslText);
    const byAttempt = new Map();
    const stages = new Map();
    const opts = {
        seed,
        stageHook(stage, attempt, state, activeIdxs) {
            const metrics = stageMetrics(state, activeIdxs);
            if (["growth", "repair", "rectify"].includes(stage)) {
                if (!byAttempt.has(attempt)) byAttempt.set(attempt, new Map());
                byAttempt.get(attempt).set(stage, metrics);
                return;
            }
            stages.set(stage, metrics);
        },
    };
    if (thorough) opts.lookahead = 999;
    const result = optimizeGrid(parsed, opts);
    if (result.error) throw new Error(`seed ${seed}: ${result.error}`);
    const winningAttempt = byAttempt.get(result.attempt);
    for (const stage of ["growth", "repair", "rectify"]) {
        if (winningAttempt?.has(stage)) stages.set(stage, winningAttempt.get(stage));
    }
    stageResults.set(seed, stages);
}

const availableStages = [...stageResults.values().next().value.keys()];
const refinements = availableStages.filter(stage => stage.startsWith("refine-"))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
const laterStages = availableStages.filter(stage => !["growth", "repair", "rectify", "coarse-best", "final"].includes(stage)
    && !stage.startsWith("refine-"));
const order = ["growth", "repair", "rectify", "coarse-best", ...refinements, ...laterStages];
order.push("final");

const fmt = value => Number.isFinite(value) ? value.toFixed(2) : "n/a";
console.log(`DSL: ${dslPath}`);
console.log(`Seeds: ${seeds.join(", ")}`);
console.log("stage          area mean/worst  bloat mean/worst  aspect       side_min     enclosed     far");
for (const stage of order) {
    const rows = [...stageResults.values()].map(stages => stages.get(stage)).filter(Boolean);
    if (!rows.length) continue;
    const area = rows.flatMap(row => row.area);
    const bloat = rows.flatMap(row => row.bloat);
    const sum = (key, suffix) => rows.reduce((total, row) => total + row[`${key}${suffix}`], 0);
    const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
    const worst = values => values.length ? Math.max(...values) : NaN;
    console.log(`${stage.padEnd(14)} ${fmt(mean(area))}/${fmt(worst(area))}`.padEnd(32)
        + `${fmt(mean(bloat))}/${fmt(worst(bloat))}`.padEnd(19)
        + `${sum("aspect", "Viol")}/${sum("aspect", "Total")}`.padEnd(13)
        + `${sum("side", "Viol")}/${sum("side", "Total")}`.padEnd(13)
        + `${sum("enclosed", "Sat")}/${sum("enclosed", "Total")}`.padEnd(13)
        + `${sum("far", "Sat")}/${sum("far", "Total")}`);
}

const finalRows = [...stageResults.entries()].map(([seed, stages]) => ({
    seed,
    metrics: stages.get("final"),
})).filter(row => row.metrics);
console.log("\nAdvisory geometry infeasibility and final delivery limitations:");
const intrinsic = finalRows[0]?.metrics.advisoryGeometry.intrinsic || [];
if (!intrinsic.length) console.log("  Intrinsic DSL exact-area conflicts: none detected.");
for (const item of intrinsic) {
    console.log(`  Intrinsic DSL exact-area conflict: ${item.path}; area ${item.area.toFixed(0)}cm², side_min ${item.sideMin.toFixed(1)}cm, ratio_max ${item.ratioMax ? item.ratioMax.toFixed(2) : "none"}; `
        + `minimum area ${item.minimumArea.toFixed(0)}cm², short by ${item.areaShortfall.toFixed(0)}cm² (${item.squareSideShortfall.toFixed(1)}cm per square side). Blocker: ${item.reason}.`);
}
const delivered = finalRows.flatMap(row => row.metrics.advisoryGeometry.delivered.map(item => ({
    ...item,
    seed: row.seed,
})));
if (!delivered.length) console.log("  Final delivered-layout side_min limitations: none.");
const deliveredByPath = new Map();
for (const item of delivered) {
    if (!deliveredByPath.has(item.path)) deliveredByPath.set(item.path, []);
    deliveredByPath.get(item.path).push(item);
}
for (const [path, items] of deliveredByPath) {
    const worst = items.reduce((a, b) => b.shortfall > a.shortfall ? b : a);
    const blocker = worst.kind === "delivered-containing-geometry"
        ? `delivered parent ${worst.parent} min side ${worst.parentMinSide.toFixed(1)}cm is below request`
        : "delivered cell allocation; no mathematical infeasibility proven";
    console.log(`  Final delivered limitation: ${path} misses side_min in ${items.length}/${finalRows.length} seeds; request area ${worst.area.toFixed(0)}cm², side_min ${worst.sideMin.toFixed(1)}cm, ratio_max ${worst.ratioMax ? worst.ratioMax.toFixed(2) : "none"}; `
        + `worst min side ${worst.minSide.toFixed(1)}cm, short by ${worst.shortfall.toFixed(1)}cm (seed ${worst.seed}). Blocker: ${blocker}.`);
}
