/**
 * CSV Workbench core: RFC 4180 parsing/serialization, delimiter and header
 * detection, type inference, filtering, stats and export formats.
 * Pure logic, no DOM access, so it can be unit tested with `bun test_csv.js`.
 */

const BOM = "\uFEFF";
const QUOTE = "\"";
const CR = "\r";
const LF = "\n";

export const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];

export const TYPE = {
    NUMBER: "number",
    DATE: "date",
    BOOLEAN: "boolean",
    EMPTY: "empty",
    STRING: "string",
};

const DETECT_SAMPLE_ROWS = 20;
const MAX_ROW_WARNINGS = 15;
const DOMINANT_TYPE_SHARE = 0.6;
const TOP_VALUES_COUNT = 5;

// Stripped before parsing: \s already covers NBSP and narrow NBSP (`1 234,56`),
// plus Swiss apostrophes and currency/percent decoration
const NUMBER_NOISE_RE = /[\s'’€$£¥%]/g;
const EXPONENT_RE = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;
const NUMBER_SHAPE_RE = /^[+-]?\d[\d.,]*$/;
const GROUPED_TAIL_RE = /^\d{3}$/;
const TRAILING_SIGN_RE = /^(\d[\d.,]*)([+-])$/;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const SLASH_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const DOTTED_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

const TRUE_WORDS = new Set(["true", "yes", "y", "wahr", "ja"]);
const FALSE_WORDS = new Set(["false", "no", "n", "falsch", "nein"]);

const RANGE_FILTER_RE = /^(.+?)\.\.(.+)$/;
const COMPARE_FILTER_RE = /^(>=|<=|>|<|=)\s*(.+)$/;

// A candidate sitting between two digits is the fingerprint of a decimal or
// group separator mistaken for a delimiter (`1.234,56` split at the comma).
const SPLIT_NUMBER_LEFT_RE = /\d$/;
const SPLIT_NUMBER_RIGHT_RE = /^\d/;

/* ------------------------------------------------------------------ parsing */

function stripBom(text) {
    return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * Character scanner shared by parsing and delimiter detection.
 * Accepts LF, CRLF and bare CR line endings; `""` inside quotes is an escaped quote.
 */
function scanRows(text, delimiter, maxRows = Infinity) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let rowStarted = false;
    let unterminatedQuote = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inQuotes) {
            if (ch !== QUOTE) {
                field += ch;
                continue;
            }
            if (text[i + 1] === QUOTE) {
                field += QUOTE;
                i++;
                continue;
            }
            inQuotes = false;
            continue;
        }

        if (ch === QUOTE) {
            inQuotes = true;
            rowStarted = true;
            continue;
        }

        if (ch === delimiter) {
            row.push(field);
            field = "";
            rowStarted = true;
            continue;
        }

        // CR of a CRLF pair: the LF closes the row
        if (ch === CR && text[i + 1] === LF) continue;

        if (ch === LF || ch === CR) {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            rowStarted = false;
            if (rows.length >= maxRows) return { rows, unterminatedQuote };
            continue;
        }

        field += ch;
        rowStarted = true;
    }

    if (inQuotes) unterminatedQuote = true;

    // A single trailing newline terminates the last row instead of starting an empty one
    if (rowStarted || field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return { rows, unterminatedQuote };
}

function isBlankRow(cells) {
    return cells.length === 1 && cells[0] === "";
}

function maxRowWidth(rows) {
    let width = 0;
    for (const row of rows) {
        if (row.length > width) width = row.length;
    }
    return width;
}

function padTo(cells, width) {
    while (cells.length < width) cells.push("");
    return cells;
}

function collectRaggedWarnings(entries, expected, warnings) {
    let extra = 0;
    for (const entry of entries) {
        const actual = entry.cells.length;
        if (actual === expected) continue;
        if (warnings.length >= MAX_ROW_WARNINGS) {
            extra++;
            continue;
        }
        const what = actual < expected ? "padded with empty cells" : "widened the table";
        warnings.push(`Line ${entry.line}: ${actual} fields instead of ${expected} — ${what}.`);
    }
    if (extra > 0) warnings.push(`…and ${extra} more rows with an unexpected field count.`);
}

/**
 * @param {string} text raw file/textarea content
 * @param {{delimiter?: string, hasHeader?: boolean}} options
 * @returns {{header: string[]|null, rows: string[][], warnings: string[]}}
 */
