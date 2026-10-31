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
    ["America/Los_Angeles", "2026-09-06T01:00:00Z", "2026-09-05", "2026-09-06", "2026-09-07"],
    ["Asia/Tokyo", "2026-09-05T16:00:00Z", "2026-09-06", "2026-09-07", "2026-09-08"],
    ["America/Los_Angeles", "2026-09-06T19:00:00Z", "2026-09-06", "2026-09-07", "2026-09-08"],
    ["Asia/Tokyo", "2026-09-06T03:00:00Z", "2026-09-06", "2026-09-07", "2026-09-08"],
    ["America/Los_Angeles", "2026-03-01T01:00:00Z", "2026-02-28", "2026-03-01", "2026-03-02"],
    ["Asia/Tokyo", "2026-02-28T16:00:00Z", "2026-03-01", "2026-03-02", "2026-03-03"],
    ["America/Los_Angeles", "2027-01-01T01:00:00Z", "2026-12-31", "2027-01-01", "2027-01-02"],
    ["Asia/Tokyo", "2026-12-31T16:00:00Z", "2027-01-01", "2027-01-02", "2027-01-03"],
])("native entry dates follow the local calendar in %s at %s", async (timezoneId, instant, initialDate, saveDate, clearDate) => {
    const context = await browser.newContext({ timezoneId });
    const pageErrors = [];

    try {
        await context.route("**/*", route => {
            return route.request().url().startsWith("file:") ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", error => pageErrors.push(error.message));
        const initialTime = new Date(instant);
        await page.clock.setFixedTime(initialTime);
        await page.goto(new URL("index.html", import.meta.url).href);
        const date = page.locator("#entry-date");
        await page.waitForFunction(() => document.getElementById("entry-date").value !== "");
        expect(await date.inputValue()).toBe(initialDate);

        await page.locator("#entry-text").fill("09:00 - 10:00");
        await page.getByRole("button", { name: "Save Entry", exact: true }).click();
        await page.waitForFunction(() => document.getElementById("entry-text").value === "");
        expect(await date.inputValue()).toBe(initialDate);
        await page.waitForFunction(async () => (await one.storage.get("timetable"))?.workDays.length === 1);
        expect(await page.evaluate(async () => {
            const data = await one.storage.get("timetable");
            return data?.workDays;
        })).toEqual([{
            inputString: "09:00 - 10:00",
            minutesWorked: 60,
            localDate: initialDate,
            dateTimeUTCWhenAdded: initialTime.toISOString(),
        }]);

        const nextDayTime = new Date(initialTime.getTime() + 24 * 60 * 60 * 1000);
        await page.clock.setFixedTime(nextDayTime);
        await date.fill("2000-01-01");
        await page.locator("#entry-text").fill("10:00 - 11:00");
        await page.getByRole("button", { name: "Save Entry", exact: true }).click();
        await page.waitForFunction(() => document.getElementById("entry-text").value === "");
        expect(await date.inputValue()).toBe(saveDate);
        await page.waitForFunction(async () => (await one.storage.get("timetable"))?.workDays.length === 2);
        expect(await page.evaluate(async () => {
            const data = await one.storage.get("timetable");
            return data?.workDays.find(day => day.localDate === "2000-01-01");
        })).toEqual({
            inputString: "10:00 - 11:00",
            minutesWorked: 60,
            localDate: "2000-01-01",
            dateTimeUTCWhenAdded: nextDayTime.toISOString(),
        });

        await page.clock.setFixedTime(new Date(initialTime.getTime() + 48 * 60 * 60 * 1000));
        await date.fill("2001-02-03");
        await page.locator("#entry-text").fill("11:00 - 12:00");
        await page.locator("#clear-entry-btn").click();
        await page.locator("#clear-entry-dialog [data-action='cancel']").click();
        expect(await date.inputValue()).toBe("2001-02-03");
        expect(await page.locator("#entry-text").inputValue()).toBe("11:00 - 12:00");
        await page.locator("#clear-entry-btn").click();
        await page.locator("[data-action='confirm-clear-entry']").click();
        expect(await date.inputValue()).toBe(clearDate);
        expect(await page.locator("#entry-text").inputValue()).toBe("");
        expect(await page.locator("#clear-entry-dialog").isVisible()).toBe(false);
        expect(pageErrors).toEqual([]);
    } finally {
        await context.close();
    }
});
