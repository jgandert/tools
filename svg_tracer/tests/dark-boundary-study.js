/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { getCampaignRound } from "./campaign-artwork.js";
import { createSpiralDiagnostics } from "./spiral-diagnostics.js";
import { createDarkBoundaryDiagnostics } from "./dark-boundary-diagnostics.js";
import { runDarkBoundaryControls } from "./dark-boundary-controls.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out-dir") throw Error("Usage: bun tests/dark-boundary-study.js --out-dir UNUSED_DIR");
const out = resolve(args[1]);
try {
    await stat(out);
    throw Error(`Output already exists: ${out}`);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
await mkdir(out, { recursive: true });
const core = await readFile(resolve(import.meta.dir, "../tracer.js"), "utf8");
const sources = await Promise.all(["mechanical", "night", "transparent"].map(async name => ({
    name,
    base64: (await readFile(resolve(import.meta.dir, `fixtures/generated-${name}.png`))).toString("base64"),
})));
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: `${core}\nwindow.tracer = createTracer(); window.intersections = (${createSpiralDiagnostics})(); window.diagnostics = (${createDarkBoundaryDiagnostics})(window.intersections); window.controls = (${runDarkBoundaryControls});` });
    const result = await page.evaluate(async ({ sources, fixtures }) => {
        const {
            bounds,
            matchPalette,
            transitions,
            chainHits,
            separatorCoverage,
            endpointGroups,
            components,
        } = window.diagnostics;
        const canvasOf = (width, height) => Object.assign(document.createElement("canvas"), {
            width,
            height,
        });
        const decode = async source => {
            const image = new Image();
            image.src = source;
            await image.decode();
            return image;
        };
        const records = [];
        const crops = {};
        for (const source of sources) {
            const image = await decode(`data:image/png;base64,${source.base64}`);
            const ratio = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = canvasOf(Math.round(image.naturalWidth * ratio), Math.round(image.naturalHeight * ratio));
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.imageSmoothingQuality = "high";
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const input = context.getImageData(0, 0, canvas.width, canvas.height);
            let noise10Labels;
            for (const noise of [0, 10, 20, 40]) {
                const traced = window.tracer.trace(input, {
                    noise,
                    colors: 0,
                    tolerance: 1.25,
                    minArea: 6,
                    removeBackground: false,
                    debug: true,
                });
                const cs = components(traced.debug, input);
                const exact = traced.debug.chains.filter(c => c.exact);
                const selected = source.name === "night" ? cs.filter(c => c.count < 150) : [];
                const record = {
                    source: source.name,
                    noise,
                    width: input.width,
                    height: input.height,
                    palette: traced.stats.palette,
                    regions: traced.stats.regions,
                    components: cs.map(c => ({
                        ...c,
                        pixels: c.count <= 48 ? c.pixels : undefined,
                    })),
                    exact: exact.map(chain => ({
                        ...chain,
                        box: bounds(chain.raw),
                        faces: [chain.left, chain.right].map(id => id < 0 ? null : cs.find(c => c.id === id)),
                    })),
                    junctions: endpointGroups(traced.debug).filter(group => exact.some(c => [c.raw[0], c.raw.at(-1)].some(p => p.x === group.raw.x && p.y === group.raw.y))),
                };
                if (noise === 10) noise10Labels = traced.debug.labels;
                if (noise === 40) {
                    const overlaps = new Map();
                    for (let p = 0; p < input.width * input.height; p++) {
                        const id = traced.debug.componentIds[p];
                        if (noise10Labels[p] !== traced.debug.labels[p]) continue;
                        overlaps.set(id, (overlaps.get(id) || 0) + 1);
                    }
                    for (const component of record.components) component.samePaintNoise10Pixels = overlaps.get(component.id) || 0;
                }
                record.exactNeighborhoods = exact.map(chain => {
                    const box = bounds(chain.raw);
                    const rows = [];
                    for (let y = Math.max(0, Math.floor(box.minY) - 2); y < Math.min(input.height, Math.ceil(box.maxY) + 2); y++) {
                        const values = [];
                        for (let x = Math.max(0, Math.floor(box.minX) - 2); x < Math.min(input.width, Math.ceil(box.maxX) + 2); x++) {
                            const p = y * input.width + x;
                            values.push({
                                x,
                                rgba: Array.from(input.data.slice(4 * p, 4 * p + 4)),
                                label: traced.debug.labels[p],
                                component: traced.debug.componentIds[p],
                            });
                        }
                        rows.push({ y, values });
                    }
                    return { chain: chain.id, rows };
                });
                const svgImage = await decode(`data:image/svg+xml;base64,${btoa(traced.svg)}`);
                const tracedCanvas = canvasOf(input.width, input.height);
                tracedCanvas.getContext("2d").drawImage(svgImage, 0, 0);
                const regions = exact.map(c => ({
                    id: `chain-${c.id}`,
                    box: bounds(c.raw),
                })).concat(selected.map(c => ({ id: `component-${c.id}`, box: c.box })));
                for (const region of regions) {
                    const box = region.box;
                    const x = Math.max(0, Math.floor(box.minX) - 6);
                    const y = Math.max(0, Math.floor(box.minY) - 6);
                    const w = Math.min(input.width - x, Math.ceil(box.maxX) - x + 6);
                    const h = Math.min(input.height - y, Math.ceil(box.maxY) - y + 6);
                    const scale = Math.max(1, Math.min(8, Math.floor(600 / Math.max(w, h))));
                    const crop = canvasOf(w * 2 * scale, h * scale);
                    const cc = crop.getContext("2d");
                    cc.imageSmoothingEnabled = false;
                    cc.drawImage(canvas, x, y, w, h, 0, 0, w * scale, h * scale);
                    cc.drawImage(tracedCanvas, x, y, w, h, w * scale, 0, w * scale, h * scale);
                    crops[`${source.name}-n${noise}-${region.id}.png`] = crop.toDataURL("image/png");
                }
                records.push(record);
            }
        }
        const procedural = [];
        const point = (matrix, p) => ({
            x: matrix.a * p.x + matrix.c * p.y + matrix.e,
            y: matrix.b * p.x + matrix.d * p.y + matrix.f,
        });
        const cubic = (p, t) => {
            const u = 1 - t;
            return {
                x: u ** 3 * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t ** 3 * p[3].x,
                y: u ** 3 * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t ** 3 * p[3].y,
            };
        };
        const derivative = (p, t) => ({
            x: 3 * (1 - t) ** 2 * (p[1].x - p[0].x) + 6 * (1 - t) * t * (p[2].x - p[1].x) + 3 * t * t * (p[3].x - p[2].x),
            y: 3 * (1 - t) ** 2 * (p[1].y - p[0].y) + 6 * (1 - t) * t * (p[2].y - p[1].y) + 3 * t * t * (p[3].y - p[2].y),
        });
        for (const fixture of fixtures) {
            const matrix = new DOMMatrix(fixture.transform);
            const names = Object.keys(fixture.paints);
            const layers = fixture.layers.map(layer => {
                const path = new Path2D();
                path.addPath(new Path2D(layer.d), matrix);
                return { ...layer, path };
            });
            const canvas = canvasOf(fixture.width * fixture.rasterScale, fixture.height * fixture.rasterScale);
            const context = canvas.getContext("2d");
            context.scale(fixture.rasterScale, fixture.rasterScale);
            for (const layer of layers) {
                context.fillStyle = fixture.paints[layer.paint];
                context.fill(layer.path);
            }
            const low = canvasOf(fixture.width, fixture.height);
            const lc = low.getContext("2d", { willReadFrequently: true });
            lc.imageSmoothingQuality = "high";
            lc.drawImage(canvas, 0, 0, low.width, low.height);
            const input = lc.getImageData(0, 0, low.width, low.height);
            if (fixture.noiseAmplitude) {
                let state = 0x9e3779b9;
                for (let i = 0; i < fixture.id.length; i++) state = Math.imul(state ^ fixture.id.charCodeAt(i), 0x45d9f3b) >>> 0;
                for (let p = 0; p < input.data.length; p += 4) {
                    state ^= state << 13;
                    state ^= state >>> 17;
                    state ^= state << 5;
                    for (let c = 0; c < 3; c++) input.data[p + c] += Math.round(((state >>> (c * 7) & 15) - 7) * fixture.noiseAmplitude / 7);
                }
            }
            const sourceAt = (x, y) => {
                let owner = -1;
                for (const layer of layers) if (lc.isPointInPath(layer.path, x, y)) owner = names.indexOf(layer.paint);
                return owner;
            };
            const isDark = fixture.id.includes("dark");
            const stations = Array.from({ length: 385 }, (_, i) => {
                const t = .02 + i * .0025;
                if (isDark) {
                    const length = Math.hypot(matrix.a, matrix.b);
                    return {
                        t,
                        origin: point(matrix, { x: 83, y: 25 + 105 * t }),
                        normal: { x: matrix.a / length, y: matrix.b / length },
                    };
                }
                const p = [{ x: 86, y: 26 }, { x: 84, y: 61 }, { x: 78, y: 94 }, { x: 73, y: 132 }];
                const d = derivative(p, t);
                const tangent = {
                    x: matrix.a * d.x + matrix.c * d.y,
                    y: matrix.b * d.x + matrix.d * d.y,
                };
                const length = Math.hypot(tangent.x, tangent.y);
                return {
                    t,
                    origin: point(matrix, cubic(p, t)),
                    normal: { x: tangent.y / length, y: -tangent.x / length },
                };
            });
            for (const noise of [0, 20]) {
                const traced = window.tracer.trace(input, {
                    noise,
                    colors: 0,
                    tolerance: 1.25,
                    minArea: 0,
                    removeBackground: false,
                    preserveDetails: true,
                    debug: true,
                });
                const mapping = matchPalette(Object.values(fixture.paints), traced.stats.palette);
                if (mapping.includes(-2) || new Set(mapping).size !== names.length) throw Error("Ambiguous local diagnostic palette");
                const debug = {
                    ...traced.debug,
                    faces: traced.debug.faces.map(face => ({
                        ...face,
                        color: face.color < 0 ? -1 : mapping[face.color],
                    })),
                };
                const labelAt = (x, y) => {
                    const label = debug.labels[Math.floor(y) * input.width + Math.floor(x)];
                    return label < 0 ? -1 : mapping[label];
                };
                const svg = new DOMParser().parseFromString(traced.svg, "image/svg+xml").documentElement;
                document.body.append(svg);
                const shapes = [...svg.querySelectorAll("path,polygon,rect,circle,ellipse")];
                const outputAt = (x, y) => {
                    let owner = -1;
                    for (const shape of shapes) if (shape.isPointInFill(new DOMPoint(x, y))) owner = mapping[traced.stats.palette.indexOf(shape.getAttribute("fill"))];
                    return owner;
                };
                const normals = stations.map(station => {
                    const normal = {
                        ...station,
                        source: transitions(sourceAt, station.origin, station.normal),
                        labels: transitions(labelAt, station.origin, station.normal),
                        raw: chainHits(debug, station.origin, station.normal, "raw"),
                        samples: chainHits(debug, station.origin, station.normal, "samples"),
                        flat: chainHits(debug, station.origin, station.normal, "flat"),
                        emitted: transitions(outputAt, station.origin, station.normal),
                    };
                    normal.gapCoverage = separatorCoverage(debug, station.origin, station.normal, normal.source, labelAt, outputAt);
                    if (normal.gapCoverage) normal.emittedAtFlatGapMidpoints = normal.gapCoverage.flat.map(interval => {
                        const at = (interval.entry + interval.exit) / 2;
                        return {
                            at,
                            owner: outputAt(station.origin.x + at * station.normal.x, station.origin.y + at * station.normal.y),
                        };
                    });
                    return normal;
                });
                const wrongPixels = [];
                const box = isDark ? { minX: 80, maxX: 87, minY: 25, maxY: 131 } : {
                    minX: 77,
                    maxX: 88,
                    minY: 63,
                    maxY: 109,
                };
                for (let y = box.minY; y < box.maxY; y++) for (let x = box.minX; x < box.maxX; x++) {
                    const source = sourceAt(x + .5, y + .5);
                    const label = labelAt(x + .5, y + .5);
                    if (source !== label) wrongPixels.push({
                        x,
                        y,
                        source,
                        label,
                        rgba: Array.from(input.data.slice(4 * (y * input.width + x), 4 * (y * input.width + x) + 4)),
                        component: debug.componentIds[y * input.width + x],
                    });
                }
                procedural.push({
                    id: fixture.id,
                    noise,
                    names,
                    palette: traced.stats.palette,
                    mapping,
                    normals,
                    wrongPixels,
                    chains: debug.chains.filter(c => c.raw.some(p => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY)),
                    junctions: endpointGroups(debug).filter(g => g.raw.x >= box.minX && g.raw.x <= box.maxX && g.raw.y >= box.minY && g.raw.y <= box.maxY),
                });
                svg.remove();
            }
        }
        const controls = await window.controls(window.tracer, window.diagnostics);
        return { generated: records, procedural, controls, crops };
    }, {
        sources,
        fixtures: getCampaignRound("validation2").filter(f => /asymmetric-fan|similar-dark/.test(f.id)),
    });
    for (const [name, data] of Object.entries(result.crops)) await writeFile(resolve(out, name), Buffer.from(data.split(",")[1], "base64"), { flag: "wx" });
    delete result.crops;
    const metadata = {
        browser: browser.version(), coreSHA256: createHash("sha256").update(core).digest("hex"),
        method: "385 normal stations per reserved boundary, at 0.0025 source-parameter spacing. Traced stages intersect every graph chain analytically as polylines; owner transitions use 1/64px steps and 14 bisections in a +/-3px local window. Bisection refines detected changes only: intervals narrower than 1/64px can be missed. Shared-vertex tangencies follow the existing half-open crossing convention. No unmatched hit is replaced by a distant arm. Emitted geometry is queried independently with SVG isPointInFill; flat curves have the core's 0.0125px flattening bound. Palette correspondence maximizes one-to-one matched centers within 52 RGB units, then minimizes total distance; all rejected centers and missing targets remain explicit. This does not establish semantic identity of arbitrarily close colors. Generated sources have raster evidence only. Local controls use independently authored vector ownership and 2x/4x rasterization; input fixture pixels, label topology and fits are separate stages.",
        inputSHA256: Object.fromEntries(sources.map(source => [source.name, createHash("sha256").update(Buffer.from(source.base64, "base64")).digest("hex")])),
    };
    await writeFile(resolve(out, "report.json"), JSON.stringify({ ...metadata, ...result }, null, 2), { flag: "wx" });
    console.log(`Wrote ${out}/report.json`);
} finally {
    await browser.close();
}
