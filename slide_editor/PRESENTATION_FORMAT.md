# Slides presentation format

This is a self-contained authoring reference for the supplied local Slides tool. It can be attached to a prompt together with a presentation brief, source material, and any design guide. It describes the implementation shipped in `slide_editor.zip`, not a generic Markdown slideshow standard.

The technical rules below were checked against `app.js`, `zip-reader.js`, `md-renderer.js`, and the slide-document styles in `index.html`. Examples use invented demonstration content, not factual claims about a real project. The final section is a reusable generation prompt.

## 1. Deliverable: one presentation ZIP

A presentation is a ZIP containing two required UTF-8 text files in the same root folder:

```text
presentation.zip
├── slides.md                 # Slide content, per-slide metadata, speaker notes
├── slides.css                # Presentation styling; may be empty
├── images/                   # Optional local assets
│   ├── logo.svg
│   └── diagram.png
├── fonts/                    # Optional font files supplied by the author
│   ├── deck-regular.woff2
│   └── deck-bold.woff2
├── README.md                 # Optional instructions
└── PRESENTATION_FORMAT.md    # Optional copy of this reference
```

Only include assets that actually exist. Font filenames above are examples; no font binaries accompany this guide.

Use the exact lowercase filenames `slides.md` and `slides.css`. No manifest, HTML file, application JavaScript, or `one.css` is required in a presentation ZIP. The application supplies its own interface and neutral slide defaults. All presentation-specific branding belongs in the presentation's Markdown, CSS, and assets, not in the tool's `index.html`.

The importer also accepts one enclosing folder containing both required files and every asset. It removes that common prefix internally. Use only one `slides.md`/`slides.css` pair in an archive. Do not put unrelated files outside the enclosing folder or include a second presentation in the ZIP.

Every additional non-directory file is retained on export, including documentation and font files; macOS metadata files are excluded. Optional Markdown documents are not automatically rendered as slides: only `slides.md` is the presentation source.

### Paths and limits

Asset references are relative to the presentation root, where `slides.md` and `slides.css` live. Use forward slashes, exact filename case, and preferably simple names. For example, use `images/logo.svg`, not `/images/logo.svg`, a local computer path, or a temporary `blob:` URL. The importer rejects unsafe paths and duplicate filenames, including names differing only by case.

The implemented limits are 32 MiB for the ZIP, 64 MiB total uncompressed data, 16 MiB per file, 256 ZIP entries, and 250 slides. Directory entries count toward the entry limit. A source document must contain at least one valid slide. Use a stored or DEFLATE-compressed ZIP; encrypted, split, and large ZIP64 archives are not supported. Export checks the same file and archive size limits, so a heavily compressed import may need smaller assets before it can be exported.

## 2. Slide boundaries and Markdown

Separate slides with `---` on a line of its own. Each slide must have a top-level `#` heading, outside lists, quotes, and HTML containers. Use exactly one such heading per slide; the first becomes the slide title. `##` and `###` headings have layout-specific roles described below.

Do not use YAML front matter: the presentation splitter treats its `---` delimiters as slide boundaries. Do not use a standalone `---` as an in-slide horizontal rule, including within speaker notes. A separator inside a fenced code block is literal code and does not start a new slide.

The renderer supports ordinary paragraphs, headings, bold, emphasis, strikethrough, lists, fenced code blocks, Markdown tables, links, and images. Additional useful syntax:

| Syntax | Meaning |
| --- | --- |
| `==important text==` | Highlighted text, rendered as `<mark>` |
| `<br>` | Explicit line break, including in a title |
| `![Useful alternative text](images/diagram.png)` | Image from the presentation ZIP |
| `> A brief caveat.` | On-slide note; see the distinction below |
| `<!-- notes -->` on its own line | Start speaker notes for this slide |

Raw HTML is sanitized. Safe structural elements and class attributes can be used for custom layouts, but scripts, executable event attributes, and inline `style` attributes are not supported. Put styles in `slides.css`. Do not rely on external JavaScript, diagram engines, or a Markdown framework's directives being present. Fenced code is rendered as code; it is not an instruction to generate a chart or diagram.

