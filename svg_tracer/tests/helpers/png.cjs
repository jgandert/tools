/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
'use strict';
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

// This decoder intentionally supports only the fixture's simple, noninterlaced
// 8-bit RGB/RGBA PNG format. All five standard row filters are decoded. It is
// fixture-loading code, not a replacement for the browser's image decoder.
function decodePNG(buffer) {
    assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature');
    let width, height, channels;
    const compressed = [];
    let ended = false;
    for (let offset = 8; offset + 12 <= buffer.length;) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const start = offset + 8, end = start + length;
        assert(end + 4 <= buffer.length, 'Truncated PNG chunk');
        if (type === 'IHDR') {
            assert.equal(length, 13, 'PNG IHDR length');
            width = buffer.readUInt32BE(start);
            height = buffer.readUInt32BE(start + 4);
            assert.equal(buffer[start + 8], 8, 'Only 8-bit PNG fixtures are supported');
            const colorType = buffer[start + 9];
            assert(colorType === 2 || colorType === 6, 'Only RGB/RGBA PNG fixtures are supported');
            channels = colorType === 2 ? 3 : 4;
            assert.equal(buffer[start + 10], 0, 'PNG compression method');
            assert.equal(buffer[start + 11], 0, 'PNG filter method');
            assert.equal(buffer[start + 12], 0, 'Interlaced PNG fixtures are unsupported');
        } else if (type === 'IDAT') compressed.push(buffer.subarray(start, end));
        else if (type === 'IEND') { ended = true; break; }
        offset = end + 4;
    }
    assert(ended && width > 0 && height > 0 && channels && compressed.length, 'Complete PNG image');
    const stride = width * channels;
    const filtered = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
    assert.equal(filtered.length, (stride + 1) * height, 'PNG scanline length');
    const rgb = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => {
        const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
        return da <= db && da <= dc ? a : db <= dc ? b : c;
    };
    for (let y = 0; y < height; y++) {
        const filter = filtered[y * (stride + 1)];
        assert(filter <= 4, 'PNG row filter');
        for (let x = 0; x < stride; x++) {
            const at = y * stride + x;
            const left = x >= channels ? rgb[at - channels] : 0;
            const up = y ? rgb[at - stride] : 0;
            const upperLeft = y && x >= channels ? rgb[at - stride - channels] : 0;
            const prediction = filter === 1 ? left : filter === 2 ? up : filter === 3
                ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
            rgb[at] = (filtered[y * (stride + 1) + x + 1] + prediction) & 255;
        }
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        const input = pixel * channels, output = pixel * 4;
        data[output] = rgb[input]; data[output + 1] = rgb[input + 1]; data[output + 2] = rgb[input + 2];
        data[output + 3] = channels === 4 ? rgb[input + 3] : 255;
    }
    return { width, height, data };
}


module.exports = { decodePNG };
