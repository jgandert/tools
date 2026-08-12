// grid_optimizer.js — coarse-to-fine grid floor plan solver.
//
// Pipeline:
//   1. quotas        — relative room areas → coarse tile quotas
//   2. coarse solve  — backtracking seed placement + guided region growth +
//                      single-cell repair; required rules hold by construction
//                      or the attempt is retried with a new RNG stream
//   3. refinement    — subdivide 2×2, greedy boundary-cell flips that improve
//                      soft cost and provably never break a required rule
//   4. inside blocks — recurse into parent regions at final resolution
//   5. ASCII render  — grid + legend + constraint report
//
// Rooms are polyomino regions (contiguous cell sets), not rectangles.
// Exact areas are not an objective — only relative quotas.

const REFINE_LEVELS = 2;
const MAX_ATTEMPTS = 80;

// Canvas size is ignored (relative areas only): every attempt samples its own
// coarse grid dims, so the plan's aspect is a search variable, not an input.
const GRID_DIMS = [[8, 6], [6, 8], [7, 7], [9, 5], [5, 9], [9, 6], [6, 9], [10, 5], [5, 10], [8, 7], [7, 8]];

// area share each area-less room (hallway) gets, relative to the known sum
const CIRCULATION_SHARE = 0.07;

// after the first fully-satisfied attempt, keep trying this many more and
// take the (unsat, softCost)-lexicographic best — the first satisfied attempt
// is often badly balanced (a room sealed near its seed), and attempts are cheap
const SATISFIED_LOOKAHEAD = 16;

// attempts kept for the expensive coarse rebalance (see the shortlist loop in
// optimizeGrid); scoring the rest through rectify alone is ~2x cheaper
const COARSE_SHORTLIST = 12;

// cheap scoring lets the satisfied-attempt window cover far more of the pool
const CHEAP_LOOKAHEAD = 64;
const REQUIRED_SEED_RETRIES = 4;
const REQUIRED_SHAPE_SEED_RETRIES = 19;
const SEED_NODE_BUDGET = 8000;
const SEED_CANDIDATES_PER_ROOM = 10;
const MAX_OPT_PASSES = 30;

// Growth guidance scores (coarse level, per-cell pick)
const G_COMPACT = 2;
const G_CONNECT_ADJ = 60;
const G_CONNECT_DIST = 4;
const G_AT_WALL = 40;
const G_AT_DIST = 3;
const G_RATIO = 25;
const G_ANCHOR = 3;
const G_WEIGHT_CAP = 5;

// Wrong-side-of-the-spine penalties (soft steering toward assignSides result)
const SIDE_SEED_PENALTY = 25;
const G_SIDE = 15;

// Rooms that are targets of at least this many required connects act as hubs:
// they are seeded and grown first, and dependents seed adjacent to them.
const HUB_INDEGREE_MIN = 3;

// Soft cost weights (refinement objective, all terms roughly O(1))
const W_AREA = 30;
const W_PERIM = 8;
const W_RATIO = 8;
const W_FILL = 6;
const W_THIN = 0.4;
const W_AT = 2;
const W_CLOSE = 2;
const W_CWL = 4;
const W_RECT = 15;

// area-less rooms (hallways) are where every rectangularisation leftover ends
// up; over quota they pay a multiple so that slack is pushed back into rooms
const W_HALL_BLOAT = 8;

// convex above quota: one room at 3x must cost more than two at 2x, or the
// slack freed from the hallways just piles onto whichever room can take it
const DEV_EXP = 8;
const FILL_MIN = 0.7;

// attempt-selection penalty per cm of missing straight hub frontage on a
// parent room whose inside-children require external hub connects
const W_FRONTAGE = 0.05;

// per cm of shortfall against the stricter SUFFICIENT frontage condition
// (see frontageShortfall). Priced ~8x W_FRONTAGE: a parent short by a couple
// of hundred cm costs about as much as a whole plan's soft cost (~100-180),
// so a geometrically unsolvable parent loses to any attempt that is solvable,
// while staying tradeable instead of vetoing outright — the condition is
// sufficient, not necessary, and coarse cells quantize it by ~1.4 cwl.
const W_FRONTAGE_REACH = 0.4;

const RECTIFY_PASSES = 4;
const MAX_STRIPE_CANDIDATES = 24;
const MAX_FINAL_POLISH_MOVES = 64;
const FINAL_POLISH_MIN_SIDE_VIOLATION_RATE = 0.3;

const DIRS = ["north", "south", "east", "west"];

function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// =============================================================================
// Rule compilation
// =============================================================================

function normalizeDirs(dir) {
    if (dir === undefined) {
        return [];
    }
    return Array.isArray(dir) ? dir : String(dir).split(" ");
}

const GRID_RULE_KINDS = new Set(["at", "not_at", "enclosed", "connect", "close", "far"]);

function makeWarningSink(warnings) {
    const seen = new Set();
    return (key, message) => {
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        warnings.push(message);
    };
}

function warnIgnoredConfig(parsed, warn) {
    const visit = (config, modules) => {
        if (config.canvasW !== undefined || config.canvasH !== undefined) {
            warn("config:canvas", "grid: canvas is ignored");
        }
        if (config.areaMin !== undefined || modules.some(m => m.areaMin !== undefined)) {
            warn("config:area_min", "grid: area_min is ignored");
        }
        if (config.sideMax !== undefined || modules.some(m => m.sideMax !== undefined)) {
            warn("config:side_max", "grid: side_max is ignored");
        }
        if (modules.some(m => m.ratio !== undefined)) {
            warn("config:ratio", "grid: fixed room ratio is ignored; ratio_max remains supported");
        }
        if (config.cwc !== undefined || modules.some(m => m.cwc !== undefined)) {
            warn("config:cwc", "grid: cwc is ignored");
        }
        for (const module of modules) {
            if (module.inside) {
                visit(module.inside.config, module.inside.modules);
            }
        }
    };
    visit(parsed.config, parsed.modules);
}

// Flatten parser rules into a uniform list; resolve target names to room indices.
function compileRooms(modules, config, warnings, options = {}) {
    const warn = options.warn || makeWarningSink(warnings);
    const scope = options.scope || "outer";
    const rooms = modules.map((m, i) => ({
        id: m.id,
        index: i,
        area: m.area,
        ratioMax: m.ratioMax || config.ratioMax || 0,
        sideMin: m.sideMin || config.sideMin || 0,
        shape: m.shape,
        shapeRequired: !!m.shapeRequired,
        inside: m.inside,
        parent: -1,
        rules: [],
    }));
    const idxOf = new Map(rooms.map(r => [r.id, r.index]));

    for (let i = 0; i < modules.length; i++) {
        for (const rule of modules[i].rules || []) {
            if (rule.subjectAny) {
                const group = rule.subjectGroupId ?? `${modules[i].id}:${rule.type}`;
                warn(`subject-any:${scope}:${group}`, `grid: any-subject rule group ${group} in '${scope}' is unsupported and was ignored`);
                continue;
            }
            if (!GRID_RULE_KINDS.has(rule.type)) {
                warn(`rule-kind:${rule.type}`, `grid: unknown rule kind '${rule.type}' was ignored`);
                continue;
            }
            if (options.inside && (rule.type === "at" || rule.type === "not_at" || rule.type === "enclosed")) {
                warn(`inside-wall:${scope}:${modules[i].id}:${rule.type}`, `grid: '${modules[i].id}' ${rule.type} inside '${scope}' refers to canvas walls, not the parent, and was ignored`);
                continue;
            }
            if (rule.crossBoundary && (rule.type === "close" || rule.type === "far")) {
                warn(`cross-boundary:${scope}:${modules[i].id}:${rule.type}`, `grid: cross-boundary ${rule.type} rule on '${modules[i].id}' is unsupported and was ignored`);
                continue;
            }
            const c = {
                kind: rule.type,
                required: !!rule.required,
                weight: rule.weight || 1,
                subject: i,
            };

            if (rule.type === "at" || rule.type === "not_at") {
                c.dirs = normalizeDirs(rule.dir);
            } else if (rule.type === "enclosed") {
                c.dirs = [];
            } else {
                const names = Array.isArray(rule.target) ? rule.target : [rule.target];
                c.targets = [];
                c.externalTargets = [];
                for (const n of names) {
                    if (idxOf.has(n)) {
                        c.targets.push(idxOf.get(n));
                    } else if (rule.crossBoundary) {
                        c.externalTargets.push(n);
                    } else {
                        warnings.push(`grid: rule target '${n}' unknown in scope of '${modules[i].id}' — skipped`);
                    }
                }
                if (!c.targets.length && !c.externalTargets.length) {
                    warn(`empty-targets:${scope}:${modules[i].id}:${rule.type}`, `grid: ${rule.type} rule on '${modules[i].id}' has no known targets and was ignored`);
                    continue;
                }
                c.any = !!rule.any;
                c.cwl = rule.cwl ?? config.cwl ?? 0;
            }

            rooms[i].rules.push(c);
        }
    }

    // symmetrize required connects: the target side gets a guidance-only pull
    // (kind 'pull' influences seeds/growth but is never reported or checked).
    // any-connects pull weakly and only while the source rule is unsatisfied.
    for (const room of rooms) {
        for (const c of room.rules) {
            if (c.kind !== "connect" || !c.required) {
                continue;
            }
            for (const t of c.targets) {
                rooms[t].rules.push({
                    kind: "pull", required: false, weight: 1, subject: t,
                    targets: [room.index], any: false, cwl: c.cwl, externalTargets: [],
                    strength: c.any ? 0.4 : 1, src: c,
                });
            }
        }
    }
    return rooms;
}

// Canvas-free: the canvas is ignored by the grid solver — only relative areas
// matter. Area-less rooms (hallways) get a circulation share of the known sum.
// Returns the total real area (cm^2) for square-cell sizing.
function computeQuotas(rooms, totalCells) {
    const known = rooms.filter(r => r.area > 0);
    const knownSum = known.reduce((s, r) => s + r.area, 0) || 1;
    const per = knownSum * CIRCULATION_SHARE;
    const unknownCount = rooms.length - known.length;

    const total = knownSum + per * unknownCount;
    for (const r of rooms) {
        const a = r.area > 0 ? r.area : per;
        r.quota = Math.max(1, Math.round((a / total) * totalCells));
    }
    return total;
}

// =============================================================================
// Grid state
// =============================================================================

function makeState(W, H, cellW, cellH, rooms) {
    return { W, H, cellW, cellH, rooms, cells: new Int16Array(W * H).fill(-1) };
}

function neighborsOf(idx, W, H, out) {
    const x = idx % W;
    const y = (idx / W) | 0;
    let n = 0;
    if (y > 0) out[n++] = idx - W;
    if (y < H - 1) out[n++] = idx + W;
    if (x > 0) out[n++] = idx - 1;
    if (x < W - 1) out[n++] = idx + 1;
    return n;
}

function wallsOfCell(idx, W, H) {
    const x = idx % W;
    const y = (idx / W) | 0;
    return {
        north: y === 0,
        south: y === H - 1,
        west: x === 0,
        east: x === W - 1,
    };
}

function onWall(idx, dir, W, H) {
    const w = wallsOfCell(idx, W, H);
    if (dir === "edge") {
        return w.north || w.south || w.east || w.west;
    }
    return !!w[dir];
}

function distToWall(idx, dir, W, H) {
    const x = idx % W;
    const y = (idx / W) | 0;
    switch (dir) {
        case "north":
            return y;
        case "south":
            return H - 1 - y;
        case "west":
            return x;
        case "east":
            return W - 1 - x;
        default:
            return Math.min(y, H - 1 - y, x, W - 1 - x);
    }
}

function manhattan(a, b, W) {
    const ax = a % W, ay = (a / W) | 0;
    const bx = b % W, by = (b / W) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by);
}

// Longest run (in cells) of consecutive shared edges along a single grid axis
// where `touch(i, j)` holds for adjacent cells i, j. Shared core for
// straightSharedRun and straightHubRun — both walk the same two axes, only
// the touch predicate differs. `out` (optional, reused by the caller so the
// hot growth path stays allocation-free) receives the per-axis runs: `vRun`
// along y (shared vertical walls), `hRun` along x.
function longestAxisRun(state, touch, out) {
    const { W, H } = state;
    let bestV = 0;
    let vEnd = -1;
    for (let x = 0; x < W - 1; x++) {
        let run = 0;
        for (let y = 0; y < H; y++) {
            const idx = y * W + x;
            run = touch(idx, idx + 1) ? run + 1 : 0;
            if (run > bestV) {
                bestV = run;
                vEnd = y;
            }
        }
    }
    let bestH = 0;
    let hEnd = -1;
    for (let y = 0; y < H - 1; y++) {
        let run = 0;
        for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            run = touch(idx, idx + W) ? run + 1 : 0;
            if (run > bestH) {
                bestH = run;
                hEnd = x;
            }
        }
    }
    if (out) {
        out.vRun = bestV;
        out.hRun = bestH;
        out.vLo = vEnd - bestV + 1;
        out.vHi = vEnd;
        out.hLo = hEnd - bestH + 1;
        out.hHi = hEnd;
    }
    return Math.max(bestV, bestH);
}

// Membership test for a "region" as accepted by straightSharedRun: either a
// room index (cells owned by that room) or a Set of full-grid cell indices
// (e.g. extAdj[name] — an outer room's cells, from the caller's perspective
// of an inside-block child).
function regionHas(state, region, idx) {
    return region instanceof Set ? region.has(idx) : state.cells[idx] === region;
}

// Longest straight run (in cells; caller multiplies by cellW/cellH — cells
// are square) of shared edges between two regions. A corner-wrapped contact
// can sum to the same total shared length as a straight one but has no
// single run wide enough for a door — this is the door-width-correct measure
// for required-connect satisfaction (see ruleSatisfied's "connect" case and
// extAdjTouches); plain summed length (stats.sharedLen) stays in use for
// growth guidance and soft costs, where over-counting a corner is harmless.
function straightSharedRun(state, cellsA, cellsB) {
    return longestAxisRun(state, (i, j) =>
        (regionHas(state, cellsA, i) && regionHas(state, cellsB, j)) ||
        (regionHas(state, cellsB, i) && regionHas(state, cellsA, j)));
}

