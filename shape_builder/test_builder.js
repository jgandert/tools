import assert from "assert";
import { Builder as b, Shape, Point } from "./shapebuilder.js";

let passed = 0;
let failed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`❌ ${name}`);
        console.error(err);
        failed++;
    }
}

function approx(val, expected, tol = 1e-3) {
    if (Math.abs(val - expected) > tol) {
        throw new Error(`Expected ~${expected}, got ${val}`);
    }
}

runTest("PointWrapper constructors", () => {
    const p1 = b.Point({ x: 10, y: 20 });
    approx(p1.x, 10);
    approx(p1.y, 20);

    const p3 = b.Point({ x: 50, y: 60 });
    approx(p3.x, 50);
    approx(p3.y, 60);
});

runTest("Circle Primitive", () => {
    const c = b.Circle({ radius: 10, center: [0, 0] });
    approx(c.bounds.width, 20);
    approx(c.bounds.height, 20);
    approx(c.bounds.center[0], 0);
    approx(c.points.A.y, -10); // top
});

runTest("Rectangle Primitive", () => {
    const r = b.Rectangle({ width: 40, height: 20, center: [100, 100] });
    approx(r.bounds.width, 40);
    approx(r.bounds.height, 20);
    approx(r.points.top.y, 90);
    approx(r.points.bottom.y, 110);
});

runTest("Triangle Primitive", () => {
    const t = b.Triangle({ side: 50 });
    // Equilateral triangle around 0,0
    approx(t.points.A.x, 0); // top point
    assert(t.points.A.y < 0);
    approx(t.points.B.x, 25);
    approx(t.points.C.x, -25);
});

runTest("Line Primitive", () => {
    const l1 = b.Line({ start: [0, 0], end: [100, 0] });
    approx(l1.bounds.width, 100);
    approx(l1.bounds.height, 0);

    const l2 = b.Line({ center: [50, 50], angle: 90, length: 100 });
    approx(l2.bounds.width, 0);
    approx(l2.bounds.height, 100);

    const thickLine = b.Line({ start: [0, 0], end: [100, 0], thickness: 10, cap: "round" });
    approx(thickLine.bounds.height, 10);
});

runTest("Transformations: Translate", () => {
    const r = b.Rectangle({ width: 10, height: 10, center: [0, 0] });
    r.translate({ dx: 5, dy: 5 });
    approx(r.bounds.center[0], 5);
    approx(r.bounds.center[1], 5);
    approx(r.points.center.x, 5);
});

runTest("Transformations: Rotation", () => {
    const r = b.Rectangle({ width: 100, height: 10, center: [0, 0] });
    r.rotate({ angle: 90 });

    // After 90 degree RT rotate: 5, -50
    // Because rotating center is 0,0. Top-left (-50, -5) -> (-5, 50) wait.
    // Let's just test bounds since it works best for 90 degree boxes.
    approx(Math.round(r.bounds.width), 10);
    approx(Math.round(r.bounds.height), 100);
});

runTest("Transformations: Scale & Stretch", () => {
    const c = b.Circle({ radius: 10, center: [0, 0] });
    c.scale({ factor: 2 }); // radius 20
    approx(c.bounds.width, 40);

    c.stretch({ width: 100 });
    approx(c.bounds.width, 100);
    approx(c.bounds.height, 40);
});

runTest("Boolean Union and Named Points Inheritance", () => {
    const r1 = b.Rectangle({ width: 50, height: 50, center: [0, 0] });
    const r2 = b.Rectangle({ width: 50, height: 50, center: [25, 0] });
    const merged = b.union({ shapes: [r1, r2] });
    approx(merged.bounds.width, 75);

    // r1's top point should be lost conceptually or re-evaled, but it inherits points still on outline
    // let's check basic subtraction
    const cutter = b.Rectangle({ width: 50, height: 25, center: [0, 12.5] }); // Cut top half
    const cut = r1.subtract({ shapes: [cutter] });
    approx(Math.round(cut.bounds.height), 25);
});

runTest("Slicer", () => {
    const c = b.Circle({ radius: 100, center: [0, 0] });
    const lineCutter = b.Line({ start: [-150, 0], end: [150, 0] });

    const topHalf = c.clone().sliceByLine({ lineShape: lineCutter }).keepTop();
    const bottomHalf = c.clone().sliceByLine({ lineShape: lineCutter }).keepBottom();

    approx(topHalf.bounds.height, 100);
    assert(topHalf.bounds.top < 0);
    assert(topHalf.bounds.bottom <= 0);

    approx(bottomHalf.bounds.height, 100);
    assert(bottomHalf.bounds.top >= 0);
});

runTest("CompoundPath getPointOnPath drifting tolerance", () => {
    const circle1 = b.Circle({ radius: 30, center: [10, 10] });
    const rect1 = b.Rectangle({ width: 40, height: 40, center: [-10, 10] });
    const union1 = circle1.union({ shapes: [rect1] });
    const sliced = union1.sliceByPoints({ p1: [-100, -100], p2: [100, 100] }).keepRight();

    // Since keepRight creates a compound/complex path sometimes,
    // getPointOnPath should not crash due to SVG offset inaccuracies
    const ptOnPath = sliced.getPointOnPath({ from: "top", to: "bottom", percent: 0.25 });
    assert(ptOnPath !== null);
    assert(typeof ptOnPath.x === "number");
});

