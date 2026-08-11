/**
 * Helper to yield control to the browser's event loop to prevent UI freezing.
 */
function yieldToMain() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Validates if an element is an operand (a room/module ID) or an operator (H or V cut).
 */
const isOperator = (c) => c === "H" || c === "V";
const isOperand = (c) => !isOperator(c);

const PENALTIES = {
    // Spatial penalties (connect, close, canvas overflow) are normalized by canvasDiag²
    // so they're dimensionless ratios in [0,1] before applying the base. This makes the
    // cost function scale-invariant — same weights work whether canvas is 500cm or 5000cm.
    // `far` was already canvas-normalized (canvasDiag/(d+1)) and is left alone.
    CONNECT_BASE: 1000000,  // base multiplier for connect/close/at/cwc rules (post-normalize)
    CWL_SHORT: 1000000,     // shared-wall-length-too-short, normalized by canvasDiag
    AT_CORNER: 1000000,     // at-rule corner orientation mismatch, normalized by canvasDiag
    NOT_AT_EDGE: 100000000, // not_at edge penetration normalized by canvasDiag²
    CANVAS: 100000000,      // canvas overflow normalized by (canvasW², canvasH²) → dimensionless
    ASPECT: 10000,          // layout aspect ratio > 2.0 per unit
    AREA_MISFIT: 0.5,       // room area absolute error per cm²
    ROOM_ASPECT: 2500000,   // room aspect ratio excess, linear + quadratic
    SIDE_MIN: 10000000,     // room side shortfall ratio, linear + quadratic
    INVALID_SOFT: 500000,   // crossing invalid NPE states (allows transitions)
    INVALID_HARD: 10000000, // hard-invalid NPE in best tracking
    DEFAULT_SIDE_MIN: 50,   // fallback for module.sideMin (cm)
    REQUIRED_BOOST: 50,    // weight multiplier for required rules (bypasses uwm ramp)
};

const CONNECT_VIOLATION_FLOOR = 0.1;

// Required attempts are still ranked first. This only keeps advisory connections competitive while SA searches.
const SOFT_CONNECT_VIOLATION_FLOOR = 8;

const SOFT_RULE_WEIGHT_CAP = PENALTIES.REQUIRED_BOOST / 2;

// Advisory far reaches zero at its configured distance cutoff. Required far retains the inverse-distance curve.
const FAR_MAX_DISTANCE_FRACTION = 1;
const FAR_CUTOFF_FRACTION_WITH_SOFT_CONNECT = 0.5;

const MIN_ACCEPT_RATE = 0.05;
const FREEZE_T_FRACTION = 0.01;
const INITIAL_DELTA_FALLBACK = 10000;
const CWM_CAP = 100;
const REPAIR_MAX_MOVES = 300;
const LONG_RANGE_MOVE_PROBABILITY = 0.2;
const GEOMETRY_EPSILON = 1e-6;

// Extra required-retry attempts explored after the first naturally-satisfied one.
// Stopping at the first satisfied attempt returns whatever cost that attempt happened
// to have — measured 22-46% above the cheapest satisfied attempt of the same run.
// A bounded lookahead keeps the retry loop cheap while letting a cheaper satisfied
// attempt win. The attempt set stays a superset of the old one and selection is a
// lexicographic (unsatisfied, cost) minimum, so the kept result can never get worse.
const SATISFIED_LOOKAHEAD = 3;

const _OPTIMIZER_MODULE_PATH = (typeof __filename !== "undefined") ? __filename : null;
const WORKER_POOL_SIZE = Math.max(1, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4);

// Worker body: loads this optimizer (importScripts in a browser worker, require in
// bun/node) and runs one `_runWithRestarts` attempt, posting the plain-data result.
const WORKER_SOURCE = `
self.onmessage = function(e) {
    var d = e.data;
    try {
        var runner = (typeof _runWithRestarts !== "undefined") ? _runWithRestarts : null;
        if (!runner && typeof importScripts === "function") {
            importScripts(d.scriptUrl);
            runner = _runWithRestarts;
        }
        if (!runner && typeof require === "function") {
            runner = require(d.scriptUrl)._runWithRestarts;
        }
        Promise.resolve(runner(d.modules, d.config, null, d.phantoms)).then(function(result) {
            self.postMessage({ ok: true, result: result });
        }).catch(function(err) {
            self.postMessage({ ok: false, error: String(err && err.stack || err) });
        });
    } catch (err) {
        self.postMessage({ ok: false, error: String(err && err.stack || err) });
    }
};
`;

/**
 * Checks if a given Polish expression is Normalized (NPE).
 * It must satisfy:
 * 1. Balloting property: Every subexpression has strictly more operands than operators.
 * 2. Skewed tree property: No consecutive identical operators (e.g., no 'HH' or 'VV').
 */
function isValidNPE(npe) {
    let operands = 0;
    let operators = 0;

    for (let i = 0; i < npe.length; i++) {
        if (isOperand(npe[i])) {
            operands++;
        } else {
            operators++;
        }

        // Balloting property: strictly more operands than operators up to any point i
        if (operands <= operators) {
            return false;
        }

        // Skewed property: no consecutive identical operators
        if (i > 0 && isOperator(npe[i]) && npe[i] === npe[i - 1]) {
            return false;
        }
    }
    return true;
}

/**
 * Move M1: Swap two adjacent operands.
 * Returns move info { type: 'M1', positions: [i, i+1] } or null if no candidate.
 */
function applyM1(npe, randomFn = Math.random) {
    let count = 0, chosen = -1;
    for (let i = 0; i < npe.length - 1; i++) {
        if (isOperand(npe[i]) && isOperand(npe[i + 1])) {
            count++;
            if (count === 1 || randomFn() * count < 1) {
                chosen = i;
            }
        }
    }
    if (chosen === -1) {
        return null;
    }
    const tmp = npe[chosen];
    npe[chosen] = npe[chosen + 1];
    npe[chosen + 1] = tmp;
    return { type: "M1", positions: [chosen, chosen + 1] };
}

/**
 * Move M2: Complement a maximal chain of operators.
 * Converts sequences like 'H V H' into 'V H V'.
 * Returns { type: 'M2', positions: [start, ..., end] } or null if no chain.
 */
function applyM2(npe, randomFn = Math.random) {
    let count = 0, chosenStart = -1, chosenEnd = -1;
    let chainStart = -1;

    for (let i = 0; i <= npe.length; i++) {
        if (i < npe.length && isOperator(npe[i])) {
            if (chainStart === -1) {
                chainStart = i;
            }
        } else if (chainStart !== -1) {
            count++;
            if (count === 1 || randomFn() * count < 1) {
                chosenStart = chainStart;
                chosenEnd = i - 1;
            }
            chainStart = -1;
        }
    }

    if (chosenStart === -1) {
        return null;
    }
    const positions = [];
    for (let idx = chosenStart; idx <= chosenEnd; idx++) {
        npe[idx] = npe[idx] === "H" ? "V" : "H";
        positions.push(idx);
    }
    return { type: "M2", positions };
}

/**
 * Move M3: Swap two adjacent operand and operator.
 * Incremental validity check: O(n) precompute + O(1) per candidate.
 *
 * Let diffs[i] = (operands - operators) over npe[0..i] in original sequence.
 *
 * Case A (operand at i, operator at i+1, swap → operator at i):
 *   - Balloting at position i becomes diffs[i] - 2; need > 0, i.e. diffs[i] > 2.
 *   - Skewed: if i > 0 and npe[i-1] is operator equal to npe[i+1], invalid.
 *
 * Case B (operator at i, operand at i+1, swap → operand at i):
 *   - Balloting auto-holds (original valid → new prefix increases by 2).
 *   - Skewed: if i+2 < n and npe[i+2] is operator equal to npe[i], invalid.
 *
 * Positions outside [i, i+1] are unaffected (sum of swapped pair unchanged).
 */
function applyM3(npe, randomFn = Math.random) {
    const n = npe.length;
    const diffs = new Array(n);
    let diff = 0;
    for (let i = 0; i < n; i++) {
        diff += isOperand(npe[i]) ? 1 : -1;
        diffs[i] = diff;
    }

    let count = 0, chosen = -1;
    for (let i = 0; i < n - 1; i++) {
        const aIsOp = isOperand(npe[i]);
        const bIsOp = isOperand(npe[i + 1]);
        if (aIsOp === bIsOp) {
            continue;
        }

        if (aIsOp) {
            if (diffs[i] <= 2) {
                continue;
            }
            if (i > 0 && isOperator(npe[i - 1]) && npe[i - 1] === npe[i + 1]) {
                continue;
            }
        } else {
            if (i + 2 < n && isOperator(npe[i + 2]) && npe[i + 2] === npe[i]) {
                continue;
            }
        }

        count++;
        if (count === 1 || randomFn() * count < 1) {
            chosen = i;
        }
    }

    if (chosen === -1) {
        return null;
    }
    const tmp = npe[chosen];
    npe[chosen] = npe[chosen + 1];
    npe[chosen + 1] = tmp;
    return { type: "M3", positions: [chosen, chosen + 1] };
}

/**
 * Move M4: Swap two non-neighboring operands in operand order.
 * Operand-only swaps preserve both NPE balloting and skewed properties.
 */
function applyM4(npe, randomFn = Math.random) {
    const operandPositions = [];
    for (let i = 0; i < npe.length; i++) {
        if (isOperand(npe[i])) {
            operandPositions.push(i);
        }
    }

    const candidates = [];
    for (let first = 0; first < operandPositions.length - 2; first++) {
        for (let second = first + 2; second < operandPositions.length; second++) {
            candidates.push([operandPositions[first], operandPositions[second]]);
        }
    }
    if (!candidates.length) {
        return null;
    }

    const positions = candidates[Math.floor(randomFn() * candidates.length)];
    const [first, second] = positions;
    const tmp = npe[first];
    npe[first] = npe[second];
    npe[second] = tmp;
    return { type: "M4", positions };
}

function applyRandomMove(npe, randomFn = Math.random) {
    const roll = randomFn();
    if (roll < LONG_RANGE_MOVE_PROBABILITY) {
        return applyM4(npe, randomFn) ?? applyM1(npe, randomFn);
    }

    const localMove = Math.floor(((roll - LONG_RANGE_MOVE_PROBABILITY)
        / (1 - LONG_RANGE_MOVE_PROBABILITY)) * 3);
    if (localMove === 0) {
        return applyM1(npe, randomFn);
    }
    if (localMove === 1) {
        return applyM2(npe, randomFn);
    }
    return applyM3(npe, randomFn);
}

/**
 * Prunes a curve to keep only Pareto-optimal shapes (minimizing w and h).
 */
function pruneCurve(curve) {
    // Sort by width ascending. If widths are equal, smaller height comes first.
    curve.sort((a, b) => a.w - b.w || a.h - b.h);

    const pareto = [];
    let minH = Infinity;
    for (let i = 0; i < curve.length; i++) {
        if (curve[i].h < minH) {
            pareto.push(curve[i]);
            minH = curve[i].h;
        }
    }
    return pareto;
}

/**
 * Phase 2: Top-Down Coordinate Assignment
 * Distributes slack to ensure the layout perfectly tiles the bounding box with no gaps.
 */
function assignCoordinates(node, shape, x, y, W, H) {
    W = W !== undefined ? W : shape.w;
    H = H !== undefined ? H : shape.h;

    if (node.type === "leaf") {
        return [{
            id: node.id,
            x: x,
            y: y,
            w: W,
            h: H,
            centerX: x + W / 2,
            centerY: y + H / 2,
        }];
    }

    const leftShape = shape.leftShape;
    const rightShape = shape.rightShape;

    if (node.type === "H") {
        // Horizontal cut: left is north (top of screen, low y), right is south (high y)
        const h_left = H * (leftShape.h / shape.h);
        const h_right = H * (rightShape.h / shape.h);
        const bottomRooms = assignCoordinates(node.left, leftShape, x, y, W, h_left);
        const topRooms = assignCoordinates(node.right, rightShape, x, y + h_left, W, h_right);
        return bottomRooms.concat(topRooms);
    } else {
        // Vertical cut: left is left, right is right
        const w_left = W * (leftShape.w / shape.w);
        const w_right = W * (rightShape.w / shape.w);
        const leftRooms = assignCoordinates(node.left, leftShape, x, y, w_left, H);
        const rightRooms = assignCoordinates(node.right, rightShape, x + w_left, y, w_right, H);
        return leftRooms.concat(rightRooms);
    }
}

/**
 * Top-down coordinate assignment in-place to avoid array/object allocation.
 */
function assignCoordinatesInPlace(node, shape, x, y, W, H, layoutMap) {
    W = W !== undefined ? W : shape.w;
    H = H !== undefined ? H : shape.h;

    if (node.type === "leaf") {
        const room = layoutMap[node.id];
        if (room) {
            room.x = x;
            room.y = y;
            room.w = W;
            room.h = H;
            room.centerX = x + W / 2;
            room.centerY = y + H / 2;
        }
        return;
    }

    const leftShape = shape.leftShape;
    const rightShape = shape.rightShape;

    if (node.type === "H") {
        // Horizontal cut: left is north (top of screen, low y), right is south (high y)
        const h_left = H * (leftShape.h / shape.h);
        const h_right = H * (rightShape.h / shape.h);
        assignCoordinatesInPlace(node.left, leftShape, x, y, W, h_left, layoutMap);
        assignCoordinatesInPlace(node.right, rightShape, x, y + h_left, W, h_right, layoutMap);
    } else {
        // Vertical cut: left is left, right is right
        const w_left = W * (leftShape.w / shape.w);
        const w_right = W * (rightShape.w / shape.w);
        assignCoordinatesInPlace(node.left, leftShape, x, y, w_left, H, layoutMap);
        assignCoordinatesInPlace(node.right, rightShape, x + w_left, y, w_right, H, layoutMap);
    }
}

