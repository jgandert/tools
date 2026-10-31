/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { makeSeedlessPaintArtwork } from "./seedless-paints.js";

const { createTracer } = createRequire(import.meta.url)("../tracer.js");
const artworks = ["branched", "disconnected"].map(kind => ({ kind, ...makeSeedlessPaintArtwork({ kind }) }));

test.each(artworks.flatMap(artwork => [0, 3].map(colors => ({ ...artwork, colors }))))(
    "local mixed pixels retain the real $kind paint (colors=$colors)", ({
                                                                            image,
                                                                            targetPixels,
                                                                            swatchPixel,
                                                                            paints,
                                                                            colors,
                                                                        }) => {
        const result = createTracer().trace(image, { noise: 10, colors, minArea: 0, debug: true });
        const paintLabel = result.debug.labels[swatchPixel];
        const rgb = [1, 3, 5].map(offset => parseInt(result.stats.palette[paintLabel].slice(offset, offset + 2), 16));
        expect(Math.hypot(...rgb.map((value, channel) => value - paints[2][channel]))).toBeLessThan(8);
        expect(targetPixels.filter(pixel => result.debug.labels[pixel] === paintLabel).length).toBeGreaterThan(targetPixels.length / 2);
        expect(result.stats.fallbackChains).toBe(0);
    });