// Stats over the whole grid in one pass: sizes, bboxes, centroids, wall contact,
// pairwise shared boundary length (cm), per-room thin-cell count.
function collectStats(state) {
    const { W, H, cells, cellW, cellH, rooms } = state;
    const n = rooms.length;
    const sizes = new Array(n).fill(0);
    const bbox = rooms.map(() => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
    const cx = new Array(n).fill(0);
    const cy = new Array(n).fill(0);
    const walls = rooms.map(() => ({ north: false, south: false, east: false, west: false }));
    const shared = new Map();
    const thin = new Array(n).fill(0);

    const key = (a, b) => a < b ? a * n + b : b * n + a;

    for (let idx = 0; idx < cells.length; idx++) {
        const r = cells[idx];
        if (r < 0) {
            continue;
        }
        const x = idx % W;
        const y = (idx / W) | 0;
        sizes[r]++;
        cx[r] += x;
        cy[r] += y;
        const b = bbox[r];
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
        const wc = wallsOfCell(idx, W, H);
        for (const d of DIRS) {
            if (wc[d]) walls[r][d] = true;
        }

        // shared boundary: count east and south borders once
        if (x < W - 1) {
            const o = cells[idx + 1];
            if (o >= 0 && o !== r) {
                const k = key(r, o);
                shared.set(k, (shared.get(k) || 0) + cellH);
            }
        }
        if (y < H - 1) {
            const o = cells[idx + W];
            if (o >= 0 && o !== r) {
                const k = key(r, o);
                shared.set(k, (shared.get(k) || 0) + cellW);
            }
        }

        // thin cell: both horizontal or both vertical neighbors foreign/outside
        const leftF = x === 0 || cells[idx - 1] !== r;
        const rightF = x === W - 1 || cells[idx + 1] !== r;
        const upF = y === 0 || cells[idx - W] !== r;
        const downF = y === H - 1 || cells[idx + W] !== r;
        if ((leftF && rightF) || (upF && downF)) {
            thin[r]++;
        }
    }

    const centroids = rooms.map((_, r) => sizes[r]
        ? { x: cx[r] / sizes[r], y: cy[r] / sizes[r] }
        : { x: W / 2, y: H / 2 });

    // memoized per collectStats call: growth scoring calls straightRun with
    // the same (room, target) pair for many candidate cells in one round
    const runCache = new Map();
    const straightRun = (a, b) => {
        let m = runCache.get(a);
        if (!m) {
            m = new Map();
            runCache.set(a, m);
        }
        if (m.has(b)) return m.get(b);
        const v = straightSharedRun(state, a, b);
        m.set(b, v);
        return v;
    };

    return {
        sizes, bbox, centroids, walls, thin,
        sharedLen: (a, b) => shared.get(key(a, b)) || 0,
        straightRun,
    };
}

// =============================================================================
// Required rules
// =============================================================================

// External adjacency (inside-block child ↔ outer room by id) uses room ids
// painted on the parent state before the inside solve; extAdj maps name → set
// of cell indices adjacent to that outer room.
function ruleSatisfied(c, state, stats, extAdj) {
    const r = c.subject;
    switch (c.kind) {
        case "at":
            return c.dirs.every(d => d === "edge"
                ? DIRS.some(w => stats.walls[r][w])
                : stats.walls[r][d]);
        case "not_at":
            if (c.dirs[0] === "edge") {
                return !DIRS.some(w => stats.walls[r][w]);
            }
            return c.dirs.every(d => !stats.walls[r][d]);
        case "enclosed":
            return !DIRS.some(w => stats.walls[r][w]);
        case "connect": {
            // satisfaction needs a straight run wide enough for a door, not
            // merely a summed contact of that length (a corner-wrapped
            // contact can sum to cwl with no single segment that wide)
            const ok = t => {
                // sum 0 <=> run 0 (a single shared edge is itself a run of
                // 1): the cheap map lookup skips the O(W*H) scan for every
                // non-touching pair, which dominates hot paths like the
                // no-regression check in tryTransfer
                if (stats.sharedLen(r, t) === 0) return false;
                if (c.cwl === 0) return true;
                return stats.straightRun(r, t) * state.cellW >= c.cwl - 1e-6;
            };
            const okExt = name => extAdjTouches(state, stats, r, name, extAdj, c.cwl);
            const results = [...c.targets.map(ok), ...c.externalTargets.map(okExt)];
            if (!results.length) {
                return true;
            }
            return c.any ? results.some(Boolean) : results.every(Boolean);
        }
        case "close": {
            const ok = t => stats.sharedLen(r, t) > 0;
            if (!c.targets.length) return true;
            return c.any ? c.targets.some(ok) : c.targets.every(ok);
        }
        case "far": {
            const ok = t => stats.sharedLen(r, t) === 0;
            if (!c.targets.length) return true;
            return c.any ? c.targets.some(ok) : c.targets.every(ok);
        }
        default:
            return true;
    }
}

// Straight-run satisfaction between room r's cells and an external region
// given by extAdj[name] = Set of full-grid cells owned by that outer room.
// Same door-width reasoning as ruleSatisfied's connect case: a summed
// contact of cwl wrapped around a corner is not a door.
function extAdjTouches(state, stats, r, name, extAdj, cwl) {
    const cellSet = extAdj?.[name];
    if (!cellSet) {
        return false;
    }
    const run = stats.straightRun(r, cellSet);
    return run > 0 && (cwl === 0 || run * state.cellW >= cwl - 1e-6);
}

// Union of full-grid cells owned by any room index in idxs — used to
// re-evaluate an inside-block parent's own required rule (see
// connectSatisfiedFromRegion) since the parent owns no cells itself once its
// children replace it in activeIdxs.
function unionCells(state, idxs) {
    const set = idxs instanceof Set ? idxs : new Set(idxs);
    const out = new Set();
    for (let i = 0; i < state.cells.length; i++) {
        if (set.has(state.cells[i])) {
            out.add(i);
        }
    }
    return out;
}

// Same satisfaction semantics as ruleSatisfied's "connect" case, but the
// subject is an arbitrary cell region (typically unionCells of an inside
// parent's children) rather than a room index. Only "connect" is supported —
// the only required-rule kind an inside-block parent carries on itself in
// practice; at/not_at/enclosed on such a parent stay out of scope (see
// GRID_HANDOFF known gaps).
function connectSatisfiedFromRegion(state, c, region, extAdj) {
    const cwl = c.origCwl ?? c.cwl;
    const runOk = run => run > 0 && (cwl === 0 || run * state.cellW >= cwl - 1e-6);
    const ok = t => runOk(straightSharedRun(state, region, t));
    const okExt = name => {
        const cellSet = extAdj?.[name];
        return cellSet ? runOk(straightSharedRun(state, region, cellSet)) : false;
    };
    const results = [...c.targets.map(ok), ...(c.externalTargets || []).map(okExt)];
    if (!results.length) {
        return true;
    }
    return c.any ? results.some(Boolean) : results.every(Boolean);
}

function requiredRules(rooms) {
    const out = [];
    for (const room of rooms) {
        for (const c of room.rules) {
            if (c.required) {
                out.push(c);
            }
        }
    }
    return out;
}

function unsatisfiedRequired(state, extAdj) {
    const stats = collectStats(state);
    return requiredRules(state.rooms).filter(c => !ruleSatisfied(c, state, stats, extAdj));
}

function requiredShapeViolations(state, roomIdxs) {
    return roomIdxs.filter(roomIdx => state.rooms[roomIdx].shapeRequired && !isRectangle(state, roomIdx));
}

// =============================================================================
// Coarse solve: seeds
// =============================================================================

// Adjacency demands a seed must satisfy right away: required connects (own or
// mirrored via 'pull' with a non-any source) whose partner already has cells
// on the grid or a placed seed. Satisfying them at seed time makes the rule
// hold by construction — grown cells are never taken back below cwl.
function seedAdjacencyDemands(room, state, seeds) {
    const demands = [];
    const present = t => seeds[t] !== undefined || state.cells.includes(t);

    for (const c of room.rules) {
        if (c.kind === "connect" && c.required) {
            const placed = c.targets.filter(present);
            if (c.any) {
                if (placed.length) {
                    demands.push(placed);
                }
            } else {
                for (const t of placed) {
                    demands.push([t]);
                }
            }
        } else if (c.kind === "pull" && c.src && !c.src.any) {
            const placed = c.targets.filter(present);
            for (const t of placed) {
                demands.push([t]);
            }
        }
    }
    return demands;
}

function seedCandidates(room, state, taken, seeds = {}) {
    const { W, H } = state;
    const req = room.rules.filter(c => c.required);
    const demands = seedAdjacencyDemands(room, state, seeds);
    const out = [];

    for (let idx = 0; idx < W * H; idx++) {
        if (taken.has(idx) || state.cells[idx] !== -1) {
            continue;
        }
        if (room.isHub && state.anchorCells?.has(idx)) {
            continue;
        }
        let legal = true;
        for (const c of req) {
            if (c.kind === "at") {
                legal = c.dirs.every(d => onWall(idx, d, W, H));
            } else if (c.kind === "not_at") {
                legal = c.dirs[0] === "edge"
                    ? !onWall(idx, "edge", W, H)
                    : c.dirs.every(d => !onWall(idx, d, W, H));
            } else if (c.kind === "enclosed") {
                legal = !onWall(idx, "edge", W, H);
            }
            if (!legal) {
                break;
            }
        }
        if (!legal) {
            continue;
        }

        // within reach of every demanded partner: the tether stage closes the
        // gap. Wall-pinned rooms (required directional 'at') have no seed
        // freedom — the tether corridor must come to them, however far away
        const pinned = req.some(c => c.kind === "at" && c.dirs.some(d => d !== "edge"));
        const reach = pinned ? W + H : Math.min(Math.max(Math.ceil(room.quota * 0.6), 2), 4);
        const adjOk = demands.every(options => options.some(t => {
            if (seeds[t] !== undefined && manhattan(idx, seeds[t], W) <= reach) {
                return true;
            }
            for (let i = 0; i < state.cells.length; i++) {
                if (state.cells[i] === t && manhattan(idx, i, W) <= reach) {
                    return true;
                }
            }
            return false;
        }));
        if (adjOk) {
            out.push(idx);
        }
    }
    return out;
}

function scoreSeed(idx, room, state, seeds, rng) {
    const { W, H } = state;
    let s = rng();

    const side = state.sideOf?.get(room.index);
    if (side) {
        const cs = cellSide(state, idx);
        if (cs && cs !== side) {
            s -= SIDE_SEED_PENALTY;
        }
    }
    for (const c of room.rules) {
        const w = Math.min(c.weight, G_WEIGHT_CAP);
        if (c.required || c.kind === "pull") {
            if (c.kind === "connect" || c.kind === "pull") {
                for (const t of c.targets) {
                    if (seeds[t] !== undefined) {
                        s -= manhattan(idx, seeds[t], W) * 2 * (c.strength ?? 1);
                    }
                }
            }
            continue;
        }
        if (c.kind === "at") {
            for (const d of c.dirs) {
                s -= distToWall(idx, d, W, H) * w;
            }
        } else if (c.kind === "not_at") {
            for (const d of c.dirs) {
                s += Math.min(distToWall(idx, d, W, H), 2) * w;
            }
        } else if (c.kind === "enclosed") {
            s += Math.min(distToWall(idx, "edge", W, H), 2) * w;
        } else if (c.kind === "far") {
            for (const t of c.targets) {
                if (seeds[t] !== undefined) {
                    s += Math.min(manhattan(idx, seeds[t], W), 6) * w * 0.5;
                }
            }
        } else if (c.kind === "close" || c.kind === "connect") {
            for (const t of c.targets) {
                if (seeds[t] !== undefined) {
                    s -= manhattan(idx, seeds[t], W) * w * 0.5;
                }
            }
        }
    }

    // spread seeds apart so regions have room to grow
    let minD = Infinity;
    for (const sIdx of Object.values(seeds)) {
        minD = Math.min(minD, manhattan(idx, sIdx, W));
    }
    if (minD !== Infinity) {
        s += Math.min(minD, 4);
    }

    // hub spine must start near wall-pinned dependents, or it can never reach them
    if (room.isHub && state.anchors?.length) {
        for (const a of state.anchors) {
            s -= Math.max(0, manhattan(idx, a.cell, W) - a.reach) * 1.5;
        }
    }
    return s;
}

function constraintHardness(room) {
    let h = 0;
    for (const c of room.rules) {
        if (!c.required) {
            continue;
        }
        if (c.kind === "at") h += c.dirs.filter(d => d !== "edge").length * 4 + 2;
        if (c.kind === "not_at") h += 2;
        if (c.kind === "enclosed") h += 3;
        if (c.kind === "connect") h += 1;
    }
    return h;
}

function placeSeeds(roomIdxs, state, rng) {
    const rooms = state.rooms;
    const order = roomIdxs.slice().sort((a, b) =>
        (constraintHardness(rooms[b]) - constraintHardness(rooms[a])) ||
        (rooms[b].quota - rooms[a].quota));

    const seeds = {};
    let budget = SEED_NODE_BUDGET;
    const { W, H } = state;
    const nbA = [0, 0, 0, 0];
    const nbB = [0, 0, 0, 0];

    // a sealed seed can neither grow nor tether — candidates must keep an open
    // neighbor themselves (waivable when all their demands are already adjacent)
    // and must NEVER take an adjacent seed's last open neighbor
    const hasOpenNeighbor = (idx, taken) => {
        const isOpen = i => state.cells[i] === -1 && !taken.has(i) && i !== idx;
        const nn = neighborsOf(idx, W, H, nbA);
        for (let i = 0; i < nn; i++) {
            if (isOpen(nbA[i])) {
                return true;
            }
        }
        return false;
    };

    const sealsNeighborSeed = (idx, taken) => {
        const isOpen = i => state.cells[i] === -1 && !taken.has(i) && i !== idx;
        const nn = neighborsOf(idx, W, H, nbA);
        for (let i = 0; i < nn; i++) {
            if (!taken.has(nbA[i])) {
                continue;
            }
            const nn2 = neighborsOf(nbA[i], W, H, nbB);
            let ok = false;
            for (let j = 0; j < nn2; j++) {
                if (isOpen(nbB[j])) {
                    ok = true;
                    break;
                }
            }
            if (!ok) {
                return true;
            }
        }
        return false;
    };

    const rec = (i) => {
        if (i === order.length) {
            return true;
        }
        if (--budget < 0) {
            return false;
        }
        const r = order[i];
        const taken = new Set(Object.values(seeds));

        // sealed is acceptable when every demanded partner is directly adjacent
        // (nothing left to tether; the room just can't grow much)
        const demandsAdjacent = (idx) => {
            const demands = seedAdjacencyDemands(rooms[r], state, seeds);
            if (!demands.length) {
                return false;
            }
            const nn = neighborsOf(idx, W, H, nbA);
            return demands.every(options => options.some(t => {
                for (let i2 = 0; i2 < nn; i2++) {
                    if (state.cells[nbA[i2]] === t || seeds[t] === nbA[i2]) {
                        return true;
                    }
                }
                return false;
            }));
        };

        const cands = seedCandidates(rooms[r], state, taken, seeds)
            .filter(idx => !sealsNeighborSeed(idx, taken) && (hasOpenNeighbor(idx, taken) || demandsAdjacent(idx)))
            .map(idx => ({ idx, s: scoreSeed(idx, rooms[r], state, seeds, rng) }))
            .sort((a, b) => b.s - a.s)
            .map(c => c.idx);

        for (const idx of cands.slice(0, SEED_CANDIDATES_PER_ROOM)) {
            seeds[r] = idx;
            if (rec(i + 1)) {
                return true;
            }
            delete seeds[r];
        }
        if (state._dbg && !cands.length) {
            console.error(`  seed dead-end: ${rooms[r].id} has no candidates`);
        }
        return false;
    };

    return rec(0) ? seeds : null;
}

// =============================================================================
// Corridor spine: constructed hub placement
// =============================================================================

// Paint the hallway network as a full-span corridor band BEFORE anything else
// is seeded. Every dependent room can then seed adjacent to it, hub tethering
// disappears, and the 'connect any hallways' family holds nearly by
// construction — random hub growth was the dominant attempt killer (79/80
// attempts died routing corridors on bad seeds). Multiple hub rooms become
// consecutive segments along the span, so hub-hub required connects hold and
// each segment touches one end wall ('hallways at edge'). Orientation,
// position and segment order are per-attempt search variables.
// Returns the spine spec { horizontal, p, t } (stored as state.spine) or null.
function paintSpine(state, hubIdxs, rng) {
    const { W, H, cells, rooms } = state;
    const horizontal = rng() < 0.5;
    const span = horizontal ? W : H;
    const depth = horizontal ? H : W;
    if (depth < 3) {
        return null;
    }

    const hubQuota = hubIdxs.reduce((s, i) => s + rooms[i].quota, 0);
    const t = Math.max(1, Math.min(Math.round(hubQuota / span), depth - 2));

    // keep at least one room band on each side of the corridor
    const p = 1 + Math.floor(rng() * (depth - t - 1));

    const order = shuffled(hubIdxs, rng);
    const cum = [];
    let acc = 0;
    for (const i of order) {
        acc += rooms[i].quota;
        cum.push(acc);
    }

    for (let s = 0; s < span; s++) {
        const f = ((s + 0.5) / span) * acc;
        let k = 0;
        while (k < cum.length - 1 && f >= cum[k]) {
            k++;
        }
        for (let d = p; d < p + t; d++) {
            cells[horizontal ? d * W + s : s * W + d] = order[k];
        }
    }
    return { horizontal, p, t };
}

// Side of the spine a cell lies on: +1 (above/west-of), -1 (below/east-of),
// 0 (inside the corridor band, or no spine).
function cellSide(state, idx) {
    const sp = state.spine;
    if (!sp) {
        return 0;
    }
    const d = sp.horizontal ? (idx / state.W) | 0 : idx % state.W;
    return d < sp.p ? 1 : d >= sp.p + sp.t ? -1 : 0;
}

// Assign each non-hub room to one side of the spine so that quota demand
// matches side capacity — otherwise big rooms get boxed in an overcommitted
// band while the deficit pools as hallway bloat on the other side. Rooms tied
// by required (non-any) connects move as one group; required at/not_at rules
// force or forbid the side that owns that wall. Best-effort: overflow is
// allowed, and the assignment only steers seeds/growth (soft penalties).
function assignSides(state, roomIdxs) {
    const { rooms, spine } = state;
    const assignable = new Set(roomIdxs);

    const parent = new Map(roomIdxs.map(i => [i, i]));
    const find = i => {
        while (parent.get(i) !== i) {
            parent.set(i, parent.get(parent.get(i)));
            i = parent.get(i);
        }
        return i;
    };
    for (const i of roomIdxs) {
        for (const c of rooms[i].rules) {
            if (c.kind === "connect" && c.required && !c.any) {
                for (const t of c.targets) {
                    if (assignable.has(t)) {
                        parent.set(find(i), find(t));
                    }
                }
            }
        }
    }

    const groups = new Map();
    for (const i of roomIdxs) {
        const g = find(i);
        if (!groups.has(g)) {
            // allowed: bit 1 = side +1, bit 2 = side -1
            groups.set(g, { members: [], quota: 0, allowed: 3 });
        }
        const grp = groups.get(g);
        grp.members.push(i);
        grp.quota += rooms[i].quota;
    }

    // wall owned exclusively by one side (walls parallel to the spine)
    const wallSide = d => {
        if (spine.horizontal) {
            return d === "north" ? 1 : d === "south" ? -1 : 0;
        }
        return d === "west" ? 1 : d === "east" ? -1 : 0;
    };
    for (const grp of groups.values()) {
        for (const i of grp.members) {
            for (const c of rooms[i].rules) {
                if (!c.required || !c.dirs) {
                    continue;
                }
                for (const d of c.dirs) {
                    const s = wallSide(d);
                    if (s === 0) {
                        continue;
                    }
                    if (c.kind === "at") {
                        grp.allowed &= s === 1 ? 1 : 2;
                    } else if (c.kind === "not_at") {
                        grp.allowed &= s === 1 ? 2 : 1;
                    }
                }
            }
        }
    }

    const span = spine.horizontal ? state.W : state.H;
    const depth = spine.horizontal ? state.H : state.W;
    const cap = { 1: span * spine.p, "-1": span * (depth - spine.p - spine.t) };
    const rem = { 1: cap[1], "-1": cap[-1] };

    // forced groups first, then big ones; free groups go to the emptier side
    const ordered = [...groups.values()].sort((a, b) =>
        ((a.allowed === 3 ? 1 : 0) - (b.allowed === 3 ? 1 : 0)) || (b.quota - a.quota));

    state.sideOf = new Map();
    for (const grp of ordered) {
        let side;
        if (grp.allowed === 1) {
            side = 1;
        } else if (grp.allowed === 2) {
            side = -1;
        } else if (grp.allowed === 0) {
            continue;
        } else {
            side = (rem[1] - grp.quota) / cap[1] >= (rem[-1] - grp.quota) / cap[-1] ? 1 : -1;
        }
        rem[side] -= grp.quota;
        for (const i of grp.members) {
            state.sideOf.set(i, side);
        }
    }
}

// =============================================================================
// Coarse solve: growth
// =============================================================================

// Tether: immediately after seeding, claim a free-cell shortest path from each
// room's seed to every required-connect partner already on the grid. This makes
// connectivity constructive — general growth can no longer block the corridor.
// Returns false when some corridor cannot be routed (attempt should retry).
function tetherRooms(state, roomIdxs, mask, extAdj, bestEffort = false) {
    const { cells } = state;
    const rooms = state.rooms;

    const order = roomIdxs.slice().sort((a, b) =>
        constraintHardness(rooms[b]) - constraintHardness(rooms[a]));

    for (const r of order) {
        const demands = seedAdjacencyDemands(rooms[r], state, {});
        const extDemands = rooms[r].rules
            .filter(c => c.kind === "connect" && c.required && c.externalTargets?.length && extAdj)
            .flatMap(c => c.any ? [c.externalTargets.map(n => extAdj[n]).filter(Boolean)] : c.externalTargets.map(n => [extAdj[n]]).filter(o => o[0]));

        for (const options of demands) {
            const isTarget = i => options.some(t => cells[i] === t);
            if (touchesTarget(state, r, isTarget)) {
                continue;
            }
            if (!carveFreePath(state, r, isTarget, mask, !bestEffort)) {
                if (state._dbg) {
                    console.error(`  tether dead-end: ${rooms[r].id} -> [${options.map(t => rooms[t].id)}]`);
                    let dump = "";
                    for (let y = 0; y < state.H; y++) {
                        let row = "    ";
                        for (let x = 0; x < state.W; x++) {
                            const v = state.cells[y * state.W + x];
                            row += v < 0 ? "." : rooms[v].id[0] + (rooms[v].id.at(-1).match(/\d/) ? rooms[v].id.at(-1) : "");
                        }
                        dump += row + "\n";
                    }
                    console.error(dump);
                }
                if (!bestEffort) {
                    return false;
                }
                continue;
            }
        }
        for (const options of extDemands) {
            const isTarget = i => options.some(set => set.has(i));
            if (touchesTarget(state, r, isTarget)) {
                continue;
            }
            if (!carveFreePath(state, r, isTarget, mask, !bestEffort) && !bestEffort) {
                return false;
            }
        }
    }
    return true;
}

function touchesTarget(state, r, isTarget) {
    const { W, H, cells } = state;
    const nb = [0, 0, 0, 0];
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== r) {
            continue;
        }
        const nn = neighborsOf(i, W, H, nb);
        for (let j = 0; j < nn; j++) {
            if (isTarget(nb[j])) {
                return true;
            }
        }
    }
    return false;
}

