// Read-only feasibility probe for delivered-layout shared-frontage exchanges.
// Usage: bun bench/shared_frontage_probe.js [seed...]
import { readFileSync } from "fs";
import { parseDSL } from "../parser.js";
import { optimizeGrid, _internals as I } from "../grid_optimizer.js";

const DEFAULT_DSL_PATHS = ["bench/user.dsl", "bench/user_one_hall.dsl"];
const DIRS = ["north", "south", "east", "west"];
const MAX_DEPTH = 3;
const argv = process.argv.slice(2);
const selectedDsl = argv.indexOf("--dsl");
const DSL_PATHS = selectedDsl >= 0 ? [argv[selectedDsl + 1]] : DEFAULT_DSL_PATHS;
const seedArgs = selectedDsl >= 0
    ? argv.filter((value, index) => index !== selectedDsl && index !== selectedDsl + 1)
    : argv;
const seeds = seedArgs
    .filter(value => !Number.isNaN(Number(value))).map(Number);
if (!seeds.length) seeds.push(...Array.from({ length: 20 }, (_, index) => index + 1));

function cloneState(state) {
    return {
        ...state,
        cells: state.cells.slice(),
        rooms: state.rooms.map(room => ({ ...room, rules: room.rules })),
    };
}

function externalAdjacency(state, childIdxs) {
    const names = new Set();
    for (const childIdx of childIdxs) {
        for (const rule of state.rooms[childIdx].rules) {
            for (const name of rule.externalTargets || []) names.add(name);
        }
    }
    const out = {};
    for (const name of names) {
        const room = state.rooms.find(candidate => candidate.id === name && candidate.parent === -1);
        if (!room) continue;
        out[name] = new Set();
        for (let index = 0; index < state.cells.length; index++) {
            if (state.cells[index] === room.index) out[name].add(index);
        }
    }
    return out;
}

function externalUnion(extAdj) {
    const out = new Set();
    for (const cells of Object.values(extAdj)) {
        for (const index of cells) out.add(index);
    }
    return out;
}

function parentFrontage(state, parentIdx, extAdj, childIdxs) {
    const region = childIdxs
        ? I.unionCells(state, childIdxs)
        : new Set(state.cells.map((owner, index) => owner === parentIdx ? index : -1).filter(index => index >= 0));
    return I.straightSharedRun(state, region, externalUnion(extAdj));
}

function childQuality(state, childIdxs) {
    const stats = I.collectStats(state);
    const ratios = childIdxs.map(childIdx => stats.sizes[childIdx] / state.rooms[childIdx].quota);
    let aspect = 0;
    let side = 0;
    for (const childIdx of childIdxs) {
        const room = state.rooms[childIdx];
        const extent = stats.bbox[childIdx];
        const width = (extent.x1 - extent.x0 + 1) * state.cellW;
        const height = (extent.y1 - extent.y0 + 1) * state.cellH;
        if (room.ratioMax > 0 && Math.max(width, height) / Math.min(width, height) > room.ratioMax + 1e-6) aspect++;
        if (room.sideMin > 0 && Math.min(width, height) < room.sideMin - 1e-6) side++;
    }
    return {
        deviation: ratios.reduce((sum, ratio) => sum + Math.abs(ratio - 1), 0) / ratios.length,
        siblingRatio: Math.max(...ratios) / Math.min(...ratios),
        aspect,
        side,
    };
}

