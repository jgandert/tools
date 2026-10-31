/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { createSpiralDiagnostics } from "./spiral-diagnostics.js";

const diagnostics = createSpiralDiagnostics();

export function makeGuidedOpening({
                                      rotation = 0,
                                      shiftX = 0,
                                      shiftY = 0,
                                      flare = .75,
                                      gap = 2,
                                  } = {}) {
    const width = 140;
    const height = 150;
    const paints = [[248, 247, 242], [49, 130, 85], [234, 179, 103]];
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const toLocal = point => {
        const dx = point.x - 70 - shiftX;
        const dy = point.y - 75 - shiftY;
        return { x: cosine * dx + sine * dy + 70, y: -sine * dx + cosine * dy + 75 };
    };
    const openingWidth = y => gap + .14 * (y - 25) + 2 * flare * Math.max(0, 1 - Math.abs(y - 37) / 5);
    const data = new Uint8ClampedArray(width * height * 4);

    // Independent 4x4 area coverage of a U and a lower accent. The accent's
    // round end and side bump prevent its own polygon guide from locking the
    // U's junctions first; its straight sides support both junction tangents.

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const rgb = [0, 0, 0];
            for (let sy = 0; sy < 4; sy++) {
                for (let sx = 0; sx < 4; sx++) {
                    const local = toLocal({ x: x + (sx + .5) / 4, y: y + (sy + .5) / 4 });
                    const half = openingWidth(local.y) / 2;
                    const slot = Math.abs(local.x - 70) < half && local.y < 95;
                    const bump = 5 * Math.max(0, 1 - Math.abs(local.y - 125) / 8);
                    const inside = local.x >= 25 && local.x <= 115 + bump && local.y >= 25
                        && (local.y <= 125 || (local.x - 70) ** 2 / 45 ** 2 + (local.y - 125) ** 2 / 18 ** 2 <= 1)
                        && !slot;
                    const paint = paints[inside ? (local.y < 105 ? 1 : 2) : 0];
                    for (let channel = 0; channel < 3; channel++) rgb[channel] += paint[channel] / 16;
                }
            }
            data.set([...rgb, 255], (y * width + x) * 4);
        }
    }
    return { image: { width, height, data }, toLocal, openingWidth };
}

export function openingInterval(points, fixture, y) {
    const crossings = diagnostics.crossings({ x: 70, y }, {
        x: 1,
        y: 0,
    }, [points.map(fixture.toLocal)]);
    const entry = crossings.filter(value => value < 0).at(-1);
    const exit = crossings.find(value => value > 0);
    if (entry === undefined || exit === undefined) return null;
    return { entry, exit, width: exit - entry };
}