// BFS from room r's cells through FREE masked cells to any cell where isTarget
// holds; claims the path for r. Free-only: never disturbs other rooms, and
// prefers not to claim the last open neighbor of a foreign room (that would
// seal it before its own tether/growth). allowSeals permits a sealing corridor
// as a second pass, i.e. when the caller would otherwise have to give up.
function carveFreePath(state, r, isTarget, mask, allowSeals = true) {
    const { W, H, cells } = state;
    const nb = [0, 0, 0, 0];
    const nb2 = [0, 0, 0, 0];

    // sealsSomeRoom runs inside the BFS neighbor loop, so its inner scan needs
    // its own scratch buffer: sharing nb made the BFS read stale neighbors and
    // walk to cells that are not adjacent to the current one.
    const nb3 = [0, 0, 0, 0];

    const sealsSomeRoom = (o) => {
        const nn = neighborsOf(o, W, H, nb2);
        const checked = new Set();
        for (let i = 0; i < nn; i++) {
            const q = cells[nb2[i]];
            if (q < 0 || q === r || checked.has(q)) {
                continue;
            }
            checked.add(q);
            let hasOther = false;
            for (let j = 0; j < cells.length && !hasOther; j++) {
                if (cells[j] !== q) {
                    continue;
                }
                const nn3 = neighborsOf(j, W, H, nb3);
                for (let k = 0; k < nn3; k++) {
                    if (cells[nb3[k]] === -1 && nb3[k] !== o) {
                        hasOther = true;
                        break;
                    }
                }
            }
            if (!hasOther) {
                return true;
            }
        }
        return false;
    };

    // seed pockets: free cells reserved as growth room around another room's
    // seed — a corridor hugging a fresh seed is how rooms end up sealed at
    // 1 cell. Respected in the strict pass, ignored in the desperate one.
    const inForeignPocket = (o) => {
        const owner = state.seedPockets?.get(o);
        return owner !== undefined && owner !== r;
    };

    const bfs = (avoidSeals, avoidPockets) => {
        const prev = new Int32Array(cells.length).fill(-2);
        const queue = [];
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === r) {
                prev[i] = -1;
                queue.push(i);
            }
        }
        for (let q = 0; q < queue.length; q++) {
            const cur = queue[q];
            const nn = neighborsOf(cur, W, H, nb);
            for (let i = 0; i < nn; i++) {
                const o = nb[i];
                if (prev[o] !== -2) {
                    continue;
                }
                if (isTarget(o)) {
                    let p = cur;
                    while (p !== -1 && cells[p] === -1) {
                        cells[p] = r;
                        p = prev[p];
                    }
                    return true;
                }
                if (cells[o] === -1 && (!mask || mask.has(o))
                    && !(avoidSeals && sealsSomeRoom(o))
                    && !(avoidPockets && inForeignPocket(o))) {
                    prev[o] = cur;
                    queue.push(o);
                }
            }
        }
        return false;
    };

    return bfs(true, true) || bfs(true, false) || (allowSeals && bfs(false, false));
}

function dumpCoarse(state, label) {
    const letters = assignLetters(state.rooms, state.rooms.map((_, i) => i));
    let out = label + "\n";
    for (let y = 0; y < state.H; y++) {
        let row = "    ";
        for (let x = 0; x < state.W; x++) {
            const v = state.cells[y * state.W + x];
            row += v < 0 ? "." : letters[v];
        }
        out += row + "\n";
    }
    console.error(out);
}

// Anchors: wall/corner spots where a hub-dependent room is pinned by a
// required directional 'at'. The hub spine is pulled to pass within reach.
function computeAnchors(rooms, hubSet, W, H) {
    const anchors = [];
    for (const room of rooms) {
        if (hubSet.has(room.index)) {
            continue;
        }
        const needsHub = room.rules.some(c => c.kind === "connect" && c.required && c.targets.some(t => hubSet.has(t)));
        if (!needsHub) {
            continue;
        }
        const at = room.rules.find(c => c.kind === "at" && c.required && c.dirs.some(d => d !== "edge"));
        if (!at) {
            continue;
        }
        let x = Math.floor(W / 2);
        let y = Math.floor(H / 2);
        for (const d of at.dirs) {
            if (d === "west") x = 0;
            if (d === "east") x = W - 1;
            if (d === "north") y = 0;
            if (d === "south") y = H - 1;
        }
        anchors.push({ cell: y * W + x, reach: Math.max(1, Math.round(Math.sqrt(room.quota))) });
    }
    return anchors;
}

function anchorReached(state, anchor) {
    const { W, cells, rooms } = state;
    for (let i = 0; i < cells.length; i++) {
        const r = cells[i];
        if (r >= 0 && rooms[r].isHub && manhattan(i, anchor.cell, W) <= anchor.reach) {
            return true;
        }
    }
    return false;
}

// Hard per-cell legality during growth (rules that individual cells can break).
function cellLegalForRoom(state, idx, room) {
    const { W, H } = state;

    // anchor cells are reserved for the wall-pinned rooms they belong to
    if (room.isHub && state.anchorCells?.has(idx)) {
        return false;
    }
    for (const c of room.rules) {
        if (!c.required) {
            continue;
        }
        if (c.kind === "not_at") {
            const bad = c.dirs[0] === "edge"
                ? onWall(idx, "edge", W, H)
                : c.dirs.some(d => onWall(idx, d, W, H));
            if (bad) {
                return false;
            }
        } else if (c.kind === "enclosed" && onWall(idx, "edge", W, H)) {
            return false;
        }
    }
    return true;
}

function nearestCellOfRoom(state, fromIdx, roomIdx) {
    const { W, cells } = state;
    let best = Infinity;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] === roomIdx) {
            const d = manhattan(fromIdx, i, W);
            if (d < best) {
                best = d;
            }
        }
    }
    return best;
}

function growthCellScore(idx, room, state, stats, rng, extAdj) {
    const { W, H, cells, cellW, cellH } = state;
    let s = rng() * 0.5;

    const nb = [0, 0, 0, 0];
    const nn = neighborsOf(idx, W, H, nb);
    let same = 0;
    for (let i = 0; i < nn; i++) {
        if (cells[nb[i]] === room.index) {
            same++;
        }
    }
    s += same * G_COMPACT;

    for (const c of room.rules) {
        const w = Math.min(c.weight, G_WEIGHT_CAP);
        if ((c.kind === "connect" && c.required) || c.kind === "pull") {
            if (c.src && ruleSatisfied(c.src, state, stats, extAdj)) {
                continue;
            }
            const strength = c.strength ?? 1;
            const lenOk = t => {
                const len = stats.sharedLen(room.index, t);
                return len > 0 && (c.cwl === 0 || len >= c.cwl - 1e-6);
            };
            let need = c.targets.filter(t => !lenOk(t));
            let needExt = (c.externalTargets || []).filter(n => !extAdjTouches(state, stats, room.index, n, extAdj, c.cwl));
            if (c.any) {
                const satisfied = need.length < c.targets.length || needExt.length < (c.externalTargets || []).length;
                if (satisfied) {
                    need = [];
                    needExt = [];
                } else if (needExt.length) {
                    // children usually connect outward: prefer the external target
                    need = [];
                    needExt = needExt.slice(0, 1);
                } else {
                    // aim at the nearest target only
                    need = need.slice().sort((a, b) => nearestCellOfRoom(state, idx, a) - nearestCellOfRoom(state, idx, b)).slice(0, 1);
                }
            }
            for (const t of need) {
                let adj = false;
                for (let i = 0; i < nn; i++) {
                    if (cells[nb[i]] === t) {
                        adj = true;
                    }
                }
                if (adj) {
                    s += G_CONNECT_ADJ * strength;
                } else {
                    const d = nearestCellOfRoom(state, idx, t);
                    if (d < Infinity) {
                        s -= d * G_CONNECT_DIST * strength;
                    }
                }
            }
            for (const name of needExt) {
                const set = extAdj?.[name];
                if (!set) {
                    continue;
                }
                let adj = false;
                let dMin = Infinity;
                for (const cellIdx of set) {
                    const d = manhattan(idx, cellIdx, W);
                    if (d === 1) {
                        adj = true;
                        break;
                    }
                    if (d < dMin) {
                        dMin = d;
                    }
                }
                if (adj) {
                    s += G_CONNECT_ADJ * strength;
                } else if (dMin < Infinity) {
                    s -= dMin * G_CONNECT_DIST * strength;
                }
            }
        } else if (c.kind === "at" && !c.required) {
            for (const d of c.dirs) {
                s += onWall(idx, d, W, H) ? G_AT_WALL * Math.min(w, 2) * 0.1 : -distToWall(idx, d, W, H) * G_AT_DIST * Math.min(w, 2) * 0.1;
            }
        } else if (c.kind === "not_at" && !c.required) {
            const bad = c.dirs[0] === "edge" ? onWall(idx, "edge", W, H) : c.dirs.some(d => onWall(idx, d, W, H));
            if (bad) {
                s -= G_AT_WALL * Math.min(w, 2) * 0.15;
            }
        }
    }

    const side = state.sideOf?.get(room.index);
    if (side) {
        const cs = cellSide(state, idx);
        if (cs && cs !== side) {
            s -= G_SIDE;
        }
    }
    // hub spine: pull toward wall-pinned dependents not yet within reach
    if (room.isHub && stats.unreachedAnchors?.length) {
        for (const a of stats.unreachedAnchors) {
            s -= Math.max(0, manhattan(idx, a.cell, W) - a.reach) * G_ANCHOR;
        }
    }

    // discourage growing the bounding box past ratio_max
    if (room.ratioMax > 0) {
        const b = stats.bbox[room.index];
        const x = idx % W;
        const y = (idx / W) | 0;
        const bw = (Math.max(b.x1, x) - Math.min(b.x0, x) + 1) * cellW;
        const bh = (Math.max(b.y1, y) - Math.min(b.y0, y) + 1) * cellH;
        const ratio = Math.max(bw / bh, bh / bw);
        if (ratio > room.ratioMax) {
            s -= G_RATIO * (ratio - room.ratioMax);
        }
    }

    return s;
}

// Grow regions from seeds until the mask is full. mask = Set of growable cells
// (whole grid for the outer solve, the parent region for inside blocks).
// toQuota stops each room at its quota (hub stage: leave space for the rest);
// absorbIdxs limits which rooms may take leftover cells in the fallback.
function growRegions(state, roomIdxs, seeds, mask, rng, extAdj, toQuota = false, absorbIdxs = roomIdxs) {
    const { W, H, cells } = state;
    const rooms = state.rooms;
    for (const [r, idx] of Object.entries(seeds)) {
        cells[idx] = +r;
    }

    let free = 0;
    for (const idx of mask) {
        if (cells[idx] === -1) {
            free++;
        }
    }

    const nb = [0, 0, 0, 0];
    while (free > 0) {
        const stats = collectStats(state);
        if (toQuota && roomIdxs.every(r => stats.sizes[r] >= rooms[r].quota)) {
            return true;
        }
        if (state.anchors?.length) {
            stats.unreachedAnchors = state.anchors.filter(a => !anchorReached(state, a));
        }

        // candidate rooms by deficit; overflow shared proportionally
        const growable = toQuota ? roomIdxs.filter(r => stats.sizes[r] < rooms[r].quota) : roomIdxs;
        // proportional fill: rooms grow in lockstep relative to their quota,
        // otherwise big rooms engulf small ones before they can expand
        const byPriority = growable.slice().sort((a, b) => {
            const fa = stats.sizes[a] / rooms[a].quota;
            const fb = stats.sizes[b] / rooms[b].quota;
            return (fa - fb) || (rooms[b].quota - rooms[a].quota);
        });

        let placed = false;
        for (const r of byPriority) {
            // frontier: free masked cells adjacent to r
            let bestIdx = -1;
            let bestScore = -Infinity;
            for (const idx of mask) {
                if (cells[idx] !== -1 || !cellLegalForRoom(state, idx, rooms[r])) {
                    continue;
                }
                const nn = neighborsOf(idx, W, H, nb);
                let adj = false;
                for (let i = 0; i < nn; i++) {
                    if (cells[nb[i]] === r) {
                        adj = true;
                        break;
                    }
                }
                if (!adj) {
                    continue;
                }
                const s = growthCellScore(idx, rooms[r], state, stats, rng, extAdj);
                if (s > bestScore) {
                    bestScore = s;
                    bestIdx = idx;
                }
            }
            if (bestIdx >= 0) {
                cells[bestIdx] = r;
                free--;
                placed = true;
                break;
            }
        }

        if (!placed) {
            if (toQuota) {
                // hub stage: nothing left to grow legally, quotas are advisory
                return true;
            }
            // hard rules block everyone: force-assign remaining cells to any
            // adjacent absorb-allowed room, preferring legal + max deficit
            const stats2 = collectStats(state);
            let changed = false;
            for (const idx of mask) {
                if (cells[idx] !== -1) {
                    continue;
                }
                const nn = neighborsOf(idx, W, H, nb);
                let best = -1;
                let bestKey = -Infinity;
                for (let i = 0; i < nn; i++) {
                    const o = cells[nb[i]];
                    if (o < 0 || !absorbIdxs.includes(o)) {
                        continue;
                    }
                    const legal = cellLegalForRoom(state, idx, rooms[o]) ? 1000 : 0;
                    const k = legal + (rooms[o].quota - stats2.sizes[o]);
                    if (k > bestKey) {
                        bestKey = k;
                        best = o;
                    }
                }
                if (best >= 0) {
                    cells[idx] = best;
                    free--;
                    changed = true;
                }
            }
            if (!changed) {
                return false;
            }
        }
    }
    return true;
}

