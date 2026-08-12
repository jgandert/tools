#!/usr/bin/env bun
// Compares direct SA geometry with geometry delivered through optimizeParsed.
// Usage: bun bench/pipeline_audit.js [seed...]
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { parseDSL } = require(path.join(ROOT, "parser.js"));
const { wongLiuSimulatedAnnealing } = require(path.join(ROOT, "sa_optimized.js"));
const { optimizeParsed } = require(path.join(ROOT, "orchestrator.js"));

const DEFAULT_SEEDS = [42, 43, 44];
const EPSILON = 1e-6;

function parseSeeds(args) {
    if (!args.length) {
        return DEFAULT_SEEDS;
    }
    const seeds = args.map(Number);
    if (seeds.some(seed => !Number.isFinite(seed))) {
        throw new Error("Seeds must be finite numbers");
    }
    return seeds;
}

function readDefaultDsl() {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const match = html.match(/<textarea[^>]*id="rules-input"[^>]*>([\s\S]*?)<\/textarea>/);
    if (!match) {
        throw new Error("Could not find #rules-input in index.html");
    }
    return match[1].trim();
}

// Mirrors _runSingleSA's fill-in for rooms without an explicit area.
function effectiveModules(modules, config) {
    const effective = modules.map(module => ({ ...module }));
    let definedArea = 0;
    const missingArea = [];
    for (const module of effective) {
        if (module.area) {
            definedArea += module.area;
            continue;
        }
        if (module.w && module.h) {
            definedArea += module.w * module.h;
            continue;
        }
        missingArea.push(module);
    }
    if (!missingArea.length || !config.canvasW || !config.canvasH) {
        return effective;
    }
    const areaPerRoom = Math.max(10, config.canvasW * config.canvasH - definedArea) / missingArea.length;
    for (const module of missingArea) {
        module.area = areaPerRoom;
        module.ratioMax = Math.max(module.ratioMax || 0, 6);
    }
    return effective;
}

function emptyMetrics() {
    return {
        rooms: 0,
        aspectViol: 0,
        sideViol: 0,
        worstAspectExcess: 0,
        worstSideShort: 0,
        areaErr: 0,
        requiredUnsat: 0,
        requiredTotal: 0,
    };
}

function auditScope(modules, config, result) {
    const metrics = emptyMetrics();
    const byId = new Map(effectiveModules(modules, config).map(module => [module.id, module]));
    metrics.requiredUnsat = (result.unsatisfied ?? []).length;
    metrics.requiredTotal = modules.reduce((total, module) => {
        return total + (module.rules ?? []).filter(rule => rule.required).length;
    }, 0);

    for (const room of result.rooms) {
        const module = byId.get(room.id);
        if (!module) {
            continue;
        }
        const aspect = Math.max(room.w / room.h, room.h / room.w);
        const ratioMax = module.ratio ? Infinity : (module.ratioMax || config.ratioMax || 3);
        const sideMin = module.sideMin || (!config.sideMinFlexible && config.sideMin) || 0;
        const aspectExcess = aspect - ratioMax;
        const sideShort = sideMin - Math.min(room.w, room.h);
        metrics.rooms++;
        if (aspectExcess > EPSILON) {
            metrics.aspectViol++;
            metrics.worstAspectExcess = Math.max(metrics.worstAspectExcess, aspectExcess);
        }
        if (sideShort > EPSILON) {
            metrics.sideViol++;
            metrics.worstSideShort = Math.max(metrics.worstSideShort, sideShort);
        }
        metrics.areaErr += Math.abs(room.w * room.h - module.area);
    }
    return metrics;
}

function addMetrics(total, metrics) {
    total.rooms += metrics.rooms;
    total.aspectViol += metrics.aspectViol;
    total.sideViol += metrics.sideViol;
    total.worstAspectExcess = Math.max(total.worstAspectExcess, metrics.worstAspectExcess);
    total.worstSideShort = Math.max(total.worstSideShort, metrics.worstSideShort);
    total.areaErr += metrics.areaErr;
    total.requiredUnsat += metrics.requiredUnsat;
    total.requiredTotal += metrics.requiredTotal;
}

function auditPipelineScopes(modules, config, result, scopePath = "top") {
    const scopes = [{ path: scopePath, metrics: auditScope(modules, config, result) }];
    for (const room of result.rooms) {
        const module = modules.find(candidate => candidate.id === room.id);
        if (!module?.inside?.modules?.length || !room.inside) {
            continue;
        }
        const innerConfig = {
            ...module.inside.config,
            canvasW: room.w,
            canvasH: room.h,
        };
        scopes.push(...auditPipelineScopes(
            module.inside.modules,
            innerConfig,
            room.inside,
            `${scopePath}/${room.id}`,
        ));
    }
    return scopes;
}

function formatMetrics(metrics) {
    return `rooms=${metrics.rooms}`
        + ` aspect=${metrics.aspectViol} worstAspect=${metrics.worstAspectExcess.toFixed(2)}`
        + ` side=${metrics.sideViol} worstSide=${metrics.worstSideShort.toFixed(1)}cm`
        + ` areaErr=${(metrics.areaErr / 1e6).toFixed(3)}Mcm2`
        + ` required=${metrics.requiredUnsat}/${metrics.requiredTotal}`;
}

async function withoutOptimizerLogs(run) {
    const originalLog = console.log;
    console.log = () => {
    };
    try {
        return await run();
    } finally {
        console.log = originalLog;
    }
}

async function runSeed(dsl, seed) {
    const rawParsed = parseDSL(dsl);
    const raw = await withoutOptimizerLogs(() => wongLiuSimulatedAnnealing(
        rawParsed.modules,
        { k: 20, iter: 1, ...rawParsed.config, seed },
    ));
    const rawMetrics = auditScope(rawParsed.modules, rawParsed.config, {
        rooms: raw.layout,
        unsatisfied: raw.unsatisfied,
    });

    const shippedParsed = parseDSL(dsl);
    shippedParsed.config.seed = seed;
    const shipped = await withoutOptimizerLogs(() => optimizeParsed(shippedParsed));
    const shippedScopes = auditPipelineScopes(shippedParsed.modules, shippedParsed.config, shipped);
    const shippedTop = shippedScopes[0].metrics;
    const shippedInner = emptyMetrics();
    for (const scope of shippedScopes.slice(1)) {
        addMetrics(shippedInner, scope.metrics);
    }

    console.log(`SEED ${seed} RAW ${formatMetrics(rawMetrics)} | SHIPPED ${formatMetrics(shippedTop)}`);
    for (const scope of shippedScopes.slice(1)) {
        console.log(`  INNER ${scope.path} ${formatMetrics(scope.metrics)}`);
    }
    return { rawMetrics, shippedTop, shippedInner };
}

async function main() {
    const seeds = parseSeeds(process.argv.slice(2));
    const dsl = readDefaultDsl();
    const rawTotal = emptyMetrics();
    const shippedTopTotal = emptyMetrics();
    const shippedInnerTotal = emptyMetrics();
    for (const seed of seeds) {
        const result = await runSeed(dsl, seed);
        addMetrics(rawTotal, result.rawMetrics);
        addMetrics(shippedTopTotal, result.shippedTop);
        addMetrics(shippedInnerTotal, result.shippedInner);
    }
    console.log(`AGG RAW ${formatMetrics(rawTotal)} | SHIPPED ${formatMetrics(shippedTopTotal)}`);
    console.log(`AGG SHIPPED_INNER ${formatMetrics(shippedInnerTotal)}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
