/* Presentation controller. Shared UI and Markdown utilities remain unchanged.
   Application-specific CSS lives in index.html; a deck supplies its own CSS. */
(() => {
    "use strict";
    const $ = (selector, scope = document) => scope.querySelector(selector);
    const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
    const mdInput = $("#markdown-source"), cssInput = $("#css-source");
    const nameInput = $("#presentation-name"), viewport = $("#viewport");
    const STORAGE_KEY = "slides-tool:draft:v1";
    const desktop = matchMedia("(min-width: 900px)");
    const requestedSlide = Number(location.hash.slice(1));
    const starter = {
        name: "presentation",
        markdown: "<!-- layout: generic | section: Your presentation -->\n# Make room for your ideas.\n\nWrite in **slides.md**. Design in **slides.css**.\n\nOpen a presentation ZIP to continue an existing deck, or start editing here.\n\n<!-- notes -->\nSpeaker notes belong after the notes marker. They never appear on the slide.\n",
        css: "/* Presentation-only overrides.\n   The tool supplies neutral defaults for a 1600 × 900 canvas.\n   Add your rules here; the editor interface is kept separate. */\n",
        assets: new Map(),
    };
    let frameDoc, printDoc, slides = [], current = 0, ready = false, busy = false;
    let assets = new Map(), assetUrls = new Map();
    let renderTimer, saveTimer, queuedSnapshot = null, writing = null;
    let revision = 0, savedRevision = 0, exportedRevision = -1, storageFailed = false;
    let lastGoodMarkdown = "", lastGoodCss = "", renderValid = true;
    let dirty = false, importTicket = 0;
    let resolvedStyle = null, fontRevision = 0, fontsReady = Promise.resolve();
    const makeDocument = () => document.implementation.createHTMLDocument("Slides");
    let buildDoc = makeDocument();

    function node(tag, className, text) {
        const result = buildDoc.createElement(tag);
        if (className) result.className = className;
        if (text !== undefined) result.textContent = text;
        return result;
    }

    function svgNode(tag, attributes) {
        const result = buildDoc.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value));
        return result;
    }

    function notice(message, error = false) {
        $("#save-state").textContent = message;
        $("#save-state").dataset.state = error ? "error" : "idle";
    }

    function showError(message) {
        $("#preview-error").textContent = message;
        $("#preview-error").hidden = !message;
    }

    function setBusy(value) {
        busy = value;
        $("#open-zip").disabled = value;
        $("#download-zip").disabled = value;
        $("#new-presentation").disabled = value;
        $("#copy-markdown").disabled = value || !mdInput.value;
        const sidebarOpen = desktop.matches ? !$("#aside-state").checked : $("#aside-state").checked;
        $("#editor").inert = value || !sidebarOpen;
        $("#content").setAttribute("aria-busy", String(value));
    }

    function cleanName(value) {
        return (value || "presentation").replace(/\.zip$/i, "").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-")
            .replace(/^\.+|[. ]+$/g, "").trim().slice(0, 100) || "presentation";
    }

    function setName() {
        const name = cleanName(nameInput.value);
        $("#document-subtitle").textContent = name + ".zip";
        document.title = name + " · Slides";
    }

    function snapshot() {
        return {
            version: 1, name: nameInput.value, markdown: mdInput.value, css: cssInput.value,
            assets: [...assets], current, revision,
        };
    }

    function scheduleSave() {
        notice("Saving draft locally…");
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 350);
    }

    function persist() {
        if (!ready) return Promise.resolve();
        clearTimeout(saveTimer);
        queuedSnapshot = snapshot();
        if (writing) return writing;
        writing = (async () => {
            while (queuedSnapshot) {
                const pending = queuedSnapshot;
                queuedSnapshot = null;
                try {
                    if (typeof one === "undefined" || !one.storage) throw new Error("Local storage is unavailable.");
                    await one.storage.set(STORAGE_KEY, pending);
                    savedRevision = pending.revision;
                    storageFailed = false;
                    if (savedRevision === revision) notice(renderValid ? "Draft saved in this browser." : "Draft saved. Preview shows the last valid slides.");
                } catch (error) {
                    storageFailed = true;
                    notice("Local save unavailable. Download ZIP to keep your edits.", true);
                    console.warn("Draft could not be saved:", error);
                }
            }
        })().finally(() => {
            writing = null;
        });
        return writing;
    }

    function touch() {
        revision++;
        dirty = true;
        scheduleSave();
    }

    const urlsFor = files => presentationAssets.urlsFor(files);
    const resolveAsset = (reference, urls = assetUrls) => presentationAssets.resolve(reference, urls).url;

    function fontRules(sheet) {
        const result = [];

        function visit(rules) {
            for (const rule of rules) {
                if (rule.type === CSSRule.FONT_FACE_RULE) result.push(rule);
                else if (rule.cssRules) visit(rule.cssRules);
            }
        }

        if (sheet) visit(sheet.cssRules);
        return result;
    }

    const fontFamilyName = value => value.trim().replace(/^(["'])(.*)\1$/, "$2");
    const fontKey = face => [fontFamilyName(face.family).toLowerCase(), face.style, face.weight, face.stretch, face.unicodeRange].join("|");
    const fontState = face => face ? ({
        loaded: "decoded",
        error: "failed",
        loading: "loading",
        unloaded: "not loaded",
    })[face.status] : "not active";

    function refreshFontDiagnostics() {
        if (!frameDoc || !printDoc || !resolvedStyle) return;
        const panel = $("#font-diagnostics");
        const paths = [...assets.keys()].filter(presentationAssets.isFont);
        const usedPaths = new Set(resolvedStyle.references.filter(ref => ref.kind === "asset").map(ref => ref.path));
        const unreferenced = paths.filter(path => !usedPaths.has(path));
        const missing = [...new Set(resolvedStyle.references.filter(ref => ref.kind === "missing" || ref.kind === "blocked").map(ref => ref.source))];
        const rules = fontRules($("#slide-custom", frameDoc).sheet);
        const localOnly = rules.filter(rule => !/url\(/i.test(rule.style.getPropertyValue("src")) && /local\(/i.test(rule.style.getPropertyValue("src")));
        const previews = new Map([...frameDoc.fonts].map(face => [fontKey(face), face]));
        const printed = new Map([...printDoc.fonts].map(face => [fontKey(face), face]));
        const keys = new Set([...previews.keys(), ...printed.keys()]);
        let failed = 0, decoded = 0, loading = 0;
        const faceLines = [];
        for (const key of keys) {
            const previewFace = previews.get(key), printFace = printed.get(key),
                face = previewFace || printFace;
            const faces = [previewFace, printFace].filter(Boolean);
            if (faces.some(item => item.status === "error")) failed++;
            else if (faces.every(item => item.status === "loaded")) decoded++;
            else loading++;
            faceLines.push(`${fontFamilyName(face.family)} · ${face.style} · weight ${face.weight} — preview: ${fontState(previewFace)}; print: ${fontState(printFace)}.`);
        }
        const problems = failed + missing.length + unreferenced.length + localOnly.length;
        panel.hidden = !(paths.length || rules.length || missing.length || keys.size);
        panel.dataset.state = problems ? "error" : loading ? "loading" : "ready";
        $("#font-summary").textContent = `Fonts & assets: ${decoded} decoded` +
            (loading ? `, ${loading} loading` : "") + (failed ? `, ${failed} failed` : "") +
            (unreferenced.length ? `; ${unreferenced.length} unreferenced font file(s)` : "") +
            (localOnly.length ? `; ${localOnly.length} local-only face(s)` : "") +
            (missing.length ? `; ${missing.length} unresolved URL(s)` : "");
        const lines = ["Presentation font report", "Loader: embedded font data; image/media Blob URLs.", ""];
        if (paths.length) {
            lines.push("FONT FILES IN ZIP");
            for (const path of paths) lines.push(`${path} — ${usedPaths.has(path) ? "referenced by CSS" : "NOT REFERENCED by CSS"}`);
            lines.push("");
        }
        if (missing.length) {
            lines.push("MISSING OR BLOCKED CSS URLS");
            lines.push(...missing.map(path => path + " — check its exact path and filename case inside the ZIP."));
            lines.push("");
        }
        if (localOnly.length) {
            lines.push("LOCAL-ONLY SOURCES");
            for (const rule of localOnly) lines.push(`${rule.style.getPropertyValue("font-family")} (${rule.style.getPropertyValue("font-weight") || "400"}): ${rule.style.getPropertyValue("src")}`);
            lines.push("local(...) searches installed fonts, not the ZIP. Add a matching relative url(...) source.", "");
        }
        lines.push("BROWSER FONT DECODING", ...(faceLines.length ? faceLines : ["No active @font-face declarations."]), "");
        if (failed) lines.push("A face failed to load/decode. Check its source, format() hint, and whether the font file is valid.", "");
        if (unreferenced.length) lines.push("Add @font-face rules referencing the unreferenced files. Merely including a font in the ZIP does not register it.", "");
        const active = slides[current]?.node;
        const heading = active?.querySelector(".slide-title"),
            body = active?.querySelector("p") || active;
        lines.push("CURRENT SLIDE CSS SELECTION");
        for (const [label, element] of [["Heading", heading], ["Body text", body]]) {
            if (!element) continue;
            const computed = frameDoc.defaultView.getComputedStyle(element);
            lines.push(`${label}: ${computed.fontFamily}; weight ${computed.fontWeight}; style ${computed.fontStyle}.`);
        }
        lines.push("", "Decoded means the browser accepted the face, not proof that every glyph uses it. The CSS family lists above are requested families, not a rendered-font inspection.",
            "Set --display for the default headings and --body for the default body text, or target the relevant selectors. An explicit heading family does not inherit a body-only font change.");
        $("#font-report").textContent = lines.join("\n");
    }

    function applySlideCss(css) {
        if (resolvedStyle?.source === css && resolvedStyle.urls === assetUrls) return;
        resolvedStyle = {
            ...presentationAssets.rewriteCss(css, assetUrls),
            source: css,
            urls: assetUrls,
        };
        for (const doc of [frameDoc, printDoc]) {
            const style = $("#slide-custom", doc);
            if (style.textContent !== resolvedStyle.css) style.textContent = resolvedStyle.css;
        }
        const version = ++fontRevision;
        // Load in each document's own FontFaceSet, not the editor's. A successful
        // decode is reported separately from CSS selection; check() is not proof
        // that a requested font is present or actually drawing text.
        fontsReady = Promise.resolve().then(async () => {
            if (version !== fontRevision) return;
            const faces = [frameDoc, printDoc].flatMap(doc => [...doc.fonts]);
            await Promise.allSettled(faces.map(face => face.load()));
            if (version === fontRevision) refreshFontDiagnostics();
        });
        refreshFontDiagnostics();
    }

    function sanitizedRoot(markdown, prefix, urls) {
        const root = node("div");
        // The renderer runs in an inert document: images cannot issue requests
        // before their URLs have been resolved or removed.
        root.innerHTML = window.parseMarkdownToHTML(markdown, { headingIdPrefix: prefix });
        for (const el of $$("*", root)) {
            for (const attr of [...el.attributes]) {
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            }
            if (el.hasAttribute("style")) {
                const align = el.getAttribute("style").match(/^\s*text-align:\s*(left|right|center);?\s*$/i);
                if (align) el.classList.add("align-" + align[1].toLowerCase());
                el.removeAttribute("style");
            }
            el.removeAttribute("srcset");
            if (el.hasAttribute("src")) {
                const resolved = resolveAsset(el.getAttribute("src"), urls);
                if (resolved) el.setAttribute("src", resolved);
                else {
                    el.removeAttribute("src");
                    el.setAttribute("data-missing-asset", "true");
                }
            }
            if (el.tagName === "A") {
                const href = el.getAttribute("href") || "";
                if (/^(https?:|mailto:)/i.test(href)) {
                    el.setAttribute("target", "_blank");
                    el.setAttribute("rel", "noopener noreferrer");
                } else if (!href.startsWith("#")) el.removeAttribute("href");
            }
        }
        return root;
    }

    function splitSlides(markdown) {
        const parts = [], lines = [];
        let fence = null;
        for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
            const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
            if (match) {
                if (!fence) fence = match[1];
                else if (match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(match[2])) fence = null;
            }
            if (!fence && /^\s*---\s*$/.test(line)) {
                if (lines.join("\n").trim()) parts.push(lines.join("\n").trim());
                lines.length = 0;
            } else lines.push(line);
        }
        if (lines.join("\n").trim()) parts.push(lines.join("\n").trim());
        return parts;
    }

    function parseSlide(raw) {
        const meta = { layout: "generic", section: "" };
        const match = raw.match(/^\s*<!--\s*(layout:[\s\S]*?)-->/);
        if (match) {
            const keys = new Set(["layout", "section", "footer", "unit", "lang", "logo", "logo-alt", "stat-label"]);
            for (const entry of match[1].split("|")) {
                const colon = entry.indexOf(":");
                const key = entry.slice(0, colon).trim();
                if (colon > 0 && keys.has(key)) meta[key] = entry.slice(colon + 1).trim();
            }
            if (!/^[a-z][a-z0-9_-]*$/i.test(meta.layout)) throw new Error("Use a simple class name for the slide layout.");
            raw = raw.slice(match[0].length);
        }
        // A notes marker inside a fenced code example is literal text.
        let fence = null, position = 0, notesAt = -1;
        for (const line of raw.split("\n")) {
            const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
            if (match) {
                if (!fence) fence = match[1];
                else if (match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(match[2])) fence = null;
            }
            if (!fence && /^\s*<!--\s*notes\s*-->\s*$/.test(line)) {
                notesAt = position;
                break;
            }
            position += line.length + 1;
        }
        const body = (notesAt < 0 ? raw : raw.slice(0, notesAt)).trim();
        const notes = notesAt < 0 ? "" : raw.slice(raw.indexOf("\n", notesAt) < 0 ? raw.length : raw.indexOf("\n", notesAt) + 1).trim();
        return { meta, body, notes };
    }

    function take(root, selector) {
        const found = $(selector, root);
        if (found) found.remove();
        return found;
    }

    function groups(root, className) {
        const result = [];
        let group;
        for (const child of [...root.children]) {
            if (child.tagName === "H3" || !group) {
                group = node("section", className);
                result.push(group);
            }
            group.append(child);
        }
        return result;
    }

    function numeric(text, unit = "number") {
        if (typeof text !== "string") throw new Error("A chart needs labels in column 1 and values in column 2.");
        if (unit === "duration") {
            const minutes = text.match(/(\d+)\s*min/), seconds = text.match(/(\d+)\s*s\b/);
            if (!minutes && !seconds) throw new Error("Format a duration like \"4 min 03 s\".");
            return Number(minutes?.[1] || 0) * 60 + Number(seconds?.[1] || 0);
        }
        const normalized = text.replace(/[^0-9,.\-]/g, "");
        if (!/[0-9]/.test(normalized)) throw new Error("Invalid chart value: " + text);
        const value = Number(unit === "decimal" ? normalized.replace(/,/g, "") : normalized.replace(/\./g, "").replace(",", "."));
        if (!Number.isFinite(value) || value < 0) throw new Error("Invalid chart value: " + text);
        return value;
    }

    function rowsOf(table) {
        if (!table) throw new Error("This layout needs a Markdown table.");
        const rows = $$("tbody tr", table).map(row => [...row.cells].map(cell => cell.textContent.trim()));
        if (rows.length < 2) throw new Error("This layout needs at least two table rows.");
        return rows;
    }

    function barChart(table, unit) {
        const rows = rowsOf(table), values = rows.map(row => numeric(row[1], unit));
        const maximum = Math.max(...values, 1);
        const chart = node("figure", "comparison-chart");
        chart.setAttribute("aria-label", rows.map(row => row.join(": ")).join("; "));
        chart.append(node("figcaption", "sr-only", "Comparison. Each bar starts at zero."));
        rows.forEach((row, index) => {
            const container = node("div", "chart-row" + (index === 0 ? " focal" : ""));
            const labels = node("div", "chart-label-line");
            labels.append(node("span", "chart-label", row[0]), node("span", "chart-value", row[1]));
            const track = node("div", "chart-bar-container");
            const svg = svgNode("svg", {
                class: "chart-track",
                viewBox: "0 0 1000 61",
                preserveAspectRatio: "none",
                "aria-hidden": "true",
            });
            svg.append(svgNode("rect", {
                class: "chart-bar",
                x: 0,
                y: 0,
                width: values[index] / maximum * 1000,
                height: 61,
                rx: 8,
            }));
            track.append(svg);
            container.append(labels, track);
            if (row[2]) container.append(node("div", "chart-detail", row[2]));
            chart.append(container);
        });
        return chart;
    }

    function pieChart(table, unit) {
        const rows = rowsOf(table), values = rows.map(row => numeric(row[1], unit));
        const total = values.reduce((sum, value) => sum + value, 0);
        if (total <= 0) throw new Error("Pie chart values must add up to more than zero.");
        const figure = node("figure", "pie-chart-figure");
        figure.setAttribute("aria-label", rows.map((row, i) => `${row[0]}: ${row[1]} (${Math.round(values[i] / total * 100)}%)`).join("; "));
        const container = node("div", "pie-chart-container");
        const svg = svgNode("svg", {
            class: "pie-svg",
            viewBox: "-105 -105 210 210",
            "aria-hidden": "true",
        });
        let angle = -Math.PI / 2;
        values.forEach((value, index) => {
            const arc = value / total * Math.PI * 2;
            const className = "pie-slice series-" + (index % 6 + 1);
            if (arc >= 2 * Math.PI - 0.000001) svg.append(svgNode("circle", {
                class: className,
                cx: 0,
                cy: 0,
                r: 100,
            }));
            else if (arc > 0) {
                const end = angle + arc;
                svg.append(svgNode("path", {
                    class: className,
                    d: `M 0 0 L ${100 * Math.cos(angle)} ${100 * Math.sin(angle)} A 100 100 0 ${arc > Math.PI ? 1 : 0} 1 ${100 * Math.cos(end)} ${100 * Math.sin(end)} Z`,
                }));
            }
            angle += arc;
        });
        const legend = node("div", "pie-legend");
        rows.forEach((row, index) => {
            const item = node("div", "pie-legend-item"), header = node("div", "pie-legend-header");
            const labels = node("div", "pie-legend-label-wrap");
            const dot = node("span", "pie-legend-dot series-" + (index % 6 + 1));
            dot.setAttribute("aria-hidden", "true");
            labels.append(dot, node("span", "pie-legend-label", row[0]));
            const value = node("div", "pie-legend-value-wrap"),
                percentage = values[index] / total * 100;
            value.append(node("span", "pie-legend-value", row[1]), node("span", "pie-legend-percent", percentage > 0 && percentage < 1 ? "(< 1 %)" : `(${Math.round(percentage)} %)`));
            header.append(labels, value);
            item.append(header);
            if (row[2]) item.append(node("div", "pie-legend-detail", row[2]));
            legend.append(item);
        });
        container.append(svg, legend);
        figure.append(container);
        return figure;
    }

    function sizeFlow(table) {
        const flow = node("div", "size-flow");
        rowsOf(table).slice(0, 2).forEach((row, index) => {
            if (index) {
                const arrow = node("span", "size-arrow", "→");
                arrow.setAttribute("aria-hidden", "true");
                flow.append(arrow);
            }
            const block = node("div", "size-step"), match = row[1].match(/^([\d.,]+)\s*(.*)$/);
            const value = node("div", "size-step-value", match ? match[1] : row[1]);
            if (match?.[2]) value.append(node("small", "", match[2]));
            block.append(node("div", "size-step-label", row[0]), value);
            flow.append(block);
        });
        return flow;
    }

    function buildSlide(data, index, total, urls) {
        const { meta } = data;
        const root = sanitizedRoot(data.body, `s${index + 1}-`, urls);
        const title = take(root, ":scope > h1");
        if (!title) throw new Error(`Slide ${index + 1} needs a title beginning with #.`);
        title.classList.add("slide-title");
        const titleClone = title.cloneNode(true);
        $$("br", titleClone).forEach(br => br.replaceWith(" "));
        const titleText = titleClone.textContent.replace(/\s+/g, " ").trim();
        const slide = node("section", "slide " + meta.layout);
        slide.id = "slide-" + (index + 1);
        slide.hidden = true;
        slide.setAttribute("role", "group");
        slide.setAttribute("aria-roledescription", "slide");
        slide.setAttribute("aria-label", `${index + 1} / ${total}: ${titleText}`);
        if (meta.lang) slide.lang = meta.lang;
        const top = node("header", "slide-top");
        top.append(node("div", "slide-kicker", meta.section));
        if (meta.logo) {
            const url = resolveAsset(meta.logo, urls);
            if (url) {
                const image = node("img", "brand");
                image.src = url;
                image.alt = meta["logo-alt"] || "";
                image.width = 166;
                image.height = 54;
                top.append(image);
            }
        }
        slide.append(top, title);
        const note = take(root, ":scope > .note");
        if (note) note.classList.add("slide-note");
        const subtitle = () => {
            const p = take(root, ":scope > p");
            if (p) {
                p.classList.add("slide-subtitle");
                slide.append(p);
            }
        };
        if (meta.layout === "cover") {
            subtitle();
            const columns = node("div", "cover-columns");
            columns.append(...groups(root, "cover-section"));
            slide.append(columns);
        } else if (meta.layout === "caveat") {
            const panel = node("div", "caveat-panel");
            panel.append(...root.children);
            slide.append(panel);
        } else if (meta.layout === "metric" || meta.layout === "metric-pie") {
            const layout = node("div", "metric-layout"), stat = node("div", "metric-stat");
            const heading = take(root, ":scope > h2"), p = take(root, ":scope > p");
            if (heading) stat.append(heading);
            if (p) stat.append(p);
            const table = $("table", root);
            layout.append(stat, meta.layout === "metric-pie" ? pieChart(table, meta.unit) : barChart(table, meta.unit));
            slide.append(layout);
        } else if (meta.layout === "quality") {
            subtitle();
            const table = take(root, ".table-container") || take(root, "table");
            if (!table) throw new Error(`Slide ${index + 1}: the quality layout needs a table.`);
            table.classList.add("quality-table");
            $$("thead th", table).forEach(cell => cell.setAttribute("scope", "col"));
            slide.append(table);
        } else if (meta.layout === "result") {
            subtitle();
            const summary = node("div", "result-summary"), stat = node("div", "result-stat");
            const heading = take(root, ":scope > h2");
            if (heading) stat.append(heading);
            if (meta["stat-label"]) stat.append(node("div", "stat-label", meta["stat-label"]));
            summary.append(stat, sizeFlow($("table", root)));
            take(root, ".table-container") || take(root, "table");
            slide.append(summary);
            const columns = node("div", "result-columns");
            columns.append(...groups(root, "result-section"));
            slide.append(columns);
        } else {
            const body = node("div", "generic-content");
            body.append(...root.children);
            slide.append(body);
        }
        if (note) slide.append(note);
        const footer = node("footer", "slide-footer");
        footer.append(node("span", "slide-source", meta.footer || ""), node("span", "slide-counter", `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`));
        slide.append(footer);
        const notes = sanitizedRoot(data.notes || "No speaker notes for this slide.", `notes-${index + 1}-`, urls);
        return {
            node: slide,
            title: titleText,
            section: meta.section,
            notes,
            lang: meta.lang || "en",
        };
    }

    function build(markdown, urls = assetUrls) {
        if (new Blob([markdown]).size > presentationZip.limits.entry) throw new Error("Markdown is larger than 16 MiB.");
        const parts = splitSlides(markdown);
        if (!parts.length) throw new Error("Add a slide beginning with # to preview your presentation.");
        if (parts.length > 250) throw new Error("A presentation can contain at most 250 slides.");
        buildDoc = makeDocument();
        return parts.map((raw, i) => buildSlide(parseSlide(raw), i, parts.length, urls));
    }

    function commit(next, markdown, css, index = current) {
        // Build first and commit only after validation. A broken edit never
        // replaces the last working presentation.
        slides = next;
        applySlideCss(css);
        $("#deck", frameDoc).replaceChildren(...slides.map(slide => slide.node));
        $("#deck", printDoc).replaceChildren(...slides.map(slide => {
            const clone = slide.node.cloneNode(true);
            clone.hidden = false;
            clone.removeAttribute("aria-hidden");
            return clone;
        }));
        frameDoc.documentElement.lang = slides[0].lang;
        printDoc.documentElement.lang = slides[0].lang;
        $("#overview-list").replaceChildren(...slides.map((slide, i) => {
            const button = document.createElement("button");
            button.type = "button";
            const label = document.createElement("small");
            label.textContent = `${i + 1} · ${slide.section || "Slide"}`;
            button.append(label, document.createTextNode(slide.title));
            button.addEventListener("click", () => {
                $("#overview-dialog").close();
                go(i);
            });
            return button;
        }));
        $("#preview-runtime").sheet.cssRules[1].style.setProperty("height", `${slides.length * 900}px`);
        lastGoodMarkdown = markdown;
        lastGoodCss = css;
        renderValid = true;
        showError("");
        go(Math.max(0, Math.min(index, slides.length - 1)), false);
        resize();
    }

    function updatePreview() {
        if (!ready) return false;
        clearTimeout(renderTimer);
        try {
            if (new Blob([cssInput.value]).size > presentationZip.limits.entry) throw new Error("CSS is larger than 16 MiB.");
            if (mdInput.value === lastGoodMarkdown && slides.length) {
                applySlideCss(cssInput.value);
                lastGoodCss = cssInput.value;
                renderValid = true;
                showError("");
            } else commit(build(mdInput.value), mdInput.value, cssInput.value);
            return true;
        } catch (error) {
            renderValid = false;
            showError(error.message + " The last valid preview is kept; both source files remain editable and exportable.");
            return false;
        }
    }

    function schedulePreview() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(updatePreview, 220);
    }

    function go(index, savePosition = true) {
        if (!slides.length) return;
        current = Math.max(0, Math.min(index, slides.length - 1));
        slides.forEach((slide, i) => {
            slide.node.hidden = i !== current;
            slide.node.setAttribute("aria-hidden", String(i !== current));
        });
        $("#prev").disabled = current === 0;
        $("#next").disabled = current === slides.length - 1;
        $("#position").textContent = `${current + 1} / ${slides.length}`;
        $("#slide-progress").max = slides.length;
        $("#slide-progress").value = current + 1;
        $("#preview-caption").textContent = `${current + 1}. ${slides[current].title}`;
        $("#slide-frame").title = `Slide ${current + 1} of ${slides.length}: ${slides[current].title}`;
        $("#notes-title").textContent = `Notes · Slide ${current + 1}`;
        $("#notes-content").replaceChildren(...[...slides[current].notes.childNodes].map(child => child.cloneNode(true)));
        $("#notes-content").lang = slides[current].lang;
        refreshFontDiagnostics();
        $$("#overview-list button").forEach((button, i) => button.setAttribute("aria-current", String(i === current)));
        try {
            history.replaceState(null, "", "#" + (current + 1));
        } catch { /* file URLs can restrict history. */
        }
        if (savePosition && ready) {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(persist, 350);
        }
    }

    function resize() {
        const rect = viewport.getBoundingClientRect(), pad = document.fullscreenElement ? 0 : 24;
        const scale = Math.max(0.01, Math.min((rect.width - pad) / 1600, (rect.height - pad) / 900));
        $("#preview-runtime").sheet.cssRules[0].style.setProperty("--preview-scale", String(scale));
    }

    function assetSummary() {
        $("#asset-summary").textContent = "ZIP: slides.md + slides.css" + (assets.size ? ` + ${assets.size} additional file${assets.size === 1 ? "" : "s"}` : "");
    }

    async function confirmReplace() {
        if (!dirty) return true;
        const dialog = $("#replace-dialog");
        if (dialog.open) return false;
        return new Promise(resolve => {
            const events = new AbortController();
            dialog.returnValue = "cancel";
            $("#cancel-replace").addEventListener("click", () => dialog.close("cancel"), { signal: events.signal });
            $("#confirm-replace").addEventListener("click", () => dialog.close("replace"), { signal: events.signal });
            dialog.addEventListener("close", () => {
                events.abort();
                resolve(dialog.returnValue === "replace");
            }, { signal: events.signal });
            dialog.showModal();
        });
    }

    async function install(presentation, index = 0) {
        const nextUrls = urlsFor(presentation.assets);
        let next;
        try {
            next = build(presentation.markdown, nextUrls);
        } catch (error) {
            presentationAssets.releaseUrls(nextUrls);
            throw error;
        }
        const previousUrls = assetUrls;
        assetUrls = nextUrls;
        assets = presentation.assets;
        mdInput.value = presentation.markdown;
        cssInput.value = presentation.css;
        $("#copy-markdown").disabled = busy || !mdInput.value;
        nameInput.value = cleanName(presentation.name);
        commit(next, presentation.markdown, presentation.css, index);
        setName();
        assetSummary();
        // All new nodes and their CSS now refer to the new set of URLs.
        presentationAssets.releaseUrls(previousUrls);
    }

    async function openZip(file) {
        if (!file || !ready || busy) return;
        const ticket = ++importTicket;
        if (!await confirmReplace()) {
            $("#zip-input").value = "";
            return;
        }
        setBusy(true);
        notice("Opening presentation ZIP…");
        clearTimeout(renderTimer);
        stopConfetti();
        try {
            const presentation = await presentationZip.read(file);
            if (ticket !== importTicket) return;
            presentation.name = cleanName(file.name);
            await install(presentation);
            revision++;
            exportedRevision = revision;
            dirty = false;
            await persist();
            notice(storageFailed ? "ZIP opened. Local save unavailable; keep the ZIP as your backup." : "ZIP opened. Draft saved in this browser.", storageFailed);
            if (!desktop.matches) {
                $("#aside-state").checked = false;
                syncAside();
            }
        } catch (error) {
            showError("Could not open ZIP: " + error.message + " Your current presentation was not replaced.");
            notice("ZIP import failed.", true);
        } finally {
            setBusy(false);
            $("#zip-input").value = "";
        }
    }

    async function downloadPresentation() {
        if (!ready || busy) return;
        setBusy(true);
        const exported = snapshot();
        const mdBytes = new TextEncoder().encode(exported.markdown),
            cssBytes = new TextEncoder().encode(exported.css);
        try {
            const limits = presentationZip.limits;
            const allSizes = [mdBytes.length, cssBytes.length, ...exported.assets.map(([, bytes]) => bytes.byteLength)];
            if (allSizes.some(size => size > limits.entry) || allSizes.reduce((sum, size) => sum + size, 0) > limits.total || allSizes.length > limits.entries) {
                throw new Error("The presentation exceeds the supported ZIP import limits. Reduce its size before exporting.");
            }
            const entries = [{ name: "slides.md", content: mdBytes }, {
                name: "slides.css",
                content: cssBytes,
            },
                ...exported.assets.map(([name, bytes]) => ({ name, content: bytes }))];
            const blob = await one.zip.create(entries, { compression: "store" });
            if (blob.size > limits.archive) throw new Error("The downloadable ZIP would exceed 32 MiB. Reduce the assets to keep it importable.");
            const url = URL.createObjectURL(blob), anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = cleanName(exported.name) + ".zip";
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            exportedRevision = exported.revision;
            if (revision === exportedRevision) dirty = false;
            notice("ZIP downloaded with Markdown, CSS and all assets.");
            persist();
        } catch (error) {
            showError("Could not download ZIP: " + error.message);
            notice("ZIP download failed.", true);
        } finally {
            setBusy(false);
        }
    }

    function syncAside() {
        const open = desktop.matches ? !$("#aside-state").checked : $("#aside-state").checked;
        $("#aside-state").setAttribute("aria-expanded", String(open));
        $("#editor").inert = !open || busy;
        resize();
    }

    function toggleAside(forceOpen = false) {
        const control = $("#aside-state");
        if (forceOpen) control.checked = !desktop.matches;
        else control.checked = !control.checked;
        syncAside();
        if (forceOpen) mdInput.focus();
    }

    async function exitFullscreen() {
        if (document.fullscreenElement) {
            try {
                await document.exitFullscreen();
            } catch { /* Exit can be denied. */
            }
        }
    }

    async function openDialog(id) {
        await exitFullscreen();
        const dialog = $("#" + id);
        if (dialog.open) dialog.close(); else dialog.showModal();
    }

    async function fullscreen() {
        if (document.fullscreenElement) await exitFullscreen();
        else {
            try {
                await viewport.requestFullscreen();
                frameDoc.body.focus();
            } catch {
                notice("Full screen is unavailable. Collapse the editors for a larger preview.", true);
            }
        }
    }

    function insertText(input, value, start = input.selectionStart, end = input.selectionEnd) {
        input.focus();
        input.setSelectionRange(start, end);
        let inserted = false;
        try {
            inserted = document.execCommand("insertText", false, value);
        } catch { /* Fallback below. */
        }
        if (!inserted) {
            input.setRangeText(value, start, end, "end");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    let confettiColors = [];
    let confettiCanvas = null;
    let confettiCtx = null;
    let confettiParticles = [];
    let confettiAnimationId = null;
    let lastConfettiTime = 0;

    function createConfettiStream(originX, originY, minAngle, maxAngle, speedBase, count) {
        const list = [];
        for (let i = 0; i < count; i++) {
            const angle = (minAngle + Math.random() * (maxAngle - minAngle)) * (Math.PI / 180);
            const speed = speedBase * (0.68 + Math.random() * 0.55);
            list.push({
                x: originX,
                y: originY,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                w: 9 + Math.random() * 6,
                h: 5 + Math.random() * 5,
                color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
                rotation: Math.random() * Math.PI * 2,
                rotationSpeed: (Math.random() - 0.5) * 0.22,
                wobble: Math.random() * Math.PI * 2,
                wobbleSpeed: 0.08 + Math.random() * 0.1,
                drag: 0.982 + Math.random() * 0.005,
                gravity: 0.3 + Math.random() * 0.1,
                isCircle: Math.random() > 0.65,
            });
        }
        return list;
    }

    function renderConfettiFrame(now) {
        const dpr = window.devicePixelRatio || 1;
        const step = lastConfettiTime ? Math.min(Math.max((now - lastConfettiTime) / (1000 / 60), 0.1), 3) : 1;
        lastConfettiTime = now;

        confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
        confettiCtx.save();
        confettiCtx.scale(dpr, dpr);

        const floorY = confettiCanvas.height / dpr + 30;
        const remaining = [];

        for (const p of confettiParticles) {
            const dragFactor = Math.pow(p.drag, step);
            p.vx *= dragFactor;
            p.vy = p.vy * dragFactor + p.gravity * step;
            p.x += p.vx * step;
            p.y += p.vy * step;
            p.rotation += p.rotationSpeed * step;
            p.wobble += p.wobbleSpeed * step;

            if (p.y > floorY) continue;
            remaining.push(p);

            confettiCtx.save();
            confettiCtx.translate(p.x, p.y);
            confettiCtx.rotate(p.rotation);
            confettiCtx.scale(Math.cos(p.wobble), 1);
            confettiCtx.fillStyle = p.color;

            if (p.isCircle) {
                confettiCtx.beginPath();
                confettiCtx.arc(0, 0, p.w * 0.45, 0, Math.PI * 2);
                confettiCtx.fill();
            } else {
                confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            }

            confettiCtx.restore();
        }

        confettiCtx.restore();
        confettiParticles = remaining;

        if (confettiParticles.length > 0) {
            confettiAnimationId = requestAnimationFrame(renderConfettiFrame);
            return;
        }

        confettiAnimationId = null;
        lastConfettiTime = 0;
        confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }

    function launchConfetti() {
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        // Sample the presentation's optional series classes rather than hardcoding
        // a deck's color palette into the application.
        confettiColors = [];
        for (let index = 1; index <= 6; index++) {
            const swatch = frameDoc.createElement("span");
            swatch.className = "series-" + index;
            frameDoc.body.append(swatch);
            confettiColors.push(frameDoc.defaultView.getComputedStyle(swatch).backgroundColor);
            swatch.remove();
        }
        if (!confettiCanvas) {
            confettiCanvas = document.createElement("canvas");
            confettiCanvas.className = "confetti-canvas";
            confettiCanvas.setAttribute("aria-hidden", "true");
            viewport.append(confettiCanvas);
            confettiCtx = confettiCanvas.getContext("2d");
        }

        const rect = viewport.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetWidth = Math.round(rect.width * dpr);
        const targetHeight = Math.round(rect.height * dpr);

        if (confettiCanvas.width !== targetWidth || confettiCanvas.height !== targetHeight) {
            confettiCanvas.width = targetWidth;
            confettiCanvas.height = targetHeight;
        }

        const speedBase = Math.sqrt(rect.height) * 1.15;
        const count = Math.min(85, Math.max(55, Math.round(rect.width / 24)));

        const leftStream = createConfettiStream(0, rect.height, -75, -38, speedBase, count);
        const rightStream = createConfettiStream(rect.width, rect.height, -142, -105, speedBase, count);

        confettiParticles = [...confettiParticles, ...leftStream, ...rightStream].slice(-500);

        if (!confettiAnimationId) {
            lastConfettiTime = 0;
            confettiAnimationId = requestAnimationFrame(renderConfettiFrame);
        }
    }

    function stopConfetti() {
        if (confettiAnimationId) cancelAnimationFrame(confettiAnimationId);
        confettiAnimationId = null;
        confettiParticles = [];
        lastConfettiTime = 0;
        if (confettiCtx) confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }

    function keydown(event) {
        if (!ready || busy || event.defaultPrevented) return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === "p") {
            event.preventDefault();
            printPresentation();
            return;
        }
        if (event.key === "Escape") {
            setTimeout(syncAside, 0);
        }
        if (command && event.key.toLowerCase() === "s") {
            event.preventDefault();
            downloadPresentation();
            return;
        }
        if (command || event.altKey) return;
        const tag = event.target?.tagName || "";
        if (/^(TEXTAREA|INPUT|SELECT)$/.test(tag) || event.target?.isContentEditable) return;
        if ($("dialog[open]")) {
            if (event.key.toLowerCase() === "n" && $("#notes-dialog").open) {
                event.preventDefault();
                $("#notes-dialog").close();
            }
            return;
        }
        if ([" ", "Enter"].includes(event.key) && event.target.closest?.("button, a")) return;
        const actions = {
            ArrowRight: () => go(current + 1),
            ArrowDown: () => go(current + 1),
            PageDown: () => go(current + 1),
            " ": () => go(current + 1),
            ArrowLeft: () => go(current - 1),
            ArrowUp: () => go(current - 1),
            PageUp: () => go(current - 1),
            Home: () => go(0),
            End: () => go(slides.length - 1),
            k: () => {
                if (!event.repeat) launchConfetti();
            },
            f: fullscreen,
            o: () => openDialog("overview-dialog"),
            n: () => openDialog("notes-dialog"),
            e: async () => {
                await exitFullscreen();
                toggleAside(true);
            },
            "?": () => openDialog("help-dialog"),
        };
        const action = actions[event.key] || actions[event.key.toLowerCase()];
        if (action) {
            event.preventDefault();
            action();
        } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= slides.length) {
            event.preventDefault();
            go(Number(event.key) - 1);
        }
    }

    function dragOver(event) {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        $("#content").dataset.dragging = "true";
    }

    function dropFiles(event) {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        $("#content").removeAttribute("data-dragging");
        if (event.dataTransfer.files.length !== 1) {
            showError("Drop one presentation ZIP at a time.");
            return;
        }
        openZip(event.dataTransfer.files[0]);
    }

    function frameInteractions(doc) {
        doc.addEventListener("dragover", dragOver);
        doc.addEventListener("drop", dropFiles);
        doc.addEventListener("dragend", () => $("#content").removeAttribute("data-dragging"));
        doc.addEventListener("keydown", keydown);
        doc.addEventListener("click", event => {
            const anchor = event.target.closest?.("a");
            if (!anchor) return;
            event.preventDefault();
            const href = anchor.getAttribute("href") || "";
            if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
            else if (href.startsWith("#")) {
                const target = doc.getElementById(href.slice(1));
                const index = slides.findIndex(slide => slide.node === target?.closest(".slide"));
                if (index >= 0) go(index);
            }
        });
        let touch;
        doc.addEventListener("touchstart", event => {
            touch = event.touches.length === 1 ? {
                x: event.touches[0].clientX,
                y: event.touches[0].clientY,
            } : null;
        }, { passive: true });
        doc.addEventListener("touchend", event => {
            if (!touch || !event.changedTouches.length) return;
            const dx = event.changedTouches[0].clientX - touch.x,
                dy = event.changedTouches[0].clientY - touch.y;
            if (Math.abs(dx) > 55 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(current + (dx < 0 ? 1 : -1));
            touch = null;
        }, { passive: true });
    }

    async function setupFrame(frame, printing = false) {
        const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
        frame.srcdoc = "<!doctype html><html lang=\"en\"><head>" + $("#slide-document").innerHTML + "</head><body tabindex=\"-1\"><main id=\"deck\" aria-label=\"Presentation\"></main></body></html>";
        await loaded;
        const doc = frame.contentDocument;
        if (!doc) throw new Error("The slide preview could not be initialized.");
        doc.fonts.addEventListener("loadingdone", refreshFontDiagnostics);
        doc.fonts.addEventListener("loadingerror", refreshFontDiagnostics);
        if (printing) doc.documentElement.dataset.print = "true";
        else frameInteractions(doc);
        return doc;
    }

    async function printPresentation() {
        if (!ready) return;
        updatePreview();
        await exitFullscreen();
        // Printing an isolated document avoids carrying editor styles into print.
        await fontsReady;
        await printDoc.fonts.ready;
        await Promise.all($$("img", printDoc).map(image => image.decode?.().catch(() => {
        }) || Promise.resolve()));
        $("#print-frame").contentWindow.focus();
        $("#print-frame").contentWindow.print();
    }

    mdInput.addEventListener("input", () => {
        $("#copy-markdown").disabled = !mdInput.value;
        touch();
        schedulePreview();
    });
    cssInput.addEventListener("input", () => {
        touch();
        schedulePreview();
    });
    nameInput.addEventListener("input", () => {
        setName();
        touch();
    });
    nameInput.addEventListener("change", () => {
        nameInput.value = cleanName(nameInput.value);
        setName();
    });
    for (const input of [mdInput, cssInput]) {
        input.addEventListener("keydown", event => {
            // Keep native Tab focus navigation; modified Tab inserts indentation.
            if (event.key === "Tab" && event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                insertText(input, "    ");
            }
        });
    }
    $("#add-slide").addEventListener("click", () => {
        const separator = mdInput.value.trim() ? "\n\n---\n\n" : "";
        insertText(mdInput, separator + "# New slide\n\nAdd your content here.\n", mdInput.value.length, mdInput.value.length);
        if (updatePreview()) go(slides.length - 1);
    });
    for (const button of $$("[data-marker]")) {
        button.addEventListener("click", () => {
            const start = mdInput.selectionStart;
            const end = mdInput.selectionEnd;
            const selected = mdInput.value.slice(start, end) || button.dataset.placeholder;
            const marker = button.dataset.marker;
            insertText(mdInput, marker + selected + marker, start, end);
            mdInput.setSelectionRange(start + marker.length, start + marker.length + selected.length);
        });
    }
    $("#copy-markdown").addEventListener("click", () => {
        if (mdInput.value) one.copy(mdInput.value);
    });
    $("#open-zip").addEventListener("click", () => {
        $("#zip-input").value = "";
        $("#zip-input").click();
    });
    $("#zip-input").addEventListener("change", () => openZip($("#zip-input").files[0]));
    $("#download-zip").addEventListener("click", downloadPresentation);
    $("#new-presentation").addEventListener("click", async () => {
        if (!ready || busy || !await confirmReplace()) return;
        clearTimeout(renderTimer);
        try {
            await install(starter);
            revision++;
            dirty = false;
            exportedRevision = -1;
            await persist();
            toggleAside(true);
        } catch (error) {
            showError(error.message);
        }
    });
    $("#prev").addEventListener("click", () => go(current - 1));
    $("#next").addEventListener("click", () => go(current + 1));
    $("#overview-button").addEventListener("click", () => openDialog("overview-dialog"));
    $("#notes-button").addEventListener("click", () => openDialog("notes-dialog"));
    $("#help-button").addEventListener("click", () => openDialog("help-dialog"));
    $("#present-button").addEventListener("click", fullscreen);
    $("#print-button").addEventListener("click", printPresentation);
    $("#copy-font-report").addEventListener("click", () => one.copy($("#font-report").textContent));
    $$("[data-close]").forEach(button => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
    $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    }));
    document.addEventListener("keydown", keydown);
    $("#aside-state").addEventListener("change", syncAside);
    desktop.addEventListener("change", () => {
        $("#aside-state").checked = false;
        syncAside();
    });
    new ResizeObserver(resize).observe(viewport);
    document.addEventListener("fullscreenchange", resize);
    window.addEventListener("hashchange", () => {
        const index = Number(location.hash.slice(1));
        if (Number.isInteger(index) && index > 0) go(index - 1);
    });
    document.addEventListener("dragover", dragOver);
    document.addEventListener("drop", dropFiles);
    $("#content").addEventListener("dragenter", event => {
        if ([...event.dataTransfer.types].includes("Files")) $("#content").dataset.dragging = "true";
    });
    $("#content").addEventListener("dragleave", event => {
        if (!$("#content").contains(event.relatedTarget)) $("#content").removeAttribute("data-dragging");
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && ready) {
            updatePreview();
            persist();
        }
    });
    window.addEventListener("beforeprint", () => {
        if (ready) updatePreview();
    });
    window.addEventListener("beforeunload", event => {
        if (ready && (savedRevision < revision || storageFailed) && exportedRevision < revision) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    window.addEventListener("pagehide", () => {
        clearTimeout(renderTimer);
        clearTimeout(saveTimer);
        stopConfetti();
    });

    (async function initialize() {
        setBusy(true);
        try {
            [frameDoc, printDoc] = await Promise.all([setupFrame($("#slide-frame")), setupFrame($("#print-frame"), true)]);
            let draft;
            try {
                draft = await one.storage.get(STORAGE_KEY);
            } catch {
                storageFailed = true;
            }
            await install(starter);
            if (draft?.version === 1 && typeof draft.markdown === "string" && typeof draft.css === "string") {
                const files = new Map(Array.isArray(draft.assets) ? draft.assets : []);
                try {
                    await install({
                        name: draft.name,
                        markdown: draft.markdown,
                        css: draft.css,
                        assets: files,
                    }, Number(draft.current) || 0);
                } catch (error) {
                    // Invalid drafts remain recoverable rather than silently discarded.
                    presentationAssets.releaseUrls(assetUrls);
                    assets = files;
                    assetUrls = urlsFor(files);
                    mdInput.value = draft.markdown;
                    cssInput.value = draft.css;
                    nameInput.value = cleanName(draft.name);
                    setName();
                    assetSummary();
                    renderValid = false;
                    showError("Recovered an unfinished draft: " + error.message + " Fix the source or download the ZIP to keep it.");
                }
                dirty = true;
            }
            if (Number.isInteger(requestedSlide) && requestedSlide > 0) go(requestedSlide - 1, false);
            ready = true;
            $("#aside-state").checked = false;
            setBusy(false);
            syncAside();
            notice(storageFailed ? "Local save unavailable. Download ZIP to keep your edits." : "Ready. Changes are saved locally.", storageFailed);
            document.documentElement.dataset.ready = "true";
        } catch (error) {
            showError("Could not start Slides: " + error.message + " Keep all application files together.");
            notice("Slides could not start.", true);
            setBusy(false);
        }
    })();
})();
