// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0

// Runs in the browser. Compare the exported SVG, including renderer seams,
// against the decoded input. Edge and junction scores exclude flat interiors.
export async function measureOutlinedTrace({ artwork, result }) {
    const { width, height, data, junctions = [] } = artwork;
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(result.svg)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const actual = ctx.getImageData(0, 0, width, height).data;
    const premultiplied = (pixels, p, c) => c === 3 ? pixels[p + 3] : pixels[p + c] * pixels[p + 3] / 255;
    let total = 0;
    let displayError = 0;
    let darkBackgroundError = 0;
    let edges = 0;
    let edgePixels = 0;
    let junctionError = 0;
    let junctionPixels = 0;
    let missingOutline = 0;
    let outlinePixels = 0;
    let outlineMass = 0;
    let expectedOutlineMass = 0;
    const junctionMetrics = junctions.map(() => ({
        mass: 0,
        expectedMass: 0,
        dark: 0,
        missing: 0,
    }));
    const [dark, ...fills] = artwork.paints;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            let error = 0;
            for (let c = 0; c < 4; c++) {
                error += Math.abs(premultiplied(actual, p, c) - premultiplied(data, p, c));
                if (c < 3) {
                    const difference = premultiplied(actual, p, c) - premultiplied(data, p, c);
                    const alphaDifference = (data[p + 3] - actual[p + 3]) / 255;
                    displayError += Math.abs(difference + 255 * alphaDifference);
                    darkBackgroundError += Math.abs(difference + 32 * alphaDifference);
                }
            }
            total += error;
            // Recover dark-paint weight from the closest dark/fill RGB segment.
            // The generator supplies an independent visible-stroke mask, so a
            // uniformly thinned outline cannot pass just by staying connected.
            const color = [0, 1, 2].map(c => actual[p + c] * actual[p + 3] / 255 + 255 - actual[p + 3]);
            let bestResidual = Infinity;
            let darkWeight = 0;
            for (const fill of fills) {
                const direction = dark.map((v, c) => v - fill[c]);
                const denominator = direction.reduce((sum, v) => sum + v * v, 0);
                const weight = Math.max(0, Math.min(1, color.reduce((sum, v, c) => sum + (v - fill[c]) * direction[c], 0) / denominator));
                const residual = color.reduce((sum, v, c) => sum + (v - fill[c] - weight * direction[c]) ** 2, 0);
                if (residual < bestResidual) {
                    bestResidual = residual;
                    darkWeight = weight;
                }
            }
            outlineMass += darkWeight;
            expectedOutlineMass += artwork.outlineCoverage[y * width + x] / 255;
            let edge = false;
            for (let dy = -1; dy <= 1 && !edge; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) {
                        continue;
                    }
                    const q = ((y + dy) * width + x + dx) * 4;
                    for (let c = 0; c < 4; c++) {
                        if (Math.abs(premultiplied(data, p, c) - premultiplied(data, q, c)) > 24) {
                            edge = true;
                        }
                    }
                }
            }
            if (edge) {
                edges += error;
                edgePixels++;
            }
            const nearbyJunctions = [];
            for (let i = 0; i < junctions.length; i++) {
                const j = junctions[i];
                if ((x + .5 - j.x) ** 2 + (y + .5 - j.y) ** 2 > 36) {
                    continue;
                }
                nearbyJunctions.push(i);
                junctionMetrics[i].mass += darkWeight;
                junctionMetrics[i].expectedMass += artwork.outlineCoverage[y * width + x] / 255;
            }
            if (nearbyJunctions.length) {
                junctionError += error;
                junctionPixels++;
            }
            // A fully covered dark outline must have dark output nearby. Allow
            // a one-pixel reconstruction shift, but catch erased or broken joins.
            if (data[p + 3] > 240 && Math.max(data[p], data[p + 1], data[p + 2]) < 55) {
                outlinePixels++;
                let found = false;
                for (let dy = -1; dy <= 1 && !found; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) {
                            continue;
                        }
                        const q = ((y + dy) * width + x + dx) * 4;
                        if (actual[q + 3] > 180 && Math.max(actual[q], actual[q + 1], actual[q + 2]) < 100) {
                            found = true;
                        }
                    }
                }
                if (!found) {
                    missingOutline++;
                }
                for (const i of nearbyJunctions) {
                    junctionMetrics[i].dark++;
                    if (!found) {
                        junctionMetrics[i].missing++;
                    }
                }
            }
        }
    }
    const gapPoints = artwork.gapPoints || [];
    const retainedGapPoints = gapPoints.filter(({ x, y }) => {
        const p = (Math.floor(y) * width + Math.floor(x)) * 4;
        // Require a bright separator even on black. Antialias alpha seams can
        // reduce opacity without closing the visible gap between dark shapes.
        return Math.min(actual[p], actual[p + 1], actual[p + 2]) * actual[p + 3] / 255 > 180;
    }).length;
    return {
        error: total / (width * height * 4),
        displayError: displayError / (width * height * 3),
        darkBackgroundError: darkBackgroundError / (width * height * 3),
        edgeError: edges / (edgePixels * 4),
        junctionError: junctionPixels ? junctionError / (junctionPixels * 4) : 0,
        missingOutline: outlinePixels ? missingOutline / outlinePixels : 0,
        edgePixels,
        junctionPixels,
        outlinePixels,
        outlineMassError: Math.abs(outlineMass - expectedOutlineMass) / expectedOutlineMass,
        worstJunctionMissingOutline: Math.max(0, ...junctionMetrics.filter(j => j.dark).map(j => j.missing / j.dark)),
        worstJunctionMassError: Math.max(0, ...junctionMetrics.filter(j => j.expectedMass > 5).map(j => Math.abs(j.mass - j.expectedMass) / j.expectedMass)),
        gapPoints: gapPoints.length,
        gapRetention: gapPoints.length ? retainedGapPoints / gapPoints.length : 1,
    };
}
