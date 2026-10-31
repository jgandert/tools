/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process, replacements, presets, one */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";

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
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const paths = {
                "/split_copy/": new URL("index.html", import.meta.url),
                "/one.js": new URL("../one.js", import.meta.url),
                "/one.css": new URL("../one.css", import.meta.url),
            };
            const path = paths[new URL(request.url).pathname];
            return path ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({ acceptDownloads: true });
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin === server.url.origin) {
            return route.continue();
        }
        return route.abort();
    });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(new URL("split_copy/", server.url).href);
    await page.waitForFunction(() => document.querySelector("#preset-select").options.length === Object.keys(presets).length);
    await page.evaluate(() => one.storage.get("sc-presets"));
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function expectRules(expected) {
    const state = await page.evaluate(() => ({
        active: replacements,
        fields: Array.from(document.querySelectorAll(".rule-row"), row => ({
            find: row.querySelector('input[type="text"]').value,
            replace: row.querySelectorAll('input[type="text"]')[1].value,
            useRegex: row.querySelector('input[type="checkbox"]').checked,
        })),
        ids: Array.from(document.querySelectorAll("[id]"), element => element.id),
        injected: document.querySelectorAll("#injected, [data-injected]").length,
        labelsValid: Array.from(document.querySelectorAll(".rule-row label"), label =>
            label.control === label.querySelector("input")),
        inputAttributes: Array.from(document.querySelectorAll('.rule-row input[type="text"]'), input =>
            input.getAttributeNames().filter(name => !["type", "id", "placeholder", "value"].includes(name))),
    }));
    expect(state.active).toEqual(expected);
    expect(state.fields).toEqual(expected);
    expect(new Set(state.ids).size).toBe(state.ids.length);
    expect(state.injected).toBe(0);
    expect(state.labelsValid.every(Boolean)).toBe(true);
    expect(state.inputAttributes.every(attributes => attributes.length === 0)).toBe(true);
}

const injected = '\"><span id="injected" data-injected="yes">injected</span><input value="';
const cases = [
    ['a"b', "&amp;"],
    ["&amp;", 'a"b'],
    ["<angle>", "\\path\\"],
    ["\\path\\", "<angle>"],
    ["", ""],
    ["remove", ""],
    [injected, "replacement"],
    ["needle", injected],
];

test.each(cases)("literal rule %j -> %j survives rerenders, storage, and preset round trips", async (find, replace) => {
    const rule = { find, replace, useRegex: false };
    const empty = { find: "", replace: "", useRegex: false };
    await page.locator("#add-rule-btn").click();
    await page.locator("#rule-find-0").fill(find);
    await page.locator("#rule-replace-0").fill(replace);
    await page.locator("#add-rule-btn").click();
    await expectRules([rule, empty]);
    await page.locator(".rule-row .btn-danger").nth(1).click();
    await expectRules([rule]);

    const input = find ? `before ${find} after` : "unchanged";
    const output = find ? `before ${replace} after` : input;
    await page.locator("#text-input").fill(input);
    expect(await page.locator(".copy-btn").allTextContents()).toEqual([output]);
    for (let attempt = 0; attempt < 30; attempt++) {
        const saved = await page.evaluate(() => one.storage.get("sc-presets"));
        if (JSON.stringify(saved?.Default?.replacements) === JSON.stringify([rule])) {
            break;
        }
        await Bun.sleep(100);
    }
    expect(await page.evaluate(() => one.storage.get("sc-presets")))
        .toEqual({ Default: { ...await page.evaluate(() => presets.Default), replacements: [rule] } });
    await page.reload();
    await page.waitForFunction(() => replacements.length === 1);
    await expectRules([rule]);
    expect(await page.locator(".copy-btn").allTextContents()).toEqual([output]);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#btn-export").click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const exported = JSON.parse(buffer.toString("utf8"));
    expect(exported.presets.Default.replacements).toEqual([rule]);
    expect(await download.failure()).toBeNull();

    await page.locator(".rule-row .btn-danger").click();
    await expectRules([]);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.locator("#btn-import").click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "literal-rules.json", mimeType: "application/json", buffer });
    await page.waitForFunction(() => replacements.length === 1);
    await expectRules([rule]);
    expect(await page.locator(".copy-btn").allTextContents()).toEqual([output]);

    await page.locator("#add-preset-btn").click();
    await page.getByRole("dialog").getByRole("textbox").fill("Literal");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expectRules([rule]);
    await page.locator("#preset-select").selectOption("Default");
    await expectRules([rule]);
    await page.locator("#preset-select").selectOption("Literal");
    await expectRules([rule]);

    await page.locator("#rule-regex-0").check();
    await page.locator("#add-rule-btn").click();
    await expectRules([{ ...rule, useRegex: true }, empty]);
    await page.locator("#rule-regex-0").uncheck();
    await page.locator(".rule-row .btn-danger").nth(1).click();
    await expectRules([rule]);
    expect(await page.locator(".copy-btn").allTextContents()).toEqual([output]);
}, 15000);
