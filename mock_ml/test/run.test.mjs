import { test } from "node:test";
import assert from "node:assert/strict";

import {
    splitTop,
    splitLinesTop,
    findTop,
    matchBalanced,
} from "../src/splitter.js";
import { WireframeError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// splitTop
// ---------------------------------------------------------------------------

test("splitTop: basic pipe split", () => {
    assert.deepEqual(splitTop("a|b|c", "|"), ["a", "b", "c"]);
});

test("splitTop: preserves empty segments", () => {
    assert.deepEqual(splitTop("a||b", "|"), ["a", "", "b"]);
});

test("splitTop: does not trim", () => {
    assert.deepEqual(splitTop(" a | b ", "|"), [" a ", " b "]);
});

test("splitTop: ignores separators inside brackets", () => {
    assert.deepEqual(splitTop("a|[b|c]|d", "|"), ["a", "[b|c]", "d"]);
});

test("splitTop: ignores separators inside parens", () => {
    assert.deepEqual(splitTop("f(a,b)|g()", "|"), ["f(a,b)", "g()"]);
});

test("splitTop: ignores separators inside braces", () => {
    assert.deepEqual(splitTop("x|{a|b}|y", "|"), ["x", "{a|b}", "y"]);
});

test("splitTop: ignores separators inside single quotes", () => {
    assert.deepEqual(splitTop("a|'b|c'|d", "|"), ["a", "'b|c'", "d"]);
});

test("splitTop: ignores separators inside double quotes", () => {
    assert.deepEqual(splitTop("a|\"b|c\"|d", "|"), ["a", "\"b|c\"", "d"]);
});

test("splitTop: honors backslash escape in quotes", () => {
    assert.deepEqual(splitTop("a|'b\\'|c'|d", "|"), ["a", "'b\\'|c'", "d"]);
});

test("splitTop: nested brackets all levels", () => {
    assert.deepEqual(splitTop("[{a|b}|c]|[d]", "|"), ["[{a|b}|c]", "[d]"]);
});

test("splitTop: no separator returns single element", () => {
    assert.deepEqual(splitTop("hello", "|"), ["hello"]);
});

test("splitTop: empty string yields single empty", () => {
    assert.deepEqual(splitTop("", "|"), [""]);
});

test("splitTop: unbalanced bracket throws WireframeError with pos", () => {
    assert.throws(() => splitTop("a|[b|c", "|"), (e) =>
        e instanceof WireframeError && e.pos >= 0);
});

test("splitTop: unterminated quote throws WireframeError", () => {
    assert.throws(() => splitTop("a|'b", "|"), (e) =>
        e instanceof WireframeError && e.pos >= 0);
});

// ---------------------------------------------------------------------------
// splitLinesTop
// ---------------------------------------------------------------------------

test("splitLinesTop: basic newline split", () => {
    assert.deepEqual(splitLinesTop("a\nb\nc"), ["a", "b", "c"]);
});

test("splitLinesTop: brace spanning lines stays one row", () => {
    assert.deepEqual(splitLinesTop("{\na|b\n}"), ["{\na|b\n}"]);
});

test("splitLinesTop: table spanning lines stays one row", () => {
    assert.deepEqual(splitLinesTop("[\n'a'|'b'\n'c'|'d'\n]"),
        ["[\n'a'|'b'\n'c'|'d'\n]"]);
});

test("splitLinesTop: preserves empty lines", () => {
    assert.deepEqual(splitLinesTop("a\n\nb"), ["a", "", "b"]);
});

// ---------------------------------------------------------------------------
// findTop
// ---------------------------------------------------------------------------

test("findTop: finds note arrow at depth 0", () => {
    assert.equal(findTop("button(Show) <- opens modal", "<-"), 13);
});

test("findTop: does not match inside parens", () => {
    assert.equal(findTop("f(a <- b)", "<-"), -1);
});

test("findTop: does not match inside quotes", () => {
    assert.equal(findTop("'a <- b'", "<-"), -1);
});

test("findTop: finds first occurrence at depth 0", () => {
    assert.equal(findTop("a <- b <- c", "<-"), 2);
});

test("findTop: returns -1 when absent", () => {
    assert.equal(findTop("button(Show)", "<-"), -1);
});

// ---------------------------------------------------------------------------
// matchBalanced
// ---------------------------------------------------------------------------

test("matchBalanced: simple parens", () => {
    assert.equal(matchBalanced("f(a,b)", "(", ")", 1), 5);
});

test("matchBalanced: nested brackets", () => {
    assert.equal(matchBalanced("[a[b]c]", "[", "]", 0), 6);
});

test("matchBalanced: mixed nesting returns outer close", () => {
    assert.equal(matchBalanced("{a[b|c]d}", "{", "}", 0), 8);
});

test("matchBalanced: honors quote chars", () => {
    assert.equal(matchBalanced("{a'}'b}", "{", "}", 0), 6);
});

test("matchBalanced: honors escape in quotes", () => {
    assert.equal(matchBalanced("{a\"\\\"}\"b}", "{", "}", 0), 8);
});

test("matchBalanced: unbalanced throws WireframeError", () => {
    assert.throws(() => matchBalanced("[abc", "[", "]", 0), (e) =>
        e instanceof WireframeError && e.pos === 0);
});

test("matchBalanced: mismatched closer throws", () => {
    assert.throws(() => matchBalanced("[abc)", "[", "]", 0), WireframeError);
});

test("matchBalanced: empty brackets return open index + 1", () => {
    assert.equal(matchBalanced("[]", "[", "]", 0), 1);
});

test("matchBalanced: throws if start char is not open", () => {
    assert.throws(() => matchBalanced("abc", "(", ")", 0), WireframeError);
});

// ---------------------------------------------------------------------------
// parser.js
// ---------------------------------------------------------------------------

import { parse } from "../src/parser.js";

function cellText(value, weight = null) {
    return {
        kind: "cell",
        weight,
        content: [{ t: "text", value }],
        note: null,
        borders: null,
        align: null,
        crossAlign: null,
        height: null,
        minHeight: null,
    };
}

test("parse: title extraction + body after blank line", () => {
    const doc = parse("title: My Mock\n\n'a'\n'c'|'d'");
    assert.equal(doc.title, "My Mock");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "col");
    assert.equal(doc.root.children.length, 2);
    assert.deepEqual(doc.root.children[0], cellText("a"));
});

