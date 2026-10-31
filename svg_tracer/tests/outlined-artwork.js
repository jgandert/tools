/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// This function is self-contained so Playwright can run it with page.evaluate().
// data is codec-decoded RGBA; clean and outlineCoverage are pre-codec references.
export async function makeOutlinedArtwork(config = {}) {
    const seed = config.seed ?? 1;
    let state = 2166136261;
    for (const character of String(seed)) {
        state ^= character.charCodeAt(0);
        state = Math.imul(state, 16777619);
    }
    const random = () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const between = (minimum, maximum) => minimum + random() * (maximum - minimum);
    const width = config.width ?? 180 + Math.floor(random() * 81);
    const height = config.height ?? 180 + Math.floor(random() * 81);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 180 || width > 260 || height < 180 || height > 260) {
        throw new RangeError("Artwork width and height must be integers from 180 to 260.");
    }
    const format = config.format ?? "png";
    if (format !== "png" && format !== "jpeg") {
        throw new RangeError("Artwork format must be png or jpeg.");
    }
    const background = config.background ?? "white";
    if (background !== "white" && background !== "transparent") {
        throw new RangeError("Artwork background must be white or transparent.");
    }
    if (format === "jpeg" && background === "transparent") {
        throw new RangeError("JPEG artwork requires a white background.");
    }
    const join = config.join ?? (random() < 0.5 ? "round" : "miter");
    if (join !== "round" && join !== "miter") {
        throw new RangeError("Artwork join must be round or miter.");
    }

    const palette = ["#29b9c8", "#ef7950", "#edc64a"];
    const outline = ["#000000", "#101820", "#1b1722", "#18212d"][Math.floor(random() * 4)];
    const strokeWidths = [between(1.5, 6), between(1.5, 6), between(1.5, 6)];
    const rotation = config.rotation ?? between(-Math.PI, Math.PI);
    if (!Number.isFinite(rotation)) {
        throw new RangeError("Artwork rotation must be a finite angle in radians.");
    }
    const offsetX = between(-0.49, 0.49);
    const offsetY = between(-0.49, 0.49);
    const scale = Math.min(width, height) / 240 * 0.82;
    const makeCanvas = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
    };
    const prepare = (context) => {
        context.translate(width / 2 + offsetX, height / 2 + offsetY);
        context.rotate(rotation);
        context.scale(scale, scale);
        context.translate(-120, -120);
        context.lineJoin = join;
        context.miterLimit = 8;
        context.lineCap = "round";
    };

    const star = new Path2D();
    const spikes = 8;
    const starAngle = between(-0.18, 0.18);
    for (let index = 0; index < spikes * 2; index++) {
        const outer = index % 2 === 0;
        const radius = outer ? between(55, 65) : between(31, 40);
        const angle = starAngle + index * Math.PI / spikes + between(-0.055, 0.055);
        const x = 91 + Math.cos(angle) * radius;
        const y = 104 + Math.sin(angle) * radius;
        if (index === 0) {
            star.moveTo(x, y);
        } else {
            star.lineTo(x, y);
        }
    }
    star.closePath();

    const organic = new Path2D();
    const knots = [];
    for (let index = 0; index < 8; index++) {
        const angle = index * Math.PI / 4 + between(-0.1, 0.1);
        const radiusX = between(52, 62);
        const radiusY = between(48, 59);
        knots.push({x: 155 + Math.cos(angle) * radiusX, y: 104 + Math.sin(angle) * radiusY});
    }
    const midpoint = (first, second) => ({x: (first.x + second.x) / 2, y: (first.y + second.y) / 2});
    const firstMidpoint = midpoint(knots.at(-1), knots[0]);
    organic.moveTo(firstMidpoint.x, firstMidpoint.y);
    for (let index = 0; index < knots.length; index++) {
        const next = midpoint(knots[index], knots[(index + 1) % knots.length]);
        organic.quadraticCurveTo(knots[index].x, knots[index].y, next.x, next.y);
    }
    organic.closePath();
    organic.ellipse(157 + between(-3, 3), 100 + between(-3, 3), between(15, 19), between(12, 17), between(-0.35, 0.35), 0, Math.PI * 2);

    const ribbon = new Path2D();
    const ribbonPoints = [
        [-81, -15], [28, -15], [54, -37], [73, -24], [48, -1],
        [75, 16], [55, 31], [28, 13], [-81, 13], [-63, -1],
    ];
    const ribbonAngle = between(-0.28, 0.28);
    const sine = Math.sin(ribbonAngle);
    const cosine = Math.cos(ribbonAngle);
    for (let index = 0; index < ribbonPoints.length; index++) {
        const [localX, localY] = ribbonPoints[index];
        const x = 116 + localX * cosine - localY * sine;
        const y = 156 + localX * sine + localY * cosine;
        if (index === 0) {
            ribbon.moveTo(x, y);
        } else {
            ribbon.lineTo(x, y);
        }
    }
    ribbon.closePath();
    const paths = [star, organic, ribbon];

    const artwork = makeCanvas();
    const artworkContext = artwork.getContext("2d", {willReadFrequently: true});
    const coverage = makeCanvas();
    const coverageContext = coverage.getContext("2d", {willReadFrequently: true});
    if (background === "white") {
        artworkContext.fillStyle = "#ffffff";
        artworkContext.fillRect(0, 0, width, height);
    }
    coverageContext.fillStyle = "#ffffff";
    coverageContext.fillRect(0, 0, width, height);
    prepare(artworkContext);
    prepare(coverageContext);
    for (let index = 0; index < paths.length; index++) {
        artworkContext.fillStyle = palette[index];
        artworkContext.strokeStyle = outline;
        artworkContext.lineWidth = strokeWidths[index] / scale;
        artworkContext.fill(paths[index], "evenodd");
        artworkContext.stroke(paths[index]);

        coverageContext.fillStyle = "#ffffff";
        coverageContext.strokeStyle = "#000000";
        coverageContext.lineWidth = strokeWidths[index] / scale;
        coverageContext.fill(paths[index], "evenodd");
        coverageContext.stroke(paths[index]);
    }
    const clean = Array.from(artworkContext.getImageData(0, 0, width, height).data);
    const coveragePixels = coverageContext.getImageData(0, 0, width, height).data;
    const outlineCoverage = new Array(width * height);
    for (let pixel = 0; pixel < outlineCoverage.length; pixel++) {
        outlineCoverage[pixel] = 255 - coveragePixels[pixel * 4];
    }

    const strokeMasks = [];
    const paintMasks = [];
    paths.forEach((path, index) => {
        const canvas = makeCanvas();
        const context = canvas.getContext("2d", {willReadFrequently: true});
        prepare(context);
        context.strokeStyle = "#000000";
        context.lineWidth = strokeWidths[index] / scale;
        context.stroke(path);
        const pixels = context.getImageData(0, 0, width, height).data;
        const mask = new Uint8Array(width * height);
        for (let pixel = 0; pixel < mask.length; pixel++) {
            mask[pixel] = pixels[pixel * 4 + 3];
        }
        strokeMasks.push(mask);

        context.fillStyle = "#000000";
        context.fill(path, "evenodd");
        const paintedPixels = context.getImageData(0, 0, width, height).data;
        const paintMask = new Uint8Array(width * height);
        for (let pixel = 0; pixel < paintMask.length; pixel++) {
            paintMask[pixel] = paintedPixels[pixel * 4 + 3];
        }
        paintMasks.push(paintMask);
    });
    const junctions = [];
    for (let first = 0; first < strokeMasks.length; first++) {
        for (let second = first + 1; second < strokeMasks.length; second++) {
            const overlap = new Uint8Array(width * height);
            for (let pixel = 0; pixel < overlap.length; pixel++) {
                let visible = strokeMasks[first][pixel] > 80 && strokeMasks[second][pixel] > 80;
                for (let later = second + 1; later < paintMasks.length; later++) {
                    if (paintMasks[later][pixel] > 128) {
                        visible = false;
                    }
                }
                overlap[pixel] = visible ? 1 : 0;
            }
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
                    junctions.push({x: sumX / count, y: sumY / count, shapes: [first, second]});
                }
            }
        }
    }

    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    const dataUrl = artwork.toDataURL(mimeType, format === "jpeg" ? 0.94 : undefined);
    const decoded = new Image();
    decoded.src = dataUrl;
    await decoded.decode();
    const decodedCanvas = makeCanvas();
    const decodedContext = decodedCanvas.getContext("2d", {willReadFrequently: true});
    decodedContext.drawImage(decoded, 0, 0);
    const data = Array.from(decodedContext.getImageData(0, 0, width, height).data);
    const hexToRgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    return {
        width, height, seed, format, background, join, rotation, strokeWidths, mimeType, dataUrl,
        data, clean, outlineCoverage, junctions,
        paints: [hexToRgb(outline), [255, 255, 255], ...palette.map(hexToRgb)],
    };
}
