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
    NOT_AT_DIR: 10000,      // not_at directional hard violation (unitless)
    NOT_AT_EDGE: 100000000, // not_at edge penetration normalized by canvasDiag²
    CANVAS: 100000000,      // canvas overflow normalized by (canvasW², canvasH²) → dimensionless
    ASPECT: 10000,          // layout aspect ratio > 2.0 per unit
    ROOM_ASPECT: 50000,     // room aspect ratio > ratioMax per unit²
    SIDE_MIN: 100000000,    // room dimension < sideMin, normalized by canvasDiag²
    INVALID_SOFT: 500000,   // crossing invalid NPE states (allows transitions)
    INVALID_HARD: 10000000, // hard-invalid NPE in best tracking
    DEFAULT_SIDE_MIN: 50,   // fallback for module.sideMin (cm)
    REQUIRED_BOOST: 50,    // weight multiplier for required rules (bypasses uwm ramp)
};

const MIN_ACCEPT_RATE = 0.05;
const FREEZE_T_FRACTION = 0.01;
const INITIAL_DELTA_FALLBACK = 10000;
const CWM_CAP = 100;

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

function applyTargets(rule, targets, layoutMap, getPenalty) {
    if (rule.any) {
        let minP = Infinity;
        for (const t of targets) {
            const B = layoutMap[t];
            if (B) {
                minP = Math.min(minP, getPenalty(B));
            }
        }
        return minP === Infinity ? 0 : minP;
    }
    let sum = 0;
    for (const t of targets) {
        const B = layoutMap[t];
        if (B) {
            sum += getPenalty(B);
        }
    }
    return sum;
}

function penaltyConnect(room, rule, layoutMap, config, cwm, canvasDiagSq, uwm = 1) {
    const baseW = rule.weight || 1;
    const weight = rule.required ? baseW * PENALTIES.REQUIRED_BOOST : 1 + (baseW - 1) * uwm;
    const targets = rule.target ?? [];

    return applyTargets(rule, targets, layoutMap, (B) => {
        const isHorizontallyAdjacent = (room.x + room.w === B.x) || (B.x + B.w === room.x);
        const verticalOverlap = Math.max(0, Math.min(room.y + room.h, B.y + B.h) - Math.max(room.y, B.y));
        const isVerticallyAdjacent = (room.y + room.h === B.y) || (B.y + B.h === room.y);
        const horizontalOverlap = Math.max(0, Math.min(room.x + room.w, B.x + B.w) - Math.max(room.x, B.x));
        let sharedWallLength = 0;
        if (isHorizontallyAdjacent && verticalOverlap > 0) {
            sharedWallLength = verticalOverlap;
        }
        if (isVerticallyAdjacent && horizontalOverlap > 0) {
            sharedWallLength = horizontalOverlap;
        }
        const cwl = rule.cwl || config.cwl || 0;
        if (sharedWallLength === 0) {
            const dx = room.centerX - B.centerX;
            const dy = room.centerY - B.centerY;
            return ((dx * dx + dy * dy) / canvasDiagSq) * PENALTIES.CONNECT_BASE * weight * cwm;
        } else if (cwl > 0 && sharedWallLength < cwl) {
            return ((cwl - sharedWallLength) / Math.sqrt(canvasDiagSq)) * PENALTIES.CWL_SHORT * weight * cwm;
        }
        return 0;
    });
}

function penaltyClose(room, rule, layoutMap, cwm, canvasDiagSq, uwm = 1) {
    const baseW = rule.weight || 1;
    const weight = rule.required ? baseW * PENALTIES.REQUIRED_BOOST : 1 + (baseW - 1) * uwm;
    const targets = rule.target ?? [];

    return applyTargets(rule, targets, layoutMap, (B) => {
        const dx = room.centerX - B.centerX;
        const dy = room.centerY - B.centerY;
        return ((dx * dx + dy * dy) / canvasDiagSq) * weight * PENALTIES.CONNECT_BASE * cwm;
    });
}

