/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// Reserved before any production change based on the round3/4 diagnosis.
// Deliberately not connected to an executed study: these remain untouched.
// Paint paths in insertion order; fill unless strokeWidths specifies a stroke.
// A paper paint means a locked opaque full-canvas background. Otherwise leave
// the background transparent. The hairline path uses the pale paint. Strokes
// use round caps. Transform paths and stroke widths, keeping the paper locked.
// JPEG variation applies only to opaque designs; jitter applies to RGB only.
export const reservedValidation = Object.freeze({
    version: 1,
    dimensions: [176, 148],
    rasterScales: [2, 4],
    noise: [0, 20, 40],
    colorModes: ["auto", "explicit"],
    sourceVariation: ["clean", "jpeg0.79", "deterministic-jitter3"],
    rasterRecipe: "Use campaign-study.js makePaths/renderVector semantics: transform authored paths and stroke widths; keep the paper background locked; rasterize at the selected scale; downsample to native dimensions with imageSmoothingEnabled=true and imageSmoothingQuality=high; then apply a source variation.",
    jpegRecipe: "For jpeg0.79, encode the native-size opaque canvas through Canvas.toBlob(image/jpeg,0.79), decode once and draw at native size, as in campaign-study.js applySourceVariation. Do not apply to transparent designs. No RGB jitter follows JPEG in these reserved profiles.",
    jitterRecipe: "For deterministic-jitter3, use campaign-study.js applySourceVariation with fixture.id=design.id, noiseAmplitude=3, noisePatches=[] and jpegQuality=null: seed state=0x9e3779b9; for each id character state=Math.imul(state^charCode,0x45d9f3b)>>>0; visit RGBA pixels in row-major order, advance xorshift32 with state^=state<<13, state^=state>>>17, state^=state<<5 once per pixel; for RGB channel c add Math.round((((state>>>(c*7))&15)-7)*3/7), clamped to 0..255; preserve alpha.",
    designs: [
        {
            id: "reserved-forked-ridge", transform: [.981, .103, -.103, .981, 8.37, -3.19],
            paints: {
                paper: "#eee6d3",
                ink: "#273a4b",
                blue: "#42788a",
                nearBlue: "#497f91",
                rust: "#bc7356",
            },
            paths: {
                ink: "M14 32L83 38L119 62L114 69L79 47L13 42Z",
                blue: "M83 38L154 14L160 22L91 51Z",
                nearBlue: "M82 50L123 78L148 113L140 118L117 85L76 59Z",
                rust: "M22 106L68 79L79 85L30 118Z",
            },
        },
        {
            id: "reserved-subtle-crescent-marks", transform: [.996, -.041, .041, .996, -2.17, 4.43],
            paints: {
                paper: "#f1e7d5",
                base: "#243145",
                adjacent: "#344254",
                pale: "#d2bc8a",
                nearPale: "#dac592",
            },
            paths: {
                base: "M13 17H158V126H13Z",
                adjacent: "M91 17H158V126H91Z",
                pale: "M102 38Q110 32 116 39L113 43Q108 39 105 44Z",
                nearPale: "M125 42L131 40L133 46L127 48Z",
                hairline: "M27 108L143 109L143 110.1L27 109.1Z",
            },
        },
        {
            id: "reserved-transparent-double-bend",
            transform: [.971, .137, -.137, .971, 12.61, -7.29],
            paints: { ink: "#1d2634", navy: "#2a3648", slate: "#3b495c", cream: "#d8c39b" },
            paths: {
                ink: "M21 67C21 32 53 17 77 27C106 39 104 82 77 101C50 119 22 102 21 67Z",
                navy: "M44 62C46 45 61 39 75 47C90 55 87 76 73 85C58 94 44 82 44 62Z",
                slate: "M119 24C155 26 167 52 147 74C131 92 142 106 159 105",
                cream: "M120 117h5v5h-5Z",
            },
            strokeWidths: { ink: 3.75, navy: 2.1, slate: 1.4 },
        },
        {
            id: "reserved-jpeg-tapered-loop", transform: [.989, -.071, .071, .989, -3.47, 6.21],
            paints: {
                paper: "#f7eddb",
                forest: "#3b735b",
                rose: "#bd626a",
                gold: "#cea34b",
                accent: "#8b8168",
            },
            paths: {
                forest: "M22 64C22 27 64 16 89 37C112 57 99 86 77 78C61 72 68 55 79 58L83 65L74 68",
                rose: "M110 30C141 15 163 41 156 67C149 94 116 97 111 76C107 59 123 50 132 59L129 67C124 61 119 67 123 73C133 85 149 67 143 50C138 37 122 34 111 42Z",
                gold: "M29 111Q49 96 66 111L63 129H34Z",
                accent: "M137 113L142 112L144 117L138 119Z",
            },
        },
    ],
});
