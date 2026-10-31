/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { makeSharedBoundaryArtwork } from "./shared-boundary-artwork.js";
import { sharedBoundaryModel } from "./shared-boundary-model.js";

const { createTracer } = createRequire(import.meta.url)("../tracer.js");
const edges = [false, true].map((present) => ({ present, ...makeSharedBoundaryArtwork({ present }) }));
const junctions = [false, true].map((present) => ({ present, ...makeSharedBoundaryArtwork({ kind: "junction", present }) }));
const hexRGB = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

function isolatedProposal(artwork, data = artwork.image.data) {
    const labels = new Int16Array(artwork.sourceLabels);
    for (const pixel of artwork.targetPixels) labels[pixel] = 2;
    return sharedBoundaryModel({ ...artwork.image, data, labels, palette: artwork.paints, noise: 10 });
}

function nominalPaint(rgb, paints) {
    const distances = paints.map((paint) => paint.reduce((sum, value, channel) => sum + (value - rgb[channel]) ** 2, 0));
    return distances.indexOf(Math.min(...distances));
}

test.each(edges)("with known surrounding ownership, shared prediction distinguishes the real mark (present=$present)", (artwork) => {
    const model = isolatedProposal(artwork);
    const expected = new Int16Array(artwork.sourceLabels);
    // The target mask includes equal coverage; retain its genuine C proposal at ties.
    if (artwork.present) for (const pixel of artwork.targetPixels) expected[pixel] = 2;

    const wrong = Array.from(model.labels).filter((color, pixel) => color !== expected[pixel]);
    expect(wrong.length).toBe(0);
    expect(model.proposals.some((proposal) => proposal.accepted)).toBe(!artwork.present);
});

test("changing withheld RGB does not change the shared prediction", () => {
    const artwork = edges[0];
    const initial = isolatedProposal(artwork).proposals.find((proposal) => proposal.accepted);
    expect(initial).toBeDefined();
    const data = new Uint8ClampedArray(artwork.image.data);
    for (const pixel of artwork.targetPixels) data.set([0, 0, 0], pixel * 4);
    const repeated = isolatedProposal(artwork, data).proposals.find((proposal) => proposal.id === initial.id);
    expect(repeated.predictions).toEqual(initial.predictions);
});

test.each(junctions)("a three-paint junction retains its proposed component (present=$present)", (artwork) => {
    const model = isolatedProposal(artwork);
    expect(model.proposals.some((proposal) => proposal.accepted)).toBe(false);
    expect(artwork.targetPixels.every((pixel) => model.labels[pixel] === 2)).toBe(true);
});

test.each(edges)("baseline proposals correct only false bleed ownership (present=$present)", (artwork) => {
    const baseline = createTracer().trace(artwork.image, { colors: 3, noise: 10, minArea: 0, debug: true });
    const labels = baseline.debug.labels;
    const palette = baseline.stats.palette.map(hexRGB);
    const paint = labels[artwork.swatchPixel];
    const model = sharedBoundaryModel({ ...artwork.image, labels, palette, noise: 10 }, { robust: true });
    const changed = Array.from(model.labels).flatMap((color, pixel) => (color === labels[pixel] ? [] : [{ color, pixel }]));
    const incorrect = changed.filter(({ color, pixel }) => nominalPaint(palette[color], artwork.paints) !== artwork.sourceLabels[pixel]);
    expect(incorrect.length).toBe(0);
    expect(model.labels[artwork.swatchPixel]).toBe(paint);
    if (artwork.present) {
        expect(artwork.targetPixels.every((pixel) => labels[pixel] === paint)).toBe(true);
        expect(artwork.targetPixels.every((pixel) => model.labels[pixel] === paint)).toBe(true);
        return;
    }
    expect(changed.length).toBeGreaterThan(0);
    const before = artwork.boundaryPixels.filter((pixel) => labels[pixel] === paint && artwork.coverage[2][pixel] === 0).length;
    const after = artwork.boundaryPixels.filter((pixel) => model.labels[pixel] === paint && artwork.coverage[2][pixel] === 0).length;
    expect(after).toBeLessThan(before);
});
