// bench/interest_report.js — "did the DELIVERED layout follow the user's DSL
// interests" report, in user-facing geometric terms (not optimizer score).
// Evaluates both optimizers on the same DSL through one backend-agnostic rule
// model + a small geometry-query abstraction (GridGeom / SaGeom), so every
// metric except D (rectangularity, grid-only concept) and E (each solver's
// own required-rule contract) is defined identically for both.
//
// Usage: bun bench/interest_report.js [--sa] [--thorough] [--dsl <file>] [seed...]
//   --sa         also run the SA optimizer (k=20, seeds 42 43 44 unless overridden)
//   --thorough   grid: opts.lookahead = 999
//   seed...      grid seeds (default 1..10); also overrides the SA seed list if given
import { readFileSync } from "fs";
import { createRequire } from "module";
import { parseDSL } from "../parser.js";
import { optimizeGrid, _internals } from "../grid_optimizer.js";

const require = createRequire(import.meta.url);

// mirrors grid_optimizer.js CIRCULATION_SHARE — used to give SA's hallways a
// comparable "expected" area even though SA never optimizes toward it
const CIRCULATION_SHARE = 0.07;
const WALL_EPS = 0.5; // cm tolerance for boundary-contact checks
const ADJ_EPS = 0.1;  // cm tolerance for shared-wall overlap checks

// ============================================================== CLI
const argv = process.argv.slice(2);
let dslPath = new URL("./user.dsl", import.meta.url);
let runSA = false;
let thorough = false;
const seedArgs = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sa") runSA = true;
    else if (a === "--thorough") thorough = true;
    else if (a === "--dsl") dslPath = argv[++i];
    else if (!Number.isNaN(Number(a))) seedArgs.push(Number(a));
}
const gridSeeds = seedArgs.length ? seedArgs : Array.from({ length: 10 }, (_, i) => i + 1);
const saSeeds = seedArgs.length ? seedArgs : [42, 43, 44];

const dslText = readFileSync(dslPath, "utf8");
const template = parseDSL(dslText);
if (template.errors.length) {
    console.error("DSL errors:\n  " + template.errors.join("\n  "));
    process.exit(1);
}

// ============================================================== rule/room model
// Flattened, backend-agnostic view of the DSL: every room (outer + inside
// children) and every rule, tagged with its subject id and (for children)
// parent id. Built once from a fresh parse — never mutated by either solver.
function collectRooms(modules, parent, out) {
    for (const m of modules) {
        const path = parent ? `${parent.path}/${m.id}` : m.id;
        const room = {
            id: m.id,
            path,
            parent: parent?.id || null,
            area: m.area || 0,
            ratioMax: m.ratioMax || 0,
            sideMin: m.sideMin || 0,
            hasChildren: !!m.inside,
        };
        out.push(room);
        if (m.inside) collectRooms(m.inside.modules, room, out);
    }
    return out;
}

function collectRules(modules, parent, out) {
    for (const m of modules) {
        for (const rule of m.rules || []) out.push({ subject: m.id, parent, rule });
        if (m.inside) collectRules(m.inside.modules, m.id, out);
    }
    return out;
}

const toArray = v => v === undefined ? [] : Array.isArray(v) ? v : [v];

const roomModel = collectRooms(template.modules, null, []);
const ruleModel = collectRules(template.modules, null, []);
const leafRooms = roomModel.filter(r => !r.hasChildren);
const areaRooms = leafRooms.filter(r => r.area > 0);
const hallwayRooms = leafRooms.filter(r => !r.area);
const REQ_AREA_SUM = areaRooms.reduce((s, r) => s + r.area, 0);
// grid_optimizer.js's computeQuotas sums TOP-LEVEL areas (parents, not their
// children) for the circulation share; REQ_AREA_SUM sums LEAF areas (children,
// not their parent). The two coincide on bench/user.dsl only because
// loud.area === sum(child areas) exactly — a different DSL would need this
// reconciled if the two sums diverge.
const CIRCULATION_TARGET_AREA = CIRCULATION_SHARE * REQ_AREA_SUM;
// DSL-declared required-rule count, including rules on parents-with-children
// (e.g. 'loud connect any hallways required'). The grid solver re-checks such
// a rule against the union of the parent's children's cells (grid_optimizer.js
// state.rooms[i].childIdxs / connectSatisfiedFromRegion) and reports it
// alongside the children's own rules, so runGridSeed's own `total` (below)
// matches this count. Kept as a sanity cross-check between the DSL and both
// backends' per-seed totals.
const FULL_REQUIRED_RULE_COUNT = ruleModel.filter(({ rule }) => rule.required).length;

