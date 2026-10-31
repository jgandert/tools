/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

/* AST Node Definitions */

const TYPES = {
    ROOT: "ROOT",
    LITERAL: "LITERAL",     // Normal text
    SET: "SET",             // [a-z] or \d
    GROUP: "GROUP",         // (...)
    BRANCH: "BRANCH",       // | (Alternation)
    ANCHOR: "ANCHOR",       // ^ $ \b
    DOT: "DOT",             // .
    FLAGS: "FLAGS",          // (?ix) inline flags
    BACKREF: "BACKREF",      // \1, \2...
};

// Creates a default unique ID for nodes to help with DOM diffing/event handling
const uid = () => Math.random().toString(36).substring(2, 11);

/* Recursive Descent Parser */

class RegexParser {
    constructor(pattern) {
        this.pattern = pattern;
        this.pos = 0;
        this.len = pattern.length;
    }

    peek() {
        return this.pos < this.len ? this.pattern[this.pos] : null;
    }

    consume() {
        return this.pos < this.len ? this.pattern[this.pos++] : null;
    }

    match(char) {
        if (this.peek() === char) {
            this.pos++;
            return true;
        }
        return false;
    }

    // Match an exact substring at the current position
    matchStr(str) {
        if (this.pattern.substring(this.pos, this.pos + str.length) === str) {
            this.pos += str.length;
            return true;
        }
        return false;
    }

    error(msg) {
        throw new Error(`${msg} at position ${this.pos}`);
    }

    parse() {
        const root = { type: TYPES.ROOT, children: [], id: uid() };
        root.children = this.parseAlternation();
        if (this.pos !== this.len) this.error("Unexpected closing parenthesis");
        return root;
    }

    // Handles a | b | c
    parseAlternation() {
        const options = [];
        let currentSequence = [];

        while (this.pos < this.len && this.peek() !== ")") {
            if (this.match("|")) {
                options.push(currentSequence);
                currentSequence = [];
            } else {
                const atom = this.parseAtom();
                if (atom) {
                    // Flags nodes cannot have quantifiers
                    const quantified = atom.type === TYPES.FLAGS ? atom : this.parseQuantifier(atom);
                    currentSequence.push(quantified);
                } else {
                    break;
                }
            }
        }

        options.push(currentSequence);

        if (options.length > 1) {
            return [{
                type: TYPES.BRANCH,
                branches: options,
                id: uid(),
            }];
        } else {
            return currentSequence;
        }
    }

    // Check if the substring at current pos (after '(?') is a flags-only group
    // e.g. (?ix), (?i), etc. - no content, just flags followed by ')'
    isInlineFlagsOnly() {
        const saved = this.pos;
        let flags = "";
        while (this.pos < this.len && /[aimsux]/.test(this.peek())) {
            flags += this.consume();
        }
        if (flags.length > 0 && this.peek() === ")") {
            // It's a flags-only group like (?ix)
            this.pos = saved;
            return true;
        }
        this.pos = saved;
        return false;
    }

