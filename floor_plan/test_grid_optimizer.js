// Tests for grid_optimizer.js — run with: bun test_grid_optimizer.js
import { parseDSL } from "./parser.js";
import { optimizeGrid, _internals as I } from "./grid_optimizer.js";
import { readFileSync } from "fs";

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(msg);
        console.log(`  FAIL: ${msg}`);
    }
}

// Build a small state by painting rows of room indices (-1 = free).
function paint(rows, rooms) {
    const H = rows.length;
    const W = rows[0].length;
    const state = I.makeState(W, H, 100, 100, rooms);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            state.cells[y * W + x] = rows[y][x];
        }
    }
    return state;
}

function mkRooms(n, quota = 4) {
    return Array.from({ length: n }, (_, i) => ({
        id: `r${i}`, index: i, area: 100, quota, ratioMax: 0, sideMin: 0,
        rect: true, parent: -1, rules: [],
    }));
}

// =============================================================================
// geometry helpers
// =============================================================================
console.log("\n=== geometry helpers ===");
{
    const rooms = mkRooms(2);
    const state = paint([
        [0, 0, 1],
        [0, 0, 1],
        [0, -1, 1],
    ], rooms);

    const e0 = I.roomExtent(state, 0);
    assert(e0.size === 5 && e0.x0 === 0 && e0.x1 === 1 && e0.y0 === 0 && e0.y1 === 2, "roomExtent: size and bbox");
    assert(e0.bboxArea === 6, "roomExtent: bboxArea");
    assert(!I.isRectangle(state, 0), "isRectangle: L-shape is not a rectangle");
    assert(I.isRectangle(state, 1), "isRectangle: 1x3 column is a rectangle");
}

// =============================================================================
// claimCell
// =============================================================================
console.log("\n=== claimCell ===");
{
    const rooms = mkRooms(2);
    const state = paint([
        [0, -1, 1],
        [0, -1, 1],
    ], rooms);

    assert(I.claimCell(state, 1, 0), "claimCell: free cell adjacent to room claimed");
    assert(state.cells[1] === 0, "claimCell: ownership updated");
    assert(!I.claimCell(state, 5, 0), "claimCell: cell not adjacent to room refused");

    // taking the target's last cell must fail (donor would vanish)
    const state2 = paint([[0, 1]], mkRooms(2));
    assert(!I.claimCell(state2, 1, 0), "claimCell: last cell of another room refused");
}

// =============================================================================
// rectifyRoom
// =============================================================================
console.log("\n=== rectifyRoom ===");
{
    // room 0 is an L; the notch belongs to free-shape room 1
    const rooms = mkRooms(2, 4);
    rooms[1].rect = false;
    const state = paint([
        [0, 0, 1, 1],
        [0, 1, 1, 1],
    ], rooms);

    const ok = I.rectifyRoom(state, 0, undefined, undefined, [0, 1]);
    assert(ok, "rectifyRoom: reports success");
    assert(I.isRectangle(state, 0), "rectifyRoom: L-shaped room becomes a rectangle");
    assert(I.isRectangle(state, 0) && I.roomExtent(state, 1).size > 0, "rectifyRoom: donor room still exists");

    // all rooms rect: full grid already rectangular stays untouched
    const rooms2 = mkRooms(2, 2);
    const state2 = paint([
        [0, 0, 1, 1],
        [0, 0, 1, 1],
    ], rooms2);
    const before = state2.cells.slice();
    I.rectify(state2, [0, 1]);
    assert(state2.cells.every((v, i) => v === before[i]), "rectify: already-rect layout unchanged");
}