test("parse: single quoted label collapses to cell", () => {
    const doc = parse("'a'");
    assert.deepEqual(doc.root, cellText("a"));
});

test("parse: two-row doc with collapsed first row + row grid second", () => {
    const doc = parse("'a'\n'c'|'d'");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "col");
    assert.equal(doc.root.children.length, 2);
    assert.deepEqual(doc.root.children[0], cellText("a"));
    const row = doc.root.children[1];
    assert.equal(row.kind, "grid");
    assert.equal(row.dir, "row");
    assert.equal(row.children.length, 2);
});

test("parse: table 2x2", () => {
    const doc = parse("[\n'a'|'b'\n'c'|'d'\n]");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "col");
    assert.equal(doc.root.children.length, 2);
    for (const row of doc.root.children) {
        assert.equal(row.kind, "grid");
        assert.equal(row.dir, "row");
        assert.equal(row.children.length, 2);
    }
});

test("parse: {a|b}|c exact mapping (group wrapper present)", () => {
    const doc = parse("{a|b}|c");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.children.length, 2);
    const grp = doc.root.children[0];
    assert.equal(grp.kind, "group");
    assert.equal(grp.child.kind, "grid");
    assert.equal(grp.child.dir, "row");
    assert.equal(grp.child.children.length, 2);
    assert.deepEqual(doc.root.children[1], cellText("c"));
});

test("parse: icon(download) elem", () => {
    const doc = parse("icon(download)");
    const c = doc.root;
    assert.equal(c.kind, "cell");
    assert.equal(c.content[0].t, "elem");
    assert.equal(c.content[0].tag, "icon");
    assert.equal(c.content[0].children[0].value, "download");
});

test("parse: input(bla) elem", () => {
    const doc = parse("input(bla)");
    assert.equal(doc.root.content[0].tag, "input");
});

test("parse: button(Submit) elem", () => {
    const doc = parse("button(Submit)");
    assert.equal(doc.root.content[0].tag, "button");
    assert.equal(doc.root.content[0].children[0].value, "Submit");
});

test("parse: hbutton(Submit) elem", () => {
    const doc = parse("hbutton(Submit)");
    assert.equal(doc.root.content[0].tag, "hbutton");
    assert.equal(doc.root.content[0].children[0].value, "Submit");
});

test("parse: button(icon(download)) nesting", () => {
    const doc = parse("button(icon(download))");
    const btn = doc.root.content[0];
    assert.equal(btn.tag, "button");
    assert.equal(btn.children[0].tag, "icon");
    assert.equal(btn.children[0].children[0].value, "download");
});

test("parse: h1/h2/h3/strong/u elems", () => {
    for (const tag of ["h1", "h2", "h3", "strong", "u"]) {
        const doc = parse(`${tag}(text)`);
        assert.equal(doc.root.content[0].tag, tag, tag);
    }
});

test("parse: size hint weight on cell", () => {
    const doc = parse("'a':2 | 'b'");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.children[0].weight, 2);
    assert.equal(doc.root.children[1].weight, null);
});

test("parse: size hint weight on group", () => {
    const doc = parse("{x\ny}:3 | 'z'");
    assert.equal(doc.root.children[0].kind, "group");
    assert.equal(doc.root.children[0].weight, 3);
});

test("parse: note attaches to last cell", () => {
    const doc = parse("button(Show) <- \"opens modal\"");
    assert.equal(doc.root.note, "opens modal");
    assert.equal(doc.root.content[0].tag, "button");
});

test("parse: inline note <<- attaches to preceding inline element", () => {
    const doc = parse("button(Show) <<- \"opens modal\" button(Hide)");
    assert.equal(doc.root.note, null);
    const buttons = doc.root.content.filter(node => node.t === "elem");
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].tag, "button");
    assert.equal(buttons[0].note, "opens modal");
    assert.equal(buttons[1].tag, "button");
    assert.equal(buttons[1].note, undefined);
});

test("parse: multiple cell-level notes on one line", () => {
    const doc = parse("a <- \"note a\" | b <- 'note b'");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.children[0].note, "note a");
    assert.equal(doc.root.children[1].note, "note b");
});

