const VALID_DIRS = new Set(["north", "south", "east", "west", "edge"]);

const SA_ADVISORY_WEIGHT_WARNING = "SA advisory weight=N uses compressed target N <= 1 ? N : min(1 + log2(N), 25), then effective weight 1 + (target - 1) * min(initial_t / T / 100, 1). At T=initial_t, only 1% of target's offset from 1 applies; target is reached at T <= initial_t / 100. weight=5 therefore targets 3.322, starts at 1.023, and final per-rule scores use 3.322. required bypasses compression and ramp.";

const FEASIBILITY_WARNING_CODES = {
    areaOverflow: "FEASIBILITY_AREA_OVERFLOW",
    insideFrontage: "FEASIBILITY_INSIDE_FRONTAGE",
    requiredAtConflict: "FEASIBILITY_REQUIRED_AT_CONFLICT",
};

const FEASIBILITY_EPSILON = 1e-6;

const RESERVED_KEYWORDS = new Set([
    "canvas", "ratio_max", "area_min", "side_min", "side_max", "cwl", "cwc",
    "seed", "iter", "k", "cooling_rate", "initial_t", "min_t", "algo", "shapes",
    "room", "inside", "any",
    "connect", "close", "far", "at", "not_at", "enclosed",
]);

function levenshtein(a, b) {
    if (a === b) {
        return 0;
    }
    const lenA = a.length;
    const lenB = b.length;
    if (!lenA || !lenB) {
        return lenA || lenB;
    }

    let row0 = new Uint8Array(lenB + 1);
    let row1 = new Uint8Array(lenB + 1);

    for (let i = 0; i <= lenB; i++) {
        row0[i] = i;
    }

    for (let i = 0; i < lenA; i++) {
        row1[0] = i + 1;
        for (let j = 0; j < lenB; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            row1[j + 1] = Math.min(
                row1[j] + 1,
                row0[j + 1] + 1,
                row0[j] + cost,
            );
        }
        [row0, row1] = [row1, row0];
    }

    return row0[lenB];
}

function suggestCorrections(token, keywords, maxDistance = 2) {
    const suggestions = [];

    for (const kw of keywords) {
        if (Math.abs(token.length - kw.length) > maxDistance) {
            continue;
        }

        const dist = levenshtein(token, kw);
        if (dist <= maxDistance) {
            suggestions.push({ kw, dist });
        }
    }

    return suggestions
        .sort((a, b) => a.dist - b.dist)
        .map(match => match.kw);
}

function stripComments(line) {
    const hashIdx = line.indexOf("#");
    const slashIdx = line.indexOf("//");

    if (hashIdx === -1 && slashIdx === -1) {
        return line;
    }

    if (hashIdx !== -1 && slashIdx !== -1) {
        return line.substring(0, Math.min(hashIdx, slashIdx));
    }

    const idx = hashIdx !== -1 ? hashIdx : slashIdx;
    return line.substring(0, idx);
}

function hasRampedAdvisoryWeight(modules) {
    return modules.some(module => {
        const localMatch = (module.rules ?? []).some(rule => !rule.required
            && Number.isFinite(rule.weight)
            && rule.weight !== 1);
        return localMatch || hasRampedAdvisoryWeight(module.inside?.modules ?? []);
    });
}

function finitePositive(value) {
    return Number.isFinite(value) && value > 0;
}

