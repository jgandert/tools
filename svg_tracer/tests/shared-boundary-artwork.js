/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Original geometry and a two-dimensional chroma filter provide controls
// independent of the boundary predictor's geometry and profile fitting code.
export function makeSharedBoundaryArtwork({
                                              kind = "edge",
                                              present = false,
                                              corrupted = true,
                                          } = {}) {
    if (!["edge", "junction"].includes(kind)) throw Error("Unknown shared-boundary control kind.");

    const width = 160;
    const height = 160;
    const scale = 16;
    const samplesPerPixel = scale * scale;
    const sigma = 1.2;
    const radius = 4;
    const paints = [
        [221, 30, 35],
        [255, 255, 255],
        [186, 33, 35],
        [30, 70, 170],
    ];
    const luminanceWeights = [0.299, 0.587, 0.114];
    const count = width * height;
    const pristineData = new Uint8ClampedArray(count * 4);
    const data = new Uint8ClampedArray(count * 4);
    const coverage = paints.map(() => new Float32Array(count));
    const markCoverage = new Float32Array(count);
    const sourceLabels = new Uint8Array(count);
    const targetPixels = [];
    const boundaryPixels = [];
    const boundary = (y) => 80.25 + (y - 80) ** 2 / 400;
    const slope = (y) => (y - 80) / 200;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const masses = [0, 0, 0, 0];
            let markMass = 0;
            for (let sy = 0; sy < scale; sy++) {
                const yy = y + (sy + 0.5) / scale;
                const edge = boundary(yy);
                const normalScale = Math.hypot(1, slope(yy));
                for (let sx = 0; sx < scale; sx++) {
                    const xx = x + (sx + 0.5) / scale;
                    const distance = (xx - edge) / normalScale;
                    const mark = yy >= 68 && yy < 80 && distance >= -0.9 && distance < -0.15;
                    if (mark) markMass++;

                    let paint = xx < edge ? 0 : 1;
                    if (kind === "junction" && yy >= 80 && xx >= edge - 14) paint = 3;
                    if (present && mark) paint = 2;
                    if (xx >= 12 && xx < 28 && yy >= 12 && yy < 28) paint = 2;
                    masses[paint]++;
                }
            }

            for (let paint = 0; paint < paints.length; paint++) coverage[paint][pixel] = masses[paint] / samplesPerPixel;
            sourceLabels[pixel] = masses.indexOf(Math.max(...masses));
            markCoverage[pixel] = markMass / samplesPerPixel;
            if (markMass >= samplesPerPixel / 2) targetPixels.push(pixel);
            if (Math.abs(x + 0.5 - boundary(y + 0.5)) < 4 && y >= 24 && y < 136) boundaryPixels.push(pixel);
            for (let channel = 0; channel < 3; channel++) {
                pristineData[pixel * 4 + channel] = Math.round(
                    paints.reduce((sum, paint, index) => sum + paint[channel] * masses[index], 0) / samplesPerPixel,
                );
            }
            pristineData[pixel * 4 + 3] = 255;
        }
    }

    if (!corrupted) data.set(pristineData);
    else {
        const luminance = new Float64Array(count);
        const chroma = new Float64Array(count * 3);
        for (let pixel = 0; pixel < count; pixel++) {
            luminance[pixel] = luminanceWeights.reduce((sum, weight, channel) => sum + weight * pristineData[pixel * 4 + channel], 0);
            for (let channel = 0; channel < 3; channel++)
                chroma[pixel * 3 + channel] = pristineData[pixel * 4 + channel] - luminance[pixel];
        }

        const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-((index - radius) ** 2) / (2 * sigma ** 2)));
        const mass = kernel.reduce((sum, value) => sum + value, 0);
        for (let index = 0; index < kernel.length; index++) kernel[index] /= mass;
        const horizontal = new Float64Array(chroma.length);
        const blurred = new Float64Array(chroma.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = y * width + x;
                for (let offset = -radius; offset <= radius; offset++) {
                    const neighbor = y * width + Math.max(0, Math.min(width - 1, x + offset));
                    for (let channel = 0; channel < 3; channel++)
                        horizontal[pixel * 3 + channel] += kernel[offset + radius] * chroma[neighbor * 3 + channel];
                }
            }
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = y * width + x;
                for (let offset = -radius; offset <= radius; offset++) {
                    const neighbor = Math.max(0, Math.min(height - 1, y + offset)) * width + x;
                    for (let channel = 0; channel < 3; channel++)
                        blurred[pixel * 3 + channel] += kernel[offset + radius] * horizontal[neighbor * 3 + channel];
                }
                for (let channel = 0; channel < 3; channel++)
                    data[pixel * 4 + channel] = Math.round(luminance[pixel] + blurred[pixel * 3 + channel]);
                data[pixel * 4 + 3] = 255;
            }
        }
    }

    return {
        image: { width, height, data },
        pristine: { width, height, data: pristineData },
        paints,
        sourceLabels,
        coverage,
        markCoverage,
        targetPixels,
        boundaryPixels,
        swatchPixel: 20 * width + 20,
        metadata: {
            sourceKind: `original-quadratic-${kind}-${present ? "mark" : "blank"}`,
            ownership:
                "16x16 square-pixel integration before corruption; ties in sourceLabels choose the first paint; coverage retains all fractions",
            geometry: {
                width,
                height,
                scale,
                boundary: "x=80.25+(y-80)^2/400",
                markY: [68, 80],
                markNormalInterval: [-0.9, -0.15],
                swatch: [12, 12, 28, 28],
                junction: kind === "junction" ? "paint D where y>=80 and x>=boundary(y)-14" : null,
            },
            corruption: corrupted
                ? {
                    kind: "separable-two-dimensional-Gaussian-chroma-blur",
                    sigma,
                    radius,
                    luminanceWeights,
                    boundaryMode: "clamp",
                    reconstruction: "original Y plus blurred (RGB-Y), rounded and clipped to byte RGB",
                }
                : { kind: "none" },
            limitations:
                "A deterministic chroma-bleed control, not a JPEG emulator. Clipping can change reconstructed luminance. The narrow mark uses the local tangent-normal distance approximation to the quadratic. Paired targetPixels describe the same authored mark footprint even in the blank source. Acceptance of an artificially supplied proposal does not establish end-to-end detection.",
        },
    };
}
