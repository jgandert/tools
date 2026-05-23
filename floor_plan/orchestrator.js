const _wsa = (function() {
    if (typeof wongLiuSimulatedAnnealing !== "undefined") {
        return wongLiuSimulatedAnnealing;
    }
    return require("./layout_optimizer.js").wongLiuSimulatedAnnealing;
})();

function stripComments(text) {
    return text.split("\n")
        .map(line => line.split("#")[0].trim())
        .filter(line => line.length > 0)
        .join("\n");
}

// Translate cross-boundary `connect` rules to `at <dir>` using resolved outer positions.
// Does not mutate the original modules array.
function crossBoundaryConnectToDirs(modules, outerRooms, parentRoom) {
    const lookup = new Map(outerRooms.map(r => [r.id, r]));

    const toDir = (outer) => {
        const dx = outer.centerX - parentRoom.centerX;
        const dy = outer.centerY - parentRoom.centerY;
        return Math.abs(dx) >= Math.abs(dy)
            ? (dx > 0 ? "east" : "west")
            : (dy > 0 ? "south" : "north");
    };

    return modules.map(m => {
        const rules = m.rules.map(rule => {
            if (rule.type !== "connect" || !rule.crossBoundary) {
                return rule;
            }
            const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
            const resolved = targets.map(tid => lookup.get(tid)).filter(Boolean);
            if (!resolved.length) {
                return rule;
            }

            let dir;
            if (rule.any) {
                // pick direction of the nearest target — `any` means connect to at least one
                const nearest = resolved.reduce((best, r) => {
                    const d = Math.hypot(r.centerX - parentRoom.centerX, r.centerY - parentRoom.centerY);
                    return d < best.d ? { r, d } : best;
                }, { r: resolved[0], d: Infinity }).r;
                dir = toDir(nearest);
            } else {
                const dirs = [...new Set(resolved.map(toDir))];
                dir = dirs.length === 1 ? dirs[0] : dirs;
            }

            return { type: "at", dir, weight: rule.weight, required: rule.required };
        });
        return { ...m, rules };
    });
}

// Run SA for modules+config, then recursively run SA for any inside blocks.
// Inner plan canvas dimensions are set to the parent room's resolved dimensions.
// `phantoms` are outer-scope rooms already translated into this level's local frame.
async function optimizeRecursive(modules, config, signal, phantoms = []) {
    const mods = [...modules];
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

        const toInner = (p) => ({
            id: p.id,
            centerX: Math.max(0, Math.min(room.w, p.centerX - room.x)),
            centerY: Math.max(0, Math.min(room.h, p.centerY - room.y)),
        });
        const innerPhantoms = [
            ...rooms.filter(r => r.id !== room.id).map(toInner),
            ...phantoms.map(toInner),
        ];

        const outerRooms = [...rooms.filter(r => r.id !== room.id), ...phantoms];
        const innerModules = crossBoundaryConnectToDirs(mod.inside.modules, outerRooms, room);

        const innerResult = await optimizeRecursive(
            innerModules,
            { ...mod.inside.config, canvasW: room.w, canvasH: room.h },
            signal,
            innerPhantoms,
        );
        room.inside = innerResult;
    }

    return { cost: raw.cost, breakdown: raw.breakdown, rooms };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { stripComments, optimizeRecursive };
}
