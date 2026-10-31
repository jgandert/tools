/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global process, one */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let browser;
let page;
let pageErrors;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    page = await browser.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.goto(new URL("one_css/index.html", import.meta.url).href);
});

afterEach(async () => {
    await page?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
});

async function openDialog(kind) {
    await page.evaluate(kind => {
        window.dialogResult = { settlements: 0 };
        const promise = kind === "confirm" ? one.confirm("Test dismissal") : one.prompt("Test dismissal", "initial");
        window.testDialog = document.querySelector("dialog[open]");
        promise.then(value => {
            window.dialogResult.value = value;
            window.dialogResult.settlements++;
        });
    }, kind);
}

async function expectResult(value) {
    await page.waitForFunction(() => window.dialogResult.settlements === 1, undefined, { timeout: 1500 }).catch(async error => {
        const state = await page.evaluate(() => ({
            ...window.dialogResult,
            attached: window.testDialog.isConnected,
            open: window.testDialog.open,
        }));
        throw new Error(`Dialog did not settle: ${JSON.stringify(state)}`, { cause: error });
    });
    // Allow the native close event queued by button or Escape dismissal to run.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => ({
        ...window.dialogResult,
        attached: window.testDialog.isConnected,
        open: window.testDialog.open,
    }))).toEqual({ settlements: 1, value, attached: false, open: false });
}

async function dismiss(action) {
    const dialog = page.locator("dialog[open]");
    if (action === "escape-button") {
        if (await dialog.locator("input").count()) {
            await page.keyboard.press("Tab");
        } else {
            await dialog.locator("[data-action=confirm]").focus();
        }
        expect(await page.evaluate(() => document.activeElement.tagName)).toBe("BUTTON");
        await page.keyboard.press("Escape");
        return;
    }
    if (action === "escape-input") {
        expect(await page.evaluate(() => document.activeElement.tagName)).toBe("INPUT");
        await page.keyboard.press("Escape");
        return;
    }
    if (action === "backdrop") {
        await page.mouse.click(1, 1);
        return;
    }
    if (action === "close") {
        await dialog.evaluate(element => element.close());
        return;
    }
    if (action === "enter-input") {
        await dialog.locator("input").fill("edited");
        await page.keyboard.press("Enter");
        return;
    }
    const buttonAction = action.replace(/^enter-/, "");
    if (buttonAction === "confirm") {
        const input = dialog.locator("input");
        if (await input.count()) {
            await input.fill("edited");
        }
    }
    const button = dialog.locator(`[data-action="${buttonAction}"]`);
    if (action.startsWith("enter-")) {
        await button.focus();
        await page.keyboard.press("Enter");
        return;
    }
    await button.click();
}

const cases = ["confirm", "prompt"].flatMap(kind => ["escape-button", "cancel", "confirm", "enter-cancel", "enter-confirm", "backdrop", "close"]
    .map(action => [kind, action, action.endsWith("confirm") ? (kind === "confirm" ? true : "edited") : (kind === "confirm" ? false : null)]));
cases.push(["prompt", "escape-input", null], ["prompt", "enter-input", "edited"]);

test.each(cases)("%s resolves and removes its dialog after %s", async (kind, action, result) => {
    await openDialog(kind);
    await dismiss(action);
    await expectResult(result);
});

test("repeated dialogs settle independently after different dismissal paths", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    for (const [kind, action, result] of cases) {
        await openDialog(kind);
        await dismiss(action);
        await expectResult(result);
    }
}, 15000);