function deliveredAreaDeviation(state, activeIdxs) {
    const stats = I.collectStats(state);
    const values = activeIdxs.filter(roomIdx => state.rooms[roomIdx].area > 0).map(roomIdx => {
        const target = state.rooms[roomIdx].area / (state.cellW * state.cellH);
        return Math.abs(stats.sizes[roomIdx] / target - 1);
    });
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareChildQuality(a, b) {
    return (a.aspect - b.aspect)
        || (a.side - b.side)
        || (a.deviation - b.deviation)
        || (a.siblingRatio - b.siblingRatio);
}

function outerRules(state) {
    return state.rooms.flatMap(room => room.rules)
        .filter(rule => rule.required && state.rooms[rule.subject].parent === -1);
}

function certifiedStates(delivered, parentIdx, childIdxs) {
    const initial = cloneState(delivered);
    for (let index = 0; index < initial.cells.length; index++) {
        if (childIdxs.includes(initial.cells[index])) initial.cells[index] = parentIdx;
    }
    initial.rooms[parentIdx].childIdxs = undefined;
    const baselineCells = initial.cells.slice();
    const extAdj = externalAdjacency(initial, childIdxs);
    const baselineRun = parentFrontage(initial, parentIdx, extAdj);
    const active = state => state.rooms.filter(room => room.parent === -1).map(room => room.index);
    const rules = outerRules(initial);
    const allowFlip = (a, b) => initial.rooms[a]?.parent === -1 && initial.rooms[b]?.parent === -1;
    const queue = [{ cells: baselineCells, depth: 0, moves: [] }];
    const seen = new Set([baselineCells.join(",")]);
    const certified = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const entry = queue[cursor];
        initial.cells.set(entry.cells);
        if (entry.depth > 0) {
            const candidateAdj = externalAdjacency(initial, childIdxs);
            const run = parentFrontage(initial, parentIdx, candidateAdj);
            if (run > baselineRun && I.deliveredRequiredViolationCount(initial, active(initial)) === 0) {
                certified.push({ cells: initial.cells.slice(), run, moves: entry.moves });
            }
        }
        if (entry.depth === MAX_DEPTH) continue;
        for (const dir of DIRS) {
            for (const grow of [true, false]) {
                initial.cells.set(entry.cells);
                const stats = I.collectStats(initial);
                if (I.trySlide(initial, parentIdx, dir, grow, active(initial), undefined, allowFlip,
                    Infinity, stats, new Map(), rules) === null) continue;
                const key = initial.cells.join(",");
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push({
                    cells: initial.cells.slice(),
                    depth: entry.depth + 1,
                    moves: entry.moves.concat(`loud:${grow ? "grow" : "shrink"}:${dir}`),
                });
            }
        }
    }
    initial.cells.set(baselineCells);
    return { initial, baselineRun, certified, explored: seen.size };
}

function repaintChildren(state, parentIdx, childIdxs) {
    const mask = new Set();
    for (let index = 0; index < state.cells.length; index++) {
        if (state.cells[index] === parentIdx) {
            mask.add(index);
            state.cells[index] = -1;
        }
    }
    const quota = mask.size / childIdxs.length;
    for (const childIdx of childIdxs) state.rooms[childIdx].quota = quota;
    const extAdj = externalAdjacency(state, childIdxs);
    const stripe = I.stripeCandidates(state, childIdxs, mask, extAdj);
    if (!stripe || stripe.unsat || stripe.ragged) return null;
    state.cells.set(stripe.cells);
    const siblingFlip = (a, b) => state.rooms[a].parent === parentIdx && state.rooms[b].parent === parentIdx;
    I.optimizeBoundary(state, childIdxs, extAdj, siblingFlip);
    return childQuality(state, childIdxs);
}

