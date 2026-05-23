#!/usr/bin/env bun
// Updates the default-result-cache slot in index.html with a pre-computed
// optimization result for the default DSL, so the page doesn't run SA on load.
const fs = require("fs");
const path = require("path");
const { parseDSL } = require("./parser.js");
const { stripComments, optimizeRecursive } = require("./orchestrator.js");

const HTML_PATH = path.join(__dirname, "index.html");

async function main() {
    const html = fs.readFileSync(HTML_PATH, "utf8");

    const CACHE_PATTERN = /(<script\s+id="default-result-cache"[^>]*>)([\s\S]*?)(<\/script>)/;
    if (!CACHE_PATTERN.test(html)) {
        throw new Error("Cache slot <script id=\"default-result-cache\"> not found in index.html");
    }

    const dslMatch = html.match(/<textarea[^>]*id="rules-input"[^>]*>([\s\S]*?)<\/textarea>/);
    if (!dslMatch) {
        throw new Error("Could not find #rules-input textarea in index.html");
    }

    const defaultDsl = dslMatch[1].trim();
    const stripped = stripComments(defaultDsl);

    const { config, modules, errors } = parseDSL(defaultDsl);
    if (errors.length > 0) {
        throw new Error(`DSL parse errors:\n${errors.join("\n")}`);
    }

    console.log(`Optimizing ${modules.length} rooms...`);
    const { signal } = new AbortController();
    const result = await optimizeRecursive(modules, config, signal);
    console.log(`Done. Cost: ${result.cost.toFixed(2)}`);

    // Escape </script> to prevent premature tag closure inside the JSON blob
    const json = JSON.stringify({ dsl: stripped, config, result })
        .replace(/<\/script>/gi, "<\\/script>");

    const updated = html.replace(CACHE_PATTERN, `$1${json}$3`);
    fs.writeFileSync(HTML_PATH, updated);
    console.log("index.html cache updated.");
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