test("parse: row-level note on bracketed table", () => {
    const doc = parse("[a | b] <- \"note row\"");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.note, "note row");
});

test("parse: footnote def pulled from grid", () => {
    const doc = parse("'Save'sup(3)\nsup(3) opens X");
    assert.equal(doc.footnotes.length, 1);
    assert.equal(doc.footnotes[0].n, "3");
    assert.equal(doc.footnotes[0].text, "opens X");
    // inline sup marker preserved
    assert.equal(doc.root.content[0].value, "Save");
    assert.equal(doc.root.content[1].t, "elem");
    assert.equal(doc.root.content[1].tag, "sup");
});

test("parse: macro def + call expands group with params", () => {
    const doc = parse("$x = {\nuser|$0\npw|$1\n}\n$x(\"mike\",\"123\")");
    assert.equal(doc.root.kind, "group");
    assert.equal(doc.root.child.kind, "grid");
    assert.equal(doc.root.child.dir, "col");
    const row0 = doc.root.child.children[0];
    assert.equal(row0.children[1].content[0].value, "mike");
    const row1 = doc.root.child.children[1];
    assert.equal(row1.children[1].content[0].value, "123");
});

test("parse: inline macro returns node directly", () => {
    const doc = parse("inline $y = {$0|$1}\n$y(a,b)");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.children[0].content[0].value, "a");
});

test("parse: empty cells a||b", () => {
    const doc = parse("a||b");
    assert.equal(doc.root.dir, "row");
    assert.equal(doc.root.children.length, 3);
    assert.equal(doc.root.children[1].content.length, 0);
});

test("parse: unknown element warns + literal text fallback", () => {
    const doc = parse("foo(bar)");
    assert.equal(doc.root.content[0].t, "text");
    assert.equal(doc.root.content[0].value, "foo(bar)");
});

test("parse: errors — unbalanced [", () => {
    assert.throws(() => parse("[abc"), (e) =>
        e instanceof WireframeError && e.pos >= 0);
});

test("parse: errors — unterminated quote", () => {
    assert.throws(() => parse("'abc"), (e) =>
        e instanceof WireframeError && e.pos >= 0);
});

test("parse: errors — unknown macro", () => {
    assert.throws(() => parse("$nonexistent()"), WireframeError);
});

test("parse: errors — recursive macro", () => {
    assert.throws(() => parse("$a = {$b()}\n$b = {$a()}\n$b()"), WireframeError);
});

test("parse: errors — duplicate macro def", () => {
    assert.throws(() => parse("$a = {x}\n$a = {y}"), WireframeError);
});

test("parse: errors — non-numeric weight", () => {
    assert.throws(() => parse("'a':x"), WireframeError);
});

test("parse: bare unquoted word is text label", () => {
    const doc = parse("user");
    assert.deepEqual(doc.root, cellText("user"));
});

// ---------------------------------------------------------------------------
// render.js + index.js
// ---------------------------------------------------------------------------

import { renderToString, renderMock, esc, slug, uniqueId } from "../src/index.js";

test("esc: escapes & < > \" '", () => {
    assert.equal(esc(`<a>"&'`), "&lt;a&gt;&quot;&amp;&#39;");
});

test("slug: basic", () => {
    assert.equal(slug("Hello World!"), "hello-world");
    assert.equal(slug(""), "node");
});

test("uniqueId: dedup with suffix", () => {
    const set = new Set();
    assert.equal(uniqueId("a", set), "a");
    assert.equal(uniqueId("a", set), "a-2");
    assert.equal(uniqueId("a", set), "a-3");
});

test("render: title in data-title", () => {
    const html = renderMock("title: Foo\n\n'a'");
    assert.ok(html.includes("data-title=\"Foo\""));
});

test("render: grid/col depth + room classes", () => {
    const html = renderMock("'a'\n'c'|'d'");
    assert.ok(html.includes("room-col"));
    assert.ok(html.includes("room-row"));
    assert.ok(html.includes("data-depth=\"0\""));
    assert.ok(html.includes("room-leaf"));
});

test("render: {a|b}|c group wrapper + depths", () => {
    const html = renderMock("{a|b}|c");
    assert.ok(html.includes("room-group"));
    // group is at depth 1, its inner grid at depth 2
    assert.ok(html.includes("data-depth=\"1\" data-id=\"group\""));
    assert.ok(html.includes("room-row"));
});

test("render: icon -> sym span", () => {
    const html = renderMock("icon(download)");
    assert.ok(html.includes("<span class=\"sym\">download</span>"));
});

test("render: input with placeholder", () => {
    const html = renderMock("input(bla)");
    assert.ok(html.includes("<input type=\"text\" placeholder=\"bla\">"));
});

test("render: button with text", () => {
    const html = renderMock("button(Submit)");
    assert.ok(html.includes("<button class=\"btn\">Submit</button>"));
});

test("render: hbutton with text", () => {
    const html = renderMock("hbutton(Submit)");
    assert.ok(html.includes("<button class=\"btn btn-primary\">Submit</button>"));
});

test("render: button(icon(download)) nested", () => {
    const html = renderMock("button(icon(download))");
    assert.ok(html.includes("<button class=\"btn-sym\">"));
    assert.ok(html.includes("<span class=\"sym\">download</span>"));
});

