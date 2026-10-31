/* global one, htmlToMarkdown */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const toolUrl = new URL("index.html", import.meta.url).href;
const fixture = await readFile(new URL("fixtures/toc.md", import.meta.url), "utf8");
const linkFixture = `${fixture}\n[Reference link](#heading-level-1)\n`;
let browser;

before(async () => {
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
});

function installClipboardFixture({ mode = "ready", items = [] } = {}) {
    const state = { reads: 0, writes: [], typesRead: [] };
    window.clipboardFixture = state;
    const clipboard = {
        async read() {
            state.reads++;
            if (mode === "denied") {
                throw new DOMException("Clipboard permission denied", "NotAllowedError");
            }
            if (mode === "deferred") {
                await new Promise(resolve => {
                    state.releaseRead = resolve;
                });
            }

            return items.map(item => ({
                types: Object.keys(item),
                async getType(type) {
                    state.typesRead.push(type);
                    if (mode === "broken-item") {
                        throw new Error("Clipboard item could not be read");
                    }

                    return new Blob([item[type]], { type });
                },
            }));
        },
        async writeText(text) {
            state.writes.push(text);
        },
    };
    if (mode === "missing-read") {
        delete clipboard.read;
    }

    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: mode === "missing" ? undefined : clipboard,
    });
}

async function openEditor(t, width = 1440, markdown = fixture, options = {}) {
    const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
        offline: true,
    });
    t.after(() => context.close());
    if (!options.nativeClipboard) {
        await context.addInitScript(installClipboardFixture, options.clipboard);
    }
    if (options.storageUnavailable) {
        await context.addInitScript(() => {
            Object.defineProperty(window, "indexedDB", {
                value: {
                    open() {
                        throw new DOMException("Storage unavailable", "SecurityError");
                    },
                },
            });
        });
    }

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], "No uncaught browser errors"));
    page.setDefaultTimeout(5000);
    await page.goto(toolUrl);
    await page.evaluate(() => document.fonts.ready);
    assert(await page.locator("body > header h1").evaluate(element => element.getBoundingClientRect().height) > 0, "Browser tests require system fonts");
    await page.getByLabel("Markdown", { exact: true }).fill(markdown);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    if (width < 900 && !options.keepEditorOpen) {
        await page.locator(".aside-toggle-btn").click();
    }

    return page;
}

async function selectSource(page, start, end = start) {
    await page.locator("#markdown-source").evaluate((element, selection) => {
        element.focus();
        element.setSelectionRange(selection.start, selection.end);
    }, { start, end });
}

async function waitForPaste(page) {
    await page.waitForFunction(() => !document.getElementById("paste-markdown").disabled);
}

async function pasteAsMarkdown(page) {
    await page.getByRole("button", { name: "Paste as Markdown", exact: true }).click();
    await waitForPaste(page);
}

async function assertSource(page, value, caret) {
    assert.equal(await page.locator("#markdown-source").inputValue(), value);
    if (caret !== undefined) {
        assert.deepEqual(await page.locator("#markdown-source").evaluate(element => ({
            focused: element === document.activeElement,
            start: element.selectionStart,
            end: element.selectionEnd,
        })), { focused: true, start: caret, end: caret });
    }
}

async function pasteEvent(page, data, selector = "#paste-input") {
    return page.locator(selector).evaluate((element, types) => {
        const clipboardData = new DataTransfer();
        for (const [type, value] of Object.entries(types)) {
            clipboardData.setData(type, value);
        }

        const event = new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, data);
}

async function settleAppearance(page) {
    await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {
        })));
    });
}

async function assertTocLayout(page, containerSelector) {
    const layout = await page.evaluate(selector => {
        const container = document.querySelector(selector);
        const bounds = container.getBoundingClientRect();
        return {
            width: container.clientWidth,
            scrollWidth: container.scrollWidth,
            tocs: [...document.querySelectorAll("#preview .toc")].map(toc => ({
                links: [...toc.querySelectorAll("a")].map(link => {
                    const rect = link.getBoundingClientRect();
                    return {
                        left: rect.left - bounds.left,
                        right: rect.right - bounds.left,
                        top: rect.top,
                        bottom: rect.bottom,
                        targetExists: Boolean(document.getElementById(decodeURIComponent(link.hash.slice(1)))),
                    };
                }),
            })),
        };
    }, containerSelector);

    assert.equal(layout.tocs.length, 2, "Both TOC markers render a TOC");
    assert(layout.scrollWidth <= layout.width + 1, `No horizontal overflow: ${layout.scrollWidth}px content in ${layout.width}px pane`);

    for (const toc of layout.tocs) {
        assert(toc.links.length > 10, "The fixture's headings appear in the TOC");
        for (const [index, link] of toc.links.entries()) {
            assert(link.targetExists, "Every TOC link targets a heading");
            assert(link.left >= -1 && link.right <= layout.width + 1, "TOC links fit the pane");
            if (index > 0) {
                assert(link.top >= toc.links[index - 1].bottom - 1, "TOC entries follow each other vertically");
            }
        }
    }
}