### On-slide notes versus speaker notes

The first top-level Markdown blockquote becomes `.slide-note` and is moved out of the main content. It appears near the slide's lower edge by default; the `caveat` layout places it in normal flow below its panel. Keep it short. Do not use that first blockquote as a normal in-flow quotation when its original position matters.

Speaker notes begin after the first standalone `<!-- notes -->` marker outside a fenced code block. They continue until the next slide separator or end of file. They can contain Markdown, but they are shown in the Notes dialog, not in the slide or its printed page. A notes marker within a fenced code example remains literal text.

## 3. Per-slide metadata

Metadata is optional. Without it, a slide uses the `generic` layout.

When present, the metadata comment must be the first content in the slide and must begin with the exact lowercase key `layout:`. Separate entries with `|`:

```text
<!-- layout: cover | section: Introduction | footer: Author-supplied source | lang: en | logo: images/logo.svg | logo-alt: Organization -->
```

This is not YAML. Values are plain text, not Markdown. Do not put literal `|` or `-->` inside a value. Unknown keys are ignored. Use the supported keys exactly as written:

| Key | Effect |
| --- | --- |
| `layout` | Built-in layout name or one custom CSS class name. Defaults to `generic`. |
| `section` | Small section label at the top of the slide. |
| `footer` | Source or footer text beside the automatic slide counter. |
| `lang` | Language tag for this slide, for example `en` or `de`. |
| `logo` | Relative path to a local image asset. Omit when no logo is provided. |
| `logo-alt` | Alternative text for the logo. |
| `unit` | Number parsing for `metric` and `metric-pie`: `number`, `decimal`, or `duration`. |
| `stat-label` | Small label below the large value in the `result` layout. |

Metadata does not carry over to the next slide. Repeat shared section, footer, language, and logo values where needed. Use the built-in layout names in lowercase. There is no presentation-level theme selector or global metadata block in this format.

## 4. Layouts and exact content structure

Structured layouts select specific elements from the Markdown; they are not arbitrary flowing pages. In particular, `metric`, `metric-pie`, and `quality` do not render unconsumed body elements. Keep supporting detail in speaker notes, or use `generic` for flexible content.

The examples below are independent valid `slides.md` files. Join them with a standalone `---` to make a multi-slide deck. Tables need a header and Markdown separator row; those do not count as data rows.

### `generic`: flexible content

The first top-level `#` heading becomes the title. All remaining body elements, except the first on-slide note, go into `.generic-content` in source order. There is no special subtitle or chart extraction.

```markdown
<!-- layout: generic | section: Overview | lang: en -->
# A clear ==main message.==

A short explanation of the message.

- First supporting point.
- Second supporting point.

> A brief on-slide qualification.

<!-- notes -->
Explain the background here without crowding the slide.
```

### `cover`: title, subtitle, and grouped sections

The first top-level paragraph becomes `.slide-subtitle`. Remaining elements are grouped into `.cover-section` elements inside `.cover-columns`; each `###` starts a new section. The default grid has two columns. For a predictable cover, use one subtitle and two `###` sections.

```markdown
<!-- layout: cover | section: Project overview | lang: en -->
# Make the next step<br>==easy to understand.==

A one-sentence introduction.

### The situation
Brief context for the presentation.

### The decision
What the audience needs to decide.

<!-- notes -->
Introduce the audience, purpose, and scope.
```

### `caveat`: explanatory panel and qualification

All remaining body elements go into `.caveat-panel`, except the extracted on-slide note. A `##` heading followed by a paragraph works well. Unlike `cover`, there is no special subtitle extraction.

```markdown
<!-- layout: caveat | section: Interpretation | lang: en -->
# Read the result<br>==in context.==

## A limited comparison.
The examples illustrate the format rather than a real evaluation.

> Do not generalize beyond the evidence supplied for a presentation.

<!-- notes -->
Describe limitations and what additional evidence would be needed.
```

### `metric`: large statistic and horizontal bars

The first top-level `##` heading and first top-level paragraph form `.metric-stat`. The first table becomes the bar chart. It must have at least two data rows. Column 1 is the label, column 2 the value, and optional column 3 a short detail. Further columns are not used.

