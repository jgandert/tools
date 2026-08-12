// Multi-seed bench over the current default index.html DSL with an aggregate line.
// Usage: bun bench/bench_seeds.js [k] [--workers] [seed...]
// LO_PATH lets a before/after run point at a snapshot in temp/pipeline_backups/
const { wongLiuSimulatedAnnealing } = require(process.env.LO_PATH || "../sa_optimized.js");
const { parseDSL } = require("../parser.js");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const forceWorkers = args.includes("--workers");
const rest = args.filter(a => a !== "--workers");
const k = parseInt(rest[0] || "2", 10);
const seeds = (rest.slice(1).length ? rest.slice(1) : ["42", "43", "44"]).map(Number);

const text = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const dsl = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);

const origLog = console.log;

(async () => {
    const rows = [];
    for (const seed of seeds) {
        console.log = () => {
        };
        const t0 = performance.now();
        const result = await wongLiuSimulatedAnnealing(modules, {
            k,
            iter: 1, ...config,
            seed,
            forceWorkers,
        });
        const ms = Math.round(performance.now() - t0);
        console.log = origLog;
        const unsat = (result.unsatisfied ?? []).map(u => `${u.roomId}.${u.type}`);
        rows.push({ seed, cost: result.cost, ms, unsat });
        console.log(`seed ${seed}  cost=${Math.round(result.cost).toLocaleString().padStart(12)}`
            + `  ${String(ms).padStart(6)}ms  unsat=${unsat.length}  ${unsat.join(",")}`);
    }
    const satisfied = rows.filter(r => r.unsat.length === 0).length;
    console.log(`AGG ${JSON.stringify({
        k, workers: forceWorkers, seeds: seeds.join("/"),
        avgCost: Math.round(rows.reduce((s, r) => s + r.cost, 0) / rows.length),
        satisfiedSeeds: `${satisfied}/${rows.length}`,
        unsatTotal: rows.reduce((s, r) => s + r.unsat.length, 0),
        costs: rows.map(r => Math.round(r.cost)),
    })}`);
})();
