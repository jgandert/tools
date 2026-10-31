# MD Paste & Preview

Open `index.html` directly from disk to convert copied rich text to Markdown and edit it beside a live preview. Use Copy Markdown beside the formatting controls, or download Markdown, export standalone HTML, and print from the header. Conversion and rendering run locally without runtime dependencies or a server. Linked images in the preview can still load from their source sites.

Use the sidebar toggle to switch between the editor and preview on narrow screens. `[TOC]`, `[[_TOC_]]`, and `<!-- toc -->` insert a table of contents. Each marker inserts its own TOC.

## Paste as Markdown

Place the cursor in the Markdown editor, or select text to replace, then choose **Paste as Markdown**. The action prefers clipboard HTML and converts it with `htmlToMarkdown()`. If the clipboard contains only plain text, it inserts that text unchanged, including punctuation and code whitespace. The editor regains focus with the caret after the insertion. Native undo works where the browser supports `insertText`; other browsers use a selection replacement fallback.

When rich clipboard reading is missing or denied, a native dialog opens with a labelled paste field. Paste into that field using the browser's normal paste command. Its clipboard event supplies HTML and plain text without Clipboard API permission, including when opening the tool through `file://`. Conversion and insertion happen immediately after that paste. Cancel or Escape closes the dialog without changing the document.

Ordinary paste into the main editor remains native plain-text paste. The usual paste-as-plain-text shortcut is unchanged. Use the explicit action whenever you want rich-text conversion.

The two paste options default to off:

- **Append at document end** inserts after the entire document instead of replacing the saved selection. It adds a paragraph separator when needed without trimming existing text or the inserted text.
- **Normalize punctuation (HTML only)** converts smart quotes, dashes and ellipses in ordinary HTML text. Code and link destinations stay exact, and plain-text paste is unaffected.

Only these versioned preferences are saved through `one.storage` under `md_preview:paste-preferences`. Missing, corrupt or unavailable storage leaves sensible defaults; a failed write keeps the chosen options usable in the current tab. Documents are not persisted and are lost when the tab is reloaded or closed.

While a paste is pending, its button shows progress and duplicate execution is disabled. If the document changes during a clipboard read or while the dialog is open, insertion is cancelled with a message asking you to choose an insertion point and retry. Empty or unsupported clipboard data and conversion errors leave the document unchanged. Resource-limit errors explain the limit and ask for a smaller or simpler copied selection.

The editor does not know the copied document's source URL, so relative links remain relative. It never uses its own page URL as the converter's `baseUrl`. Clipboard HTML is handled as a string, and the preview receives the renderer's sanitized output.

## HTML-to-Markdown converter

[`html-to-md.js`](html-to-md.js) exposes `htmlToMarkdown(html, options)` and powers both paste paths. It is an independent Apache-2.0 implementation with no runtime dependencies, DOM access, network access, or other I/O. [`paste-workflow.js`](paste-workflow.js) holds the DOM-free insertion, separator and preference logic; the editor page coordinates the controls, clipboard access, dialog and undo-aware insertion.

In Bun, load it with `const { htmlToMarkdown } = require("./md_preview/html-to-md.js")`. A classic browser script exposes `globalThis.htmlToMarkdown`, so it also works when loaded from disk without a module server.

```js
htmlToMarkdown("<h2>Title</h2><p>Hello <strong>world</strong>.</p>");
// "## Title\n\nHello **world**."

htmlToMarkdown('<a href="../guide">Guide</a>', {
    baseUrl: "https://example.com/docs/start/",
});
// "[Guide](https://example.com/docs/guide)"
```

The converter handles headings, paragraphs, nested lists, ordered list starts, task checkboxes, blockquotes, links, images, inline code and fenced code blocks. It includes tables, strikethrough, highlight, insertion, and the preview renderer's subscript/superscript extensions. Common inline font-weight, font-style and text-decoration declarations also convert to formatting. Ambiguous inline formatting uses safe HTML tags.

Merged cells, row headers, complex tables, reversed lists, explicit list-item values, definition lists, details and links wrapping blocks retain their structure as generated, sanitized HTML. Tables without a header get an empty header row so their first data row remains data. Unsupported wrappers retain their text. Executable elements, embedded documents, hidden content and event handlers are discarded. Only HTTP, HTTPS, relative URLs and mailto links are retained; unsupported images retain their alt text. A supplied `baseUrl` must be absolute HTTP or HTTPS; an imported `<base>` tag is ignored.

Punctuation stays unchanged by default. `normalizePunctuation: true` converts smart quotes, dashes and ellipses in ordinary text; code and link destinations remain exact. HTML character references are decoded once, including the complete set of [HTML named character references](https://html.spec.whatwg.org/multipage/named-characters.html). The embedded table contains standard names and Unicode code points.

HTML and Markdown do not express all the same layouts. The converter does not reproduce stylesheets, computed CSS, generated content, embedded media, or a browser's complete HTML5 error-recovery algorithm. It recovers common omitted and mismatched closing tags, handles quoted attributes and raw-text elements, and preserves preformatted whitespace. Inputs over 5,000,000 UTF-16 code units, 100,000 parsed nodes, or 128 stack levels are rejected with `RangeError`. Invalid argument types and options raise `TypeError`. Large sparse tables use HTML to avoid expanding into an excessive Markdown grid.

### Bun tests

Run the converter and insertion tests directly, without installing a browser:

```sh
bun test md_preview/html-to-md.test.js
bun test md_preview/paste-workflow.test.js
bun test_md_renderer.js
```

The converter tests cover malformed fragments, whitespace, character references, delimiter collisions, nested structures, unsafe URLs and attributes, resource limits, deterministic generated inputs, representative conversion/rendering round trips against [`md-renderer.js`](../md-renderer.js), and the classic browser script export in an isolated JavaScript context.

## Browser tests

The browser checks cover rich and plain clipboard fixtures, cursor insertion, selection replacement, append mode, preference restoration and unavailable storage, clipboard denial and missing APIs, dialog paste and cancellation, unchanged documents after errors, duplicate requests, edits during pending reads, focus, undo and the native insertion fallback. Trusted clipboard tests write deterministic HTML and plain-text fixtures before exercising normal paste, the plain-text shortcut and dialog conversion without clipboard-read permission.

They also check preview updates, editing, copy, Markdown and standalone HTML exports, printing, TOCs and anchors, narrow and wide layouts, keyboard operation, automatic light and dark modes, enlarged text, short viewports and textarea scrolling. The TOC fixture preserves Markdown hard breaks and adjacent source lines intentionally.

Playwright is a development dependency; the tool does not load it. From the repository root, install it and its Chromium browser, then run the tests:

```sh
bun add --dev playwright
bunx playwright install chromium
node --test md_preview/test_browser.mjs
```

The tests open the tool directly from disk with networking disabled. Chromium's platform libraries and system fonts must be available.
