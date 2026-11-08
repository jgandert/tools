/* Exhaustive oracle for intersection candidate search and allocation-free
 * ownership bands. Run: node tests/validation-search.test.cjs [core.js]
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js'));
const source = fs.readFileSync(corePath, 'utf8');
const hook = 'return {trace};';
assert.equal(source.split(hook).length, 2, 'One self-contained factory return');
const context = { module: { exports: {} } };
vm.createContext(context);
vm.runInContext(source.replace(hook,
    'return {trace,validateIntersections,insideSwept,inside,segmentConflict,project,same,dist2};'), context);
const { validateIntersections, insideSwept, inside, segmentConflict, project, same, dist2 } = context.module.exports.createTracer();

// The oracle deliberately enumerates ALL previous segments, without a spatial
// grid, bounds rejection, or duplicate suppression. It reuses the established
// exact pair predicate to isolate the correctness of the optimized search.
function exhaustive(g) {
    const segments = [], bad = new Set(), uncertain = new Set();
    for (const chain of g.chains) for (let i = 1; i < chain.flat.length; i++) {
        const a = chain.flat[i - 1], b = chain.flat[i];
        if (dist2(a, b) < 1e-18) continue;
        if ([a, b].some(p => p.x < -1e-7 || p.y < -1e-7 || p.x > g.w + 1e-7 || p.y > g.h + 1e-7)) bad.add(chain.id);
        const curved = chain.segments.some(segment => segment.type !== 'L');
        for (const other of segments) {
            const previous = other.chain;
            let allowed = chain === previous && (Math.abs(i - other.i) === 1 ||
                chain.closed && ((i === 1 && other.i === chain.flat.length - 1) ||
                    (other.i === 1 && i === chain.flat.length - 1)));
            if (chain !== previous) {
                for (const [node, endpoint] of [[chain.a, chain.flat[0]], [chain.b, chain.flat.at(-1)]]) {
                    for (const [otherNode, otherEndpoint] of [[previous.a, previous.flat[0]], [previous.b, previous.flat.at(-1)]]) {
                        if (node === otherNode && same(endpoint, otherEndpoint) &&
                            (same(a, endpoint) || same(b, endpoint)) &&
                            (same(other.a, otherEndpoint) || same(other.b, otherEndpoint))) allowed = true;
                    }
                }
            }
            if (segmentConflict(a, b, other.a, other.b, allowed)) {
                bad.add(chain.id); bad.add(previous.id);
            } else if (!allowed && (curved || other.curved) &&
                Math.min(project(a, other.a, other.b).d, project(b, other.a, other.b).d,
                    project(other.a, a, b).d, project(other.b, a, b).d) <
                (curved ? chain.flatTolerance : 0) + (other.curved ? previous.flatTolerance : 0) + .0001) {
                bad.add(chain.id); bad.add(previous.id);
                uncertain.add(chain.id); uncertain.add(previous.id);
            }
        }
        segments.push({ a, b, chain, i, curved });
    }
    return { bad, uncertain, checkedSegments: segments.length };
}
const normalize = result => ({ bad: [...result.bad].sort((a, b) => a - b),
    uncertain: [...result.uncertain].sort((a, b) => a - b), checkedSegments: result.checkedSegments });
const point = (x, y) => ({ x, y });
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
let searchCases = 0, bandCases = 0, ringCases = 0;
function exhaustiveInside(p, poly) {
    let parity = false;
    for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) parity = !parity;
    }
    return parity;
}
function check(chains) {
    const graph = { w: 96, h: 96, chains: chains.map((flat, id) => ({ id, flat,
        a: {}, b: {}, closed: same(flat[0], flat.at(-1)),
        segments: [{ type: id % 3 ? 'C' : 'L' }], flatTolerance: id % 2 ? .0125 : .001 })) };
    // Deliberately share several endpoints across otherwise unrelated chains.
    const shared = new Map();
    for (const chain of graph.chains) for (const [key, p] of [['a', chain.flat[0]], ['b', chain.flat.at(-1)]]) {
        const token = `${p.x},${p.y}`;
        if (!shared.has(token)) shared.set(token, {});
        chain[key] = shared.get(token);
    }
    assert.deepEqual(normalize(validateIntersections(graph)), normalize(exhaustive(graph)), `Exhaustive search case ${searchCases++}`);
}

// Long diagonals span many hash cells; almost coincident chords straddle cell
// boundaries. Closed seams, shared nodes, overlaps and zero-length edges are
// included independently of the seeded cases below.
check([
    [point(0, 0), point(96, 96)], [point(0, 96), point(96, 0)],
    [point(12 - .00005, 4), point(12 - .00005, 90)],
    [point(12 + .00005, 5), point(12 + .00005, 91)],
    [point(24, 24), point(36, 24), point(36, 36), point(24, 24)],
    [point(24, 24), point(24, 24), point(12, 12)],
    [point(24, 24), point(30, 24), point(36, 24)],
    [point(-.001, 2), point(7, 3)],
]);
for (let trial = 0; trial < 32; trial++) {
    const chains = [];
    for (let c = 0; c < 18; c++) {
        const x = Math.floor(random() * 8) * 12, y = Math.floor(random() * 8) * 12;
        const flat = [point(x, y)];
        for (let edge = 0; edge < 1 + c % 5; edge++) flat.push(point(
            Math.max(0, Math.min(96, x + (random() - .5) * 30)),
            Math.max(0, Math.min(96, y + (random() - .5) * 30))));
        if (c % 7 === 0) flat.push(flat[0]);
        chains.push(flat);
    }
    check(chains);
    for (let c = 0; c < chains.length; c++) {
        const raw = chains[c], fitted = raw.map(p => point(p.x + (random() - .5) * 2, p.y + (random() - .5) * 2));
        const probes = [...raw, ...fitted, ...Array.from({ length: 12 }, () => point(random() * 96, random() * 96))];
        for (const p of probes) {
            assert.equal(insideSwept(p, raw, fitted), exhaustiveInside(p, raw.concat(fitted.slice().reverse(), [raw[0]])),
                `Same directed ownership band ${bandCases++}`);
        }
    }
}
// Longer rings exercise the reused polyline tree, repeated y extrema and
// horizontal segments. Include exact vertices, equality on a node's y bound,
// reversed rings, narrow folds, and ordinary random probes.
for (const length of [79, 80, 81, 128, 517]) {
    const raw = Array.from({ length }, (_, i) => {
        const angle = i * 2 * Math.PI / (length - 1), radius = 20 + 7 * Math.sin(11 * angle);
        return point(48 + radius * Math.cos(angle), Math.round((48 + radius * Math.sin(angle)) * 4) / 4);
    });
    raw[raw.length - 1] = raw[0];
    const fitted = raw.map(p => point(p.x + (random() - .5), p.y + (random() - .5)));
    const probes = [...raw, ...fitted, ...raw.map(p => point(random() * 96, p.y)),
        ...Array.from({ length: 512 }, () => point(random() * 96, random() * 96))];
    for (const p of probes) {
        assert.equal(inside(p, raw), exhaustiveInside(p, raw), `Indexed ring ${ringCases++}`);
        assert.equal(inside(p, raw, true), exhaustiveInside(p, raw.slice().reverse()), `Reversed indexed ring ${ringCases++}`);
        assert.equal(insideSwept(p, raw, fitted), exhaustiveInside(p, raw.concat(fitted.slice().reverse(), [raw[0]])),
            `Long ownership band ${bandCases++}`);
    }
}
console.log(`PASS ${searchCases} exhaustive intersection searches, ${ringCases} indexed ring queries and ${bandCases} directed ownership bands`);
