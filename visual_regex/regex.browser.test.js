/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, process */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let server;
let browser;
let context;
let page;
let pageErrors;

beforeAll(async () => {
    const files = new Map([
        ["/visual_regex/index.html", new URL("index.html", import.meta.url)],
        ["/visual_regex/regex.js", new URL("regex.js", import.meta.url)],
        ["/visual_regex/icon.svg", new URL("icon.svg", import.meta.url)],
        ["/one.js", new URL("../one.js", import.meta.url)],
        ["/one.css", new URL("../one.css", import.meta.url)],
    ]);
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const file = files.get(new URL(request.url).pathname);
            return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.protocol === "file:" || url.origin === server.url.origin ? route.continue() : route.abort();
    });
    await page.goto(new URL("visual_regex/index.html", server.url).href);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function loadPattern(pattern, joined = true) {
    await page.locator("#join-literals").setChecked(joined);
    await page.locator("#regex-out").fill(pattern);
    expect(await page.locator("#error-msg").isVisible()).toBe(false);
}

async function matchingResults(pattern, inputs) {
    return page.evaluate(({
                              pattern,
                              inputs,
                          }) => inputs.map(input => new RegExp(pattern).test(input)), {
        pattern,
        inputs,
    });
}

const patterns = [
    ["^a+b+$", ["ab", "aabb", "abb", "abab"]],
    ["^a{2}b{2}$", ["aabb", "abb", "abab"]],
    ["^a\\tb$", ["a\tb", "atb", "ab"]],
    ["^a\\nb$", ["a\nb", "anb", "ab"]],
    ["^\\x41+$", ["A", "AA", "x411", "AA41"]],
    ["^\\u0041{2}$", ["AA", "A", "u00411"]],
    ["^\\.+\\++$", [".+", "..++", "..", ".+.++"]],
    ["^(?:abc|def)+$", ["abc", "def", "abcdef", "ab"]],
    ["^\\)\\]\\}$", [")]}", ")", "]", "}"]],
    ["^[a\\]b]+$", ["a]b", "]", "ab", "c"]],
    ["^((a|b)(?:c|d))$", ["ac", "bd", "ab", "a"]],
];

for (const joined of [false, true]) {
    test.each(patterns)(`an unrelated visual edit preserves %s with joining ${joined}`, async (pattern, inputs) => {
        await loadPattern(pattern, joined);
        const expected = await matchingResults(pattern, inputs);
        expect(expected).toContain(true);
        expect(expected).toContain(false);

        await page.locator("#tree-root > .toolbox select").selectOption({ label: "Non-capturing Group" });
        const edited = await page.locator("#regex-out").inputValue();
        expect(await matchingResults(edited, inputs)).toEqual(expected);
        await page.reload();
        expect(await page.locator("#regex-out").inputValue()).toBe(edited);
        expect(await matchingResults(edited, inputs)).toEqual(expected);
    });
}

test.each([
    [1280, "light", 1],
    [390, "dark", 1],
    [780, "light", 2],
])("repeating and splitting Text preserves whole-block scope at screen width %i in %s with scale %i", async (width, colorScheme, zoom) => {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
        width: width / zoom,
        height: 900 / zoom,
        deviceScaleFactor: zoom,
        mobile: false,
    });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await loadPattern("^ab$");
    const block = page.locator("#tree-root > .type-LITERAL");
    expect(await block.count()).toBe(1);
    expect(await block.locator("[title^='Add Repetitions']").getAttribute("title")).toContain("entire Text block");
    await block.locator("[title^='Add Repetitions']").focus();
    await page.keyboard.press("Enter");

    await block.locator(".repeat-group input").first().fill("2");
    await page.keyboard.press("Tab");
    await block.locator(".repeat-group input").last().fill("3");
    await page.keyboard.press("Tab");
    const inputs = ["abab", "ababab", "ab", "abb", "abababab"];
    const expected = [true, true, false, false, false];
    const repeated = await page.locator("#regex-out").inputValue();
    expect(await matchingResults(repeated, inputs)).toEqual(expected);

    await block.locator("[title='Split into individual characters']").focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#tree-root > .type-GROUP .type-LITERAL").count()).toBe(2);
    const split = await page.locator("#regex-out").inputValue();
    expect(await matchingResults(split, inputs)).toEqual(expected);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("a hexadecimal escape remains one repeatable atom without a character-split action", async () => {
    await loadPattern("^\\x41$");
    const block = page.locator("#tree-root > .type-LITERAL");
    expect(await block.count()).toBe(1);
    expect(await block.locator("input.text").inputValue()).toBe("x41");
    expect(await block.locator("[title='Split into individual characters']").count()).toBe(0);
    await block.locator("[title='Add Repetitions']").focus();
    await page.keyboard.press("Enter");
    await block.locator(".repeat-group input").first().fill("2");
    await page.keyboard.press("Tab");
    await block.locator(".repeat-group input").last().fill("2");
    await page.keyboard.press("Tab");
    const pattern = await page.locator("#regex-out").inputValue();
    expect(await matchingResults(pattern, ["AA", "A", "x411"])).toEqual([true, false, false]);
});

test("the extracted engine still supports opening the tool directly from a local file", async () => {
    await page.goto(pathToFileURL(`${import.meta.dir}/index.html`).href);
    await loadPattern("^a+b+$");
    await page.locator("#tree-root > .toolbox select").selectOption({ label: "Non-capturing Group" });
    const pattern = await page.locator("#regex-out").inputValue();
    expect(await matchingResults(pattern, ["aabb", "abab"])).toEqual([true, false]);
});

