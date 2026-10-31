const assert = require("node:assert/strict");
global.window = global;
require("../asset-loader.js");
const a = presentationAssets;
const bytes = new Uint8Array(50003);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const u = a.urlsFor(new Map([["fonts/body.woff2", bytes], ["fonts/Font (one),regular.ttf", bytes], ["fonts/a b.ttf", bytes], ["fonts/a\"b.ttf", bytes], ["images/a.svg", new TextEncoder().encode("<svg/>")]]));
assert.deepEqual(Buffer.from(u.get("fonts/body.woff2").split(",")[1], "base64"), Buffer.from(bytes));
let checks = 1;
for (const source of ["url(\"fonts/body.woff2\")", "url('fonts/body.woff2')", "url(fonts/body.woff2)", String.raw`url("font\73 /body.woff2")`, String.raw`u\72l("fonts/body.woff2")`, "URL(\"./fonts/../fonts/body.woff2?v=1\")"]) {
    const r = a.rewriteCss("@font-face {src:" + source + "}", u);
    assert.equal(r.references.length, 1);
    assert.equal(r.references[0].path, "fonts/body.woff2");
    assert.ok(r.css.includes("data:font/woff2;base64,"));
    checks++;
}
for (const [source, path] of [[String.raw`url(fonts/Font\ \(one\),regular.ttf)`, "fonts/Font (one),regular.ttf"], ["url(\"fonts/a%20b.ttf\")", "fonts/a b.ttf"], [String.raw`url("fonts/a\"b.ttf")`, "fonts/a\"b.ttf"]]) {
    assert.equal(a.rewriteCss(source, u).references[0].path, path);
    checks++;
}
for (const source of ["/* url(\"x\") */", "p:before{content:\"url(hello)\";}"]) {
    assert.equal(a.rewriteCss(source, u).css, source);
    assert.equal(a.rewriteCss(source, u).references.length, 0);
    checks++;
}
for (const source of ["url(../outside.ttf)", "url(/outside.ttf)", "url(https://example.org/a.ttf)", "url(%2e%2e/a.ttf)", "url(file:///tmp/a.ttf)", "url(blob:null/other)"]) {
    assert.equal(a.rewriteCss(source, u).references[0].kind, "blocked");
    checks++;
}
assert.equal(a.rewriteCss("url(fonts/missing.woff2)", u).references[0].kind, "missing");
checks++;
assert.equal(a.rewriteCss("/*# sourceMappingURL= */", u).css.includes("sourceMappingURL="), false);
checks++;
assert.equal(a.rewriteCss("p{content:\"/*# sourceMappingURL=x */\"}", u).css, "p{content:\"/*# sourceMappingURL=x */\"}");
checks++;
assert.equal(a.rewriteCss("url(\"data:image/svg+xml;base64,PHN2Zy8+\")", u).references[0].kind, "data");
checks++;
a.releaseUrls(u);
console.log(`${checks} asset-resolution checks passed`);