async function assertTocLinkAppearance(page) {
    const link = page.locator(".toc").first().getByRole("link").first();
    const readAppearance = () => link.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            color: style.color,
            background: style.backgroundColor,
            radius: style.borderRadius,
            decoration: style.textDecorationLine,
            outlineStyle: style.outlineStyle,
            outlineWidth: parseFloat(style.outlineWidth),
        };
    });
    await page.mouse.move(0, 0);
    await settleAppearance(page);
    const referenceColor = await page.getByRole("link", {
        name: "Reference link",
        exact: true,
    }).evaluate(element => getComputedStyle(element).color);
    const normal = await readAppearance();
    assert.equal(normal.color, referenceColor, "TOC links use the document's link color");
    assert(normal.decoration.includes("underline"), "Links are recognizable before hovering");

    await link.hover();
    const hovered = await readAppearance();
    assert.equal(hovered.background, "rgba(0, 0, 0, 0)", "Hover does not draw a button background");
    assert.equal(hovered.radius, "0px", "Links have no rounded button corners");
    assert(hovered.decoration.includes("underline"), "Hover preserves the link underline");

    await link.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await link.evaluate(element => element === document.activeElement && element.matches(":focus-visible")), true);
    const focused = await readAppearance();
    assert.notEqual(focused.outlineStyle, "none", "Keyboard focus has a visible outline");
    assert(focused.outlineWidth > 0, "The focus outline has a visible width");
}

for (const width of [1440, 768, 320]) {
    test(`TOCs fit a ${width}px viewport and use a vertical hierarchy`, async t => {
        const page = await openEditor(t, width);
        await assertTocLayout(page, "#content");
    });
}

for (const colorScheme of ["light", "dark"]) {
    test(`TOC links remain recognizable in ${colorScheme} mode`, async t => {
        const page = await openEditor(t, 1440, linkFixture);
        await page.emulateMedia({ colorScheme });
        await assertTocLinkAppearance(page);
    });
}

test("long nested TOC labels wrap within a narrow preview", async t => {
    const heading = `Heading ${"with a long label ".repeat(20)}`;
    const page = await openEditor(t, 320, `${fixture}\n###### ${heading}\n`);
    await assertTocLayout(page, "#content");
    const link = page.locator(".toc").first().getByRole("link", {
        name: heading.trim(),
        exact: true,
    });
    const height = await link.evaluate(element => element.getBoundingClientRect().height);
    assert(height > 48, "The long label spans multiple lines");
});

test("TOC links scroll the preview without moving the header", async t => {
    const page = await openEditor(t);
    await page.locator(".toc").first().getByRole("link", {
        name: "Paragraphs and line breaks",
        exact: true,
    }).click();
    const position = await page.evaluate(() => ({
        headerTop: document.querySelector("body > header").getBoundingClientRect().top,
        previewScroll: document.getElementById("content").scrollTop,
        documentScroll: document.scrollingElement.scrollTop,
    }));
    assert.equal(position.headerTop, 0);
    assert.equal(position.documentScroll, 0);
    assert(position.previewScroll > 0, "The preview scrolls to the linked heading");
});

test("HTML downloads retain the TOC layout, link styling and working anchors", async t => {
    const page = await openEditor(t, 1440, linkFixture);
    const directory = await mkdtemp(join(tmpdir(), "md-preview-test-"));
    t.after(() => rm(directory, { recursive: true }));
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "HTML", exact: true }).click();
    const download = await downloadEvent;
    const path = join(directory, "document.html");
    await download.saveAs(path);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(pathToFileURL(path).href);
    await assertTocLayout(page, "body");
    assert.equal(await page.locator("script, link[rel=stylesheet], textarea").count(), 0, "The download is standalone");
    for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await assertTocLinkAppearance(page);
    }
});

