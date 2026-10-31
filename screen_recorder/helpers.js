// Pure logic for the Screen Recorder. No DOM, no MediaRecorder — testable with bun.

export const MIME_CANDIDATES = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
];

export const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

const BYTES_PER_UNIT = 1024;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const INVALID_DURATION_TEXT = "--:--";

/**
 * First candidate accepted by the passed MediaRecorder.isTypeSupported.
 * Returns "" when nothing matches, so callers can let the browser choose.
 */
export function pickMimeType(isTypeSupported) {
    if (typeof isTypeSupported !== "function") return "";

    for (const candidate of MIME_CANDIDATES) {
        if (isTypeSupported(candidate)) return candidate;
    }

    return "";
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

/** Seconds as m:ss, or h:mm:ss once an hour is reached. */
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return INVALID_DURATION_TEXT;

    const total = Math.max(0, Math.floor(seconds));
    const secs = total % SECONDS_PER_MINUTE;
    const mins = Math.floor(total / SECONDS_PER_MINUTE) % SECONDS_PER_MINUTE;
    const hours = Math.floor(total / SECONDS_PER_HOUR);

    if (hours > 0) return `${hours}:${pad2(mins)}:${pad2(secs)}`;

    return `${mins}:${pad2(secs)}`;
}

/** Byte count in binary units, whole numbers for bytes and one decimal above. */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

    let value = bytes;
    let unitIndex = 0;

    while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
        value /= BYTES_PER_UNIT;
        unitIndex++;
    }

    if (unitIndex === 0) return `${Math.round(value)} B`;

    return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/** Local-time download name, e.g. rec_2026-07-28_09-05-03.webm */
export function makeFilename(date, suffix = "") {
    const stamp = [
        date.getFullYear(),
        "-",
        pad2(date.getMonth() + 1),
        "-",
        pad2(date.getDate()),
        "_",
        pad2(date.getHours()),
        "-",
        pad2(date.getMinutes()),
        "-",
        pad2(date.getSeconds()),
    ].join("");

    const tail = suffix ? `_${suffix}` : "";

    return `rec_${stamp}${tail}.webm`;
}

/**
 * Keeps an in/out pair ordered and inside [0, duration] while one handle moves.
 * `moved` names the handle the user just dragged; the other one yields.
 */
export function clampTrimRange(start, end, duration, moved = "start", minSpan = 0.1) {
    if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };

    const span = Math.min(minSpan, duration);
    const inBounds = (value) => Math.min(Math.max(value, 0), duration);

    let nextStart = inBounds(Number.isFinite(start) ? start : 0);
    let nextEnd = inBounds(Number.isFinite(end) ? end : duration);

    if (nextEnd - nextStart >= span) return { start: nextStart, end: nextEnd };

    if (moved === "start") {
        nextEnd = inBounds(nextStart + span);
        nextStart = inBounds(nextEnd - span);
        return { start: nextStart, end: nextEnd };
    }

    nextStart = inBounds(nextEnd - span);
    nextEnd = inBounds(nextStart + span);

    return { start: nextStart, end: nextEnd };
}

/**
 * Why a capture source might be producing nothing, from what its video track
 * reports. A muted track means the source hands the browser no frames (on
 * Linux/Wayland typically the PipeWire/xdg-desktop-portal share failing) and
 * MediaRecorder encodes nothing without ever raising an error.
 */
export function describeVideoTrack(track) {
    if (!track) return "no video track";
    if (track.readyState === "ended") return "the video track has ended";
    if (track.muted) return "the video track is muted — the source delivers no frames";

    return "the video track is live";
}

/** Human summary of what audio actually made it into the recording. */
export function describeAudio(hasDisplayAudio, hasMicAudio) {
    if (hasDisplayAudio && hasMicAudio) return "shared audio + microphone";
    if (hasDisplayAudio) return "shared audio only";
    if (hasMicAudio) return "microphone only";

    return "no audio";
}
