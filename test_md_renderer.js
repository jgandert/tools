/**
 * Expanded test suite for md-renderer.js
 * Run with: bun test_md_renderer.js
 */

const fs = require("fs");
const path = require("path");
const {
    parseMarkdownToHTML,
    renderMarkdownFileToElement,
    parseMarkdownToModalHTML,
    renderMarkdownFileToModal,
} = require("./md-renderer.js");

console.log("==============================================");
console.log("      Running md-renderer.js Test Suite      ");
console.log("==============================================\n");

let totalTests = 0;
let passedTests = 0;

function assert(description, condition) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  [PASS] ${description}`);
    } else {
        console.error(`  [FAIL] ${description}`);
    }
}

function assertEqual(description, actual, expected) {
    totalTests++;
    if (actual === expected) {
        passedTests++;
        console.log(`  [PASS] ${description}`);
    } else {
        console.error(`  [FAIL] ${description}`);
        console.error(`         Expected: ${JSON.stringify(expected)}`);
        console.error(`         Actual:   ${JSON.stringify(actual)}`);
    }
}

function assertThrows(description, callback, expectedMessage) {
    try {
        callback();
        assert(description, false);
    } catch (error) {
        assert(description, error instanceof Error && error.message.includes(expectedMessage));
    }
}

// --- Test Group 1: Documentation-Style Integration Fixture ---
console.log("Test Group 1: Documentation-Style Integration Fixture");

const documentationFixture = [
    "# query type",
    "",
    "## `p:` playlist queries",
    "",
    "Normal search implies `t:` track search. See [ordering](#ordering).",
    "",
    "| query | meaning |",
    "|-------|---------|",
    "| `X Y` | implicit **and** — adjacent predicates both apply |",
    "| `rating = 1` | rating is a `0..1` fraction; `1` = 100% = 5★ |",
    "",
    "- `:avg` is the normal (unweighted) average",
    "- `:wbav` is the length-weighted bayesian average",
    "",
    "# ordering",
].join("\n");
const documentationFixtureHtml = parseMarkdownToHTML(documentationFixture);

assert("Documentation fixture contains H1 heading with id", documentationFixtureHtml.includes('<h1 id="query-type">query type</h1>'));
assert("Documentation fixture contains code-bearing H2 heading", documentationFixtureHtml.includes('<h2 id="p-playlist-queries"><code>p:</code> playlist queries</h2>'));
assert("Documentation fixture wraps dense table", documentationFixtureHtml.includes('<div class="table-container"><table>'));
assert("Documentation fixture renders fragment link", documentationFixtureHtml.includes('<a href="#ordering" target="_blank" rel="noopener">ordering</a>'));
assert("Documentation fixture renders inline strong and code in table cells", documentationFixtureHtml.includes('implicit <strong>and</strong> — adjacent predicates both apply') && documentationFixtureHtml.includes('<code>0..1</code> fraction'));
assert("Documentation fixture preserves Unicode symbols", documentationFixtureHtml.includes("5★"));
assert("Documentation fixture renders code-heavy bullet list", documentationFixtureHtml.includes('<ul><li><code>:avg</code> is the normal (unweighted) average</li>'));
assert("Documentation fixture leaves no internal token placeholders", !documentationFixtureHtml.includes("CODE_TOKEN") && !documentationFixtureHtml.includes("\uFFFC"));

// --- Test Group 2: Inline Formatting & Escaping ---
console.log("\nTest Group 2: Inline Formatting & Escaping");

const edgeCaseMarkdown = [
    "# Header with `inline code` and **bold** ###",
    "",
    "XSS Test: <script>alert('xss')</script> and `a < b && c > d`.",
    "Multiple code blocks: `first` and `second`.",
    "Math multiplication: 2 * 3 * 4 should not be italic.",
    "Underscore filename: file_name_v1_final should not be italic.",
    "",
    "## Table with escaped pipes & alignment",
    "| Left | Center | Right |",
    "| :--- | :---: | ---: |",
    "| `a \\| b` | `t:` | cell |",
    "| | `r:` | `code with <tag>` |",
    "",
    "> Note block line 1 with `code`.",
    "> Note block line 2.",
    "",
    "- Unordered item 1",
    "- Unordered item 2",
    "",
    "1. Ordered item 1",
    "2. Ordered item 2 with [Link](https://example.com)",
    "",
    "---",
    "",
    "```js",
    "console.log(\"Fenced code block\");",
    "```",
].join("\n");

const html2 = parseMarkdownToHTML(edgeCaseMarkdown);

assert("HTML tags in body text escaped", html2.includes("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"));
assert("HTML tags inside code blocks escaped", html2.includes("<code>code with &lt;tag&gt;</code>"));
assert("Multiple code blocks on single line parsed", html2.includes("<code>first</code>") && html2.includes("<code>second</code>"));
assert("Multiplication 2 * 3 * 4 preserved", !html2.includes("2 <em> 3 </em> 4"));
assert("Underscore filename file_name_v1_final preserved", !html2.includes("file<em>name</em>v1_final"));
assert("Trailing hashes in H1 header stripped", html2.includes("<h1 id=\"header-with-inline-code-and-bold\">Header with <code>inline code</code> and <strong>bold</strong></h1>"));
assert("Table escaped pipe handled inside cell", html2.includes("<code>a | b</code>"));
assert("Table alignment parsed into style attributes", html2.includes("style=\"text-align: center;\"") && html2.includes("style=\"text-align: right;\""));
assert("Note block created for blockquote", html2.includes("<div class=\"note\">") && html2.includes("<code>code</code>"));
assert("Unordered list created", html2.includes("<ul><li>Unordered item 1</li>"));
assert("Ordered list created", html2.includes("<ol><li>Ordered item 1</li>"));
assert("Markdown link parsed", html2.includes("<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\">Link</a>"));
assert("Horizontal rule rendered", html2.includes("<hr>"));
assert("Fenced code block rendered with escaped quotes", html2.includes("<pre><code class=\"language-js\">console.log(&quot;Fenced code block&quot;);</code></pre>"));

