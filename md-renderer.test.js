import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const { parseMarkdownToHTML } = require("./md-renderer.js");

describe("fenced code in lists", () => {
    for (const fence of ["```", "~~~"]) {
        test(`${fence} immediately after the list marker`, () => {
            expect(parseMarkdownToHTML(`- ${fence}js\n  const x = 1;\n  ${fence}`)).toBe(
                '<ul><li><pre><code class="language-js">const x = 1;</code></pre></li></ul>',
            );
        });

        test(`${fence} after blank lines stays in the first item`, () => {
            expect(parseMarkdownToHTML(`- Item\n\n  ${fence}js\n  const x = 1;\n  ${fence}\n\n- Next`)).toBe(
                '<ul><li>Item<pre><code class="language-js">const x = 1;</code></pre></li><li>Next</li></ul>',
            );
        });

        test(`${fence} preserves internal whitespace and code that looks like blocks`, () => {
            const code = "if (x) {\n  work();\n\n    deeper();\n}\n- literal item\n# literal heading\n> literal quote\n| literal | row |";
            const markdown = `- Item\n  ${fence}text\n${code.split("\n").map(line => `  ${line}`).join("\n")}\n  ${fence}\n- Next`;
            expect(parseMarkdownToHTML(markdown)).toBe(
                `<ul><li>Item<pre><code class="language-text">${code.replace(/>/g, "&gt;")}</code></pre></li><li>Next</li></ul>`,
            );
        });

        test(`${fence} supports nested mixed lists and parent continuation`, () => {
            const markdown = `5. Outer\n   - Child\n     9) ${fence}js\n        child();\n          nested();\n        ${fence}\n\n     10) Next child\n\n   ${fence}text\n   outer\n   ${fence}\n6. Next`;
            expect(parseMarkdownToHTML(markdown)).toBe(
                '<ol start="5"><li>Outer<ul><li>Child<ol start="9"><li><pre><code class="language-js">child();\n  nested();</code></pre></li><li>Next child</li></ol></li></ul><pre><code class="language-text">outer</code></pre></li><li>Next</li></ol>',
            );
        });

        test(`${fence} preserves checked and unchecked task items`, () => {
            const markdown = `- [x] Done\n\n  ${fence}js\n  done();\n  ${fence}\n\n- [ ] Next`;
            expect(parseMarkdownToHTML(markdown)).toBe(
                '<ul><li><input type="checkbox" checked aria-label="Done" disabled> Done<pre><code class="language-js">done();</code></pre></li><li><input type="checkbox" aria-label="Next" disabled> Next</li></ul>',
            );
        });

        test(`${fence} ends at the item boundary when unclosed`, () => {
            expect(parseMarkdownToHTML(`- ${fence}text\n  keep\n- Next\n\n[out]: /outside\n\n[out]`)).toBe(
                '<ul><li><pre><code class="language-text">keep</code></pre></li><li>Next</li></ul>\n<p><a href="/outside" target="_blank" rel="noopener">out</a></p>',
            );
        });

        test(`${fence} at document indentation starts outside the list`, () => {
            expect(parseMarkdownToHTML(`- Item\n\n${fence}text\nkeep\n${fence}\n\n- Next`)).toBe(
                '<ul><li>Item</li></ul>\n<pre><code class="language-text">keep</code></pre>\n<ul><li>Next</li></ul>',
            );
        });
    }

    test("matching fence character and minimum closing length", () => {
        expect(parseMarkdownToHTML("- ````text\n  ```\n  ~~~~\n  ```` not a closing fence\n  keep\n  `````\n- Next")).toBe(
            '<ul><li><pre><code class="language-text">```\n~~~~\n```` not a closing fence\nkeep</code></pre></li><li>Next</li></ul>',
        );
    });

    test("fence indentation is removed in addition to the list container", () => {
        expect(parseMarkdownToHTML("  - Item\n\n      ```text\n      base\n        inner\n    short\n      ```")).toBe(
            '<ul><li>Item<pre><code class="language-text">base\n  inner\nshort</code></pre></li></ul>',
        );
    });

    test("tabs in the list prefix preserve tabs within code", () => {
        expect(parseMarkdownToHTML("-\t```text\n\tbase\n\t\tinner\n\t```\n- Next")).toBe(
            '<ul><li><pre><code class="language-text">base\n\tinner</code></pre></li><li>Next</li></ul>',
        );
    });

    test("consecutive fences and empty blocks stay in their item", () => {
        expect(parseMarkdownToHTML("- ```\n  ```\n\n  ~~~\n  next\n  ~~~\n\n  After\n- Last")).toBe(
            '<ul><li><pre><code></code></pre><pre><code>next</code></pre> After</li><li>Last</li></ul>',
        );
    });

    test("nested list markers on one line contain the fenced block", () => {
        expect(parseMarkdownToHTML("- 3. ```text\n     [key]: /literal\n     keep\n     ```\n- Next")).toBe(
            '<ul><li><ol start="3"><li><pre><code class="language-text">[key]: /literal\nkeep</code></pre></li></ol></li><li>Next</li></ul>',
        );
    });
});

