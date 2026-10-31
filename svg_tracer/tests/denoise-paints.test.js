/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {expect, test} from "bun:test";
import {createRequire} from "node:module";
import {correlatedColumnAccent, noisyMidpointAccent, resampledSlit} from "./campaign-paints.js";

const {createTracer} = createRequire(import.meta.url)("../tracer.js");

test.each([0, 3].map(colors => ({colors})))("a locally supported paint retains a three-paint plurality below half coverage (colors=$colors)", ({colors}) => {
    const width = 64;
    const height = 64;
    const paints = [[221, 30, 35], [43, 81, 155], [130, 91, 67]];
    const mixed = paints[2].map((value, channel) => Math.round(.4 * value + .3 * paints[0][channel] + .3 * paints[1][channel]));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let paint = paints[x < 32 ? 0 : 1];
            if (x >= 6 && x < 18 && y >= 6 && y < 18 || x >= 28 && x <= 30 && y >= 29 && y <= 31) paint = paints[2];
            if (x === 31 && y >= 32 && y <= 34) paint = mixed;
            data.set([...paint, 255], 4 * (y * width + x));
        }
    }
    const result = createTracer().trace({width, height, data}, {noise: 10, colors, minArea: 0, debug: true});
    const retainedPaint = result.debug.labels[10 * width + 10];
    for (const y of [32, 33, 34]) expect(result.debug.labels[y * width + 31]).toBe(retainedPaint);
    expect(result.stats.threePaintPixels).toBeGreaterThan(0);
    expect(result.stats.fallbackChains).toBe(0);
});

test.each([false, true].flatMap(diamond => [false, true].map(offMixture => ({diamond, offMixture}))))(
    "correlated cleanup preserves the known paint interface (diamond=$diamond offMixture=$offMixture)", config => {
        const {image, owners, paints} = correlatedColumnAccent(config);
        const result = createTracer().trace(image, {noise: 10, minArea: 0, debug: true});
        const paletteOwners = result.stats.palette.map(hex => {
            const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
            const distances = paints.map(paint => Math.hypot(...paint.map((value, channel) => value - rgb[channel])));
            return distances.indexOf(Math.min(...distances));
        });

        // The tiny accent is an unresolved baseline failure. Check the two
        // broad paints independently so that limitation cannot hide new loss.
        for (let pixel = 0; pixel < owners.length; pixel++) {
            if (owners[pixel] === 2) continue;
            expect(paletteOwners[result.debug.labels[pixel]]).toBe(owners[pixel]);
        }

        // Nominal-paint matching can hide a false lighter stripe of the same hue.
        for (let y = 0; y < image.height; y++) {
            const hex = result.stats.palette[result.debug.labels[y * image.width + 5]];
            const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
            expect(Math.hypot(...rgb.map((value, channel) => value - paints[0][channel]))).toBeLessThan(16);
        }
        const interfaceSamples = result.debug.chains.filter(chain => {
            const left = paletteOwners[result.debug.faces[chain.left]?.color];
            const right = paletteOwners[result.debug.faces[chain.right]?.color];
            return (left === 0 && right === 1) || (left === 1 && right === 0);
        }).flatMap(chain => chain.flat).filter(point => point.x > 24 && point.x < 40);
        expect(interfaceSamples.length).toBeGreaterThan(0);
        expect(Math.max(...interfaceSamples.map(point => Math.abs(point.x - 32)))).toBeLessThan(.15);
        expect(result.stats.regions).toBeLessThanOrEqual(25);
        expect(result.stats.fallbackChains).toBe(0);
    });

test.each([false, true].flatMap(transpose => [0, .2, .4].flatMap(phase => [0, 10, 20, 40].map(noise => ({transpose, phase, noise})))))(
    "resampling and cleanup retain a two-paint slit (transpose=$transpose phase=$phase noise=$noise)", ({transpose, phase, noise}) => {
        const image = resampledSlit({transpose, phase});
        const result = createTracer().trace(image, {noise, debug: true});
        expect(result.stats.colors).toBe(2);
        expect(result.stats.visibleRegions).toBe(3);
        expect(result.stats.fallbackChains).toBe(0);
        const background = result.stats.palette.indexOf("#fdfcf6");
        expect(background).toBeGreaterThanOrEqual(0);
        for (let along = 16; along <= 80; along += 4) {
            const center = 48 + phase + .025 * (along - 48);
            const x = transpose ? along : Math.floor(center);
            const y = transpose ? Math.floor(center) : along;
            expect(result.debug.labels[y * image.width + x]).toBe(background);

            // Check both continuous fitted boundaries against the original
            // vector slit, so deleting an island by closing the gap cannot pass.
            const crossings = [];
            for (const chain of result.debug.chains) {
                for (let index = 1; index < chain.flat.length; index++) {
                    let a = chain.flat[index - 1];
                    let b = chain.flat[index];
                    if (transpose) {
                        a = {x: a.y, y: a.x};
                        b = {x: b.y, y: b.x};
                    }
                    if ((a.y <= along && b.y > along) || (b.y <= along && a.y > along)) {
                        const cross = a.x + (along - a.y) * (b.x - a.x) / (b.y - a.y);
                        if (cross > 42 && cross < 54) crossings.push(cross);
                    }
                }
            }
            crossings.sort((a, b) => a - b);
            expect(crossings).toHaveLength(2);
            expect(Math.abs(crossings[0] - (center - 1.375))).toBeLessThan(.15);
            expect(Math.abs(crossings[1] - (center + 1.375))).toBeLessThan(.15);
        }
    });

const accentCases = [
    {size: 4, jitter: 0, noises: [0, 10, 20]},
    {size: 4, jitter: 8, noises: [10, 20]},
    {size: 6, jitter: 12, noises: [10, 20, 40]},
].flatMap(({noises, ...shape}) => [16, 32].flatMap(position => noises.flatMap(noise => [0, 3].map(colors => ({...shape, position, noise, colors})))));

test.each(accentCases)(
    "source verification preserves a real mixture-color accent ($size px, jitter=$jitter position=$position noise=$noise colors=$colors)", config => {
        const image = noisyMidpointAccent(config);
        const result = createTracer().trace(image, {noise: config.noise, colors: config.colors, minArea: 0, debug: true});
        const center = result.debug.labels[32 * image.width + config.position];
        const paint = result.stats.palette[center];
        const rgb = [1, 3, 5].map(offset => parseInt(paint.slice(offset, offset + 2), 16));
        expect(Math.hypot(...rgb.map((value, channel) => value - [115, 100, 65][channel]))).toBeLessThan(20);
        expect(center).not.toBe(result.debug.labels[8 * image.width + 8]);
        expect(center).not.toBe(result.debug.labels[8 * image.width + 56]);
        expect(result.stats.fallbackChains).toBe(0);
    });
