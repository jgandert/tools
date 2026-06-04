const VALID_DIRS = new Set(["north", "south", "east", "west", "edge"]);

const RESERVED_KEYWORDS = new Set([
    "canvas", "ratio_max", "area_min", "side_min", "side_max", "cwl", "cwc",
    "seed", "iter", "k", "cooling_rate", "initial_t", "min_t", "algo",
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

function parseDSL(dslString, _isInside = false, outerScope = new Set(), outerGroups = {}) {
    const rawLines = dslString.split("\n");
    const errors = [];
    const warnings = [];

    const { outerLines, insideBlocks } = extractInsideBlocks(rawLines);

    const lines = outerLines
        .map((text, i) => ({ text: text.trim(), lineNum: i + 1 }))
        .filter(({ text }) => text && !text.startsWith("#") && !text.startsWith("//"));

    const config = {};
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

    const parseRatio = (str, lineNum, label) => {
        if (str.includes(":")) {
            const [num, den] = str.split(":");
            const n = parseNum(num, lineNum, label), d = parseNum(den, lineNum, label);
            return n / d;
        }
        return parseNum(str, lineNum, label);
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
            subjects = listStr.split(",").map(s => s.trim()).filter(Boolean);
        }

        return { subjects, ruleTokens };
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
            config.ratioMax = parseRatio(tokens[1]);
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
            config.algo = tokens[1];

            // Groups: name = [a, b, c]
        } else if (tokens.length >= 3 && tokens[1] === "=") {
            const name = tokens[0];
            const listStr = line.substring(line.indexOf("[") + 1, line.lastIndexOf("]"));
            groups[name] = listStr.split(",").map(s => s.trim());

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
                    m.ratioMax = parseRatio(val, lineNum, "ratio_max");
                } else if (key === "cwc") {
                    m.cwc = parseNum(val, lineNum, "cwc");
                } else {
                    const suggestions = suggestCorrections(key, new Set(["area", "area_min", "side_min", "ratio", "ratio_max", "cwc"]));
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
                        weight: params.weight ? parseFloat(params.weight) : 1,
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
                        weight: params.weight ? parseFloat(params.weight) : 1,
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
                        weight: params.weight ? parseFloat(params.weight) : 1,
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
        const inner = parseDSL(block.text, true, declaredRooms, groups);
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

    return {
        config,
        modules: Object.values(modulesMap),
        errors,
        warnings,
        insideBlocks: parsedInsideBlocks,
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseDSL };
}