// --- Test Group 3: Detailed Emphasis & Link Edge Cases ---
console.log("\nTest Group 3: Detailed Emphasis & Link Edge Cases");

assertEqual("Triple asterisk bold-italic", parseMarkdownToHTML("***bold italic text***"), "<p><strong><em>bold italic text</em></strong></p>");
assertEqual("Triple underscore bold-italic", parseMarkdownToHTML("___bold italic text___"), "<p><strong><em>bold italic text</em></strong></p>");
assertEqual("Double asterisk bold", parseMarkdownToHTML("**bold text**"), "<p><strong>bold text</strong></p>");
assertEqual("Double underscore bold", parseMarkdownToHTML("__bold text__"), "<p><strong>bold text</strong></p>");
assertEqual("Single asterisk italic", parseMarkdownToHTML("*italic text*"), "<p><em>italic text</em></p>");
assertEqual("Single underscore italic", parseMarkdownToHTML("_italic text_"), "<p><em>italic text</em></p>");
assertEqual("Link with query string", parseMarkdownToHTML("[Search](https://example.com/search?q=test&lang=en)"), "<p><a href=\"https://example.com/search?q=test&amp;lang=en\" target=\"_blank\" rel=\"noopener\">Search</a></p>");
assertEqual("Link with special HTML in link text", parseMarkdownToHTML("[<Home>](https://example.com)"), "<p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\">&lt;Home&gt;</a></p>");
assertEqual("Link wrapping bold text", parseMarkdownToHTML("[**Bold Link**](https://example.com)"), "<p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\"><strong>Bold Link</strong></a></p>");
assertEqual("Link wrapping multiple inline code spans", parseMarkdownToHTML("[`bevy_scene` has been renamed to `bevy_world_serialization`](#target)"), "<p><a href=\"#target\" target=\"_blank\" rel=\"noopener\"><code>bevy_scene</code> has been renamed to <code>bevy_world_serialization</code></a></p>");

assertEqual("Link wrapping bold text with multiple inline code spans", parseMarkdownToHTML("[**`code` and `more`**](#target)"), "<p><a href=\"#target\" target=\"_blank\" rel=\"noopener\"><strong><code>code</code> and <code>more</code></strong></a></p>");
assertEqual("Bold text wrapping link with inline code", parseMarkdownToHTML("**[`code`](#target)**"), "<p><strong><a href=\"#target\" target=\"_blank\" rel=\"noopener\"><code>code</code></a></strong></p>");
assertEqual("Link wrapping escaped punctuation", parseMarkdownToHTML("[literal \\*](#target)"), "<p><a href=\"#target\" target=\"_blank\" rel=\"noopener\">literal *</a></p>");
assertEqual("Link wrapping safe inline HTML", parseMarkdownToHTML("[press <kbd>K</kbd>](#target)"), "<p><a href=\"#target\" target=\"_blank\" rel=\"noopener\">press <kbd>K</kbd></a></p>");
assertEqual("Multiple links restore their own inline code", parseMarkdownToHTML("[`one`](#one) and [`two`](#two)"), "<p><a href=\"#one\" target=\"_blank\" rel=\"noopener\"><code>one</code></a> and <a href=\"#two\" target=\"_blank\" rel=\"noopener\"><code>two</code></a></p>");

const nestedTokenStressMarkdown = Array.from({ length: 1_000 }, (_, index) => "[`item-" + index + "`](#item-" + index + ")").join(" ");
const nestedTokenStressHtml = parseMarkdownToHTML(nestedTokenStressMarkdown);
assert("Large nested-token input restores all placeholders", !nestedTokenStressHtml.includes("\uFFFC") && nestedTokenStressHtml.includes("<code>item-0</code>") && nestedTokenStressHtml.includes("<code>item-999</code>"));

// --- Test Group 4: Inline Code Immunity & Nesting Rules ---
console.log("\nTest Group 4: Inline Code Immunity & Escaping");

assertEqual("Bold syntax inside inline code is immune", parseMarkdownToHTML("`**not bold**`"), "<p><code>**not bold**</code></p>");
assertEqual("Italic syntax inside inline code is immune", parseMarkdownToHTML("`*not italic*`"), "<p><code>*not italic*</code></p>");
assertEqual("Link syntax inside inline code is immune", parseMarkdownToHTML("`[not a link](url)`"), "<p><code>[not a link](url)</code></p>");
assertEqual("HTML entities inside inline code preserved", parseMarkdownToHTML("`&amp; &lt;`"), "<p><code>&amp; &lt;</code></p>");

// --- Test Group 5: Header Levels & Trailing Hashes ---
console.log("\nTest Group 5: Header Levels & Trailing Hashes");

assertEqual("H1 header", parseMarkdownToHTML("# Heading 1"), "<h1 id=\"heading-1\">Heading 1</h1>");
assertEqual("H2 header", parseMarkdownToHTML("## Heading 2"), "<h2 id=\"heading-2\">Heading 2</h2>");
assertEqual("H3 header", parseMarkdownToHTML("### Heading 3"), "<h3 id=\"heading-3\">Heading 3</h3>");
assertEqual("H4 header", parseMarkdownToHTML("#### Heading 4"), "<h4 id=\"heading-4\">Heading 4</h4>");
assertEqual("H5 header", parseMarkdownToHTML("##### Heading 5"), "<h5 id=\"heading-5\">Heading 5</h5>");
assertEqual("H6 header", parseMarkdownToHTML("###### Heading 6"), "<h6 id=\"heading-6\">Heading 6</h6>");
assertEqual("Header with trailing hashes stripped", parseMarkdownToHTML("### Heading 3 ###"), "<h3 id=\"heading-3\">Heading 3</h3>");
assertEqual("Header with inline code and bold", parseMarkdownToHTML("## `code` and **bold**"), "<h2 id=\"code-and-bold\"><code>code</code> and <strong>bold</strong></h2>");
assertEqual("Header without space is treated as paragraph", parseMarkdownToHTML("#HeaderNotTitle"), "<p>#HeaderNotTitle</p>");
assertEqual("7 hashes is treated as paragraph", parseMarkdownToHTML("####### Title"), "<p>####### Title</p>");

