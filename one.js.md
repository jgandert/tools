# one.js

[`one.js`](one.js) provides shared browser helpers for the tools. This reference covers its ZIP API and shared regression tests.

## ZIP reading and writing

[`one.js`](one.js) includes ZIP reading and writing adapted from the original `clean-zip` source supplied with this project. Load it with the usual classic `<script src="one.js"></script>`; ZIP support works directly from `file://` and over HTTP(S), without module imports or additional ZIP script requests. It uses native browser compression and has no runtime dependencies. Files and archives stay on the device.

```js
const files = [
    { name: "hello.txt", content: "Hello!" },
    { name: "assets/data.bin", content: new Uint8Array([0, 1, 255]) },
];

await one.zip(files, "my-files.zip");
const blob = await one.zip.create(files);
const archive = await one.zip.open(blob);
console.log(archive.names());
console.log(await archive.text("hello.txt"));
```

Omit the download filename to use `archive-<timestamp>.zip`. `one.zip.create(files, options)` returns a ZIP `Blob`; `one.zip.open(input, options)` indexes an archive without unpacking every entry. `one.zip(files, filename, options)` accepts the same creation options.

File collections can be an array of `{ name, content }` descriptors, a filename-to-content object, or a `Map`. Content can be a string, `Blob`/`File`, `ArrayBuffer`, typed-array view, or a `ReadableStream` of binary chunks. Directory entries have a trailing `/` and empty content. Archive inputs accept the same binary types, including streams. Streams and requested entries are buffered in memory; this is not a streaming archive output API.

The default `compression: "auto"` stores tiny files, uses DEFLATE when it saves space, and falls back to uncompressed STORE if native raw DEFLATE is unavailable. Set `compression: "store"` to disable compression or `compression: "deflate"` to require it. These options can be set per entry. Reading a DEFLATE entry requires native `DecompressionStream("deflate-raw")`; stored entries do not. No JavaScript codec fallback is bundled.

Entry descriptors also accept `mtime: Date` and `comment`; creation options accept an archive `comment`. Timestamps default to 1980-01-01 for reproducible output. Supplied timestamps must fall in 1980-2107. Reading supports ZIP64 metadata, signed and unsigned data descriptors, UTF-8 and legacy CP437 filenames, and Unicode filename extra fields. Writing uses classic ZIP and rejects sizes or entry counts requiring ZIP64. Encryption, split archives, prefixed/self-extracting archives, symlinks, and special files are unsupported. Other compression methods can be listed but cannot be read.

`archive.get(name)` returns an entry or `undefined`; `archive.has(name)` checks for one. Entries expose their sizes and metadata and provide `bytes()`, `text()`, `blob()`, and `arrayBuffer()`. Content reads verify the actual size and CRC-32. `archive.verify()` reads and checks every entry. A read can lower the per-entry byte limit with `{ maxSize }`; text reads also accept `{ encoding, fatal }`, and Blob reads accept `{ type }`.

Both creation and opening accept `{ limits, signal }`. Default limits are 512 MiB per archive, 128 MiB per entry, 512 MiB total uncompressed content, and 10,000 entries. Override `maxArchiveSize`, `maxEntrySize`, `maxTotalSize`, and `maxEntries` in `limits`; an optional `maxCompressionRatio` rejects entries above that ratio. Limits bound bytes, not total process memory. Pass an `AbortSignal` for cooperative cancellation, including on later reads. Synchronous parsing and checksum work cannot be interrupted mid-loop. ZIP errors have `error.name === "ZipError"`; inspect `error.code` to distinguish argument, format, checksum, size-limit, and unsupported-feature failures. Paths that are unsafe or nonportable and duplicate/conflicting paths are rejected rather than renamed. The archive API never extracts to disk.

No server or build step is required for ZIP support. The downloadable framework bundle includes the self-contained `one.js` and the Apache 2.0 `LICENSE`. Code Theme Builder, Favicon Packer, Image Slicer, the framework showcase, SVG Export, and Slides use the shared ZIP helpers and their path checks. Slides retains its stricter presentation limits and writes STORE archives for reading without a native decompressor. For SVG Export, rename source files with nonportable characters or duplicate output names before retrying a ZIP export.

## Testing

Run `bun test one.test.js one.dialog.browser.test.js one.url.browser.test.js` for ZIP checks and the shared dialog and URL regressions. ZIP tests exercise the public helpers from the classic script, with Python 3 and system `unzip` for independent interoperability checks. Installed Playwright/Chromium verifies `file://` creation, reading, downloads, STORE fallback, cancellation, and operation without extra script requests, plus HTTP(S) use and the downloaded framework bundle.
