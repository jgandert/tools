// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
/* global Bun, Buffer */

// Original geometric artwork, unrelated to the reference image. Deliberately
// damaged silhouette RGB models fringes from an earlier compositing operation.
export function makeEdgeArtifactArtwork() {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 260;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#138fce";
    ctx.beginPath();
    ctx.arc(235.4, 55.8, 31.6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(101.4, 69.2);
    ctx.lineTo(269.8, 166.4);
    ctx.lineTo(251.6, 197.9);
    ctx.lineTo(83.2, 100.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#e77919";
    ctx.fillRect(24, 24, 32, 196);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const clean = Array.from(image.data);
    for (let y = 1; y < canvas.height - 1; y++) {
        for (let x = 1; x < canvas.width - 1; x++) {
            const p = y * canvas.width + x;
            if (clean[4 * p + 3] < 128 || clean[4 * p] > 100) {
                continue;
            }
            const edge = [-1, 1, -canvas.width, canvas.width].some(offset => clean[4 * (p + offset) + 3] < 128);
            if (edge) {
                image.data.set([100, 175, 197, clean[4 * p + 3]], 4 * p);
            }
        }
    }
    for (let y = 24; y < 27; y++) {
        for (let x = 24; x < 56; x++) {
            image.data.set([204, 38, 49, 255], (y * canvas.width + x) * 4);
        }
    }
    ctx.putImageData(image, 0, 0);
    return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(image.data),
        png: canvas.toDataURL(),
        clean,
    };
}

export function makeTransparentDetailsArtwork(kind) {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    if (kind === "outline") {
        ctx.fillStyle = "#e77919";
        ctx.strokeStyle = "#172238";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(100, 80, 75, 51, .25, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    } else {
        ctx.fillStyle = "#138fce";
        ctx.fillRect(20, 20, 110, 120);
        ctx.fillStyle = "#e77919";
        ctx.fillRect(180, 40, 1.5, 80);
    }
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(image.data),
        png: canvas.toDataURL(),
    };
}

// Original capsule geometry, sampled at pixel centers rather than rasterized by
// canvas. Its diagonal reaches the frame close to a corner with binary alpha.
export function makeClippedBinaryCapsule({ slope = .45, quarterTurns = 0, clipped = true } = {}) {
    const radius = 18;
    const endX = 90;
    const endY = slope * endX + radius * Math.hypot(1, slope) + .05;
    const startX = clipped ? -40 : 24;
    const startY = endY - slope * (endX - startX);
    const sourceWidth = endX + radius + (clipped ? -1 : 9);
    const sourceHeight = Math.ceil(endY + radius + 9);
    const width = quarterTurns % 2 ? sourceHeight : sourceWidth;
    const height = quarterTurns % 2 ? sourceWidth : sourceHeight;
    const data = new Array(width * height * 4).fill(0);
    const dx = endX - startX;
    const dy = endY - startY;
    const lengthSquared = dx * dx + dy * dy;
    for (let y = 0; y < sourceHeight; y++) {
        for (let x = 0; x < sourceWidth; x++) {
            const t = Math.max(0, Math.min(1, ((x + .5 - startX) * dx + (y + .5 - startY) * dy) / lengthSquared));
            if (Math.hypot(x + .5 - startX - t * dx, y + .5 - startY - t * dy) > radius) {
                continue;
            }
            let targetX = x;
            let targetY = y;
            if (quarterTurns === 1) {
                targetX = sourceHeight - 1 - y;
                targetY = x;
            } else if (quarterTurns === 2) {
                targetX = sourceWidth - 1 - x;
                targetY = sourceHeight - 1 - y;
            } else if (quarterTurns === 3) {
                targetX = y;
                targetY = sourceWidth - 1 - x;
            }
            const offset = (targetY * width + targetX) * 4;
            data[offset] = 133;
            data[offset + 1] = 61;
            data[offset + 2] = 194;
            data[offset + 3] = 255;
        }
    }
    return { width, height, data };
}

if (import.meta.main) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const cases = [
            ["edge_artifacts", await page.evaluate(makeEdgeArtifactArtwork)],
            ["transparent_outline_auto", await page.evaluate(makeTransparentDetailsArtwork, "outline")],
            ["transparent_accent_auto", await page.evaluate(makeTransparentDetailsArtwork, "accent")],
        ];
        for (const [name, artwork] of cases) {
            await Bun.write(new URL(`fixtures/${name}.png`, import.meta.url), Buffer.from(artwork.png.split(",")[1], "base64"));
            await Bun.write(new URL(`fixtures/${name}.rgba`, import.meta.url), new Uint8Array(artwork.data));
        }
    } finally {
        await browser.close();
    }
}
