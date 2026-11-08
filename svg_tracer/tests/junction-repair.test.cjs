'use strict';
// Original procedural interfaces with a narrow, wavy separator meet at one
// shared junction. Long tangent estimates can leave their source sectors and
// cross a sibling interface even when tighter distance fits remain accurate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.TRACER_CORE || path.join(__dirname, '..', 'tracer.js'), 'utf8');
const exposed = source.replace('return {trace};', 'return {fitChain,repairGraph};');
assert.notEqual(exposed, source);
const api = new Function(`${exposed}\nreturn createTracer();`)();
function junction(angle, closed, height, offset) {
    const transform = p => ({ x: 40 + Math.cos(angle) * p.x - Math.sin(angle) * p.y,
        y: 40 + Math.sin(angle) * p.x + Math.cos(angle) * p.y });
    const origin = { x: 0, y: 0 };
    const rawA = [origin, { x: 0, y: 1 }, { x: 1, y: 1 }, ...Array.from({ length: 12 }, (_, i) => ({ x: 2 + i, y: 1 }))];
    const samplesA = [origin, { x: offset, y: .5 }, { x: .5, y: height },
        ...Array.from({ length: 12 }, (_, i) => ({ x: 1.5 + i, y: height + .02 * Math.sin(i * .5) })), { x: 13, y: 1 }];
    const rawB = [origin, ...Array.from({ length: 13 }, (_, i) => ({ x: 1 + i, y: 0 }))];
    const samplesB = [origin, ...Array.from({ length: 13 }, (_, i) => ({ x: .5 + i, y: .46 + .01 * Math.sin(i * .5) })), { x: 13, y: 0 }];
    const curves = closed ? [{ raw: rawA.concat(rawB.slice().reverse()), samples: samplesA.concat(samplesB.slice().reverse()) }]
        : [{ raw: rawA, samples: samplesA }, { raw: rawB, samples: samplesB }];
    curves.push(...[[origin, { x: 0, y: -10 }], [origin, { x: -10, y: 0 }]].map(raw => ({ raw, samples: raw })));
    const p = transform(origin), node = { id: 0, original: p, p, out: [0, 1, 2, 3] }, nodes = new Map([[0, node]]);
    const chains = curves.map((curve, id) => {
        const raw = curve.raw.map(transform), samples = curve.samples.map(transform), isClosed = closed && id === 0;
        const q = raw.at(-1), b = isClosed ? node : { id: id + 1, original: q, p: q, out: [1] };
        if (!isClosed) nodes.set(b.id, b);
        return { id, raw, samples, a: node, b, closed: isClosed, freeLoop: false,
            right: -1, left: -1, detailTolerance: .25, retry: 0 };
    });
    return { w: 80, h: 80, nodes, chains, loops: [], edges: [] };
}
function sample(segments) {
    const out = [segments[0].a];
    for (const s of segments) {
        if (s.type === 'L') { out.push(s.b); continue; }
        for (let k = 1; k <= 192; k++) {
            if (k === 192) { out.push(s.b); continue; }
            const t = k / 192, u = 1 - t;
            if (s.type === 'C') out.push({ x: u ** 3 * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t ** 3 * s.b.x,
                y: u ** 3 * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t ** 3 * s.b.y });
            else {
                const a = s.start + s.delta * t, x = s.rx * Math.cos(a), y = s.ry * Math.sin(a);
                out.push({ x: s.cx + Math.cos(s.angle) * x - Math.sin(s.angle) * y,
                    y: s.cy + Math.sin(s.angle) * x + Math.cos(s.angle) * y });
            }
        }
    }
    return out;
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
function crossing(paths) {
    const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const edges = paths.flatMap(p => p.slice(1).map((b, i) => ({ a: p[i], b })));
    for (let i = 0; i < edges.length; i++) for (let j = 0; j < i; j++) {
        const { a, b } = edges[i], { a: c, b: d } = edges[j];
        if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)
            || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
        if (turn(a, b, c) * turn(a, b, d) < -1e-20 && turn(c, d, a) * turn(c, d, b) < -1e-20) return true;
    }
    return false;
}
let cases = 0;
for (const reverseTraversal of [false, true]) for (const closed of [false, true]) for (const angle of [0, .3, Math.PI / 2, Math.PI]) for (const [height, offset] of [[.51, .4], [.8, .3]]) {
    const g = junction(angle, closed, height, offset);
    if (reverseTraversal) for (const c of g.chains) {
        c.raw.reverse(); c.samples.reverse();
        [c.a, c.b] = [c.b, c.a];
    }
    for (const c of g.chains) api.fitChain(c, .25);
    const report = api.repairGraph(g, [], .25, () => {}), label = `${reverseTraversal ? 'reverse' : 'forward'} ${closed ? 'anchored loop' : 'open interfaces'}, angle ${angle}, height ${height}`;
    assert.equal(report.validation.ok, true, `${label}: full junction topology validates`);
    assert.equal(report.globalExactFallback, false, `${label}: retain fitted geometry`);
    assert(g.chains.every(c => !c.exact && !c.sampleFallback), `${label}: no whole-chain pixel or sample fallback`);
    assert(g.chains.some(c => c.segments.some(s => s.type === 'C' || s.type === 'A')), `${label}: preserve curved boundaries`);
    assert(g.chains.reduce((n, c) => n + c.segments.length, 0) < 32, `${label}: compact geometry`);
    const paths = g.chains.map(c => sample(c.segments));
    assert.equal(crossing(paths), false, `${label}: independently sampled paths do not cross`);
    for (let i = 0; i < g.chains.length; i++) {
        const c = g.chains[i], points = paths[i];
        assert.deepEqual(points[0], c.a.p, `${label}: fixed shared start`);
        assert.deepEqual(points.at(-1), c.b.p, `${label}: fixed shared end`);
        for (const p of c.samples) assert(distance(p, points) <= c.fitTolerance + .021, `${label}: source-to-curve fidelity`);
        for (const p of points) assert(distance(p, c.samples) <= c.fitTolerance + .021, `${label}: curve-to-source fidelity`);
    }
    cases++;
}
console.log(JSON.stringify({ test: 'local junction tangent repair', passed: true, cases }));
