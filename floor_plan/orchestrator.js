const _wsa = (function() {
    if (typeof wongLiuSimulatedAnnealing !== "undefined") {
        return wongLiuSimulatedAnnealing;
    }
    return require("./sa_optimized.js").wongLiuSimulatedAnnealing;
})();

const DOMINANCE_HINT_LIMIT = 3;
const PENALTY_COMPARISON_EPSILON = 1e-6;

function sharedRuleParticipants(left, right) {
    const rightParticipants = new Set(right.participants ?? right.subjects ?? []);
    return (left.participants ?? left.subjects ?? []).filter(roomId => rightParticipants.has(roomId));
}

function attachDominanceHints(rules, scopePath) {
    const scopedRules = rules.map(rule => ({ ...rule, id: `${scopePath}::${rule.id}` }));
    return scopedRules.map(rule => {
        if (rule.required || rule.satisfied !== false) {
            return rule;
        }

        const dominanceHints = scopedRules
            .filter(candidate => candidate.id !== rule.id
                && candidate.penalty > rule.penalty + PENALTY_COMPARISON_EPSILON
                && sharedRuleParticipants(rule, candidate).length > 0)
            .sort((left, right) => right.penalty - left.penalty || left.id.localeCompare(right.id))
            .slice(0, DOMINANCE_HINT_LIMIT)
            .map(candidate => ({
                kind: "penalty-magnitude-correlation",
                counterfactualComputed: false,
                ruleId: candidate.id,
                scopePath,
                text: candidate.text,
                sharedRooms: sharedRuleParticipants(rule, candidate),
                penalty: candidate.penalty,
                penaltyDifference: candidate.penalty - rule.penalty,
            }));
        return { ...rule, dominanceHints };
    });
}

function gridApi() {
    if (typeof optimizeGrid !== "undefined" && typeof gridResultToLayout !== "undefined") {
        return { optimizeGrid, gridResultToLayout };
    }
    return require("./grid_optimizer.js");
}

function stripComments(text) {
    return text.split("\n")
        .map(line => line.split("#")[0].trim())
        .filter(line => line.length > 0)
        .join("\n");
}

function ruleTargetKey(rule) {
    const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
    return `${rule.any ? "any:" : "all:"}${[...targets].sort().join("|")}`;
}

function crossBoundaryWallRequirement(module, rule, config = {}, fallbackConfig = {}) {
    const cwl = rule.cwl ?? config.cwl ?? fallbackConfig.cwl ?? 0;
    const sideMinFlexible = config.sideMinFlexible ?? fallbackConfig.sideMinFlexible ?? false;
    const sideMin = sideMinFlexible ? 0 : (module.sideMin ?? config.sideMin ?? fallbackConfig.sideMin ?? 0);
    return Math.max(cwl, sideMin);
}

function applyInsideFrontageDemand(modules, config) {
    return modules.map(module => {
        if (!module.inside?.modules?.length) {
            return module;
        }

        const demandByTargets = new Map();
        const cwlDemandByTargets = new Map();
        const countedSubjectAnyGroups = new Set();
        for (const child of module.inside.modules) {
            for (const rule of child.rules ?? []) {
                if (rule.type !== "connect" || !rule.crossBoundary) {
                    continue;
                }
                const cwl = crossBoundaryWallRequirement(child, rule, module.inside.config, config);
                const configuredCwl = rule.cwl ?? module.inside.config.cwl ?? config.cwl ?? 0;
                const key = ruleTargetKey(rule);
                const subjectAnyKey = `${rule.subjectGroupId}:${key}`;
                if (rule.subjectAny && countedSubjectAnyGroups.has(subjectAnyKey)) {
                    continue;
                }
                if (rule.subjectAny) {
                    countedSubjectAnyGroups.add(subjectAnyKey);
                }
                demandByTargets.set(key, (demandByTargets.get(key) ?? 0) + cwl);
                cwlDemandByTargets.set(key, (cwlDemandByTargets.get(key) ?? 0) + configuredCwl);
            }
        }
        if (!demandByTargets.size) {
            return module;
        }

        const frontageSideMin = Math.max(0, ...[...demandByTargets]
            .filter(([key, demand]) => demand > cwlDemandByTargets.get(key))
            .map(([, demand]) => demand));
        let changed = false;
        const rules = module.rules.map(rule => {
            if (rule.type !== "connect") {
                return rule;
            }
            const demand = demandByTargets.get(ruleTargetKey(rule));
            const currentCwl = rule.cwl ?? config.cwl ?? 0;
            if (!demand) {
                return rule;
            }
            changed = true;
            return { ...rule, cwl: Math.max(currentCwl, demand), insideFrontage: true };
        });
        if (!changed) {
            return module;
        }
        if (!frontageSideMin) {
            return { ...module, rules };
        }
        return { ...module, sideMin: Math.max(module.sideMin ?? 0, frontageSideMin), rules };
    });
}

