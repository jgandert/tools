/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global resolveDates, parseSingleDateString, parseHolidays */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createRequire } from "node:module";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);

let browser;
let context;
let page;
let pageErrors;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext();
    await context.route("**/*", route => {
        return route.request().url().startsWith("file:") ? route.continue() : route.abort();
    });
    page = await context.newPage();
    pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.clock.setFixedTime(new Date("2025-06-15T12:00:00"));
    await page.goto(new URL("index.html", import.meta.url).href);
    await page.waitForFunction(() => document.querySelector(".timeline-wrapper") !== null);
});

afterEach(async () => {
    await context?.close();
    expect(pageErrors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
});

test("calendar validation follows inference and preserves valid shorthand and cross-year ranges", async () => {
    const cases = [
        ["2025-02-31", null, null],
        ["04/31/2025", null, null],
        ["29.02.2025", null, null],
        ["29.02.1900", null, null],
        ["31 April 2025", null, null],
        ["2025-06-31", null, null],
        ["29.02", null, null],
        ["31", null, null],
        ["31", "30.04.2025", null],
        ["2025-04-30", "31", null],
        ["2025-02-28", "2025-02-29", null],
        ["29.02", "1.03.2025", null],
        ["2025-12-31", "29.02", null],
        ["2025-04-30", "0", null],
        ["0", "30.04.2025", null],
        ["2024-02-29", null, [[2024, 2, 29], [2024, 2, 29]]],
        ["29.02.2000", null, [[2000, 2, 29], [2000, 2, 29]]],
        ["28.02.24", "29.02.24", [[2024, 2, 28], [2024, 2, 29]]],
        ["28", "29.02.2024", [[2024, 2, 28], [2024, 2, 29]]],
        ["2024-02-28", "29", [[2024, 2, 28], [2024, 2, 29]]],
        ["2.5", "10.6", [[2025, 5, 2], [2025, 6, 10]]],
        ["15", null, [[2025, 6, 15], [2025, 6, 15]]],
        ["2025-12-31", "1.01", [[2025, 12, 31], [2026, 1, 1]]],
        ["31.12", "1.01.2026", [[2025, 12, 31], [2026, 1, 1]]],
        ["31.12", "1.01", [[2025, 12, 31], [2026, 1, 1]]],
        ["21.12", "3.01.26", [[2025, 12, 21], [2026, 1, 3]]],
        ["2023-12-31", "29.02", [[2023, 12, 31], [2024, 2, 29]]],
    ];
    const results = await page.evaluate(inputs => inputs.map(([start, end]) => {
        const range = resolveDates(parseSingleDateString(start), end ? parseSingleDateString(end) : null);
        return range ? [range.start, range.end].map(date => [date.getFullYear(), date.getMonth() + 1, date.getDate()]) : null;
    }), cases);
    cases.forEach(([start, end, expected], index) => {
        expect(results[index], `${start} - ${end || "single day"}`).toEqual(expected);
    });

    const holidays = await page.evaluate(() => parseHolidays("2025-02-31 + 2025-04-30 - 31 + 2024-02-29").map(range =>
        [range.start.getFullYear(), range.start.getMonth() + 1, range.start.getDate()]));
    expect(holidays).toEqual([[2024, 2, 29]]);
});

test.each([
    [1280, "light"],
    [390, "dark"],
])("native textarea edits reject impossible overlaps and recover at %i px in %s mode", async (width, colorScheme) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    if (width < 600) {
        await page.locator("label[for='aside-state']").click();
    }
    const input = page.locator("#date-input");
    await input.fill("Alice: 2025-03-03\nBob: 2025-03-03");
    expect(await page.locator(".timeline-title").textContent()).toContain("1 overlapping work day");

    await input.press("ControlOrMeta+A");
    await input.pressSequentially("Alice: 2025-02-31");
    expect(await page.locator(".timeline-wrapper").count()).toBe(0);
    expect(await page.locator("#error-alert").textContent()).toContain("Invalid calendar date");

    const invalidRanges = [
        "2025-02-31", "04/31/2025", "29.02.2025", "2025-02-28 - 2025-02-29",
        "31 - 30.04.2025", "2025-04-30 - 31", "29.02 - 1.03.2025",
    ];
    for (const range of invalidRanges) {
        await input.fill(`Alice: ${range}\nBob: 2025-03-03`);
        expect(await page.locator(".timeline-wrapper").count()).toBe(0);
        expect(await page.locator("#error-alert").isVisible()).toBe(true);
        expect(await page.locator("#error-alert").textContent()).toContain(`Invalid calendar date in "${range}"`);
        expect(await page.locator("#error-alert").textContent()).toContain("Check the day for its month and year");
    }

    const errorBounds = await page.locator("#error-alert").boundingBox();
    expect(errorBounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await input.fill("Alice: 2024-02-28 - 29\nBob: 29.02.2024");
    expect(await page.locator(".timeline-title").textContent()).toContain("1 overlapping work day");
    expect(await page.locator("#error-alert").isVisible()).toBe(false);
    expect(await page.locator(".tube-end").last().textContent()).toBe("2024-02-29");

    await page.locator("#show-non-workdays").check();
    await input.fill("Alice: 31.12 - 1.01.2026\nBob: 31.12.2025 - 1.01.2026");
    expect(await page.locator(".timeline-title").textContent()).toContain("2 overlapping days");
    expect(await page.locator("#error-alert").isVisible()).toBe(false);

    if (width < 600) {
        await page.locator("label[for='aside-state']").click();
    }
    await page.locator("#btn-clear").click();
    expect(await input.inputValue()).toBe("");
    expect(await page.locator(".timeline-wrapper").count()).toBe(0);
});
