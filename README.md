# Tools Dashboard

A collection of lightweight, privacy-focused browser utilities that run entirely
client-side. No data ever leaves your machine — every tool works offline and
requires zero server interaction.

## Features

- **Various standalone tools** spanning data transformation, image manipulation,
  developer diagnostics, creative design, and productivity.
- **Unified design system** — all tools<sup>1</sup> share
  [`one.css`](one_css/index.html), a class-lite semantic stylesheet providing
  consistent theming (including dark mode), typography, layout primitives, and
  iconography across every page.
- **Single-file architecture** — each tool is a (nearly) self-contained `index.html`
  that can be opened directly in a browser.
- **Offline-ready** — everything runs in the browser; no backend needed.

<sup>1</sup> "Recursive Grid JSON Editor" has different requirements, so it uses its own style.

## Getting started

Open `index.html` in any modern browser to reach the dashboard, then click
through to the tool you need. No installation, bundling, or dev server is
required.

## Project structure

```
.
├── index.html          # Dashboard landing page
├── one.css             # Shared design-system stylesheet
├── one_css/            # one.css documentation / demo page
├── <tool>/             # One directory per tool
│   ├── index.html      #   Self-contained tool page
│   └── icon.svg        #   Tool icon used on the dashboard
├── LICENSE             # Apache License 2.0
└── README.md           # This file
```

## License

Licensed under [Apache License, Version 2.0](LICENSE) except for the following:

[Paste To Markdown](paste_to_markdown/index.html) is licensed under MIT (due to it being based on a tool with that license).

### Third-party assets

`turndown-standalone.js` (used in 'Paste To Markdown'), `client-zip.js` (used in multiple tools) and `paper.js` (used only in `shape_builder`) are distributed under the MIT license.

The `material-symbols.woff2` and most of the icons are based on
[Material Symbols](https://github.com/google/material-design-icons) by Google, licensed under the Apache License 2.0.

The Inter font (`Inter-VariableFont_opsz,wght.ttf`) is released under the <a href="https://openfontlicense.org/open-font-license-official-text/">SIL OPEN FONT LICENSE Version 1.1</a>.
