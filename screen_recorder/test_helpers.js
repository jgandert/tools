import {
    pickMimeType,
    formatDuration,
    formatBytes,
    makeFilename,
    clampTrimRange,
    describeAudio,
    describeVideoTrack,
    MIME_CANDIDATES,
} from "./helpers.js";

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(msg);
        console.log(`  FAIL: ${msg}`);
    }
}

function assertEq(actual, expected, msg) {
    assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function supporting(...supported) {
    const set = new Set(supported);
    return (type) => set.has(type);
}

// =============================================================================
// pickMimeType
// =============================================================================
console.log("\n=== pickMimeType ===");
{
    const all = supporting(...MIME_CANDIDATES);
    assertEq(pickMimeType(all), "video/webm;codecs=vp9,opus", "pickMimeType: prefers vp9 when everything is supported");

    const vp8Only = supporting("video/webm;codecs=vp8,opus", "video/webm");
    assertEq(pickMimeType(vp8Only), "video/webm;codecs=vp8,opus", "pickMimeType: falls back to vp8 without vp9");

    const bareOnly = supporting("video/webm");
    assertEq(pickMimeType(bareOnly), "video/webm", "pickMimeType: falls back to bare webm");

    assertEq(pickMimeType(supporting()), "", "pickMimeType: empty string when nothing is supported");
    assertEq(pickMimeType(undefined), "", "pickMimeType: empty string without a probe function");
    assertEq(pickMimeType(null), "", "pickMimeType: empty string for null probe");

    const seen = [];
    pickMimeType((type) => {
        seen.push(type);
        return false;
    });
    assertEq(seen.join("|"), MIME_CANDIDATES.join("|"), "pickMimeType: probes candidates in preference order");
}

// =============================================================================
// formatDuration
// =============================================================================
console.log("\n=== formatDuration ===");
{
    assertEq(formatDuration(0), "0:00", "formatDuration: 0s");
    assertEq(formatDuration(9), "0:09", "formatDuration: pads single-digit seconds");
    assertEq(formatDuration(59), "0:59", "formatDuration: 59s");
    assertEq(formatDuration(60), "1:00", "formatDuration: exactly one minute");
    assertEq(formatDuration(61), "1:01", "formatDuration: 61s");
    assertEq(formatDuration(61.9), "1:01", "formatDuration: truncates fractional seconds");
    assertEq(formatDuration(599), "9:59", "formatDuration: just below ten minutes");
    assertEq(formatDuration(3599), "59:59", "formatDuration: just below an hour stays m:ss");
    assertEq(formatDuration(3600), "1:00:00", "formatDuration: exactly one hour switches to h:mm:ss");
    assertEq(formatDuration(3661), "1:01:01", "formatDuration: 1h 1m 1s");
    assertEq(formatDuration(36000), "10:00:00", "formatDuration: ten hours");
    assertEq(formatDuration(-5), "0:00", "formatDuration: negative clamps to zero");
    assertEq(formatDuration(Infinity), "--:--", "formatDuration: Infinity (unseeked WebM) is not a time");
    assertEq(formatDuration(NaN), "--:--", "formatDuration: NaN is not a time");
    assertEq(formatDuration(undefined), "--:--", "formatDuration: undefined is not a time");
}

// =============================================================================
// formatBytes
// =============================================================================
console.log("\n=== formatBytes ===");
{
    assertEq(formatBytes(0), "0 B", "formatBytes: zero");
    assertEq(formatBytes(-1), "0 B", "formatBytes: negative clamps to zero");
    assertEq(formatBytes(1), "1 B", "formatBytes: single byte");
    assertEq(formatBytes(1023), "1023 B", "formatBytes: just below the KB boundary");
    assertEq(formatBytes(1024), "1.0 KB", "formatBytes: KB boundary");
    assertEq(formatBytes(1536), "1.5 KB", "formatBytes: one and a half KB");
    assertEq(formatBytes(1024 * 1024 - 1), "1024.0 KB", "formatBytes: just below the MB boundary");
    assertEq(formatBytes(1024 * 1024), "1.0 MB", "formatBytes: MB boundary");
    assertEq(formatBytes(5 * 1024 * 1024 + 512 * 1024), "5.5 MB", "formatBytes: fractional MB");
    assertEq(formatBytes(1024 ** 3), "1.0 GB", "formatBytes: GB boundary");
    assertEq(formatBytes(2 * 1024 ** 3), "2.0 GB", "formatBytes: two GB (the stop-and-save warning size)");
    assertEq(formatBytes(1024 ** 4), "1.0 TB", "formatBytes: TB boundary");
    assertEq(formatBytes(1024 ** 5), "1024.0 TB", "formatBytes: stays in TB beyond the largest unit");
    assertEq(formatBytes(Infinity), "0 B", "formatBytes: Infinity is treated as no data");
    assertEq(formatBytes(NaN), "0 B", "formatBytes: NaN is treated as no data");
}

// =============================================================================
// makeFilename
// =============================================================================
console.log("\n=== makeFilename ===");
{
    const date = new Date(2026, 6, 28, 9, 5, 3);
    assertEq(makeFilename(date), "rec_2026-07-28_09-05-03.webm", "makeFilename: zero-pads month, day and clock parts");
    assertEq(makeFilename(date), makeFilename(new Date(2026, 6, 28, 9, 5, 3)), "makeFilename: deterministic for a fixed date");
    assertEq(makeFilename(date, "trimmed"), "rec_2026-07-28_09-05-03_trimmed.webm", "makeFilename: optional suffix");
    assertEq(makeFilename(date, ""), makeFilename(date), "makeFilename: empty suffix adds nothing");

    const december = new Date(2026, 11, 31, 23, 59, 59);
    assertEq(makeFilename(december), "rec_2026-12-31_23-59-59.webm", "makeFilename: two-digit month and 24h clock");

    const newYear = new Date(2027, 0, 1, 0, 0, 0);
    assertEq(makeFilename(newYear), "rec_2027-01-01_00-00-00.webm", "makeFilename: midnight on new year");
}

// =============================================================================
// clampTrimRange
// =============================================================================
console.log("\n=== clampTrimRange ===");
{
    const untouched = clampTrimRange(2, 8, 10, "start");
    assertEq(untouched.start, 2, "clampTrimRange: valid range keeps start");
    assertEq(untouched.end, 8, "clampTrimRange: valid range keeps end");

    const pushedEnd = clampTrimRange(9.99, 8, 10, "start", 0.5);
    assert(pushedEnd.end - pushedEnd.start >= 0.499, "clampTrimRange: dragging start past end keeps the minimum span");
    assert(pushedEnd.end <= 10, "clampTrimRange: pushed end stays inside the duration");

    const pushedStart = clampTrimRange(4, 0.1, 10, "end", 0.5);
    assert(pushedStart.end - pushedStart.start >= 0.499, "clampTrimRange: dragging end past start keeps the minimum span");
    assert(pushedStart.start >= 0, "clampTrimRange: pushed start stays at or above zero");

    const clamped = clampTrimRange(-5, 99, 10);
    assertEq(clamped.start, 0, "clampTrimRange: negative start clamps to zero");
    assertEq(clamped.end, 10, "clampTrimRange: end clamps to the duration");

    const noDuration = clampTrimRange(1, 2, Infinity);
    assertEq(noDuration.start, 0, "clampTrimRange: unknown duration yields an empty range (start)");
    assertEq(noDuration.end, 0, "clampTrimRange: unknown duration yields an empty range (end)");

    const tiny = clampTrimRange(0, 0.05, 0.05, "end", 0.1);
    assert(tiny.start >= 0 && tiny.end <= 0.05, "clampTrimRange: span larger than the clip stays inside it");
}

// =============================================================================
// describeAudio
// =============================================================================
console.log("\n=== describeAudio ===");
{
    assertEq(describeAudio(true, true), "shared audio + microphone", "describeAudio: both sources");
    assertEq(describeAudio(true, false), "shared audio only", "describeAudio: display audio only");
    assertEq(describeAudio(false, true), "microphone only", "describeAudio: mic only");
    assertEq(describeAudio(false, false), "no audio", "describeAudio: silent recording");
}

// =============================================================================
// describeVideoTrack
// =============================================================================
console.log("\n=== describeVideoTrack ===");
{
    assertEq(describeVideoTrack(undefined), "no video track", "describeVideoTrack: missing track");
    assertEq(describeVideoTrack(null), "no video track", "describeVideoTrack: null track");
    assertEq(describeVideoTrack({
        readyState: "live",
        muted: false,
    }), "the video track is live", "describeVideoTrack: healthy track");
    assertEq(describeVideoTrack({
        readyState: "live",
        muted: true,
    }), "the video track is muted — the source delivers no frames", "describeVideoTrack: muted track (portal delivering nothing)");
    assertEq(describeVideoTrack({
        readyState: "ended",
        muted: true,
    }), "the video track has ended", "describeVideoTrack: ended wins over muted");
    assertEq(describeVideoTrack({
        readyState: "ended",
        muted: false,
    }), "the video track has ended", "describeVideoTrack: ended track");
}

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failures.length > 0) {
    console.log("\nFailed assertions:");
    for (const f of failures) {
        console.log(`  - ${f}`);
    }
}
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