export function parseCsv(text, { delimiter = ",", hasHeader = true } = {}) {
    const warnings = [];
    const clean = stripBom(text ?? "");
    if (clean.trim() === "") return { header: null, rows: [], warnings };

    const { rows: raw, unterminatedQuote } = scanRows(clean, delimiter);

    if (unterminatedQuote) {
        warnings.push("Unterminated quoted field: the rest of the input was read as one field.");
    }

    // Blank lines are noise in multi-column data, but a real empty value in single-column data
    const dropBlanks = maxRowWidth(raw) > 1;
    const entries = [];
    raw.forEach((cells, index) => {
        if (dropBlanks && isBlankRow(cells)) return;
        entries.push({ cells, line: index + 1 });
    });

    if (entries.length === 0) return { header: null, rows: [], warnings };

    const headerEntry = hasHeader ? entries.shift() : null;
    const expected = headerEntry ? headerEntry.cells.length : entries[0].cells.length;
    const width = Math.max(expected, maxRowWidth(entries.map((e) => e.cells)));

    collectRaggedWarnings(entries, expected, warnings);

    const rows = entries.map((entry) => padTo(entry.cells, width));
    if (!headerEntry) return { header: null, rows, warnings };

    const header = padTo(headerEntry.cells, width);
    for (let i = 0; i < header.length; i++) {
        if (header[i].trim() === "") header[i] = `Column ${i + 1}`;
    }
    return { header, rows, warnings };
}

/* -------------------------------------------------------------- serializing */

function quoteField(value, delimiter) {
    const text = value ?? "";
    const needsQuotes = text.includes(delimiter) || text.includes(QUOTE)
        || text.includes(LF) || text.includes(CR);
    if (!needsQuotes) return text;
    return QUOTE + text.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
}

/**
 * @param {string[]|null} header
 * @param {string[][]} rows
 * @param {{delimiter?: string, newline?: string}} options
 * @returns {string}
 */
export function serializeCsv(header, rows, { delimiter = ",", newline = LF } = {}) {
    const lines = [];
    if (header) lines.push(header.map((cell) => quoteField(cell, delimiter)).join(delimiter));
    for (const row of rows) {
        lines.push(row.map((cell) => quoteField(cell, delimiter)).join(delimiter));
    }
    if (lines.length === 0) return "";
    return lines.join(newline) + newline;
}

/* ---------------------------------------------------------------- detection */

function modeOf(counts) {
    const tally = new Map();
    for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);

    let best = 0;
    let bestSeen = 0;
    for (const [count, seen] of tally) {
        if (seen > bestSeen || (seen === bestSeen && count > best)) {
            best = count;
            bestSeen = seen;
        }
    }
    return { mode: best, hits: bestSeen };
}

function splitNumberArtifactShare(rows) {
    let affected = 0;
    for (const row of rows) {
        for (let i = 1; i < row.length; i++) {
            const left = row[i - 1].trim();
            const right = row[i].trim();
            if (!SPLIT_NUMBER_LEFT_RE.test(left)) continue;
            if (!SPLIT_NUMBER_RIGHT_RE.test(right)) continue;
            affected++;
            break;
        }
    }
    return rows.length === 0 ? 0 : affected / rows.length;
}

function scoreDelimiter(text, delimiter) {
    const { rows } = scanRows(text, delimiter, DETECT_SAMPLE_ROWS);
    const sample = rows.filter((row) => !isBlankRow(row));
    if (sample.length === 0) return null;

    const { mode, hits } = modeOf(sample.map((row) => row.length));
    if (mode < 2) return null;

    return {
        delimiter,
        consistency: hits / sample.length,
        artifacts: splitNumberArtifactShare(sample),
        fields: mode,
        preference: DELIMITER_CANDIDATES.indexOf(delimiter),
    };
}

function betterScore(a, b) {
    if (a.consistency !== b.consistency) return a.consistency > b.consistency;
    if (a.artifacts !== b.artifacts) return a.artifacts < b.artifacts;
    if (a.fields !== b.fields) return a.fields > b.fields;
    return a.preference < b.preference;
}

/**
 * Scores `, ; \t |` by field-count consistency over the first rows, penalizing
 * splits that look like a thousands separator (`1,234` in a semicolon file).
 * @param {string} text
 * @returns {string} best candidate, comma when nothing splits the input
 */
export function detectDelimiter(text) {
    const clean = stripBom(text ?? "");
    let best = null;
    for (const delimiter of DELIMITER_CANDIDATES) {
        const score = scoreDelimiter(clean, delimiter);
        if (!score) continue;
        if (!best || betterScore(score, best)) best = score;
    }
    return best ? best.delimiter : ",";
}

