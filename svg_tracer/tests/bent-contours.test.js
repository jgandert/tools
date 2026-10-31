/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {expect, test} from "bun:test";
import {createRequire} from "node:module";

const {createTracer} = createRequire(import.meta.url)("../tracer.js");
const tracer = createTracer();

function makeBentRibbon({radius, angle, shift, kind = "circle"}) {
    const width = 300;
    const height = 280;
    const tip = {x: 82.2 + shift, y: 173.6};
    const axis = {x: Math.cos(angle), y: Math.sin(angle)};
    const elbow = {x: tip.x + 115 * axis.x, y: tip.y + 115 * axis.y};
    const tail = {x: elbow.x + 90, y: elbow.y + 120};
    const distance = (x, y, a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    };
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const u = (x + .5 - tip.x) * axis.x + (y + .5 - tip.y) * axis.y;
            const v = -(x + .5 - tip.x) * axis.y + (y + .5 - tip.y) * axis.x;
            const terminal = kind === "chamfer"
                ? u >= -radius && Math.abs(v) <= radius && -u + Math.abs(v) <= 1.45 * radius
                : kind === "ellipse"
                    ? (u / (1.3 * radius)) ** 2 + (v / radius) ** 2 <= 1
                    : u * u + v * v <= radius * radius;
            const first = u < 0 ? terminal : distance(x + .5, y + .5, tip, elbow) <= radius;
            if (first || distance(x + .5, y + .5, elbow, tail) <= radius) {
                data.set([110, 38, 170, 255], (y * width + x) * 4);
            }
        }
    }
    return {width, height, data, tip, axis};
}

const cases = [18, 30, 42].flatMap(radius => [-1.05, -.75, -.45].flatMap(angle => [0, .4].map(shift => ({radius, angle, shift}))));

test.each(cases)("binary bent ribbon retains a round terminal: radius $radius, angle $angle, shift $shift", config => {
    const input = makeBentRibbon(config);
    const result = tracer.trace(input, {debug: true});
    const onCap = p => (p.x - input.tip.x) * input.axis.x + (p.y - input.tip.y) * input.axis.y < -2 && Math.hypot(p.x - input.tip.x, p.y - input.tip.y) < config.radius + 4;
    let maxRadialError = 0;
    let longestFlatSpan = 0;
    let samples = 0;
    for (const chain of result.debug.chains) {
        for (let i = 0; i < chain.flat.length; i++) {
            const p = chain.flat[i];
            if (!onCap(p)) {
                continue;
            }
            samples++;
            maxRadialError = Math.max(maxRadialError, Math.abs(Math.hypot(p.x - input.tip.x, p.y - input.tip.y) - config.radius));
            if (i && onCap(chain.flat[i - 1])) {
                longestFlatSpan = Math.max(longestFlatSpan, Math.hypot(p.x - chain.flat[i - 1].x, p.y - chain.flat[i - 1].y));
            }
        }
    }
    const context = JSON.stringify({config, maxRadialError, longestFlatSpan, stats: result.stats});
    expect(result.stats.colors, context).toBe(1);
    expect(result.stats.visibleRegions, context).toBe(1);
    expect(result.stats.fallbackChains, context).toBe(0);
    expect(samples, context).toBeGreaterThan(20);
    expect(maxRadialError, context).toBeLessThan(1);

    // Inspect the actual flattened contour, independent of its SVG command
    // types. A long flat plateau can fit the raster well but flatten a cap.

    expect(longestFlatSpan, context).toBeLessThan(6);
});