// =============================================================================
// trySlide
// =============================================================================
console.log("\n=== trySlide ===");
{
    // room 0 (rect, starving: quota 6, size 2) next to free-shape room 1
    // (bloated: quota 2, size 6) — east grow should fire and improve cost
    const rooms = mkRooms(2);
    rooms[0].quota = 6;
    rooms[1].quota = 2;
    rooms[1].rect = false;
    const state = paint([
        [0, 1, 1, 1],
        [0, 1, 1, 1],
    ], rooms);

    const cost = I.softCost(state, [0, 1], undefined);
    const next = I.trySlide(state, 0, "east", true, [0, 1], undefined, () => true, cost);
    assert(next !== null && next < cost, `trySlide: grow east accepted and improves cost (${cost.toFixed(2)} -> ${next?.toFixed(2)})`);
    assert(I.isRectangle(state, 0), "trySlide: grown room still rectangular");
    assert(I.roomExtent(state, 0).size === 4, "trySlide: grew by one full strip");

    // sliding into a wall returns null
    assert(I.trySlide(state, 0, "west", true, [0, 1], undefined, () => true, cost) === null, "trySlide: grow off-grid refused");

    // shrink that would empty the room returns null
    const rooms2 = mkRooms(2);
    const state2 = paint([[0, 1, 1]], rooms2);
    assert(I.trySlide(state2, 0, "east", false, [0, 1], undefined, () => true, 999) === null, "trySlide: shrink of 1-wide room refused");
}

// =============================================================================
// winning-layout shape polish
// =============================================================================
console.log("\n=== winning-layout shape polish ===");
{
    const oneHall = readFileSync(new URL("./bench/user_one_hall.dsl", import.meta.url), "utf8");
    const stages = {};
    const res = optimizeGrid(parseDSL(oneHall), {
        seed: 6,
        stageHook(stage, _attempt, state, activeIdxs) {
            if (stage === "inside-loud" || stage === "final-polish") {
                stages[stage] = I.finalPolishQuality(state, activeIdxs);
            }
        },
    });
    assert(!res.error, "shape polish: one-hall fixture solves");
    assert(stages["inside-loud"].sideViolations === 4 && stages["final-polish"].sideViolations === 1,
        `shape polish: side violations improve 4 -> 1 (got ${stages["inside-loud"].sideViolations} -> ${stages["final-polish"].sideViolations})`);
    assert(stages["final-polish"].aspectViolations <= stages["inside-loud"].aspectViolations,
        "shape polish: aspect violations do not regress after higher-priority side improvement");
    assert(stages["final-polish"].requiredViolations === 0 && stages["final-polish"].nonRect === 0,
        "shape polish: required rules and rectangularity remain intact");
}
{
    const defaultDsl = readFileSync(new URL("./bench/user.dsl", import.meta.url), "utf8");
    let before;
    let after;
    const res = optimizeGrid(parseDSL(defaultDsl), {
        seed: 10,
        stageHook(stage, _attempt, state) {
            if (stage === "inside-loud") before = state.cells.slice();
            if (stage === "final-polish") after = state.cells.slice();
        },
    });
    assert(!res.error, "shape polish: default fixture solves");
    assert(after.every((owner, idx) => owner === before[idx]),
        "shape polish: multi-hall layout stays unchanged");
}
{
    const oneHall = readFileSync(new URL("./bench/user_one_hall.dsl", import.meta.url), "utf8");
    const stages = {};
    const res = optimizeGrid(parseDSL(oneHall), {
        seed: 2,
        stageHook(stage, _attempt, state, activeIdxs) {
            if (stage === "inside-loud" || stage === "final-polish") {
                stages[stage] = I.finalPolishQuality(state, activeIdxs);
            }
        },
    });
    assert(!res.error, "compound polish: one-hall fixture solves");
    assert(stages["inside-loud"].sideViolations === 7 && stages["final-polish"].sideViolations === 6,
        `compound polish: paired strips escape single-move minimum 7 -> 6 (got ${stages["inside-loud"].sideViolations} -> ${stages["final-polish"].sideViolations})`);
    assert(stages["final-polish"].aspectViolations <= stages["inside-loud"].aspectViolations,
        "compound polish: aspect violations do not regress");
    assert(stages["final-polish"].requiredViolations === 0 && stages["final-polish"].nonRect === 0,
        "compound polish: required rules and rectangularity remain intact");
    const res2 = optimizeGrid(parseDSL(oneHall), { seed: 2 });
    assert(res2.state.cells.every((owner, idx) => owner === res.state.cells[idx]),
        "compound polish: same seed reproduces identical layout");
}

