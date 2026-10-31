/*
 * Adapted from the supplied clean-zip tests.
 * Copyright (c) 2026 clean-zip contributors. SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* global Bun, Buffer, process, one */

import { test, describe, beforeAll, beforeEach, afterAll, afterEach, expect } from "bun:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { compileFunction } from "node:vm";
import { pathToFileURL } from "node:url";

const playwrightPath = createRequire(import.meta.url).resolve("playwright", {
    paths: [import.meta.dir, ...(process.env.NODE_PATH || "").split(":").filter(Boolean)],
});
const { chromium } = await import(playwrightPath);
const concat = parts => new Uint8Array(Buffer.concat(parts));

// Execute the classic script in this runtime so codec substitutions reach the
// implementation. Only the shared drawer listener needs a DOM during setup.

const shared = compileFunction(`${await Bun.file(new URL("one.js", import.meta.url)).text()}\nreturn one;`, ["document"])({
    addEventListener() {
    },
});
const api = {
    async createZip(files, options) {
        const blob = await shared.zip.create(files, options);
        assert.ok(blob instanceof Blob);
        assert.equal(blob.type, "application/zip");
        return new Uint8Array(await blob.arrayBuffer());
    },
    openZip: shared.zip.open,
};
const isZipError = error => error instanceof Error && error.name === "ZipError" && typeof error.code === "string";

const encoder = new TextEncoder();
const errorCode = code => error => isZipError(error) && error.code === code;

function locate(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) {
        end--;
    }
    assert.ok(end >= 0);
    const central = view.getUint32(end + 16, true);
    const data = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    return { view, end, central, data };
}

async function stored(content = "hello", name = "x.txt") {
    return api.createZip({ [name]: content }, { compression: "store" });
}

function changeName(bytes, name) {
    const { central } = locate(bytes);
    const encoded = encoder.encode(name);
    bytes.set(encoded, 30);
    bytes.set(encoded, central + 46);
}

test("empty archive and fixed defaults", async () => {
    const bytes = await api.createZip({});
    assert.equal(bytes.length, 22);
    const archive = await api.openZip(bytes);
    assert.equal(archive.size, 0);
    assert.equal(archive.totalSize, 0);
    assert.deepEqual(archive.names(), []);
    await archive.verify();
});

test("STORE and DEFLATE; Unicode; files and directories", async () => {
    for (const compression of ["store", "deflate"]) {
        const bytes = await api.createZip([
            { name: "docs/" }, { name: "docs/日本語 😀.txt", content: "Grüße 🌍" },
            { name: "raw.bin", content: new Uint8Array([0, 17, 255]) }, {
                name: "empty",
                content: "",
            },
        ], { compression, comment: "archive 🌍" });
        const archive = await api.openZip(bytes);
        assert.equal(archive.comment, "archive 🌍");
        assert.equal(archive.size, 4);
        assert.equal(archive.get("docs/").isDirectory, true);
        assert.equal(archive.get("empty").compression, "store");
        assert.equal(await archive.text("docs/日本語 😀.txt"), "Grüße 🌍");
        assert.deepEqual(await archive.read("raw.bin"), new Uint8Array([0, 17, 255]));
        assert.deepEqual([...archive], archive.entries);
        await archive.verify();
    }
});

test("Map, Blob/File-like input, views with offsets, ArrayBuffer", async () => {
    const original = new Uint8Array([99, 1, 2, 88]);
    const files = new Map([
        ["a", new DataView(original.buffer, 1, 2)],
        ["b", new Blob(["hello"])], ["c", new Uint8Array([42]).buffer],
    ]);
    const data = await api.createZip(files);
    const padded = new Uint8Array(data.length + 10);
    padded.set(data, 5);
    const archive = await api.openZip(new DataView(padded.buffer, 5, data.length));
    assert.deepEqual(await archive.read("a"), new Uint8Array([1, 2]));
    assert.equal(await archive.text("b"), "hello");
    assert.equal((await archive.read("c"))[0], 42);
    const fromBlob = await api.openZip(new Blob([data]));
    assert.equal(await fromBlob.text("b"), "hello");
});

test("independent returned buffers and immutable metadata", async () => {
    const bytes = await api.createZip({ x: "abc" }, { compression: "store" });
    const archive = await api.openZip(bytes);
    bytes.fill(0);
    const first = await archive.read("x");
    first.fill(0);
    assert.equal(await archive.text("x"), "abc");
    assert.equal(Object.isFrozen(archive), true);
    assert.equal(Object.isFrozen(archive.entries), true);
    assert.equal(Object.isFrozen(archive.get("x")), true);
    assert.throws(() => archive.entries.push(null), TypeError);
    assert.throws(() => {
        archive.get("x").name = "bad";
    }, TypeError);
});

test("text, Blob, ArrayBuffer, missing names", async () => {
    const archive = await api.openZip(await api.createZip({ x: "hi" }));
    const entry = archive.get("x");
    assert.equal(await (await entry.blob({ type: "text/plain" })).text(), "hi");
    assert.deepEqual(new Uint8Array(await entry.arrayBuffer()), encoder.encode("hi"));
    assert.equal(archive.has("missing"), false);
    assert.equal(archive.get("missing"), undefined);
    await assert.rejects(archive.read("missing"), errorCode("ERR_NOT_FOUND"));
    assert.throws(() => archive.get(123), errorCode("ERR_ARGUMENT"));
    await assert.rejects(entry.text({ encoding: "not-an-encoding" }), errorCode("ERR_ARGUMENT"));
});