function sharedWallSide(A, B) {
    const epsilon = 0.1;
    const verticalOverlap = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
    const horizontalOverlap = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
    const sides = [
        { dir: "east", overlap: Math.abs(A.x + A.w - B.x) < epsilon ? verticalOverlap : 0 },
        { dir: "west", overlap: Math.abs(B.x + B.w - A.x) < epsilon ? verticalOverlap : 0 },
        { dir: "south", overlap: Math.abs(A.y + A.h - B.y) < epsilon ? horizontalOverlap : 0 },
        { dir: "north", overlap: Math.abs(B.y + B.h - A.y) < epsilon ? horizontalOverlap : 0 },
    ];
    const best = sides.reduce((current, side) => side.overlap > current.overlap ? side : current);
    return best.overlap > epsilon ? best : null;
}

// Keep cross-boundary connects aimed at fixed outer-room geometry. Fall back to
// a directional boundary rule only for callers that supplied point phantoms.
function resolveCrossBoundaryConnects(modules, outerRooms, parentRoom, config = {}) {
    const lookup = new Map(outerRooms.map(r => [r.id, r]));

    const toDir = (outer) => {
        if ([outer.x, outer.y, outer.w, outer.h, parentRoom.x, parentRoom.y, parentRoom.w, parentRoom.h].every(Number.isFinite)) {
            const sharedSide = sharedWallSide(parentRoom, outer);
            if (sharedSide) {
                return sharedSide.dir;
            }
        }
        const outerCX = outer.centerX ?? (outer.x + outer.w / 2);
        const outerCY = outer.centerY ?? (outer.y + outer.h / 2);
        const parentCX = parentRoom.centerX ?? (parentRoom.x + parentRoom.w / 2);
        const parentCY = parentRoom.centerY ?? (parentRoom.y + parentRoom.h / 2);
        const dx = outerCX - parentCX;
        const dy = outerCY - parentCY;
        return Math.abs(dx) >= Math.abs(dy)
            ? (dx > 0 ? "east" : "west")
            : (dy > 0 ? "south" : "north");
    };

    return modules.map(m => {
        const rules = m.rules.flatMap(rule => {
            if (rule.type !== "connect" || !rule.crossBoundary) {
                return rule;
            }
            const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
            const resolved = targets.map(tid => lookup.get(tid)).filter(Boolean);
            if (!resolved.length) {
                return rule;
            }
            const hasRectangles = resolved.length === targets.length
                && resolved.every(room => [room.x, room.y, room.w, room.h].every(Number.isFinite));
            const reachable = hasRectangles ? resolved.filter(room => sharedWallSide(parentRoom, room)) : [];
            const guideTargets = reachable.length ? reachable : resolved;

            let dir;
            if (rule.any) {
                const nearest = guideTargets.reduce((best, r) => {
                    const d = Math.hypot(r.centerX - parentRoom.centerX, r.centerY - parentRoom.centerY);
                    return d < best.d ? { r, d } : best;
                }, { r: guideTargets[0], d: Infinity }).r;
                dir = toDir(nearest);
            } else {
                const dirs = [...new Set(guideTargets.map(toDir))];
                dir = dirs.length === 1 ? dirs[0] : dirs;
            }

            const boundaryGuide = {
                type: "at",
                dir,
                weight: rule.weight,
                required: rule.required,
                reportOrigin: "derived-cross-boundary-guide",
            };
            const physicallyReachable = rule.any ? reachable.length > 0 : reachable.length === resolved.length;
            const cwl = crossBoundaryWallRequirement(m, rule, config);
            const connectRule = rule.cwl === cwl
                ? rule
                : { ...rule, cwl, reportOrigin: "derived-cross-boundary-connect" };
            return physicallyReachable ? [connectRule, boundaryGuide] : boundaryGuide;
        });
        return { ...m, rules };
    });
}

