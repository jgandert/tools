/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {expect, test} from "bun:test";
import {createRequire} from "node:module";
import {makeClippedBinaryCapsule} from "./artwork.js";

const {createTracer} = createRequire(import.meta.url)("../tracer.js");
const tracer = createTracer();
const configurations = [.3, .8].flatMap(slope => [0, 1, 2, 3].map(quarterTurns => ({slope, quarterTurns})));

function capsuleContour(config, chamfered = false) {
    const input = makeClippedBinaryCapsule({...config, clipped: false});
    const sourceWidth = config.quarterTurns % 2 ? input.height : input.width;
    const sourceHeight = config.quarterTurns % 2 ? input.width : input.height;
    const unrotate = p => {
        if (config.quarterTurns === 1) {return {x: p.y, y: sourceHeight - p.x};}
        if (config.quarterTurns === 2) {return {x: sourceWidth - p.x, y: sourceHeight - p.y};}
        if (config.quarterTurns === 3) {return {x: sourceWidth - p.y, y: p.x};}
        return p;
    };
    const norm = Math.hypot(1, config.slope);
    const axis = {x: 1 / norm, y: config.slope / norm};
    const normal = {x: -axis.y, y: axis.x};
    const end = {x: 90, y: config.slope * 90 + 18 * norm + .05};
    const start = {x: 24, y: end.y - config.slope * 66};
    const length = 66 * norm;
    if (chamfered) {
        input.data.fill(0);
        for (let y = 0; y < input.height; y++) {
            for (let x = 0; x < input.width; x++) {
                const p = unrotate({x: x + .5, y: y + .5});
                const dx = p.x - start.x;
                const dy = p.y - start.y;
                const t = dx * axis.x + dy * axis.y;
                const n = Math.abs(dx * normal.x + dy * normal.y);

                // An independent octagon has two long sides, flat ends, and
                // 45-degree chamfers. Its real corners must survive tracing.
                if (t < -18 || t > length + 18 || n > 18 || -t + n > 26 || t - length + n > 26) {continue;}
                const offset = (y * input.width + x) * 4;
                input.data[offset] = 133;
                input.data[offset + 1] = 61;
                input.data[offset + 2] = 194;
                input.data[offset + 3] = 255;
            }
        }
    }
    const result = tracer.trace(input, {debug: true});
    const painted = result.debug.chains.filter(chain => [chain.left, chain.right].some(id => result.debug.faces[id]?.color >= 0));
    const context = JSON.stringify({config, stats: result.stats});
    expect(result.stats.colors, context).toBe(1);
    expect(result.stats.visibleRegions, context).toBe(1);
    expect(result.stats.fallbackChains, context).toBe(0);
    expect(painted.length, context).toBe(1);
    expect(painted[0].segments.length, context).toBeLessThanOrEqual(12);
    expect(painted[0].raw.every(p => p.x > 0 && p.y > 0 && p.x < input.width && p.y < input.height), context).toBe(true);

    const flat = painted[0].flat.map(unrotate);

    // Measure the finished contour, including curved segments, without requiring
    // a particular primitive, command type, anchor placement, or fit strategy.
    const intersections = (origin, direction) => {
        const distances = [];
        for (let i = 1; i < flat.length; i++) {
            const a = flat[i - 1];
            const b = flat[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const determinant = direction.x * dy - direction.y * dx;
            if (Math.abs(determinant) < 1e-10) {continue;}
            const ax = a.x - origin.x;
            const ay = a.y - origin.y;
            const t = (ax * dy - ay * dx) / determinant;
            const u = (ax * direction.y - ay * direction.x) / determinant;
            if (u >= -1e-9 && u <= 1 + 1e-9) {distances.push(t);}
        }
        expect(distances.length, context).toBeGreaterThanOrEqual(2);
        expect(distances.every(Number.isFinite), context).toBe(true);
        return distances;
    };
    return {axis, normal, start, end, length, intersections};
}

test.each(configurations)("a contained binary capsule recovers straight sides at slope $slope after $quarterTurns quarter turns", config => {
    const {axis, normal, start, length, intersections} = capsuleContour(config);
    for (const sign of [-1, 1]) {
        const positions = Array.from({length: 25}, (_, i) => {
            const distance = length * (.2 + .6 * i / 24);
            const hits = intersections({x: start.x + axis.x * distance, y: start.y + axis.y * distance}, normal);
            return sign < 0 ? Math.min(...hits) : Math.max(...hits);
        });
        const range = Math.max(...positions) - Math.min(...positions);
        const offset = Math.max(...positions.map(value => Math.abs(Math.abs(value) - 18)));
        const context = JSON.stringify({config, sign, range, offset});

        // A binary staircase leaves the line's offset uncertain. It does not
        // justify spending the fitting tolerance on a broad bow along the side.
        expect(range, context).toBeLessThan(.2);
        expect(offset, context).toBeLessThan(.35);
    }
});

function capMetrics({axis, normal, start, end, intersections}) {
    return [[-1, start], [1, end]].map(([sign, origin]) => {
        const samples = Array.from({length: 57}, (_, i) => {
            const angle = -1.4 + i * .05;
            const direction = {
                x: sign * axis.x * Math.cos(angle) + normal.x * Math.sin(angle),
                y: sign * axis.y * Math.cos(angle) + normal.y * Math.sin(angle),
            };
            const radius = Math.max(...intersections(origin, direction));
            return {x: direction.x * radius, y: direction.y * radius, radius};
        });
        let maxTurn = 0;
        for (let i = 1; i < samples.length - 1; i++) {
            const a = samples[i - 1];
            const b = samples[i];
            const c = samples[i + 1];
            const ax = b.x - a.x;
            const ay = b.y - a.y;
            const bx = c.x - b.x;
            const by = c.y - b.y;
            const cosine = (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by);
            maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, cosine))));
        }
        const radialError = Math.max(...samples.map(p => Math.abs(p.radius - 18)));
        return {sign, maxTurn, radialError};
    });
}

