/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// The remote swatch establishes a real paint, while subpixel local marks
// supply mixed RGB evidence. These are authored features, not codec fringes.
export function makeSeedlessPaintArtwork({ kind = "branched", present = true } = {}) {
    const width = 96;
    const height = 96;
    const scale = 16;
    const paints = [[20, 50, 90], [210, 150, 40], [124, 122, 110]];
    const data = new Uint8ClampedArray(width * height * 4);
    const targetPixels = [];

    const onDiagonal = (x, y) => {
        const t = Math.max(0, Math.min(1, ((x - 47.5) * -8 + (y - 57.5) * 8) / 128));
        return Math.hypot(x - 47.5 + t * 8, y - 57.5 - t * 8) < .375;
    };
    const inMark = (x, y) => {
        if (kind === "branched") {
            return x >= 47.125 && x < 47.875 && y >= 24 && y < 76
                || x >= 36 && x < 47.875 && y >= 47.125 && y < 47.875
                || onDiagonal(x, y);
        }
        return x >= 47.125 && x < 47.875
            && (y >= 25 && y < 33 || y >= 49 && y < 57 || y >= 72 && y < 80);
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sum = [0, 0, 0];
            let coverage = 0;
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const xx = x + (dx + .5) / scale;
                    const yy = y + (dy + .5) / scale;
                    const mark = inMark(xx, yy);
                    if (mark) coverage++;

                    const swatch = xx >= 8 && xx < 24 && yy >= 6 && yy < 16;
                    const paint = swatch || present && mark ? paints[2] : paints[xx < 48 ? 0 : 1];
                    for (let channel = 0; channel < 3; channel++) sum[channel] += paint[channel];
                }
            }
            const pixel = y * width + x;
            for (let channel = 0; channel < 3; channel++) data[4 * pixel + channel] = Math.round(sum[channel] / scale ** 2);
            data[4 * pixel + 3] = 255;
            if (coverage >= scale ** 2 * .5) targetPixels.push(pixel);
        }
    }
    return { image: { width, height, data }, targetPixels, swatchPixel: 10 * width + 16, paints };
}
