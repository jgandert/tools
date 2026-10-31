/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Self-contained for Playwright page.evaluate(). Coordinates and outline coverage
// come from the lossless canvas; data comes from the requested image codec.
export async function makeJunctionArtwork(config = {}) {
    const seed = config.seed ?? 1;
    let state = 2166136261;
    for (const character of String(seed)) {
        state = Math.imul(state ^ character.charCodeAt(0), 16777619);
    }
    const random = () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const kind = config.kind ?? "acute";
    // The first three positions cross both outlines; tangent leaves a narrow gap.
    const positions = {
        acute: { x: 139, y: 95, angle: -0.48 },
        obtuse: { x: 144, y: 119, angle: 0.42 },
        shared: { x: 159, y: 104, angle: -0.18 },
        tangent: { x: 190, y: 99, angle: 0 },
    };
    if (!Object.hasOwn(positions, kind)) {
        throw new RangeError("Artwork kind must be acute, obtuse, shared, or tangent.");
    }
    const format = config.format ?? "png";
    if (format !== "png" && format !== "jpeg") {
        throw new RangeError("Artwork format must be png or jpeg.");
    }
    const rotation = config.rotation ?? 0;
    if (!Number.isFinite(rotation)) {
        throw new RangeError("Artwork rotation must be a finite angle in radians.");
    }
    const width = 224;
    const height = 224;
    const scale = 0.76;
    const offsetX = (random() - 0.5) * 0.8;
    const offsetY = (random() - 0.5) * 0.8;
    const jitter = () => (random() - 0.5) * 0.5;
    const position = positions[kind];
    const centerX = position.x + jitter();
    const centerY = position.y + jitter();
    const angle = position.angle + jitter() * 0.08;
    const strokeWidths = [2.5, 2.3];
    const paints = [[0, 0, 0], [255, 255, 255], [237, 187, 77], [72, 181, 202]];
    const makeCanvas = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
    };
    const prepare = context => {
        context.translate(width / 2 + offsetX, height / 2 + offsetY);
        context.rotate(rotation);
        context.scale(scale, scale);
        context.translate(-110, -110);
        context.lineJoin = "round";
        context.lineCap = "round";
    };

    const silhouette = new Path2D();
    const corners = [
        [34, 55], [77, 33], [119, 44], [135, 70], [112, 83],
        [136, 98], [124, 135], [144, 154], [119, 178],
        [65, 166], [43, 139], [59, 110], [37, 91],
    ];
    corners.forEach(([x, y], index) => {
        if (index === 0) {
            silhouette.moveTo(x, y);
        } else {
            silhouette.lineTo(x, y);
        }
    });
    silhouette.closePath();
    silhouette.ellipse(80, 83, 13, 10, -0.3, 0, Math.PI * 2);

    const overlay = new Path2D();
    const knots = [];
    const radiusXs = [54, 51, 55, 52, 54, 56, 53, 55];
    const radiusYs = [35, 34, 37, 33, 35, 36, 34, 37];
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    for (let index = 0; index < 8; index++) {
        const theta = index * Math.PI / 4;
        const x = Math.cos(theta) * radiusXs[index];
        const y = Math.sin(theta) * radiusYs[index];
        knots.push({
            x: centerX + x * cosine - y * sine,
            y: centerY + x * sine + y * cosine,
        });
    }
    const midpoint = (first, second) => ({
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
    });
    const first = midpoint(knots[7], knots[0]);
    overlay.moveTo(first.x, first.y);
    for (let index = 0; index < knots.length; index++) {
        const next = midpoint(knots[index], knots[(index + 1) % knots.length]);
        overlay.quadraticCurveTo(knots[index].x, knots[index].y, next.x, next.y);
    }
    overlay.closePath();
    const paths = [silhouette, overlay];

    const artwork = makeCanvas();
    const context = artwork.getContext("2d", { willReadFrequently: true });
    const coverage = makeCanvas();
    const coverageContext = coverage.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    coverageContext.fillStyle = "#ffffff";
    coverageContext.fillRect(0, 0, width, height);
    prepare(context);
    prepare(coverageContext);
    paths.forEach((path, index) => {
        const color = paints[index + 2];
        context.fillStyle = `rgb(${color.join(",")})`;
        context.strokeStyle = "#000000";
        context.lineWidth = strokeWidths[index] / scale;
        context.fill(path, "evenodd");
        context.stroke(path);

        coverageContext.fillStyle = "#ffffff";
        coverageContext.strokeStyle = "#000000";
        coverageContext.lineWidth = strokeWidths[index] / scale;
        coverageContext.fill(path, "evenodd");
        coverageContext.stroke(path);
    });
    const clean = Array.from(context.getImageData(0, 0, width, height).data);
    const coveragePixels = coverageContext.getImageData(0, 0, width, height).data;
    const outlineCoverage = new Array(width * height);
    for (let pixel = 0; pixel < outlineCoverage.length; pixel++) {
        outlineCoverage[pixel] = 255 - coveragePixels[pixel * 4];
    }

    const masks = paths.map((path, index) => {
        const maskCanvas = makeCanvas();
        const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
        prepare(maskContext);
        maskContext.strokeStyle = "#000000";
        maskContext.lineWidth = strokeWidths[index] / scale;
        maskContext.stroke(path);
        return maskContext.getImageData(0, 0, width, height).data;
    });
    const overlap = new Uint8Array(width * height);
    for (let pixel = 0; pixel < overlap.length; pixel++) {
        overlap[pixel] = masks[0][pixel * 4 + 3] > 80 && masks[1][pixel * 4 + 3] > 80 ? 1 : 0;
    }
    const junctions = [];
    for (let pixel = 0; pixel < overlap.length; pixel++) {
        if (!overlap[pixel]) {
            continue;
        }
        const pending = [pixel];
        overlap[pixel] = 0;
        let count = 0;
        let sumX = 0;
        let sumY = 0;
        while (pending.length) {
            const current = pending.pop();
            const x = current % width;
            const y = Math.floor(current / width);
            count++;
            sumX += x + 0.5;
            sumY += y + 0.5;
            for (let nextY = Math.max(0, y - 1); nextY <= Math.min(height - 1, y + 1); nextY++) {
                for (let nextX = Math.max(0, x - 1); nextX <= Math.min(width - 1, x + 1); nextX++) {
                    const next = nextY * width + nextX;
                    if (overlap[next]) {
                        overlap[next] = 0;
                        pending.push(next);
                    }
                }
            }
        }
        if (count >= 2) {
            junctions.push({ x: sumX / count, y: sumY / count, shapes: [0, 1] });
        }
    }

    const gapPoints = [];
    if (kind === "tangent") {
        // Search around the silhouette tip at source-space (137, 100).
        const gapX = width / 2 + offsetX + scale * (27 * Math.cos(rotation) + 10 * Math.sin(rotation));
        const gapY = height / 2 + offsetY + scale * (27 * Math.sin(rotation) - 10 * Math.cos(rotation));
        const candidates = [];
        for (let y = Math.max(5, Math.floor(gapY) - 12); y <= Math.min(height - 6, Math.ceil(gapY) + 12); y++) {
            for (let x = Math.max(5, Math.floor(gapX) - 12); x <= Math.min(width - 6, Math.ceil(gapX) + 12); x++) {
                const pixel = y * width + x;
                const channel = pixel * 4;
                if (clean[channel] !== 255 || clean[channel + 1] !== 255 || clean[channel + 2] !== 255) {
                    continue;
                }
                const distances = [Infinity, Infinity];
                for (let dy = -5; dy <= 5; dy++) {
                    for (let dx = -5; dx <= 5; dx++) {
                        const distance = dx * dx + dy * dy;
                        if (distance > 25) {
                            continue;
                        }
                        const nearby = ((y + dy) * width + x + dx) * 4 + 3;
                        for (let shape = 0; shape < 2; shape++) {
                            if (masks[shape][nearby] > 128 && distance < distances[shape]) {
                                distances[shape] = distance;
                            }
                        }
                    }
                }
                if (distances[0] <= 25 && distances[1] <= 25) {
                    candidates.push({
                        x,
                        y,
                        widest: Math.max(...distances),
                        total: distances[0] + distances[1],
                    });
                }
            }
        }
        candidates.sort((first, second) => first.widest - second.widest || first.total - second.total || first.y - second.y || first.x - second.x);
        gapPoints.push(...candidates.slice(0, 3).map(({ x, y }) => ({ x, y })));
    }

    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    const dataUrl = artwork.toDataURL(mimeType, format === "jpeg" ? 0.94 : undefined);
    const decoded = new Image();
    decoded.src = dataUrl;
    await decoded.decode();
    const decodedCanvas = makeCanvas();
    const decodedContext = decodedCanvas.getContext("2d", { willReadFrequently: true });
    decodedContext.drawImage(decoded, 0, 0);
    const data = Array.from(decodedContext.getImageData(0, 0, width, height).data);
    return {
        width,
        height,
        seed,
        kind,
        rotation,
        format,
        mimeType,
        background: "white",
        join: "round",
        strokeWidths,
        paints,
        clean,
        outlineCoverage,
        junctions,
        gapPoints,
        dataUrl,
        data,
    };
}
