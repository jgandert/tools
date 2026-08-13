/**
 * Zero-dependency client-side Markdown to HTML renderer.
 * Converts markdown (e.g., QUERY.md) into styled HTML structures.
 *
 * @example Browser Usage:
 * <script src="md-renderer.js"></script>
 * <script>
 *   // Method 1: Fetch and render directly into a DOM container
 *   renderMarkdownFileToElement('QUERY.md', '#content-container');
 *
 *   // Method 2: Parse raw Markdown string to HTML
 *   const html = parseMarkdownToHTML('# Hello World\nSome text.');
 *   document.getElementById('content-container').innerHTML = html;
 * </script>
 *
 * @example Node.js / Bun Usage:
 * const { parseMarkdownToHTML, renderMarkdownFileToElement } = require('./md-renderer.js');
 * const html = parseMarkdownToHTML('# Title\n\nParagraph text.');
 */

/**
 * Escapes raw HTML characters while preserving existing valid HTML entities.
 * @param {string} str
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    return str
        .replace(/&(?!(?:[a-zA-Z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);)/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Parses inline formatting: `code`, ![img](url), ***bold-italic***, **bold**, *italic*, and [links](url).
 * @param {string} text
 * @returns {string} HTML string
 */
function parseInline(text) {
    if (!text) return "";

    const uniquePrefix = `\uFFFC_${Math.random().toString(36).substring(2, 9)}_`;
    const tokens = [];

    function addToken(html) {
        const placeholder = `${uniquePrefix}${tokens.length}\uFFFC`;
        tokens.push(html);
        return placeholder;
    }

    // Process inline code blocks first using safe random placeholder
    text = text.replace(/`([^`]+)`/g, (_, code) => {
        return addToken(`<code>${escapeHtml(code)}</code>`);
    });

    // Escape raw HTML characters
    text = escapeHtml(text);

    // Markdown Images: ![alt text](url)
    text = text.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, altText, url) => {
        const safeUrl = escapeHtml(url.trim());
        const safeAlt = escapeHtml(altText.trim());
        return addToken(`<img src="${safeUrl}" alt="${safeAlt}">`);
    });

    // Markdown Links: [link text](url) - supports balanced parentheses in URLs
    text = text.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, linkText, url) => {
        const safeUrl = escapeHtml(url.trim());
        const formattedText = parseInline(linkText);
        return addToken(`<a href="${safeUrl}" target="_blank" rel="noopener">${formattedText}</a>`);
    });

    // Triple Emphasis: ***text*** or ___text___
    text = text.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/___(.*?)___/g, "<strong><em>$1</em></strong>");

    // Bold / Strong: **text** or __text__
    text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\b__(.*?)__\b/g, "<strong>$1</strong>");

    // Italic / Emphasis: *text* or _text_
    text = text.replace(/(^|\s)\*([^\s*]|[^\s*].*?[^\s*])\*(?=\s|$|[.,!?:;()])/g, "$1<em>$2</em>");
    text = text.replace(/(^|\s)_([^\s_]|[^\s_].*?[^\s_])_(?=\s|$|[.,!?:;()])/g, "$1<em>$2</em>");

    // Restore tokens
    tokens.forEach((token, index) => {
        text = text.replace(`${uniquePrefix}${index}\uFFFC`, token);
    });

    return text;
}

/**
 * Splits a table row by unescaped '|' delimiters, respecting escaped pipes (\|) and pipes inside inline code.
 * @param {string} rowStr
 * @returns {string[]} Cell strings
 */
function splitTableRow(rowStr) {
    let s = rowStr.trim().replace(/\\\|/g, "\uFFFD");
    s = s.replace(/`([^`]+)`/g, (match) => match.replace(/\|/g, "\uFFFD"));

    const rawCells = s.split("|");
    if (rawCells.length > 0 && rawCells[0].trim() === "") rawCells.shift();
    if (rawCells.length > 0 && rawCells[rawCells.length - 1].trim() === "") rawCells.pop();

    return rawCells.map((cell) => cell.replace(/\uFFFD/g, "|"));
}

