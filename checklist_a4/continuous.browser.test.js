/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global Bun, process */

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
        async fetch(request) {
            const pathname = new URL(request.url).pathname;
            const files = {
                "/checklist_a4/": new URL("index.html", import.meta.url),
                "/one.css": new URL("../one.css", import.meta.url),
                "/one.js": new URL("../one.js", import.meta.url),
            };
            const file = files[pathname];
            return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
        },
    });
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(new URL("checklist_a4/", server.url).href);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

const sourceLabels = [
    "A " + "a".repeat(36),
    "B " + "b".repeat(36),
    "C " + "c".repeat(20),
    "D " + "d".repeat(20),
    "Duplicate",
    "Other " + "o".repeat(40),
    "Duplicate",
    "End",
];
const sourceMarkdown = `**First:** ${sourceLabels.slice(0, 4).map(text => `- [ ] ${text}`).join("  ")} / **Second:** ${sourceLabels.slice(4).map(text => `- [ ] ${text}`).join("  ")}`;

async function applyMarkdown(markdown = sourceMarkdown) {
    await page.locator("label[for=\"mode-continuous\"]").click();
    await page.locator("#header-edit-btn").click();
    await page.locator("#markdown-input").fill(markdown);
    await page.locator("#editor-save-btn").click();
}

async function markdownMarks() {
    return page.evaluate(() => [...localStorage.getItem("travel_checklist_markdown_continuous")
        .matchAll(/[-*+]\s+\[([ xX])\]/g)].map(match => match[1].toLowerCase() === "x"));
}

function sourceEntry(index) {
    return page.locator(`#continuous-flow .entry[data-source-index="${index}"]`);
}

async function expectSourceMarks(indices, labels = sourceLabels) {
    const entries = await page.locator("#continuous-flow .entry").evaluateAll(entries => entries
        .map(entry => ({
            index: Number(entry.dataset.sourceIndex),
            text: entry.lastElementChild.textContent,
            checked: entry.classList.contains("checked"),
        }))
        .sort((a, b) => a.index - b.index));
    expect(entries).toEqual(labels.map((text, index) => ({ index, text, checked: indices.includes(index) })));
    expect(await markdownMarks()).toEqual(labels.map((_, index) => indices.includes(index)));
}

async function expectEditorMarks(indices) {
    await page.locator("#header-edit-btn").click();
    const markdown = await page.locator("#markdown-input").inputValue();
    expect([...markdown.matchAll(/[-*+]\s+\[([ xX])\]/g)].map(match => match[1].toLowerCase() === "x"))
        .toEqual(sourceLabels.map((_, index) => indices.includes(index)));
}

test("checking a browser-measured reordered entry updates its source Markdown item", async () => {
    await applyMarkdown();
    await page.locator("#font-family").fill("monospace");
    await page.locator("#font-family").press("Tab");
    const labels = await page.locator("#continuous-flow .entry > span:last-child").allTextContents();
    expect(labels).not.toEqual(sourceLabels);
    const reorderedPosition = labels.findIndex((text, index) => text !== sourceLabels[index]);
    const sourceIndex = sourceLabels.indexOf(labels[reorderedPosition]);
    await page.locator("#continuous-flow .entry").nth(reorderedPosition).click();
    await expectSourceMarks([sourceIndex]);
    await expectEditorMarks([sourceIndex]);
    await page.locator("#editor-save-btn").click();
    await expectSourceMarks([sourceIndex]);
    await page.reload();
    await expectSourceMarks([sourceIndex]);
    await sourceEntry(sourceIndex).click();
    await expectSourceMarks([]);
    await page.reload();
    await expectSourceMarks([]);
});

