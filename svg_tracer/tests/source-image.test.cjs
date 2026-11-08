/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* Slow, dependency-free source-image integration regression.
 * Run: node tests/source-image.test.cjs [core.js] [source.png] [working.rgba.gz]
 * The default fixture is tests/fixtures/source.png. The user supplied this
 * original artwork and explicitly permitted it and its derivatives as tests;
 * see SOURCE_IMAGE.md for provenance and the reproduction limitations.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { decodePNG } = require('./helpers/png.cjs');

const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js'));
const fixturePath = path.resolve(process.argv[3] || path.join(__dirname, 'fixtures', 'source.png'));
const originalPNG = fs.readFileSync(fixturePath);
assert.equal(crypto.createHash('sha256').update(originalPNG).digest('hex'),
    '125272e0439c5f050ecc7b0933ed369685f5533617bd33986f9410614331b1f1', 'Original source PNG fixture');
const original = decodePNG(originalPNG);
assert.deepEqual([original.width, original.height], [1254, 1254], 'Original source dimensions');
assert.equal(crypto.createHash('sha256').update(original.data).digest('hex'),
    '1b2c4363278f19ee260f1560d4f4822d5541359fb252e475798a4cee62884de6',
    'PNG rows decode to the independently verified original RGBA bytes');
// This frozen working raster was derived from the original by the UI's
// Canvas2D high-quality resampling calls using @napi-rs/canvas. It reproduces
// the reported staircase in this environment; no Chromium byte identity is
// claimed. Keeping the bytes removes browser/resampler changes from this test.
const workingPath = path.resolve(process.argv[4] || path.join(__dirname, 'fixtures', 'source-1024-skia.rgba.gz'));
const working = zlib.gunzipSync(fs.readFileSync(workingPath), { maxOutputLength: 1024 * 1024 * 4 });
assert.equal(working.length, 1024 * 1024 * 4, 'Frozen working raster length');
assert.equal(crypto.createHash('sha256').update(working).digest('hex'),
    '28ee8010e224f06b94c54fefb2c2fb5ccf80d9da15714e33ca00882579890fb8', 'Frozen working RGBA pixels');
const input = { width: 1024, height: 1024, data: new Uint8ClampedArray(working) };
const { createTracer } = require(corePath);
const result = createTracer().trace(input, {
    colors: 0, noise: 10, tolerance: 1.25, minArea: 6,
    preserveDetails: true, smoothJunctions: true, removeBackground: false,
    outputWidth: 1254, outputHeight: 1254, debug: true,
});
const { stats, svg, debug } = result;
assert.match(stats.validation, /^passed/, 'Source topology validation');
assert.equal(stats.globalExactFallback, false, 'Do not put the entire drawing back onto pixel boundaries');
assert(stats.colors >= 2 && stats.colors <= 32, 'Auto stays within its documented paint limit');
assert(stats.regions >= 1000 && stats.regions <= 5000, 'Retain rich region detail with the established Auto recovery');
assert(stats.autoMergedFragments > 0, 'Keep source-supported Auto recovery active independently of the higher capacity limit');
assert.match(svg, /width="1254" height="1254" viewBox="0 0 1024 1024"/, 'Default working size preserves original export dimensions');
assert(!/NaN|Infinity|undefined/.test(svg), 'Finite serialized geometry');
assert(!/<(?:image|mask|filter|clipPath|use|script)\b|\bstroke\s*=/.test(svg), 'Actual non-overlapping filled vector regions');

const intensity = hex => (parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)) / 3;
const paints = stats.palette.map(intensity);
const labelIntensity = (x, y) => paints[debug.labels[y * input.width + x]];
// Points were selected from both original and frozen working RGB before
// viewing a candidate: dark fan ribs/curves and one enclosed white node hole.
// Each row is [originalX, originalY, workingX, workingY]. Bright working holes
// have at least eight connected pixels above 220, independently of tracing.
// The original retained controls are augmented by two dark points and two
// enclosed holes documented as lost before the cleanup-ordering repair. Their
// source locations were recorded before evaluating that repair. Recovery must
// preserve these fragments before minimum-area merging can erase the contour.
// One further documented dark point remains unresolved and is not required.
const inkPairs = [[13,988,11,807], [50,1045,41,853], [11,980,9,800], [84,980,69,800],
    [38,996,31,813], [50,996,41,813], [59,996,48,813], [93,996,76,813],
    [44,1004,36,820], [51,1004,42,820], [58,1004,47,820], [35,1012,28,826],
    [46,1012,37,826], [54,1012,44,826], [59,1012,48,826], [28,1045,23,853],
    [39,1045,32,853], [47,1045,38,853], [30,1060,24,865], [44,1060,36,865]];