// =============================================================================
// end-to-end: bench/user.dsl
// =============================================================================
console.log("\n=== end-to-end bench/user.dsl ===");
{
    const dsl = readFileSync(new URL("./bench/user.dsl", import.meta.url), "utf8");
    const parsed = parseDSL(dsl);
    assert(parsed.errors.length === 0, "user.dsl parses without errors");

    const res = optimizeGrid(parsed, { seed: 10 });
    assert(!res.error, "optimizeGrid returns a layout");
    assert(res.unsatisfied.length === 0, `all required rules satisfied (unsat: ${res.unsatisfied.join("; ")})`);

    const { state, activeIdxs } = res;

    // 'loud' is replaced by its children in activeIdxs but still carries its
    // own required rule ('[all but ...] connect any hallways required'),
    // reported via the children's cell union — 23 required rules in the DSL,
    // not 22
    const totalRequired = state.rooms.reduce((s, room, r) =>
        (activeIdxs.includes(r) || room.childIdxs) ? s + room.rules.filter(c => c.required).length : s, 0);
    assert(totalRequired === 23, `parent's own required rule is counted (got ${totalRequired}/23)`);

    // loud's own connect rule keeps its pre-bump cwl (config cwl 125) in
    // origCwl for the union re-check, alongside the bumped cwl (3 ext-kid
    // children * 125 = 375) that the outer solve uses to reserve frontage
    const loudRule = state.rooms.find(r => r.id === "loud").rules.find(c => c.kind === "connect" && c.required);
    assert(loudRule.origCwl === 125 && loudRule.cwl === 375,
        `loud's connect keeps original cwl 125 alongside bumped 375 (got ${loudRule.origCwl}/${loudRule.cwl})`);

    // full coverage: every cell owned by an active room
    const activeSet = new Set(activeIdxs);
    let covered = true;
    for (const c of state.cells) {
        if (!activeSet.has(c)) {
            covered = false;
        }
    }
    assert(covered, "every grid cell belongs to an active room");

    // every active room is connected
    const roomOk = activeIdxs.every(r => {
        const cellsOf = [];
        for (let i = 0; i < state.cells.length; i++) {
            if (state.cells[i] === r) cellsOf.push(i);
        }
        if (!cellsOf.length) return false;
        const seen = new Set([cellsOf[0]]);
        const queue = [cellsOf[0]];
        const set = new Set(cellsOf);
        while (queue.length) {
            const cur = queue.pop();
            for (const o of [cur - 1, cur + 1, cur - state.W, cur + state.W]) {
                if (set.has(o) && !seen.has(o) &&
                    !(o === cur - 1 && cur % state.W === 0) &&
                    !(o === cur + 1 && o % state.W === 0)) {
                    seen.add(o);
                    queue.push(o);
                }
            }
        }
        return seen.size === cellsOf.length;
    });
    assert(roomOk, "every active room is non-empty and connected");

    // largest inside-child quota share, established before the inside solve
    const loud = state.rooms.find(r => r.id === "loud");
    assert(Math.abs(loud.extKidTopShare - 1 / 3) < 1e-9,
        `loud's three equal children give a top share of 1/3 (got ${loud.extKidTopShare})`);
    assert(Array.isArray(loud.childIdxs) && loud.childIdxs.length === 3,
        "loud is marked as a replaced parent with 3 children");

    // shape defaults: hubs free, everything else rect
    const hallways = state.rooms.filter(r => r.id.startsWith("hallway"));
    assert(hallways.every(r => !r.rect), "hallways default to free shape");
    const office = state.rooms.find(r => r.id === "office");
    assert(office.rect === true, "non-hub rooms default to rect");

    // determinism: same seed, same cells
    const res2 = optimizeGrid(parseDSL(dsl), { seed: 10 });
    assert(res2.state.cells.every((v, i) => v === state.cells[i]), "same seed reproduces identical layout");
}

// =============================================================================
// shapes free: polyomino mode
// =============================================================================
console.log("\n=== shapes free ===");
{
    const dsl = readFileSync(new URL("./bench/user.dsl", import.meta.url), "utf8");
    const parsed = parseDSL("shapes free\n" + dsl);
    assert(parsed.errors.length === 0, "user.dsl with 'shapes free' parses");
    const res = optimizeGrid(parsed, { seed: 10 });
    assert(!res.error, "shapes free: optimizeGrid returns a layout");
    assert(res.state.rooms.filter(r => r.parent === -1).every(r => !r.rect), "shapes free: every outer room is free-form");
}