// --- Test Group 6: Fenced Code Blocks & Horizontal Rules ---
console.log("\nTest Group 6: Fenced Code Blocks & Horizontal Rules");

assertEqual("Backtick code block with language", parseMarkdownToHTML("```javascript\nconst a = 1;\n```"), "<pre><code class=\"language-javascript\">const a = 1;</code></pre>");
assertEqual("Backtick code block without language", parseMarkdownToHTML("```\nplain text\n```"), "<pre><code>plain text</code></pre>");
assertEqual("Tilde code block with language", parseMarkdownToHTML("~~~python\ndef foo(): pass\n~~~"), "<pre><code class=\"language-python\">def foo(): pass</code></pre>");
assertEqual("Code block escaping unescaped HTML characters", parseMarkdownToHTML("```html\n<div id=\"app\">x < y & y > z</div>\n```"), "<pre><code class=\"language-html\">&lt;div id=&quot;app&quot;&gt;x &lt; y &amp; y &gt; z&lt;/div&gt;</code></pre>");
assertEqual("Code block preserving pre-existing HTML entity", parseMarkdownToHTML("```html\n&amp;\n```"), "<pre><code class=\"language-html\">&amp;</code></pre>");
assertEqual("Empty fenced code block", parseMarkdownToHTML("```js\n```"), "<pre><code class=\"language-js\"></code></pre>");
assertEqual("Unclosed fenced code block reaches EOF", parseMarkdownToHTML("```js\nconsole.log(\"hi\");"), "<pre><code class=\"language-js\">console.log(&quot;hi&quot;);</code></pre>");
assertEqual("Horizontal rule ---", parseMarkdownToHTML("---"), "<hr>");
assertEqual("Horizontal rule ***", parseMarkdownToHTML("***"), "<hr>");
assertEqual("Horizontal rule ___", parseMarkdownToHTML("___"), "<hr>");
assertEqual("Horizontal rule with trailing whitespace", parseMarkdownToHTML("---   "), "<hr>");

// --- Test Group 7: Table Variations & Edge Cases ---
console.log("\nTest Group 7: Table Variations & Edge Cases");

const simpleTableMd = [
    "| Header 1 | Header 2 |",
    "| :--- | ---: |",
    "| Cell 1 | Cell 2 |",
].join("\n");
const expectedSimpleTable = "<div class=\"table-container\"><table><thead><tr><th style=\"text-align: left;\">Header 1</th><th style=\"text-align: right;\">Header 2</th></tr></thead><tbody><tr><td style=\"text-align: left;\">Cell 1</td><td style=\"text-align: right;\">Cell 2</td></tr></tbody></table></div>";
assertEqual("Simple table with left and right alignment", parseMarkdownToHTML(simpleTableMd), expectedSimpleTable);

const tableMissingCellsMd = [
    "| Header A | Header B | Header C |",
    "| --- | --- | --- |",
    "| Value A | |",
].join("\n");
assert("Table handles missing trailing cells gracefully", parseMarkdownToHTML(tableMissingCellsMd).includes("<td>Value A</td><td></td><td></td>"));

const tableNoSeparatorMd = [
    "| Header A | Header B |",
    "| Row 1 A | Row 1 B |",
].join("\n");
assert("Table without separator line uses first row as header and rest as body", parseMarkdownToHTML(tableNoSeparatorMd).includes("<thead><tr><th>Header A</th><th>Header B</th></tr></thead><tbody><tr><td>Row 1 A</td><td>Row 1 B</td></tr></tbody>"));

const tableMultiplePipesInCodeMd = [
    "| Function | Pattern |",
    "| --- | --- |",
    "| Filter | `a | b | c` |",
].join("\n");
assert("Table cell with multiple pipes inside inline code", parseMarkdownToHTML(tableMultiplePipesInCodeMd).includes("<code>a | b | c</code>"));

// --- Test Group 8: Blockquotes, Lists & Paragraph Merging ---
console.log("\nTest Group 8: Blockquotes, Lists & Paragraph Merging");

assertEqual("Single line blockquote", parseMarkdownToHTML("> Note text"), "<div class=\"note\">Note text</div>");
assertEqual("Unordered list with asterisks", parseMarkdownToHTML("* Item A\n* Item B"), "<ul><li>Item A</li><li>Item B</li></ul>");
assertEqual("Unordered list with leading spaces", parseMarkdownToHTML("  - Item 1\n  - Item 2"), "<ul><li>Item 1</li><li>Item 2</li></ul>");
assertEqual("Ordered list with numbers", parseMarkdownToHTML("1. First item\n2. Second item"), "<ol><li>First item</li><li>Second item</li></ol>");
assertEqual("Ordered list starting with non-1 index", parseMarkdownToHTML("5. Fifth item\n6. Sixth item"), "<ol><li>Fifth item</li><li>Sixth item</li></ol>");

// Nested list tests
const nestedUnordered4Spaces = [
    "* Category A",
    "    * Sub A1",
    "    * Sub A2",
    "* Category B",
    "    * Sub B1",
].join("\n");
assertEqual(
    "Nested unordered list (4 spaces)",
    parseMarkdownToHTML(nestedUnordered4Spaces),
    "<ul><li>Category A<ul><li>Sub A1</li><li>Sub A2</li></ul></li><li>Category B<ul><li>Sub B1</li></ul></li></ul>"
);

const nestedUnordered2Spaces = [
    "- Root 1",
    "  - Child 1.1",
    "    - Grandchild 1.1.1",
    "  - Child 1.2",
    "- Root 2",
].join("\n");
assertEqual(
    "Deeply nested unordered list (2 spaces)",
    parseMarkdownToHTML(nestedUnordered2Spaces),
    "<ul><li>Root 1<ul><li>Child 1.1<ul><li>Grandchild 1.1.1</li></ul></li><li>Child 1.2</li></ul></li><li>Root 2</li></ul>"
);