// ============================================================== geometry helpers

// Longest run of consecutive shared-edge cells between rooms a/b along a
// single grid line (a straight wall segment survives coarsening/refinement
// intact; a corner-wrapped contact of the same summed length does not).
function longestStraightRun(state, a, b) {
    const { W, H, cells, cellW, cellH } = state;
    const touch = (p, q) => (p === a && q === b) || (p === b && q === a);

    let bestV = 0;
    for (let x = 0; x < W - 1; x++) {
        let run = 0;
        for (let y = 0; y < H; y++) {
            run = touch(cells[y * W + x], cells[y * W + x + 1]) ? run + 1 : 0;
            if (run > bestV) bestV = run;
        }
    }
    let bestH = 0;
    for (let y = 0; y < H - 1; y++) {
        let run = 0;
        for (let x = 0; x < W; x++) {
            run = touch(cells[y * W + x], cells[(y + 1) * W + x]) ? run + 1 : 0;
            if (run > bestH) bestH = run;
        }
    }
    return Math.max(bestV * cellH, bestH * cellW);
}

// Two axis-aligned rects always share a single contiguous interval (or none),
// so this doubles as both "shared length" and "straight run" for SA rooms.
function sharedWallRects(A, B) {
    const isHAdj = Math.abs(A.x + A.w - B.x) < ADJ_EPS || Math.abs(B.x + B.w - A.x) < ADJ_EPS;
    const vOv = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    const isVAdj = Math.abs(A.y + A.h - B.y) < ADJ_EPS || Math.abs(B.y + B.h - A.y) < ADJ_EPS;
    const hOv = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
    if (isHAdj && vOv > ADJ_EPS) return vOv;
    if (isVAdj && hOv > ADJ_EPS) return hOv;
    return 0;
}

// Grid geometry: rooms are cell regions in state.cells. Rooms with active
// children (e.g. 'loud' once carved into child_1..3) have no cells of their
// own — wall/adjacency/centroid queries transparently union over the
// children (leavesOf) so soft rules that target the parent (e.g. `far loud`)
// still resolve to something meaningful.
export class GridGeom {
    constructor(state, activeIdxs) {
        this.backend = "grid";
        this.state = state;
        this.stats = _internals.collectStats(state);
        this.byId = new Map(state.rooms.map((r, i) => [r.id, i]));
        this.childrenByParent = new Map();
        for (const i of activeIdxs) {
            const p = state.rooms[i].parent;
            if (p < 0) continue;
            if (!this.childrenByParent.has(p)) this.childrenByParent.set(p, []);
            this.childrenByParent.get(p).push(i);
        }
    }

    idx(name) {
        return this.byId.get(name);
    }

    has(name) {
        if (!this.byId.has(name)) return false;
        const index = this.idx(name);
        return this.stats.sizes[index] > 0 || this.childrenByParent.has(index);
    }

    childrenOf(name) {
        const kids = this.childrenByParent.get(this.idx(name));
        return kids ? kids.map(i => this.state.rooms[i].id) : [];
    }

    leavesOf(name) {
        const kids = this.childrenOf(name);
        return kids.length ? kids.flatMap(k => this.leavesOf(k)) : [name];
    }

    bboxCm(name) {
        const e = _internals.roomExtent(this.state, this.idx(name));
        if (e.size) return {
            w: (e.x1 - e.x0 + 1) * this.state.cellW,
            h: (e.y1 - e.y0 + 1) * this.state.cellH,
        };
        const leaves = this.leavesOf(name).map(leaf => _internals.roomExtent(this.state, this.idx(leaf))).filter(extent => extent.size);
        if (!leaves.length) return null;
        const x0 = Math.min(...leaves.map(extent => extent.x0));
        const x1 = Math.max(...leaves.map(extent => extent.x1));
        const y0 = Math.min(...leaves.map(extent => extent.y0));
        const y1 = Math.max(...leaves.map(extent => extent.y1));
        return { w: (x1 - x0 + 1) * this.state.cellW, h: (y1 - y0 + 1) * this.state.cellH };
    }

    areaCm(name) {
        return this.stats.sizes[this.idx(name)] * this.state.cellW * this.state.cellH;
    }