function formatMeasure(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatRatio(value) {
    return String(Math.round(value * 1000) / 1000);
}

function normalizeDirections(dir) {
    if (dir === undefined) {
        return [];
    }
    return Array.isArray(dir) ? dir : String(dir).split(" ").filter(Boolean);
}

function targetGroupKey(rule) {
    const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
    return `${rule.any ? "any:" : "all:"}${[...targets].sort().join("|")}`;
}

function requestedMinimumSide(module) {
    if (finitePositive(module.w) && finitePositive(module.h)) {
        return Math.min(module.w, module.h);
    }
    if (!finitePositive(module.area)) {
        return 0;
    }
    if (finitePositive(module.ratio)) {
        const ratio = Math.max(module.ratio, 1 / module.ratio);
        return Math.sqrt(module.area / ratio);
    }
    if (finitePositive(module.ratioMax)) {
        return Math.sqrt(module.area / module.ratioMax);
    }
    return 0;
}

function requestedMaximumSide(module) {
    if (finitePositive(module.w) && finitePositive(module.h)) {
        return Math.max(module.w, module.h);
    }
    if (!finitePositive(module.area)) {
        return 0;
    }
    if (finitePositive(module.ratio)) {
        const ratio = Math.max(module.ratio, 1 / module.ratio);
        return Math.sqrt(module.area * ratio);
    }
    if (finitePositive(module.ratioMax)) {
        return Math.sqrt(module.area * module.ratioMax);
    }
    return 0;
}

function crossBoundaryFrontageRequirement(module, rule, config) {
    const cwl = finitePositive(rule.cwl) ? rule.cwl : (finitePositive(config.cwl) ? config.cwl : 0);
    const sideMin = config.sideMinFlexible
        ? 0
        : (finitePositive(module.sideMin) ? module.sideMin : (finitePositive(config.sideMin) ? config.sideMin : 0));
    return Math.max(cwl, sideMin, requestedMinimumSide(module));
}

function describeTargets(rule, containingPath) {
    const targets = (Array.isArray(rule.target) ? rule.target : [rule.target])
        .map(target => `${containingPath} / ${target}`);
    return `${rule.any ? "any " : ""}[${targets.join(", ")}]`;
}

function collectRequiredAtWarnings(module, roomPath) {
    const requiredDirections = new Set();
    for (const rule of module.rules ?? []) {
        if (rule.type !== "at" || !rule.required || rule.subjectAny) {
            continue;
        }
        for (const dir of normalizeDirections(rule.dir)) {
            requiredDirections.add(dir);
        }
    }

    const warnings = [];
    const opposingPairs = [
        ["north", "south", "height"],
        ["east", "west", "width"],
    ];
    for (const [first, second, dimension] of opposingPairs) {
        if (!requiredDirections.has(first) || !requiredDirections.has(second)) {
            continue;
        }
        warnings.push(
            `[${FEASIBILITY_WARNING_CODES.requiredAtConflict}] ${roomPath}: opposing required constraints `
            + `at ${first} required and at ${second} required force this room to span full scope ${dimension}; `
            + "treat them as contradictory directional intent unless full-span geometry is deliberate.",
        );
    }
    return warnings;
}

function collectInsideFrontageWarnings(parent, parentPath, containingPath) {
    if (!parent.inside?.modules?.length) {
        return [];
    }
    const parentMaximum = requestedMaximumSide(parent);
    if (!finitePositive(parentMaximum)) {
        return [];
    }

    const demandGroups = new Map();
    const subjectAnyGroups = new Map();
    for (const child of parent.inside.modules) {
        for (const rule of child.rules ?? []) {
            if (rule.type !== "connect" || !rule.crossBoundary || !rule.required) {
                continue;
            }
            const demand = crossBoundaryFrontageRequirement(child, rule, parent.inside.config);
            if (!finitePositive(demand)) {
                continue;
            }
            const entry = { child, rule, demand };
            if (rule.subjectAny && rule.subjectGroupId !== undefined) {
                const key = `${rule.subjectGroupId}:${targetGroupKey(rule)}`;
                if (!subjectAnyGroups.has(key)) {
                    subjectAnyGroups.set(key, { rule, candidates: [] });
                }
                subjectAnyGroups.get(key).candidates.push(entry);
                continue;
            }
            const key = targetGroupKey(rule);
            if (!demandGroups.has(key)) {
                demandGroups.set(key, []);
            }
            const entries = demandGroups.get(key);
            const duplicate = entries.find(candidate => !candidate.rule.subjectAny && candidate.child.id === child.id);
            if (!duplicate) {
                entries.push(entry);
            } else if (demand > duplicate.demand) {
                duplicate.demand = demand;
                duplicate.rule = rule;
            }
        }
    }
    for (const group of subjectAnyGroups.values()) {
        const key = targetGroupKey(group.rule);
        if (!demandGroups.has(key)) {
            demandGroups.set(key, []);
        }
        demandGroups.get(key).push({
            rule: group.rule,
            subjectAnyCandidates: group.candidates,
        });
    }

    const warnings = [];
    for (const entries of demandGroups.values()) {
        const mandatoryEntries = entries.filter(entry => !entry.subjectAnyCandidates);
        const mandatoryByChild = new Map(mandatoryEntries.map(entry => [entry.child.id, entry]));
        const mandatoryDemand = mandatoryEntries.reduce((sum, entry) => sum + entry.demand, 0);
        let subjectAnyDemand = 0;
        let limitingSubjectAny;
        for (const group of entries.filter(entry => entry.subjectAnyCandidates)) {
            const cheapest = group.subjectAnyCandidates
                .map(candidate => ({
                    candidate,
                    incremental: Math.max(0, candidate.demand - (mandatoryByChild.get(candidate.child.id)?.demand ?? 0)),
                }))
                .sort((left, right) => left.incremental - right.incremental)[0];
            if (cheapest && cheapest.incremental > subjectAnyDemand) {
                subjectAnyDemand = cheapest.incremental;
                limitingSubjectAny = group;
            }
        }
        const totalDemand = mandatoryDemand + subjectAnyDemand;
        if (totalDemand <= parentMaximum + FEASIBILITY_EPSILON) {
            continue;
        }
        const children = mandatoryEntries.map(entry => `${parentPath} / ${entry.child.id}=${formatMeasure(entry.demand)} cm`);
        if (limitingSubjectAny) {
            const paths = limitingSubjectAny.subjectAnyCandidates.map(entry => `${parentPath} / ${entry.child.id}`);
            children.push(`any [${paths.join(", ")}] adds at least ${formatMeasure(subjectAnyDemand)} cm`);
        }
        const parentConstraint = finitePositive(parent.w) && finitePositive(parent.h)
            ? `fixed ${formatMeasure(parent.w)}x${formatMeasure(parent.h)} cm dimensions`
            : finitePositive(parent.ratio)
                ? `area=${formatMeasure(parent.area)} cm² and ratio=${formatRatio(parent.ratio)}`
                : `area=${formatMeasure(parent.area)} cm² and ratio_max=${formatRatio(parent.ratioMax)}`;
        warnings.push(
            `[${FEASIBILITY_WARNING_CODES.insideFrontage}] ${parentPath}: required cross-boundary frontage for `
            + `[${children.join(", ")}] targeting ${describeTargets(entries[0].rule, containingPath)} needs at least `
            + `${formatMeasure(totalDemand)} cm on one parent wall, but ${parentConstraint} allow at most `
            + `${formatMeasure(parentMaximum)} cm; shortfall ${formatMeasure(totalDemand - parentMaximum)} cm. `
            + "Demand includes required cwl/non-flexible side_min and each child's requested area/ratio_max rectangular lower bound.",
        );
    }
    return warnings;
}

function collectScopeFeasibilityWarnings(modules, scopePath, includeFrontage) {
    const warnings = [];
    for (const module of modules) {
        const roomPath = `${scopePath} / ${module.id}`;
        warnings.push(...collectRequiredAtWarnings(module, roomPath));
        if (includeFrontage) {
            warnings.push(...collectInsideFrontageWarnings(module, roomPath, scopePath));
        }
        if (module.inside?.modules?.length) {
            warnings.push(...collectScopeFeasibilityWarnings(module.inside.modules, roomPath, includeFrontage));
        }
    }
    return warnings;
}

function collectAreaOverflowWarning(modules, config) {
    if (config.canvasFlexible || !finitePositive(config.canvasW) || !finitePositive(config.canvasH)) {
        return [];
    }
    const requested = modules.filter(module => finitePositive(module.area));
    const totalArea = requested.reduce((sum, module) => sum + module.area, 0);
    const canvasArea = config.canvasW * config.canvasH;
    if (totalArea <= canvasArea + FEASIBILITY_EPSILON) {
        return [];
    }
    const roomPaths = requested.map(module => `top / ${module.id}`);
    return [
        `[${FEASIBILITY_WARNING_CODES.areaOverflow}] top: requested area for [${roomPaths.join(", ")}] totals `
        + `${formatMeasure(totalArea)} cm², but strict canvas ${formatMeasure(config.canvasW)}x${formatMeasure(config.canvasH)} cm `
        + `provides ${formatMeasure(canvasArea)} cm²; shortfall ${formatMeasure(totalArea - canvasArea)} cm².`,
    ];
}

function collectFeasibilityWarnings(modules, config) {
    const isSa = (config.algo ?? "sa") === "sa";
    const warnings = [
        ...collectScopeFeasibilityWarnings(modules, "top", isSa),
    ];
    if (isSa) {
        warnings.push(...collectAreaOverflowWarning(modules, config));
    }
    return [...new Set(warnings)];
}

// Extract `inside <room> { ... }` blocks from DSL text.
// Returns { outerLines: string[], insideBlocks: { roomId: innerDslText } }
// Handles nested `inside` via brace depth tracking.
function extractInsideBlocks(rawLines) {
    const insideBlocks = {};
    const outerLines = [];
    let i = 0;

    while (i < rawLines.length) {
        const line = rawLines[i];
        const cleanLine = stripComments(line);
        const trimmed = cleanLine.trim();

        const match = trimmed.match(/^inside\s+(\S+)(?:\s*\{(.*))?$/);
        if (match) {
            const roomId = match[1];
            let afterBrace = "";
            let foundBrace = false;
            let braceLineIndex = i;

            if (match[2] !== undefined) {
                foundBrace = true;
                afterBrace = match[2];
            } else {
                let j = i + 1;
                while (j < rawLines.length) {
                    const nextLineClean = stripComments(rawLines[j]).trim();
                    if (!nextLineClean) {
                        j++;
                        continue;
                    }
                    if (nextLineClean.startsWith("{")) {
                        foundBrace = true;
                        afterBrace = nextLineClean.substring(1);
                        braceLineIndex = j;
                    }
                    break;
                }
            }

            if (foundBrace) {
                const innerLines = [];
                let depth = 1;

                if (afterBrace.trim()) {
                    innerLines.push(afterBrace.trim());
                }
                i = braceLineIndex + 1;

                while (i < rawLines.length && depth > 0) {
                    const innerLine = rawLines[i];
                    const cleanInnerLine = stripComments(innerLine);

                    const opens = (cleanInnerLine.match(/\{/g) || []).length;
                    const closes = (cleanInnerLine.match(/\}/g) || []).length;
                    depth += opens - closes;

                    if (depth === 0) {
                        const cleanBefore = cleanInnerLine.substring(0, cleanInnerLine.lastIndexOf("}")).trim();
                        if (cleanBefore) {
                            innerLines.push(cleanBefore);
                        }
                    } else {
                        innerLines.push(innerLine);
                    }
                    i++;
                }

                insideBlocks[roomId] = {
                    text: innerLines.join("\n"),
                    unclosed: depth !== 0,
                };
            } else {
                outerLines.push(line);
                i++;
            }
        } else {
            outerLines.push(line);
            i++;
        }
    }

    return { outerLines, insideBlocks };
}

// Global geometry settings an `inside` block inherits from its enclosing scope.
// Canvas dims are excluded on purpose — an inner plan's canvas is the parent room.
// Search/seed settings are excluded too: the orchestrator drives those per level.
const INHERITED_CONFIG_KEYS = ["ratioMax", "areaMin", "sideMin", "sideMinFlexible", "sideMax", "cwl", "cwc", "shapes", "shapeRequired"];

function parseDSL(dslString, _isInside = false, outerScope = new Set(), outerGroups = {}, outerConfig = {}) {
    const rawLines = dslString.split("\n");
    const errors = [];
    const warnings = [];

    const { outerLines, insideBlocks } = extractInsideBlocks(rawLines);

    const lines = outerLines
        .map((text, i) => ({ text: text.trim(), lineNum: i + 1 }))
        .filter(({ text }) => text && !text.startsWith("#") && !text.startsWith("//"));

    const config = {};
    for (const key of INHERITED_CONFIG_KEYS) {
        if (outerConfig[key] !== undefined) {
            config[key] = outerConfig[key];
        }
    }

    const modulesMap = {};
    const declaredRooms = new Set();
    const groups = {};
    let subjectGroupCounter = 0;

    const parseParams = (tokens) => {
        const params = {};
        for (const token of tokens) {
            if (token === "required") {
                params.required = true;
            } else if (token.includes("=")) {
                const eqIdx = token.indexOf("=");
                const key = token.substring(0, eqIdx);
                const value = token.substring(eqIdx + 1);
                params[key === "w" ? "weight" : key] = value;
            }
        }
        return params;
    };

    const parseNum = (str, lineNum, label) => {
        if (!str.trim()) {
            errors.push(`Line ${lineNum}: missing value for '${label}'`);
            return NaN;
        }
        const n = Number(str);
        if (isNaN(n)) {
            errors.push(`Line ${lineNum}: invalid number '${str}' for '${label}'`);
            return NaN;
        }
        if (n <= 0) {
            errors.push(`Line ${lineNum}: '${label}' must be positive (got ${n})`);
            return NaN;
        }
        return n;
    };

    const parseWeight = (params, lineNum) => params.weight === undefined
        ? 1
        : parseNum(params.weight, lineNum, "weight");

    const parseRatio = (str, lineNum, label) => {
        if (str.includes(":")) {
            const [num, den] = str.split(":");
            const n = parseNum(num, lineNum, label), d = parseNum(den, lineNum, label);
            return n / d;
        }
        return parseNum(str, lineNum, label);
    };

    const parseRatioMax = (str, lineNum, label) => {
        const v = parseRatio(str, lineNum, label);
        return isNaN(v) ? v : Math.max(v, 1 / v);
    };

    const KNOWN_RULE_PARAMS = {
        connect: new Set(["weight", "cwl", "required"]),
        close: new Set(["weight", "required"]),
        far: new Set(["weight", "required"]),
        at: new Set(["weight", "required"]),
        not_at: new Set(["weight", "required"]),
        enclosed: new Set(["weight", "required"]),
    };

    const checkParams = (params, ruleType, lineNum) => {
        const known = KNOWN_RULE_PARAMS[ruleType] || new Set();
        for (const key of Object.keys(params)) {
            if (!known.has(key)) {
                const suggestions = suggestCorrections(key, known);
                warnings.push(
                    `Line ${lineNum}: unknown parameter '${key}'` +
                    (suggestions.length ? ` — did you mean '${suggestions[0]}'?` : ""),
                );
            }
        }
    };

    const resolveIds = (name, lineNum) => {
        if (groups[name]) {
            return groups[name];
        }
        if (outerGroups[name]) {
            return outerGroups[name];
        }
        return [name];
    };

    const validateIds = (ids, lineNum, role) => {
        for (const id of ids) {
            if (!declaredRooms.has(id) && !outerScope.has(id)) {
                const known = new Set([...declaredRooms, ...outerScope, ...Object.keys(groups), ...Object.keys(outerGroups)]);
                const suggestions = suggestCorrections(id, known);
                errors.push(
                    `Line ${lineNum}: ${role} '${id}' is not a declared room` +
                    (suggestions.length ? ` — did you mean '${suggestions[0]}'?` : ""),
                );
            }
        }
    };

    // Parse inline "[a, b, c] ..." — returns { subjects, ruleTokens } or null
    // Supports "[all but x, y, ...]" to expand to all declared rooms minus exclusions.
    const parseInlineArray = (line, lineNum) => {
        if (!line.startsWith("[")) {
            return null;
        }
        const closeIdx = line.indexOf("]");
        if (closeIdx === -1) {
            return null;
        }
        const listStr = line.substring(1, closeIdx).trim();
        const rest = line.substring(closeIdx + 1).trim();
        const ruleTokens = rest ? rest.split(/\s+/) : [];

        let subjects;
        if (listStr.startsWith("all but ")) {
            const exclusionStr = listStr.substring("all but ".length);
            const excludeIds = exclusionStr.split(",").map(s => s.trim()).filter(Boolean)
                .flatMap(id => resolveIds(id, lineNum));
            validateIds(excludeIds, lineNum, "exclusion");
            const excludeSet = new Set(excludeIds);
            subjects = [...declaredRooms].filter(id => !excludeSet.has(id));
        } else {
            const ids = listStr.split(",").map(s => s.trim()).filter(Boolean);
            subjects = [...new Set(ids.flatMap(id => resolveIds(id, lineNum)))];
        }

        return { subjects, ruleTokens };
    };

    // Parse a group definition RHS: terms joined by '+', each either "[a, b]" or a bare
    // group/room name. Group references resolve to their members (groups are flat, so
    // definition-time resolution is enough); unknown names stay literal and are
    // validated when the group is used.
    const parseGroupExpr = (expr, lineNum) => {
        const members = [];

        for (const rawTerm of expr.split("+")) {
            const term = rawTerm.trim();
            if (!term) {
                errors.push(`Line ${lineNum}: empty term in group expression`);
                continue;
            }

            if (term.startsWith("[") && term.endsWith("]")) {
                const ids = term.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
                members.push(...ids.flatMap(id => resolveIds(id, lineNum)));
                continue;
            }

            if (term.includes("[") || term.includes("]") || term.includes(",")) {
                errors.push(`Line ${lineNum}: cannot parse group term '${term}' — expected '[a, b]' or a group/room name`);
                continue;
            }

            members.push(...resolveIds(term, lineNum));
        }

        return [...new Set(members)];
    };

    for (const { text: line, lineNum } of lines) {
        const tokens = line.split(/\s+/);
        const cmd = tokens[0];

        // Global settings
        if (cmd === "canvas") {
            if (_isInside) {
                errors.push(`Line ${lineNum}: 'canvas' is not allowed inside an 'inside' block — dimensions come from the parent room`);
                continue;
            }
            if (tokens.length >= 2 && tokens[1].includes("x")) {
                const [w, h] = tokens[1].split("x");
                config.canvasW = parseFloat(w);
                config.canvasH = parseFloat(h);
                config.canvasFlexible = tokens[2] === "flexible";
            } else if (tokens.length >= 3) {
                config.canvasW = parseFloat(tokens[1]);
                config.canvasH = parseFloat(tokens[2]);
                config.canvasFlexible = tokens[3] === "flexible";
            }
        } else if (cmd === "ratio_max") {
            config.ratioMax = parseRatioMax(tokens[1] || "", lineNum, "ratio_max");
        } else if (cmd === "area_min") {
            config.areaMin = parseFloat(tokens[1]);
        } else if (cmd === "side_min") {
            config.sideMin = parseFloat(tokens[1]);
            config.sideMinFlexible = tokens[2] === "flexible";
        } else if (cmd === "side_max") {
            config.sideMax = parseFloat(tokens[1]);
        } else if (cmd === "cwl") {
            config.cwl = parseFloat(tokens[1]);
        } else if (cmd === "cwc") {
            config.cwc = parseFloat(tokens[1]);
        } else if (["seed", "iter", "k", "cooling_rate", "initial_t", "min_t"].includes(cmd)) {
            config[cmd] = parseFloat(tokens[1]);
        } else if (cmd === "algo") {
            if (_isInside) {
                errors.push(`Line ${lineNum}: 'algo' is not allowed inside an 'inside' block — nested plans use the outer algorithm`);
            } else if (tokens.length !== 2 || (tokens[1] !== "sa" && tokens[1] !== "grid")) {
                errors.push(`Line ${lineNum}: 'algo' expects exactly 'sa' or 'grid', got '${tokens.slice(1).join(" ")}'`);
            } else {
                config.algo = tokens[1];
            }
        } else if (cmd === "shapes") {
            if (tokens[1] === "rect" || tokens[1] === "free") {
                config.shapes = tokens[1];
            } else {
                errors.push(`Line ${lineNum}: 'shapes' expects 'rect' or 'free', got '${tokens[1] || ""}'`);
            }
        } else if (cmd === "shape" && tokens.length === 3 && tokens[1] === "rect" && tokens[2] === "required") {
            config.shapes = "rect";
            config.shapeRequired = true;

            // Groups: name = [a, b] + other_group + ...
        } else if (tokens.length >= 3 && tokens[1] === "=") {
            const name = tokens[0];
            groups[name] = parseGroupExpr(line.substring(line.indexOf("=") + 1), lineNum);

            // Rooms
        } else if (cmd === "room") {
            const id = tokens[1];
            if (!id) {
                errors.push(`Line ${lineNum}: 'room' missing name`);
                continue;
            }
            if (RESERVED_KEYWORDS.has(id)) {
                errors.push(`Line ${lineNum}: room name '${id}' is a reserved keyword`);
                continue;
            }
            declaredRooms.add(id);
            if (!modulesMap[id]) {
                modulesMap[id] = { id, rules: [] };
            }
            const m = modulesMap[id];
            const params = parseParams(tokens.slice(2));

            for (const [key, val] of Object.entries(params)) {
                if (key === "area") {
                    if (val.includes("x")) {
                        const [w, h] = val.split("x");
                        m.w = parseNum(w, lineNum, "area width");
                        m.h = parseNum(h, lineNum, "area height");
                        if (!isNaN(m.w) && !isNaN(m.h)) {
                            m.area = m.w * m.h;
                        }
                    } else {
                        m.area = parseNum(val, lineNum, "area");
                    }
                } else if (key === "area_min") {
                    m.areaMin = parseNum(val, lineNum, "area_min");
                } else if (key === "side_min") {
                    m.sideMin = parseNum(val, lineNum, "side_min");
                } else if (key === "ratio") {
                    m.ratio = parseRatio(val, lineNum, "ratio");
                } else if (key === "ratio_max") {
                    m.ratioMax = parseRatioMax(val, lineNum, "ratio_max");
                } else if (key === "cwc") {
                    m.cwc = parseNum(val, lineNum, "cwc");
                } else if (key === "shape") {
                    if (val === "rect:required") {
                        m.shape = "rect";
                        m.shapeRequired = true;
                    } else if (val === "rect" || val === "free") {
                        m.shape = val;
                    } else {
                        errors.push(`Line ${lineNum}: 'shape' expects 'rect', 'free', or 'rect:required', got '${val}'`);
                    }
                } else {
                    const suggestions = suggestCorrections(key, new Set(["area", "area_min", "side_min", "ratio", "ratio_max", "cwc", "shape"]));
                    errors.push(
                        `Line ${lineNum}: unknown room parameter '${key}'` +
                        (suggestions.length ? ` — did you mean '${suggestions[0]}'?` : ""),
                    );
                }
            }

            // Rules
        } else {
            if (cmd !== "any" && !line.startsWith("[")) {
                const isKnownSubject = declaredRooms.has(cmd) || groups[cmd] || outerScope.has(cmd) || outerGroups[cmd];
                if (!isKnownSubject) {
                    const allKnown = new Set([...RESERVED_KEYWORDS, ...declaredRooms, ...outerScope, ...Object.keys(groups), ...Object.keys(outerGroups)]);
                    const suggestions = suggestCorrections(cmd, allKnown);
                    errors.push(
                        `Line ${lineNum}: unknown directive '${cmd}'` +
                        (suggestions.length ? ` — did you mean '${suggestions[0]}'?` : ""),
                    );
                    continue;
                }
            }

            let subjectAny = false;
            let subjects;
            let ruleTokens;

            let parseLine = line;
            if (tokens[0] === "any") {
                subjectAny = true;
                parseLine = line.substring(line.indexOf(" ") + 1).trimStart();
            }

            const inlined = parseInlineArray(parseLine, lineNum);
            if (inlined) {
                ({ subjects, ruleTokens } = inlined);
                if (!ruleTokens.length) {
                    errors.push(`Line ${lineNum}: inline array '[...]' has no rule verb`);
                    continue;
                }
            } else {
                const restTokens = parseLine.split(/\s+/);
                const A = restTokens[0];
                subjects = groups[A] ? groups[A] : (outerGroups[A] ? outerGroups[A] : [A]);
                ruleTokens = restTokens.slice(1);
            }

            validateIds(subjects, lineNum, "subject");
            for (const s of subjects) {
                if (outerScope.has(s)) {
                    errors.push(`Line ${lineNum}: '${s}' is an outer-scope room and cannot be a rule subject inside an inside block`);
                }
            }

            const groupId = subjectAny ? subjectGroupCounter++ : undefined;

            let ruleType = ruleTokens[0];
            let ruleIndex = 0;

            if (ruleType === "not" && ruleTokens[1] === "at") {
                ruleType = "not_at";
                ruleIndex = 1;
            }

            for (const subj of subjects) {
                if (!modulesMap[subj]) {
                    continue;
                } // undeclared, already reported
                const m = modulesMap[subj];

                if (ruleType === "enclosed") {
                    const params = parseParams(ruleTokens.slice(ruleIndex + 1));
                    checkParams(params, "enclosed", lineNum);
                    const rule = {
                        type: "enclosed",
                        weight: parseWeight(params, lineNum),
                        required: !!params.required,
                        subjectAny,
                    };
                    if (groupId !== undefined) {
                        rule.subjectGroupId = groupId;
                    }
                    m.rules.push(rule);

                } else if (ruleType === "at" || ruleType === "not_at") {
                    let dirArray = [];
                    let paramTokens = [];
                    for (let i = ruleIndex + 1; i < ruleTokens.length; i++) {
                        if (ruleTokens[i].includes("=") || ruleTokens[i] === "required") {
                            paramTokens = ruleTokens.slice(i);
                            break;
                        }
                        dirArray.push(ruleTokens[i]);
                    }
                    const params = parseParams(paramTokens);
                    checkParams(params, ruleType, lineNum);

                    if (dirArray.length === 1) {
                        dirArray = dirArray[0];
                    }

                    const VALID_AT_TOKENS = new Set([...VALID_DIRS, "required"]);
                    const dirsToCheck = Array.isArray(dirArray) ? dirArray : [dirArray];
                    for (const d of dirsToCheck) {
                        if (!VALID_DIRS.has(d)) {
                            const suggestions = suggestCorrections(d, VALID_AT_TOKENS);
                            errors.push(
                                `Line ${lineNum}: unknown direction '${d}'` +
                                (suggestions.length ? ` — did you mean '${suggestions[0]}'?` : ""),
                            );
                        }
                    }

                    const rule = {
                        type: ruleType,
                        dir: dirArray,
                        weight: parseWeight(params, lineNum),
                        required: !!params.required,
                        subjectAny,
                    };
                    if (groupId !== undefined) {
                        rule.subjectGroupId = groupId;
                    }
                    m.rules.push(rule);

                } else if (["close", "far", "connect"].includes(ruleType)) {
                    let anyModifier = false;
                    let targetStart = ruleIndex + 1;
                    if (ruleTokens[targetStart] === "any") {
                        anyModifier = true;
                        targetStart++;
                    }

                    let targets = [];
                    let paramTokens = [];

                    const remainingStr = ruleTokens.slice(targetStart).join(" ");
                    if (remainingStr.startsWith("[")) {
                        const closeIdx = remainingStr.indexOf("]");
                        if (closeIdx === -1) {
                            errors.push(`Line ${lineNum}: unclosed '[' in target list`);
                            continue;
                        }
                        const listStr = remainingStr.substring(1, closeIdx).trim();
                        const rest = remainingStr.substring(closeIdx + 1).trim();
                        if (rest) {
                            paramTokens = rest.split(/\s+/);
                        }
                        if (listStr.startsWith("all but ")) {
                            const exclusionStr = listStr.substring("all but ".length);
                            const excludeIds = exclusionStr.split(",").map(s => s.trim()).filter(Boolean)
                                .flatMap(id => resolveIds(id, lineNum));
                            validateIds(excludeIds, lineNum, "exclusion");
                            const excludeSet = new Set(excludeIds);
                            targets = [...declaredRooms].filter(id => !excludeSet.has(id));
                        } else {
                            targets = listStr.split(",").map(s => s.trim());
                        }
                    } else {
                        const targetName = ruleTokens[targetStart];
                        targets = resolveIds(targetName, lineNum);
                        paramTokens = ruleTokens.slice(targetStart + 1);
                    }

                    const resolvedTargets = targets.flatMap(t => groups[t] ? groups[t] : (outerGroups[t] ? outerGroups[t] : [t]));
                    validateIds(resolvedTargets, lineNum, "target");

                    const params = parseParams(paramTokens);
                    checkParams(params, ruleType, lineNum);

                    const hasCrossBoundaryTarget = resolvedTargets.some(t => outerScope.has(t) && !declaredRooms.has(t));
                    if (hasCrossBoundaryTarget && ruleType !== "connect" && params.required) {
                        warnings.push(`Line ${lineNum}: 'required' is not supported on cross-boundary rules and will be ignored`);
                    }

                    const ruleObj = {
                        type: ruleType,
                        target: targets.length === 1 ? targets[0] : targets,
                        any: anyModifier,
                        weight: parseWeight(params, lineNum),
                        // cross-boundary connect is translated to `at <dir>` so `required` is meaningful there;
                        // for close/far cross-boundary, required cannot be enforced
                        required: (hasCrossBoundaryTarget && ruleType !== "connect") ? false : !!params.required,
                        subjectAny,
                    };
                    if (hasCrossBoundaryTarget) {
                        ruleObj.crossBoundary = true;
                    }
                    if (ruleType === "connect" && params.cwl) {
                        ruleObj.cwl = parseFloat(params.cwl);
                    }
                    if (groupId !== undefined) {
                        ruleObj.subjectGroupId = groupId;
                    }

                    m.rules.push(ruleObj);

                } else {
                    const verbSuggestions = suggestCorrections(ruleType, new Set(["connect", "close", "far", "at", "not", "enclosed"]));
                    errors.push(
                        `Line ${lineNum}: unknown rule verb '${ruleType}'` +
                        (verbSuggestions.length ? ` — did you mean '${verbSuggestions[0]}'?` : ""),
                    );
                }
            }
        }
    }

    for (const m of Object.values(modulesMap)) {
        if (config.ratioMax && !m.ratioMax) {
            m.ratioMax = config.ratioMax;
        }
        if (config.sideMin && !m.sideMin) {
            m.sideMin = config.sideMin;
        }
    }

    // Parse inside blocks and attach to their parent rooms
    const parsedInsideBlocks = {};
    for (const [roomId, block] of Object.entries(insideBlocks)) {
        if (block.unclosed) {
            errors.push(`'inside ${roomId}': unclosed '{' block`);
            continue;
        }
        if (!declaredRooms.has(roomId)) {
            errors.push(`'inside ${roomId}': room '${roomId}' is not declared in this scope`);
            continue;
        }
        const inner = parseDSL(block.text, true, declaredRooms, groups, config);
        // Prefix inner errors/warnings with context
        for (const e of inner.errors) {
            errors.push(`inside ${roomId}: ${e}`);
        }
        for (const w of inner.warnings) {
            warnings.push(`inside ${roomId}: ${w}`);
        }

        parsedInsideBlocks[roomId] = {
            config: inner.config,
            modules: inner.modules,
            insideBlocks: inner.insideBlocks,
        };
        modulesMap[roomId].inside = parsedInsideBlocks[roomId];
    }

    const modules = Object.values(modulesMap);
    if (!_isInside && errors.length === 0) {
        warnings.push(...collectFeasibilityWarnings(modules, config));
    }
    if (!_isInside && (config.algo ?? "sa") === "sa" && hasRampedAdvisoryWeight(modules)) {
        warnings.push(SA_ADVISORY_WEIGHT_WARNING);
    }

    return {
        config,
        modules,
        errors,
        warnings,
        insideBlocks: parsedInsideBlocks,
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseDSL };
}