test.each(configurations)("a contained binary capsule recovers rounded caps at slope $slope after $quarterTurns quarter turns", config => {
    for (const metrics of capMetrics(capsuleContour(config))) {
        const context = JSON.stringify({config, ...metrics});

        // Samples are about .9 pixels apart on an 18-pixel circle. Its tangent
        // turns .05 radians per step; .22 allows flattening error and binary
        // uncertainty while rejecting corners hidden by a low raster error.
        expect(metrics.maxTurn, context).toBeLessThan(.22);
        expect(metrics.radialError, context).toBeLessThan(1);
    }
});

test.each(configurations)("genuine chamfered ends retain corners at slope $slope after $quarterTurns quarter turns", config => {
    for (const metrics of capMetrics(capsuleContour(config, true))) {
        const context = JSON.stringify({config, ...metrics});
        expect(metrics.maxTurn, context).toBeGreaterThan(.4);
        expect(metrics.radialError, context).toBeGreaterThan(1.3);
    }
});

function makeHeldoutShape({radius, length, angle, samples = 1, kind = "capsule"}) {
    const co = Math.cos(angle);
    const si = Math.sin(angle);
    const halfWidth = length / 2 + radius;
    const width = Math.ceil(2 * (Math.abs(co) * halfWidth + Math.abs(si) * radius) + 16);
    const height = Math.ceil(2 * (Math.abs(si) * halfWidth + Math.abs(co) * radius) + 16);
    const cx = width / 2 + .23;
    const cy = height / 2 - .17;
    const local = p => ({x: (p.x - cx) * co + (p.y - cy) * si, y: -(p.x - cx) * si + (p.y - cy) * co});
    const distance = p => {
        if (kind === "ellipse") {
            return (p.x / halfWidth) ** 2 + (p.y / radius) ** 2 - 1;
        }
        if (kind === "rounded rectangle") {
            const corner = radius * .45;
            const dx = Math.abs(p.x) - (halfWidth - corner);
            const dy = Math.abs(p.y) - (radius - corner);
            return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - corner;
        }
        return Math.hypot(Math.max(Math.abs(p.x) - length / 2, 0), p.y) - radius;
    };
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let covered = 0;
            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const p = local({x: x + (sx + .5) / samples, y: y + (sy + .5) / samples});
                    if (distance(p) <= 0) {covered++;}
                }
            }
            if (covered) {data.set([133, 61, 194, Math.round(255 * covered / samples ** 2)], (y * width + x) * 4);}
        }
    }
    return {input: {width, height, data}, local, distance, halfWidth};
}

function traceHeldoutShape(config) {
    const {input, local, distance, halfWidth} = makeHeldoutShape(config);
    const result = tracer.trace(input, {debug: true});
    const chains = result.debug.chains.filter(chain => [chain.left, chain.right].some(id => result.debug.faces[id]?.color >= 0));
    const context = JSON.stringify({config, stats: result.stats});
    expect(result.stats.colors, context).toBe(1);
    expect(result.stats.visibleRegions, context).toBe(1);
    expect(result.stats.fallbackChains, context).toBe(0);
    expect(chains.length, context).toBe(1);
    expect(chains[0].segments.length, context).toBeLessThanOrEqual(12);
    const flat = chains[0].flat.map(local);
    const maxBoundaryError = Math.max(...flat.map(p => {
        const residual = distance(p);
        if (config.kind !== "ellipse") {return Math.abs(residual);}

        // Convert the ellipse's implicit residual to a local normal distance.
        const gradient = 2 * Math.hypot(p.x / halfWidth ** 2, p.y / config.radius ** 2);
        return Math.abs(residual / gradient);
    }));
    return {flat, maxBoundaryError, context};
}

// Independent pixel-center and 4x4 square-coverage sampling changes the radius,
// aspect ratio, angle, and subpixel placement rather than rotating one fixture.
const heldoutCapsules = [
    {radius: 5, length: 32, angle: .17},
    {radius: 8, length: 41, angle: 1.13},
    {radius: 13, length: 37, angle: 2.39},
    {radius: 25, length: 136, angle: 2.81},
    {radius: 11, length: 220, angle: .47},
    {radius: 8, length: 41, angle: 1.13, samples: 4},
    {radius: 13, length: 37, angle: 2.39, samples: 4},
    {radius: 25, length: 136, angle: 2.81, samples: 4},
];

test.each(heldoutCapsules)("a heldout capsule recovers its contour with radius $radius, length $length and angle $angle", config => {
    const {maxBoundaryError, context} = traceHeldoutShape(config);
    expect(maxBoundaryError, context).toBeLessThan(.35);
});

test.each(["ellipse", "rounded rectangle"].flatMap(kind => [1, 4].map(samples => ({kind, samples}))))(
    "a heldout $kind preserves its distinct contour with $samples squared coverage samples", ({kind, samples}) => {
        const config = {kind, samples, radius: 15, length: 52, angle: .73};
        const {flat, maxBoundaryError, context} = traceHeldoutShape(config);
        expect(maxBoundaryError, context).toBeLessThan(kind === "ellipse" ? .35 : 1.25);

        // These controls differ from a circular-ended capsule by several pixels.
        const capsuleMismatch = Math.max(...flat.map(p => Math.abs(Math.hypot(Math.max(Math.abs(p.x) - config.length / 2, 0), p.y) - config.radius)));
        expect(capsuleMismatch, context).toBeGreaterThan(2.5);
    });
