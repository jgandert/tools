/**
 * Evaluates query strings against a JSON dataset.
 * Supports path traversal, filtering, projection, modifiers, and multi-query composition.
 * Intermediate results are cached by query prefix to speed up repeated or incremental queries.
 * All operations are read-only; data mutation inside queries is prohibited.
 */
class JSONQuery {
    constructor(data = {}) {
        this.cache = new Map();
        this.setData(data);
    }

    setData(newData) {
        this.data = typeof structuredClone === "function"
            ? structuredClone(newData)
            : this._deepCloneFallback(newData);
        this.cache.clear();
        this.cache.set("", this.data);
    }

    _deepCloneFallback(obj) {
        if (obj === null || typeof obj !== "object") {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this._deepCloneFallback(item));
        }
        const clone = {};
        for (const key in obj) {
            clone[key] = this._deepCloneFallback(obj[key]);
        }
        return clone;
    }

    _parseComposition(str) {
        if (!str.startsWith("{") || !str.endsWith("}")) {
            return null;
        }
        const content = str.slice(1, -1).trim();
        const pairs = [];

        let currentAlias = "", currentQuery = "", inString = false, stringChar = "", depth = 0,
            phase = "ALIAS";

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            if (!inString && phase === "QUERY" && char === "/" && /[=!]~\s*$/.test(currentQuery)) {
                const literal = this._readRegexLiteral(content, i);
                currentQuery += content.slice(i, literal.end);
                i = literal.end - 1;
                continue;
            }

            if ((char === "\"" || char === "'" || char === "`") && content[i - 1] !== "\\") {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (stringChar === char) {
                    inString = false;
                }
            }

            if (!inString) {
                if (char === "{" || char === "[") {
                    depth++;
                }
                if (char === "}" || char === "]") {
                    depth--;
                }
            }

            if (depth === 0 && !inString) {
                if (phase === "ALIAS" && char === ":") {
                    phase = "QUERY";
                    continue;
                }
                if (phase === "QUERY" && char === ",") {
                    pairs.push({ alias: currentAlias.trim(), query: currentQuery.trim() });
                    currentAlias = "";
                    currentQuery = "";
                    phase = "ALIAS";
                    continue;
                }
            }

            if (phase === "ALIAS") {
                currentAlias += char;
            }
            if (phase === "QUERY") {
                currentQuery += char;
            }
        }

        if (currentAlias && currentQuery) {
            pairs.push({ alias: currentAlias.trim(), query: currentQuery.trim() });
        }

        const cleanAlias = (a) => a.replace(/^["'`]|["'`]$/g, "");

        const isValid = pairs.length > 0 && pairs.every(p => {
            const a = cleanAlias(p.alias);
            return a.length > 0 && p.query.length > 0;
        });

        return isValid ? pairs.map(p => ({ alias: cleanAlias(p.alias), query: p.query })) : null;
    }

    update(queryStr) {
        queryStr = queryStr.trim();
        if (this.cache.has(queryStr)) {
            return this.cache.get(queryStr);
        }

        const composition = this._parseComposition(queryStr);
        if (composition) {
            const result = Object.create(null);
            for (const { alias, query } of composition) {
                result[alias] = this.update(query);
            }
            this.cache.set(queryStr, result);
            return result;
        }

        const tokens = this._tokenize(queryStr);
        let currentData = this.data;
        let prefixKey = "";

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const nextKey = prefixKey + (prefixKey ? " | " : "") + token.raw;

            if (this.cache.has(nextKey)) {
                currentData = this.cache.get(nextKey);
            } else {
                currentData = this._evaluateStep(currentData, token);
                this.cache.set(nextKey, Array.isArray(currentData) ? [...currentData] : currentData);
            }
            prefixKey = nextKey;
        }

        this.cache.set(queryStr, currentData);
        return currentData;
    }

    _tokenize(queryStr) {
        const tokens = [];
        let cursor = 0;

        while (cursor < queryStr.length) {
            const remaining = queryStr.slice(cursor);

            const wsMatch = remaining.match(/^\s+/);
            if (wsMatch) {
                cursor += wsMatch[0].length;
                continue;
            }

            let match = remaining.match(/^(?:\.)?=>\s*{((?:[^'"`}]|'[^']*'|"[^"]*"|`[^`]*`)+)}/);
            if (match) {
                tokens.push({ type: "PROJECTION", val: match[1].trim(), raw: match[0] });
                cursor += match[0].length;
                continue;
            }

            const filter = this._readFilterToken(remaining);
            if (filter) {
                tokens.push(filter);
                cursor += filter.raw.length;
                continue;
            }

            match = remaining.match(/^:([a-zA-Z_]+)(?:\(([^)]*)\))?/);
            if (match) {
                tokens.push({ type: "MODIFIER", val: match[1], args: match[2], raw: match[0] });
                cursor += match[0].length;
                continue;
            }

            // Slice notation, e.g. users[0:2], users[1:], users[:-1].
            match = remaining.match(/^(?:\.)?\[\s*(-?\d+)?\s*:\s*(-?\d+)?\s*\]/);
            if (match) {
                tokens.push({
                    type: "SLICE",
                    start: match[1] !== undefined && match[1] !== null ? parseInt(match[1], 10) : undefined,
                    end: match[2] !== undefined && match[2] !== null ? parseInt(match[2], 10) : undefined,
                    raw: match[0],
                });
                cursor += match[0].length;
                continue;
            }

            // Array/string indexing, e.g. users[0] or users[-1].
            match = remaining.match(/^(?:\.)?\[\s*(-?\d+)\s*\]/);
            if (match) {
                tokens.push({ type: "INDEX", val: parseInt(match[1], 10), raw: match[0] });
                cursor += match[0].length;
                continue;
            }

            match = remaining.match(/^(?:\.)?`([^`]+)`/);
            if (match) {
                tokens.push({ type: "PATH", val: match[1], raw: match[0] });
                cursor += match[0].length;
                continue;
            }

            match = remaining.match(/^(?:\.)?([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (match) {
                tokens.push({ type: "PATH", val: match[1], raw: match[0] });
                cursor += match[0].length;
                continue;
            }

            throw new Error(`Syntax Error: Unrecognized token at "${remaining.slice(0, 10)}"`);
        }
        return tokens;
    }

    _readRegexLiteral(str, start) {
        let inCharacterClass = false;

        for (let cursor = start + 1; cursor < str.length; cursor++) {
            const char = str[cursor];
            if (/[\r\n\u2028\u2029]/.test(char)) {
                throw new Error("Syntax Error: Unterminated regex literal before line break.");
            }
            if (char === "\\") {
                if (cursor + 1 === str.length || /[\r\n\u2028\u2029]/.test(str[cursor + 1])) {
                    throw new Error("Syntax Error: Unterminated regex literal after escape.");
                }
                cursor++;
                continue;
            }
            if (char === "[" && !inCharacterClass) {
                inCharacterClass = true;
                continue;
            }
            if (char === "]" && inCharacterClass) {
                inCharacterClass = false;
                continue;
            }
            if (char !== "/" || inCharacterClass) {
                continue;
            }

            const pattern = str.slice(start + 1, cursor);
            let end = cursor + 1;
            while (end < str.length && /[a-zA-Z]/.test(str[end])) {
                end++;
            }
            const flags = str.slice(cursor + 1, end);
            try {
                new RegExp(pattern, flags);
            } catch (error) {
                throw new Error(`Syntax Error: Invalid regex literal: ${error.message}`);
            }
            return { end, pattern, flags };
        }

        throw new Error(`Syntax Error: Unterminated regex literal${inCharacterClass ? " character class" : ""}.`);
    }

    _readFilterToken(str) {
        const opening = str.match(/^\.?{/);
        if (!opening) {
            return null;
        }
        const contentStart = opening[0].length;
        const regexLiterals = [];
        let quote = "";

        for (let cursor = contentStart; cursor < str.length; cursor++) {
            const char = str[cursor];
            if (quote) {
                if (char === quote) {
                    quote = "";
                } else if (char === "\\" && quote !== "`") {
                    cursor++;
                }
                continue;
            }
            if (char === "'" || char === "\"" || char === "`") {
                quote = char;
                continue;
            }
            if (char === "/" && /[=!]~\s*$/.test(str.slice(contentStart, cursor))) {
                const literal = this._readRegexLiteral(str, cursor);
                regexLiterals.push({ start: cursor, ...literal });
                cursor = literal.end - 1;
                continue;
            }
            if (char !== "}") {
                continue;
            }

            const content = str.slice(contentStart, cursor);
            const offset = contentStart + content.length - content.trimStart().length;
            return {
                type: "FILTER",
                val: content.trim(),
                raw: str.slice(0, cursor + 1),
                regexLiterals: regexLiterals.map(literal => ({
                    ...literal,
                    start: literal.start - offset,
                    end: literal.end - offset,
                })),
            };
        }

        throw new Error("Syntax Error: Unterminated filter; expected closing '}'.");
    }

    _resolvePath(obj, pathStr) {
        if (!pathStr || obj === null || obj === undefined) {
            return undefined;
        }
        return pathStr.split(".").reduce((o, i) => o?.[i], obj);
    }

    _replaceInlineModifiers(str, isProjection = false) {
        const strings = [];
        const quotedFields = [];
        let fieldPrefix = "__FIELD_";
        while (str.includes(fieldPrefix)) {
            fieldPrefix += "_";
        }

        // Protect field names until every expression rewrite has finished.

        let js = str.replace(/`[^`]+`|(["'])(?:(?=(\\?))\2.)*?\1/g, match => {
            if (match.startsWith("`")) {
                const key = match.slice(1, -1);
                quotedFields.push({ key, code: `__ctx[${JSON.stringify(key)}]` });
                return `${fieldPrefix}${quotedFields.length - 1}__`;
            }

            strings.push(match);
            return `__STR_${strings.length - 1}__`;
        });

        if (isProjection) {
            const keyRegex = new RegExp(`(^|[,{])\\s*(${fieldPrefix}(\\d+)__)\\s*:`, "g");
            js = js.replace(keyRegex, (_match, prefix, placeholder, index) => {
                quotedFields[index].code = JSON.stringify(quotedFields[index].key).slice(1, -1);
                return `${prefix}"${placeholder}":`;
            });
        }

        const knownMods = "len|flat|unique|join|limit|sum|avg|max|min|group_by|sort|reverse|keys|values|count_by|upper|lower|trim|entries";
        const modRegex = new RegExp(`\\b([a-zA-Z_][a-zA-Z0-9_.]*):(${knownMods})(?:\\(([^)]*)\\))?`, "g");

        js = js.replace(modRegex, (_match, path, mod, args) => {
            if (!args) {
                return `__mod(${path}, "${mod}", null)`;
            }
            const trimmed = args.trim();
            const safeArgs = /^__STR_\d+__$/.test(trimmed) ? trimmed : `"${args.replace(/"/g, "\\\"")}"`;
            return `__mod(${path}, "${mod}", ${safeArgs})`;
        });

        strings.forEach((s, i) => {
            js = js.replace(`__STR_${i}__`, () => s);
        });

        const fieldRegex = new RegExp(`\\b${fieldPrefix}(\\d+)__\\b`, "g");
        return {
            code: js,
            restoreFields: code => code.replace(fieldRegex, (_match, index) => quotedFields[index].code),
        };
    }

    _evaluateStep(data, token) {
        if (data === undefined || data === null) {
            return undefined;
        }

        const __mod = this._applyModifier.bind(this);

        // Wraps the current item in a Proxy so that:
        // 1. Missing keys resolve to undefined instead of throwing a ReferenceError.
        // 2. Assignment attempts (e.g. users.{age = 40}) throw immediately via the `set` trap.
        const createSandboxProxy = (__ctx) => new Proxy(Object(__ctx), {
            has: (t, k) => {
                if (typeof k !== "string") {
                    return false;
                }
                const reserved = ["__rest", "omits", "__mod", "__ctx", "Math", "Date", "String", "Number", "Boolean", "Array", "Object", "RegExp", "console"];
                return !reserved.includes(k);
            },
            get: (t, k) => t[k],
            set: () => {
                throw new Error("Data mutation inside queries is strictly prohibited.");
            },
        });

        switch (token.type) {
            case "PATH":
                return Array.isArray(data) ? data.map(item => item?.[token.val]) : data[token.val];

            case "INDEX": {
                const idx = token.val;
                if (Array.isArray(data) || typeof data === "string") {
                    return idx < 0 ? data[data.length + idx] : data[idx];
                }
                return undefined;
            }

            case "SLICE": {
                if (Array.isArray(data) || typeof data === "string") {
                    return data.slice(token.start, token.end);
                }
                return undefined;
            }

            case "FILTER": {
                const jsCondition = this._transpileFilter(token.val, token.regexLiterals);
                const evaluator = new Function("__ctx", "createSandboxProxy", "__mod", `
          try {
            with(createSandboxProxy(__ctx)) { return (${jsCondition}); }
          } catch(e) { return false; }
        `);
                return Array.isArray(data)
                    ? data.filter(item => evaluator(item, createSandboxProxy, __mod))
                    : (evaluator(data, createSandboxProxy, __mod) ? data : undefined);
            }

            case "PROJECTION": {
                const { code, omits } = this._transpileProjection(token.val);
                const mapper = new Function("__ctx", "omits", "createSandboxProxy", "__mod", `
          try {
            const __rest = { ...__ctx };
            omits.forEach(k => delete __rest[k]);
            with(createSandboxProxy(__ctx)) { return ({ ${code} }); }
          } catch(e) { return undefined; }
        `);
                return Array.isArray(data)
                    ? data.map(item => mapper(item, omits, createSandboxProxy, __mod))
                    : mapper(data, omits, createSandboxProxy, __mod);
            }

            case "MODIFIER":
                return this._applyModifier(data, token.val, token.args);
        }
    }

    _transpileFilter(str, regexLiterals) {
        let regexPrefix = "__REGEX_";
        while (str.includes(regexPrefix)) {
            regexPrefix += "_";
        }

        let protectedExpression = "";
        let cursor = 0;
        regexLiterals.forEach((literal, index) => {
            protectedExpression += str.slice(cursor, literal.start) + `${regexPrefix}${index}__`;
            cursor = literal.end;
        });
        protectedExpression += str.slice(cursor);

        // Protect regexes from string, field, modifier, and operator rewrites.

        const { code, restoreFields } = this._replaceInlineModifiers(protectedExpression);
        let js = code;

        const field = "([a-zA-Z_$][a-zA-Z0-9_.$]*|__ctx\\[\"[^\"]+\"\\])";
        const regex = `(${regexPrefix}\\d+__)`;

        js = js.replace(new RegExp(`\\bhas\\s+${field}`, "g"), "$1 !== undefined");
        js = js.replace(new RegExp(`${field}\\s*!~\\s*${regex}`, "g"), "($1 != null && !$2.test($1))");
        js = js.replace(new RegExp(`${field}\\s*=~\\s*${regex}`, "g"), "($1 != null && $2.test($1))");
        js = js.replace(new RegExp(`${field}\\s+contains\\s+(["'][^"']+["'])`, "g"), "($1?.includes?.($2) ?? false)");
        js = js.replace(new RegExp(`(["'][^"']+["'])\\s+in\\s+${field}`, "g"), "($2?.includes?.($1) ?? false)");

        // Treat single = as == (no assignment in query filters).
        js = js.replace(/(?<![!=<>])=(?![=~>])/g, "==");

        js = js.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\b/g, "!");
        return restoreFields(js).replace(new RegExp(`\\b${regexPrefix}(\\d+)__\\b`, "g"), (_match, index) => {
            const { pattern, flags } = regexLiterals[index];
            return `(new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}))`;
        });
    }

    _transpileProjection(str) {
        const result = this._replaceInlineModifiers(str, true);
        let code = result.code;
        let omits = [];
        code = code.replace(/\.\.\.\s*but\s+([a-zA-Z0-9_,\s]+)/, (_, fields) => {
            omits = fields.split(",").map(s => s.trim());
            return "...__rest";
        });
        code = code.replace(/\.\.\.(?!__rest)/g, "...__rest");
        return { code: result.restoreFields(code), omits };
    }

    _applyModifier(data, mod, args) {
        const isArr = Array.isArray(data);
        switch (mod) {
            case "len":
                return isArr ? data.length : Object.keys(data || {}).length;
            case "flat":
                return isArr ? data.flat() : data;
            case "unique":
                return isArr ? [...new Set(data)] : data;
            case "join":
                return isArr ? data.join(args ? args.replace(/['"]/g, "") : ",") : String(data);
            case "limit":
                return isArr ? data.slice(0, parseInt(args, 10)) : data;
            case "sum":
                return isArr ? data.reduce((a, b) => a + Number(b), 0) : Number(data);
            case "avg":
                return isArr && data.length ? data.reduce((a, b) => a + Number(b), 0) / data.length : 0;
            case "max":
                return isArr ? Math.max(...data.map(Number)) : Number(data);
            case "min":
                return isArr ? Math.min(...data.map(Number)) : Number(data);
            case "group_by": {
                const key = args?.trim();
                return isArr ? data.reduce((acc, obj) => {
                    const k = this._resolvePath(obj, key) ?? "undefined";
                    acc[k] = acc[k] || [];
                    acc[k].push(obj);
                    return acc;
                }, Object.create(null)) : { [this._resolvePath(data, key)]: [data] };
            }
            case "sort": {
                if (!isArr) {
                    return data;
                }
                const [key, dir] = (args || "").split(",").map(s => s.trim());
                const mult = dir === "desc" ? -1 : 1;
                return data.slice().sort((a, b) => {
                    const valA = this._resolvePath(a, key), valB = this._resolvePath(b, key);
                    if (valA === valB) {
                        return 0;
                    }
                    if (valA === undefined) {
                        return 1;
                    }
                    if (valB === undefined) {
                        return -1;
                    }
                    return valA < valB ? -1 * mult : 1 * mult;
                });
            }
            case "reverse":
                return isArr ? [...data].reverse() : data;
            case "keys":
                return Object.keys(data || {});
            case "values":
                return isArr ? data : Object.values(data || {});
            case "count_by": {
                const key = args?.trim();
                if (!isArr) {
                    return { [this._resolvePath(data, key) ?? "undefined"]: 1 };
                }
                return data.reduce((acc, obj) => {
                    const k = this._resolvePath(obj, key) ?? "undefined";
                    acc[k] = (acc[k] || 0) + 1;
                    return acc;
                }, Object.create(null));
            }
            case "upper":
                return isArr ? data.map(v => typeof v === "string" ? v.toUpperCase() : v)
                    : typeof data === "string" ? data.toUpperCase() : data;
            case "lower":
                return isArr ? data.map(v => typeof v === "string" ? v.toLowerCase() : v)
                    : typeof data === "string" ? data.toLowerCase() : data;
            case "trim":
                return isArr ? data.map(v => typeof v === "string" ? v.trim() : v)
                    : typeof data === "string" ? data.trim() : data;
            case "entries": {
                if (isArr) {
                    return data.map((value, i) => ({ key: i, value }));
                }
                return Object.entries(data || {}).map(([key, value]) => ({ key, value }));
            }
            default:
                return data;
        }
    }
}

/**
 * Like JSON.stringify but emits the literal word `undefined` for undefined values
 * instead of converting them to null (arrays) or omitting them (objects).
 */
function stringifyWithUndefined(value, indent = 2) {
    const fmt = (val, depth) => {
        if (val === undefined) {
            return "undefined";
        }
        if (val === null) {
            return "null";
        }
        if (typeof val === "string") {
            return JSON.stringify(val);
        }
        if (typeof val === "number" || typeof val === "boolean") {
            return String(val);
        }
        const pad = " ".repeat(indent * (depth + 1));
        const closePad = " ".repeat(indent * depth);
        if (Array.isArray(val)) {
            if (val.length === 0) {
                return "[]";
            }
            return "[\n" + val.map(v => pad + fmt(v, depth + 1)).join(",\n") + "\n" + closePad + "]";
        }
        if (typeof val === "object") {
            const keys = Object.keys(val);
            if (keys.length === 0) {
                return "{}";
            }
            return "{\n" + keys.map(k => pad + JSON.stringify(k) + ": " + fmt(val[k], depth + 1)).join(",\n") + "\n" + closePad + "}";
        }
        return String(val);
    };
    return fmt(value, 0);
}