The first data row gets `.chart-row.focal`. Bars start at zero and scale to the largest value within that slide's chart. Different slides do not automatically share a scale. Numeric bar values must be nonnegative. The large statistic is authored text: it is not calculated or verified by the tool.

```markdown
<!-- layout: metric | section: Demonstration | unit: decimal | lang: en -->
# The example uses<br>==25% less.==

## −25%
Example B uses fewer units than Example A.

| Variant | Units | Detail |
| --- | ---: | --- |
| Example B | 75 | Focal row |
| Example A | 100 | Comparison row |

> Demonstration values only.

<!-- notes -->
The authored percentage is (100 - 75) / 100 = 25%.
```

### `metric-pie`: large statistic and pie chart

Use the same Markdown structure as `metric`. At least two data rows are required, all parsed values must be nonnegative, and the total must be greater than zero. The tool calculates pie proportions and legend percentages; it does not calculate the large authored `##` statistic. `.series-1` through `.series-6` style slices and legend swatches, cycling for additional rows.

```markdown
<!-- layout: metric-pie | section: Demonstration | unit: decimal | lang: en -->
# Where the example<br>==total goes.==

## 65%
The main category represents most of the example total.

| Category | Value | Detail |
| --- | ---: | --- |
| Main category | 65 | Primary group |
| Other category | 35 | Remaining group |

<!-- notes -->
These are invented values used to illustrate the format.
```

### `quality`: subtitle and comparison table

The first top-level paragraph becomes `.slide-subtitle`. The first Markdown table becomes `.quality-table`. Table cell content remains Markdown-rendered text; it is not converted into chart values. This layout requires a table, but not the chart layouts' two-data-row minimum. Other unconsumed body content is omitted; use the on-slide note or speaker notes for additional explanation.

```markdown
<!-- layout: quality | section: Comparison | lang: en -->
# Compare the<br>==trade-offs.==

An illustrative comparison of two approaches.

| Criterion | Approach A | Approach B |
| --- | --- | --- |
| Setup | Simple | More configuration |
| Flexibility | Limited | Broader options |

> The preferred approach depends on the requirements.

<!-- notes -->
Replace these examples with findings supported by the supplied sources.
```

### `result`: large result, before/after values, and sections

The first top-level paragraph becomes `.slide-subtitle`. The first `##` heading becomes the large result; `stat-label` supplies its small label. A table with at least two data rows supplies the before/after flow. Only the first two data rows and their first two columns are used. Values can include units such as `100 items`; the tool separates leading numeric text from its trailing unit for display. It does not calculate a reduction from the table.

After the subtitle, statistic, and table have been extracted, remaining elements are grouped into `.result-section` blocks, with each `###` starting a new block. The default result grid has two columns.

```markdown
<!-- layout: result | section: Outcome | stat-label: Example reduction | lang: en -->
# Keep the value.<br>==Reduce the overhead.==

A simplified before-and-after example.

## −25%

| Stage | Size |
| --- | ---: |
| Before | 100 items |
| After | 75 items |

### Keep
The essential material.

### Change
The unnecessary duplication.

> Demonstration values, not a measured project result.

<!-- notes -->
Explain the calculation and distinguish the measured quantity from other outcomes.
```

### Custom layouts

An unrecognized valid layout name uses the generic renderer and is added as the slide's CSS class. A name must begin with an ASCII letter and contain only letters, numbers, underscores, and hyphens. Use a lowercase name such as `two-column`; do not use a CSS selector, multiple class names, or a name beginning with a digit.

With `layout: two-column`, target `.slide.two-column` and `.two-column .generic-content` in `slides.css`. The tool does not infer a new content parser from the name. Use normal Markdown order, CSS selectors, or sanitized class-based HTML wrappers to build the design. A custom layout is not a way to add executable code.

## 5. Numeric chart values

`unit` controls how the second column of a `metric` or `metric-pie` table is parsed; it does not control how the label is printed. The displayed value remains the cell's text. Formatting inside chart labels, values, and details is reduced to plain text.