// =============================================================================
// shape override
// =============================================================================
console.log("\n=== shape override ===");
{
    const dsl = `
canvas 1000x800
cwl 0
room A area=300000 shape=free
room B area=300000
room C area=200000 shape=rect
A connect B required
`;
    const parsed = parseDSL(dsl);
    assert(parsed.errors.length === 0, "override DSL parses");
    const res = optimizeGrid(parsed, { seed: 1 });
    assert(!res.error, "override: optimizeGrid returns a layout");
    const A = res.state.rooms.find(r => r.id === "A");
    const B = res.state.rooms.find(r => r.id === "B");
    const C = res.state.rooms.find(r => r.id === "C");
    assert(A.rect === false, "explicit shape=free wins over rect default");
    assert(B.rect === true && C.rect === true, "default and explicit rect resolved");
    assert(res.unsatisfied.length === 0, "override: required connect satisfied");
    assert(I.isRectangle(res.state, B.index), "override: room B delivered rectangular");
    assert(I.isRectangle(res.state, C.index), "override: room C delivered rectangular");
}

// =============================================================================
// required rectangularity
// =============================================================================
console.log("\n=== required rectangularity ===");
{
    const dsl = `
algo grid
shape rect required
cwl 0
room A area=300000 shape=free
room B area=300000
room C area=200000 shape=rect
A connect B required
`;
    const parsed = parseDSL(dsl);
    assert(parsed.errors.length === 0, "global required-shape DSL parses");
    const res = optimizeGrid(parsed, { seed: 1 });
    assert(!res.error, "global required shape returns a layout");
    const A = res.state.rooms.find(r => r.id === "A");
    const requiredRooms = res.activeIdxs.filter(i => res.state.rooms[i].id !== "A");
    assert(A.rect === false && A.shapeRequired === false,
        "explicit shape=free overrides global required rectangle");
    assert(requiredRooms.every(i => res.state.rooms[i].shapeRequired),
        "global required rectangle marks non-free rooms hard");
    assert(I.requiredShapeViolations(res.state, requiredRooms).length === 0,
        "global required rectangle delivers hard rooms rectangular");
    assert(res.shapeUnsatisfied === 0 && res.unsatisfied.length === 0,
        "global required rectangle reports no satisfied constraint as unsatisfied");
}
{
    const parsed = parseDSL(`
algo grid
shapes free
room A area=300000 shape=rect:required
room B area=300000
`);
    const res = optimizeGrid(parsed, { seed: 3 });
    const A = res.state.rooms.find(r => r.id === "A");
    const B = res.state.rooms.find(r => r.id === "B");
    assert(A.rect && A.shapeRequired && I.isRectangle(res.state, A.index),
        "per-room rect:required overrides global free-form mode");
    assert(!B.rect && !B.shapeRequired, "legacy shapes free remains best-effort free-form mode");
}

