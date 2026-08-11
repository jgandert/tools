import { classifyAdvisoryGeometry } from "./interest_report.js";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const rooms = [
    { id: "dressing", path: "dressing", parent: null, area: 30000, sideMin: 175, ratioMax: 5 / 3, hasChildren: false },
    { id: "child", path: "suite/child", parent: "suite", area: 40000, sideMin: 190, ratioMax: 2, hasChildren: false },
    { id: "feasible", path: "feasible", parent: null, area: 40000, sideMin: 175, ratioMax: 2, hasChildren: false },
];
const sideMin = [
    { room: "dressing", minSide: 160, shortfall: 15, violated: true },
    { room: "child", minSide: 170, shortfall: 20, violated: true },
    { room: "feasible", minSide: 200, shortfall: -25, violated: false },
];
const geom = {
    bboxCm(room) {
        return room === "suite" ? { w: 180, h: 400 } : null;
    },
};
const result = classifyAdvisoryGeometry(rooms, geom, sideMin);

assert(result.intrinsic.length === 1 && result.intrinsic[0].room === "dressing", "detect exact-area side_min conflict");
assert(result.intrinsic[0].areaShortfall === 625, "report exact area shortfall");
assert(result.delivered.find(item => item.room === "dressing").kind === "delivered-layout", "do not overclaim observed outer-room miss");
assert(result.delivered.find(item => item.room === "child").kind === "delivered-containing-geometry", "detect delivered parent bbox blocker");
assert(!result.delivered.some(item => item.room === "feasible"), "omit satisfied advisory geometry");

console.log("advisory geometry reporting: 5 passed");