test("render: button(icon(download) \"bla\") nested", () => {
    const html = renderMock("button(icon(download) \"bla\")");
    assert.ok(html.includes("<button class=\"btn\">"));
    assert.ok(html.includes("<span class=\"sym\">download</span>"));
    assert.ok(html.includes("bla"));
});

test("render: h1/h2/h3/strong/u tags", () => {
    for (const tag of ["h1", "h2", "h3", "strong", "u"]) {
        const html = renderMock(`${tag}(text)`);
        assert.ok(html.includes(`<${tag}>text</${tag}>`), tag);
    }
});

test("render: size hint flex weight", () => {
    const html = renderMock("'a':2 | 'b'");
    assert.ok(html.includes("flex:2 1 0"));
    assert.ok(html.includes("flex:1 1 0"));
});

test("render: note has-note + mock-note outside mock", () => {
    const html = renderMock("button(Show) <- \"opens modal\"");
    assert.ok(html.includes("has-note"));
    assert.ok(html.includes("data-note-id="));
    assert.ok(html.includes("class=\"mock-note\""));
    assert.ok(html.includes("opens modal"));
    // note box is after closing </div> of .mock
    const mockClose = html.indexOf("</div></div></div>");
    const notesIdx = html.indexOf("mock-notes");
    assert.ok(notesIdx > 0);
});

test("render: inline note <<- renders has-note class on specific inline element", () => {
    const html = renderMock("button(Show) <<- \"opens modal\" button(Hide)");
    // Should wrap only the first button, not the cell or second button
    assert.ok(!html.includes("class=\"room room-leaf has-note\""));
    assert.ok(html.includes("class=\"btn has-note\""));
    assert.ok(html.includes("class=\"btn\""));
    assert.ok(html.includes("opens modal"));
});

test("render: notesAsFootnotes converts notes to footnotes", () => {
    const html = renderMock("button(Show) <- \"opens modal\" | \"text\" <<- \"text note\"", { notesAsFootnotes: true });
    // Check that standard note containers/classes are absent
    assert.ok(!html.includes("class=\"mock-note\""));
    assert.ok(!html.includes("has-note"));
    // Check that footnotes are present
    assert.ok(html.includes("mock-footnote"));
    assert.ok(html.includes("data-footnote=\"1\""));
    assert.ok(html.includes("data-footnote=\"2\""));
    assert.ok(html.includes("opens modal"));
    assert.ok(html.includes("text note"));
    // Check that superscript numbers are rendered inline
    assert.ok(html.includes("<sup>1</sup>"));
    assert.ok(html.includes("<sup>2</sup>"));
});

test("render: hideNotes option hides all notes and footnotes", () => {
    const html = renderMock("button(Show) <- \"opens modal\" | \"text\" <<- \"text note\" | \"Save\"sup(3)\nsup(3) opens X", { hideNotes: true });
    // Check that no notes, no footnotes, and no sup tags are in HTML
    assert.ok(!html.includes("mock-note"));
    assert.ok(!html.includes("has-note"));
    assert.ok(!html.includes("mock-footnote"));
    assert.ok(!html.includes("data-footnote"));
    assert.ok(!html.includes("<sup"));
});

test("render: footnote box outside mock", () => {
    const html = renderMock("'Save'sup(3)\nsup(3) opens X");
    assert.ok(html.includes("data-sup=\"3\""));
    assert.ok(html.includes("mock-footnote"));
    assert.ok(html.includes("data-footnote=\"3\""));
});

test("render: HTML escaping in labels", () => {
    const html = renderMock("'<script>'");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
});

test("render: empty cell renders empty label", () => {
    const html = renderMock("a||b");
    assert.ok(html.includes("class=\"room-label\"></div>"));
});

test("render: macro expansion renders", () => {
    const html = renderMock("$x = {\nuser|$0\npw|$1\n}\n$x(\"mike\",\"123\")");
    assert.ok(html.includes("room-group"));
    assert.ok(html.includes(">mike<"));
    assert.ok(html.includes(">123<"));
});

test("render: data-id uniqueness for duplicate labels", () => {
    const html = renderMock("'a'|'a'|'a'");
    assert.ok(html.includes("data-id=\"a\""));
    assert.ok(html.includes("data-id=\"a-2\""));
    assert.ok(html.includes("data-id=\"a-3\""));
});

test("render: footnotes box absent when no footnotes", () => {
    const html = renderMock("'a'");
    assert.ok(!html.includes("mock-footnotes"));
});

test("render: notes box absent when no notes", () => {
    const html = renderMock("'a'");
    assert.ok(!html.includes("mock-notes"));
});

// ---------------------------------------------------------------------------
// notes.js — connectNotes (real DOM via happy-dom)
// ---------------------------------------------------------------------------

import { connectNotes } from "../src/notes.js";
import { Window } from "happy-dom";

function withDom(fn) {
    const savedDoc = globalThis.document;
    const savedGcs = globalThis.getComputedStyle;
    const win = new Window();
    globalThis.document = win.document;
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    try {
        fn(win);
    } finally {
        globalThis.document = savedDoc;
        globalThis.getComputedStyle = savedGcs;
    }
}

