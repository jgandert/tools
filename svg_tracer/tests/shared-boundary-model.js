/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Experimental pixel-ownership predictor, not part of createTracer().
// Component discovery is frozen; source fitting withholds each target's full
// tangential interval. Cross-validation is an empirical envelope, not a proof.
const knots = [-4, -2, -0.5, 0, 0.5, 2, 4];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const sq = (x) => x * x;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const error = (a, b) => a.reduce((sum, x, i) => sum + sq(x - b[i]), 0);
function solve(matrix, values) {
    const n = values.length;
    const rows = matrix.map((row, i) => [...row, values[i]]);
    const scale = Math.max(...matrix.flat().map(Math.abs), 1);
    for (let column = 0; column < n; column++) {
        let pivot = column;
        for (let row = column + 1; row < n; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
        if (Math.abs(rows[pivot][column]) < scale * 1e-9) return null;
        [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
        const divisor = rows[column][column];
        for (let c = column; c <= n; c++) rows[column][c] /= divisor;
        for (let row = 0; row < n; row++)
            if (row !== column) {
                const multiple = rows[row][column];
                for (let c = column; c <= n; c++) rows[row][c] -= multiple * rows[column][c];
            }
    }
    return rows.map((row) => row[n]);
}
function regression(points, columns, value) {
    const matrix = Array.from({ length: columns }, () => Array(columns).fill(0));
    const values = Array(columns).fill(0);
    for (const point of points) {
        const basis = point.basis;
        for (let i = 0; i < columns; i++) {
            values[i] += (point.weight ?? 1) * basis[i] * value(point);
            for (let j = 0; j < columns; j++) matrix[i][j] += (point.weight ?? 1) * basis[i] * basis[j];
        }
    }
    return solve(matrix, values);
}
function components(labels, width, height) {
    const ids = new Int32Array(labels.length).fill(-1),
        list = [];
    for (let p = 0; p < labels.length; p++) {
        if (ids[p] >= 0) continue;
        const queue = [p],
            id = list.length,
            color = labels[p];
        ids[p] = id;
        for (let index = 0; index < queue.length; index++) {
            const q = queue[index],
                x = q % width,
                y = Math.floor(q / width);
            for (const r of [x ? q - 1 : -1, x + 1 < width ? q + 1 : -1, y ? q - width : -1, y + 1 < height ? q + width : -1]) {
                if (r < 0 || ids[r] >= 0 || labels[r] !== color) continue;
                ids[r] = id;
                queue.push(r);
            }
        }
        list.push({ id, color, pixels: queue });
    }
    return { ids, list };
}
function profileBasis(distance) {
    const weights = Array(knots.length).fill(0);
    if (distance <= knots[0]) {
        weights[0] = 1;
        return weights;
    }
    if (distance >= knots.at(-1)) {
        weights[weights.length - 1] = 1;
        return weights;
    }
    const index = knots.findIndex((value, i) => i + 1 < knots.length && distance >= value && distance < knots[i + 1]);
    const t = (distance - knots[index]) / (knots[index + 1] - knots[index]);
    weights[index] = 1 - t;
    weights[index + 1] = t;
    return weights;
}
function triangleError(point, C, A, B) {
    const X = C.map((x, i) => (x + A[i]) / 2),
        Y = C.map((x, i) => (x + B[i]) / 2);
    const u = X.map((x, i) => x - C[i]),
        v = Y.map((x, i) => x - C[i]),
        q = point.map((x, i) => x - C[i]);
    const uu = dot(u, u),
        vv = dot(v, v),
        uv = dot(u, v),
        uq = dot(u, q),
        vq = dot(v, q),
        det = uu * vv - uv * uv;
    let best = error(point, C);
    if (det > 1e-10) {
        const a = (uq * vv - vq * uv) / det,
            b = (vq * uu - uq * uv) / det;
        if (a >= 0 && b >= 0 && a + b <= 1)
            best = error(
                point,
                C.map((x, i) => x + a * u[i] + b * v[i]),
            );
    }
    for (const [a, b] of [
        [C, X],
        [C, Y],
        [X, Y],
    ]) {
        const d = b.map((x, i) => x - a[i]),
            denominator = dot(d, d);
        const t = denominator
            ? clamp(
                  dot(
                      point.map((x, i) => x - a[i]),
                      d,
                  ) / denominator,
                  0,
                  1,
              )
            : 0;
        best = Math.min(
            best,
            error(
                point,
                a.map((x, i) => x + t * d[i]),
            ),
        );
    }
    return best;
}
function score(samples) {
    if (!samples.length) return null;
    const errors = samples.map((sample) => error(sample.rgb, sample.prediction));
    const bias = [0, 1, 2].map(
        (channel) => samples.reduce((sum, sample) => sum + sample.rgb[channel] - sample.prediction[channel], 0) / samples.length,
    );
    return {
        count: samples.length,
        mean: errors.reduce((sum, x) => sum + x, 0) / errors.length,
        tail: quantile(errors, 0.95),
        maximum: Math.max(...errors),
        bias: dot(bias, bias),
    };
}
export function sharedBoundaryModel(scene, { degree = 2, robust = false } = {}) {
    const { width, height, data, labels, palette, noise } = scene;
    const frozen = new Int16Array(labels),
        output = new Int16Array(labels),
        topology = components(frozen, width, height),
        proposals = [];
    const rgbAt = (p) => [data[4 * p], data[4 * p + 1], data[4 * p + 2]];
    for (const component of topology.list) {
        if (component.color < 0 || component.pixels.length > 128) continue;
        const adjacent = new Map();
        for (const p of component.pixels) {
            const x = p % width,
                y = Math.floor(p / width);
            for (const q of [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y ? p - width : -1, y + 1 < height ? p + width : -1]) {
                if (q < 0 || frozen[q] < 0 || frozen[q] === component.color) continue;
                adjacent.set(frozen[q], (adjacent.get(frozen[q]) || 0) + 1);
            }
        }
        const record = {
            id: component.id,
            color: component.color,
            size: component.pixels.length,
            adjacent: [...adjacent],
            accepted: false,
        };
        proposals.push(record);
        if (adjacent.size !== 2) {
            record.reason = "not-two-paint-interface";
            continue;
        }
        const [a, b] = [...adjacent.keys()],
            C = palette[component.color],
            nominalA = palette[a],
            nominalB = palette[b];
        const center = [0, 0];
        for (const p of component.pixels) {
            center[0] += (p % width) + 0.5;
            center[1] += Math.floor(p / width) + 0.5;
        }
        center[0] /= component.pixels.length;
        center[1] /= component.pixels.length;
        let xx = 0,
            xy = 0,
            yy = 0;
        for (const p of component.pixels) {
            const x = (p % width) + 0.5 - center[0],
                y = Math.floor(p / width) + 0.5 - center[1];
            xx += x * x;
            xy += x * y;
            yy += y * y;
        }
        const angle = Math.atan2(2 * xy, xx - yy) / 2,
            tangent = [Math.cos(angle), Math.sin(angle)],
            normal = [-tangent[1], tangent[0]];
        const coords = (x, y) => {
            const dx = x - center[0],
                dy = y - center[1];
            return { t: dx * tangent[0] + dy * tangent[1], n: dx * normal[0] + dy * normal[1] };
        };
        const targetCoordinates = component.pixels.map((p) => ({ p, ...coords((p % width) + 0.5, Math.floor(p / width) + 0.5) }));
        const halfPixel = (Math.abs(tangent[0]) + Math.abs(tangent[1])) / 2;
        const span = [
            Math.min(...targetCoordinates.map((p) => p.t)) - halfPixel,
            Math.max(...targetCoordinates.map((p) => p.t)) + halfPixel,
        ];
        const length = span[1] - span[0],
            extent = 2 * length + 16;
        record.geometry = { center, tangent, normal, span, extent };
        const samples = [],
            byPixel = new Map();
        const xRadius = Math.abs(tangent[0]) * extent + Math.abs(normal[0]) * 8,
            yRadius = Math.abs(tangent[1]) * extent + Math.abs(normal[1]) * 8;
        for (let y = Math.max(0, Math.floor(center[1] - yRadius)); y < Math.min(height, Math.ceil(center[1] + yRadius)); y++) {
            for (let x = Math.max(0, Math.floor(center[0] - xRadius)); x < Math.min(width, Math.ceil(center[0] + xRadius)); x++) {
                const coordinate = coords(x + 0.5, y + 0.5),
                    p = y * width + x;
                if (Math.abs(coordinate.t) > extent || Math.abs(coordinate.n) > 8 || data[p * 4 + 3] !== 255) continue;
                const sample = { p, x, y, ...coordinate, rgb: rgbAt(p) };
                samples.push(sample);
                byPixel.set(p, sample);
            }
        }
        const otherSpans = new Map();
        for (const sample of samples) {
            if (frozen[sample.p] !== component.color || topology.ids[sample.p] === component.id) continue;
            const id = topology.ids[sample.p],
                interval = otherSpans.get(id) || [Infinity, -Infinity];
            interval[0] = Math.min(interval[0], sample.t - halfPixel);
            interval[1] = Math.max(interval[1], sample.t + halfPixel);
            otherSpans.set(id, interval);
        }
        const permanentExclusions = robust ? [span] : [span, ...otherSpans.values()];
        const fit = (extraExclusions) => {
            const intervals = [...permanentExclusions, ...extraExclusions];
            const excluded = (t) => intervals.some(([lo, hi]) => t >= lo - 2 && t <= hi + 2);
            const train = samples.filter((sample) => !excluded(sample.t));
            const anchorSamples = [[], []],
                nominalDifference = nominalB.map((x, i) => x - nominalA[i]),
                nominalSeparation = dot(nominalDifference, nominalDifference);
            const radius2 = 3 * sq(Math.max(10, noise * 1.6));
            for (const sample of train) {
                const eA = error(sample.rgb, nominalA),
                    eB = error(sample.rgb, nominalB),
                    side = eA < eB ? 0 : 1;
                if (Math.min(eA, eB) <= Math.min(radius2, nominalSeparation * 0.04)) anchorSamples[side].push(sample);
            }
            if (anchorSamples.some((group) => group.length < 16)) return { reason: "insufficient-off-patch-plateaus" };
            const anchors = anchorSamples.map((group) => [0, 1, 2].map((channel) => median(group.map((sample) => sample.rgb[channel]))));
            const [A, B] = anchors,
                difference = B.map((x, i) => x - A[i]),
                separation = dot(difference, difference);
            if (separation < 1) return { reason: "indistinct-plateaus" };
            const fraction = (sample) =>
                dot(
                    sample.rgb.map((x, i) => x - A[i]),
                    difference,
                ) / separation;
            const bins = new Map();
            for (const sample of train) {
                for (const q of [sample.x + 1 < width ? sample.p + 1 : -1, sample.y + 1 < height ? sample.p + width : -1]) {
                    const neighbor = byPixel.get(q);
                    if (!neighbor || excluded(neighbor.t)) continue;
                    const f0 = fraction(sample) - 0.5,
                        f1 = fraction(neighbor) - 0.5;
                    if (f0 * f1 > 0 || f0 === f1) continue;
                    const t = clamp(f0 / (f0 - f1), 0, 1),
                        station = sample.t + t * (neighbor.t - sample.t),
                        n = sample.n + t * (neighbor.n - sample.n);
                    const key = Math.floor(station);
                    const bin = bins.get(key) || [];
                    bin.push({ t: station, n });
                    bins.set(key, bin);
                }
            }
            const points = [];
            for (const values of bins.values()) {
                if (Math.max(...values.map((v) => v.n)) - Math.min(...values.map((v) => v.n)) > 2)
                    return { reason: "competing-source-crossings" };
                const t = median(values.map((v) => v.t)),
                    n = median(values.map((v) => v.n));
                points.push({ t, n, basis: Array.from({ length: degree + 1 }, (_, power) => (t / extent) ** power) });
            }
            const guarded = intervals.map(([lo, hi]) => [lo - 2, hi + 2]).sort((a, b) => a[0] - b[0]);
            const merged = [];
            for (const interval of guarded) {
                const previous = merged.at(-1);
                if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
                else merged.push([...interval]);
            }
            for (const predicted of [span, ...extraExclusions]) {
                const blocked = merged.find(([lo, hi]) => predicted[0] >= lo && predicted[1] <= hi);
                if (!blocked || points.filter((p) => p.t < blocked[0]).length < 4 || points.filter((p) => p.t > blocked[1]).length < 4)
                    return { reason: "no-two-sided-interpolation" };
            }
            const coefficients = regression(points, degree + 1, (point) => point.n);
            if (!coefficients) return { reason: "geometry-rank" };
            const boundary = (t) => coefficients.reduce((sum, value, power) => sum + value * (t / extent) ** power, 0);
            const distance = (sample) =>
                (sample.n - boundary(sample.t)) /
                Math.hypot(
                    1,
                    coefficients.reduce(
                        (sum, value, power) => (power ? sum + (power * value * (sample.t / extent) ** (power - 1)) / extent : sum),
                        0,
                    ),
                );
            const residuals = points.map((point) => Math.abs(point.n - boundary(point.t)));
            const rms = Math.sqrt(residuals.reduce((sum, x) => sum + x * x, 0) / residuals.length),
                maximum = Math.max(...residuals);
            if (rms > 0.45 || maximum > 0.85)
                return { reason: "geometry-residual", rms, maximum, points: points.map(({ t, n }) => ({ t, n })), coefficients, anchors };
            const meanDistances = anchorSamples.map((group) => group.reduce((sum, sample) => sum + distance(sample), 0) / group.length);
            const endpoints = meanDistances[0] < meanDistances[1] ? [A, B] : [B, A],
                endpointLabels = meanDistances[0] < meanDistances[1] ? [a, b] : [b, a];
            const profileSamples = train
                .map((sample) => {
                    const d = distance(sample),
                        weights = profileBasis(d);
                    return { ...sample, distance: d, weights, basis: weights.slice(1, -1) };
                })
                .filter((sample) => sample.distance >= -4 && sample.distance <= 4);
            let channels = [0, 1, 2].map((channel) =>
                regression(
                    profileSamples,
                    5,
                    (sample) =>
                        sample.rgb[channel] - sample.weights[0] * endpoints[0][channel] - sample.weights.at(-1) * endpoints[1][channel],
                ),
            );
            if (robust && channels.every((channel) => channel)) {
                const delta = Math.sqrt(3) * Math.max(4, noise);
                for (let iteration = 0; iteration < 4; iteration++) {
                    for (const sample of profileSamples) {
                        const prediction = [0, 1, 2].map(
                            (channel) =>
                                sample.weights[0] * endpoints[0][channel] +
                                sample.weights.at(-1) * endpoints[1][channel] +
                                dot(sample.basis, channels[channel]),
                        );
                        sample.weight = Math.min(1, delta / Math.max(1e-12, Math.sqrt(error(sample.rgb, prediction))));
                    }
                    channels = [0, 1, 2].map((channel) =>
                        regression(
                            profileSamples,
                            5,
                            (sample) =>
                                sample.rgb[channel] -
                                sample.weights[0] * endpoints[0][channel] -
                                sample.weights.at(-1) * endpoints[1][channel],
                        ),
                    );
                    if (channels.some((channel) => !channel)) break;
                }
            }
            if (channels.some((channel) => !channel)) return { reason: "profile-rank", rms, maximum };
            const predict = (sample) => {
                const d = distance(sample),
                    weights = profileBasis(d);
                const prediction = [0, 1, 2].map((channel) =>
                    clamp(
                        weights[0] * endpoints[0][channel] +
                            weights.at(-1) * endpoints[1][channel] +
                            dot(weights.slice(1, -1), channels[channel]),
                        0,
                        255,
                    ),
                );
                return { distance: d, prediction, label: endpointLabels[d < 0 ? 0 : 1] };
            };
            const distances = profileSamples.map((sample) => sample.distance);
            const weightStats = {
                samples: profileSamples.length,
                downweighted: profileSamples.filter((sample) => (sample.weight ?? 1) < 1).length,
                effectiveMass: profileSamples.reduce((sum, sample) => sum + (sample.weight ?? 1), 0),
                knotSupport: Array.from({ length: 5 }, (_, index) => ({
                    raw: profileSamples.reduce((sum, sample) => sum + sample.basis[index], 0),
                    effective: profileSamples.reduce((sum, sample) => sum + (sample.weight ?? 1) * sample.basis[index], 0),
                })),
            };
            return {
                predict,
                boundary,
                coefficients,
                anchors,
                endpoints,
                channels,
                weightStats,
                rms,
                maximum,
                points,
                minDistance: Math.min(...distances),
                maxDistance: Math.max(...distances),
                separation,
            };
        };
        const main = fit([]);
        if (!main.predict) {
            record.reason = main.reason;
            record.fitFailure = main;
            continue;
        }
        const target = targetCoordinates.map((sample) => ({ ...sample, rgb: rgbAt(sample.p), ...main.predict(sample) }));
        record.predictions = target.map(({ p, prediction, label, distance }) => ({ p, rgb: prediction, label, distance }));
        const normalRange = [Math.min(...target.map((p) => p.distance)), Math.max(...target.map((p) => p.distance))];
        if (normalRange[0] < main.minDistance || normalRange[1] > main.maxDistance) {
            record.reason = "unsupported-target-distances";
            continue;
        }
        const validationIntervals = [
            [span[0] - length - 8, span[0] - 8],
            [span[1] + 8, span[1] + length + 8],
        ];
        const validations = [],
            modelFits = [];
        for (const interval of validationIntervals) {
            const validation = fit([interval]);
            if (!validation.predict) {
                validations.push({ interval, reason: validation.reason });
                continue;
            }
            const held = samples
                .filter(
                    (sample) =>
                        sample.t >= interval[0] &&
                        sample.t <= interval[1] &&
                        !permanentExclusions.some(([lo, hi]) => sample.t >= lo - 2 && sample.t <= hi + 2),
                )
                .map((sample) => ({ ...sample, ...validation.predict(sample) }))
                .filter((sample) => sample.distance >= normalRange[0] - 0.5 && sample.distance <= normalRange[1] + 0.5);
            if (held.some((sample) => sample.distance < validation.minDistance || sample.distance > validation.maxDistance)) {
                validations.push({ interval, reason: "unsupported-held-out-distances" });
                continue;
            }
            if (held.length < Math.max(8, Math.ceil(target.length / 2))) {
                validations.push({ interval, reason: "insufficient-held-out-support", count: held.length });
                continue;
            }
            const pointErrors = main.points
                .filter((point) => point.t >= interval[0] && point.t <= interval[1])
                .map((point) => Math.abs(point.n - validation.boundary(point.t)));
            if (!pointErrors.length || Math.max(...pointErrors) > 0.85) {
                validations.push({ interval, reason: "held-out-geometry", maximum: pointErrors.length ? Math.max(...pointErrors) : null });
                continue;
            }
            const metrics = score(held);
            validations.push({ interval, metrics, geometryMaximum: Math.max(...pointErrors) });
            modelFits.push(validation);
        }
        record.validations = validations;
        record.fit = {
            anchors: main.anchors,
            coefficients: main.coefficients,
            channels: main.channels,
            weightStats: main.weightStats,
            rms: main.rms,
            maximum: main.maximum,
            normalRange,
        };
        if (validations.some((result) => !result.metrics)) {
            record.reason = "validation-unavailable";
            continue;
        }
        const envelope = Object.fromEntries(
            ["mean", "tail", "maximum", "bias"].map((key) => [key, Math.max(...validations.map((result) => result.metrics[key]))]),
        );
        const qualityCap = Math.min(3 * sq(Math.max(4, noise)), main.separation * 0.04);
        record.envelope = envelope;
        record.qualityCap = qualityCap;
        if (envelope.mean > qualityCap) {
            record.reason = "poor-held-out-prediction";
            continue;
        }
        const ownershipAgrees = target.every((sample) => modelFits.every((model) => model.predict(sample).label === sample.label));
        if (!ownershipAgrees) {
            record.reason = "unstable-predicted-ownership";
            continue;
        }
        const spreads = modelFits.map((model) =>
            score(target.map((sample) => ({ rgb: sample.prediction, prediction: model.predict(sample).prediction }))),
        );
        record.predictionSpreads = spreads;
        if (spreads.some((spread) => ["mean", "tail", "maximum", "bias"].some((key) => spread[key] > envelope[key] + 1e-6))) {
            record.reason = "unstable-predicted-rgb";
            continue;
        }
        const metrics = score(target),
            alternative = target.reduce((sum, sample) => sum + triangleError(sample.rgb, C, ...main.anchors), 0) / target.length;
        record.target = { ...metrics, dominantPaintMean: alternative };
        if (["mean", "tail", "maximum", "bias"].some((key) => metrics[key] > envelope[key] + 1e-6)) {
            record.reason = "target-not-predicted";
            continue;
        }
        if (alternative - metrics.mean <= envelope.mean + 1e-6) {
            record.reason = "no-predictive-advantage";
            continue;
        }
        record.accepted = true;
        record.reason = "predicted-by-shared-boundary";
        record.changes = [];
        for (const sample of target) {
            output[sample.p] = sample.label;
            record.changes.push({ p: sample.p, color: sample.label });
        }
    }
    return { labels: output, proposals };
}