// =============================================================================
// Repair: single-cell transfers to fix violated required rules
// =============================================================================

function regionStaysConnected(state, roomIdx, removeIdx) {
    const { W, H, cells } = state;
    const members = [];
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] === roomIdx && i !== removeIdx) {
            members.push(i);
        }
    }
    if (members.length === 0) {
        return false;
    }
    const memberSet = new Set(members);
    const seen = new Set([members[0]]);
    const queue = [members[0]];
    const nb = [0, 0, 0, 0];
    while (queue.length) {
        const cur = queue.pop();
        const nn = neighborsOf(cur, W, H, nb);
        for (let i = 0; i < nn; i++) {
            const o = nb[i];
            if (memberSet.has(o) && !seen.has(o)) {
                seen.add(o);
                queue.push(o);
            }
        }
    }
    return seen.size === members.length;
}

// Transfer cell idx to room r if the donor stays connected and no required
// rule of donor/receiver becomes violated. mask (when given) restricts which
// cells may change owner — inside-block repair must stay in the parent region.
function tryTransfer(state, idx, r, extAdj, mask, context) {
    const donor = state.cells[idx];
    if (donor === r || donor < 0) {
        return false;
    }
    if (mask && !mask.has(idx)) {
        return false;
    }
    if (!cellLegalForRoom(state, idx, state.rooms[r])) {
        return false;
    }
    if (!context?.connectedDonors.has(donor) && !regionStaysConnected(state, donor, idx)) {
        return false;
    }

    // no-regression: only rules that were satisfied before must stay satisfied
    // (rules mid-repair are legitimately unsatisfied on intermediate steps)
    const rules = context?.rules || requiredRules(state.rooms);
    const pairKey = donor < r ? donor * state.rooms.length + r : r * state.rooms.length + donor;
    let affected = context?.affectedRules.get(pairKey);
    if (!affected) {
        affected = rules.filter(c =>
            c.subject === donor || c.subject === r ||
            (c.targets || []).includes(donor) || (c.targets || []).includes(r));
        context?.affectedRules.set(pairKey, affected);
    }
    const before = context?.stats || collectStats(state);
    const satBefore = affected.map(c => {
        if (context?.satisfaction.has(c)) {
            return context.satisfaction.get(c);
        }
        if (context?.initialSatisfaction?.has(c)) {
            return context.initialSatisfaction.get(c);
        }
        const satisfied = ruleSatisfied(c, state, before, extAdj);
        context?.initialSatisfaction?.set(c, satisfied);
        return satisfied;
    });

    state.cells[idx] = r;
    const after = collectStats(state);
    const satAfter = context ? affected.map(c => ruleSatisfied(c, state, after, extAdj)) : null;
    const broken = context
        ? satAfter.some((satisfied, i) => satBefore[i] && !satisfied)
        : affected.some((c, i) => satBefore[i] && !ruleSatisfied(c, state, after, extAdj));
    if (broken) {
        state.cells[idx] = donor;
        return false;
    }
    if (context) {
        context.stats = after;
        affected.forEach((rule, i) => context.satisfaction.set(rule, satAfter[i]));
    }
    return true;
}

// Shortest cell path from region a to any cell matching isTarget (BFS,
// 4-neighbor). Returns the intermediate cell indices (owned by other rooms)
// or null when unreachable.
function pathBetweenRegions(state, a, isTarget, mask) {
    const { W, H, cells } = state;
    const prev = new Int32Array(cells.length).fill(-2);
    const queue = [];
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] === a) {
            prev[i] = -1;
            queue.push(i);
        }
    }
    const nb = [0, 0, 0, 0];
    for (let q = 0; q < queue.length; q++) {
        const cur = queue[q];
        const nn = neighborsOf(cur, W, H, nb);
        for (let i = 0; i < nn; i++) {
            const o = nb[i];
            if (prev[o] !== -2) {
                continue;
            }
            if (mask && !mask.has(o) && !isTarget(o)) {
                continue;
            }
            prev[o] = cur;
            if (isTarget(o)) {
                const path = [];
                let p = cur;
                while (p !== -1 && cells[p] !== a) {
                    path.push(p);
                    p = prev[p];
                }
                return path.reverse();
            }
            if (cells[o] >= 0) {
                queue.push(o);
            }
        }
    }
    return null;
}

// Straight run (cells) between region r and a target predicate — same
// door-width measure as straightSharedRun, but for widenContact's isTarget
// closures (`i => cells[i] === t` or `i => set.has(i)`), which aren't one of
// straightSharedRun's two accepted region shapes.
function runToPredicate(state, r, isTarget) {
    const { cells } = state;
    return longestAxisRun(state, (i, j) =>
        (cells[i] === r && isTarget(j)) || (cells[j] === r && isTarget(i)));
}

// Widen an existing contact between region r and a target region: transfer a
// cell that touches both to r. One cell per call; repair loops until cwl
// holds. Among candidates, prefer the one that most extends the longest
// straight run over one that only piles onto a corner-wrapped sum — a
// corner contact can sum to cwl while no single segment is door-wide.
function widenContact(state, r, isTarget, extAdj, mask) {
    const { W, H, cells } = state;
    const nb = [0, 0, 0, 0];
    const candidates = [];
    for (let idx = 0; idx < cells.length; idx++) {
        const own = cells[idx];
        if (own < 0 || own === r || isTarget(idx)) {
            continue;
        }
        const nn = neighborsOf(idx, W, H, nb);
        let touchR = false;
        let touchT = false;
        for (let i = 0; i < nn; i++) {
            if (cells[nb[i]] === r) touchR = true;
            if (isTarget(nb[i])) touchT = true;
        }
        if (touchR && touchT) {
            candidates.push(idx);
        }
    }
    const scored = candidates.map(idx => {
        const prevOwner = cells[idx];
        cells[idx] = r;
        const run = runToPredicate(state, r, isTarget);
        cells[idx] = prevOwner;
        return { idx, run };
    }).sort((a, b) => b.run - a.run);

    for (const { idx } of scored) {
        if (tryTransfer(state, idx, r, extAdj, mask)) {
            return true;
        }
    }
    return false;
}

function repair(state, extAdj, mask) {
    const nb = [0, 0, 0, 0];
    for (let round = 0; round < 12; round++) {
        const unsat = unsatisfiedRequired(state, extAdj);
        if (!unsat.length) {
            return;
        }
        let progressed = false;

        for (const c of unsat) {
            const r = c.subject;

            if (c.kind === "connect") {
                const stats = collectStats(state);
                const cells = state.cells;
                // repair's "done" target is the same straight-run measure as
                // ruleSatisfied, else it could declare victory on a contact
                // that sums to cwl but wraps a corner with no door-wide run
                const lenOk = t => {
                    if (stats.sharedLen(r, t) === 0) return false;
                    if (c.cwl === 0) return true;
                    return stats.straightRun(r, t) * state.cellW >= c.cwl - 1e-6;
                };
                const extOk = n => extAdjTouches(state, stats, r, n, extAdj, c.cwl);

                let missing = c.targets.filter(t => !lenOk(t)).map(t => ({
                    isTarget: i => cells[i] === t,
                    touching: stats.sharedLen(r, t) > 0,
                }));
                let missingExt = (c.externalTargets || []).filter(n => !extOk(n)).map(n => {
                    const set = extAdj?.[n];
                    return set && {
                        isTarget: i => set.has(i),
                        touching: extAdjTouches(state, stats, r, n, extAdj, 0),
                    };
                }).filter(Boolean);

                if (c.any) {
                    if (missing.length < c.targets.length || missingExt.length < (c.externalTargets || []).length) {
                        missing = [];
                        missingExt = [];
                    } else {
                        // fix the cheapest single option: touching beats distant
                        const all = [...missing, ...missingExt].sort((a, b) => (b.touching - a.touching) ||
                            ((pathBetweenRegions(state, r, a.isTarget, mask)?.length ?? 99) - (pathBetweenRegions(state, r, b.isTarget, mask)?.length ?? 99)));
                        missing = all.slice(0, 1);
                        missingExt = [];
                    }
                }

                for (const m of [...missing, ...missingExt]) {
                    if (m.touching) {
                        if (widenContact(state, r, m.isTarget, extAdj, mask)) {
                            progressed = true;
                        }
                        continue;
                    }
                    const path = pathBetweenRegions(state, r, m.isTarget, mask);
                    if (!path) {
                        continue;
                    }
                    for (const idx of path) {
                        if (tryTransfer(state, idx, r, extAdj, mask)) {
                            progressed = true;
                        } else {
                            break;
                        }
                    }
                }
            } else if (c.kind === "at") {
                // pull the room onto the wall: wall cell adjacent to the region
                for (const d of c.dirs) {
                    for (let idx = 0; idx < state.cells.length; idx++) {
                        if (!onWall(idx, d, state.W, state.H) || state.cells[idx] === r) {
                            continue;
                        }
                        const nn = neighborsOf(idx, state.W, state.H, nb);
                        let adj = false;
                        for (let i = 0; i < nn; i++) {
                            if (state.cells[nb[i]] === r) {
                                adj = true;
                            }
                        }
                        if (adj && tryTransfer(state, idx, r, extAdj, mask)) {
                            progressed = true;
                            break;
                        }
                    }
                }
            }
        }

        if (!progressed) {
            return;
        }
    }
}

// =============================================================================
// Rectangularization (shape=rect rooms)
// =============================================================================

function roomExtent(state, r) {
    const { W, cells } = state;
    let size = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== r) {
            continue;
        }
        const x = i % W;
        const y = (i / W) | 0;
        size++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    const bboxArea = size ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
    return { size, x0, y0, x1, y1, bboxArea };
}

function isRectangle(state, r) {
    const e = roomExtent(state, r);
    return e.size > 0 && e.size === e.bboxArea;
}

function isRectangleInStats(stats, r) {
    const size = stats.sizes[r];
    const extent = stats.bbox[r];
    return size > 0 && size === (extent.x1 - extent.x0 + 1) * (extent.y1 - extent.y0 + 1);
}

// Like tryTransfer but also handles free cells and requires the cell to touch
// the receiving region (a transfer never checks receiver contiguity itself).
function claimCell(state, idx, r, extAdj, mask, context) {
    const { W, H, cells } = state;
    const nb = [0, 0, 0, 0];
    const nn = neighborsOf(idx, W, H, nb);
    let adj = false;
    for (let i = 0; i < nn; i++) {
        if (cells[nb[i]] === r) {
            adj = true;
            break;
        }
    }
    if (!adj) {
        return false;
    }
    if (cells[idx] === -1) {
        if (mask && !mask.has(idx)) {
            return false;
        }
        if (!cellLegalForRoom(state, idx, state.rooms[r])) {
            return false;
        }
        cells[idx] = r;
        if (context) {
            context.stats = null;
        }
        return true;
    }
    return tryTransfer(state, idx, r, extAdj, mask, context);
}

// Peel the cheapest bbox edge strip of room r: transfer every r-cell in that
// row/col to an adjacent foreign room (free-shape receivers preferred). A full
// peel shrinks the bbox by one row/col; partial peels are rolled back.
function peelStrip(state, r, extAdj, mask, roomIdxs) {
    const { W, H, cells, rooms } = state;
    const e = roomExtent(state, r);
    if (e.size <= 1) {
        return false;
    }
    const nb = [0, 0, 0, 0];

    const stripCells = (dir) => {
        const out = [];
        if (dir === "north" || dir === "south") {
            const y = dir === "north" ? e.y0 : e.y1;
            for (let x = e.x0; x <= e.x1; x++) {
                if (cells[y * W + x] === r) out.push(y * W + x);
            }
        } else {
            const x = dir === "west" ? e.x0 : e.x1;
            for (let y = e.y0; y <= e.y1; y++) {
                if (cells[y * W + x] === r) out.push(y * W + x);
            }
        }
        return out;
    };

    const strips = DIRS
        .map(d => ({ dir: d, cells: stripCells(d) }))
        .filter(s => s.cells.length > 0 && s.cells.length < e.size)
        .sort((a, b) => a.cells.length - b.cells.length);

    const stats = collectStats(state);
    for (const { dir, cells: strip } of strips) {
        const off = dir === "north" ? -W : dir === "south" ? W : dir === "west" ? -1 : 1;
        const undo = [];
        let ok = true;
        for (const idx of strip) {
            // outward receiver keeps the neighbor's own edge aligned (see trySlide)
            const outOk = dir === "north" ? idx >= W : dir === "south" ? idx < W * (H - 1)
                : dir === "west" ? idx % W > 0 : idx % W < W - 1;
            const outward = outOk ? cells[idx + off] : -1;
            const nn = neighborsOf(idx, W, H, nb);
            const receivers = [];
            for (let i = 0; i < nn; i++) {
                const o = cells[nb[i]];
                if (o >= 0 && o !== r && roomIdxs.includes(o) && !receivers.includes(o)) {
                    receivers.push(o);
                }
            }
            receivers.sort((a, b) =>
                ((b === outward ? 1 : 0) - (a === outward ? 1 : 0)) ||
                ((rooms[a].rect ? 1 : 0) - (rooms[b].rect ? 1 : 0)) ||
                ((rooms[b].quota - stats.sizes[b]) - (rooms[a].quota - stats.sizes[a])));
            let done = false;
            for (const o of receivers) {
                if (tryTransfer(state, idx, o, extAdj, mask)) {
                    undo.push(idx);
                    done = true;
                    break;
                }
            }
            if (!done) {
                ok = false;
                break;
            }
        }
        if (ok) {
            return true;
        }
        for (const idx of undo) {
            cells[idx] = r;
        }
    }
    return false;
}

// Make room r a rectangle: claim bbox holes adjacent to the region first
// (tryTransfer's no-regression keeps required rules intact), peel the cheapest
// bbox edge strip when claiming stalls. Lexicographic progress (holes, size)
// guarantees termination; the guard is a backstop only.
function rectifyRoom(state, r, extAdj, mask, roomIdxs) {
    const { W, cells } = state;
    for (let guard = 0; guard < 400; guard++) {
        const e = roomExtent(state, r);
        if (e.size === 0) {
            return false;
        }
        if (e.size === e.bboxArea) {
            return true;
        }

        let progressed = false;
        for (let y = e.y0; y <= e.y1; y++) {
            for (let x = e.x0; x <= e.x1; x++) {
                const idx = y * W + x;
                if (cells[idx] === r) {
                    continue;
                }
                if (claimCell(state, idx, r, extAdj, mask)) {
                    progressed = true;
                }
            }
        }
        if (progressed) {
            continue;
        }
        if (!peelStrip(state, r, extAdj, mask, roomIdxs)) {
            return false;
        }
    }
    return isRectangle(state, r);
}

// Multi-pass: a later room's peel can re-ragged an earlier room, so sweep
// until every rect room is rectangular or the pass budget runs out. Rooms
// that stay ragged are paid for via W_RECT in softCost.
function rectify(state, roomIdxs, extAdj, mask) {
    const rooms = state.rooms;
    const rectIdxs = roomIdxs.filter(r => rooms[r].rect);
    if (!rectIdxs.length) {
        return;
    }
    const order = rectIdxs.slice().sort((a, b) =>
        (constraintHardness(rooms[b]) - constraintHardness(rooms[a])) ||
        (rooms[b].quota - rooms[a].quota));

    for (let pass = 0; pass < RECTIFY_PASSES; pass++) {
        for (const r of order) {
            rectifyRoom(state, r, extAdj, mask, roomIdxs);
        }
        if (rectIdxs.every(r => isRectangle(state, r))) {
            return;
        }
    }
}