/**
 * Converts heading text into a URL-safe slug ID.
 * @param {string} text
 * @returns {string} Slug string
 */
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/`([^`]+)`/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}

/**
 * Returns a unique slug string given a heading text, tracking map, and optional prefix.
 * @param {string} rawHeader
 * @param {Object.<string, number>} slugCounts
 * @param {string} [prefix=""]
 * @returns {string} Unique slug
 */
function getUniqueSlug(rawHeader, slugCounts, prefix = "") {
    let slug = slugify(rawHeader) || "heading";
    if (prefix) slug = `${prefix}${slug}`;
    if (slugCounts[slug] !== undefined) {
        slugCounts[slug]++;
        slug = `${slug}-${slugCounts[slug]}`;
    } else {
        slugCounts[slug] = 0;
    }
    return slug;
}

/**
 * Extracts structured headings from Markdown text (skipping headings inside fenced code blocks).
 * @param {string} markdown
 * @param {object} [options] - Options object
 * @param {string} [options.slugPrefix=""] - Optional prefix for generated anchor slugs
 * @returns {Array<{ level: number, title: string, slug: string, rawText: string }>} Headings list
 */
function extractHeadings(markdown, options = {}) {
    const lines = markdown.split(/\r?\n/);
    const headings = [];
    const slugCounts = {};
    const slugPrefix = options.slugPrefix || options.headingIdPrefix || "";
    let inFence = false;
    let fenceChar = null;
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                fenceChar = fenceMatch[1][0];
                fenceLen = fenceMatch[1].length;
            } else {
                const endMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (endMatch && endMatch[1][0] === fenceChar && endMatch[1].length >= fenceLen) {
                    inFence = false;
                }
            }
            continue;
        }

        if (inFence) continue;

        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const title = parseInline(rawHeader);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            headings.push({ level, title, slug, rawText: rawHeader });
        }
    }

    return headings;
}

/**
 * Generates an HTML Table of Contents from Markdown text with full CSS & structure customization.
 * @param {string} markdown
 * @param {object} [options] - Options object
 * @param {number} [options.minLevel=1] - Minimum heading level (1-6)
 * @param {number} [options.maxLevel=6] - Maximum heading level (1-6)
 * @param {string} [options.containerClass="toc"] - CSS class for wrapper container
 * @param {string} [options.containerTag="nav"] - HTML tag for container ('nav', 'aside', 'div', or '' for no wrapper)
 * @param {string} [options.title=""] - Optional title text/HTML to display inside container
 * @param {string} [options.ulClass=""] - Optional CSS class for <ul> elements
 * @param {string} [options.liClass=""] - Optional CSS class for <li> elements
 * @param {string} [options.aClass=""] - Optional CSS class for <a> elements
 * @param {string} [options.slugPrefix=""] - Optional prefix for anchor IDs
 * @returns {string} HTML TOC string
 */
function generateTOC(markdown, options = {}) {
    const headings = extractHeadings(markdown, options);
    const minLevel = options.minLevel || 1;
    const maxLevel = options.maxLevel || 6;
    const filtered = headings.filter(h => h.level >= minLevel && h.level <= maxLevel);

    if (filtered.length === 0) return "";

    const containerTag = options.containerTag !== undefined ? options.containerTag : "nav";
    const containerClass = options.containerClass !== undefined ? options.containerClass : "toc";
    const titleText = options.title || "";

    const ulAttr = options.ulClass ? ` class="${escapeHtml(options.ulClass)}"` : "";
    const liAttr = options.liClass ? ` class="${escapeHtml(options.liClass)}"` : "";
    const aAttr = options.aClass ? ` class="${escapeHtml(options.aClass)}"` : "";

    let html = "";
    if (containerTag) {
        const classAttr = containerClass ? ` class="${escapeHtml(containerClass)}"` : "";
        html += `<${containerTag}${classAttr}>`;
    }

    if (titleText) {
        html += titleText.startsWith("<") ? titleText : `<h2 class="toc-title">${escapeHtml(titleText)}</h2>`;
    }

    html += `<ul${ulAttr}>`;
    let currentDepth = filtered[0].level;

    filtered.forEach((h, index) => {
        if (index > 0) {
            if (h.level > currentDepth) {
                for (let d = currentDepth; d < h.level; d++) {
                    html += `<ul${ulAttr}>`;
                }
            } else if (h.level < currentDepth) {
                for (let d = currentDepth; d > h.level; d--) {
                    html += `</li></ul>`;
                }
                html += `</li>`;
            } else {
                html += `</li>`;
            }
        }
        html += `<li${liAttr}><a href="#${h.slug}"${aAttr}>${h.title}</a>`;
        currentDepth = h.level;
    });

    for (let d = currentDepth; d > filtered[0].level; d--) {
        html += `</li></ul>`;
    }
    html += `</li></ul>`;

    if (containerTag) {
        html += `</${containerTag}>`;
    }

    return html;
}

/**
 * Converts a Markdown string into formatted HTML with optional class and feature customizations.
 * @param {string} markdown
 * @param {object} [options] - Configuration options
 * @param {object|boolean} [options.toc] - Options for TOC generation, or `false` to disable inline [TOC]
 * @param {string} [options.headingIdPrefix=""] - Prefix prepended to heading anchor IDs
 * @param {string} [options.headingClass=""] - Custom CSS class added to <h1..h6> elements
 * @param {string} [options.tableContainerClass="table-container"] - CSS class for table wrapper <div>
 * @param {string} [options.noteClass="note"] - CSS class for blockquote wrapper <div>
 * @returns {string} HTML string
 */
function parseMarkdownToHTML(markdown, options = {}) {
    const lines = markdown.split(/\r?\n/);
    const output = [];
    const slugCounts = {};
    const slugPrefix = options.headingIdPrefix || options.slugPrefix || "";
    const tableContainerClass = options.tableContainerClass !== undefined ? options.tableContainerClass : "table-container";
    const noteClass = options.noteClass !== undefined ? options.noteClass : "note";
    const headingClass = options.headingClass ? ` class="${escapeHtml(options.headingClass)}"` : "";
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];

        // Skip empty lines
        if (!line.trim()) {
            i++;
            continue;
        }

        // Table of Contents placeholder: [TOC], [toc], or [[toc]]
        if (/^\s*\[(?:TOC|toc|\[toc\])\]\s*$/.test(line.trim())) {
            if (options.toc !== false) {
                const tocOptions = typeof options.toc === "object" ? { ...options, ...options.toc } : options;
                output.push(generateTOC(markdown, tocOptions));
            }
            i++;
            continue;
        }

        // Fenced Code Blocks (```lang or ~~~lang, allowing up to 3 leading spaces)
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
        if (fenceMatch) {
            const fenceChar = fenceMatch[1][0];
            const fenceLen = fenceMatch[1].length;
            const lang = escapeHtml(fenceMatch[2].trim());
            const codeLines = [];
            i++;
            while (i < lines.length) {
                const endMatch = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (endMatch && endMatch[1][0] === fenceChar && endMatch[1].length >= fenceLen) {
                    i++;
                    break;
                }
                codeLines.push(escapeHtml(lines[i]));
                i++;
            }
            const langClass = lang ? ` class="language-${lang}"` : "";
            output.push(`<pre><code${langClass}>${codeLines.join("\n")}</code></pre>`);
            continue;
        }

        // Horizontal Rules (---, ***, ___ with optional spaces)
        if (/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line)) {
            output.push("<hr>");
            i++;
            continue;
        }

        // Headers (# H1, ## H2, ### H3, #### H4) - allows up to 3 leading spaces, strips trailing hashes
        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            const rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const content = parseInline(rawHeader);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            output.push(`<h${level} id="${slug}"${headingClass}>${content}</h${level}>`);
            i++;
            continue;
        }

        // Blockquotes -> <div class="note">
        if (line.trim().startsWith(">")) {
            const noteLines = [];
            while (i < lines.length && lines[i].trim().startsWith(">")) {
                noteLines.push(lines[i].trim().replace(/^>\s?/, ""));
                i++;
            }
            const noteContent = parseInline(noteLines.join("\n").trim());
            const classAttr = noteClass ? ` class="${escapeHtml(noteClass)}"` : "";
            output.push(`<div${classAttr}>${noteContent}</div>`);
            continue;
        }

        // Tables (lines starting with '|' or containing '|')
        if (line.trim().startsWith("|") || (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|"))) {
            const tableLines = [];
            while (i < lines.length && (lines[i].trim().startsWith("|") || lines[i].includes("|"))) {
                tableLines.push(lines[i].trim());
                i++;
            }

            if (tableLines.length >= 2) {
                const parseRow = (rowStr) =>
                    splitTableRow(rowStr).map((c) => parseInline(c.trim()));

                const headers = parseRow(tableLines[0]);
                const isSeparator = /^\|?\s*:?-+:?\s*(?:\|?\s*:?-+:?\s*\|?)+$/.test(tableLines[1]);
                const alignments = [];

                if (isSeparator) {
                    const sepCells = splitTableRow(tableLines[1]);
                    sepCells.forEach((cell) => {
                        const trimmed = cell.trim();
                        if (trimmed.startsWith(":") && trimmed.endsWith(":")) alignments.push(" style=\"text-align: center;\"");
                        else if (trimmed.endsWith(":")) alignments.push(" style=\"text-align: right;\"");
                        else if (trimmed.startsWith(":")) alignments.push(" style=\"text-align: left;\"");
                        else alignments.push("");
                    });
                }

                const bodyStart = isSeparator ? 2 : 1;
                const containerClassAttr = tableContainerClass ? ` class="${escapeHtml(tableContainerClass)}"` : "";

                let tableHtml = `<div${containerClassAttr}><table><thead><tr>`;
                headers.forEach((h, idx) => {
                    const style = alignments[idx] || "";
                    tableHtml += `<th${style}>${h}</th>`;
                });
                tableHtml += "</tr></thead><tbody>";

                for (let r = bodyStart; r < tableLines.length; r++) {
                    const cells = parseRow(tableLines[r]);
                    tableHtml += "<tr>";
                    for (let c = 0; c < headers.length; c++) {
                        const cellVal = cells[c] !== undefined ? cells[c] : "";
                        const style = alignments[c] || "";
                        tableHtml += `<td${style}>${cellVal}</td>`;
                    }
                    tableHtml += "</tr>";
                }
                tableHtml += "</tbody></table></div>";
                output.push(tableHtml);
                continue;
            }
        }

        // Unordered Lists (- item, * item, or + item)
        if (/^\s*[-*+]\s+/.test(line)) {
            const listItems = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                const itemText = lines[i].replace(/^\s*[-*+]\s+/, "");
                listItems.push(parseInline(itemText));
                i++;
            }
            let listHtml = "<ul>";
            listItems.forEach((item) => {
                listHtml += `<li>${item}</li>`;
            });
            listHtml += "</ul>";
            output.push(listHtml);
            continue;
        }

        // Ordered Lists (1. item)
        if (/^\s*\d+\.\s+/.test(line)) {
            const listItems = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                const itemText = lines[i].replace(/^\s*\d+\.\s+/, "");
                listItems.push(parseInline(itemText));
                i++;
            }
            let listHtml = "<ol>";
            listItems.forEach((item) => {
                listHtml += `<li>${item}</li>`;
            });
            listHtml += "</ol>";
            output.push(listHtml);
            continue;
        }

        // Paragraphs: collect consecutive non-empty lines that aren't other block elements
        const paragraphLines = [];
        while (
            i < lines.length &&
            lines[i].trim() &&
            !lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/) &&
            !/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(lines[i]) &&
            !lines[i].match(/^\s{0,3}#{1,6}\s+/) &&
            !lines[i].trim().startsWith(">") &&
            !lines[i].trim().startsWith("|") &&
            !/^\s*[-*+]\s+/.test(lines[i]) &&
            !/^\s*\d+\.\s+/.test(lines[i]) &&
            !/^\s*\[(?:TOC|toc|\[toc\])\]\s*$/.test(lines[i].trim())
            ) {
            paragraphLines.push(lines[i].trim());
            i++;
        }
        if (paragraphLines.length > 0) {
            const pContent = parseInline(paragraphLines.join(" "));
            output.push(`<p>${pContent}</p>`);
        }
    }

    return output.join("\n");
}

