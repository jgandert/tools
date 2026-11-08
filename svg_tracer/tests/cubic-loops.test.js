// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

// Exercise the fitting boundary without adding a public debugging API. These
// three authored samples are independent of the supplied raster artwork.
const source = readFileSync(process.env.TRACER_CORE || new URL('../tracer.js', import.meta.url), 'utf8');
const factory = source.replace('return {trace};', 'return {constrainedCubic,fitSmoothSpan};');
if (factory === source) throw Error('Cannot expose the fitting functions for the regression.');
const { constrainedCubic, fitSmoothSpan } = new Function(`${factory}\nreturn createTracer();`)();

function sampleSegments(segments) {
    const points = [segments[0].a];
    for (const s of segments) {
        if (s.type === 'L') { points.push(s.b); continue; }
        if (s.type !== 'C') throw Error(`Unexpected fitting segment ${s.type}`);
        for (let i = 1; i <= 512; i++) {
            const t = i / 512, u = 1 - t;
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
        if (turn(a, b, c) * turn(a, b, d) < -1e-20 && turn(c, d, a) * turn(c, d, b) < -1e-20) return true;
    }
    return false;
}

for (const angle of [0, .3, Math.PI / 2, Math.PI]) test(`a low-error cubic must not loop inside a sparse span (rotation ${angle})`, () => {
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const rotate = (point, translate = false) => ({
        x: cosine * point.x - sine * point.y + (translate ? 81.25 : 0),
        y: sine * point.x + cosine * point.y + (translate ? 19.375 : 0),
    });
    const samples = [{ x: 0, y: 0 }, { x: .8, y: .2 }, { x: 1, y: 1 }].map(p => rotate(p, true));
    const start = rotate({ x: Math.cos(.35), y: Math.sin(.35) });
    const end = rotate({ x: Math.cos(1), y: Math.sin(1) });
    const fitted = constrainedCubic(samples, start, end, .15);
    if (fitted?.ok) expect(hasCrossing(sampleSegments([fitted.segment]))).toBe(false);
    const segments = fitSmoothSpan(samples, .15, start, end);
    expect(hasCrossing(sampleSegments(segments))).toBe(false);
    expect(segments[0].a).toEqual(samples[0]);
    expect(segments.at(-1).b).toEqual(samples.at(-1));
    for (let i = 1; i < segments.length; i++) expect(segments[i - 1].b).toEqual(segments[i].a);
});

test('well-supported tangent fitting remains a cubic', () => {
    const samples = Array.from({ length: 17 }, (_, i) => {
        const t = i / 16, u = 1 - t;
        return { x: 3 * u * t * t + t ** 3, y: 3 * u * u * t + 3 * u * t * t + t ** 3 };
    });
    const fitted = constrainedCubic(samples, { x: 0, y: 1 }, { x: 1, y: 0 }, .15);
    expect(fitted?.ok).toBe(true);
    expect(fitted.segment.type).toBe('C');
    expect(hasCrossing(sampleSegments([fitted.segment]))).toBe(false);
});

for (const scale of [.2, 1, 12]) for (const angle of [0, .3, Math.PI / 2]) test(`a simple closed cubic retains its closure (scale ${scale}, rotation ${angle})`, () => {
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const rotate = (x, y) => ({ x: cosine * x - sine * y, y: sine * x + cosine * y });
    const samples = Array.from({ length: 33 }, (_, i) => {
        const t = i / 32, u = 1 - t;
        const p = rotate(3 * u * u * t - 3 * u * t * t, 3 * u * u * t + 3 * u * t * t);
        return { x: 203.25 + scale * p.x, y: 71.375 + scale * p.y };
    });
    const diagonal = Math.SQRT1_2;
    const fitted = constrainedCubic(samples, rotate(diagonal, diagonal), rotate(diagonal, -diagonal), .15 * scale);
    expect(fitted?.ok).toBe(true);
    expect(hasCrossing(sampleSegments([fitted.segment]))).toBe(false);
});