// Longest straight contiguous run (cm) of room r's boundary shared with hub
// cells. A parent whose children each need cwl of hub contact through its
// border needs one straight frontage — a corner-wrapped sum of the same total
// length is NOT partitionable into per-child straight door segments.
function straightHubRun(state, r, out) {
    const { cells, rooms } = state;
    const isHub = i => cells[i] >= 0 && rooms[cells[i]].isHub;
    const run = longestAxisRun(state, (i, j) =>
        (cells[i] === r && isHub(j)) || (cells[j] === r && isHub(i)), out);
    return run * state.cellW;
}

// Shortfall (cm) against the SUFFICIENT frontage condition for a parent whose
// inside-children each need their own straight door onto the hub:
//
//     run >= (1 - largestChildShare) * sideLen + cwl
//
// where sideLen is the parent side the frontage lies on — the side the
// children are sliced along. The children's stripes partition that side
// proportionally to their quotas, so the frontage must reach every stripe:
// even the largest child's stripe can sit entirely off a shorter run. The
// demand `childCount * cwl` (extKidNeed) is generally weaker and lets the
// coarse plan hand the inside solve a geometrically unsolvable parent shape,
// which no inside-solve arrangement can rescue. Positive means doomed.
function frontageShortfall(state, r) {
    const room = state.rooms[r];
    if (!room.extKidNeed || !room.extKidCwl || !(room.extKidTopShare > 0)) {
        return 0;
    }
    const axis = {};
    straightHubRun(state, r, axis);
    const ext = roomExtent(state, r);
    if (!ext.size) {
        return 0;
    }

    // the children may slice along either axis, so the parent is doomed only
    // if BOTH slicing directions fail their own frontage run
    const shortV = axisShortfall(room, axis.vRun * state.cellW, (ext.y1 - ext.y0 + 1) * state.cellW);
    const shortH = axisShortfall(room, axis.hRun * state.cellW, (ext.x1 - ext.x0 + 1) * state.cellW);
    return Math.min(shortV, shortH);
}

function axisShortfall(room, run, sideLen) {
    return Math.max(0, (1 - room.extKidTopShare) * sideLen + room.extKidCwl - run);
}

// =============================================================================
// Soft cost
// =============================================================================

function softCost(state, roomIdxs, extAdj, breakdown) {
    const { W, H, cellW, cellH, rooms } = state;
    const stats = collectStats(state);
    const diag = Math.hypot(W, H);
    let cost = 0;
    const note = breakdown
        ? (key, v) => {
            breakdown[key] = (breakdown[key] || 0) + v;
        }
        : () => {
        };

    // ratio-based, relative to each room's own quota: |size-quota|/quota is
    // bounded by 1 for starving rooms but unbounded for bloated ones, which
    // made the optimizer trim small over-quota rooms while ignoring a big
    // room sealed at 1 cell. max/min-1 scores 1/12 of quota the same as 12x.
    // area-less rooms (hallways) hold a leftover-share quota only — staying
    // small is fine (cheap circulation), but bloating pays full price
    let areaDev = 0;
    for (const r of roomIdxs) {
        const size = Math.max(stats.sizes[r], 0.5);
        const q = rooms[r].quota;
        const dev = Math.min(Math.max(size, q) / Math.min(size, q) - 1, 20);
        const areaLess = !(rooms[r].area > 0);
        areaDev += areaLess ? dev * (size < q ? 0.25 : W_HALL_BLOAT + dev)
            : size > q ? dev * (1 + dev * DEV_EXP) : dev;
    }
    cost += (areaDev / roomIdxs.length) * W_AREA;
    note("area", (areaDev / roomIdxs.length) * W_AREA);

    // wall straightness: total inter-room boundary relative to a grid-crossing wall
    let boundary = 0;
    for (let idx = 0; idx < state.cells.length; idx++) {
        const r = state.cells[idx];
        if (r < 0) {
            continue;
        }
        const x = idx % W;
        const y = (idx / W) | 0;
        if (x < W - 1 && state.cells[idx + 1] !== r && state.cells[idx + 1] >= 0) boundary += cellH;
        if (y < H - 1 && state.cells[idx + W] !== r && state.cells[idx + W] >= 0) boundary += cellW;
    }
    cost += (boundary / ((W * cellW) + (H * cellH))) * W_PERIM * 0.1;
    note("perim", (boundary / ((W * cellW) + (H * cellH))) * W_PERIM * 0.1);

    for (const r of roomIdxs) {
        const room = rooms[r];
        const b = stats.bbox[r];
        if (stats.sizes[r] === 0) {
            cost += 100;
            note("empty", 100);
            continue;
        }

        // parents of hub-connected children need ONE STRAIGHT hub frontage:
        // a corner-wrapped contact of the same summed length satisfies the
        // parent's cwl rule but cannot be partitioned into per-child straight
        // door segments. Whole cwl slots only: a run just short of k*cwl
        // fits k-1 doors. In softCost so refinement defends the run too.
        if (room.extKidNeed && room.extKidCwl) {
            const reachShort = frontageShortfall(state, r);
            if (reachShort > 0) {
                cost += reachShort * W_FRONTAGE_REACH;
                note("frontage_reach:" + room.id, reachShort * W_FRONTAGE_REACH);
            }
            const slots = Math.floor(straightHubRun(state, r) / room.extKidCwl) * room.extKidCwl;
            const short = Math.max(0, room.extKidNeed - slots);
            if (short > 0) {
                cost += short * W_FRONTAGE;
                note("frontage:" + room.id, short * W_FRONTAGE);
            }
        }
        const bw = (b.x1 - b.x0 + 1) * cellW;
        const bh = (b.y1 - b.y0 + 1) * cellH;
        if (room.ratioMax > 0) {
            const ratio = Math.max(bw / bh, bh / bw);
            if (ratio > room.ratioMax) {
                // rooms far under quota are scaffolding, not final shapes:
                // full-strength aspect penalty would veto every growth step
                // (squared: a starved room must be able to grow through a
                // 1-wide column without the aspect term outvoting area gain)
                const rampUp = Math.min(1, (stats.sizes[r] / room.quota) ** 2);
                cost += (ratio - room.ratioMax) * W_RATIO * rampUp;
                note("ratio:" + room.id, (ratio - room.ratioMax) * W_RATIO * rampUp);
            }
        }
        const fill = stats.sizes[r] / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
        if (fill < FILL_MIN) {
            cost += (FILL_MIN - fill) * W_FILL;
            note("fill:" + room.id, (FILL_MIN - fill) * W_FILL);
        }
        if (room.rect && fill < 1) {
            cost += (1 - fill) * W_RECT;
            note("rect:" + room.id, (1 - fill) * W_RECT);
        }
        if (room.sideMin > Math.min(cellW, cellH)) {
            cost += stats.thin[r] * W_THIN;
            note("thin:" + room.id, stats.thin[r] * W_THIN);
        }

        for (const c of room.rules) {
            const w = Math.min(c.weight, G_WEIGHT_CAP);
            const cen = stats.centroids[r];
            if (c.kind === "at" && !c.required) {
                for (const d of c.dirs) {
                    if (!(d === "edge" ? DIRS.some(k => stats.walls[r][k]) : stats.walls[r][d])) {
                        cost += w * W_AT;
                        note("at:" + room.id, w * W_AT);
                    }
                }
            } else if (c.kind === "not_at" && !c.required) {
                const bad = c.dirs[0] === "edge" ? DIRS.some(k => stats.walls[r][k]) : c.dirs.some(d => stats.walls[r][d]);
                if (bad) {
                    cost += w * W_AT;
                    note("at:" + room.id, w * W_AT);
                }
            } else if (c.kind === "enclosed" && !c.required) {
                if (DIRS.some(k => stats.walls[r][k])) {
                    cost += w * W_AT;
                    note("at:" + room.id, w * W_AT);
                }
            } else if (c.kind === "close" || c.kind === "far") {
                const ds = c.targets.map(t => {
                    const o = stats.centroids[t];
                    return Math.hypot(cen.x - o.x, cen.y - o.y) / diag;
                });
                if (!ds.length) {
                    continue;
                }
                if (c.kind === "close") {
                    const d = c.any ? Math.min(...ds) : ds.reduce((s, v) => s + v, 0) / ds.length;
                    cost += d * w * W_CLOSE;
                    note("close:" + room.id, d * w * W_CLOSE);
                } else {
                    const d = c.any ? Math.max(...ds) : ds.reduce((s, v) => s + v, 0) / ds.length;
                    cost += (1 - d) * w * W_CLOSE;
                    note("far:" + room.id, (1 - d) * w * W_CLOSE);
                }
            } else if (c.kind === "connect") {
                for (const t of c.targets) {
                    const len = stats.sharedLen(r, t);
                    if (len === 0 && !c.required) {
                        const o = stats.centroids[t];
                        cost += (Math.hypot(cen.x - o.x, cen.y - o.y) / diag) * w * W_CLOSE;
                        note("connect:" + room.id, (Math.hypot(cen.x - o.x, cen.y - o.y) / diag) * w * W_CLOSE);
                    } else if (c.cwl > 0 && len > 0 && len < c.cwl) {
                        cost += ((c.cwl - len) / c.cwl) * w * W_CWL;
                        note("cwl:" + room.id, ((c.cwl - len) / c.cwl) * w * W_CWL);
                    }
                    if (c.any && len > 0) {
                        break;
                    }
                }
            }
        }
    }

    return cost;
}

// =============================================================================
// Refinement
// =============================================================================

function subdivide(state) {
    const { W, H, cells } = state;
    const W2 = W * 2;
    const H2 = H * 2;
    const next = new Int16Array(W2 * H2);
    for (let y = 0; y < H2; y++) {
        for (let x = 0; x < W2; x++) {
            next[y * W2 + x] = cells[(y >> 1) * W + (x >> 1)];
        }
    }
    state.W = W2;
    state.H = H2;
    state.cells = next;
    state.cellW /= 2;
    state.cellH /= 2;
    for (const r of state.rooms) {
        r.quota *= 4;
    }
}

// Wall slide for a rectangular room: grow claims the strip adjacent to one
// bbox side, shrink gives one bbox edge strip away. All-or-nothing with
// rollback; accepted only when softCost improves and every rect-flagged room
// that was rectangular before stays rectangular.
function trySlide(state, r, dir, grow, roomIdxs, extAdj, allowFlip, costBefore, initialStats, initialSatisfaction, rules) {
    const { W, H, cells, rooms } = state;
    const e = roomExtent(state, r);
    const strip = [];
    if (dir === "north" || dir === "south") {
        const y = grow
            ? (dir === "north" ? e.y0 - 1 : e.y1 + 1)
            : (dir === "north" ? e.y0 : e.y1);
        if (y < 0 || y >= H || (!grow && e.y0 === e.y1)) {
            return null;
        }
        for (let x = e.x0; x <= e.x1; x++) strip.push(y * W + x);
    } else {
        const x = grow
            ? (dir === "west" ? e.x0 - 1 : e.x1 + 1)
            : (dir === "west" ? e.x0 : e.x1);
        if (x < 0 || x >= W || (!grow && e.x0 === e.x1)) {
            return null;
        }
        for (let y = e.y0; y <= e.y1; y++) strip.push(x + y * W);
    }

    // rect-ness is recorded per room BEFORE its first cell moves
    const wasRect = new Map();
    const noteRoom = (o) => {
        if (o >= 0 && o !== r && !wasRect.has(o)) {
            const rectangle = transferContext?.stats
                ? isRectangleInStats(transferContext.stats, o)
                : isRectangle(state, o);
            wasRect.set(o, rooms[o].rect && rectangle);
        }
    };
    const undo = [];
    const connectedDonors = new Set();
    if (costBefore === Infinity && initialStats) {
        const donors = grow ? new Set(strip.map(idx => cells[idx]).filter(owner => owner >= 0 && owner !== r)) : new Set([r]);
        for (const donor of donors) {
            const extent = initialStats.bbox[donor];
            const verticalStrip = dir === "west" || dir === "east";
            const onEdge = verticalStrip
                ? strip.some(idx => cells[idx] === donor && (idx % W === extent.x0 || idx % W === extent.x1))
                : strip.some(idx => cells[idx] === donor && (((idx / W) | 0) === extent.y0 || ((idx / W) | 0) === extent.y1));
            const hasParallelThickness = verticalStrip ? extent.x1 > extent.x0 : extent.y1 > extent.y0;
            if (isRectangleInStats(initialStats, donor) && onEdge && hasParallelThickness) {
                connectedDonors.add(donor);
            }
        }
    }
    const transferContext = costBefore === Infinity
        ? {
            rules: rules || requiredRules(rooms),
            stats: initialStats,
            connectedDonors,
            satisfaction: new Map(),
            initialSatisfaction,
            affectedRules: new Map(),
        }
        : undefined;
    const rollback = () => {
        for (const [idx, owner] of undo) {
            cells[idx] = owner;
        }
    };
    const nb = [0, 0, 0, 0];

    for (const idx of strip) {
        const owner = cells[idx];
        if (grow) {
            if (owner === r) {
                continue;
            }
            if (owner >= 0 && ((!transferContext && !roomIdxs.includes(owner)) || !allowFlip(owner, r))) {
                rollback();
                return null;
            }
            noteRoom(owner);
            if (!claimCell(state, idx, r, extAdj, undefined, transferContext)) {
                rollback();
                return null;
            }
            undo.push([idx, owner]);
        } else {
            // outward receiver first: the room just past the shed edge gains a
            // segment aligned with its own span and stays rectangular; lateral
            // receivers (often an already-transferred strip cell's new owner)
            // would snake along the strip instead
            const off = dir === "north" ? -W : dir === "south" ? W : dir === "west" ? -1 : 1;
            const outIdx = idx + off;
            const outOk = dir === "north" ? idx >= W : dir === "south" ? idx < W * (H - 1)
                : dir === "west" ? idx % W > 0 : idx % W < W - 1;
            const outward = outOk ? cells[outIdx] : -1;
            const nn = neighborsOf(idx, W, H, nb);
            const receivers = [];
            for (let i = 0; i < nn; i++) {
                const o = cells[nb[i]];
                if (o >= 0 && o !== r && (transferContext || roomIdxs.includes(o))
                    && allowFlip(r, o) && !receivers.includes(o)) {
                    receivers.push(o);
                }
            }
            receivers.sort((a, b) =>
                ((b === outward ? 1 : 0) - (a === outward ? 1 : 0)) ||
                ((rooms[a].rect ? 1 : 0) - (rooms[b].rect ? 1 : 0)));
            let done = false;
            for (const o of receivers) {
                noteRoom(o);
                if (tryTransfer(state, idx, o, extAdj, undefined, transferContext)) {
                    undo.push([idx, r]);
                    done = true;
                    break;
                }
            }
            if (!done) {
                rollback();
                return null;
            }
        }
    }
    if (!undo.length) {
        return null;
    }

    const rectangle = roomIdx => transferContext?.stats
        ? isRectangleInStats(transferContext.stats, roomIdx)
        : isRectangle(state, roomIdx);
    let broken = rooms[r].rect && !rectangle(r);
    for (const [o, was] of wasRect) {
        if (was && !rectangle(o)) {
            broken = true;
        }
    }
    if (broken) {
        rollback();
        return null;
    }

    if (costBefore === Infinity) {
        return 0;
    }
    const cost = softCost(state, roomIdxs, extAdj);
    if (cost < costBefore - 1e-9) {
        return cost;
    }
    rollback();
    return null;
}

// Greedy boundary flips + wall slides. allowFlip filters which room pairs may
// exchange cells (outer pass: parentless rooms only; sibling pass: same
// parent). Single-cell flips never break an intact rectangle; rect rooms move
// via all-or-nothing strip slides instead.
function optimizeBoundary(state, roomIdxs, extAdj, allowFlip) {
    const { W, H, rooms } = state;
    const nb = [0, 0, 0, 0];
    const idxSet = new Set(roomIdxs);
    let cost = softCost(state, roomIdxs, extAdj);

    for (let pass = 0; pass < MAX_OPT_PASSES; pass++) {
        let changes = 0;

        for (let idx = 0; idx < state.cells.length; idx++) {
            const donor = state.cells[idx];
            if (donor < 0 || !idxSet.has(donor)) {
                continue;
            }
            const nn = neighborsOf(idx, W, H, nb);
            const tried = new Set();

            for (let i = 0; i < nn; i++) {
                const r = state.cells[nb[i]];
                if (r < 0 || r === donor || tried.has(r) || !idxSet.has(r)) {
                    continue;
                }
                tried.add(r);
                if (!allowFlip(donor, r)) {
                    continue;
                }
                const donorWasRect = rooms[donor].rect && isRectangle(state, donor);
                const rWasRect = rooms[r].rect && isRectangle(state, r);
                if (!tryTransfer(state, idx, r, extAdj)) {
                    continue;
                }
                if ((donorWasRect && !isRectangle(state, donor)) || (rWasRect && !isRectangle(state, r))) {
                    state.cells[idx] = donor;
                    continue;
                }
                const next = softCost(state, roomIdxs, extAdj);
                if (next < cost - 1e-9) {
                    cost = next;
                    changes++;
                    break;
                }
                state.cells[idx] = donor;
            }
        }

        for (const r of roomIdxs) {
            if (!rooms[r].rect || !isRectangle(state, r)) {
                continue;
            }
            for (const dir of DIRS) {
                for (const grow of [true, false]) {
                    // repeat while improving: a starved room may need many strips
                    for (let step = 0; step < 64; step++) {
                        const next = trySlide(state, r, dir, grow, roomIdxs, extAdj, allowFlip, cost);
                        if (next === null) {
                            break;
                        }
                        cost = next;
                        changes++;
                    }
                }
            }
        }

        if (!changes) {
            break;
        }
    }
    return cost;
}