// SA resolves nested plans after their containing rectangle is known.
async function optimizeSaRecursive(modules, config, signal, phantoms = [], scopePath = ["top"]) {
    const mods = applyInsideFrontageDemand(modules, config);
    if (mods.length === 1) {
        mods.push({ id: "_dummy", area: 1, w: 1, h: 1, rules: [] });
    }

    const raw = await _wsa(mods, { k: 20, iter: 1, ...config }, signal, phantoms);
    const rooms = raw.layout
        .filter(r => r.id !== "_dummy")
        .map(r => ({ ...r, name: r.id }));

    for (const room of rooms) {
        const mod = modules.find(m => m.id === room.id);
        if (!mod?.inside?.modules?.length) {
            continue;
        }

        const toInner = (p) => {
            const pCX = p.centerX ?? (p.x + p.w / 2);
            const pCY = p.centerY ?? (p.y + p.h / 2);
            return {
                id: p.id,
                x: Number.isFinite(p.x) ? p.x - room.x : undefined,
                y: Number.isFinite(p.y) ? p.y - room.y : undefined,
                w: p.w,
                h: p.h,
                centerX: pCX - room.x,
                centerY: pCY - room.y,
            };
        };
        const innerPhantoms = [
            ...rooms.filter(r => r.id !== room.id).map(toInner),
            ...phantoms.map(toInner),
        ];
        const outerRooms = [...rooms.filter(r => r.id !== room.id), ...phantoms];
        const innerModules = resolveCrossBoundaryConnects(mod.inside.modules, outerRooms, room, mod.inside.config);
        room.inside = await optimizeSaRecursive(
            innerModules,
            { ...mod.inside.config, canvasW: room.w, canvasH: room.h, algo: "sa" },
            signal,
            innerPhantoms,
            [...scopePath, room.id],
        );
    }

    const path = scopePath.join(" / ");
    const localScores = raw.ruleScores ?? {
        totalCost: raw.cost,
        topologicalPenalty: raw.breakdown?.topologicalPenalty ?? 0,
        reportedPenalty: 0,
        unreportedTopologicalPenalty: raw.breakdown?.topologicalPenalty ?? 0,
        rules: [],
    };
    const localScope = {
        path,
        totalCost: localScores.totalCost,
        topologicalPenalty: localScores.topologicalPenalty,
        reportedPenalty: localScores.reportedPenalty,
        unreportedTopologicalPenalty: localScores.unreportedTopologicalPenalty,
        rules: attachDominanceHints(localScores.rules, path),
    };
    const nestedScopes = rooms.flatMap(room => room.inside?.ruleReport?.scopes ?? []);

    return {
        schemaVersion: 1,
        algo: "sa",
        cost: raw.cost,
        breakdown: raw.breakdown,
        unsatisfied: raw.unsatisfied ?? [],
        rooms,
        warnings: [],
        ruleReport: {
            availability: "available",
            metric: "sa-normalized-delivered-cost",
            percentBasis: "scope-total-cost",
            weightSemantics: localScores.weightSemantics,
            dominanceHintBasis: "shared-room-current-penalty-magnitude-correlation",
            dominanceHintLimit: DOMINANCE_HINT_LIMIT,
            scopes: [localScope, ...nestedScopes],
        },
    };
}

function runGridInWorker(parsed, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Optimization aborted", "AbortError"));
            return;
        }
        const worker = new Worker(new URL("grid_worker.js", document.baseURI));
        const abort = () => {
            worker.terminate();
            reject(new DOMException("Optimization aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        worker.onmessage = ({ data }) => {
            signal?.removeEventListener("abort", abort);
            worker.terminate();
            if (data.error) {
                reject(new Error(data.error));
                return;
            }
            resolve(data.result);
        };
        worker.onerror = (event) => {
            signal?.removeEventListener("abort", abort);
            worker.terminate();
            reject(new Error(event.message || "Grid worker failed"));
        };
        worker.postMessage(parsed);
    });
}

async function optimizeParsed(parsed, signal) {
    const algo = parsed.config.algo ?? "sa";
    if (algo === "sa") {
        const result = await optimizeSaRecursive(parsed.modules, parsed.config, signal);
        result.warnings = [...(parsed.warnings || []), ...(result.warnings || [])];
        return result;
    }
    if (typeof Worker !== "undefined" && typeof document !== "undefined") {
        return runGridInWorker(parsed, signal);
    }
    const { optimizeGrid: runGrid, gridResultToLayout: adaptGrid } = gridApi();
    const raw = runGrid(parsed, { seed: parsed.config.seed });
    if (raw.error) {
        throw new Error(raw.error);
    }
    return adaptGrid(raw, parsed.warnings || []);
}

// Compatibility entry point used by scripts. Missing `algo` selects SA.
async function optimizeRecursive(modules, config, signal, phantoms = []) {
    if ((config.algo ?? "sa") === "sa") {
        return optimizeSaRecursive(modules, config, signal, phantoms);
    }
    return optimizeParsed({ modules, config, warnings: [], errors: [] }, signal);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        stripComments,
        optimizeRecursive,
        optimizeParsed,
        optimizeSaRecursive,
        attachDominanceHints,
    };
}