test("deterministic default timestamp; supplied timestamp and comments", async () => {
    const a = await api.createZip({ x: "hello".repeat(20) });
    const b = await api.createZip({ x: "hello".repeat(20) });
    assert.deepEqual(a, b);
    const mtime = new Date("2024-06-07T08:09:11.000Z");
    const archive = await api.openZip(await api.createZip([{
        name: "x",
        content: "x",
        mtime,
        comment: "hello 💛",
    }]));
    assert.equal(archive.get("x").mtime.toISOString(), mtime.toISOString());
    archive.get("x").mtime.setFullYear(2000);
    assert.equal(archive.get("x").mtime.toISOString(), mtime.toISOString());
    assert.equal(archive.get("x").comment, "hello 💛");
});

test("no eager content inflation, CRC verified on read", async () => {
    const data = await stored();
    data[locate(data).data] ^= 1;
    const archive = await api.openZip(data);
    assert.equal(archive.size, 1);
    await assert.rejects(archive.read("x.txt"), errorCode("ERR_CRC"));
    await assert.rejects(archive.verify(), errorCode("ERR_CRC"));
});

test("metadata limits before reading", async () => {
    const bytes = await api.createZip({ a: "abcd", b: "efgh" });
    for (const limits of [
        { maxArchiveSize: 1 }, { maxEntrySize: 3 }, { maxTotalSize: 7 }, { maxEntries: 1 },
    ]) {
        await assert.rejects(api.openZip(bytes, { limits }), errorCode("ERR_LIMIT"));
    }
    const archive = await api.openZip(bytes);
    await assert.rejects(archive.read("a", { maxSize: 3 }), errorCode("ERR_LIMIT"));
});

test("writer limits", async () => {
    for (const limits of [
        { maxArchiveSize: 1 }, { maxEntrySize: 3 }, { maxTotalSize: 7 }, { maxEntries: 1 },
    ]) {
        await assert.rejects(api.createZip({
            a: "abcd",
            b: "efgh",
        }, { limits }), errorCode("ERR_LIMIT"));
    }
    await assert.rejects(api.createZip({ a: "x".repeat(1000) }, { limits: { maxArchiveSize: 110 } }), errorCode("ERR_LIMIT"));
    await assert.rejects(api.createZip({ a: "日本語" }, { limits: { maxEntrySize: 5 } }), errorCode("ERR_LIMIT"));
});

test("enforce output limit even when declared sizes are lies", async () => {
    const bytes = await api.createZip({ x: "x".repeat(1024 * 1024) });
    const { view, central } = locate(bytes);
    view.setUint32(22, 1, true);
    view.setUint32(central + 24, 1, true);
    const archive = await api.openZip(bytes);
    await assert.rejects(archive.read("x"), errorCode("ERR_LIMIT"));
});

test("ratio limits are configurable", async () => {
    const bytes = await api.createZip({ x: "x".repeat(10000) });
    await assert.rejects(api.openZip(bytes, { limits: { maxCompressionRatio: 2 } }), errorCode("ERR_LIMIT"));
    await assert.rejects(api.createZip({ x: "x".repeat(10000) }, { limits: { maxCompressionRatio: 2 } }), errorCode("ERR_LIMIT"));
});

test("abort before work and before completion", async () => {
    const controller = new AbortController();
    controller.abort("test");
    await assert.rejects(api.createZip({ x: "x" }, { signal: controller.signal }), errorCode("ERR_ABORTED"));
    await assert.rejects(api.openZip(await stored(), { signal: controller.signal }), errorCode("ERR_ABORTED"));
    const archive = await api.openZip(await stored());
    await assert.rejects(archive.read("x.txt", { signal: controller.signal }), errorCode("ERR_ABORTED"));
    const mid = new AbortController();
    const task = api.createZip({ x: randomBytes(2 * 1024 * 1024) }, { signal: mid.signal });
    mid.abort();
    await assert.rejects(task, errorCode("ERR_ABORTED"));
});

test("mixed compression and unsupported member methods", async () => {
    const bytes = await api.createZip([{
        name: "a",
        content: "A",
        compression: "store",
    }, { name: "b", content: "B", compression: "deflate" }]);
    let archive = await api.openZip(bytes);
    assert.equal(archive.get("a").method, 0);
    assert.equal(archive.get("b").method, 8);
    const changed = await stored();
    const { view, central } = locate(changed);
    view.setUint16(8, 12, true);
    view.setUint16(central + 10, 12, true);
    archive = await api.openZip(changed);
    assert.equal(archive.get("x.txt").compression, "method-12");
    await assert.rejects(archive.read("x.txt"), errorCode("ERR_UNSUPPORTED"));
});

test("invalid UTF-8 file content can be read as bytes or strict text", async () => {
    const archive = await api.openZip(await api.createZip({ x: new Uint8Array([0xff]) }));
    assert.equal(await archive.text("x"), "\ufffd");
    await assert.rejects(archive.text("x", { fatal: true }), errorCode("ERR_ENCODING"));
});

