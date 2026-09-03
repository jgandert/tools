/**
 * Zero-dependency client-side Markdown to HTML renderer.
 * Converts markdown (e.g., md-showcase.md) into styled HTML structures.
 *
 * @example Browser Usage:
 * <script src="md-renderer.js"></script>
 * <script>
 *   // Method 1: Fetch and render directly into a DOM container
 *   renderMarkdownFileToElement('md-showcase.md', '#content-container');
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

function escapeHtmlAttribute(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

const SAFE_HTML_TAGS = new Set([
    "a", "abbr", "article", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol", "p", "picture", "rp", "rt", "ruby", "s", "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr",
]);
const VOID_HTML_TAGS = new Set(["br", "col", "hr", "img", "input", "source", "wbr"]);
const URL_ATTRIBUTES = new Set(["cite", "href", "poster", "src"]);
const SAFE_HTML_ATTRIBUTES = new Set([
    "alt", "aria-describedby", "aria-label", "aria-labelledby", "checked", "class", "colspan", "controls", "disabled", "height", "id", "open", "rel", "rowspan", "scope", "span", "start", "target", "title", "type", "width",
]);

function isSafeUrl(url) {
    const normalized = String(url).trim().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith("#") || normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) return true;
    return /^(?:https?:|mailto:)/.test(normalized) || !/^[a-z][a-z0-9+.-]*:/i.test(normalized);
}

function sanitizeHtmlTag(tag, options = {}) {
    const match = tag.match(/^<\s*(\/?)\s*([a-zA-Z][\w-]*)([\s\S]*?)>$/);
    if (!match) return escapeHtml(tag);
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const rawAttributes = match[3];
    const isSelfClosing = /\/\s*$/.test(rawAttributes);
    const mediaAllowed = options.allowAudioVideo && (name === "audio" || name === "video");
    if ((!SAFE_HTML_TAGS.has(name) && !mediaAllowed) || (isSelfClosing && !VOID_HTML_TAGS.has(name))) return escapeHtml(tag);
    if (closing) return `</${name}>`;

    let attributes = "";
    const attributePattern = /([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g;
    for (const attributeMatch of rawAttributes.replace(/\/\s*$/, "").matchAll(attributePattern)) {
        const attributeName = attributeMatch[1].toLowerCase();
        if (!SAFE_HTML_ATTRIBUTES.has(attributeName) && !URL_ATTRIBUTES.has(attributeName)) continue;
        const hasValue = attributeMatch[2] !== undefined || attributeMatch[3] !== undefined || attributeMatch[4] !== undefined;
        if (!hasValue) {
            attributes += ` ${attributeName}`;
            continue;
        }
        const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4];
        if (URL_ATTRIBUTES.has(attributeName) && !isSafeUrl(value)) continue;
        attributes += ` ${attributeName}="${escapeHtmlAttribute(value)}"`;
    }
    return `<${name}${attributes}>`;
}

function sanitizeHtmlFragment(html, options = {}) {
    if (options.allowUnsafeHtml) return html;
    return html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, (tag) => tag.startsWith("<!--") ? "" : sanitizeHtmlTag(tag, options));
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
    let slug = text.toLowerCase();
    if (slug.includes("{#") && slug.includes("}")) {
        slug = slug.replace(/\{#[^}]+\}/g, "");
    }
    if (slug.includes("`")) {
        const firstBacktick = slug.indexOf("`");
        if (slug.indexOf("`", firstBacktick + 1) !== -1) {
            slug = slug.replace(/`([^`]+)`/g, "$1");
        }
    }
    if (slug.includes("<") && slug.includes(">")) {
        slug = slug.replace(/<[^>]+>/g, "");
    }
    return slug
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
    const explicitMatch = rawHeader.match(/\{#([a-zA-Z0-9_-]+)[^}]*\}/);
    let slug = explicitMatch ? explicitMatch[1] : (slugify(rawHeader) || "heading");
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
    markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const lines = markdown.split(/\r?\n/);
    const headings = [];
    const slugCounts = Object.create(null);
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
            let rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const explicitMatch = rawHeader.match(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            if (explicitMatch) {
                rawHeader = rawHeader.replace(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/, "").trim();
            }
            const title = parseInline(rawHeader);
            headings.push({ level, title, slug, rawText: rawHeader });
            continue;
        }

        if (i + 1 < lines.length && line.trim() && !line.match(/^\s{0,3}(?:[-*+]|\d+[.)]|>|\|)/)) {
            const nextLine = lines[i + 1].trim();
            if (/^={2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                const title = parseInline(rawHeader);
                headings.push({ level: 1, title, slug, rawText: rawHeader });
                i++;
                continue;
            } else if (/^-{2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                const title = parseInline(rawHeader);
                headings.push({ level: 2, title, slug, rawText: rawHeader });
                i++;
                continue;
            }
        }
    }

    return headings;
}

/**
 * Generates an HTML Table of Contents from Markdown text with full CSS & structure customization.
 * @param {string} markdown
 * @param {object} [options] - Options object
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

    const root = { children: [] };
    const stack = [root];
    filtered.forEach((heading) => {
        while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop();
        const node = { ...heading, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    });
    const renderNodes = (nodes) => `<ul${ulAttr}>${nodes.map((node) => {
        const children = node.children.length ? renderNodes(node.children) : "";
        return `<li${liAttr}><a href="#${escapeHtmlAttribute(node.slug)}"${aAttr}>${node.title}</a>${children}</li>`;
    }).join("")}</ul>`;
    html += renderNodes(root.children);

    if (containerTag) {
        html += `</${containerTag}>`;
    }

    return html;
}

/**
 * Checks if a line matches a list item marker (and is not a horizontal rule).
 * @param {string} line
 * @returns {{ indent: number, type: "ul"|"ol", prefix: string, text: string } | null}
 */