// =============================================================================
// straight-run door width (connect satisfaction)
// =============================================================================
console.log("\n=== straight-run door width ===");
{
    // corner-wrapped contact: room0/room1 touch across 3 separate single-cell
    // edges (an L-shaped boundary) — sum = 300cm >= cwl 250, but no single
    // straight run is more than 1 cell (100cm) wide: no door fits
    const rooms = mkRooms(2);
    rooms[0].rules = [{ kind: "connect", required: true, subject: 0, targets: [1], externalTargets: [], any: false, cwl: 250, weight: 1 }];
    const state = paint([
        [0, 0, 1],
        [0, 1, 1],
    ], rooms);

    assert(I.straightSharedRun(state, 0, 1) === 1, "straightSharedRun: corner-wrapped contact longest run is 1 cell");
    const unsat = I.unsatisfiedRequired(state, undefined);
    assert(unsat.length === 1 && unsat[0].subject === 0, "corner-wrapped contact (sum >= cwl, run < cwl) is UNSATISFIED");
}
{
    // straight contact: room0/room1 share a full 3-cell-tall wall — run =
    // 300cm >= cwl 250, satisfied
    const rooms = mkRooms(2);
    rooms[0].rules = [{ kind: "connect", required: true, subject: 0, targets: [1], externalTargets: [], any: false, cwl: 250, weight: 1 }];
    const state = paint([
        [0, 1],
        [0, 1],
        [0, 1],
    ], rooms);

    assert(I.straightSharedRun(state, 0, 1) === 3, "straightSharedRun: straight contact longest run is 3 cells");
    const unsat = I.unsatisfiedRequired(state, undefined);
    assert(unsat.length === 0, "straight contact with run >= cwl is satisfied");
}
{
    // refine (subdivide-equivalent): halving cell size and doubling every
    // cell into a 2x2 block of the same owner must preserve the straight
    // run in cm (edge count doubles, cell size halves)
    const coarseRooms = mkRooms(2);
    const coarse = paint([
        [0, 1],
        [0, 1],
        [0, 1],
    ], coarseRooms);
    const coarseRunCm = I.straightSharedRun(coarse, 0, 1) * coarse.cellW;

    const fineRooms = mkRooms(2);
    const fine = I.makeState(4, 6, 50, 50, fineRooms);
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 2; x++) {
            const owner = coarse.cells[y * 2 + x];
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    fine.cells[(y * 2 + dy) * 4 + (x * 2 + dx)] = owner;
                }
            }
        }
    }
    const fineRunCm = I.straightSharedRun(fine, 0, 1) * fine.cellW;
    assert(I.straightSharedRun(fine, 0, 1) === I.straightSharedRun(coarse, 0, 1) * 2, "refine: run cell-count doubles");
    assert(fineRunCm === coarseRunCm, `refine preserves straight run in cm (coarse ${coarseRunCm}, fine ${fineRunCm})`);
}

// =============================================================================
// structured inside stripes
// =============================================================================
console.log("\n=== structured inside stripes ===");
{
    const state = paint([
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
        [0, 0, 1],
    ], mkRooms(2));
    const runs = {};
    I.longestAxisRun(state, (a, b) => state.cells[a] !== state.cells[b], runs);
    assert(runs.vRun === 4 && runs.vLo === 0 && runs.vHi === 3,
        "longestAxisRun: reports vertical run interval");
    assert(runs.hRun === 0 && runs.hLo === 0 && runs.hHi === -1,
        "longestAxisRun: empty horizontal run has an empty interval");
}
{
    const equal = I.bandLineCounts([16, 16, 16, 16, 16, 16, 16, 16, 16], [48, 48, 48], [3, 3, 3], 0, 8);
    assert(equal?.join(",") === "3,3,3", `bandLineCounts: equal quotas produce equal door-wide bands (got ${equal})`);

    const clamped = I.bandLineCounts([8, 8, 8, 8, 8, 8], [1, 4, 1], [2, 2, 2], 0, 5);
    assert(clamped?.every(count => count >= 2), `bandLineCounts: every door band stays inside frontage window (got ${clamped})`);

    const impossible = I.bandLineCounts([8, 8, 8, 8, 8], [1, 1, 1], [2, 2, 2], 0, 4);
    assert(impossible === null, "bandLineCounts: rejects frontage too short for all doors");
}
{
    const connected = paint([
        [0, 0, 1],
        [0, 1, 1],
    ], mkRooms(2));
    assert(I.regionConnected(connected, 0), "regionConnected: adjacent cells form one region");

    const split = paint([
        [0, 1, 0],
        [1, 1, 1],
    ], mkRooms(2));
    assert(!I.regionConnected(split, 0), "regionConnected: separated cells are rejected");
}
{
    const rooms = mkRooms(2, 6);
    const state = paint([
        [0, 0, 0, 1, 1, 1],
        [0, 0, 0, 1, 1, 1],
    ], rooms);
    const mask = new Set(state.cells.keys());
    const candidate = I.stripeCandidates(state, [0, 1], mask, {});
    assert(candidate?.unsat === 0 && candidate.ragged === 0 && candidate.balance === 0,
        "stripeCandidates: generates connected, rectangular, balanced bands");

    rooms[0].rules = [{ kind: "enclosed", required: true }];
    rooms[1].rules = [{ kind: "enclosed", required: true }];
    assert(I.stripeCandidates(state, [0, 1], mask, {}) === null,
        "stripeCandidates: rejects painted bands that violate per-cell legality");
}