function connectWallRequirement(A, B, rule, config = {}) {
    const configured = rule.cwl ?? config.cwl ?? 0;
    if (!rule.insideFrontage) {
        return configured;
    }

    const epsilon = REQUIRED_SATISFIED_EPS;
    const horizontalAdjacency = Math.abs(A.x + A.w - B.x) < epsilon || Math.abs(B.x + B.w - A.x) < epsilon;
    if (horizontalAdjacency) {
        return Math.max(configured, A.h);
    }
    const verticalAdjacency = Math.abs(A.y + A.h - B.y) < epsilon || Math.abs(B.y + B.h - A.y) < epsilon;
    if (verticalAdjacency) {
        return Math.max(configured, A.w);
    }
    return configured;
}

function effectiveRuleWeight(rule, uwm = 1) {
    const baseWeight = rule.weight || 1;
    if (rule.required) {
        return baseWeight * PENALTIES.REQUIRED_BOOST;
    }

    const compressedWeight = baseWeight <= 1
        ? baseWeight
        : Math.min(1 + Math.log2(baseWeight), SOFT_RULE_WEIGHT_CAP);
    return 1 + (compressedWeight - 1) * uwm;
}

function advisoryWeightSemantics() {
    const exampleRawWeight = 5;
    const exampleTargetWeight = Math.min(1 + Math.log2(exampleRawWeight), SOFT_RULE_WEIGHT_CAP);
    return {
        mode: "compressed-target-temperature-ramp",
        compressedTargetFormula: `N <= 1 ? N : min(1 + log2(N), ${SOFT_RULE_WEIGHT_CAP})`,
        annealingEffectiveFormula: `1 + (target - 1) * min(initial_t / T / ${CWM_CAP}, 1)`,
        initialOffsetFraction: 1 / CWM_CAP,
        fullTargetTemperatureFraction: 1 / CWM_CAP,
        finalReportUses: "compressed-target",
        requiredWeightFormula: `N * ${PENALTIES.REQUIRED_BOOST}`,
        requiredBypasses: ["compression", "temperature-ramp"],
        example: {
            rawWeight: exampleRawWeight,
            compressedTargetWeight: exampleTargetWeight,
            initialEffectiveWeight: 1 + (exampleTargetWeight - 1) / CWM_CAP,
        },
    };
}

function penaltyConnect(room, rule, layoutMap, config, cwm, canvasDiagSq, uwm = 1, canvasDiag = Math.sqrt(canvasDiagSq)) {
    const weight = effectiveRuleWeight(rule, uwm);
    const violationFloor = rule.required ? CONNECT_VIOLATION_FLOOR : SOFT_CONNECT_VIOLATION_FLOOR;
    const targets = rule.target ?? [];

    if (rule.any) {
        let minP = Infinity;
        for (let i = 0; i < targets.length; i++) {
            const B = layoutMap[targets[i]];
            if (B) {
                const sharedWallLength = sharedWall(room, B);
                const cwl = connectWallRequirement(room, B, rule, config);
                let val = 0;
                if (sharedWallLength === 0) {
                    const dx = room.centerX - B.centerX;
                    const dy = room.centerY - B.centerY;
                    val = (violationFloor + (dx * dx + dy * dy) / canvasDiagSq) * PENALTIES.CONNECT_BASE * weight * cwm;
                } else if (cwl > 0 && sharedWallLength < cwl) {
                    val = ((cwl - sharedWallLength) / canvasDiag) * PENALTIES.CWL_SHORT * weight * cwm;
                }
                if (val < minP) {
                    minP = val;
                }
            }
        }
        return minP === Infinity ? 0 : minP;
    }

    let sum = 0;
    for (let i = 0; i < targets.length; i++) {
        const B = layoutMap[targets[i]];
        if (B) {
            const sharedWallLength = sharedWall(room, B);
            const cwl = connectWallRequirement(room, B, rule, config);
            if (sharedWallLength === 0) {
                const dx = room.centerX - B.centerX;
                const dy = room.centerY - B.centerY;
                sum += (violationFloor + (dx * dx + dy * dy) / canvasDiagSq) * PENALTIES.CONNECT_BASE * weight * cwm;
            } else if (cwl > 0 && sharedWallLength < cwl) {
                sum += ((cwl - sharedWallLength) / canvasDiag) * PENALTIES.CWL_SHORT * weight * cwm;
            }
        }
    }
    return sum;
}

function penaltyClose(room, rule, layoutMap, cwm, canvasDiagSq, uwm = 1) {
    const weight = effectiveRuleWeight(rule, uwm);
    const targets = rule.target ?? [];

    if (rule.any) {
        let minP = Infinity;
        for (let i = 0; i < targets.length; i++) {
            const B = layoutMap[targets[i]];
            if (B) {
                const dx = room.centerX - B.centerX;
                const dy = room.centerY - B.centerY;
                const val = ((dx * dx + dy * dy) / canvasDiagSq) * weight * PENALTIES.CONNECT_BASE * cwm;
                if (val < minP) {
                    minP = val;
                }
            }
        }
        return minP === Infinity ? 0 : minP;
    }

    let sum = 0;
    for (let i = 0; i < targets.length; i++) {
        const B = layoutMap[targets[i]];
        if (B) {
            const dx = room.centerX - B.centerX;
            const dy = room.centerY - B.centerY;
            sum += ((dx * dx + dy * dy) / canvasDiagSq) * weight * PENALTIES.CONNECT_BASE * cwm;
        }
    }
    return sum;
}

function farPenaltyRatio(distance, canvasDiag, cutoffFraction) {
    if (!cutoffFraction) {
        return 1 / (1 + distance / canvasDiag);
    }

    const cutoffRatio = 1 / (1 + cutoffFraction);
    const distanceRatio = distance / canvasDiag;
    const shiftedRatio = Math.max(0, 1 / (1 + distanceRatio) - cutoffRatio);
    return shiftedRatio / (1 - cutoffRatio);
}

function penaltyFar(room, rule, layoutMap, canvasDiag, cwm, uwm = 1, cutoffFraction = 0) {
    const weight = effectiveRuleWeight(rule, uwm);
    const effectiveCutoffFraction = rule.required
        ? 0
        : (cutoffFraction || FAR_MAX_DISTANCE_FRACTION);
    const targets = rule.target ?? [];

    if (rule.any) {
        let minP = Infinity;
        for (let i = 0; i < targets.length; i++) {
            const B = layoutMap[targets[i]];
            if (B) {
                const dx = room.centerX - B.centerX;
                const dy = room.centerY - B.centerY;
                const d = Math.sqrt(dx * dx + dy * dy);
                const val = farPenaltyRatio(d, canvasDiag, effectiveCutoffFraction) * weight * PENALTIES.CONNECT_BASE * cwm;
                if (val < minP) {
                    minP = val;
                }
            }
        }
        return minP === Infinity ? 0 : minP;
    }

    let sum = 0;
    for (let i = 0; i < targets.length; i++) {
        const B = layoutMap[targets[i]];
        if (B) {
            const dx = room.centerX - B.centerX;
            const dy = room.centerY - B.centerY;
            const d = Math.sqrt(dx * dx + dy * dy);
            sum += farPenaltyRatio(d, canvasDiag, effectiveCutoffFraction) * weight * PENALTIES.CONNECT_BASE * cwm;
        }
    }
    return sum;
}

function penaltyAt(room, rule, rootW, rootH, cwm, canvasDiag, uwm = 1) {
    const weight = effectiveRuleWeight(rule, uwm);
    const dirs = rule.dir ?? [];
    let p = 0;

    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        let d = 0;
        if (dir === "edge") {
            const d_min = Math.min(room.y, rootH - (room.y + room.h), room.x, rootW - (room.x + room.w));
            d = d_min > 0 ? d_min : 0;
        } else if (dir === "north") {
            d = room.y;
        } else if (dir === "south") {
            d = rootH - (room.y + room.h);
        } else if (dir === "east") {
            d = rootW - (room.x + room.w);
        } else if (dir === "west") {
            d = room.x;
        }
        p += (d / canvasDiag) * weight * PENALTIES.CONNECT_BASE * cwm;
    }
    if (dirs.length >= 2) {
        const first = dirs[0];
        if ((first === "north" || first === "south") && room.h > room.w) {
            p += ((room.h - room.w) / canvasDiag) * weight * PENALTIES.AT_CORNER * cwm;
        } else if ((first === "east" || first === "west") && room.w > room.h) {
            p += ((room.w - room.h) / canvasDiag) * weight * PENALTIES.AT_CORNER * cwm;
        }
    }
    return p;
}

function penaltyNotAt(room, rule, mod, rootW, rootH, cwm, canvasDiagSq, uwm = 1, canvasDiag = Math.sqrt(canvasDiagSq)) {
    const weight = effectiveRuleWeight(rule, uwm);
    const targetDepth = mod.sideMin || PENALTIES.DEFAULT_SIDE_MIN;

    const d0 = rule.dir?.[0];
    if (d0 === "edge" || rule.type === "enclosed") {
        const d_min = Math.min(room.y, rootH - (room.y + room.h), room.x, rootW - (room.x + room.w));
        if (d_min >= targetDepth) {
            return 0;
        }
        const shortfall = targetDepth - d_min;
        return ((shortfall * shortfall) / canvasDiagSq) * weight * PENALTIES.NOT_AT_EDGE * cwm;
    }

    let d = Infinity;
    if (d0 === "north") {
        d = room.y;
    } else if (d0 === "south") {
        d = rootH - (room.y + room.h);
    } else if (d0 === "east") {
        d = rootW - (room.x + room.w);
    } else if (d0 === "west") {
        d = room.x;
    }

    if (d >= targetDepth) {
        return 0;
    }

    // Graded, mirroring penaltyAt in reverse: cost falls off linearly as the room leaves
    // the forbidden band, so SA gets a direction to push it out. A flat step penalty gave
    // no gradient at all — the room only ever escaped the wall by luck or by the repair
    // phase. Same normalization and base as penaltyAt, so a room sitting flush against a
    // forbidden wall costs exactly what a room `targetDepth` away from a required wall does.
    return ((targetDepth - d) / canvasDiag) * weight * PENALTIES.CONNECT_BASE * cwm;
}

function calculateRulePenalty(room, rule, mod, layoutMap, rootW, rootH, config, cwm, uwm, canvasDiagSq, canvasDiag) {
    if (rule.type === "connect") {
        return penaltyConnect(room, rule, layoutMap, config, cwm, canvasDiagSq, uwm, canvasDiag);
    }
    if (rule.type === "close") {
        return penaltyClose(room, rule, layoutMap, cwm, canvasDiagSq, uwm);
    }
    if (rule.type === "far") {
        return penaltyFar(room, rule, layoutMap, canvasDiag, cwm, uwm, config._farCutoffFraction);
    }
    if (rule.type === "at") {
        return penaltyAt(room, rule, rootW, rootH, cwm, canvasDiag, uwm);
    }
    if (rule.type === "not_at" || rule.type === "enclosed") {
        return penaltyNotAt(room, rule, mod, rootW, rootH, cwm, canvasDiagSq, uwm, canvasDiag);
    }
    return 0;
}

const REQUIRED_SATISFIED_EPS = 0.1;

function sharedWall(A, B) {
    const isHAdj = Math.abs(A.x + A.w - B.x) < REQUIRED_SATISFIED_EPS || Math.abs(B.x + B.w - A.x) < REQUIRED_SATISFIED_EPS;
    const vOv = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    const isVAdj = Math.abs(A.y + A.h - B.y) < REQUIRED_SATISFIED_EPS || Math.abs(B.y + B.h - A.y) < REQUIRED_SATISFIED_EPS;
    const hOv = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
    if (isHAdj && vOv > REQUIRED_SATISFIED_EPS) {
        return vOv;
    }
    if (isVAdj && hOv > REQUIRED_SATISFIED_EPS) {
        return hOv;
    }
    return 0;
}