| `unit` | Input conventions | Example and parsed value |
| --- | --- | --- |
| `number` (default) | Periods group thousands; a comma separates decimals. | `1.234,5` becomes 1234.5. |
| `decimal` | Commas group thousands; a period separates decimals. | `1,234.5` becomes 1234.5. |
| `duration` | Nonnegative whole minutes marked `min` and/or seconds marked `s`. | `4 min 03 s` becomes 243 seconds. |

Choose the unit explicitly for chart slides. A value such as `2.75` under the default `number` mode is interpreted as 275, not 2.75. Currency or unit text may be displayed with a numeric value, but abbreviations such as `1k`, arithmetic expressions, ranges, scientific notation, colon-formatted durations, and negative values should not be used as chart input. Use ordinary digits and the documented separators. Do not mix incompatible units in one chart.

## 6. Styling contract

The slide canvas is fixed at **1600 × 900 pixels**, a 16:9 ratio. The application scales it to the available preview area; it does not reflow, automatically fit text, or paginate overflowing content into additional slides. Keep titles, text, and tables within the canvas, and check every slide after changing typography.

Styles are applied in this order: neutral defaults, `slides.css`, then the application's visibility/printing rules. Presentation CSS belongs to the isolated slide document, not to the editor's document. The separate print document receives the same presentation CSS and local assets. Speaker notes are shown in the tool's dialog, not styled as slides.

Common variables supplied by the neutral defaults:

| Variable | Role |
| --- | --- |
| `--paper`, `--ink` | Slide background and foreground text |
| `--muted`, `--rule`, `--surface` | Secondary text, separator lines, and surfaces |
| `--accent`, `--accent-text`, `--context` | Primary accent, accent text/links, and non-focal bars |
| `--display`, `--body` | Heading and body font-family lists |

These variables are the neutral defaults' contract, not a requirement that every imported deck use them. A branded stylesheet may introduce its own variables and directly set colors or fonts; inspect that stylesheet before assuming a single variable changes every element.

A small presentation stylesheet can be enough:

```css
:root {
  --paper: #ffffff;
  --ink: #18212b;
  --muted: #546170;
  --rule: #d7dfe7;
  --surface: #f3f6f9;
  --accent: #2859a6;
  --accent-text: #214b8b;
  --context: #c4cfde;
  --display: system-ui, sans-serif;
  --body: system-ui, sans-serif;
}

.slide-title {
  font-size: 72px;
  line-height: 1.15;
}

.cover .slide-title {
  font-size: 92px;
}

.chart-row.focal .chart-bar {
  fill: var(--accent);
}

.series-1 {
  fill: var(--accent);
  background-color: var(--accent);
}
```

Useful selectors include:

| Area | Selectors |
| --- | --- |
| Common structure | `.slide`, `.slide-title`, `.slide-top`, `.slide-kicker`, `.brand` |
| Footer and notes | `.slide-footer`, `.slide-source`, `.slide-counter`, `.slide-note` |
| Generic content | `.generic-content` |
| Cover and caveat | `.slide-subtitle`, `.cover-columns`, `.cover-section`, `.caveat-panel` |
| Metric statistic | `.metric-layout`, `.metric-stat` |
| Bars | `.comparison-chart`, `.chart-row`, `.chart-row.focal`, `.chart-label`, `.chart-value`, `.chart-bar`, `.chart-detail` |
| Pie | `.pie-svg`, `.pie-slice`, `.pie-legend`, `.pie-legend-dot`, `.series-1` through `.series-6` |
| Quality table | `.quality-table`, `.quality table`, `.quality th`, `.quality td` |
| Result | `.result-summary`, `.result-stat`, `.stat-label`, `.size-flow`, `.size-step`, `.size-step-label`, `.size-step-value`, `.size-arrow`, `.result-columns`, `.result-section` |

Bars and pie slices are SVG shapes: use `fill`, not just `background-color`, to change their color. Pie legend swatches use `background-color`, so define both on `.series-*` rules. Table alignment from Markdown is represented by `.align-left`, `.align-right`, and `.align-center`, not inline styles.