    bloatRatio(name) {
        const room = this.state.rooms[this.idx(name)];
        return this.stats.sizes[this.idx(name)] / room.quota;
    }

    isRectDelivered(name) {
        return _internals.isRectangle(this.state, this.idx(name));
    }

    rectFlag(name) {
        return !!this.state.rooms[this.idx(name)].rect;
    }

    wallTouch(name, dir) {
        const kids = this.childrenOf(name);
        if (kids.length) return kids.some(k => this.wallTouch(k, dir));
        const w = this.stats.walls[this.idx(name)];
        return dir === "edge" ? (w.north || w.south || w.east || w.west) : !!w[dir];
    }

    adjacent(a, b) {
        const as = this.leavesOf(a), bs = this.leavesOf(b);
        return as.some(x => bs.some(y => this.stats.sharedLen(this.idx(x), this.idx(y)) > 0));
    }

    // subject/target may be a parent whose cells were fully carved into
    // children (e.g. 'loud'); such a connect is satisfied through whichever
    // single child reaches the target, so take the best leaf-pair run
    straightRun(a, b) {
        let best = 0;
        for (const x of this.leavesOf(a)) {
            for (const y of this.leavesOf(b)) {
                best = Math.max(best, longestStraightRun(this.state, this.idx(x), this.idx(y)));
            }
        }
        return best;
    }

    centroidCm(name) {
        const leaves = this.leavesOf(name);
        if (leaves.length === 1) {
            const c = this.stats.centroids[this.idx(leaves[0])];
            return { x: c.x * this.state.cellW, y: c.y * this.state.cellH };
        }
        let sw = 0, sx = 0, sy = 0;
        for (const l of leaves) {
            const i = this.idx(l), s = this.stats.sizes[i], c = this.stats.centroids[i];
            sw += s;
            sx += c.x * s;
            sy += c.y * s;
        }
        return { x: (sx / sw) * this.state.cellW, y: (sy / sw) * this.state.cellH };
    }

    planDiagCm() {
        return Math.hypot(this.state.W * this.state.cellW, this.state.H * this.state.cellH);
    }
}

// SA geometry: rooms are cm rects (already resolved by optimizeRecursive);
// a room keeps its own rect even when it has inside children, so no
// composite/union logic is needed the way GridGeom needs it.
class SaGeom {
    constructor(flatRooms) {
        this.backend = "sa";
        this.rooms = new Map(flatRooms.map(r => [r.id, r]));
        const top = flatRooms.filter(r => r.parent === null);
        this.bounds = {
            x0: Math.min(...top.map(r => r.x)), y0: Math.min(...top.map(r => r.y)),
            x1: Math.max(...top.map(r => r.x + r.w)), y1: Math.max(...top.map(r => r.y + r.h)),
        };
    }

    bboxCm(name) {
        const r = this.rooms.get(name);
        return r ? { w: r.w, h: r.h } : null;
    }

    areaCm(name) {
        const r = this.rooms.get(name);
        return r ? r.w * r.h : 0;
    }

    bloatRatio(name) {
        return this.areaCm(name) / CIRCULATION_TARGET_AREA;
    }

    isRectDelivered() {
        return true;
    }

    rectFlag() {
        return true;
    }

    wallTouch(name, dir) {
        const r = this.rooms.get(name);
        switch (dir) {
            case "north":
                return r.y - this.bounds.y0 < WALL_EPS;
            case "south":
                return this.bounds.y1 - (r.y + r.h) < WALL_EPS;
            case "west":
                return r.x - this.bounds.x0 < WALL_EPS;
            case "east":
                return this.bounds.x1 - (r.x + r.w) < WALL_EPS;
            default:
                return ["north", "south", "east", "west"].some(d => this.wallTouch(name, d));
        }
    }

    adjacent(a, b) {
        return this.straightRun(a, b) > 0;
    }

    straightRun(a, b) {
        const A = this.rooms.get(a), B = this.rooms.get(b);
        return A && B ? sharedWallRects(A, B) : 0;
    }

    centroidCm(name) {
        const r = this.rooms.get(name);
        return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }

    planDiagCm() {
        return Math.hypot(this.bounds.x1 - this.bounds.x0, this.bounds.y1 - this.bounds.y0);
    }
}

function distNorm(geom, a, b) {
    const ca = geom.centroidCm(a), cb = geom.centroidCm(b);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) / geom.planDiagCm();
}

