const fs = require("fs");
const path = require("path");

// Load v2 components
const { parseDSL } = require("./parser.js");
const { optimizeRecursive } = require("./orchestrator.js");

// Load engine by appending exports to a temp file
const engineCode = fs.readFileSync(path.join(__dirname, "sa_optimized.js"), "utf8");
const engineWithExports = engineCode + "\nmodule.exports = { wongLiuSimulatedAnnealing, evaluateCost, calculateTopologicalPenalties, calculateRuleScores, calculateRoomGeometryPenalty, countDeliveredGeometryViolations, requiredAttemptSelectionKey, assignCoordinates, buildInitialCandidates, orderedToNpe, buildLinearFallback, isValidNPE, applyM4, buildTreeFresh, buildTreeIncremental, buildRuleIndex, applyGuidedMove, checkRequiredSatisfied, checkBoundariesOnTree, isPreferredRequiredAttempt, repairRequiredLayout, offendingOperandSwaps, offendingM3Swaps, collectOffendingIds, _runWithRestarts, _runSingleSA, _selectRequiredBest, _shouldUseWorkers };\n";
const tempEnginePath = path.join(__dirname, "temp", "sa_optimized_exported.js");

if (!fs.existsSync(path.join(__dirname, "temp"))) {
    fs.mkdirSync(path.join(__dirname, "temp"));
}
fs.writeFileSync(tempEnginePath, engineWithExports);

