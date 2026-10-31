/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global require */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const { htmlToMarkdown } = require("./html-to-md.js");
const { parseMarkdownToHTML } = require("../md-renderer.js");

describe("HTML documents and fragments", () => {
    test.each([
        ["empty input", "", ""],
        ["formatting whitespace", " \t\r\n ", ""],
        ["paragraphs", "<p>First</p><p>Second</p>", "First\n\nSecond"],
        ["divisions", "<div>First</div><div>Second</div>", "First\n\nSecond"],
        ["case insensitive tags", "<H2>Title</H2><P>Body</P>", "## Title\n\nBody"],
        ["all heading levels", "<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>", "# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F"],
        ["complete document", "<!doctype html><html><head><title>Metadata</title><style>p{color:red}</style></head><body><h1>Title</h1><p>One</p><p>Two</p></body></html>", "# Title\n\nOne\n\nTwo"],
        ["implicit head closing tag", "<head><title>Metadata</title><body><p>Visible</p>", "Visible"],
        ["body text after an unclosed head", "<head><title>Metadata</title>Visible", "Visible"],
        ["clipboard fragment comments", "<!--StartFragment--><p>Text</p><!--EndFragment-->", "Text"],
        ["comments and declarations", "a<!-- note > -->b<?processing?><!doctype html>c", "abc"],
        ["quoted doctype identifier", "<!DOCTYPE html SYSTEM 'identifier > suffix'><p>Visible</p>", "Visible"],
        ["unclosed comment", "visible<!-- hidden", "visible"],
        ["abrupt comment end", "a<!-->b<!-- x --!>c", "abc"],
        ["abrupt comment after a dash", "a<!--->b", "ab"],
        ["unclosed paragraph", "<p>Text", "Text"],
        ["optional paragraph closing tags", "<p>One<p>Two<div>Three</div>", "One\n\nTwo\n\nThree"],
        ["optional heading end tag", "<h1>One<h2>Two", "# One\n\n## Two"],
        ["nonvoid self closing slash", "<div/>a<div>b", "a\n\nb"],
        ["unknown inline wrappers", "<custom-tag><span>One <b>two</b></span></custom-tag>", "One **two**"],
        ["deep block wrappers", "<custom><span><p>One</p><p>Two</p></span></custom>", "One\n\nTwo"],
        ["less than in text", "1 < 2 > 0", "1 \\< 2 \\> 0"],
        ["unfinished tag", "visible <a href='unfinished", "visible"],
        ["quoted angle brackets", "<a href='/x' title='a > b'>text</a>", "[text](/x \"a &gt; b\")"],
        ["Windows newlines", "<p>a\r\nb\rc</p>", "a b c"],
        ["null character", "a\0b", "a\ufffdb"],
        ["raw textarea", "<textarea>\n&lt;b&gt; &amp; **text**</textarea>", "\\<b\\> &amp; \\*\\*text\\*\\*"],
        ["plaintext element", "<plaintext><b>literal</b>", "\\<b\\>literal\\</b\\>"],
        ["heading anchors", "<h2 id='target'>Heading</h2><a href='#target'>Go</a>", "<a id=\"target\"></a>\n\n## Heading\n\n[Go](#target)"],
        ["named anchors", "<a name='here'></a>Text", "<a id=\"here\"></a>Text"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });
});

describe("inline formatting and whitespace", () => {
    test.each([
        ["bold and italic", "<p><strong>Bold</strong> and <em>italic</em>.</p>", "**Bold** and *italic*."],
        ["italic aliases", "<i>i</i> <cite>cite</cite> <var>var</var>", "*i* *cite* *var*"],
        ["whitespace around emphasis", "a <b> b </b> c", "a **b** c"],
        ["whitespace inside wrappers", "a<b> b</b><span> c</span>", "a <strong>b</strong> c"],
        ["space supplied by empty wrapper", "one<span> </span>two", "one two"],
        ["adjacent whitespace", "a <span> </span> b", "a b"],
        ["nonbreaking spaces", "a&nbsp;&nbsp;b", "a\u00a0\u00a0b"],
        ["intraword emphasis", "un<em>break</em>able", "un<em>break</em>able"],
        ["adjacent formatting", "<b>A</b><b>B</b>", "<strong>A</strong><strong>B</strong>"],
        ["nested formatting", "<strong>bold <em>italic</em></strong>", "<strong>bold *italic*</strong>"],
        ["empty formatting", "a<b></b>b<em> </em>c", "ab c"],
        ["strikethrough", "<del>old</del> <s>gone</s> <strike>removed</strike>", "~~old~~ ~~gone~~ ~~removed~~"],
        ["subscript and superscript", "H<sub>2</sub>O x<sup>2</sup>", "H~2~O x^2^"],
        ["standalone subscript and superscript", "<sup>2</sup> <sub>i</sub>", "^2^ ~i~"],
        ["multiword superscript", "<sup>two words</sup>", "<sup>two words</sup>"],
        ["highlight insertion underline", "<mark>highlight</mark> <ins>new</ins> <u>underline</u>", "==highlight== ++new++ <u>underline</u>"],
        ["inline clipboard styles", "<span style='font-weight: 700; font-style: italic'>text</span>", "<strong>*text*</strong>"],
        ["normal Google Docs bold wrapper", "<b style='font-weight:normal'>plain <span style='font-weight:700'>bold</span></b>", "plain **bold**"],
        ["decoration styles", "<span style='text-decoration:line-through'>old</span>", "~~old~~"],
        ["block style inheritance", "<div style='font-weight:700'><p>One</p><p>Two</p></div>", "**One**\n\n**Two**"],
        ["formatting around blocks", "<b><p>One</p><p>Two</p></b>", "**One**\n\n**Two**"],
        ["hard line break", "a<br>b", "a  \nb"],
        ["successive line breaks", "a<br><br>b", "a<br><br>b"],
        ["edge line breaks", "<br>a<br>", "<br>a<br>"],
        ["line break inside emphasis", "<em>a<br>b</em>", "*a  \nb*"],
        ["horizontal rule", "<p>a</p><hr><p>b</p>", "a\n\n* * *\n\nb"],
        ["literal Markdown", "<p># heading *bold* [link](url) ~x~ ^y^ =z= +item -item $math$ |</p>", "\\# heading \\*bold\\* \\[link\\](url) \\~x\\~ \\^y\\^ \\=z\\= \\+item \\-item &#36;math&#36; &#124;"],
        ["literal list marker", "<p>12. text</p><p>2) text</p>", "12\\. text\n\n2\\) text"],
        ["literal TOC marker", "<p>[TOC]</p>", "\\[TOC\\]"],
        ["literal backticks", "<p>Use `code` literally</p>", "Use &#96;code&#96; literally"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });
});

describe("character references", () => {
    test.each([
        ["basic named references", "&lt;b&gt; &amp; &quot; &apos;", "\\<b\\> &amp; \" '"],
        ["Latin Greek math and multi-codepoint names", "&Aacute; &alpha; &sum; &NotEqualTilde; &CounterClockwiseContourIntegral;", "Á α ∑ ≂̸ ∳"],
        ["optional semicolon", "&copy &notit; &amp!", "© ¬it; &amp;\\!"],
        ["numeric references", "&#65; &#x1f642; &#X3B1 &#128;", "A 🙂 α €"],
        ["referenced HTML whitespace", "a&#13;b&#10;c&#9;d", "a b c d"],
        ["invalid codepoints", "&#0; &#xD800; &#1114112;", "� � �"],
        ["unknown names", "&notarealentity; &DoesNotExist;", "¬arealentity; &amp;DoesNotExist;"],
        ["one decoding pass", "&amp;lt;script&amp;gt;", "&amp;lt;script&amp;gt;"],
        ["attribute reference ambiguity", "<a href='/q?x=1&copy=2&notit;=3'>link</a>", "[link](/q?x=1&copy=2&notit;=3)"],
        ["attribute named references", "<a href='/q?x=1&amp;y=2'>link</a>", "[link](/q?x=1&y=2)"],
        ["entity-looking URL text", "<a href='/q?x=1&amp;copy;'>link</a>", "[link](/q?x=1&amp;copy;)"],
        ["duplicate attributes keep the first", "<a href='/first' href='/second'>link</a>", "[link](/first)"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });
});

describe("code preserves its contents", () => {
    test.each([
        ["code aliases", "<code>a</code> <kbd>b</kbd> <samp>c</samp> <tt>d</tt>", "`a` `b` `c` `d`"],
        ["inline HTML and Markdown", "<code>&lt;em&gt; **x** &amp;amp;</code>", "`<em> **x** &amp;`"],
        ["inline backticks", "<code>a`b``c</code>", "```a`b``c```"],
        ["backticks at edges", "<code>`code`</code>", "`` `code` ``"],
        ["space padding", "<code> code </code>", "`  code  `"],
        ["whitespace only code", "<code>   </code>", "`   `"],
        ["inline newlines", "<code>a\nb</code>", "`a b`"],
        ["empty code span", "<code></code>", ""],
        ["code block", "<pre><code class='language-js'>const x = 1;</code></pre>", "```js\nconst x = 1;\n```"],
        ["bare preformatted text", "<pre>  a\n\n\n b  \n</pre>", "```\n  a\n\n\n b  \n```"],
        ["HTML's initial pre newline", "<pre>\nline</pre>", "```\nline\n```"],
        ["pre newline following a comment", "<pre><!--comment-->\nline</pre>", "```\n\nline\n```"],
        ["empty code block", "<pre></pre>", "```\n```"],
        ["fence collisions", "<pre><code>```\n````\n~~~</code></pre>", "`````\n```\n````\n~~~\n`````"],
        ["raw legacy code", "<xmp><p>&amp;</p></xmp>", "```\n<p>&amp;</p>\n```"],
        ["code after a block", "<p>Before</p><pre> \nvalue\n\n</pre><p>After</p>", "Before\n\n```\n \nvalue\n\n```\n\nAfter"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });

    test("many backtick runs do not overflow the argument stack", () => {
        const code = "`x".repeat(100_000);
        expect(htmlToMarkdown(`<pre>${code}</pre>`)).toBe(`\`\`\`\n${code}\n\`\`\``);
    });
});

describe("links and images", () => {
    test.each([
        ["link", "<a href='https://example.com'>Example</a>", "[Example](https://example.com)"],
        ["autolink", "<a href='https://example.com/x'>https://example.com/x</a>", "<https://example.com/x>"],
        ["visible URL punctuation", "<a href='https://example.com/(x)'>https://example.com/(x)</a>", "[https\\://example.com/(x)](https://example.com/%28x%29)"],
        ["email autolink", "<a href='mailto:me@example.com'>me@example.com</a>", "<me@example.com>"],
        ["link without href", "<a>Text</a>", "Text"],
        ["link edge whitespace", "before<a href='/x'> text </a>after", "before [text](/x) after"],
        ["formatted URL labels", "<a href='https://example.com'><strong>https://example.com</strong></a>", "[**https\\://example.com**](https://example.com)"],
        ["plain URL text", "https://example.com", "https\\://example.com"],
        ["links wrapping blocks", "<a href='/x'><p>One</p><p>Two</p></a>", "<a href=\"/x\"><p>One</p><p>Two</p></a>"],
        ["empty href", "<a href=''>Text</a>", "Text"],
        ["nested inline content", "<a href='/x'><strong>Bold</strong> <code>code</code></a>", "[**Bold** `code`](/x)"],
        ["destination punctuation", "<a href='/a (b)/[c]'>Link</a>", "[Link](/a%20%28b%29/%5Bc%5D)"],
        ["title quotes", "<a href='/x' title='say &quot;yes&quot;'>Text</a>", "[Text](/x \"say &quot;yes&quot;\")"],
        ["image", "<img src='/picture.png' alt='A picture' title='Photo'>", "![A picture](/picture.png \"Photo\")"],
        ["image without alt", "<img src='/picture.png'>", "![](/picture.png)"],
        ["image without src", "<img alt='Description'>", "Description"],
        ["unavailable embedded image", "<img src='data:image/png;base64,AAAA' alt='Description'>", "Description"],
        ["linked image", "<a href='/page'><img src='/photo' alt='Photo'></a>", "[![Photo](/photo)](/page)"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });

    test("relative URLs resolve only against an explicit source URL", () => {
        const html = "<base href='https://wrong.example/'><a href='../page?q=1&amp;b=2'>Go</a><img src='./a.png' alt='A'>";
        expect(htmlToMarkdown(html, { baseUrl: "https://example.com/docs/start/" })).toBe("[Go](https://example.com/docs/page?q=1&b=2)![A](https://example.com/docs/start/a.png)");
    });
});

describe("lists, blockquotes and tables", () => {
    test.each([
        ["unordered list", "<ul><li>One</li><li>Two</li></ul>", "- One\n- Two"],
        ["separate adjacent lists", "<ul><li>One</li></ul><ul><li>Two</li></ul>", "- One\n\n<!-- -->\n\n- Two"],
        ["omitted list item end tags", "<ul><li>One<li>Two</ul>", "- One\n- Two"],
        ["ordered start", "<ol start='7'><li>Seven</li><li>Eight</li></ol>", "7. Seven\n8. Eight"],
        ["nested list", "<ul><li>Outer<ul><li>Inner</li></ul></li><li>Last</li></ul>", "- Outer\n\n  - Inner\n- Last"],
        ["paragraphs inside list items", "<ul><li><p>One</p><p>Two</p></li><li><p>Three</p></li></ul>", "- One\n\n  Two\n\n- Three"],
        ["task list", "<ul><li><input type='checkbox' checked>Done</li><li><input type='checkbox'>Todo</li></ul>", "- [x] Done\n- [ ] Todo"],
        ["blockquotes", "<blockquote><p>One</p><p>Two</p></blockquote>", "> One\n>\n> Two"],
        ["nested blockquote", "<blockquote><p>Outer</p><blockquote>Inner</blockquote></blockquote>", "> Outer\n>\n> > Inner"],
        ["simple table", "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>", "| A | B |\n| --- | --- |\n| 1 | 2 |"],
        ["table alignment", "<table><tr><th align='right'>A</th><th style='text-align:center'>B</th></tr><tr><td>x</td><td>y</td></tr></table>", "| A | B |\n| ---: | :---: |\n| x | y |"],
        ["table without headers", "<table><tr><td>A</td><td>B</td></tr></table>", "|  |  |\n| --- | --- |\n| A | B |"],
        ["ragged table", "<table><tr><th>A</th><th>B</th></tr><tr><td>x</td></tr></table>", "| A | B |\n| --- | --- |\n| x |  |"],
        ["optional table closing tags", "<table><tr><th>A<th>B<tr><td>x<td>y</table>", "| A | B |\n| --- | --- |\n| x | y |"],
        ["table cell pipes", "<table><tr><th>Text</th><th>Code</th></tr><tr><td>A | B</td><td><code>a|b</code></td></tr></table>", "| Text | Code |\n| --- | --- |\n| A &#124; B | `a\\|b` |"],
        ["table cell paragraphs", "<table><tr><th>A</th></tr><tr><td><p>One</p><p>Two</p></td></tr></table>", "| A |\n| --- |\n| One<br>Two |"],
    ])("%s", (_name, html, markdown) => {
        expect(htmlToMarkdown(html)).toBe(markdown);
    });

    test("merged table cells retain structure in sanitized HTML", () => {
        const input = "<table onclick='bad()'><caption>Title</caption><tr><th colspan='2'>Heading</th></tr><tr><td rowspan='2'>A</td><td>B</td></tr></table>";
        expect(htmlToMarkdown(input)).toBe("<table><caption>Title</caption><tr><th colspan=\"2\">Heading</th></tr><tr><td rowspan=\"2\">A</td><td>B</td></tr></table>");
    });

    test("reversed lists and explicit item values retain their meaning", () => {
        expect(htmlToMarkdown("<ol reversed start='3'><li>A</li><li value='1'>B</li></ol>")).toBe("<ol start=\"3\" reversed><li>A</li><li value=\"1\">B</li></ol>");
    });

    test("details and definition lists retain structure", () => {
        expect(htmlToMarkdown("<details open><summary>More</summary><p>Text</p></details>")).toBe("<details open><summary>More</summary><p>Text</p></details>");
        expect(htmlToMarkdown("<dl><dt>Term<dd>Definition<dt>Other<dd>Value</dl>")).toBe("<dl><dt>Term</dt><dd>Definition</dd><dt>Other</dt><dd>Value</dd></dl>");
    });

    test("row headers retain their semantic role", () => {
        const html = "<table><tr><th>Name</th><th>Value</th></tr><tr><th scope='row'>A</th><td>B</td></tr></table>";
        expect(htmlToMarkdown(html)).toContain("<tr><th scope=\"row\">A</th><td>B</td></tr>");
    });

    test("table text outside a cell is not lost", () => {
        expect(htmlToMarkdown("<table><tr>Outside<td>Inside</td></tr></table>")).toBe("<table><tr>Outside<td>Inside</td></tr></table>");
    });

    test("preformatted blocks inside table wrappers keep their whitespace", () => {
        const html = "<table><tr><td><div><pre>  code\n\nnext</pre></div></td></tr></table>";
        expect(htmlToMarkdown(html)).toBe(html);
    });

    test("unexpected text in a list is retained", () => {
        expect(htmlToMarkdown("<ul>Outside<li>Inside</li></ul>")).toBe("<ul>Outside<li>Inside</li></ul>");
    });
});

describe("untrusted HTML", () => {
    test.each(["script", "style", "template", "noscript", "iframe", "object", "svg", "math", "canvas", "audio", "video"])("discards %s content", tag => {
        expect(htmlToMarkdown(`<p>before</p><${tag}>secret</${tag}><p>after</p>`)).toBe("before\n\nafter");
    });

    test.each([
        "javascript:alert(1)", "JAVASCRIPT:alert(1)", "java&#x09;script:alert(1)",
        "&#106;avascript:alert(1)", "javascript&colon;alert(1)", "vbscript:bad()",
        "data:text/html,bad", "file:///etc/passwd", "blob:https://example.com/id",
    ])("rejects an executable or unsupported URL: %s", url => {
        expect(htmlToMarkdown(`<a href='${url}'>Label</a> <img src='${url}' alt='Picture'>`)).toBe("Label Picture");
    });

    test("omits inline-hidden and accessibility-hidden content", () => {
        const input = "a<span hidden>secret</span><span style='display: none !important'>secret</span><span style='visibility:hidden'>secret</span><span aria-hidden='true'>icon</span>b";
        expect(htmlToMarkdown(input)).toBe("ab");
    });

    test("raw-text elements do not accidentally close on tag prefixes", () => {
        expect(htmlToMarkdown("a<script>secret</scripture><b>hidden</b></script>b")).toBe("ab");
    });

    test("sanitized structural HTML never carries executable attributes or nested active elements", () => {
        const input = "<details open onmouseover='bad()'><summary style='background:url(bad)'>More</summary><a href='javascript:bad()'>Label</a><img src='/safe' onerror='bad()' alt='Picture'><script>bad()</script><input type='checkbox' checked onclick='bad()'></details>";
        expect(htmlToMarkdown(input)).toBe("<details open><summary>More</summary>Label<img src=\"/safe\" alt=\"Picture\"><input type=\"checkbox\" disabled aria-label=\"Task\" checked></details>");
    });

    test("prototype-looking attributes and tags are ordinary data", () => {
        expect(htmlToMarkdown("<a __proto__='x' constructor='x' href='/ok'>ok</a><constructor>text</constructor>")).toBe("[ok](/ok)text");
        expect({}.polluted).toBeUndefined();
    });

    test("escaped tags remain literal, including in structural HTML", () => {
        expect(htmlToMarkdown("<details><summary>&lt;script&gt;</summary>&lt;img onerror=bad()&gt;</details>")).toBe("<details><summary>&lt;script&gt;</summary>&lt;img onerror=bad()&gt;</details>");
    });
});

describe("options and bounded resource use", () => {
    test("punctuation is preserved by default", () => {
        expect(htmlToMarkdown("<p>“Hello”—it’s…</p>")).toBe("“Hello”—it’s…");
    });

    test("optional punctuation normalization never rewrites code or destinations", () => {
        const html = "<p>“Hello”—it’s… <code>“quoted”—…</code> <a href='https://example.com/…'>link</a></p><pre>“code”—…</pre>";
        expect(htmlToMarkdown(html, { normalizePunctuation: true })).toBe("\"Hello\"\\-\\-\\-it's... `“quoted”—…` [link](https://example.com/…)\n\n```\n“code”—…\n```");
    });

    test.each([undefined, null, 1, false, {}, []].map(value => [value]))("rejects non-string input: %p", value => {
        expect(() => htmlToMarkdown(value)).toThrow(TypeError);
    });

    test.each([null, [], true, "options"].map(value => [value]))("rejects invalid options: %p", options => {
        expect(() => htmlToMarkdown("text", options)).toThrow(TypeError);
    });

    test.each(["/relative", "javascript:bad()", "file:///tmp/test", "invalid"])("rejects invalid base URL: %s", baseUrl => {
        expect(() => htmlToMarkdown("text", { baseUrl })).toThrow("absolute HTTP or HTTPS URL");
    });

    test("validates punctuation option", () => {
        expect(() => htmlToMarkdown("text", { normalizePunctuation: "false" })).toThrow(TypeError);
    });

    test("rejects oversized input before parsing", () => {
        expect(() => htmlToMarkdown("x".repeat(5_000_001))).toThrow("character limit");
    });

    test("rejects extreme nesting with an actionable error", () => {
        expect(() => htmlToMarkdown("<div>".repeat(129) + "text")).toThrow("nesting limit");
    });

    test("rejects excessive node counts", () => {
        expect(() => htmlToMarkdown("<br>".repeat(100_001))).toThrow("node limit");
    });

    test("large ordinary pasted documents convert completely", () => {
        const html = "<p>Text <b>bold</b> &amp; text.</p>".repeat(5000);
        const markdown = htmlToMarkdown(html);
        expect(markdown.split("\n\n")).toHaveLength(5000);
        expect(markdown.endsWith("Text **bold** &amp; text.")).toBe(true);
    });

    test("malformed attribute input terminates", () => {
        expect(htmlToMarkdown("visible<a " + "name=\"".repeat(20_000))).toBe("visible");
    });

    test("many unfinished raw-text closing tags do not trigger quadratic scanning", () => {
        expect(htmlToMarkdown("visible<script>" + "</script ".repeat(100_000))).toBe("visible");
    });

    test("conversion is repeatable and calls do not share mutable state", () => {
        const input = "<ol><li><a href='/path'>text</a></li></ol>";
        const first = htmlToMarkdown(input);
        htmlToMarkdown(input, { baseUrl: "https://example.com/" });
        expect(htmlToMarkdown(input)).toBe(first);
    });

    test("seeded nested inline fragments retain all visible words", () => {
        let seed = 1234567;
        const random = maximum => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed % maximum;
        };
        const tags = ["span", "b", "strong", "i", "em", "mark", "u", "custom-tag"];
        for (let sample = 0; sample < 100; sample++) {
            const words = [];
            const fragment = depth => {
                const pieces = [];
                for (let index = 0; index < 3; index++) {
                    const tag = tags[random(tags.length)];
                    let content;
                    if (depth < 3 && random(3) === 0) {
                        content = fragment(depth + 1);
                    } else {
                        content = `word${random(1000)}`;
                        words.push(content);
                    }
                    pieces.push(`<${tag}>${content}</${tag}>`);
                }
                return pieces.join(" ");
            };
            const input = fragment(0);
            const rendered = parseMarkdownToHTML(htmlToMarkdown(input));
            expect(rendered.match(/word\d+/g)).toEqual(words);
        }
    });
});

describe("preview renderer integration", () => {
    test("headings, emphasis, code, links and images survive conversion and rendering", () => {
        const html = "<h2>Title</h2><p><strong>Bold</strong> and <em>italic</em> with <code>a &lt; b</code>, <a href='/target'>link</a> and <img src='/image' alt='Picture'>.</p>";
        const rendered = parseMarkdownToHTML(htmlToMarkdown(html));
        expect(rendered).toContain("<h2 id=\"title\">Title</h2>");
        expect(rendered).toContain("<strong>Bold</strong> and <em>italic</em>");
        expect(rendered).toContain("<code>a &lt; b</code>");
        expect(rendered).toContain("href=\"/target\"");
        expect(rendered).toContain("<img src=\"/image\" alt=\"Picture\">");
    });

    test("task lists and nested lists render as list structures", () => {
        const html = "<ul><li><input type='checkbox' checked>Done<ul><li>Nested</li></ul></li><li>Last</li></ul>";
        const rendered = parseMarkdownToHTML(htmlToMarkdown(html));
        expect(rendered).toContain("checked");
        expect(rendered).toContain("<ul><li>Nested</li></ul>");
        expect(rendered).toContain("<li>Last</li>");
    });

    test("tables preserve literal pipes in ordinary cells and code", () => {
        const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>x | y</td><td><code>a|b</code></td></tr></table>";
        const rendered = parseMarkdownToHTML(htmlToMarkdown(html));
        expect(rendered).toContain("<td>x &#124; y</td>");
        expect(rendered).toContain("<td><code>a|b</code></td>");
    });

    test("literal extensions do not turn into a TOC, links or formatting", () => {
        const rendered = parseMarkdownToHTML(htmlToMarkdown("<p>[TOC] **literal** ==mark== ~sub~ ^sup^</p>"));
        expect(rendered).toBe("<p>[TOC] **literal** ==mark== ~sub~ ^sup^</p>");
    });

    test("literal backticks remain text in the preview", () => {
        const rendered = parseMarkdownToHTML(htmlToMarkdown("<p>Use `a` and `b` literally.</p>"));
        expect(rendered).toBe("<p>Use &#96;a&#96; and &#96;b&#96; literally.</p>");
    });

    test("plain URLs and dollar signs do not acquire unintended formatting", () => {
        expect(parseMarkdownToHTML(htmlToMarkdown("<p>https://example.com</p><p>$$</p>"))).toBe("<p>https://example.com</p>\n<p>&#36;&#36;</p>");
    });

    test("query-string separators survive conversion and rendering", () => {
        const html = "<a href='https://example.com/?a=1&amp;b=2'>Link</a> <a href='https://example.com/?a=1&amp;b=2'>https://example.com/?a=1&amp;b=2</a>";
        const rendered = parseMarkdownToHTML(htmlToMarkdown(html));
        expect(rendered.match(/href="https:\/\/example.com\/\?a=1&amp;b=2"/g)).toHaveLength(2);
    });

    test("separate source lists remain separate in the preview", () => {
        const rendered = parseMarkdownToHTML(htmlToMarkdown("<ul><li>A</li></ul><ul><li>B</li></ul>"));
        expect(rendered.match(/<ul>/g)).toHaveLength(2);
    });

    test("the documentation fixture's main structures survive a round trip", () => {
        const markdown = "# Query\n\nUse `field` and **bold**.\n\n| Name | Value |\n| --- | --- |\n| Key | `value` |\n\n- First\n- Second\n\n```js\nconst x = 1;\n```";
        const first = parseMarkdownToHTML(markdown);
        const second = parseMarkdownToHTML(htmlToMarkdown(first));
        for (const snippet of ["<h1", "<code>field</code>", "<strong>bold</strong>", "<table>", "<td><code>value</code></td>", "<li>First</li>", "<pre><code class=\"language-js\">const x = 1;</code></pre>"]) {
            expect(second).toContain(snippet);
        }
    });
});

test("classic browser script exports its API without DOM or module globals", () => {
    const context = {};
    runInNewContext(readFileSync(new URL("html-to-md.js", import.meta.url), "utf8"), context);
    expect(context.htmlToMarkdown("<h1>Title</h1>")).toBe("# Title");
});
