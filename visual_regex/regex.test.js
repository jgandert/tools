/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

import { expect, test } from "bun:test";
import { TYPES, RegexParser, Generator, joinLiteralsInAST } from "./regex.js";

const cases = [
    ["ordinary text", "^abcd$", "", ["abcd", "abc", "abcdd", "xabcdy"]],
    ["repeated literal", "^a+a+$", "", ["a", "aa", "aaa", "aaaa", "b"]],
    ["equal plus quantifiers", "^a+b+$", "", ["ab", "aabb", "abb", "aaabbb", "aba"]],
    ["different quantifiers", "^a*b+$", "", ["b", "ab", "aabb", "a", ""]],
    ["equal exact counts", "^a{2}b{2}$", "", ["aabb", "abb", "abab", "aab"]],
    ["equal ranges", "^a{1,3}b{1,3}$", "", ["ab", "aabb", "aaabbb", "abab", "aaaab"]],
    ["equal optional atoms", "^a?b?$", "", ["", "a", "b", "ab", "abb"]],
    ["quantified trailing atom", "^abc+$", "", ["abc", "abcc", "abcabc", "ab"]],
    ["lazy captures", "^(a+?b+?)(a?)$", "", ["ab", "aabb", "aabba", "aba"]],
    ["joined text in alternatives", "^(?:abc|def)+$", "", ["abc", "def", "abcdef", "ab", "defdef"]],
    ["tabs", "^a\\tb$", "", ["a\tb", "atb", "ab", "a\\tb"]],
    ["newlines", "^a\\nb$", "", ["a\nb", "anb", "ab", "a\\nb"]],
    ["adjacent whitespace escapes", "^\\t\\n$", "", ["\t\n", "tn", "\t", "\n"]],
    ["other character escapes", "^\\r\\f\\v$", "", ["\r\f\v", "rfv", "\r\f"]],
    ["hex escape", "^\\x41$", "", ["A", "x41", "41", "AA"]],
    ["hex escape repetition", "^\\x41+$", "", ["A", "AA", "x411", "AA41"]],
    ["adjacent hex escapes", "^\\x41\\x42c$", "", ["ABc", "x41x42c", "AB", "Abc"]],
    ["Unicode escape", "^\\u0041$", "", ["A", "u0041", "AA"]],
    ["Unicode escape repetition", "^\\u0041{2}$", "", ["A", "AA", "u00411", "AA1"]],
    ["Unicode code point", "^\\u{1F600}+$", "u", ["😀", "😀😀", "u", "1F600", ""]],
    ["escaped punctuation", "^a\\.\\+\\*\\?\\[\\]\\(\\)\\{\\}\\|\\^\\$\\\\b$", "", ["a.+*?[](){}|^$\\b", "a.+*?[](){}|^$b", "a"]],
    ["escaped punctuation repetition", "^\\.+\\++$", "", [".+", "..++", ".+++", "..", ".+.++"]],
    ["escaped letters", "^a\\qb$", "", ["aqb", "a\\qb", "ab"]],
    ["control escape repetition", "^\\cA+$", "", ["\x01", "\x01\x01", "cAA", "A"]],
    ["zero-prefixed octal", "^\\012+$", "", ["\n", "\n\n", "\x00122", "0122"]],
    ["literal astral text", "^😀b$", "u", ["😀b", "😀😀b", "b", "😀"]],
];

function observableMatch(pattern, flags, input) {
    const match = new RegExp(pattern, flags).exec(input);
    return match ? { values: [...match], index: match.index } : null;
}

for (const joined of [false, true]) {
    test.each(cases)(`%s preserves matching and captures with joining ${joined}`, (_name, pattern, flags, inputs) => {
        const ast = new RegexParser(pattern).parse();
        if (joined) joinLiteralsInAST(ast);
        const generated = Generator.generate(ast);
        const reparsed = new RegexParser(generated).parse();
        if (joined) joinLiteralsInAST(reparsed);
        const regenerated = Generator.generate(reparsed);

        for (const input of inputs) {
            const expected = observableMatch(pattern, flags, input);
            expect(observableMatch(generated, flags, input)).toEqual(expected);
            expect(observableMatch(regenerated, flags, input)).toEqual(expected);
        }
    });
}

test("repetitions apply to an entire multi-character Text block without creating a capture", () => {
    const block = {
        type: TYPES.LITERAL,
        value: "ab",
        quantifier: { min: 2, max: 3, greedy: false },
    };
    const pattern = `^${Generator.generate(block)}(c)$`;
    expect(observableMatch(pattern, "", "ababc")?.values).toEqual(["ababc", "c"]);
    expect(observableMatch(pattern, "", "abababc")?.values).toEqual(["abababc", "c"]);
    expect(observableMatch(pattern, "", "abbbc")).toBeNull();
    expect(observableMatch(pattern, "", "abc")).toBeNull();
});

test("whole-block repetitions also escape punctuation in Text", () => {
    const block = {
        type: TYPES.LITERAL,
        value: "a.",
        quantifier: { min: 2, max: 2, greedy: true },
    };
    const pattern = `^${Generator.generate(block)}$`;
    expect(observableMatch(pattern, "", "a.a.")?.values).toEqual(["a.a."]);
    expect(observableMatch(pattern, "", "a..")).toBeNull();
    expect(observableMatch(pattern, "", "axax")).toBeNull();
});

test.each([
    ")", "^abc)", "^abc)def$", "a|b)c",
    "(abc", "(?:abc", "(?=abc", "(?>abc", "(?P<name>abc", "(a(b)",
    "[abc", "[^abc", "[abc\\]", "[\\",
    "a{2", "a{2,3", "a{foo}", "a{2foo}", "a{2,foo}", "a{2,3,4}",
    "a{}", "a{2,,3}", "a{,foo}", "a{ 2}", "a{2 }", "a{2\n}",
    "a{-1}", "a{1.5}", "a{1e2}", "a{3,2}",
    "a{9007199254740992}", "a{0,9007199254740992}",
    `a{0,${"9".repeat(400)}}`,
])("rejects incomplete or malformed %s without returning an AST", pattern => {
    expect(() => new RegexParser(pattern).parse()).toThrow(/.+ at position \d+/);
});

test.each([
    ["a{0}", 0, 0],
    ["a{2}", 2, 2],
    ["a{2,}", 2, Infinity],
    ["a{2,3}", 2, 3],
    ["a{,3}", 0, 3],
    ["a{,}", 0, Infinity],
    ["a{02,003}", 2, 3],
    ["a{9007199254740991}", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
])("preserves the supported bounds of %s", (pattern, min, max) => {
    const ast = new RegexParser(pattern).parse();
    expect(ast.children[0].quantifier).toEqual({ min, max, greedy: true });
    const generated = new RegexParser(Generator.generate(ast)).parse();
    expect(generated.children[0].quantifier).toEqual({ min, max, greedy: true });
});

test.each([
    "", "((a|b)(?:c|d))", "(?ix)(?P<word>a{,3})(?P=word)", "(?>a)(?<=a)b",
    "^\\)\\]\\}$", "[a\\]b]", "[(){}]", "(?:\\)|a{2,3}?)", "[^\\]]",
])("fully parses valid nested groups, dialect features, and escaped closers in %s", pattern => {
    const parser = new RegexParser(pattern);
    const ast = parser.parse();
    expect(parser.pos).toBe(pattern.length);
    expect(() => new RegexParser(Generator.generate(ast)).parse()).not.toThrow();
});