test("zero-width highlighting preserves source text and native match positions", async () => {
    const cases = [
        ["^", "abc", ""],
        ["$", "abc", ""],
        ["^|$", "abc", ""],
        ["(?=b)", "abc", ""],
        ["(?!b)", "abc", ""],
        ["(?<=a)", "abc", ""],
        ["(?<!a)", "abc", ""],
        ["a?", "abc", ""],
        ["a*", "abc", ""],
        ["a*?", "abc", ""],
        ["a{0,2}", "aabc", ""],
        ["(?:)", "abc", ""],
        ["\\b", "ab cd", ""],
        ["z", "abc", ""],
        ["(?:)", "a😀b", ""],
        ["(?:)", "a😀b", "u"],
        ["(?=😀)|$", "a😀b", "u"],
        ["a*", "a😀b", "u"],
        ["ε?", "εbε", ""],
        ["(?:)", "<>&\tε", ""],
    ];

    for (const [pattern, input, flags] of cases) {
        const result = await page.evaluate(({ pattern, input, flags }) => {
            document.getElementById("regex-out").value = `${flags ? `(?${flags})` : ""}${pattern}`;
            const testInput = document.getElementById("test-input");
            testInput.value = input;
            testInput.dispatchEvent(new Event("input", { bubbles: true }));

            const text = document.querySelector("#test-results .test-text");
            const matches = [];
            let restored = "";
            for (const node of text.childNodes) {
                if (node.nodeName !== "MARK") {
                    restored += node.textContent;
                    continue;
                }

                const empty = node.getAttribute("data-tooltip") === "Empty match";
                const value = empty ? "" : node.textContent;
                matches.push({ index: restored.length, value, marker: node.textContent });
                restored += value;
            }

            const expected = [...input.matchAll(new RegExp(pattern, `${flags}g`))].map(match => ({
                index: match.index,
                value: match[0],
                marker: match[0] || "ε",
            }));
            return { restored, matches, expected };
        }, { pattern, input, flags });

        expect(result.restored, `${pattern} /${flags} preserves source`).toBe(input);
        expect(result.matches, `${pattern} /${flags} highlights every engine match`).toEqual(result.expected);
    }
});

test.each([
    [1280, "light", true],
    [390, "dark", false],
])("invalid input blocks visual edits at screen width %i in %s with joining %s", async (width, colorScheme, joined) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const invalidPatterns = [
        ")", "^abc)", "^abc)def$", "a|b)c", "(abc", "(?:abc", "(?=abc", "(a(b)",
        "[abc", "[^abc", "[abc\\]", "[\\", "a{2", "a{2,3", "a{foo}", "a{2foo}",
        "a{2,foo}", "a{2,3,4}", "a{}", "a{2,,3}", "a{,foo}", "a{ 2}",
        "a{-1}", "a{1.5}", "a{3,2}", "a{9007199254740992}",
    ];

    for (const pattern of invalidPatterns) {
        await loadPattern("^ok$", joined);
        const previousToolbox = await page.locator("#tree-root > .toolbox select").elementHandle();
        await page.locator("#regex-out").fill(pattern);
        expect(await page.locator("#error-msg").isVisible(), pattern).toBe(true);
        expect(await page.locator("#error-msg").textContent(), pattern).toMatch(/.+ at position \d+/);
        expect(await page.locator("#tree-root :is(input, select, button)").count(), pattern).toBe(0);
        expect(await page.locator("#generate-btn").isDisabled(), pattern).toBe(true);

        // A delayed event from the previous tree must not overwrite the invalid input.

        await previousToolbox.evaluate(select => {
            select.value = [...select.options].find(option => option.textContent === "Non-capturing Group").value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(await page.locator("#regex-out").inputValue(), pattern).toBe(pattern);
        expect(await page.locator("#error-msg").isVisible(), pattern).toBe(true);
        await page.locator("#join-literals").setChecked(!joined);
        expect(await page.locator("#error-msg").isVisible(), pattern).toBe(true);
        expect(await page.locator("#tree-root :is(input, select, button)").count(), pattern).toBe(0);
        await previousToolbox.dispose();
    }

    await loadPattern("^fixed$", joined);
    expect(await page.locator("#generate-btn").isEnabled()).toBe(true);
    await page.locator("#tree-root > .toolbox select").selectOption({ label: "Non-capturing Group" });
    expect(await matchingResults(await page.locator("#regex-out").inputValue(), ["fixed", "ok"])).toEqual([true, false]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test.each(["^abc)def$", "[abc", "a{2", "a{foo}"])("saved invalid %s remains invalid after reload", async pattern => {
    await page.locator("#regex-out").fill(pattern);
    await page.reload();
    expect(await page.locator("#regex-out").inputValue()).toBe(pattern);
    expect(await page.locator("#error-msg").isVisible()).toBe(true);
    expect(await page.locator("#tree-root :is(input, select, button)").count()).toBe(0);
    expect(await page.locator("#generate-btn").isDisabled()).toBe(true);
});

test("supported Python-style syntax and omitted bounds stay editable", async () => {
    for (const pattern of ["(?i)(?P<word>a{,3})(?P=word)", "(?>a{,})", "a{,3}?", "a{,}"]) {
        await loadPattern(pattern);
        await page.locator("#tree-root > .toolbox select").selectOption({ label: "Non-capturing Group" });
        expect(await page.locator("#error-msg").isVisible(), pattern).toBe(false);
        await page.reload();
        expect(await page.locator("#error-msg").isVisible(), pattern).toBe(false);
        expect(await page.locator("#generate-btn").isEnabled(), pattern).toBe(true);
    }
});