test("truncated or trailing compressed stream is rejected", async () => {
    const bytes = await api.createZip({ x: "hello".repeat(100) });
    const { view, central } = locate(bytes);
    // Make the compressed region shorter and leave the last byte as a gap.

    const length = view.getUint32(18, true) - 1;
    view.setUint32(18, length, true);
    view.setUint32(central + 20, length, true);
    await assert.rejects((await api.openZip(bytes)).read("x"), errorCode("ERR_FORMAT"));
    // Overwrite an equal-length payload with a valid shorter stream plus junk.

    const trailing = await stored("x".repeat(100));
    const t = locate(trailing);
    t.view.setUint16(8, 8, true);
    t.view.setUint16(t.central + 10, 8, true);
    const compressed = deflateRawSync("x".repeat(100));
    trailing.fill(0, t.data, t.central);
    trailing.set(compressed, t.data);
    await assert.rejects((await api.openZip(trailing)).read("x.txt"), errorCode("ERR_FORMAT"));
});

test("CRC-32 known-answer vectors are written to entry metadata", async () => {
    const archive = await api.openZip(await api.createZip({
        empty: "",
        digits: "123456789",
        sentence: "The quick brown fox jumps over the lazy dog",
    }));
    assert.equal(archive.get("empty").crc32, 0);
    assert.equal(archive.get("digits").crc32, 0xcbf43926);
    assert.equal(archive.get("sentence").crc32, 0x414fa339);
});

test("Unsafe names are rejected on write and read", async () => {
    for (const name of ["../x", "/x", "a/../x", "a\\x", "C:x", "a//x", "./x", "x\0x", "x\nx", "CON", "a/nul.txt", "a/x.", "a/x ", "a?b"]) {
        await assert.rejects(api.createZip({ [name]: "x" }), errorCode("ERR_PATH"));
    }
    const bytes = await stored("abc", "abcd");
    changeName(bytes, "../x");
    await assert.rejects(api.openZip(bytes), errorCode("ERR_PATH"));
});

test("Duplicate names and ancestor file conflicts are rejected in either order", async () => {
    for (const names of [["x", "x"], ["x", "x/"], ["x", "x/y"], ["x/y", "x"]]) {
        await assert.rejects(api.createZip(names.map(name => ({
                name,
                content: name.endsWith("/") ? "" : "x",
            }))),
            error => ["ERR_DUPLICATE", "ERR_PATH"].includes(error.code));
    }
    const bytes = await api.createZip({ a: "x", b: "x" }, { compression: "store" });
    const { view, central } = locate(bytes);
    const secondCentral = central + 47;
    const secondLocal = view.getUint32(secondCentral + 42, true);
    bytes[secondLocal + 30] = 97;
    bytes[secondCentral + 46] = 97;
    await assert.rejects(api.openZip(bytes), errorCode("ERR_DUPLICATE"));
});

test("Input and option validation is explicit", async () => {
    for (const input of [null, undefined, 42, "a.zip"]) {
        await assert.rejects(api.openZip(input), errorCode("ERR_ARGUMENT"));
    }
    for (const files of [null, undefined, "path"]) {
        await assert.rejects(api.createZip(files), errorCode("ERR_ARGUMENT"));
    }
    for (const options of [null, { compression: "gzip" }, { levle: 5 }, { level: 12 }, { signal: {} }, { limits: { maxEntrySize: NaN } }, { limits: { maxArchiveSize: -1 } }, { limits: { maxEntries: Infinity } }, { limits: { maxCompressionRatio: NaN } }]) {
        await assert.rejects(api.createZip({ x: "x" }, options), errorCode("ERR_ARGUMENT"));
    }
    await assert.rejects(api.createZip([{
        name: "x/",
        content: "not empty",
    }]), errorCode("ERR_ARGUMENT"));
    await assert.rejects(api.createZip([{
        name: "x",
        content: "a",
        mtime: new Date("bad"),
    }]), errorCode("ERR_ARGUMENT"));
    await assert.rejects(api.createZip([{
        name: "x",
        content: "a",
        mtime: new Date("1970-01-01"),
    }]), errorCode("ERR_ARGUMENT"));
    await assert.rejects(api.createZip({ "\ud800": "a" }), errorCode("ERR_ARGUMENT"));

});

test("Filename and comment byte lengths are checked before 16-bit overflow", async () => {
    await assert.rejects(api.createZip({ ["a".repeat(65536)]: "" }), errorCode("ERR_LIMIT"));
    await assert.rejects(api.createZip({ x: "" }, { comment: "語".repeat(22000) }), errorCode("ERR_LIMIT"));
});

test("Every truncation of a small ZIP fails with a library error", async () => {
    const bytes = await stored();
    for (let length = 0; length < bytes.length; length++) {
        await assert.rejects(api.openZip(bytes.subarray(0, length)), error => isZipError(error));
    }
    await assert.rejects(api.openZip(concat([bytes, new Uint8Array([0])])), errorCode("ERR_FORMAT"));
});

test("Local filename, method, sizes and CRC must match central metadata", async () => {
    for (const [offset, value, bits] of [[30, 121, 8], [8, 8, 16], [22, 4, 32], [14, 1, 32]]) {
        const bytes = await stored();
        const view = locate(bytes).view;
        if (bits === 8) {
            bytes[offset] = value;
        } else if (bits === 16) {
            view.setUint16(offset, value, true);
        } else {
            view.setUint32(offset, value, true);
        }
        await assert.rejects(api.openZip(bytes), errorCode("ERR_FORMAT"));
    }
});

