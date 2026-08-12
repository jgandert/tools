// Per-attempt required-rule probe for the CURRENT default DSL in index.html.
// Reports, for every retry attempt of every seed: cost, unsatisfied required rules,
// whether the repair phase ran, and the geometry/penalty of `parents not at south`.
// Usage: bun bench/notat_probe.js [k] [seed...]      (defaults k=20, seeds 42 43 44)
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SCRATCH = process.env.PROBE_SCRATCH || path.join(os.tmpdir(), "notat_probe");
fs.mkdirSync(SCRATCH, { recursive: true });

// Re-export the optimizer's internals (penalty fns + PENALTIES) from a fresh copy so
// the probe can never drift from sa_optimized.js.
const EXTRA_EXPORTS = "\nmodule.exports.PENALTIES = PENALTIES;"
    + "\nmodule.exports.penaltyNotAt = penaltyNotAt;"
    + "\nmodule.exports.penaltyAt = penaltyAt;"
    + "\nmodule.exports.penaltyFar = penaltyFar;"
    + "\nmodule.exports.penaltyConnect = penaltyConnect;\n";

const exportedPath = path.join(SCRATCH, "lo_exported.js");
fs.writeFileSync(exportedPath, fs.readFileSync(path.join(ROOT, "sa_optimized.js"), "utf8") + EXTRA_EXPORTS);

const { parseDSL } = require(path.join(ROOT, "parser.js"));
const LO = require(exportedPath);

const k = parseInt(process.argv[2] || "20", 10);
const seeds = (process.argv.slice(3).length ? process.argv.slice(3) : ["42", "43", "44"]).map(Number);

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dsl = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);
const modulesMap = Object.fromEntries(modules.map(m => [m.id, m]));

const MAX_RETRIES = config.requiredMaxRetries ?? 10;
const origLog = console.log;

function notAtDetail(layout) {
    const mod = modulesMap["parents"];
    const rule = mod?.rules?.find(r => r.type === "not_at");
    const room = layout.find(r => r.id === "parents");
    if (!rule || !room) {
        return null;
    }
    const gW = layout.reduce((m, r) => Math.max(m, r.x + r.w), 0);
    const gH = layout.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    const canvasDiagSq = gW * gW + gH * gH;
    return {
        dSouth: +(gH - (room.y + room.h)).toFixed(1),
        targetDepth: mod.sideMin || LO.PENALTIES.DEFAULT_SIDE_MIN,
        penalty: Math.round(LO.penaltyNotAt(room, rule, mod, gW, gH, 1, canvasDiagSq, 1)),
        atPenalty: Math.round(mod.rules.filter(r => r.type === "at")
            .reduce((s, r) => s + LO.penaltyAt(room, r, gW, gH, 1, Math.sqrt(canvasDiagSq), 1), 0)),
        farPenalty: Math.round(mod.rules.filter(r => r.type === "far")
            .reduce((s, r) => s + LO.penaltyFar(room, r, Math.sqrt(canvasDiagSq), 1, 1), 0)),
    };
}

(async () => {
    const summary = [];
    for (const seed of seeds) {
        const rows = [];
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const attemptSeed = attempt === 0 ? seed : seed + attempt * 0x17A4B3C1;
            console.log = () => {
            };
            const result = await LO._runSingleSA(modules, { ...config, k, seed: attemptSeed });
            console.log = origLog;
            const unsat = LO.checkRequiredSatisfied(result.layout, modulesMap);
            rows.push({
                attempt,
                cost: result.cost,
                unsat: unsat.map(u => `${u.roomId}.${u.type}`),
                repaired: !!result.repairAttempted,
                notAt: notAtDetail(result.layout),
            });
        }

        // mirror _selectRequiredBest: lexicographic (unsat, cost) best over attempts,
        // stopping SATISFIED_LOOKAHEAD=3 attempts after the first naturally-satisfied one
        let kept = null;
        let satisfiedAt = -1;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!kept || r.unsat.length < kept.unsat.length
                || (r.unsat.length === kept.unsat.length && r.cost < kept.cost)) {
                kept = r;
            }
            if (satisfiedAt < 0 && r.unsat.length === 0 && !r.repaired) {
                satisfiedAt = i;
            }
            if (satisfiedAt >= 0 && i >= satisfiedAt + 3) {
                break;
            }
        }

        const notAtUnsat = rows.filter(r => r.unsat.includes("parents.not_at")).length;
        const anyUnsat = rows.filter(r => r.unsat.length > 0).length;
        const firstNotAtOk = rows.findIndex(r => !r.unsat.includes("parents.not_at"));
        const satisfied = rows.filter(r => r.unsat.length === 0);

        console.log(`\n### seed ${seed}  k=${k}`);
        for (const r of rows) {
            console.log(`  attempt ${String(r.attempt).padStart(2)}`
                + `  cost=${Math.round(r.cost).toLocaleString().padStart(12)}`
                + `  unsat=${r.unsat.length}${r.repaired ? " (rep)" : "     "}`
                + `  dS=${String(r.notAt?.dSouth ?? "-").padStart(7)}`
                + `  notAtPen=${String((r.notAt?.penalty ?? 0).toLocaleString()).padStart(11)}`
                + `  ${r.unsat.join(",")}`);
        }
        const row = {
            seed, k,
            kept: Math.round(kept.cost), keptAttempt: kept.attempt, keptUnsat: kept.unsat,
            notAtUnsatAttempts: notAtUnsat, anyUnsatAttempts: anyUnsat, attempts: rows.length,
            firstNotAtOkAttempt: firstNotAtOk,
            naturallySatisfied: satisfied.length,
        };
        summary.push(row);
        console.log(`  PROBE ${JSON.stringify(row)}`);
    }

    const tot = summary.reduce((a, s) => ({
        notAt: a.notAt + s.notAtUnsatAttempts,
        any: a.any + s.anyUnsatAttempts,
        att: a.att + s.attempts,
        cost: a.cost + s.kept,
    }), { notAt: 0, any: 0, att: 0, cost: 0 });
    console.log(`\nAGGREGATE ${JSON.stringify({
        k,
        seeds: seeds.join("/"),
        notAtUnsat: `${tot.notAt}/${tot.att}`,
        anyUnsat: `${tot.any}/${tot.att}`,
        avgKeptCost: Math.round(tot.cost / summary.length),
    })}`);
})();
