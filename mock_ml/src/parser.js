// Wireframe language parser — produces a Doc AST from source text.

import { WireframeError } from "./errors.js";
import { splitTop, splitLinesTop, findTop, matchBalanced, scanFull } from "./splitter.js";

// --- constants ---

const ALLOWED_TAGS = new Set([
    "icon", "input", "button", "hbutton", "h1", "h2", "h3", "strong", "u", "sup",
    "link", "img", "select", "htag", "tag", "hr", "spacer",
]);

const ELEM_RE = /^(icon|input|button|hbutton|h1|h2|h3|strong|u|sup|link|img|select|htag|tag|hr|spacer)\s*\(/;

const MACRO_CALL_RE = /^\$(\w+)\s*\(/;

const MACRO_DEF_RE = /^\s*(inline\s+)?\$(\w+)\s*=\s*\{/;

const FOOTNOTE_DEF_RE = /^\s*sup\(([^)]*)\)\s+(.+)$/;

const META_RE = /^\s*([a-z]\w*)\s*:\s*(.+)$/;

// border keywords → normalized single-char direction
// 'l'=left, 'r'=right, 'u'=up(top), 'd'=down(bottom), 'a'=all
// aliases: lr/rl→lr, ud/du→ud
const BORDER_KW = {
    all: "a",
    l: "l", r: "r", u: "u", d: "d",
    lr: "lr", rl: "lr",
    ud: "ud", du: "ud",
};

const ALL_BORDERS = new Set(["l", "r", "u", "d"]);

function expandBorderKw(kw) {
    const norm = BORDER_KW[kw];
    if (!norm) return null;
    const out = new Set();
    for (const ch of norm) {
        if (ch === "a") for (const d of ALL_BORDERS) out.add(d);
        else out.add(ch);
    }
    return out;
}

// alignment keywords for @align
const ALIGN_MAIN_KW = {
    left: "left", l: "left",
    right: "right", r: "right",
    center: "center", c: "center",
    justify: "justify", j: "justify",
};

const ALIGN_CROSS_KW = {
    top: "flex-start", t: "flex-start",
    bottom: "flex-end", b: "flex-end",
    middle: "center", m: "center",
};

// --- AST constructors ---

function grid(dir, children, weight = null) {
    return {
        kind: "grid",
        dir,
        weight,
        children,
        note: null,
        bordersDefault: null,
        borders: null,
        align: null,
        crossAlign: null,
        height: null,
        minHeight: null,
    };
}

function group(child, weight = null) {
    return {
        kind: "group",
        weight,
        child,
        note: null,
        bordersDefault: null,
        borders: null,
        align: null,
        crossAlign: null,
        height: null,
        minHeight: null,
    };
}

function cell(content, weight = null) {
    return {
        kind: "cell",
        weight,
        content,
        note: null,
        borders: null,
        align: null,
        crossAlign: null,
        height: null,
        minHeight: null,
    };
}

function textNode(value) {
    return { t: "text", value };
}

function elemNode(tag, children) {
    return { t: "elem", tag, children };
}

// --- border / weight modifier parsing ---

// Find the last depth-0 ':' in `s` (ignoring quotes/brackets). Returns its index or -1.
function findLastTopColon(s) {
    let result = -1;
    scanFull(s, (i, ch) => {
        if (ch === ":") result = i;
    });
    return result;
}

// Parse a modifier string (everything after the last top-level ':').
// Returns { weight, borders } or throws WireframeError.
// Accepts: '' | '<number>' | '<borderkw>' | '<number><borderkw>'
function parseModifier(modStr, pos) {
    const result = {
        weight: null,
        borders: null,
        align: null,
        crossAlign: null,
        minHeight: null,
        height: null,
    };
    if (modStr === "") return result;

    let rest = modStr;
    while (true) {
        const alignMatch = /^@([a-zA-Z-]+)/.exec(rest);
        if (!alignMatch) break;

        const word = alignMatch[1].toLowerCase();
        if (ALIGN_MAIN_KW[word]) {
            result.align = ALIGN_MAIN_KW[word];
        } else if (ALIGN_CROSS_KW[word]) {
            result.crossAlign = ALIGN_CROSS_KW[word];
        } else {
            throw new WireframeError(`invalid modifier ':${modStr}'`, pos);
        }
        rest = rest.slice(alignMatch[0].length);
    }

    let matched = true;
    while (matched) {
        matched = false;
        const minHMatch = /^min-h(\d+(?:px|em|rem|%)?)/i.exec(rest);
        if (minHMatch) {
            let val = minHMatch[1];
            if (/^\d+$/.test(val)) val += "px";
            result.minHeight = val;
            rest = rest.slice(minHMatch[0].length);
            matched = true;
            continue;
        }
        const hMatch = /^h(\d+(?:px|em|rem|%)?)/i.exec(rest);
        if (hMatch) {
            let val = hMatch[1];
            if (/^\d+$/.test(val)) val += "px";
            result.height = val;
            rest = rest.slice(hMatch[0].length);
            matched = true;
            continue;
        }
    }

    const numMatch = /^(\d+(?:\.\d+)?)/.exec(rest);
    if (numMatch) {
        result.weight = parseFloat(numMatch[1]);
        rest = rest.slice(numMatch[1].length);
    }

    if (rest !== "") {
        const kw = rest.toLowerCase();
        const expanded = expandBorderKw(kw);
        if (!expanded)
            throw new WireframeError(`invalid modifier ':${modStr}'`, pos);
        result.borders = expanded;
    }

    if (result.weight === null && result.borders === null && result.align === null && result.crossAlign === null && result.minHeight === null && result.height === null)
        throw new WireframeError(`invalid modifier ':${modStr}'`, pos);

    return result;
}

// Extract trailing `:modifier` from a cell content string.
// Returns { before, weight, borders }.
function extractTrailingModifier(s) {
    const ci = findLastTopColon(s);
    if (ci < 0) return {
        before: s,
        weight: null,
        borders: null,
        align: null,
        crossAlign: null,
        minHeight: null,
        height: null,
    };
    const after = s.slice(ci + 1).trim();
    if (after === "") return {
        before: s,
        weight: null,
        borders: null,
        align: null,
        crossAlign: null,
        minHeight: null,
        height: null,
    };
    const mod = parseModifier(after, ci);
    return {
        before: s.slice(0, ci),
        weight: mod.weight,
        borders: mod.borders,
        align: mod.align,
        crossAlign: mod.crossAlign,
        minHeight: mod.minHeight,
        height: mod.height,
    };
}

const PARAM_RE = /\$(\d+)/g;

// Strip // comments: from `//` to end of line, only at depth 0 outside quotes.
// Comment marker must be at start of token (after whitespace) or at a position
// where the previous non-space char is a separator (|, newline, start of input).
// Simplified: strip any `//` that appears at depth 0 outside quotes — the scanner
// guarantees we're not inside brackets or quotes, so `//` here is always a comment.
// Strip `//` line comments at depth 0 outside quotes.
// A `//` is a comment only when it starts a token (preceded by whitespace, `|`, or
// start of input). We scan char-by-char tracking depth/quotes and blank out from
// `//` to the next `\n` when the condition is met. Brackets/quotes are respected
// so `//` inside `'...'` or `(...)` is never a comment.
function stripComments(src) {
    const stack = [];
    let quote = null;
    let out = "";
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            out += ch;
            if (ch === "\\" && i + 1 < src.length) {
                out += src[i + 1];
                i++;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === "\"") {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
            stack.push(ch);
            out += ch;
            continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
            if (stack.length) stack.pop();
            out += ch;
            continue;
        }
        if (stack.length === 0 && ch === "/" && src[i + 1] === "/") {
            const prev = i === 0 ? "" : src[i - 1];
            if (i === 0 || prev === " " || prev === "\t" || prev === "\n" || prev === "|") {
                let j = i + 2;
                while (j < src.length && src[j] !== "\n") j++;
                if (j < src.length) out += "\n";
                i = j;
                continue;
            }
        }
        out += ch;
    }
    return out;
}

// --- preprocess (§4a) ---

function extractMetadata(src) {
    const lines = src.split("\n");
    let title = null;
    let minHeight = null;
    let i = 0;
    while (i < lines.length) {
        const m = META_RE.exec(lines[i]);
        if (!m) break;
        if (m[1] === "title") title = m[2].trim();
        else if (m[1] === "min_height") minHeight = m[2].trim();
        i++;
    }
    return { title, minHeight, body: lines.slice(i).join("\n") };
}

function extractDefsAndFootnotes(src) {
    const defs = {};
    const footnotes = [];
    const logicalLines = splitLinesTop(src);
    const remaining = [];

    for (const line of logicalLines) {
        const mm = MACRO_DEF_RE.exec(line);
        if (mm) {
            const name = mm[2];
            if (Object.prototype.hasOwnProperty.call(defs, name))
                throw new WireframeError(`duplicate macro $${name}`);
            const braceStart = mm[0].length - 1;
            const braceEnd = matchBalanced(line, "{", "}", braceStart);
            defs[name] = {
                body: line.slice(braceStart + 1, braceEnd),
                inline: !!mm[1],
            };
            continue;
        }

        const fm = FOOTNOTE_DEF_RE.exec(line);
        if (fm) {
            footnotes.push({ n: fm[1].trim(), text: fm[2].trim() });
            continue;
        }

        remaining.push(line);
    }

    return { defs, footnotes, body: remaining.join("\n") };
}

// --- macro expansion (§4b) ---

function expandMacro(name, argstr, ctx) {
    const def = ctx.defs[name];
    if (!def) throw new WireframeError(`unknown macro $${name}`);
    if (ctx.stack.includes(name))
        throw new WireframeError(`recursive macro $${name}`);

    const args = splitTop(argstr, ",").map(s => s.trim());
    const body = def.body.replace(PARAM_RE, (_, digits) => {
        const k = Number(digits);
        if (k >= args.length) {
            console.warn(`macro $${name}: missing arg $${k}`);
            return "";
        }
        return args[k];
    });

    ctx.stack.push(name);
    let node;
    try {
        node = parseRows(body, ctx);
    } finally {
        ctx.stack.pop();
    }

    return def.inline ? node : group(node);
}

// --- recursive parse (§4c) ---

function parseRows(text, ctx) {
    const rows = splitLinesTop(text)
        .map(s => s.trim())
        .filter(s => s !== "");

    if (rows.length === 0) return cell([]);
    if (rows.length === 1) return parseRow(rows[0], ctx);
    return grid("col", rows.map(r => parseRow(r, ctx)));
}

function parseRow(line, ctx) {
    const cols = splitTop(line, "|").map(s => s.trim());
    const children = cols.map(c => parseCell(c, ctx));

    if (children.length === 1) {
        return children[0];
    }
    return grid("row", children);
}

// Apply trailing `:modifier` to a node. `s` = full cell string, `fromIdx` = index after main token.
function applyTrailingModifier(node, s, fromIdx) {
    const rest = s.slice(fromIdx);
    if (rest.trim() === "") return;
    const ci = findLastTopColon(rest);
    if (ci < 0)
        throw new WireframeError(`unexpected trailing content`, fromIdx);
    const after = rest.slice(ci + 1).trim();
    if (after === "") return;
    const mod = parseModifier(after, fromIdx + ci);
    if (mod.weight !== null) node.weight = mod.weight;
    if (mod.borders !== null) node.borders = mod.borders;
    if (mod.align !== null) node.align = mod.align;
    if (mod.crossAlign !== null) node.crossAlign = mod.crossAlign;
    if (mod.minHeight !== null) node.minHeight = mod.minHeight;
    if (mod.height !== null) node.height = mod.height;
    // anything between fromIdx and the colon must be whitespace
    if (rest.slice(0, ci).trim() !== "")
        throw new WireframeError(`unexpected trailing content`, fromIdx);
}

function parseCell(seg, ctx) {
    let note = null;
    let ni = -1;
    scanFull(seg, (i, ch) => {
        if (ni === -1 && ch === "<" && seg.startsWith("<-", i) && (i === 0 || seg[i - 1] !== "<")) {
            ni = i;
        }
    });
    if (ni >= 0) {
        let startQuoteIdx = ni + 2;
        while (startQuoteIdx < seg.length && /\s/.test(seg[startQuoteIdx])) {
            startQuoteIdx++;
        }
        if (startQuoteIdx < seg.length) {
            const q = seg[startQuoteIdx];
            if (q === "'" || q === "\"") {
                const endQuoteIdx = matchQuoteEnd(seg, startQuoteIdx);
                note = unescape(seg.slice(startQuoteIdx + 1, endQuoteIdx));
                const before = seg.slice(0, ni);
                const after = seg.slice(endQuoteIdx + 1);
                seg = before + after;
            }
        }
    }

    const s = seg.trim();
    if (s === "") {
        const node = cell([]);
        if (note !== null) node.note = note;
        return node;
    }

    const first = s[0];
    let node;

    // Table prefix: `[:spec content]` — spec between `[` and first whitespace.
    if (first === "[") {
        const afterBracket = s.slice(1);
        const pm = /^(\s*):(\S+)(?=\s)/.exec(afterBracket);
        if (pm) {
            const specStr = pm[2];
            const mod = parseModifier(specStr, 1 + pm[1].length + 1);
            const tableBd = mod.borders;
            const tableWt = mod.weight;
            const tableAlign = mod.align;
            const tableCrossAlign = mod.crossAlign;
            const tableMinHeight = mod.minHeight;
            const tableHeight = mod.height;
            const end = matchBalanced(s, "[", "]", 0);
            const inner = s.slice(1 + pm[0].length, end);
            node = parseRows(inner, ctx);
            node.bordersDefault = tableBd;
            if (tableWt !== null) node.weight = tableWt;
            if (tableAlign !== null) node.align = tableAlign;
            if (tableCrossAlign !== null) node.crossAlign = tableCrossAlign;
            if (tableMinHeight !== null) node.minHeight = tableMinHeight;
            if (tableHeight !== null) node.height = tableHeight;
            applyTrailingModifier(node, s, end + 1);
            node.isTable = true;
        } else {
            const end = matchBalanced(s, "[", "]", 0);
            node = parseRows(s.slice(1, end), ctx);
            applyTrailingModifier(node, s, end + 1);
            node.isTable = true;
        }
    } else if (first === "{") {
        const end = matchBalanced(s, "{", "}", 0);
        node = group(parseRows(s.slice(1, end), ctx));
        applyTrailingModifier(node, s, end + 1);
    } else if (first === "$") {
        const m = MACRO_CALL_RE.exec(s);
        if (m) {
            const name = m[1];
            const parenStart = m[0].length - 1;
            const parenEnd = matchBalanced(s, "(", ")", parenStart);
            const argstr = s.slice(parenStart + 1, parenEnd);
            node = expandMacro(name, argstr, ctx);
            applyTrailingModifier(node, s, parenEnd + 1);
        } else {
            const {
                before: contentStr,
                weight,
                borders,
                align,
                crossAlign,
                minHeight,
                height,
            } = extractTrailingModifier(s);
            node = cell(parseInline(contentStr, ctx), weight);
            if (borders) node.borders = borders;
            if (align) node.align = align;
            if (crossAlign) node.crossAlign = crossAlign;
            if (minHeight) node.minHeight = minHeight;
            if (height) node.height = height;
        }
    } else {
        const {
            before: contentStr,
            weight,
            borders,
            align,
            crossAlign,
            minHeight,
            height,
        } = extractTrailingModifier(s);
        node = cell(parseInline(contentStr, ctx), weight);
        if (borders) node.borders = borders;
        if (align) node.align = align;
        if (crossAlign) node.crossAlign = crossAlign;
        if (minHeight) node.minHeight = minHeight;
        if (height) node.height = height;
    }

    if (note !== null) {
        node.note = note;
    }
    return node;
}

function extractInlineNodes(node) {
    if (!node) return [];
    if (node.kind === "cell") {
        return node.content;
    }
    if (node.kind === "group") {
        return extractInlineNodes(node.child);
    }
    if (node.kind === "grid") {
        return node.children.flatMap(extractInlineNodes);
    }
    return [];
}

const COMMA_SPLIT_TAGS = new Set(["link", "img", "select"]);

function parseElem(tag, argstr, ctx) {
    if (COMMA_SPLIT_TAGS.has(tag)) {
        const parts = splitTop(argstr, ",").map(s => s.trim());
        const children = parts.map(p => parseInline(p, ctx)).flat();
        return elemNode(tag, children);
    }
    const children = parseInline(argstr, ctx);
    if (tag === "icon") {
        const flat = children
            .map(c => (c.t === "text" ? c.value : ""))
            .join("");
        return elemNode("icon", [textNode(flat)]);
    }
    return elemNode(tag, children);
}

function matchQuoteEnd(text, start) {
    const q = text[start];
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === "\\") {
            i++;
            continue;
        }
        if (text[i] === q) return i;
    }
    throw new WireframeError(`unterminated ${q} quote`, start);
}