function penaltyFar(room, rule, layoutMap, canvasDiag, cwm, uwm = 1) {
    const baseW = rule.weight || 1;
    const weight = rule.required ? baseW * PENALTIES.REQUIRED_BOOST : 1 + (baseW - 1) * uwm;
    const targets = rule.target ?? [];

    return applyTargets(rule, targets, layoutMap, (B) => {
        const dx = room.centerX - B.centerX;
        const dy = room.centerY - B.centerY;
        const d = Math.sqrt(dx * dx + dy * dy);
        return (1 / (1 + d / canvasDiag)) * weight * PENALTIES.CONNECT_BASE * cwm;
    });
}

function penaltyAt(room, rule, globalBounds, cwm, canvasDiag, uwm = 1) {
    const baseW = rule.weight || 1;
    const weight = rule.required ? baseW * PENALTIES.REQUIRED_BOOST : 1 + (baseW - 1) * uwm;
    const dirs = rule.dir ?? [];
    let p = 0;

    for (const dir of dirs) {
        let d = 0;
        if (dir === "edge") {
            const d_min = Math.min(room.y, globalBounds.h - (room.y + room.h), room.x, globalBounds.w - (room.x + room.w));
            d = d_min > 0 ? d_min : 0;
        } else if (dir === "north") {
            d = room.y;
        } else if (dir === "south") {
            d = globalBounds.h - (room.y + room.h);
        } else if (dir === "east") {
            d = globalBounds.w - (room.x + room.w);
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

function penaltyNotAt(room, rule, mod, globalBounds, cwm, canvasDiagSq, uwm = 1) {
    const baseW = rule.weight || 1;
    const weight = rule.required ? baseW * PENALTIES.REQUIRED_BOOST : 1 + (baseW - 1) * uwm;
    const targetDepth = mod.sideMin || PENALTIES.DEFAULT_SIDE_MIN;
    let p = 0;

    const d0 = rule.dir?.[0];
    if (d0 === "edge" || rule.type === "enclosed") {
        const d_min = Math.min(room.y, globalBounds.h - (room.y + room.h), room.x, globalBounds.w - (room.x + room.w));
        if (d_min < targetDepth) {
            const shortfall = Math.max(0, targetDepth - d_min);
            p += ((shortfall * shortfall) / canvasDiagSq) * weight * PENALTIES.NOT_AT_EDGE * cwm;
        }
    } else if (d0 === "north") {
        if (room.y < targetDepth) {
            p += PENALTIES.NOT_AT_DIR * weight * cwm;
        }
    } else if (d0 === "south") {
        const d = globalBounds.h - (room.y + room.h);
        if (d < targetDepth) {
            p += PENALTIES.NOT_AT_DIR * weight * cwm;
        }
    } else if (d0 === "east") {
        const d = globalBounds.w - (room.x + room.w);
        if (d < targetDepth) {
            p += PENALTIES.NOT_AT_DIR * weight * cwm;
        }
    } else if (d0 === "west") {
        if (room.x < targetDepth) {
            p += PENALTIES.NOT_AT_DIR * weight * cwm;
        }
    }
    return p;
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

    switch (rule.type) {
        case "connect": {
            const targets = rule.target ?? [];
            const cwl = rule.cwl || 0;
            const ok = (t) => {
                const swl = sharedWall(room, layoutMap[t]);
                return swl > 0 && (cwl === 0 || swl >= cwl - REQUIRED_SATISFIED_EPS);
            };
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "close": {
            const targets = rule.target ?? [];
            const ok = (t) => layoutMap[t] && sharedWall(room, layoutMap[t]) > 0;
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "far": {
            // satisfied when not adjacent — the continuous penalty maximizes distance,
            // but the binary check only requires non-adjacency
            const targets = rule.target ?? [];
            const ok = (t) => !layoutMap[t] || sharedWall(room, layoutMap[t]) === 0;
            return rule.any ? targets.some(ok) : targets.every(ok);
        }
        case "at": {
            const dirs = rule.dir ?? [];
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
            if (rule.type === "enclosed" || rule.dir?.[0] === "edge") {
                return Math.min(room.y, gH - (room.y + room.h), room.x, gW - (room.x + room.w)) > REQUIRED_SATISFIED_EPS;
            }
            const dirs = rule.dir ?? [];
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

function checkRequiredSatisfied(layout, modulesMap) {
    if (!layout || layout.length === 0) {
        return [];
    }
    const layoutMap = Object.fromEntries(layout.map(r => [r.id, r]));
    const gW = layout.reduce((m, r) => Math.max(m, r.x + r.w), 0);
    const gH = layout.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    const globalBounds = { w: gW, h: gH };
    const unsatisfied = [];
    const subjectAnyGroups = new Map(); // subjectGroupId -> { rule, satisfied, roomIds }

    for (const room of layout) {
        const mod = modulesMap[room.id];
        if (!mod?.rules) {
            continue;
        }
        for (const rule of mod.rules) {
            if (!rule.required) {
                continue;
            }

            if (rule.subjectAny && rule.subjectGroupId !== undefined) {
                if (!subjectAnyGroups.has(rule.subjectGroupId)) {
                    subjectAnyGroups.set(rule.subjectGroupId, {
                        rule,
                        satisfied: false,
                        roomIds: [],
                    });
                }
                const group = subjectAnyGroups.get(rule.subjectGroupId);
                group.roomIds.push(room.id);
                if (isRuleSatisfied(rule, room, layoutMap, globalBounds)) {
                    group.satisfied = true;
                }
            } else {
                if (!isRuleSatisfied(rule, room, layoutMap, globalBounds)) {
                    unsatisfied.push({
                        roomId: room.id,
                        type: rule.type,
                        target: rule.target,
                        dir: rule.dir,
                    });
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

/**
 * Phase 3: Augmented Cost Function (Topological Penalties)
 */
function calculateTopologicalPenalties(layout, modulesMap, globalBounds, config = {}, connectWeightMultiplier = 1, uwm = 1, layoutMap = null, phantoms = []) {
    let penalty = 0;
    const canvasDiagSq = globalBounds.w * globalBounds.w + globalBounds.h * globalBounds.h;
    const canvasDiag = Math.sqrt(canvasDiagSq);
    const cwm = connectWeightMultiplier;

    if (!layoutMap) {
        layoutMap = {};
        for (const room of layout) {
            layoutMap[room.id] = room;
        }
    }
    for (const p of phantoms) {
        if (!layoutMap[p.id]) {
            layoutMap[p.id] = p;
        }
    }

    const subjectAnyMin = new Map(); // subjectGroupId -> minPenalty

    for (const room of layout) {
        const mod = modulesMap[room.id];

        const cwc = mod?.cwc || config.cwc || 0;
        if (cwc > 0) {
            let connections = 0;
            for (const B of layout) {
                if (room.id === B.id) {
                    continue;
                }
                const isHorizontallyAdjacent = (room.x + room.w === B.x) || (B.x + B.w === room.x);
                const verticalOverlap = Math.max(0, Math.min(room.y + room.h, B.y + B.h) - Math.max(room.y, B.y));
                const isVerticallyAdjacent = (room.y + room.h === B.y) || (B.y + B.h === room.y);
                const horizontalOverlap = Math.max(0, Math.min(room.x + room.w, B.x + B.w) - Math.max(room.x, B.x));
                let sharedWallLength = 0;
                if (isHorizontallyAdjacent && verticalOverlap > 0) {
                    sharedWallLength = verticalOverlap;
                }
                if (isVerticallyAdjacent && horizontalOverlap > 0) {
                    sharedWallLength = horizontalOverlap;
                }
                if (sharedWallLength > 0) {
                    connections++;
                }
            }
            if (connections < cwc) {
                penalty += (cwc - connections) * PENALTIES.CONNECT_BASE * cwm;
            }
        }

        if (!mod || !mod.rules) {
            continue;
        }

        for (const rule of mod.rules) {
            let p = 0;
            if (rule.type === "connect") {
                p = penaltyConnect(room, rule, layoutMap, config, cwm, canvasDiagSq, uwm);
            } else if (rule.type === "close") {
                p = penaltyClose(room, rule, layoutMap, cwm, canvasDiagSq, uwm);
            } else if (rule.type === "far") {
                p = penaltyFar(room, rule, layoutMap, canvasDiag, cwm, uwm);
            } else if (rule.type === "at") {
                p = penaltyAt(room, rule, globalBounds, cwm, canvasDiag, uwm);
            } else if (rule.type === "not_at" || rule.type === "enclosed") {
                p = penaltyNotAt(room, rule, mod, globalBounds, cwm, canvasDiagSq, uwm);
            }

            if (rule.subjectAny && rule.subjectGroupId !== undefined) {
                const prev = subjectAnyMin.get(rule.subjectGroupId);
                if (prev === undefined || p < prev) {
                    subjectAnyMin.set(rule.subjectGroupId, p);
                }
            } else {
                penalty += p;
            }
        }
    }

    for (const p of subjectAnyMin.values()) {
        penalty += p;
    }

    return penalty;
}

/**
 * Phase 1.5: Fast-Fail Topological Boundary Check on built tree.
 * Replaces NPE re-traversal — reuses the tree already built in evaluateCost.
 */
function checkBoundariesOnTree(node, boundaries, modulesMap) {
    if (node.type === "leaf") {
        const mod = modulesMap[node.id];
        if (mod?.rules) {
            for (const rule of mod.rules) {
                if (rule.type !== "at") {
                    continue;
                }
                const dirs = rule.dir ?? [];
                for (const dir of dirs) {
                    if (dir === "north" && !boundaries.north) {
                        return false;
                    }
                    if (dir === "south" && !boundaries.south) {
                        return false;
                    }
                    if (dir === "east" && !boundaries.east) {
                        return false;
                    }
                    if (dir === "west" && !boundaries.west) {
                        return false;
                    }
                    if (dir === "edge" && !(boundaries.north || boundaries.south || boundaries.east || boundaries.west)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    let rightB, leftB;
    if (node.type === "H") {
        leftB = {
            north: boundaries.north,
            south: false,
            east: boundaries.east,
            west: boundaries.west,
        };
        rightB = {
            north: false,
            south: boundaries.south,
            east: boundaries.east,
            west: boundaries.west,
        };
    } else {
        rightB = {
            north: boundaries.north,
            south: boundaries.south,
            east: boundaries.east,
            west: false,
        };
        leftB = {
            north: boundaries.north,
            south: boundaries.south,
            east: false,
            west: boundaries.west,
        };
    }
    return checkBoundariesOnTree(node.right, rightB, modulesMap) &&
        checkBoundariesOnTree(node.left, leftB, modulesMap);
}

/**
 * Merges two child curves under H/V operator and prunes to Pareto front.
 * Iteration order (left outer, right inner) preserved for bit-level determinism.
 */
function mergeShapes(leftCurve, rightCurve, op) {
    const n = leftCurve.length * rightCurve.length;
    const ws = new Float64Array(n);
    const hs = new Float64Array(n);
    let k = 0;
    if (op === "H") {
        for (let li = 0; li < leftCurve.length; li++) {
            for (let ri = 0; ri < rightCurve.length; ri++, k++) {
                ws[k] = Math.max(leftCurve[li].w, rightCurve[ri].w);
                hs[k] = leftCurve[li].h + rightCurve[ri].h;
            }
        }
    } else {
        for (let li = 0; li < leftCurve.length; li++) {
            for (let ri = 0; ri < rightCurve.length; ri++, k++) {
                ws[k] = leftCurve[li].w + rightCurve[ri].w;
                hs[k] = Math.max(leftCurve[li].h, rightCurve[ri].h);
            }
        }
    }
    const idx = Array.from({ length: n }, (_, i) => i)
        .sort((a, b) => ws[a] - ws[b] || hs[a] - hs[b]);
    const result = [];
    let minH = Infinity;
    for (const i of idx) {
        if (hs[i] < minH) {
            const li = Math.floor(i / rightCurve.length);
            const ri = i % rightCurve.length;
            result.push({
                w: ws[i],
                h: hs[i],
                leftShape: leftCurve[li],
                rightShape: rightCurve[ri],
            });
            minH = hs[i];
        }
    }
    return result;
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
 * Score a fully-assigned layout against the cost function. Used both inside the
 * rootShape sweep and by the post-SA slack-redistribution check.
 * `rootW, rootH` are the outer bounds the layout fills (rootShape for SA picks,
 * canvas for redistributed layouts).
 */
function evaluateLayoutCost(layout, rootW, rootH, modulesMap, config = {}, cwm = 1, uwm = 1, phantoms = []) {
    const canvasW = config.canvasW || 500;
    const canvasH = config.canvasH || 500;
    const canvasTargetDiagSq = canvasW * canvasW + canvasH * canvasH;

    const area = rootW * rootH;
    const aspect = Math.max(rootW / rootH, rootH / rootW);
    const aspectPenalty = aspect > 2.0 ? (aspect - 2.0) * PENALTIES.ASPECT : 0;

    const overW = Math.max(0, rootW - canvasW);
    const overH = Math.max(0, rootH - canvasH);
    const canvasPenalty = ((overW * overW + overH * overH) / canvasTargetDiagSq) * PENALTIES.CANVAS * cwm;

    const layoutMap = Object.fromEntries(layout.map(r => [r.id, r]));
    const topologicalPenalty = calculateTopologicalPenalties(layout, modulesMap, {
        w: rootW,
        h: rootH,
    }, config, cwm, uwm, layoutMap, phantoms);

    let roomPenalty = 0;
    for (const room of layout) {
        const m = modulesMap[room.id];
        if (!m) {
            continue;
        }
        const rArea = room.w * room.h;
        if (m.area) {
            roomPenalty += Math.abs(rArea - m.area) * 0.5 * cwm;
        }
        const rAspect = Math.max(room.w / room.h, room.h / room.w);
        const rMax = m.ratio ? Infinity : (m.ratioMax || config.ratioMax || 3.0);
        if (rAspect > rMax) {
            roomPenalty += Math.pow(rAspect - rMax, 2) * PENALTIES.ROOM_ASPECT * cwm;
        }
        const effectiveSideMin = m.sideMin || (!config.sideMinFlexible && config.sideMin) || 0;
        if (effectiveSideMin > 0) {
            const shortW = Math.max(0, effectiveSideMin - room.w);
            const shortH = Math.max(0, effectiveSideMin - room.h);
            if (shortW > 0 || shortH > 0) {
                roomPenalty += (shortW * shortW + shortH * shortH) / canvasTargetDiagSq * PENALTIES.SIDE_MIN * cwm;
            }
        }
    }

    const total = area + aspectPenalty + canvasPenalty + topologicalPenalty + roomPenalty;
    return { total, area, aspectPenalty, canvasPenalty, topologicalPenalty, roomPenalty };
}

function evaluateCost(npe, modulesMap, config = {}, connectWeightMultiplier = 1, treeBundle = null, uwm = 1, hasAtRules = true, phantoms = []) {
    if (!treeBundle) {
        treeBundle = buildTreeFresh(npe, modulesMap);
    }
    const rootNode = treeBundle.tree;
    const positionMap = treeBundle.positionMap;
    const rootCurve = rootNode.curve;

    // Boundary check on tree — replaces separate passesTopologicalBoundaryCheck NPE traversal
    let boundaryValid = true;
    if (hasAtRules) {
        boundaryValid = checkBoundariesOnTree(rootNode, {
            north: true,
            south: true,
            east: true,
            west: true,
        }, modulesMap);
    }

    // Objective Cost Function: evaluate all possible root shapes and pick the best one
    let bestCost = Infinity;
    let bestRootShape = null;

    for (const rootShape of rootCurve) {
        const layout = assignCoordinates(rootNode, rootShape, 0, 0);
        const cost = evaluateLayoutCost(layout, rootShape.w, rootShape.h, modulesMap, config, connectWeightMultiplier, uwm, phantoms).total;
        if (cost < bestCost) {
            bestCost = cost;
            bestRootShape = rootShape;
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
                adj.get(m.id).push(t);
                if (adj.has(t)) {
                    adj.get(t).push(m.id);
                }
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
    for (const m of modules) {
        for (const r of m.rules ?? []) {
            if (r.type === "connect" || r.type === "far") {
                const targets = r.target ?? [];
                for (const t of targets) {
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

async function _runWithRestarts(modules, config, signal, phantoms = []) {
    const restarts = Math.max(1, config.restarts ?? 1);
    if (restarts === 1 || modules.length <= 2) {
        return _runSingleSA(modules, config, signal, phantoms);
    }

    const baseSeed = config.seed ?? 0xDEADBEEF;
    const innerIter = Math.max(1, (config.iter ?? 1) / restarts);
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

async function wongLiuSimulatedAnnealing(modules, config = {}, signal = null, phantoms = []) {
    const hasRequired = modules.some(m => m.rules?.some(r => r.required));
    if (!hasRequired) {
        return _runWithRestarts(modules, config, signal, phantoms);
    }

    const maxRetries = config.requiredMaxRetries ?? 10;
    const baseSeed = config.seed ?? 0xDEADBEEF;
    const modulesMap = Object.fromEntries(modules.map(m => [m.id, m]));

    let best = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const attemptConfig = attempt === 0 ? config : {
            ...config,
            seed: baseSeed + attempt * 0x17A4B3C1,
        };
        const result = await _runWithRestarts(modules, attemptConfig, signal, phantoms);
        if (signal?.aborted) {
            throw new DOMException("Cancelled", "AbortError");
        }

        const unsatisfied = checkRequiredSatisfied(result.layout, modulesMap);
        if (!best || result.cost < best.cost) {
            best = { ...result, unsatisfied };
        }
        if (unsatisfied.length === 0) {
            break;
        }
    }

    if (best.unsatisfied?.length > 0) {
        console.warn(`Required constraints unsatisfied after ${maxRetries + 1} attempts:`,
            best.unsatisfied.map(u => `${u.roomId}.${u.type}`).join(", "));
    }

    return best;
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
                    const ratioMax = m.ratioMax || 3.0;
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

    let currentNpe;
    let candidates;
    if (n === 1) {
        currentNpe = [modules[0].id];
        const result = evaluateCost(currentNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms);
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
            const r = evaluateCost(c, modulesMap, config, 1, null, 1, hasAtRules, phantoms);
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
            const testResult = evaluateCost(testNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms);
            let testCost = testResult.cost + (testResult.valid ? 0 : PENALTIES.INVALID_HARD);
            for (let i = 0; i < Math.min(n * 5, 100); i++) {
                const nextNpe = [...testNpe];
                const moveType = Math.floor(randomFn() * 3) + 1;
                if (moveType === 1) {
                    applyM1(nextNpe, randomFn);
                } else if (moveType === 2) {
                    applyM2(nextNpe, randomFn);
                } else {
                    applyM3(nextNpe, randomFn);
                }

                const nextResult = evaluateCost(nextNpe, modulesMap, config, 1, null, 1, hasAtRules, phantoms);
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
    let currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms);
    let currentCost = currentResult.cost;
    if (!currentResult.valid) {
        currentCost += PENALTIES.INVALID_HARD;
    }
    let bestCost = currentCost;
    let bestResult = currentResult;

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
        // Re-evaluate current and best cost with new multiplier so delta is accurate
        currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms);
        currentCost = currentResult.cost;
        if (!currentResult.valid) {
            currentCost += PENALTIES.INVALID_HARD;
        }

        bestResult = evaluateCost(bestNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms);
        bestCost = bestResult.cost;
        if (!bestResult.valid) {
            bestCost += PENALTIES.INVALID_HARD;
        }

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
                const moveType = Math.floor(randomFn() * 3) + 1;
                if (moveType === 1) {
                    move = applyM1(nextNpe, randomFn);
                } else if (moveType === 2) {
                    move = applyM2(nextNpe, randomFn);
                } else {
                    move = applyM3(nextNpe, randomFn);
                }
            }

            let nextTreeBundle;
            if (move && currentResult.positionMap) {
                nextTreeBundle = buildTreeIncremental(currentResult.positionMap, nextNpe, move.positions, modulesMap);
            } else {
                nextTreeBundle = null; // fresh build inside evaluateCost (no-op move)
            }

            const nextResult = evaluateCost(nextNpe, modulesMap, config, connectWeightMultiplier, nextTreeBundle, uwm, hasAtRules, phantoms);
            let nextCost = nextResult.cost;
            if (!nextResult.valid) {
                nextCost += PENALTIES.INVALID_SOFT;
            } // moderate penalty; allows crossing invalid states

            const delta = nextCost - currentCost;

            // Acceptance Probability
            const prevBest = bestCost;
            if (delta < 0 || randomFn() < Math.exp(-delta / T)) {
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
                    const moveType = m === 0 ? 2 : Math.floor(randomFn() * 3) + 1;
                    if (moveType === 1) {
                        applyM1(recovered, randomFn);
                    } else if (moveType === 2) {
                        applyM2(recovered, randomFn);
                    } else {
                        applyM3(recovered, randomFn);
                    }
                }
            } else if (dice < 0.6) {
                recovered = bestNpe.map(c => c === "H" ? "V" : (c === "V" ? "H" : c));
            } else if (dice < 0.8 && candidates && candidates.length > 0) {
                recovered = [...candidates[Math.floor(randomFn() * candidates.length)]];
            } else {
                recovered = [...currentNpe];
                for (let m = 0; m < 5; m++) {
                    const moveType = Math.floor(randomFn() * 3) + 1;
                    if (moveType === 1) {
                        applyM1(recovered, randomFn);
                    } else if (moveType === 2) {
                        applyM2(recovered, randomFn);
                    } else {
                        applyM3(recovered, randomFn);
                    }
                }
            }
            if (isValidNPE(recovered)) {
                currentNpe = recovered;
                currentResult = evaluateCost(currentNpe, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms);
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
            const origCost = evaluateLayoutCost(layout, bestResult.bestShape.w, bestResult.bestShape.h, modulesMap, config, connectWeightMultiplier, 1, phantoms).total;
            const redistCost = evaluateLayoutCost(redistLayout, canvasW, canvasH, modulesMap, config, connectWeightMultiplier, 1, phantoms).total;
            if (strict) {
                console.log(`Compress to canvas: cost ${origCost.toExponential(3)} → ${redistCost.toExponential(3)} (required)`);
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
            const flippedRes = evaluateCost(flipped, modulesMap, config, connectWeightMultiplier, null, uwm, hasAtRules, phantoms);
            if (flippedRes.valid && flippedRes.bestShape) {
                let flippedLayout = assignCoordinates(flippedRes.rootNode, flippedRes.bestShape, 0, 0);
                let flippedCost = evaluateLayoutCost(
                    flippedLayout, flippedRes.bestShape.w, flippedRes.bestShape.h,
                    modulesMap, config, connectWeightMultiplier, 1, phantoms,
                ).total;

                const canvasW = config.canvasW || 500;
                const canvasH = config.canvasH || 500;
                const strictF = config.canvasW && config.canvasH && !config.canvasFlexible;
                const overflowF = Math.max(0, flippedRes.bestShape.w - canvasW)
                    + Math.max(0, flippedRes.bestShape.h - canvasH);
                if (overflowF > 0) {
                    const redist = assignCoordinates(flippedRes.rootNode, flippedRes.bestShape, 0, 0, canvasW, canvasH);
                    const redistCost = evaluateLayoutCost(redist, canvasW, canvasH, modulesMap, config, connectWeightMultiplier, 1, phantoms).total;
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

    const breakdown = layout.length > 0 && finalShape
        ? evaluateLayoutCost(layout, finalShape.w, finalShape.h, modulesMap, config, connectWeightMultiplier, 1, phantoms)
        : null;

    console.log(`Finished! Total Iterations: ${totalIterations}. Best Cost: ${finalCost}`);
    return { npe: bestNpe, cost: finalCost, layout, breakdown };
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
        applyM1, applyM2, applyM3, isValidNPE, checkBoundariesOnTree,
        calculateTopologicalPenalties, buildInitialCandidates, orderedToNpe,
        buildLinearFallback, buildRuleIndex, applyGuidedMove,
        checkRequiredSatisfied, isRuleSatisfied,
    };
}
