/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process, scrapeJSON, getSnapshot, currentStateStr, LS_JSON_DATA_KEY */

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
            if (new URL(request.url).pathname !== "/") {
                return new Response(null, { status: 404 });
            }
            return new Response(Bun.file(new URL("index.html", import.meta.url)));
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(server.url.href);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function loadRaw(value) {
    await page.locator("#btn-view-raw").click();
    await page.locator("#modal-textarea").fill(JSON.stringify(value));
    await page.locator("#btn-save-modal").click();
    await expectRoot(value);
}

async function expectRoot(value) {
    const state = await page.evaluate(() => ({
        scraped: JSON.stringify(scrapeJSON()),
        snapshot: getSnapshot(),
        current: currentStateStr,
    }));
    for (const serialized of Object.values(state)) {
        expect(JSON.parse(serialized)).toEqual(value);
    }
}

async function expectRaw(value) {
    await page.locator("#btn-view-raw").click();
    expect(JSON.parse(await page.locator("#modal-textarea").inputValue())).toEqual(value);
    await page.locator("#btn-close-modal").click();
}

async function expectDownload(value) {
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#btn-download").click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(value);
    expect(await download.failure()).toBeNull();
}

async function setSettings({ strict = false, sorted = false } = {}) {
    await page.locator("#btn-settings").click();
    await page.locator("#type-safe-toggle").setChecked(strict);
    await page.locator("#sort-keys-toggle").setChecked(sorted);
    await page.locator("#btn-close-settings").click();
}

const primitives = [42, -1.5, 0, "text", "", "  quoted \"text\"\nnext\n", true, false, null];
const roundTrips = primitives.flatMap(value => [false, true].flatMap(strict =>
    [false, true].map(sorted => [value, strict, sorted])));

test.each(roundTrips)("primitive %j survives strict=%j sorted=%j raw/export/persistence", async (value, strict, sorted) => {
    await setSettings({ strict, sorted });
    await loadRaw(value);
    await expectRaw(value);
    await expectDownload(value);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem(LS_JSON_DATA_KEY)))).toEqual(value);
    await page.reload();
    await expectRoot(value);
    await expectRaw(value);
}, 10000);

