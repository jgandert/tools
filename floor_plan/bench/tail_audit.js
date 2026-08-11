// Read-only second-decile quality audit for both maintained grid DSLs.
// Usage: bun bench/tail_audit.js [seed...]
import { readFileSync } from "fs";
import { parseDSL } from "../parser.js";
import { optimizeGrid, _internals as I } from "../grid_optimizer.js";
import { GridGeom, computeMetrics } from "./interest_report.js";

const DEFAULT_DSL_PATHS = ["bench/user_one_hall.dsl", "bench/user.dsl"];
const STAGE_ORDER = ["growth", "repair", "rectify", "coarse-best", "refine-1", "refine-2"];
const AREA_MISS = 0.25;
const BLOAT_MISS = 1.5;

const argv = process.argv.slice(2);
const selectedDsl = argv.indexOf("--dsl");
const DSL_PATHS = selectedDsl >= 0 ? [argv[selectedDsl + 1]] : DEFAULT_DSL_PATHS;
const args = argv.filter((value, index) => index !== selectedDsl && index !== selectedDsl + 1)
    .filter(value => !Number.isNaN(Number(value))).map(Number);
const seeds = args.length ? args : Array.from({ length: 20 }, (_, index) => index + 1);
if (seeds.length < 2) throw new Error("tail audit needs at least two seeds");
const split = Math.ceil(seeds.length / 2);

function cloneStage(state, activeIdxs) {
    return {
        state: { ...state, cells: state.cells.slice(), rooms: state.rooms.map(room => ({ ...room })) },
        activeIdxs: activeIdxs.slice(),
    };
}

function metrics(stage) {
    return computeMetrics(new GridGeom(stage.state, stage.activeIdxs), { total: 0, satisfied: 0, unsatisfiedList: [] });
}

function roomMisses(stage) {
    const value = metrics(stage);
    const out = new Map();
    for (const room of value.area.rooms) {
        if (room.dev > AREA_MISS) out.set(`area:${room.room}`, room.dev);
    }
    for (const room of value.area.hallways) {
        if (room.bloat > BLOAT_MISS) out.set(`bloat:${room.room}`, room.bloat);
    }
    for (const room of value.aspect) {
        if (room.violated) out.set(`aspect:${room.room}`, room.excess);
    }
    for (const room of value.sideMin) {
        if (room.violated) out.set(`side_min:${room.room}`, room.shortfall);
    }
    return out;
}

function stageSequence(stages) {
    const inside = [...stages.keys()].filter(stage => stage.startsWith("inside-"));
    return [...STAGE_ORDER, ...inside, "final-polish", "final"].filter(stage => stages.has(stage));
}

function attribution(stages, key) {
    const sequence = stageSequence(stages);
    let introduced = sequence[0];
    let previous = false;
    for (const stage of sequence) {
        const present = roomMisses(stages.get(stage)).has(key);
        if (present && !previous) introduced = stage;
        previous = present;
    }
    return introduced;
}

function qualityShapeImproves(candidate, current) {
    return candidate.sideViolations < current.sideViolations
        || candidate.aspectViolations < current.aspectViolations;
}

function singleAndCompoundReachability(stage) {
    const { state, activeIdxs } = stage;
    const saved = state.cells.slice();
    const current = I.finalPolishQuality(state, activeIdxs);
    const groups = I.finalPolishGroups(state, activeIdxs);
    const singles = I.finalPolishSlideCandidates(state, activeIdxs, groups, undefined, saved);
    let single = 0;
    const participants = new Set();
    for (const candidate of singles) {
        state.cells.set(candidate.cells);
        candidate.quality.requiredViolations = I.deliveredRequiredViolationCount(state, activeIdxs);
        if (qualityShapeImproves(candidate.quality, current)
            && I.compareFinalPolishQuality(candidate.quality, current) < 0) {
            single++;
            for (let index = 0; index < saved.length; index++) {
                if (saved[index] === candidate.cells[index]) continue;
                if (saved[index] >= 0) participants.add(state.rooms[saved[index]].id);
                if (candidate.cells[index] >= 0) participants.add(state.rooms[candidate.cells[index]].id);
            }
        }
    }
    state.cells.set(saved);
    const compound = I.bestCompoundFinalPolishCandidate(state, activeIdxs, groups, undefined, current, saved, singles);
    if (compound && qualityShapeImproves(compound.quality, current)) {
        for (let index = 0; index < saved.length; index++) {
            if (saved[index] === compound.cells[index]) continue;
            if (saved[index] >= 0) participants.add(state.rooms[saved[index]].id);
            if (compound.cells[index] >= 0) participants.add(state.rooms[compound.cells[index]].id);
        }
    }
    state.cells.set(saved);
    return { single, compound: compound && qualityShapeImproves(compound.quality, current) ? 1 : 0, participants };
}

function adjacent(state, a, b) {
    return I.collectStats(state).sharedLen(a, b) > 0;
}