Avoid overriding the canvas size, `#deck`, slide positioning, hidden-slide behavior, or pagination rules. Do not use inline styles or inject application CSS into a presentation. Put all presentation CSS, including `@font-face`, directly in `slides.css`: external stylesheets and `@import` are blocked.

## 7. Fonts inside the presentation ZIP

Font assets can be packaged inside the presentation ZIP. The asset loader recognizes `.woff2`, `.woff`, `.ttf`, and `.otf` extensions and assigns font MIME types. Actual decoding still depends on the font file and browser. Use valid font files that you are authorized to package and distribute.

Place the files in the ZIP, then reference them from `slides.css` with relative `url(...)` sources:

```css
@font-face {
  font-family: "Deck Text";
  src: url("fonts/deck-regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: "Deck Text";
  src: url("fonts/deck-bold.woff2") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: swap;
}

:root {
  --body: "Deck Text", Arial, sans-serif;
  --display: "Deck Text", Arial, sans-serif;
}

body,
p,
li {
  font-weight: 400;
}

h1,
h2,
h3,
strong,
.chart-value,
.pie-legend-value,
.size-step-value {
  font-weight: 700;
}
```

Use your actual asset names and actual weights. Add separate faces for other weights or italic text as needed. The neutral defaults use a light body weight and heavier heading weights, so align the CSS weights with the faces supplied for the intended appearance.

A `src: local("...")` rule only looks for an installed font; it does not load a matching file from the ZIP automatically. Add or replace it with `url("fonts/...")` for a self-contained presentation. Supplying a file without referencing it is not enough.

During rendering, references to ZIP font files are replaced with embedded `data:font/...;base64,...` URLs containing the actual imported bytes. The same rewritten CSS is applied to the preview and the separate print document, and fonts are loaded in each document's own font set. This avoids requiring the slide iframe to fetch a font through a parent-created Blob URL. Images and media continue to use temporary Blob URLs.

The editor's CSS keeps the original relative paths. Export retains the source CSS and the imported font bytes, without inserting runtime data URLs or Blob URLs into the downloadable source files. Existing authored data URLs are retained. Network font URLs and CSS imports remain blocked.

Font sources can use quoted filenames with spaces, commas, parentheses or Unicode, percent-encoded paths, CSS-escaped filenames and CSS-escaped `url` function names. Always match the real ZIP path and filename case. Missing paths are reported, not guessed. Use `format("woff2")`, `format("woff")`, `format("truetype")` for TTF or `format("opentype")` for OTF; the format hint is optional. `format("ttf")` and `format("otf")` are not the appropriate hints.

Both declaration and selection matter. Set `--body` for default body text and `--display` for default headings, or explicitly target the relevant selectors. Changing only `body { font-family: ... }` does not override an explicit font family on headings. Prefer a ZIP `url(...)` source before any `local(...)` alternative when the bundled font should take precedence.

### Font diagnostics

Expand **Fonts & assets** beneath the editors. It reports font files in the archive, unreferenced font files, missing or blocked CSS paths, local-only declarations, and font decoding status in the preview and print documents. It also shows the requested CSS family lists and weights for the current heading and body text.

**Decoded** confirms that the browser accepted a font face. It is not proof that every character uses that face; CSS selection, weights, styles, Unicode ranges, glyph coverage and fallback still apply. The report deliberately does not present CSS family lists or `document.fonts.check()` as a rendered-font inspection. Use **Copy report** to share the diagnostic text. Keep font sources in `slides.css`; no font registration script is required in a presentation.

The current aside edits only `slides.md` and `slides.css`; it is not a font-file or asset upload manager. To add or replace binary assets, download the presentation ZIP, add the files and update paths using an archive tool or extracted folder, create the ZIP again, then use **Open ZIP** to reload it. Zip the presentation contents, not the tool installation.

CSS `sourceMappingURL` and `sourceURL` debugging comments are omitted only from the runtime stylesheets. Their original text remains in the editor and downloaded ZIP; they do not define font assets.

## 8. Images, links, and isolation