// =============================================================================
// inside-block parent's own required rule, re-checked against child union
// =============================================================================
console.log("\n=== parent rule vs. children's cell union ===");
{
    // rooms 1 and 2 are children of an (unmodeled) parent; room 3 is the
    // outer target (e.g. a hallway). The parent's own connect rule uses the
    // union of its children's cells rather than its own (it owns none once
    // replaced in activeIdxs) — straight 3-cell run against room 3 satisfies
    // cwl 250 (300cm) even though neither child touches room 3 alone across
    // the whole run
    const rooms = mkRooms(4);
    const rule = { kind: "connect", required: true, subject: 0, targets: [3], externalTargets: [], any: false, cwl: 250, origCwl: 250, weight: 1 };
    const state = paint([
        [1, 1, 3],
        [1, 1, 3],
        [2, 2, 3],
    ], rooms);

    const union = I.unionCells(state, [1, 2]);
    assert(I.connectSatisfiedFromRegion(state, rule, union, undefined),
        "parent rule satisfied: children's union maintains a straight cwl-wide run to the target");
}
{
    // room 1 touches the target along a vertical wall (2 cells, 200cm);
    // room 2 touches it along a perpendicular horizontal wall elsewhere (2
    // cells, 200cm). Both contacts are real and door-sized at cwl 150, but
    // neither reaches cwl 250 alone, and — since the two runs are on
    // different axes and not collinear — the union doesn't combine them
    // into one longer run either (longest stays 2 cells): the parent rule
    // must report UNSATISFIED at cwl 250 even though 400cm of total contact
    // exists between the union and the target, split across the two children
    const rooms = mkRooms(4);
    const state = paint([
        [1, 1, 3, 3, 3],
        [1, 1, 3, 3, 3],
        [3, 3, 3, 2, 2],
    ], rooms);

    const union = I.unionCells(state, [1, 2]);
    assert(I.straightSharedRun(state, union, 3) === 2, "setup: union/target longest run is 2 cells (perpendicular contacts don't combine)");

    const ruleShort = { kind: "connect", required: true, subject: 0, targets: [3], externalTargets: [], any: false, cwl: 250, origCwl: 250, weight: 1 };
    assert(!I.connectSatisfiedFromRegion(state, ruleShort, union, undefined),
        "parent rule unsatisfied: children's union does not maintain a straight cwl-wide run to the target");

    const ruleOk = { ...ruleShort, cwl: 150, origCwl: 150 };
    assert(I.connectSatisfiedFromRegion(state, ruleOk, union, undefined),
        "sanity: the same union/target run satisfies a lower cwl (confirms the threshold, not just the run, drives the result)");
}

// =============================================================================
// Sufficient frontage condition for parents of hub-connected children
// =============================================================================

console.log("\n=== parent frontage sufficient condition ===");

// parent (room 0) is 6x3 at 100cm cells, hub (room 1) sits on part of its
// north side, room 2 fills the rest of that row. Three equal children, cwl
// 125: the old childCount*cwl demand is 375cm, the sufficient condition is
// (1 - 1/3) * 600 + 125 = 525cm.
function frontageFixture(hubCols) {
    const rooms = mkRooms(3);
    Object.assign(rooms[0], { extKidNeed: 375, extKidCwl: 125, extKidTopShare: 1 / 3 });
    rooms[1].isHub = true;
    const top = Array.from({ length: 6 }, (_, x) => x < hubCols ? 1 : 2);
    return paint([top, [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]], rooms);
}
{
    const state = frontageFixture(4);
    assert(I.straightHubRun(state, 0) === 400, "partial frontage: straight hub run is 400cm");
    assert(I.frontageShortfall(state, 0) === 125,
        `frontage run meeting childCount*cwl (375) still falls 125cm short of the sufficient 525 (got ${I.frontageShortfall(state, 0)})`);

    const breakdown = {};
    I.softCost(state, [0, 1, 2], undefined, breakdown);
    assert(breakdown["frontage:r0"] === undefined, "the childCount*cwl frontage term does not fire here");
    assert(breakdown["frontage_reach:r0"] > 0, "the sufficient-condition term prices the shortfall");
}
{
    const state = frontageFixture(6);
    assert(I.straightHubRun(state, 0) === 600, "full frontage: straight hub run is 600cm");
    assert(I.frontageShortfall(state, 0) === 0, "a run covering the whole slicing side has no shortfall");

    const breakdown = {};
    I.softCost(state, [0, 1, 2], undefined, breakdown);
    assert(breakdown["frontage_reach:r0"] === undefined, "no shortfall, no cost");
}
{
    // the children may slice along either axis: a parent whose frontage runs
    // along its short side is fine if that side is short enough to cover
    const rooms = mkRooms(3);
    Object.assign(rooms[0], { extKidNeed: 375, extKidCwl: 125, extKidTopShare: 1 / 3 });
    rooms[1].isHub = true;
    const state = paint([
        [1, 0, 0, 0, 0, 2],
        [1, 0, 0, 0, 0, 2],
        [1, 0, 0, 0, 0, 2],
        [1, 0, 0, 0, 0, 2],
    ], rooms);
    assert(I.frontageShortfall(state, 0) === 0,
        "frontage along the parent's full 400cm side satisfies the condition (need 391.7), even though slicing along the 600cm side would not");
}
{
    // an unequal split relaxes the condition: the largest child covers more
    // of the side, so less of it has to be frontage
    const equal = frontageFixture(4);
    const skewed = frontageFixture(4);
    skewed.rooms[0].extKidTopShare = 0.6;
    assert(I.frontageShortfall(skewed, 0) < I.frontageShortfall(equal, 0),
        "a larger dominant child lowers the frontage the parent must provide");
}

