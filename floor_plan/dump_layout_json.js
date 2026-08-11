const { parseDSL } = require("./parser.js");
const { optimizeParsed } = require("./orchestrator.js");
const fs = require("fs");

const text = fs.readFileSync("index.html", "utf8");
const dslMatch = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
if (!dslMatch) {
    throw new Error("No DSL found");
}
const parsed = parseDSL(dslMatch[1]);
if (parsed.errors.length) {
    throw new Error(parsed.errors.join("\n"));
}

(async () => {
    const result = await optimizeParsed({
        ...parsed,
        config: {
            ...parsed.config,
            k: 20,
            iter: 1,
        },
    });
    console.log(JSON.stringify(result.rooms, null, 4));
})();
