# Slides

A local Markdown-and-CSS presentation editor. There is no build step and no presentation service or account.

## Authoring reference

See [PRESENTATION_FORMAT.md](PRESENTATION_FORMAT.md) for a standalone technical reference suitable for attaching to an AI prompt. It documents the ZIP structure, metadata, every built-in layout with a working Markdown example, numeric formats, CSS hooks, asset and font packaging, restrictions, and a reusable authoring prompt. A deck-specific design guide can be supplied alongside it.

## Open the tool

Open `slide_editor/index.html` from the web workspace in a modern browser. Keep the application files in `slide_editor` and the shared `one.css`, `one.js`, and font assets in its parent directory. Click **Open ZIP** and select a presentation archive. Leave the presentation ZIP compressed when importing it.

The header, responsive main/aside grid, controls, surfaces, typography and dialogs use the shared `one.css`. Shared UI helpers and ZIP generation load from `../one.js`; Markdown rendering uses the adjacent `md-renderer.js`. Application-specific rules and inert slide defaults live in `index.html`; additional presentation rules live in each presentation's `slides.css`. The application does not contain an embedded branded presentation or a display-mode selector.

The interface uses the local Inter and Material Symbols font assets provided by the shared stylesheet. Keep those assets alongside `one.css` when packaging the tool.

Some browser configurations restrict local-file storage or browser APIs. A local static server is another way to open the tool:

```sh
cd path/to/web
python -m http.server 8000
```

Then open `http://localhost:8000/slide_editor/` in your browser. The tool requires JavaScript, CSS `:has()` and `light-dark()`, `ResizeObserver`, and the normal browser Blob/stream APIs. Compressed ZIP import additionally requires `DecompressionStream("deflate-raw")`; uncompressed ZIPs do not need the decompressor.

## Edit and present

The aside has separate, continuously editable **slides.md** and **slides.css** fields. Both update the preview after a short debounce. On smaller screens, the header's menu control opens the same aside as a drawer.

**Add slide** inserts a new slide at the end. **Bold**, **Italic** and **Strikethrough** wrap selected Markdown. **Copy Markdown** copies the complete Markdown source. **New** starts a neutral presentation; replacing an edited deck asks for confirmation.

Use the arrow buttons or keyboard to navigate. Overview jumps to any slide; Notes shows the current slide's speaker notes. Present opens a full-screen canvas. Print uses a separate, complete slide document rather than printing the tool interface. The K shortcut retains the optional confetti effect and respects reduced-motion preferences.

The complete syntax and shortcuts are available through the info button at the top right.

## Presentation ZIP format

Required UTF-8 text files at the ZIP root:

```text
slides.md
slides.css
```

A single enclosing folder is also accepted. Include images and other referenced assets alongside those files or in subfolders. The required filenames are case-sensitive. Every additional non-directory file is retained in downloads, except macOS metadata files. For example:

```text
slides.md
slides.css
images/logo.svg
images/diagram.png
```

**Download ZIP** writes the current contents of both editors and all imported assets using shared `one.zip.create` in STORE mode. This keeps exported decks readable without native compression or decompression support. No tool HTML, temporary blob URLs or application styles are inserted into those source files. Textarea line endings are normalized by the browser; imported UTF-8 BOMs are not retained. Image/binary assets remain byte-for-byte unchanged. Export rejects nonportable asset paths, including characters such as `:` and `"`; rename those assets and update their source references before importing the deck.

**Open ZIP**, or dropping a ZIP onto the canvas, restores both editor files and resolves relative image and CSS `url(...)` references to local archive assets. Temporary image/media Blob URLs and embedded font data URLs exist only in the rendered slide documents. The ZIP reader supports stored and DEFLATE-compressed files, including data descriptors. It rejects encrypted, multi-part, large ZIP64, ambiguous, path-traversing or corrupt archives.

Limits: 32 MiB archive, 64 MiB total uncompressed, 16 MiB per file, 256 entries and 250 slides. Exports are checked against the same import limits so an exported file remains importable. Font binaries are not included with the supplied tool or sample presentation.

## Bundled fonts

Presentation ZIPs may contain font assets. The updated loader recognizes `.woff2`, `.woff`, `.ttf`, and `.otf`. Reference them with relative `url(...)` sources inside `@font-face` rules in `slides.css`; `local(...)` alone only uses an installed font. Imported font bytes and source-relative CSS paths are preserved on export. Network font URLs and CSS imports are blocked. There is no separate binary-asset upload control: add assets to the ZIP and import it again. Use font files you are authorized to package and distribute. No font binaries are included in this tool archive.