const mixedNestedLists = [
    "1. Numbered 1",
    "   * Bullet A",
    "   * Bullet B",
    "2. Numbered 2",
    "   1. Sub-numbered 1",
].join("\n");
assertEqual(
    "Mixed nested lists (ordered with unordered, ordered with ordered)",
    parseMarkdownToHTML(mixedNestedLists),
    "<ol><li>Numbered 1<ul><li>Bullet A</li><li>Bullet B</li></ul></li><li>Numbered 2<ol><li>Sub-numbered 1</li></ol></li></ol>"
);

const multilineListItems = [
    "* First item",
    "  continuation line",
    "* Second item",
].join("\n");
assertEqual(
    "List item with indented continuation line",
    parseMarkdownToHTML(multilineListItems),
    "<ul><li>First item continuation line</li><li>Second item</li></ul>"
);

assertEqual("Task lists render labeled disabled checkboxes", parseMarkdownToHTML("- [ ] Write docs\n- [X] Ship"), "<ul><li><input type=\"checkbox\" aria-label=\"Write docs\" disabled> Write docs</li><li><input type=\"checkbox\" checked aria-label=\"Ship\" disabled> Ship</li></ul>");
assertEqual("Empty task item gets fallback accessible name", parseMarkdownToHTML("- [ ]"), "<ul><li><input type=\"checkbox\" aria-label=\"Task item\" disabled> </li></ul>");
assertEqual("Task item accessible name escapes attribute content", parseMarkdownToHTML("- [ ] Review \"quotes\" & <tag>"), "<ul><li><input type=\"checkbox\" aria-label=\"Review &quot;quotes&quot; &amp; &lt;tag&gt;\" disabled> Review &quot;quotes&quot; &amp; &lt;tag&gt;</li></ul>");

const multiLineParagraph = [
    "Line one of paragraph.",
    "Line two of paragraph.",
].join("\n");
assertEqual("Multi-line paragraph merged with space", parseMarkdownToHTML(multiLineParagraph), "<p>Line one of paragraph. Line two of paragraph.</p>");

const multipleParagraphs = [
    "Paragraph 1",
    "",
    "",
    "Paragraph 2",
].join("\n");
assertEqual("Multiple paragraphs separated by multiple blank lines", parseMarkdownToHTML(multipleParagraphs), "<p>Paragraph 1</p>\n<p>Paragraph 2</p>");

// --- Test Group 9: Empty Inputs & Windows Line Endings ---
console.log("\nTest Group 9: Empty Inputs & Windows Line Endings");

assertEqual("Empty input string", parseMarkdownToHTML(""), "");
assertEqual("Whitespace only input string", parseMarkdownToHTML("   \n  \t  \n"), "");

const crlfMarkdown = "# Header\r\n\r\nParagraph line 1.\r\nParagraph line 2.\r\n";
const crlfExpected = "<h1 id=\"header\">Header</h1>\n<p>Paragraph line 1. Paragraph line 2.</p>";
assertEqual("Windows CRLF line endings processed properly", parseMarkdownToHTML(crlfMarkdown), crlfExpected);

// --- Test Group 10: Exports & Async Modal Rendering & Backward Compatibility ---
console.log("\nTest Group 10: Exports & Backward Compatibility Aliases");

const { extractHeadings, generateTOC, slugify } = require("./md-renderer.js");

assert("parseMarkdownToHTML exported as function", typeof parseMarkdownToHTML === "function");
assert("renderMarkdownFileToElement exported as function", typeof renderMarkdownFileToElement === "function");
assert("extractHeadings exported as function", typeof extractHeadings === "function");
assert("generateTOC exported as function", typeof generateTOC === "function");
assert("slugify exported as function", typeof slugify === "function");
assert("Legacy parseMarkdownToModalHTML alias exported", parseMarkdownToModalHTML === parseMarkdownToHTML);
assert("Legacy renderMarkdownFileToModal alias exported", renderMarkdownFileToModal === renderMarkdownFileToElement);

// Async test for renderMarkdownFileToElement with mock fetch & targetElement
async function testRenderMarkdownFileToElement() {
    const mockContainer = { innerHTML: "" };
    const originalFetch = global.fetch;

    global.fetch = async (url) => {
        if (url === "test.md") {
            return {
                ok: true,
                status: 200,
                text: async () => "# Mock Title\n\nTest content.",
            };
        }
        return { ok: false, status: 404 };
    };

    // Ensure document.querySelector is available in non-browser envs for testing
    const originalDocument = global.document;
    global.document = {
        querySelector: (sel) => (sel === "#target" ? mockContainer : null),
    };

    try {
        await renderMarkdownFileToElement("test.md", mockContainer);
        assertEqual("renderMarkdownFileToElement populates direct object targetElement.innerHTML", mockContainer.innerHTML, "<h1 id=\"mock-title\">Mock Title</h1>\n<p>Test content.</p>");

        mockContainer.innerHTML = "";
        await renderMarkdownFileToElement("test.md", "#target");
        assertEqual("renderMarkdownFileToElement populates string selector targetElement", mockContainer.innerHTML, "<h1 id=\"mock-title\">Mock Title</h1>\n<p>Test content.</p>");

        // Suppress expected console.error during 404 test
        const originalConsoleError = console.error;
        console.error = () => {
        };
        mockContainer.innerHTML = "unchanged";
        await renderMarkdownFileToElement("404.md", mockContainer);
        assertEqual("renderMarkdownFileToElement leaves innerHTML intact on HTTP 404", mockContainer.innerHTML, "unchanged");

        await renderMarkdownFileToElement("test.md", "#nonexistent");
        assertEqual("renderMarkdownFileToElement handles nonexistent selector gracefully", mockContainer.innerHTML, "unchanged");
        console.error = originalConsoleError;
    } finally {
        global.fetch = originalFetch;
        global.document = originalDocument;
    }
}