// ============================================================== metrics A-D, F, G (shared)

function metricAreaFidelity(geom) {
    const presentAreaRooms = areaRooms.filter(r => geom.has?.(r.id) ?? true);
    const reqAreaSum = presentAreaRooms.reduce((s, r) => s + r.area, 0);
    const delSum = presentAreaRooms.reduce((s, r) => s + geom.areaCm(r.id), 0);
    const rooms = presentAreaRooms.map(r => {
        const reqShare = r.area / reqAreaSum;
        const delShare = geom.areaCm(r.id) / delSum;
        const ratio = delShare / reqShare;
        return { room: r.id, ratio, dev: Math.abs(ratio - 1) };
    });
    const hallways = hallwayRooms.filter(r => geom.has?.(r.id) ?? true).map(r => ({
        room: r.id,
        bloat: geom.bloatRatio(r.id),
    }));
    return { rooms, hallways };
}

function metricAspect(geom) {
    return leafRooms.filter(r => r.ratioMax > 0 && (geom.has?.(r.id) ?? true)).map(r => {
        const box = geom.bboxCm(r.id);
        if (!box) return {
            room: r.id,
            aspect: 0,
            ratioMax: r.ratioMax,
            excess: 0,
            violated: false,
            empty: true,
        };
        const aspect = Math.max(box.w, box.h) / Math.min(box.w, box.h);
        return {
            room: r.id,
            aspect,
            ratioMax: r.ratioMax,
            excess: aspect / r.ratioMax,
            violated: aspect > r.ratioMax + 1e-6,
        };
    });
}

function metricSideMin(geom) {
    return leafRooms.filter(r => r.sideMin > 0 && (geom.has?.(r.id) ?? true)).map(r => {
        const box = geom.bboxCm(r.id);
        if (!box) return {
            room: r.id,
            minSide: 0,
            sideMin: r.sideMin,
            shortfall: r.sideMin,
            violated: true,
            ragged: false,
            empty: true,
        };
        const minSide = Math.min(box.w, box.h);
        const ragged = !geom.isRectDelivered(r.id);
        return {
            room: r.id,
            minSide,
            sideMin: r.sideMin,
            shortfall: r.sideMin - minSide,
            violated: minSide < r.sideMin - 1e-6,
            ragged,
        };
    });
}

export function classifyAdvisoryGeometry(rooms, geom, sideMinMetrics) {
    const intrinsic = [];
    const delivered = [];
    for (const room of rooms.filter(candidate => !candidate.hasChildren && candidate.sideMin > 0)) {
        const exactAreaMinimum = room.sideMin * room.sideMin;
        if (room.area > 0 && room.area < exactAreaMinimum - 1e-6) {
            intrinsic.push({
                room: room.id,
                path: room.path,
                area: room.area,
                sideMin: room.sideMin,
                ratioMax: room.ratioMax,
                minimumArea: exactAreaMinimum,
                areaShortfall: exactAreaMinimum - room.area,
                squareSideShortfall: room.sideMin - Math.sqrt(room.area),
                reason: "exact-area rectangle needs area >= side_min^2",
            });
        }

        const observed = sideMinMetrics.find(metric => metric.room === room.id);
        if (!observed?.violated) continue;
        const parentBox = room.parent ? geom.bboxCm(room.parent) : null;
        const parentMinSide = parentBox ? Math.min(parentBox.w, parentBox.h) : 0;
        const containingBlocker = parentBox && parentMinSide < room.sideMin - 1e-6;
        delivered.push({
            room: room.id,
            path: room.path,
            area: room.area,
            sideMin: room.sideMin,
            ratioMax: room.ratioMax,
            minSide: observed.minSide,
            shortfall: observed.shortfall,
            kind: containingBlocker ? "delivered-containing-geometry" : "delivered-layout",
            parent: containingBlocker ? room.parent : null,
            parentMinSide: containingBlocker ? parentMinSide : null,
            reason: containingBlocker
                ? "delivered parent bbox is narrower than requested side_min"
                : "delivered cell allocation misses advisory side_min; no mathematical infeasibility proven",
        });
    }
    return { intrinsic, delivered };
}

function metricRectangularity(geom) {
    if (geom.backend !== "grid") return null; // SA always delivers rectangles
    const flagged = leafRooms.filter(r => (geom.has?.(r.id) ?? true) && geom.rectFlag(r.id));
    const nonRect = flagged.filter(r => !geom.isRectDelivered(r.id)).map(r => r.id);
    return { total: flagged.length, nonRect };
}