// =============================================================================
// Winning-layout shape polish
// =============================================================================

function externalAdjacencyForParent(state, parentIdx) {
    const parentScope = state.rooms[parentIdx].parent;
    const externalNames = new Set();
    for (const room of state.rooms) {
        if (room.parent !== parentIdx) {
            continue;
        }
        for (const rule of room.rules) {
            for (const name of rule.externalTargets || []) {
                externalNames.add(name);
            }
        }
    }

    const extAdj = {};
    for (const name of externalNames) {
        const outer = state.rooms.find(room => room.id === name && room.parent === parentScope);
        if (!outer) {
            continue;
        }
        extAdj[name] = new Set();
        for (let idx = 0; idx < state.cells.length; idx++) {
            if (state.cells[idx] === outer.index) {
                extAdj[name].add(idx);
            }
        }
    }
    return extAdj;
}

function deliveredRequiredViolationCount(state, activeIdxs, stats = collectStats(state)) {
    const active = new Set(activeIdxs);
    let violations = 0;
    for (const rule of requiredRules(state.rooms)) {
        const subject = state.rooms[rule.subject];
        if (!active.has(rule.subject) && !subject.childIdxs) {
            continue;
        }
        if (subject.childIdxs) {
            const extAdj = externalAdjacencyForParent(state, rule.subject);
            if (!connectSatisfiedFromRegion(state, rule, unionCells(state, subject.childIdxs), extAdj)) {
                violations++;
            }
            continue;
        }
        const extAdj = subject.parent >= 0 ? externalAdjacencyForParent(state, subject.parent) : undefined;
        if (!ruleSatisfied(rule, state, stats, extAdj)) {
            violations++;
        }
    }
    return violations + activeIdxs.filter(roomIdx =>
        state.rooms[roomIdx].shapeRequired && !isRectangleInStats(stats, roomIdx)).length;
}

function finalPolishGeometry(state) {
    const sizes = new Array(state.rooms.length).fill(0);
    const bbox = state.rooms.map(() => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
    for (let idx = 0; idx < state.cells.length; idx++) {
        const roomIdx = state.cells[idx];
        if (roomIdx < 0) {
            continue;
        }
        const x = idx % state.W;
        const y = (idx / state.W) | 0;
        sizes[roomIdx]++;
        const extent = bbox[roomIdx];
        if (x < extent.x0) extent.x0 = x;
        if (x > extent.x1) extent.x1 = x;
        if (y < extent.y0) extent.y0 = y;
        if (y > extent.y1) extent.y1 = y;
    }
    return { sizes, bbox };
}

function finalPolishQuality(state, activeIdxs, measureRequired = true) {
    const stats = measureRequired ? collectStats(state) : finalPolishGeometry(state);
    let nonRect = 0;
    let sideViolations = 0;
    let sideTotal = 0;
    let aspectViolations = 0;
    let hallwayBloat = 0;
    let hallwayBloatWorst = 0;
    let hallwayCount = 0;
    let quotaDeviation = 0;
    let quotaCount = 0;

    for (const roomIdx of activeIdxs) {
        const room = state.rooms[roomIdx];
        const extent = stats.bbox[roomIdx];
        const size = stats.sizes[roomIdx];
        const bboxArea = size ? (extent.x1 - extent.x0 + 1) * (extent.y1 - extent.y0 + 1) : 0;
        if (room.rect && !(size > 0 && size === bboxArea)) {
            nonRect++;
        }
        const width = (extent.x1 - extent.x0 + 1) * state.cellW;
        const height = (extent.y1 - extent.y0 + 1) * state.cellH;
        if (room.sideMin > 0) {
            sideTotal++;
            if (Math.min(width, height) < room.sideMin - 1e-6) {
                sideViolations++;
            }
        }
        if (room.ratioMax > 0 && Math.max(width, height) / Math.min(width, height) > room.ratioMax + 1e-6) {
            aspectViolations++;
        }
        if (!room.area) {
            const bloat = size / room.quota;
            hallwayBloat += bloat;
            hallwayBloatWorst = Math.max(hallwayBloatWorst, bloat);
            hallwayCount++;
            continue;
        }
        quotaDeviation += Math.abs(size / room.quota - 1);
        quotaCount++;
    }

    return {
        requiredViolations: measureRequired ? deliveredRequiredViolationCount(state, activeIdxs, stats) : undefined,
        nonRect,
        sideViolations,
        sideTotal,
        aspectViolations,
        hallwayBloat: hallwayCount ? hallwayBloat / hallwayCount : 0,
        hallwayBloatWorst,
        hallwayCount,
        quotaDeviation: quotaCount ? quotaDeviation / quotaCount : 0,
    };
}

function compareFinalPolishQuality(a, b) {
    return (a.requiredViolations - b.requiredViolations)
        || (a.nonRect - b.nonRect)
        || (a.sideViolations - b.sideViolations)
        || (a.aspectViolations - b.aspectViolations)
        || (a.hallwayBloat - b.hallwayBloat)
        || (a.hallwayBloatWorst - b.hallwayBloatWorst)
        || (a.quotaDeviation - b.quotaDeviation);
}

function compareFinalPolishInterests(a, b) {
    return (a.nonRect - b.nonRect)
        || (a.sideViolations - b.sideViolations)
        || (a.aspectViolations - b.aspectViolations)
        || (a.hallwayBloat - b.hallwayBloat)
        || (a.hallwayBloatWorst - b.hallwayBloatWorst)
        || (a.quotaDeviation - b.quotaDeviation);
}

function finalPolishGroups(state, activeIdxs) {
    const byParent = new Map();
    for (const roomIdx of activeIdxs) {
        const parent = state.rooms[roomIdx].parent;
        if (!byParent.has(parent)) {
            byParent.set(parent, []);
        }
        byParent.get(parent).push(roomIdx);
    }
    return [...byParent.values()];
}

function finalPolishSlideCandidates(state, activeIdxs, groups, rules, saved, onlyParent) {
    const candidates = [];
    const savedStats = collectStats(state);
    const initialSatisfaction = new Map();
    for (const roomIdxs of groups) {
        const parent = state.rooms[roomIdxs[0]].parent;
        if (onlyParent !== undefined && parent !== onlyParent) {
            continue;
        }
        const allowed = new Set(roomIdxs);
        const allowFlip = (a, b) => allowed.has(a) && allowed.has(b);
        const extAdj = parent >= 0 ? externalAdjacencyForParent(state, parent) : undefined;
        for (const roomIdx of roomIdxs) {
            if (!state.rooms[roomIdx].rect || !isRectangleInStats(savedStats, roomIdx)) {
                continue;
            }
            for (const dir of DIRS) {
                for (const grow of [true, false]) {
                    state.cells.set(saved);
                    if (trySlide(state, roomIdx, dir, grow, roomIdxs, extAdj, allowFlip,
                        Infinity, savedStats, initialSatisfaction, rules) === null) {
                        continue;
                    }
                    candidates.push({
                        parent,
                        quality: finalPolishQuality(state, activeIdxs, false),
                        cells: state.cells.slice(),
                    });
                }
            }
        }
    }
    state.cells.set(saved);
    return candidates;
}

function bestFinalPolishCandidate(state, activeIdxs, candidates, current) {
    let best = null;
    for (const candidate of candidates) {
        if (current.requiredViolations === 0
            && compareFinalPolishInterests(candidate.quality, current) >= 0) {
            continue;
        }
        state.cells.set(candidate.cells);
        candidate.quality.requiredViolations = deliveredRequiredViolationCount(state, activeIdxs);
        if (compareFinalPolishQuality(candidate.quality, current) >= 0) {
            continue;
        }
        if (!best || compareFinalPolishQuality(candidate.quality, best.quality) < 0) {
            best = candidate;
        }
    }
    return best;
}

function bestCompoundFinalPolishCandidate(state, activeIdxs, groups, rules, current, saved, firstCandidates) {
    let best = null;
    // First step may be neutral, but may not worsen either shape count. The
    // second step must improve a shape count, so compound search cannot spend
    // its bounded pass on a bloat-only or quota-only rearrangement.
    const firstMoves = (firstCandidates
        || finalPolishSlideCandidates(state, activeIdxs, groups, rules, saved))
        .filter(candidate => candidate.quality.sideViolations <= current.sideViolations
            && candidate.quality.aspectViolations <= current.aspectViolations);
    for (const first of firstMoves) {
        state.cells.set(first.cells);
        // Separate parent/sibling groups cannot unlock each other's slides.
        const secondMoves = finalPolishSlideCandidates(state, activeIdxs, groups, rules,
            first.cells, first.parent)
            .filter(candidate => candidate.quality.sideViolations < current.sideViolations
                || candidate.quality.aspectViolations < current.aspectViolations);
        const candidate = bestFinalPolishCandidate(state, activeIdxs, secondMoves, current);
        if (candidate && (!best || compareFinalPolishQuality(candidate.quality, best.quality) < 0)) {
            best = candidate;
        }
    }
    state.cells.set(saved);
    return best;
}

function polishWinningLayout(state, activeIdxs) {
    let current = finalPolishQuality(state, activeIdxs);
    if (current.hallwayCount !== 1 || !current.sideTotal) {
        return 0;
    }

    const compoundEligible = current.sideViolations / current.sideTotal
        >= FINAL_POLISH_MIN_SIDE_VIOLATION_RATE;
    const groups = finalPolishGroups(state, activeIdxs);
    const rules = requiredRules(state.rooms);
    let moves = 0;
    let compoundUsed = false;
    while (moves < MAX_FINAL_POLISH_MOVES) {
        const saved = state.cells.slice();
        const candidates = finalPolishSlideCandidates(state, activeIdxs, groups, rules, saved);
        let best = bestFinalPolishCandidate(state, activeIdxs, candidates, current);
        state.cells.set(saved);
        if (!best) {
            if (!compoundEligible || compoundUsed || moves + 2 > MAX_FINAL_POLISH_MOVES) {
                break;
            }
            compoundUsed = true;
            best = bestCompoundFinalPolishCandidate(state, activeIdxs, groups, rules, current, saved, candidates);
            if (!best) {
                break;
            }
            moves += 2;
        } else {
            moves++;
        }
        state.cells.set(best.cells);
        current = best.quality;
    }
    return moves;
}

// =============================================================================
// Inside blocks
// =============================================================================

function cwlCells(state, cwl) {
    return Math.max(1, Math.ceil((cwl - 1e-6) / state.cellW));
}

function frontageAxisRuns(state, mask, extUnion) {
    const out = {};
    longestAxisRun(state, (i, j) =>
        (mask.has(i) && extUnion.has(j)) || (mask.has(j) && extUnion.has(i)), out);
    return out;
}

function bandLineCounts(lineCells, quotas, minLinesPer, doorLo, doorHi) {
    const roomCount = quotas.length;
    const lineCount = lineCells.length;
    const cumulativeMin = new Array(roomCount + 1).fill(0);
    const cumulativeDoorMin = new Array(roomCount + 1).fill(0);
    for (let room = 0; room < roomCount; room++) {
        cumulativeMin[room + 1] = cumulativeMin[room] + Math.max(1, minLinesPer[room]);
        cumulativeDoorMin[room + 1] = cumulativeDoorMin[room] + minLinesPer[room];
    }
    if (cumulativeMin[roomCount] > lineCount) {
        return null;
    }

    const totalCells = lineCells.reduce((sum, count) => sum + count, 0);
    const quotaSum = quotas.reduce((sum, quota) => sum + quota, 0) || 1;
    const prefixCells = new Array(lineCount + 1).fill(0);
    for (let line = 0; line < lineCount; line++) {
        prefixCells[line + 1] = prefixCells[line] + lineCells[line];
    }

    const idealCut = room => {
        let target = 0;
        for (let prior = 0; prior < room; prior++) {
            target += quotas[prior] / quotaSum * totalCells;
        }
        let bestLine = 0;
        let bestError = Infinity;
        for (let line = 0; line <= lineCount; line++) {
            const error = Math.abs(prefixCells[line] - target);
            if (error < bestError) {
                bestError = error;
                bestLine = line;
            }
        }
        return bestLine;
    };

    const cuts = new Array(roomCount + 1);
    cuts[0] = 0;
    cuts[roomCount] = lineCount;
    for (let room = 1; room < roomCount; room++) {
        let low = Math.max(cuts[room - 1] + Math.max(1, minLinesPer[room - 1]), cumulativeMin[room]);
        if (cumulativeDoorMin[room] > 0) {
            low = Math.max(low, doorLo + cumulativeDoorMin[room]);
        }
        let high = lineCount - (cumulativeMin[roomCount] - cumulativeMin[room]);
        const remainingDoorMin = cumulativeDoorMin[roomCount] - cumulativeDoorMin[room];
        if (remainingDoorMin > 0) {
            high = Math.min(high, doorHi + 1 - remainingDoorMin);
        }
        if (low > high) {
            return null;
        }
        cuts[room] = Math.min(Math.max(idealCut(room), low), high);
    }

    const counts = [];
    for (let room = 0; room < roomCount; room++) {
        counts.push(cuts[room + 1] - cuts[room]);
    }
    return counts.every(count => count >= 1) ? counts : null;
}

function permutations(values) {
    if (values.length <= 1) {
        return [values.slice()];
    }
    const result = [];
    for (let i = 0; i < values.length; i++) {
        const remaining = values.slice(0, i).concat(values.slice(i + 1));
        for (const suffix of permutations(remaining)) {
            result.push([values[i], ...suffix]);
        }
    }
    return result;
}

function regionConnected(state, roomIdx) {
    const { W, H, cells } = state;
    let start = -1;
    let total = 0;
    for (let idx = 0; idx < cells.length; idx++) {
        if (cells[idx] !== roomIdx) {
            continue;
        }
        total++;
        start = start < 0 ? idx : start;
    }
    if (start < 0) {
        return false;
    }

    const seen = new Set([start]);
    const stack = [start];
    const neighbors = [0, 0, 0, 0];
    while (stack.length) {
        const current = stack.pop();
        const count = neighborsOf(current, W, H, neighbors);
        for (let i = 0; i < count; i++) {
            const next = neighbors[i];
            if (cells[next] !== roomIdx || seen.has(next)) {
                continue;
            }
            seen.add(next);
            stack.push(next);
        }
    }
    return seen.size === total;
}

function stripeCandidateOrders(childIdxs, rooms) {
    if (childIdxs.length <= 4) {
        return permutations(childIdxs).slice(0, MAX_STRIPE_CANDIDATES);
    }
    const descending = childIdxs.slice().sort((a, b) => rooms[b].quota - rooms[a].quota || a - b);
    return [descending, descending.slice().reverse()];
}

function siblingBalance(state, childIdxs) {
    const sizes = collectStats(state).sizes;
    const childSizes = childIdxs.map(roomIdx => Math.max(sizes[roomIdx], 0.5));
    return Math.max(...childSizes) / Math.min(...childSizes) - 1;
}

function scoreInsideCandidate(state, childIdxs, extAdj) {
    const ruleUnsat = unsatisfiedRequired(state, extAdj).filter(rule => childIdxs.includes(rule.subject)).length;
    const shapeUnsat = requiredShapeViolations(state, childIdxs).length;
    const ragged = childIdxs.filter(roomIdx => state.rooms[roomIdx].rect && !isRectangle(state, roomIdx)).length;
    return {
        shapeUnsat,
        unsat: ruleUnsat + shapeUnsat,
        ragged,
        cost: softCost(state, childIdxs, extAdj),
        balance: siblingBalance(state, childIdxs),
        cells: state.cells.slice(),
    };
}

function stripeCandidates(state, childIdxs, mask, extAdj) {
    const { W, cells, rooms } = state;
    if (childIdxs.length < 2 || mask.size === 0) {
        return null;
    }

    const externalUnion = new Set();
    const needsDoor = new Set();
    let cwl = 0;
    for (const roomIdx of childIdxs) {
        for (const rule of rooms[roomIdx].rules) {
            if (rule.kind !== "connect" || !rule.required || !rule.externalTargets?.length) {
                continue;
            }
            needsDoor.add(roomIdx);
            cwl = Math.max(cwl, rule.cwl || 0);
            for (const name of rule.externalTargets) {
                for (const idx of extAdj[name] || []) {
                    externalUnion.add(idx);
                }
            }
        }
    }

    const doorMin = cwlCells(state, cwl);
    const runs = externalUnion.size ? frontageAxisRuns(state, mask, externalUnion) : null;
    const extent = [...mask].reduce((box, idx) => {
        const x = idx % W;
        const y = (idx / W) | 0;
        box.x0 = Math.min(box.x0, x);
        box.x1 = Math.max(box.x1, x);
        box.y0 = Math.min(box.y0, y);
        box.y1 = Math.max(box.y1, y);
        return box;
    }, { x0: Infinity, x1: -1, y0: Infinity, y1: -1 });
    const rowCells = new Array(extent.y1 - extent.y0 + 1).fill(0);
    const columnCells = new Array(extent.x1 - extent.x0 + 1).fill(0);
    for (const idx of mask) {
        rowCells[((idx / W) | 0) - extent.y0]++;
        columnCells[(idx % W) - extent.x0]++;
    }

    const requiredDoorLines = needsDoor.size * doorMin;
    const axes = [];
    if (!runs || runs.vRun >= requiredDoorLines) {
        axes.push("y");
    }
    if (!runs || runs.hRun >= requiredDoorLines) {
        axes.push("x");
    }

    const saved = cells.slice();
    let best = null;
    let generated = 0;
    for (const axis of axes) {
        const lineCells = axis === "y" ? rowCells : columnCells;
        const base = axis === "y" ? extent.y0 : extent.x0;
        const doorLo = runs ? (axis === "y" ? runs.vLo : runs.hLo) - base : 0;
        const doorHi = runs ? (axis === "y" ? runs.vHi : runs.hHi) - base : lineCells.length - 1;
        for (const order of stripeCandidateOrders(childIdxs, rooms)) {
            if (generated++ >= MAX_STRIPE_CANDIDATES) {
                break;
            }
            const minLines = order.map(roomIdx => needsDoor.has(roomIdx) ? doorMin : 0);
            const counts = bandLineCounts(lineCells, order.map(roomIdx => rooms[roomIdx].quota), minLines, doorLo, doorHi);
            if (!counts) {
                continue;
            }

            cells.set(saved);
            for (const idx of mask) {
                cells[idx] = -1;
            }
            let line = 0;
            for (let room = 0; room < order.length; room++) {
                const lineEnd = line + counts[room];
                for (const idx of mask) {
                    const position = axis === "y" ? ((idx / W) | 0) - extent.y0 : (idx % W) - extent.x0;
                    if (position >= line && position < lineEnd) {
                        cells[idx] = order[room];
                    }
                }
                line = lineEnd;
            }
            const connected = order.every(roomIdx => regionConnected(state, roomIdx));
            const legal = connected && [...mask].every(idx => cellLegalForRoom(state, idx, rooms[cells[idx]]));
            if (!legal) {
                continue;
            }

            repairInside(state, childIdxs, mask, extAdj);
            rectify(state, childIdxs, extAdj, mask);
            const candidate = scoreInsideCandidate(state, childIdxs, extAdj);
            if (!best || compareCandidates(candidate, best) < 0) {
                best = candidate;
            }
        }
    }
    cells.set(saved);
    return best;
}

function solveInside(state, parentIdx, warnings, seed, warn) {
    const parent = state.rooms[parentIdx];
    const inner = parent.inside;

    const childRooms = compileRooms(inner.modules, inner.config, warnings, {
        inside: true,
        scope: roomPath(state.rooms, parentIdx),
        warn,
    });

    // children are never hubs: rect by default, 'shapes free' (inherited or
    // local) restores polyomino mode
    for (const c of childRooms) {
        c.rect = (c.shape ?? (inner.config.shapes === "free" ? "free" : "rect")) === "rect";
        c.shapeRequired = c.shape !== "free" && (c.shapeRequired || !!inner.config.shapeRequired);
    }
    // register children as rooms on the shared state
    const base = state.rooms.length;
    for (const c of childRooms) {
        c.index = base + c.index;
        c.parent = parentIdx;
        for (const rule of c.rules) {
            rule.subject += base;
            if (rule.targets) {
                rule.targets = rule.targets.map(t => t + base);
            }
        }
        state.rooms.push(c);
    }

    const mask = new Set();
    for (let i = 0; i < state.cells.length; i++) {
        if (state.cells[i] === parentIdx) {
            mask.add(i);
        }
    }

    // external adjacency for cross-boundary connects: outer room id → cell set
    const extAdj = {};
    for (const c of childRooms) {
        for (const rule of c.rules) {
            for (const name of rule.externalTargets || []) {
                if (!extAdj[name]) {
                    const outer = state.rooms.find(r => r.id === name && r.parent === parent.parent);
                    if (!outer) {
                        continue;
                    }
                    extAdj[name] = new Set();
                    for (let i = 0; i < state.cells.length; i++) {
                        if (state.cells[i] === outer.index) {
                            extAdj[name].add(i);
                        }
                    }
                }
            }
        }
    }

    const parentArea = [...mask].length;
    const areaSum = childRooms.reduce((s, c) => s + (c.area || 0), 0) || 1;
    for (const c of childRooms) {
        c.quota = Math.max(1, Math.round(((c.area || areaSum / childRooms.length) / areaSum) * parentArea));
    }

    const childIdxs = childRooms.map(c => c.index);
    let best = null;
    let satisfiedAttempts = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const rng = mulberry32((seed * 7349 + parentIdx * 131 + attempt) >>> 0);
        for (const i of mask) {
            state.cells[i] = -1;
        }

        const seeds = placeInsideSeeds(state, childIdxs, mask, extAdj, rng);
        if (!seeds) {
            continue;
        }
        for (const [ri, idx] of Object.entries(seeds)) {
            state.cells[idx] = +ri;
        }
        if (!tetherRooms(state, childIdxs, mask, extAdj)) {
            continue;
        }
        if (!growRegions(state, childIdxs, seeds, mask, rng, extAdj)) {
            continue;
        }
        repairInside(state, childIdxs, mask, extAdj);
        rectify(state, childIdxs, extAdj, mask);

        const candidate = scoreInsideCandidate(state, childIdxs, extAdj);
        if (!best || compareCandidates(candidate, best) < 0) {
            best = candidate;
        }
        // first satisfied attempt is often the worst-balanced one (slivers):
        // keep looking a bounded window for a better-ragged/cheaper layout
        if (best.unsat === 0 && ++satisfiedAttempts > SATISFIED_LOOKAHEAD) {
            break;
        }
    }

    const stripe = stripeCandidates(state, childIdxs, mask, extAdj);
    const siblingFlip = (a, b) => state.rooms[a].parent === parentIdx && state.rooms[b].parent === parentIdx;
    const finalists = best ? [best] : [];
    if (stripe) {
        finalists.push(stripe);
    }
    let winner = null;
    for (const finalist of finalists) {
        state.cells.set(finalist.cells);
        optimizeBoundary(state, childIdxs, extAdj, siblingFlip);
        const scored = scoreInsideCandidate(state, childIdxs, extAdj);
        const improvesScore = !winner || compareCandidates(scored, winner) < 0;
        const preservesBalance = !winner || scored.balance <= winner.balance + 1e-9;
        if (improvesScore && preservesBalance) {
            winner = scored;
        }
    }
    if (winner) {
        state.cells = winner.cells;
    }
    return childIdxs;
}