test.each([
    [42, 17],
    [-1.5, 0],
    [0, -8.25],
    ["text", "edited"],
    ["", "filled"],
    ["filled", ""],
    [true, false],
    [false, true],
    [null, "from null"],
].flatMap(([initial, edited]) => [false, true].map(sorted => [initial, edited, sorted])))("Free Mode edits %j to %j sorted=%j with undo/redo and persisted export", async (initial, edited, sorted) => {
    await setSettings({ sorted });
    await loadRaw(initial);
    const cell = page.locator("#editor-container > .json-grid > .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await page.keyboard.insertText(JSON.stringify(edited));
    await cell.press("Tab");
    await expectRoot(edited);
    await page.locator("#btn-undo").click();
    await expectRoot(initial);
    await page.locator("#btn-redo").click();
    await expectRoot(edited);
    await expectRaw(edited);
    await expectDownload(edited);
    await page.reload();
    await expectRoot(edited);
});

test.each([[true, false, "f"], [false, true, "t"]])("Strict Mode toggles %j to %j with history", async (initial, edited, key) => {
    await setSettings({ strict: true });
    await loadRaw(initial);
    await page.locator("#editor-container > .json-grid > .cell.value").press(key);
    await expectRoot(edited);
    await page.locator("#btn-undo").click();
    await expectRoot(initial);
    await page.locator("#btn-redo").click();
    await expectRoot(edited);
    await expectDownload(edited);
});

test.each([
    {}, [], { "": 42, z: [false, null, { nested: "value" }], a: {} }, [0, "", true, null, [], {}],
].map(value => [value]))("object/array %j retains its shape", async value => {
    await loadRaw(value);
    await expectRaw(value);
    await expectDownload(value);
    await setSettings({ sorted: true });
    await expectRoot(value);
    await expectDownload(value);
    await page.reload();
    await expectRoot(value);
});

test("native JSON file import keeps the primitive root", async () => {
    await page.locator("#file-input").setInputFiles({
        name: "primitive.json",
        mimeType: "application/json",
        buffer: Buffer.from("42"),
    });
    await page.waitForFunction(() => scrapeJSON() === 42);
    await expectRoot(42);
    await expectRaw(42);
    await expectDownload(42);
});

test("sorting and strict-mode changes preserve an edited root string", async () => {
    const value = "  escaped \"quote\"\nnewline\n";
    await loadRaw(value);
    await setSettings({ strict: true, sorted: true });
    await expectRoot(value);
    await expectRaw(value);
    await setSettings({ strict: false, sorted: false });
    await expectRoot(value);
    await expectDownload(value);
});

test.each([{}, [], { nested: [0, false, null] }, ["text", { "": 42 }]].map(value => [value]))("Free Mode root conversion to %j exports without a synthetic key", async value => {
    await loadRaw(0);
    const cell = page.locator("#editor-container > .json-grid > .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await page.keyboard.insertText(JSON.stringify(value));
    await expectRoot(value);
    await page.locator("#btn-undo").click();
    await expectRoot(0);
    await page.locator("#btn-redo").click();
    await expectRoot(value);
    await expectRaw(value);
    await expectDownload(value);
    await page.reload();
    await expectRoot(value);
});

test.each([[0, 18], [42, 0], ["", "filled"], ["text", ""]])("Strict Mode edits %j to %j with history", async (initial, edited) => {
    await setSettings({ strict: true });
    await loadRaw(initial);
    const cell = page.locator("#editor-container > .json-grid > .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await page.keyboard.insertText(String(edited));
    await cell.press("Tab");
    await expectRoot(edited);
    await page.locator("#btn-undo").click();
    await expectRoot(initial);
    await page.locator("#btn-redo").click();
    await expectRoot(edited);
    await expectDownload(edited);
});

test("persistence disabled and reenabled keeps a primitive root", async () => {
    await page.locator("#btn-settings").click();
    await page.locator("#save-local-toggle").uncheck();
    await page.locator("#btn-close-settings").click();
    await loadRaw(false);
    expect(await page.evaluate(() => localStorage.getItem(LS_JSON_DATA_KEY))).toBeNull();
    await expectRaw(false);
    await page.locator("#btn-settings").click();
    await page.locator("#save-local-toggle").check();
    await page.locator("#btn-close-settings").click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem(LS_JSON_DATA_KEY)))).toBe(false);
    await page.reload();
    await expectRoot(false);
});

test("row controls preserve the synthetic root value", async () => {
    await loadRaw(42);
    await page.locator("#editor-container > .json-grid > .cell.value").focus();
    for (const id of ["btn-add-null", "btn-add-obj", "btn-add-list", "btn-del-row", "btn-move-up", "btn-move-down"]) {
        await page.locator(`#${id}`).click();
        await expectRoot(42);
    }
    await expectRaw(42);
    await expectDownload(42);
});

test.each([{}, [], 17, "pasted"].map(value => [value]))("native paste of %j records one root edit", async value => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loadRaw(42);
    await loadRaw(0);
    await page.evaluate(value => navigator.clipboard.writeText(JSON.stringify(value)), value);
    const cell = page.locator("#editor-container > .json-grid > .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await cell.press("ControlOrMeta+v");
    await page.waitForFunction(value => JSON.stringify(scrapeJSON()) === JSON.stringify(value), value);
    await expectRaw(value);
    await expectRoot(value);
    await page.locator("#btn-undo").click();
    await expectRoot(0);
    await page.locator("#btn-undo").click();
    await expectRoot(42);
    await page.locator("#btn-redo").click();
    await expectRoot(0);
    await page.locator("#btn-redo").click();
    await expectRoot(value);
    await expectDownload(value);
});