/**
 * @param {string[][]} rows all rows, first one being the header candidate
 * @returns {boolean} whether the first row looks like a header
 */
export function detectHeader(rows) {
    if (!rows || rows.length === 0) return false;

    const first = rows[0];
    if (first.length === 0) return false;

    // A header cell is always a non-empty, untyped label
    for (const cell of first) {
        if (classifyCell(cell) !== TYPE.STRING) return false;
    }

    const labels = first.map((cell) => cell.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) return false;

    if (rows.length === 1) return true;

    const body = rows.slice(1, 1 + DETECT_SAMPLE_ROWS);
    for (let col = 0; col < first.length; col++) {
        const type = inferColumnType(body.map((row) => row[col] ?? ""));
        if (type === TYPE.NUMBER || type === TYPE.DATE || type === TYPE.BOOLEAN) return true;
    }

    // All-string table: distinct non-empty labels above repeated-ish values still read as a header
    return true;
}

/* ----------------------------------------------------------------- type work */

function splitNumberParts(cleaned) {
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");

    // Both separators present: the rightmost one is the decimal separator
    if (lastDot >= 0 && lastComma >= 0) {
        return lastDot > lastComma ? { decimal: ".", group: "," } : { decimal: ",", group: "." };
    }

    const sep = lastDot >= 0 ? "." : (lastComma >= 0 ? "," : null);
    if (!sep) return { decimal: null, group: null };

    const parts = cleaned.split(sep);
    // Repeated separator, or exactly three trailing digits after digits: grouping
    const grouped = parts.length > 2
        || (GROUPED_TAIL_RE.test(parts[1]) && /\d$/.test(parts[0]));
    return grouped ? { decimal: null, group: sep } : { decimal: sep, group: null };
}

/**
 * Parses `1 234,56`, `1,234.56`, `1234`, `-1.234,50 €` and exponent notation.
 * Ambiguity rule: with both separators the rightmost is the decimal point; with
 * only one it groups when repeated or followed by exactly three digits.
 * @param {string} value
 * @returns {number|null}
 */
export function parseNumber(value) {
    if (typeof value !== "string") return null;

    let text = value.trim();
    if (text === "") return null;
    if (EXPONENT_RE.test(text)) return Number(text);

    text = text.replace(NUMBER_NOISE_RE, "");
    if (text === "") return null;

    let sign = 1;
    if (text.startsWith("-") || text.startsWith("+")) {
        sign = text.startsWith("-") ? -1 : 1;
        text = text.slice(1);
    }

    const trailingSign = TRAILING_SIGN_RE.exec(text);
    if (trailingSign) {
        sign = trailingSign[2] === "-" ? -sign : sign;
        text = trailingSign[1];
    }

    if (!NUMBER_SHAPE_RE.test(sign < 0 ? `-${text}` : text)) return null;

    const { decimal, group } = splitNumberParts(text);
    let normalized = text;
    if (group) normalized = normalized.split(group).join("");
    if (decimal) normalized = normalized.replace(decimal, ".");

    if (!/^\d*\.?\d+$/.test(normalized)) return null;

    const parsed = Number(normalized) * sign;
    return Number.isFinite(parsed) ? parsed : null;
}

function buildDate(year, month, day, hour = 0, minute = 0, second = 0) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;

    // setUTCFullYear preserves years below 100 instead of adding 1900 like Date.UTC.

    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * ISO-ish dates: `2024-05-27`, `2024-05-27T10:00:00Z`, `2024/05/27`, `27.05.2024`.
 * @param {string} value
 * @returns {number|null} UTC timestamp
 */
export function parseDate(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text === "") return null;

    const iso = ISO_DATE_RE.exec(text) ?? SLASH_DATE_RE.exec(text);
    if (iso) return buildDate(+iso[1], +iso[2], +iso[3]);

    const stamp = ISO_DATETIME_RE.exec(text);
    if (stamp) {
        const base = buildDate(+stamp[1], +stamp[2], +stamp[3], +stamp[4], +stamp[5], +(stamp[6] ?? 0));
        if (base === null) return null;
        const zone = stamp[7];
        if (!zone) return base;
        if (zone !== "Z") {
            const offset = zone.slice(1).replace(":", "");
            if (+offset.slice(0, 2) > 23 || +offset.slice(2) > 59) return null;
        }

        const timestamp = Date.parse(text.replace(" ", "T"));
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    const dotted = DOTTED_DATE_RE.exec(text);
    if (dotted) return buildDate(+dotted[3], +dotted[2], +dotted[1]);

    return null;
}

