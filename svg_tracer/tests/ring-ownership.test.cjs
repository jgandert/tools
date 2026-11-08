/* Independent ownership oracle for the validation ring index.
 * Run: node tests/ring-ownership.test.cjs [path/to/tracer.js]
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tracer.js'));
const core = fs.readFileSync(corePath, 'utf8');
const hook = 'const owners=[...ownerSet].sort((a,b)=>a-b);';
assert.equal(core.split(hook).length, 2, 'Exactly one indexed ownership query to observe');
let checked = 0, sawTransparent = false, sawOmitted = false, sawHoles = false;
function inside(point, ring) {
    let parity = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const u = ring[a], v = ring[b];
        if ((u.y > point.y) !== (v.y > point.y)
            && point.x < u.x + (v.x - u.x) * (point.y - u.y) / (v.y - u.y)) parity = !parity;
    }
    return parity;
}
const context = {
    module: { exports: {} },
    verifyOwners(point, models, owners, faces) {
        // Deliberately examine EVERY ring without any bounding-box shortcut.
        // This oracle would catch omitted candidates and incorrect parity when
        // several holes or nested rings belong to the same face.
        const exhaustive = [];
        for (let id = 0; id < models.length; id++) {
            if (models[id].rings.reduce((parity, ring) => parity !== inside(point, ring), false)) exhaustive.push(id);
        }
        assert.deepEqual(Array.from(owners), exhaustive, `Indexed versus exhaustive ownership at (${point.x},${point.y})`);
        checked++;
        sawTransparent ||= faces.some(face => face.color < 0);
        sawOmitted ||= faces.some(face => face.omit);
        sawHoles ||= models.some(model => model.rings.length > 1);
    },
};
vm.createContext(context);
vm.runInContext(core.replace(hook, `${hook}globalThis.verifyOwners(p,models,owners,faces);`), context, { filename: corePath });
const { createTracer } = context.module.exports;
const paints = [[246, 246, 236, 255], [10, 15, 24, 255], [220, 40, 65, 255], [0, 0, 0, 0]];
function nestedArtwork() {
    const width = 160, height = 128, data = new Uint8ClampedArray(width * height * 4);
    const layers = [0, 1, 3, 2, 0, 1, 3];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const depth = Math.min(x, width - 1 - x, y, height - 1 - y);
        data.set(paints[layers[Math.min(layers.length - 1, Math.floor(depth / 9))]], (y * width + x) * 4);
    }
    return { width, height, data };
}
function manyHoles() {
    const width = 260, height = 200, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let paint = 0;
        const col = Math.floor((x - 10) / 20), row = Math.floor((y - 10) / 20);
        if (col >= 0 && col < 12 && row >= 0 && row < 9) {
            const dx = x - (20 + col * 20), dy = y - (20 + row * 20), distance = Math.hypot(dx, dy);
            if (distance < 7) paint = (row + col) % 2 ? 1 : 2;
            if (distance < 3) paint = 3;
        }
        data.set(paints[paint], (y * width + x) * 4);
    }
    return { width, height, data };
}
for (const [name, image] of [['nested rings', nestedArtwork()], ['separate rings and many holes', manyHoles()]]) {
    for (const removeBackground of [false, true]) {
        const before = checked;
        const result = createTracer().trace(image, { colors: 3, noise: 0, minArea: 0, preserveDetails: true, removeBackground });
        assert.match(result.stats.validation, /^passed/);
        assert(checked > before, `${name}: exercised indexed ownership queries`);
        console.log(`PASS ${name}, removeBackground=${removeBackground}: ${checked - before} exhaustive ownership comparisons`);
    }
}
assert(sawTransparent && sawOmitted && sawHoles, 'Include transparency, omitted background, and faces with holes');
