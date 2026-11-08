import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

// CommonJS resolution also supports developers using a shared NODE_PATH install.
const { chromium } = createRequire(import.meta.url)("playwright");
let stylesheet;
try {
    stylesheet = await readFile(new URL("../one.css", import.meta.url));
} catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.warn("Shared ../one.css is absent; full styled layout is not verified.");
}
const resources = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/block_trace_diff.js", ["block_trace_diff.js", "text/javascript; charset=utf-8"]],
    ["/icon.svg", ["icon.svg", "image/svg+xml"]],
]);
const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/one.css") {
        if (stylesheet !== undefined) {
            response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(stylesheet);
        } else {
            response.writeHead(404).end("Not found");
        }
        return;
    }
    const resource = resources.get(pathname);
    if (!resource) {
        response.writeHead(404).end("Not found");
        return;
    }
    try {
        const [filename, contentType] = resource;
        const body = await readFile(new URL(filename, import.meta.url));
        response.writeHead(200, { "Content-Type": contentType }).end(body);
    } catch {
        response.writeHead(500).end("Could not load a required application file");
    }
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const serverUrl = `http://127.0.0.1:${server.address().port}/`;

let browser;
let checks = 0;

try {
    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        });
    } catch (error) {
        throw new Error(
            "Browser checks require Chromium. Run `npx playwright install chromium` or set " +
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium executable.\n" + error.message,
            { cause: error },
        );
    }
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(() => {
        window.originalConsoleMethods = [console.log, console.warn, console.error];
    });
    await page.goto(serverUrl);
    await page.locator("#output details").first().waitFor();

    // Observe options passed by the real UI while preserving the real diff result.
    await page.evaluate(async () => {
        const { BlockTraceDiff } = await import("./block_trace_diff.js");
        const originalDiff = BlockTraceDiff.prototype.diff;
        window.diffCalls = [];
        BlockTraceDiff.prototype.diff = function(source, target) {
            const operations = originalDiff.call(this, source, target);
            window.diffCalls.push({
                source,
                target,
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

    await check("the page retains its shared parent stylesheet dependency", async () => {
        assert.equal(await page.locator('link[rel="stylesheet"]').getAttribute("href"), "../one.css");
        const response = await page.request.get(new URL("../one.css", serverUrl).href);
        assert.equal(response.status(), stylesheet !== undefined ? 200 : 404);
        if (stylesheet !== undefined) {
            assert.match(response.headers()["content-type"], /text\/css/);
            assert.deepEqual(await response.body(), stylesheet);
        }
    });

    await check("empty documents have zero lines while trailing newlines remain visible", async () => {
        await setCase("", "", { "skip-whitespace-ops": false });
        assert.equal(await page.locator("#output details").count(), 0);
        assert.deepEqual(await page.evaluate(() => {
            const { source, target } = window.diffCalls.at(-1);
            return { source, target };
        }), { source: [], target: [] });
        await setCase("", "line\n");
        assert.deepEqual(await targetLines(), ["line", ""]);
        assert.deepEqual(await page.evaluate(() => window.diffCalls.at(-1).target), ["line", ""]);
        await setCase("line\n", "");
        const call = await page.evaluate(() => window.diffCalls.at(-1));
        assert.deepEqual(call.source, ["line", ""]);
        assert.deepEqual(call.target, []);
        assert.deepEqual(call.operations.map(operation => operation.type), ["DELETE", "DELETE"]);
        await setCase("line", "line", { "skip-whitespace-ops": true });
    });

    await check("comparison output is committed once from a DocumentFragment", async () => {
        await page.evaluate(() => {
            const output = document.getElementById("output");
            const originalReplaceChildren = output.replaceChildren;
            window.outputCommits = [];
            window.outputMutations = [];
            const observer = new MutationObserver(records => {
                window.outputMutations.push(...records.map(record => ({
                    added: record.addedNodes.length,
                    removed: record.removedNodes.length,
                })));
            });
            observer.observe(output, { childList: true });
            output.replaceChildren = function(...nodes) {
                window.outputCommits.push({
                    argumentCount: nodes.length,
                    isFragment: nodes[0] instanceof DocumentFragment,
                    childCount: nodes[0]?.childElementCount,
                });
                return originalReplaceChildren.apply(this, nodes);
            };
            window.stopOutputObservation = () => {
                observer.disconnect();
                delete output.replaceChildren;
            };
        });
        try {
            await setCase("A1\nA2\nB1\nB2", "B1\nB2\nA1\nA2\nX");
            const { commits, mutations } = await page.evaluate(() => ({
                commits: window.outputCommits,
                mutations: window.outputMutations,
            }));
            assert.equal(commits.length, 1);
            assert.equal(commits[0].argumentCount, 1);
            assert.equal(commits[0].isFragment, true);
            assert.ok(commits[0].childCount > 1, "the case must render multiple chunks");
            assert.equal(mutations.length, 1, "output should change in one DOM mutation");
            assert.equal(mutations[0].added, commits[0].childCount);
            assert.deepEqual(await targetLines(), ["B1", "B2", "A1", "A2", "X"]);
        } finally {
            await page.evaluate(() => window.stopOutputObservation());
        }
    });

    await check("moved blocks and following insert render in target order", async () => {
        await setCase("A1\nA2\nB1\nB2", "B1\nB2\nA1\nA2\nX");
        assert.deepEqual(await targetLines(), ["B1", "B2", "A1", "A2", "X"]);
        assert.equal(await page.locator("#output details[data-type=\"MOVE_TO\"]").count(), 1);
        assert.equal(await page.locator("#output details[data-type=\"MOVE_FROM\"]").count(), 0);
    });

    await check("literal internal whitespace changes remain visible", async () => {
        await setCase("const value = \"a  b\";", "const value = \"a b\";");
        assert.deepEqual(await page.locator("#output del").allTextContents(), ["const value = \"a  b\";\n"]);
        assert.deepEqual(await page.locator("#output ins").allTextContents(), ["const value = \"a b\";\n"]);
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
        const destination = page.locator("#output details[data-type=\"MOVE_TO\"]");
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

    await check("diagnostics retain history beyond 30 entries, omit document content, and preserve the console", async () => {
        const marker = "document-content-must-not-be-logged";
        await setCase(marker, marker);
        const before = await page.locator("#debug-log > *").allTextContents();
        await page.evaluate(() => {
            for (let i = 0; i < 40; i++) {
                document.getElementById("diff-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            }
        });
        const after = await page.locator("#debug-log > *").allTextContents();
        assert.equal(after.length, before.length + 40);
        assert.deepEqual(after.slice(0, before.length), before, "earlier diagnostic entries must be retained");
        assert.equal(after.some(entry => entry.includes(marker)), false);
        assert.ok(after.every(entry => entry.length < 200), "each diagnostic should be a short summary");
        assert.equal(after.some(entry => /\"(?:type|internalDiff|targetText)\"\s*:/.test(entry)), false);
        assert.equal(await page.evaluate(() =>
            [console.log, console.warn, console.error].every((method, index) => method === window.originalConsoleMethods[index])
        ), true);
    });

    await check("document HTML is rendered as text", async () => {
        const source = '<script>window.injected = true;<\/script>';
        const target = '<img src=x onerror="window.injected = true">';
        await setCase(source, target);
        assert.deepEqual(await targetLines(), [target]);
        assert.equal(await page.locator("#output img, #output script").count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
    });

    await check("loading a file recomputes the comparison and clears its picker", async () => {
        await setCase("source", "old target");
        const calls = await page.evaluate(() => window.diffCalls.length);
        await page.locator("#target-file-input").setInputFiles({
            name: "loaded.txt", mimeType: "text/plain", buffer: Buffer.from("loaded\ntext\n"),
        });
        await page.waitForFunction(count => window.diffCalls.length > count, calls);
        assert.equal(await page.locator("#target").inputValue(), "loaded\ntext\n");
        assert.equal(await page.locator("#target-file-input").inputValue(), "");
        assert.deepEqual(await targetLines(), ["loaded", "text"]);
    });

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
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
