/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* Independent, originally authored region-limit control. Node built-ins only.
 * Run: node tests/auto-region-limit.test.cjs [path/to/tracer.js]
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTracer } = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js')));

function crowdedGrayOutlines(jitter = 0) {
    const count = 52, step = 9, width = count * step + 36, height = width;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) data.set([255, 255, 255, 255], p * 4);
    const setGray = (x, y, value) => data.set([value, value, value, 255], (y * width + x) * 4);
    // Each shape has an intentional 1-pixel gray outline around a black square.
    // Its source RGB is exactly the same paint as the larger isolated gray mark.
    // Black/white mixture compatibility does not make this authored gray fake.
    for (let gy = 0; gy < count; gy++) for (let gx = 0; gx < count; gx++) {
        const left = 24 + gx * step, top = 24 + gy * step;
        for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
            const gray = 128 + ((x * 3 + y * 5 + gx + gy) % 3 - 1) * jitter;
            setGray(left + x, top + y, x > 0 && x < 5 && y > 0 && y < 5 ? 0 : gray);
        }
    }
    // Genuine compact gray accents with exact and modest correlated RGB noise.
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) setGray(x, y, 128);
    for (let y = 4; y < 10; y++) for (let x = 14; x < 20; x++) setGray(x, y, 128 + ((x + y) % 3 - 1) * 5);
    return { width, height, data };
}

function inside(point, polygon) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
}

function checkRetained(name, image, options) {
    const original = Buffer.from(image.data), progress = [];
    const { stats, svg, debug } = createTracer().trace(image, {
        tolerance: 1.25, preserveDetails: true, debug: true, ...options,
    }, message => progress.push(message));
    assert.match(stats.validation, /^passed/, `${name}: topology validation`);
    assert.equal(stats.regions, 52 * 52 * 2 + 3, `${name}: every authored region survives`);
    assert.equal(stats.visibleRegions, stats.regions, `${name}: every region remains visible`);
    assert.equal(stats.colors, 3, `${name}: retain the three real paints`);
    assert.equal(stats.autoMergedFragments, 0, `${name}: do not alias authored gray outlines to black or white`);
    assert.equal(stats.removedPixels, 0, `${name}: do not remove genuine detail to meet the capacity limit`);
    assert.equal(stats.globalExactFallback, false, `${name}: preserve ordinary fitted output`);
    assert.equal(Buffer.compare(original, Buffer.from(image.data)), 0, `${name}: input bytes are unchanged`);
    assert(!/NaN|Infinity|undefined/.test(svg), `${name}: finite SVG`);
    assert.equal(progress.includes('Resolving mixture-color fragments in Auto'),
        !options.colors && options.noise > 0 && options.minArea > 1,
        `${name}: preserve the 5,000-region recovery trigger independently of the new ceiling`);

    const intensity = stats.palette.map(hex => parseInt(hex.slice(1, 3), 16));
    const black = intensity.findIndex(value => value < 10);
    const gray = intensity.findIndex(value => value > 100 && value < 155);
    const white = intensity.findIndex(value => value > 245);
    assert(black >= 0 && gray >= 0 && white >= 0, `${name}: expected paint identities`);
    for (let p = 0; p < debug.labels.length; p++) {
        const source = image.data[p * 4], expected = source < 64 ? black : source < 200 ? gray : white;
        assert.equal(debug.labels[p], expected, `${name}: preserve source paint at pixel ${p}`);
    }

    // Independently verify finished geometry at the middle of every thin rim,
    // every black interior, and both isolated gray accents. Component counts
    // alone cannot prove that the fitted boundary still contains these marks.
    const rings = debug.loops.map(loops => loops.map(loop => loop.flatMap(he => {
        const flat = debug.chains[he >> 1].flat;
        return (he & 1 ? flat.slice().reverse() : flat).slice(0, -1);
    })));
    const checkPoint = (x, y, color) => {
        const pixel = y * image.width + x, face = debug.componentIds[pixel];
        assert.equal(debug.faces[face].color, color, `${name}: correct source component at (${x},${y})`);
        assert(rings[face].reduce((parity, ring) => parity !== inside({ x: x + .5, y: y + .5 }, ring), false),
            `${name}: finished geometry retains (${x},${y})`);
        return face;
    };
    const rims = new Set(), interiors = new Set();
    for (let row = 0; row < 52; row++) for (let col = 0; col < 52; col++) {
        const x = 24 + col * 9, y = 24 + row * 9;
        rims.add(checkPoint(x, y + 2, gray));
        interiors.add(checkPoint(x + 2, y + 2, black));
    }
    assert.equal(rims.size, 52 * 52, `${name}: independent gray rims`);
    assert.equal(interiors.size, 52 * 52, `${name}: independent black interiors`);
    for (const [x, y] of [[5, 5], [16, 6]]) assert(!rims.has(checkPoint(x, y, gray)), `${name}: retain isolated accent`);
    console.log(`PASS ${name}: ${stats.regions} genuine regions, all paints and thin rims retained (${stats.ms} ms)`);
}

const image = crowdedGrayOutlines();
const cases = [
    { name: 'Auto with detail protection', colors: 0, noise: 10, minArea: 6 },
    { name: 'Explicit three paints', colors: 3, noise: 10, minArea: 6 },
    { name: 'Auto without noise filtering', colors: 0, noise: 0, minArea: 6 },
    { name: 'Auto without area cleanup', colors: 0, noise: 10, minArea: 0 },
];
for (const { name, ...options } of cases) checkRetained(name, image, options);
for (const jitter of [6, 10]) checkRetained(`Correlated gray-rim noise ±${jitter}`, crowdedGrayOutlines(jitter), {
    colors: 0, noise: 10, minArea: 6,
});
