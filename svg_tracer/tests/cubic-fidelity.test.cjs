'use strict';
// Authored four-sample bends expose a narrow reverse-distance excursion that
// coarse candidate chords can miss. Retain a locally subdivided curve instead
// of discarding the whole chain at the assembled fidelity check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.TRACER_CORE || path.join(__dirname, '..', 'tracer.js'), 'utf8');
const exposed = source.replace('return {trace};', 'return {fitChain};');
assert.notEqual(exposed, source);
const { fitChain } = new Function(`${exposed}\nreturn createTracer();`)();
function sample(segments) {
    const points = [segments[0].a];
    for (const s of segments) {
        if (s.type === 'L') { points.push(s.b); continue; }
        assert.equal(s.type, 'C');
        for (let i = 1; i <= 512; i++) {
            const t = i / 512, u = 1 - t;
            points.push({ x: u ** 3 * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t ** 3 * s.b.x,
                y: u ** 3 * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t ** 3 * s.b.y });
        }
    }
    return points;
}
function distance(q, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
    }
    return best;
}
let cases = 0;
for (const angle of [0, .3, Math.PI / 2, Math.PI]) for (const [left, right, y] of [[-.98, -.58, -1.19], [-.9, -.58, -1.17]]) {
    const turn = p => ({ x: 20 + p.x * Math.cos(angle) - p.y * Math.sin(angle),
        y: 20 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const points = [{ x: 0, y: 0 }, { x: .75, y: -1 }, { x: .9, y }, { x: 1.9, y: -1.35 }].map(turn);
    const chain = { raw: points.map(p => ({ ...p })), samples: points, a: { p: points[0] }, b: { p: points.at(-1) },
        freeLoop: false, closed: false, detailTolerance: .25,
        tangentA: { x: Math.cos(left + angle), y: Math.sin(left + angle) },
        tangentB: { x: Math.cos(right + angle), y: Math.sin(right + angle) } };
    fitChain(chain, .25);
    assert.equal(chain.sampleFallback, false, `Rotation ${angle}: preserve the fit by local subdivision`);
    assert(chain.segments.some(s => s.type === 'C'), 'Retain curve commands');
    assert(chain.segments.length <= 3, 'Keep the repaired bend compact');
    const fitted = sample(chain.segments);
    for (const p of points) assert(distance(p, fitted) <= .2701, 'Independent source-to-curve error');
    for (const p of fitted) assert(distance(p, points) <= .2701, 'Independent curve-to-source error');
    cases++;
}
console.log(JSON.stringify({ test: 'cubic candidate fidelity precision', passed: true, cases }));
