/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createSpiralDiagnostics } from "./spiral-diagnostics.js";

const testDir = import.meta.dir;
const config = { core: resolve(testDir, "../tracer.js"), out: null };
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === "--help" || flag === "-h") {
        process.stdout.write("Usage: bun tests/campaign-contour-study.js [--core PATH] [--out NEW.json]\n");
        process.exit(0);
    }
    if (flag !== "--core" && flag !== "--out") throw Error(`Unknown option: ${flag}`);
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw Error(`Missing value for ${flag}.`);
    const value = process.argv[++i];
    if (flag === "--core") config.core = resolve(value);
    else config.out = resolve(value);
}
if (config.out) {
    try {
        await stat(config.out);
        throw Error(`Refusing to overwrite existing output: ${config.out}`);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

const source = await readFile(config.core, "utf8");
const coreSHA256 = createHash("sha256").update(source).digest("hex");
const browser = await chromium.launch({ headless: true });
let output;
try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: `${source}\nwindow.campaignContourTracer = createTracer();\nwindow.spiralDiagnostics = (${createSpiralDiagnostics.toString()})();` });
    output = await page.evaluate(async () => {
        const colors = {
            background: "#f8f7f2",
            wedge: "#318255",
            highlight: "#eab367",
            outline: "#26292c",
        };
        const width = 300;
        const height = 280;
        const cornerWidth = 256;
        const cornerHeight = 224;
        const pointOnEdge = (a, b, t, inset = 0) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = Math.hypot(dx, dy);
            return { x: a.x + dx * t - dy / length * inset, y: a.y + dy * t + dx / length * inset };
        };
        const ellipsePoint = (cx, cy, rx, ry, theta, inset = 0) => ({
            x: cx + (rx - inset) * Math.cos(theta),
            y: cy + (ry - inset) * Math.sin(theta),
        });
        const sharpCases = [
            { name: "shallow-110-gap3", kind: "sharp", angle: 110, gap: 3 },
            { name: "shallow-120-gap3", kind: "sharp", angle: 120, gap: 3 },
            { name: "shallow-130-gap5", kind: "sharp", angle: 130, gap: 5 },
            {
                name: "shallow-120-rotated-subpixel",
                kind: "sharp",
                angle: 120,
                gap: 3,
                rotation: .49,
                shiftX: .31,
                shiftY: -.28,
            },
            { name: "sharp-55-negative", kind: "sharp", angle: 55, gap: 5 },
            {
                name: "shallow-130-jpeg-negative",
                kind: "sharp",
                angle: 130,
                gap: 5,
                rotation: -1.17,
                shiftX: -.35,
                shiftY: .27,
                codec: "jpeg",
            },
            {
                name: "shallow-115-jpeg-negative",
                kind: "sharp",
                angle: 115,
                gap: 8,
                rotation: 2.03,
                shiftX: .23,
                shiftY: -.36,
                codec: "jpeg",
            },
            { name: "smooth-ellipse-negative", kind: "smooth", theta: 1.12 },
            { name: "smooth-jpeg-ellipse-negative", kind: "smooth", theta: -1.18, codec: "jpeg" },
            { name: "true-chamfer-negative", kind: "chamfer", angle: 55, gap: 5, cut: 5 },
        ];
        const spiralCases = [
            { name: "spiral-gap3.6", pitch: 25.2, halfWidth: 10.8, tolerance: 1.25, noise: 10 },
            { name: "spiral-gap2.4", pitch: 24.0, halfWidth: 10.8, tolerance: 1.25, noise: 10 },
            {
                name: "spiral-gap1.6-rotated-subpixel",
                pitch: 23.2,
                halfWidth: 10.8,
                tolerance: .85,
                noise: 10,
                rotation: .47,
                shiftX: .31,
                shiftY: -.27,
            },
            {
                name: "spiral-gap2.4-tolerance.15",
                pitch: 24.0,
                halfWidth: 10.8,
                tolerance: .15,
                noise: 0,
            },
            {
                name: "spiral-gap1.3-limit",
                pitch: 22.9,
                halfWidth: 10.8,
                tolerance: .15,
                noise: 0,
                shiftX: .19,
                shiftY: -.24,
                diagnosticOnly: true,
            },
        ];
        const rasterCanvas = (w, h, fill) => {
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.fillStyle = fill;
            context.fillRect(0, 0, w, h);
            return { canvas, context };
        };
        const jpegRoundTrip = async canvas => {
            const image = new Image();
            image.src = canvas.toDataURL("image/jpeg", .94);
            await image.decode();
            const {
                canvas: decoded,
                context,
            } = rasterCanvas(canvas.width, canvas.height, colors.background);
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height);
        };
        const makeCorner = async config => {
            const { canvas, context } = rasterCanvas(cornerWidth, cornerHeight, colors.background);
            if (config.rotation) {
                context.translate(cornerWidth / 2 + (config.shiftX || 0), cornerHeight / 2 + (config.shiftY || 0));
                context.rotate(config.rotation);
                context.translate(-cornerWidth / 2, -cornerHeight / 2);
            }
            const point = { x: 222, y: 130 };
            const a = { x: 24, y: 18 };
            const b = { x: 25, y: 203 };
            const direction = Math.atan2(a.y - point.y, a.x - point.x) - config.angle * Math.PI / 180;
            const d = {
                x: point.x + 115 * Math.cos(direction),
                y: point.y + 115 * Math.sin(direction),
            };
            const edgeLength = Math.hypot(point.x - a.x, point.y - a.y);
            const vertices = config.kind === "chamfer" ? [
                a,
                pointOnEdge(point, a, config.cut / edgeLength),
                pointOnEdge(point, d, config.cut / 115),
                d,
                b,
            ] : [a, point, d, b];
            context.fillStyle = colors.wedge;
            context.beginPath();
            context.moveTo(vertices[0].x, vertices[0].y);
            for (const vertex of vertices.slice(1)) context.lineTo(vertex.x, vertex.y);
            context.closePath();
            context.fill();
            context.fillStyle = colors.highlight;
            context.beginPath();
            const start = pointOnEdge(a, point, .08, 9);
            const touchStart = pointOnEdge(a, point, 1 - 22 / edgeLength);
            const touchEnd = pointOnEdge(a, point, 1 - config.gap / edgeLength);
            const lowerEnd = pointOnEdge(a, point, .08, 20);
            context.moveTo(start.x, start.y);
            context.bezierCurveTo(pointOnEdge(a, point, .35, 8).x, pointOnEdge(a, point, .35, 8).y,
                pointOnEdge(a, point, .72, 5).x, pointOnEdge(a, point, .72, 5).y, touchStart.x, touchStart.y);
            context.lineTo(touchEnd.x, touchEnd.y);
            const c1 = pointOnEdge(a, point, .70, 12);
            const c2 = pointOnEdge(a, point, .36, 17);
            context.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, lowerEnd.x, lowerEnd.y);
            context.closePath();
            context.fill();
            const transform = p => {
                const x = p.x - cornerWidth / 2;
                const y = p.y - cornerHeight / 2;
                const angle = config.rotation || 0;
                return {
                    x: cornerWidth / 2 + (config.shiftX || 0) + x * Math.cos(angle) - y * Math.sin(angle),
                    y: cornerHeight / 2 + (config.shiftY || 0) + x * Math.sin(angle) + y * Math.cos(angle),
                };
            };
            const geometry = {
                a: transform(a),
                point: transform(point),
                d: transform(d),
                vertices: vertices.map(transform),
            };
            const input = config.codec === "jpeg" ? await jpegRoundTrip(canvas) : context.getImageData(0, 0, cornerWidth, cornerHeight);
            return { input, geometry };
        };
        const makeSmooth = async config => {
            const { canvas, context } = rasterCanvas(cornerWidth, cornerHeight, colors.background);
            const cx = 128;
            const cy = 112;
            const rx = 91;
            const ry = 76;
            context.fillStyle = colors.wedge;
            context.beginPath();
            context.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
            context.fill();
            const theta0 = config.theta - .22;
            const theta1 = config.theta + .22;
            context.fillStyle = colors.highlight;
            context.beginPath();
            const start = ellipsePoint(cx, cy, rx, ry, theta0, 8);
            const outerStart = ellipsePoint(cx, cy, rx, ry, theta0);
            context.moveTo(start.x, start.y);
            context.lineTo(outerStart.x, outerStart.y);
            context.ellipse(cx, cy, rx, ry, 0, theta0, theta1);
            const end = ellipsePoint(cx, cy, rx, ry, theta1);
            context.lineTo(end.x, end.y);
            const c1 = ellipsePoint(cx, cy, rx, ry, theta1 - .08, 18);
            const c2 = ellipsePoint(cx, cy, rx, ry, theta0 + .08, 18);
            context.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, start.x, start.y);
            context.closePath();
            context.fill();
            return {
                input: config.codec === "jpeg" ? await jpegRoundTrip(canvas) : context.getImageData(0, 0, cornerWidth, cornerHeight),
                geometry: { cx, cy, rx, ry, theta: config.theta },
            };
        };
        const makeThinOutline = () => {
            const { canvas, context } = rasterCanvas(width, height, colors.background);
            const cx = 150;
            const cy = 140;
            const outerRadius = 94;
            const innerRadius = 90.5;
            context.fillStyle = colors.outline;
            context.beginPath();
            context.arc(cx, cy, outerRadius, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = colors.wedge;
            context.beginPath();
            context.arc(cx, cy, innerRadius, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = colors.highlight;
            context.beginPath();
            context.arc(cx + 53, cy - 14, 3.2, 0, Math.PI * 2);
            context.fill();
            return {
                input: context.getImageData(0, 0, width, height),
                geometry: { cx, cy, outerRadius, innerRadius },
            };
        };
        const makeSpiral = config => {
            const w = 176;
            const h = 176;
            const geometry = window.spiralDiagnostics.makeGeometry(config, w, h);
            const polygon = geometry.polygon;
            const { canvas, context } = rasterCanvas(w, h, colors.background);
            context.fillStyle = colors.wedge;
            context.beginPath();
            context.moveTo(polygon[0].x, polygon[0].y);
            for (const point of polygon.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
            context.fill();
            return { input: context.getImageData(0, 0, w, h), geometry };
        };
        const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
        const nearestColor = (palette, target) => palette.map((hex, index) => ({
            index,
            error: rgb(hex).reduce((sum, value, channel) => sum + (value - target[channel]) ** 2, 0),
        })).sort((a, b) => a.error - b.error)[0].index;
        const chainColors = (result, first, second) => result.debug.chains.filter(chain => {
            const pair = [result.debug.faces[chain.left]?.color, result.debug.faces[chain.right]?.color];
            return pair.includes(first) && pair.includes(second);
        });
        const segmentDistance = (p, a, b) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const denominator = dx * dx + dy * dy;
            const t = denominator ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator)) : 0;
            return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        };
        const nearestPolylineHit = (p, flat) => {
            let best = { distance: Infinity, point: null };
            for (let i = 1; i < flat.length; i++) {
                const a = flat[i - 1];
                const b = flat[i];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const denominator = dx * dx + dy * dy;
                const t = denominator ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator)) : 0;
                const point = { x: a.x + t * dx, y: a.y + t * dy };
                const distance = Math.hypot(p.x - point.x, p.y - point.y);
                if (distance < best.distance) best = { distance, point };
            }
            return best;
        };
        const nearestPolylineDistance = (p, flat) => nearestPolylineHit(p, flat).distance;
        const sourceDistance = (p, polyline) => {
            let best = Infinity;
            for (let i = 1; i < polyline.length; i++) best = Math.min(best, segmentDistance(p, polyline[i - 1], polyline[i]));
            return best;
        };
        const rows = [];
        for (const config of sharpCases) {
            const made = config.kind === "smooth" ? await makeSmooth(config) : await makeCorner(config);
            const options = { colors: 3, noise: 10, tolerance: 1.25, minArea: 0, debug: true };
            const result = window.campaignContourTracer.trace(made.input, options);
            const background = nearestColor(result.stats.palette, rgb(colors.background));
            const wedge = nearestColor(result.stats.palette, rgb(colors.wedge));
            const highlight = nearestColor(result.stats.palette, rgb(colors.highlight));
            const candidates = chainColors(result, background, wedge);
            const geometry = made.geometry;
            if (config.kind === "smooth") {
                const chain = candidates.map(chain => ({
                    chain,
                    d: Math.min(...chain.raw.map(p => Math.abs(Math.atan2(p.y - geometry.cy, p.x - geometry.cx) - geometry.theta))),
                }))
                    .sort((a, b) => a.d - b.d)[0]?.chain;
                const local = chain?.flat.filter(p => Math.abs(Math.atan2(p.y - geometry.cy, p.x - geometry.cx) - geometry.theta) <= .48) || [];
                rows.push({
                    name: config.name,
                    geometry: chain ? {
                        maxEllipseError: Math.max(...local.map(p =>
                            Math.abs(Math.hypot((p.x - geometry.cx) / geometry.rx, (p.y - geometry.cy) / geometry.ry) - 1) * Math.min(geometry.rx, geometry.ry))),
                    } : null,
                    topology: {
                        wedgeBackground: candidates.length > 0,
                        highlightBackground: chainColors(result, background, highlight).length > 0,
                    },
                    stats: {
                        colors: result.stats.colors,
                        visibleRegions: result.stats.visibleRegions,
                        fallbackChains: result.stats.fallbackChains,
                        sampleFallbackChains: result.stats.sampleFallbackChains,
                        minimumTolerance: result.stats.minimumTolerance,
                        segments: result.stats.segments,
                    },
                });
            } else if (config.kind === "chamfer") {
                const chain = candidates.map(chain => ({
                    chain,
                    d: Math.min(...chain.raw.map(p => Math.hypot(p.x - geometry.vertices[1].x, p.y - geometry.vertices[1].y))),
                }))
                    .sort((a, b) => a.d - b.d)[0]?.chain;
                rows.push({
                    name: config.name,
                    geometry: chain ? { chamferVertexDistances: geometry.vertices.slice(1, 3).map(vertex => nearestPolylineDistance(vertex, chain.flat)) } : null,
                    topology: {
                        wedgeBackground: candidates.length > 0,
                        highlightBackground: chainColors(result, background, highlight).length > 0,
                    },
                    stats: {
                        colors: result.stats.colors,
                        visibleRegions: result.stats.visibleRegions,
                        fallbackChains: result.stats.fallbackChains,
                        sampleFallbackChains: result.stats.sampleFallbackChains,
                        minimumTolerance: result.stats.minimumTolerance,
                        segments: result.stats.segments,
                    },
                });
            } else {
                const chain = candidates.map(chain => ({
                    chain,
                    d: Math.min(...chain.raw.map(p => Math.hypot(p.x - geometry.point.x, p.y - geometry.point.y))),
                }))
                    .sort((a, b) => a.d - b.d)[0]?.chain;
                const local = chain?.flat.filter(p => Math.hypot(p.x - geometry.point.x, p.y - geometry.point.y) <= 18) || [];
                const sourceParts = [[geometry.a, geometry.point], [geometry.point, geometry.d]];
                rows.push({
                    name: config.name,
                    geometry: chain ? {
                        cornerDistance: nearestPolylineDistance(geometry.point, chain.flat),
                        maxLocalDeviation: Math.max(...local.map(p => Math.min(...sourceParts.map(part => segmentDistance(p, part[0], part[1]))))),
                    } : null,
                    topology: {
                        wedgeBackground: candidates.length > 0,
                        highlightBackground: chainColors(result, background, highlight).length > 0,
                    },
                    stats: {
                        colors: result.stats.colors,
                        visibleRegions: result.stats.visibleRegions,
                        fallbackChains: result.stats.fallbackChains,
                        sampleFallbackChains: result.stats.sampleFallbackChains,
                        minimumTolerance: result.stats.minimumTolerance,
                        segments: result.stats.segments,
                    },
                });
            }
        }
        {
            const made = makeThinOutline();
            const result = window.campaignContourTracer.trace(made.input, {
                colors: 4,
                noise: 10,
                tolerance: 1.25,
                minArea: 0,
                debug: true,
            });
            const palette = result.stats.palette;
            const background = nearestColor(palette, rgb(colors.background));
            const wedge = nearestColor(palette, rgb(colors.wedge));
            const outline = nearestColor(palette, rgb(colors.outline));
            const highlight = nearestColor(palette, rgb(colors.highlight));
            rows.push({
                name: "thin-outline-and-small-accent-negative",
                geometry: { expectedOutlineWidth: made.geometry.outerRadius - made.geometry.innerRadius },
                topology: {
                    outlineBackground: chainColors(result, background, outline).length > 0,
                    bodyOutline: chainColors(result, outline, wedge).length > 0,
                    accentVisible: chainColors(result, wedge, highlight).length > 0,
                },
                stats: {
                    colors: result.stats.colors,
                    visibleRegions: result.stats.visibleRegions,
                    fallbackChains: result.stats.fallbackChains,
                    sampleFallbackChains: result.stats.sampleFallbackChains,
                    minimumTolerance: result.stats.minimumTolerance,
                    segments: result.stats.segments,
                },
            });
        }
        for (const config of spiralCases) {
            const made = makeSpiral(config);
            const result = window.campaignContourTracer.trace(made.input, {
                colors: 2,
                noise: config.noise,
                tolerance: config.tolerance,
                minArea: 0,
                debug: true,
            });
            const background = nearestColor(result.stats.palette, rgb(colors.background));
            const wedge = nearestColor(result.stats.palette, rgb(colors.wedge));
            const candidates = chainColors(result, background, wedge);
            const nearestHit = (point, key = "flat") => candidates.map(chain => nearestPolylineHit(point, chain[key]))
                .sort((a, b) => a.distance - b.distance)[0] || null;
            const gapA = nearestHit(made.geometry.gapA);
            const gapB = nearestHit(made.geometry.gapB);
            const local = candidates.flatMap(chain => chain.flat).filter(p =>
                Math.min(Math.hypot(p.x - made.geometry.gapA.x, p.y - made.geometry.gapA.y), Math.hypot(p.x - made.geometry.gapB.x, p.y - made.geometry.gapB.y)) <= 16);
            const diagnostics = window.spiralDiagnostics.measure(made.input, result, made.geometry, background, wedge, rgb(colors.background), rgb(colors.wedge));
            rows.push({
                name: config.name,
                diagnosticOnly: !!config.diagnosticOnly,
                diagnostics,
                geometry: candidates.length ? {
                    sourceParameterPointDistance: Math.hypot(made.geometry.gapA.x - made.geometry.gapB.x, made.geometry.gapA.y - made.geometry.gapB.y),
                    nearestParameterPointDistance: Math.hypot(gapA.point.x - gapB.point.x, gapA.point.y - gapB.point.y),
                    maxLocalDeviation: local.length ? Math.max(...local.map(p => sourceDistance(p, made.geometry.sourcePath))) : null,
                    localSamples: local.length,
                    nearestStartBoundary: Object.fromEntries(["raw", "samples", "flat"].map(key => [key, nearestHit(made.geometry.center, key).distance])),
                    nearestEndBoundary: Object.fromEntries(["raw", "samples", "flat"].map(key => [key, nearestHit(made.geometry.end, key).distance])),
                } : null,
                topology: { paintBackground: chainColors(result, background, wedge).length > 0 },
                stats: {
                    colors: result.stats.colors,
                    visibleRegions: result.stats.visibleRegions,
                    fallbackChains: result.stats.fallbackChains,
                    sampleFallbackChains: result.stats.sampleFallbackChains,
                    minimumTolerance: result.stats.minimumTolerance,
                    requestedTolerance: config.tolerance,
                    segments: result.stats.segments,
                    repairedChains: result.stats.repairedChains,
                    clearanceRetries: result.debug.chains.reduce((sum, chain) => sum + (chain.clearanceRetries || 0), 0),
                    clearanceGuideDrops: result.debug.chains.reduce((sum, chain) => sum + (chain.clearanceGuideDrops || 0), 0),
                },
            });
        }
        return { browser: navigator.userAgent, rows };
    });
} finally {
    await browser.close();
}