describe("ordered list starts", () => {
    test.each([
        ["1. First\n2. Second", "<ol><li>First</li><li>Second</li></ol>"],
        ["0. Zero\n1. First", '<ol start="0"><li>Zero</li><li>First</li></ol>'],
        ["05) Fifth\n99) Next", '<ol start="5"><li>Fifth</li><li>Next</li></ol>'],
        ["- Parent\n  7. Child\n  8. Next\n- Last", '<ul><li>Parent<ol start="7"><li>Child</li><li>Next</li></ol></li><li>Last</li></ul>'],
        ["3. Outer\n   1. Child\n4. Last", '<ol start="3"><li>Outer<ol><li>Child</li></ol></li><li>Last</li></ol>'],
        ["- Bullet\n8. Ordered\n- Bullet again\n2. Restart", '<ul><li>Bullet</li></ul><ol start="8"><li>Ordered</li></ol><ul><li>Bullet again</li></ul><ol start="2"><li>Restart</li></ol>'],
    ])("preserves the first marker in %s", (markdown, html) => {
        expect(parseMarkdownToHTML(markdown)).toBe(html);
    });
});

describe("literal code and definition boundaries", () => {
    const literal = "&amp; &lt; &#65; &#x41; &bogus; <tag>";
    const escaped = "&amp;amp; &amp;lt; &amp;#65; &amp;#x41; &amp;bogus; &lt;tag&gt;";

    test.each([
        [`\`${literal}\``, `<p><code>${escaped}</code></p>`],
        [`\`\` ${literal} \`\``, `<p><code>${escaped}</code></p>`],
        [`\`\`\`\n${literal}\n\`\`\``, `<pre><code>${escaped}</code></pre>`],
        [`~~~\n${literal}\n~~~`, `<pre><code>${escaped}</code></pre>`],
        [`    ${literal}`, `<pre><code>${escaped}</code></pre>`],
        [`\t${literal}`, `<pre><code>${escaped}</code></pre>`],
    ])("escapes literal code in %s", (markdown, html) => {
        expect(parseMarkdownToHTML(markdown)).toBe(html);
    });

    const definitions = "[key]: /path\n[^note]: literal note\n*[HTML]: literal abbreviation\nkeep";
    test.each(["```", "~~~", "````"])("preserves definitions inside %s", fence => {
        expect(parseMarkdownToHTML(`${fence}text\n${definitions}\n${fence}`)).toBe(
            `<pre><code class="language-text">${definitions}</code></pre>`,
        );
    });

    test("preserves definitions in indented code without registering them", () => {
        const markdown = definitions.split("\n").map(line => `    ${line}`).join("\n") + "\n\n[key]";
        expect(parseMarkdownToHTML(markdown)).toBe(`<pre><code>${definitions}</code></pre>\n<p>[key]</p>`);
    });

    test("unclosed fence preserves definitions through EOF", () => {
        expect(parseMarkdownToHTML(`~~~\n${definitions}`)).toBe(`<pre><code>${definitions}</code></pre>`);
    });

    test("definitions in list fences do not shadow real definitions", () => {
        const markdown = `- Item\n\n  ~~~\n${definitions.split("\n").map(line => `  ${line}`).join("\n")}\n  ~~~\n- Next\n\n[key]: /real\n[^note]: Real note\n*[HTML]: Real abbreviation\n\n[key] [^note] HTML`;
        const html = parseMarkdownToHTML(markdown);
        expect(html).toContain(`<ul><li>Item<pre><code>${definitions}</code></pre></li><li>Next</li></ul>`);
        expect(html).toContain('href="/real"');
        expect(html).toContain('<li id="fn-note">Real note');
        expect(html).not.toContain("Real abbreviation");
        expect(html.match(/id="fnref-note"/g)).toHaveLength(1);
    });

    test("definition collection resumes after a fence with a shorter fence inside", () => {
        const markdown = "````\n```\n[key]: /code\n````\n\n[key]: /real\n\n[key]";
        expect(parseMarkdownToHTML(markdown)).toBe('<pre><code>```\n[key]: /code</code></pre>\n<p><a href="/real" target="_blank" rel="noopener">key</a></p>');
    });

    test("indented literal fences do not hide following definitions", () => {
        expect(parseMarkdownToHTML("    ```\n\n[key]: /real\n\n[key]")).toBe('<pre><code>```</code></pre>\n<p><a href="/real" target="_blank" rel="noopener">key</a></p>');
    });

    test("indented code inside a list preserves entities, definitions and blank lines", () => {
        expect(parseMarkdownToHTML("- Item\n\n      [key]: /path\n      [^note]: literal note\n\n        &amp;\n      keep\n\n- Next")).toBe(
            '<ul><li>Item<pre><code>[key]: /path\n[^note]: literal note\n\n  &amp;amp;\nkeep</code></pre></li><li>Next</li></ul>',
        );
    });

    test("definition collection follows code boundaries after a list interruption", () => {
        const markdown = "- Item\n  # Heading\n  ```text\n[key]: /path\n[^note]: literal note\nkeep\n  ```";
        expect(parseMarkdownToHTML(markdown)).toBe('<ul><li>Item</li></ul>\n<h1 id="heading">Heading</h1>\n<pre><code class="language-text">[key]: /path\n[^note]: literal note\nkeep</code></pre>');
    });
});

