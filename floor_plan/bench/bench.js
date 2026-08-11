// Multi-seed benchmark for the default index.html DSL.
// Usage: bun bench/bench.js [seed]   (default 42; run 42 43 44 for comparisons)
const { wongLiuSimulatedAnnealing } = require("../sa_optimized.js");
const { parseDSL } = require("../parser.js");
const fs = require("fs");
const path = require("path");

const seed = parseInt(process.argv[2] || "42", 10);
const text = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const dsl = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);

(async () => {
    const t0 = performance.now();
    const result = await wongLiuSimulatedAnnealing(modules, { k: 2, iter: 1, ...config, seed });
    const ms = Math.round(performance.now() - t0);
    console.log("BENCH_RESULT " + JSON.stringify({
        seed,
        cost: result.cost,
        ms,
        unsatisfied: (result.unsatisfied ?? []).map(u => `${u.roomId}.${u.type}`),
        breakdown: result.breakdown,
    }));
})();
