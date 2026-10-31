/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {expect, test} from "bun:test";
import {createRequire} from "node:module";
import {makeGuidedOpening, openingInterval} from "./guided-clearance.js";

const {createTracer} = createRequire(import.meta.url)("../tracer.js");
const stations = [29.5, 32.5, 34.5, 36.5, 37, 37.5, 39.5, 41.5, 45.5, 60.5, 80.5, 90.5];

function traceFixture(config) {
    const fixture = makeGuidedOpening(config);
    const result = createTracer().trace(fixture.image, {colors: 3, noise: 0, tolerance: 2, minArea: 0, debug: true});
    const pair = chain => [chain.left, chain.right].map(id => result.debug.faces[id]?.color);
    const background = result.stats.palette.indexOf("#f8f7f2");
    const body = result.stats.palette.indexOf("#318255");
    const accent = result.stats.palette.indexOf("#eab367");
    const interfaces = result.debug.chains.filter(chain => pair(chain).includes(background) && pair(chain).includes(body));
    expect(interfaces).toHaveLength(1);
    const neighbor = result.debug.chains.find(chain => pair(chain).includes(background) && pair(chain).includes(accent));
    expect(neighbor).toBeDefined();
    return {fixture, result, chain: interfaces[0], neighbor};
}

function expectSafeNetwork(result) {
    expect(result.stats.colors).toBe(3);
    expect(result.stats.visibleRegions).toBe(3);
    expect(result.stats.fallbackChains).toBe(0);
    expect(result.stats.sampleFallbackChains).toBe(0);
    expect(result.stats.globalExactFallback).toBe(false);
    expect(result.stats.repairPasses).toBe(0);
    for (const chain of result.debug.chains) {
        for (let i = 1; i < chain.segments.length; i++) expect(chain.segments[i - 1].b).toEqual(chain.segments[i].a);
    }
    for (const loops of result.debug.loops) {
        for (const ring of loops) {
            const endpoints = ring.map(halfEdge => {
                const segments = result.debug.chains[halfEdge >> 1].segments;
                const points = [segments[0].a, segments.at(-1).b];
                return halfEdge & 1 ? points.reverse() : points;
            });
            for (let i = 0; i < endpoints.length; i++) expect(endpoints[i][1]).toEqual(endpoints[(i + 1) % endpoints.length][0]);
        }
    }
}

function expectOpening(chain, fixture, maximumWidthError) {
    for (const y of stations) {
        const fitted = openingInterval(chain.flat, fixture, y);
        const source = fixture.openingWidth(y);
        expect(fitted, JSON.stringify({y, source})).not.toBeNull();
        expect(fitted.entry).toBeLessThan(0);
        expect(fitted.exit).toBeGreaterThan(0);
        expect(Math.abs(fitted.width - source), JSON.stringify({y, source, fitted})).toBeLessThan(maximumWidthError);
        expect(Math.abs(fitted.entry + source / 2)).toBeLessThan(maximumWidthError);
        expect(Math.abs(fitted.exit - source / 2)).toBeLessThan(maximumWidthError);
    }

    // Dense horizontal transects protect the slot itself; a positive interval
    // on a remote arm cannot substitute for the opening around local x=70.

    for (let y = 28; y <= 92; y += .5) {
        const fitted = openingInterval(chain.flat, fixture, y);
        expect(fitted).not.toBeNull();
        expect(fitted.width).toBeGreaterThan(1);
        expect(Math.abs(fitted.entry)).toBeLessThan(8);
        expect(Math.abs(fitted.exit)).toBeLessThan(8);
    }
}

function endpointTangent(segment, start) {
    if (segment.type === "A") {
        const angle = segment.start + (start ? 0 : segment.delta);
        const cosine = Math.cos(segment.angle);
        const sine = Math.sin(segment.angle);
        const direction = Math.sign(segment.delta);
        const dx = direction * (-segment.rx * Math.sin(angle) * cosine - segment.ry * Math.cos(angle) * sine);
        const dy = direction * (-segment.rx * Math.sin(angle) * sine + segment.ry * Math.cos(angle) * cosine);
        const length = Math.hypot(dx, dy);
        return {x: dx / length, y: dy / length};
    }
    const a = segment.type === "C" ? (start ? segment.a : segment.c2) : segment.a;
    const b = segment.type === "C" ? (start ? segment.c1 : segment.b) : segment.b;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return {x: (b.x - a.x) / length, y: (b.y - a.y) / length};
}

test("a dropped polygon guide retains junctions and the original clearance neighborhood", () => {
    const {fixture, result, chain, neighbor} = traceFixture({});
    expectSafeNetwork(result);
    expect(result.stats.guideCount).toBeGreaterThan(0);
    expect(chain.clearanceGuideDrops).toBeGreaterThan(0);
    expect(chain.clearanceRetries).toBeGreaterThan(0);
    expect(chain.fitTolerance).toBeLessThan(2);
    expect(chain.segments[0].a).toEqual(chain.raw[0]);
    expect(chain.segments.at(-1).b).toEqual(chain.raw.at(-1));
    expect(neighbor.tangentA).not.toBeNull();
    expect(neighbor.tangentB).not.toBeNull();

    for (const start of [true, false]) {
        const guidedSegment = start ? chain.segments[0] : chain.segments.at(-1);
        const neighborSegment = start ? neighbor.segments[0] : neighbor.segments.at(-1);
        expect(start ? guidedSegment.a : guidedSegment.b).toEqual(start ? neighborSegment.a : neighborSegment.b);
        const a = endpointTangent(guidedSegment, start);
        const b = endpointTangent(neighborSegment, start);
        const angle = Math.acos(Math.max(-1, Math.min(1, -a.x * b.x - a.y * b.y))) * 180 / Math.PI;
        expect(angle).toBeLessThan(1);
    }

    for (const y of stations) {
        const sampled = openingInterval(chain.samples, fixture, y);
        const fitted = openingInterval(chain.flat, fixture, y);
        expect(sampled).not.toBeNull();
        expect(sampled.width - fitted.width, JSON.stringify({y, sampled, fitted})).toBeLessThanOrEqual(.75);
    }
    expectOpening(chain, fixture, .8);
});

test.each([
    {rotation: .37, shiftX: .23, shiftY: -.19, maximumWidthError: .8},
    {rotation: -.51, shiftX: -.28, shiftY: .31, maximumWidthError: 1.25},
])("a frozen rotated opening stays continuous at rotation $rotation", config => {
    const {fixture, result, chain} = traceFixture(config);
    expectSafeNetwork(result);
    expectOpening(chain, fixture, config.maximumWidthError);
});

test("an unflared narrow polygon keeps its guide without extra tightening", () => {
    const {fixture, result, chain} = traceFixture({flare: 0});
    expectSafeNetwork(result);
    expect(result.stats.guideCount).toBeGreaterThan(0);
    expect(chain.clearanceGuideDrops).toBe(0);
    expect(chain.clearanceRetries).toBe(0);
    expect(chain.fitTolerance).toBe(2);
    expectOpening(chain, fixture, .1);
});

test("a wider opening outside the local search does not request an extra retry", () => {
    const {fixture, result, chain} = traceFixture({gap: 8});
    expectSafeNetwork(result);
    expect(chain.clearanceGuideDrops).toBe(0);
    expect(chain.clearanceRetries).toBe(0);
    expect(chain.fitTolerance).toBe(2);
    for (const y of stations) {
        const fitted = openingInterval(chain.flat, fixture, y);
        expect(fitted.width).toBeGreaterThan(7);
        expect(Math.abs(fitted.width - fixture.openingWidth(y))).toBeLessThan(1.3);
    }
});