test("Encryption, symlinks, split archives and malformed extra fields fail explicitly", async () => {
    const encryption = await stored();
    let t = locate(encryption);
    t.view.setUint16(t.central + 8, 0x801, true);
    await assert.rejects(api.openZip(encryption), errorCode("ERR_UNSUPPORTED"));
    const symlink = await stored();
    t = locate(symlink);
    t.view.setUint32(t.central + 38, (0o120777 << 16) >>> 0, true);
    await assert.rejects(api.openZip(symlink), errorCode("ERR_UNSUPPORTED"));
    const split = await stored();
    t = locate(split);
    t.view.setUint16(t.end + 4, 1, true);
    await assert.rejects(api.openZip(split), errorCode("ERR_UNSUPPORTED"));
    const malformed = await api.createZip([{
        name: "x",
        content: "",
        mtime: new Date("2024-01-01"),
    }]);
    t = locate(malformed);
    t.view.setUint16(t.central + 46 + 1 + 2, 0xffff, true);
    await assert.rejects(api.openZip(malformed), errorCode("ERR_FORMAT"));
});

test("Central directory bounds, counts, offsets and overlap are checked", async () => {
    for (const mutate of [
        t => t.view.setUint32(t.end + 16, 0xffffff00, true),
        t => t.view.setUint16(t.end + 10, 100, true),
        t => t.view.setUint32(t.central + 42, t.central, true),
        t => t.view.setUint32(t.central + 20, 0xfffffff0, true),
    ]) {
        const bytes = await stored();
        mutate(locate(bytes));
        await assert.rejects(api.openZip(bytes), error => isZipError(error));
    }
});

test("ZIP-like bytes in archive comments do not shadow the actual end record", async () => {
    const fakeEnd = "\x50\x4b\x05\x06" + "\0".repeat(18);
    const bytes = await api.createZip({ x: "abc" }, { comment: `comment${fakeEnd}` });
    const archive = await api.openZip(bytes);
    assert.equal(await archive.text("x"), "abc");
});

test("Valid-looking local records nested inside another member are rejected as overlaps", async () => {
    const inner = await stored("inside", "inner");
    const innerLocation = locate(inner);
    const innerLocal = inner.subarray(0, innerLocation.central);
    const outer = await stored(innerLocal, "outer");
    const outerLocation = locate(outer);
    const innerCentral = new Uint8Array(inner.subarray(innerLocation.central, innerLocation.end));
    new DataView(innerCentral.buffer).setUint32(42, outerLocation.data, true);
    const end = new Uint8Array(outer.subarray(outerLocation.end));
    const endView = new DataView(end.buffer);
    endView.setUint16(8, 2, true);
    endView.setUint16(10, 2, true);
    endView.setUint32(12, outerLocation.end - outerLocation.central + innerCentral.length, true);
    const overlapping = concat([outer.subarray(0, outerLocation.end), innerCentral, end]);
    await assert.rejects(api.openZip(overlapping), error => error.code === "ERR_FORMAT" && /Overlapping/.test(error.message));
});

test("ZIP64 end records: round trip, missing locator, and unsafe 64-bit values", async () => {
    const classic = await stored();
    const { end: start, central } = locate(classic);
    const wide = new Uint8Array(56), locator = new Uint8Array(20);
    const view = new DataView(wide.buffer), lv = new DataView(locator.buffer);
    view.setUint32(0, 0x06064b50, true);
    view.setBigUint64(4, 44n, true);
    view.setUint16(12, 45, true);
    view.setUint16(14, 45, true);
    view.setBigUint64(24, 1n, true);
    view.setBigUint64(32, 1n, true);
    view.setBigUint64(40, BigInt(start - central), true);
    view.setBigUint64(48, BigInt(central), true);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(start), true);
    lv.setUint32(16, 1, true);
    const end = new Uint8Array(classic.subarray(start)), ev = new DataView(end.buffer);
    ev.setUint16(8, 0xffff, true);
    ev.setUint16(10, 0xffff, true);
    ev.setUint32(12, 0xffffffff, true);
    ev.setUint32(16, 0xffffffff, true);
    const bytes = concat([classic.subarray(0, start), wide, locator, end]);
    const archive = await api.openZip(bytes);
    assert.equal(archive.zip64, true);
    assert.equal(await archive.text("x.txt"), "hello");
    const missing = concat([classic.subarray(0, start), end]);
    await assert.rejects(api.openZip(missing), errorCode("ERR_FORMAT"));
    const huge = new Uint8Array(bytes);
    new DataView(huge.buffer).setBigUint64(start + 32, 1n << 63n, true);
    await assert.rejects(api.openZip(huge), errorCode("ERR_LIMIT"));
});

test("automatic compression stores tiny and incompressible files", async () => {
    const random = randomBytes(8192);
    const archive = await api.openZip(await api.createZip({
        tiny: "hi",
        random,
        repeated: "hello".repeat(1000),
    }));
    assert.equal(archive.get("tiny").method, 0);
    assert.equal(archive.get("random").method, 0);
    assert.equal(archive.get("repeated").method, 8);
    assert.deepEqual(await archive.read("random"), new Uint8Array(random));
});

