/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { expect, test } from "bun:test";
import { createSpiralDiagnostics } from "./spiral-diagnostics.js";

const diagnostics = createSpiralDiagnostics();
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom },
    { x: left, y: bottom }, { x: left, y: top },
];

test("normal intersections preserve holes, direction and component identity", () => {
    const paths = [rectangle(-4, -3, 4, 3), rectangle(-2, -1, 2, 1)];
    expect(diagnostics.intervals({ x: 0, y: .25 }, { x: 1, y: 0 }, paths, 7)).toEqual([
        { entry: -4, exit: -2, component: 7 }, { entry: 2, exit: 4, component: 7 },
    ]);
    expect(diagnostics.intervals({ x: 1, y: .25 }, { x: -1, y: 0 }, paths, 7)).toEqual([
        { entry: -3, exit: -1, component: 7 }, { entry: 3, exit: 5, component: 7 },
    ]);
});

test("a ray through a vertex does not invent a zero-width interval", () => {
    const triangle = [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 0 }];
    expect(diagnostics.intervals({ x: 0, y: 1 }, { x: 1, y: 0 }, [triangle])).toEqual([
        { entry: 0, exit: 2, component: null },
    ]);
    expect(diagnostics.intervals({ x: 0, y: 2 }, { x: 1, y: 0 }, [triangle])).toEqual([]);
});

test("an unrelated arm cannot replace a missing source interval", () => {
    const local = { entry: -.1, exit: .1 };
    const remote = diagnostics.intervals({ x: 0, y: 0 }, {
        x: 1,
        y: 0,
    }, [rectangle(3, -1, 7, 1)], 9);
    expect(diagnostics.correspondingIntervals(local, remote)).toEqual([]);
});

test("correspondence retains isolated tip fragments beside a larger component", () => {
    const source = { entry: 0, exit: 12 };
    const candidates = [
        { entry: 4, exit: 13, component: 1 },
        { entry: 1, exit: 2, component: 2 },
        { entry: -2, exit: 0, component: 3 },
    ];
    expect(diagnostics.correspondingIntervals(source, candidates)).toEqual([candidates[1], candidates[0]]);
});

test.each([
    { pitch: 25.2, halfWidth: 10.8 },
    { pitch: 23.2, halfWidth: 10.8, rotation: .47, shiftX: .31, shiftY: -.27 },
    { pitch: 22.9, halfWidth: 10.8, shiftX: .19, shiftY: -.24 },
])("source-normal measurements distinguish actual opening from nominal pitch: $pitch", config => {
    const geometry = diagnostics.makeGeometry(config);
    const source = geometry.polygon.concat([geometry.polygon[0]]);
    const station = geometry.pointAt(Math.PI);
    const normal = { x: -station.normal.x, y: -station.normal.y };
    const hits = diagnostics.crossings(station.outward, normal, [source]);
    const index = hits.findIndex(value => value > -.1);
    const gap = hits[index + 1] - hits[index];
    expect(Math.abs(hits[index])).toBeLessThan(1e-10);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(config.pitch - 2 * config.halfWidth);

    for (const end of [false, true]) {
        for (const offset of [.5, 1, 2, 4, 8, 12]) {
            const point = geometry.stationAt(offset, end);
            const interval = diagnostics.intervals(point.center, point.normal, [source])
                .find(interval => interval.entry < 0 && interval.exit > 0);
            expect(interval).toBeDefined();
            expect(Math.abs(interval.entry + point.halfWidth)).toBeLessThan(.01);
            expect(Math.abs(interval.exit - point.halfWidth)).toBeLessThan(.01);
        }
    }
});
