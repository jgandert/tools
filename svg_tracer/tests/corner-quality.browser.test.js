/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
let browser;
let page;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const source = readFileSync(new URL("../tracer.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: `${source}\nwindow.cornerQualityTracer = createTracer();` });
});

afterAll(async () => {
    try {
        await page?.close();
    } finally {
        await browser?.close();
    }
});

const cases = [
    {
        name: "acute corner, 5px highlight gap",
        kind: "sharp",
        angle: 55,
        gap: 5,
        cornerLimit: 1.3,
        deviationLimit: 1.3,
    },
    {
        name: "acute corner, 8px highlight gap",
        kind: "sharp",
        angle: 55,
        gap: 8,
        cornerLimit: 1.3,
        deviationLimit: 1.3,
    },
    {
        name: "acute corner, 12px control gap",
        kind: "sharp",
        angle: 55,
        gap: 12,
        cornerLimit: 1.3,
        deviationLimit: 1.3,
    },
    {
        name: "narrow corner, 3px highlight gap",
        kind: "sharp",
        angle: 75,
        gap: 3,
        cornerLimit: .95,
        deviationLimit: .65,
    },
    { name: "smooth junction before the apex", kind: "smooth", theta: -.28, ellipseLimit: .06 },
    { name: "smooth junction after the apex", kind: "smooth", theta: .48, ellipseLimit: .06 },
];