function unescape(s) {
    return s.replace(/\\(.)/g, "$1");
}

function parseInline(text, ctx) {
    const result = [];
    let buf = "";
    let i = 0;

    const flush = () => {
        if (buf) {
            result.push(textNode(buf));
            buf = "";
        }
    };

    while (i < text.length) {
        const ch = text[i];

        if (text.startsWith("<<-", i)) {
            flush();
            let startQuoteIdx = i + 3;
            while (startQuoteIdx < text.length && /\s/.test(text[startQuoteIdx])) {
                startQuoteIdx++;
            }
            if (startQuoteIdx < text.length) {
                const q = text[startQuoteIdx];
                if (q === "'" || q === "\"") {
                    const endQuoteIdx = matchQuoteEnd(text, startQuoteIdx);
                    const noteText = unescape(text.slice(startQuoteIdx + 1, endQuoteIdx));
                    let targetNode = null;
                    for (let idx = result.length - 1; idx >= 0; idx--) {
                        const node = result[idx];
                        if (node.t === "text" && node.value.trim() === "") {
                            continue;
                        }
                        targetNode = node;
                        break;
                    }
                    if (targetNode) {
                        targetNode.note = noteText;
                    } else {
                        console.warn(`inline note <<- '${noteText}' has no preceding element to attach to`);
                    }
                    i = endQuoteIdx + 1;
                    continue;
                }
            }
        }

        if (ch === "'" || ch === "\"") {
            flush();
            const end = matchQuoteEnd(text, i);
            result.push(textNode(unescape(text.slice(i + 1, end))));
            i = end + 1;
            continue;
        }

        const isWordStart = i === 0 || !/\w/.test(text[i - 1]);
        if (isWordStart) {
            const slice = text.slice(i);
            const m = ELEM_RE.exec(slice);
            if (m) {
                flush();
                const tag = m[1];
                const parenStart = i + m[0].length - 1;
                const parenEnd = matchBalanced(text, "(", ")", parenStart);
                result.push(parseElem(tag, text.slice(parenStart + 1, parenEnd), ctx));
                i = parenEnd + 1;
                continue;
            }

            if (ctx) {
                const mm = MACRO_CALL_RE.exec(slice);
                if (mm) {
                    flush();
                    const name = mm[1];
                    const parenStart = i + mm[0].length - 1;
                    const parenEnd = matchBalanced(text, "(", ")", parenStart);
                    const argstr = text.slice(parenStart + 1, parenEnd);
                    const expandedNode = expandMacro(name, argstr, ctx);
                    result.push(...extractInlineNodes(expandedNode));
                    i = parenEnd + 1;
                    continue;
                }
            }

            const um = /^([a-z]\w*)\s*\(/.exec(slice);
            if (um && !ALLOWED_TAGS.has(um[1]))
                console.warn(`unknown element '${um[1]}' — treating as text`);
        }

        buf += ch;
        i++;
    }

    flush();
    return result;
}

// --- top-level (§4d) ---

export function parse(src) {
    src = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    src = stripComments(src);
    const { title, minHeight, body: afterMeta } = extractMetadata(src);
    const { defs, footnotes, body } = extractDefsAndFootnotes(afterMeta);
    const ctx = { defs, stack: [] };
    const root = parseRows(body, ctx);
    return { title, minHeight, root, footnotes };
}