function getListItemMatch(line) {
    if (!line) return null;
    if (/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line)) {
        return null;
    }
    const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!match) return null;
    const indentStr = match[1].replace(/\t/g, "    ");
    const marker = match[2];
    const isOrdered = /^\d+[.)]/.test(marker);
    let itemText = match[3];
    let prefix = "";

    // Task lists: - [ ] or - [x] or - [X]
    const taskMatch = itemText.match(/^\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
        const taskText = taskMatch[2].trim();
        const accessibleName = taskText || "Task item";
        prefix = `<input type="checkbox"${checked} aria-label="${escapeHtmlAttribute(accessibleName)}" disabled> `;
        itemText = taskMatch[2];
    }

    return {
        indent: indentStr.length,
        type: isOrdered ? "ol" : "ul",
        prefix,
        text: itemText,
    };
}

/**
 * Parses inline formatting: `code`, ![img](url), ***bold-italic***, **bold**, *italic*, strikethrough, highlight, sub/sup, links, etc.
 * @param {string} text
 * @param {object} [context={}]
 * @returns {string} HTML string
 */
function parseInline(text, context = {}) {
    if (!text) return "";
    text = String(text);

    const uniquePrefix = `\uFFFC_${Math.random().toString(36).substring(2, 9)}_`;
    const tokens = [];

    function addToken(html) {
        const placeholder = `${uniquePrefix}${tokens.length}\uFFFC`;
        tokens.push(html);
        return placeholder;
    }

    // 1. Process inline code spans (handles single and multi-backticks, padding spaces)
    if (text.includes("`")) {
        text = text.replace(/(`+)([\s\S]*?)\1/g, (_, fence, code) => {
            if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && !/^\s+$/.test(code)) {
                code = code.slice(1, -1);
            }
            return addToken(`<code>${escapeHtml(code)}</code>`);
        });
    }

    // 2. Escaped markdown punctuation
    text = text.replace(/\\([\\`*_{}\[\]()#+\-.!~|^=<>:])/g, (_, char) => {
        return addToken(escapeHtml(char));
    });

    // 3. Safe inline HTML tags
    const safeTagRegex = /<\/?(?:em|strong|b|i|del|ins|mark|sub|sup|small|u|s|kbd|var|ruby|rp|rt|abbr|wbr|br|span|a|picture|source|audio|video|img|input)(?:\s+[^<>]*)?\/?>/gi;
    if (text.includes("<") && text.includes(">")) {
        text = text.replace(safeTagRegex, (match) => {
            return addToken(sanitizeHtmlTag(match, context.options));
        });
    }

    // 4. Autolinks: <https://...> or <user@example.com>
    if (text.includes("<") && text.includes(">")) {
        text = text.replace(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]+)>/g, (_, url) => {
            if (!isSafeUrl(url)) return escapeHtml(url);
            const safeUrl = escapeHtmlAttribute(url);
            return addToken(`<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`);
        });
        text = text.replace(/<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g, (_, email) => {
            const safeEmail = escapeHtml(email);
            return addToken(`<a href="mailto:${safeEmail}">${safeEmail}</a>`);
        });
    }

    if (text.includes("[![")) text = text.replace(/\[!\[([^\]]*)\]\(([^\s)]+)\)\]\(([^\s)]+)\)/g, (_, altText, imageUrl, linkUrl) => {
        if (!isSafeUrl(imageUrl) || !isSafeUrl(linkUrl)) return escapeHtml(altText);
        return addToken(`<a href="${escapeHtmlAttribute(linkUrl)}" target="_blank" rel="noopener"><img src="${escapeHtmlAttribute(imageUrl)}" alt="${escapeHtmlAttribute(altText)}"></a>`);
    });

    // 5. Wiki-links: [[Target]] or [[Target|Label]]
    if (text.includes("[[") && text.includes("]]")) {
        text = text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
            const displayText = escapeHtml((label || target).trim());
            const slug = slugify(target.trim());
            return addToken(`<a href="#${slug}">${displayText}</a>`);
        });
    }

    // 6. Markdown Images
    if (text.includes("![") && text.includes("]")) text = text.replace(/!\[([^\]]*)\](?:\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)|\[([^\]]*)\])(?:\{([^}]+)\})?/g, (match, altText, url, title1, title2, refKey, attrs) => {
        let finalUrl = url !== undefined ? url : "";
        let finalTitle = title1 || title2 || "";
        if (refKey !== undefined) {
            const key = (refKey || altText).toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (ref) {
                finalUrl = ref.url;
                if (!finalTitle && ref.title) finalTitle = ref.title;
            }
        }
        if (!isSafeUrl(finalUrl)) return addToken(escapeHtml(altText.trim()));
        const safeUrl = escapeHtmlAttribute(finalUrl.trim());
        const safeAlt = escapeHtml(altText.trim());
        const titleAttr = finalTitle ? ` title="${escapeHtmlAttribute(finalTitle.trim())}"` : "";
        let attrStr = "";
        if (attrs) {
            const widthMatch = attrs.match(/width=(\d+)/);
            const heightMatch = attrs.match(/height=(\d+)/);
            if (widthMatch) attrStr += ` width="${widthMatch[1]}"`;
            if (heightMatch) attrStr += ` height="${heightMatch[1]}"`;
        }
        return addToken(`<img src="${safeUrl}" alt="${safeAlt}"${titleAttr}${attrStr}>`);
    });

    // 7. Markdown Links: [text](url "title") or [text][ref] or [text][]
    if (text.includes("[") && text.includes("]")) text = text.replace(/\[([^\]]*)\](?:\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)|\[([^\]]*)\])/g, (match, linkText, url, title1, title2, refKey) => {
        let finalUrl = url !== undefined ? url : "";
        let finalTitle = title1 || title2 || "";
        if (refKey !== undefined) {
            const key = (refKey || linkText).toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (ref) {
                finalUrl = ref.url;
                if (!finalTitle && ref.title) finalTitle = ref.title;
            }
        }
        if (!finalUrl && refKey === undefined && url === undefined) {
            const key = linkText.toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (ref) {
                finalUrl = ref.url;
                if (!finalTitle && ref.title) finalTitle = ref.title;
            }
        }
        const formattedText = parseInline(linkText, context);
        if (!isSafeUrl(finalUrl)) return addToken(formattedText);
        const safeUrl = escapeHtmlAttribute(finalUrl.trim());
        const titleAttr = finalTitle ? ` title="${escapeHtmlAttribute(finalTitle.trim())}"` : "";
        return addToken(`<a href="${safeUrl}"${titleAttr} target="_blank" rel="noopener">${formattedText}</a>`);
    });

    if (text.includes("[") && text.includes("]")) text = text.replace(/\[([^\]^]+)\]/g, (match, linkText) => {
        const ref = context.references && context.references[linkText.toLowerCase().trim()];
        if (!ref || !isSafeUrl(ref.url)) return match;
        const titleAttr = ref.title ? ` title="${escapeHtmlAttribute(ref.title.trim())}"` : "";
        return addToken(`<a href="${escapeHtmlAttribute(ref.url.trim())}"${titleAttr} target="_blank" rel="noopener">${parseInline(linkText, context)}</a>`);
    });

    // 8. Footnote references: [^id]
    if (text.includes("[^") && text.includes("]")) text = text.replace(/\[\^([^\]]+)\]/g, (_, id) => {
        const safeId = escapeHtmlAttribute(id);
        if (context.footnoteOrder && !context.footnoteOrder.includes(id)) {
            context.footnoteOrder.push(id);
        }
        const num = context.footnoteOrder ? context.footnoteOrder.indexOf(id) + 1 : 1;
        context.footnoteReferenceCounts ||= Object.create(null);
        context.footnoteReferenceCounts[id] = (context.footnoteReferenceCounts[id] || 0) + 1;
        const suffix = context.footnoteReferenceCounts[id] > 1 ? `-${context.footnoteReferenceCounts[id]}` : "";
        return addToken(`<sup><a href="#fn-${safeId}" id="fnref-${safeId}${suffix}">[${num}]</a></sup>`);
    });

    // 9. Escape raw HTML characters
    text = escapeHtml(text);

    // 10. Bare URLs (GFM autolink)
    text = text.replace(/(^|\s)(https?:\/\/[^\s<>()]+)(?=\s|$|[.,!?:;])/g, (_, before, url) => {
        const safeUrl = escapeHtml(url);
        return `${before}${addToken(`<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`)}`;
    });

    // 11. Inline formatting
    text = text.replace(/~~(.*?)~~/g, "<del>$1</del>");
    text = text.replace(/==(.*?)==/g, "<mark>$1</mark>");
    text = text.replace(/\+\+(.*?)\+\+/g, "<ins>$1</ins>");
    text = text.replace(/~([^\s~]+)~/g, "<sub>$1</sub>");
    text = text.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
    text = text.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/___(.*?)___/g, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\b__(.*?)__\b/g, "<strong>$1</strong>");
    text = text.replace(/(^|\s)_([^\s_<>]|[^\s_<>][^_<>]*?[^\s_<>])_(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");
    text = text.replace(/<strong>[\s\S]*?<\/strong>/g, (match) => addToken(match));
    text = text.replace(/(^|\s)\*([^\s*<>]|[^\s*<>][^*<>]*?[^\s*<>])\*(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");
    text = text.replace(/(^|\s)_([^\s_<>]|[^\s_<>][^_<>]*?[^\s_<>])_(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");

    if (tokens.length > 0) {
        const tokenPattern = new RegExp(`${uniquePrefix}(\\d+)\uFFFC`, "g");
        const restoreToken = (placeholder, index) => tokens[Number(index)] ?? placeholder;

        // Later tokens can contain placeholders for earlier tokens.
        for (let index = 0; index < tokens.length; index++) {
            if (tokens[index].includes(uniquePrefix)) {
                tokens[index] = tokens[index].replace(tokenPattern, restoreToken);
            }
        }
        text = text.replace(tokenPattern, restoreToken);
    }

    return text;
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
    if (typeof markdown !== "string") {
        throw new TypeError("markdown must be a string");
    }
    if (!markdown || !markdown.trim()) return "";

    // 1. Strip YAML frontmatter at top of document
    markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

    const lines = markdown.split(/\r?\n/);
    const output = [];
    const slugCounts = Object.create(null);
    const slugPrefix = options.headingIdPrefix || options.slugPrefix || "";
    const tableContainerClass = options.tableContainerClass !== undefined ? options.tableContainerClass : "table-container";
    const noteClass = options.noteClass !== undefined ? options.noteClass : "note";
    const headingClass = options.headingClass ? ` class="${escapeHtmlAttribute(options.headingClass)}"` : "";

    const context = {
        references: Object.create(null),
        footnotes: Object.create(null),
        footnoteOrder: [],
        footnoteReferenceCounts: Object.create(null),
        options,
    };

    // 2. First pass: Collect reference link definitions and footnote definitions
    const cleanedLines = [];
    for (let r = 0; r < lines.length; r++) {
        const l = lines[r];
        const refMatch = l.match(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/);
        const fnMatch = l.match(/^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/);
        const abbrMatch = l.match(/^\s{0,3}\*\[([^\]]+)\]:\s*(.*)$/);

        if (fnMatch) {
            const fnId = fnMatch[1];
            let fnContent = fnMatch[2];
            let nextR = r + 1;
            while (nextR < lines.length && (lines[nextR].startsWith("    ") || lines[nextR].startsWith("\t") || !lines[nextR].trim())) {
                if (lines[nextR].trim()) {
                    fnContent += "\n" + lines[nextR].trim();
                }
                nextR++;
            }
            context.footnotes[fnId] = fnContent;
            r = nextR - 1;
        } else if (refMatch) {
            const key = refMatch[1].toLowerCase().trim();
            const url = refMatch[2];
            const title = refMatch[3] || refMatch[4] || refMatch[5] || "";
            context.references[key] = { url, title };
        } else if (abbrMatch) {
            // Ignored abbreviation definition
        } else {
            cleanedLines.push(l);
        }
    }

    const startsTableAt = (index) =>
        index + 1 < cleanedLines.length &&
        cleanedLines[index].includes("|") &&
        cleanedLines[index + 1].includes("|");

    let i = 0;
    while (i < cleanedLines.length) {
        let line = cleanedLines[i];

        // Skip empty lines
        if (!line.trim()) {
            i++;
            continue;
        }

        // HTML Comments <!-- ... -->
        if (line.trim().startsWith("<!--") && !/^<!--\s*toc\s*-->$/i.test(line.trim())) {
            while (i < cleanedLines.length && !cleanedLines[i].includes("-->")) {
                i++;
            }
            i++;
            continue;
        }

        // Table of Contents placeholder: [TOC], [toc], [[toc]], [[_TOC_]], <!-- toc -->
        if (/^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(line.trim())) {
            if (options.toc !== false) {
                const tocOptions = typeof options.toc === "object" ? { ...options, ...options.toc } : options;
                output.push(generateTOC(markdown, tocOptions));
            }
            i++;
            continue;
        }

        // Fenced Code Blocks (```lang or ~~~lang)
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
        if (fenceMatch) {
            const fenceChar = fenceMatch[1][0];
            const fenceLen = fenceMatch[1].length;
            let info = fenceMatch[2].trim();
            let lang = "";
            const attrMatch = info.match(/^\{(?:\.([a-zA-Z0-9_-]+))?[^}]*\}$/);
            if (attrMatch && attrMatch[1]) {
                lang = attrMatch[1];
            } else {
                lang = info.split(/\s+/)[0] || "";
            }
            lang = escapeHtml(lang.replace(/^\{?\.?([a-zA-Z0-9_-]+).*$/, "$1"));

            const codeLines = [];
            i++;
            while (i < cleanedLines.length) {
                const endMatch = cleanedLines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (endMatch && endMatch[1][0] === fenceChar && endMatch[1].length >= fenceLen) {
                    i++;
                    break;
                }
                codeLines.push(escapeHtml(cleanedLines[i]));
                i++;
            }
            const langClass = lang ? ` class="language-${lang}"` : "";
            output.push(`<pre><code${langClass}>${codeLines.join("\n")}</code></pre>`);
            continue;
        }

        // Indented Code Blocks (4 spaces or 1 tab)
        if ((line.startsWith("    ") || line.startsWith("\t")) && !getListItemMatch(line)) {
            const codeLines = [];
            while (i < cleanedLines.length && (cleanedLines[i].startsWith("    ") || cleanedLines[i].startsWith("\t") || !cleanedLines[i].trim())) {
                const cLine = cleanedLines[i].startsWith("\t")
                    ? cleanedLines[i].slice(1)
                    : (cleanedLines[i].startsWith("    ") ? cleanedLines[i].slice(4) : cleanedLines[i]);
                codeLines.push(escapeHtml(cLine));
                i++;
            }
            output.push(`<pre><code>${codeLines.join("\n").replace(/\n+$/, "")}</code></pre>`);
            continue;
        }

        // Display Math: $$ ... $$ or \[ ... \]
        if (line.trim() === "$$" || line.trim() === "\\[") {
            const closing = line.trim() === "$$" ? "$$" : "\\]";
            const mathLines = [];
            i++;
            while (i < cleanedLines.length && cleanedLines[i].trim() !== closing) {
                mathLines.push(cleanedLines[i]);
                i++;
            }
            if (i < cleanedLines.length) i++;
            output.push(`<div class="math display">${escapeHtml(mathLines.join("\n"))}</div>`);
            continue;
        }

        // Setext Headings (Level 1: ===, Level 2: ---)
        if (i + 1 < cleanedLines.length && line.trim() && !line.match(/^\s{0,3}(?:[-*+]|\d+[.)]|>|\|)/)) {
            const nextLine = cleanedLines[i + 1].trim();
            if (/^={2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const content = parseInline(rawHeader, context);
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                output.push(`<h1 id="${slug}"${headingClass}>${content}</h1>`);
                i += 2;
                continue;
            } else if (/^-{2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const content = parseInline(rawHeader, context);
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                output.push(`<h2 id="${slug}"${headingClass}>${content}</h2>`);
                i += 2;
                continue;
            }
        }

        // Horizontal Rules (---, ***, ___ with optional spaces)
        if (/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line)) {
            output.push("<hr>");
            i++;
            continue;
        }

        // ATX Headers (# H1 to ###### H6)
        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            let rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const explicitMatch = rawHeader.match(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            if (explicitMatch) {
                rawHeader = rawHeader.replace(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/, "").trim();
            }
            const content = parseInline(rawHeader, context);
            output.push(`<h${level} id="${slug}"${headingClass}>${content}</h${level}>`);
            i++;
            continue;
        }

        // Blockquotes & GitHub Alerts
        if (line.trim().startsWith(">")) {
            const noteLines = [];
            while (i < cleanedLines.length && (cleanedLines[i].trim().startsWith(">") || (cleanedLines[i].trim() && noteLines.length > 0 && !cleanedLines[i].match(/^\s{0,3}(?:#{1,6}|`{3,}|~{3,}|[-*+]|\d+[.)]|\|)/)))) {
                if (cleanedLines[i].trim().startsWith(">")) {
                    noteLines.push(cleanedLines[i].trim().replace(/^>\s?/, ""));
                } else {
                    noteLines.push(cleanedLines[i].trim());
                }
                i++;
            }

            const rawBlock = noteLines.join("\n").trim();
            const firstLine = rawBlock.split("\n")[0];
            const alertMatch = firstLine.match(/^\[!([a-zA-Z0-9_-]+)\]-?\s*(.*)$/i);
            const classAttr = noteClass ? ` class="${escapeHtml(noteClass)}"` : "";

            if (alertMatch) {
                const type = alertMatch[1].toUpperCase();
                const inlineTitle = alertMatch[2].trim();
                const body = rawBlock.slice(firstLine.length).trim();
                const titleHeader = inlineTitle ? `<strong>${type}: ${escapeHtml(inlineTitle)}</strong>` : `<strong>${type}</strong>`;
                const noteContent = parseMarkdownToHTML(body, options);
                output.push(`<div${classAttr}>${titleHeader}\n${noteContent}</div>`);
            } else {
                if (!rawBlock.includes("\n\n") && !rawBlock.startsWith("- ") && !rawBlock.startsWith("* ")) {
                    const noteContent = parseInline(rawBlock, context);
                    output.push(`<div${classAttr}>${noteContent}</div>`);
                } else {
                    const noteContent = parseMarkdownToHTML(rawBlock, options);
                    output.push(`<div${classAttr}>\n${noteContent}\n</div>`);
                }
            }
            continue;
        }

        // Tables
        if (startsTableAt(i)) {
            const tableLines = [];
            while (i < cleanedLines.length && (cleanedLines[i].trim().startsWith("|") || cleanedLines[i].includes("|"))) {
                tableLines.push(cleanedLines[i].trim());
                i++;
            }

            if (tableLines.length >= 2) {
                const parseRow = (rowStr) =>
                    splitTableRow(rowStr).map((c) => parseInline(c.trim(), context));

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

        // Definition Lists (Term \n : Definition)
        if (i + 1 < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i + 1]) && !getListItemMatch(line)) {
            const term = parseInline(line.trim(), context);
            const defs = [];
            i++;
            while (i < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i])) {
                defs.push(parseInline(cleanedLines[i].trim().replace(/^:\s*/, ""), context));
                i++;
            }
            let dlHtml = `<dl><dt>${term}</dt>`;
            defs.forEach((d) => {
                dlHtml += `<dd>${d}</dd>`;
            });
            dlHtml += `</dl>`;
            output.push(dlHtml);
            continue;
        }

        // Lists
        if (getListItemMatch(line)) {
            let listHtml = "";
            const stack = [];

            while (i < cleanedLines.length) {
                const currentLine = cleanedLines[i];

                if (
                    currentLine.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/) ||
                    /^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(currentLine) ||
                    currentLine.match(/^\s{0,3}#{1,6}\s+/) ||
                    currentLine.trim().startsWith(">") ||
                    currentLine.trim().startsWith("|") ||
                    /^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(currentLine.trim())
                ) {
                    break;
                }

                const itemMatch = getListItemMatch(currentLine);

                if (itemMatch) {
                    const { indent, type, prefix, text } = itemMatch;
                    const renderedText = prefix + parseInline(text, context);

                    if (stack.length === 0) {
                        stack.push({ type, indent });
                        listHtml += `<${type}><li>${renderedText}`;
                    } else {
                        const top = stack[stack.length - 1];

                        if (indent > top.indent) {
                            stack.push({ type, indent });
                            listHtml += `<${type}><li>${renderedText}`;
                        } else if (indent === top.indent) {
                            if (type === top.type) {
                                listHtml += `</li><li>${renderedText}`;
                            } else {
                                listHtml += `</li></${top.type}>`;
                                stack.pop();
                                stack.push({ type, indent });
                                listHtml += `<${type}><li>${renderedText}`;
                            }
                        } else {
                            while (stack.length > 1 && stack[stack.length - 1].indent > indent) {
                                const popped = stack.pop();
                                listHtml += `</li></${popped.type}>`;
                            }

                            const currentTop = stack[stack.length - 1];
                            if (currentTop.indent === indent) {
                                if (currentTop.type === type) {
                                    listHtml += `</li><li>${renderedText}`;
                                } else {
                                    listHtml += `</li></${currentTop.type}>`;
                                    stack.pop();
                                    stack.push({ type, indent });
                                    listHtml += `<${type}><li>${renderedText}`;
                                }
                            } else if (indent < currentTop.indent) {
                                listHtml += `</li></${currentTop.type}>`;
                                stack.pop();
                                stack.push({ type, indent });
                                listHtml += `<${type}><li>${renderedText}`;
                            } else {
                                stack.push({ type, indent });
                                listHtml += `<${type}><li>${renderedText}`;
                            }
                        }
                    }
                    i++;
                } else if (!currentLine.trim()) {
                    let peek = i + 1;
                    while (peek < cleanedLines.length && !cleanedLines[peek].trim()) {
                        peek++;
                    }
                    if (peek < cleanedLines.length && getListItemMatch(cleanedLines[peek])) {
                        i++;
                        continue;
                    } else {
                        break;
                    }
                } else {
                    const leadingSpaces = currentLine.match(/^(\s*)/)[1].replace(/\t/g, "    ").length;
                    if (stack.length > 0 && leadingSpaces >= 2) {
                        listHtml += ` ${parseInline(currentLine.trim(), context)}`;
                        i++;
                    } else {
                        break;
                    }
                }
            }

            while (stack.length > 0) {
                const popped = stack.pop();
                listHtml += `</li></${popped.type}>`;
            }

            output.push(listHtml);
            continue;
        }

        // Raw HTML Blocks
        const htmlBlockMatch = line.match(/^\s{0,3}<(details|summary|section|article|figure|figcaption|blockquote|table|thead|tbody|tfoot|tr|th|td|ul|ol|li|dl|dt|dd|audio|video|picture|div|p|a)\b[^>]*>/i);
        if (htmlBlockMatch) {
            const blockTag = htmlBlockMatch[1].toLowerCase();
            const closingTagPattern = new RegExp(`</${blockTag}>`, "i");
            const htmlLines = [line];
            if (!closingTagPattern.test(line) && !line.endsWith("/>") && blockTag !== "summary") {
                i++;
                while (i < cleanedLines.length) {
                    htmlLines.push(cleanedLines[i]);
                    if (closingTagPattern.test(cleanedLines[i])) {
                        i++;
                        break;
                    }
                    i++;
                }
            } else {
                i++;
            }
            const rawHtml = htmlLines.join("\n");
            if (blockTag === "details" && !options.allowUnsafeHtml) {
                const detailsMatch = rawHtml.match(/^(<details\b[^>]*>)\s*\n?(<summary\b[^>]*>[\s\S]*?<\/summary>)\s*\n?([\s\S]*?)\s*<\/details>$/i);
                if (detailsMatch) {
                    const opening = sanitizeHtmlFragment(detailsMatch[1], options);
                    const summary = sanitizeHtmlFragment(detailsMatch[2], options);
                    const body = parseMarkdownToHTML(detailsMatch[3].trim(), options);
                    output.push(`${opening}\n${summary}\n${body}\n</details>`);
                    continue;
                }
            }
            output.push(sanitizeHtmlFragment(rawHtml, options));
            continue;
        }

        // Paragraphs
        const paragraphLines = [];
        while (
            i < cleanedLines.length &&
            cleanedLines[i].trim() &&
            !cleanedLines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/) &&
            !/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(cleanedLines[i]) &&
            !cleanedLines[i].match(/^\s{0,3}#{1,6}\s+/) &&
            !cleanedLines[i].trim().startsWith(">") &&
            !startsTableAt(i) &&
            !getListItemMatch(cleanedLines[i]) &&
            !cleanedLines[i].trim().startsWith("<!--") &&
            !/^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(cleanedLines[i].trim()) &&
            !cleanedLines[i].match(/^\s{0,3}<(details|summary|section|article|figure|figcaption|blockquote|table|thead|tbody|tfoot|tr|th|td|ul|ol|li|dl|dt|dd|audio|video|picture|div|p|a)\b[^>]*>/i) &&
            !((cleanedLines[i].startsWith("    ") || cleanedLines[i].startsWith("\t")) && paragraphLines.length === 0)
            ) {
            if (i + 1 < cleanedLines.length && /^(={2,}|-{2,})\s*$/.test(cleanedLines[i + 1].trim())) {
                break;
            }
            if (i + 1 < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i + 1])) {
                break;
            }
            paragraphLines.push(cleanedLines[i]);
            i++;
        }

        if (paragraphLines.length > 0) {
            const formattedParas = [];
            let currentP = [];
            for (let p = 0; p < paragraphLines.length; p++) {
                const pLine = paragraphLines[p];
                if (pLine.endsWith("  ") || pLine.endsWith("\\")) {
                    currentP.push(pLine.replace(/(\\|\s{2})$/, ""));
                    formattedParas.push(currentP.join(" "));
                    currentP = [];
                } else {
                    currentP.push(pLine.trim());
                }
            }
            if (currentP.length > 0) {
                formattedParas.push(currentP.join(" "));
            }
            const pContent = formattedParas.map(p => parseInline(p, context)).join("<br>\n");
            output.push(`<p>${pContent}</p>`);
        }
    }

    // Append Footnotes if any were used
    if (context.footnoteOrder.length > 0) {
        let fnHtml = `<section class="footnotes">\n<hr>\n<ol>\n`;
        context.footnoteOrder.forEach((fnId) => {
            const rawContent = context.footnotes[fnId] || "";
            const parsedContent = parseInline(rawContent, context);
            const safeId = escapeHtmlAttribute(fnId);
            const referenceCount = context.footnoteReferenceCounts[fnId] || 1;
            let backrefs = "";
            for (let referenceIndex = 1; referenceIndex <= referenceCount; referenceIndex++) {
                const suffix = referenceIndex > 1 ? `-${referenceIndex}` : "";
                backrefs += ` <a href="#fnref-${safeId}${suffix}" class="footnote-backref">&#x21a9;&#xfe0e;</a>`;
            }
            fnHtml += `<li id="fn-${safeId}">${parsedContent}${backrefs}</li>\n`;
        });
        fnHtml += `</ol>\n</section>`;
        output.push(fnHtml);
    }

    return output.join("\n");
}

/**
 * Fetches a Markdown file from a URL/path and renders its content into a target element.
 * @param {string} url - Path to .md file (e.g., 'md-showcase.md')
 * @param {HTMLElement|string} targetElement - DOM element or selector
 * @param {object} [options] - Options passed to parseMarkdownToHTML
 */
async function renderMarkdownFileToElement(url, targetElement, options = {}) {
    const container = typeof targetElement === "string"
        ? (typeof document !== "undefined" && document.querySelector ? document.querySelector(targetElement) : null)
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
