/* Original procedural benchmark; timings are local observations, not test gates.
 * Run: node tests/region-capacity-benchmark.cjs [core.js] [square-grid-count] [--exhaustive]
 * The optional exhaustive mode restores the former ownership query as a comparator.
 */
'use strict';
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js'));
const core = fs.readFileSync(corePath, 'utf8');
let source = core;
const exhaustive = process.argv.includes('--exhaustive');
if (exhaustive) {
    const start = source.indexOf('    // Index individual rings, including background holes.');
    const end = source.indexOf('    // Detect vanished features and changed nesting', start);
    assert(start >= 0 && end > start, 'Locate the ring index for the exhaustive comparator');
    source = source.slice(0, start) + source.slice(end);
    const query = 'const ownerSet=new Set();collectOwners(ringIndex,p,ownerSet);\n      const owners=[...ownerSet].sort((a,b)=>a-b);';
    assert.equal(source.split(query).length, 2, 'Locate exactly one indexed ownership query');
    source = source.replace(query, `const owners=[];
      for(let i=0;i<models.length;i++) {
        const m=models[i];if(p.x<m.minX||p.x>m.maxX||p.y<m.minY||p.y>m.maxY)continue;
        let yes=false;
        for(let j=0;j<m.rings.length;j++) {
          const box=m.bounds[j];
          if(p.x>=box.minX&&p.x<=box.maxX&&p.y>=box.minY&&p.y<=box.maxY&&inside(p,m.rings[j]))yes=!yes;
        }
        if(yes)owners.push(i);
      }`);
}
const { createTracer } = new Function('module', source + '\nreturn module.exports;')({ exports: {} });
const count = Number(process.argv[3] || 141);
assert(Number.isInteger(count) && count > 0, 'Positive integer square-grid count');
const width = count * 5 + 2, height = width;
const data = new Uint8ClampedArray(width * height * 4).fill(255);
for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        const p = ((row * 5 + 2 + y) * width + col * 5 + 2 + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
    }
}
let previous = performance.now(), stage = 'setup';
const durations = {};
const result = createTracer().trace({ width, height, data }, { colors: 2, noise: 0, minArea: 0 }, next => {
    const now = performance.now(); durations[stage] = (durations[stage] || 0) + now - previous;
    previous = now; stage = next;
});
durations[stage] = (durations[stage] || 0) + performance.now() - previous;
const { regions, rawEdges, sharedChains, segments, fallbackChains, globalExactFallback, ms } = result.stats;
console.log(JSON.stringify({ core: corePath, ownership: exhaustive ? 'exhaustive' : 'ring index', coreSha256: require('node:crypto').createHash('sha256').update(core).digest('hex'), count, width, regions, rawEdges, sharedChains, segments, fallbackChains, globalExactFallback, ms, svgBytes: Buffer.byteLength(result.svg), svgSha256: require('node:crypto').createHash('sha256').update(result.svg).digest('hex'), peakRssMb: process.resourceUsage().maxRSS / 1024, stages: durations }, null, 2));
