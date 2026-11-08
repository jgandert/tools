/* Verify the same self-contained factory serialization used by index.html.
 * Node worker isolation tests factory dependencies; it does not emulate browser
 * layout, image decoding, or Blob URL security policy.
 * Run: node tests/worker-factory.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createTracer } = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js')));

async function main() {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))
        .find(item => item.name === 'holes');
    assert(fixture, 'Bundled nested-region fixture');
    const data = new Uint8ClampedArray(fs.readFileSync(path.join(__dirname, 'fixtures', 'holes.rgba')));
    const image = {width:fixture.width, height:fixture.height, data};
    const options = {colors:fixture.colors, noise:10, tolerance:1.25, minArea:6, ...fixture.options};
    const direct = createTracer().trace(image, options);
    const stages = [];
    const worker = new Worker(`
        'use strict';
        const { parentPort } = require('node:worker_threads');
        const createTracer = ${createTracer.toString()};
        const tracer = createTracer();
        parentPort.on('message', ({width, height, buffer, options}) => {
            try {
                const result = tracer.trace({width, height, data:new Uint8ClampedArray(buffer)}, options,
                    stage => parentPort.postMessage({type:'progress', stage}));
                parentPort.postMessage({type:'result', result});
            } catch (error) { parentPort.postMessage({type:'error', message:error.stack}); }
        });
    `, {eval:true});
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Serialized worker timed out')), 30000);
            worker.once('error', error => {clearTimeout(timer); reject(error);});
            worker.on('message', message => {
                if (message.type === 'progress') stages.push(message.stage);
                else {
                    clearTimeout(timer);
                    if (message.type === 'error') reject(new Error(message.message));
                    else resolve(message.result);
                }
            });
            worker.postMessage({width:image.width, height:image.height, buffer:data.buffer, options}, [data.buffer]);
            assert.equal(data.byteLength, 0, 'RGBA input buffer transferred to isolated worker');
        });
        assert.equal(result.svg, direct.svg, 'Serialized factory exports the same SVG');
        const withoutTime = ({ms, ...rest}) => rest;
        assert.deepEqual(withoutTime(result.stats), withoutTime(direct.stats), 'Serialized factory statistics');
        assert.match(result.stats.validation, /^passed/);
        assert(stages.length > 0, 'Worker progress is reported');
        console.log(`PASS serialized factory worker: ${result.stats.regions} regions, identical SVG and statistics`);
    } finally { await worker.terminate(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