function clusterExtent(state, members) {
    const extents = members.map(room => I.roomExtent(state, room));
    return {
        x0: Math.min(...extents.map(e => e.x0)), x1: Math.max(...extents.map(e => e.x1)),
        y0: Math.min(...extents.map(e => e.y0)), y1: Math.max(...extents.map(e => e.y1)),
    };
}

function rectangularUnion(state, members) {
    const extent = clusterExtent(state, members);
    const allowed = new Set(members);
    for (let y = extent.y0; y <= extent.y1; y++) {
        for (let x = extent.x0; x <= extent.x1; x++) {
            if (!allowed.has(state.cells[y * state.W + x])) return null;
        }
    }
    return extent;
}

function connectedCluster(state, members) {
    const seen = new Set([members[0]]);
    while (true) {
        const found = members.find(room => !seen.has(room) && [...seen].some(other => adjacent(state, room, other)));
        if (found === undefined) break;
        seen.add(found);
    }
    return seen.size === members.length;
}

function combinations(items, size, start = 0, prefix = [], out = []) {
    if (prefix.length === size) {
        out.push(prefix.slice());
        return out;
    }
    for (let index = start; index <= items.length - (size - prefix.length); index++) {
        prefix.push(items[index]);
        combinations(items, size, index + 1, prefix, out);
        prefix.pop();
    }
    return out;
}

function permutations(items) {
    if (items.length < 2) return [items];
    const out = [];
    for (let index = 0; index < items.length; index++) {
        const rest = items.slice(0, index).concat(items.slice(index + 1));
        for (const tail of permutations(rest)) out.push([items[index], ...tail]);
    }
    return out;
}

function cutCandidates(low, high, share) {
    const span = high - low + 1;
    if (span <= 10) return Array.from({ length: span - 1 }, (_, index) => low + index);
    const ideal = low + span * share - 1;
    return [...new Set([Math.floor(ideal) - 1, Math.floor(ideal), Math.ceil(ideal), Math.ceil(ideal) + 1])]
        .filter(cut => cut >= low && cut < high);
}

function* guillotineAssignments(extent, order, quotas) {
    if (order.length === 1) {
        yield { regions: [{ ...extent, room: order[0] }] };
        return;
    }
    for (let count = 1; count < order.length; count++) {
        for (const axis of ["x", "y"]) {
            const low = axis === "x" ? extent.x0 : extent.y0;
            const high = axis === "x" ? extent.x1 : extent.y1;
            const leftQuota = order.slice(0, count).reduce((sum, room) => sum + quotas.get(room), 0);
            const totalQuota = order.reduce((sum, room) => sum + quotas.get(room), 0);
            for (const cut of cutCandidates(low, high, leftQuota / totalQuota)) {
                const first = axis === "x" ? { ...extent, x1: cut } : { ...extent, y1: cut };
                const second = axis === "x" ? { ...extent, x0: cut + 1 } : { ...extent, y0: cut + 1 };
                for (const left of guillotineAssignments(first, order.slice(0, count), quotas)) {
                    for (const right of guillotineAssignments(second, order.slice(count), quotas)) {
                        yield { regions: left.regions.concat(right.regions) };
                    }
                }
            }
        }
    }
}

function paintAssignment(state, assignment) {
    for (const region of assignment.regions) {
        for (let y = region.y0; y <= region.y1; y++) {
            for (let x = region.x0; x <= region.x1; x++) state.cells[y * state.W + x] = region.room;
        }
    }
}

function macroReachability(stage) {
    const { state, activeIdxs } = stage;
    const saved = state.cells.slice();
    const current = I.finalPolishQuality(state, activeIdxs);
    const groups = I.finalPolishGroups(state, activeIdxs);
    const quotas = new Map(activeIdxs.map(room => [room, state.rooms[room].quota]));
    let clusters = 0;
    let examined = 0;
    let viable = null;
    for (const group of groups) {
        for (let size = 2; size <= Math.min(4, group.length); size++) {
            for (const members of combinations(group, size)) {
                if (!connectedCluster(state, members)) continue;
                const extent = rectangularUnion(state, members);
                if (!extent) continue;
                clusters++;
                for (const order of permutations(members)) {
                    for (const assignment of guillotineAssignments(extent, order, quotas)) {
                        examined++;
                        state.cells.set(saved);
                        paintAssignment(state, assignment);
                        const candidate = I.finalPolishQuality(state, activeIdxs, false);
                        if (!qualityShapeImproves(candidate, current)) continue;
                        candidate.requiredViolations = I.deliveredRequiredViolationCount(state, activeIdxs);
                        if (I.compareFinalPolishQuality(candidate, current) < 0) {
                            viable = { rooms: members.map(index => state.rooms[index].id), quality: candidate };
                            state.cells.set(saved);
                            return { clusters, viable, examined };
                        }
                    }
                }
            }
        }
    }
    state.cells.set(saved);
    return { clusters, viable, examined };
}