test("connectNotes: creates one <path> per resolvable note", () => {
    withDom(() => {
        const root = globalThis.document.createElement("div");
        root.innerHTML = renderMock("button(Show) <- \"opens modal\"");
        globalThis.document.body.appendChild(root);
        connectNotes(root);
        const paths = root.querySelectorAll("svg.mock-note-lines path");
        assert.equal(paths.length, 1);
    });
});

test("connectNotes: missing target skipped, no throw", () => {
    withDom(() => {
        const root = globalThis.document.createElement("div");
        root.innerHTML = renderMock("button(Show) <- \"opens modal\"");
        globalThis.document.body.appendChild(root);
        root.querySelector(".mock-note").setAttribute("data-note-for", "nope");
        assert.doesNotThrow(() => connectNotes(root));
        const paths = root.querySelectorAll("svg.mock-note-lines path");
        assert.equal(paths.length, 0);
    });
});

test("connectNotes: idempotent — second call clears prior lines", () => {
    withDom(() => {
        const root = globalThis.document.createElement("div");
        root.innerHTML = renderMock("button(Show) <- \"opens modal\"");
        globalThis.document.body.appendChild(root);
        connectNotes(root);
        connectNotes(root);
        const paths = root.querySelectorAll("svg.mock-note-lines path");
        assert.equal(paths.length, 1);
    });
});

test("connectNotes: no-op outside DOM", () => {
    const saved = globalThis.document;
    globalThis.document = undefined;
    try {
        assert.doesNotThrow(() => connectNotes({}));
    } finally {
        globalThis.document = saved;
    }
});

// ---------------------------------------------------------------------------
// border hints (§10)
// ---------------------------------------------------------------------------

test("parse: cell border :ud", () => {
    const doc = parse("'a':ud");
    assert.equal(doc.root.kind, "cell");
    assert.ok(doc.root.borders.has("u"));
    assert.ok(doc.root.borders.has("d"));
    assert.equal(doc.root.borders.size, 2);
});

test("parse: cell border :lr (alias rl)", () => {
    const doc = parse("'a':rl");
    assert.ok(doc.root.borders.has("l"));
    assert.ok(doc.root.borders.has("r"));
    assert.equal(doc.root.borders.size, 2);
});

test("parse: cell border :all", () => {
    const doc = parse("'a':all");
    assert.equal(doc.root.borders.size, 4);
    for (const d of ["u", "d", "l", "r"]) assert.ok(doc.root.borders.has(d));
});

test("parse: cell border single :l", () => {
    const doc = parse("'a':l");
    assert.ok(doc.root.borders.has("l"));
    assert.equal(doc.root.borders.size, 1);
});

test("parse: weight + border combined :2ud", () => {
    const doc = parse("'a':2ud");
    assert.equal(doc.root.weight, 2);
    assert.ok(doc.root.borders.has("u"));
    assert.ok(doc.root.borders.has("d"));
});

test("parse: border on group", () => {
    const doc = parse("{a|b}:ud");
    assert.equal(doc.root.kind, "group");
    assert.ok(doc.root.borders.has("u"));
    assert.ok(doc.root.borders.has("d"));
});

test("parse: table prefix [:ud ...] sets bordersDefault", () => {
    const doc = parse("[:ud 'a'|'b'\n'c'|'d']");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "col");
    assert.ok(doc.root.bordersDefault);
    assert.ok(doc.root.bordersDefault.has("u"));
    assert.ok(doc.root.bordersDefault.has("d"));
});

test("parse: table prefix border inherited by children at render", () => {
    const html = renderMock("[:ud 'a'|'b'\n'c'|'d']");
    // Row 0 cells get border-top and border-bottom. Row 1 cells get border-bottom.
    const topCount = (html.match(/border-top/g) || []).length;
    const botCount = (html.match(/border-bottom/g) || []).length;
    assert.equal(topCount, 2, `expected 2 border-top, got ${topCount}`);
    assert.equal(botCount, 4, `expected 4 border-bottom, got ${botCount}`);
});

test("parse: table prefix with weight [:2ud ...]", () => {
    const doc = parse("[:2ud 'a'|'b']");
    assert.equal(doc.root.weight, 2);
    assert.ok(doc.root.bordersDefault);
    assert.ok(doc.root.bordersDefault.has("u"));
    assert.ok(doc.root.bordersDefault.has("d"));
});

test("parse: table prefix border-only [:l ...]", () => {
    const doc = parse("[:l 'a'|'b']");
    assert.equal(doc.root.weight, null);
    assert.ok(doc.root.bordersDefault);
    assert.ok(doc.root.bordersDefault.has("l"));
    assert.equal(doc.root.bordersDefault.size, 1);
});

test("parse: table without prefix has no bordersDefault", () => {
    const doc = parse("['a'|'b']");
    assert.equal(doc.root.bordersDefault, null);
});

test("parse: invalid border keyword throws", () => {
    assert.throws(() => parse("'a':xyz"), WireframeError);
});

test("parse: borders are case-insensitive", () => {
    const doc = parse("'a':UD");
    assert.ok(doc.root.borders.has("u"));
    assert.ok(doc.root.borders.has("d"));
});

