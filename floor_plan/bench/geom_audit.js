// Audits the *delivered* outer layout against the constraints the shape curve
// was built from: per-room aspect vs effective ratio_max, min side vs effective
// side_min, and area vs target. Answers "does the post-SA canvas stretch ship
// geometry the cost curve never offered?".
// Usage: [LO_PATH=<snapshot>] bun bench/geom_audit.js [k] [seed...]
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const { wongLiuSimulatedAnnealing } = require(process.env.LO_PATH || path.join(ROOT, "sa_optimized.js"));
const { parseDSL } = require(path.join(ROOT, "parser.js"));

const k = parseInt(process.argv[2] || "2", 10);
const seeds = (process.argv.slice(3).length ? process.argv.slice(3) : ["42", "43", "44"]).map(Number);

const text = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dsl = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
const { config, modules } = parseDSL(dsl);

// Mirrors _runSingleSA's fill-in for rooms without an explicit area.
function effectiveModules() {
    const mods = modules.map(m => ({ ...m }));
    let defined = 0;
    const undef = [];
    for (const m of mods) {
        if (m.area) {
            defined += m.area;
        } else if (m.w && m.h) {
            defined += m.w * m.h;
        } else {
            undef.push(m);
        }
    }
    if (undef.length && config.canvasW && config.canvasH) {
        const per = Math.max(10, config.canvasW * config.canvasH - defined) / undef.length;
        for (const m of undef) {
            m.area = per;
            m.ratioMax = Math.max(m.ratioMax || 0, 6.0);
        }
    }
    return mods;
}

const origLog = console.log;

(async () => {
    const agg = [];
    for (const seed of seeds) {
        console.log = () => {
        };
        const result = await wongLiuSimulatedAnnealing(modules, { k, iter: 1, ...config, seed });
        console.log = origLog;

        const mods = effectiveModules();
        const byId = {};
        for (const m of mods) {
            byId[m.id] = m;
        }

        let aspectViol = 0, sideViol = 0, worstAspectExcess = 0, worstSideShort = 0, areaErr = 0;
        const lines = [];
        for (const room of result.layout) {
            const m = byId[room.id];
            if (!m) {
                continue;
            }
            const aspect = Math.max(room.w / room.h, room.h / room.w);
            const rMax = m.ratio ? Infinity : (m.ratioMax || config.ratioMax || 3.0);
            const sideMin = m.sideMin || (!config.sideMinFlexible && config.sideMin) || 0;
            const side = Math.min(room.w, room.h);
            const aExcess = aspect - rMax;
            const sShort = sideMin - side;
            if (aExcess > 1e-6) {
                aspectViol++;
                worstAspectExcess = Math.max(worstAspectExcess, aExcess);
            }
            if (sShort > 1e-6) {
                sideViol++;
                worstSideShort = Math.max(worstSideShort, sShort);
            }
            areaErr += Math.abs(room.w * room.h - m.area);
            lines.push(`  ${room.id.padEnd(12)} ${room.w.toFixed(0).padStart(5)}x${room.h.toFixed(0).padStart(5)}`
                + ` aspect=${aspect.toFixed(2)}/${rMax.toFixed(2)}${aExcess > 1e-6 ? " ASPECT!" : ""}`
                + ` side=${side.toFixed(0)}/${sideMin}${sShort > 1e-6 ? " SIDE!" : ""}`
                + ` area=${Math.round(room.w * room.h)}/${Math.round(m.area)}`);
        }
        console.log(`SEED ${seed} k=${k} cost=${Math.round(result.cost).toLocaleString()}`
            + ` unsat=${(result.unsatisfied ?? []).length}`);
        for (const l of lines) {
            console.log(l);
        }
        agg.push({
            seed, aspectViol, sideViol,
            worstAspectExcess: +worstAspectExcess.toFixed(2),
            worstSideShort: +worstSideShort.toFixed(1),
            areaErrM: +(areaErr / 1e6).toFixed(3),
        });
    }
    console.log(`AUDIT_AGG ${JSON.stringify(agg)}`);
})();
