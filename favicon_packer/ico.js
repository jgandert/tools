function encodeFaviconIco(pngBlob) {
    const headerSize = 22;
    const header = new Uint8Array(headerSize);
    const view = new DataView(header.buffer);

    // One 32x32, 32-bit PNG image follows the ICO directory entry.
    view.setUint16(2, 1, true);
    view.setUint16(4, 1, true);
    view.setUint8(6, 32);
    view.setUint8(7, 32);
    view.setUint16(10, 1, true);
    view.setUint16(12, 32, true);
    view.setUint32(14, pngBlob.size, true);
    view.setUint32(18, headerSize, true);

    return new Blob([header, pngBlob], { type: "image/vnd.microsoft.icon" });
}

// Classic loading keeps local-file use working; Bun tests import the same encoder.

if (typeof module !== "undefined") {
    module.exports = { encodeFaviconIco };
}