const paperPairs = [[31,23,25,19], [121,96,99,78], [18,107,15,87]];
const rgbAt = (image, x, y) => image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3);
const ink = inkPairs.map(([ox, oy, x, y]) => {
    assert(Math.max(...rgbAt(original, ox, oy)) < 80, `Dark original ink at (${ox},${oy})`);
    assert(Math.max(...rgbAt(input, x, y)) < 150, `Retained dark working ink at (${x},${y})`);
    assert(labelIntensity(x, y) < 200, `Preserve source ink at (${x},${y})`);
    return [x, y];
});
const paper = paperPairs.map(([ox, oy, x, y]) => {
    assert(Math.min(...rgbAt(original, ox, oy)) >= 240, `Bright original hole at (${ox},${oy})`);
    assert(Math.min(...rgbAt(input, x, y)) >= 240, `Retained bright working hole at (${x},${y})`);
    assert(labelIntensity(x, y) > 220, `Preserve small source hole at (${x},${y})`);
    assert.notEqual(debug.componentIds[y * input.width + x], debug.componentIds[0],
        `Source hole at (${x},${y}) remains enclosed rather than joining the background`);
    return [x, y];
});

// Check final geometric ownership at those source-selected locations using a
// separate even/odd ray cast over the finished flattened chains. This checks
// fitted geometry, rather than only its pre-fitting labels. Flattening itself
// is supplied by the core; finite probes do not establish universal topology.
function inside(point, polygon) {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) yes = !yes;
    }
    return yes;
}
const models = debug.loops.map(rings => rings.map(ring => ring.flatMap(he => {
    const flat = debug.chains[he >> 1].flat;
    return (he & 1 ? flat.slice().reverse() : flat).slice(0, -1);
})));
for (const [x, y] of [...ink, ...paper]) {
    const point = { x: x + .5, y: y + .5 };
    const owners = [];
    for (let i = 0; i < models.length; i++) {
        if (models[i].reduce((parity, ring) => parity !== inside(point, ring), false)) owners.push(i);
    }
    assert.equal(owners.length, 1, `Exactly one fitted face owns source probe (${x},${y})`);
    const expectedFace = debug.componentIds[y * input.width + x];
    const expectsPaper = paper.some(p => p[0] === x && p[1] === y);
    if (expectsPaper) {
        assert.equal(owners[0], expectedFace, `Fitted hole at (${x},${y}) remains its enclosed face`);
        assert.notEqual(owners[0], debug.componentIds[0], `Fitted hole at (${x},${y}) stays separate from background`);
    } else if (owners[0] !== expectedFace) {
        // A sampled raster center may cross an antialiased fitted boundary.
        // Require the SAME source component locally, within the documented
        // quarter-pixel thin-feature budget plus .0125 flattening allowance.
        // An unrelated nearby dark region cannot satisfy this control.
        const radius = .25 + .0125;
        let retained = false;
        for (const distance of [radius / 2, radius]) for (let angle = 0; angle < 16; angle++) {
            const theta = angle * 2 * Math.PI / 16;
            const probe = { x: point.x + distance * Math.cos(theta), y: point.y + distance * Math.sin(theta) };
            if (models[expectedFace].reduce((parity, ring) => parity !== inside(probe, ring), false)) retained = true;
        }
        assert(retained, `Fitting retains source ink component within a quarter pixel at (${x},${y})`);
    }
}
console.log(JSON.stringify({ test: 'source-image default-size Auto', passed: true,
    width: input.width, height: input.height, colors: stats.colors, regions: stats.regions,
    segments: stats.segments, fallbackChains: stats.fallbackChains, sourceProbes: ink.length + paper.length,
    validation: stats.validation, ms: stats.ms }, null, 2));
