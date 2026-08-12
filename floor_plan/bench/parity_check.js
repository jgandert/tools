// forceWorkers parity: the worker path must select the same attempt as the
// sequential path, byte-identical in cost and NPE.
// Usage: [LO_PATH=<snapshot>] bun bench/parity_check.js [k] [seed...]
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const { wongLiuSimulatedAnnealing } = require(process.env.LO_PATH || path.join(ROOT, "sa_optimized.js"));
const { parseDSL } = require(path.join(ROOT, "parser.js"));

const k = parseInt(process.argv[2] || "2", 10);
const seeds = (process.argv.slice(3).length ? process.argv.slice(3) : ["42", "43"]).map(Number);

const text = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dsl = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);

const origLog = console.log;

async function run(seed, forceWorkers) {
    console.log = () => {
    };
    const r = await wongLiuSimulatedAnnealing(modules, {
        k,
        iter: 1, ...config,
        seed,
        forceWorkers,
    });
    console.log = origLog;
    return {
        cost: r.cost,
        npe: r.npe.join(" "),
        unsat: (r.unsatisfied ?? []).map(u => `${u.roomId}.${u.type}`).join(","),
    };
}

(async () => {
    let allMatch = true;
    for (const seed of seeds) {
        const seq = await run(seed, false);
        const par = await run(seed, true);
        const match = seq.cost === par.cost && seq.npe === par.npe && seq.unsat === par.unsat;
        allMatch = allMatch && match;
        console.log(`seed ${seed} k=${k} ${match ? "MATCH" : "MISMATCH"}`);
        console.log(`  seq cost=${seq.cost} unsat=[${seq.unsat}]`);
        console.log(`  par cost=${par.cost} unsat=[${par.unsat}]`);
        if (!match) {
            console.log(`  seq npe=${seq.npe}`);
            console.log(`  par npe=${par.npe}`);
        }
    }
    console.log(`PARITY ${allMatch ? "OK" : "FAILED"}`);
})();