test("duplicate labels in separate source positions survive layout, typography, mode, and editor changes", async () => {
    await applyMarkdown();
    await sourceEntry(4).click();
    await expectSourceMarks([4]);
    await sourceEntry(6).click();
    await expectSourceMarks([4, 6]);
    await sourceEntry(4).click();
    await expectSourceMarks([6]);

    await page.locator("#opt-line-optimizer").uncheck();
    expect(await page.locator("#continuous-flow .entry > span:last-child").allTextContents()).toEqual(sourceLabels);
    await expectSourceMarks([6]);
    await page.locator("#opt-line-optimizer").check();
    await expectSourceMarks([6]);

    await page.locator("#font-size").fill("15");
    await page.locator("#font-size").press("Tab");
    await expectSourceMarks([6]);
    await page.locator("#sheet-margin").fill("12");
    await page.locator("#sheet-margin").press("Tab");
    await expectSourceMarks([6]);
    await page.locator("#font-family").fill("Georgia, serif");
    await page.locator("#font-family").press("Tab");
    await expectSourceMarks([6]);
    await page.locator("label[for=\"mode-columns\"]").filter({ hasText: /^Columns$/ }).click();
    await page.locator("label[for=\"mode-continuous\"]").click();
    await expectSourceMarks([6]);

    await expectEditorMarks([6]);
    await page.locator("#markdown-input").press("ControlOrMeta+Enter");
    await expectSourceMarks([6]);
    await page.reload();
    await expectSourceMarks([6]);

    const labelsAfterEdit = ["New", ...sourceLabels];
    await page.locator("#header-edit-btn").click();
    const edited = (await page.locator("#markdown-input").inputValue()).replace("**First:**", "**First:** - [ ] New");
    await page.locator("#markdown-input").fill(edited);
    await page.locator("#editor-save-btn").click();
    await expectSourceMarks([7], labelsAfterEdit);
    await page.reload();
    await expectSourceMarks([7], labelsAfterEdit);
});

test("narrow dark layout, 200% CSS zoom, and delayed resize preserve source marks", async () => {
    await applyMarkdown();
    await sourceEntry(2).click();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    await expectSourceMarks([2]);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    await page.setViewportSize({ width: 391, height: 844 });
    await page.waitForTimeout(150);
    await expectSourceMarks([2]);
    await page.locator("#header-edit-btn").click();
    await page.locator("#markdown-input").press("ControlOrMeta+Enter");
    await expectSourceMarks([2]);
    await page.reload();
    await expectSourceMarks([2]);
});

test("empty checkbox markers keep later items aligned with Markdown", async () => {
    await applyMarkdown("**First:** - [ ] - [ ] A - [ ] B / **Second:** - [ ] - [ ] A");
    await sourceEntry(4).click();
    expect(await markdownMarks()).toEqual([false, false, false, false, true]);
    await page.reload();
    expect(await sourceEntry(4).getAttribute("class")).toContain("checked");
    await sourceEntry(4).click();
    expect(await markdownMarks()).toEqual([false, false, false, false, false]);
});

test("existing Markdown marks load and editor Apply keeps them on optimized items", async () => {
    const markdown = sourceMarkdown.replace(`- [ ] ${sourceLabels[2]}`, `- [X] ${sourceLabels[2]}`);
    await page.evaluate(markdown => {
        localStorage.setItem("travel_checklist_mode", "continuous");
        localStorage.setItem("travel_checklist_markdown_continuous", markdown);
        localStorage.removeItem("travel_checklist_state_continuous");
    }, markdown);
    await page.reload();
    await expectSourceMarks([2]);
    await expectEditorMarks([2]);
    await page.locator("#editor-save-btn").click();
    await expectSourceMarks([2]);
});

test("legacy positional state is retired using source Markdown marks", async () => {
    const markdown = sourceMarkdown.replace("- [ ] Duplicate  - [ ] End", "- [x] Duplicate  - [ ] End");
    await page.evaluate(markdown => {
        localStorage.setItem("travel_checklist_mode", "continuous");
        localStorage.setItem("travel_checklist_markdown_continuous", markdown);
        localStorage.setItem("travel_checklist_state_continuous", JSON.stringify([0]));
    }, markdown);
    await page.reload();
    await expectSourceMarks([6]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("travel_checklist_state_continuous"))))
        .toEqual({ version: 2, checkedSourceIndices: [6] });
    await page.reload();
    await expectSourceMarks([6]);
    await expectEditorMarks([6]);
    await page.locator("#editor-cancel-btn").click();
});

