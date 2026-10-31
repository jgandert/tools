/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, Buffer, process */

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
let downloads;

beforeAll(async () => {
    const files = {
        "/csv_workbench/": new URL("index.html", import.meta.url),
        "/csv_workbench/csv.js": new URL("csv.js", import.meta.url),
        "/one.js": new URL("../one.js", import.meta.url),
        "/one.css": new URL("../one.css", import.meta.url),
        "/Inter-VariableFont_opsz,wght.ttf": new URL("../Inter-VariableFont_opsz,wght.ttf", import.meta.url),
        "/material-symbols.woff2": new URL("../material-symbols.woff2", import.meta.url),
    };
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const file = files[new URL(request.url).pathname];
            return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({
        acceptDownloads: true,
        permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    pageErrors = [];
    downloads = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("download", download => downloads.push(download));
    await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin
        ? route.continue()
        : route.abort());
    await page.goto(new URL("csv_workbench/", server.url).href);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function loadCsv(text) {
    await page.locator("#delimiter-select").selectOption(",");
    await page.getByLabel("First row is a header").check();
    await page.getByLabel("Paste delimited text").fill(text);
    await page.getByRole("button", { name: "Parse", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#table-body td").length > 0);
    await page.getByLabel("Format", { exact: true }).selectOption("json-objects");
}

async function copiedJson() {
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("[role=status]")]
        .some(element => element.textContent === "Copied to clipboard"));
    return JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
}

async function downloadedJson() {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const download = await pending;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/^csv-workbench_.+\.json$/);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function expectBlockedObjectExports() {
    await page.evaluate(() => navigator.clipboard.writeText("keep clipboard"));
    const initialErrors = await page.getByRole("alert").count();
    for (const [index, action] of ["Copy", "Download"].entries()) {
        await page.getByRole("button", { name: action, exact: true }).click();
        await page.waitForFunction(count => document.querySelectorAll("[role=alert]").length === count,
            initialErrors + index + 1);
        const message = await page.getByRole("alert").last().textContent();
        expect(message).toContain("unique column names");
        expect(message).toContain("Rename duplicate columns");
        expect(message).toContain("JSON (array of arrays)");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("keep clipboard");
        expect(downloads).toHaveLength(0);
    }
}

test.each([[1280, "light"], [390, "dark"]])("literal keys survive native Copy and Download at width %i in %s mode", async (width, colorScheme) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    if (width < 600) await page.locator("label[for=aside-state]").click();
    await loadCsv("__proto__,constructor,toString,,ordinary\nkeep,own constructor,own string,empty name,value\nnull,next constructor,next string,next empty,next value");
    const expected = JSON.parse('[{"__proto__":"keep","constructor":"own constructor","toString":"own string","Column 4":"empty name","ordinary":"value"},{"__proto__":"null","constructor":"next constructor","toString":"next string","Column 4":"next empty","ordinary":"next value"}]');
    for (const output of [await copiedJson(), await downloadedJson()]) {
        expect(output).toEqual(expected);
        expect(output.every(row => Object.hasOwn(row, "__proto__") && Object.keys(row).length === 5)).toBe(true);
    }
});

test.each(["x,x", "__proto__,__proto__", ",Column 1"])("duplicate headers %s block both exports and allow lossless JSON arrays", async header => {
    await loadCsv(`${header}\nfirst,second`);
    await expectBlockedObjectExports();
    await page.getByLabel("Format", { exact: true }).selectOption("json-arrays");
    const expectedHeader = header === ",Column 1" ? ["Column 1", "Column 1"] : header.split(",");
    const expected = [expectedHeader, ["first", "second"]];
    expect(await copiedJson()).toEqual(expected);
    expect(await downloadedJson()).toEqual(expected);
});

test("renaming to a duplicate blocks export until column names are unique", async () => {
    await loadCsv("x,y\nfirst,second");
    await page.getByRole("button", { name: "Filter and edit column y", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("x");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expectBlockedObjectExports();
    await page.getByRole("button", { name: "Filter and edit column x", exact: true }).nth(1).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("restored");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const expected = [{ x: "first", restored: "second" }];
    expect(await copiedJson()).toEqual(expected);
    expect(await downloadedJson()).toEqual(expected);
});
