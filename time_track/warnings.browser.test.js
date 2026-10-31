/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let browser;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
    await browser?.close();
});

test.each([
    [0, "09:00 - 17:00", 480, false],
    [15, "09:00 - 10:01", 61, true],
    [15, "09:00 - 10:00", 60, false],
])("saving with divisor %i and interval %s honors the warning setting", async (divisor, interval, minutes, warns) => {
    const context = await browser.newContext();

    try {
        await context.route("**/*", route => {
            return route.request().url().startsWith("file:") ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.goto(new URL("index.html", import.meta.url).href);
        await page.waitForFunction(() => document.getElementById("entry-date").value !== "");
        await page.locator("#divisible-warning").fill(String(divisor));
        await page.waitForFunction(async expected => (await one.storage.get("timetable"))?.settings.divisibleWarning === expected, divisor);
        await page.locator("#entry-date").fill("2000-01-01");
        await page.locator("#entry-text").fill(interval);
        await page.getByRole("button", { name: "Save Entry", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("dialog[open]") || document.getElementById("entry-text").value === "");

        const dialog = page.locator("dialog[open]");
        expect(await dialog.count()).toBe(warns ? 1 : 0);
        if (warns) {
            expect(await dialog.textContent()).toContain("not divisible by 15");
            expect(await page.evaluate(async () => (await one.storage.get("timetable"))?.workDays.length)).toBe(0);
            await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
        }
        await page.waitForFunction(async expected => (await one.storage.get("timetable"))?.workDays[0]?.minutesWorked === expected, minutes);

        if (divisor === 0) {
            await page.locator("#entry-date").fill("2000-01-01");
            await page.locator("#entry-text").fill("10:00 - 11:01");
            await page.getByRole("button", { name: "Save Entry", exact: true }).click();
            await dialog.waitFor({ state: "visible" });
            expect(await dialog.textContent()).toContain("An entry for 2000-01-01 already exists. Replace it?");
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            expect(await page.locator("#entry-text").inputValue()).toBe("10:00 - 11:01");
            expect(await page.evaluate(async () => (await one.storage.get("timetable"))?.workDays[0]?.minutesWorked)).toBe(480);

            await page.getByRole("button", { name: "Save Entry", exact: true }).click();
            await dialog.waitFor({ state: "visible" });
            expect(await dialog.textContent()).toContain("An entry for 2000-01-01 already exists. Replace it?");
            await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
            await page.waitForFunction(async () => {
                const days = (await one.storage.get("timetable"))?.workDays;
                return days?.length === 1 && days[0].minutesWorked === 61;
            });
        }
        expect(pageErrors).toEqual([]);
    } finally {
        await context.close();
    }
});