test.each([{}, []].map(value => [value]))("an empty converted root %j still accepts child rows", async value => {
    await loadRaw(42);
    const cell = page.locator("#editor-container > .json-grid > .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await page.keyboard.insertText(JSON.stringify(value));
    await page.locator("#btn-add-null").click();
    const expected = Array.isArray(value) ? [null] : { key: null };
    await expectRoot(expected);
    await expectDownload(expected);
    await page.locator("#btn-undo").click();
    await expectRoot(value);
    await page.locator("#btn-redo").click();
    await expectRoot(expected);
});

const prototypeValues = ['{"kept":true}', '"literal"', 'null'];
const prototypeObjects = prototypeValues.map(value => JSON.parse(`{"__proto__":${value},"constructor":"own constructor","toString":"own string","x":1,"nested":{"__proto__":{"kept":true},"constructor":null,"toString":false},"items":[{"__proto__":"nested string","x":2},{"__proto__":null,"x":3}]}`));

async function expectOwnPropertyRoot(value) {
    const state = await page.evaluate(() => {
        const scraped = scrapeJSON();
        const hasOrdinaryPrototypes = value => {
            if (value === null || typeof value !== "object") return true;
            if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
            return Object.keys(value).every(key => hasOrdinaryPrototypes(value[key]));
        };
        return {
            scraped: JSON.stringify(scraped),
            snapshot: getSnapshot(),
            current: currentStateStr,
            ordinaryPrototypes: hasOrdinaryPrototypes(scraped),
        };
    });
    for (const key of ["scraped", "snapshot", "current"]) {
        expect(JSON.parse(state[key])).toEqual(value);
    }
    expect(state.ordinaryPrototypes).toBe(true);
}

test.each(prototypeObjects.flatMap(value => [false, true].map(sorted => [value, sorted])))("prototype-named properties %j survive sorted=%j editing/history/export/persistence", async (value, sorted) => {
    await setSettings({ sorted });
    await loadRaw(value);
    await expectOwnPropertyRoot(value);
    await expectRaw(value);
    await expectDownload(value);
    const cell = page.locator("#editor-container > .json-grid > .cell.key")
        .filter({ has: page.locator("span", { hasText: /^x$/ }) }).locator("+ .cell.value");
    await cell.focus();
    await cell.press("ControlOrMeta+a");
    await page.keyboard.insertText("2");
    await cell.press("Tab");
    const edited = JSON.parse(JSON.stringify(value));
    edited.x = 2;
    await expectOwnPropertyRoot(edited);
    await page.locator("#btn-undo").click();
    await expectOwnPropertyRoot(value);
    await page.locator("#btn-redo").click();
    await expectOwnPropertyRoot(edited);
    await expectRaw(edited);
    await expectDownload(edited);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem(LS_JSON_DATA_KEY)))).toEqual(edited);
    await page.reload();
    await expectOwnPropertyRoot(edited);
    await setSettings({ sorted: !sorted });
    await expectOwnPropertyRoot(edited);
    await expectRaw(edited);
    await expectDownload(edited);
});

test.each([false, true])("renaming a key to __proto__ sorted=%j preserves its data and history", async sorted => {
    await setSettings({ sorted });
    const value = { rename: { kept: true }, constructor: 1, toString: "own string" };
    const edited = JSON.parse('{"__proto__":{"kept":true},"constructor":1,"toString":"own string"}');
    await loadRaw(value);
    const key = page.locator("#editor-container > .json-grid > .cell.key > span[contenteditable]")
        .filter({ hasText: /^rename$/ });
    await key.focus();
    await key.press("ControlOrMeta+a");
    await page.keyboard.insertText("__proto__");
    await page.keyboard.press("Tab");
    await expectOwnPropertyRoot(edited);
    await page.locator("#btn-undo").click();
    await expectOwnPropertyRoot(value);
    await page.locator("#btn-redo").click();
    await expectOwnPropertyRoot(edited);
    await expectRaw(edited);
    await expectDownload(edited);
    await page.reload();
    await expectOwnPropertyRoot(edited);
});
