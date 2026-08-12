// Recursive-solve bench: resolves `inside` blocks (plain bench.js never calls
// optimizeRecursive) so inner child-room geometry is visible.
// Usage: [LO_PATH=<snapshot>] bun bench/bench_geom.js [k] [seed...]
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const LO_PATH = process.env.LO_PATH || path.join(ROOT, "sa_optimized.js");

global.wongLiuSimulatedAnnealing = require(LO_PATH).wongLiuSimulatedAnnealing;
const { optimizeRecursive } = require(path.join(ROOT, "orchestrator.js"));
const { parseDSL } = require(path.join(ROOT, "parser.js"));

const k = parseInt(process.argv[2] || "2", 10);
const seeds = (process.argv.slice(3).length ? process.argv.slice(3) : ["42", "43", "44"]).map(Number);

const text = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dsl = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);

const origLog = console.log;

(async () => {
    const worst = [];
    for (const seed of seeds) {
        console.log = () => {
        };
        const result = await optimizeRecursive(modules, {
            k,
            iter: 1, ...config,
            algo: "sa",
            seed,
        }, undefined, []);
        console.log = origLog;

        const loud = result.rooms.find(r => r.id === "loud");
        console.log(`SEED ${seed} k=${k} outerCost=${Math.round(result.cost).toLocaleString()}`
            + `  loud=${loud ? `${loud.w.toFixed(1)}x${loud.h.toFixed(1)}` : "n/a"}`);
        if (!loud?.inside) {
            console.log("  no inside result");
            continue;
        }
        let maxAspect = 0;
        let minSide = Infinity;
        for (const c of loud.inside.rooms) {
            const aspect = Math.max(c.w / c.h, c.h / c.w);
            const side = Math.min(c.w, c.h);
            maxAspect = Math.max(maxAspect, aspect);
            minSide = Math.min(minSide, side);
            console.log(`  ${c.id}: ${c.w.toFixed(1)} x ${c.h.toFixed(1)}  aspect=${aspect.toFixed(2)}  minSide=${side.toFixed(1)}`);
        }
        worst.push({ seed, maxAspect: +maxAspect.toFixed(2), minSide: +minSide.toFixed(1) });
    }
    console.log(`GEOM_AGG ${JSON.stringify(worst)}`);
})();
