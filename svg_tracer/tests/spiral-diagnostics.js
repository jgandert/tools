/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Keep the factory DOM-free so the contour study can inject the same methods
// into Chromium without a server or module imports in the page.
export function createSpiralDiagnostics() {
    const maxTheta = Math.PI * 4;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    function makeGeometry(config, width = 176, height = 176) {
        const cx = width / 2 + (config.shiftX || 0);
        const cy = height / 2 + (config.shiftY || 0);
        const startAngle = -2.3 + (config.rotation || 0);
        const rate = config.pitch / (2 * Math.PI);
        const pointAt = theta => {
            const fraction = theta / maxTheta;
            const envelope = Math.max(0, Math.min(1, fraction / .1, (1 - fraction) / .1));
            const radius = 9 + rate * theta;
            const angle = theta + startAngle;
            const center = {x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle)};
            const dx = rate * Math.cos(angle) - radius * Math.sin(angle);
            const dy = rate * Math.sin(angle) + radius * Math.cos(angle);
            const length = Math.hypot(dx, dy);
            const tangent = {x: dx / length, y: dy / length};
            const normal = {x: -tangent.y, y: tangent.x};
            const halfWidth = config.halfWidth * envelope;
            return {
                center, tangent, normal, halfWidth,
                inward: {x: center.x + halfWidth * normal.x, y: center.y + halfWidth * normal.y},
                outward: {x: center.x - halfWidth * normal.x, y: center.y - halfWidth * normal.y},
            };
        };
        const points = Array.from({length: 641}, (_, i) => pointAt(maxTheta * i / 640));
        const polygon = points.map(p => p.inward).concat(points.map(p => p.outward).reverse());
        const lengths = [0];
        for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i - 1].center, points[i].center));
        const stationAt = (offset, end = false) => {
            const target = end ? lengths.at(-1) - offset : offset;
            const upper = lengths.findIndex(length => length >= target);
            const index = Math.max(1, upper);
            const fraction = (target - lengths[index - 1]) / (lengths[index] - lengths[index - 1]);
            return pointAt(maxTheta * (index - 1 + fraction) / 640);
        };
        return {
            polygon, pointAt, stationAt,
            center: points[0].center,
            end: points.at(-1).center,
            gapA: pointAt(Math.PI).outward,
            gapB: pointAt(3 * Math.PI).inward,
            sourcePath: polygon,
        };
    }

    function crossings(origin, direction, polylines) {
        const hits = [];
        for (const points of polylines) {
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1];
                const b = points[i];
                const ax = a.x - origin.x;
                const ay = a.y - origin.y;
                const bx = b.x - origin.x;
                const by = b.y - origin.y;
                const sideA = ax * direction.y - ay * direction.x;
                const sideB = bx * direction.y - by * direction.x;
                if ((sideA > 0) === (sideB > 0)) continue;
                const t = sideA / (sideA - sideB);
                hits.push((ax + t * (bx - ax)) * direction.x + (ay + t * (by - ay)) * direction.y);
            }
        }
        return hits.sort((a, b) => a - b);
    }

    function intervals(origin, direction, polylines, component = null) {
        const hits = crossings(origin, direction, polylines);
        const result = [];
        for (let i = 1; i < hits.length; i += 2) {
            if (hits[i] - hits[i - 1] > 1e-8) result.push({entry: hits[i - 1], exit: hits[i], component});
        }
        return result;
    }

    function correspondingIntervals(source, candidates) {
        // A remote arm must not stand in for a missing local strip. Require
        // positive overlap with the independently known source interval.
        return candidates.filter(candidate => Math.min(source.exit, candidate.exit) - Math.max(source.entry, candidate.entry) > 1e-8)
            .sort((a, b) => a.entry - b.entry);
    }

    function componentCounts(labels, width, height) {
        const visited = new Uint8Array(labels.length);
        const counts = [0, 0];
        const queue = new Int32Array(labels.length);
        for (let p = 0; p < labels.length; p++) {
            if (visited[p]) continue;
            const value = labels[p];
            counts[value]++;
            let head = 0;
            let tail = 1;
            queue[0] = p;
            visited[p] = 1;
            while (head < tail) {
                const q = queue[head++];
                const x = q % width;
                const y = Math.floor(q / width);
                for (const next of [x ? q - 1 : -1, x + 1 < width ? q + 1 : -1, y ? q - width : -1, y + 1 < height ? q + width : -1]) {
                    if (next < 0 || visited[next] || labels[next] !== value) continue;
                    visited[next] = 1;
                    queue[tail++] = next;
                }
            }
        }
        return {background: counts[0], foreground: counts[1]};
    }

    function measure(input, result, geometry, background, foreground, backgroundRGB, foregroundRGB) {
        const keys = ["raw", "samples", "flat"];
        const sourcePath = geometry.polygon.concat([geometry.polygon[0]]);
        const delta = foregroundRGB.map((v, i) => v - backgroundRGB[i]);
        const denominator = delta.reduce((sum, v) => sum + v * v, 0);
        const coverage = Array.from({length: input.width * input.height}, (_, p) => Math.max(0, Math.min(1,
            delta.reduce((sum, v, i) => sum + v * (input.data[4 * p + i] - backgroundRGB[i]), 0) / denominator,
        )));
        const halfCoverage = coverage.map(value => value >= .5 ? 1 : 0);
        const labeledForeground = result.debug.labels.map(value => value === foreground ? 1 : 0);
        const faces = paint => result.debug.faces.filter(face => face.color === paint);
        const faceIntervals = (origin, direction, paint, key) => faces(paint).flatMap(face => {
            const chains = result.debug.loops[face.id].flat().map(halfEdge => result.debug.chains[halfEdge >> 1][key]);
            return intervals(origin, direction, chains, face.id);
        });
        const pixelAt = point => {
            const x = Math.floor(point.x);
            const y = Math.floor(point.y);
            const p = y * input.width + x;
            return {x, y, coverage: coverage[p], foreground: !!labeledForeground[p], component: result.debug.componentIds[p]};
        };
        const stages = (origin, direction, source, paint) => Object.fromEntries(keys.map(key => [key,
            correspondingIntervals(source, faceIntervals(origin, direction, paint, key)),
        ]));
        const tips = [false, true].map(end => {
            const terminal = geometry.pointAt(end ? maxTheta : 0);
            const direction = {x: terminal.tangent.x * (end ? -1 : 1), y: terminal.tangent.y * (end ? -1 : 1)};
            const source = intervals(terminal.center, direction, [sourcePath]).find(interval => interval.entry <= .05 && interval.exit > .05);
            const longitudinal = source ? {
                source,
                ...stages(terminal.center, direction, source, foreground),
            } : null;
            const normals = [.5, 1, 2, 4, 8, 12].map(offset => {
                const station = geometry.stationAt(offset, end);
                const source = intervals(station.center, station.normal, [sourcePath]).find(interval => interval.entry < 0 && interval.exit > 0);
                return {
                    offset,
                    source: source || null,
                    ...(source ? stages(station.center, station.normal, source, foreground) : {}),
                    centerPixel: pixelAt(station.center),
                };
            });
            const pixels = [];
            for (let y = Math.floor(terminal.center.y) - 4; y <= Math.floor(terminal.center.y) + 4; y++) {
                for (let x = Math.floor(terminal.center.x) - 4; x <= Math.floor(terminal.center.x) + 4; x++) {
                    const pixel = pixelAt({x: x + .5, y: y + .5});
                    if (pixel.coverage > .001 && pixel.coverage < .999) pixels.push(pixel);
                }
            }
            return {name: end ? "end" : "start", point: terminal.center, longitudinal, normals, partialPixels: pixels};
        });
        const gaps = [-.2, -.1, 0, .1, .2].map(offset => {
            const station = geometry.pointAt(Math.PI + offset);
            const direction = {x: -station.normal.x, y: -station.normal.y};
            const hits = crossings(station.outward, direction, [sourcePath]);
            const entry = hits.findIndex(value => value > -.1);
            const source = entry >= 0 && entry + 1 < hits.length ? {entry: hits[entry], exit: hits[entry + 1]} : null;
            return {theta: Math.PI + offset, source, ...(source ? stages(station.outward, direction, source, background) : {})};
        });
        return {
            halfCoverageLabelDisagreements: halfCoverage.reduce((sum, value, p) => sum + (value !== labeledForeground[p] ? 1 : 0), 0),
            sourceHalfCoverageComponents: componentCounts(halfCoverage, input.width, input.height),
            labelComponents: componentCounts(labeledForeground, input.width, input.height),
            tips,
            gaps,
        };
    }

    return {makeGeometry, crossings, intervals, correspondingIntervals, measure};
}
