/* Reproducible source benchmark, Node built-ins only.
 * Run: node tests/source-benchmark.cjs [core.js] [--native|--working]
 *          [--colors=0|2] [--debug] [--svg=output.svg]
 * Use separate, otherwise idle processes for comparable peak RSS and timing.
 * This measures a workload; it does not enforce a machine-dependent deadline.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { decodePNG } = require('./helpers/png.cjs');

let corePath = path.join(__dirname, '..', 'tracer.js');
let size = 'working', colors = 0, debug = false, svgPath = null;
let fixtureDir = path.join(__dirname, 'fixtures'), suppliedCore = false;
for (const arg of process.argv.slice(2)) {
    if (arg === '--native') size = 'native';
    else if (arg === '--working') size = 'working';
    else if (arg === '--debug') debug = true;
    else if (/^--colors=(0|2)$/.test(arg)) colors = Number(arg.slice(9));
    else if (arg.startsWith('--svg=')) svgPath = path.resolve(arg.slice(6));
    else if (arg.startsWith('--fixtures=')) fixtureDir = path.resolve(arg.slice(11));
    else if (!arg.startsWith('--') && !suppliedCore) { corePath = arg; suppliedCore = true; }
    else throw new Error(`Unknown benchmark argument: ${arg}`);
}
corePath = path.resolve(corePath);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalPNG = fs.readFileSync(path.join(fixtureDir, 'source.png'));
assert.equal(sha256(originalPNG), '125272e0439c5f050ecc7b0933ed369685f5533617bd33986f9410614331b1f1', 'Original source PNG fixture');
let input;
if (size === 'native') {
    input = decodePNG(originalPNG);
    assert.deepEqual([input.width, input.height], [1254, 1254], 'Original source dimensions');
    assert.equal(sha256(input.data), '1b2c4363278f19ee260f1560d4f4822d5541359fb252e475798a4cee62884de6', 'Original RGBA pixels');
} else {
    const pixels = zlib.gunzipSync(fs.readFileSync(path.join(fixtureDir, 'source-1024-skia.rgba.gz')), { maxOutputLength: 1024 * 1024 * 4 });
    assert.equal(sha256(pixels), '28ee8010e224f06b94c54fefb2c2fb5ccf80d9da15714e33ca00882579890fb8', 'Frozen working RGBA pixels');
    input = { width: 1024, height: 1024, data: new Uint8ClampedArray(pixels) };
}
const options = {
    colors, noise: 10, tolerance: 1.25, minArea: 6,
    preserveDetails: true, smoothJunctions: true, removeBackground: false,
    outputWidth: 1254, outputHeight: 1254, debug,
};
const { createTracer } = require(corePath);
const stages = [], started = performance.now();
const checkpoint = name => {
    const elapsedMs = performance.now() - started, heap = v8.getHeapStatistics();
    if (stages.length) stages[stages.length - 1].durationMs = elapsedMs - stages[stages.length - 1].elapsedMs;
    stages.push({ name, elapsedMs, heapUsedMb: heap.used_heap_size / 1048576,
        heapTotalMb: heap.total_heap_size / 1048576, peakRssMb: process.resourceUsage().maxRSS / 1024 });
};
const result = createTracer().trace(input, options, checkpoint);
checkpoint('Complete');
assert.match(result.stats.validation, /^passed/, 'Source topology validation');
if (svgPath) fs.writeFileSync(svgPath, result.svg);
const { ms, ...stableStats } = result.stats;
const fingerprint = debug ? {
    labelsSha256: sha256(Int16Array.from(result.debug.labels)),
    componentIdsSha256: sha256(Int32Array.from(result.debug.componentIds)),
} : undefined;
console.log(JSON.stringify({
    corePath, coreSha256: sha256(fs.readFileSync(corePath)),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    input: { size, width: input.width, height: input.height, rgbaSha256: sha256(input.data) },
    options, peakRssMb: process.resourceUsage().maxRSS / 1024,
    elapsedMs: stages[stages.length - 1].elapsedMs,
    svgSha256: sha256(result.svg), svgBytes: Buffer.byteLength(result.svg),
    stableStatsSha256: sha256(JSON.stringify(stableStats)),
    stats: result.stats, stages, fingerprint,
}, null, 2));