function metricDoorWidth(geom) {
    const connects = ruleModel.filter(({
                                           subject,
                                           rule,
                                       }) => rule.type === "connect" && rule.required
        && (!geom.has || (geom.has(subject) && toArray(rule.target).every(target => geom.has(target)))));
    return connects.map(({ subject, rule }) => {
        const targets = toArray(rule.target);
        const cwl = rule.cwl ?? template.config.cwl ?? 0;
        const runs = targets.map(t => geom.straightRun(subject, t));
        const doorWidth = rule.any ? Math.max(...runs) : Math.min(...runs);
        return { subject, targets, cwl, doorWidth, violated: doorWidth < cwl - 1e-6 };
    });
}

function metricSoft(geom) {
    const out = { at: [], not_at: [], enclosed: [], far: [], close: [], connect: [] };
    for (const { subject, rule } of ruleModel) {
        if (rule.required) continue;
        if (geom.has && !geom.has(subject)) continue;
        if (rule.type === "at" || rule.type === "not_at" || rule.type === "enclosed") {
            const dirs = rule.type === "enclosed" ? ["edge"] : toArray(rule.dir);
            const touched = dirs.map(d => geom.wallTouch(subject, d));
            const satisfied = rule.type === "at" ? touched.every(Boolean) : touched.every(t => !t);
            out[rule.type].push({ subject, dirs, satisfied });
        } else if (rule.type === "far" || rule.type === "close" || rule.type === "connect") {
            const targets = toArray(rule.target);
            if (geom.has && targets.some(target => !geom.has(target))) continue;
            const cwl = rule.cwl ?? template.config.cwl ?? 0;
            const per = targets.map(t => {
                const adjacent = geom.adjacent(subject, t);
                return {
                    target: t,
                    adjacent,
                    run: adjacent ? geom.straightRun(subject, t) : 0,
                    dist: distNorm(geom, subject, t),
                };
            });
            const okFar = p => !p.adjacent;
            const okClose = p => p.adjacent;
            const okConnect = p => p.adjacent && p.run >= cwl - 1e-6;
            const ok = rule.type === "far" ? okFar : rule.type === "close" ? okClose : okConnect;
            const satisfied = rule.any ? per.some(ok) : per.every(ok);
            out[rule.type].push({ subject, targets, satisfied, per });
        }
    }
    return out;
}

export function computeMetrics(geom, required) {
    const sideMin = metricSideMin(geom);
    return {
        backend: geom.backend,
        required,
        area: metricAreaFidelity(geom),
        aspect: metricAspect(geom),
        sideMin,
        advisoryGeometry: classifyAdvisoryGeometry(leafRooms, geom, sideMin),
        rect: metricRectangularity(geom),
        doors: metricDoorWidth(geom),
        soft: metricSoft(geom),
    };
}

// ============================================================== grid run

function runGridSeed(seed) {
    const parsed = parseDSL(dslText); // fresh parse per seed, matches grid_seeds.js
    const opts = { seed };
    if (thorough) opts.lookahead = 999;
    const t0 = performance.now();
    const result = optimizeGrid(parsed, opts);
    const ms = performance.now() - t0;
    if (result.error) return { seed, error: result.error };

    const geom = new GridGeom(result.state, result.activeIdxs);
    // inside-block parents (e.g. 'loud') are replaced by their children in
    // activeIdxs but still carry — and the solver still reports on —
    // required rules of their own, re-checked against the children's cell
    // union (grid_optimizer.js childIdxs / connectSatisfiedFromRegion)
    const counted = r => result.activeIdxs.includes(r) || !!result.state.rooms[r].childIdxs;
    const total = result.state.rooms.reduce((s, room, r) =>
        counted(r) ? s + room.rules.filter(c => c.required).length : s, 0);
    const required = {
        total,
        satisfied: total - result.unsatisfied.length,
        unsatisfiedList: result.unsatisfied,
    };
    return { seed, ms, ...computeMetrics(geom, required) };
}

// ============================================================== SA run

function flattenSA(rooms, offsetX, offsetY, parent, out) {
    for (const r of rooms) {
        const abs = { id: r.id, x: r.x + offsetX, y: r.y + offsetY, w: r.w, h: r.h, parent };
        out.push(abs);
        if (r.inside?.rooms) flattenSA(r.inside.rooms, abs.x, abs.y, r.id, out);
    }
    return out;
}