/**
 * @param {string} value
 * @returns {boolean|null}
 */
export function parseBoolean(value) {
    if (typeof value !== "string") return null;
    const text = value.trim().toLowerCase();
    if (TRUE_WORDS.has(text)) return true;
    if (FALSE_WORDS.has(text)) return false;
    return null;
}

/**
 * @param {string} value
 * @returns {string} one of TYPE
 */
export function classifyCell(value) {
    if (typeof value !== "string" || value.trim() === "") return TYPE.EMPTY;
    if (parseBoolean(value) !== null) return TYPE.BOOLEAN;
    if (parseDate(value) !== null) return TYPE.DATE;
    if (parseNumber(value) !== null) return TYPE.NUMBER;
    return TYPE.STRING;
}

/**
 * @param {string[]} values
 * @returns {string} dominant non-empty type, STRING when no type reaches 60%
 */
export function inferColumnType(values) {
    const tally = new Map();
    let filled = 0;

    for (const value of values) {
        const type = classifyCell(value);
        if (type === TYPE.EMPTY) continue;
        filled++;
        tally.set(type, (tally.get(type) ?? 0) + 1);
    }

    if (filled === 0) return TYPE.EMPTY;

    let best = TYPE.STRING;
    let bestCount = 0;
    for (const [type, count] of tally) {
        if (count > bestCount) {
            best = type;
            bestCount = count;
        }
    }
    return bestCount / filled >= DOMINANT_TYPE_SHARE ? best : TYPE.STRING;
}

/**
 * @param {string} value
 * @param {string} type
 * @returns {number|null} sortable numeric key, null for empty/unparseable cells
 */
export function sortKey(value, type) {
    if (typeof value !== "string" || value.trim() === "") return null;
    if (type === TYPE.NUMBER) return parseNumber(value);
    if (type === TYPE.DATE) return parseDate(value);
    if (type === TYPE.BOOLEAN) {
        const parsed = parseBoolean(value);
        return parsed === null ? null : Number(parsed);
    }
    return null;
}

/**
 * Compares two cells of a typed column; empty cells always sort last.
 * @returns {number}
 */
export function compareCells(a, b, type) {
    const aEmpty = a === undefined || a === null || a.trim() === "";
    const bEmpty = b === undefined || b === null || b.trim() === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    const keyA = sortKey(a, type);
    const keyB = sortKey(b, type);
    if (keyA !== null && keyB !== null) return keyA - keyB;
    if (keyA !== null) return -1;
    if (keyB !== null) return 1;

    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/* ----------------------------------------------------------------- filtering */

function substringPredicate(term) {
    const needle = term.toLowerCase();
    return (value) => (value ?? "").toLowerCase().includes(needle);
}

function operandKey(text, type) {
    return type === TYPE.DATE ? parseDate(text) : parseNumber(text);
}

function typedPredicate(expression, type) {
    const range = RANGE_FILTER_RE.exec(expression);
    if (range) {
        const low = operandKey(range[1].trim(), type);
        const high = operandKey(range[2].trim(), type);
        if (low === null || high === null) return null;
        return (value) => {
            const key = sortKey(value, type);
            return key !== null && key >= low && key <= high;
        };
    }

    const compare = COMPARE_FILTER_RE.exec(expression);
    if (!compare) return null;

    const bound = operandKey(compare[2].trim(), type);
    if (bound === null) return null;

    const operator = compare[1];
    return (value) => {
        const key = sortKey(value, type);
        if (key === null) return false;
        if (operator === ">") return key > bound;
        if (operator === ">=") return key >= bound;
        if (operator === "<") return key < bound;
        if (operator === "<=") return key <= bound;
        return key === bound;
    };
}

/**
 * Builds a cell predicate: substring for strings, plus `>x`, `<x`, `>=x`, `<=x`,
 * `=x` and `x..y` for numeric/date columns. Falls back to substring matching.
 * @param {string} expression
 * @param {string} type
 * @returns {((value: string) => boolean)|null} null for an empty expression
 */
export function makeCellFilter(expression, type) {
    const term = (expression ?? "").trim();
    if (term === "") return null;

    if (type === TYPE.NUMBER || type === TYPE.DATE) {
        const typed = typedPredicate(term, type);
        if (typed) return typed;
    }
    return substringPredicate(term);
}

/* --------------------------------------------------------------------- stats */

function median(sorted) {
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

function topValues(values) {
    const tally = new Map();
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);

    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
        distinct: tally.size,
        top: ranked.slice(0, TOP_VALUES_COUNT).map(([value, count]) => ({ value, count })),
    };
}

