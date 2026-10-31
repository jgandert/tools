import { expect, test } from "bun:test";
import { encodeFaviconIco } from "./ico.js";

test("the ICO directory preserves the PNG payload and identifies a single 32x32 image", async () => {
    const png = new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), "payload"], { type: "image/png" });
    const ico = encodeFaviconIco(png);
    expect(ico.type).toBe("image/vnd.microsoft.icon");
    const bytes = Buffer.from(await ico.arrayBuffer());
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBe(1);
    expect([...bytes.subarray(6, 10)]).toEqual([32, 32, 0, 0]);
    expect(bytes.readUInt16LE(10)).toBe(1);
    expect(bytes.readUInt16LE(12)).toBe(32);
    const size = bytes.readUInt32LE(14);
    const offset = bytes.readUInt32LE(18);
    expect(offset).toBe(22);
    expect(size).toBe(png.size);
    expect(offset + size).toBe(bytes.length);
    expect(bytes.subarray(offset)).toEqual(Buffer.from(await png.arrayBuffer()));
});