function probeRun(result) {
    const delivered = result.state;
    const parentIdx = delivered.rooms.findIndex(room => room.inside && room.childIdxs?.length);
    if (parentIdx < 0) throw new Error("no delivered inside parent");
    const childIdxs = delivered.rooms[parentIdx].childIdxs;
    const baseline = childQuality(delivered, childIdxs);
    const baselineArea = deliveredAreaDeviation(delivered, result.activeIdxs);
    const baselineFull = I.finalPolishQuality(delivered, result.activeIdxs);
    const search = certifiedStates(delivered, parentIdx, childIdxs);
    const savedQuotas = childIdxs.map(childIdx => delivered.rooms[childIdx].quota);
    let best = null;
    let valid = 0;
    const eligible = [];
    for (const certificate of search.certified) {
        const candidate = cloneState(search.initial);
        childIdxs.forEach((childIdx, index) => candidate.rooms[childIdx].quota = savedQuotas[index]);
        candidate.cells.set(certificate.cells);
        candidate.rooms[parentIdx].childIdxs = childIdxs.slice();
        const quality = repaintChildren(candidate, parentIdx, childIdxs);
        if (!quality) continue;
        const activeIdxs = result.activeIdxs.filter(roomIdx => !childIdxs.includes(roomIdx)).concat(childIdxs);
        if (I.deliveredRequiredViolationCount(candidate, activeIdxs) !== 0) continue;
        valid++;
        if (quality.aspect > baseline.aspect || quality.side > baseline.side) continue;
        if (quality.deviation >= baseline.deviation - 1e-9
            && quality.siblingRatio >= baseline.siblingRatio - 1e-9) continue;
        const area = deliveredAreaDeviation(candidate, activeIdxs);
        const full = I.finalPolishQuality(candidate, activeIdxs);
        eligible.push({ moves: certificate.moves, quality, area, full });
        if (!best || compareChildQuality(quality, best.quality) < 0) best = {
            ...certificate,
            quality,
            area,
            full,
        };
    }
    return { baseline, baselineArea, baselineFull, search, valid, best, eligible };
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

for (const dslPath of DSL_PATHS) {
    const text = readFileSync(dslPath, "utf8");
    const runs = [];
    console.log(`\n=== ${dslPath} ===`);
    for (const seed of seeds) {
        const result = optimizeGrid(parseDSL(text), { seed });
        if (result.error) throw new Error(`${dslPath} seed ${seed}: ${result.error}`);
        const run = probeRun(result);
        runs.push(run);
        const best = run.best;
        const shape = best ? `${run.baselineFull.sideViolations}/${run.baselineFull.aspectViolations} -> ${best.full.sideViolations}/${best.full.aspectViolations}` : "none";
        const bloat = best ? `${run.baselineFull.hallwayBloat.toFixed(2)} -> ${best.full.hallwayBloat.toFixed(2)}` : "none";
        console.log(`seed ${seed}: frontage ${run.search.baselineRun.toFixed(1)} -> ${best ? best.run.toFixed(1) : "none"}, explored ${run.search.explored}, certified ${run.search.certified.length}, valid ${run.valid}, area ${run.baselineArea.toFixed(3)} -> ${best ? best.area.toFixed(3) : "none"}, shape ${shape}, bloat ${bloat}, moves ${best ? best.moves.join(" + ") : "none"}`);
        if (seeds.length === 1) {
            for (const candidate of run.eligible) {
                console.log(`  option area ${candidate.area.toFixed(3)}, bloat ${candidate.full.hallwayBloat.toFixed(2)}, child ${candidate.quality.deviation.toFixed(3)}/${candidate.quality.siblingRatio.toFixed(3)}, shape ${candidate.full.sideViolations}/${candidate.full.aspectViolations}: ${candidate.moves.join(" + ")}`);
            }
        }
    }
    const available = runs.filter(run => run.valid);
    const viable = runs.filter(run => run.best);
    const baselineDeviation = mean(runs.map(run => run.baseline.deviation));
    const baselineRatio = mean(runs.map(run => run.baseline.siblingRatio));
    const candidateDeviation = mean(runs.map(run => run.best?.quality.deviation ?? run.baseline.deviation));
    const candidateRatio = mean(runs.map(run => run.best?.quality.siblingRatio ?? run.baseline.siblingRatio));
    const baselineAspect = runs.reduce((sum, run) => sum + run.baseline.aspect, 0);
    const baselineSide = runs.reduce((sum, run) => sum + run.baseline.side, 0);
    const candidateAspect = runs.reduce((sum, run) => sum + (run.best?.quality.aspect ?? run.baseline.aspect), 0);
    const candidateSide = runs.reduce((sum, run) => sum + (run.best?.quality.side ?? run.baseline.side), 0);
    console.log(`required-valid availability ${available.length}/${runs.length}; quality-eligible ${viable.length}/${runs.length}`);
    console.log(`child deviation ${baselineDeviation.toFixed(3)} -> ${candidateDeviation.toFixed(3)}, sibling ratio ${baselineRatio.toFixed(3)} -> ${candidateRatio.toFixed(3)}, aspect ${baselineAspect} -> ${candidateAspect}, side_min ${baselineSide} -> ${candidateSide}`);
}