Markdown images, the metadata `logo`, and CSS `url(...)` references can use files in the ZIP. Relative asset references are resolved against the presentation root, including when they occur inside CSS declarations. Missing or unsupported references are reported in Fonts & assets and do not become requests to a remote server. Remote images, remote fonts, external stylesheets, CSS imports, and slide scripts are blocked.

Ordinary HTTP(S) and email links are allowed for user-initiated navigation. That is different from loading remote content as a slide asset. Relative links to extra ZIP documents are not an attachment-download mechanism; the application preserves those documents in the archive but does not expose them through arbitrary Markdown file links.

Prefer Markdown for content. For a custom layout that needs HTML, use sanitized structural elements with classes and define their styles in `slides.css`. Do not rely on event handlers, script execution, inline styles, or unsanitized embedded content. The tool is not a general-purpose HTML application container.

## 9. Import, edit, export, and check

Open the tool, choose **Open ZIP**, and select the presentation ZIP without extracting it for import. Both source editors update the preview automatically. **Download ZIP** writes the current Markdown and CSS plus imported assets. Source text may have browser-normalized line endings and UTF-8 BOMs are not retained; binary assets remain unchanged.

Invalid Markdown can leave the last valid slides visible while the unfinished source remains editable and downloadable. A successful download alone therefore does not prove a presentation is renderable. Check that no preview error is shown, navigate through every slide, and re-import the exported ZIP. Also check the print output separately when printing matters.

Before delivery, confirm that the required filenames and asset paths are correct; every slide has its title; metadata starts with `layout:`; structured layouts have the required paragraphs, headings, and tables; chart number formats match `unit`; every referenced asset exists; text fits; speaker notes stay out of the visible content; and claims, numbers, sources, and labels reflect the supplied material rather than invented content.

A deck-specific style guide complements this technical reference. It can specify colors, typography, tone, and composition, but must not override the implemented ZIP or Markdown syntax. In the separately supplied sample, `style-guide.md` is the original design guide, not this technical format specification.

## 10. Reusable authoring prompt

Attach this file alongside the brief, factual sources, style guide, and available assets. Replace the bracketed fields below before use.

```text
Create a presentation for the local Slides tool using the attached
PRESENTATION_FORMAT.md as the technical format reference.

Topic and objective: [topic and what the audience should understand or decide]
Audience: [audience]
Language: [language]
Length: [slide count or speaking duration]
Source material: [attached sources]
Visual direction: [attached style guide or desired design]
Available assets: [actual supplied image and font filenames, or none]

Deliver slides.md and slides.css at the root of one presentation ZIP, with
all referenced assets alongside them or in subfolders. Do not include the
tool's HTML, JavaScript, or one.css. Do not add a manifest or YAML front matter.

Use one top-level # title per slide and standalone --- slide separators.
Use only the documented per-slide metadata syntax, beginning with layout:.
Choose layouts according to their actual content structure. Use generic or a
custom CSS class layout when the built-in structured layouts do not fit.
Do not put content into positions that those layouts discard.

Put visible qualifications in a short on-slide note where appropriate.
Put detailed speaking material after <!-- notes -->. Keep notes out of the
visible slide content. Make titles concise and keep content inside the
fixed 1600 x 900 canvas; do not rely on automatic text fitting or pagination.

Put all presentation styling in slides.css, with no inline style attributes,
remote dependencies, scripts, or CSS @import. Use correct relative asset paths.
Reference only assets that are actually available. Do not fabricate font or
image files. For bundled fonts, add @font-face rules with matching paths and
weights; use fallback fonts when suitable font assets are unavailable.

For metric and metric-pie slides, choose unit explicitly, use at least two
data rows, and use nonnegative numeric values in the documented format.
For result slides, supply exactly two before/after data rows. Calculate and
check any authored headline statistics; the renderer does not calculate them.

Base factual content on the supplied sources. Preserve relevant limitations,
units, definitions, and attribution. Do not invent evidence, citations, or
results to make a slide more persuasive.

Check the Markdown structure, referenced assets, visual fit, and exported ZIP.
State any checks you could not perform. When file generation is unavailable,
return separate complete code blocks labelled slides.md and slides.css plus
a precise asset list, rather than claiming to have created a ZIP.
```
