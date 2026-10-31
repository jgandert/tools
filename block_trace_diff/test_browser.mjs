import assert from "node:assert/strict";
import { chromium } from "playwright";

const stylesheet = Bun.file(new URL("../one.css", import.meta.url));
const stylesheetExists = await stylesheet.exists();
if (!stylesheetExists) {
    console.warn("Shared ../one.css is absent; full styled layout is not verified.");
}

const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/one.css") {
            return stylesheetExists
                ? new Response(stylesheet)
                : new Response("Not found", { status: 404 });
        }

        const filename = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!["index.html", "block_trace_diff.js", "icon.svg"].includes(filename)) {
            return new Response("Not found", { status: 404 });
        }
        return new Response(Bun.file(new URL(filename, import.meta.url)));
    },
});

let browser;
let checks = 0;

try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(server.url.href);
    await page.locator("#output details").first().waitFor();

    // Observe options passed by the real UI while preserving the real diff result.
    await page.evaluate(async () => {
        const { BlockTraceDiff } = await import("./block_trace_diff.js");
        const originalDiff = BlockTraceDiff.prototype.diff;
        window.diffCalls = [];
        BlockTraceDiff.prototype.diff = function(source, target) {
            const operations = originalDiff.call(this, source, target);
            window.diffCalls.push({
                kGramSize: this.kGramSize,
                maxStitchGap: this.maxStitchGap,
                maxOccurrences: this.maxOccurrences,
                operations,
            });
            return operations;
        };
    });

    async function setCase(source, target, options = {}) {
        const previousCalls = await page.evaluate(() => window.diffCalls.length);
        await page.evaluate(({ source, target, options }) => {
            document.getElementById("source").value = source;
            document.getElementById("target").value = target;
            for (const [id, value] of Object.entries(options)) {
                const input = document.getElementById(id);
                if (input.type === "checkbox") {
                    input.checked = value;
                } else {
                    input.value = String(value);
                }
            }
            document.getElementById("target").dispatchEvent(new Event("input", { bubbles: true }));
        }, { source, target, options });
        await page.waitForFunction(count => window.diffCalls.length > count, previousCalls);
    }

    async function targetLines() {
        return page.locator("#output details").evaluateAll(details => details
            .filter(detail => detail.dataset.type !== "DELETE")
            .flatMap(detail => {
                const code = detail.querySelector("code");
                if (!code.children.length) return code.textContent.split("\n");
                return Array.from(code.children)
                    .filter(child => child.tagName !== "DEL")
                    .map(child => child.textContent.slice(0, -1));
            }));
    }

    async function check(name, fn) {
        await fn();
        checks++;
        console.log(`PASS ${name}`);
    }

    await check("moved blocks and following insert render in target order", async () => {
        await setCase("A1\nA2\nB1\nB2", "B1\nB2\nA1\nA2\nX");
        assert.deepEqual(await targetLines(), ["B1", "B2", "A1", "A2", "X"]);
        assert.equal(await page.locator('#output details[data-type="MOVE_TO"]').count(), 1);
        assert.equal(await page.locator('#output details[data-type="MOVE_FROM"]').count(), 0);
    });

    await check("literal internal whitespace changes remain visible", async () => {
        await setCase('const value = "a  b";', 'const value = "a b";');
        assert.deepEqual(await page.locator("#output del").allTextContents(), ['const value = "a  b";\n']);
        assert.deepEqual(await page.locator("#output ins").allTextContents(), ['const value = "a b";\n']);
    });

    await check("blank suppression retains the nonblank replacement", async () => {
        await setCase("old\n\n", "new");
        assert.deepEqual(await page.locator("#output del").allTextContents(), ["old\n"]);
        assert.deepEqual(await page.locator("#output ins").allTextContents(), ["new\n"]);
    });

    await check("retained normalized matches display target indentation", async () => {
        await setCase("  same\n    other", "same\n other");
        assert.deepEqual(await targetLines(), ["same", " other"]);
    });

    await check("normalized moved matches display target indentation", async () => {
        await setCase("A1\nA2\nB1\nB2", "  B1\n  B2\n A1\n A2\nX");
        assert.deepEqual(await targetLines(), ["  B1", "  B2", " A1", " A2", "X"]);
        const destination = page.locator('#output details[data-type="MOVE_TO"]');
        assert.equal(await destination.count(), 1);
        assert.match(await destination.locator("summary").textContent(), /target lines \d+-\d+ <- source lines \d+-\d+/);
    });

    await check("exact mode displays leading whitespace edits and blank insertions", async () => {
        await setCase("  same", "same\n", {
            "ignore-leading-whitespace": false,
            "skip-whitespace-ops": false,
        });
        assert.deepEqual(await targetLines(), ["same", ""]);
        assert.deepEqual(await page.locator("#output del").allTextContents(), ["  same\n"]);
    });

    await check("zero occurrence limit disables moves without substituting defaults", async () => {
        await setCase("A1\nA2\nB1\nB2", "B1\nB2\nA1\nA2\nX", {
            "max-occurrences": 0,
            "max-stitch-gap": 0,
            "ignore-leading-whitespace": true,
            "skip-whitespace-ops": true,
        });
        const call = await page.evaluate(() => window.diffCalls.at(-1));
        assert.equal(call.maxOccurrences, 0);
        assert.equal(call.maxStitchGap, 0);
        assert.equal(call.operations.some(operation => operation.type.startsWith("MOVE_")), false);
        assert.deepEqual(await targetLines(), ["B1", "B2", "A1", "A2", "X"]);
    });

    for (const [id, maximum, validValue] of [
        ["k-gram-size", 20, 2],
        ["max-stitch-gap", 20, 0],
        ["max-occurrences", 100, 0],
    ]) {
        const invalidValues = ["", "-1", "1.5", String(maximum + 1)];
        if (id === "k-gram-size") invalidValues.push("0");

        for (const value of invalidValues) {
            await check(`${id} rejects ${value === "" ? "empty input" : value} before calling the library`, async () => {
                const calls = await page.evaluate(() => window.diffCalls.length);
                const output = await page.locator("#output").innerHTML();
                await page.locator(`#${id}`).fill(value);
                await page.waitForTimeout(350);
                assert.equal(await page.locator(`#${id}`).evaluate(input => input.validity.valid), false);
                assert.equal(await page.evaluate(() => document.activeElement.id), id);
                assert.equal(await page.evaluate(() => window.diffCalls.length), calls);
                assert.equal(await page.locator("#output").innerHTML(), output);
                await page.locator(`#${id}`).fill(String(validValue));
                await page.waitForFunction(count => window.diffCalls.length > count, calls);
            });
        }
    }

    await check("wide and narrow viewports retain usable option controls", async () => {
        await setCase("short", "changed");
        for (const width of [1440, 320]) {
            await page.setViewportSize({ width, height: 900 });
            for (const id of ["k-gram-size", "max-stitch-gap", "max-occurrences"]) {
                const control = page.locator(`#${id}`);
                await control.scrollIntoViewIfNeeded();
                const box = await control.boundingBox();
                assert.ok(box && box.width > 0 && box.height > 0);
                assert.ok(box.x >= 0 && box.x + box.width <= width, `${id} extends beyond ${width}px viewport`);
                assert.equal(await control.evaluate(input => Array.from(input.labels).some(label => label.textContent.trim().length > 0)), true);
            }
        }
    });

    await check("UI interactions produce no uncaught browser exceptions", async () => {
        assert.deepEqual(pageErrors, []);
    });

    console.log(`${checks} browser checks passed`);
} finally {
    try {
        await browser?.close();
    } finally {
        await server.stop(true);
    }
}