// Seeds for children: cross-boundary required connect pins the seed onto a
// cell adjacent to the external target's region.
function placeInsideSeeds(state, childIdxs, mask, extAdj, rng) {
    const seeds = {};
    const taken = new Set();

    const order = childIdxs.slice().sort((a, b) =>
        constraintHardness(state.rooms[b]) - constraintHardness(state.rooms[a]));

    for (const r of order) {
        const room = state.rooms[r];
        const extReq = room.rules.filter(c => c.required && c.kind === "connect" && c.externalTargets?.length);

        // within a few cells of the external target: growth pulls the gap shut
        let cands = [...mask].filter(i => !taken.has(i));
        if (extReq.length) {
            const reach = 3;
            cands = cands.filter(idx => extReq.every(c => c.externalTargets.some(name => {
                const set = extAdj[name];
                if (!set) {
                    return false;
                }
                for (const cellIdx of set) {
                    if (manhattan(idx, cellIdx, state.W) <= reach) {
                        return true;
                    }
                }
                return false;
            })));
        }
        if (!cands.length) {
            return null;
        }

        // spread children apart (precomputed key: comparator must be consistent)
        const keyed = cands.map(idx => ({
            idx,
            k: Math.min(...Object.values(seeds).map(s => manhattan(idx, s, state.W)), 99) + rng() * 0.5,
        })).sort((a, b) => b.k - a.k);
        seeds[r] = keyed[0].idx;
        taken.add(keyed[0].idx);
    }
    return seeds;
}

function repairInside(state, childIdxs, mask, extAdj) {
    // reuse the generic repair: it only transfers cells between rooms that
    // already touch, so it stays within the parent region by construction
    repair(state, extAdj, mask);
}

// =============================================================================
// ASCII rendering
// =============================================================================

const LETTER_POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function assignLetters(rooms, activeIdxs) {
    const used = new Set();
    const letters = {};
    for (const r of activeIdxs) {
        const id = rooms[r].id;
        let ch = null;
        const prefs = [...id.replace(/[^a-z0-9]/gi, "")].map((c, i) => i === 0 ? c.toUpperCase() : c);
        for (const p of [...prefs, ...LETTER_POOL]) {
            if (!used.has(p)) {
                ch = p;
                break;
            }
        }
        used.add(ch);
        letters[r] = ch;
    }
    return letters;
}

function describeRule(c, rooms) {
    const name = i => rooms[i]?.id ?? "?";
    switch (c.kind) {
        case "at":
            return `${name(c.subject)} at ${c.dirs.join(" ")}`;
        case "not_at":
            return `${name(c.subject)} not at ${c.dirs.join(" ")}`;
        case "enclosed":
            return `${name(c.subject)} enclosed`;
        default: {
            const t = [...(c.targets || []).map(name), ...(c.externalTargets || [])].join(", ");
            return `${name(c.subject)} ${c.kind}${c.any ? " any" : ""} [${t}]`;
        }
    }
}

function renderAscii(state, activeIdxs, extAdjByParent) {
    const { W, H, cells, cellW, cellH, rooms } = state;
    const letters = assignLetters(rooms, activeIdxs);
    const stats = collectStats(state);

    const lines = [];
    lines.push(`Grid ${W}x${H}, cell ${cellW.toFixed(1)} x ${cellH.toFixed(1)} cm   (N = up)`);
    lines.push("");
    lines.push("  " + "-".repeat(W + 2));
    for (let y = 0; y < H; y++) {
        let row = "";
        for (let x = 0; x < W; x++) {
            const r = cells[y * W + x];
            row += r < 0 ? "." : letters[r];
        }
        lines.push("  |" + row + "|");
    }
    lines.push("  " + "-".repeat(W + 2));
    lines.push("");

    lines.push("Legend (cells / quota):");
    for (const r of activeIdxs) {
        const room = rooms[r];
        const parentNote = room.parent >= 0 ? `  (inside ${rooms[room.parent].id})` : "";
        lines.push(`  ${letters[r]} ${room.id.padEnd(12)} ${String(stats.sizes[r]).padStart(4)} / ${String(room.quota).padStart(4)}${parentNote}`);
    }
    lines.push("");

    const req = requiredRules(rooms).filter(c => activeIdxs.includes(c.subject) || rooms[c.subject].childIdxs);
    let sat = 0;
    const ruleLines = [];
    for (const c of req) {
        const subj = rooms[c.subject];
        const ok = subj.childIdxs
            ? connectSatisfiedFromRegion(state, c, unionCells(state, subj.childIdxs), extAdjByParent[c.subject])
            : ruleSatisfied(c, state, collectStats(state), subj.parent >= 0 ? extAdjByParent[subj.parent] : undefined);
        if (ok) {
            sat++;
        }
        ruleLines.push(`  ${ok ? "OK " : "XX "} ${describeRule(c, rooms)}`);
    }
    lines.push(`Required rules: ${sat}/${req.length} satisfied`);
    lines.push(...ruleLines);

    const requiredShapes = activeIdxs.filter(roomIdx => rooms[roomIdx].shapeRequired);
    if (requiredShapes.length) {
        const shapeLines = requiredShapes.map(roomIdx => {
            const ok = isRectangle(state, roomIdx);
            return `  ${ok ? "OK " : "XX "} ${rooms[roomIdx].id} shape rect required`;
        });
        const shapeSat = requiredShapes.length - requiredShapeViolations(state, requiredShapes).length;
        lines.push("");
        lines.push(`Required shapes: ${shapeSat}/${requiredShapes.length} satisfied`);
        lines.push(...shapeLines);
    }

    return lines.join("\n");
}

// Required shape violations are a veto whenever a shape-valid candidate
// exists. Legacy candidates all have shapeUnsat=0, preserving old ranking.
// Attempt number breaks ties so shortlist order never depends on insertion.
function compareCandidates(a, b) {
    return ((a.shapeUnsat || 0) - (b.shapeUnsat || 0))
        || (a.unsat - b.unsat)
        || (a.ragged - b.ragged)
        || (a.cost - b.cost)
        || (a.attempt - b.attempt);
}

function addCandidate(list, cand) {
    list.push(cand);
    list.sort(compareCandidates);
    list.length = Math.min(list.length, COARSE_SHORTLIST);
}

// Test hook: internal helpers for unit tests and probes.
const _internals = {
    compareCandidates,
    addCandidate,
    COARSE_SHORTLIST,
    requiredShapeViolations,
    compileRooms,
    makeWarningSink,
    warnIgnoredConfig,
    makeState,
    collectStats,
    softCost,
    tryTransfer,
    roomExtent,
    isRectangle,
    claimCell,
    peelStrip,
    rectifyRoom,
    rectify,
    trySlide,
    optimizeBoundary,
    unsatisfiedRequired,
    straightSharedRun,
    straightHubRun,
    frontageShortfall,
    unionCells,
    connectSatisfiedFromRegion,
    longestAxisRun,
    bandLineCounts,
    regionConnected,
    stripeCandidates,
    finalPolishQuality,
    compareFinalPolishQuality,
    polishWinningLayout,
    finalPolishGroups,
    finalPolishSlideCandidates,
    bestFinalPolishCandidate,
    bestCompoundFinalPolishCandidate,
    deliveredRequiredViolationCount,
};

// =============================================================================
// Main entry
// =============================================================================

