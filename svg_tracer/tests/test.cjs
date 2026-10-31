/* Dependency-free regression tests for the DOM-free tracing core.
 * Run: node tests/test.cjs [path/to/tracer.js]
 * Fixtures were rasterized in Chromium; their RGBA bytes are bundled so this
 * runner requires no browser, canvas package, or network connection.
 * Numerical topology validation and finite fixtures are not a formal proof.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const corePath = process.argv[2] || path.join(__dirname, '..', 'tracer.js');
const core = fs.readFileSync(corePath, 'utf8');
const context = {module: {exports: {}}, console};
vm.createContext(context);
vm.runInContext(core, context, {filename: 'tracer.js'});
const tracer = context.module.exports.createTracer();
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const records = [];
function checkResult(name, image, options, expectedColors) {
  const original = Buffer.from(image.data);
  const result = tracer.trace(image, {...options, debug: true});
  const {svg, stats, debug} = result;
  assert.match(stats.validation, /^passed/, `${name}: topology validation`);
  assert(!/NaN|Infinity|undefined/.test(svg), `${name}: invalid serialized number`);
  assert(!/<(?:image|mask|filter|clipPath|use|script)\b|\bstroke\s*=/.test(svg), `${name}: prohibited raster/masking/stroke workaround`);
  assert.equal(Buffer.compare(original, Buffer.from(image.data)), 0, `${name}: input data was mutated`);
  if (expectedColors !== undefined) assert.equal(stats.colors, expectedColors, `${name}: paint count`);
  // Independently check that the exported chains join, in either orientation,
  // to form closed rings. This catches endpoint bugs before SVG's implicit Z
  // operation can conceal them.
  for (const rings of debug.loops) for (const ring of rings) {
    let first = null, last = null;
    for (const he of ring) {
      const chain = debug.chains[he >> 1];
      const list = (he & 1) ? chain.segments.slice().reverse() : chain.segments;
      for (const s of list) {
        const a = (he & 1) ? s.b : s.a, b = (he & 1) ? s.a : s.b;
        if (last) assert(Math.hypot(a.x-last.x,a.y-last.y) < 1e-6, `${name}: disconnected boundary`);
        else first = a;
        last = b;
      }
    }
    if (first) assert(Math.hypot(first.x-last.x,first.y-last.y) < 1e-6, `${name}: open ring`);
  }
  records.push({name, passed: true, colors: stats.colors, regions: stats.regions,
    segments: stats.segments, fallbackChains: stats.fallbackChains,
    recoveredPaints: stats.recoveredPaints, svgBytes: Buffer.byteLength(svg)});
  console.log(`PASS ${name}: ${stats.colors} paints, ${stats.segments} segments`);
  return result;
}
const byName = new Map();
for (const f of fixtures) {
  const data = new Uint8ClampedArray(fs.readFileSync(path.join(__dirname, 'fixtures', `${f.name}.rgba`)));
  const result = checkResult(f.name, {width:f.width,height:f.height,data},
    {colors:f.colors,noise:10,tolerance:1.25,minArea:6,...f.options}, f.colors);
  byName.set(f.name, result);
}
assert.equal(byName.get('thin_outline_auto').stats.recoveredPaints, 1);
assert.equal(byName.get('small_accents_auto').stats.recoveredPaints, 2);
assert(byName.get('transparent').stats.alphaBoundarySamples > 0);
assert(byName.get('rounded_capsules').stats.primitives.roundedRect >= 2);
assert(byName.get('primitives').stats.primitives.circle >= 1);
assert(byName.get('primitives').stats.primitives.ellipse >= 1);
assert(byName.get('organic').stats.primitiveGuides >= 1);
assert.equal(byName.get('tiny_pixels').stats.visibleRegions, 3);
assert.equal(byName.get('holes').stats.visibleRegions, 3);
assert.equal(byName.get('transparent_empty').stats.visibleRegions, 0);

// An RGB fringe must not partition a transparent silhouette into extra paints.
// Check the known geometry as well as the paint count: extra edge regions used
// to prevent circle recognition and leave staircase diagonals after repairs.
const edgeArtwork = byName.get('edge_artifacts');
assert.equal(edgeArtwork.stats.visibleRegions, 3);
assert.equal(edgeArtwork.stats.fallbackChains, 0);
const circleBoundary = edgeArtwork.debug.chains.find(c => c.segments.length === 2 && c.segments.every(s => s.type === 'A'));
assert(circleBoundary, 'edge_artifacts: round contour');
for (const s of circleBoundary.segments) {
  assert(Math.abs(s.cx - 235.4) < .15 && Math.abs(s.cy - 55.8) < .15, 'edge_artifacts: circle center');
  assert(Math.abs(s.rx - 31.6) < .15 && s.rx === s.ry, 'edge_artifacts: circle radius');
}
const vertices = [{x:101.4,y:69.2},{x:269.8,y:166.4},{x:251.6,y:197.9},{x:83.2,y:100.7}];
const diagonal = edgeArtwork.debug.chains.find(c => c.segments.length === 4 && c.segments.every(s => s.type === 'L') && vertices.every(v => c.segments.some(s => Math.hypot(v.x-s.a.x,v.y-s.a.y) < .3)));
assert(diagonal, 'edge_artifacts: four straight sides at the source vertices');
assert.equal(byName.get('transparent_outline_auto').stats.visibleRegions, 2);
assert.equal(byName.get('transparent_accent_auto').stats.visibleRegions, 2);

// A known count must still retain edge-only colors when they are intentional.
const damagedArtwork = {
  width: 320,
  height: 260,
  data: new Uint8ClampedArray(fs.readFileSync(path.join(__dirname, 'fixtures', 'edge_artifacts.rgba'))),
};
checkResult('edge_artifacts_explicit', damagedArtwork, {colors:4,noise:10,tolerance:1.25,minArea:6}, 4);
checkResult('edge_artifacts_no_prefilter', damagedArtwork, {colors:0,noise:0,tolerance:1.25,minArea:6}, 2);

// A clipped foreground object must not be mistaken for the background when
// transparent pixels, rather than an opaque paint, dominate the canvas border.
{
  const width=40,height=32,data=new Uint8ClampedArray(width*height*4);
  for(let y=10;y<22;y++)for(let x=0;x<13;x++)data.set([32,130,170,255],(y*width+x)*4);
  const r=checkResult('transparent_border_removal',{width,height,data},
    {colors:1,noise:0,minArea:0,removeBackground:true,outputWidth:400,outputHeight:320},1);
  assert.equal(r.stats.visibleRegions,1);
  assert.match(r.svg,/width="400" height="320" viewBox="0 0 40 32"/);
}

// Exercise the new explicit upper color limit with 64 distinct solid paints.
{
  const width=64,height=64,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const c=Math.floor(y/8)*8+Math.floor(x/8);
    data.set([(c*47)%256,(c*83)%256,(c*131)%256,255],(y*width+x)*4);
  }
  checkResult('sixty_four_colors',{width,height,data},{colors:64,noise:0,minArea:0,tolerance:.3},64);
}

// Seeded pixel-art fields stress disconnected faces, short chains, 4-way
// contacts, holes and exact lattice geometry. These are not visual benchmarks.
let state=73819;
const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
const paints=[[255,255,255,255],[20,110,145,255],[230,55,85,255],[224,165,30,255]];
for(let test=0;test<12;test++) {
  const width=12+test,height=15+test,block=1+test%4;
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y+=block)for(let x=0;x<width;x+=block) {
    const color=paints[(random()>>>22)%4];
    for(let yy=y;yy<Math.min(y+block,height);yy++)for(let xx=x;xx<Math.min(x+block,width);xx++)data.set(color,(yy*width+xx)*4);
  }
  checkResult(`seeded_topology_${test+1}`,{width,height,data},{colors:4,noise:0,minArea:0,tolerance:.5},4);
}
const pixel={width:1,height:1,data:new Uint8ClampedArray([18,96,120,255])};
assert.throws(()=>tracer.trace({width:0,height:1,data:new Uint8Array(0)}),/valid width and height/);
assert.throws(()=>tracer.trace(pixel,{tolerance:NaN}),/Invalid tolerance/);
assert.throws(()=>tracer.trace(pixel,{colors:Infinity}),/Invalid colors/);
assert.throws(()=>tracer.trace(pixel,{outputWidth:0}),/Invalid SVG output dimensions/);
assert.throws(()=>tracer.trace({width:2001,height:2001,data:{length:2001*2001*4}}),/4 million pixels/);
console.log(`\n${records.length} image cases and 5 invalid-input checks passed.`);
fs.writeFileSync(path.join(__dirname,'test-results.json'),JSON.stringify({imageCases:records.length,invalidInputChecks:5,records},null,2));