function terminalSamples(input, result) {
    const normal = {x: -input.axis.y, y: input.axis.x};
    return Array.from({length: 113}, (_, index) => {
        const angle = -1.4 + index * .025;
        const dx = -input.axis.x * Math.cos(angle) + normal.x * Math.sin(angle);
        const dy = -input.axis.y * Math.cos(angle) + normal.y * Math.sin(angle);
        let radius = Infinity;
        for (const chain of result.debug.chains) {
            for (let i = 1; i < chain.flat.length; i++) {
                const a = chain.flat[i - 1];
                const b = chain.flat[i];
                const vx = b.x - a.x;
                const vy = b.y - a.y;
                const determinant = dx * vy - dy * vx;
                if (Math.abs(determinant) < 1e-10) continue;
                const ax = a.x - input.tip.x;
                const ay = a.y - input.tip.y;
                const t = (ax * vy - ay * vx) / determinant;
                const u = (ax * dy - ay * dx) / determinant;
                if (t > 0 && u >= 0 && u <= 1) radius = Math.min(radius, t);
            }
        }
        expect(Number.isFinite(radius)).toBe(true);
        return {angle, radius, x: dx * radius, y: dy * radius};
    });
}

test.each([
    {radius: 18, angle: -1.05, shift: 0},
    {radius: 30, angle: -.75, shift: 0},
    {radius: 42, angle: -.75, shift: .4},
])("supported binary terminal retains circular bend: radius $radius, angle $angle, shift $shift", config => {
    const input = makeBentRibbon(config);
    const result = tracer.trace(input, {debug: true});
    const points = terminalSamples(input, result);
    const radialError = Math.max(...points.map(point => Math.abs(point.radius - config.radius)));
    const window = Math.round(5 / (config.radius * .025));
    let minSagitta = Infinity;
    for (let i = window; i < points.length - window; i++) {
        const a = points[i - window];
        const b = points[i];
        const c = points[i + window];
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        minSagitta = Math.min(minSagitta, Math.abs(dx * (a.y - b.y) - (a.x - b.x) * dy) / Math.hypot(dx, dy));
    }
    const context = JSON.stringify({config, radialError, minSagitta, stats: result.stats});
    expect(result.stats.fallbackChains, context).toBe(0);
    expect(radialError, context).toBeLessThan(.3);

    // A five-pixel half-window has a known bend on the source circle. Keeping
    // most of that bend rejects a locally flat cap despite low radial error.
    const expectedSagitta = config.radius * (1 - Math.cos(window * .025));
    expect(minSagitta, context).toBeGreaterThan(expectedSagitta * .8);
});

const noncircularTerminals = [8, 18, 30].flatMap(radius => [-.75, -.45].flatMap(angle =>
    [0, .4].flatMap(shift => ["ellipse", "chamfer"].map(kind => ({radius, angle, shift, kind}))),
));

test.each(noncircularTerminals)("a bent ribbon preserves its $kind terminal: radius $radius, angle $angle, shift $shift", config => {
    const input = makeBentRibbon(config);
    const result = tracer.trace(input, {debug: true});
    const points = terminalSamples(input, result);
    let radialError = 0;
    let maxTurn = 0;
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const cosine = Math.cos(point.angle);
        const sine = Math.abs(Math.sin(point.angle));
        const expected = config.kind === "ellipse"
            ? config.radius / Math.sqrt((cosine / 1.3) ** 2 + sine ** 2)
            : Math.min(config.radius / cosine, config.radius / sine, 1.45 * config.radius / (cosine + sine));
        radialError = Math.max(radialError, Math.abs(point.radius - expected));
        if (!i || i === points.length - 1) continue;
        const a = points[i - 1];
        const b = points[i];
        const c = points[i + 1];
        const ux = b.x - a.x;
        const uy = b.y - a.y;
        const vx = c.x - b.x;
        const vy = c.y - b.y;
        maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / Math.hypot(ux, uy) / Math.hypot(vx, vy)))));
    }
    const context = JSON.stringify({config, radialError, maxTurn, stats: result.stats});
    expect(result.stats.colors, context).toBe(1);
    expect(result.stats.visibleRegions, context).toBe(1);
    expect(result.stats.fallbackChains, context).toBe(0);
    expect(radialError, context).toBeLessThan(config.kind === "ellipse" ? 1.05 : 1.6);
    if (config.kind === "chamfer") expect(maxTurn, context).toBeGreaterThan(.3);
});