/**
 * Fetches a Markdown file from a URL/path and renders its content into a target element.
 * @param {string} url - Path to .md file (e.g., 'QUERY.md')
 * @param {HTMLElement|string} targetElement - DOM element or selector
 * @param {object} [options] - Options passed to parseMarkdownToHTML
 */
async function renderMarkdownFileToElement(url, targetElement, options = {}) {
    const container = typeof targetElement === "string"
        ? document.querySelector(targetElement)
        : targetElement;
    if (!container) return;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to render markdown file into target element: HTTP error ${response.status}`);
            return;
        }
        const markdown = await response.text();
        container.innerHTML = parseMarkdownToHTML(markdown, options);
    } catch (err) {
        console.error("Failed to render markdown file into target element:", err);
    }
}

// Backward-compatible alias functions
const parseMarkdownToModalHTML = parseMarkdownToHTML;
const renderMarkdownFileToModal = renderMarkdownFileToElement;

// Support both ES module / CommonJS and global browser usage
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        parseMarkdownToHTML,
        renderMarkdownFileToElement,
        extractHeadings,
        generateTOC,
        slugify,
        // Legacy aliases
        parseMarkdownToModalHTML,
        renderMarkdownFileToModal,
    };
} else {
    window.parseMarkdownToHTML = parseMarkdownToHTML;
    window.renderMarkdownFileToElement = renderMarkdownFileToElement;
    window.extractHeadings = extractHeadings;
    window.generateTOC = generateTOC;
    window.slugify = slugify;
    // Legacy aliases
    window.parseMarkdownToModalHTML = parseMarkdownToModalHTML;
    window.renderMarkdownFileToModal = renderMarkdownFileToModal;
}
