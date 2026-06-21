// Balanced top-level scanners — core utility for the wireframe compiler.
// Split/scan only at depth 0, ignoring separators inside quotes and brackets.

import { WireframeError } from "./errors.js";

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const PAIRS = { ")": "(", "]": "[", "}": "{" };
const QUOTES = new Set(["'", "\""]);

// Walk the full string tracking a bracket stack and quote state.
// Calls `visit(i, ch)` for each char at depth 0 and outside quotes.
// Throws WireframeError (with pos) on unterminated quote or bracket mismatch.
export function scanFull(str, visit) {
    const stack = [];
    let quote = null;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (quote) {
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (QUOTES.has(ch)) {
            quote = ch;
            continue;
        }
        if (OPENERS.has(ch)) {
            stack.push(ch);
            continue;
        }
        if (CLOSERS.has(ch)) {
            if (!stack.length || stack[stack.length - 1] !== PAIRS[ch])
                throw new WireframeError(`unexpected '${ch}'`, i);
            stack.pop();
            continue;
        }
        if (stack.length === 0) visit(i, ch);
    }
    if (quote) throw new WireframeError(`unterminated ${quote} quote`, str.length);
    if (stack.length) throw new WireframeError(`unbalanced '${stack[stack.length - 1]}'`, str.length);
}

// Split on `sepChar` at depth 0. Does NOT trim. Empty segments preserved.
export function splitTop(str, sepChar) {
    const parts = [];
    let last = 0;
    scanFull(str, (i, ch) => {
        if (ch === sepChar) {
            parts.push(str.slice(last, i));
            last = i + 1;
        }
    });
    parts.push(str.slice(last));
    return parts;
}

// Split on `\n` at depth 0 (so multi-line `{…}`/`[…]` stays one logical row).
export function splitLinesTop(str) {
    return splitTop(str, "\n");
}

// First index of literal `token` at depth 0, outside quotes. -1 if not found.
// Assumes token does not contain bracket or quote chars (e.g. `<-`).
export function findTop(str, token) {
    let result = -1;
    scanFull(str, (i, ch) => {
        if (result === -1 && ch === token[0] && str.startsWith(token, i))
            result = i;
    });
    return result;
}

// Given str[startIdx]===open, return index of the matching close.
// Throws WireframeError (with pos) if unbalanced or mismatched.
export function matchBalanced(str, open, close, startIdx) {
    if (str[startIdx] !== open)
        throw new WireframeError(`expected '${open}'`, startIdx);

    const stack = [];
    let quote = null;
    for (let i = startIdx; i < str.length; i++) {
        const ch = str[i];

        if (quote) {
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (QUOTES.has(ch)) {
            quote = ch;
            continue;
        }
        if (OPENERS.has(ch)) {
            stack.push(ch);
            continue;
        }
        if (CLOSERS.has(ch)) {
            if (!stack.length || stack[stack.length - 1] !== PAIRS[ch])
                throw new WireframeError(`unexpected '${ch}'`, i);
            stack.pop();
            if (stack.length === 0) return i;
            continue;
        }
    }
    if (quote) throw new WireframeError(`unterminated ${quote} quote`, str.length);
    throw new WireframeError(`unbalanced '${open}'`, startIdx);
}