await testRenderMarkdownFileToElement();

// --- Test Group 11: Advanced Edge Cases & Special Syntax ---
console.log("\nTest Group 11: Advanced Edge Cases & Special Syntax");

assertEqual("4-backtick fence containing 3 backticks inside", parseMarkdownToHTML("````js\n```\n````"), "<pre><code class=\"language-js\">```</code></pre>");
assertEqual("Table with empty cells", parseMarkdownToHTML("| Header 1 | Header 2 |\n| --- | --- |\n| | Cell 2 |"), "<div class=\"table-container\"><table><thead><tr><th>Header 1</th><th>Header 2</th></tr></thead><tbody><tr><td></td><td>Cell 2</td></tr></tbody></table></div>");
assertEqual("Unmatched emphasis star treated as literal text", parseMarkdownToHTML("*unmatched star"), "<p>*unmatched star</p>");
assertEqual("Unclosed markdown link treated as literal text", parseMarkdownToHTML("[unclosed link](http://example.com"), "<p>[unclosed link](http://example.com</p>");
assertEqual("Naked ampersand in body text escaped", parseMarkdownToHTML("AT&T"), "<p>AT&amp;T</p>");
assertEqual("Literal code token placeholder in text isolated", parseMarkdownToHTML("\uFFFCCODE0\uFFFC and `test`"), "<p>\uFFFCCODE0\uFFFC and <code>test</code></p>");
assertEqual("Plus-sign unordered list handled correctly", parseMarkdownToHTML("+ Item 1\n+ Item 2"), "<ul><li>Item 1</li><li>Item 2</li></ul>");
assertEqual("Indented header parsed up to 3 spaces", parseMarkdownToHTML("   # Indented Header"), "<h1 id=\"indented-header\">Indented Header</h1>");
assertEqual("Indented code fence parsed up to 3 spaces", parseMarkdownToHTML("  ```js\nconst a = 1;\n  ```"), "<pre><code class=\"language-js\">const a = 1;</code></pre>");
assertEqual("Image syntax rendered as img tag", parseMarkdownToHTML("![alt](https://example.com/img.png)"), "<p><img src=\"https://example.com/img.png\" alt=\"alt\"></p>");
assertEqual("URL containing underscores/asterisks protected from attribute corruption", parseMarkdownToHTML("[Link](https://example.com/foo_bar_baz)"), "<p><a href=\"https://example.com/foo_bar_baz\" target=\"_blank\" rel=\"noopener\">Link</a></p>");
assertEqual("URL with balanced parentheses parsed completely", parseMarkdownToHTML("[Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar))"), "<p><a href=\"https://en.wikipedia.org/wiki/Foo_(bar)\" target=\"_blank\" rel=\"noopener\">Wikipedia</a></p>");
assertEqual("Uppercase hex HTML entity preserved without double-escaping", parseMarkdownToHTML("&#X1F600;"), "<p>&#X1F600;</p>");

// --- Test Group 12: Table of Contents (TOC) Generation & Headings Extraction ---
console.log("\nTest Group 12: Table of Contents (TOC) Generation");

const sampleTocMd = [
    "# Document Title",
    "",
    "[TOC]",
    "",
    "## Section 1: Overview",
    "### Subsection 1.1",
    "## Section 2: Details",
    "## Section 1: Overview",
].join("\n");

const headings = extractHeadings(sampleTocMd);
assertEqual("extractHeadings count", headings.length, 5);
assertEqual("extractHeadings slug deduplication", headings[4].slug, "section-1-overview-1");

const tocHtml = generateTOC(sampleTocMd);
assert("generateTOC wraps in nav tag", tocHtml.startsWith("<nav class=\"toc\"><ul>"));
assert("generateTOC contains link to Section 1", tocHtml.includes("<a href=\"#section-1-overview\">Section 1: Overview</a>"));
assert("generateTOC contains nested subsection link", tocHtml.includes("<a href=\"#subsection-11\">Subsection 1.1</a>"));

const parsedWithToc = parseMarkdownToHTML(sampleTocMd);
assert("parseMarkdownToHTML replaces [TOC] placeholder", parsedWithToc.includes("<nav class=\"toc\">") && parsedWithToc.includes("<h2 id=\"section-1-overview\">Section 1: Overview</h2>"));

// Customization options test
const customTocHtml = generateTOC(sampleTocMd, {
    containerTag: "aside",
    containerClass: "custom-toc",
    title: "Table of Contents",
    ulClass: "toc-list",
    liClass: "toc-item",
    aClass: "toc-link",
    slugPrefix: "sec-",
});
assert("generateTOC respects containerTag & containerClass", customTocHtml.includes("<aside class=\"custom-toc\">"));
assert("generateTOC renders custom title header", customTocHtml.includes("<h2 class=\"toc-title\">Table of Contents</h2>"));
assert("generateTOC applies ulClass, liClass, aClass, and slugPrefix", customTocHtml.includes("<ul class=\"toc-list\"><li class=\"toc-item\"><a href=\"#sec-document-title\" class=\"toc-link\">Document Title</a>"));

const customParsedHtml = parseMarkdownToHTML("# Title\n\n> Note text\n\n| H |\n|---|", {
    headingIdPrefix: "h-",
    headingClass: "doc-heading",
    noteClass: "custom-note",
    tableContainerClass: "custom-table-wrap",
});
assert("parseMarkdownToHTML applies headingIdPrefix & headingClass", customParsedHtml.includes("<h1 id=\"h-title\" class=\"doc-heading\">Title</h1>"));
assert("parseMarkdownToHTML applies noteClass", customParsedHtml.includes("<div class=\"custom-note\">Note text</div>"));
assert("parseMarkdownToHTML applies tableContainerClass", customParsedHtml.includes("<div class=\"custom-table-wrap\"><table>"));