test("automatic compression accepts an incompressible file at the exact archive limit", async () => {
    const content = randomBytes(8192);
    const storedBytes = await api.createZip({ x: content }, { compression: "store" });
    const bytes = await api.createZip({ x: content }, { limits: { maxArchiveSize: storedBytes.length } });
    const archive = await api.openZip(bytes);
    assert.equal(archive.get("x").method, 0);
    assert.deepEqual(await archive.read("x"), new Uint8Array(content));
});

test.each([undefined, class {
    constructor() {
        throw new TypeError("Unsupported format");
    }
}])(
    "automatic writing uses STORE when raw DEFLATE is unavailable: %s",
    async unavailable => {
        const native = globalThis.CompressionStream;
        try {
            globalThis.CompressionStream = unavailable;
            const archive = await api.openZip(await api.createZip({ x: "hello".repeat(1000) }));
            assert.equal(archive.get("x").method, 0);
            assert.equal(await archive.text("x"), "hello".repeat(1000));
            await assert.rejects(api.createZip({ x: "hello" }, { compression: "deflate" }), errorCode("ERR_UNSUPPORTED"));
        } finally {
            globalThis.CompressionStream = native;
        }
    },
);

test("stored entries remain readable without a decompressor", async () => {
    const storedBytes = await stored();
    const compressedBytes = await api.createZip({ x: "hello" }, { compression: "deflate" });
    const native = globalThis.DecompressionStream;
    try {
        globalThis.DecompressionStream = undefined;
        assert.equal(await (await api.openZip(storedBytes)).text("x.txt"), "hello");
        await assert.rejects((await api.openZip(compressedBytes)).read("x"), errorCode("ERR_UNSUPPORTED"));
    } finally {
        globalThis.DecompressionStream = native;
    }
});

test("large files round-trip through native compression and bounded stream inputs", async () => {
    const content = encoder.encode("large streamed file\n".repeat(100000));
    let position = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (position === content.length) {
                controller.close();
                return;
            }
            const end = Math.min(position + 4096, content.length);
            controller.enqueue(content.subarray(position, end));
            position = end;
        },
    });
    const bytes = await api.createZip([{ name: "assets/data.txt", content: stream }]);
    assert.equal(stream.locked, false);
    const archive = await api.openZip(new Blob([bytes]).stream());
    assert.deepEqual(await archive.read("assets/data.txt"), content);
});

test("stream byte limits cancel input and release its lock", async () => {
    let canceled = false;
    const stream = new ReadableStream({
        pull(controller) {
            controller.enqueue(new Uint8Array(10));
        },
        cancel() {
            canceled = true;
        },
    });
    await assert.rejects(api.createZip({ x: stream }, { limits: { maxEntrySize: 15 } }), errorCode("ERR_LIMIT"));
    assert.equal(canceled, true);
    assert.equal(stream.locked, false);
});

test("abort cancels a stream waiting for its next chunk", async () => {
    let canceled = false;
    const stream = new ReadableStream({
        cancel() {
            canceled = true;
        },
    });
    const controller = new AbortController();
    const promise = api.createZip({ x: stream }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(promise, errorCode("ERR_ABORTED"));
    assert.equal(canceled, true);
    assert.equal(stream.locked, false);
});

test("abort while the compression stream consumes input rejects the operation", async () => {
    const NativeCompressionStream = globalThis.CompressionStream;
    const controller = new AbortController();
    let receivedInput = false;
    try {
        globalThis.CompressionStream = class {
            constructor(format) {
                const native = new NativeCompressionStream(format);
                const gate = new TransformStream({
                    transform(chunk, output) {
                        receivedInput = true;
                        controller.abort();
                        output.enqueue(chunk);
                    },
                });
                this.writable = gate.writable;
                this.readable = gate.readable.pipeThrough(native);
            }
        };
        await assert.rejects(api.createZip({ x: "abort me ".repeat(10000) }, {
            signal: controller.signal,
            compression: "deflate",
        }), errorCode("ERR_ABORTED"));
        assert.equal(receivedInput, true);
    } finally {
        globalThis.CompressionStream = NativeCompressionStream;
    }
});

test("invalid chunks and failed streams produce actionable errors", async () => {
    const invalid = new ReadableStream({
        start(controller) {
            controller.enqueue("text");
        },
    });
    await assert.rejects(api.createZip({ x: invalid }), errorCode("ERR_ARGUMENT"));
    const failed = new ReadableStream({
        start(controller) {
            controller.error(new Error("Input failed"));
        },
    });
    await assert.rejects(api.openZip(failed), errorCode("ERR_ARGUMENT"));
    assert.equal(invalid.locked, false);
    assert.equal(failed.locked, false);
});

async function zipWithDeflate(content, compressed) {
    const original = await api.createZip({ x: content }, { compression: "store" });
    const { data, central, end } = locate(original);
    const localBytes = original.slice(0, data);
    const centralBytes = original.slice(central, end);
    const endBytes = original.slice(end);
    const localView = new DataView(localBytes.buffer);
    const centralView = new DataView(centralBytes.buffer);
    localView.setUint16(8, 8, true);
    localView.setUint32(18, compressed.length, true);
    centralView.setUint16(10, 8, true);
    centralView.setUint32(20, compressed.length, true);
    new DataView(endBytes.buffer).setUint32(16, data + compressed.length, true);
    return concat([localBytes, compressed, centralBytes, endBytes]);
}

test("independent DEFLATE streams cover all block types, levels, and strategies", async () => {
    let seed = 20261005;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
    };
    const blockTypes = new Set();
    for (let sample = 0; sample < 50; sample++) {
        const input = Uint8Array.from({ length: sample < 5 ? sample : 8000 }, (_, i) => sample % 3 === 0 ? i % 3 : random());
        const compressed = deflateRawSync(input, { level: sample % 10, strategy: sample % 5 });
        blockTypes.add((compressed[0] >>> 1) & 3);
        const bytes = await zipWithDeflate(input, compressed);
        assert.deepEqual(await (await api.openZip(bytes)).read("x"), input);
        const trailing = await zipWithDeflate(input, concat([compressed, new Uint8Array([0])]));
        await assert.rejects((await api.openZip(trailing)).read("x"), errorCode("ERR_FORMAT"));
        const truncated = await zipWithDeflate(input, compressed.subarray(0, -1));
        await assert.rejects((await api.openZip(truncated)).read("x"), errorCode("ERR_FORMAT"));
    }
    assert.deepEqual([...blockTypes].sort(), [0, 1, 2]);
});

