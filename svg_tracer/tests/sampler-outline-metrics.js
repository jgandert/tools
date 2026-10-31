// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0

// Generator geometry and paints are independent of the fitted SVG. Samples
// stay clear of occlusion junctions, which receive separate raster checks.
export function measureSamplerOutline({width, height, actual, expected, actualScale = 1, nativeActual}) {
    if (actualScale > 1) {
        const reduced = new Float64Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = (y * width + x) * 4;
                for (let dy = 0; dy < actualScale; dy++) {
                    for (let dx = 0; dx < actualScale; dx++) {
                        const q = ((y * actualScale + dy) * width * actualScale + x * actualScale + dx) * 4;
                        for (let c = 0; c < 3; c++) {
                            reduced[p + c] += (actual[q + c] * actual[q + 3] / 255 + 255 - actual[q + 3]) / actualScale ** 2;
                        }
                    }
                }
                reduced[p + 3] = 255;
            }
        }
        actual = reduced;
    }
    const junctionRaster = nativeActual || actual;
    const dark = [32, 43, 56];
    const white = [255, 255, 255];
    const yellow = [231, 179, 41];
    const red = [223, 67, 94];
    const blue = [51, 137, 205];
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const circleDistance = (x, y) => Math.hypot(x - 139.2, y - 140.6) - 92.4;
    const ellipseDistance = (x, y) => {
        const dx = x - 263.2;
        const dy = y - 94.7;
        const u = dx * Math.cos(-.45) + dy * Math.sin(-.45);
        const v = -dx * Math.sin(-.45) + dy * Math.cos(-.45);
        return (u * u / 62.5 ** 2 + v * v / 32.2 ** 2 - 1) /
            (2 * Math.hypot(u / 62.5 ** 2, v / 32.2 ** 2));
    };
    const rectangleDistance = (x, y) => {
        const dx = Math.abs(x - 244.5) - (87.1 - 23);
        const dy = Math.abs(y - 174) - (64.4 - 23);
        return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - 23;
    };
    const groups = {};
    const add = (name, x, y, nx, ny, fill, background) => {
        (groups[name] ||= []).push({x, y, nx, ny, fill, background});
    };
    const arc = (name, cx, cy, radius, start, end, fill, backgroundAt) => {
        for (let angle = start; angle <= end; angle += .035) {
            const nx = Math.cos(angle);
            const ny = Math.sin(angle);
            const x = cx + radius * nx;
            const y = cy + radius * ny;
            const background = backgroundAt(x, y);
            if (background) { add(name, x, y, nx, ny, fill, background); }
        }
    };
    arc("circle", 139.2, 140.6, 92.4, 1.65, 5.15, yellow, () => white);
    arc("topLeft", 180.4, 132.6, 23, Math.PI, Math.PI * 1.5, red, () => yellow);
    arc("topRight", 308.6, 132.6, 23, -Math.PI / 2, 0, red,
        (x, y) => ellipseDistance(x, y) > 7 ? white : null);
    arc("bottomRight", 308.6, 215.4, 23, 0, Math.PI / 2, red, () => white);
    arc("bottomLeft", 180.4, 215.4, 23, Math.PI / 2, Math.PI, red,
        (x, y) => Math.abs(circleDistance(x, y)) > 7 ? (circleDistance(x, y) < 0 ? yellow : white) : null);
    for (let angle = .65; angle <= 2.8; angle += .035) {
        const u = 62.5 * Math.cos(angle);
        const v = 32.2 * Math.sin(angle);
        const x = 263.2 + u * Math.cos(-.45) - v * Math.sin(-.45);
        const y = 94.7 + u * Math.sin(-.45) + v * Math.cos(-.45);
        if (Math.abs(rectangleDistance(x, y)) < 7 || Math.abs(circleDistance(x, y)) < 7) { continue; }
        const a = Math.cos(angle) / 62.5;
        const b = Math.sin(angle) / 32.2;
        const length = Math.hypot(a, b);
        const nx = (a * Math.cos(-.45) - b * Math.sin(-.45)) / length;
        const ny = (a * Math.sin(-.45) + b * Math.cos(-.45)) / length;
        const background = rectangleDistance(x, y) < 0 ? red : circleDistance(x, y) < 0 ? yellow : white;
        add("ellipse", x, y, nx, ny, blue, background);
    }
    for (let x = 182; x < 307; x++) {
        if (ellipseDistance(x, 109.6) > 7) { add("redTop", x, 109.6, 0, -1, red, yellow); }
    }

    const coverage = (data, fill, background) => {
        const f = fill.map((v, i) => v - background[i]);
        const d = dark.map((v, i) => v - background[i]);
        const ff = dot(f, f);
        const fd = dot(f, d);
        const dd = dot(d, d);
        const determinant = ff * dd - fd * fd;
        const field = new Float64Array(width * height);
        for (let p = 0; p < field.length; p++) {
            const pixel = background.map((v, i) => data[p * 4 + i] * data[p * 4 + 3] / 255 + 255 - data[p * 4 + 3] - v);
            field[p] = Math.max(0, Math.min(1, (dot(pixel, d) * ff - dot(pixel, f) * fd) / determinant));
        }
        return field;
    };
    const fields = new Map();
    const profile = (data, sample) => {
        const key = `${data === actual ? "actual" : "expected"}:${sample.fill}:${sample.background}`;
        if (!fields.has(key)) { fields.set(key, coverage(data, sample.fill, sample.background)); }
        const field = fields.get(key);
        let mass = 0;
        let moment = 0;
        // Pixel values live at cell centers. Bilinear reconstruction plus a
        // symmetric 1/8-pixel quadrature avoids diagonal nearest-pixel bias.
        for (let offset = -4 + 1 / 16; offset < 4; offset += 1 / 8) {
            const x = sample.x + offset * sample.nx - .5;
            const y = sample.y + offset * sample.ny - .5;
            const ix = Math.floor(x);
            const iy = Math.floor(y);
            const fx = x - ix;
            const fy = y - iy;
            const value = (1 - fy) * ((1 - fx) * field[iy * width + ix] + fx * field[iy * width + ix + 1]) +
                fy * ((1 - fx) * field[(iy + 1) * width + ix] + fx * field[(iy + 1) * width + ix + 1]);
            mass += value / 8;
            moment += offset * value / 8;
        }
        return {width: mass, center: moment / mass};
    };
    const metrics = {};
    for (const [name, samples] of Object.entries(groups)) {
        const profiles = samples.map(sample => ({source: profile(expected, sample), actual: profile(actual, sample)}));
        const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
        const widthErrors = profiles.map(p => Math.abs(p.actual.width - p.source.width));
        const shifts = profiles.map(p => p.actual.center - p.source.center);
        const range = values => Math.max(...values) - Math.min(...values);
        metrics[name] = {
            samples: samples.length,
            meanWidthError: mean(widthErrors),
            maxWidthError: Math.max(...widthErrors),
            minimumWidth: Math.min(...profiles.map(p => p.actual.width)),
            meanCenterError: mean(shifts.map(Math.abs)),
            maxCenterError: Math.max(...shifts.map(Math.abs)),
            centerErrorRange: range(shifts),
            sourceCenterRange: range(profiles.map(p => p.source.center)),
            actualCenterRange: range(profiles.map(p => p.actual.center)),
        };
    }

    // Intersections invalidate a two-paint normal profile. Compare their
    // premultiplied RGBA patches independently so averaging cannot hide a join.
    const junctions = [
        {name: "circle-red", x: 162.615, y: 229.984},
        {name: "circle-ellipse", x: 216.406, y: 89.836},
        {name: "red-ellipse-left", x: 205.658, y: 109.6},
        {name: "red-ellipse-right", x: 299.542, y: 109.6},
    ];
    metrics.junctions = junctions.map(({name, x, y}) => {
        let error = 0;
        let count = 0;
        for (let py = Math.floor(y - 6); py <= y + 6; py++) {
            for (let px = Math.floor(x - 6); px <= x + 6; px++) {
                if (Math.hypot(px + .5 - x, py + .5 - y) > 6) { continue; }
                const p = (py * width + px) * 4;
                for (let c = 0; c < 4; c++) {
                    error += Math.abs(c === 3 ? junctionRaster[p + c] - expected[p + c] :
                        junctionRaster[p + c] * junctionRaster[p + 3] / 255 - expected[p + c] * expected[p + 3] / 255);
                }
                count++;
            }
        }
        return {name, x, y, pixels: count, error: error / (count * 4)};
    });
    return metrics;
}
