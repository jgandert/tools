/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {createSpiralDiagnostics} from "./spiral-diagnostics.js";
import {createDarkBoundaryDiagnostics} from "./dark-boundary-diagnostics.js";
import {createValidationDiagnostics, instrumentValidationCore} from "./validation-diagnostics.js";
import {compareCampaignResults} from "./validation-summary.js";

const intersections = createSpiralDiagnostics();
const dark = createDarkBoundaryDiagnostics(intersections);
const diagnostics = createValidationDiagnostics(intersections, dark);

test("source normals turn an oblique transect into local perpendicular distance", () => {
    const normal = {x: .6, y: .8};
    const owner = (x, y) => x * normal.x + y * normal.y < 2 ? 1 : 2;
    const station = diagnostics.sourceNormal(owner, {x: 3.375, y: 0}, 1, 2, {x: 1, y: 0});
    expect(station.available).toBe(true);
    expect(station.origin.x).toBeCloseTo(2 / .6, 5);
    expect(station.normal.x).toBeCloseTo(.6, 5);
    expect(station.normal.y).toBeCloseTo(.8, 5);
    const curve = (x, y) => Math.hypot(x, y) < 10 ? 1 : 2;
    const circular = diagnostics.sourceNormal(curve, {x: 6, y: 8}, 1, 2, {x: 1, y: 0});
    expect(circular.normal.x).toBeCloseTo(.6, 4);
    expect(circular.normal.y).toBeCloseTo(.8, 4);
});

test("source normals decline a junction with a third paint", () => {
    const station = diagnostics.sourceNormal((x, y) => y > .02 ? 3 : x < 0 ? 1 : 2,
        {x: 0, y: 0}, 1, 2, {x: 1, y: 0});
    expect(station.available).toBe(false);
    expect(station.reason).toBe("Third paint at source station");
});

test("normal correspondence leaves remote and wrong-paint crossings unmatched", () => {
    const source = [{at: 0, from: 1, to: 2}];
    const remote = {at: 101.5, paints: [1, 2]};
    const stripe = {at: .03, paints: [1, 3]};
    const lost = diagnostics.localCorrespondence(source, [remote, stripe]);
    expect(lost.matches).toEqual([]);
    expect(lost.missing).toEqual(source);
    expect(lost.extra).toEqual([remote, stripe]);
    const local = diagnostics.localCorrespondence(source, [{at: .23, paints: [2, 1]}]);
    expect(local.matches[0].offset).toBeCloseTo(.23);
});

test("coverage separates minority hairline pixels from full interior evidence", () => {
    const masks = diagnostics.coverageMasks({width: 3, height: 1, paints: {paper: "#ffffff", ink: "#000000"}},
        (x, y) => x > 1.4 && x < 1.6 ? 1 : 0);
    expect(masks[1]).toEqual([]);
    const wider = diagnostics.coverageMasks({width: 3, height: 1, paints: {paper: "#ffffff", ink: "#000000"}},
        (x, y) => x > 1.2 && x < 1.8 ? 1 : 0);
    expect(wider[1]).toEqual([{pixel: 1, coverage: .5}]);
});

test("study instrumentation preserves actual pixels, paths, stats and fallback decisions", () => {
    const core = readFileSync(new URL("../tracer.js", import.meta.url), "utf8");
    const baseline = new Function(`${core}\nreturn createTracer();`)();
    const diagnostic = new Function(`${instrumentValidationCore(core)}\nreturn createTracer();`)();
    for (const transparent of [false, true]) {
        const width = 42;
        const height = 36;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const inMark = Math.abs(Math.hypot(x - 21, y - 18) - 10) < 2;
            data.set(inMark ? [31, 48, 61, 255] : transparent ? [0, 0, 0, 0] : [237, 225, 207, 255], 4 * pixel);
        }
        const input = {width, height, data};
        const options = {colors: 2, noise: 20, minArea: 0, debug: true};
        const before = baseline.trace(input, options);
        const after = diagnostic.trace(input, options);
        expect(after.svg).toBe(before.svg);
        expect(after.debug).toEqual(before.debug);
        const withoutTime = ({ms, ...stats}) => stats;
        expect(withoutTime(after.stats)).toEqual(withoutTime(before.stats));
        expect(globalThis.validationStages.initialPalette.length).toBeGreaterThan(0);
        expect(globalThis.validationStages.nearestLabels).toHaveLength(width * height);
    }
});

test("round3 explicit40 native midpoint survives its operational global reassignment", () => {
    const intended = ["#f5eedf", "#625033", "#bd984e", "#c49f55", "#3c786f", "#8f7441", "#927c69"];
    const palette = ["#f5eedf", "#625033", "#bd984e", "#3c786f", "#8f7541", "#b5924c", "#79623a"];
    const mapping = dark.matchPalette(intended, palette);
    expect(mapping[4]).toBe(6);
    expect(mapping[6]).toBe(5);
    const native = diagnostics.probeOwnership(4, mapping, palette, [143, 116, 65]);
    expect(native.nativeRGB).toEqual([143, 117, 65]);
    expect(native.distanceFromIntendedRGB).toBe(1);
    expect(native.operationalOwner).toBe(6);
});

test("analytic all-face crossings and midpoint ownership retain a substep gap", () => {
    const rectangle = (x1, x2) => [{x: x1, y: -1}, {x: x2, y: -1}, {x: x2, y: 1}, {x: x1, y: 1}, {x: x1, y: -1}];
    const gap = rectangle(.001, .003);
    const left = rectangle(-10, .001);
    const right = rectangle(.003, 10);
    const debug = {faces: [{id: 0, color: 0}, {id: 1, color: 1}, {id: 2, color: 2}], loops: [[[0]], [[2]], [[4]]],
        chains: [gap, left, right].map((points, id) => ({id, right: id, left: -1, flat: points}))};
    const hits = diagnostics.stageCrossings(debug, [0, 1, 2], {x: 0, y: 0}, {x: 1, y: 0}, "flat");
    expect(hits.some(hit => hit.at === .001 && hit.from === 1 && hit.to === 0)).toBe(true);
    expect(hits.some(hit => hit.at === .003 && hit.from === 0 && hit.to === 2)).toBe(true);
    expect(dark.transitions(x => x < .001 ? 1 : x < .003 ? 0 : 2, {x: 0, y: 0}, {x: 1, y: 0})
        .some(hit => hit.from === 1 && hit.to === 0)).toBe(false);
});


test("paired campaign verification ignores timing and optional artifacts but catches changed evidence", () => {
    const baseline = {metadata: {coreSHA256: "core", fixtureSHA256: "source"}, results: [{fixtureId: "shape", noise: 20, colorMode: "auto", stats: {ms: 5, colors: 3}, palette: ["#123456"], cropFiles: ["original.png"]}]};
    const diagnostic = structuredClone(baseline);
    diagnostic.results[0].stats.ms = 10;
    diagnostic.results[0].diagnostics = {stages: []};
    delete diagnostic.results[0].cropFiles;
    expect(compareCampaignResults(baseline, diagnostic)).toEqual({compared: 1, changed: []});
    diagnostic.results[0].palette = ["#654321"];
    expect(compareCampaignResults(baseline, diagnostic).changed).toEqual(["shape/20/auto"]);
});
