/* Dependency-free integration regression for the user's reported helical
 * staircase. Run: node tests/source-helix.test.cjs [path/to/tracer.js]
 * Source permission and working-raster provenance: SOURCE_IMAGE.md.
 *
 * Source controls were selected before examining a candidate: one dark center
 * per 10x10 native-source cell, with original gray <=70 and working gray <=110;
 * enclosed paper centers were >=220 in the original and frozen working raster.
 * The baseline retained all 93 ink points and 40 paper points in 15 distinct
 * enclosed output faces. Five source paper components already joined background
 * and are not required to remain lost. Some source dividers were already absent.
 * Finite checks are regression evidence, not a universal topology proof.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js'));
const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'source.png'));
assert.equal(hash(original), '125272e0439c5f050ecc7b0933ed369685f5533617bd33986f9410614331b1f1', 'Original source fixture');
const working = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'source-1024-skia.rgba.gz')), { maxOutputLength: 1024 * 1024 * 4 });
assert.equal(hash(working), '28ee8010e224f06b94c54fefb2c2fb5ccf80d9da15714e33ca00882579890fb8', 'Frozen working pixels');
const input = { width: 1024, height: 1024, data: new Uint8ClampedArray(working) };
// Each row is [originalX, originalY, workingX, workingY].
const inkPairs = [
    [28,708,23,578], [43,706,35,576], [47,702,38,573], [60,709,49,579], [80,704,65,575],
    [94,700,77,572], [100,709,82,579], [109,703,89,574], [14,719,11,587], [22,719,18,587],
    [26,713,21,582], [35,711,28,581], [60,714,49,583], [84,710,69,580], [93,715,76,584],
    [97,714,79,583], [13,720,11,588], [17,726,14,593], [58,720,47,588], [101,720,82,588],
    [110,725,90,592], [9,732,7,598], [17,736,14,601], [61,731,50,597], [66,732,54,598],
    [75,734,61,599], [87,739,71,603], [95,739,77,603], [14,740,11,604], [21,741,17,605],
    [26,741,21,605], [54,745,44,608], [63,744,51,607], [98,742,80,606], [108,748,88,611],
    [44,759,36,620], [54,754,44,616], [55,754,45,616], [65,754,53,616], [81,755,66,616],
    [91,756,74,617], [98,757,80,618], [108,759,88,620], [23,768,19,627], [28,766,23,625],
    [37,760,30,621], [53,763,43,623], [65,760,53,621], [93,769,76,628], [101,765,82,625],
    [107,760,87,621], [14,778,11,635], [17,774,14,632], [71,778,58,635], [82,773,67,631],
    [86,772,70,630], [10,785,8,641], [38,789,31,644], [50,785,41,641], [61,782,50,638],
    [65,780,53,637], [23,795,19,649], [25,795,20,649], [43,790,35,645], [48,790,39,645],
    [57,792,46,647], [70,796,57,650], [80,797,65,651], [12,802,10,655], [15,800,12,653],
    [81,800,66,653], [87,801,71,654], [14,810,11,661], [16,811,13,662], [30,816,24,666],
    [38,818,31,668], [45,819,37,669], [96,812,78,663], [54,821,44,670], [55,821,45,670],
    [67,822,55,671], [76,824,62,673], [94,828,77,676], [96,829,78,677], [67,839,55,685],
    [82,838,67,684], [91,834,74,681], [96,830,78,678], [30,849,24,693], [37,847,30,692],
    [50,847,41,692], [70,844,57,689], [77,841,63,687],
];
const paperPairs = [
    [22,717,18,585], [58,737,47,602], [65,736,53,601], [81,737,66,602], [84,746,69,609],
    [22,743,18,607], [97,755,79,616], [55,768,45,627], [69,766,56,625], [74,765,60,625],
    [83,763,68,623], [88,764,72,624], [93,767,76,626], [48,770,39,629], [39,767,32,626],
    [34,788,28,643], [27,784,22,640], [20,783,16,639], [16,794,13,648], [12,800,10,653],
    [52,786,42,642], [10,801,8,654], [35,809,28,661], [41,804,33,656], [44,805,36,657],
    [50,806,41,658], [28,813,23,664], [58,807,47,659], [66,799,54,652], [26,804,21,656],
    [80,810,65,661], [19,804,15,656], [16,801,13,654], [85,813,69,664], [88,811,72,662],
    [93,815,76,665], [70,833,57,680], [79,825,64,674], [83,834,68,681], [86,834,70,681],
];
const separateHoles = [
    [22,717,18,585], [58,737,47,602], [65,736,53,601], [22,743,18,607], [55,768,45,627],
    [69,766,56,625], [93,767,76,626], [48,770,39,629], [39,767,32,626], [34,788,28,643],
    [52,786,42,642], [35,809,28,661], [50,806,41,658], [58,807,47,659], [70,833,57,680],
];
for (const [, , x, y] of inkPairs) assert(Math.max(...working.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 3)) <= 110, 'Source-supported dark ink');
for (const [, , x, y] of paperPairs) assert(Math.min(...working.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 3)) >= 220, 'Source-supported white cell');
const { createTracer } = require(corePath);
const { svg, stats, debug } = createTracer().trace(input, {
    colors: 2, noise: 10, tolerance: 1.25, minArea: 6,
    preserveDetails: true, smoothJunctions: true, removeBackground: false,
    outputWidth: 1254, outputHeight: 1254, debug: true,
});
assert.equal(hash(input.data), hash(working), 'Do not mutate input pixels');
assert.equal(stats.colors, 2, 'Explicit two-paint output');
assert.match(stats.validation, /^passed/, 'Validated source topology');
assert.equal(stats.globalExactFallback, false, 'Preserve fitted geometry throughout the drawing');
assert.equal(stats.fallbackChains, 0, 'Fit every shared boundary in the complete two-color source without exact fallback');
assert.equal(stats.sampleFallbackChains, 0, 'Do not replace a complete source boundary by sample lines');
assert.match(svg, /width="1254" height="1254" viewBox="0 0 1024 1024"/, 'Original export dimensions');
assert(!/NaN|Infinity|undefined/.test(svg), 'Finite serialized geometry');
assert(!/<(?:image|mask|filter|clipPath|use|script)\b|\bstroke\s*=/.test(svg), 'Filled vector output');

// Locate the outer helical contour by source bounds, independently of chain IDs.
const helical = debug.chains.filter(chain => chain.raw.length > 600
    && chain.raw.every(p => p.x >= 0 && p.x <= 100 && p.y >= 560 && p.y <= 700));
assert.equal(helical.length, 1, 'Locate the reported outer helical boundary');
const boundary = helical[0];
assert.equal(boundary.exact, false, 'Do not replace the entire helical boundary with pixel edges');
assert(boundary.segments.length < 240, 'Recover a compact fitted helical boundary');
assert(boundary.segments.filter(segment => segment.type === 'C' || segment.type === 'A').length >= 10, 'Retain curved helical geometry');
let run = 0, longestStaircase = 0;
for (const segment of boundary.segments) {
    const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y;
    const isSmallAxisLine = segment.type === 'L'
        && (Math.abs(dx) < 1e-8 || Math.abs(dy) < 1e-8)
        && Math.hypot(dx, dy) > 0 && Math.hypot(dx, dy) <= 4;
    run = isSmallAxisLine ? run + 1 : 0;
    longestStaircase = Math.max(longestStaircase, run);
}
assert(longestStaircase < 16, 'No long consecutive pixel-step run on the helical perimeter');

// Independently cast rays over final flattened geometry. Exactly one face owns
// each probe; a dark source component may shift by the existing quarter-pixel
// thin-feature allowance plus 0.0125 pixels of flattening tolerance.
function inside(point, polygon) {
    let yes = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) yes = !yes;
    }
    return yes;
}
const models = debug.loops.map(rings => {
    const polygons = rings.map(ring => ring.flatMap(halfEdge => {
        const flat = debug.chains[halfEdge >> 1].flat;
        return (halfEdge & 1 ? flat.slice().reverse() : flat).slice(0, -1);
    }));
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const ring of polygons) for (const p of ring) {
        box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
        box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
    }
    return { polygons, box };
});
function contains(id, point) {
    const { box, polygons } = models[id];
    if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) return false;
    return polygons.reduce((parity, ring) => parity !== inside(point, ring), false);
}
const brightness = stats.palette.map(hex => (parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)) / 3);
for (const [kind, pairs] of [['ink', inkPairs], ['paper', paperPairs]]) for (const [, , x, y] of pairs) {
    const at = y * 1024 + x, expectedFace = debug.componentIds[at];
    const point = { x: x + .5, y: y + .5 };
    const owners = models.flatMap((_, id) => contains(id, point) ? [id] : []);
    assert.equal(owners.length, 1, 'Exactly one fitted face owns source probe (' + x + ',' + y + ')');
    if (kind === 'paper') {
        assert(brightness[debug.labels[at]] > 220, 'Preserve source paper');
        assert.notEqual(expectedFace, debug.componentIds[0], 'Keep source cell enclosed');
        assert.equal(owners[0], expectedFace, 'Fitted source cell retains its face');
    } else {
        assert(brightness[debug.labels[at]] < 200, 'Preserve source ink');
        let retained = owners[0] === expectedFace;
        if (!retained) for (const distance of [.13125, .2625]) for (let angle = 0; angle < 16; angle++) {
            const theta = angle * Math.PI / 8;
            retained ||= contains(expectedFace, { x: point.x + distance * Math.cos(theta), y: point.y + distance * Math.sin(theta) });
        }
        assert(retained, 'Retain same source ink component within a quarter pixel');
    }
}
assert.equal(new Set(separateHoles.map(([, , x, y]) => debug.componentIds[y * 1024 + x])).size, separateHoles.length, 'Preserve 15 distinct enclosed helical faces');
console.log(JSON.stringify({ test: 'source helical staircase, explicit two paints', passed: true,
    sourceInkProbes: inkPairs.length, sourcePaperProbes: paperPairs.length,
    separateHoles: separateHoles.length, helicalSegments: boundary.segments.length,
    longestStaircase, fallbackChains: stats.fallbackChains, sampleFallbackChains: stats.sampleFallbackChains,
    segments: stats.segments, validation: stats.validation,
    coreSHA256: hash(fs.readFileSync(corePath)), svgSHA256: hash(svg), ms: stats.ms }, null, 2));