// --- Test Group 13: Documentation Fixture Performance Benchmark ---
console.log("\nTest Group 13: Performance Benchmark");

const repeatedDocumentationFixture = `${documentationFixture}\n\n`.repeat(25);
const documentationIterations = 100;
const documentationStartedAt = performance.now();
for (let i = 0; i < documentationIterations; i++) {
    parseMarkdownToHTML(repeatedDocumentationFixture);
}
const documentationTotalTimeMs = performance.now() - documentationStartedAt;
const documentationAverageTimeMs = documentationTotalTimeMs / documentationIterations;
const documentationOpsPerSecond = Math.round(documentationIterations / (documentationTotalTimeMs / 1000));
assert(`Documentation fixture parsed in under 20ms average time (${documentationAverageTimeMs.toFixed(3)} ms/parse, ${documentationOpsPerSecond.toLocaleString()} ops/sec)`, documentationAverageTimeMs < 20);

// --- Test Group 14: md-showcase.md Integration & Extended Features ---
console.log("\nTest Group 14: md-showcase.md Integration & Extended Features");

const showcaseMdPath = path.join(__dirname, "md-showcase.md");
if (fs.existsSync(showcaseMdPath)) {
    const showcaseMd = fs.readFileSync(showcaseMdPath, "utf8");
    const showcaseHtml = parseMarkdownToHTML(showcaseMd, { allowAudioVideo: true });

    assert("Frontmatter cleanly stripped from showcase", !showcaseHtml.includes("Example Author") && !showcaseHtml.includes("draft: false"));
    assert("GitHub Alerts rendered using one.css .note class", showcaseHtml.includes("<div class=\"note\"><strong>NOTE</strong>") && showcaseHtml.includes("<div class=\"note\"><strong>TIP</strong>"));
    assert("HTML comments hidden from rendered output", !showcaseHtml.includes("&lt;!--") && !showcaseHtml.includes("This HTML comment should not appear"));
    assert("Setext headings level 1 & 2 parsed", showcaseHtml.includes("<h1 id=\"setext-heading-level-1\">Setext heading level 1</h1>") && showcaseHtml.includes("<h2 id=\"setext-heading-level-2\">Setext heading level 2</h2>"));
    assert("Heading with explicit identifier parsed", showcaseHtml.includes("<h3 id=\"custom-heading\">Heading with an explicit identifier</h3>"));
    assert("GFM strikethrough parsed", showcaseHtml.includes("<del>deleted text</del>"));
    assert("Highlight extension parsed", showcaseHtml.includes("<mark>highlighted text</mark>"));
    assert("Subscript and superscript parsed", showcaseHtml.includes("<sub>2</sub>") && showcaseHtml.includes("<sup>10</sup>"));
    assert("Inserted text parsed", showcaseHtml.includes("<ins>inserted text</ins>"));
    assert("Task lists with disabled checkboxes parsed", showcaseHtml.includes("<input type=\"checkbox\" aria-label=\"Unchecked task\" disabled>") && showcaseHtml.includes("<input type=\"checkbox\" checked aria-label=\"Checked task\" disabled>"));
    assert("Definition lists parsed into dl/dt/dd", showcaseHtml.includes("<dl><dt>Term</dt><dd>First definition.</dd>"));
    assert("Indented code block parsed into pre/code", showcaseHtml.includes("<pre><code>Indented code uses four leading spaces."));
    assert("Link with title attribute parsed", showcaseHtml.includes("title=\"Example title\""));
    assert("Reference links resolved properly", showcaseHtml.includes("href=\"https://example.com/reference\""));
    assert("Reference images resolved properly", showcaseHtml.includes("src=\"https://placehold.co/320x120/png\""));
    assert("Linked image parsed", showcaseHtml.includes("<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\"><img src=\"https://placehold.co/120x60/png\""));
    assert("Raw HTML details/summary preserved", showcaseHtml.includes("<details>") && showcaseHtml.includes("<summary>Expandable details</summary>"));
    assert("Raw HTML section/figure/audio/video preserved", showcaseHtml.includes("<section") && showcaseHtml.includes("<figure>") && showcaseHtml.includes("<audio") && showcaseHtml.includes("<video"));
    assert("Footnotes section generated at bottom", showcaseHtml.includes("<section class=\"footnotes\">") && showcaseHtml.includes("<li id=\"fn-simple\">"));
    assert("Display Math rendered", showcaseHtml.includes("<div class=\"math display\">"));
}

// --- Test Group 15: Imported Robustness & Security Regressions ---
console.log("\nTest Group 15: Imported Robustness & Security Regressions");

assertThrows("Non-string input rejected with clear error", () => parseMarkdownToHTML(42), "markdown must be a string");

const recursiveBlockquoteMarkdown = `${">".repeat(10_000)} content`;
const recursiveBlockquoteStartedAt = performance.now();
const recursiveBlockquoteHtml = parseMarkdownToHTML(recursiveBlockquoteMarkdown);
assert("Deep blockquote input preserves content", recursiveBlockquoteHtml.includes("content"));
assert("Deep blockquote input completes within two seconds", performance.now() - recursiveBlockquoteStartedAt < 2_000);

const uppercaseRawHtml = parseMarkdownToHTML("<DIV>\ninside\n</DIV>\nafter", { allowUnsafeHtml: true });
assert("Uppercase raw HTML closing tag preserves following content", uppercaseRawHtml.includes("</DIV>") && uppercaseRawHtml.includes("<p>after</p>"));

const lonePipeHtml = parseMarkdownToHTML("| lone row\nnext line");
assert("Lone pipe-led line is not dropped during table detection", lonePipeHtml.includes("| lone row") && lonePipeHtml.includes("next line"));