function numericStats(values) {
    const numbers = [];
    for (const value of values) {
        const parsed = parseNumber(value);
        if (parsed !== null) numbers.push(parsed);
    }
    if (numbers.length === 0) return {};

    numbers.sort((a, b) => a - b);
    const sum = numbers.reduce((total, n) => total + n, 0);
    return {
        min: numbers[0],
        max: numbers[numbers.length - 1],
        mean: sum / numbers.length,
        median: median(numbers),
        sum,
    };
}

function dateStats(values) {
    let min = null;
    let max = null;
    for (const value of values) {
        const stamp = parseDate(value);
        if (stamp === null) continue;
        if (min === null || stamp < min.stamp) min = { stamp, value };
        if (max === null || stamp > max.stamp) max = { stamp, value };
    }
    if (!min) return {};
    return { minDate: min.value, maxDate: max.value };
}

function lengthStats(values) {
    if (values.length === 0) return {};
    let shortest = values[0];
    let longest = values[0];
    for (const value of values) {
        if (value.length < shortest.length) shortest = value;
        if (value.length > longest.length) longest = value;
    }
    return { shortest, longest };
}

/**
 * @param {string[]} values all cells of a column (already filtered by the view)
 * @param {string} type column type
 * @returns {object} count/empty/distinct/top plus type specific fields
 */
export function computeStats(values, type) {
    const filled = values.filter((value) => (value ?? "").trim() !== "");
    const { distinct, top } = topValues(filled);
    const base = { count: values.length, empty: values.length - filled.length, distinct, top };

    if (type === TYPE.NUMBER) return { ...base, ...numericStats(filled) };
    if (type === TYPE.DATE) return { ...base, ...dateStats(filled) };
    return { ...base, ...lengthStats(filled) };
}

/* ------------------------------------------------------------------- exports */

function escapeHtml(text) {
    return (text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function escapeMarkdown(text) {
    return (text ?? "")
        .replaceAll("\\", "\\\\")
        .replaceAll("|", "\\|")
        .replaceAll(/\r\n|[\r\n]/g, "<br>");
}

/**
 * @param {string[]|null} header
 * @param {string[][]} rows
 * @returns {string}
 */
export function toJsonObjects(header, rows) {
    const keys = header ?? rows[0]?.map((_, i) => `column_${i + 1}`) ?? [];
    const seen = new Set();
    for (const key of keys) {
        if (seen.has(key)) {
            throw new Error(`JSON objects require unique column names: ${JSON.stringify(key)} is repeated. Rename duplicate columns or choose JSON (array of arrays), CSV, or TSV to preserve every column.`);
        }
        seen.add(key);
    }

    const objects = rows.map((row) => Object.fromEntries(
        keys.map((key, i) => [key, row[i] ?? ""]),
    ));
    return JSON.stringify(objects, null, 2);
}

/**
 * @param {string[]|null} header
 * @param {string[][]} rows
 * @param {boolean} includeHeader
 * @returns {string}
 */
export function toJsonRows(header, rows, includeHeader = true) {
    const all = includeHeader && header ? [header, ...rows] : rows;
    return JSON.stringify(all, null, 2);
}

/**
 * @param {string[]|null} header
 * @param {string[][]} rows
 * @returns {string} GitHub flavored markdown table
 */
export function toMarkdown(header, rows) {
    const width = header?.length ?? maxRowWidth(rows);
    const labels = header ?? Array.from({ length: width }, (_, i) => `Column ${i + 1}`);

    const lines = [
        `| ${labels.map(escapeMarkdown).join(" | ")} |`,
        `| ${labels.map(() => "---").join(" | ")} |`,
    ];
    for (const row of rows) {
        const cells = Array.from({ length: width }, (_, i) => escapeMarkdown(row[i] ?? ""));
        lines.push(`| ${cells.join(" | ")} |`);
    }
    return lines.join(LF) + LF;
}

/**
 * @param {string[]|null} header
 * @param {string[][]} rows
 * @returns {string}
 */
export function toHtmlTable(header, rows) {
    const lines = ["<table>"];
    if (header) {
        const cells = header.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("");
        lines.push("  <thead>", `    <tr>${cells}</tr>`, "  </thead>");
    }
    lines.push("  <tbody>");
    for (const row of rows) {
        const cells = row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
        lines.push(`    <tr>${cells}</tr>`);
    }
    lines.push("  </tbody>", "</table>");
    return lines.join(LF) + LF;
}
