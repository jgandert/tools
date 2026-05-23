const { wongLiuSimulatedAnnealing } = require("./layout_optimizer.js");
const { parseDSL } = require("./parser.js");
const fs = require("fs");

const text = fs.readFileSync("index.html", "utf8");
const dslMatch = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
if (!dslMatch) {
    console.log("No DSL found");
    process.exit(1);
}
const dsl = dslMatch[1];
// Strip HTML encoding if any, though it's likely raw
const { config, modules } = parseDSL(dsl);

if (modules.length === 1) {
    modules.push({ id: "_dummy", area: 1, w: 1, h: 1, rules: [] });
}

(async () => {
    const result = await wongLiuSimulatedAnnealing(modules, {
        k: 2,
        iter: 1,
        ...config,
    });
    console.log(result.cost);
    console.log(result.npe.join(" "));
})();
