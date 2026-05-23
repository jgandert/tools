const {
    evaluateCost,
    passesTopologicalBoundaryCheck,
    pruneCurve,
} = require("./layout_optimizer.js");
const { parseDSL } = require("./parser.js");
const fs = require("fs");

const text = fs.readFileSync("index.html", "utf8");
const dslMatch = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
const dsl = dslMatch[1];
const { config, modules } = parseDSL(dsl);

// Calculate remaining area for rooms without size constraints
let definedAreaSum = 0;
const undefinedRooms = [];

for (const m of modules) {
    if (m.area) {
        definedAreaSum += m.area;
    } else if (m.w && m.h) {
        definedAreaSum += m.w * m.h;
    } else if (!m.curve) {
        undefinedRooms.push(m);
    }
}

if (undefinedRooms.length > 0) {
    if (config.canvasW && config.canvasH) {
        const totalCanvasArea = config.canvasW * config.canvasH;
        const remainingArea = Math.max(10, totalCanvasArea - definedAreaSum);
        const areaPerUndefinedRoom = remainingArea / undefinedRooms.length;

        for (const m of undefinedRooms) {
            m.area = areaPerUndefinedRoom;
            m.ratioMax = Math.max(m.ratioMax || 0, 6.0); // Make shape highly flexible
        }
    } else {
        for (const m of undefinedRooms) {
            m.area = 10000;
            m.ratioMax = Math.max(m.ratioMax || 0, 6.0);
        }
    }
}

const modulesMap = {};
for (const m of modules) {
    if (!m.curve) {
        if (m.w && m.h) {
            m.curve = pruneCurve([
                { w: m.w, h: m.h },
                { w: m.h, h: m.w },
            ]);
        } else if (m.area) {
            const curve = [];
            if (m.ratio) {
                const w = Math.sqrt(m.area * m.ratio);
                const h = m.area / w;
                curve.push({ w, h });
                curve.push({ w: h, h: w });
            } else {
                const ratioMax = m.ratioMax || 3.0;
                let w_max = Math.sqrt(m.area * ratioMax);
                let w_min = Math.sqrt(m.area / ratioMax);
                const globalSideMin = !config.sideMinFlexible && config.sideMin;
                const effectiveSideMin = m.sideMin || globalSideMin || 0;
                if (effectiveSideMin) {
                    w_min = Math.max(w_min, effectiveSideMin);
                    w_max = Math.min(w_max, m.area / effectiveSideMin);
                    if (w_min > w_max) {
                        w_min = w_max = Math.sqrt(m.area);
                    }
                }
                const samples = ratioMax <= 1.5 ? 3
                    : ratioMax <= 2.5 ? 5
                        : ratioMax <= 4.0 ? 7
                            : 10;
                const step = w_max === w_min ? 0 : (w_max - w_min) / (samples - 1);

                for (let i = 0; i < samples; i++) {
                    const w = w_min + i * step;
                    const h = m.area / w;
                    curve.push({ w, h });
                }
            }
            m.curve = pruneCurve(curve);
        } else {
            throw new Error(`Room '${m.id}' has no area or dimensions defined.`);
        }
    }
    modulesMap[m.id] = m;
}

const n = modules.length;
const currentNpe = [modules[0].id, modules[1].id, "V"];
for (let i = 2; i < n; i++) {
    currentNpe.push(modules[i].id, i % 2 === 0 ? "H" : "V");
}

console.log("Alt NPE:", currentNpe.join(" "));
const cost = evaluateCost(currentNpe, modulesMap, config, 1).cost;
console.log("Alt Cost:", cost);

const vNpe = [modules[0].id, modules[1].id, "V"];
for (let i = 2; i < n; i++) {
    vNpe.push(modules[i].id, "V");
}
const vCost = evaluateCost(vNpe, modulesMap, config, 1).cost;
console.log("V Cost:", vCost);

