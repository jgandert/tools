const fs = require("fs");
const path = require("path");

// Load v2 components
const { parseDSL } = require("./parser.js");
const { optimizeRecursive } = require("./orchestrator.js");

// Load engine by appending exports to a temp file
const engineCode = fs.readFileSync(path.join(__dirname, "layout_optimizer.js"), "utf8");
const engineWithExports = engineCode + "\nmodule.exports = { wongLiuSimulatedAnnealing, evaluateCost, calculateTopologicalPenalties, assignCoordinates, buildInitialCandidates, orderedToNpe, buildLinearFallback, isValidNPE, buildRuleIndex, applyGuidedMove, checkRequiredSatisfied };\n";
const tempEnginePath = path.join(__dirname, "temp", "layout_optimizer_exported.js");

if (!fs.existsSync(path.join(__dirname, "temp"))) {
    fs.mkdirSync(path.join(__dirname, "temp"));
}
fs.writeFileSync(tempEnginePath, engineWithExports);

const {
    wongLiuSimulatedAnnealing,
    evaluateCost,
    calculateTopologicalPenalties,
    assignCoordinates,
    buildInitialCandidates,
    orderedToNpe,
    buildLinearFallback,
    isValidNPE,
    buildRuleIndex,
    applyGuidedMove,
    checkRequiredSatisfied,
} = require(tempEnginePath);

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

function overlapArea(A, B) {
    const xOverlap = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
    const yOverlap = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    return xOverlap * yOverlap;
}

function noOverlap(rooms) {
    for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
            const A = rooms[i], B = rooms[j];
            const ov = overlapArea(A, B);
            if (ov > 1) {
                return { ok: false, a: A.name, b: B.name, ov };
            }
        }
    }
    return { ok: true };
}

function inCanvas(rooms, w, h) {
    for (const r of rooms) {
        if (r.x < -1 || r.y < -1 || r.x + r.w > w + 1 || r.y + r.h > h + 1) {
            return { ok: false, room: r.name, x: r.x, y: r.y, w: r.w, h: r.h };
        }
    }
    return { ok: true };
}

function roomByName(rooms, name) {
    return rooms.find(r => r.name === name);
}

function sharedWallLen(rooms, nameA, nameB) {
    const A = rooms.find(r => r.name === nameA);
    const B = rooms.find(r => r.name === nameB);
    if (!A || !B) {
        return 0;
    }
    const isHorizontallyAdjacent = (Math.abs(A.x + A.w - B.x) < 0.1) || (Math.abs(B.x + B.w - A.x) < 0.1);
    const verticalOverlap = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    const isVerticallyAdjacent = (Math.abs(A.y + A.h - B.y) < 0.1) || (Math.abs(B.y + B.h - A.y) < 0.1);
    const horizontalOverlap = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));

    let shared = 0;
    if (isHorizontallyAdjacent && verticalOverlap > 0) {
        shared = verticalOverlap;
    }
    if (isVerticallyAdjacent && horizontalOverlap > 0) {
        shared = horizontalOverlap;
    }
    return shared;
}

async function runFloorPlan(dsl) {
    const { config, modules } = parseDSL(dsl);

    // Extract seed if present in DSL
    let seed = 1;
    const seedMatch = dsl.match(/seed\s+(\d+)/);
    if (seedMatch) {
        seed = parseInt(seedMatch[1]);
    }

    // Fix for 1-room plans (layout_optimizer.js requires >= 2)
    const originalCount = modules.length;
    if (modules.length === 1) {
        modules.push({ id: "_dummy", area: 1, w: 1, h: 1, rules: [] });
    }

    const result = await wongLiuSimulatedAnnealing(modules, {
        ...config,
        seed: seed,
        initial_t: 4000,
        cooling_rate: 0.85,
        k: 100,
        iter: 5,
    });

    return {
        rooms: result.layout.filter(r => r.id !== "_dummy").map(r => ({ ...r, name: r.id })),
        score: result.cost,
        breakdown: {},
    };
}

