/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { expect, test } from "bun:test";
import { createSpiralDiagnostics } from "./spiral-diagnostics.js";
import { createDarkBoundaryDiagnostics } from "./dark-boundary-diagnostics.js";
import { summarizeNormals } from "./dark-boundary-summary.js";

const diagnostics = createDarkBoundaryDiagnostics(createSpiralDiagnostics());
const origin = { x: 0, y: 0 };
const normal = { x: 1, y: 0 };

test("palette correspondence rejects remote shades and prevents duplicate identities", () => {
    expect(diagnostics.matchPalette(["#151513", "#1d1c1b"], ["#151513", "#734320"])).toEqual([0, -2]);
    expect(diagnostics.matchPalette(["#151513", "#1d1c1b"], ["#161614", "#1c1c1b"])).toEqual([0, 1]);
    expect(diagnostics.matchPalette(["#151513"], ["#151513", "#161614"])).toEqual([0, -2]);
});

test("local transition queries retain short paint runs and signed crossings", () => {
    const ownerAt = x => x < -.2 ? 1 : x < .21 ? 0 : 2;
    const hits = diagnostics.transitions(ownerAt, origin, normal);
    expect(hits.map(hit => [hit.from, hit.to])).toEqual([[1, 0], [0, 2]]);
    expect(hits[0].at).toBeCloseTo(-.2, 5);
    expect(hits[1].at).toBeCloseTo(.21, 5);
    const reverse = diagnostics.transitions(ownerAt, origin, { x: -1, y: 0 });
    expect(reverse.map(hit => [hit.from, hit.to])).toEqual([[2, 0], [0, 1]]);
});

test("finite owner sampling does not claim to resolve every substep strip", () => {
    const hits = diagnostics.transitions(x => x > .001 && x < .003 ? 1 : 0, origin, normal);
    expect(hits).toEqual([]);
});

test("normal summary does not replace a lost interface with a wrong-paint stripe", () => {
    const row = {
        origin, source: [{ at: 0, from: 1, to: 2 }],
        samples: [{ at: -.3, paints: [1, 3] }, { at: .7, paints: [3, 2] }],
    };
    const summary = summarizeNormals([row]);
    expect(summary.samples).toEqual({
        matched: 0,
        missing: 1,
        extra: 2,
        meanPx: null,
        maxPx: null,
    });
});

test("face interval correspondence distinguishes shifted from absent separator", () => {
    const row = {
        origin, source: [{ at: 0, from: 1, to: 0 }, { at: .4, from: 0, to: 2 }],
        samples: [], flat: [], gapCoverage: { samples: [{ entry: .1, exit: .5 }], flat: [] },
    };
    const summary = summarizeNormals([row]);
    expect(summary.separator.samples.missingLocal).toBe(0);
    expect(summary.separator.flat.missingLocal).toBe(1);
    expect(summary.separator.flat.widestLostPx).toBeCloseTo(.4);
});

test("paper correspondence survives an unexpected paint fragment before the gap", () => {
    const paper = [{ x: .3, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: .3, y: 1 }, {
        x: .3,
        y: -1,
    }];
    const debug = {
        faces: [{ id: 0, color: 0 }],
        loops: [[[0]]],
        chains: [{ raw: paper, samples: paper, flat: paper }],
    };
    const source = [{ at: 0, from: 1, to: 0 }, { at: .8, from: 0, to: 2 }];
    const coverage = diagnostics.separatorCoverage(debug, origin, normal, source, x => x < 0 ? 1 : x < .3 ? 2 : x < 1 ? 0 : 2);
    expect(coverage.labels).toHaveLength(1);
    expect(coverage.flat).toEqual([{ entry: .3, exit: 1, component: 0 }]);
    expect(coverage.labels[0].entry).toBeCloseTo(.3, 5);
});

test("shared endpoint inspection detects fit separation without assuming lattice position", () => {
    const chains = [0, 1, 2].map(id => ({
        id,
        raw: [origin, { x: id + 1, y: 2 }],
        samples: [{ x: .2, y: .3 }, { x: id + 1, y: 2 }],
        flat: [{ x: .2 + (id === 2 ? .1 : 0), y: .3 }, { x: id + 1, y: 2 }],
    }));
    const [group] = diagnostics.endpointGroups({ chains });
    expect(group.ends).toHaveLength(3);
    expect(group.spread).toBeCloseTo(.1);
    chains[2].flat[0].x = .2;
    expect(diagnostics.endpointGroups({ chains })[0].spread).toBe(0);
});

test("component source evidence retains partial alpha separately from label ownership", () => {
    const input = {
        width: 3,
        height: 1,
        data: new Uint8ClampedArray([10, 120, 130, 255, 13, 132, 130, 120, 10, 120, 130, 255]),
    };
    const cs = diagnostics.components({ labels: [0, -1, 0], componentIds: [0, 1, 0] }, input);
    expect(cs[1].paint).toBe(-1);
    expect(cs[1].mean[3]).toBe(120);
    expect(cs[1].box).toEqual({ minX: 1, minY: 0, maxX: 2, maxY: 1 });
    expect(cs[0].count).toBe(2);
});