test("seeded ZIP mutations never escape as raw parser exceptions", async () => {
    const original = await api.createZip({
        a: "alpha",
        "b/c": "beta",
        d: new Uint8Array([0, 1, 2]),
    });
    let seed = 12345;
    for (let sample = 0; sample < 500; sample++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const bytes = original.slice();
        bytes[seed % bytes.length] ^= 1 << (sample % 8);
        try {
            await (await api.openZip(bytes, {
                limits: {
                    maxEntrySize: 1024,
                    maxTotalSize: 4096,
                },
            })).verify();
        } catch (error) {
            assert.ok(isZipError(error), `${error.name}: ${error.message}`);
        }
    }
});

const pythonFixtures = `
import io, json, struct, zipfile, zlib, base64
class NonSeekable(io.BytesIO):
    def seekable(self): return False
    def seek(self, *args): raise io.UnsupportedOperation("not seekable")
fixtures = {}
for name, method in [("stored", zipfile.ZIP_STORED), ("deflated", zipfile.ZIP_DEFLATED)]:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=method) as archive:
        archive.writestr("docs/caf\\u00e9.txt", "Hello \\U0001f30d")
        archive.writestr("empty", b"")
    fixtures[name] = output.getvalue()
for name, wide in [("descriptor", False), ("descriptor64", True)]:
    output = NonSeekable()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        with archive.open("stream.txt", "w", force_zip64=wide) as member:
            member.write(b"streamed data")
    fixtures[name] = output.getvalue()
unsigned = bytearray(fixtures["descriptor"])
end = len(unsigned) - 22
central = struct.unpack_from("<I", unsigned, end + 16)[0]
del unsigned[central-16:central-12]
struct.pack_into("<I", unsigned, end - 4 + 16, central - 4)
fixtures["unsigned"] = bytes(unsigned)
output = io.BytesIO()
threshold = zipfile.ZIP64_LIMIT
zipfile.ZIP64_LIMIT = 0
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("wide.txt", b"small ZIP64 file")
zipfile.ZIP64_LIMIT = threshold
fixtures["zip64"] = output.getvalue()
output = io.BytesIO()
with zipfile.ZipFile(output, "w") as archive:
    archive.writestr("aaaa.txt", b"legacy")
legacy = bytearray(output.getvalue())
central = struct.unpack_from("<I", legacy, len(legacy) - 6)[0]
legacy[30:38] = "caf\\u00e9.txt".encode("cp437")
legacy[central+46:central+54] = "caf\\u00e9.txt".encode("cp437")
fixtures["cp437"] = bytes(legacy)
output = io.BytesIO()
info = zipfile.ZipInfo("fallback.txt")
payload = b"\\x01" + struct.pack("<I", zlib.crc32(b"fallback.txt")) + "\\u65e5\\u672c\\u8a9e.txt".encode()
info.extra = struct.pack("<HH", 0x7075, len(payload)) + payload
with zipfile.ZipFile(output, "w") as archive:
    archive.writestr(info, b"unicode extra")
fixtures["unicode"] = output.getvalue()
print(json.dumps({k:base64.b64encode(v).decode() for k,v in fixtures.items()}))
`;