describe("Markdown references in link and image attributes", () => {
    const destination = "https://example.test/?a=1&amp;b=2";
    const title = "A &quot;quote&quot; &amp; B";
    const link = '<a href="https://example.test/?a=1&amp;b=2" title="A &quot;quote&quot; &amp; B" target="_blank" rel="noopener">x</a>';
    const image = '<img src="https://example.test/?a=1&amp;b=2" alt="x" title="A &quot;quote&quot; &amp; B">';

    test.each([
        [`[x](${destination} "${title}")`, link],
        [`![x](${destination} "${title}")`, image],
        [`[x](<${destination}> "${title}")`, link],
        [`![x](<${destination}> "${title}")`, image],
        [`[x][ref]\n\n[ref]: ${destination} "${title}"`, link],
        [`![x][ref]\n\n[ref]: ${destination} "${title}"`, image],
        [`[x][]\n\n[x]: ${destination} '${title}'`, link],
        [`![x][]\n\n[x]: ${destination} '${title}'`, image],
        [`[x]\n\n[x]: ${destination} (${title})`, link],
        [`![x]\n\n[x]: ${destination} (${title})`, image],
    ])("decodes inline and reference attributes in %s", (markdown, html) => {
        expect(parseMarkdownToHTML(markdown)).toBe(`<p>${html}</p>`);
    });

    test("named, numeric, uppercase hex and multi-codepoint references", () => {
        expect(parseMarkdownToHTML('[x](/&copy;/&#65;/&#x41;/&#X1F600;/&NotEqualTilde; "&apos; &Aacute; &alpha; &CounterClockwiseContourIntegral;")')).toBe(
            '<p><a href="/\u00a9/A/A/\u{1f600}/\u2242\u0338" title="&#039; \u00c1 \u03b1 \u2233" target="_blank" rel="noopener">x</a></p>',
        );
    });

    test("quotes and angle brackets cannot create attributes or tags", () => {
        expect(parseMarkdownToHTML('![x](/&quot;&#34;&#39;&lt;&gt; "&quot; onerror=&quot;alert(1) &lt;img&gt;")')).toBe(
            '<p><img src="/&quot;&quot;&#039;&lt;&gt;" alt="x" title="&quot; onerror=&quot;alert(1) &lt;img&gt;"></p>',
        );
    });

    test("unknown, unterminated and encoded entity spellings remain literal", () => {
        const source = "&amp;amp;/&amp;#65;/&bogus;/&copy/&#65/&#12345678;/&#x1234567;";
        const escaped = "&amp;amp;/&amp;#65;/&amp;bogus;/&amp;copy/&amp;#65/&amp;#12345678;/&amp;#x1234567;";
        expect(parseMarkdownToHTML(`[x](/${source} "${source}")`)).toBe(`<p><a href="/${escaped}" title="${escaped}" target="_blank" rel="noopener">x</a></p>`);
    });

    test("backslash-escaped ampersands stay literal in inline and reference attributes", () => {
        for (const markdown of ['[x](/\\&amp; "\\&quot;")', '[x][ref]\n\n[ref]: /\\&amp; "\\&quot;"']) {
            expect(parseMarkdownToHTML(markdown)).toBe('<p><a href="/&amp;amp;" title="&amp;quot;" target="_blank" rel="noopener">x</a></p>');
        }
    });

    test("invalid Unicode scalar values become replacement characters", () => {
        expect(parseMarkdownToHTML('[x](/&#0;/&#xD800;/&#x110000;)')).toBe('<p><a href="/\ufffd/\ufffd/\ufffd" target="_blank" rel="noopener">x</a></p>');
    });

    test.each(["java&#x73;cript:alert%281%29", "javascript&colon;alert%281%29", "java&Tab;script:alert%281%29", "java&NewLine;script:alert%281%29", "&#106;avascript:alert%281%29", "&#100;ata:text/html,payload", "vbscript&colon;msgbox%281%29", "javascript\\:alert%281%29", "java&#x73;cript\\:alert%281%29"])("blocks decoded executable URLs: %s", url => {
        for (const markdown of [`[click](${url})`, `![click](${url})`, `[click][ref]\n\n[ref]: ${url}`, `![click][ref]\n\n[ref]: ${url}`, `[ref]\n\n[ref]: ${url}`, `![ref]\n\n[ref]: ${url}`]) {
            const html = parseMarkdownToHTML(markdown);
            expect(html).not.toMatch(/<(?:a|img)\b/);
        }
    });

    test("escaped punctuation is resolved before URL validation for linked images", () => {
        expect(parseMarkdownToHTML('[![x](/image)](java&#x73;cript\\:alert%281%29)')).not.toContain("href=");
        expect(parseMarkdownToHTML('[outer [inner](java&#x73;cript\\:alert%281%29)](/url)')).not.toContain("href=");
    });

    test("inline tokens in attributes are restored as text before escaping", () => {
        expect(parseMarkdownToHTML('[x](/path "a \\"quoted\\" title &amp; `code`")')).toBe('<p><a href="/path" title="a &quot;quoted&quot; title &amp; `code`" target="_blank" rel="noopener">x</a></p>');
        expect(parseMarkdownToHTML('![x](/image "<span title=\'x\'>literal</span>")')).toBe('<p><img src="/image" alt="x" title="&lt;span title=&#039;x&#039;&gt;literal&lt;/span&gt;"></p>');
        expect(parseMarkdownToHTML('[x](/path "<user@example.test> [[label]] &amp; B")')).toBe('<p><a href="/path" title="&lt;user@example.test&gt; [[label]] &amp; B" target="_blank" rel="noopener">x</a></p>');
    });

    test("character references preserve encoded whitespace in attributes", () => {
        expect(parseMarkdownToHTML('[x](/path&#32; "&#32;title&#32;")')).toBe('<p><a href="/path " title=" title " target="_blank" rel="noopener">x</a></p>');
    });

    test("reference titles support escaped quotes alongside character references", () => {
        expect(parseMarkdownToHTML('[x][ref]\n\n[ref]: /&amp; "a \\"quote\\" &amp; B"')).toBe('<p><a href="/&amp;" title="a &quot;quote&quot; &amp; B" target="_blank" rel="noopener">x</a></p>');
    });

    test("linked images decode both destinations exactly once", () => {
        expect(parseMarkdownToHTML('[![A &amp; B](/image?a=1&amp;b=2)](/target?a=1&amp;b=2)')).toBe('<p><a href="/target?a=1&amp;b=2" target="_blank" rel="noopener"><img src="/image?a=1&amp;b=2" alt="A &amp; B"></a></p>');
        expect(parseMarkdownToHTML('[![x](/image)](java&#x73;cript:alert%281%29)')).not.toContain("href=");
    });

    test("entity characters do not become Markdown syntax or raw HTML", () => {
        expect(parseMarkdownToHTML("&#42;literal&#42; &lt;script&gt;alert(1)&lt;/script&gt;")).toBe("<p>&#42;literal&#42; &lt;script&gt;alert(1)&lt;/script&gt;</p>");
        expect(parseMarkdownToHTML('<a href="java&#x73;cript:alert(1)" onclick="alert(1)">x</a>')).toBe('<a href="java&amp;#x73;cript:alert(1)">x</a>');
    });
});