    parseAtom() {
        const char = this.peek();
        if (char === null) return null;

        // End of group
        if (char === ")" || char === "|") return null;

        // Group
        if (this.match("(")) {
            let capturing = true;
            let name = null;

            if (this.match("?")) {
                // Inline flags only: (?ix)
                if (this.isInlineFlagsOnly()) {
                    let flags = "";
                    while (this.pos < this.len && /[aimsux]/.test(this.peek())) {
                        flags += this.consume();
                    }
                    if (!this.match(")")) this.error("Expected ) after inline flags");
                    return {
                        type: TYPES.FLAGS,
                        flags: flags,
                        id: uid(),
                    };
                }
                // Lookahead/lookbehind: (?=...) (?!...) (?<=...) (?<!...)
                else if ("=!".includes(this.peek()) || (this.peek() === "<" && this.pos + 1 < this.len && "=!".includes(this.pattern[this.pos + 1]))) {
                    let lookType;
                    if (this.match("<")) {
                        lookType = "<" + this.consume(); // <= or <!
                    } else {
                        lookType = this.consume(); // = or !
                    }
                    const children = this.parseAlternation();
                    if (!this.match(")")) this.error("Unclosed lookaround group");
                    return {
                        type: TYPES.GROUP,
                        capturing: false,
                        lookType: "?" + lookType,
                        children: children,
                        id: uid(),
                    };
                }
                // Atomic group: (?>...)
                else if (this.match(">")) {
                    const children = this.parseAlternation();
                    if (!this.match(")")) this.error("Unclosed atomic group");
                    return {
                        type: TYPES.GROUP,
                        capturing: false,
                        lookType: "?>",
                        children: children,
                        id: uid(),
                    };
                }
                // Named group: (?P<name>...) or (?<name>...)
                else if (this.matchStr("P<") || this.match("<")) {
                    name = "";
                    while (this.pos < this.len && this.peek() !== ">") {
                        name += this.consume();
                    }
                    if (!this.match(">")) this.error("Expected > after group name");
                    capturing = true;
                }
                // Python style named backreference: (?P=name)
                else if (this.matchStr("P=")) {
                    let name = "";
                    while (this.pos < this.len && this.peek() !== ")") {
                        name += this.consume();
                    }
                    if (!this.match(")")) this.error("Expected ) after named backref");
                    return {
                        type: TYPES.BACKREF,
                        named: true,
                        value: name,
                        id: uid(),
                    };
                }
                // Non-capturing: (?:...)
                else if (this.match(":")) {
                    capturing = false;
                }
            }

            const children = this.parseAlternation();
            if (!this.match(")")) this.error("Unclosed group");

            return {
                type: TYPES.GROUP,
                capturing: capturing,
                name: name,
                children: children,
                id: uid(),
            };
        }

        // Set [...]
        if (this.match("[")) {
            let content = "";
            let negated = false;
            let closed = false;
            if (this.match("^")) {
                negated = true;
            }

            // Proper set content parsing that handles escape sequences
            while (this.pos < this.len) {
                if (this.peek() === "\\") {
                    // Consume the backslash and the next char as a pair
                    content += this.consume(); // backslash
                    if (this.pos < this.len) content += this.consume(); // escaped char
                } else if (this.peek() === "]") {
                    this.consume();
                    closed = true;
                    break;
                } else {
                    content += this.consume();
                }
            }

            if (!closed) this.error("Unclosed character set: expected ]");

            return {
                type: TYPES.SET,
                content: content,
                negated: negated,
                id: uid(),
            };
        }

        // Anchors
        if (this.match("^")) return {
            type: TYPES.ANCHOR,
            kind: "Start",
            value: "^",
            id: uid(),
        };
        if (this.match("$")) return { type: TYPES.ANCHOR, kind: "End", value: "$", id: uid() };
        if (this.match(".")) return { type: TYPES.DOT, id: uid() };

        // Escapes
        if (this.match("\\")) {
            const esc = this.consume();
            if (esc === null) this.error("Expected a character after backslash");

            // Backreference \1, \2...
            if (/[1-9]/.test(esc)) {
                let val = esc;
                while (this.pos < this.len && /[0-9]/.test(this.peek())) {
                    val += this.consume();
                }
                return { type: TYPES.BACKREF, value: val, id: uid() };
            }
            // Predefined sets
            if ("dDwWsS".includes(esc)) {
                return {
                    type: TYPES.SET,
                    predefined: "\\" + esc,
                    id: uid(),
                };
            }
            // Anchor \b \B
            if ("bB".includes(esc)) {
                return {
                    type: TYPES.ANCHOR,
                    kind: "Boundary",
                    value: "\\" + esc,
                    id: uid(),
                };
            }
            // Keep the complete escape in one atom so a following quantifier has the same scope.

            let suffix = "";
            const remaining = this.pattern.slice(this.pos);
            if (esc === "x") suffix = remaining.match(/^[0-9a-f]{2}/i)?.[0] || "";
            if (esc === "u") suffix = remaining.match(/^(?:[0-9a-f]{4}|\{[0-9a-f]+\})/i)?.[0] || "";
            if (esc === "c") suffix = remaining.match(/^[a-z]/i)?.[0] || "";
            if (esc === "0") suffix = remaining.match(/^[0-7]{1,2}/)?.[0] || "";
            this.pos += suffix.length;

            return {
                type: TYPES.LITERAL,
                value: esc + suffix,
                escaped: true,
                id: uid(),
            };
        }

        // Literal
        const val = this.consume();
        if ("*+?{}".includes(val)) this.error(`Unexpected quantifier ${val}`);

        return { type: TYPES.LITERAL, value: val, id: uid() };
    }