test("render: cell border :ud emits border classes", () => {
    const html = renderMock("'a':ud");
    assert.ok(html.includes("border-top"));
    assert.ok(html.includes("border-bottom"));
    assert.ok(!html.includes("border-left"));
    assert.ok(!html.includes("border-right"));
});

test("render: cell border :all emits all four classes", () => {
    const html = renderMock("'a':all");
    assert.ok(html.includes("border-top"));
    assert.ok(html.includes("border-bottom"));
    assert.ok(html.includes("border-left"));
    assert.ok(html.includes("border-right"));
});

test("render: no border by default", () => {
    const html = renderMock("'a'");
    assert.ok(!html.includes("border-top"));
    assert.ok(!html.includes("border-bottom"));
    assert.ok(!html.includes("border-left"));
    assert.ok(!html.includes("border-right"));
});

test("render: table prefix [:ud ...] applies borders to all cells", () => {
    const html = renderMock("[:ud 'a'|'b'\n'c'|'d']");
    // Row 0 cells get border-top and border-bottom. Row 1 cells get border-bottom.
    const topCount = (html.match(/border-top/g) || []).length;
    const botCount = (html.match(/border-bottom/g) || []).length;
    assert.equal(topCount, 2, `expected 2 border-top, got ${topCount}`);
    assert.equal(botCount, 4, `expected 4 border-bottom, got ${botCount}`);
});

test("render: weight + border combined flex + classes", () => {
    const html = renderMock("'a':2ud | 'b'");
    assert.ok(html.includes("flex:2 1 0"));
    assert.ok(html.includes("border-top"));
    assert.ok(html.includes("border-bottom"));
});

test("render: per-cell border overrides table default", () => {
    const html = renderMock("[:ud 'a':l | 'b']");
    // 'a' should have border-left (its own) + inherited ud
    const aLeafIdx = html.indexOf("data-id=\"a\"");
    assert.ok(aLeafIdx >= 0);
    // Find the class string for the 'a' cell
    const classStart = html.lastIndexOf("class=\"", aLeafIdx) + 7;
    const classEnd = html.indexOf("\"", classStart);
    const aClass = html.slice(classStart, classEnd);
    assert.ok(aClass.includes("border-left"));
    assert.ok(aClass.includes("border-top"));
    assert.ok(aClass.includes("border-bottom"));
});

// ---------------------------------------------------------------------------
// comments (//)
// ---------------------------------------------------------------------------

test("parse: line comment stripped", () => {
    const doc = parse("// this is a comment\n'a'");
    assert.deepEqual(doc.root, cellText("a"));
});

test("parse: trailing comment stripped", () => {
    const doc = parse("'a' // trailing comment");
    assert.deepEqual(doc.root, cellText("a"));
});

test("parse: comment inside quotes preserved", () => {
    const doc = parse("'a // not a comment'");
    assert.equal(doc.root.content[0].value, "a // not a comment");
});

test("parse: comment inside brackets ignored (stays as content)", () => {
    // // inside () is NOT a comment since it's at depth > 0
    const doc = parse("button(Click // me)");
    assert.equal(doc.root.content[0].tag, "button");
    assert.equal(doc.root.content[0].children[0].value, "Click // me");
});

test("parse: comment between rows", () => {
    const doc = parse("'a'\n// comment row\n'b'");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.dir, "col");
    assert.equal(doc.root.children.length, 2);
});

test("parse: comment with pipe and brackets in it", () => {
    const doc = parse("'a'\n// this | has [brackets] and stuff\n'b'");
    assert.equal(doc.root.children.length, 2);
});

// ---------------------------------------------------------------------------
// link element
// ---------------------------------------------------------------------------

test("parse: link(url, text) elem", () => {
    const doc = parse("link(/home, Home)");
    assert.equal(doc.root.content[0].tag, "link");
    assert.equal(doc.root.content[0].children.length, 2);
    assert.equal(doc.root.content[0].children[0].value, "/home");
    assert.equal(doc.root.content[0].children[1].value, "Home");
});

test("parse: link(text) elem", () => {
    const doc = parse("link(Home)");
    assert.equal(doc.root.content[0].tag, "link");
    assert.equal(doc.root.content[0].children.length, 1);
    assert.equal(doc.root.content[0].children[0].value, "Home");
});

test("render: link(url, text) -> <a> with href", () => {
    const html = renderMock("link(/home, Home)");
    assert.ok(html.includes("<a href=\"/home\">Home</a>"));
});

test("render: link(text) -> <a> with # href", () => {
    const html = renderMock("link(Home)");
    assert.ok(html.includes("<a href=\"#\">Home</a>"));
});

test("render: link with icon child", () => {
    const html = renderMock("link(/dl, icon(download))");
    assert.ok(html.includes("href=\"/dl\""));
    assert.ok(html.includes("sym"));
});

// ---------------------------------------------------------------------------
// img element
// ---------------------------------------------------------------------------

test("parse: img(alt) elem", () => {
    const doc = parse("img(avatar)");
    assert.equal(doc.root.content[0].tag, "img");
    assert.equal(doc.root.content[0].children[0].value, "avatar");
});

test("parse: img(url, alt) elem", () => {
    const doc = parse("img(/pic.png, avatar)");
    assert.equal(doc.root.content[0].tag, "img");
    assert.equal(doc.root.content[0].children.length, 2);
    assert.equal(doc.root.content[0].children[0].value, "/pic.png");
    assert.equal(doc.root.content[0].children[1].value, "avatar");
});

