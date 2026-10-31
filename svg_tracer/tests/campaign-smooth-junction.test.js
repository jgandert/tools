// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
import {expect, test} from "bun:test";
import {createRequire} from "node:module";

const {createTracer} = createRequire(import.meta.url)("../tracer.js");

const colors = {
    background: [248, 247, 242],
    body: [49, 130, 85],
    accent: [234, 179, 103],
};

function smoothJunctionImage() {
    const width = 160;
    const height = 120;
    const junctionX = 40;
    const stripeEnd = 84;
    const stripeDepth = 16;
    const data = new Uint8ClampedArray(width * height * 4);
    const edgeY = x => 48 + 2 * Math.sin(2 * Math.PI * (x - junctionX) / 16);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const edge = edgeY(x + .5);
            const paint = y + .5 < edge
                ? colors.background
                : x >= junctionX && x < stripeEnd && y + .5 < edge + stripeDepth
                    ? colors.accent
                    : colors.body;
            data.set([...paint, 255], (y * width + x) * 4);
        }
    }
    return {image: {width, height, data}, junction: {x: junctionX, y: 48}};
}

function unit(x, y) {
    const length = Math.hypot(x, y) || 1;
    return {x: x / length, y: y / length};
}

function segmentTangent(segment, start) {
    if (segment.type === "L") return unit(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
    if (segment.type === "C") {
        return start
            ? unit(segment.c1.x - segment.a.x, segment.c1.y - segment.a.y)
            : unit(segment.b.x - segment.c2.x, segment.b.y - segment.c2.y);
    }
    const angle = segment.start + (start ? 0 : segment.delta);
    const cosine = Math.cos(segment.angle);
    const sine = Math.sin(segment.angle);
    const direction = Math.sign(segment.delta);
    return unit(
        direction * (-segment.rx * Math.sin(angle) * cosine - segment.ry * Math.cos(angle) * sine),
        direction * (-segment.rx * Math.sin(angle) * sine + segment.ry * Math.cos(angle) * cosine),
    );
}

function angleBetween(a, b) {
    return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180 / Math.PI;
}

test("a smooth painted boundary stays smooth close to its junction", () => {
    const {image, junction} = smoothJunctionImage();
    const result = createTracer().trace(image, {colors: 3, noise: 0, tolerance: 1.25, minArea: 0, debug: true});
    expect(result.stats.colors).toBe(3);
    expect(result.stats.visibleRegions).toBe(3);
    expect(result.stats.fallbackChains).toBe(0);

    const background = result.stats.palette.indexOf("#f8f7f2");
    const accent = result.stats.palette.indexOf("#eab367");
    const interfaces = result.debug.chains.filter(chain => {
        const colors = [result.debug.faces[chain.left]?.color, result.debug.faces[chain.right]?.color];
        return colors.includes(background) && colors.includes(accent) && chain.raw.length > 30;
    });
    expect(interfaces).toHaveLength(1);

    const chain = interfaces[0];
    const endpoint = [chain.raw[0], chain.raw.at(-1)].reduce((best, point) =>
        Math.hypot(point.x - junction.x, point.y - junction.y) < Math.hypot(best.x - junction.x, best.y - junction.y) ? point : best,
    );
    expect(Math.hypot(endpoint.x - junction.x, endpoint.y - junction.y)).toBeLessThan(1);

    const falseCorners = [];
    for (let index = 1; index < chain.segments.length; index++) {
        const incoming = segmentTangent(chain.segments[index - 1], false);
        const outgoing = segmentTangent(chain.segments[index], true);
        const point = chain.segments[index].a;
        if (Math.hypot(point.x - junction.x, point.y - junction.y) <= 5) {
            const degrees = angleBetween(incoming, outgoing);
            if (degrees > 30) falseCorners.push({point, degrees});
        }
    }
    expect(falseCorners).toEqual([]);
});

function roundedJunctionImage({rotation, bendOffset}) {
    const width = 160;
    const height = 140;
    const junction = {x: 60.23, y: 70};
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const edgeY = x => .5 * Math.sqrt((x - bendOffset) ** 2 + .5 ** 2);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const rgb = [0, 0, 0];
            for (let sy = 0; sy < 4; sy++) {
                for (let sx = 0; sx < 4; sx++) {
                    const dx = x + (sx + .5) / 4 - junction.x;
                    const dy = y + (sy + .5) / 4 - junction.y;
                    const u = cosine * dx + sine * dy;
                    const v = -sine * dx + cosine * dy + edgeY(0);
                    const edge = edgeY(u);
                    const paint = v < edge
                        ? colors.background
                        : u >= 0 && u < 44 && v < edge + 16
                            ? colors.accent
                            : colors.body;
                    for (let c = 0; c < 3; c++) rgb[c] += paint[c] / 16;
                }
            }
            data.set([...rgb, 255], (y * width + x) * 4);
        }
    }
    return {image: {width, height, data}, junction};
}

test.each([
    {rotation: 0, bendOffset: 4},
    {rotation: .49, bendOffset: 4},
    {rotation: 0, bendOffset: 6},
])("a smooth concentrated bend stays smooth after its junction: rotation $rotation, offset $bendOffset", config => {
    const {image, junction} = roundedJunctionImage(config);
    const result = createTracer().trace(image, {colors: 3, noise: 0, tolerance: 1.25, minArea: 0, debug: true});
    expect(result.stats.colors).toBe(3);
    expect(result.stats.visibleRegions).toBe(3);
    expect(result.stats.fallbackChains).toBe(0);
    const background = result.stats.palette.indexOf("#f8f7f2");
    const accent = result.stats.palette.indexOf("#eab367");
    const interfaces = result.debug.chains.filter(chain => {
        const pair = [result.debug.faces[chain.left]?.color, result.debug.faces[chain.right]?.color];
        return pair.includes(background) && pair.includes(accent) && chain.raw.length > 30;
    });
    expect(interfaces).toHaveLength(1);
    let joins = 0;
    for (const chain of interfaces) {
        for (let i = 1; i < chain.segments.length; i++) {
            const point = chain.segments[i].a;
            if (Math.hypot(point.x - junction.x, point.y - junction.y) > 11.25) continue;
            joins++;
            const degrees = angleBetween(segmentTangent(chain.segments[i - 1], false), segmentTangent(chain.segments[i], true));
            expect(degrees, JSON.stringify({config, point, degrees})).toBeLessThan(30);
        }
    }
    expect(joins).toBeGreaterThan(0);
});