test("legacy marks without saved Markdown are retired rather than assigned to guessed labels", async () => {
    await page.evaluate(() => {
        localStorage.setItem("travel_checklist_mode", "continuous");
        localStorage.setItem("travel_checklist_state_continuous", JSON.stringify([1]));
    });
    await page.reload();
    expect(await page.locator("#continuous-flow .entry.checked").count()).toBe(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("travel_checklist_state_continuous"))))
        .toEqual({ version: 2, checkedSourceIndices: [] });
    expect(await page.getByText("Checklist marks were restored from the Markdown. Review them once after this update.").count()).toBe(1);
    await page.reload();
    expect(await page.locator("#continuous-flow .entry.checked").count()).toBe(0);
    expect(await page.getByText("Checklist marks were restored from the Markdown. Review them once after this update.").count()).toBe(0);
});

test("a saved empty source state overrides Markdown marks until editor Apply", async () => {
    const markdown = sourceMarkdown.replace(`- [ ] ${sourceLabels[2]}`, `- [x] ${sourceLabels[2]}`);
    await page.evaluate(markdown => {
        localStorage.setItem("travel_checklist_mode", "continuous");
        localStorage.setItem("travel_checklist_markdown_continuous", markdown);
        localStorage.setItem("travel_checklist_state_continuous", JSON.stringify({ version: 2, checkedSourceIndices: [] }));
    }, markdown);
    await page.reload();
    expect(await page.locator("#continuous-flow .entry.checked").count()).toBe(0);
    await expectEditorMarks([]);
    await page.locator("#editor-save-btn").click();
    await expectSourceMarks([]);
    await page.reload();
    await expectSourceMarks([]);
});

test("Clear Marks clears source state and Markdown across reload", async () => {
    await applyMarkdown();
    await sourceEntry(2).click();
    await sourceEntry(6).click();
    await page.locator("#sidebar-clear-btn").click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expectSourceMarks([]);
    await page.reload();
    await expectSourceMarks([]);
});

test("default checklist marks use source indices through editor Apply and reload", async () => {
    await page.locator("label[for=\"mode-continuous\"]").click();
    const sourceIndex = await page.locator("#continuous-flow .entry").first().getAttribute("data-source-index");
    const text = await sourceEntry(sourceIndex).locator("span:last-child").textContent();
    await sourceEntry(sourceIndex).click();
    await page.reload();
    expect(await sourceEntry(sourceIndex).getAttribute("class")).toContain("checked");
    expect(await sourceEntry(sourceIndex).locator("span:last-child").textContent()).toBe(text);
    await page.locator("#header-edit-btn").click();
    const markdown = await page.locator("#markdown-input").inputValue();
    const marks = [...markdown.matchAll(/[-*+]\s+\[([ xX])\]/g)].map(match => match[1].toLowerCase() === "x");
    expect(marks.flatMap((checked, index) => checked ? [index] : [])).toEqual([Number(sourceIndex)]);
    await page.locator("#editor-save-btn").click();
    await page.reload();
    expect(await sourceEntry(sourceIndex).getAttribute("class")).toContain("checked");
    expect(await sourceEntry(sourceIndex).locator("span:last-child").textContent()).toBe(text);
});

test.each([
    "{broken",
    JSON.stringify({ version: 2, checkedSourceIndices: ["0"] }),
    JSON.stringify({ version: 1, checkedSourceIndices: [0] }),
])("invalid stored state %s falls back to source Markdown marks", async raw => {
    const markdown = sourceMarkdown.replace(`- [ ] ${sourceLabels[2]}`, `- [x] ${sourceLabels[2]}`);
    await page.evaluate(({ markdown, raw }) => {
        localStorage.setItem("travel_checklist_mode", "continuous");
        localStorage.setItem("travel_checklist_markdown_continuous", markdown);
        localStorage.setItem("travel_checklist_state_continuous", raw);
    }, { markdown, raw });
    await page.reload();
    await expectSourceMarks([2]);
    await expectEditorMarks([2]);
    await page.locator("#editor-cancel-btn").click();
});
