// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const { createTracer } = createRequire(import.meta.url)("../tracer.js");

// Distinct broad paints may share a coarse RGB histogram bucket. A known
// count and disabled cleanup must preserve the surviving source evidence.
const paints = [[120, 40, 80], [127, 47, 87], [20, 110, 180]];
const paintHex = ([r, g, b]) => `#${[r, g, b].map(value => value.toString(16).padStart(2, "0")).join("")}`;

function makeArtwork(antialiased) {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let paint = paints[x < 32 ? 0 : 1];
            if (antialiased && y >= 48) {
                paint = paints[2];
            } else if (antialiased && x === 31) {
                // A vertical boundary at x=31.25 covers a quarter of this
                // pixel with the left paint and three quarters with the right.
                paint = paints[0].map((value, channel) => Math.round(value * .25 + paints[1][channel] * .75));
            }
            data.set([...paint, 255], 4 * (y * width + x));
        }
    }
    return { width, height, data };
}

test.each([
    { name: "two flat halves", antialiased: false, colors: 2 },
    { name: "an antialiased boundary and another paint", antialiased: true, colors: 3 },
].flatMap(config => [0, 10].flatMap(noise => [false, true].map(preserveDetails => ({
    ...config,
    noise,
    preserveDetails,
})))))(
    "an explicit paint count preserves similar paints in $name (noise=$noise, protect=$preserveDetails)", ({
                                                                                                               antialiased,
                                                                                                               colors,
                                                                                                               noise,
                                                                                                               preserveDetails,
                                                                                                           }) => {
        const image = makeArtwork(antialiased);
        const result = createTracer().trace(image, {
            colors,
            noise,
            preserveDetails,
            minArea: 0,
            debug: true,
        });
        expect([...result.stats.palette].sort()).toEqual(paints.slice(0, colors).map(paintHex).sort());
        const left = result.debug.labels[20 * image.width + 10];
        const right = result.debug.labels[20 * image.width + 50];
        expect(left).not.toBe(right);
        expect(result.stats.visibleRegions).toBe(colors);
    });

test("an excessive explicit count does not invent a paint in a uniform image", () => {
    const width = 32;
    const height = 32;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        data.set([...paints[0], 255], pixel * 4);
    }
    const result = createTracer().trace({ width, height, data }, { colors: 64 });
    expect(result.stats.palette).toEqual([paintHex(paints[0])]);
    expect(result.stats.visibleRegions).toBe(1);
});

test("Auto does not promote small RGB variation in one coarse bucket to extra paints", () => {
    const width = 32;
    const height = 32;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (x * 3 + y * 5) % 8;
            data.set([...paints[0].map(value => value + offset), 255], (y * width + x) * 4);
        }
    }
    const result = createTracer().trace({ width, height, data });
    expect(result.stats.colors).toBe(1);
    expect(result.stats.visibleRegions).toBe(1);
});

test("the explicit upper limit can retain 64 paints within one coarse bucket", () => {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    const expected = [];
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const paint = [120 + x, 40 + y, 80];
            expected.push(paintHex(paint));
            for (let yy = y * 8; yy < y * 8 + 8; yy++) {
                for (let xx = x * 8; xx < x * 8 + 8; xx++) {
                    data.set([...paint, 255], (yy * width + xx) * 4);
                }
            }
        }
    }
    const result = createTracer().trace({ width, height, data }, {
        colors: 64,
        noise: 0,
        minArea: 0,
    });
    expect([...result.stats.palette].sort()).toEqual(expected.sort());
    expect(result.stats.visibleRegions).toBe(64);
});

test.each([0, 10].flatMap(noise => [false, true].map(preserveDetails => ({
    noise,
    preserveDetails,
}))))(
    "an antialias fringe in another bucket cannot repaint finely separated paints (noise=$noise, protect=$preserveDetails)", ({
                                                                                                                                  noise,
                                                                                                                                  preserveDetails,
                                                                                                                              }) => {
        const image = makeArtwork(true);

        // The bottom boundary at y=47.95 leaves 95% of the left paint and
        // 5% of the third paint in this row. Its RGB falls outside the
        // coarse bucket shared by the two broad upper paints.
        const fringe = paints[0].map((value, channel) => Math.round(value * .95 + paints[2][channel] * .05));
        for (let x = 0; x < 32; x++) {
            image.data.set([...fringe, 255], (47 * image.width + x) * 4);
        }
        const result = createTracer().trace(image, {
            colors: 3,
            noise,
            preserveDetails,
            minArea: 0,
            debug: true,
        });
        expect([...result.stats.palette].sort()).toEqual(paints.map(paintHex).sort());
        const left = result.debug.labels[20 * image.width + 10];
        const right = result.debug.labels[20 * image.width + 50];
        expect(result.stats.palette[left]).toBe(paintHex(paints[0]));
        expect(result.stats.palette[right]).toBe(paintHex(paints[1]));
        expect(result.stats.visibleRegions).toBe(3);
    });