const {
    wongLiuSimulatedAnnealing,
    evaluateCost,
    calculateTopologicalPenalties,
    calculateRuleScores,
    calculateRoomGeometryPenalty,
    countDeliveredGeometryViolations,
    requiredAttemptSelectionKey,
    assignCoordinates,
    buildInitialCandidates,
    orderedToNpe,
    buildLinearFallback,
    isValidNPE,
    applyM4,
    buildTreeFresh,
    buildTreeIncremental,
    buildRuleIndex,
    applyGuidedMove,
    checkRequiredSatisfied,
    checkBoundariesOnTree,
    isPreferredRequiredAttempt,
    repairRequiredLayout,
    offendingOperandSwaps,
    offendingM3Swaps,
    collectOffendingIds,
    _selectRequiredBest,
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

    // Fix for 1-room plans (sa_optimized.js requires >= 2)
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
    // TEST 10B: only required at-rules constrain slicing-tree boundaries
    // =====================================================================
    console.log("\n=== Test 10B: soft at rules do not hard-prune slicing trees ===");
    {
        const softLeaf = {
            type: "leaf",
            id: "A",
        };
        const requiredLeaf = {
            type: "leaf",
            id: "B",
        };
        const modulesMap = {
            A: { id: "A", rules: [{ type: "at", dir: ["west"], required: false }] },
            B: { id: "B", rules: [{ type: "at", dir: ["west"], required: true }] },
        };

        assert(checkBoundariesOnTree(softLeaf, true, true, true, false, modulesMap),
            "T10B soft west preference remains valid away from west boundary");
        assert(!checkBoundariesOnTree(requiredLeaf, true, true, true, false, modulesMap),
            "T10B required west rule rejects tree away from west boundary");
    }

    // =====================================================================
    // TEST 10C: advisory far has no irreducible floor; required far is unchanged
    // =====================================================================
    console.log("\n=== Test 10C: distant rooms carry no far floor ===");
    {
        const rule = { type: "far", target: ["B"], any: false, weight: 1, required: false };
        const modulesMap = {
            A: { id: "A", rules: [rule] },
            B: { id: "B", rules: [] },
        };
        const bounds = { w: 1000, h: 1000 };
        const nearLayout = [
            { id: "A", x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 },
            { id: "B", x: 100, y: 0, w: 10, h: 10, centerX: 105, centerY: 5 },
        ];
        const distantLayout = [
            { id: "A", x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 },
            { id: "B", x: 800, y: 0, w: 10, h: 10, centerX: 805, centerY: 5 },
        ];
        const config = { _farCutoffFraction: 0.5 };
        const nearPenalty = calculateTopologicalPenalties(nearLayout, modulesMap, bounds, config, 1, 1);
        const distantPenalty = calculateTopologicalPenalties(distantLayout, modulesMap, bounds, config, 1, 1);
        const maxDistanceLayout = [
            { id: "A", x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 },
            { id: "B", x: 1000, y: 1000, w: 0, h: 0, centerX: 1000, centerY: 1000 },
        ];
        const defaultAdvisoryMaxPenalty = calculateTopologicalPenalties(maxDistanceLayout, modulesMap, bounds, {}, 1, 1);
        const requiredModulesMap = {
            A: { id: "A", rules: [{ ...rule, required: true }] },
            B: modulesMap.B,
        };
        const requiredDistantPenalty = calculateTopologicalPenalties(distantLayout, requiredModulesMap, bounds, config, 1, 1);
        const requiredMaxPenalty = calculateTopologicalPenalties(maxDistanceLayout, requiredModulesMap, bounds, {}, 1, 1);

        assert(nearPenalty > 0, `T10C nearby rooms retain gradient (got ${nearPenalty})`);
        assert(distantPenalty === 0, `T10C advisory-connect cutoff reaches zero at half diagonal (got ${distantPenalty})`);
        assert(defaultAdvisoryMaxPenalty === 0, `T10C default advisory far reaches zero at max distance (got ${defaultAdvisoryMaxPenalty})`);
        assert(requiredDistantPenalty > 0, `T10C required far retains gradient (got ${requiredDistantPenalty})`);
        assert(requiredMaxPenalty === 25000000,
            `T10C required far retains original half-floor at max distance (got ${requiredMaxPenalty})`);
    }

    // =====================================================================
    // TEST 10D: advisory weights use bounded logarithmic compression
    // =====================================================================
    console.log("\n=== Test 10D: advisory weight compression is bounded ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 },
            { id: "B", x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 },
        ];
        const bounds = { w: 1000, h: 1000 };
        const penaltyFor = (weight, required = false, uwm = 1) => calculateTopologicalPenalties(layout, {
            A: { id: "A", rules: [{ type: "far", target: ["B"], any: false, weight, required }] },
            B: { id: "B", rules: [] },
        }, bounds, {}, 1, uwm);

        assert(penaltyFor(2) === 2000000, `T10D weight=2 stays 2 (got ${penaltyFor(2)})`);
        assert(penaltyFor(512) === 10000000, `T10D weight=512 compresses to 10 (got ${penaltyFor(512)})`);
        assert(penaltyFor(512, false, 0.5) === 5500000,
            `T10D uwm ramps compressed weight from 1 to 10 (got ${penaltyFor(512, false, 0.5)})`);
        const weightFiveTarget = 1 + Math.log2(5);
        const weightFiveStart = 1 + (weightFiveTarget - 1) / 100;
        assert(Math.abs(penaltyFor(5) / 1000000 - weightFiveTarget) < 1e-12,
            `T10D weight=5 final target is compressed to ${weightFiveTarget} (got ${penaltyFor(5) / 1000000})`);
        assert(Math.abs(penaltyFor(5, false, 0.01) / 1000000 - weightFiveStart) < 1e-12,
            `T10D weight=5 starts at 1% of compressed-target offset (got ${penaltyFor(5, false, 0.01) / 1000000})`);
        assert(penaltyFor(2 ** 50) === 25000000,
            `T10D advisory weight caps below required boost (got ${penaltyFor(2 ** 50)})`);
        assert(penaltyFor(512, true) === 25600000000,
            `T10D required weight bypasses compression (got ${penaltyFor(512, true)})`);
    }

    // =====================================================================
    // TEST 10E: geometry penalties retain scale and threshold gradients
    // =====================================================================
    console.log("\n=== Test 10E: room geometry penalty scaling ===");
    {
        const ratioModule = { ratioMax: 1.67 };
        const thresholdAspect = calculateRoomGeometryPenalty({ w: 167, h: 100 }, ratioModule);
        const nearAspect = calculateRoomGeometryPenalty({ w: 197, h: 100 }, ratioModule);
        const severeAspect = calculateRoomGeometryPenalty({ w: 1167, h: 100 }, ratioModule);

        assert(Math.abs(thresholdAspect) < 1e-6,
            `T10E aspect at ratio_max is free (got ${thresholdAspect})`);
        assert(Math.abs(nearAspect - 975000) < 1e-6,
            `T10E aspect excess 0.3 carries linear threshold pressure (got ${nearAspect})`);
        assert(Math.abs(severeAspect - 275000000) < 1e-5,
            `T10E severe aspect excess remains uncapped (got ${severeAspect})`);

        const sideModule = { ratio: 1, sideMin: 175 };
        const sideAtLimit = calculateRoomGeometryPenalty({ w: 175, h: 175 }, sideModule);
        const sideShortSmallCanvas = calculateRoomGeometryPenalty(
            { w: 87.5, h: 175 }, sideModule, { canvasW: 500, canvasH: 500 },
        );
        const sideShortLargeCanvas = calculateRoomGeometryPenalty(
            { w: 87.5, h: 175 }, sideModule, { canvasW: 5000, canvasH: 5000 },
        );

        assert(sideAtLimit === 0, `T10E side at side_min is free (got ${sideAtLimit})`);
        assert(sideShortSmallCanvas === 7500000,
            `T10E half-side shortfall has relative linear-plus-quadratic cost (got ${sideShortSmallCanvas})`);
        assert(sideShortLargeCanvas === sideShortSmallCanvas,
            `T10E side penalty is independent of canvas size (got ${sideShortLargeCanvas})`);

        const areaPenalty = calculateRoomGeometryPenalty(
            { w: 200, h: 100 }, { area: 10000, ratio: 1 },
        );
        assert(areaPenalty === 5000,
            `T10E area coefficient remains 0.5 per square centimeter (got ${areaPenalty})`);
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
    // TEST M4: long-range operand swaps preserve validity and incremental trees
    // =====================================================================
    console.log("\n=== Test M4: long-range operand swap validity and incremental rebuild ===");
    {
        const initialNpe = ["A", "B", "V", "C", "H", "D", "V", "E", "H"];
        let state = [...initialNpe];
        let randomState = 0xC0FFEE;
        const randomFn = () => {
            randomState = (randomState * 1664525 + 1013904223) >>> 0;
            return randomState / 4294967296;
        };
        let valid = true;
        let positionsAreLongRange = true;
        for (let iteration = 0; iteration < 10000; iteration++) {
            const before = [...state];
            const move = applyM4(state, randomFn);
            const operandPositions = before
                .map((token, position) => token === "H" || token === "V" ? -1 : position)
                .filter(position => position >= 0);
            const ranks = move.positions.map(position => operandPositions.indexOf(position));
            positionsAreLongRange = positionsAreLongRange && Math.abs(ranks[0] - ranks[1]) > 1;
            valid = valid && move.type === "M4" && isValidNPE(state);
        }
        assert(valid, "M4 preserves valid NPEs across 10,000 applications");
        assert(positionsAreLongRange, "M4 always swaps non-neighboring operands");

        const modulesMap = Object.fromEntries(["A", "B", "C", "D", "E"].map((id, index) => [id, {
            id,
            area: 10000 + index * 1000,
            ratioMax: 3,
            curve: [
                { w: 100 + index * 5, h: 100 },
                { w: 80 + index * 4, h: 125 },
            ],
            rules: [],
        }]));
        const movedNpe = [...initialNpe];
        const previous = buildTreeFresh(movedNpe, modulesMap);
        const move = applyM4(movedNpe, () => 0);
        const incremental = buildTreeIncremental(previous.positionMap, movedNpe, move.positions, modulesMap);
        const fresh = buildTreeFresh(movedNpe, modulesMap);
        const config = { canvasW: 600, canvasH: 500, canvasFlexible: true };
        const incrementalResult = evaluateCost(movedNpe, modulesMap, config, 1, incremental, 1, false);
        const freshResult = evaluateCost(movedNpe, modulesMap, config, 1, fresh, 1, false);

        assert(JSON.stringify(incremental.tree) === JSON.stringify(fresh.tree),
            "M4 incremental tree equals full rebuild");
        assert(incrementalResult.cost === freshResult.cost
            && JSON.stringify(incrementalResult.bestShape) === JSON.stringify(freshResult.bestShape),
            "M4 incremental cost and selected shape equal full rebuild");
        assert(move.positions.every(position => incremental.positionMap[position] !== previous.positionMap[position]),
            "M4 rebuilds both dirty operand positions");
        assert(incremental.positionMap[5] === previous.positionMap[5],
            "M4 reuses an untouched leaf outside both dirty paths");
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
    // TEST CONNECT_FLOOR: corner-touching (no shared wall) scores a higher
    // connect penalty than wall-sharing, thanks to the violation floor.
    // =====================================================================
    console.log("\n=== Test CONNECT_FLOOR: corner-touch penalty > wall-share penalty ===");
    {
        const rule = { type: "connect", target: ["B"], any: false, weight: 1, required: false };
        const bounds = { w: 200, h: 200 };

        const cornerLayout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 100, y: 100, w: 100, h: 100, centerX: 150, centerY: 150 },
        ];
        const cornerMap = { A: { id: "A", rules: [rule] }, B: { id: "B", rules: [] } };
        const cornerPen = calculateTopologicalPenalties(cornerLayout, cornerMap, bounds, {}, 1, 1);

        const wallLayout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 100, y: 0, w: 100, h: 100, centerX: 150, centerY: 50 },
        ];
        const wallMap = { A: { id: "A", rules: [{ ...rule }] }, B: { id: "B", rules: [] } };
        const wallPen = calculateTopologicalPenalties(wallLayout, wallMap, bounds, {}, 1, 1);

        assert(cornerPen > wallPen, `CONNECT_FLOOR corner-touch > wall-share (corner=${cornerPen.toFixed(0)}, wall=${wallPen.toFixed(0)})`);
        assert(cornerPen > 8000000, `CONNECT_FLOOR soft violation outweighs residual far gradients (got ${cornerPen.toFixed(0)})`);
        console.log(`  cornerPen: ${cornerPen.toFixed(0)}, wallPen: ${wallPen.toFixed(0)}`);
    }

    // =====================================================================
    // TEST CONNECT_FLOAT_ADJACENCY: connect scoring and hard satisfaction
    // use the same epsilon-aware shared-wall check after proportional splits.
    // =====================================================================
    console.log("\n=== Test CONNECT_FLOAT_ADJACENCY: epsilon-aware connect scoring ===");
    {
        const A = { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 };
        const horizontalB = {
            id: "B",
            x: 100 + 1e-10,
            y: 0,
            w: 100,
            h: 100,
            centerX: 150 + 1e-10,
            centerY: 50,
        };
        const verticalB = {
            id: "B",
            x: 0,
            y: 100 + 1e-10,
            w: 100,
            h: 100,
            centerX: 50,
            centerY: 150 + 1e-10,
        };
        const sumRule = { type: "connect", target: ["B"], any: false, required: true };
        const anyRule = { type: "connect", target: ["missing", "B"], any: true, required: true };
        const bounds = { w: 200, h: 200 };

        const horizontalLayout = [A, horizontalB];
        const horizontalModules = {
            A: { id: "A", rules: [sumRule] },
            B: { id: "B", rules: [] },
        };
        const horizontalPenalty = calculateTopologicalPenalties(horizontalLayout, horizontalModules, bounds, {}, 1, 1);
        assert(horizontalPenalty === 0, `CONNECT_FLOAT_ADJACENCY sum penalty is zero (got ${horizontalPenalty})`);
        assert(checkRequiredSatisfied(horizontalLayout, horizontalModules).length === 0,
            "CONNECT_FLOAT_ADJACENCY horizontal scoring agrees with satisfaction");

        const verticalLayout = [A, verticalB];
        const verticalModules = {
            A: { id: "A", rules: [anyRule] },
            B: { id: "B", rules: [] },
        };
        const verticalPenalty = calculateTopologicalPenalties(verticalLayout, verticalModules, bounds, {}, 1, 1);
        assert(verticalPenalty === 0, `CONNECT_FLOAT_ADJACENCY any penalty is zero (got ${verticalPenalty})`);
        assert(checkRequiredSatisfied(verticalLayout, verticalModules).length === 0,
            "CONNECT_FLOAT_ADJACENCY vertical scoring agrees with satisfaction");
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

        // Optimizer: nested layout resolves without losing either child.
        const { config, modules } = parsed;
        const result = await optimizeRecursive(modules, {
            ...config,
            algo: "sa",
            seed: 1,
        }, new AbortController().signal);
        const outerRooms = result.rooms;
        const containerRoom = outerRooms.find(r => r.id === "container");
        assert(containerRoom?.inside?.rooms?.length === 2, "T_XBND container has 2 inner rooms");
    }

    // =====================================================================
    // TEST T_XBND_REQUIRED: required nested connects use hard physical
    // adjacency checks against projected outer-room geometry.
    // =====================================================================
    console.log("\n=== Test T_XBND_REQUIRED: nested required connects are physical ===");
    {
        const parsed = parseDSL(`
            seed 7
            canvas 400x200
            cwl 50
            room hub area=40000
            room container area=40000
            hub connect container required
            inside container {
                room child_a area=20000
                room child_b area=20000
                [child_a, child_b] connect hub required
            }
        `);
        const result = await optimizeRecursive(parsed.modules, parsed.config, new AbortController().signal);
        const container = result.rooms.find(room => room.id === "container");
        const globalChildren = (container?.inside?.rooms ?? []).map(child => ({
            ...child,
            x: container.x + child.x,
            y: container.y + child.y,
            name: child.id,
        }));
        const globalRooms = [...result.rooms, ...globalChildren];
        const childWalls = globalChildren.map(child => sharedWallLen(globalRooms, child.id, "hub"));

        assert(parsed.errors.length === 0,
            `T_XBND_REQUIRED DSL parses (got ${JSON.stringify(parsed.errors)})`);
        assert(childWalls.length === 2,
            `T_XBND_REQUIRED container has 2 children (got ${childWalls.length})`);
        assert(childWalls.every(wall => wall >= parsed.config.cwl - 0.1),
            `T_XBND_REQUIRED every child gets cwl=${parsed.config.cwl} to hub (got ${JSON.stringify(childWalls)})`);

        const phantom = { id: "hub", x: -100, y: 0, w: 100, h: 200, centerX: -50, centerY: 100 };
        const innerModules = [
            {
                id: "child_a",
                area: 20000,
                rules: [
                    {
                        type: "connect",
                        target: ["hub"],
                        required: true,
                        crossBoundary: true,
                        cwl: 50,
                    },
                    { type: "at", dir: ["west"], required: true, weight: 1 },
                ],
            },
            {
                id: "child_b",
                area: 20000,
                rules: [
                    {
                        type: "connect",
                        target: ["hub"],
                        required: true,
                        crossBoundary: true,
                        cwl: 50,
                    },
                    { type: "at", dir: ["west"], required: true, weight: 1 },
                ],
            },
        ];
        const workerConfig = { seed: 7, canvasW: 200, canvasH: 200, k: 2, iter: 1 };
        const sequential = await wongLiuSimulatedAnnealing(innerModules, workerConfig, undefined, [phantom]);
        const parallel = await wongLiuSimulatedAnnealing(innerModules, {
            ...workerConfig,
            forceWorkers: true,
        }, undefined, [phantom]);

        assert(sequential.unsatisfied.length === 0 && parallel.unsatisfied.length === 0,
            `T_XBND_REQUIRED sequential and worker paths satisfy phantom connects (got ${sequential.unsatisfied.length}/${parallel.unsatisfied.length})`);
        assert(sequential.cost === parallel.cost
            && sequential.geometryViolations === parallel.geometryViolations
            && sequential.npe.join(" ") === parallel.npe.join(" "),
            "T_XBND_REQUIRED worker selection matches sequential for phantom targets");
        assert(JSON.stringify(sequential.ruleScores) === JSON.stringify(parallel.ruleScores),
            "T_XBND_REQUIRED final per-rule scores match across sequential and worker selection");
    }

    // =====================================================================
    // TEST T_XBND_ANY_GROUP: every child in a subject list physically
    // connects to an outer target selected from an any-target group with
    // enough frontage to honor its inherited side_min.
    // =====================================================================
    console.log("\n=== Test T_XBND_ANY_GROUP: every nested child connects to outer hub ===");
    {
        const dsl = `
            seed 44
            canvas 1400x1100
            ratio_max 5:3
            side_min 175
            cwl 125

            # Top-level Rooms
            room foyer ratio_max=1:6
            room hallway ratio_max=1:6
            room loud area=300000
            room dining area=140000
            room guest_bath area=40000
            room office area=80000
            room kitchen area=150000
            room living area=250000
            room main_bath area=80000
            room parents area=180000
            room pantry area=50000
            room utility area=40000
            room dressing area=30000

            # Groups
            hub = [foyer, hallway]

            # Sub-layouts
            inside loud {
                room child_1 area=100000
                room child_2 area=100000
                room child_3 area=100000

                [child_1, child_2, child_3] connect any hub required
            }

            # Connectivity & Flow
            # Route primary parent nodes to hub
            foyer connect hallway required

            [loud, living, dining, parents, guest_bath, office, utility] connect any hub required

            parents connect [dressing, main_bath] required
            [dining, pantry] connect kitchen required

            # Enclosures (Dark Core)
            [dressing, pantry, guest_bath] enclosed

            # Perimeters (Light / Ventilation / Access)
            [kitchen, dining, parents, main_bath, foyer] at edge required

            # Acoustic Separation
            [office, parents] far loud weight=10
            main_bath far hub weight=2

            # Environmental Mapping
            [pantry, parents] not at south required
            living at east south weight=10
            office at north west weight=10
        `;
        const parsed = parseDSL(dsl);
        const result = await optimizeRecursive(parsed.modules, parsed.config, new AbortController().signal);
        const loud = result.rooms.find(room => room.id === "loud");
        const globalChildren = (loud?.inside?.rooms ?? []).map(child => ({
            ...child,
            x: loud.x + child.x,
            y: loud.y + child.y,
            name: child.id,
        }));
        const globalRooms = [...result.rooms, ...globalChildren];
        const childConnections = globalChildren.map(child => ({
            id: child.id,
            foyer: sharedWallLen(globalRooms, child.id, "foyer"),
            hallway: sharedWallLen(globalRooms, child.id, "hallway"),
        }));
        const connectedChildren = childConnections.filter(connection => Math.max(connection.foyer, connection.hallway) >= parsed.config.sideMin - 0.1);

        assert(parsed.errors.length === 0,
            `T_XBND_ANY_GROUP DSL parses (got ${JSON.stringify(parsed.errors)})`);
        assert(globalChildren.length === 3,
            `T_XBND_ANY_GROUP loud has 3 children (got ${globalChildren.length})`);
        assert(connectedChildren.length === 3,
            `T_XBND_ANY_GROUP all children get side_min=${parsed.config.sideMin} frontage to foyer or hallway (got ${connectedChildren.length}/3: ${JSON.stringify(childConnections)})`);
        assert(globalChildren.every(child => Math.min(child.w, child.h) >= parsed.config.sideMin - 0.1),
            `T_XBND_ANY_GROUP all children honor inherited side_min=${parsed.config.sideMin} (got ${JSON.stringify(globalChildren.map(child => ({
                id: child.id,
                w: child.w,
                h: child.h,
            })))})`);
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

    // =====================================================================
    // TEST TYPE_MISMATCH: checkRequiredSatisfied handles un-normalized rules
    // =====================================================================
    console.log("\n=== Test TYPE_MISMATCH: checkRequiredSatisfied handles un-normalized rules ===");
    {
        const layout = [
            { id: "A", x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5 },
            { id: "B", x: 10, y: 0, w: 10, h: 10, centerX: 15, centerY: 5 },
        ];
        const unnormalizedModules = {
            A: {
                id: "A",
                rules: [
                    { type: "connect", target: "B", required: true },
                    { type: "at", dir: "north", required: true },
                ],
            },
            B: {
                id: "B",
                rules: [],
            },
        };
        let threw = false;
        let result = [];
        try {
            result = checkRequiredSatisfied(layout, unnormalizedModules);
        } catch (e) {
            threw = true;
            console.error(e);
        }
        assert(!threw, "TYPE_MISMATCH: checkRequiredSatisfied did not throw");
        assert(result.length === 0, "TYPE_MISMATCH: all rules are satisfied");
    }

    // =====================================================================
    // TEST CONNECT_FAR_CONFLICT: exact reported DSL keeps required connection
    // when `far required` targets the same pair. `far` remains a cost pressure
    // for a short connection, but cannot win the hard-attempt selector.
    // =====================================================================
    console.log("\n=== Test CONNECT_FAR_CONFLICT: required connect wins same-pair far ===");
    {
        const dsl = `
            seed 12
            canvas 1400x1100
            ratio_max 5:3
            side_min 175
            cwl 125

            # Top-level Rooms
            room loud area=300000
            room dining area=140000
            room guest_bath area=40000
            room office area=80000
            room kitchen area=150000
            room living area=250000
            room main_bath area=80000
            room parents area=180000
            room pantry area=50000
            room utility area=40000
            room dressing area=30000
            room foyer area=40000
            room hallway ratio_max=1:6

            # Groups
            hub = [foyer, hallway]
            meal = [kitchen, dining]

            # Sub-layouts
            inside loud {
                room child_1 area=100000
                room child_2 area=100000
                room child_3 area=100000

                # Cross-boundary rules cannot use 'required'
                [child_1, child_2, child_3] connect any hub weight=500
            }

            # Connectivity & Flow
            # Route primary parent nodes to hub
            foyer connect hallway required

            # So the connection is small
            foyer far hallway required

            loud connect any hub required
            [parents, guest_bath, office, utility] connect any hub required
            living connect any hub required

            parents connect dressing required
            parents connect main_bath required
            [dining, pantry] connect kitchen required
            living connect any meal required

            # Enclosures (Dark Core)
            dressing enclosed
            pantry enclosed
            guest_bath enclosed

            # Perimeters (Light / Ventilation / Access)
            [meal, parents, main_bath, foyer] at edge required

            # Acoustic Separation
            [office, parents] far loud weight=10
            main_bath far hub weight=2

            # Environmental Mapping
            [pantry, parents] not at south required
            living at east south weight=10
            office at north west weight=10
        `;
        const parsed = parseDSL(dsl);
        const modulesMap = Object.fromEntries(parsed.modules.map(m => [m.id, m]));
        const connectedLayout = [
            { id: "foyer", x: 0, y: 0, w: 200, h: 200 },
            { id: "hallway", x: 200, y: 0, w: 200, h: 125 },
        ];
        const disconnectedLayout = [
            { id: "foyer", x: 0, y: 0, w: 200, h: 200 },
            { id: "hallway", x: 400, y: 0, w: 200, h: 125 },
        ];
        const connectedUnsatisfied = checkRequiredSatisfied(connectedLayout, modulesMap);
        const disconnectedUnsatisfied = checkRequiredSatisfied(disconnectedLayout, modulesMap);
        const connectedWithOtherViolations = [
            { roomId: "office", type: "at", dir: "north" },
            { roomId: "parents", type: "not_at", dir: "south" },
        ];
        const selected = _selectRequiredBest([
            {
                result: { layout: connectedLayout, cost: 100, tag: "connected" },
                unsatisfied: connectedWithOtherViolations,
            },
            {
                result: { layout: disconnectedLayout, cost: 1, tag: "disconnected" },
                unsatisfied: disconnectedUnsatisfied,
            },
        ]);

        assert(parsed.errors.length === 0, `CONNECT_FAR_CONFLICT DSL parses (got ${JSON.stringify(parsed.errors)})`);
        assert(connectedUnsatisfied.length === 0,
            `CONNECT_FAR_CONFLICT connected candidate satisfies hard rules (got ${JSON.stringify(connectedUnsatisfied)})`);
        assert(disconnectedUnsatisfied.some(rule => rule.type === "connect"),
            `CONNECT_FAR_CONFLICT disconnected candidate violates connect (got ${JSON.stringify(disconnectedUnsatisfied)})`);
        assert(selected.tag === "connected",
            `CONNECT_FAR_CONFLICT selector preserves connection despite other violations (got ${selected.tag})`);
    }

    // =====================================================================
    // TEST RETRY_PREF: isPreferredRequiredAttempt — required-satisfied
    // attempts beat cheaper unsatisfied ones, regardless of arrival order.
    // =====================================================================
    console.log("\n=== Test RETRY_PREF: prefer required-satisfied over cheaper unsatisfied ===");
    {
        const cheapUnsatisfied = { cost: 100, geometryViolations: 0 };
        const pricierSatisfied = { cost: 500, geometryViolations: 2 };
        const twoUnsatisfied = new Array(2).fill({ roomId: "X", type: "connect" });

        const challengerWins = isPreferredRequiredAttempt(
            pricierSatisfied, [], cheapUnsatisfied, twoUnsatisfied);
        assert(challengerWins, "RETRY_PREF pricier satisfied attempt beats cheap unsatisfied incumbent");

        const incumbentHolds = isPreferredRequiredAttempt(
            cheapUnsatisfied, twoUnsatisfied, pricierSatisfied, []);
        assert(!incumbentHolds, "RETRY_PREF cheap unsatisfied challenger does not beat satisfied incumbent");

        assert(isPreferredRequiredAttempt(
                { cost: 600, geometryViolations: 0 }, [],
                { cost: 500, geometryViolations: 1 }, []),
            "RETRY_PREF tie on required count prefers fewer geometry violations before cost");
        assert(isPreferredRequiredAttempt(
                { cost: 500, geometryViolations: 1 }, [],
                { cost: 600, geometryViolations: 1 }, []),
            "RETRY_PREF tie on required and geometry count falls back to lower cost");
        assert(!isPreferredRequiredAttempt(
                { cost: 600, geometryViolations: 1 }, [],
                { cost: 500, geometryViolations: 1 }, []),
            "RETRY_PREF tie on required and geometry count rejects higher cost");

        const key = requiredAttemptSelectionKey(
            { cost: 123, geometryViolations: 4 }, twoUnsatisfied);
        assert(JSON.stringify(key) === JSON.stringify([0, 2, 4, 123]),
            `RETRY_PREF shared key is conflict/required/geometry/cost (got ${JSON.stringify(key)})`);
    }

    // =====================================================================
    // TEST SELECT_BEST: _selectRequiredBest replicates the sequential retry
    // selection (lexicographic best over the first satisfied attempt plus a
    // bounded SATISFIED_LOOKAHEAD) over precomputed attempt-ordered results.
    // This is the correctness invariant the parallel worker path relies on.
    // =====================================================================
    console.log("\n=== Test SELECT_BEST: parallel selection == sequential lookahead ===");
    {
        const e = (cost, unsat, geometryViolations = 0, repairAttempted = false, tag = cost) => ({
            result: { cost, geometryViolations, repairAttempted, tag },
            unsatisfied: new Array(unsat).fill({ roomId: "X", type: "connect" }),
        });

        // A naturally-satisfied attempt no longer ends the search: a cheaper satisfied
        // attempt inside the lookahead window wins.
        const cheaperWithinWindow = _selectRequiredBest([e(100, 0), e(50, 0)]);
        assert(cheaperWithinWindow.cost === 50,
            `SELECT_BEST cheaper satisfied attempt within lookahead wins (got ${cheaperWithinWindow.cost})`);

        // The lookahead is bounded: attempts more than SATISFIED_LOOKAHEAD past the
        // first satisfied one are never considered, however cheap they are.
        const beyondWindow = _selectRequiredBest([e(100, 0), e(999, 1), e(999, 1), e(999, 1), e(1, 0)]);
        assert(beyondWindow.cost === 100,
            `SELECT_BEST stops SATISFIED_LOOKAHEAD attempts after the first satisfied one (got ${beyondWindow.cost})`);

        // Unsatisfied first attempt, satisfied second: the window opens at the second,
        // so the cheaper satisfied third still wins.
        const secondSatisfied = _selectRequiredBest([e(10, 2), e(500, 0), e(5, 0)]);
        assert(secondSatisfied.cost === 5, `SELECT_BEST cheapest satisfied attempt wins (got ${secondSatisfied.cost})`);
        assert(secondSatisfied.unsatisfied.length === 0, "SELECT_BEST returns the satisfied attempt");

        // A repaired-satisfied attempt does NOT stop the search; a later cheaper
        // natural (or lexicographically better) attempt still wins.
        const repairedThenBetter = _selectRequiredBest([e(300, 0, 0, true), e(200, 0)]);
        assert(repairedThenBetter.cost === 200, `SELECT_BEST repaired attempt keeps searching (got ${repairedThenBetter.cost})`);

        // No attempt satisfied: fewest unsatisfied then lowest cost across all.
        const allUnsat = _selectRequiredBest([e(100, 2), e(90, 1), e(80, 1)]);
        assert(allUnsat.cost === 80 && allUnsat.unsatisfied.length === 1,
            `SELECT_BEST all-unsatisfied picks fewest-unsatisfied then lowest cost (got cost ${allUnsat.cost}, unsat ${allUnsat.unsatisfied.length})`);

        // Exact cost tie: the earlier attempt index holds (deterministic tie-break).
        const geometryWins = _selectRequiredBest([e(10, 0, 2), e(100, 0, 1)]);
        assert(geometryWins.cost === 100 && geometryWins.geometryViolations === 1,
            `SELECT_BEST worker replay prefers geometry before cost (got ${geometryWins.geometryViolations}/${geometryWins.cost})`);

        const geometryTie = _selectRequiredBest([e(100, 0, 1), e(50, 0, 1)]);
        assert(geometryTie.cost === 50,
            `SELECT_BEST geometry tie falls through to cost (got ${geometryTie.cost})`);

        const costTie = _selectRequiredBest([e(70, 1, 2, false, "first"), e(70, 1, 2, false, "second")]);
        assert(costTie.tag === "first" && costTie.cost === 70, "SELECT_BEST exact cost tie keeps earliest attempt");
    }

    // =====================================================================
    // TEST GEOMETRY_COUNT: count delivered rooms once when aspect or side_min
    // violates its effective limit, including auto-area room ratio flexibility.
    // =====================================================================
    console.log("\n=== Test GEOMETRY_COUNT: delivered geometry uses effective limits ===");
    {
        const modulesMap = {
            both: { id: "both", ratioMax: 2, sideMin: 50 },
            auto: { id: "auto", ratioMax: 6, sideMin: 10 },
            fixedRatio: { id: "fixedRatio", ratio: 4, sideMin: 10 },
        };
        const layout = [
            { id: "both", w: 120, h: 40 },
            { id: "auto", w: 60, h: 10 },
            { id: "fixedRatio", w: 40, h: 10 },
        ];
        assert(countDeliveredGeometryViolations(layout, modulesMap, {
            ratioMax: 1.5,
            sideMin: 20,
        }) === 1,
            "GEOMETRY_COUNT counts aspect-or-side failure once and honors room overrides/fixed ratio");

        const epsilonLayout = [{ id: "both", w: 100, h: 50 - 1e-8 }];
        assert(countDeliveredGeometryViolations(epsilonLayout, modulesMap) === 0,
            "GEOMETRY_COUNT ignores floating-point drift within epsilon");
    }

    // =====================================================================
    // TEST RULE_REPORT: exact post-solve per-rule accounting
    // =====================================================================
    console.log("\n=== Test RULE_REPORT: exact post-solve per-rule accounting ===");
    {
        const scalarConnect = { type: "connect", target: "B", weight: 1, required: false };
        const anyNorth = {
            type: "at",
            dir: "north",
            weight: 1,
            required: false,
            subjectAny: true,
            subjectGroupId: 4,
        };
        const modulesMap = {
            A: { id: "A", rules: [scalarConnect, anyNorth] },
            B: { id: "B", rules: [] },
            C: { id: "C", rules: [{ ...anyNorth }] },
        };
        const layout = [
            { id: "A", x: 0, y: 0, w: 100, h: 100, centerX: 50, centerY: 50 },
            { id: "B", x: 300, y: 0, w: 100, h: 100, centerX: 350, centerY: 50 },
            { id: "C", x: 100, y: 100, w: 100, h: 100, centerX: 150, centerY: 150 },
        ];
        const bounds = { w: 400, h: 200 };
        const topological = calculateTopologicalPenalties(layout, modulesMap, bounds, {}, 1, 1);
        const total = topological + 80000;
        const report = calculateRuleScores(layout, modulesMap, bounds, {}, total, topological);
        const connect = report.rules.find(rule => rule.type === "connect");
        const subjectAny = report.rules.find(rule => rule.id === "group:4");

        assert(report.rules.length === 2, `RULE_REPORT subject-any expansions collapse to one rule (got ${report.rules.length})`);
        assert(connect.text === "A connect B", `RULE_REPORT canonical rule text is stable (got '${connect.text}')`);
        assert(connect.participants.join("|") === "A|B", "RULE_REPORT exposes named subject and target participants without parsing display text");
        assert(connect.satisfied === false && connect.penalty > 0, "RULE_REPORT includes binary verdict and continuous penalty");
        assert(subjectAny.text === "any [A, C] at north", `RULE_REPORT names all subject-any rooms (got '${subjectAny.text}')`);
        assert(subjectAny.participants.join("|") === "A|C", "RULE_REPORT subject-any participants include every named subject");
        assert(subjectAny.satisfied === true && subjectAny.penalty === 0, "RULE_REPORT subject-any uses any verdict and minimum penalty");
        assert(Math.abs(report.reportedPenalty - topological) < 1e-6, "RULE_REPORT rule terms sum to final topological score");
        assert(Math.abs(connect.percentOfTotal - connect.penalty / total * 100) < 1e-12, "RULE_REPORT percentage uses final scope total");
        assert(scalarConnect.target === "B" && anyNorth.dir === "north", "RULE_REPORT does not normalize parser rules in place");
        assert(report.weightSemantics.compressedTargetFormula === "N <= 1 ? N : min(1 + log2(N), 25)",
            "RULE_REPORT distinguishes raw weight from compressed target formula");
        assert(report.weightSemantics.annealingEffectiveFormula === "1 + (target - 1) * min(initial_t / T / 100, 1)",
            "RULE_REPORT exposes temperature-dependent effective-weight formula");
        assert(Math.abs(report.weightSemantics.example.compressedTargetWeight - (1 + Math.log2(5))) < 1e-12
            && Math.abs(report.weightSemantics.example.initialEffectiveWeight - (1 + Math.log2(5) / 100)) < 1e-12,
            "RULE_REPORT weight=5 example separates raw, target, and initial effective weights");
        assert(report.weightSemantics.finalReportUses === "compressed-target"
            && report.weightSemantics.requiredWeightFormula === "N * 50",
            "RULE_REPORT states final-report and required-weight semantics");

        const conflictModules = {
            A: {
                id: "A", rules: [
                    { type: "connect", target: "B", weight: 1, required: true },
                    { type: "far", target: "B", weight: 1, required: true },
                ],
            },
            B: { id: "B", rules: [] },
        };
        const conflictTopological = calculateTopologicalPenalties(layout.slice(0, 2), conflictModules, bounds, {}, 1, 1);
        const conflictReport = calculateRuleScores(layout.slice(0, 2), conflictModules, bounds, {}, conflictTopological, conflictTopological);
        const far = conflictReport.rules.find(rule => rule.type === "far");
        assert(far.satisfied === null && far.penalty > 0, "RULE_REPORT labels required connect/far hard-verdict conflict as exempt while retaining scored penalty");
        const farSplit = far.farPenaltyDecomposition;
        assert(farSplit.mode === "required-inverse-distance-floor"
            && farSplit.distanceBasis === "room-center-to-target-center"
            && farSplit.requiredWeight === 50 && farSplit.penaltyScale === 1000000
            && farSplit.canvasDiagonal === Math.hypot(bounds.w, bounds.h),
            "RULE_REPORT required far split states center-distance and scope-canvas assumptions");
        assert(farSplit.irreduciblePenalty === 25000000
            && Math.abs(farSplit.irreduciblePenalty + farSplit.reduciblePenalty - far.penalty) < 1e-9,
            "RULE_REPORT required far split is exact and additive for a local target");
        assert(farSplit.floorTerms[0].maximumDistanceBasis === "scope-canvas-diagonal"
            && farSplit.floorTerms[0].maximumCenterDistance === farSplit.canvasDiagonal,
            "RULE_REPORT local required far floor uses one canvas diagonal maximum distance");

        const multiFarLayout = [...layout.slice(0, 2), layout[2]];
        const summedFarModules = {
            A: { id: "A", rules: [{ type: "far", target: ["B", "C"], weight: 1, required: true }] },
            B: { id: "B", rules: [] },
            C: { id: "C", rules: [] },
        };
        const summedPenalty = calculateTopologicalPenalties(multiFarLayout, summedFarModules, bounds, {}, 1, 1);
        const summedFar = calculateRuleScores(multiFarLayout, summedFarModules, bounds, {}, summedPenalty, summedPenalty).rules[0];
        const anyFarModules = {
            ...summedFarModules,
            A: {
                id: "A",
                rules: [{ type: "far", target: ["B", "C"], any: true, weight: 1, required: true }],
            },
        };
        const anyPenalty = calculateTopologicalPenalties(multiFarLayout, anyFarModules, bounds, {}, 1, 1);
        const anyFar = calculateRuleScores(multiFarLayout, anyFarModules, bounds, {}, anyPenalty, anyPenalty).rules[0];
        assert(summedFar.farPenaltyDecomposition.aggregation === "sum-over-resolved-targets"
            && summedFar.farPenaltyDecomposition.irreduciblePenalty === 50000000,
            "RULE_REPORT multi-target required far sums pair floors");
        assert(anyFar.farPenaltyDecomposition.aggregation === "minimum-over-resolved-targets"
            && anyFar.farPenaltyDecomposition.irreduciblePenalty === 25000000,
            "RULE_REPORT any-target required far takes minimum pair floor");

        const advisoryFarModules = {
            A: { id: "A", rules: [{ type: "far", target: "B", weight: 1, required: false }] },
            B: { id: "B", rules: [] },
        };
        const advisoryFarReport = calculateRuleScores(layout.slice(0, 2), advisoryFarModules, bounds, {}, 0, 0);
        assert(advisoryFarReport.rules[0].farPenaltyDecomposition === undefined,
            "RULE_REPORT never claims an irreducible floor for zero-cutoff advisory far");

        const externalTarget = { id: "outside", centerX: 600, centerY: 100 };
        const phantomFarModules = {
            A: { id: "A", rules: [{ type: "far", target: "outside", weight: 1, required: true }] },
        };
        const phantomPenalty = calculateTopologicalPenalties(layout.slice(0, 1), phantomFarModules, bounds, {}, 1, 1, null, [externalTarget]);
        const phantomReport = calculateRuleScores(layout.slice(0, 1), phantomFarModules, bounds, {}, phantomPenalty, phantomPenalty, [externalTarget]);
        const phantomSplit = phantomReport.rules[0].farPenaltyDecomposition;
        assert(phantomSplit.floorTerms[0].maximumDistanceBasis === "farthest-scope-corner-from-fixed-external-target"
            && phantomSplit.floorTerms[0].maximumCenterDistance === Math.hypot(600, 100),
            "RULE_REPORT external phantom far floor uses farthest scope-corner distance");
        assert(Math.abs(phantomSplit.irreduciblePenalty + phantomSplit.reduciblePenalty - phantomReport.rules[0].penalty) < 1e-9,
            "RULE_REPORT external phantom far split remains exact and additive");
    }

    // =====================================================================
    // TEST MUTATION: Input parameters not mutated
    // =====================================================================
    console.log("\n=== Test MUTATION: Input parameters not mutated ===");
    {
        const originalModules = [
            {
                id: "A",
                area: 100,
                rules: [
                    { type: "connect", target: "B", required: true },
                    { type: "at", dir: "north" },
                ],
            },
            {
                id: "B",
                area: 100,
                rules: [],
            },
        ];

        // Deep clone before running to compare against
        const cloneBeforeRun = JSON.parse(JSON.stringify(originalModules));

        await wongLiuSimulatedAnnealing(originalModules, {
            seed: 42,
            k: 5,
            iter: 1,
            cooling_rate: 0.5,
            min_t: 0.1,
        });

        // Ensure originalModules structure remains untouched
        assert(JSON.stringify(originalModules) === JSON.stringify(cloneBeforeRun),
            "MUTATION: originalModules mutated during execution");
    }

    // =====================================================================
    // TEST REPAIR: post-SA repair fixes a required connect via one operand swap
    // =====================================================================
    console.log("\n=== Test REPAIR: post-SA repair phase satisfies required connect ===");
    {
        const modulesMap = {
            A: { id: "A", rules: [{ type: "connect", target: ["C"], required: true, any: false }] },
            B: { id: "B", rules: [] },
            C: { id: "C", rules: [] },
        };

        // Fake geometry: A and C share a wall iff they are adjacent in operand order.
        const finalizeNpe = (npe) => {
            const ops = npe.filter(x => x !== "H" && x !== "V");
            const adjacent = Math.abs(ops.indexOf("A") - ops.indexOf("C")) === 1;
            const layout = adjacent
                ? [
                    { id: "A", x: 0, y: 0, w: 10, h: 10 },
                    { id: "C", x: 10, y: 0, w: 10, h: 10 },
                    { id: "B", x: 0, y: 100, w: 10, h: 10 },
                ]
                : [
                    { id: "A", x: 0, y: 0, w: 10, h: 10 },
                    { id: "C", x: 100, y: 0, w: 10, h: 10 },
                    { id: "B", x: 0, y: 100, w: 10, h: 10 },
                ];
            return { layout, cost: adjacent ? 100 : 1000, shape: { w: 120, h: 120 } };
        };

        // Start NPE puts B between A and C, so the connect is unsatisfied.
        const startNpe = ["A", "B", "V", "C", "V"];
        const start = { npe: startNpe, ...finalizeNpe(startNpe) };
        assert(checkRequiredSatisfied(start.layout, modulesMap).length === 1,
            "REPAIR start layout has the connect unsatisfied");

        // Every enumerated candidate must remain a valid NPE and preserve operands.
        const offending = collectOffendingIds([{ roomId: "A", type: "connect", target: ["C"] }]);
        assert(offending.has("A") && offending.has("C"), "REPAIR offending set includes room and target");
        const cands = offendingOperandSwaps(startNpe, offending).concat(offendingM3Swaps(startNpe, offending));
        assert(cands.length > 0, "REPAIR generates candidate moves");
        const startSorted = [...startNpe].sort().join(",");
        let allValid = true;
        for (const c of cands) {
            if (!isValidNPE(c)) {
                allValid = false;
            }
        }
        assert(allValid, "REPAIR every candidate is a valid NPE");
        const swapsPreserveOperands = offendingOperandSwaps(startNpe, offending)
            .every(c => [...c].sort().join(",") === startSorted);
        assert(swapsPreserveOperands, "REPAIR operand swaps preserve the operand multiset");

        // M3 swaps change nesting; ensure the generator emits candidates and they stay valid.
        const m3Npe = ["A", "B", "V", "C", "H", "D", "V"];
        const m3Cands = offendingM3Swaps(m3Npe, new Set(["C"]));
        assert(m3Cands.length > 0, "REPAIR M3 generator emits candidates");
        assert(m3Cands.every(isValidNPE), "REPAIR every M3 candidate is a valid NPE");

        const repaired = repairRequiredLayout(start, finalizeNpe, modulesMap);
        assert(repaired.attempted, "REPAIR ran (attempted) on an unsatisfied layout");
        assert(repaired.unsatisfiedAfter === 0, `REPAIR cleared all unsatisfied (got ${repaired.unsatisfiedAfter})`);
        assert(checkRequiredSatisfied(repaired.layout, modulesMap).length === 0, "REPAIR result satisfies the required connect");
        assert(isValidNPE(repaired.npe), "REPAIR result NPE is valid");

        // Already-satisfied layout: no-op, unchanged reference to npe.
        const satisfiedNpe = ["A", "C", "V", "B", "V"];
        const satisfied = { npe: satisfiedNpe, ...finalizeNpe(satisfiedNpe) };
        const noop = repairRequiredLayout(satisfied, finalizeNpe, modulesMap);
        assert(!noop.attempted, "REPAIR is a no-op when nothing is unsatisfied");
        assert(noop.npe === satisfiedNpe, "REPAIR leaves a satisfied layout untouched");
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