The loader now embeds ZIP font bytes as data URLs in the preview and print stylesheets. It does not depend on a font Blob URL created in the parent document. CSS URL parsing supports escaped characters and function names, quoted filenames with spaces or parentheses, percent-encoded paths, and a single enclosing ZIP folder. These substitutions only affect runtime CSS; exports keep the original relative sources and font bytes.

Expand **Fonts & assets** below the editors for a report showing the files in the ZIP, unreferenced fonts, missing or blocked URLs, local-only sources, per-document font decoding status, and the current slide's requested heading/body font families. **Decoded** means that the browser accepted the face, not that every glyph on the slide uses it. Use **Copy report** when diagnosing a presentation. Font loading is awaited before printing; reapplying unchanged CSS does not reset the font faces.

A font must be both declared and selected. `local(...)` does not read the ZIP, and a `body { font-family: ... }` rule does not override headings that already have their own font family. Set `--body` and `--display`, or target the relevant selectors. Use `format("truetype")` for TTF and `format("opentype")` for OTF, or omit the optional format hint; the hint is not the filename extension.

CSS source-map/sourceURL comments are omitted from the rendered copy, where relative debugging URLs have no useful archive location. Source files and ZIP downloads retain those comments. This is separate from font selection or decoding.

See the dedicated authoring reference for complete font examples.

## Markdown and CSS

Separate slides with `---` on its own line. Each slide needs a top-level `#` heading. Fenced code blocks can contain literal separator lines. `==text==` becomes highlighted text. Put `<!-- notes -->` on its own line before speaker notes.

Optional metadata goes at the very start of a slide:

```markdown
<!-- layout: cover | section: Introduction | footer: Source description | lang: en -->
# A clear ==main message.==

A subtitle.

### First point
Supporting copy.

### Second point
Supporting copy.

<!-- notes -->
Speaker notes, not shown on the slide.
```

Supported layouts are `generic`, `cover`, `caveat`, `metric`, `metric-pie`, `quality` and `result`. An unknown simple layout name behaves as generic content and is available as a CSS class. Other recognized metadata keys are `logo`, `logo-alt`, `stat-label` and `unit`. Chart layouts use Markdown tables: labels in column one, values in column two, optional descriptions in column three. `unit: number` uses periods as grouping separators and commas as decimals; `unit: decimal` uses commas as grouping separators and a decimal point; `unit: duration` accepts values such as `4 min 03 s`.

The canvas is 1600 × 900. `slides.css` overrides neutral defaults within an isolated slide document. Common selectors include `.slide`, `.slide-title`, `.slide-top`, `.slide-footer`, `.slide-note` and the layout classes. Common variables include `--paper`, `--ink`, `--muted`, `--accent`, `--context`, `--display` and `--body`. Pie/confetti colors can be defined through `.series-1` to `.series-6`.

No inline style attributes are added by the tool. The renderer's table-alignment attributes are converted to CSS classes. Scale values are updated through the stylesheet API. Chart geometry uses SVG attributes.

## Drafts and isolation

Drafts include Markdown, CSS, the presentation name, position and local assets. The tool saves them through the supplied `one.storage` IndexedDB utility. Drafts are browser/origin-specific, not a replacement for a downloaded ZIP. If storage is unavailable, the editor and ZIP workflow continue and the status explains that a download is needed to keep changes.

Invalid Markdown leaves the last valid preview intact while keeping the unfinished source editable, locally saveable and downloadable. After a reload, an unfinished draft can still be recovered in the editors. A failed ZIP import does not replace the current presentation.

Slide CSS is applied inside a sandboxed iframe, not to the tool's document. Raw Markdown HTML is sanitized; slide scripts, remote images, CSS imports and external stylesheets are blocked. Local archive assets and data URLs work. This isolates presentation design from application controls; it is not a guarantee against all possible browser or resource-exhaustion bugs in untrusted input.

## Files and verification

`app.js` handles editing, layout, navigation, storage coordination, font diagnostics and downloads. `asset-loader.js` resolves archive URLs and embeds font bytes in runtime CSS. `zip-reader.js` is the bounded local import reader; the shared parent `one.js` provides ZIP writing. `index.html` contains the shell and all added style rules.

From the web root, run `bun test slide_editor/export.browser.test.js` for Chromium import/edit/export/re-import checks over HTTP and `file://`. The suite verifies source text and binary assets with Python's independent ZIP reader, STORE output without native codecs, narrow/dark and wide/light layouts, export failure recovery, and download resource cleanup. It uses the installed Playwright package and closes its browser contexts, browser, and fixture server after testing.