assertEqual("Equal-length backtick runs delimit inline code", parseMarkdownToHTML("`` a ` b `` and `c` and `unclosed"), "<p><code>a ` b</code> and <code>c</code> and `unclosed</p>");
assertEqual("Nested italic and bold tags stay balanced", parseMarkdownToHTML("*italic **bold***"), "<p><em>italic <strong>bold</strong></em></p>");
assertEqual("Nested underscore emphasis stays balanced", parseMarkdownToHTML("This **is _nested_**."), "<p>This <strong>is <em>nested</em></strong>.</p>");
assertEqual("Ambiguous nested emphasis stays balanced", parseMarkdownToHTML("**bold *ambiguous***"), "<p><strong>bold *ambiguous</strong>*</p>");

const escapedTokenMarkdown = "\\* ".repeat(25_000);
const escapedTokenStartedAt = performance.now();
const escapedTokenHtml = parseMarkdownToHTML(escapedTokenMarkdown);
assert("Large escaped-token input produces output", escapedTokenHtml.length > escapedTokenMarkdown.length / 2);
assert("Large escaped-token input completes within two seconds", performance.now() - escapedTokenStartedAt < 2_000);

const unmatchedBacktickMarkdown = Array.from({ length: 20_000 }, (_, index) => `${"`".repeat(index % 7 + 1)}x`).join(" ");
const unmatchedBacktickStartedAt = performance.now();
assert("Large unmatched-backtick input produces output", parseMarkdownToHTML(unmatchedBacktickMarkdown).length > 0);
assert("Large unmatched-backtick input completes within two seconds", performance.now() - unmatchedBacktickStartedAt < 2_000);

const handoffDiffLines = Array.from({ length: 500 }, (_, index) => [
    `@@ -${index},6 +${index},9 @@`,
    "-        old_call(root.join(`legacy`));",
    "+        new_call(root.join(`replacement`));",
    "+        assert!(!source.contains(forbidden), \"forbidden `{forbidden}`\");",
].join("\n")).join("\n");
const handoffLogMarkdown = [
    "<!-- handoff-task: t-345 -->",
    "Previous worker attempt for task 't-345' exited without completing it.",
    "",
    "## Previous attempt log (last 12000 bytes)",
    "",
    "```",
    handoffDiffLines,
    "```",
    "",
    "Content after handoff log.",
].join("\n");
const handoffLogStartedAt = performance.now();
const handoffLogHtml = parseMarkdownToHTML(handoffLogMarkdown);
assert("Large handoff diff hides metadata comment", !handoffLogHtml.includes("handoff-task"));
assert("Large handoff diff renders as one fenced code block", handoffLogHtml.includes("<pre><code>@@ -0,6 +0,9 @@") && handoffLogHtml.includes("forbidden `{forbidden}`") && handoffLogHtml.includes("</code></pre>"));
assert("Large handoff diff preserves content after closing fence", handoffLogHtml.endsWith("<p>Content after handoff log.</p>"));
assert("Large handoff diff completes within two seconds", performance.now() - handoffLogStartedAt < 2_000);

const unmatchedInlineInputs = [
    " *a".repeat(100_000),
    " _a".repeat(100_000),
    "[a".repeat(100_000),
    "<http:x".repeat(100_000),
];
const unmatchedInlineStartedAt = performance.now();
assert("Large unmatched inline inputs produce output", unmatchedInlineInputs.every((input) => parseMarkdownToHTML(input).length > 0));
assert("Large unmatched inline inputs complete within two seconds", performance.now() - unmatchedInlineStartedAt < 2_000);

const multiBacktickTable = parseMarkdownToHTML("| a | b |\n| - | - |\n| ``x|y`` | z |");
assert("Table splitting respects multi-backtick code spans", multiBacktickTable.includes("<td><code>x|y</code></td><td>z</td>"));

assertEqual("Executable markdown link URL blocked", parseMarkdownToHTML("[click](javascript:alert(1))"), "<p>click</p>");
assertEqual("Executable markdown image URL blocked", parseMarkdownToHTML("![alt](data:text/html,payload)"), "<p>alt</p>");
assert("Executable autolink URL blocked", !parseMarkdownToHTML("<javascript:alert(1)>").includes("href="));

const entityAttributeHtml = parseMarkdownToHTML('[click](https://example.test?a=&quot; "title &quot; value")');
assert("Entities are escaped again inside attributes", entityAttributeHtml.includes("a=&amp;quot;") && entityAttributeHtml.includes("title &amp;quot; value"));

const sanitizedInlineHtml = parseMarkdownToHTML('<img src="x" onerror="alert(1)"> <a href="javascript:alert(1)" onclick="alert(1)">x</a>');
assert("Inline HTML event attributes removed", sanitizedInlineHtml.includes('<img src="x">') && sanitizedInlineHtml.includes("<a>x</a>") && !sanitizedInlineHtml.includes("onerror") && !sanitizedInlineHtml.includes("onclick") && !sanitizedInlineHtml.includes("javascript:"));
assert("Self-closing non-void HTML escaped", parseMarkdownToHTML("before <span/> after").includes("&lt;span/&gt;"));
assert("Self-closing void HTML normalized", parseMarkdownToHTML("before <br/> after").includes("<br>"));

const unsafeHtmlMarkdown = "<div><script>alert(1)</script></div>";
assertEqual("Executable raw HTML escaped by default", parseMarkdownToHTML(unsafeHtmlMarkdown), "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
assertEqual("Explicit unsafe HTML passthrough retained", parseMarkdownToHTML(unsafeHtmlMarkdown, { allowUnsafeHtml: true }), unsafeHtmlMarkdown);

const detailsMarkdown = "<details open onclick=\"alert(1)\">\n<summary>More</summary>\n\n**Safe content**\n\n</details>";
const detailsHtml = parseMarkdownToHTML(detailsMarkdown);
assertEqual("Details element keeps safe attributes and Markdown content", detailsHtml, "<details open>\n<summary>More</summary>\n<p><strong>Safe content</strong></p>\n</details>");
assert("Details element removes event attributes", !detailsHtml.includes("onclick"));

const commonRawHtml = '<figure><img src="https://example.test/a.png"><figcaption><kbd>Alt</kbd></figcaption></figure>\n\n<blockquote cite="javascript:alert(1)">Quote</blockquote>\n\n<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>';
const commonRawHtmlOutput = parseMarkdownToHTML(commonRawHtml);
assert("Common safe GitHub HTML retained", commonRawHtmlOutput.includes('<figure><img src="https://example.test/a.png"><figcaption><kbd>Alt</kbd></figcaption></figure>') && commonRawHtmlOutput.includes("<blockquote>Quote</blockquote>") && commonRawHtmlOutput.includes('<td colspan="2">Cell</td>'));
assert("Unsafe URL removed from common raw HTML", !commonRawHtmlOutput.includes("javascript:"));

const mediaMarkdown = '<audio controls src="https://example.test/a.mp3">Audio</audio> <video controls src="https://example.test/a.mp4">Video</video>';
const defaultMediaHtml = parseMarkdownToHTML(mediaMarkdown);
const enabledMediaHtml = parseMarkdownToHTML(mediaMarkdown, { allowAudioVideo: true });
assert("Audio and video require explicit option", defaultMediaHtml.includes("&lt;audio controls src=&quot;https://example.test/a.mp3&quot;&gt;Audio&lt;/audio&gt;") && defaultMediaHtml.includes("&lt;video controls src=&quot;https://example.test/a.mp4&quot;&gt;Video&lt;/video&gt;"));
assert("Audio and video render when explicitly enabled", enabledMediaHtml.includes('<audio controls src="https://example.test/a.mp3">Audio</audio>') && enabledMediaHtml.includes('<video controls src="https://example.test/a.mp4">Video</video>'));

if (fs.existsSync(showcaseMdPath)) {
    const showcaseMd = fs.readFileSync(showcaseMdPath, "utf8");
    const safeShowcaseHtml = parseMarkdownToHTML(showcaseMd, { allowAudioVideo: true });

    assert("Showcase safe structural HTML retained", safeShowcaseHtml.includes("<details>") && safeShowcaseHtml.includes('<section aria-labelledby="html-section-title">') && safeShowcaseHtml.includes("<caption>Raw HTML table</caption>") && safeShowcaseHtml.includes("<figcaption>Raw HTML figure caption.</figcaption>"));
    assert("Showcase enabled media retained", safeShowcaseHtml.includes('<audio controls src="https://example.com/example.mp3">') && safeShowcaseHtml.includes('<video controls width="320" poster="https://placehold.co/320x180/png">'));
    assert("Showcase raw anchor retained and HTML comment removed", safeShowcaseHtml.includes('<a id="raw-html-anchor"></a>') && !safeShowcaseHtml.includes("This HTML comment should not appear"));
}

const escapedOptionHtml = parseMarkdownToHTML("# Heading", {
    headingClass: 'x&quot; onclick=&quot;alert(1)',
    headingIdPrefix: 'x&quot; onclick=&quot;alert(1)',
});
assert("Option-provided attributes escaped", escapedOptionHtml.includes("&amp;quot;") && !escapedOptionHtml.includes(' onclick="alert(1)"'));

const footnoteBeforeReferenceHtml = parseMarkdownToHTML("Use[^note].\n\n[^note]: Footnote text");
assert("Footnotes parsed before reference definitions", footnoteBeforeReferenceHtml.includes('href="#fn-note"') && footnoteBeforeReferenceHtml.includes('<li id="fn-note">Footnote text'));

const repeatedFootnoteHtml = parseMarkdownToHTML("A[^x] B[^x].\n\n[^x]: Note");
assert("Repeated footnotes emit unique reference IDs and backrefs", repeatedFootnoteHtml.includes('id="fnref-x"') && repeatedFootnoteHtml.includes('id="fnref-x-2"') && repeatedFootnoteHtml.includes('href="#fnref-x"') && repeatedFootnoteHtml.includes('href="#fnref-x-2"'));

const prototypeIdHtml = parseMarkdownToHTML("# constructor\n\nA[^__proto__].\n\n[^__proto__]: Note");
assert("Object-prototype names work as heading and footnote IDs", prototypeIdHtml.includes('id="constructor"') && prototypeIdHtml.includes('href="#fn-__proto__"') && prototypeIdHtml.includes('<li id="fn-__proto__">Note'));

const shortcutReferenceHtml = parseMarkdownToHTML("[known] [missing]\n\n[known]: https://example.test");
assert("Shortcut references resolve while unresolved references stay literal", shortcutReferenceHtml.includes('<a href="https://example.test"') && shortcutReferenceHtml.includes("[missing]"));

const commentTocMarkdown = "<!-- toc -->\n\n## A\n\n#### B\n\n### C\n\n## D";
const commentToc = generateTOC(commentTocMarkdown);
const commentTocHtml = parseMarkdownToHTML(commentTocMarkdown);
assert("Comment TOC placeholder renders valid skipped-level nesting", commentToc.includes('<nav class="toc">') && !commentToc.includes("<ul><ul>") && commentToc.includes('<li><a href="#a">A</a><ul>') && commentTocHtml.startsWith('<nav class="toc">'));

const headingsOutsideFences = extractHeadings("# A\n```md\n# B\n```\n## C").map((heading) => heading.rawText);
assertEqual("Headings inside fenced code ignored", JSON.stringify(headingsOutsideFences), JSON.stringify(["A", "C"]));

const slugStressInputs = ["<".repeat(400_000), "{#a".repeat(150_000), "`".repeat(400_000)];
const slugStressStartedAt = performance.now();
assert("Slugify handles unmatched delimiter inputs", slugStressInputs.every((input) => typeof slugify(input) === "string"));
assert("Slugify unmatched delimiters completes within two seconds", performance.now() - slugStressStartedAt < 2_000);

console.log("\n==============================================");
console.log(`Results: ${passedTests}/${totalTests} tests passed.`);
console.log("==============================================");

if (passedTests !== totalTests) {
    process.exit(1);
}
