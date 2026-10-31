/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global require */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const { readPreferences, paragraphSeparator, planInsertion } = require("./paste-workflow.js");

describe("paste insertion", () => {
    function insert(value, text, start, end = start, appendMode = false) {
        const plan = planInsertion(value, text, { start, end }, appendMode);
        return plan ? value.slice(0, plan.start) + plan.text + value.slice(plan.end) : value;
    }

    test("inserts at a cursor and replaces only the selected text", () => {
        expect(insert("before after", "**bold** ", 7)).toBe("before **bold** after");
        expect(insert("before selected after", "**bold**", 7, 15)).toBe("before **bold** after");
    });

    test("keeps surrounding code, tabs, blank lines and hard breaks exact", () => {
        const before = "```js\n\t  code();  \n```\n\n";
        const after = "\n\nTail  \nnext\n\n";
        expect(insert(before + "replace" + after, "  plain\n\ttext  \n", before.length, before.length + 7))
            .toBe(before + "  plain\n\ttext  \n" + after);
    });

    test("append ignores the selection and preserves existing trailing whitespace", () => {
        const original = "```\n  code  \n```  \n  ";
        expect(insert(original, "More", 0, original.length, true)).toBe(original + "\nMore");
    });

    test("empty and unsupported contents never remove a selection or add a separator", () => {
        for (const text of ["", undefined, null]) {
            expect(insert("keep", text, 0, 4)).toBe("keep");
            expect(insert("keep", text, 0, 4, true)).toBe("keep");
        }
    });

    test("plain whitespace and punctuation are still input", () => {
        expect(insert("AB", " \t\n  ", 1)).toBe("A \t\n  B");
        expect(insert("", "\r\n“Text”—…\r\n", 0)).toBe("\r\n“Text”—…\r\n");
    });
});

describe("append paragraph separator", () => {
    test.each([
        ["", "Text", ""],
        ["Text", "", ""],
        ["Text", "More", "\n\n"],
        ["Text\n", "More", "\n"],
        ["Text\n\n", "More", ""],
        ["Text\n\n\n", "More", ""],
        ["Text  ", "  More", "\n\n"],
        ["Text\n  ", "More", "\n"],
        ["Text\n\t \n  ", "More", ""],
        ["Text", "\nMore", "\n"],
        ["Text", "\n\nMore", ""],
        ["Text\n", "  \nMore", ""],
        ["Text\r\n", "More", "\n"],
        ["Text\r\n\r\n", "More", ""],
        ["Text\r", "\nMore", "\n"],
    ])("between %j and %j", (before, after, separator) => {
        expect(paragraphSeparator(before, after)).toBe(separator);
    });
});

describe("conversion preferences", () => {
    const defaults = { version: 1, appendMode: true, normalizePunctuation: false };

    test.each([undefined, null, false, [], "{broken", {}, {
        version: 2,
        appendMode: false,
    }].map(stored => [stored]))("corrupt or unsupported state %j uses defaults", stored => {
        expect(readPreferences(stored)).toEqual(defaults);
    });

    test("restores only boolean preferences from the supported version", () => {
        expect(readPreferences({ version: 1, appendMode: false })).toEqual({
            ...defaults,
            appendMode: false,
        });
        expect(readPreferences({
            version: 1,
            appendMode: "true",
            normalizePunctuation: true,
        })).toEqual({ ...defaults, normalizePunctuation: true });
        expect(readPreferences({
            version: 1,
            appendMode: true,
            normalizePunctuation: true,
            draft: "private",
        }))
            .toEqual({ version: 1, appendMode: true, normalizePunctuation: true });
    });

    test("does not share mutable defaults or change the stored object", () => {
        const stored = Object.freeze({ version: 1, normalizePunctuation: true });
        readPreferences(stored).appendMode = true;
        readPreferences().normalizePunctuation = true;
        expect(readPreferences(stored)).toEqual({ ...defaults, normalizePunctuation: true });
        expect(readPreferences()).toEqual(defaults);
    });
});

test("classic browser script works without DOM or module globals", () => {
    const context = {};
    runInNewContext(readFileSync(new URL("paste-workflow.js", import.meta.url), "utf8"), context);
    expect(context.mdPaste.planInsertion("A", "B", { start: 0, end: 0 }, true).text).toBe("\n\nB");
});