function roomClassifications(finalStage, finalMetrics, reach) {
    const { state } = finalStage;
    const intrinsic = new Set(finalMetrics.advisoryGeometry.intrinsic.map(item => item.room));
    const violated = new Set([
        ...finalMetrics.aspect.filter(item => item.violated).map(item => item.room),
        ...finalMetrics.sideMin.filter(item => item.violated).map(item => item.room),
    ]);
    const byId = new Map(state.rooms.map((room, index) => [room.id, { room, index }]));
    return [...violated].map(id => {
        if (intrinsic.has(id)) return `${id}=intrinsic-infeasibility`;
        const entry = byId.get(id);
        const hasRequired = entry?.room.rules.some(rule => rule.required || rule.externalTargets?.length);
        if (reach.participants.has(id)) return `${id}=search-cap-exhaustion`;
        if (hasRequired) return `${id}=required-contact-lock`;
        return `${id}=donor-geometry`;
    });
}

function aggregate(runs) {
    const values = runs.map(run => metrics(run.stages.get("final")));
    const area = values.flatMap(value => value.area.rooms.map(room => room.dev));
    const bloat = values.flatMap(value => value.area.hallways.map(room => room.bloat));
    return {
        areaMean: area.reduce((sum, value) => sum + value, 0) / area.length,
        areaWorst: Math.max(...area),
        bloatMean: bloat.reduce((sum, value) => sum + value, 0) / bloat.length,
        bloatWorst: Math.max(...bloat),
        aspect: values.reduce((sum, value) => sum + value.aspect.filter(room => room.violated).length, 0),
        aspectTotal: values.reduce((sum, value) => sum + value.aspect.length, 0),
        side: values.reduce((sum, value) => sum + value.sideMin.filter(room => room.violated).length, 0),
        sideTotal: values.reduce((sum, value) => sum + value.sideMin.length, 0),
    };
}

function fmt(value) {
    return value.toFixed(2);
}

for (const dslPath of DSL_PATHS) {
    const text = readFileSync(dslPath, "utf8");
    const runs = [];
    console.log(`\n=== ${dslPath} ===`);
    for (const seed of seeds) {
        const stages = new Map();
        const winningAttempts = new Map();
        const parsed = parseDSL(text);
        const result = optimizeGrid(parsed, {
            seed,
            stageHook(stage, attempt, state, activeIdxs) {
                const snapshot = cloneStage(state, activeIdxs);
                if (["growth", "repair", "rectify"].includes(stage)) {
                    if (!winningAttempts.has(attempt)) winningAttempts.set(attempt, new Map());
                    winningAttempts.get(attempt).set(stage, snapshot);
                    return;
                }
                stages.set(stage, snapshot);
            },
        });
        if (result.error) throw new Error(`${dslPath} seed ${seed}: ${result.error}`);
        for (const [stage, snapshot] of winningAttempts.get(result.attempt) || []) stages.set(stage, snapshot);
        const finalStage = stages.get("final");
        const finalMetrics = metrics(finalStage);
        const reach = singleAndCompoundReachability(finalStage);
        const macro = macroReachability(finalStage);
        const misses = roomMisses(finalStage);
        const detail = [...misses].map(([key]) => `${key}@${attribution(stages, key)}`).join(", ") || "none";
        const classes = roomClassifications(finalStage, finalMetrics, reach).join(", ") || "none";
        console.log(`seed ${seed}: misses ${detail}`);
        console.log(`  trapped ${classes}; reachable single ${reach.single}, compound ${reach.compound}, macro clusters ${macro.clusters}, viable ${macro.viable ? macro.viable.rooms.join("+") : "none"}, examined ${macro.examined}`);
        runs.push({ seed, stages, reach, macro });
    }
    for (const [label, selected] of [["first decile", runs.slice(0, split)], ["second decile", runs.slice(split)]]) {
        const value = aggregate(selected);
        console.log(`${label}: area ${fmt(value.areaMean)}/${fmt(value.areaWorst)}, bloat ${fmt(value.bloatMean)}x/${fmt(value.bloatWorst)}x, aspect ${value.aspect}/${value.aspectTotal}, side_min ${value.side}/${value.sideTotal}`);
    }
    const single = runs.reduce((sum, run) => sum + (run.reach.single > 0 ? 1 : 0), 0);
    const compound = runs.reduce((sum, run) => sum + (run.reach.compound > 0 ? 1 : 0), 0);
    const macro = runs.reduce((sum, run) => sum + (run.macro.viable ? 1 : 0), 0);
    console.log(`reachability: single-strip seeds ${single}/${runs.length}, two-strip seeds ${compound}/${runs.length}, neither ${runs.length - new Set(runs.filter(run => run.reach.single || run.reach.compound).map(run => run.seed)).size}/${runs.length}`);
    console.log(`macro viability: ${macro}/${runs.length} seeds have a 2-4 room rectangular cluster with a lexicographically improving legal guillotine repartition`);
    console.log(macro >= 8
        ? "recommendation: Task R viability gate passes; implement bounded macro-region repartition."
        : "recommendation: Task R viability gate fails; no worthwhile bounded macro-region repartition remains.");
}