test("printing keeps both TOCs visible and expands the document", async t => {
    const page = await openEditor(t);
    await page.emulateMedia({ media: "print" });
    await assertTocLayout(page, "#content");
    for (const toc of await page.locator(".toc").all()) {
        assert.equal(await toc.isVisible(), true);
    }
    assert.equal(await page.locator("body > header").isVisible(), false);
    assert.equal(await page.locator("aside").isVisible(), false);
    const heights = await page.locator("#content").evaluate(element => [element.clientHeight, element.scrollHeight]);
    assert(heights[0] > 900, "The printed document extends past the viewport");
    assert(heights[1] <= heights[0] + 1, "Print does not clip the scrollable preview");
});

test("header actions stay centered and source scrolling stays inside the textarea", async t => {
    const page = await openEditor(t);
    const centers = await page.locator("body > header, .header-actions button").evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.top + bounds.height / 2;
    }));
    assert(centers.every(center => Math.abs(center - centers[0]) < 1), "Header buttons are vertically centered");
    const heights = await page.locator("#markdown-source, aside").evaluateAll(elements => Object.fromEntries(elements.map(element => [
        element.tagName.toLowerCase(),
        { visible: element.clientHeight, content: element.scrollHeight },
    ])));
    assert(heights.textarea.content > heights.textarea.visible, "Long source text scrolls inside the textarea");
    assert(heights.aside.content <= heights.aside.visible + 1, "The sidebar has no second vertical scrollbar");
});

