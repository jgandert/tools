/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Independently authored local controls. Their declared geometry is truth only
// for these sources; it is not a reconstruction of the generated artwork.
export async function runDarkBoundaryControls(tracer, diagnostics) {
    const {
        matchPalette,
        transitions,
        chainHits,
        separatorCoverage,
        endpointGroups,
        components,
    } = diagnostics;
    const canvasOf = (width, height) => Object.assign(document.createElement("canvas"), {
        width,
        height,
    });
    const rectangle = (x, y, width, height) => `M${x} ${y}h${width}v${height}h-${width}z`;
    const fixtures = [];
    for (const rasterScale of [2, 4]) for (const angle of [.7, 22]) for (const underpaint of [false, true]) {
        fixtures.push({
            id: `dark-seam-${rasterScale}x-${angle}-${underpaint ? "underpaint" : "adjacent"}`,
            angle,
            rasterScale,
            jitter: 4,
            paints: ["#f5efe5", "#161d28", "#253044", "#3b4054"],
            layers: [[0, rectangle(0, 0, 192, 160)], [1, rectangle(19, 25, underpaint ? 124 : 62.31, 108)], [2, rectangle(81.31, 25, 61.69, 108)], [3, rectangle(154, 36, 23, 24)]],
            stations: Array.from({ length: 193 }, (_, i) => ({ x: 81.31, y: 31 + i * .5 })),
            mechanism: "Adjacent antialias coverage over paper versus identical vector ownership with dark underpaint",
        });
    }
    for (const angle of [0, 17]) for (const shift of [.13, .61]) {
        const edge = 75 + shift;
        fixtures.push({
            id: `tapered-separator-${angle}-${shift}`, angle,
            paints: ["#f6efe0", "#42273c", "#c65965"],
            layers: [[0, rectangle(0, 0, 192, 160)], [1, rectangle(29, 24, edge - 29, 110)], [2, `M${edge + 2.7} 24H124V134H${edge - .8}Z`]],
            stations: Array.from({ length: 205 }, (_, i) => ({ x: edge, y: 28 + i * .5 })),
            mechanism: "A known tapering paper separator terminates at a three-paint junction",
        });
    }
    for (const width of [1, 2]) for (const band of ["#1d1c1b", "#353331"]) {
        fixtures.push({
            id: `near-black-outline-${width}-${band.slice(1)}`, angle: .8,
            paints: ["#f9f3e8", "#e56a26", "#151513", band],
            layers: [[0, rectangle(0, 0, 192, 160)], [1, rectangle(22, 18, 51, 126)], [2, rectangle(69.2, 18, 5, 126)], [3, rectangle(69.2, 18, width, 126)]],
            stations: Array.from({ length: 193 }, (_, i) => ({
                x: 69.2 + width / 2,
                y: 30 + i * .5,
            })),
            mechanism: "A genuine narrow tonal band inside a dark outline",
        });
    }
    for (const radius of [.42, .62]) {
        fixtures.push({
            id: `alpha-hole-${radius}`, angle: 0, paints: ["#078582"],
            layers: [[0, rectangle(20, 20, 146, 118)]], hole: { x: 93.5, y: 81.5, radius },
            stations: [{ x: 93.5, y: 81.5 }],
            mechanism: "An authored subpixel circular hole can produce one subthreshold-alpha pixel before fitting",
        });
    }
    fixtures.push({
        id: "outline-fringe", angle: 13,
        paints: ["#fcf3e8", "#261d30", "#c6a7ed"],
        layers: [[0, rectangle(0, 0, 192, 160)], [1, rectangle(25, 28, 133, 105)], [2, rectangle(29, 32, 125, 97)], [2, "M80 30.7H87V32H80Z"]],
        stations: [{ x: 83.5, y: 31 }], direction: { x: 0, y: 1 },
        mechanism: "A real short lavender fringe interrupts a dark outline at shared endpoints",
    });
    for (const remotePaint of [false, true]) {
        fixtures.push({
            id: `shallow-dark-edge-${remotePaint ? "remote-paint" : "two-paints"}`, angle: 0,
            paints: remotePaint ? ["#081832", "#284476", "#10254c"] : ["#081832", "#284476"],
            layers: [[0, rectangle(0, 0, 192, 160)], [1, "M20 25H170V94.7L20 86.3Z"], ...(remotePaint ? [[2, rectangle(140, 119, 24, 22)]] : [])],
            stations: Array.from({ length: 261 }, (_, i) => ({
                x: 30 + i * .5,
                y: 86.3 + (10 + i * .5) * 8.4 / 150,
            })), direction: { x: -8.4 / 150, y: 1 },
            mechanism: "Shallow antialiased dark wing edge with or without a remote available intermediate paint",
        });
    }
    const records = [];
    for (const fixture of fixtures) {
        const radians = fixture.angle * Math.PI / 180;
        const matrix = new DOMMatrix().translate(96, 80).rotate(fixture.angle).translate(-96, -80);
        const map = p => ({
            x: matrix.a * p.x + matrix.c * p.y + matrix.e,
            y: matrix.b * p.x + matrix.d * p.y + matrix.f,
        });
        const direction = fixture.direction || { x: 1, y: 0 };
        const length = Math.hypot(direction.x, direction.y);
        const normal = {
            x: (Math.cos(radians) * direction.x - Math.sin(radians) * direction.y) / length,
            y: (Math.sin(radians) * direction.x + Math.cos(radians) * direction.y) / length,
        };
        const layers = fixture.layers.map(([paint, d]) => {
            const path = new Path2D();
            path.addPath(new Path2D(d), matrix);
            return { paint, path };
        });
        const scale = fixture.rasterScale || 4;
        const high = canvasOf(192 * scale, 160 * scale);
        const context = high.getContext("2d");
        context.scale(scale, scale);
        for (const layer of layers) {
            context.fillStyle = fixture.paints[layer.paint];
            context.fill(layer.path);
        }
        if (fixture.hole) {
            context.globalCompositeOperation = "destination-out";
            context.beginPath();
            context.arc(fixture.hole.x, fixture.hole.y, fixture.hole.radius, 0, Math.PI * 2);
            context.fill();
        }
        const canvas = canvasOf(192, 160);
        const low = canvas.getContext("2d", { willReadFrequently: true });
        low.imageSmoothingQuality = "high";
        low.drawImage(high, 0, 0, 192, 160);
        const input = low.getImageData(0, 0, 192, 160);
        if (fixture.jitter) {
            let state = 0x73528baf;
            for (let p = 0; p < input.data.length; p += 4) {
                state ^= state << 13;
                state ^= state >>> 17;
                state ^= state << 5;
                for (let c = 0; c < 3; c++) input.data[p + c] += ((state >>> (c * 7) & 15) - 7) * fixture.jitter / 7;
            }
        }
        const sourceAt = (x, y) => {
            if (fixture.hole && Math.hypot(x - fixture.hole.x, y - fixture.hole.y) < fixture.hole.radius) return -1;
            let paint = -1;
            for (const layer of layers) if (low.isPointInPath(layer.path, x, y)) paint = layer.paint;
            return paint;
        };
        const colorModes = fixture.id.startsWith("near-black") ? ["auto", "explicit"] : ["auto"];
        for (const colorMode of colorModes) for (const noise of [0, 20, 40]) {
            const traced = tracer.trace(input, {
                noise,
                colors: colorMode === "auto" ? 0 : fixture.paints.length,
                minArea: 6,
                tolerance: 1.25,
                preserveDetails: true,
                removeBackground: false,
                debug: true,
            });
            const mapping = matchPalette(fixture.paints, traced.stats.palette);
            const debug = {
                ...traced.debug,
                faces: traced.debug.faces.map(face => ({
                    ...face,
                    color: face.color < 0 ? -1 : mapping[face.color],
                })),
            };
            const labelAt = (x, y) => {
                const label = debug.labels[Math.floor(y) * 192 + Math.floor(x)];
                return label < 0 ? -1 : mapping[label];
            };
            const normals = fixture.stations.map(p => {
                const origin = map(p);
                const source = transitions(sourceAt, origin, normal);
                return {
                    origin,
                    source,
                    labels: transitions(labelAt, origin, normal),
                    samples: chainHits(debug, origin, normal, "samples"),
                    flat: chainHits(debug, origin, normal, "flat"),
                    gapCoverage: separatorCoverage(debug, origin, normal, source, labelAt),
                };
            });
            let remoteIntrusionPixels = 0;
            const sourceSeamValues = [];
            for (let y = 0; y < 160; y++) for (let x = 0; x < 192; x++) {
                const label = labelAt(x + .5, y + .5);
                const source = sourceAt(x + .5, y + .5);
                const p = y * 192 + x;
                if (fixture.id.startsWith("dark-seam") && label === 3 && source !== 3) remoteIntrusionPixels++;
                if (fixture.id.startsWith("shallow-dark") && label === 2 && source !== 2) remoteIntrusionPixels++;
                if (fixture.id.startsWith("dark-seam")) {
                    const inverse = new DOMPoint(x + .5, y + .5).matrixTransform(matrix.inverse());
                    if (Math.abs(inverse.x - 81.31) < .6 && inverse.y > 30 && inverse.y < 128) sourceSeamValues.push({
                        x,
                        y,
                        rgba: Array.from(input.data.slice(4 * p, 4 * p + 4)),
                        source,
                        label,
                    });
                }
            }
            records.push({
                id: fixture.id,
                mechanism: fixture.mechanism,
                colorMode,
                noise,
                palette: traced.stats.palette,
                mapping,
                missingIntendedPaints: fixture.paints.map((_, i) => i).filter(i => !mapping.includes(i)),
                rasterScale: scale,
                jitter: fixture.jitter || 0,
                fallbackChains: traced.stats.fallbackChains,
                regions: traced.stats.regions,
                remoteIntrusionPixels,
                localSeamIntrusionPixels: sourceSeamValues.filter(p => p.label === 3).length,
                sourceSeamValues,
                components: components({
                    ...debug,
                    labels: debug.labels.map(label => label < 0 ? -1 : mapping[label]),
                }, input).map(({ pixels, ...component }) => component),
                normals,
                junctions: endpointGroups(debug),
                centerAlpha: fixture.hole ? input.data[(81 * 192 + 93) * 4 + 3] : undefined,
            });
        }
    }
    return records;
}