test("render: img(alt) -> placeholder div", () => {
    const html = renderMock("img(avatar)");
    assert.ok(html.includes("class=\"mock-img\""));
    assert.ok(html.includes(">avatar<"));
});

test("render: img(url, alt) -> div with data-src", () => {
    const html = renderMock("img(/pic.png, avatar)");
    assert.ok(html.includes("data-src=\"/pic.png\""));
    assert.ok(html.includes(">avatar<"));
});

test("render: img(alt, 1:1) -> aspect ratio square placeholder", () => {
    const html = renderMock("img(avatar, 1:1)");
    assert.ok(html.includes("class=\"mock-img\""));
    assert.ok(html.includes("style=\"aspect-ratio:1/1\""));
    assert.ok(html.includes(">avatar<"));
});

test("render: img(url, alt, 16:9) -> aspect ratio image with url", () => {
    const html = renderMock("img(/pic.png, avatar, 16:9)");
    assert.ok(html.includes("data-src=\"/pic.png\""));
    assert.ok(html.includes("style=\"aspect-ratio:16/9\""));
    assert.ok(html.includes(">avatar<"));
});

// ---------------------------------------------------------------------------
// select element
// ---------------------------------------------------------------------------

test("parse: select(opts) elem", () => {
    const doc = parse("select(Red, Green, Blue)");
    assert.equal(doc.root.content[0].tag, "select");
});

test("render: select -> <select> with options", () => {
    const html = renderMock("select(Red, Green, Blue)");
    assert.ok(html.includes("<select>"));
    assert.ok(html.includes("<option>Red</option>"));
    assert.ok(html.includes("<option>Green</option>"));
    assert.ok(html.includes("<option>Blue</option>"));
});

test("render: select single option", () => {
    const html = renderMock("select(Only)");
    assert.ok(html.includes("<option>Only</option>"));
});

// ---------------------------------------------------------------------------
// badge and tag elements
// ---------------------------------------------------------------------------

test("parse: htag(New) elem", () => {
    const doc = parse("htag(New)");
    assert.equal(doc.root.content[0].tag, "htag");
    assert.equal(doc.root.content[0].children[0].value, "New");
});

test("parse: tag(v2.0) elem", () => {
    const doc = parse("tag(v2.0)");
    assert.equal(doc.root.content[0].tag, "tag");
    assert.equal(doc.root.content[0].children[0].value, "v2.0");
});

test("render: htag -> span.tag.tag-highlight", () => {
    const html = renderMock("htag(New)");
    assert.ok(html.includes("<span class=\"tag tag-highlight\">New</span>"));
});

test("render: tag -> span.tag", () => {
    const html = renderMock("tag(v2.0)");
    assert.ok(html.includes("<span class=\"tag\">v2.0</span>"));
});

// ---------------------------------------------------------------------------
// hr (divider) element
// ---------------------------------------------------------------------------

test("parse: hr() elem", () => {
    const doc = parse("hr()");
    assert.equal(doc.root.content[0].tag, "hr");
});

test("render: hr -> <hr> element", () => {
    const html = renderMock("hr()");
    assert.ok(html.includes("<hr>"));
});

// ---------------------------------------------------------------------------
// spacer element
// ---------------------------------------------------------------------------

test("parse: spacer() elem", () => {
    const doc = parse("spacer()");
    assert.equal(doc.root.content[0].tag, "spacer");
});

test("render: spacer -> div.flex-1", () => {
    const html = renderMock("spacer()");
    assert.ok(html.includes("<div class=\"flex-1\"></div>"));
});

// ---------------------------------------------------------------------------
// alignment hints (@align)
// ---------------------------------------------------------------------------

test("parse: cell align @center", () => {
    const doc = parse("'a':@center");
    assert.equal(doc.root.align, "center");
});

test("parse: cell align @left", () => {
    const doc = parse("'a':@left");
    assert.equal(doc.root.align, "left");
});

test("parse: cell align @right", () => {
    const doc = parse("'a':@right");
    assert.equal(doc.root.align, "right");
});

test("parse: cell align @justify", () => {
    const doc = parse("'a':@justify");
    assert.equal(doc.root.align, "justify");
});

test("parse: cell align short form @c", () => {
    const doc = parse("'a':@c");
    assert.equal(doc.root.align, "center");
});

test("parse: cell align short form @l @r @j", () => {
    assert.equal(parse("'a':@l").root.align, "left");
    assert.equal(parse("'a':@r").root.align, "right");
    assert.equal(parse("'a':@j").root.align, "justify");
});

test("parse: align case-insensitive", () => {
    const doc = parse("'a':@CENTER");
    assert.equal(doc.root.align, "center");
});

test("parse: align + weight combined @center2", () => {
    const doc = parse("'a':@center2");
    assert.equal(doc.root.align, "center");
    assert.equal(doc.root.weight, 2);
});

test("parse: align + weight + border combined @center2ud", () => {
    const doc = parse("'a':@center2ud");
    assert.equal(doc.root.align, "center");
    assert.equal(doc.root.weight, 2);
    assert.ok(doc.root.borders.has("u"));
    assert.ok(doc.root.borders.has("d"));
});