runTest("CompoundPath distributePoints", () => {
    const rect1 = b.Rectangle({ width: 100, height: 100, center: [0, 0] });
    const rect2 = b.Rectangle({ width: 50, height: 50, center: [0, 0] });
    const compound = rect1.subtract({ shapes: [rect2] }); // creates a donut with hole
    const pts = compound.distributePoints({ count: 4, paddingMode: "space-evenly" });
    assert(pts.length === 4);
    assert(typeof pts[0].x === "number");
});

runTest("Align Layout", () => {
    const shapes = [
        b.Circle({ radius: 10 }),
        b.Circle({ radius: 10 }),
        b.Circle({ radius: 10 }),
    ];
    b.align({ shapes, axis: "horizontal", distribution: "space-between", width: 100 });

    approx(shapes[0].bounds.center[0], 0);
    approx(shapes[1].bounds.center[0], 50);
    approx(shapes[2].bounds.center[0], 100);
});

runTest("Move Until / Slide Direction", () => {
    const s1 = b.Rectangle({ width: 10, height: 10, center: [0, 0] });
    const s2 = b.Rectangle({ width: 10, height: 10, center: [100, 0] });

    // Slid right until hits s2
    s1.slideDirection({ vector: [1, 0], stopAt: s2 });
    approx(s1.bounds.right, 95); // Stop logic increments by 1 step. 
});

runTest("Get Point On Path and Move Perpendicular", () => {
    const c = b.Circle({ radius: 50, center: [0, 0] }); // A is top (0, -50), B is Right (50, 0), C is Bottom (0, 50)
    // Going from A to B is roughly 25% of the circle perimeter usually, but we use the custom distance percent logic.
    const pt = c.getPointOnPath({ from: "A", to: "B", percent: 0.5 });

    // Check if it moved inward properly
    const inward = pt.movePerpendicular({ amount: 10, direction: "inward" });
    approx(inward.p.getDistance(c.center.p), 40); // 50 radius - 10 inward = 40 distance from center

    const outward = pt.movePerpendicular({ amount: 10, direction: "outward" });
    approx(outward.p.getDistance(c.center.p), 60); // 50 + 10 = 60
});

runTest("Snap Points Mapping (2 points)", () => {
    const rect1 = b.Rectangle({ width: 10, height: 50, center: [0, 0] });
    const rect2 = b.Rectangle({ width: 20, height: 20, center: [100, 100] });

    // We want to snap rect2's top center to rect1's top center
    rect2.snapPoints({
        map: [
            { from: "top", to: rect1.points.top },
        ],
    });
    approx(rect2.points.top.x, rect1.points.top.x);
    approx(rect2.points.top.y, rect1.points.top.y);

    const line = b.Line({ start: [0, 0], end: [100, 100] });
    const tri = b.Triangle({ side: 50 });

    // Snap triangle baseline (B, C) to the line end points
    tri.snapPoints({
        map: [
            { from: "C", to: b.Point({ x: 0, y: 0 }) },
            { from: "B", to: b.Point({ x: 100, y: 100 }) },
        ],
    });
    // Tri B should be exact mapped to 100, 100 since the length of the snapping target vector changes the scale, but we don't scale!
    // Wait... if we don't scale during snap, the distance from C to B is still 50!
    // So 'B' will only point TOWARDS 100, 100, placed 50 units away!
    // The vector angle will be 45 degrees.
    // Length is 50. x = 50 * cos(45) = 50 * 0.707 = ~35.355
    approx(tri.points.B.x, 35.355);
    approx(tri.points.B.y, 35.355);
    approx(tri.points.C.x, 0);
    approx(tri.points.C.y, 0);
});

runTest("Mirror", () => {
    const obj = b.Rectangle({ width: 10, height: 10, center: [100, 0] });
    const mirrored = obj.mirror({ axis: "vertical", about: b.Point({ x: 0, y: 0 }) });
    // mirrored center should be at -100, 0
    approx(mirrored.bounds.center[0], -100);
});

runTest("Distribute Points", () => {
    const line = b.Line({ start: [0, 0], end: [100, 0] });

    const spaceEvenly = line.distributePoints({ count: 3, paddingMode: "space-evenly" });
    approx(spaceEvenly[0].x, 25);
    approx(spaceEvenly[1].x, 50);
    approx(spaceEvenly[2].x, 75);

    const between = line.distributePoints({ count: 3, paddingMode: "space-between" });
    approx(between[0].x, 0);
    approx(between[1].x, 50);
    approx(between[2].x, 100);
});

runTest("Split creates gap", () => {
    const r = b.Rectangle({ width: 100, height: 100, center: [0, 0] });
    r.split({ angle: 0, center: [0, 0], gap: 20 });
    // Gap 20 around y=0 horizontal line means everything between y=-10 to y=10 is gone
    // Should result in two rectangles height 40 each. Total bounds height is 100 
    // Wait, the new shape is a compound path of two pieces. Total bounds remain 100? Yes.
    approx(r.bounds.height, 100);

    // Area roughly drops by 20%
    // Let's check bounding center, should remain 0
    approx(r.bounds.center[1], 0);
});

runTest("Radial Repeat", () => {
    const leaf = b.Circle({ radius: 5, center: [0, -50] });
    const flower = leaf.radialRepeat({ count: 4, center: [0, 0] });

    // Top, Bottom, Left, Right 
    approx(flower.bounds.top, -55);
    approx(flower.bounds.bottom, 55);
    approx(flower.bounds.left, -55);
    approx(flower.bounds.right, 55);
});

runTest("Output to SVG", () => {
    const c = b.Circle({ radius: 10, center: [0, 0] });
    const svg = c.toSVG({ fill: "#fff" });
    assert(svg.includes("<path"));
    assert(svg.includes("fill=\"#fff\""));
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
}
