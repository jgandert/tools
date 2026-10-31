/* Local, bounded ZIP reader. ZIP creation uses the shared one.zip helpers.
   Supports stored (0) and DEFLATE (8) entries, including data descriptors. */
(() => {
    "use strict";
    const LIMITS = Object.freeze({
        archive: 32 * 1024 * 1024, total: 64 * 1024 * 1024,
        entry: 16 * 1024 * 1024, entries: 256,
    });
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        crcTable[n] = value >>> 0;
    }

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function safePath(name) {
        if (!name || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith("/") || /^[a-z]:/i.test(name)) {
            throw new Error("The ZIP contains an unsafe file path.");
        }
        const path = name.endsWith("/") ? name.slice(0, -1) : name;
        if (path.split("/").some(part => !part || part === ".." || part === ".")) {
            throw new Error("The ZIP contains an unsafe file path.");
        }
        return name;
    }

    async function inflate(compressed, expected) {
        let stream;
        try {
            stream = new DecompressionStream("deflate-raw");
        } catch {
            throw new Error("This browser cannot open compressed ZIPs. Use a current browser or an uncompressed (stored) ZIP.");
        }
        const reader = new Blob([compressed]).stream().pipeThrough(stream).getReader();
        const chunks = [];
        let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > expected || size > LIMITS.entry) {
                    await reader.cancel();
                    throw new Error("A ZIP entry exceeds its declared or allowed size.");
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        if (size !== expected) throw new Error("A ZIP entry has an incorrect uncompressed size.");
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    }

    async function read(file) {
        if (!file || file.size < 22) throw new Error("Choose a valid presentation ZIP.");
        if (file.size > LIMITS.archive) throw new Error("The ZIP must be no larger than 32 MiB.");
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        const check = (offset, size) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > bytes.length) {
                throw new Error("The ZIP is truncated or malformed.");
            }
        };
        const u16 = offset => {
            check(offset, 2);
            return view.getUint16(offset, true);
        };
        const u32 = offset => {
            check(offset, 4);
            return view.getUint32(offset, true);
        };
        let end = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
            if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
                end = i;
                break;
            }
        }
        if (end < 0) throw new Error("The ZIP directory is missing or damaged.");
        if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) {
            throw new Error("Multi-part ZIPs are not supported.");
        }
        const count = u16(end + 10), directorySize = u32(end + 12), directoryStart = u32(end + 16);
        if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
            throw new Error("Large ZIP64 archives are not supported.");
        }
        if (!count || count > LIMITS.entries) throw new Error("Use a ZIP containing between 1 and 256 entries.");
        check(directoryStart, directorySize);
        if (directoryStart + directorySize > end) throw new Error("The ZIP directory is invalid.");
        const entries = [], names = new Set();
        const utf8 = new TextDecoder("utf-8", { fatal: true });
        let cursor = directoryStart, total = 0;
        for (let i = 0; i < count; i++) {
            check(cursor, 46);
            if (u32(cursor) !== 0x02014b50) throw new Error("The ZIP directory is malformed.");
            const flags = u16(cursor + 8), method = u16(cursor + 10);
            const crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24);
            const nameSize = u16(cursor + 28), extraSize = u16(cursor + 30),
                commentSize = u16(cursor + 32);
            const localOffset = u32(cursor + 42);
            check(cursor + 46, nameSize + extraSize + commentSize);
            if (flags & 1) throw new Error("Encrypted ZIPs are not supported.");
            if (u16(cursor + 34) || compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
                throw new Error("Multi-part or large ZIP64 entries are not supported.");
            }
            if (method !== 0 && method !== 8) throw new Error("Use a stored or DEFLATE-compressed ZIP.");
            if (((u32(cursor + 38) >>> 16) & 0xf000) === 0xa000) throw new Error("ZIP symlinks are not supported.");
            let name;
            try {
                name = safePath(utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize)));
            } catch (error) {
                throw new Error(error.message.includes("unsafe") ? error.message : "ZIP filenames must use UTF-8 or ASCII.");
            }
            if (names.has(name.toLowerCase())) throw new Error("The ZIP contains duplicate or ambiguous filenames.");
            names.add(name.toLowerCase());
            total += size;
            if (size > LIMITS.entry || total > LIMITS.total) throw new Error("The uncompressed ZIP is too large (16 MiB per file; 64 MiB total).");
            check(localOffset, 30);
            if (u32(localOffset) !== 0x04034b50 || u16(localOffset + 8) !== method || u16(localOffset + 6) !== flags) {
                throw new Error("A ZIP entry header does not match its directory.");
            }
            const localNameSize = u16(localOffset + 26), localExtraSize = u16(localOffset + 28);
            check(localOffset + 30, localNameSize + localExtraSize);
            if (utf8.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize)) !== name) {
                throw new Error("A ZIP entry filename does not match its directory.");
            }
            const start = localOffset + 30 + localNameSize + localExtraSize;
            check(start, compressed);
            if (start + compressed > directoryStart) throw new Error("A ZIP entry overlaps its directory.");
            entries.push({ name, start, compressed, size, crc, method });
            cursor += 46 + nameSize + extraSize + commentSize;
        }
        if (cursor !== directoryStart + directorySize) throw new Error("The ZIP directory size is inconsistent.");
        const files = new Map();
        for (const entry of entries) {
            const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
            const content = entry.method === 0 ? compressed.slice() : await inflate(compressed, entry.size);
            if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error("A ZIP file is corrupt (size or CRC mismatch): " + entry.name);
            if (!entry.name.endsWith("/") && !entry.name.startsWith("__MACOSX/") && !entry.name.endsWith(".DS_Store")) {
                files.set(entry.name, content);
            }
        }
        const roots = [...files.keys()].filter(name => /(^|\/)slides\.md$/.test(name));
        const candidates = roots.filter(name => files.has(name.slice(0, -9) + "slides.css"));
        if (candidates.length !== 1) throw new Error("The ZIP must contain one slides.md and slides.css pair in the same folder.");
        const prefix = candidates[0].slice(0, -9);
        const normalized = new Map();
        for (const [name, content] of files) {
            if (!name.startsWith(prefix)) throw new Error("Put slides.md, slides.css and their assets in the same root folder.");
            normalized.set(name.slice(prefix.length), content);
        }
        let markdown, css;
        try {
            markdown = utf8.decode(normalized.get("slides.md"));
            css = utf8.decode(normalized.get("slides.css"));
        } catch {
            throw new Error("slides.md and slides.css must be UTF-8 text files.");
        }
        normalized.delete("slides.md");
        normalized.delete("slides.css");
        return { markdown, css, assets: normalized };
    }

    window.presentationZip = Object.freeze({ read, limits: LIMITS });
})();