function optimizeGridOnce(parsed, opts = {}) {
    const config = parsed.config;
    const warnings = [];
    const warn = makeWarningSink(warnings);
    const seed = opts.seed ?? config.seed ?? 42;

    warnIgnoredConfig(parsed, warn);

    // opts.lookahead widens the satisfied-attempt window. Since scoring an
    // attempt no longer includes the coarse rebalance, the default already
    // covers essentially the whole pool — --thorough is now a no-op on the
    // usual DSLs and kept only as an escape hatch for larger pools.
    const lookahead = opts.lookahead ?? CHEAP_LOOKAHEAD;

    const rooms = compileRooms(parsed.modules, config, warnings, { warn });

    // children with required cross-boundary connects each need cwl of contact
    // through the parent's border — widen the parent's own connect demand so
    // the outer solve reserves enough shared wall
    for (const room of rooms) {
        if (!room.inside) {
            continue;
        }
        const extKidCwls = room.inside.modules.map(module => {
            const requiredCwls = (module.rules || [])
                .filter(rule => rule.type === "connect" && rule.required && rule.crossBoundary && !rule.subjectAny)
                .map(rule => rule.cwl ?? room.inside.config.cwl ?? config.cwl ?? 0);
            return requiredCwls.length ? Math.max(...requiredCwls) : 0;
        }).filter(cwl => cwl > 0);
        if (!extKidCwls.length) {
            continue;
        }
        room.extKidNeed = extKidCwls.reduce((sum, cwl) => sum + cwl, 0);
        room.extKidCwl = Math.min(...extKidCwls);

        // largest child's quota share, mirroring solveInside's quota formula —
        // the shortfall must be known BEFORE the inside solve computes quotas
        const kids = room.inside.modules;
        const areaSum = kids.reduce((s, m) => s + (m.area || 0), 0) || 1;
        room.extKidTopShare = Math.max(...kids.map(m =>
            (m.area || areaSum / kids.length) / areaSum));

        for (const c of room.rules) {
            if (c.kind === "connect" && c.required) {
                // original (pre-bump) cwl, kept for the parent's own-rule
                // re-check against its children's cell union (see
                // connectSatisfiedFromRegion) — the bumped value is only the
                // outer solve's frontage-reservation demand, not a door width
                c.origCwl = c.cwl;
                c.cwl = Math.max(c.cwl, room.extKidNeed);
            }
        }
    }

    const outerIdxs = rooms.map((_, i) => i);

    // hubs: rooms many required connects point at (the hallway network)
    const indeg = new Array(rooms.length).fill(0);
    for (const room of rooms) {
        for (const c of room.rules) {
            if (c.kind === "connect" && c.required) {
                for (const t of c.targets) {
                    indeg[t]++;
                }
            }
        }
    }
    const hubIdxs = outerIdxs.filter(i => indeg[i] >= HUB_INDEGREE_MIN);
    const hubSet = new Set(hubIdxs);
    const nonHubIdxs = outerIdxs.filter(i => !hubSet.has(i));
    let satisfiedAttempts = 0;

    // rectangular by default; hubs (hallway spines) stay free-form unless the
    // room says otherwise; 'shapes free' restores polyomino mode globally
    for (const r of rooms) {
        const dflt = !config.shapeRequired && (hubSet.has(r.index) || config.shapes === "free") ? "free" : "rect";
        r.rect = (r.shape ?? dflt) === "rect";
        r.shapeRequired = r.shape !== "free" && (r.shapeRequired || !!config.shapeRequired);
    }
    let best = null;

    const pool = [];

    // three attempt phases:
    //   spine   — hubs pre-painted as a corridor band (only when hubs exist);
    //             the normal path since random hub growth rarely survives
    //   staged  — original hub-first staged solve, entered only when no spine
    //             attempt fully satisfied the required rules
    //   relaxed — staged + best-effort tether, entered only when nothing
    //             survived at all (failed corridors left to growth/repair)
    const spinePhase = hubIdxs.length ? MAX_ATTEMPTS : 0;
    for (let attempt = 0; attempt < spinePhase + MAX_ATTEMPTS * 2; attempt++) {
        if (attempt === spinePhase && best && best.unsat === 0) {
            break;
        }
        if (attempt === spinePhase + MAX_ATTEMPTS && best) {
            break;
        }
        const mode = attempt < spinePhase ? "spine"
            : attempt < spinePhase + MAX_ATTEMPTS ? "staged" : "relaxed";
        const rng = mulberry32((seed * 9301 + attempt * 49297) >>> 0);

        // canvas is ignored: grid dims (and so the plan's aspect) are sampled
        // per attempt, quotas and square cell size come from real areas alone
        const [W, H] = GRID_DIMS[Math.floor(rng() * GRID_DIMS.length)];
        const stateRooms = rooms.map(r => ({ ...r, rules: r.rules }));
        const totalRealArea = computeQuotas(stateRooms, W * H);
        const cellEdge = Math.sqrt(totalRealArea / (W * H));
        const state = makeState(W, H, cellEdge, cellEdge, stateRooms);
        for (const i of hubIdxs) {
            state.rooms[i].isHub = true;
        }
        state._dbg = !!opts.debug;
        const fullMask = new Set(Array.from({ length: W * H }, (_, i) => i));

        if (mode === "spine") {
            state.anchors = [];
            state.anchorCells = new Set();
            state.spine = paintSpine(state, hubIdxs, rng);
            if (!state.spine) {
                if (opts.debug) console.error(`attempt ${attempt}: spine paint failed`);
                continue;
            }
            assignSides(state, nonHubIdxs);
        } else {
            state.anchors = computeAnchors(state.rooms, hubSet, W, H);
            state.anchorCells = new Set(state.anchors.map(a => a.cell));

            // stage A: hub spine seeded and grown to quota first
            if (hubIdxs.length) {
                const hubSeeds = placeSeeds(hubIdxs, state, rng);
                if (!hubSeeds) {
                    if (opts.debug) console.error(`attempt ${attempt}: hub seeding failed`);
                    continue;
                }
                if (!growRegions(state, hubIdxs, hubSeeds, fullMask, rng, undefined, true)) {
                    if (opts.debug) console.error(`attempt ${attempt}: hub growth failed`);
                    continue;
                }
            }
        }

        // stage B: dependents seed near the spine, tether corridors, then grow
        const seeds = placeSeeds(nonHubIdxs, state, rng);
        if (!seeds) {
            if (opts.debug) console.error(`attempt ${attempt}: dependent seeding failed`);
            continue;
        }
        for (const [r, idx] of Object.entries(seeds)) {
            state.cells[idx] = +r;
        }

        // 3x3 growth pockets around sizable seeds; corridors route around them
        state.seedPockets = new Map();
        for (const [r, idx] of Object.entries(seeds)) {
            if (state.rooms[+r].quota < 8) {
                continue;
            }
            const sx = idx % W;
            const sy = (idx / W) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = sx + dx;
                    const y = sy + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) {
                        continue;
                    }
                    const p = y * W + x;
                    if (!state.seedPockets.has(p)) {
                        state.seedPockets.set(p, +r);
                    }
                }
            }
        }
        const tetherOk = tetherRooms(state, nonHubIdxs, fullMask, undefined, mode === "relaxed");
        state.seedPockets = null;
        if (!tetherOk) {
            if (opts.debug) console.error(`attempt ${attempt}: tethering failed`);
            continue;
        }
        const trace = opts.debugDump === attempt;
        if (trace) dumpCoarse(state, `attempt ${attempt} after tether:`);
        if (!growRegions(state, nonHubIdxs, seeds, fullMask, rng, undefined, false, outerIdxs)) {
            if (opts.debug) console.error(`attempt ${attempt}: dependent growth failed`);
            continue;
        }
        if (trace) dumpCoarse(state, `attempt ${attempt} after growth:`);
        opts.stageHook?.("growth", attempt, state, outerIdxs);
        repair(state);
        if (trace) dumpCoarse(state, `attempt ${attempt} after repair:`);
        opts.stageHook?.("repair", attempt, state, outerIdxs);
        rectify(state, outerIdxs);
        if (trace) dumpCoarse(state, `attempt ${attempt} after rectify:`);
        opts.stageHook?.("rectify", attempt, state, outerIdxs);

        const ruleUnsat = unsatisfiedRequired(state);
        const shapeUnsat = requiredShapeViolations(state, outerIdxs);
        const cost = softCost(state, outerIdxs);

        // refinement provably never breaks an intact rectangle, so any ragged
        // rect-room in the kept attempt ships ragged — select it away while
        // the attempt pool is healthy (lexicographic, between unsat and cost)
        const ragged = outerIdxs.filter(r => state.rooms[r].rect && !isRectangle(state, r)).length;
        if (opts.debug) {
            const descriptions = [
                ...ruleUnsat.map(c => describeRule(c, state.rooms)),
                ...shapeUnsat.map(r => `${state.rooms[r].id} shape rect required`),
            ];
            console.error(`attempt ${attempt}: unsat=${descriptions.length} [${descriptions.join("; ")}] ragged=${ragged} cost=${cost.toFixed(2)}`);
        }
        addCandidate(pool, {
            shapeUnsat: shapeUnsat.length,
            unsat: ruleUnsat.length + shapeUnsat.length,
            ragged,
            cost,
            state,
            attempt,
        });
        best = pool[0];
        if (best.unsat === 0 && ++satisfiedAttempts > lookahead) {
            break;
        }
    }

    if (!pool.length) {
        return {
            error: "grid: no coarse solution found (seed placement failed on every attempt)",
            warnings,
        };
    }

    // Coarse rebalance is the expensive part of scoring an attempt, so it runs
    // only on the shortlist: wall slides rescue rooms sealed near their seed
    // (a tether corridor can box a room in at 1 cell — growth can never fix
    // that, but sliding whole walls at 48 cells is cheap and safe), and they
    // reorder the shortlist, so every finalist is rescored afterwards.
    for (const cand of pool) {
        optimizeBoundary(cand.state, outerIdxs, undefined, () => true);
        if (opts.debugDump === cand.attempt) dumpCoarse(cand.state, `attempt ${cand.attempt} after coarse rebalance:`);
        cand.shapeUnsat = requiredShapeViolations(cand.state, outerIdxs).length;
        cand.unsat = unsatisfiedRequired(cand.state).length + cand.shapeUnsat;
        cand.ragged = outerIdxs.filter(r => cand.state.rooms[r].rect && !isRectangle(cand.state, r)).length;
        cand.cost = softCost(cand.state, outerIdxs);
    }
    pool.sort(compareCandidates);
    best = pool[0];

    const state = best.state;

    // anchors, spine and side steering are coarse-resolution guidance; their
    // cell indices are stale after subdivide, so drop them before refinement
    state.anchors = [];
    state.anchorCells = new Set();
    state.spine = null;
    state.sideOf = null;

    // refinement: subdivide + greedy boundary optimization among outer rooms
    const outerFlip = (a, b) => state.rooms[a].parent === -1 && state.rooms[b].parent === -1;
    opts.stageHook?.("coarse-best", best.attempt, state, outerIdxs);
    for (let level = 0; level < REFINE_LEVELS; level++) {
        subdivide(state);
        optimizeBoundary(state, outerIdxs, undefined, outerFlip);
        opts.stageHook?.(`refine-${level}`, best.attempt, state, outerIdxs);
    }

    // inside blocks at final resolution
    const extAdjByParent = {};
    let activeIdxs = outerIdxs.slice();
    const insideQueue = outerIdxs.slice();
    while (insideQueue.length) {
        const r = insideQueue.shift();
        if (!state.rooms[r].inside) {
            continue;
        }
        const childIdxs = solveInside(state, r, warnings, seed, warn);
        activeIdxs = activeIdxs.filter(i => i !== r).concat(childIdxs);
        // marks r as a replaced parent: its own required rules are re-checked
        // against the union of these children's cells (see
        // connectSatisfiedFromRegion) instead of being silently dropped
        state.rooms[r].childIdxs = childIdxs;

        const extAdj = {};
        for (const ci of childIdxs) {
            for (const rule of state.rooms[ci].rules) {
                for (const name of rule.externalTargets || []) {
                    if (!extAdj[name]) {
                        const outer = state.rooms.find(x => x.id === name && x.parent === state.rooms[r].parent);
                        if (outer) {
                            extAdj[name] = new Set();
                            for (let i = 0; i < state.cells.length; i++) {
                                if (state.cells[i] === outer.index) {
                                    extAdj[name].add(i);
                                }
                            }
                        }
                    }
                }
            }
        }
        extAdjByParent[r] = extAdj;

        const siblingFlip = (a, b) => state.rooms[a].parent === r && state.rooms[b].parent === r;
        optimizeBoundary(state, childIdxs, extAdj, siblingFlip);
        opts.stageHook?.(`inside-${state.rooms[r].id}`, best.attempt, state, activeIdxs);
        insideQueue.push(...childIdxs);
    }

    polishWinningLayout(state, activeIdxs);
    for (let r = 0; r < state.rooms.length; r++) {
        if (state.rooms[r].childIdxs) {
            extAdjByParent[r] = externalAdjacencyForParent(state, r);
        }
    }
    opts.stageHook?.("final-polish", best.attempt, state, activeIdxs);
    opts.stageHook?.("final", best.attempt, state, activeIdxs);

    const ascii = renderAscii(state, activeIdxs, extAdjByParent);
    const unsatRules = requiredRules(state.rooms)
        .filter(c => activeIdxs.includes(c.subject) || state.rooms[c.subject].childIdxs)
        .filter(c => {
            const subj = state.rooms[c.subject];
            if (subj.childIdxs) {
                return !connectSatisfiedFromRegion(state, c, unionCells(state, subj.childIdxs), extAdjByParent[c.subject]);
            }
            const parent = subj.parent;
            return !ruleSatisfied(c, state, collectStats(state), parent >= 0 ? extAdjByParent[parent] : undefined);
        });
    const unsatShapes = requiredShapeViolations(state, activeIdxs);

    return {
        state,
        activeIdxs,
        ascii,
        attempt: best.attempt,
        shapeUnsatisfied: unsatShapes.length,
        unsatisfied: [
            ...unsatRules.map(c => describeRule(c, state.rooms)),
            ...unsatShapes.map(roomIdx => `${state.rooms[roomIdx].id} shape rect required`),
        ],
        warnings,
    };
}

function hasRequiredShape(config, modules) {
    return !!config.shapeRequired || modules.some(module =>
        module.shapeRequired || (module.inside && hasRequiredShape(module.inside.config, module.inside.modules)));
}

function optimizeGrid(parsed, opts = {}) {
    if (opts.debug || opts.debugDump !== undefined || opts.stageHook) {
        return optimizeGridOnce(parsed, opts);
    }
    const initialSeed = opts.seed ?? parsed.config.seed ?? 42;
    const retryLimit = hasRequiredShape(parsed.config, parsed.modules)
        ? REQUIRED_SHAPE_SEED_RETRIES
        : REQUIRED_SEED_RETRIES;
    let best = null;
    for (let offset = 0; offset <= retryLimit; offset++) {
        const result = optimizeGridOnce(parsed, { ...opts, seed: initialSeed + offset });
        result.seed = initialSeed + offset;
        if (result.error) {
            if (!best) {
                best = result;
            }
            continue;
        }
        const score = softCost(result.state, result.activeIdxs);
        const candidate = {
            result,
            shapeUnsatisfied: result.shapeUnsatisfied,
            unsatisfied: result.unsatisfied.length,
            score,
        };
        if (!best || best.error || candidate.shapeUnsatisfied < best.shapeUnsatisfied
            || (candidate.shapeUnsatisfied === best.shapeUnsatisfied && candidate.unsatisfied < best.unsatisfied)
            || (candidate.shapeUnsatisfied === best.shapeUnsatisfied
                && candidate.unsatisfied === best.unsatisfied && candidate.score < best.score)) {
            best = candidate;
        }
        if (candidate.unsatisfied === 0) {
            return result;
        }
    }
    return best.result || best;
}

function roomPath(rooms, roomIdx) {
    const ids = [];
    let current = roomIdx;
    while (current >= 0) {
        ids.push(rooms[current].id);
        current = rooms[current].parent;
    }
    return ids.reverse().join(" / ");
}

function roomParts(state, roomIdx) {
    const parts = [];
    let previousRuns = new Map();
    for (let y = 0; y < state.H; y++) {
        const currentRuns = new Map();
        let x = 0;
        while (x < state.W) {
            if (state.cells[y * state.W + x] !== roomIdx) {
                x++;
                continue;
            }
            const x0 = x;
            while (x < state.W && state.cells[y * state.W + x] === roomIdx) {
                x++;
            }
            const key = `${x0}:${x}`;
            let part = previousRuns.get(key);
            if (part) {
                part.h += state.cellH;
            } else {
                part = {
                    x: x0 * state.cellW,
                    y: y * state.cellH,
                    w: (x - x0) * state.cellW,
                    h: state.cellH,
                };
                parts.push(part);
            }
            currentRuns.set(key, part);
        }
        previousRuns = currentRuns;
    }
    return parts;
}

function gridResultToLayout(result, parserWarnings = []) {
    const { state, activeIdxs } = result;
    const breakdown = {};
    const cost = softCost(state, activeIdxs, undefined, breakdown);
    const rooms = activeIdxs.map(roomIdx => {
        const parts = roomParts(state, roomIdx);
        const x = Math.min(...parts.map(part => part.x));
        const y = Math.min(...parts.map(part => part.y));
        const xe = Math.max(...parts.map(part => part.x + part.w));
        const ye = Math.max(...parts.map(part => part.y + part.h));
        return {
            id: `grid-room-${roomIdx}`,
            sourceId: state.rooms[roomIdx].id,
            name: roomPath(state.rooms, roomIdx),
            x,
            y,
            w: xe - x,
            h: ye - y,
            centerX: (x + xe) / 2,
            centerY: (y + ye) / 2,
            parts,
        };
    });
    return {
        schemaVersion: 1,
        algo: "grid",
        geometry: "grid",
        cost,
        breakdown,
        rooms,
        canvasW: state.W * state.cellW,
        canvasH: state.H * state.cellH,
        attempt: result.attempt,
        seed: result.seed,
        unsatisfied: result.unsatisfied,
        warnings: [...new Set([...parserWarnings, ...result.warnings])],
        ruleReport: {
            availability: "unavailable",
            metric: null,
            percentBasis: null,
            scopes: [],
            reason: "Grid refinement score does not expose stable per-rule penalty terms. Unsupported grid semantics remain warnings, not satisfied rules.",
        },
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { optimizeGrid, gridResultToLayout, _internals };
}
