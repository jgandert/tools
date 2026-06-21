// AST → HTML string renderer. Flexbox divs, no CSS/SVG in the mock itself.

// --- utilities (§6) ---

export function slug(text) {
    const s = String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return s || "node";
}

export function uniqueId(base, set) {
    if (!set.has(base)) {
        set.add(base);
        return base;
    }
    let n = 2;
    while (set.has(`${base}-${n}`)) n++;
    const id = `${base}-${n}`;
    set.add(id);
    return id;
}

// --- escaping ---

export function esc(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// --- text helpers ---

function flattenText(inlines) {
    let out = "";
    for (const node of inlines) {
        if (node.t === "text") out += node.value;
        else {
            if (node.tag === "icon") out += node.children.map(c => c.t === "text" ? c.value : "").join("");
            else out += flattenText(node.children);
        }
    }
    return out;
}

function isIconOnly(children) {
    const nonWhitespace = children.filter(c => !(c.t === "text" && c.value.trim() === ""));
    return nonWhitespace.length === 1 && nonWhitespace[0].t === "elem" && nonWhitespace[0].tag === "icon";
}

function applyInlineNote(node, tagHtml, ctx) {
    if (node.note === null || node.note === undefined) return tagHtml;
    if (ctx.hideNotes) return tagHtml;
    if (ctx.notesAsFootnotes) {
        const fnNum = ctx.notesAsFootnotesCounter++;
        ctx.notesAsFootnotesList.push({ n: String(fnNum), text: node.note });
        return `${tagHtml}<sup data-sup="${fnNum}">${fnNum}</sup>`;
    }
    ctx.noteIdCounter += 1;
    const nid = `mock-note-${ctx.noteIdCounter}`;
    ctx.notes.push({ nid, targetId: nid, text: node.note });
    const classMatch = /^(<[a-z0-9]+[^>]*class=")([^"]*)(")/i.exec(tagHtml);
    if (classMatch) {
        return tagHtml.replace(classMatch[0], `${classMatch[1]}${classMatch[2]} has-note${classMatch[3]} data-note-id="${nid}"`);
    }
    const tagMatch = /^(<[a-z0-9]+)/i.exec(tagHtml);
    if (tagMatch) {
        return tagHtml.replace(tagMatch[0], `${tagMatch[0]} class="has-note" data-note-id="${nid}"`);
    }
    return tagHtml;
}

function inlineHtml(inlines, ctx) {
    let html = "";
    for (const node of inlines) {
        if (node.t === "text") {
            if (node.note !== null && node.note !== undefined) {
                if (ctx.hideNotes) {
                    html += esc(node.value);
                } else if (ctx.notesAsFootnotes) {
                    const fnNum = ctx.notesAsFootnotesCounter++;
                    ctx.notesAsFootnotesList.push({ n: String(fnNum), text: node.note });
                    html += `${esc(node.value)}<sup data-sup="${fnNum}">${fnNum}</sup>`;
                } else {
                    ctx.noteIdCounter += 1;
                    const nid = `mock-note-${ctx.noteIdCounter}`;
                    ctx.notes.push({ nid, targetId: nid, text: node.note });
                    html += `<span class="has-note" data-note-id="${nid}">${esc(node.value)}</span>`;
                }
            } else {
                html += esc(node.value);
            }
            continue;
        }
        // elem
        let tagHtml = "";
        switch (node.tag) {
            case "icon":
                tagHtml = `<span class="sym">${esc(node.children.map(c => c.t === "text" ? c.value : "").join(""))}</span>`;
                break;
            case "input":
                tagHtml = `<input type="text" placeholder="${esc(flattenText(node.children))}">`;
                break;
            case "button": {
                const cls = isIconOnly(node.children) ? "btn-sym" : "btn";
                tagHtml = `<button class="${cls}">${inlineHtml(node.children, ctx)}</button>`;
            }
                break;
            case "hbutton": {
                const cls = isIconOnly(node.children) ? "btn-sym btn-primary" : "btn btn-primary";
                tagHtml = `<button class="${cls}">${inlineHtml(node.children, ctx)}</button>`;
            }
                break;
            case "h1":
            case "h2":
            case "h3":
                tagHtml = `<${node.tag}>${inlineHtml(node.children, ctx)}</${node.tag}>`;
                break;
            case "strong":
                tagHtml = `<strong>${inlineHtml(node.children, ctx)}</strong>`;
                break;
            case "u":
                tagHtml = `<u>${inlineHtml(node.children, ctx)}</u>`;
                break;
            case "sup":
                if (ctx.hideNotes) {
                    tagHtml = "";
                } else {
                    tagHtml = `<sup data-sup="${esc(flattenText(node.children))}">${esc(flattenText(node.children))}</sup>`;
                }
                break;
            case "link":
                // link(url, text) or link(text) — first child is URL if two Texts, else text only
            {
                const kids = node.children;
                let href = "#";
                let label = inlineHtml(kids, ctx);
                // If first child is text and there's a second child, treat first as URL
                if (kids.length >= 2 && kids[0].t === "text") {
                    href = esc(kids[0].value);
                    label = inlineHtml(kids.slice(1), ctx);
                }
                tagHtml = `<a href="${href}">${label}</a>`;
            }
                break;
            case "img":
                // img(alt) or img(url, alt) — renders as placeholder div
            {
                const kids = [...node.children];
                let ratio = null;
                const ratioIdx = kids.findIndex(c => c.t === "text" && /^\d+[:/]\d+$/.test(c.value.trim()));
                if (ratioIdx >= 0) {
                    ratio = kids[ratioIdx].value.trim();
                    kids.splice(ratioIdx, 1);
                }
                let alt = esc(flattenText(kids));
                let src = "";
                if (kids.length >= 2 && kids[0].t === "text") {
                    src = esc(kids[0].value);
                    alt = esc(flattenText(kids.slice(1)));
                }
                let styleAttr = "";
                if (ratio) {
                    const cssRatio = ratio.replace(":", "/");
                    styleAttr = ` style="aspect-ratio:${cssRatio}"`;
                }
                tagHtml = `<div class="mock-img"${styleAttr} data-src="${src}">${alt}</div>`;
            }
                break;
            case "select":
                // select(opt1, opt2, ...) — each child text becomes an option
            {
                const opts = node.children
                    .map(c => c.t === "text" ? `<option>${esc(c.value)}</option>` : "")
                    .join("");
                tagHtml = `<select>${opts}</select>`;
            }
                break;
            case "htag":
                tagHtml = `<span class="tag tag-highlight">${inlineHtml(node.children, ctx)}</span>`;
                break;
            case "tag":
                tagHtml = `<span class="tag">${inlineHtml(node.children, ctx)}</span>`;
                break;
            case "hr":
                tagHtml = "<hr>";
                break;
            case "spacer":
                tagHtml = "<div class=\"flex-1\"></div>";
                break;
            default:
                tagHtml = esc(flattenText([node]));
        }
        html += applyInlineNote(node, tagHtml, ctx);
    }
    return html;
}

// --- border resolution ---

const BORDER_CLASS = {
    u: "border-top",
    d: "border-bottom",
    l: "border-left",
    r: "border-right",
};

function borderClasses(borders) {
    if (!borders || borders.size === 0) return "";
    const parts = [];
    for (const d of ["u", "d", "l", "r"]) {
        if (borders.has(d)) parts.push(BORDER_CLASS[d]);
    }
    return parts.length ? " " + parts.join(" ") : "";
}

// --- node rendering ---

// If the node has a note, register it and return the extra attrs string
// (` data-note-id="..."` — caller adds `has-note` to the class list itself).
function registerNote(node, id, ctx) {
    if (node.note === null || node.note === undefined) return "";
    if (ctx.hideNotes || ctx.notesAsFootnotes) return "";
    ctx.noteIdCounter += 1;
    const nid = `mock-note-${ctx.noteIdCounter}`;
    ctx.notes.push({ nid, targetId: id, text: node.note });
    return ` data-note-id="${nid}"`;
}

function mergeBorders(own, inherited) {
    if (!own) return inherited;
    if (!inherited) return own;
    const out = new Set(own);
    for (const b of inherited) out.add(b);
    return out;
}

function resolveInheritedBorders(inheritedBd, posInfo) {
    if (!inheritedBd) return null;
    if (!posInfo) return inheritedBd;
    const { r, numRows, c, numCols } = posInfo;
    const resolved = new Set();
    if (inheritedBd.has("u")) {
        if (r === 0 || !inheritedBd.has("d")) {
            resolved.add("u");
        }
    }
    if (inheritedBd.has("d")) {
        resolved.add("d");
    }
    if (inheritedBd.has("l")) {
        if (c === 0 || !inheritedBd.has("r")) {
            resolved.add("l");
        }
    }
    if (inheritedBd.has("r")) {
        resolved.add("r");
    }
    return resolved;
}

function nodeStyle(node, parentDir) {
    const parts = [];

    if (node.kind === "grid") {
        parts.push("display:flex");
        parts.push(`flex-direction:${node.dir === "row" ? "row" : "column"}`);
    } else if (node.kind === "group") {
        parts.push("display:flex");
    }

    // flex calculation
    const isSpacer = node.kind === "cell" && node.content.length === 1 && node.content[0].t === "elem" && node.content[0].tag === "spacer";
    let grow = 0;
    let shrink = 1;
    let basis = "auto";

    if (node.weight !== null) {
        grow = node.weight;
        basis = "0";
    } else if (isSpacer) {
        grow = 1;
        basis = "0";
    } else if (parentDir === "row") {
        grow = 1;
        basis = "0";
    }

    parts.push(`flex:${grow} ${shrink} ${basis}`);

    if (node.align) {
        if (node.kind === "cell") {
            parts.push(`text-align:${node.align}`);
        } else {
            parts.push(`justify-content:${node.align}`);
        }
    }

    if (node.crossAlign) {
        if (node.kind === "cell") {
            parts.push(`align-self:${node.crossAlign}`);
            parts.push(`align-items:${node.crossAlign}`);
        } else {
            parts.push(`align-items:${node.crossAlign}`);
        }
    }

    if (node.height) {
        parts.push(`height:${node.height}`);
    }
    if (node.minHeight) {
        parts.push(`min-height:${node.minHeight}`);
    }

    return parts.join(";");
}

function renderNode(node, depth, ctx, inheritedBd, posInfo = null, parentDir = "col") {
    const resolvedInherited = (node.kind === "cell") ? resolveInheritedBorders(inheritedBd, posInfo) : null;
    const effectiveBorders = mergeBorders(node.borders, resolvedInherited);

    if (node.kind === "grid") {
        const id = uniqueId("grid", ctx.ids);
        let cls = `room room-parent room-${node.dir}`;
        if (node.isTable) cls += " room-table";
        let extra = registerNote(node, id, ctx);
        if (extra) cls += " has-note";
        cls += borderClasses(effectiveBorders);
        const style = nodeStyle(node, parentDir);
        const childInherited = node.bordersDefault || inheritedBd;
        let html = `<div class="${cls}" data-depth="${depth}" data-id="${id}"${extra} style="${style}">`;
        if (!ctx.hideNotes && ctx.notesAsFootnotes && node.note !== null && node.note !== undefined) {
            const fnNum = ctx.notesAsFootnotesCounter++;
            ctx.notesAsFootnotesList.push({ n: String(fnNum), text: node.note });
            html += `<sup data-sup="${fnNum}">${fnNum}</sup>`;
        }

        if (node.dir === "col") {
            const numRows = node.children.length;
            html += node.children.map((c, r) => {
                const childPos = { r, numRows, c: posInfo?.c ?? 0, numCols: posInfo?.numCols ?? 1 };
                return renderNode(c, depth + 1, ctx, childInherited, childPos, "col");
            }).join("");
        } else {
            const numCols = node.children.length;
            html += node.children.map((c, colIdx) => {
                const childPos = {
                    r: posInfo?.r ?? 0,
                    numRows: posInfo?.numRows ?? 1,
                    c: colIdx,
                    numCols,
                };
                return renderNode(c, depth + 1, ctx, childInherited, childPos, "row");
            }).join("");
        }

        html += "</div>";
        return html;
    }

    if (node.kind === "group") {
        const id = uniqueId("group", ctx.ids);
        let cls = "room room-parent room-group";
        if (node.isTable) cls += " room-table";
        let extra = registerNote(node, id, ctx);
        if (extra) cls += " has-note";
        cls += borderClasses(effectiveBorders);
        const style = nodeStyle(node, parentDir);
        const childInherited = node.bordersDefault || inheritedBd;
        let html = `<div class="${cls}" data-depth="${depth}" data-id="${id}"${extra} style="${style}">`;
        if (!ctx.hideNotes && ctx.notesAsFootnotes && node.note !== null && node.note !== undefined) {
            const fnNum = ctx.notesAsFootnotesCounter++;
            ctx.notesAsFootnotesList.push({ n: String(fnNum), text: node.note });
            html += `<sup data-sup="${fnNum}">${fnNum}</sup>`;
        }
        html += renderNode(node.child, depth + 1, ctx, childInherited, posInfo, "row");
        html += "</div>";
        return html;
    }

    // cell
    const textContent = flattenText(node.content);
    const baseId = textContent
        ? slug(textContent)
        : (node.content.length > 0 && node.content[0].t === "elem" ? node.content[0].tag : "node");
    const id = uniqueId(baseId, ctx.ids);
    let cls = "room room-leaf";
    if (node.isTable) cls += " room-table";
    let extra = registerNote(node, id, ctx);
    if (extra) cls += " has-note";
    cls += borderClasses(effectiveBorders);
    const style = nodeStyle(node, parentDir);
    let labelHtml = inlineHtml(node.content, ctx);
    if (!ctx.hideNotes && ctx.notesAsFootnotes && node.note !== null && node.note !== undefined) {
        const fnNum = ctx.notesAsFootnotesCounter++;
        ctx.notesAsFootnotesList.push({ n: String(fnNum), text: node.note });
        labelHtml += `<sup data-sup="${fnNum}">${fnNum}</sup>`;
    }
    let html = `<div class="${cls}" data-depth="${depth}" data-id="${id}"${extra} style="${style}">`;
    html += `<div class="room-label">${labelHtml}</div></div>`;
    return html;
}

// --- top-level ---

export function renderToString(doc, options = {}) {
    const ctx = {
        ids: new Set(),
        notes: [],
        noteIdCounter: 0,
        notesAsFootnotes: !!options.notesAsFootnotes,
        notesAsFootnotesCounter: (doc.footnotes ? doc.footnotes.length : 0) + 1,
        notesAsFootnotesList: [],
        hideNotes: !!options.hideNotes,
    };

    let mockAttr = "";
    if (doc.title) mockAttr = ` data-title="${esc(doc.title)}"`;

    let mockStyle = "";
    if (doc.minHeight) {
        const mh = /^\d+$/.test(doc.minHeight) ? `${doc.minHeight}px` : doc.minHeight;
        mockStyle = ` style="min-height:${esc(mh)}"`;
    }

    let html = "<div class=\"mock-root\">";
    html += `<div class="mock"${mockAttr}${mockStyle}>`;
    html += renderNode(doc.root, 0, ctx, null, null, "col");
    html += "</div>";

    if (!ctx.hideNotes && ctx.notes.length > 0) {
        html += "<div class=\"mock-notes\">";
        for (const note of ctx.notes) {
            html += `<div class="mock-note" data-note-for="${note.nid}" id="${note.nid}">${esc(note.text)}</div>`;
        }
        html += "</div>";
    }

    const allFootnotes = [
        ...(doc.footnotes || []),
        ...ctx.notesAsFootnotesList,
    ];

    if (!ctx.hideNotes && allFootnotes.length > 0) {
        html += "<div class=\"mock-footnotes\">";
        for (const fn of allFootnotes) {
            html += `<div class="mock-footnote" data-footnote="${esc(fn.n)}"><sup>${esc(fn.n)}</sup> ${esc(fn.text)}</div>`;
        }
        html += "</div>";
    }

    html += "</div>";
    return html;
}