test("nearby paint junctions retain sharp corners and smooth boundaries", async () => {
    const metrics = await page.evaluate(async cases => {
        const width = 256;
        const height = 224;
        const colors = { background: "#f8f7f2", wedge: "#318255", highlight: "#eab367" };
        const pointOnEdge = (a, b, t, inset = 0) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length = Math.hypot(dx, dy);
            return {
                x: a.x + dx * t - dy / length * inset,
                y: a.y + dy * t + dx / length * inset,
            };
        };
        const ellipsePoint = (cx, cy, rx, ry, theta, inset = 0) => ({
            x: cx + (rx - inset) * Math.cos(theta),
            y: cy + (ry - inset) * Math.sin(theta),
        });
        const draw = config => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            context.fillStyle = colors.background;
            context.fillRect(0, 0, width, height);
            if (config.kind === "sharp") {
                const a = { x: 24, y: 18 };
                const corner = { x: 222, y: 130 };
                const direction = Math.atan2(a.y - corner.y, a.x - corner.x) - config.angle * Math.PI / 180;
                const d = {
                    x: corner.x + 115 * Math.cos(direction),
                    y: corner.y + 115 * Math.sin(direction),
                };
                const b = { x: 25, y: 203 };
                const edgeLength = Math.hypot(corner.x - a.x, corner.y - a.y);
                context.fillStyle = colors.wedge;
                context.beginPath();
                context.moveTo(a.x, a.y);
                context.lineTo(corner.x, corner.y);
                context.lineTo(d.x, d.y);
                context.lineTo(b.x, b.y);
                context.closePath();
                context.fill();

                context.fillStyle = colors.highlight;
                context.beginPath();
                const start = pointOnEdge(a, corner, .08, 9);
                const touchStart = pointOnEdge(a, corner, 1 - 22 / edgeLength);
                const touchEnd = pointOnEdge(a, corner, 1 - config.gap / edgeLength);
                const lowerEnd = pointOnEdge(a, corner, .08, 20);
                const upperControl = pointOnEdge(a, corner, .35, 8);
                const approachControl = pointOnEdge(a, corner, .72, 5);
                context.moveTo(start.x, start.y);
                context.bezierCurveTo(upperControl.x, upperControl.y, approachControl.x, approachControl.y, touchStart.x, touchStart.y);
                context.lineTo(touchEnd.x, touchEnd.y);
                const returnControl1 = pointOnEdge(a, corner, .70, 12);
                const returnControl2 = pointOnEdge(a, corner, .36, 17);
                context.bezierCurveTo(returnControl1.x, returnControl1.y, returnControl2.x, returnControl2.y, lowerEnd.x, lowerEnd.y);
                context.closePath();
                context.fill();
                return { canvas, geometry: { a, corner, d } };
            }

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
            const innerControl1 = ellipsePoint(cx, cy, rx, ry, theta1 - .08, 18);
            const innerControl2 = ellipsePoint(cx, cy, rx, ry, theta0 + .08, 18);
            context.bezierCurveTo(innerControl1.x, innerControl1.y, innerControl2.x, innerControl2.y, start.x, start.y);
            context.closePath();
            context.fill();
            return { canvas, geometry: { cx, cy, rx, ry, theta: config.theta } };
        };
        const nearestColor = (palette, target) => palette.map((hex, index) => ({
            index,
            error: [1, 3, 5].reduce((sum, offset, channel) => sum +
                (parseInt(hex.slice(offset, offset + 2), 16) - target[channel]) ** 2, 0),
        })).sort((left, right) => left.error - right.error)[0].index;
        const pointSegmentDistance = (point, a, b) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const denominator = dx * dx + dy * dy;
            const t = denominator ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator)) : 0;
            return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
        };
        const interfaceExists = (result, first, second) => result.debug.chains.some(chain => {
            const pair = [result.debug.faces[chain.left]?.color, result.debug.faces[chain.right]?.color];
            return pair.includes(first) && pair.includes(second);
        });
        const selectBoundary = (result, first, second, near) => result.debug.chains.filter(chain => {
            const pair = [result.debug.faces[chain.left]?.color, result.debug.faces[chain.right]?.color];
            return pair.includes(first) && pair.includes(second);
        }).map(chain => ({
            chain,
            distance: Math.min(...chain.raw.map(near)),
        })).sort((left, right) => left.distance - right.distance)[0]?.chain;
        return cases.map(config => {
            const { canvas, geometry } = draw(config);
            const image = canvas.getContext("2d").getImageData(0, 0, width, height);
            const result = window.cornerQualityTracer.trace(image, {
                colors: 3, noise: 10, tolerance: 1.25, minArea: 0, debug: true,
            });
            const palette = result.stats.palette;
            const backgroundId = nearestColor(palette, [248, 247, 242]);
            const wedgeId = nearestColor(palette, [49, 130, 85]);
            const highlightId = nearestColor(palette, [234, 179, 103]);
            const interfaces = {
                wedgeBackground: interfaceExists(result, wedgeId, backgroundId),
                highlightBackground: interfaceExists(result, highlightId, backgroundId),
            };
            const chain = config.kind === "sharp"
                ? selectBoundary(result, wedgeId, backgroundId, point => Math.hypot(point.x - geometry.corner.x, point.y - geometry.corner.y))
                : selectBoundary(result, wedgeId, backgroundId, point => Math.abs(Math.atan2(point.y - geometry.cy, point.x - geometry.cx) - geometry.theta));
            if (!chain) {
                return { name: config.name, found: false, stats: result.stats, interfaces };
            }
            const local = config.kind === "sharp"
                ? chain.flat.filter(point => Math.hypot(point.x - geometry.corner.x, point.y - geometry.corner.y) <= 18)
                : chain.flat.filter(point => Math.abs(Math.atan2(point.y - geometry.cy, point.x - geometry.cx) - geometry.theta) <= .48);
            const geometryError = config.kind === "sharp"
                ? {
                    cornerDistance: Math.min(...chain.flat.slice(1).map((point, index) =>
                        pointSegmentDistance(geometry.corner, chain.flat[index], point))),
                    maxLocalDeviation: Math.max(...local.map(point => Math.min(
                        pointSegmentDistance(point, geometry.a, geometry.corner),
                        pointSegmentDistance(point, geometry.corner, geometry.d),
                    ))),
                    localSamples: local.length,
                }
                : {
                    maxEllipseError: Math.max(...local.map(point => Math.abs(
                        Math.hypot((point.x - geometry.cx) / geometry.rx, (point.y - geometry.cy) / geometry.ry) - 1,
                    ) * Math.min(geometry.rx, geometry.ry))),
                    localSamples: local.length,
                };
            return {
                name: config.name,
                found: true,
                geometryError,
                interfaces,
                stats: {
                    colors: result.stats.colors,
                    visibleRegions: result.stats.visibleRegions,
                    fallbackChains: result.stats.fallbackChains,
                },
            };
        });
    }, cases);

    for (const [index, metric] of metrics.entries()) {
        const config = cases[index];
        const context = JSON.stringify({ config, ...metric });
        expect(metric.found, context).toBe(true);
        expect(metric.stats.colors, context).toBe(3);
        expect(metric.stats.visibleRegions, context).toBeGreaterThanOrEqual(3);
        expect(metric.stats.fallbackChains, context).toBe(0);
        expect(metric.interfaces.wedgeBackground, context).toBe(true);
        expect(metric.interfaces.highlightBackground, context).toBe(true);
        expect(metric.geometryError.localSamples, context).toBeGreaterThan(0);
        if (config.kind === "sharp") {
            expect(metric.geometryError.cornerDistance, context).toBeLessThan(config.cornerLimit);
            expect(metric.geometryError.maxLocalDeviation, context).toBeLessThan(config.deviationLimit);
        } else {
            expect(metric.geometryError.maxEllipseError, context).toBeLessThan(config.ellipseLimit);
        }
    }
});