test("rich clipboard HTML is preferred across items and preserves relative links, code and punctuation", async t => {
    const page = await openEditor(t, 1440, "", {
        clipboard: {
            items: [
                { "text/plain": "Do not choose the first plain item" },
                {
                    "text/html": "<h2>Copied</h2><p><strong>Bold</strong> &amp; “quoted” <a href='../guide?q=1&amp;b=2'>link</a></p><pre><code>\t  code();  \n\n</code></pre>",
                    "text/plain": "Plain fallback",
                },
            ],
        },
    });
    assert.equal(await page.locator("#append-mode").isChecked(), true);
    assert.equal(await page.locator("#normalize-punctuation").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Copy Markdown" }).isDisabled(), true);
    await pasteAsMarkdown(page);
    const expected = "## Copied\n\n**Bold** &amp; “quoted” [link](../guide?q=1&b=2)\n\n```\n\t  code();  \n\n```";
    await assertSource(page, expected, expected.length);
    assert.equal(await page.locator("#preview h2").textContent(), "Copied");
    assert.equal(await page.locator("#preview strong").textContent(), "Bold");
    assert.equal(await page.locator("#preview p").textContent(), "Bold & “quoted” link");
    assert.equal(await page.locator("#preview pre code").textContent(), "\t  code();  \n");
    assert.equal(await page.locator("#preview a").getAttribute("href"), "../guide?q=1&b=2");
    assert.deepEqual(await page.evaluate(() => window.clipboardFixture.typesRead), ["text/html"]);
    for (const name of ["Copy Markdown", "MD", "HTML", "Print document"]) {
        assert.equal(await page.getByRole("button", { name, exact: true }).isEnabled(), true);
    }
});

for (const [name, start, end] of [["cursor insertion", 7, 7], ["selection replacement", 7, 15]]) {
    test(`${name} preserves surrounding text, focuses the caret and supports undo and redo`, async t => {
        const original = "before selected after\n\n```\n  code();  \n```  \n";
        const page = await openEditor(t, 1440, original, {
            clipboard: {
                items: [{
                    "text/html": "<b>new</b>",
                    "text/plain": "new",
                }],
            },
        });
        await page.getByLabel("Append at document end").uncheck();
        await selectSource(page, start, end);
        await pasteAsMarkdown(page);
        const expected = original.slice(0, start) + "**new**" + original.slice(end);
        await assertSource(page, expected, start + 7);
        await page.keyboard.press("Control+z");
        await assertSource(page, original);
        await page.keyboard.press("Control+Shift+z");
        await assertSource(page, expected);
    });
}

test("plain-text-only paste keeps whitespace and punctuation even with normalization enabled", async t => {
    const text = " \t“plain”—…  \n\n  code();  \n";
    const page = await openEditor(t, 1440, "before AFTER", { clipboard: { items: [{ "text/plain": text }] } });
    await page.getByLabel("Append at document end").uncheck();
    await page.getByLabel("Normalize punctuation (HTML only)").check();
    await selectSource(page, 7, 12);
    await pasteAsMarkdown(page);
    await assertSource(page, "before " + text, 7 + text.length);
});

test("native textarea CRLF normalization leaves the caret immediately after inserted text", async t => {
    const page = await openEditor(t, 1440, "A tail", { clipboard: { items: [{ "text/plain": "one\r\ntwo" }] } });
    await page.getByLabel("Append at document end").uncheck();
    await selectSource(page, 1);
    await pasteAsMarkdown(page);
    await assertSource(page, "Aone\ntwo tail", 8);
});

test("append and punctuation preferences survive reload without saving a draft", async t => {
    const page = await openEditor(t, 1440, "private draft", { clipboard: { items: [{ "text/html": "<p>“Text”…</p>" }] } });
    await page.getByLabel("Append at document end").check();
    await page.getByLabel("Normalize punctuation (HTML only)").check();
    await page.waitForFunction(async () => (await one.storage.get("md_preview:paste-preferences"))?.normalizePunctuation === true);
    assert.deepEqual(await page.evaluate(async () => ({
        keys: await one.storage.keys(),
        preferences: await one.storage.get("md_preview:paste-preferences"),
    })), {
        keys: ["md_preview:paste-preferences"],
        preferences: { version: 1, appendMode: true, normalizePunctuation: true },
    });
    await page.reload();
    await page.waitForFunction(() => document.getElementById("normalize-punctuation").checked);
    await assertSource(page, "");
    assert.equal(await page.getByLabel("Append at document end").isChecked(), true);
    const original = "```\n  code  \n```  \n  ";
    await page.locator("#markdown-source").fill(original);
    await selectSource(page, 0, original.length);
    await pasteAsMarkdown(page);
    const expected = original + "\n\"Text\"...";
    await assertSource(page, expected, expected.length);
});

test("corrupt preferences restore defaults and unavailable storage still permits paste", async t => {
    const page = await openEditor(t, 1440, "", { clipboard: { items: [{ "text/plain": "Text" }] } });
    await page.evaluate(() => one.storage.set("md_preview:paste-preferences", "{broken"));
    await page.reload();
    await page.evaluate(() => one.storage.get("md_preview:paste-preferences"));
    assert.equal(await page.getByLabel("Append at document end").isChecked(), true);
    assert.equal(await page.getByLabel("Normalize punctuation (HTML only)").isChecked(), false);
    await pasteAsMarkdown(page);
    await assertSource(page, "Text", 4);

    const unavailable = await openEditor(t, 1440, "", {
        storageUnavailable: true,
        clipboard: { items: [{ "text/plain": "Text" }] },
    });
    await unavailable.getByLabel("Normalize punctuation (HTML only)").check();
    await unavailable.getByText("Paste options could not be saved. They still apply in this tab.", { exact: true }).waitFor();
    await pasteAsMarkdown(unavailable);
    await assertSource(unavailable, "Text", 4);
});

for (const mode of ["denied", "missing", "missing-read", "broken-item"]) {
    test(`${mode} clipboard access offers a focused dialog that converts a rich paste event`, async t => {
        const page = await openEditor(t, 1440, "before selected after", {
            clipboard: {
                mode,
                items: [{ "text/html": "<p>Unused</p>" }],
            },
        });
        await page.getByLabel("Append at document end").uncheck();
        await selectSource(page, 7, 15);
        await page.getByRole("button", { name: "Paste as Markdown", exact: true }).click();
        await page.getByRole("dialog", { name: "Paste as Markdown" }).waitFor();
        assert.equal(await page.getByLabel("Paste copied content here").evaluate(element => element === document.activeElement), true);
        assert.equal(await page.locator("#paste-markdown").isDisabled(), true);
        assert.equal(await pasteEvent(page, {
            "text/html": "<strong>converted</strong>",
            "text/plain": "plain fallback",
        }), true);
        await waitForPaste(page);
        await assertSource(page, "before **converted** after", 20);
        assert.equal(await page.getByRole("dialog").isVisible(), false);
        assert.equal(await page.locator("#paste-input").inputValue(), "");
        await page.keyboard.press("Control+z");
        await assertSource(page, "before selected after");
    });
}

test("dialog plain-text paste and append share the same insertion workflow", async t => {
    const page = await openEditor(t, 1440, "Existing  \n", { clipboard: { mode: "missing" } });
    await page.getByLabel("Append at document end").check();
    await page.getByLabel("Normalize punctuation (HTML only)").check();
    await selectSource(page, 0, 8);
    await page.locator("#paste-markdown").click();
    await page.getByRole("dialog").waitFor();
    await pasteEvent(page, { "text/plain": "“plain”  \n\tcode\n" });
    await waitForPaste(page);
    const expected = "Existing  \n\n“plain”  \n\tcode\n";
    await assertSource(page, expected, expected.length);
});

for (const cancel of ["Escape", "button"]) {
    test(`keyboard activation and dialog cancellation via ${cancel} leave the selection intact`, async t => {
        const page = await openEditor(t, 1440, "before selected after", { clipboard: { mode: "missing" } });
        await page.getByLabel("Append at document end").uncheck();
        await selectSource(page, 7, 15);
        for (let tab = 0; tab < 3; tab++) {
            await page.keyboard.press("Shift+Tab");
        }
        assert.equal(await page.locator("#paste-markdown").evaluate(element => element === document.activeElement && element.matches(":focus-visible")), true);
        await page.keyboard.press("Enter");
        await page.getByRole("dialog").waitFor();
        if (cancel === "button") {
            await page.keyboard.press("Tab");
            assert.equal(await page.getByRole("button", {
                name: "Cancel",
                exact: true,
            }).evaluate(element => element === document.activeElement), true);
            await page.keyboard.press("Enter");
        } else {
            await page.keyboard.press("Escape");
        }

        await waitForPaste(page);
        await assertSource(page, "before selected after");
        assert.equal(await page.getByRole("dialog").isVisible(), false);
        assert.equal(await page.locator("#markdown-source").evaluate(element => element === document.activeElement), true);
        await page.locator("#paste-markdown").click();
        await page.getByRole("dialog").waitFor();
        await pasteEvent(page, { "text/plain": "new" });
        await waitForPaste(page);
        await assertSource(page, "before new after", 10);
    });
}

for (const [name, items] of [
    ["empty clipboard", []],
    ["unsupported image", [{ "image/png": "fixture image bytes" }]],
    ["empty plain text", [{ "text/plain": "" }]],
    ["HTML with no convertible content", [{
        "text/html": "<script>unsafe()</script>",
        "text/plain": "Do not insert this fallback",
    }]],
]) {
    test(`${name} leaves a selected document unchanged`, async t => {
        const page = await openEditor(t, 1440, "Keep this", { clipboard: { items } });
        await selectSource(page, 0, 9);
        await pasteAsMarkdown(page);
        await assertSource(page, "Keep this");
        await page.getByText("No convertible HTML or plain text was found. Copy text and try again.", { exact: true }).waitFor();
    });
}

test("converter resource limits and failures report errors without inserting HTML or plain fallbacks", async t => {
    const page = await openEditor(t, 1440, "Keep this", {
        clipboard: {
            items: [{
                "text/html": "<div>".repeat(129) + "Too deep",
                "text/plain": "Do not insert this fallback",
            }],
        },
    });
    await selectSource(page, 0, 9);
    await pasteAsMarkdown(page);
    await assertSource(page, "Keep this");
    await page.getByText(/Could not paste as Markdown.*128 level nesting limit.*smaller or simpler/).waitFor();
    await page.evaluate(() => {
        window.htmlToMarkdown = () => {
            throw new Error("Converter fixture failure");
        };
    });
    await pasteAsMarkdown(page);
    await assertSource(page, "Keep this");
    await page.getByText("Could not paste as Markdown. Copy a smaller or simpler selection and try again.", { exact: true }).waitFor();
});

test("empty dialog paste and failed dialog conversion leave the document unchanged", async t => {
    const page = await openEditor(t, 1440, "Keep this", { clipboard: { mode: "missing" } });
    await selectSource(page, 0, 9);
    for (const data of [{}, {
        "text/html": "<div>".repeat(129) + "Too deep",
        "text/plain": "fallback",
    }]) {
        await page.locator("#paste-markdown").click();
        await page.getByRole("dialog").waitFor();
        await pasteEvent(page, data);
        await waitForPaste(page);
        await assertSource(page, "Keep this");
    }
});

test("pending reads block duplicate execution and use the saved selection even after the cursor moves", async t => {
    const page = await openEditor(t, 1440, "ABCD", {
        clipboard: {
            mode: "deferred",
            items: [{ "text/html": "<b>X</b>" }],
        },
    });
    await page.getByLabel("Append at document end").uncheck();
    await selectSource(page, 1, 3);
    await page.locator("#paste-markdown").click();
    await page.waitForFunction(() => window.clipboardFixture.releaseRead);
    assert.equal(await page.locator("#paste-status").textContent(), "Reading clipboard...");
    assert.equal(await page.locator("#paste-markdown").getAttribute("aria-busy"), "true");
    assert.equal(await page.getByLabel("Append at document end").isDisabled(), true);
    await page.locator("#paste-markdown").dispatchEvent("click");
    await selectSource(page, 4);
    await page.evaluate(() => {
        const convert = htmlToMarkdown;
        window.htmlToMarkdown = (...args) => {
            window.conversionBusy = document.getElementById("paste-markdown").disabled
                && document.getElementById("paste-preferences").disabled
                && document.getElementById("paste-status").textContent === "Converting...";
            return convert(...args);
        };
        window.clipboardFixture.releaseRead();
    });
    await waitForPaste(page);
    assert.equal(await page.evaluate(() => window.clipboardFixture.reads), 1);
    assert.equal(await page.evaluate(() => window.conversionBusy), true);
    await assertSource(page, "A**X**D", 6);
    assert.equal(await page.getByLabel("Append at document end").isEnabled(), true);
    assert.equal(await page.locator("#paste-markdown").getAttribute("aria-busy"), null);
});

for (const edit of ["typing", "edit then undo", "programmatic", "append"]) {
    test(`${edit} during an asynchronous read cancels insertion and preserves the current document`, async t => {
        const page = await openEditor(t, 1440, "Original", {
            clipboard: {
                mode: "deferred",
                items: [{ "text/plain": "Stale paste" }],
            },
        });
        if (edit !== "append") {
            await page.getByLabel("Append at document end").uncheck();
        }
        await selectSource(page, 0, 8);
        await page.locator("#paste-markdown").click();
        await page.waitForFunction(() => window.clipboardFixture.releaseRead);
        if (edit === "programmatic") {
            await page.locator("#markdown-source").evaluate(element => {
                element.value = "Edited";
            });
        } else {
            await page.locator("#markdown-source").fill("Edited");
        }
        if (edit === "edit then undo") {
            await page.keyboard.press("Control+z");
        }
        const expected = await page.locator("#markdown-source").inputValue();
        await page.evaluate(() => window.clipboardFixture.releaseRead());
        await waitForPaste(page);
        await assertSource(page, expected);
        await page.getByText(/The Markdown changed while paste was pending/).waitFor();
    });
}

test("edits while the dialog is open cancel its pending insertion", async t => {
    const page = await openEditor(t, 1440, "Original", { clipboard: { mode: "missing" } });
    await selectSource(page, 0, 8);
    await page.locator("#paste-markdown").click();
    await page.getByRole("dialog").waitFor();
    await page.locator("#markdown-source").evaluate(element => {
        element.value = "Edited while waiting";
        element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pasteEvent(page, { "text/html": "<b>Stale</b>" });
    await waitForPaste(page);
    await assertSource(page, "Edited while waiting");
    await page.getByText(/The Markdown changed while paste was pending/).waitFor();
});

for (const fallback of ["false", "throw"]) {
    test(`selection insertion still updates preview when execCommand returns ${fallback}`, async t => {
        const page = await openEditor(t, 1440, "Before old after", { clipboard: { items: [{ "text/html": "<strong>new</strong>" }] } });
        await page.getByLabel("Append at document end").uncheck();
        await page.evaluate(mode => {
            document.execCommand = () => {
                if (mode === "throw") {
                    throw new Error("insertText unavailable");
                }
                return false;
            };
        }, fallback);
        await selectSource(page, 7, 10);
        await pasteAsMarkdown(page);
        await assertSource(page, "Before **new** after", 14);
        assert.equal(await page.locator("#preview strong").textContent(), "new");
    });
}

test("normal paste and the plain-text shortcut retain trusted native textarea behavior", async t => {
    const page = await openEditor(t, 1440, "AB", { nativeClipboard: true });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(async () => {
        window.nativePastes = [];
        document.getElementById("markdown-source").addEventListener("paste", event => {
            window.nativePastes.push({
                trusted: event.isTrusted,
                prevented: event.defaultPrevented,
            });
        });
        await navigator.clipboard.write([new ClipboardItem({
            "text/html": new Blob(["<b>rich</b>"], { type: "text/html" }),
            "text/plain": new Blob(["  plain *text*  \n"], { type: "text/plain" }),
        })]);
    });
    try {
        for (const shortcut of ["Control+v", "Control+Shift+v"]) {
            await page.locator("#markdown-source").fill("AB");
            await selectSource(page, 1);
            await page.keyboard.press(shortcut);
            await assertSource(page, "A  plain *text*  \nB");
        }
        assert.deepEqual(await page.evaluate(() => window.nativePastes), [{
            trusted: true,
            prevented: false,
        }, { trusted: true, prevented: false }]);
        assert.equal(await page.getByRole("dialog").isVisible(), false);
    } finally {
        await page.evaluate(() => navigator.clipboard.writeText(""));
    }
});

test("a trusted rich paste into the dialog works without granting clipboard-read permission", async t => {
    const page = await openEditor(t, 1440, "AB", { nativeClipboard: true });
    await page.getByLabel("Append at document end").uncheck();
    await page.context().grantPermissions(["clipboard-write"]);
    await page.evaluate(async () => {
        Object.defineProperty(navigator.clipboard, "read", {
            value: async () => {
                throw new DOMException("Reading is denied", "NotAllowedError");
            },
        });
        document.getElementById("paste-input").addEventListener("paste", event => {
            window.dialogPasteTrusted = event.isTrusted;
        });
        await navigator.clipboard.write([new ClipboardItem({
            "text/html": new Blob(["<strong>rich text</strong>"], { type: "text/html" }),
            "text/plain": new Blob(["plain fallback"], { type: "text/plain" }),
        })]);
    });
    try {
        await selectSource(page, 1);
        await page.getByRole("button", { name: "Paste as Markdown", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        await page.keyboard.press("Control+v");
        await waitForPaste(page);
        assert.equal(await page.evaluate(() => window.dialogPasteTrusted), true);
        await assertSource(page, "A**rich text**B", 14);
    } finally {
        await page.evaluate(() => navigator.clipboard.writeText(""));
    }
});

test("clipboard HTML stays out of the live DOM and only sanitized conversion is previewed", async t => {
    const page = await openEditor(t, 1440, "", { clipboard: { mode: "missing" } });
    await page.evaluate(() => {
        window.unsafeInserted = false;
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && (node.matches("[data-raw-clipboard]") || node.querySelector("[data-raw-clipboard]"))) {
                        window.unsafeInserted = true;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.stopObservingClipboard = () => observer.disconnect();
    });
    await page.locator("#paste-markdown").click();
    await page.getByRole("dialog").waitFor();
    await pasteEvent(page, { "text/html": "<p data-raw-clipboard='yes' onclick='window.clipboardExecuted=true'>Safe <b>text</b></p><script data-raw-clipboard='yes'>window.clipboardExecuted=true</script>" });
    await waitForPaste(page);
    await assertSource(page, "Safe **text**", 13);
    assert.equal(await page.evaluate(() => window.unsafeInserted || Boolean(window.clipboardExecuted)), false);
    assert.equal(await page.locator("#preview p").textContent(), "Safe text");
    await page.evaluate(() => window.stopObservingClipboard());
});

test("converted Markdown remains editable, copyable, exportable and printable with a working TOC", async t => {
    const page = await openEditor(t, 1440, "[TOC]\n\n", { clipboard: { items: [{ "text/html": "<h1>Copied title</h1><p>Hello <strong>world</strong>.</p><h2>Section</h2><p>Text.</p>" }] } });
    await selectSource(page, 7);
    await pasteAsMarkdown(page);
    const markdown = "[TOC]\n\n# Copied title\n\nHello **world**.\n\n## Section\n\nText.";
    await assertSource(page, markdown, markdown.length);
    assert.equal(await page.locator(".toc a").count(), 2);
    await page.getByRole("button", { name: "Copy Markdown" }).click();
    assert.deepEqual(await page.evaluate(() => window.clipboardFixture.writes), [markdown]);
    await page.getByText("Copied to clipboard", { exact: true }).waitFor();
    const directory = await mkdtemp(join(tmpdir(), "md-paste-exports-"));
    t.after(() => rm(directory, { recursive: true }));
    for (const [label, extension] of [["MD", "md"], ["HTML", "html"]]) {
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: label, exact: true }).click();
        const download = await downloadEvent;
        assert.match(download.suggestedFilename(), new RegExp(`^md-preview-.+\\.${extension}$`));
        const path = join(directory, `converted.${extension}`);
        await download.saveAs(path);
        const text = await readFile(path, "utf8");
        if (extension === "md") {
            assert.equal(text, markdown);
        } else {
            const exported = await page.context().newPage();
            await exported.goto(pathToFileURL(path).href);
            assert.equal(await exported.locator("script, link[rel=stylesheet], textarea").count(), 0);
            assert.equal(await exported.locator(".toc a").count(), 2);
            await exported.locator(".toc").getByRole("link", {
                name: "Section",
                exact: true,
            }).click();
            assert.equal(new URL(exported.url()).hash, "#section");
            await exported.close();
        }
    }

    await page.evaluate(() => {
        window.print = () => {
            window.printedText = document.getElementById("preview").textContent;
        };
    });
    await page.getByRole("button", { name: "Print document" }).click();
    assert.match(await page.evaluate(() => window.printedText), /Copied title/);
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".toc").isVisible(), true);
    assert.equal(await page.locator("body > header").isVisible(), false);
    assert.equal(await page.locator("aside").isVisible(), false);
    await page.emulateMedia({ media: "screen" });
    const start = markdown.indexOf("Hello");
    await selectSource(page, start, start + 5);
    await page.getByRole("button", { name: "Italic", exact: true }).click();
    await page.locator("#preview em").waitFor();
    assert.equal(await page.locator("#preview em").textContent(), "Hello");
    await page.keyboard.press("Control+z");
    await assertSource(page, markdown);
    await page.locator("#markdown-source").fill("");
    await page.waitForFunction(() => document.getElementById("copy-markdown").disabled);
    assert.equal(await page.getByRole("button", { name: "Copy Markdown" }).isDisabled(), true);
});

for (const width of [320, 768, 1440]) {
    test(`paste controls and dialog fit at ${width}px in automatic light and dark modes`, async t => {
        const page = await openEditor(t, width, fixture, {
            keepEditorOpen: true,
            clipboard: { mode: "missing" },
        });
        const backgrounds = [];
        for (const colorScheme of ["light", "dark"]) {
            await page.emulateMedia({ colorScheme });
            await settleAppearance(page);
            const layout = await page.evaluate(() => ({
                background: getComputedStyle(document.getElementById("markdown-source")).backgroundColor,
                width: innerWidth,
                scrollWidth: document.scrollingElement.scrollWidth,
                controls: [...document.querySelectorAll("#editor button, #editor label, #editor fieldset")].map(element => {
                    const rect = element.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        width: element.clientWidth,
                        content: element.scrollWidth,
                    };
                }),
            }));
            backgrounds.push(layout.background);
            assert(layout.scrollWidth <= layout.width + 1, "The page has no horizontal overflow");
            assert(layout.controls.every(rect => rect.left >= 0 && rect.right <= width + 1 && rect.content <= rect.width + 1), "Editor controls and labels fit without clipping");
            await page.locator("#paste-markdown").click();
            await page.getByRole("dialog").waitFor();
            const dialog = await page.getByRole("dialog").evaluate(element => ({
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
                width: element.clientWidth,
                content: element.scrollWidth,
                background: getComputedStyle(element).backgroundColor,
            }));
            assert(dialog.left >= 0 && dialog.right <= width && dialog.content <= dialog.width + 1, "The dialog fits without clipping");
            backgrounds.push(dialog.background);
            await page.keyboard.press("Escape");
            await waitForPaste(page);
        }
        assert.notEqual(backgrounds[0], backgrounds[2], "Editor colors follow the system preference");
        assert.notEqual(backgrounds[1], backgrounds[3], "Dialog colors follow the system preference");
    });
}

test("large text and short viewports keep paste controls and the editor reachable", async t => {
    const page = await openEditor(t, 720, fixture, { keepEditorOpen: true });
    await page.setViewportSize({ width: 720, height: 450 });
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    for (const selector of ["#paste-markdown", "#append-mode", "#normalize-punctuation", "#markdown-source", "#copy-markdown"]) {
        await page.locator(selector).focus();
        await page.locator(selector).scrollIntoViewIfNeeded();
        const bounds = await page.locator(selector).boundingBox();
        assert(bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.x + bounds.width <= 721, `${selector} fits horizontally`);
        assert(bounds.y < 450 && bounds.y + bounds.height > 0, `${selector} is reachable by scrolling`);
    }
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), true);
});
