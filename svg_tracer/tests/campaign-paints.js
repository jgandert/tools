/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Original vector geometry is integrated over 8x8 square samples, then passed
// through a separable resampling kernel. The pale slit is background, never a
// third paint. This reproduces a denoiser-created plateau without reference art.
export function resampledSlit({phase = 0, blur = .08, transpose = false} = {}) {
    const width = 96;
    const height = 96;
    const background = [253, 252, 246];
    const foreground = [20, 41, 77];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let coverage = 0;
            for (let sy = 0; sy < 8; sy++) {
                for (let sx = 0; sx < 8; sx++) {
                    const xx = x + (sx + .5) / 8;
                    const yy = y + (sy + .5) / 8;
                    const offset = xx - (48 + phase + .025 * (yy - 48));
                    if (xx >= 10 && xx < 86 && yy >= 10 && yy < 86 && Math.abs(offset) > 2.75 / 2) coverage++;
                }
            }
            const pixel = 4 * (y * width + x);
            for (let channel = 0; channel < 3; channel++) {
                data[pixel + channel] = Math.round(background[channel] + coverage / 64 * (foreground[channel] - background[channel]));
            }
            data[pixel + 3] = 255;
        }
    }
    const filtered = new Uint8ClampedArray(data);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let channel = 0; channel < 3; channel++) {
                const pixel = 4 * (y * width + x) + channel;
                filtered[pixel] = Math.round(data[pixel] * (1 - 2 * blur) + blur * (data[pixel - 4] + data[pixel + 4]));
            }
        }
    }
    if (!transpose) return {width, height, data: filtered};
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            data.set(filtered.subarray(4 * (y * width + x), 4 * (y * width + x + 1)), 4 * (x * height + y));
        }
    }
    return {width: height, height: width, data};
}

// The accent is exactly a mixture of both large paints, so a generic mixture
// rejection would erase it. Independent channel noise defeats strict 3x3-core
// corroboration while preserving the intended paint's mean and ownership.
export function noisyMidpointAccent({size = 4, jitter = 8, position = 16} = {}) {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    let seed = 123456;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let rgb = x < 32 ? [20, 50, 90] : [210, 150, 40];
            if (Math.abs(x - position + .5) < size / 2 && Math.abs(y - 32 + .5) < size / 2) {
                rgb = [115, 100, 65].map(value => {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    return value + Math.round((seed / 2 ** 32 * 2 - 1) * jitter);
                });
            }
            data.set([...rgb, 255], 4 * (y * width + x));
        }
    }
    return {width, height, data};
}

// Two-pixel correlated columns can support several noisy palette modes.
// Removing one mode must not move the independently known split at x=32.
export function correlatedColumnAccent({diamond = false, offMixture = false} = {}) {
    const width = 64;
    const height = 64;
    const paints = [[24, 48, 84], [204, 158, 64], offMixture ? [114, 119, 110] : [114, 103, 74]];
    const data = new Uint8ClampedArray(width * height * 4);
    const owners = new Uint8Array(width * height);
    for (let x = 0; x < width; x++) {
        const column = Math.floor((x + 1) / 2);
        let hash = Math.imul(column + 1, 0x45d9f3b) ^ Math.imul(1, 0x119de1f3) ^ 31;
        hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
        hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
        hash ^= hash >>> 16;
        const jitter = Math.round(((hash >>> 0) / 4294967296 * 2 - 1) * 32);
        for (let y = 0; y < height; y++) {
            const accent = diamond ? Math.abs(x - 16) + Math.abs(y - 32) <= 2 : Math.abs(x - 16) < 2 && Math.abs(y - 32) < 2;
            const owner = accent ? 2 : x < 32 ? 0 : 1;
            const pixel = y * width + x;
            owners[pixel] = owner;
            data.set([...paints[owner].map(value => Math.max(0, Math.min(255, value + jitter))), 255], 4 * pixel);
        }
    }
    return {image: {width, height, data}, owners, paints};
}
