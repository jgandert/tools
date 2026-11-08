/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

const width = 192;
const height = 160;

const rect = (x, y, w, h) => `M${x} ${y}h${w}v${h}h-${w}z`;
const layer = (paint, d, options = {}) => ({ paint, d, ...options });
const identity = [1, 0, 0, 1, 0, 0];

function affine(scale = 1, degrees = 0, tx = 0, ty = 0) {
    const radians = degrees * Math.PI / 180;
    const a = scale * Math.cos(radians);
    const b = scale * Math.sin(radians);
    const c = -b;
    const d = a;
    return [a, b, c, d, width / 2 - a * width / 2 - c * height / 2 + tx,
        height / 2 - b * width / 2 - d * height / 2 + ty];
}

function mapPoint(transform, x, y) {
    const [a, b, c, d, e, f] = transform;
    return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function scene(id, paints, layers, options = {}) {
    return {
        id,
        width,
        height,
        paints,
        layers,
        transform: identity,
        rasterScale: 1,
        jpegQuality: null,
        noiseAmplitude: 0,
        lines: [],
        probes: [],
        crops: [],
        ...options,
    };
}

const diagnostic = [
    scene("reentrant-junctions", {
        paper: "#f7f0df",
        ink: "#18253b",
        coral: "#de5946",
        teal: "#28796f",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M18 18H114V45H80V75H137V138H27V109H55V70H18z"),
        layer("coral", "M80 45H114V75H137V101H80z"),
        layer("teal", "M143 19H179V57H143z"),
        layer("paper", "M150 26H172V50H150z", { fillRule: "evenodd" }),
    ], {
        lines: [{ axis: "h", at: 45.37, start: 8, end: 151 }, {
            axis: "v",
            at: 79.41,
            start: 8,
            end: 150,
        }],
        probes: [
            { name: "notch-core", x: 66.5, y: 86.5, paint: "ink" },
            { name: "junction-fill", x: 105.5, y: 60.5, paint: "coral" },
            { name: "cutout", x: 160.5, y: 38.5, paint: "paper" },
        ],
        crops: [{ name: "notch", x: 42, y: 39, width: 72, height: 72 }],
    }),
    scene("rounded-outline", {
        paper: "#fff8ea",
        ink: "#1b293b",
        gold: "#d99b32",
        blue: "#347d91",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M20 31Q20 19 32 19H97Q109 19 109 31V112Q109 124 97 124H32Q20 124 20 112zM31 39V104Q31 113 40 113H89Q98 113 98 104V39Q98 30 89 30H40Q31 30 31 39z", { fillRule: "evenodd" }),
        layer("gold", "M39 42Q39 37 45 37H84Q90 37 90 43V100Q90 107 83 107H46Q39 107 39 100z"),
        layer("blue", "M128 79C128 62 141 51 155 51S182 63 182 79 169 108 155 108 128 96 128 79Z"),
    ], {
        lines: [{ axis: "h", at: 31.37, start: 12, end: 117 }, {
            axis: "v",
            at: 108.61,
            start: 15,
            end: 132,
        }],
        probes: [
            { name: "outline", x: 25.5, y: 72.5, paint: "ink" },
            { name: "inside", x: 64.5, y: 76.5, paint: "gold" },
            { name: "round-cap", x: 155.5, y: 53.5, paint: "blue" },
        ],
        crops: [{ name: "rounded-corner", x: 14, y: 14, width: 64, height: 64 }],
    }),
    scene("curves-holes-contact", {
        paper: "#f5f0e7",
        forest: "#247061",
        lilac: "#927ab5",
        navy: "#192941",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("forest", "M18 75C18 39 43 18 78 18S137 39 137 75 111 132 78 132 18 111 18 75ZM54 76C54 91 64 101 78 101S102 91 102 76 92 50 78 50 54 61 54 76Z", { fillRule: "evenodd" }),
        layer("lilac", "M115 76C127 60 153 55 171 68C185 79 178 101 160 111C141 121 118 111 112 96C109 89 110 82 115 76Z"),
        layer("navy", "M24 140C37 128 53 128 65 140L80 155H22Z"),
    ], {
        lines: [{ axis: "h", at: 75.43, start: 10, end: 185 }, {
            axis: "v",
            at: 78.67,
            start: 10,
            end: 145,
        }],
        probes: [
            { name: "loop-body", x: 40.5, y: 75.5, paint: "forest" },
            { name: "loop-hole", x: 78.5, y: 75.5, paint: "paper" },
            { name: "touching-color", x: 121.5, y: 80.5, paint: "lilac" },
        ],
        crops: [{ name: "hole-junction", x: 81, y: 51, width: 68, height: 64 }],
    }),
    scene("spiral-opening-tips", {
        paper: "#f8f1e4",
        green: "#31824d",
        amber: "#dd8d35",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("green", "M34 43C45 20 72 12 99 15C130 18 151 39 151 62C151 87 130 101 109 97C92 94 89 78 102 72C113 67 124 73 123 83", {
            strokeWidth: 14,
            lineCap: "butt",
        }),
        layer("green", "M34 43L21 34L27 53Z"),
        layer("green", "M123 83L140 82L128 72Z"),
        layer("amber", "M63 122C69 113 81 113 87 122S95 139 86 143H64C57 139 58 130 63 122Z"),
    ], {
        transform: affine(1, 0, 0.37, -0.28),
        rasterScale: 3,
        lines: [{ axis: "h", at: 58.37, start: 12, end: 166 }, {
            axis: "v",
            at: 101.53,
            start: 8,
            end: 112,
        }],
        probes: [
            { name: "outer-turn", x: 137.5, y: 41.5, paint: "green" },
            { name: "narrow-opening", x: 113.5, y: 58.5, paint: "paper" },
            { name: "accent", x: 75.5, y: 128.5, paint: "amber", kind: "accent" },
        ],
        crops: [{ name: "opening-tip", x: 79, y: 45, width: 73, height: 70 }],
    }),
    scene("thin-outline-mixed-accent", {
        paper: "#faf4e6",
        ink: "#1c3049",
        ochre: "#d99537",
        mix: "#7b6340",
        sage: "#617c68",
        offMix: "#786b62",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M17 34L69 18L119 40L109 105L65 132L22 105Z"),
        layer("ochre", "M26 38L69 25L109 43L101 98L64 120L31 98Z"),
        layer("mix", rect(143, 28, 4, 4)),
        layer("mix", rect(68, 22, 4, 4)),
        layer("mix", rect(143, 41, 4, 4)),
        layer("mix", rect(161, 27, 6, 6)),
        layer("sage", rect(151, 28, 5, 4)),
        layer("ink", "M145 50H176V55H145Z"),
        layer("ochre", "M145 62H176V67H145Z"),
        layer("mix", "M159 78C163 78 166 81 166 85S163 92 159 92 152 89 152 85 155 78 159 78Z"),
        layer("offMix", "M141 109H178V110H141Z"),
    ], {
        noisePatches: [
            { x: 143, y: 41, width: 4, height: 4, amplitude: 8 },
            { x: 161, y: 27, width: 6, height: 6, amplitude: 12 },
        ],
        lines: [{ axis: "h", at: 34.37, start: 8, end: 122 }, {
            axis: "v",
            at: 109.61,
            start: 20,
            end: 126,
        }],
        probes: [
            { name: "outline-width", x: 21.5, y: 70.5, paint: "ink" },
            { name: "mixture-accent", x: 144.5, y: 29.5, paint: "mix", kind: "accent" },
            { name: "boundary-mixture-accent", x: 69.5, y: 23.5, paint: "mix", kind: "accent" },
            { name: "noisy-midpoint-4x4-jitter8", x: 144.5, y: 42.5, paint: "mix", kind: "accent" },
            {
                name: "noisy-midpoint-6x6-jitter12",
                x: 163.5,
                y: 29.5,
                paint: "mix",
                kind: "accent",
            },
            { name: "thin-stripe", x: 160.5, y: 52.5, paint: "ink", kind: "accent" },
            { name: "near-dark-accent", x: 153.5, y: 29.5, paint: "sage", kind: "accent" },
            { name: "one-pixel-off-mixture", x: 159.5, y: 109.5, paint: "offMix", kind: "accent" },
        ],
        crops: [{ name: "small-paints", x: 135, y: 19, width: 53, height: 89 }],
    }),
    scene("touching-tjunctions", {
        paper: "#fff6e7",
        ink: "#151f32",
        blue: "#3b6590",
        red: "#bd4c43",
        nearBlue: "#416b96",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M19 20H90L115 58L91 98H19Z"),
        layer("blue", "M90 20H162V67H115L90 58Z"),
        layer("red", "M91 98L115 67H162V137H91Z"),
        layer("nearBlue", "M27 111H75V137H27Z"),
    ], {
        transform: affine(0.96, -0.7, 0.41, 0.19),
        lines: [{ axis: "h", at: 58.37, start: 8, end: 175 }, {
            axis: "v",
            at: 91.61,
            start: 8,
            end: 151,
        }],
        probes: [
            { name: "left-region", x: 42.5, y: 50.5, paint: "ink" },
            { name: "t-junction", x: 120.5, y: 54.5, paint: "blue" },
            { name: "near-color", x: 47.5, y: 122.5, paint: "nearBlue" },
        ],
        crops: [{ name: "junction", x: 78, y: 43, width: 56, height: 67 }],
    }),
    scene("transparent-loop-islands", {
        ink: "#17273f",
        mint: "#478679",
        cream: "#e9d8b5",
    }, [
        layer("ink", "M22 71C22 38 45 20 76 20S132 40 132 71 108 123 76 123 22 104 22 71ZM54 71C54 85 63 94 76 94S98 85 98 71 89 47 76 47 54 57 54 71Z", { fillRule: "evenodd" }),
        layer("mint", "M121 39L169 39L169 88L121 88Z"),
        layer(null, "M130 48H160V79H130Z", { erase: true }),
        layer("cream", "M140 57C144 53 150 53 153 58S155 69 149 72C144 75 138 70 138 65S138 59 140 57Z"),
        layer("cream", "M34 138H39V143H34Z"),
    ], {
        rasterScale: 2,
        noiseAmplitude: 3,
        lines: [{ axis: "h", at: 71.37, start: 10, end: 180 }, {
            axis: "v",
            at: 76.61,
            start: 10,
            end: 150,
        }],
        probes: [
            { name: "transparent-hole", x: 76.5, y: 71.5, paint: null },
            { name: "cleared-region", x: 132.5, y: 64.5, paint: null },
            { name: "tiny-accent", x: 36.5, y: 140.5, paint: "cream", kind: "accent" },
        ],
        crops: [{ name: "alpha-hole", x: 14, y: 16, width: 68, height: 68 }],
    }),
    scene("rotated-subpixel-caps", {
        paper: "#f6eddc",
        navy: "#172b43",
        coral: "#d85747",
        cyan: "#397c8a",
    }, [
        layer("paper", rect(0, 0, width, height), { lock: true }),
        layer("navy", "M27 31Q27 23 35 23H102Q110 23 110 31V49Q110 57 102 57H35Q27 57 27 49Z"),
        layer("coral", "M65 57C65 43 76 33 91 33H147Q160 33 160 46V104Q160 117 147 117H91C76 117 65 106 65 92Z"),
        layer("cyan", "M30 95L52 82L75 103L52 125Z"),
    ], {
        transform: affine(0.89, 23, 0.43, -0.31),
        rasterScale: 2,
        lines: [{ axis: "h", at: 52.37, start: 8, end: 180 }, {
            axis: "v",
            at: 105.61,
            start: 8,
            end: 150,
        }],
        probes: [
            { name: "rotated-rectangle", x: 71.9473, y: 29.173, paint: "navy" },
            { name: "rotated-curve", x: 118.314, y: 88.496, paint: "coral" },
            { name: "triangle-tip", x: 47.752, y: 95.285, paint: "cyan" },
        ],
        crops: [{ name: "rotated-contact", x: 57, y: 44, width: 67, height: 75 }],
    }),
    scene("jpeg-curve-sheet", {
        paper: "#f8f2e8",
        forest: "#256c58",
        violet: "#7d6a9f",
        orange: "#d77b34",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("forest", "M18 53C21 27 48 16 72 27C91 36 92 53 78 66C67 76 64 88 75 97C89 109 115 96 113 78C111 61 97 57 93 48C87 33 102 21 121 25C146 30 163 54 158 80C151 113 121 137 89 132C63 128 52 110 55 92C58 77 70 68 72 56C74 42 61 35 50 39C37 43 38 58 44 68L24 78C18 71 17 63 18 53Z"),
        layer("violet", "M119 117C124 104 136 98 149 100C164 102 174 112 173 126C172 138 160 146 146 145L122 142Z"),
        layer("orange", "M27 111C34 105 43 105 49 111S55 127 49 132H28C22 128 22 117 27 111Z"),
    ], {
        rasterScale: 3,
        jpegQuality: 0.78,
        noiseAmplitude: 2,
        lines: [{ axis: "h", at: 78.37, start: 8, end: 181 }, {
            axis: "v",
            at: 93.61,
            start: 8,
            end: 149,
        }],
        probes: [
            { name: "spiral-body", x: 39.5, y: 47.5, paint: "forest" },
            { name: "spiral-gap", x: 92.5, y: 67.5, paint: "paper" },
            { name: "detached-accent", x: 38.5, y: 120.5, paint: "orange", kind: "accent" },
        ],
        crops: [{ name: "spiral-contact", x: 53, y: 52, width: 82, height: 73 }],
    }),
];

const validation1 = [
    scene("v1-offset-knot", {
        paper: "#f4ebda",
        ink: "#22283c",
        peach: "#e59072",
        blue: "#416e9c",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M19 38L68 18L104 48L88 77L111 102L78 135L56 111L28 123L40 83Z"),
        layer("peach", "M68 18L129 23L148 50L104 48Z"),
        layer("blue", "M111 102L148 76L171 104L143 137L78 135Z"),
    ], {
        transform: affine(0.93, 11.5, -0.23, 0.39),
        rasterScale: 2,
        lines: [{ axis: "h", at: 77.37, start: 8, end: 180 }, {
            axis: "v",
            at: 104.61,
            start: 8,
            end: 153,
        }],
        probes: [{ name: "knot-center", x: 96.5, y: 91.5, paint: "ink" },
            { name: "junction-paint", x: 132.5, y: 39.5, paint: "peach" }],
        crops: [{ name: "offset-knot", x: 67, y: 47, width: 73, height: 72 }],
    }),
    scene("v1-tapered-pair", {
        paper: "#f7f0e6",
        teal: "#226b68",
        saffron: "#d9a13c",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("teal", "M21 44C36 24 63 18 85 27C106 35 117 57 105 74C95 88 74 86 69 73C65 61 77 52 87 58C94 62 92 68 88 71", {
            strokeWidth: 13,
            lineCap: "butt",
        }),
        layer("teal", "M21 44L8 34L13 55Z"),
        layer("teal", "M88 71L103 74L96 59Z"),
        layer("saffron", "M114 101C127 86 156 87 170 104L154 126L125 129Z"),
    ], {
        transform: affine(1, 0, 0.21, -0.34),
        rasterScale: 3,
        lines: [{ axis: "h", at: 64.37, start: 7, end: 180 }, {
            axis: "v",
            at: 87.61,
            start: 7,
            end: 108,
        }],
        probes: [{ name: "thin-gap", x: 76.5, y: 45.5, paint: "paper" }, {
            name: "taper-tip",
            x: 12.5,
            y: 44.5,
            paint: "teal",
        }],
        crops: [{ name: "taper-opening", x: 20, y: 25, width: 90, height: 72 }],
    }),
    scene("v1-small-spectrum", {
        paper: "#fff8ed",
        dark: "#202b39",
        umber: "#8c5b42",
        tan: "#ddb45d",
        pale: "#d5dbc7",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("dark", "M18 26H113V113H18Z"),
        layer("tan", "M27 35H104V104H27Z"),
        layer("umber", rect(135, 28, 5, 5)),
        layer("pale", rect(148, 28, 4, 5)),
        layer("umber", "M134 50H174V56H134Z"),
        layer("dark", "M134 65H174V70H134Z"),
        layer("pale", "M153 83C160 80 166 85 164 91S157 98 152 94 148 86 153 83Z"),
    ], {
        noiseAmplitude: 4,
        rasterScale: 2,
        lines: [{ axis: "h", at: 35.37, start: 8, end: 116 }, {
            axis: "v",
            at: 113.61,
            start: 8,
            end: 123,
        }],
        probes: [{
            name: "tiny-umber",
            x: 137.5,
            y: 30.5,
            paint: "umber",
            kind: "accent",
        }, { name: "tiny-pale", x: 149.5, y: 30.5, paint: "pale", kind: "accent" }],
        crops: [{ name: "tiny-spectrum", x: 128, y: 21, width: 54, height: 85 }],
    }),
    scene("v1-transparent-chamfer", {
        ink: "#25334b",
        lilac: "#9d83bd",
        cream: "#e7d9ba",
    }, [
        layer("ink", "M28 34L49 18H104L124 39V95L103 116H49L28 97Z M55 49L65 41H88L98 51V84L88 94H64L54 84Z", { fillRule: "evenodd" }),
        layer("lilac", "M117 84C130 69 157 70 169 86S171 118 151 124C133 129 113 109 117 84Z"),
        layer("cream", "M137 90C141 84 151 84 156 91S156 103 149 106 135 99 137 90Z"),
    ], {
        rasterScale: 3,
        lines: [{ axis: "h", at: 67.37, start: 8, end: 180 }, {
            axis: "v",
            at: 76.61,
            start: 8,
            end: 147,
        }],
        probes: [{ name: "transparent-interior", x: 76.5, y: 67.5, paint: null }, {
            name: "ring",
            x: 32.5,
            y: 66.5,
            paint: "ink",
        }],
        crops: [{ name: "chamfer-hole", x: 19, y: 15, width: 96, height: 104 }],
    }),
];

const validation2 = [
    scene("v2-asymmetric-fan", {
        paper: "#f8f0df",
        wine: "#3b2435",
        rose: "#c85962",
        gold: "#dcaa42",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("wine", "M27 126C40 93 52 60 67 22L86 26C84 61 78 94 73 132Z"),
        layer("rose", "M64 131C77 94 88 57 101 20L120 26C115 62 106 98 95 138Z"),
        layer("gold", "M88 134C111 103 129 69 150 35L169 48C149 82 127 117 105 143Z"),
    ], {
        transform: affine(0.94, -8.7, 0.33, 0.27),
        rasterScale: 2,
        lines: [{ axis: "h", at: 84.37, start: 8, end: 180 }, {
            axis: "v",
            at: 88.61,
            start: 8,
            end: 151,
        }],
        probes: [{ name: "fan-left", x: 69.5, y: 88.5, paint: "wine" }, {
            name: "fan-middle",
            x: 101.5,
            y: 89.5,
            paint: "rose",
        }, { name: "fan-right", x: 137.5, y: 81.5, paint: "gold" }],
        crops: [{ name: "fan-junctions", x: 58, y: 51, width: 91, height: 77 }],
    }),
    scene("v2-crossed-caps", {
        paper: "#f4ecd9",
        charcoal: "#242b3b",
        turquoise: "#288b83",
        orange: "#d8733c",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("charcoal", "M25 45Q25 28 42 28H110Q127 28 127 45V60Q127 77 110 77H42Q25 77 25 60Z"),
        layer("turquoise", "M69 81Q69 64 86 64H151Q168 64 168 81V96Q168 113 151 113H86Q69 113 69 96Z"),
        layer("orange", "M116 32C132 32 143 43 143 58S132 84 116 84 89 73 89 58 100 32 116 32Z"),
    ], {
        transform: affine(1, 18.5, -0.16, 0.44),
        rasterScale: 3,
        lines: [{ axis: "h", at: 70.37, start: 8, end: 180 }, {
            axis: "v",
            at: 114.61,
            start: 8,
            end: 150,
        }],
        probes: [{ name: "crossing-cap", x: 115.5, y: 57.5, paint: "orange" }, {
            name: "underlap",
            x: 81.5,
            y: 91.5,
            paint: "turquoise",
        }],
        crops: [{ name: "crossed-caps", x: 74, y: 36, width: 82, height: 76 }],
    }),
    scene("v2-similar-dark-paints", {
        paper: "#f8f3e9",
        black: "#171c26",
        navy: "#222b3b",
        slate: "#313b4c",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("black", "M18 25H83V130H18Z"),
        layer("navy", "M83 25H137V130H83Z"),
        layer("slate", "M137 25H175V130H137Z"),
        layer("paper", "M30 47H71V108H30Z"),
        layer("navy", "M148 43C155 36 166 40 167 49V107H148Z"),
    ], {
        transform: affine(0.98, 0.6, -0.21, 0.12),
        rasterScale: 2,
        noiseAmplitude: 4,
        lines: [{ axis: "v", at: 83.37, start: 8, end: 150 }, {
            axis: "v",
            at: 137.61,
            start: 8,
            end: 150,
        }],
        probes: [{ name: "black", x: 22.5, y: 34.5, paint: "black" }, {
            name: "navy",
            x: 106.5,
            y: 34.5,
            paint: "navy",
        }, { name: "slate", x: 160.5, y: 34.5, paint: "slate" }],
        crops: [{ name: "dark-palette", x: 13, y: 18, width: 169, height: 120 }],
    }),
    scene("v2-thin-slits-and-dots", {
        paper: "#fbf5e9",
        green: "#2d7259",
        peach: "#da8564",
        mixture: "#837c5f",
    }, [
        layer("paper", rect(0, 0, width, height), { lock: true }),
        layer("green", "M20 34C37 15 68 18 82 39C94 57 88 80 71 90C55 100 36 95 29 80C23 68 28 56 40 52C51 49 61 56 59 66C58 72 52 73 49 69"),
        layer("peach", "M104 28H169V34H104Z"),
        layer("peach", "M104 44H169V50H104Z"),
        layer("mixture", rect(111, 66, 4, 4)),
        layer("mixture", "M135 80C139 76 145 78 146 83S143 91 138 90 132 84 135 80Z"),
    ], {
        transform: affine(0.95, -0.4, 0.37, -0.22),
        rasterScale: 3,
        jpegQuality: 0.84,
        lines: [{ axis: "h", at: 60.37, start: 7, end: 181 }, {
            axis: "v",
            at: 82.61,
            start: 7,
            end: 104,
        }],
        probes: [{ name: "loop-core", x: 41.5, y: 66.5, paint: "green" }, {
            name: "thin-first-line",
            x: 130.5,
            y: 31.5,
            paint: "peach",
            kind: "accent",
        }, { name: "midpoint-dot", x: 112.5, y: 67.5, paint: "mixture", kind: "accent" }],
        crops: [{ name: "slits-and-dots", x: 97, y: 19, width: 83, height: 79 }],
    }),
];

const v3OrbitTransform = affine(0.94, 13.2, 0.31, -0.26);
const v3FanTransform = affine(0.92, -9.4, -0.29, 0.38);
const v3HairlineTransform = affine(1.03, 5.8, 0.27, -0.33);
const v4RibbonTransform = affine(0.95, -11.3, 0.37, -0.24);
const v4NotchTransform = affine(0.97, 1.1, -0.35, 0.22);
const v4DarkTransform = affine(0.96, 0.5, 0.19, -0.17);
const v4JpegTransform = affine(0.94, 7.2, 0.28, 0.34);

const validation3 = [
    scene("v3-orbit-curves", {
        paper: "#f6efdf",
        ink: "#203047",
        cranberry: "#a94f56",
        moss: "#557b62",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M18 73C18 39 43 17 76 17S132 39 132 73 108 128 76 128 18 107 18 73ZM47 73C47 91 59 102 76 102S105 91 105 73 93 45 76 45 47 56 47 73Z", { fillRule: "evenodd" }),
        layer("cranberry", "M99 45C116 28 145 31 162 48C179 66 173 96 153 108C135 118 114 111 107 97C101 84 109 73 122 70C132 68 140 75 138 84L127 88C125 81 118 82 117 88C116 94 123 101 133 101C147 100 158 87 156 72C154 57 141 47 127 48C117 49 110 54 105 62Z"),
        layer("moss", "M30 133C38 120 52 119 61 130C68 139 64 150 55 154H27C22 149 24 140 30 133Z"),
    ], {
        rasterScale: 3,
        transform: v3OrbitTransform,
        lines: [{ axis: "h", at: 72.37, start: 8, end: 181 }, {
            axis: "v",
            at: 101.61,
            start: 7,
            end: 150,
        }],
        probes: [
            { name: "curved-ring", ...mapPoint(v3OrbitTransform, 41.5, 68.5), paint: "ink" },
            { name: "ring-opening", ...mapPoint(v3OrbitTransform, 76.5, 70.5), paint: "paper" },
            {
                name: "curl-core", ...mapPoint(v3OrbitTransform, 155.875, 71.125),
                paint: "cranberry",
            },
            {
                name: "detached-curved-accent", ...mapPoint(v3OrbitTransform, 44.375, 143.375),
                paint: "moss",
                kind: "accent",
            },
        ],
        crops: [{ name: "orbit-contact", x: 98, y: 42, width: 77, height: 75 }],
    }),
    scene("v3-shallow-acute-fan", {
        paper: "#f8f1e5",
        ink: "#29364a",
        blue: "#396b8f",
        nearBlue: "#426f93",
        orange: "#c8794e",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("ink", "M18 34L104 41L142 67L137 73L101 50L17 43Z"),
        layer("blue", "M104 41L174 17L179 25L112 53Z"),
        layer("nearBlue", "M101 51L139 74L168 112L160 118L132 81L96 59Z"),
        layer("orange", "M22 111L83 79L96 85L33 124Z"),
    ], {
        transform: v3FanTransform,
        rasterScale: 2,
        lines: [{ axis: "h", at: 50.37, start: 7, end: 181 }, {
            axis: "v",
            at: 103.61,
            start: 8,
            end: 158,
        }],
        probes: [
            { name: "shallow-band", ...mapPoint(v3FanTransform, 65.375, 37.875), paint: "ink" },
            { name: "acute-upper-ray", ...mapPoint(v3FanTransform, 146.5, 30.5), paint: "blue" },
            {
                name: "near-color-lower-ray", ...mapPoint(v3FanTransform, 141.5, 89.5),
                paint: "nearBlue",
            },
            { name: "crossing-wedge", ...mapPoint(v3FanTransform, 52.5, 101.5), paint: "orange" },
        ],
        crops: [{ name: "acute-junction", x: 91, y: 38, width: 71, height: 61 }],
    }),
    scene("v3-noisy-micro-palette", {
        paper: "#f5eedf",
        umber: "#625033",
        brass: "#bd984e",
        nearBrass: "#c49f55",
        teal: "#3c786f",
        midpoint: "#8f7441",
        offMixture: "#927c69",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("umber", "M18 26C18 20 23 16 29 16H101C107 16 111 21 111 27V112C111 118 107 122 101 122H28C22 122 18 118 18 112Z"),
        layer("brass", "M29 37Q29 31 35 31H93Q99 31 99 37V103Q99 109 93 109H35Q29 109 29 103Z"),
        layer("nearBrass", "M119 24C119 19 123 15 128 15H169C174 15 178 19 178 24V66C178 71 174 75 169 75H128C123 75 119 71 119 66Z"),
        layer("teal", "M120 88L172 82L177 119L125 126Z"),
        layer("midpoint", rect(126, 35, 4, 4)),
        layer("midpoint", rect(142, 36, 6, 6)),
        layer("midpoint", rect(159, 37, 5, 5)),
        layer("offMixture", "M123 137H175V138H123Z"),
    ], {
        noisePatches: [{ x: 142, y: 36, width: 6, height: 6, amplitude: 10 }],
        noiseAmplitude: 2,
        rasterScale: 2,
        lines: [{ axis: "h", at: 109.37, start: 9, end: 117 }, {
            axis: "v",
            at: 111.61,
            start: 8,
            end: 128,
        }],
        probes: [
            { name: "curved-brass", x: 48.5, y: 43.5, paint: "brass" },
            { name: "near-brass-region", x: 153.5, y: 56.5, paint: "nearBrass" },
            { name: "exact-midpoint-4x4", x: 128.5, y: 37.5, paint: "midpoint", kind: "accent" },
            { name: "noisy-midpoint-6x6", x: 144.5, y: 38.5, paint: "midpoint", kind: "accent" },
            {
                name: "off-mixture-hairline",
                x: 149.5,
                y: 137.5,
                paint: "offMixture",
                kind: "accent",
            },
        ],
        crops: [{ name: "micro-palette", x: 116, y: 12, width: 69, height: 133 }],
    }),
    scene("v3-transparent-hairlines", {
        ink: "#151c29",
        navy: "#222c3b",
        slate: "#34404f",
        cream: "#dec99e",
    }, [
        layer("ink", "M22 70C22 39 45 22 75 22C104 22 127 41 127 70C127 99 104 119 75 119C45 119 22 101 22 70Z", {
            strokeWidth: 4.5,
            lineCap: "round",
        }),
        layer("navy", "M43 72C43 55 56 44 75 44C94 44 107 56 107 72C107 89 94 100 75 100C56 100 43 89 43 72Z", { strokeWidth: 2.25 }),
        layer("slate", "M133 28C145 22 159 24 169 33C178 42 178 57 170 68", {
            strokeWidth: 1.25,
            lineCap: "round",
        }),
        layer("cream", "M141 105C145 98 153 96 160 101S170 114 164 121H145C138 117 137 111 141 105Z"),
        layer("cream", rect(31, 135, 4, 4)),
    ], {
        transform: v3HairlineTransform,
        rasterScale: 3,
        lines: [{ axis: "h", at: 70.37, start: 8, end: 181 }, {
            axis: "v",
            at: 75.61,
            start: 8,
            end: 140,
        }],
        probes: [
            {
                name: "transparent-outer-outline", ...mapPoint(v3HairlineTransform, 24.375, 74.125),
                paint: "ink",
            },
            {
                name: "transparent-inner-outline", ...mapPoint(v3HairlineTransform, 56.125, 49.875),
                paint: "navy",
            },
            {
                name: "thin-dark-hairline", ...mapPoint(v3HairlineTransform, 170.875, 36.125),
                paint: "slate",
                kind: "accent",
            },
            {
                name: "small-opaque-accent", ...mapPoint(v3HairlineTransform, 33.5, 137.5),
                paint: "cream",
                kind: "accent",
            },
        ],
        crops: [{ name: "hairline-curves", x: 116, y: 15, width: 68, height: 66 }],
    }),
];

const validation4 = [
    scene("v4-crossing-ribbons", {
        paper: "#f4eddf",
        plum: "#49334e",
        jade: "#33796e",
        apricot: "#d28759",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("plum", "M18 43C34 22 57 18 78 27C101 37 117 61 108 81C101 96 81 97 72 85C64 73 72 61 83 62C92 63 96 71 91 78", {
            strokeWidth: 12,
            lineCap: "round",
        }),
        layer("plum", "M18 43L7 32L13 52Z"),
        layer("plum", "M91 78L106 85L99 68Z"),
        layer("jade", "M111 32C130 16 159 22 171 42C183 62 173 87 155 96C139 104 119 96 116 81C113 69 121 60 132 61C141 62 145 69 142 76L132 79C131 72 124 72 124 79C124 85 133 91 144 87C156 83 163 68 158 54C152 38 133 32 120 42Z"),
        layer("apricot", "M39 118C46 107 59 106 67 114C75 123 73 136 63 143H39C32 137 33 126 39 118Z"),
    ], {
        transform: v4RibbonTransform,
        rasterScale: 3,
        lines: [{ axis: "h", at: 78.37, start: 7, end: 182 }, {
            axis: "v",
            at: 106.61,
            start: 7,
            end: 156,
        }],
        probes: [
            { name: "tapered-ribbon", ...mapPoint(v4RibbonTransform, 30.5, 33.5), paint: "plum" },
            {
                name: "tight-ribbon-turn", ...mapPoint(v4RibbonTransform, 87.5, 34.5),
                paint: "plum",
            },
            {
                name: "crossing-loop", ...mapPoint(v4RibbonTransform, 154.625, 47.625),
                paint: "jade",
            },
            {
                name: "detached-curved-paint", ...mapPoint(v4RibbonTransform, 50.5, 127.5),
                paint: "apricot",
            },
        ],
        crops: [{ name: "crossing-ribbons", x: 50, y: 27, width: 106, height: 77 }],
    }),
    scene("v4-notched-slivers", {
        paper: "#f7f0e6",
        charcoal: "#283444",
        clay: "#a8504d",
        coral: "#d37868",
        cream: "#e3cfa5",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("charcoal", "M16 22H94L128 57L91 93H16Z"),
        layer("clay", "M94 22H174V58H128Z"),
        layer("coral", "M91 93L128 58H174V120H91Z"),
        layer("cream", "M23 112L74 83L84 87L31 120Z"),
        layer("paper", "M129 67L158 91L129 113Z"),
    ], {
        transform: v4NotchTransform,
        rasterScale: 2,
        lines: [{ axis: "h", at: 58.37, start: 7, end: 183 }, {
            axis: "v",
            at: 92.61,
            start: 7,
            end: 151,
        }],
        probes: [
            { name: "notched-body", ...mapPoint(v4NotchTransform, 48.5, 50.5), paint: "charcoal" },
            { name: "upper-sliver", ...mapPoint(v4NotchTransform, 147.5, 39.5), paint: "clay" },
            { name: "lower-wedge", ...mapPoint(v4NotchTransform, 148.5, 106.5), paint: "coral" },
            {
                name: "acute-paper-notch", ...mapPoint(v4NotchTransform, 143.5, 88.5),
                paint: "paper",
            },
        ],
        crops: [{ name: "acute-notch", x: 116, y: 49, width: 58, height: 74 }],
    }),
    scene("v4-dark-spectrum-accents", {
        paper: "#f0e8d8",
        black: "#151923",
        navy: "#222a39",
        slate: "#313b4b",
        pale: "#d5c28f",
        nearPale: "#dcc996",
    }, [
        layer("paper", rect(0, 0, width, height)),
        layer("black", "M17 24C17 18 22 14 28 14H72V132H28C22 132 17 128 17 122Z"),
        layer("navy", "M72 14H128V132H72Z"),
        layer("slate", "M128 14H171C177 14 181 19 181 25V121C181 127 177 132 171 132H128Z"),
        layer("paper", "M30 42C30 36 35 32 41 32H57V112H41C35 112 30 108 30 102Z"),
        layer("navy", "M137 39C142 32 155 32 161 39L169 48V106L157 114H137Z"),
        layer("pale", rect(101, 46, 4, 4)),
        layer("nearPale", rect(111, 46, 5, 5)),
        layer("pale", "M96 119H151V120H96Z"),
    ], {
        transform: v4DarkTransform,
        rasterScale: 2,
        noiseAmplitude: 3,
        lines: [{ axis: "v", at: 72.37, start: 7, end: 151 }, {
            axis: "v",
            at: 128.61,
            start: 7,
            end: 151,
        }],
        probes: [
            { name: "near-black-panel", ...mapPoint(v4DarkTransform, 45.5, 25.5), paint: "black" },
            { name: "near-navy-panel", ...mapPoint(v4DarkTransform, 97.5, 25.5), paint: "navy" },
            { name: "near-slate-panel", ...mapPoint(v4DarkTransform, 151.5, 25.5), paint: "slate" },
            {
                name: "small-pale-accent", ...mapPoint(v4DarkTransform, 102.5, 47.5),
                paint: "pale",
                kind: "accent",
            },
            {
                name: "near-pale-accent", ...mapPoint(v4DarkTransform, 113.5, 48.5),
                paint: "nearPale",
                kind: "accent",
            },
        ],
        crops: [{ name: "dark-spectrum", x: 16, y: 11, width: 168, height: 130 }],
    }),
    scene("v4-opaque-jpeg-curves", {
        paper: "#faf3e5",
        green: "#2f7057",
        rose: "#c85d63",
        gold: "#d6a13e",
        midpoint: "#867e60",
    }, [
        layer("paper", rect(0, 0, width, height), { lock: true }),
        layer("green", "M22 61C22 36 42 19 67 19C92 19 112 39 110 62C109 78 97 88 82 85C69 83 64 71 70 62C74 56 84 55 88 61", {
            strokeWidth: 11,
            lineCap: "round",
        }),
        layer("green", "M22 61L9 52L14 69Z"),
        layer("rose", "M113 30C129 18 153 23 166 39C178 54 175 77 160 89C146 101 127 97 121 84C116 73 123 62 134 62C142 62 147 69 143 76L134 78C133 71 126 71 127 78C128 84 138 88 146 82C155 75 155 61 148 51C139 38 123 37 114 46Z"),
        layer("gold", "M35 112C43 103 56 102 64 110S73 129 65 137H40C33 132 31 119 35 112Z"),
        layer("midpoint", rect(149, 112, 4, 4)),
    ], {
        jpegQuality: 0.82,
        transform: v4JpegTransform,
        rasterScale: 3,
        lines: [{ axis: "h", at: 62.37, start: 7, end: 181 }, {
            axis: "v",
            at: 110.61,
            start: 7,
            end: 158,
        }],
        probes: [
            {
                name: "opaque-jpeg-loop", ...mapPoint(v4JpegTransform, 31.125, 44.625),
                paint: "green",
            },
            { name: "jpeg-loop-opening", ...mapPoint(v4JpegTransform, 95.5, 63.5), paint: "paper" },
            {
                name: "curved-second-loop", ...mapPoint(v4JpegTransform, 152.5, 54.5),
                paint: "rose",
            },
            {
                name: "tiny-jpeg-accent", ...mapPoint(v4JpegTransform, 150.5, 113.5),
                paint: "midpoint",
                kind: "accent",
            },
        ],
        crops: [{ name: "jpeg-curves", x: 12, y: 18, width: 166, height: 130 }],
    }),
];

const rounds = { diagnostic, validation1, validation2, validation3, validation4 };

export const CAMPAIGN_NOISES = {
    diagnostic: [0, 10, 20, 40],
    validation1: [0, 20, 40],
    validation2: [0, 20, 40],
    validation3: [0, 20, 40],
    validation4: [0, 20, 40],
};

export function getCampaignRound(name) {
    const fixtures = rounds[name];
    if (!fixtures) {
        throw Error(`Unknown campaign round: ${name}`);
    }
    return fixtures.map(fixture => structuredClone(fixture));
}
