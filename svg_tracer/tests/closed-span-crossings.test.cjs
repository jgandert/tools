'use strict';
// Authored closed hooks reproduce the local fitting defect independently of
// any supplied raster: a tiny fold at a narrow return must not force the
// complete closed perimeter back to sample or integer-grid segments.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.TRACER_CORE || path.join(__dirname, '..', 'tracer.js'), 'utf8');
const exposed = source.replace('return {trace};', 'return {fitChain,repairSpanCrossings};');
assert.notEqual(exposed, source, 'Expose only the existing internal fitting boundary');
const { fitChain, repairSpanCrossings } = new Function(`${exposed}\nreturn createTracer();`)();

function sampleSegments(segments, steps = 128) {
    const points = [segments[0].a];
    for (const s of segments) {
        if (s.type === 'L') { points.push(s.b); continue; }
        for (let i = 1; i <= steps; i++) {
            if (i === steps) { points.push(s.b); continue; }
            const t = i / steps, u = 1 - t;
            if (s.type === 'C') points.push({
                x: u ** 3 * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t ** 3 * s.b.x,
                y: u ** 3 * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t ** 3 * s.b.y,
            });
            else {
                assert.equal(s.type, 'A');
                const angle = s.start + s.delta * t, x = s.rx * Math.cos(angle), y = s.ry * Math.sin(angle);
                points.push({ x: s.cx + Math.cos(s.angle) * x - Math.sin(s.angle) * y,
                    y: s.cy + Math.sin(s.angle) * x + Math.cos(s.angle) * y });
            }
        }
    }
    return points;
}
function hasCrossing(points) {
    const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (let i = 1; i < points.length; i++) for (let j = 1; j < i - 1; j++) {
        const a = points[i - 1], b = points[i], c = points[j - 1], d = points[j];
        if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
            || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
        if (turn(a, b, c) * turn(a, b, d) < -1e-20 && turn(c, d, a) * turn(c, d, b) < -1e-20) return true;
    }
    return false;
}
function distanceToPath(q, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
    }
    return best;
}
function hook(angle, start) {
    const points = [];
    for (let x = 0; x <= 30; x++) points.push({ x, y: .1 * Math.sin(.7 * x) });
    points.push({ x: 30.13, y: .1 * Math.sin(21) + .02 });
    for (let x = 30; x >= 15; x--) points.push({ x, y: .04 + .1 * Math.sin(.7 * x) + .02 * (30 - x) ** 1.5 });
    for (let i = 1; i <= 12; i++) {
        const a = i * Math.PI / 12;
        points.push({ x: 7.5 + 7.5 * Math.cos(a), y: 1.15 + 10 * Math.sin(a) });
    }
    const rotated = points.slice(start).concat(points.slice(0, start));
    rotated.push(rotated[0]);
    return rotated.map(p => ({ x: 41.25 + Math.cos(angle) * p.x - Math.sin(angle) * p.y,
        y: 63.375 + Math.sin(angle) * p.x + Math.cos(angle) * p.y }));
}
let cases = 0;
for (const freeLoop of [false, true]) for (const angle of [0, .3, Math.PI / 2, Math.PI]) {
    const samples = hook(angle, freeLoop ? 17 : 0), node = { p: samples[0] };
    const chain = { raw: samples.map(p => ({ ...p })), samples, a: node, b: node,
        closed: true, freeLoop, detailTolerance: .25 };
    fitChain(chain, .25);
    const fitted = sampleSegments(chain.segments);
    const label = `${freeLoop ? 'free' : 'anchored'} closed hook, rotation ${angle}`;
    assert.equal(hasCrossing(fitted), false, `${label}: preserve the narrow return`);
    assert.equal(chain.sampleFallback, false, `${label}: retain fitted distant curves`);
    assert(chain.segments.length < 24, `${label}: bounded local subdivision`);
    assert(chain.segments.some(s => s.type === 'C'), `${label}: retain curve commands`);
    assert.deepEqual(fitted[0], fitted.at(-1), `${label}: close the seam exactly`);
    for (let i = 1; i < chain.segments.length; i++)
        assert.deepEqual(chain.segments[i - 1].b, chain.segments[i].a, `${label}: connected joins`);
    for (const p of samples) assert(distanceToPath(p, fitted) <= .271, `${label}: source-to-curve tolerance`);
    for (const p of fitted) assert(distanceToPath(p, samples) <= .271, `${label}: curve-to-source tolerance`);
    cases++;
}
// A genuine smooth seam must not be counted as a crossing. The helper keeps
// successful curve objects intact rather than replacing a whole closed ring.
const k = .5522847498307936, p = (x, y) => ({ x: 20 + x * 10, y: 20 + y * 10 });
const circle = [
    { type: 'C', a: p(1, 0), c1: p(1, k), c2: p(k, 1), b: p(0, 1) },
    { type: 'C', a: p(0, 1), c1: p(-k, 1), c2: p(-1, k), b: p(-1, 0) },
    { type: 'C', a: p(-1, 0), c1: p(-1, -k), c2: p(-k, -1), b: p(0, -1) },
    { type: 'C', a: p(0, -1), c1: p(k, -1), c2: p(1, -k), b: p(1, 0) },
];
const retained = repairSpanCrossings(sampleSegments(circle, 16), circle, .25);
assert.equal(retained.length, circle.length, 'A smooth closed seam needs no subdivision');
retained.forEach((segment, i) => assert.equal(segment, circle[i], 'Retain unaffected curve objects'));
assert.deepEqual(repairSpanCrossings([], [], .25), [], 'Empty candidate remains empty');
console.log(JSON.stringify({ test: 'closed span repair', passed: true, hookCases: cases, seamControl: true }));
