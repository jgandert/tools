/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* Invalid export dimensions must reject before expensive image processing.
 * Run: node tests/api-dimensions.test.cjs [path/to/tracer.js]
 */
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {createTracer}=require(path.resolve(process.argv[2]||path.join(__dirname,'..','tracer.js')));
const tracer=createTracer(),image={width:2,height:1,data:new Uint8ClampedArray([18,96,120,255,18,96,120,255])};
let invalidCases=0;
for(const key of ['outputWidth','outputHeight'])for(const value of [0,-1,NaN,Infinity,-Infinity,'bad','']) {
 let stages=0;
 assert.throws(()=>tracer.trace(image,{[key]:value},()=>stages++),/Invalid SVG output dimensions/);
 assert.equal(stages,0,`${key}=${String(value)} rejects before tracing progress`);
 invalidCases++;
}
const trace=options=>tracer.trace(image,{colors:1,noise:0,minArea:0,...options}).svg;
assert.match(trace({}),/width="2" height="1" viewBox="0 0 2 1"/,'Default export dimensions');
assert.match(trace({outputWidth:null,outputHeight:undefined}),/width="2" height="1" viewBox="0 0 2 1"/,'Nullish dimensions use raster dimensions');
assert.match(trace({outputWidth:'2.5',outputHeight:'4'}),/width="2.5" height="4" viewBox="0 0 2 1"/,'Preserve accepted numeric coercion and fractional dimensions');
console.log(`PASS output dimensions: ${invalidCases} fail before tracing, defaults and numeric coercion retained`);
