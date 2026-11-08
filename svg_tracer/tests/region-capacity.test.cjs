/* Original procedural controls for the independent region, edge, and pixel limits.
 * Run: node tests/region-capacity.test.cjs [path/to/tracer.js]
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTracer } = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js')));
const options = { colors: 2, noise: 0, minArea: 0, preserveDetails: true };
function raster(width, height, blackAt) {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (blackAt(x, y)) {
        const p = (y * width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
    }
    return { width, height, data };
}
const count = 141, side = count * 5 + 2;
const squares = raster(side, side, (x, y) => x >= 2 && y >= 2 && (x - 2) % 5 < 3 && (y - 2) % 5 < 3);
const dense = createTracer().trace(squares, options);
assert.equal(dense.stats.regions, count * count + 1, 'Retain 19,881 separate marks plus the common background');
assert.equal(dense.stats.visibleRegions, dense.stats.regions);
assert.equal(dense.stats.colors, 2);
assert.equal(dense.stats.removedPixels, 0);
assert.equal(dense.stats.relabeledPixels, 0);
assert.equal(dense.stats.autoMergedFragments, 0, 'Explicit colors do not use Auto recovery');
assert.equal(dense.stats.elements.rect, count * count, 'Every source square has its own rectangular SVG element');
assert.equal(dense.stats.rawEdges, 12 * count * count + 4 * side);
assert.equal(dense.stats.globalExactFallback, false);
assert.match(dense.stats.validation, /^passed/);
assert(!/NaN|Infinity|undefined/.test(dense.svg));
console.log(`PASS dense original squares: ${dense.stats.regions} regions, ${dense.stats.rawEdges} edges (${dense.stats.ms} ms)`);

const exact = createTracer().trace(raster(200, 100, (x, y) => (x + y) % 2 === 0), options);
assert.equal(exact.stats.regions, 20000, 'The 20,000-region ceiling is inclusive');
assert.equal(exact.stats.visibleRegions, 20000);
assert.equal(exact.stats.removedPixels, 0);
assert.equal(exact.stats.relabeledPixels, 0);
assert.match(exact.stats.validation, /^passed/);
console.log(`PASS exact capacity: ${exact.stats.regions} connected regions (${exact.stats.ms} ms)`);

const over = raster(201, 100, (x, y) => (x + y) % 2 === 0);
for (const colors of [0, 2]) {
    assert.throws(() => createTracer().trace(over, { ...options, colors }), /More than 20,000 regions \(20,100 detected\)/,
        `Reject real excess complexity for ${colors ? 'explicit colors' : 'Auto'} without deleting pixels`);
}
console.log('PASS excess regions: Auto and explicit counts keep the independent 20,000-region guard');

// These stripes have only 501 faces but more than 450,000 shared edges.
// Raising region capacity must not bypass the separate geometry budget.
assert.throws(() => createTracer().trace(raster(501, 900, x => x % 2 === 0), options), /Too many boundaries/);
console.log('PASS boundary guard: low region count cannot bypass the edge budget');
assert.throws(() => createTracer().trace({ width: 4000001, height: 1, data: new Uint8ClampedArray(4000001 * 4) }, options), /4 million pixels/);
console.log('PASS working-pixel guard: unchanged 4-million-pixel ceiling');