function saRequiredStats(LO, flatAll) {
    const topLayout = flatAll.filter(r => r.parent === null);
    const topModMap = Object.fromEntries(template.modules.map(m => [m.id, m]));
    let total = template.modules.reduce((s, m) => s + (m.rules || []).filter(r => r.required).length, 0);
    const unsatisfiedList = LO.checkRequiredSatisfied(topLayout, topModMap).map(u => ({
        ...u,
        scope: "top",
    }));

    for (const m of template.modules) {
        if (!m.inside) continue;
        const childMods = m.inside.modules;
        total += childMods.reduce((s, c) => s + (c.rules || []).filter(r => r.required).length, 0);
        const childMap = Object.fromEntries(childMods.map(c => [c.id, c]));
        // include outer rooms too so cross-boundary targets (e.g. 'hallway_1') resolve
        const innerLayout = flatAll.filter(r => r.parent === m.id).concat(topLayout);
        unsatisfiedList.push(...LO.checkRequiredSatisfied(innerLayout, childMap).map(u => ({
            ...u,
            scope: m.id,
        })));
    }
    return { total, satisfied: total - unsatisfiedList.length, unsatisfiedList };
}

async function runSASeed(LO, optimizeRecursive, seed) {
    const origLog = console.log;
    console.log = () => {
    };
    const t0 = performance.now();
    const result = await optimizeRecursive(template.modules, {
        k: 20,
        iter: 1, ...template.config,
        algo: "sa",
        seed,
    }, undefined, []);
    console.log = origLog;
    const ms = performance.now() - t0;

    const flatAll = flattenSA(result.rooms, 0, 0, null, []);
    const geom = new SaGeom(flatAll);
    const required = saRequiredStats(LO, flatAll);
    return { seed, ms, ...computeMetrics(geom, required) };
}

// ============================================================== reporting