test("parse: align on group", () => {
    const doc = parse("{a|b}:@center");
    assert.equal(doc.root.kind, "group");
    assert.equal(doc.root.align, "center");
});

test("parse: align on grid (table)", () => {
    const doc = parse("[:@center 'a'|'b'\n'c'|'d']");
    assert.equal(doc.root.kind, "grid");
    assert.equal(doc.root.align, "center");
});

test("parse: invalid align throws", () => {
    assert.throws(() => parse("'a':@xyz"), WireframeError);
});

test("render: cell align @center emits text-align", () => {
    const html = renderMock("'a':@center");
    assert.ok(html.includes("text-align:center"));
});

test("render: cell align @right emits text-align", () => {
    const html = renderMock("'a':@right");
    assert.ok(html.includes("text-align:right"));
});

test("render: no align by default (no text-align)", () => {
    const html = renderMock("'a'");
    assert.ok(!html.includes("text-align"));
});

test("render: group align @center emits justify-content", () => {
    const html = renderMock("{a|b}:@center");
    assert.ok(html.includes("justify-content:center"));
});

test("render: grid align emits justify-content", () => {
    const html = renderMock("[:@center 'a'|'b'\n'c'|'d']");
    assert.ok(html.includes("justify-content:center"));
});

test("render: align + weight + border combined render", () => {
    const html = renderMock("'a':@center2ud");
    assert.ok(html.includes("text-align:center"));
    assert.ok(html.includes("flex:2 1 0"));
    assert.ok(html.includes("border-top"));
    assert.ok(html.includes("border-bottom"));
});

test("parse: inline macro invocation within cell text", () => {
    const doc = parse("$new = { htag(New) }\nlink(Databases) $new()");
    const cell = doc.root;
    assert.equal(cell.kind, "cell");
    assert.equal(cell.content.length, 3);
    assert.equal(cell.content[0].tag, "link");
    assert.equal(cell.content[1].value, " ");
    assert.equal(cell.content[2].tag, "htag");
});

test("render: inline macro inside link renders correctly", () => {
    const html = renderMock("$new = { htag(New) }\nlink(Databases) $new()");
    assert.ok(html.includes("<a href=\"#\">Databases</a> <span class=\"tag tag-highlight\">New</span>"));
});

test("parse & render: min_height metadata", () => {
    const doc = parse("min_height: 500\n'a'");
    assert.equal(doc.minHeight, "500");
    const html = renderMock("min_height: 500\n'a'");
    assert.ok(html.includes("style=\"min-height:500px\""));
});

test("parse: h and min-h modifiers", () => {
    const doc = parse("'a':h80 | 'b':min-h100% | 'c':h2remmin-h10px");
    const row = doc.root;
    assert.equal(row.children[0].height, "80px");
    assert.equal(row.children[1].minHeight, "100%");
    assert.equal(row.children[2].height, "2rem");
    assert.equal(row.children[2].minHeight, "10px");
});

test("render: h and min-h styles", () => {
    const html = renderMock("'a':h80 | 'b':min-h100");
    assert.ok(html.includes("height:80px"));
    assert.ok(html.includes("min-height:100px"));
});

test("render: default flex values for column layout", () => {
    const html = renderMock("'a'\n'b'");
    const aIdx = html.indexOf("data-id=\"a\"");
    const classStart = html.lastIndexOf("style=\"", aIdx);
    const styleVal = html.slice(classStart, html.indexOf("\"", classStart + 7));
    assert.ok(styleVal.includes("flex:0 1 auto"));
});

test("render: spacer default flex value is flex-grow 1", () => {
    const html = renderMock("'a'\nspacer()\n'b'");
    const spacerIdx = html.indexOf("data-id=\"spacer\"");
    const styleStart = html.indexOf("style=\"", spacerIdx);
    const styleVal = html.slice(styleStart, html.indexOf("\"", styleStart + 7));
    assert.ok(styleVal.includes("flex:1 1 0"));
});

test("parse: vertical alignment modifiers", () => {
    const doc = parse("'a':@top | 'b':@bottom | 'c':@middle | 'd':@t | 'e':@b | 'f':@m");
    const row = doc.root;
    assert.equal(row.children[0].crossAlign, "flex-start");
    assert.equal(row.children[1].crossAlign, "flex-end");
    assert.equal(row.children[2].crossAlign, "center");
    assert.equal(row.children[3].crossAlign, "flex-start");
    assert.equal(row.children[4].crossAlign, "flex-end");
    assert.equal(row.children[5].crossAlign, "center");
});

test("parse: combined alignment modifiers", () => {
    const doc = parse("'a':@center@top | 'b':@c@t");
    const row = doc.root;
    assert.equal(row.children[0].align, "center");
    assert.equal(row.children[0].crossAlign, "flex-start");
    assert.equal(row.children[1].align, "center");
    assert.equal(row.children[1].crossAlign, "flex-start");
});

test("render: vertical alignment styles", () => {
    const html = renderMock("'a':@top | 'b':@middle");
    assert.ok(html.includes("align-self:flex-start;align-items:flex-start"));
    assert.ok(html.includes("align-self:center;align-items:center"));
});