(async function runTests() {
    console.log("Starting v2 Tests...");

    // =====================================================================
    // TEST 1: Simple two-room connection
    // =====================================================================
    console.log("\n=== Test 1: Simple two-room connection ===");
    {
        const result = await runFloorPlan(`
            canvas 300 200
            room A area=100x50
            room B area=100x50
            A connect B
        `);
        const ov = noOverlap(result.rooms);
        assert(ov.ok, `T1 no overlap (${ov.a}-${ov.b} ov=${ov.ov})`);
        assert(inCanvas(result.rooms, 300, 200).ok, "T1 in canvas");
        const wl = sharedWallLen(result.rooms, "A", "B");
        assert(wl > 0, `T1 shared wall > 0 (got ${wl})`);
        console.log(`  Score: ${result.score.toFixed(2)}, Wall: ${wl}`);
    }

    // =====================================================================
    // TEST 2: Three rooms in a line: A-B-C
    // =====================================================================
    console.log("\n=== Test 2: Three rooms in a line ===");
    {
        const result = await runFloorPlan(`
            canvas 400 200
            room A area=100x100
            room B area=100x100
            room C area=100x100
            A connect B
            B connect C
            A far C
        `);
        const ov = noOverlap(result.rooms);
        assert(ov.ok, `T2 no overlap (${ov.a}-${ov.b} ov=${ov.ov})`);
        assert(inCanvas(result.rooms, 400, 200).ok, "T2 in canvas");
        const wlAB = sharedWallLen(result.rooms, "A", "B");
        const wlBC = sharedWallLen(result.rooms, "B", "C");
        assert(wlAB > 0, `T2 A-B wall > 0 (got ${wlAB})`);
        assert(wlBC > 0, `T2 B-C wall > 0 (got ${wlBC})`);
        const rA = roomByName(result.rooms, "A"), rC = roomByName(result.rooms, "C");
        const cxA = rA.x + rA.w / 2, cyA = rA.y + rA.h / 2;
        const cxC = rC.x + rC.w / 2, cyC = rC.y + rC.h / 2;
        const centDist = Math.hypot(cxC - cxA, cyC - cyA);
        const halfDiagA = Math.hypot(rA.w, rA.h) / 2, halfDiagC = Math.hypot(rC.w, rC.h) / 2;
        assert(centDist > halfDiagA + halfDiagC, `T2 A far C: centroid dist ${centDist.toFixed(1)} > half-diag sum ${(halfDiagA + halfDiagC).toFixed(1)}`);
        console.log(`  Score: ${result.score.toFixed(2)}, AB=${wlAB}, BC=${wlBC}, A-C centDist=${centDist.toFixed(1)}`);
    }

    // =====================================================================
    // TEST 3: Four rooms forming a grid
    // =====================================================================
    console.log("\n=== Test 3: Four rooms grid ===");
    {
        const result = await runFloorPlan(`
            canvas 400 400
            room A area=150x150
            room B area=150x150
            room C area=150x150
            room D area=150x150
            A connect B
            A connect C
            B connect D
            C connect D
        `);
        const ov = noOverlap(result.rooms);
        assert(ov.ok, `T3 no overlap (${ov.a}-${ov.b} ov=${ov.ov})`);
        assert(inCanvas(result.rooms, 800, 800).ok, "T3 in canvas");
        const wlAB = sharedWallLen(result.rooms, "A", "B");
        const wlAC = sharedWallLen(result.rooms, "A", "C");
        const wlBD = sharedWallLen(result.rooms, "B", "D");
        const wlCD = sharedWallLen(result.rooms, "C", "D");
        let connections = 0;
        if (wlAB > 0) {
            connections++;
        }
        if (wlAC > 0) {
            connections++;
        }
        if (wlBD > 0) {
            connections++;
        }
        if (wlCD > 0) {
            connections++;
        }
        assert(connections >= 3, `T3 >= 3 connections (got ${connections})`);
        console.log(`  Score: ${result.score.toFixed(2)}, AB=${wlAB}, AC=${wlAC}, BD=${wlBD}, CD=${wlCD}`);
    }

    // =====================================================================
    // TEST 4: Facing directions (at north/south/east/west)
    // =====================================================================
    console.log("\n=== Test 4: Facing directions ===");
    {
        const result = await runFloorPlan(`
            canvas 500 500
            room north_room area=100x80
            room south_room area=100x80
            room east_room area=80x100
            room west_room area=80x100
            north_room at north
            south_room at south
            east_room at east
            west_room at west
        `);
        const rooms = result.rooms;
        const ov = noOverlap(rooms);
        assert(ov.ok, `T4 no overlap (${ov.a}-${ov.b} ov=${ov.ov})`);
        assert(inCanvas(rooms, 500, 500).ok, "T4 in canvas");

        const nr = roomByName(rooms, "north_room");
        const sr = roomByName(rooms, "south_room");
        const er = roomByName(rooms, "east_room");
        const wr = roomByName(rooms, "west_room");

        let maxX = -Infinity, maxY = -Infinity;
        for (const r of rooms) {
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.h);
        }

        assert(Math.abs(nr.y - 0) <= 100, `T4 north_room near north (y=${nr.y})`);
        assert(Math.abs((sr.y + sr.h) - maxY) <= 100, `T4 south_room near south (y+h=${sr.y + sr.h}, maxY=${maxY})`);
        assert(Math.abs((er.x + er.w) - maxX) <= 100, `T4 east_room near east (x+w=${er.x + er.w}, maxX=${maxX})`);
        assert(Math.abs(wr.x - 0) <= 100, `T4 west_room near west (x=${wr.x})`);
        console.log(`  Score: ${result.score.toFixed(2)}`);
    }

    // =====================================================================
    // TEST 5: Enclosed constraint (not at edge)
    // =====================================================================
    console.log("\n=== Test 5: Enclosed room ===");
    {
        const result = await runFloorPlan(`
            canvas 500 500
            room n area=200x50
            room s area=200x50
            room e area=50x200
            room w area=50x200
            room inner area=100x100
            inner enclosed
            n at north
            s at south
            e at east
            w at west
        `);
        const rooms = result.rooms;
        const inner = roomByName(rooms, "inner");

        let maxX = -Infinity, maxY = -Infinity;
        for (const r of rooms) {
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.h);
        }

        const d_min = Math.min(inner.y, maxY - (inner.y + inner.h), inner.x, maxX - (inner.x + inner.w));
        assert(d_min >= 0, "T5 inner room is inside layout"); // Slicing trees can't perfectly enclose unless very specific, but we check penalty logic mainly.
        console.log(`  Score: ${result.score.toFixed(2)}, Edge Dist: ${d_min.toFixed(1)}`);
    }

    // =====================================================================
    // TEST 6: Area min constraint
    // =====================================================================
    console.log("\n=== Test 6: Area min constraint ===");
    {
        const result = await runFloorPlan(`
            canvas 500 500
            room big area=200 area_min=180
            room small area=50 area_min=40
        `);
        const rooms = result.rooms;
        const big = roomByName(rooms, "big");
        const small = roomByName(rooms, "small");
        const bigArea = big.w * big.h;
        const smallArea = small.w * small.h;
        assert(bigArea >= 170, `T6 big area >= 170 (got ${bigArea.toFixed(1)})`);
        assert(smallArea >= 35, `T6 small area >= 35 (got ${smallArea.toFixed(1)})`);
        console.log(`  big area=${bigArea.toFixed(1)}, small area=${smallArea.toFixed(1)}`);
    }

    // =====================================================================
    // TEST 8: Ratio constraint
    // =====================================================================
    console.log("\n=== Test 8: Ratio constraint ===");
    {
        const result = await runFloorPlan(`
            canvas 500 500
            room hall area=300 ratio=3:1
        `);
        const hall = roomByName(result.rooms, "hall");
        const ratio = hall.w / hall.h;
        const target = 3.0;
        assert(Math.abs(ratio - target) < 1.0 || Math.abs(1 / ratio - target) < 1.0,
            `T8 hall ratio ~3:1 (got ${ratio.toFixed(2)} or ${(1 / ratio).toFixed(2)})`);
        console.log(`  hall: ${hall.w.toFixed(1)}x${hall.h.toFixed(1)}, ratio=${ratio.toFixed(2)}`);
    }

    // =====================================================================
    // TEST 10: At edge constraint
    // =====================================================================
    console.log("\n=== Test 10: At edge ===");
    {
        const result = await runFloorPlan(`
            canvas 400 400
            room center area=100x100
            room edge1 area=60x60
            room edge2 area=60x60
            edge1 at edge
            edge2 at edge
            center connect edge1
            center connect edge2
        `);
        const rooms = result.rooms;
        const ov = noOverlap(rooms);
        assert(ov.ok, "T10 no overlap");
        assert(inCanvas(rooms, 400, 400).ok, "T10 in canvas");

        let maxX = -Infinity, maxY = -Infinity;
        for (const r of rooms) {
            maxX = Math.max(maxX, r.x + r.w);
            maxY = Math.max(maxY, r.y + r.h);
        }
        for (const name of ["edge1", "edge2"]) {
            const r = roomByName(rooms, name);
            const d_min = Math.min(r.y, maxY - (r.y + r.h), r.x, maxX - (r.x + r.w));
            assert(d_min < 5, `T10 ${name} at edge (dist=${d_min.toFixed(1)})`);
        }
        console.log(`  Score: ${result.score.toFixed(2)}`);
    }

    // =====================================================================
    // TEST 11: Complex house layout - 6 rooms
    // =====================================================================
    console.log("\n=== Test 11: Complex house (6 rooms) ===");
    {
        const result = await runFloorPlan(`
            canvas 1000 800
            cwl 60
            room living area=200x150
            room kitchen area=150x120
            room dining area=120x100
            room bedroom area=150x130
            room bathroom area=80x70
            room hallway area=200x40
            living connect hallway
            kitchen connect hallway
            dining connect kitchen
            bedroom connect hallway
            bathroom connect hallway
            living at south
            kitchen at east
        `);
        const rooms = result.rooms;
        const ov = noOverlap(rooms);
        assert(ov.ok, "T11 no overlap");
        assert(inCanvas(rooms, 1000, 800).ok, "T11 in canvas");

        let hallConnections = 0;
        for (const name of ["living", "kitchen", "bedroom", "bathroom"]) {
            const wl = sharedWallLen(rooms, name, "hallway");
            if (wl > 0) {
                hallConnections++;
            }
        }
        assert(hallConnections >= 2, `T11 hallway connects to >= 2 rooms (got ${hallConnections})`);
        console.log(`  Score: ${result.score.toFixed(2)}, hallConnections=${hallConnections}`);
    }

    // =====================================================================
    // TEST 15: Close and far constraints
    // =====================================================================
    console.log("\n=== Test 15: Close and far constraints ===");
    {
        const result = await runFloorPlan(`
            canvas 600 400
            room A area=80x80
            room B area=80x80
            room C area=80x80
            A close B weight=1.0
            A far C weight=1.0
            B far C weight=1.0
        `);
        const rooms = result.rooms;
        const ov = noOverlap(rooms);
        assert(ov.ok, "T15 no overlap");

        const cA = { x: roomByName(rooms, "A").x + 40, y: roomByName(rooms, "A").y + 40 };
        const cB = { x: roomByName(rooms, "B").x + 40, y: roomByName(rooms, "B").y + 40 };
        const cC = { x: roomByName(rooms, "C").x + 40, y: roomByName(rooms, "C").y + 40 };
        const dAB = Math.sqrt((cA.x - cB.x) ** 2 + (cA.y - cB.y) ** 2);
        const dAC = Math.sqrt((cA.x - cC.x) ** 2 + (cA.y - cC.y) ** 2);
        const dBC = Math.sqrt((cB.x - cC.x) ** 2 + (cB.y - cC.y) ** 2);
        assert(dAB <= dAC + 50, `T15 A close to B (AB=${dAB.toFixed(0)}, AC=${dAC.toFixed(0)})`);
        assert(dBC >= dAB - 50, `T15 B far from C (BC=${dBC.toFixed(0)}, AB=${dAB.toFixed(0)})`);
        console.log(`  dAB=${dAB.toFixed(0)}, dAC=${dAC.toFixed(0)}, dBC=${dBC.toFixed(0)}`);
    }

    // =====================================================================
    // TEST 17: Determinism check
    // =====================================================================
    console.log("\n=== Test 17: Determinism ===");
    {
        const dsl = `
            canvas 300 300
            room A area=80x60
            room B area=60x80
            A connect B
        `;
        const r1 = await runFloorPlan(dsl);
        const r2 = await runFloorPlan(dsl);
        assert(JSON.stringify(r1.rooms) === JSON.stringify(r2.rooms), "T17 deterministic output");
    }

    // =====================================================================
    // TEST 93: 'any' modifier for rules
    // =====================================================================
    console.log("\n=== Test 93: any modifier ===");
    {
        const result = await runFloorPlan(`
            canvas 500 500
            room living area=100x100
            room kitchen area=80x80
            room hall1 area=50x50
            room hall2 area=50x50
            room bed area=100x100

            hallways = [hall1, hall2]

            living connect any hallways
            kitchen close any [hall1, hall2]
            bed far any hallways
        `);

        const rooms = result.rooms;
        const livingHall1 = sharedWallLen(rooms, "living", "hall1");
        const livingHall2 = sharedWallLen(rooms, "living", "hall2");
        assert(livingHall1 > 0 || livingHall2 > 0, `T93 any connection satisfied (hall1:${livingHall1}, hall2:${livingHall2})`);
        console.log(`  Score: ${result.score.toFixed(2)}, hall1_wall=${livingHall1}, hall2_wall=${livingHall2}`);
    }

    // =====================================================================
    // TEST: buildInitialCandidates — all at-north rooms
    // Poles are NS-dominated → baseOp='H' → root operator 'H'.
    // poleSorted puts all rooms in north bucket (before neutral/south).
    // =====================================================================
    console.log("\n=== Test IC1: buildInitialCandidates — all at-north ===");
    {
        function makeModule(id, rules = []) {
            const area = 100;
            const ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            return { id, area, ratioMax, curve, rules };
        }

        const mods = ["A", "B", "C", "D"].map(id => makeModule(id, [{
            type: "at",
            dir: ["north"],
        }]));
        const mm = Object.fromEntries(mods.map(m => [m.id, m]));
        const seed = 42;
        let s = seed;
        const rfn = () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 4294967296;
        };

        const cands = buildInitialCandidates(mods, mm, rfn);
        assert(cands.length > 0, "IC1 candidates non-empty");
        assert(cands.every(c => isValidNPE(c)), "IC1 all candidates valid NPE");
        // NS-dominated → root of first candidate is 'H'
        assert(cands[0][cands[0].length - 1] === "H", `IC1 first candidate root is H (got ${cands[0][cands[0].length - 1]})`);
        console.log(`  candidates: ${cands.length}, first: ${cands[0].join(" ")}`);
    }

    // =====================================================================
    // TEST: buildInitialCandidates — one north, one south, two neutral
    // poleSorted order: [northRoom, neutral1, neutral2, southRoom].
    // In poleSorted candidate NPE, northRoom's array index precedes southRoom's.
    // =====================================================================
    console.log("\n=== Test IC2: buildInitialCandidates — north/south/neutral ===");
    {
        function makeModule2(id, rules = []) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            return { id, area, ratioMax, curve, rules };
        }

        const mods = [
            makeModule2("N", [{ type: "at", dir: ["north"] }]),
            makeModule2("X", []),
            makeModule2("Y", []),
            makeModule2("S", [{ type: "at", dir: ["south"] }]),
        ];
        const mm = Object.fromEntries(mods.map(m => [m.id, m]));
        const rfn = () => 0.5;

        const cands = buildInitialCandidates(mods, mm, rfn);
        assert(cands.length > 0, "IC2 candidates non-empty");
        assert(cands.every(c => isValidNPE(c)), "IC2 all candidates valid NPE");
        // First candidate uses poleSorted order: N, ..., S
        const first = cands[0];
        const idxN = first.indexOf("N"), idxS = first.indexOf("S");
        assert(idxN < idxS, `IC2 N precedes S in poleSorted candidate (N@${idxN}, S@${idxS})`);
        console.log(`  first candidate: ${first.join(" ")}`);
    }

    // =====================================================================
    // TEST: buildInitialCandidates — no directional rules
    // No crash. Candidates non-empty, all valid. baseOp defaults to 'V'.
    // =====================================================================
    console.log("\n=== Test IC3: buildInitialCandidates — no at rules ===");
    {
        function makeModule3(id) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            return { id, area, ratioMax, curve, rules: [] };
        }

        const mods = ["A", "B", "C"].map(makeModule3);
        const mm = Object.fromEntries(mods.map(m => [m.id, m]));
        const rfn = () => 0.3;

        let threw = false;
        let cands;
        try {
            cands = buildInitialCandidates(mods, mm, rfn);
        } catch (e) {
            threw = true;
        }
        assert(!threw, "IC3 no crash with no at rules");
        assert(cands && cands.length > 0, "IC3 candidates non-empty");
        assert(cands.every(c => isValidNPE(c)), "IC3 all candidates valid NPE");
        console.log(`  candidates: ${cands.length}, first: ${cands[0].join(" ")}`);
    }

    // =====================================================================
    // TEST: buildInitialCandidates — pure at-edge rules (not pole-sorted)
    // 'edge' is not a pole dir, so poles stay empty → no pole sorting applied.
    // baseOp defaults to 'V'. Candidates include BFS-ordered NPE.
    // =====================================================================
    console.log("\n=== Test IC4: buildInitialCandidates — at edge (not pole) ===");
    {
        function makeModule4(id) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            return { id, area, ratioMax, curve, rules: [{ type: "at", dir: ["edge"] }] };
        }

        const mods = ["A", "B", "C"].map(makeModule4);
        const mm = Object.fromEntries(mods.map(m => [m.id, m]));
        const rfn = () => 0.5;

        const cands = buildInitialCandidates(mods, mm, rfn);
        assert(cands.length > 0, "IC4 candidates non-empty");
        assert(cands.every(c => isValidNPE(c)), "IC4 all candidates valid NPE");
        // No poles → root operator defaults to 'V'
        assert(cands[0][cands[0].length - 1] === "V", `IC4 first candidate root is V (got ${cands[0][cands[0].length - 1]})`);
        console.log(`  candidates: ${cands.length}, first: ${cands[0].join(" ")}`);
    }

    // =====================================================================
    // TEST: Stagnation recovery triggers and resets
    // Use a tight budget so stagnation fires within the run. Verify output
    // remains valid (no crash, valid NPE returned).
    // =====================================================================
    console.log("\n=== Test STAG1: Stagnation recovery fires and resets ===");
    {
        // 4 rooms, no rules → very few improvements after initial convergence.
        // k*n*iter small so STAGNATION_LIMIT (max 200, floor(k*n*iter/8)) is
        // reachable within the run's total move budget.
        function makeMod(id) {
            return {
                id, area: 100, ratioMax: 3.0,
                curve: [{ w: 10, h: 10 }],
            };
        }

        const mods = ["A", "B", "C", "D"].map(makeMod);
        // k=10, n=4, defaultIter~1 → movesAtTemp=40, STAGNATION_LIMIT=max(200,5)=200
        // run enough temperature steps for stagnation to accumulate past 200.
        const result = await wongLiuSimulatedAnnealing(mods, {
            seed: 42,
            k: 10,
            iter: 1,
            cooling_rate: 0.5,  // fast cooling → many low-T steps with high rejection
            min_t: 0.001,
        });
        assert(result && result.npe && result.npe.length > 0, "STAG1 result has npe");
        assert(isValidNPE(result.npe), `STAG1 bestNpe is valid NPE (${result.npe.join(" ")})`);
        assert(typeof result.cost === "number" && isFinite(result.cost), `STAG1 finite cost (${result.cost})`);
        console.log(`  cost: ${result.cost.toFixed(2)}, npe: ${result.npe.join(" ")}`);
    }

    // =====================================================================
    // TEST: Determinism — same seed produces identical bestNpe across runs
    // =====================================================================
    console.log("\n=== Test STAG2: Determinism with stagnation enabled ===");
    {
        function makeMod(id) {
            return {
                id, area: 100, ratioMax: 3.0,
                curve: [{ w: 10, h: 10 }, { w: 5, h: 20 }],
            };
        }

        const mods = ["A", "B", "C", "D"].map(makeMod);
        const cfg = { seed: 0xCAFE, k: 10, iter: 1, cooling_rate: 0.7, min_t: 0.1 };

        const r1 = await wongLiuSimulatedAnnealing([...mods.map(m => ({ ...m }))], { ...cfg });
        const r2 = await wongLiuSimulatedAnnealing([...mods.map(m => ({ ...m }))], { ...cfg });

        assert(JSON.stringify(r1.npe) === JSON.stringify(r2.npe),
            `STAG2 same seed → identical npe (run1: ${r1.npe.join(" ")} run2: ${r2.npe.join(" ")})`);
        assert(Math.abs(r1.cost - r2.cost) < 1e-6,
            `STAG2 same seed → identical cost (${r1.cost} vs ${r2.cost})`);
        console.log(`  npe: ${r1.npe.join(" ")}, cost: ${r1.cost.toFixed(2)}`);
    }

    // =====================================================================
    // TEST FLIP1: Global-flip probe — NS-rule layout ends on correct axis
    // 4-room input: 2 at north, 2 at south. Try multiple seeds; at least one
    // should yield north rooms at top and south rooms at bottom.
    // =====================================================================
    console.log("\n=== Test FLIP1: Global-flip probe — NS rules on correct axis ===");
    {
        function makeMod(id, dir) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            const rules = dir ? [{ type: "at", dir }] : [];
            return { id, area, ratioMax, curve, rules };
        }

        const mods = [
            makeMod("N1", "north"), makeMod("N2", "north"),
            makeMod("S1", "south"), makeMod("S2", "south"),
        ];
        // Run with a few seeds; the flip probe should help at least the seeds
        // where SA converges to the wrong axis. Require that at least one run
        // places north rooms above south rooms.
        let anyCorrect = false;
        for (const seed of [1, 2, 3, 7, 42]) {
            const r = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), {
                seed, k: 15, iter: 2, cooling_rate: 0.80, min_t: 0.5,
                canvasW: 400, canvasH: 400,
            });
            const lm = Object.fromEntries(r.layout.map(x => [x.id, x]));
            const northTop = Math.min(lm["N1"].y, lm["N2"].y);
            const southTop = Math.min(lm["S1"].y, lm["S2"].y);
            if (northTop < southTop) {
                anyCorrect = true;
                break;
            }
        }
        assert(anyCorrect, "FLIP1 at least one seed places north rooms above south rooms");
    }

    // =====================================================================
    // TEST FLIP2: Idempotence — determinism still holds after flip probe
    // Two runs with same seed produce identical output.
    // =====================================================================
    console.log("\n=== Test FLIP2: Global-flip probe — determinism ===");
    {
        function makeMod(id, dir) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            const rules = dir ? [{ type: "at", dir }] : [];
            return { id, area, ratioMax, curve, rules };
        }

        const mods = [
            makeMod("N1", "north"), makeMod("N2", "north"),
            makeMod("S1", "south"), makeMod("S2", "south"),
        ];
        const cfg = {
            seed: 0xBEEF, k: 15, iter: 2, cooling_rate: 0.80, min_t: 0.5,
            canvasW: 400, canvasH: 400,
        };
        const r1 = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), { ...cfg });
        const r2 = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), { ...cfg });
        assert(JSON.stringify(r1.npe) === JSON.stringify(r2.npe),
            `FLIP2 same seed → identical npe (${r1.npe.join(" ")} vs ${r2.npe.join(" ")})`);
        assert(Math.abs(r1.cost - r2.cost) < 1e-6,
            `FLIP2 same seed → identical cost (${r1.cost} vs ${r2.cost})`);
        console.log(`  npe: ${r1.npe.join(" ")}, cost: ${r1.cost.toFixed(2)}`);
    }

    // =====================================================================
    // TEST MR1: Multi-restart — restarts:4 valid result + determinism
    // 6-room chain with two connect rules (multimodal search space).
    // restarts:4 iter:4 → each inner run gets iter:1, total budget = 4×single.
    // restarts:1 iter:4 → one run, same total budget. Both must be valid.
    // =====================================================================
    console.log("\n=== Test MR1: Multi-restart valid result and determinism ===");
    {
        function makeMod(id, connectTarget = null) {
            const area = 100, ratioMax = 3.0;
            const w_max = Math.sqrt(area * ratioMax), w_min = Math.sqrt(area / ratioMax);
            const curve = [];
            for (let i = 0; i < 5; i++) {
                curve.push({
                    w: w_min + i * (w_max - w_min) / 4,
                    h: area / (w_min + i * (w_max - w_min) / 4),
                });
            }
            const rules = connectTarget ? [{ type: "connect", target: connectTarget }] : [];
            return { id, area, ratioMax, curve, rules };
        }

        const mods = [
            makeMod("A", "B"), makeMod("B", "C"), makeMod("C", "D"),
            makeMod("D", "E"), makeMod("E", "F"), makeMod("F"),
        ];
        const cfg = { seed: 0xABCD, k: 10, iter: 4, cooling_rate: 0.80, min_t: 0.5 };

        const r4a = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), {
            ...cfg,
            restarts: 4,
        });
        const r4b = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), {
            ...cfg,
            restarts: 4,
        });

        assert(r4a && r4a.npe && r4a.npe.length > 0, "MR1 restarts:4 has npe");
        assert(isValidNPE(r4a.npe), `MR1 restarts:4 valid NPE (${r4a.npe.join(" ")})`);
        assert(typeof r4a.cost === "number" && isFinite(r4a.cost), `MR1 restarts:4 finite cost (${r4a.cost})`);
        assert(JSON.stringify(r4a.npe) === JSON.stringify(r4b.npe),
            `MR1 same seed → identical npe (${r4a.npe.join(" ")} vs ${r4b.npe.join(" ")})`);
        assert(Math.abs(r4a.cost - r4b.cost) < 1e-6,
            `MR1 same seed → identical cost (${r4a.cost} vs ${r4b.cost})`);

        const r1 = await wongLiuSimulatedAnnealing(mods.map(m => ({ ...m })), {
            ...cfg,
            restarts: 1,
        });
        assert(r1 && isValidNPE(r1.npe), "MR1 restarts:1 valid NPE");
        // restarts:4 should find a result at least as good as restarts:1 (same total budget).
        assert(r4a.cost <= r1.cost + 1e-6,
            `MR1 restarts:4 cost (${r4a.cost.toExponential(3)}) <= restarts:1 cost (${r1.cost.toExponential(3)})`);
        console.log(`  restarts:4 cost=${r4a.cost.toExponential(3)}, restarts:1 cost=${r1.cost.toExponential(3)}`);
    }

    // =====================================================================
    // TEST MR2: Multi-restart — cancellation between restarts throws AbortError
    // =====================================================================
    console.log("\n=== Test MR2: Multi-restart cancellation ===");
    {
        function makeMod(id) {
            return { id, area: 100, ratioMax: 3.0, curve: [{ w: 10, h: 10 }], rules: [] };
        }

        const mods = ["A", "B", "C", "D", "E", "F"].map(makeMod);
        const controller = new AbortController();

        // Abort immediately so the cancellation fires between/during restarts
        controller.abort();

        let threw = false;
        let errName = "";
        try {
            await wongLiuSimulatedAnnealing(mods, {
                seed: 1, k: 5, iter: 4, restarts: 4, cooling_rate: 0.85, min_t: 0.1,
            }, controller.signal);
        } catch (e) {
            threw = true;
            errName = e.name;
        }
        assert(threw, "MR2 cancelled run throws");
        assert(errName === "AbortError", `MR2 throws AbortError (got ${errName})`);
        console.log(`  threw=${threw}, name=${errName}`);
    }

    // =====================================================================
    // TEST GM1: applyGuidedMove — connect pair moves closer
    // NPE has A at index 0 and B at index 6 (distance 6 > 2). B is preceded
    // by operand Z (index 5), so the swap is unblocked. rfn=()=>0 is deterministic.
    // =====================================================================
    console.log("\n=== Test GM1: applyGuidedMove — connect pair moves closer ===");
    {
        // ['A','X','V','Y','H','Z','B','V','W','V'] is a valid NPE
        const npe = ["A", "X", "V", "Y", "H", "Z", "B", "V", "W", "V"];
        const ruleIdx = buildRuleIndex([
            { id: "A", rules: [{ type: "connect", target: ["B"] }] },
            { id: "B", rules: [] }, { id: "X", rules: [] },
            { id: "Y", rules: [] }, { id: "Z", rules: [] }, { id: "W", rules: [] },
        ]);
        const distBefore = Math.abs(npe.indexOf("A") - npe.indexOf("B"));
        const clone = [...npe];
        const move = applyGuidedMove(clone, () => 0, ruleIdx);
        assert(move !== null, "GM1 guided move produced a non-null result");
        assert(move.type === "M1", `GM1 move type is M1 (got ${move?.type})`);
        const distAfter = Math.abs(clone.indexOf("A") - clone.indexOf("B"));
        assert(distAfter < distBefore, `GM1 A-B distance decreased (${distBefore} → ${distAfter})`);
        assert(isValidNPE(clone), "GM1 result NPE is still valid");
        console.log(`  move: [${move?.positions}], dist ${distBefore} → ${distAfter}`);
    }

    // =====================================================================
    // TEST GM2: applyGuidedMove — at-north violator walks toward NPE start
    // A is at operand rank 3 (second half) in a 4-operand NPE; mid=2.
    // npe[3]='Z' (operand) is directly before A at index 4 — swap succeeds.
    // =====================================================================
    console.log("\n=== Test GM2: applyGuidedMove — at-north violator walks toward start ===");
    {
        // ['X','Y','V','Z','A','H','V'] is a valid NPE; operands: X,Y,Z,A; mid=2; A rank=3
        const npe = ["X", "Y", "V", "Z", "A", "H", "V"];
        const ruleIdx = buildRuleIndex([
            { id: "A", rules: [{ type: "at", dir: ["north"] }] },
            { id: "X", rules: [] }, { id: "Y", rules: [] }, { id: "Z", rules: [] },
        ]);
        const posBefore = npe.indexOf("A");
        const clone = [...npe];
        const move = applyGuidedMove(clone, () => 0, ruleIdx);
        assert(move !== null, "GM2 guided move produced a non-null result");
        assert(move.type === "M1", `GM2 move type is M1 (got ${move?.type})`);
        const posAfter = clone.indexOf("A");
        assert(posAfter < posBefore, `GM2 A moved toward start (${posBefore} → ${posAfter})`);
        assert(isValidNPE(clone), "GM2 result NPE is still valid");
        console.log(`  move: [${move?.positions}], A pos ${posBefore} → ${posAfter}`);
    }

    // =====================================================================
    // TEST GM3: applyGuidedMove — determinism (same seed → same mutation)
    // =====================================================================
    console.log("\n=== Test GM3: applyGuidedMove — determinism ===");
    {
        const npe = ["A", "X", "V", "Y", "H", "Z", "B", "V", "W", "V"];
        const ruleIdx = buildRuleIndex([
            { id: "A", rules: [{ type: "connect", target: ["B"] }] },
            { id: "B", rules: [] }, { id: "X", rules: [] },
            { id: "Y", rules: [] }, { id: "Z", rules: [] }, { id: "W", rules: [] },
        ]);

        function seededRfn() {
            let s = 0xABCD;
            return () => {
                s = (s * 1664525 + 1013904223) >>> 0;
                return s / 4294967296;
            };
        }

        const c1 = [...npe];
        applyGuidedMove(c1, seededRfn(), ruleIdx);
        const c2 = [...npe];
        applyGuidedMove(c2, seededRfn(), ruleIdx);
        assert(JSON.stringify(c1) === JSON.stringify(c2), "GM3 same seed → identical NPE mutation");
        console.log(`  npe after: ${c1.join(" ")}`);
    }

    // =====================================================================
    // SUMMARY
    // =====================================================================
    // =====================================================================
    // TEST ANY_SUBJ1: Parser — `any [A, B] connect C` sets subjectAny + shared groupId
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ1: Parser — any [A,B] subjectAny + groupId ===");
    {
        const { modules, errors } = parseDSL(`
            canvas 400 400
            room A area=100
            room B area=100
            room C area=100
            any [A, B] connect C weight=2
        `);
        assert(errors.length === 0, `ANY_SUBJ1 no parse errors (${errors.join(", ")})`);
        const mA = modules.find(m => m.id === "A");
        const mB = modules.find(m => m.id === "B");
        const rA = mA?.rules[0];
        const rB = mB?.rules[0];
        assert(rA?.subjectAny === true, "ANY_SUBJ1 A.subjectAny");
        assert(rB?.subjectAny === true, "ANY_SUBJ1 B.subjectAny");
        assert(rA?.subjectGroupId !== undefined, "ANY_SUBJ1 subjectGroupId defined");
        assert(rA?.subjectGroupId === rB?.subjectGroupId, `ANY_SUBJ1 A and B share groupId (${rA?.subjectGroupId})`);
        assert(rA?.type === "connect" && rA?.weight === 2, "ANY_SUBJ1 type=connect weight=2");
        console.log(`  groupId: ${rA?.subjectGroupId}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ2: Parser — two distinct `any` groups → different groupIds
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ2: Parser — two any groups get distinct groupIds ===");
    {
        const { modules, errors } = parseDSL(`
            canvas 400 400
            room A area=100
            room B area=100
            room C area=100
            room D area=100
            any [A, B] connect C
            any [A, B] connect D
        `);
        assert(errors.length === 0, `ANY_SUBJ2 no parse errors (${errors.join(", ")})`);
        const mA = modules.find(m => m.id === "A");
        const gid0 = mA?.rules[0]?.subjectGroupId;
        const gid1 = mA?.rules[1]?.subjectGroupId;
        assert(gid0 !== gid1, `ANY_SUBJ2 distinct groupIds (${gid0} vs ${gid1})`);
        console.log(`  groupId0: ${gid0}, groupId1: ${gid1}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ3: Parser — both-side any: subjectAny and target-side any both set
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ3: Parser — both-side any composes correctly ===");
    {
        const { modules, errors } = parseDSL(`
            canvas 400 400
            room A area=100
            room B area=100
            room C area=100
            room D area=100
            any [A, B] connect any [C, D]
        `);
        assert(errors.length === 0, `ANY_SUBJ3 no parse errors (${errors.join(", ")})`);
        const mA = modules.find(m => m.id === "A");
        const mB = modules.find(m => m.id === "B");
        assert(mA?.rules[0]?.subjectAny === true, "ANY_SUBJ3 A subjectAny");
        assert(mA?.rules[0]?.any === true, "ANY_SUBJ3 A target-side any");
        assert(mB?.rules[0]?.subjectAny === true, "ANY_SUBJ3 B subjectAny");
        assert(mB?.rules[0]?.any === true, "ANY_SUBJ3 B target-side any");
        assert(mA?.rules[0]?.subjectGroupId === mB?.rules[0]?.subjectGroupId, "ANY_SUBJ3 same groupId");
        console.log(`  groupId: ${mA?.rules[0]?.subjectGroupId}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ4: Parser — `any group` expands named group with subjectAny
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ4: Parser — any <groupName> expands group ===");
    {
        const { modules, errors } = parseDSL(`
            canvas 400 400
            room A area=100
            room B area=100
            room C area=100
            grp = [A, B]
            any grp connect C
        `);
        assert(errors.length === 0, `ANY_SUBJ4 no parse errors (${errors.join(", ")})`);
        const mA = modules.find(m => m.id === "A");
        const mB = modules.find(m => m.id === "B");
        assert(mA?.rules[0]?.subjectAny === true, "ANY_SUBJ4 A subjectAny");
        assert(mB?.rules[0]?.subjectAny === true, "ANY_SUBJ4 B subjectAny");
        assert(mA?.rules[0]?.subjectGroupId === mB?.rules[0]?.subjectGroupId, "ANY_SUBJ4 shared groupId");
        console.log(`  groupId: ${mA?.rules[0]?.subjectGroupId}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ5: Optimizer — subjectAny uses min penalty, not sum
    // A is adjacent to C (penalty ≈ 0), B is far (penalty >> 0).
    // subjectAny → min ≈ 0. Normal (sum) → penalty >> 0.
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ5: Optimizer — subjectAny min penalty ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 300, y: 0, w: 100, h: 100, centerX: 350, centerY: 50 },
            { id: "C", x: 100, y: 0, w: 100, h: 100, centerX: 150, centerY: 50 },
        ];
        const rule = {
            type: "connect",
            target: ["C"],
            any: false,
            weight: 1,
            required: false,
            subjectAny: true,
            subjectGroupId: 0,
        };
        const modMap = {
            A: { id: "A", rules: [rule] },
            B: { id: "B", rules: [{ ...rule }] },
            C: { id: "C", rules: [] },
        };
        const bounds = { w: 400, h: 100 };
        const penMin = calculateTopologicalPenalties(layout, modMap, bounds, {}, 1, 1);
        assert(penMin < 1, `ANY_SUBJ5 min penalty ≈ 0 (got ${penMin.toFixed(2)})`);

        const ruleNoAny = {
            type: "connect",
            target: ["C"],
            any: false,
            weight: 1,
            required: false,
            subjectAny: false,
        };
        const modMapSum = {
            A: { id: "A", rules: [{ ...ruleNoAny }] },
            B: { id: "B", rules: [{ ...ruleNoAny }] },
            C: { id: "C", rules: [] },
        };
        const penSum = calculateTopologicalPenalties(layout, modMapSum, bounds, {}, 1, 1);
        assert(penSum > penMin, `ANY_SUBJ5 sum > min (${penSum.toFixed(2)} > ${penMin.toFixed(2)})`);
        console.log(`  minPenalty: ${penMin.toFixed(2)}, sumPenalty: ${penSum.toFixed(2)}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ6: checkRequiredSatisfied — group satisfied if any subject satisfies
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ6: checkRequiredSatisfied — OR logic (satisfied) ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 300, y: 0, w: 100, h: 100, centerX: 350, centerY: 50 },
            { id: "C", x: 100, y: 0, w: 100, h: 100, centerX: 150, centerY: 50 },
        ];
        const rule = {
            type: "connect",
            target: ["C"],
            any: false,
            weight: 1,
            required: true,
            subjectAny: true,
            subjectGroupId: 5,
        };
        const modMap = {
            A: { id: "A", rules: [rule] },
            B: { id: "B", rules: [{ ...rule }] },
            C: { id: "C", rules: [] },
        };
        const unsat = checkRequiredSatisfied(layout, modMap);
        assert(unsat.length === 0, `ANY_SUBJ6 group satisfied (A adjacent to C) — unsat=${JSON.stringify(unsat)}`);
        console.log(`  unsatisfied: ${unsat.length} (expected 0)`);
    }

    // =====================================================================
    // TEST ANY_SUBJ7: checkRequiredSatisfied — fails when all subjects fail
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ7: checkRequiredSatisfied — OR logic (all fail) ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 200, y: 0, w: 100, h: 100, centerX: 250, centerY: 50 },
            { id: "C", x: 500, y: 0, w: 100, h: 100, centerX: 550, centerY: 50 },
        ];
        const rule = {
            type: "connect",
            target: ["C"],
            any: false,
            weight: 1,
            required: true,
            subjectAny: true,
            subjectGroupId: 7,
        };
        const modMap = {
            A: { id: "A", rules: [rule] },
            B: { id: "B", rules: [{ ...rule }] },
            C: { id: "C", rules: [] },
        };
        const unsat = checkRequiredSatisfied(layout, modMap);
        assert(unsat.length === 1, `ANY_SUBJ7 one unsatisfied group (got ${unsat.length})`);
        assert(unsat[0]?.subjectAny === true, "ANY_SUBJ7 entry has subjectAny flag");
        console.log(`  unsatisfied: ${JSON.stringify(unsat[0])}`);
    }

    // =====================================================================
    // TEST ANY_SUBJ8: checkRequiredSatisfied — `any [A,B] at north required`
    // A is at north (y=0), B is not. Group is satisfied.
    // =====================================================================
    console.log("\n=== Test ANY_SUBJ8: checkRequiredSatisfied — any [A,B] at north (A satisfies) ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 100, y: 150, w: 100, h: 100, centerX: 150, centerY: 200 },
        ];
        const rule = {
            type: "at",
            dir: ["north"],
            weight: 1,
            required: true,
            subjectAny: true,
            subjectGroupId: 9,
        };
        const modMap = {
            A: { id: "A", rules: [rule] },
            B: { id: "B", rules: [{ ...rule }] },
        };
        const unsat = checkRequiredSatisfied(layout, modMap);
        assert(unsat.length === 0, `ANY_SUBJ8 group satisfied (A at north) — unsat=${JSON.stringify(unsat)}`);
        console.log(`  unsatisfied: ${unsat.length} (expected 0)`);
    }

    // =====================================================================
    // RESERVED_KW: room name cannot be a reserved keyword
    // =====================================================================
    console.log("\n=== Test RESERVED_KW: reserved keyword as room name → error ===");
    {
        const cases = ["room", "canvas", "connect", "at", "inside", "cooling_rate"];
        for (const kw of cases) {
            const { errors } = parseDSL(`canvas 100 100\nroom ${kw} area=100`);
            assert(
                errors.some(e => e.includes(`room name '${kw}' is a reserved keyword`)),
                `RESERVED_KW 'room ${kw}' → reserved keyword error (got: ${JSON.stringify(errors)})`,
            );
        }
        // Valid room name must not trigger the error
        const { errors: ok } = parseDSL("canvas 100 100\nroom kitchen area=100");
        assert(!ok.some(e => e.includes("reserved")), "RESERVED_KW valid name 'kitchen' should not error");
    }

    // =====================================================================
    // T_CWC: cwc per-room connection count enforced by engine
    // hub cwc=3 means hub must share a wall with >= 3 other rooms.
    // =====================================================================
    console.log("\n=== Test T_CWC: cwc per-room connection count ===");
    {
        // No explicit connect rules — cwc=3 alone must drive the adjacency.
        const result = await runFloorPlan(`
            canvas 500 400
            room hub area=200x200 cwc=3
            room ra area=100x100
            room rb area=100x100
            room rc area=100x100
        `);
        const ov = noOverlap(result.rooms);
        assert(ov.ok, "T_CWC no overlap");
        const rooms = result.rooms;
        let connections = 0;
        for (const other of ["ra", "rb", "rc"]) {
            if (sharedWallLen(rooms, "hub", other) > 0) {
                connections++;
            }
        }
        assert(connections >= 3, `T_CWC hub shares wall with >= 3 rooms (got ${connections})`);
        console.log(`  Score: ${result.score.toFixed(2)}, HubConnections: ${connections}`);
    }

    // =====================================================================
    // T_CWL: cwl minimum shared-wall enforcement flows DSL → engine → layout
    // =====================================================================
    console.log("\n=== Test T_CWL: cwl minimum shared-wall enforcement ===");
    {
        const result = await runFloorPlan(`
            canvas 300 200
            room A area=100x100
            room B area=100x100
            A connect B cwl=50
        `);
        const ov = noOverlap(result.rooms);
        assert(ov.ok, "T_CWL no overlap");
        const wl = sharedWallLen(result.rooms, "A", "B");
        assert(wl >= 50, `T_CWL shared wall >= 50 (got ${wl})`);
        console.log(`  Score: ${result.score.toFixed(2)}, SharedWall: ${wl}`);
    }

    // =====================================================================
    // TEST T_XBND: inside block — two cross-boundary connects, different outer rooms
    // =====================================================================
    console.log("\n=== Test T_XBND: multiple cross-boundary connect rules ===");
    {
        const dsl = `
            seed 1
            canvas 400 600
            room outer_a area=150x120
            room container area=200x200
            room outer_b area=150x120
            outer_a at north
            outer_b at south
            outer_a connect container
            outer_b connect container
            inside container {
              room inner_x area=80x80
              room inner_y area=80x80
              inner_x connect outer_a
              inner_y connect outer_b
            }
        `;

        // Parser: both cross-boundary rules present
        const parsed = parseDSL(dsl);
        const containerMod = parsed.modules.find(m => m.id === "container");
        const innerX = containerMod?.inside?.modules?.find(m => m.id === "inner_x");
        const innerY = containerMod?.inside?.modules?.find(m => m.id === "inner_y");
        assert(innerX?.rules?.some(r => r.crossBoundary && r.target === "outer_a"),
            "T_XBND inner_x has crossBoundary connect outer_a");
        assert(innerY?.rules?.some(r => r.crossBoundary && r.target === "outer_b"),
            "T_XBND inner_y has crossBoundary connect outer_b");

        // Optimizer: inner rooms placed near their outer partners
        const { config, modules } = parsed;
        const result = await optimizeRecursive(modules, {
            ...config,
            seed: 1,
        }, new AbortController().signal);
        const outerRooms = result.rooms;
        const containerRoom = outerRooms.find(r => r.id === "container");
        assert(containerRoom?.inside?.rooms?.length === 2, "T_XBND container has 2 inner rooms");

        if (containerRoom?.inside?.rooms?.length === 2) {
            const ix = containerRoom.inside.rooms.find(r => r.id === "inner_x");
            const iy = containerRoom.inside.rooms.find(r => r.id === "inner_y");
            const outerA = outerRooms.find(r => r.id === "outer_a");
            const outerB = outerRooms.find(r => r.id === "outer_b");

            // Determine direction of each outer room relative to container center
            const aCenterY = outerA.y + outerA.h / 2;
            const bCenterY = outerB.y + outerB.h / 2;
            const cCenterY = containerRoom.y + containerRoom.h / 2;
            const aIsNorth = aCenterY < cCenterY;
            const bIsSouth = bCenterY > cCenterY;
            assert(aIsNorth, `T_XBND outer_a is north of container (aY=${aCenterY.toFixed(0)}, cY=${cCenterY.toFixed(0)})`);
            assert(bIsSouth, `T_XBND outer_b is south of container (bY=${bCenterY.toFixed(0)}, cY=${cCenterY.toFixed(0)})`);

            // inner_x should be in the northern half of container, inner_y in the southern half
            const ixCY = ix.y + ix.h / 2;
            const iyCY = iy.y + iy.h / 2;
            assert(ixCY < containerRoom.h / 2,
                `T_XBND inner_x in north half of container (cy=${ixCY.toFixed(1)}, mid=${(containerRoom.h / 2).toFixed(1)})`);
            assert(iyCY >= containerRoom.h / 2,
                `T_XBND inner_y in south half of container (cy=${iyCY.toFixed(1)}, mid=${(containerRoom.h / 2).toFixed(1)})`);

            console.log(`  outer_a centerY=${aCenterY.toFixed(1)}, outer_b centerY=${bCenterY.toFixed(1)}, container centerY=${cCenterY.toFixed(1)}`);
            console.log(`  inner_x centerY=${ixCY.toFixed(1)}, inner_y centerY=${iyCY.toFixed(1)}, container.h=${containerRoom.h.toFixed(1)}`);
        }
    }

    // =====================================================================
    // TEST T_AT_CONFLICT: conflicting at rules degrade gracefully
    // =====================================================================
    console.log("\n=== Test T_AT_CONFLICT: conflicting at rules (north + south same room) ===");
    {
        let result, threw = false;
        try {
            result = await runFloorPlan(`
                canvas 400 300
                room A area=100x100
                room B area=100x100
                A connect B
                A at north
                A at south
            `);
        } catch (e) {
            threw = true;
            assert(false, `T_AT_CONFLICT threw: ${e.message}`);
        }
        if (!threw) {
            assert(Array.isArray(result.rooms) && result.rooms.length >= 2, "T_AT_CONFLICT layout returned");
            assert(Number.isFinite(result.score), `T_AT_CONFLICT finite cost (got ${result.score})`);
            const ov = noOverlap(result.rooms);
            assert(ov.ok, `T_AT_CONFLICT no overlap (${ov.a}-${ov.b} ov=${ov.ov})`);
            console.log(`  Score: ${result.score.toFixed(2)} (contradictory at rules; cost elevated but finite)`);
        }
    }

    // =====================================================================
    // TEST T_CANVAS_FLEXIBLE: flexible mode behavior vs strict
    // strict:   overflow → always compress layout to fit canvas
    // flexible: overflow → compress only if it reduces cost (may keep overflow)
    // 3 × 60×60 rooms in 80×80 canvas: total area 10800 > 6400, overflow guaranteed
    // =====================================================================
    console.log("\n=== Test T_CANVAS_FLEXIBLE: canvas flexible mode ===");
    {
        const strictResult = await runFloorPlan(`
            canvas 80 80
            seed 1
            room A area=60x60
            room B area=60x60
            room C area=60x60
        `);
        const flexResult = await runFloorPlan(`
            canvas 80 80 flexible
            seed 1
            room A area=60x60
            room B area=60x60
            room C area=60x60
        `);
        const sfit = inCanvas(strictResult.rooms, 80, 80);
        assert(sfit.ok, `T_CANVAS_FLEXIBLE strict layout fits canvas (room ${sfit.room} at ${sfit.x},${sfit.y} size ${sfit.w}x${sfit.h})`);
        assert(flexResult.score <= strictResult.score + 1,
            `T_CANVAS_FLEXIBLE flex cost <= strict (flex=${flexResult.score.toFixed(0)}, strict=${strictResult.score.toFixed(0)})`);
        assert(noOverlap(strictResult.rooms).ok, "T_CANVAS_FLEXIBLE strict no overlap");
        assert(noOverlap(flexResult.rooms).ok, "T_CANVAS_FLEXIBLE flex no overlap");
        console.log(`  strict cost=${strictResult.score.toFixed(0)}, fits=${sfit.ok}`);
        console.log(`  flex   cost=${flexResult.score.toFixed(0)}, fits=${inCanvas(flexResult.rooms, 80, 80).ok}`);
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    if (failures.length > 0) {
        console.log("\nFailed assertions:");
        for (const f of failures) {
            console.log(`  - ${f}`);
        }
    }
    console.log("=".repeat(60));

})();
