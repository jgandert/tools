// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

// Authored sparse hooks exercise crossings between individually simple curves
// on opposite sides of a sharp corner, independently of any captured artwork.
const source = readFileSync(process.env.TRACER_CORE || new URL('../tracer.js', import.meta.url), 'utf8');
const factory = source.replace('return {trace};', 'return {fitChain};');
if (factory === source) throw Error('Cannot expose the fitting boundary.');
const { fitChain } = new Function(`${factory}\nreturn createTracer();`)();

function sampleSegments(segments) {
    const points = [segments[0].a];
    for (const s of segments) {
        if (s.type === 'L') { points.push(s.b); continue; }
        if (s.type !== 'C') throw Error(`Unexpected fitting segment ${s.type}`);
        for (let i = 1; i <= 256; i++) {
            const t = i / 256, u = 1 - t;
            points.push({
                x: u ** 3 * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t ** 3 * s.b.x,
                y: u ** 3 * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t ** 3 * s.b.y,
            });
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

function distanceToPath(q, path) {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy));
    }
    return best;
}

for (const angle of [0, .3, Math.PI / 2, Math.PI]) test(`a sharp narrow hook preserves its two sides (rotation ${angle})`, () => {
    const points = [];
    for (let x = 0; x <= 30; x++) points.push({ x, y: .1 * Math.sin(.7 * x) });
    points.push({ x: 30.13, y: .1 * Math.sin(21) + .02 });
    for (let x = 30; x >= 15; x--) points.push({ x, y: .04 + .1 * Math.sin(.7 * x) + .02 * (30 - x) ** 1.5 });
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const samples = points.map(p => ({ x: 41.25 + cosine * p.x - sine * p.y, y: 63.375 + sine * p.x + cosine * p.y }));
    const c = { raw: samples.map(p => ({ ...p })), samples, a: { p: samples[0] }, b: { p: samples.at(-1) }, detailTolerance: .25 };
    fitChain(c, .25);
    const fitted = sampleSegments(c.segments);
    expect(hasCrossing(fitted)).toBe(false);
    expect(c.sampleFallback).toBe(false);
    expect(c.segments.length).toBeLessThan(24);
    expect(c.segments.some(s => s.type === 'C')).toBe(true);
    expect(fitted[0]).toEqual(samples[0]);
    expect(fitted.at(-1)).toEqual(samples.at(-1));
    for (const p of samples) expect(distanceToPath(p, fitted)).toBeLessThan(.271);
    for (const p of fitted) expect(distanceToPath(p, samples)).toBeLessThan(.271);
});