// =============================================================================
// Coarse attempt shortlist (two-phase selection)
// =============================================================================

console.log("\n=== coarse attempt shortlist ===");
{
    // the shortlist must keep the lexicographic best of everything it ever saw
    const attempts = [];
    for (let i = 0; i < 40; i++) {
        attempts.push({ unsat: i === 37 ? 0 : 1, ragged: 0, cost: 100 - i, attempt: i });
    }
    const pool = [];
    for (const a of attempts) {
        I.addCandidate(pool, a);
    }
    assert(pool.length === I.COARSE_SHORTLIST, `shortlist is capped at ${I.COARSE_SHORTLIST}`);
    assert(pool[0].attempt === 37, "shortlist head is the lexicographic best (unsat first)");

    const fullBest = attempts.slice().sort(I.compareCandidates)[0];
    assert(pool[0] === fullBest, "top-k selection agrees with scoring the whole pool");

    const shapeValid = { shapeUnsat: 0, unsat: 4, ragged: 0, cost: 100, attempt: 41 };
    const shapeInvalid = { shapeUnsat: 1, unsat: 1, ragged: 1, cost: 1, attempt: 42 };
    assert(I.compareCandidates(shapeValid, shapeInvalid) < 0,
        "required shape violation loses whenever a shape-valid candidate exists");
}
{
    // ties must break on attempt number, never on insertion order
    const a = { unsat: 0, ragged: 1, cost: 5, attempt: 9 };
    const b = { unsat: 0, ragged: 1, cost: 5, attempt: 3 };
    assert(I.compareCandidates(a, b) > 0 && I.compareCandidates(b, a) < 0, "equal keys break on attempt number");

    const forward = [];
    const backward = [];
    for (const c of [a, b]) I.addCandidate(forward, c);
    for (const c of [b, a]) I.addCandidate(backward, c);
    assert(forward[0].attempt === 3 && backward[0].attempt === 3, "shortlist order is insertion-independent");
}

// =============================================================================
// Hallway bloat / over-quota convexity in softCost
// =============================================================================

console.log("\n=== over-quota cost shape ===");
{
    // an area-less room (hallway) over quota must cost strictly more than an
    // area room with the same deviation — the hallway is where every
    // rectangularisation leftover lands, so it has to be the expensive sink
    const bloated = (areaLess) => {
        const rooms = mkRooms(2);
        rooms[0].area = areaLess ? 0 : 100;
        rooms[1].area = 100;
        rooms[0].quota = 2;
        rooms[1].quota = 6;
        const state = paint([
            [0, 0, 0, 1],
            [1, 1, 1, 1],
        ], rooms);
        const breakdown = {};
        I.softCost(state, [0, 1], undefined, breakdown);
        return breakdown.area;
    };
    assert(bloated(true) > bloated(false), "an over-quota hallway costs more than an over-quota room of the same deviation");
}
{
    // convexity: one room at 4x quota must cost more than two rooms at 2x
    const cost = (rows, quotas) => {
        const rooms = mkRooms(quotas.length);
        rooms.forEach((r, i) => { r.area = 100; r.quota = quotas[i]; });
        const breakdown = {};
        I.softCost(paint(rows, rooms), rooms.map((_, i) => i), undefined, breakdown);
        return breakdown.area;
    };
    const concentrated = cost([
        [0, 0, 0, 0],
        [1, 1, 2, 2],
    ], [1, 2, 2]);
    const spread = cost([
        [0, 0, 1, 1],
        [0, 0, 1, 1],
    ], [2, 2]);
    assert(concentrated > spread, "one badly bloated room costs more than two mildly bloated ones");
}