function isRuleSatisfied(rule, room, layoutMap, globalBounds) {
    const { w: gW, h: gH } = globalBounds;
    const targets = rule.target === undefined ? [] : (Array.isArray(rule.target) ? rule.target : [rule.target]);
    const dirs = rule.dir === undefined ? [] : (Array.isArray(rule.dir) ? rule.dir : (typeof rule.dir === "string" ? rule.dir.split(" ") : []));

    switch (rule.type) {
        case "connect": {
            const ok = (t) => {
                const target = layoutMap[t];
                if (!target) {
                    return false;
                }
                const swl = sharedWall(room, target);
                const cwl = connectWallRequirement(room, target, rule);
                return swl > 0 && (cwl === 0 || swl >= cwl - REQUIRED_SATISFIED_EPS);
            };
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "close": {
            const ok = (t) => layoutMap[t] && sharedWall(room, layoutMap[t]) > 0;
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "far": {
            // satisfied when not adjacent — the continuous penalty maximizes distance,
            // but the binary check only requires non-adjacency
            const ok = (t) => !layoutMap[t] || sharedWall(room, layoutMap[t]) === 0;
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "at": {
            return dirs.every(dir => {
                if (dir === "north") {
                    return room.y < REQUIRED_SATISFIED_EPS;
                }
                if (dir === "south") {
                    return (gH - (room.y + room.h)) < REQUIRED_SATISFIED_EPS;
                }
                if (dir === "east") {
                    return (gW - (room.x + room.w)) < REQUIRED_SATISFIED_EPS;
                }
                if (dir === "west") {
                    return room.x < REQUIRED_SATISFIED_EPS;
                }
                if (dir === "edge") {
                    return Math.min(room.y, gH - (room.y + room.h), room.x, gW - (room.x + room.w)) < REQUIRED_SATISFIED_EPS;
                }
                return true;
            });
        }
        case "not_at":
        case "enclosed": {
            if (rule.type === "enclosed" || dirs[0] === "edge") {
                return Math.min(room.y, gH - (room.y + room.h), room.x, gW - (room.x + room.w)) > REQUIRED_SATISFIED_EPS;
            }
            return dirs.every(dir => {
                if (dir === "north") {
                    return room.y > REQUIRED_SATISFIED_EPS;
                }
                if (dir === "south") {
                    return (gH - (room.y + room.h)) > REQUIRED_SATISFIED_EPS;
                }
                if (dir === "east") {
                    return (gW - (room.x + room.w)) > REQUIRED_SATISFIED_EPS;
                }
                if (dir === "west") {
                    return room.x > REQUIRED_SATISFIED_EPS;
                }
                return true;
            });
        }
        default:
            return true;
    }
}

function requiredConnectPairKey(a, b) {
    return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function collectRequiredConnectPairs(modulesMap) {
    const pairs = new Set();

    for (const module of Object.values(modulesMap)) {
        for (const rule of module.rules || []) {
            if (rule.type !== "connect" || !rule.required || rule.subjectAny) {
                continue;
            }
            const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
            if (rule.any && targets.length > 1) {
                continue;
            }
            for (const target of targets) {
                pairs.add(requiredConnectPairKey(module.id, target));
            }
        }
    }

    return pairs;
}

function collectRequiredFarPairs(modulesMap) {
    const pairs = new Set();

    for (const module of Object.values(modulesMap)) {
        for (const rule of module.rules || []) {
            if (rule.type !== "far" || !rule.required) {
                continue;
            }
            const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
            for (const target of targets) {
                pairs.add(requiredConnectPairKey(module.id, target));
            }
        }
    }

    return pairs;
}

function removeRequiredConnectConflicts(rule, roomId, requiredConnectPairs) {
    if (rule.type !== "far") {
        return rule;
    }

    // Keep `far` in the cost landscape, but do not let its incompatible binary
    // verdict defeat a required shared wall for the same room pair.
    const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
    const compatibleTargets = targets.filter(target => !requiredConnectPairs.has(requiredConnectPairKey(roomId, target)));
    if (compatibleTargets.length === targets.length) {
        return rule;
    }
    if (compatibleTargets.length === 0) {
        return null;
    }

    return { ...rule, target: compatibleTargets };
}

function checkRequiredSatisfied(layout, modulesMap, phantoms = []) {
    if (!layout || layout.length === 0) {
        return [];
    }
    const layoutMap = Object.fromEntries(layout.map(r => [r.id, r]));
    for (const phantom of phantoms) {
        if (!layoutMap[phantom.id]) {
            layoutMap[phantom.id] = phantom;
        }
    }
    const gW = layout.reduce((m, r) => Math.max(m, r.x + r.w), 0);
    const gH = layout.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    const globalBounds = { w: gW, h: gH };
    const unsatisfied = [];
    const subjectAnyGroups = new Map(); // subjectGroupId -> { rule, satisfied, roomIds }
    const requiredConnectPairs = collectRequiredConnectPairs(modulesMap);
    const requiredFarPairs = collectRequiredFarPairs(modulesMap);

    for (const room of layout) {
        const mod = modulesMap[room.id];
        if (!mod?.rules) {
            continue;
        }
        for (const rule of mod.rules) {
            if (!rule.required) {
                continue;
            }
            const effectiveRule = removeRequiredConnectConflicts(rule, room.id, requiredConnectPairs);
            if (!effectiveRule) {
                continue;
            }

            if (effectiveRule.subjectAny && effectiveRule.subjectGroupId !== undefined) {
                if (!subjectAnyGroups.has(effectiveRule.subjectGroupId)) {
                    subjectAnyGroups.set(effectiveRule.subjectGroupId, {
                        rule: effectiveRule,
                        satisfied: false,
                        roomIds: [],
                    });
                }
                const group = subjectAnyGroups.get(effectiveRule.subjectGroupId);
                group.roomIds.push(room.id);
                if (isRuleSatisfied(effectiveRule, room, layoutMap, globalBounds)) {
                    group.satisfied = true;
                }
            } else {
                if (!isRuleSatisfied(effectiveRule, room, layoutMap, globalBounds)) {
                    const violation = {
                        roomId: room.id,
                        type: effectiveRule.type,
                        target: effectiveRule.target,
                        dir: effectiveRule.dir,
                    };
                    if (effectiveRule.type === "connect"
                        && (Array.isArray(effectiveRule.target) ? effectiveRule.target : [effectiveRule.target])
                            .some(target => {
                                const pair = requiredConnectPairKey(room.id, target);
                                return requiredConnectPairs.has(pair) && requiredFarPairs.has(pair);
                            })) {
                        violation.connectFarConflict = true;
                    }
                    unsatisfied.push(violation);
                }
            }
        }
    }

    for (const group of subjectAnyGroups.values()) {
        if (!group.satisfied) {
            const { rule } = group;
            unsatisfied.push({
                roomId: group.roomIds[0],
                type: rule.type,
                target: rule.target,
                dir: rule.dir,
                subjectAny: true,
            });
        }
    }

    return unsatisfied;
}

const subjectAnyMinMap = new Map();

/**
 * Phase 3: Augmented Cost Function (Topological Penalties)
 */
function calculateTopologicalPenalties(layout, modulesMap, globalBounds, config = {}, connectWeightMultiplier = 1, uwm = 1, layoutMap = null, phantoms = []) {
    let rootW, rootH;
    let cfg = config;
    let cwm = connectWeightMultiplier;
    let u = uwm;
    let lMap = layoutMap;
    let phs = phantoms;

    if (globalBounds && typeof globalBounds === "object") {
        rootW = globalBounds.w;
        rootH = globalBounds.h;
    } else {
        rootW = globalBounds;
        rootH = arguments[3];
        cfg = arguments[4] || {};
        cwm = arguments[5] !== undefined ? arguments[5] : 1;
        u = arguments[6] !== undefined ? arguments[6] : 1;
        lMap = arguments[7];
        phs = arguments[8] || [];
    }

    let penalty = 0;
    const canvasDiagSq = rootW * rootW + rootH * rootH;
    const canvasDiag = Math.sqrt(canvasDiagSq);

    if (!lMap) {
        lMap = {};
        for (let i = 0; i < layout.length; i++) {
            lMap[layout[i].id] = layout[i];
        }
    }
    for (let i = 0; i < phs.length; i++) {
        const p = phs[i];
        if (!lMap[p.id]) {
            lMap[p.id] = p;
        }
    }

    subjectAnyMinMap.clear();
    let connectionsMap = null;
    let hasCwc = false;

    for (let i = 0; i < layout.length; i++) {
        const room = layout[i];
        const mod = modulesMap[room.id];

        if ((mod?.cwc || cfg.cwc || 0) > 0) {
            hasCwc = true;
            break;
        }
    }

    if (hasCwc) {
        connectionsMap = new Map();
        const byX = new Map();
        const byY = new Map();

        for (let i = 0; i < layout.length; i++) {
            const r = layout[i];
            connectionsMap.set(r.id, 0);

            let arrX = byX.get(r.x);

            if (!arrX) {
                arrX = [];
                byX.set(r.x, arrX);
            }

            arrX.push(r);

            let arrY = byY.get(r.y);

            if (!arrY) {
                arrY = [];
                byY.set(r.y, arrY);
            }

            arrY.push(r);
        }

        for (let i = 0; i < layout.length; i++) {
            const room = layout[i];
            const rightCandidates = byX.get(room.x + room.w);

            if (rightCandidates) {
                for (let j = 0; j < rightCandidates.length; j++) {
                    const B = rightCandidates[j];
                    const verticalOverlap = Math.max(0, Math.min(room.y + room.h, B.y + B.h) - Math.max(room.y, B.y));

                    if (verticalOverlap > 0) {
                        connectionsMap.set(room.id, connectionsMap.get(room.id) + 1);
                        connectionsMap.set(B.id, connectionsMap.get(B.id) + 1);
                    }
                }
            }

            const bottomCandidates = byY.get(room.y + room.h);

            if (bottomCandidates) {
                for (let j = 0; j < bottomCandidates.length; j++) {
                    const B = bottomCandidates[j];
                    const horizontalOverlap = Math.max(0, Math.min(room.x + room.w, B.x + B.w) - Math.max(room.x, B.x));

                    if (horizontalOverlap > 0) {
                        connectionsMap.set(room.id, connectionsMap.get(room.id) + 1);
                        connectionsMap.set(B.id, connectionsMap.get(B.id) + 1);
                    }
                }
            }
        }
    }

    for (let i = 0; i < layout.length; i++) {
        const room = layout[i];
        const mod = modulesMap[room.id];

        const cwc = mod?.cwc || cfg.cwc || 0;
        if (cwc > 0) {
            const connections = connectionsMap.get(room.id) || 0;
            if (connections < cwc) {
                penalty += (cwc - connections) * PENALTIES.CONNECT_BASE * cwm;
            }
        }

        if (!mod || !mod.rules) {
            continue;
        }

        for (let j = 0; j < mod.rules.length; j++) {
            const rule = mod.rules[j];
            const p = calculateRulePenalty(room, rule, mod, lMap, rootW, rootH, cfg, cwm, u, canvasDiagSq, canvasDiag);

            if (rule.subjectAny && rule.subjectGroupId !== undefined) {
                const prev = subjectAnyMinMap.get(rule.subjectGroupId);
                if (prev === undefined || p < prev) {
                    subjectAnyMinMap.set(rule.subjectGroupId, p);
                }
            } else {
                penalty += p;
            }
        }
    }

    for (const p of subjectAnyMinMap.values()) {
        penalty += p;
    }

    return penalty;
}

function normalizedRuleCopy(rule) {
    const target = rule.target === undefined || Array.isArray(rule.target) ? rule.target : [rule.target];
    const dir = rule.dir === undefined || Array.isArray(rule.dir)
        ? rule.dir
        : (typeof rule.dir === "string" ? rule.dir.split(" ") : []);
    if (target === rule.target && dir === rule.dir) {
        return rule;
    }
    return { ...rule, target, dir };
}

function formatRuleText(subjects, rule) {
    const subjectText = rule.subjectAny
        ? `any [${subjects.join(", ")}]`
        : subjects[0];
    let relationship;
    if (rule.type === "enclosed") {
        relationship = "enclosed";
    } else if (rule.type === "at" || rule.type === "not_at") {
        const verb = rule.type === "not_at" ? "not at" : "at";
        relationship = `${verb} ${(rule.dir ?? []).join(" ")}`;
    } else {
        const targets = rule.target ?? [];
        const targetText = targets.length === 1 ? targets[0] : `[${targets.join(", ")}]`;
        relationship = `${rule.type}${rule.any ? " any" : ""} ${targetText}`;
    }

    const options = [];
    if (rule.weight !== undefined && rule.weight !== 1) {
        options.push(`weight=${rule.weight}`);
    }
    if (rule.cwl !== undefined) {
        options.push(`cwl=${rule.cwl}`);
    }
    if (rule.required) {
        options.push("required");
    }
    return `${subjectText} ${relationship}${options.length ? ` ${options.join(" ")}` : ""}`;
}

function ruleReportOrigin(rule) {
    if (rule.reportOrigin) {
        return rule.reportOrigin;
    }
    if (rule.insideFrontage) {
        return "derived-inside-frontage";
    }
    return "dsl";
}

function ruleReportParticipants(subjects, rule) {
    return [...new Set([...subjects, ...(rule.target ?? [])])].sort();
}

function farthestScopeCornerDistance(target, scopeW, scopeH) {
    return Math.max(
        Math.hypot(target.centerX, target.centerY),
        Math.hypot(scopeW - target.centerX, target.centerY),
        Math.hypot(target.centerX, scopeH - target.centerY),
        Math.hypot(scopeW - target.centerX, scopeH - target.centerY),
    );
}

function requiredFarPenaltyDecomposition(room, rule, layoutMap, scopeW, scopeH, phantomIds, penalty) {
    if (rule.type !== "far" || !rule.required) {
        return null;
    }

    const canvasDiagonal = Math.hypot(scopeW, scopeH);
    const subjectIsBounded = Number.isFinite(room.centerX) && Number.isFinite(room.centerY)
        && room.centerX >= 0 && room.centerX <= scopeW
        && room.centerY >= 0 && room.centerY <= scopeH;
    if (!(canvasDiagonal > 0) || !subjectIsBounded) {
        return null;
    }

    const floorTerms = [];
    for (const targetId of rule.target ?? []) {
        const target = layoutMap[targetId];
        if (!target) {
            continue;
        }

        const targetIsPhantom = phantomIds.has(targetId);
        const targetIsBounded = Number.isFinite(target.centerX) && Number.isFinite(target.centerY)
            && target.centerX >= 0 && target.centerX <= scopeW
            && target.centerY >= 0 && target.centerY <= scopeH;
        if (!Number.isFinite(target.centerX) || !Number.isFinite(target.centerY)) {
            return null;
        }
        if (!targetIsPhantom && !targetIsBounded) {
            return null;
        }

        floorTerms.push({
            target: targetId,
            centerDistance: Math.hypot(room.centerX - target.centerX, room.centerY - target.centerY),
            maximumCenterDistance: targetIsPhantom
                ? farthestScopeCornerDistance(target, scopeW, scopeH)
                : canvasDiagonal,
            maximumDistanceBasis: targetIsPhantom
                ? "farthest-scope-corner-from-fixed-external-target"
                : "scope-canvas-diagonal",
        });
    }
    if (!floorTerms.length) {
        return null;
    }

    const requiredWeight = effectiveRuleWeight(rule, 1);
    const floors = floorTerms.map(term => requiredWeight * PENALTIES.CONNECT_BASE
        / (1 + term.maximumCenterDistance / canvasDiagonal));
    const irreduciblePenalty = rule.any ? Math.min(...floors) : floors.reduce((sum, floor) => sum + floor, 0);
    if (penalty + GEOMETRY_EPSILON < irreduciblePenalty) {
        return null;
    }

    return {
        mode: "required-inverse-distance-floor",
        penaltyFormula: "requiredWeight * 1000000 / (1 + centerDistance / canvasDiagonal)",
        aggregation: rule.any ? "minimum-over-resolved-targets" : "sum-over-resolved-targets",
        distanceBasis: "room-center-to-target-center",
        boundedSubjectAssumption: "subject center lies within scope bounds",
        requiredWeight,
        penaltyScale: PENALTIES.CONNECT_BASE,
        canvasDiagonal,
        resolvedTargetCount: floorTerms.length,
        floorTerms,
        irreduciblePenalty,
        reduciblePenalty: penalty - irreduciblePenalty,
    };
}

function calculateRuleScores(layout, modulesMap, globalBounds, config = {}, totalCost = 0, topologicalPenalty = 0, phantoms = []) {
    const rootW = globalBounds.w;
    const rootH = globalBounds.h;
    const canvasDiagSq = rootW * rootW + rootH * rootH;
    const canvasDiag = Math.sqrt(canvasDiagSq);
    const layoutMap = Object.fromEntries(layout.map(room => [room.id, room]));
    const phantomIds = new Set(phantoms.map(phantom => phantom.id));
    for (const phantom of phantoms) {
        if (!layoutMap[phantom.id]) {
            layoutMap[phantom.id] = phantom;
        }
    }

    const requiredConnectPairs = collectRequiredConnectPairs(modulesMap);
    const entries = [];
    const subjectAnyGroups = new Map();
    const modules = Object.values(modulesMap);

    for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
        const mod = modules[moduleIndex];
        const room = layoutMap[mod.id];
        if (!room) {
            continue;
        }
        for (let ruleIndex = 0; ruleIndex < (mod.rules ?? []).length; ruleIndex++) {
            const rule = normalizedRuleCopy(mod.rules[ruleIndex]);
            const penalty = calculateRulePenalty(room, rule, mod, layoutMap, rootW, rootH, config, 1, 1, canvasDiagSq, canvasDiag);
            const farPenaltyDecomposition = requiredFarPenaltyDecomposition(
                room,
                rule,
                layoutMap,
                rootW,
                rootH,
                phantomIds,
                penalty,
            );
            const effectiveRule = rule.required
                ? removeRequiredConnectConflicts(rule, room.id, requiredConnectPairs)
                : rule;
            const verdictRule = effectiveRule?.type === "connect" && effectiveRule.cwl === undefined && config.cwl !== undefined
                ? { ...effectiveRule, cwl: config.cwl }
                : effectiveRule;
            const satisfied = verdictRule
                ? isRuleSatisfied(verdictRule, room, layoutMap, globalBounds)
                : null;

            if (rule.subjectAny && rule.subjectGroupId !== undefined) {
                let group = subjectAnyGroups.get(rule.subjectGroupId);
                if (!group) {
                    group = {
                        id: `group:${rule.subjectGroupId}`,
                        text: "",
                        subjects: [],
                        participants: [],
                        type: rule.type,
                        required: !!rule.required,
                        satisfied: false,
                        penalty: Infinity,
                        percentOfTotal: 0,
                        origin: ruleReportOrigin(rule),
                        rule,
                        hasEffectiveVerdict: false,
                    };
                    subjectAnyGroups.set(rule.subjectGroupId, group);
                    entries.push(group);
                }
                group.subjects.push(room.id);
                if (penalty < group.penalty) {
                    group.penalty = penalty;
                    if (farPenaltyDecomposition) {
                        group.farPenaltyDecomposition = farPenaltyDecomposition;
                    } else {
                        delete group.farPenaltyDecomposition;
                    }
                }
                if (satisfied !== null) {
                    group.hasEffectiveVerdict = true;
                    group.satisfied ||= satisfied;
                }
                continue;
            }

            const entry = {
                id: `rule:${moduleIndex}:${ruleIndex}`,
                text: formatRuleText([room.id], rule),
                subjects: [room.id],
                participants: ruleReportParticipants([room.id], rule),
                type: rule.type,
                required: !!rule.required,
                satisfied,
                penalty,
                percentOfTotal: totalCost > 0 ? penalty / totalCost * 100 : 0,
                origin: ruleReportOrigin(rule),
            };
            if (farPenaltyDecomposition) {
                entry.farPenaltyDecomposition = farPenaltyDecomposition;
            }
            entries.push(entry);
        }
    }

    for (const group of subjectAnyGroups.values()) {
        group.text = formatRuleText(group.subjects, group.rule);
        group.participants = ruleReportParticipants(group.subjects, group.rule);
        group.penalty = group.penalty === Infinity ? 0 : group.penalty;
        group.percentOfTotal = totalCost > 0 ? group.penalty / totalCost * 100 : 0;
        if (!group.hasEffectiveVerdict) {
            group.satisfied = null;
        }
        delete group.rule;
        delete group.hasEffectiveVerdict;
    }

    const reportedPenalty = entries.reduce((sum, entry) => sum + entry.penalty, 0);
    const unreported = topologicalPenalty - reportedPenalty;
    return {
        totalCost,
        topologicalPenalty,
        reportedPenalty,
        unreportedTopologicalPenalty: Math.abs(unreported) < 1e-6 ? 0 : unreported,
        weightSemantics: advisoryWeightSemantics(),
        rules: entries,
    };
}

/**
 * Phase 1.5: Fast-Fail Topological Boundary Check on built tree.
 * Replaces NPE re-traversal — reuses the tree already built in evaluateCost.
 */
function checkBoundariesOnTree(node, north, south, east, west, modulesMap) {
    if (north && typeof north === "object") {
        // Old signature compatibility: checkBoundariesOnTree(node, boundaries, modulesMap)
        const boundaries = north;
        const modMap = south;
        return checkBoundariesOnTree(node, boundaries.north, boundaries.south, boundaries.east, boundaries.west, modMap);
    }

    if (node.type === "leaf") {
        const mod = modulesMap[node.id];
        if (mod?.rules) {
            for (let i = 0; i < mod.rules.length; i++) {
                const rule = mod.rules[i];
                if (rule.type !== "at" || !rule.required) {
                    continue;
                }
                const dirs = rule.dir ?? [];
                for (let j = 0; j < dirs.length; j++) {
                    const dir = dirs[j];
                    if (dir === "north" && !north) {
                        return false;
                    }
                    if (dir === "south" && !south) {
                        return false;
                    }
                    if (dir === "east" && !east) {
                        return false;
                    }
                    if (dir === "west" && !west) {
                        return false;
                    }
                    if (dir === "edge" && !(north || south || east || west)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    let leftRes;
    if (node.type === "H") {
        leftRes = checkBoundariesOnTree(node.left, north, false, east, west, modulesMap);
        if (!leftRes) {
            return false;
        }
        return checkBoundariesOnTree(node.right, false, south, east, west, modulesMap);
    } else {
        leftRes = checkBoundariesOnTree(node.left, north, south, false, west, modulesMap);
        if (!leftRes) {
            return false;
        }
        return checkBoundariesOnTree(node.right, north, south, east, false, modulesMap);
    }
}

/**
 * Linear-time vertical shape-curve merge.
 */
function mergeVerticalLinear(L, R) {
    const result = [];
    let li = 0;
    let ri = 0;

    while (li < L.length && ri < R.length) {
        const l = L[li];
        const r = R[ri];
        const w = l.w + r.w;
        const h = Math.max(l.h, r.h);
        result.push({
            w: w,
            h: h,
            leftShape: l,
            rightShape: r,
        });

        if (l.h > r.h) {
            li++;
        } else if (l.h < r.h) {
            ri++;
        } else {
            li++;
            ri++;
        }
    }

    return pruneCurve(result);
}

/**
 * Merges two child curves under H/V operator and prunes to Pareto front.
 * Uses Stockmeyer's linear-time merge algorithm.
 */
function mergeShapes(leftCurve, rightCurve, op) {
    if (op === "V") {
        return mergeVerticalLinear(leftCurve, rightCurve);
    }

    const L_swapped = leftCurve.map(c => ({ w: c.h, h: c.w, original: c })).reverse();
    const R_swapped = rightCurve.map(c => ({ w: c.h, h: c.w, original: c })).reverse();
    const merged_swapped = mergeVerticalLinear(L_swapped, R_swapped);
    const merged = merged_swapped.map(c => ({
        w: c.h,
        h: c.w,
        leftShape: c.leftShape.original,
        rightShape: c.rightShape.original,
    })).reverse();

    return pruneCurve(merged);
}

/**
 * Bottom-up Stockmeyer shape-curve build over the full NPE.
 * Returns { tree, positionMap }: positionMap[i] is the node created at NPE position i.
 */
function buildTreeFresh(npe, modulesMap) {
    const stack = [];
    const positionMap = new Array(npe.length);
    for (let i = 0; i < npe.length; i++) {
        const item = npe[i];
        let node;
        if (isOperand(item)) {
            const curve = modulesMap[item].curve.map(c => ({ w: c.w, h: c.h, id: item }));
            node = { type: "leaf", id: item, curve, npePos: i };
        } else {
            const right = stack.pop();
            const left = stack.pop();
            node = {
                type: item,
                left,
                right,
                curve: mergeShapes(left.curve, right.curve, item),
                npePos: i,
            };
        }
        positionMap[i] = node;
        stack.push(node);
    }
    return { tree: stack[0], positionMap };
}

/**
 * Incremental shape-curve rebuild. Reuses cached subtrees whose descendants are unaffected.
 *
 * `dirtyPositions` lists NPE indices whose content was directly mutated by the move:
 *   - M1 (operand-operand swap): the two swapped indices.
 *   - M2 (operator chain complement): every flipped operator index.
 *   - M3 (operand-operator swap): the two swapped indices.
 *   - M4 (long-range operand swap): the two swapped indices.
 *
 * A node is rebuilt if its NPE position is in dirty, OR any descendant is dirty (curve changes
 * propagate up). Otherwise the cached node from prevPositionMap is reused by reference.
 *
 * Reuse safety: when both popped children at NPE position j are non-dirty, they are cached
 * references that match what the previous tree popped at j (stack depth and unchanged-NPE
 * tail guarantee identity), so prevPositionMap[j] is structurally equivalent and reusable.
 */
function buildTreeIncremental(prevPositionMap, npe, dirtyPositions, modulesMap) {
    const dirty = new Set(dirtyPositions);
    const stack = [];
    const dirtyStack = [];
    const positionMap = new Array(npe.length);

    for (let i = 0; i < npe.length; i++) {
        const item = npe[i];
        let node, nodeDirty;

        if (isOperand(item)) {
            if (dirty.has(i)) {
                const curve = modulesMap[item].curve.map(c => ({ w: c.w, h: c.h, id: item }));
                node = { type: "leaf", id: item, curve, npePos: i };
                nodeDirty = true;
            } else {
                node = prevPositionMap[i];
                nodeDirty = false;
            }
        } else {
            const right = stack.pop();
            const left = stack.pop();
            const rightDirty = dirtyStack.pop();
            const leftDirty = dirtyStack.pop();
            const childDirty = leftDirty || rightDirty;
            if (dirty.has(i) || childDirty) {
                node = {
                    type: item,
                    left,
                    right,
                    curve: mergeShapes(left.curve, right.curve, item),
                    npePos: i,
                };
                nodeDirty = true;
            } else {
                node = prevPositionMap[i];
                nodeDirty = false;
            }
        }
        positionMap[i] = node;
        stack.push(node);
        dirtyStack.push(nodeDirty);
    }
    return { tree: stack[0], positionMap };
}

/**
 * Evaluates the Floorplan Cost.
 * Performs a bottom-up Stockmeyer shape curve merge and top-down coordinate assignment.
 *
 * Optional `treeBundle` ({tree, positionMap}) lets callers reuse a pre-built tree (e.g. from
 * incremental rebuild). When omitted, a fresh tree is built from `npe`.
 */
/**
 * O(1) part of evaluateLayoutCost (area + aspectPenalty + canvasPenalty). Both
 * topologicalPenalty and roomPenalty are non-negative, so this is a valid lower
 * bound on the full cost — lets evaluateCost's rootShape sweep skip a shape
 * without assigning coordinates or running the topological/room passes.
 */
function computeBaseCost(rootW, rootH, config, cwm) {
    const canvasW = config.canvasW || 500;
    const canvasH = config.canvasH || 500;
    const canvasTargetDiagSq = canvasW * canvasW + canvasH * canvasH;

    const area = rootW * rootH;
    const aspect = Math.max(rootW / rootH, rootH / rootW);
    const aspectPenalty = aspect > 2.0 ? (aspect - 2.0) * PENALTIES.ASPECT : 0;

    const overW = Math.max(0, rootW - canvasW);
    const overH = Math.max(0, rootH - canvasH);
    const canvasPenalty = ((overW * overW + overH * overH) / canvasTargetDiagSq) * PENALTIES.CANVAS * cwm;

    return { area, aspectPenalty, canvasPenalty, total: area + aspectPenalty + canvasPenalty };
}

function effectiveRoomGeometryLimits(roomModule, config = {}) {
    return {
        ratioMax: roomModule.ratio ? Infinity : (roomModule.ratioMax || config.ratioMax || 3.0),
        sideMin: roomModule.sideMin || (!config.sideMinFlexible && config.sideMin) || 0,
    };
}

function calculateRoomGeometryPenalty(room, roomModule, config = {}, cwm = 1) {
    let penalty = 0;
    const roomArea = room.w * room.h;
    if (roomModule.area) {
        penalty += Math.abs(roomArea - roomModule.area) * PENALTIES.AREA_MISFIT;
    }

    const { ratioMax, sideMin } = effectiveRoomGeometryLimits(roomModule, config);
    const roomAspect = Math.max(room.w / room.h, room.h / room.w);
    const aspectExcess = Math.max(0, roomAspect - ratioMax);
    penalty += (aspectExcess + aspectExcess * aspectExcess) * PENALTIES.ROOM_ASPECT;

    if (sideMin > 0) {
        const shortWidthRatio = Math.max(0, sideMin - room.w) / sideMin;
        const shortHeightRatio = Math.max(0, sideMin - room.h) / sideMin;
        penalty += (
            shortWidthRatio + shortWidthRatio * shortWidthRatio
            + shortHeightRatio + shortHeightRatio * shortHeightRatio
        ) * PENALTIES.SIDE_MIN;
    }

    return penalty * cwm;
}

function countDeliveredGeometryViolations(layout, modulesMap, config = {}) {
    let violations = 0;
    for (const room of layout) {
        const roomModule = modulesMap[room.id];
        if (!roomModule) {
            continue;
        }
        const { ratioMax, sideMin } = effectiveRoomGeometryLimits(roomModule, config);
        const aspect = Math.max(room.w / room.h, room.h / room.w);
        const violatesAspect = aspect > ratioMax + GEOMETRY_EPSILON;
        const violatesSideMin = Math.min(room.w, room.h) < sideMin - GEOMETRY_EPSILON;
        if (violatesAspect || violatesSideMin) {
            violations++;
        }
    }
    return violations;
}

/**
 * Score a fully-assigned layout against the cost function. Used both inside the
 * rootShape sweep and by the post-SA slack-redistribution check.
 * `rootW, rootH` are the outer bounds the layout fills (rootShape for SA picks,
 * canvas for redistributed layouts).
 */
function evaluateLayoutCost(layout, rootW, rootH, modulesMap, config = {}, cwm = 1, uwm = 1, phantoms = [], layoutMap = null, onlyTotal = false) {
    const { area, aspectPenalty, canvasPenalty } = computeBaseCost(rootW, rootH, config, cwm);

    let lMap = layoutMap;
    if (!lMap) {
        lMap = {};
        for (let i = 0; i < layout.length; i++) {
            lMap[layout[i].id] = layout[i];
        }
    }
    const topologicalPenalty = calculateTopologicalPenalties(layout, modulesMap, rootW, rootH, config, cwm, uwm, lMap, phantoms);

    let roomPenalty = 0;
    for (let i = 0; i < layout.length; i++) {
        const room = layout[i];
        const m = modulesMap[room.id];
        if (!m) {
            continue;
        }
        roomPenalty += calculateRoomGeometryPenalty(room, m, config, cwm);
    }

    const total = area + aspectPenalty + canvasPenalty + topologicalPenalty + roomPenalty;
    if (onlyTotal) {
        return total;
    }
    return { total, area, aspectPenalty, canvasPenalty, topologicalPenalty, roomPenalty };
}

function evaluateCost(npe, modulesMap, config = {}, connectWeightMultiplier = 1, treeBundle = null, uwm = 1, hasAtRules = true, phantoms = [], layoutArray = null, layoutMap = null) {
    if (!treeBundle) {
        treeBundle = buildTreeFresh(npe, modulesMap);
    }
    const rootNode = treeBundle.tree;
    const positionMap = treeBundle.positionMap;
    const rootCurve = rootNode.curve;

    // Boundary check on tree — replaces separate passesTopologicalBoundaryCheck NPE traversal
    let boundaryValid = true;
    if (hasAtRules) {
        boundaryValid = checkBoundariesOnTree(rootNode, true, true, true, true, modulesMap);
    }

    // Objective Cost Function: evaluate all possible root shapes and pick the best one.
    // Strict canvas: score the layout that ships. The post-SA stretch fills the *full*
    // canvas, so the scored geometry has to be that same stretch — clamping per axis
    // (min(shape.w, canvasW)) scored room proportions the delivered layout never has,
    // which let ratio_max/side_min violations ship unpaid. area/aspect/overflow then
    // collapse to constants across overflowing shapes; that is correct, not a loss —
    // under a fixed canvas, bounding-box compactness is not an objective.
    let bestCost = Infinity;
    let bestRootShape = null;

    const strictCanvas = config.canvasW && config.canvasH && !config.canvasFlexible;
    const canvasW = config.canvasW;
    const canvasH = config.canvasH;

    if (layoutArray && layoutMap) {
        for (let i = 0; i < rootCurve.length; i++) {
            const rootShape = rootCurve[i];
            const compress = strictCanvas && (rootShape.w > canvasW || rootShape.h > canvasH);
            const scoreW = compress ? canvasW : rootShape.w;
            const scoreH = compress ? canvasH : rootShape.h;
            if (computeBaseCost(scoreW, scoreH, config, connectWeightMultiplier).total >= bestCost) {
                continue;
            }
            assignCoordinatesInPlace(rootNode, rootShape, 0, 0, compress ? scoreW : undefined, compress ? scoreH : undefined, layoutMap);
            const cost = evaluateLayoutCost(layoutArray, scoreW, scoreH, modulesMap, config, connectWeightMultiplier, uwm, phantoms, layoutMap, true);
            if (cost < bestCost) {
                bestCost = cost;
                bestRootShape = rootShape;
            }
        }
    } else {
        for (let i = 0; i < rootCurve.length; i++) {
            const rootShape = rootCurve[i];
            const compress = strictCanvas && (rootShape.w > canvasW || rootShape.h > canvasH);
            const scoreW = compress ? canvasW : rootShape.w;
            const scoreH = compress ? canvasH : rootShape.h;
            if (computeBaseCost(scoreW, scoreH, config, connectWeightMultiplier).total >= bestCost) {
                continue;
            }
            const layout = compress
                ? assignCoordinates(rootNode, rootShape, 0, 0, scoreW, scoreH)
                : assignCoordinates(rootNode, rootShape, 0, 0);
            const cost = evaluateLayoutCost(layout, scoreW, scoreH, modulesMap, config, connectWeightMultiplier, uwm, phantoms).total;
            if (cost < bestCost) {
                bestCost = cost;
                bestRootShape = rootShape;
            }
        }
    }

    return {
        cost: bestCost,
        rootNode,
        bestShape: bestRootShape,
        valid: boundaryValid,
        positionMap,
    };
}

function mulberry32(a) {
    return function() {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function buildLinearFallback(modules) {
    const npe = [modules[0].id, modules[1].id, "V"];
    for (let i = 2; i < modules.length; i++) {
        npe.push(modules[i].id, i % 2 === 0 ? "H" : "V");
    }
    return npe;
}

// Recursively bisect an ordered id list into a postorder NPE.
// Alternates operators each depth level starting from baseOp at depth 0.
function orderedToNpe(ids, depth = 0, baseOp = "V") {
    if (ids.length === 1) {
        return [ids[0]];
    }
    const mid = Math.ceil(ids.length / 2);
    const left = orderedToNpe(ids.slice(0, mid), depth + 1, baseOp);
    const right = orderedToNpe(ids.slice(mid), depth + 1, baseOp);
    const op = depth % 2 === 0 ? baseOp : (baseOp === "V" ? "H" : "V");
    return [...left, ...right, op];
}

// Builds a set of initial NPE candidates informed by at-rules and connect topology.
// Returns only valid NPEs (passes isValidNPE). Caller evaluates and picks best.
function buildInitialCandidates(modules, modulesMap, randomFn) {
    // Directional poles from at-rules
    const poles = { north: new Set(), south: new Set(), east: new Set(), west: new Set() };
    for (const m of modules) {
        for (const rule of m.rules ?? []) {
            if (rule.type !== "at") {
                continue;
            }
            const dirs = rule.dir ?? [];
            for (const dir of dirs) {
                if (dir in poles) {
                    poles[dir].add(m.id);
                }
            }
        }
    }

    // Connect adjacency (undirected) and degree for hub detection
    const adj = new Map();
    const deg = new Map();
    for (const m of modules) {
        adj.set(m.id, []);
        deg.set(m.id, 0);
    }
    for (const m of modules) {
        for (const rule of m.rules ?? []) {
            if (rule.type !== "connect") {
                continue;
            }
            const targets = rule.target ?? [];
            for (const t of targets) {
                if (!adj.has(t)) {
                    continue;
                }
                adj.get(m.id).push(t);
                adj.get(t).push(m.id);
                deg.set(m.id, (deg.get(m.id) || 0) + 1);
                deg.set(t, (deg.get(t) || 0) + 1);
            }
        }
    }

    let hub = null, maxDeg = 2;
    for (const [id, d] of deg) {
        if (d > maxDeg) {
            maxDeg = d;
            hub = id;
        }
    }

    // BFS order seeded from hub (or first module)
    const startId = hub ?? modules[0].id;
    const bfsOrder = [];
    const visited = new Set([startId]);
    const queue = [startId];
    while (queue.length > 0) {
        const cur = queue.shift();
        bfsOrder.push(cur);
        for (const nb of adj.get(cur) ?? []) {
            if (!visited.has(nb)) {
                visited.add(nb);
                queue.push(nb);
            }
        }
    }
    for (const m of modules) {
        if (!visited.has(m.id)) {
            bfsOrder.push(m.id);
        }
    }

    // Determine primary cut axis from pole counts
    const nsWeight = poles.north.size + poles.south.size;
    const ewWeight = poles.east.size + poles.west.size;
    const baseOp = (nsWeight >= ewWeight && nsWeight > 0) ? "H" : "V";
    const altOp = baseOp === "V" ? "H" : "V";

    // Split ids into pole buckets; rooms in both opposite poles go to neutral
    function splitBuckets(order) {
        const isFirst = id => baseOp === "H" ? poles.north.has(id) : poles.west.has(id);
        const isLast = id => baseOp === "H" ? poles.south.has(id) : poles.east.has(id);
        const first = [], neutral = [], last = [];
        for (const id of order) {
            const f = isFirst(id), l = isLast(id);
            if (f && !l) {
                first.push(id);
            } else if (l && !f) {
                last.push(id);
            } else {
                neutral.push(id);
            }
        }
        return { first, neutral, last };
    }

    function poleSorted(order) {
        const { first, neutral, last } = splitBuckets(order);
        return [...first, ...neutral, ...last];
    }

    function shuffleNeutral(order) {
        const { first, neutral, last } = splitBuckets(order);
        const m = [...neutral];
        for (let i = m.length - 1; i > 0; i--) {
            const j = Math.floor(randomFn() * (i + 1));
            [m[i], m[j]] = [m[j], m[i]];
        }
        return [...first, ...m, ...last];
    }

    const poleOrder = poleSorted(bfsOrder);
    const raw = [
        orderedToNpe(poleOrder, 0, baseOp),
        orderedToNpe(bfsOrder, 0, baseOp),
        orderedToNpe(bfsOrder, 0, altOp),
        orderedToNpe(shuffleNeutral(bfsOrder), 0, baseOp),
        orderedToNpe(shuffleNeutral(bfsOrder), 0, baseOp),
        orderedToNpe(shuffleNeutral(bfsOrder), 0, baseOp),
    ];

    if (hub !== null) {
        const rest = poleSorted(bfsOrder.filter(id => id !== hub));
        const restNpe = orderedToNpe(rest, 0, baseOp);
        raw.push([hub, ...restNpe, "V"]);
        raw.push([...restNpe, hub, "V"]);
    }

    // Deduplicate then drop invalid candidates
    const seen = new Set();
    const candidates = [];
    for (const c of raw) {
        const key = JSON.stringify(c);
        if (!seen.has(key)) {
            seen.add(key);
            if (isValidNPE(c)) {
                candidates.push(c);
            }
        }
    }
    return candidates;
}

function buildRuleIndex(modules) {
    const connectPairs = [];
    const farPairs = [];
    const polePrefs = new Map();
    const moduleIds = new Set(modules.map(module => module.id));
    for (const m of modules) {
        for (const r of m.rules ?? []) {
            if (r.type === "connect" || r.type === "far") {
                const targets = r.target ?? [];
                for (const t of targets) {
                    if (!moduleIds.has(t)) {
                        continue;
                    }
                    (r.type === "connect" ? connectPairs : farPairs).push({ a: m.id, b: t });
                }
            } else if (r.type === "at") {
                const dirs = r.dir ?? [];
                for (const d of dirs) {
                    if (d === "north" || d === "west") {
                        polePrefs.set(m.id, "first");
                    } else if (d === "south" || d === "east") {
                        polePrefs.set(m.id, "last");
                    }
                }
            }
        }
    }
    return { connectPairs, farPairs, polePrefs };
}

function applyGuidedMove(npe, randomFn, ruleIdx) {
    const operandIndex = id => npe.findIndex(c => isOperand(c) && c === id);
    const mid = Math.floor(npe.filter(isOperand).length / 2);

    const tries = [];
    if (ruleIdx.connectPairs.length) {
        tries.push("connect");
    }
    if (ruleIdx.polePrefs.size) {
        tries.push("pole");
    }
    if (!tries.length) {
        return null;
    }

    const which = tries[Math.floor(randomFn() * tries.length)];

    if (which === "connect") {
        const pair = ruleIdx.connectPairs[Math.floor(randomFn() * ruleIdx.connectPairs.length)];
        const ia = operandIndex(pair.a), ib = operandIndex(pair.b);
        if (ia < 0 || ib < 0 || Math.abs(ia - ib) <= 2) {
            return null;
        }
        const [hi, lo] = ia > ib ? [ia, ib] : [ib, ia];
        let j = hi - 1;
        while (j > lo && !isOperand(npe[j])) {
            j--;
        }
        if (j <= lo || !isOperand(npe[j])) {
            return null;
        }
        if (j !== hi - 1) {
            return null;
        }
        const tmp = npe[hi];
        npe[hi] = npe[j];
        npe[j] = tmp;
        return { type: "M1", positions: [j, hi] };
    }

    // pole branch
    const candidatesArr = [...ruleIdx.polePrefs.entries()].filter(([id, pref]) => {
        const pos = operandIndex(id);
        if (pos < 0) {
            return false;
        }
        const rank = npe.slice(0, pos + 1).filter(isOperand).length - 1;
        return (pref === "first" && rank > mid) || (pref === "last" && rank < mid);
    });
    if (!candidatesArr.length) {
        return null;
    }
    const [id, pref] = candidatesArr[Math.floor(randomFn() * candidatesArr.length)];
    const pos = operandIndex(id);
    const target = pref === "first" ? pos - 1 : pos + 1;
    if (target < 0 || target >= npe.length) {
        return null;
    }
    if (!isOperand(npe[target])) {
        return null;
    }
    const tmp = npe[pos];
    npe[pos] = npe[target];
    npe[target] = tmp;
    return { type: "M1", positions: [Math.min(pos, target), Math.max(pos, target)] };
}

// Web Worker fan-out is used only in a real browser main thread, or when a caller
// explicitly opts in (`forceWorkers`, e.g. bun end-to-end tests). `disableWorkers`
// (set on the config handed to a worker) prevents nested fan-out.
function _shouldUseWorkers(config) {
    if (config.disableWorkers) {
        return false;
    }
    if (config.forceWorkers) {
        return true;
    }
    return typeof Worker !== "undefined" && typeof document !== "undefined";
}

function _resolveOptimizerScriptUrl() {
    if (typeof document !== "undefined") {
        const el = document.querySelector('script[src*="sa_optimized"]');
        if (el?.src) {
            return el.src;
        }
        return new URL("sa_optimized.js", document.baseURI).href;
    }
    return _OPTIMIZER_MODULE_PATH;
}

function _createSaWorker() {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
    const worker = new Worker(url);
    worker._blobUrl = url;
    return worker;
}

// Run independent SA tasks across a worker pool, returning results in task order.
// Each task is one `_runWithRestarts` invocation; the worker runs it with workers
// disabled so nested fan-out never happens. Aborting terminates all workers.
function _runTasksInWorkers(tasks, signal) {
    return new Promise((resolve, reject) => {
        const scriptUrl = _resolveOptimizerScriptUrl();
        const results = new Array(tasks.length);
        const workers = [];
        let nextIdx = 0;
        let doneCount = 0;
        let settled = false;

        const finish = (fn, arg) => {
            if (settled) {
                return;
            }
            settled = true;
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            for (const w of workers) {
                w.terminate();
                URL.revokeObjectURL(w._blobUrl);
            }
            fn(arg);
        };

        const onAbort = () => finish(reject, new DOMException("Cancelled", "AbortError"));

        if (signal?.aborted) {
            return onAbort();
        }
        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        const dispatch = (worker) => {
            if (settled || nextIdx >= tasks.length) {
                return;
            }
            const idx = nextIdx++;
            worker._taskIdx = idx;
            const task = tasks[idx];
            worker.postMessage({
                scriptUrl,
                modules: task.modules,
                config: { ...task.config, disableWorkers: true, forceWorkers: false },
                phantoms: task.phantoms ?? [],
            });
        };

        const poolSize = Math.max(1, Math.min(tasks.length, WORKER_POOL_SIZE));
        for (let i = 0; i < poolSize; i++) {
            const worker = _createSaWorker();
            worker.onmessage = (e) => {
                if (settled) {
                    return;
                }
                const msg = e.data;
                if (!msg?.ok) {
                    return finish(reject, new Error("SA worker failed: " + (msg?.error ?? "unknown")));
                }
                results[worker._taskIdx] = msg.result;
                doneCount++;
                if (doneCount === tasks.length) {
                    return finish(resolve, results);
                }
                dispatch(worker);
            };
            worker.onerror = (err) => finish(reject, new Error("SA worker error: " + (err?.message ?? err)));
            workers.push(worker);
        }
        for (const worker of workers) {
            dispatch(worker);
        }
    });
}

async function _runWithRestarts(modules, config, signal, phantoms = []) {
    const restarts = Math.max(1, config.restarts ?? 1);
    if (restarts === 1 || modules.length <= 2) {
        return _runSingleSA(modules, config, signal, phantoms);
    }

    const baseSeed = config.seed ?? 0xDEADBEEF;
    const innerIter = Math.max(1, (config.iter ?? 1) / restarts);

    if (_shouldUseWorkers(config)) {
        const tasks = [];
        for (let r = 0; r < restarts; r++) {
            const innerCfg = { ...config, seed: baseSeed + r * 0x9E3779B1, iter: innerIter, restarts: 1 };
            tasks.push({ modules, config: innerCfg, phantoms });
        }
        const results = await _runTasksInWorkers(tasks, signal);
        let best = null;
        for (const result of results) {
            if (!best || result.cost < best.cost) {
                best = result;
            }
        }
        return best;
    }

    let best = null;
    for (let r = 0; r < restarts; r++) {
        const innerCfg = { ...config, seed: baseSeed + r * 0x9E3779B1, iter: innerIter };
        const result = await _runSingleSA(modules, innerCfg, signal, phantoms);
        if (signal?.aborted) {
            throw new DOMException("Cancelled", "AbortError");
        }
        if (!best || result.cost < best.cost) {
            best = result;
        }
    }
    return best;
}

// Replicate the required-retry loop's selection over precomputed, attempt-ordered
// results: preserve explicitly conflicted connections, then prefer fewest
// unsatisfied, fewest delivered-geometry violations, lowest cost, and lowest attempt index,
// and stop `SATISFIED_LOOKAHEAD` attempts after the first naturally-satisfied one
// (unsatisfied && !repaired). Fed the same deterministic per-seed results, this
// returns exactly what the sequential loop would.
function _selectRequiredBest(entries) {
    let best = null;
    let satisfiedAt = -1;

    for (let i = 0; i < entries.length; i++) {
        const { result, unsatisfied } = entries[i];
        if (!best || isPreferredRequiredAttempt(result, unsatisfied, best, best.unsatisfied)) {
            best = { ...result, unsatisfied };
        }
        if (satisfiedAt < 0 && unsatisfied.length === 0 && !result.repairAttempted) {
            satisfiedAt = i;
        }
        if (satisfiedAt >= 0 && i >= satisfiedAt + SATISFIED_LOOKAHEAD) {
            break;
        }
    }
    return best;
}

function requiredAttemptSelectionKey(result, unsatisfied) {
    const unsatisfiedRules = Array.isArray(unsatisfied) ? unsatisfied : [];
    const unsatisfiedCount = Array.isArray(unsatisfied) ? unsatisfied.length : unsatisfied;
    return [
        unsatisfiedRules.filter(rule => rule.connectFarConflict).length,
        unsatisfiedCount,
        result.geometryViolations ?? 0,
        result.cost,
    ];
}

function isPreferredRequiredAttempt(result, unsatisfied, bestResult, bestUnsatisfied) {
    const key = requiredAttemptSelectionKey(result, unsatisfied);
    const bestKey = requiredAttemptSelectionKey(bestResult, bestUnsatisfied);
    for (let i = 0; i < key.length; i++) {
        if (key[i] === bestKey[i]) {
            continue;
        }
        return key[i] < bestKey[i];
    }
    return false;
}

function collectOffendingIds(unsatisfied) {
    const ids = new Set();
    for (const u of unsatisfied) {
        ids.add(u.roomId);
        const targets = Array.isArray(u.target) ? u.target : (u.target !== undefined ? [u.target] : []);
        for (const t of targets) {
            ids.add(t);
        }
    }
    return ids;
}

/**
 * Enumerate operand-operand swaps where at least one endpoint is an offending
 * room. Swapping two operands never breaks NPE validity (balloting/skewed depend
 * only on the operand/operator pattern, which is unchanged), so every candidate
 * is a valid NPE relocating an offending room to another leaf slot.
 */
function offendingOperandSwaps(npe, offendingIds) {
    const operandPos = [];
    for (let i = 0; i < npe.length; i++) {
        if (isOperand(npe[i])) {
            operandPos.push(i);
        }
    }
    const swaps = [];
    for (let a = 0; a < operandPos.length; a++) {
        for (let b = a + 1; b < operandPos.length; b++) {
            const pa = operandPos[a];
            const pb = operandPos[b];
            if (!offendingIds.has(npe[pa]) && !offendingIds.has(npe[pb])) {
                continue;
            }
            if (npe[pa] === npe[pb]) {
                continue;
            }
            const cand = [...npe];
            const tmp = cand[pa];
            cand[pa] = cand[pb];
            cand[pb] = tmp;
            swaps.push(cand);
        }
    }
    return swaps;
}

/**
 * Enumerate M3 (operand-operator swap) candidates where the operand endpoint is
 * an offending room. Unlike operand swaps these change the tree nesting, so they
 * can move a room onto/off an edge — the structural lever positional rules need.
 * Validity mirrors applyM3 (balloting + skewed) so every candidate is a valid NPE.
 */
function offendingM3Swaps(npe, offendingIds) {
    const n = npe.length;
    const diffs = new Array(n);
    let diff = 0;
    for (let i = 0; i < n; i++) {
        diff += isOperand(npe[i]) ? 1 : -1;
        diffs[i] = diff;
    }

    const swaps = [];
    for (let i = 0; i < n - 1; i++) {
        const aIsOp = isOperand(npe[i]);
        const bIsOp = isOperand(npe[i + 1]);
        if (aIsOp === bIsOp) {
            continue;
        }
        const operandVal = aIsOp ? npe[i] : npe[i + 1];
        if (!offendingIds.has(operandVal)) {
            continue;
        }
        if (aIsOp) {
            if (diffs[i] <= 2) {
                continue;
            }
            if (i > 0 && isOperator(npe[i - 1]) && npe[i - 1] === npe[i + 1]) {
                continue;
            }
        } else if (i + 2 < n && isOperator(npe[i + 2]) && npe[i + 2] === npe[i]) {
            continue;
        }
        const cand = [...npe];
        const tmp = cand[i];
        cand[i] = cand[i + 1];
        cand[i + 1] = tmp;
        swaps.push(cand);
    }
    return swaps;
}

/**
 * Post-SA repair: bounded steepest-descent over single operand swaps and M3
 * swaps that touch an offending room, ranked by the required-attempt key.
 * Re-enumerates after each accepted move. Deterministic (no RNG) so satisfied
 * layouts are untouched. `finalizeNpe(npe)` returns { layout, cost, shape } or null.
 */
function repairRequiredLayout(best, finalizeNpe, modulesMap, maxMoves = REPAIR_MAX_MOVES, phantoms = []) {
    const before = checkRequiredSatisfied(best.layout, modulesMap, phantoms);
    if (before.length === 0) {
        return { ...best, attempted: false, unsatisfiedBefore: 0, unsatisfiedAfter: 0 };
    }

    let cur = best;
    let curUnsat = before;
    let budget = maxMoves;
    let improved = true;

    while (improved && curUnsat.length > 0 && budget > 0) {
        improved = false;
        const offendingIds = collectOffendingIds(curUnsat);
        const cands = offendingOperandSwaps(cur.npe, offendingIds)
            .concat(offendingM3Swaps(cur.npe, offendingIds))
            .filter(isValidNPE);

        let pickNpe = null;
        let pickLayout = null;
        let pickCost = cur.cost;
        let pickShape = null;
        let pickUnsat = curUnsat;
        let pickGeometryViolations = cur.geometryViolations ?? 0;

        for (const candNpe of cands) {
            if (budget-- <= 0) {
                break;
            }
            const cand = finalizeNpe(candNpe);
            if (!cand) {
                continue;
            }
            const candUnsat = checkRequiredSatisfied(cand.layout, modulesMap, phantoms);
            if (isPreferredRequiredAttempt(cand, candUnsat, {
                cost: pickCost,
                geometryViolations: pickGeometryViolations,
            }, pickUnsat)) {
                pickNpe = candNpe;
                pickLayout = cand.layout;
                pickCost = cand.cost;
                pickShape = cand.shape;
                pickUnsat = candUnsat;
                pickGeometryViolations = cand.geometryViolations ?? 0;
            }
        }

        if (pickNpe) {
            cur = {
                npe: pickNpe,
                layout: pickLayout,
                cost: pickCost,
                shape: pickShape,
                geometryViolations: pickGeometryViolations,
            };
            curUnsat = pickUnsat;
            improved = true;
        }
    }

    return { ...cur, attempted: true, unsatisfiedBefore: before.length, unsatisfiedAfter: curUnsat.length };
}

async function wongLiuSimulatedAnnealing(modules, config = {}, signal = null, phantoms = []) {
    // Deep clone modules and their nested properties (rules, curve) to prevent in-place mutation of parameters.
    const clonedModules = modules.map(m => {
        const cloned = { ...m };
        if (m.rules) {
            cloned.rules = m.rules.map(r => {
                const clonedRule = { ...r };
                if (r.target !== undefined) {
                    clonedRule.target = Array.isArray(r.target) ? [...r.target] : r.target;
                }
                if (r.dir !== undefined) {
                    clonedRule.dir = Array.isArray(r.dir) ? [...r.dir] : r.dir;
                }
                return clonedRule;
            });
        }
        if (m.curve) {
            cloned.curve = m.curve.map(c => ({ ...c }));
        }
        return cloned;
    });

    const hasRequired = clonedModules.some(m => m.rules?.some(r => r.required));
    let best;
    if (!hasRequired) {
        best = await _runWithRestarts(clonedModules, config, signal, phantoms);
        return attachRuleScores(best, clonedModules, config, phantoms);
    }

    const maxRetries = config.requiredMaxRetries ?? 10;
    const baseSeed = config.seed ?? 0xDEADBEEF;
    const modulesMap = Object.fromEntries(clonedModules.map(m => [m.id, m]));

    best = null;
    if (_shouldUseWorkers(config)) {
        const tasks = [];
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const attemptConfig = attempt === 0 ? config : {
                ...config,
                seed: baseSeed + attempt * 0x17A4B3C1,
            };
            tasks.push({ modules: clonedModules, config: attemptConfig, phantoms });
        }
        const results = await _runTasksInWorkers(tasks, signal);
        const entries = results.map(result => ({
            result,
            unsatisfied: checkRequiredSatisfied(result.layout, modulesMap, phantoms),
        }));
        best = _selectRequiredBest(entries);
    } else {
        let satisfiedAttempt = -1;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const attemptConfig = attempt === 0 ? config : {
                ...config,
                seed: baseSeed + attempt * 0x17A4B3C1,
            };
            const result = await _runWithRestarts(clonedModules, attemptConfig, signal, phantoms);
            if (signal?.aborted) {
                throw new DOMException("Cancelled", "AbortError");
            }

            const unsatisfied = checkRequiredSatisfied(result.layout, modulesMap, phantoms);
            if (!best || isPreferredRequiredAttempt(result, unsatisfied, best, best.unsatisfied)) {
                best = { ...result, unsatisfied };
            }

            // A naturally-satisfied attempt starts a bounded lookahead instead of ending
            // the search: its cost is arbitrary, and a cheaper satisfied attempt usually
            // sits a few attempts further on. A repaired attempt never triggers it.
            if (satisfiedAttempt < 0 && unsatisfied.length === 0 && !result.repairAttempted) {
                satisfiedAttempt = attempt;
            }
            if (satisfiedAttempt >= 0 && attempt >= satisfiedAttempt + SATISFIED_LOOKAHEAD) {
                break;
            }
        }
    }

    if (best.unsatisfied?.length > 0) {
        console.warn(`Required constraints unsatisfied after ${maxRetries + 1} attempts:`,
            best.unsatisfied.map(u => `${u.roomId}.${u.type}`).join(", "));
    }

    return attachRuleScores(best, clonedModules, config, phantoms);
}

function attachRuleScores(result, modules, config, phantoms) {
    const modulesMap = Object.fromEntries(modules.map(module => [module.id, module]));
    const bounds = result.layout.reduce((current, room) => ({
        w: Math.max(current.w, room.x + room.w),
        h: Math.max(current.h, room.y + room.h),
    }), { w: 0, h: 0 });
    const hasSoftConnect = modules.some(module => module.rules?.some(rule => rule.type === "connect" && !rule.required));
    const reportConfig = hasSoftConnect
        ? { ...config, _farCutoffFraction: FAR_CUTOFF_FRACTION_WITH_SOFT_CONNECT }
        : config;
    const totalCost = result.breakdown?.total ?? result.cost;
    const topologicalPenalty = result.breakdown?.topologicalPenalty ?? 0;
    return {
        ...result,
        ruleScores: calculateRuleScores(result.layout, modulesMap, bounds, reportConfig, totalCost, topologicalPenalty, phantoms),
    };
}

/**
 * The Async Wong-Liu Simulated Annealing Algorithm (single run).
 */
async function _runSingleSA(modules, config = {}, signal = null, phantoms = []) {
    let {
        initial_t,
        min_t = 0.1,
        cooling_rate = 0.85,  // 'r' from the paper (typically 0.85 - 0.90)
        k = 10,              // local neighborhood depth multiplier
        seed = 0xDEADBEEF,
        iter = 1,
    } = config;

    const randomFn = seed !== undefined ? mulberry32(seed) : Math.random;

    modules = modules.map(m => ({ ...m }));
    const hasSoftConnect = modules.some(module => module.rules?.some(rule => rule.type === "connect" && !rule.required));
    if (hasSoftConnect) {
        config = { ...config, _farCutoffFraction: FAR_CUTOFF_FRACTION_WITH_SOFT_CONNECT };
    }
    const n = modules.length;
    if (n === 0) {
        return { npe: [], cost: 0, layout: [] };
    }

    // Harder rules (connect, positional) need more exploration than soft proximity rules.
    // Divide by sqrt(n) because k*n already scales moves with room count.
    const weightedRules = modules.reduce((sum, m) => {
        for (const r of m.rules ?? []) {
            if (r.type === "connect") {
                sum += 2;
            } else if (r.type === "at" || r.type === "not_at" || r.type === "enclosed") {
                sum += 1.5;
            } else {
                sum += 1;
            }
        }
        return sum;
    }, 0);
    const defaultIter = Math.max(1, Math.round(weightedRules / Math.sqrt(n)));
    iter = defaultIter * iter;

    // 1. Calculate remaining area for rooms without size constraints
    let definedAreaSum = 0;
    const undefinedRooms = [];

    for (const m of modules) {
        if (m.area) {
            definedAreaSum += m.area;
        } else if (m.w && m.h) {
            definedAreaSum += m.w * m.h;
        } else if (!m.curve) {
            undefinedRooms.push(m);
        }
    }

    if (undefinedRooms.length > 0) {
        if (config.canvasW && config.canvasH) {
            const totalCanvasArea = config.canvasW * config.canvasH;
            const remainingArea = Math.max(10, totalCanvasArea - definedAreaSum);
            const areaPerUndefinedRoom = remainingArea / undefinedRooms.length;

            for (const m of undefinedRooms) {
                m.area = areaPerUndefinedRoom;
                m.ratioMax = Math.max(m.ratioMax || 0, 6.0); // Make shape highly flexible
            }
        } else {
            // Fallback if no canvas bounds
            for (const m of undefinedRooms) {
                m.area = 10000; // Default fallback to avoid crash
                m.ratioMax = Math.max(m.ratioMax || 0, 6.0);
            }
        }
    }

    // 2. Initialize mapping & the starting NPE: e.g.,[1, 2, 'V', 3, 'V', 4, 'V']
    const modulesMap = {};
    for (const m of modules) {
        if (!m.curve) {
            if (m.w && m.h) {
                // Support rotation for rigid modules (True Stockmeyer)
                m.curve = pruneCurve([
                    { w: m.w, h: m.h },
                    { w: m.h, h: m.w },
                ]);
            } else if (m.area) {
                const curve = [];
                if (m.ratio) {
                    const w = Math.sqrt(m.area * m.ratio);
                    const h = m.area / w;
                    curve.push({ w, h });
                    curve.push({ w: h, h: w });
                } else {
                    // Must match the effective ratioMax evaluateLayoutCost scores against,
                    // otherwise the curve only offers shapes the cost function penalizes.
                    const ratioMax = m.ratioMax || config.ratioMax || 3.0;
                    let w_max = Math.sqrt(m.area * ratioMax);
                    let w_min = Math.sqrt(m.area / ratioMax);
                    const globalSideMin = !config.sideMinFlexible && config.sideMin;
                    const effectiveSideMin = m.sideMin || globalSideMin || 0;
                    if (effectiveSideMin) {
                        w_min = Math.max(w_min, effectiveSideMin);
                        w_max = Math.min(w_max, m.area / effectiveSideMin);
                        if (w_min > w_max) {
                            w_min = w_max = Math.sqrt(m.area);
                        }
                    }
                    const samples = ratioMax <= 1.5 ? 3
                        : ratioMax <= 2.5 ? 5
                            : ratioMax <= 4.0 ? 7
                                : 10;
                    const step = w_max === w_min ? 0 : (w_max - w_min) / (samples - 1);

                    for (let i = 0; i < samples; i++) {
                        const w = w_min + i * step;
                        const h = m.area / w;
                        curve.push({ w, h });
                    }
                }
                m.curve = pruneCurve(curve);
            } else {
                throw new Error(`Room '${m.id}' has no area or dimensions defined.`);
            }
        }
        modulesMap[m.id] = m;
    }

    for (const m of modules) {
        for (const rule of m.rules ?? []) {
            if (rule.target !== undefined && !Array.isArray(rule.target)) {
                rule.target = [rule.target];
            }
            if (rule.dir !== undefined && !Array.isArray(rule.dir)) {
                rule.dir = typeof rule.dir === "string" ? rule.dir.split(" ") : [];
            }
        }
    }

    const hasAtRules = Object.values(modulesMap).some(m => m.rules?.some(r => r.type === "at"));
    const ruleIdx = buildRuleIndex(modules);

    const layoutArray = [];
    const layoutMap = {};
    for (let i = 0; i < modules.length; i++) {
        const m = modules[i];
        const room = { id: m.id, x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 };
        layoutArray.push(room);
        layoutMap[m.id] = room;
    }
    for (let i = 0; i < phantoms.length; i++) {
        const p = phantoms[i];
        const room = {
            id: p.id,
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            centerX: p.centerX,
            centerY: p.centerY,
        };
        layoutMap[p.id] = room;
    }

    let currentNpe;
    let candidates;
    if (n === 1) {
        currentNpe = [modules[0].id];
        const result = evaluateCost(currentNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms, layoutArray, layoutMap);
        return {
            npe: currentNpe,
            cost: result.cost,
            layout: result.rootNode && result.bestShape ? assignCoordinates(result.rootNode, result.bestShape, 0, 0) : [],
        };
    } else {
        candidates = buildInitialCandidates(modules, modulesMap, randomFn);
        let bestInit = null, bestInitCost = Infinity;
        for (const c of candidates) {
            if (!isValidNPE(c)) {
                continue;
            }
            const r = evaluateCost(c, modulesMap, config, 1, null, 1, hasAtRules, phantoms, layoutArray, layoutMap);
            const cost = r.cost + (r.valid ? 0 : PENALTIES.INVALID_HARD);
            if (cost < bestInitCost) {
                bestInitCost = cost;
                bestInit = c;
            }
        }
        currentNpe = bestInit ?? buildLinearFallback(modules);
    }

    if (initial_t === undefined) {
        if (n > 1) {
            const uphillDeltas = [];
            let testNpe = [...currentNpe];
            const testResult = evaluateCost(testNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms, layoutArray, layoutMap);
            let testCost = testResult.cost + (testResult.valid ? 0 : PENALTIES.INVALID_HARD);
            for (let i = 0; i < Math.min(n * 5, 100); i++) {
                const nextNpe = [...testNpe];
                applyRandomMove(nextNpe, randomFn);

                const nextResult = evaluateCost(nextNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms, layoutArray, layoutMap);
                const nextCost = nextResult.cost + (nextResult.valid ? 0 : PENALTIES.INVALID_HARD);
                const delta = nextCost - testCost;
                if (delta > 0) {
                    uphillDeltas.push(delta);
                }
                testNpe = nextNpe;
                testCost = nextCost;
            }
            const deltaAvg = uphillDeltas.length > 0 ? uphillDeltas.reduce((a, b) => a + b, 0) / uphillDeltas.length : INITIAL_DELTA_FALLBACK;
            initial_t = -deltaAvg / Math.log(0.95);
        } else {
            initial_t = INITIAL_DELTA_FALLBACK;
        }
    }

    let T = initial_t;
    let totalIterations = 0;

    // Track Global Bests
    let connectWeightMultiplier = Math.min(initial_t / T, CWM_CAP);
    let uwm = Math.min(initial_t / T / CWM_CAP, 1);
    let bestNpe = [...currentNpe];
    let currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
    let currentCost = currentResult.cost;
    if (!currentResult.valid) {
        currentCost += PENALTIES.INVALID_HARD;
    }
    let bestCost = currentCost;
    let bestResult = currentResult;
    let firstTemperature = true;

    let stagnation = 0;
    const STAGNATION_LIMIT = Math.max(200, Math.floor(k * n * iter / 8));
    const STAGNATION_REHEAT = 2.0;
    // Limit total reheats to prevent T oscillating forever when no best can be found.
    const MAX_STAGNATION_RECOVERIES = Math.max(3,
        Math.ceil(Math.log(Math.max(min_t, 1e-9) / initial_t) / Math.log(cooling_rate)) / 4);
    let stagnationRecoveries = 0;

    console.log(`Starting Annealing... Initial Cost: ${currentCost}`);

    // 2. Cooling Schedule
    while (T > min_t) {
        connectWeightMultiplier = Math.min(initial_t / T, CWM_CAP);
        uwm = Math.min(initial_t / T / CWM_CAP, 1);
        // First temperature uses the identical multipliers already evaluated above.
        if (!firstTemperature) {
            const currentTreeBundle = {
                tree: currentResult.rootNode,
                positionMap: currentResult.positionMap,
            };
            currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, currentTreeBundle, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
            currentCost = currentResult.cost;
            if (!currentResult.valid) {
                currentCost += PENALTIES.INVALID_HARD;
            }

            const currentMatchesBest = currentNpe.every((item, index) => item === bestNpe[index]);
            if (currentMatchesBest) {
                bestResult = currentResult;
                bestCost = currentCost;
            } else {
                const bestTreeBundle = {
                    tree: bestResult.rootNode,
                    positionMap: bestResult.positionMap,
                };
                bestResult = evaluateCost(bestNpe, modulesMap, config, connectWeightMultiplier, bestTreeBundle, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
                bestCost = bestResult.cost;
                if (!bestResult.valid) {
                    bestCost += PENALTIES.INVALID_HARD;
                }
            }
        }
        firstTemperature = false;

        const movesAtTemp = k * n * iter;
        let acceptedMoves = 0;
        let lastYield = performance.now();

        for (let step = 0; step < movesAtTemp; step++) {
            totalIterations++;

            if (performance.now() - lastYield >= 8) {
                await yieldToMain();
                lastYield = performance.now();
                if (signal?.aborted) {
                    throw new DOMException("Cancelled", "AbortError");
                }
            }

            const nextNpe = [...currentNpe];

            let move;
            const useGuided = randomFn() < 0.3 && ruleIdx;
            if (useGuided) {
                move = applyGuidedMove(nextNpe, randomFn, ruleIdx);
            }
            if (!move) {
                move = applyRandomMove(nextNpe, randomFn);
            }

            let nextTreeBundle;
            if (move && currentResult.positionMap) {
                nextTreeBundle = buildTreeIncremental(currentResult.positionMap, nextNpe, move.positions, modulesMap);
            } else {
                nextTreeBundle = null; // fresh build inside evaluateCost (no-op move)
            }

            const nextResult = evaluateCost(nextNpe, modulesMap, config, connectWeightMultiplier, nextTreeBundle, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
            let nextCost = nextResult.cost;
            if (!nextResult.valid) {
                nextCost += PENALTIES.INVALID_SOFT;
            } // moderate penalty; allows crossing invalid states

            const delta = nextCost - currentCost;

            // Acceptance Probability
            const prevBest = bestCost;
            if (delta < 0 || randomFn() < Math.exp(-delta / (T * connectWeightMultiplier))) {
                currentNpe = nextNpe;
                currentCost = nextCost;
                currentResult = nextResult;
                acceptedMoves++;

                if (currentCost < bestCost) {
                    bestCost = currentCost;
                    bestNpe = [...currentNpe];
                    bestResult = currentResult;
                }
            }

            if (bestCost < prevBest - 1e-9) {
                stagnation = 0;
            } else {
                stagnation++;
            }
        }

        if (stagnation >= STAGNATION_LIMIT) {
            const dice = randomFn();
            let recovered;
            if (dice < 0.45) {
                recovered = [...bestNpe];
                for (let m = 0; m < 3; m++) {
                    if (m === 0) {
                        applyM2(recovered, randomFn);
                    } else {
                        applyRandomMove(recovered, randomFn);
                    }
                }
            } else if (dice < 0.6) {
                recovered = bestNpe.map(c => c === "H" ? "V" : (c === "V" ? "H" : c));
            } else if (dice < 0.8 && candidates && candidates.length > 0) {
                recovered = [...candidates[Math.floor(randomFn() * candidates.length)]];
            } else {
                recovered = [...currentNpe];
                for (let m = 0; m < 5; m++) {
                    applyRandomMove(recovered, randomFn);
                }
            }
            if (isValidNPE(recovered)) {
                currentNpe = recovered;
                currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
                currentCost = currentResult.cost + (currentResult.valid ? 0 : PENALTIES.INVALID_HARD);
                if (stagnationRecoveries++ < MAX_STAGNATION_RECOVERIES) {
                    T = Math.min(initial_t, T * STAGNATION_REHEAT);
                }
            }
            stagnation = 0;
        }

        T *= cooling_rate;

        // Termination condition: if accept rate < 5% at very low temps
        if ((acceptedMoves / movesAtTemp) < MIN_ACCEPT_RATE && T < (initial_t * FREEZE_T_FRACTION)) {
            break;
        }
    }

    // Extract final coordinates using Phase 2
    let layout = [];
    let finalCost = bestCost;
    let finalShape = bestResult?.bestShape ?? null;
    if (bestResult && bestResult.rootNode && bestResult.bestShape) {
        layout = assignCoordinates(bestResult.rootNode, bestResult.bestShape, 0, 0);
        finalCost = evaluateLayoutCost(layout, finalShape.w, finalShape.h, modulesMap, config, 1, 1, phantoms).total;

        // Post-SA slack redistribution: stretch the slicing tree to fit the canvas
        // exactly. assignCoordinates already does proportional dimension distribution
        // at every cut when given override (W, H). Keep the redistributed layout
        // only if it scores better under the same cost function.
        const canvasW = config.canvasW || 500;
        const canvasH = config.canvasH || 500;
        const strict = config.canvasW && config.canvasH && !config.canvasFlexible;
        const overflow = Math.max(0, bestResult.bestShape.w - canvasW) + Math.max(0, bestResult.bestShape.h - canvasH);
        if (overflow > 0) {
            const redistLayout = assignCoordinates(bestResult.rootNode, bestResult.bestShape, 0, 0, canvasW, canvasH);
            const origCost = finalCost;
            const redistCost = evaluateLayoutCost(redistLayout, canvasW, canvasH, modulesMap, config, 1, 1, phantoms).total;
            if (strict) {
                // No cost jump by construction: evaluateCost scored this same stretch,
                // so `redistCost` is the landscape SA optimized. `origCost` is only the
                // freestanding shape it never ships at.
                console.log(`Compress to canvas: freestanding ${origCost.toExponential(3)} → delivered ${redistCost.toExponential(3)} (scored geometry)`);
                layout = redistLayout;
                finalCost = redistCost;
                finalShape = { w: canvasW, h: canvasH };
            } else if (redistCost < origCost) {
                console.log(`Redistribute: cost ${origCost.toExponential(3)} → ${redistCost.toExponential(3)} (kept)`);
                layout = redistLayout;
                finalCost = redistCost;
                finalShape = { w: canvasW, h: canvasH };
            } else {
                console.log(`Redistribute: cost ${origCost.toExponential(3)} → ${redistCost.toExponential(3)} (discarded)`);
            }
        }
    }

    // Global-flip probe: complement every operator (H↔V) and keep if cheaper.
    // Catches layouts SA can't escape via individual M2 moves (would need O(n) correlated flips).
    {
        const flipped = bestNpe.map(c => c === "H" ? "V" : (c === "V" ? "H" : c));
        if (isValidNPE(flipped)) {
            const flippedRes = evaluateCost(flipped, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
            if (flippedRes.valid && flippedRes.bestShape) {
                let flippedLayout = assignCoordinates(flippedRes.rootNode, flippedRes.bestShape, 0, 0);
                let flippedCost = evaluateLayoutCost(
                    flippedLayout, flippedRes.bestShape.w, flippedRes.bestShape.h,
                    modulesMap, config, 1, 1, phantoms,
                ).total;

                const canvasW = config.canvasW || 500;
                const canvasH = config.canvasH || 500;
                const strictF = config.canvasW && config.canvasH && !config.canvasFlexible;
                const overflowF = Math.max(0, flippedRes.bestShape.w - canvasW)
                    + Math.max(0, flippedRes.bestShape.h - canvasH);
                if (overflowF > 0) {
                    const redist = assignCoordinates(flippedRes.rootNode, flippedRes.bestShape, 0, 0, canvasW, canvasH);
                    const redistCost = evaluateLayoutCost(redist, canvasW, canvasH, modulesMap, config, 1, 1, phantoms).total;
                    if (strictF || redistCost < flippedCost) {
                        flippedLayout = redist;
                        flippedCost = redistCost;
                        flippedRes.bestShape = { w: canvasW, h: canvasH };
                    }
                }

                if (flippedCost < finalCost) {
                    console.log(`Global-flip probe: ${finalCost.toExponential(3)} → ${flippedCost.toExponential(3)} (kept)`);
                    bestNpe = flipped;
                    layout = flippedLayout;
                    finalCost = flippedCost;
                    finalShape = flippedRes.bestShape;
                } else {
                    console.log(`Global-flip probe: ${finalCost.toExponential(3)} → ${flippedCost.toExponential(3)} (discarded)`);
                }
            }
        }
    }

    // Post-SA repair: targeted local search to satisfy any still-unsatisfied
    // required rules before the retry loop's verdict, cutting expensive full SA
    // reruns. No-op (and zero-cost) when the layout already satisfies everything.
    const finalizeNpe = (npe) => {
        const res = evaluateCost(npe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms, layoutArray, layoutMap);
        if (!res.valid || !res.rootNode || !res.bestShape) {
            return null;
        }
        let repairLayout = assignCoordinates(res.rootNode, res.bestShape, 0, 0);
        let repairCost = evaluateLayoutCost(repairLayout, res.bestShape.w, res.bestShape.h, modulesMap, config, 1, 1, phantoms).total;
        let repairShape = res.bestShape;

        const cW = config.canvasW || 500;
        const cH = config.canvasH || 500;
        const strictC = config.canvasW && config.canvasH && !config.canvasFlexible;
        const overflowC = Math.max(0, res.bestShape.w - cW) + Math.max(0, res.bestShape.h - cH);
        if (overflowC > 0) {
            const redist = assignCoordinates(res.rootNode, res.bestShape, 0, 0, cW, cH);
            const redistCost = evaluateLayoutCost(redist, cW, cH, modulesMap, config, 1, 1, phantoms).total;
            if (strictC || redistCost < repairCost) {
                repairLayout = redist;
                repairCost = redistCost;
                repairShape = { w: cW, h: cH };
            }
        }
        return {
            layout: repairLayout,
            cost: repairCost,
            shape: repairShape,
            geometryViolations: countDeliveredGeometryViolations(repairLayout, modulesMap, config),
        };
    };

    const repaired = repairRequiredLayout(
        {
            npe: bestNpe,
            layout,
            cost: finalCost,
            shape: finalShape,
            geometryViolations: countDeliveredGeometryViolations(layout, modulesMap, config),
        },
        finalizeNpe, modulesMap, REPAIR_MAX_MOVES, phantoms,
    );
    if (repaired.attempted) {
        console.log(`Repair phase: unsatisfied ${repaired.unsatisfiedBefore} → ${repaired.unsatisfiedAfter}, cost ${finalCost.toExponential(3)} → ${repaired.cost.toExponential(3)}`);
        bestNpe = repaired.npe;
        layout = repaired.layout;
        finalCost = repaired.cost;
        finalShape = repaired.shape;
    }

    const breakdown = layout.length > 0 && finalShape
        ? evaluateLayoutCost(layout, finalShape.w, finalShape.h, modulesMap, config, 1, 1, phantoms)
        : null;

    console.log(`Finished! Total Iterations: ${totalIterations}. Best Cost: ${finalCost}`);
    return {
        npe: bestNpe,
        cost: finalCost,
        layout,
        breakdown,
        repairAttempted: repaired.attempted,
        geometryViolations: countDeliveredGeometryViolations(layout, modulesMap, config),
    };
}

// ==========================================
// Example Execution Setup
// ==========================================
async function runFloorplanner() {
    const dummyModules = [
        { id: "LivingRoom", area: 400, ratioMax: 2.0 },
        { id: "Kitchen", area: 150, ratioMax: 2.0 },
        { id: "Bathroom", area: 80, ratioMax: 1.5 },
        { id: "Bedroom1", area: 225, ratioMax: 2.0 },
        { id: "Bedroom2", area: 180, ratioMax: 2.0 },
        { id: "Hallway", area: 100, ratioMax: 4.0 },
    ];

    console.log("Generating floorplan async...");

    const result = await wongLiuSimulatedAnnealing(dummyModules, {
        initial_t: 5000,
        cooling_rate: 0.90,
        k: 15, // Higher allows deeper search per temperature slice
    });

    console.log("Optimal Slicing Tree (Normalized Polish Expression):", result.npe);
}

// Call this from a browser console or a button click!
// runFloorplanner();

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        wongLiuSimulatedAnnealing, evaluateCost, pruneCurve, assignCoordinates,
        applyM1, applyM2, applyM3, applyM4, isValidNPE, checkBoundariesOnTree,
        calculateTopologicalPenalties, calculateRuleScores, buildInitialCandidates, orderedToNpe,
        buildLinearFallback, buildRuleIndex, applyGuidedMove,
        checkRequiredSatisfied, isRuleSatisfied,
        countDeliveredGeometryViolations, requiredAttemptSelectionKey,
        _runWithRestarts, _runSingleSA, _selectRequiredBest, _shouldUseWorkers,
    };
}