    parseQuantifier(atom) {
        let min = 1, max = 1;
        let greedy = true;
        let quantified = false;

        if (this.match("*")) {
            min = 0;
            max = Infinity;
            quantified = true;
        } else if (this.match("+")) {
            min = 1;
            max = Infinity;
            quantified = true;
        } else if (this.match("?")) {
            min = 0;
            max = 1;
            quantified = true;
        } else if (this.match("{")) {
            const start = this.pos;
            while (this.pos < this.len && this.peek() !== "}") this.pos++;
            const content = this.pattern.substring(start, this.pos);
            if (!this.match("}")) this.error("Unclosed quantifier: expected }");

            const bounds = content.match(/^([0-9]*)(?:,([0-9]*))?$/);
            if (!bounds || bounds[0] !== content || (bounds[1] === "" && bounds[2] === undefined)) {
                this.error("Invalid quantifier: expected {n}, {n,}, {n,m}, {,m}, or {,}");
            }

            min = Number(bounds[1]);
            max = bounds[2] === undefined ? min : bounds[2] === "" ? Infinity : Number(bounds[2]);
            if (!Number.isSafeInteger(min) || (bounds[2] !== "" && !Number.isSafeInteger(max))) {
                this.error("Quantifier bounds must be safe integers");
            }
            if (max < min) this.error("Quantifier maximum must be at least its minimum");
            quantified = true;
        }

        if (quantified) {
            if (this.match("?")) greedy = false;
            atom.quantifier = { min, max, greedy };
        }

        return atom;
    }
}

/* AST Generator */

const SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/;

const Generator = {
    generate(node) {
        if (Array.isArray(node)) return node.map(n => Generator.generate(n)).join("");

        let out = "";

        switch (node.type) {
            case TYPES.ROOT:
                out = Generator.generate(node.children);
                break;
            case TYPES.LITERAL:
                // Escape special chars, but preserve already-escaped literals
                if (node.escaped) {
                    out = "\\" + node.value;
                } else {
                    out = node.value.split("").map(c => SPECIAL_CHARS.test(c) ? "\\" + c : c).join("");
                }
                break;
            case TYPES.DOT:
                out = ".";
                break;
            case TYPES.ANCHOR:
                out = node.value;
                break;
            case TYPES.SET:
                if (node.predefined) {
                    out = node.predefined;
                } else {
                    out = `[${node.negated ? "^" : ""}${node.content}]`;
                }
                break;
            case TYPES.GROUP: {
                const inner = Generator.generate(node.children);
                if (node.lookType) {
                    out = `(${node.lookType}${inner})`;
                } else if (node.name) {
                    out = `(?P<${node.name}>${inner})`;
                } else if (node.capturing) {
                    out = `(${inner})`;
                } else {
                    out = `(?:${inner})`;
                }
                break;
            }
            case TYPES.BRANCH:
                out = node.branches.map(b => Generator.generate(b)).join("|");
                break;
            case TYPES.FLAGS:
                out = `(?${node.flags})`;
                break;
            case TYPES.BACKREF:
                if (node.named) {
                    out = `(?P=${node.value})`;
                } else {
                    out = "\\" + node.value;
                }
                break;
        }

        // Append quantifier
        if (node.quantifier) {
            if (node.type === TYPES.LITERAL && !node.escaped && node.value.length !== 1) {
                out = `(?:${out})`;
            }

            const { min, max, greedy } = node.quantifier;
            if (min === 0 && max === Infinity) out += "*";
            else if (min === 1 && max === Infinity) out += "+";
            else if (min === 0 && max === 1) out += "?";
            else if (min === max) out += `{${min}}`;
            else out += `{${min},${max === Infinity ? "" : max}}`;

            if (!greedy) out += "?";
        }

        return out;
    },
};

function joinLiteralsInAST(node) {
    if (!node || typeof node !== "object") return;
    if (node.children) {
        node.children = joinLiteralsInArray(node.children);
        node.children.forEach(joinLiteralsInAST);
    }
    if (node.branches) {
        for (let i = 0; i < node.branches.length; i++) {
            node.branches[i] = joinLiteralsInArray(node.branches[i]);
            node.branches[i].forEach(joinLiteralsInAST);
        }
    }
}

function joinLiteralsInArray(arr) {
    const result = [];
    for (const current of arr) {
        const prev = result[result.length - 1];
        if (prev?.type === TYPES.LITERAL && current.type === TYPES.LITERAL &&
            !prev.quantifier && !current.quantifier && !prev.escaped && !current.escaped) {
            prev.value += current.value;
            continue;
        }
        result.push(current);
    }
    return result;
}
// A classic browser script preserves direct local-file use; Bun imports the same implementation for tests.

if (typeof module !== "undefined") {
    module.exports = { TYPES, uid, RegexParser, Generator, joinLiteralsInAST };
}