test("reads independently generated Python ZIPs, descriptors, ZIP64, and legacy filenames", async () => {
    const result = spawnSync("python3", ["-c", pythonFixtures], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const fixtures = JSON.parse(result.stdout);
    for (const name of ["stored", "deflated"]) {
        const archive = await api.openZip(Buffer.from(fixtures[name], "base64"));
        assert.equal(await archive.text("docs/caf\u00e9.txt"), "Hello \u{1f30d}");
        assert.equal(await archive.text("empty"), "");
    }
    for (const name of ["descriptor", "descriptor64", "unsigned"]) {
        assert.equal(await (await api.openZip(Buffer.from(fixtures[name], "base64"))).text("stream.txt"), "streamed data");
    }
    const wide = await api.openZip(Buffer.from(fixtures.zip64, "base64"));
    assert.equal(wide.zip64, true);
    assert.equal(await wide.text("wide.txt"), "small ZIP64 file");
    assert.equal(await (await api.openZip(Buffer.from(fixtures.cp437, "base64"))).text("caf\u00e9.txt"), "legacy");
    assert.equal(await (await api.openZip(Buffer.from(fixtures.unicode, "base64"))).text("\u65e5\u672c\u8a9e.txt"), "unicode extra");
});

test("Python and system unzip independently read generated archives", async () => {
    const folder = await mkdtemp(join(tmpdir(), "one-zip-test-"));
    try {
        for (const compression of ["store", "deflate", "auto"]) {
            const bytes = await api.createZip({
                "docs/": "",
                "docs/caf\u00e9.txt": "Hello \u{1f30d}",
                binary: new Uint8Array([0, 1, 255]),
                empty: "",
            }, { compression });
            const checked = spawnSync("python3", ["-c", `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    assert archive.read("docs/caf\\u00e9.txt") == "Hello \\U0001f30d".encode()
    assert archive.read("binary") == bytes([0,1,255])
    assert archive.read("empty") == b""
`], { input: bytes, encoding: "utf8" });
            assert.equal(checked.status, 0, checked.stderr);
            const file = join(folder, `${compression}.zip`);
            await Bun.write(file, bytes);
            const unzipped = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
            assert.equal(unzipped.status, 0, unzipped.stdout + unzipped.stderr);
        }
    } finally {
        await rm(folder, { recursive: true });
    }
});

describe("browser integration", () => {
    let browser;
    let server;
    let page;
    let pageErrors;
    let requests;
    let fixtureFolder;
    let fixtureUrl;

    beforeAll(async () => {
        const files = new Map([
            ["/shared/one.js", new URL("one.js", import.meta.url)],
            ...["one.js", "one.css", "LICENSE", "Inter-VariableFont_opsz,wght.ttf", "material-symbols.woff2", "one_css/index.html"]
                .map(file => [`/${file}`, new URL(file, import.meta.url)]),
        ]);
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                if (path === "/tools/zip/index.html") {
                    return new Response("<!doctype html><html lang=\"en\"><head><base href=\"/other/\"></head><body><script src=\"/shared/one.js\"></script></body></html>", {
                        headers: { "Content-Type": "text/html" },
                    });
                }
                const file = files.get(path);
                return file ? new Response(Bun.file(file), { headers: { "Cache-Control": "no-store" } }) : new Response(null, { status: 404 });
            },
        });
        fixtureFolder = await mkdtemp(join(tmpdir(), "one-file-browser-test-"));
        fixtureUrl = pathToFileURL(join(fixtureFolder, "index.html"));
        await Bun.write(fixtureUrl, `<!doctype html><html lang="en"><head><meta charset="UTF-8"><base href="other/"></head><body><script src="${new URL("one.js", import.meta.url).href}"></script></body></html>`);
        browser = await chromium.launch({ headless: true });
    });

    beforeEach(async () => {
        requests = [];
        page = await browser.newPage({ acceptDownloads: true });
        pageErrors = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("request", request => requests.push({
            url: request.url(),
            type: request.resourceType(),
        }));
        await page.route("**/*", route => {
            const request = route.request();
            const url = new URL(request.url());
            if (request.resourceType() === "script" && url.pathname.split("/").pop() !== "one.js") {
                return route.abort();
            }
            return url.protocol === "file:" || url.origin === server.url.origin ? route.continue() : route.abort();
        });
        await page.goto(fixtureUrl.href);
    });

    afterEach(async () => {
        await page?.close();
        expect(pageErrors).toEqual([]);
        expect(requests.filter(request => request.type === "script" && new URL(request.url).pathname.split("/").pop() !== "one.js")).toEqual([]);
    });

    afterAll(async () => {
        await browser?.close();
        server?.stop(true);
        if (fixtureFolder) {
            await rm(fixtureFolder, { recursive: true });
        }
    });

    test.each(["file", "http"])("one.js creates concurrent archives over %s without additional requests", async protocol => {
        if (protocol === "http") {
            await page.goto(new URL("tools/zip/index.html", server.url).href);
        }
        assert.equal(new URL(page.url()).protocol, `${protocol}:`);
        const initialRequests = requests.slice();
        const result = await page.evaluate(async () => {
            const [a, b] = await Promise.all([
                one.zip.create([{ name: "a.txt", content: "A" }]),
                one.zip.create({ "b.txt": "B" }),
            ]);
            return [a.type, await (await one.zip.open(a)).text("a.txt"), await (await one.zip.open(b)).text("b.txt")];
        });
        expect(result).toEqual(["application/zip", "A", "B"]);
        expect(requests).toEqual(initialRequests);
    });

    const compressionCases = ["file", "http"].flatMap(protocol => ["native", "unavailable", "unsupported"].map(mode => [protocol, mode]));
    test.each(compressionCases)("%s round trips with %s compression", async (protocol, mode) => {
        if (protocol === "http") {
            await page.goto(new URL("tools/zip/index.html", server.url).href);
        }
        const initialRequests = requests.slice();
        const result = await page.evaluate(async mode => {
            if (mode === "unavailable") {
                window.CompressionStream = undefined;
            }
            if (mode === "unsupported") {
                window.CompressionStream = class {
                    constructor() {
                        throw new TypeError("Unsupported");
                    }
                };
            }
            const text = "browser compression ".repeat(10000);
            const blob = await one.zip.create({ "docs/caf\u00e9.txt": text });
            const archive = await one.zip.open(blob);
            return [await archive.text("docs/caf\u00e9.txt"), archive.get("docs/caf\u00e9.txt").method];
        }, mode);
        expect(result).toEqual(["browser compression ".repeat(10000), mode === "native" ? 8 : 0]);
        expect(requests).toEqual(initialRequests);
    });

    const downloadCases = ["file", "http"].flatMap(protocol => ["explicit", "default"].map(mode => [protocol, mode]));
    test.each(downloadCases)("%s one.zip downloads a valid archive with %s naming and cleans up", async (protocol, mode) => {
        if (protocol === "http") {
            await page.goto(new URL("tools/zip/index.html", server.url).href);
        }
        assert.equal(new URL(page.url()).protocol, `${protocol}:`);
        const initialRequests = requests.slice();
        await page.evaluate(() => {
            window.revokedUrls = [];
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = url => {
                window.revokedUrls.push(url);
                revoke(url);
            };
        });
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.evaluate(mode => one.zip({ "download.txt": "Downloaded" }, mode === "explicit" ? "my-files.zip" : undefined), mode),
        ]);
        const archive = await api.openZip(await Bun.file(await download.path()).arrayBuffer());
        assert.equal(await archive.text("download.txt"), "Downloaded");
        if (mode === "explicit") {
            assert.equal(download.suggestedFilename(), "my-files.zip");
        } else {
            assert.match(download.suggestedFilename(), /^archive-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.zip$/);
        }
        await page.waitForFunction(() => window.revokedUrls.length === 1);
        assert.equal(await page.locator("a[download]").count(), 0);
        expect(requests).toEqual(initialRequests);
    });

    test("invalid ZIP input rejects without downloading", async () => {
        const downloads = [];
        page.on("download", download => downloads.push(download));
        const error = await page.evaluate(async () => {
            try {
                await one.zip({ "../unsafe": "x" });
            } catch (error) {
                return error.code;
            }
        });
        assert.equal(error, "ERR_PATH");
        assert.equal(downloads.length, 0);
    });

    test("file:// cancellation rejects without downloading and leaves helpers usable", async () => {
        const downloads = [];
        page.on("download", download => downloads.push(download));
        const result = await page.evaluate(async () => {
            const controller = new AbortController();
            controller.abort("test");
            try {
                await one.zip({ x: "hello" }, "aborted.zip", { signal: controller.signal });
            } catch (error) {
                const archive = await one.zip.open(await one.zip.create({ x: "hello" }));
                return [error.name, error.code, error.cause, await archive.text("x"), typeof one.getTimestamp()];
            }
        });
        expect(result).toEqual(["ZipError", "ERR_ABORTED", "test", "hello", "string"]);
        expect(downloads).toEqual([]);
    });

    test("browser reads reject corrupt data and forged decompression sizes", async () => {
        const corrupt = await stored();
        corrupt[locate(corrupt).data] ^= 1;
        const oversized = await api.createZip({ x: "x".repeat(100000) });
        const { view, central } = locate(oversized);
        view.setUint32(22, 1, true);
        view.setUint32(central + 24, 1, true);
        const result = await page.evaluate(async inputs => {
            const errors = [];
            for (const input of inputs) {
                try {
                    await (await one.zip.open(new Uint8Array(input))).verify();
                } catch (error) {
                    errors.push(error.code);
                }
            }
            return errors;
        }, [Array.from(corrupt), Array.from(oversized)]);
        expect(result).toEqual(["ERR_CRC", "ERR_LIMIT"]);
    });

    test.each([false, true])("framework download includes self-contained one.js and its license, STORE fallback=%s", async fallback => {
        if (fallback) {
            await page.addInitScript(() => {
                window.CompressionStream = undefined;
            });
        }
        await page.goto(new URL("one_css/index.html", server.url).href);
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator("#download-zip-btn").click(),
        ]);
        const archive = await api.openZip(await Bun.file(await download.path()).arrayBuffer());
        expect(archive.names().sort()).toEqual([
            "Inter-VariableFont_opsz,wght.ttf", "LICENSE", "index.html", "material-symbols.woff2", "one.css", "one.js",
        ]);
        assert.equal(await archive.text("one.js"), await Bun.file(new URL("one.js", import.meta.url)).text());
        assert.equal(await archive.text("LICENSE"), await Bun.file(new URL("LICENSE", import.meta.url)).text());
        const bundleFolder = join(fixtureFolder, "bundle");
        for (const entry of archive) {
            await Bun.write(join(bundleFolder, entry.name), await entry.bytes());
        }
        await page.goto(pathToFileURL(join(bundleFolder, "index.html")).href);
        expect(await page.locator("#download-zip-btn, #download-zip-link").count()).toBe(0);
        const initialRequests = requests.slice();
        const result = await page.evaluate(async () => {
            const blob = await one.zip.create({ "bundle.txt": "Packaged ZIP support" });
            return [blob.type, await (await one.zip.open(blob)).text("bundle.txt")];
        });
        expect(result).toEqual(["application/zip", "Packaged ZIP support"]);
        expect(requests).toEqual(initialRequests);
    });
});