// =============================================================================
// compatibility filtering and warnings
// =============================================================================

console.log("\n=== compatibility filtering ===");
{
    const modules = [
        {
            id: "a",
            rules: [
                { type: "connect", target: "b", required: true, subjectAny: true, subjectGroupId: 7 },
                { type: "close", target: "outside", crossBoundary: true },
                { type: "connect", target: "b", required: true },
                { type: "mystery", target: "b" },
                { type: "connect", target: "missing", required: true },
            ],
        },
        {
            id: "b",
            rules: [
                { type: "connect", target: "a", subjectAny: true, subjectGroupId: 7 },
                { type: "far", target: "outside", crossBoundary: true },
            ],
        },
    ];
    const before = JSON.stringify(modules);
    const warnings = [];
    const rooms = I.compileRooms(modules, { cwl: 100 }, warnings);

    assert(warnings.filter(w => w.includes("any-subject")).length === 1,
        "any-subject group emits one deduplicated warning");
    assert(warnings.some(w => w.includes("cross-boundary close")) && warnings.some(w => w.includes("cross-boundary far")),
        "cross-boundary close and far emit accurate warnings");
    assert(warnings.some(w => w.includes("unknown rule kind 'mystery'")),
        "unknown programmatic rule kind emits warning");
    assert(warnings.some(w => w.includes("no known targets") && w.includes("was ignored")),
        "rule with only unknown targets is explicitly ignored");
    assert(rooms[0].rules.some(r => r.kind === "connect" && r.required),
        "supported connect rule is preserved");
    assert(!rooms.some(room => room.rules.some(r => ["close", "far", "mystery"].includes(r.kind))),
        "unsupported rules are omitted from compiled rooms");
    assert(rooms[0].rules.filter(r => r.kind === "connect").length === 1,
        "required rule with no known targets is not reported as satisfied");
    assert(JSON.stringify(modules) === before, "compatibility filtering does not mutate parser input");
}
{
    const modules = [{
        id: "child",
        rules: [
            { type: "at", dir: "north", required: true },
            { type: "not_at", dir: "south" },
            { type: "enclosed" },
            { type: "connect", target: "sibling", required: true },
        ],
    }, { id: "sibling", rules: [] }];
    const warnings = [];
    const rooms = I.compileRooms(modules, {}, warnings, { inside: true, scope: "parent" });

    assert(warnings.length === 3 && warnings.every(w => w.includes("was ignored")),
        "inside at, not_at, and enclosed each emit ignored warning");
    assert(rooms[0].rules.length === 1 && rooms[0].rules[0].kind === "connect",
        "inside wall rules are ignored while supported inside connect remains");
}
{
    const parsed = {
        config: { canvasW: 500, canvasH: 400, areaMin: 10, sideMax: 300, cwc: 2 },
        modules: [{
            id: "parent",
            ratio: 1.5,
            areaMin: 20,
            cwc: 3,
            rules: [],
            inside: {
                config: { canvasW: 100, areaMin: 5, sideMax: 50, cwc: 1 },
                modules: [{ id: "child", ratio: 2, rules: [] }],
            },
        }],
    };
    const warnings = [];
    I.warnIgnoredConfig(parsed, I.makeWarningSink(warnings));

    assert(warnings.length === 5, `ignored config settings warn once each across nested scopes (got ${warnings.length})`);
    assert(["canvas", "area_min", "side_max", "fixed room ratio", "cwc"].every(name => warnings.some(w => w.includes(name))),
        "ignored config warnings name every unsupported setting");
}

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