function fmt(n, d = 2) {
    return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

function seedLine(r) {
    if (r.error) return `  seed ${r.seed}: ERROR ${r.error}`;
    const worstArea = r.area.rooms.reduce((a, b) => b.dev > a.dev ? b : a, { dev: -1 });
    const aspectViol = r.aspect.filter(a => a.violated).length;
    const sideViol = r.sideMin.filter(s => s.violated).length;
    const doorViol = r.doors.filter(d => d.violated).length;
    const narrowest = r.doors.reduce((a, b) => b.doorWidth < a.doorWidth ? b : a, r.doors[0]);
    const rectNote = r.rect ? `rect ${r.rect.nonRect.length}/${r.rect.total}` : "rect n/a (SA)";
    return `  seed ${r.seed} (${fmt(r.ms, 0)}ms): required ${r.required.satisfied}/${r.required.total}, `
        + `area-dev worst ${fmt(worstArea.dev)} (${worstArea.room}), aspect viol ${aspectViol}/${r.aspect.length}, `
        + `side viol ${sideViol}/${r.sideMin.length}, ${rectNote}, door viol ${doorViol}/${r.doors.length}, `
        + `door-min ${fmt(narrowest.doorWidth, 1)}cm (${narrowest.subject})`;
}

// Reduces a per-seed, per-item list to {mean, worst: {seed, ...item}} using `val`.
function aggregate(results, pick, val) {
    const items = [];
    for (const r of results) {
        if (r.error) continue;
        for (const item of pick(r)) items.push({ seed: r.seed, ...item });
    }
    if (!items.length) return null;
    const mean = items.reduce((s, i) => s + val(i), 0) / items.length;
    const worst = items.reduce((a, b) => val(b) > val(a) ? b : a);
    return { mean, worst, items };
}

function printAggregate(label, results) {
    console.log(`\n=== ${label} aggregate (${results.filter(r => !r.error).length}/${results.length} seeds solved) ===`);
    const ok = results.filter(r => !r.error);
    if (!ok.length) {
        console.log("  no successful runs");
        return;
    }

    const reqTotal = ok.reduce((s, r) => s + r.required.total, 0);
    const reqSat = ok.reduce((s, r) => s + r.required.satisfied, 0);
    console.log("A. Area fidelity:");

    const areaAgg = aggregate(ok, r => r.area.rooms, i => i.dev);
    if (areaAgg) console.log(`   relative-size deviation |ratio-1|: mean ${fmt(areaAgg.mean)}  worst ${fmt(areaAgg.worst.dev)} (${areaAgg.worst.room}, seed ${areaAgg.worst.seed})`);
    const bloatAgg = aggregate(ok, r => r.area.hallways, i => i.bloat);
    if (bloatAgg) console.log(`   hallway bloat (delivered/target): mean ${fmt(bloatAgg.mean)}x  worst ${fmt(bloatAgg.worst.bloat)}x (${bloatAgg.worst.room}, seed ${bloatAgg.worst.seed})`);

    const aspectAgg = aggregate(ok, r => r.aspect, i => i.excess);
    const aspectViol = ok.reduce((s, r) => s + r.aspect.filter(a => a.violated).length, 0);
    const aspectTotal = ok.reduce((s, r) => s + r.aspect.length, 0);
    console.log(`B. Aspect (ratio_max): violations ${aspectViol}/${aspectTotal}` + (aspectAgg ? `  worst excess ${fmt(aspectAgg.worst.excess)}x (${aspectAgg.worst.room}, seed ${aspectAgg.worst.seed})` : ""));

    const sideViol = ok.reduce((s, r) => s + r.sideMin.filter(x => x.violated).length, 0);
    const sideTotal = ok.reduce((s, r) => s + r.sideMin.length, 0);
    const sideAgg = aggregate(ok, r => r.sideMin.filter(x => x.violated), i => i.shortfall);
    const raggedNote = ok.reduce((s, r) => s + r.sideMin.filter(x => x.ragged).length, 0);
    console.log(`C. side_min: violations ${sideViol}/${sideTotal}` + (sideAgg ? `  worst shortfall ${fmt(sideAgg.worst.shortfall, 1)}cm (${sideAgg.worst.room}, seed ${sideAgg.worst.seed})` : "") + `  (${raggedNote} ragged-room bbox checks, may understate)`);

    if (ok[0].rect) {
        const rectNonRect = ok.reduce((s, r) => s + r.rect.nonRect.length, 0);
        const rectTotal = ok.reduce((s, r) => s + r.rect.total, 0);
        console.log(`D. Rectangularity: non-rect ${rectNonRect}/${rectTotal}` + (rectNonRect ? `  e.g. ${ok.find(r => r.rect.nonRect.length)?.rect.nonRect.join(", ")}` : ""));
    } else {
        console.log("D. Rectangularity: n/a (SA always delivers rectangles)");
    }

    const perSeedTotal = ok[0].required.total;
    const totalNote = perSeedTotal !== FULL_REQUIRED_RULE_COUNT
        ? `  (note: ${FULL_REQUIRED_RULE_COUNT} required rules exist in the DSL; this backend's own contract only tracks ${perSeedTotal}/seed — see FULL_REQUIRED_RULE_COUNT comment)`
        : "";
    console.log(`E. Required rules: ${reqSat}/${reqTotal} satisfied` + (reqSat < reqTotal ? `  e.g. ${JSON.stringify(ok.find(r => r.required.unsatisfiedList.length)?.required.unsatisfiedList[0])}` : "") + totalNote);
    if (ok[0].backend === "sa") {
        // sa_optimized's isRuleSatisfied reads `rule.cwl || 0` — the DSL's
        // GLOBAL `cwl 125` never reaches a connect rule without its own
        // per-rule `cwl=`, so SA's native required-connect check accepts any
        // non-zero contact. Grid's checker applies config.cwl as the
        // fallback and is strictly narrower (documented in GRID_HANDOFF.md).
        // F below re-checks every required connect against cwl 125 for BOTH
        // backends identically — treat F, not this E count, as the door-width
        // yardstick when comparing the two.
        console.log("   (SA's own check ignores the global cwl on connects without cwl=; see F for the cwl-strict yardstick)");
    }

    const doorViol = ok.reduce((s, r) => s + r.doors.filter(d => d.violated).length, 0);
    const doorTotal = ok.reduce((s, r) => s + r.doors.length, 0);
    const doorAgg = aggregate(ok, r => r.doors, i => -i.doorWidth); // "worst" = narrowest
    console.log(`F. Door width (cwl): narrow-door count ${doorViol}/${doorTotal}` + (doorAgg ? `  narrowest ${fmt(doorAgg.worst.doorWidth, 1)}cm (${doorAgg.worst.subject} -> [${doorAgg.worst.targets.join(",")}], seed ${doorAgg.worst.seed})` : ""));

    console.log("G. Soft directional/topological interests:");
    for (const kind of ["at", "not_at", "enclosed", "far", "close", "connect"]) {
        const all = ok.flatMap(r => r.soft[kind].map(x => ({ ...x, seed: r.seed })));
        if (!all.length) continue;
        const sat = all.filter(x => x.satisfied).length;
        const worst = all.find(x => !x.satisfied);
        let distNote = "";
        if (kind === "far") {
            // normalized center-to-center distance (per target pair), higher = better honored
            const dists = all.flatMap(x => x.per.map(p => ({
                ...p,
                subject: x.subject,
                seed: x.seed,
            })));
            const meanDist = dists.reduce((s, p) => s + p.dist, 0) / dists.length;
            const closest = dists.reduce((a, b) => b.dist < a.dist ? b : a);
            distNote = `  norm-dist mean ${fmt(meanDist)}  closest ${fmt(closest.dist)} (${closest.subject} vs ${closest.target}, seed ${closest.seed})`;
        }
        console.log(`   ${kind}: ${sat}/${all.length} satisfied` + (worst ? `  e.g. violated: ${worst.subject} (seed ${worst.seed})` : "") + distNote);
    }

    console.log("H. Advisory geometry infeasibility and delivery limitations:");
    const intrinsic = ok[0].advisoryGeometry.intrinsic;
    if (!intrinsic.length) console.log("   Intrinsic DSL exact-area conflicts: none detected.");
    for (const item of intrinsic) {
        console.log(`   Intrinsic DSL exact-area conflict: ${item.path} requests area ${fmt(item.area, 0)}cm², side_min ${fmt(item.sideMin, 1)}cm, ratio_max ${item.ratioMax ? fmt(item.ratioMax) : "none"}; `
            + `minimum area ${fmt(item.minimumArea, 0)}cm², short by ${fmt(item.areaShortfall, 0)}cm² (${fmt(item.squareSideShortfall, 1)}cm per square side). Blocker: ${item.reason}.`);
    }
    const delivered = ok.flatMap(result => result.advisoryGeometry.delivered.map(item => ({
        ...item,
        seed: result.seed,
    })));
    if (!delivered.length) console.log("   Delivered-layout side_min limitations: none.");
    const deliveredByPath = new Map();
    for (const item of delivered) {
        if (!deliveredByPath.has(item.path)) deliveredByPath.set(item.path, []);
        deliveredByPath.get(item.path).push(item);
    }
    for (const [path, items] of deliveredByPath) {
        const worst = items.reduce((a, b) => b.shortfall > a.shortfall ? b : a);
        const blocker = worst.kind === "delivered-containing-geometry"
            ? `delivered parent ${worst.parent} min side ${fmt(worst.parentMinSide, 1)}cm is below request`
            : "delivered cell allocation; no mathematical infeasibility proven";
        console.log(`   Delivered limitation: ${path} misses side_min in ${items.length}/${ok.length} seeds; request area ${fmt(worst.area, 0)}cm², side_min ${fmt(worst.sideMin, 1)}cm, ratio_max ${worst.ratioMax ? fmt(worst.ratioMax) : "none"}; `
            + `worst delivered min side ${fmt(worst.minSide, 1)}cm, short by ${fmt(worst.shortfall, 1)}cm (seed ${worst.seed}). Blocker: ${blocker}.`);
    }
}

// ============================================================== main

async function main() {
    console.log(`DSL: ${dslPath}`);

    console.log(`\n########## GRID (${gridSeeds.length} seeds${thorough ? ", --thorough" : ""}) ##########`);
    const gridResults = gridSeeds.map(runGridSeed);
    for (const r of gridResults) console.log(seedLine(r));
    printAggregate("GRID", gridResults);

    if (!runSA) return;

    const LO = require("../sa_optimized.js");
    globalThis.wongLiuSimulatedAnnealing = LO.wongLiuSimulatedAnnealing;
    const { optimizeRecursive } = require("../orchestrator.js");

    console.log(`\n########## SA k=20 (${saSeeds.length} seeds) ##########`);
    const saResults = [];
    for (const seed of saSeeds) {
        const r = await runSASeed(LO, optimizeRecursive, seed);
        console.log(seedLine(r));
        saResults.push(r);
    }
    printAggregate("SA", saResults);
}

if (import.meta.main) await main();