output.core = config.core;
output.coreSHA256 = coreSHA256;
output.cases = output.rows.length;
output.regressionCases = output.rows.filter(row => !row.diagnosticOnly).length;
const supportedLocalDeviationBounds = new Map([
    ["spiral-gap3.6", .75],
    ["spiral-gap2.4", .70],
    ["spiral-gap1.6-rotated-subpixel", .72],
]);
output.failures = output.rows.flatMap(row => {
    const failures = [];
    const context = `${row.name}: ${JSON.stringify(row)}`;
    if (row.name.startsWith("spiral-")) {
        const transects = [...row.diagnostics.tips.flatMap(tip => [tip.longitudinal, ...tip.normals]), ...row.diagnostics.gaps];
        if (transects.some(transect => !transect.source || !Number.isFinite(transect.source.entry) ||
            !Number.isFinite(transect.source.exit) || transect.source.exit <= transect.source.entry)) {
            failures.push(`Invalid independent source-normal measurement (${context}).`);
        }
        for (const transect of transects) {
            for (const key of ["raw", "samples", "flat"]) {
                if (!Array.isArray(transect[key]) || transect[key].some(interval =>
                    !Number.isFinite(interval.entry) || !Number.isFinite(interval.exit) || interval.exit <= interval.entry ||
                    !Number.isInteger(interval.component) || interval.component < 0)) {
                    failures.push(`Invalid measured ${key} interval (${context}).`);
                }
            }
        }
    }

    // Measurement validity applies to the limit case too. Its unresolved
    // geometry does not acquire a quality pass bound by being measurable.
    if (row.diagnosticOnly) return failures;
    if (!row.geometry || !row.topology || row.stats.fallbackChains !== 0 || row.stats.sampleFallbackChains !== 0) {
        failures.push(`Missing contour, topology, or fallback regression (${context}).`);
        return failures;
    }
    if (row.name.startsWith("shallow-") || row.name.startsWith("sharp-")) {
        if (!row.topology.wedgeBackground || !row.topology.highlightBackground) failures.push(`Paint junction disappeared (${context}).`);
        if (!Number.isFinite(row.geometry.cornerDistance) || row.geometry.cornerDistance > 1.35 || row.geometry.maxLocalDeviation > 1.5) {
            failures.push(`Corner contour exceeded its geometric bound (${context}).`);
        }
    } else if (row.name.startsWith("smooth-")) {
        if (!row.topology.wedgeBackground || !row.topology.highlightBackground || row.geometry.maxEllipseError > .2) {
            failures.push(`Smooth contour control changed beyond its bound (${context}).`);
        }
    } else if (row.name.startsWith("true-chamfer")) {
        if (!row.topology.wedgeBackground || !row.topology.highlightBackground || row.geometry.chamferVertexDistances.some(value => value > 1)) {
            failures.push(`True chamfer control changed beyond its bound (${context}).`);
        }
    } else if (row.name.startsWith("thin-outline")) {
        if (row.stats.colors !== 4 || !row.topology.outlineBackground || !row.topology.bodyOutline || !row.topology.accentVisible) {
            failures.push(`Thin outline or small accent disappeared (${context}).`);
        }
    } else if (row.name.startsWith("spiral-")) {
        if (!row.topology.paintBackground || !Number.isFinite(row.geometry.maxLocalDeviation) || row.geometry.maxLocalDeviation > 1.5 ||
            Math.abs(row.geometry.nearestParameterPointDistance - row.geometry.sourceParameterPointDistance) > 1.2) {
            failures.push(`Spiral gap contour exceeded its geometric bound (${context}).`);
        }
        const localDeviationBound = supportedLocalDeviationBounds.get(row.name);
        if (localDeviationBound !== undefined && row.geometry.maxLocalDeviation > localDeviationBound) {
            failures.push(`Supported narrow-gap improvement missed its per-case bound (${context}).`);
        }
        if (row.stats.minimumTolerance > row.stats.requestedTolerance + 1e-9) {
            failures.push(`Spiral contour exceeded the requested tolerance (${context}).`);
        }
        if (row.name === "spiral-gap2.4-tolerance.15" && row.stats.minimumTolerance > .15 + 1e-9) {
            failures.push(`The 0.15-request spiral exceeded its explicit maximum tolerance (${context}).`);
        }
    }
    return failures;
});
const report = `${JSON.stringify(output, null, 2)}\n`;
if (config.out) await writeFile(config.out, report, { flag: "wx" });
const summary = `${JSON.stringify({
    core: output.core,
    coreSHA256,
    regressionCases: output.regressionCases,
    diagnosticCases: output.cases - output.regressionCases,
    passed: output.failures.length === 0,
    failureCount: output.failures.length,
}, null, 2)}\n`;
process.stdout.write(config.out ? summary : report);
if (output.failures.length) process.exitCode = 1;