describe("inline code in image descriptions", () => {
    test.each([
        ["`code`", "code"],
        ["Use `first` and `second`", "Use first and second"],
        ["`` a ` b ``", "a ` b"],
        ["``` a `` b ```", "a `` b"],
        ["` padded `", "padded"],
        ["`   `", "   "],
        ["`[brackets]`", "[brackets]"],
        ["`&amp; &lt; &#65;` &amp; &#65;", "&amp;amp; &amp;lt; &amp;#65; &amp; A"],
        ["`\\*literal\\* \\&amp;`", "\\*literal\\* \\&amp;amp;"],
        ['`" onerror="alert(1) <tag>`', "&quot; onerror=&quot;alert(1) &lt;tag&gt;"],
        ["\\`literal\\` and `code`", "`literal` and code"],
        ["&#96;literal&#96; and `code`", "`literal` and code"],
        ["`unclosed", "`unclosed"],
        ["``unclosed", "``unclosed"],
        ["```unclosed", "```unclosed"],
        ["``code```", "``code```"],
    ])("renders code as safely escaped text: %s", (description, escapedAlt) => {
        const image = `<img src="/img" alt="${escapedAlt}">`;
        expect(parseMarkdownToHTML(`![${description}](/img)`)).toBe(`<p>${image}</p>`);
        expect(parseMarkdownToHTML(`[![${description}](/img)](/target)`)).toBe(`<p><a href="/target" target="_blank" rel="noopener">${image}</a></p>`);
    });

    test.each([
        "![`code`][image]\n\n[image]: /img",
        "![`code`][]\n\n[`code`]: /img",
        "![`code`]\n\n[`code`]: /img",
    ])("preserves reference image resolution: %s", markdown => {
        expect(parseMarkdownToHTML(markdown)).toBe('<p><img src="/img" alt="code"></p>');
    });

    test("destinations and titles retain literal backticks", () => {
        expect(parseMarkdownToHTML('![`code`](/`path` "`title` &amp; B")')).toBe('<p><img src="/`path`" alt="code" title="`title` &amp; B"></p>');
    });
});

test("classic browser script works offline without module or DOM dependencies", () => {
    const context = { window: {} };
    runInNewContext(readFileSync(new URL("md-renderer.js", import.meta.url), "utf8"), context);
    const parse = context.window.parseMarkdownToHTML;
    expect(context.window.parseMarkdownToModalHTML).toBe(parse);
    expect(parse("- ```js\n  &amp;\n  ```")).toBe('<ul><li><pre><code class="language-js">&amp;amp;</code></pre></li></ul>');
    expect(parse('[x](/&copy; "&quot;")')).toBe('<p><a href="/\u00a9" title="&quot;" target="_blank" rel="noopener">x</a></p>');
    expect(parse('![`&amp;`](/img)')).toBe('<p><img src="/img" alt="&amp;amp;"></p>');
});
