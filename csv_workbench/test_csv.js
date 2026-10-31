import {
    TYPE,
    classifyCell,
    compareCells,
    computeStats,
    detectDelimiter,
    detectHeader,
    inferColumnType,
    makeCellFilter,
    parseCsv,
    parseDate,
    parseNumber,
    serializeCsv,
    toHtmlTable,
    toJsonObjects,
    toJsonRows,
    toMarkdown,
} from "./csv.js";

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

function assertEqual(actual, expected, msg) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    assert(same, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// =============================================================================
// basic parsing
// =============================================================================
console.log("\n=== basic parsing ===");
{
    const r = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    assertEqual(r.header, ["a", "b", "c"], "basic: header");
    assertEqual(r.rows, [["1", "2", "3"], ["4", "5", "6"]], "basic: rows");
    assertEqual(r.warnings, [], "basic: no warnings");

    const noHeader = parseCsv("1,2\n3,4", { hasHeader: false });
    assert(noHeader.header === null, "basic: header null when hasHeader=false");
    assertEqual(noHeader.rows, [["1", "2"], ["3", "4"]], "basic: headerless rows");

    const trailing = parseCsv("a,b\n1,2\n");
    assertEqual(trailing.rows, [["1", "2"]], "basic: single trailing newline is a terminator");

    const noTrailing = parseCsv("a,b\n1,2");
    assertEqual(noTrailing.rows, [["1", "2"]], "basic: missing trailing newline");

    const emptyTail = parseCsv("a,b\n1,");
    assertEqual(emptyTail.rows, [["1", ""]], "basic: trailing empty field kept");

    const blanks = parseCsv("a,b\n1,2\n\n3,4\n");
    assertEqual(blanks.rows, [["1", "2"], ["3", "4"]], "basic: blank line dropped in multi-column");

    const headerGap = parseCsv("a,,c\n1,2,3");
    assertEqual(headerGap.header, ["a", "Column 2", "c"], "basic: empty header cell named");
}

// =============================================================================
// quoting
// =============================================================================
console.log("\n=== quoting ===");
{
    const embeddedDelimiter = parseCsv("a,b\n\"x,y\",z");
    assertEqual(embeddedDelimiter.rows, [["x,y", "z"]], "quoting: embedded delimiter");

    const embeddedNewline = parseCsv("a,b\n\"line1\nline2\",z\n");
    assertEqual(embeddedNewline.rows, [["line1\nline2", "z"]], "quoting: embedded newline");

    const embeddedQuote = parseCsv("a,b\n\"say \"\"hi\"\"\",z");
    assertEqual(embeddedQuote.rows, [["say \"hi\"", "z"]], "quoting: doubled quotes");

    const quotedEmpty = parseCsv("a,b\n\"\",z");
    assertEqual(quotedEmpty.rows, [["", "z"]], "quoting: quoted empty field");

    const crlfInQuotes = parseCsv("a,b\r\n\"one\r\ntwo\",z\r\n");
    assertEqual(crlfInQuotes.rows, [["one\r\ntwo", "z"]], "quoting: CRLF inside quotes preserved");

    const unterminated = parseCsv("a,b\n\"open,z");
    assert(unterminated.warnings.some((w) => w.includes("Unterminated")),
        "quoting: unterminated quote warns");
    assertEqual(unterminated.rows, [["open,z", ""]], "quoting: unterminated quote keeps data");
}

// =============================================================================
// line endings, BOM
// =============================================================================
console.log("\n=== line endings and BOM ===");
{
    const crlf = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    assertEqual(crlf.header, ["a", "b"], "crlf: header without CR");
    assertEqual(crlf.rows, [["1", "2"], ["3", "4"]], "crlf: rows");

    const cr = parseCsv("a,b\r1,2\r");
    assertEqual(cr.rows, [["1", "2"]], "cr: bare CR line ending");

    const bom = parseCsv("﻿a,b\n1,2\n");
    assertEqual(bom.header, ["a", "b"], "bom: stripped from first header cell");
    assert(detectDelimiter("﻿a;b\n1;2\n") === ";", "bom: detection ignores BOM");
}

// =============================================================================
// ragged rows
// =============================================================================
console.log("\n=== ragged rows ===");
{
    const short = parseCsv("a,b,c\n1,2\n4,5,6\n");
    assertEqual(short.rows, [["1", "2", ""], ["4", "5", "6"]], "ragged: short row padded");
    assert(short.warnings.length === 1, "ragged: one warning for the short row");
    assert(short.warnings[0].includes("Line 2"), `ragged: warning names the line (${short.warnings[0]})`);

    const long = parseCsv("a,b\n1,2,3\n");
    assertEqual(long.rows, [["1", "2", "3"]], "ragged: long row keeps extra data");
    assertEqual(long.header, ["a", "b", "Column 3"], "ragged: header widened with generated name");
    assert(long.warnings.length === 1, "ragged: one warning for the long row");

    const many = parseCsv("a,b,c\n" + "1,2\n".repeat(40));
    assert(many.warnings.length === 16, `ragged: warnings capped (${many.warnings.length})`);
    assert(many.warnings.at(-1).includes("25 more"), "ragged: overflow summary counts the rest");
}

// =============================================================================
// serialize + round trip
// =============================================================================
console.log("\n=== serialize and round trip ===");
{
    assert(serializeCsv(["a"], [["b"]]) === "a\nb\n", "serialize: plain fields unquoted");
    assert(serializeCsv(null, [["x,y"]]) === "\"x,y\"\n", "serialize: quotes on delimiter");
    assert(serializeCsv(null, [["say \"hi\""]]) === "\"say \"\"hi\"\"\"\n", "serialize: doubles quotes");
    assert(serializeCsv(null, [["a\nb"]]) === "\"a\nb\"\n", "serialize: quotes on newline");
    assert(serializeCsv(null, [["a", "b"]], { delimiter: "\t" }) === "a\tb\n", "serialize: tab delimiter");
    assert(serializeCsv(null, [["a"], ["b"]], { newline: "\r\n" }) === "a\r\nb\r\n", "serialize: CRLF newline");
    assert(serializeCsv(null, [["a;b"]], { delimiter: ";" }) === "\"a;b\"\n", "serialize: semicolon quoting");
    assert(serializeCsv(null, [["a,b"]], { delimiter: ";" }) === "a,b\n", "serialize: comma safe in semicolon file");
    assert(serializeCsv(null, []) === "", "serialize: empty data");

    const header = ["name", "note", "amount"];
    const rows = [
        ["Müller", "with,comma", "1.234,56"],
        ["O'Neil", "with \"quotes\"", "-7"],
        ["Multi", "line1\nline2", ""],
        ["", "", "0"],
    ];
    for (const delimiter of [",", ";", "\t", "|"]) {
        for (const newline of ["\n", "\r\n"]) {
            const text = serializeCsv(header, rows, { delimiter, newline });
            const back = parseCsv(text, { delimiter });
            assertEqual(back.header, header, `round trip: header (${JSON.stringify(delimiter)}/${JSON.stringify(newline)})`);
            assertEqual(back.rows, rows, `round trip: rows (${JSON.stringify(delimiter)}/${JSON.stringify(newline)})`);
        }
    }

    const single = ["value"];
    const singleRows = [["a"], [""], ["b"]];
    const singleBack = parseCsv(serializeCsv(single, singleRows));
    assertEqual(singleBack.rows, singleRows, "round trip: single column keeps empty value");

    const headerless = [["1", "2"], ["3", "4"]];
    const headerlessBack = parseCsv(serializeCsv(null, headerless), { hasHeader: false });
    assertEqual(headerlessBack.rows, headerless, "round trip: headerless");
}

// =============================================================================
// empty and single column input
// =============================================================================
console.log("\n=== empty and single column ===");
{
    const empty = parseCsv("");
    assert(empty.header === null && empty.rows.length === 0, "empty: nothing parsed");
    assertEqual(parseCsv("\n\n").rows, [], "empty: only newlines");
    assert(detectDelimiter("") === ",", "empty: delimiter falls back to comma");
    assert(detectHeader([]) === false, "empty: no header detected");

    const single = parseCsv("value\n1\n2\n3\n");
    assertEqual(single.header, ["value"], "single column: header");
    assertEqual(single.rows, [["1"], ["2"], ["3"]], "single column: rows");
    assert(single.warnings.length === 0, "single column: no warnings");
    assert(detectDelimiter("value\n1\n2\n") === ",", "single column: detection falls back to comma");
}

// =============================================================================
// delimiter detection
// =============================================================================
console.log("\n=== delimiter detection ===");
{
    assert(detectDelimiter("a,b,c\n1,2,3\n4,5,6\n") === ",", "detect: comma");
    assert(detectDelimiter("a;b;c\n1;2;3\n4;5;6\n") === ";", "detect: semicolon");
    assert(detectDelimiter("a\tb\tc\n1\t2\t3\n") === "\t", "detect: tab");
    assert(detectDelimiter("a|b|c\n1|2|3\n") === "|", "detect: pipe");

    const germanExcel = "Name;Betrag;Datum\nMüller;1.234,56;2024-01-31\nMeier;2.000,00;2024-02-01\n";
    assert(detectDelimiter(germanExcel) === ";", "detect: German Excel export (semicolon + comma decimals)");

    const germanNoHeader = "Müller;1.234,56\nMeier;2.000,00\nSchmidt;900,10\n";
    assert(detectDelimiter(germanNoHeader) === ";",
        "detect: headerless German rows beat the comma decimal tie");

    const quotedDecoy = "\"a,b\";c;d\n\"x,y\";1;2\n\"p,q\";3;4\n";
    assert(detectDelimiter(quotedDecoy) === ";", "detect: commas inside quotes ignored");

    const tabWithCommas = "name\tcity\nA, Inc.\tBerlin\nB, Ltd.\tParis\n";
    assert(detectDelimiter(tabWithCommas) === "\t", "detect: tab wins over commas in values");

    const pipeWithSemicolons = "a|b|c\nx; y|1|2\np; q|3|4\n";
    assert(detectDelimiter(pipeWithSemicolons) === "|", "detect: pipe wins over stray semicolons");

    const crlfSemicolon = "a;b\r\n1;2\r\n3;4\r\n";
    assert(detectDelimiter(crlfSemicolon) === ";", "detect: works with CRLF");
}

// =============================================================================
// header detection
// =============================================================================
console.log("\n=== header detection ===");
{
    const typed = [["name", "amount", "date"], ["Ann", "12.5", "2024-01-01"], ["Bob", "8", "2024-02-03"]];
    assert(detectHeader(typed) === true, "header: labels above typed columns");

    const german = [["Name", "Betrag"], ["Müller", "1.234,56"], ["Meier", "2.000,00"]];
    assert(detectHeader(german) === true, "header: German Excel labels");

    const allStrings = [["city", "country"], ["Berlin", "DE"], ["Paris", "FR"]];
    assert(detectHeader(allStrings) === true, "header: all-string table still has labels");

    const numericFirstRow = [["1", "2", "3"], ["4", "5", "6"]];
    assert(detectHeader(numericFirstRow) === false, "header: numeric first row is data");

    const mixedFirstRow = [["Ann", "12.5"], ["Bob", "8"]];
    assert(detectHeader(mixedFirstRow) === false, "header: typed cell in first row rejects it");

    const emptyCell = [["name", ""], ["Ann", "1"]];
    assert(detectHeader(emptyCell) === false, "header: empty label rejects it");

    const duplicateLabels = [["a", "a"], ["1", "2"]];
    assert(detectHeader(duplicateLabels) === false, "header: duplicate labels reject it");

    const dateFirstRow = [["2024-01-01", "x"], ["2024-01-02", "y"]];
    assert(detectHeader(dateFirstRow) === false, "header: date in first row is data");

    assert(detectHeader([["name", "amount"]]) === true, "header: single row of labels");
}

// =============================================================================
// number parsing
// =============================================================================
console.log("\n=== number parsing ===");
{
    assert(parseNumber("42") === 42, "number: integer");
    assert(parseNumber("-7.5") === -7.5, "number: negative decimal");
    assert(parseNumber("+3") === 3, "number: leading plus");
    assert(parseNumber("1.234,56") === 1234.56, "number: German 1.234,56");
    assert(parseNumber("1,234.56") === 1234.56, "number: English 1,234.56");
    assert(parseNumber("1 234,56") === 1234.56, "number: space grouped");
    assert(parseNumber("1 234,56") === 1234.56, "number: NBSP grouped");
    assert(parseNumber("1 234.56") === 1234.56, "number: narrow NBSP grouped");
    assert(parseNumber("1'234.50") === 1234.5, "number: Swiss apostrophe grouped");
    assert(parseNumber("1,234") === 1234, "number: single comma before three digits groups");
    assert(parseNumber("1.234") === 1234, "number: single dot before three digits groups");
    assert(parseNumber("1,23") === 1.23, "number: single comma before two digits is decimal");
    assert(parseNumber("0,5") === 0.5, "number: German half");
    assert(parseNumber("1.234.567") === 1234567, "number: repeated separator groups");
    assert(parseNumber("-1.234,50 €") === -1234.5, "number: currency suffix stripped");
    assert(parseNumber("1234-") === -1234, "number: trailing sign");
    assert(parseNumber("1e3") === 1000, "number: exponent");
    assert(parseNumber("") === null, "number: empty");
    assert(parseNumber("abc") === null, "number: text");
    assert(parseNumber("12abc") === null, "number: trailing text");
    assert(parseNumber("2024-01-01") === null, "number: date is not a number");
    assert(parseNumber("1.2.3.4") === 1234, "number: dotted groups collapse");
}

// =============================================================================
// date parsing
// =============================================================================
console.log("\n=== date parsing ===");
{
    assert(parseDate("2024-05-27") === Date.UTC(2024, 4, 27), "date: ISO date");
    assert(parseDate("2024/05/27") === Date.UTC(2024, 4, 27), "date: slash ISO");
    assert(parseDate("27.05.2024") === Date.UTC(2024, 4, 27), "date: German dotted");
    assert(parseDate("2024-05-27T10:30") === Date.UTC(2024, 4, 27, 10, 30), "date: ISO datetime");
    assert(parseDate("2024-05-27 10:30:15") === Date.UTC(2024, 4, 27, 10, 30, 15), "date: space datetime");
    assert(parseDate("2024-05-27T10:30:00Z") === Date.UTC(2024, 4, 27, 10, 30), "date: zulu datetime");
    assert(parseDate("2024-13-01") === null, "date: invalid month");
    assert(parseDate("2024-02-30") === null, "date: invalid day");
    assert(parseDate("not a date") === null, "date: text");
    assert(parseDate("1234") === null, "date: bare number");

    const invalidDates = [
        "2024-01-01T12:60",
        "2024-01-01T12:59:60",
        "2024-01-01T12:60Z",
        "2024-01-01T12:59:60+02:00",
        "2024-01-01T23:60",
        "2024-01-01T23:59:60Z",
        "2024-01-01T24:00",
        "2024-01-01T24:00Z",
        "2024-01-01T99:00",
        "2024-01-01T12:00+99:99",
        "2024-01-01T12:00+24:00",
        "2024-01-01T12:00-00:60",
        "2024-01-01T12:00+23:60",
        "2024-01-01T12:00+2400",
        "2024-01-01T12:00-0060",
        "2023-02-29",
        "1900-02-29",
        "0099-02-29",
        "2024-02-30T12:00+02:00",
    ];
    for (const value of invalidDates) {
        assert(parseDate(value) === null, `date: rejects invalid components (${value})`);
        assert(classifyCell(value) === TYPE.STRING, `classify: invalid date remains a string (${value})`);
    }

    const validDates = [
        ["2024-02-29", Date.UTC(2024, 1, 29)],
        ["29.02.2024", Date.UTC(2024, 1, 29)],
        ["2000-02-29", Date.UTC(2000, 1, 29)],
        ["0000-02-29", Date.parse("0000-02-29T00:00:00Z")],
        ["0099-01-01", Date.parse("0099-01-01T00:00:00Z")],
        ["0099-01-01T12:00Z", Date.parse("0099-01-01T12:00:00Z")],
        ["2024-02-29T23:59:59Z", Date.UTC(2024, 1, 29, 23, 59, 59)],
        ["2024-01-01T00:30+02:30", Date.UTC(2023, 11, 31, 22)],
        ["2024-01-01 00:30+0230", Date.UTC(2023, 11, 31, 22)],
        ["2024-01-01T23:30-04:00", Date.UTC(2024, 0, 2, 3, 30)],
        ["2024-01-01T00:00+00:00", Date.UTC(2024, 0, 1)],
        ["2024-01-01T00:00-0000", Date.UTC(2024, 0, 1)],
        ["2024-01-01T00:00+23:59", Date.UTC(2023, 11, 31, 0, 1)],
        ["2024-03-31T02:30", Date.UTC(2024, 2, 31, 2, 30)],
        ["2024-11-03T01:30", Date.UTC(2024, 10, 3, 1, 30)],
    ];
    for (const [value, expected] of validDates) {
        assert(Number.isFinite(expected) && parseDate(value) === expected, `date: valid civil components (${value})`);
    }
}

// =============================================================================
// type inference
// =============================================================================
console.log("\n=== type inference ===");
{
    assert(classifyCell("") === TYPE.EMPTY, "classify: empty");
    assert(classifyCell("   ") === TYPE.EMPTY, "classify: whitespace");
    assert(classifyCell("1.234,56") === TYPE.NUMBER, "classify: German number");
    assert(classifyCell("2024-05-27") === TYPE.DATE, "classify: date");
    assert(classifyCell("true") === TYPE.BOOLEAN, "classify: boolean");
    assert(classifyCell("Ja") === TYPE.BOOLEAN, "classify: German boolean");
    assert(classifyCell("hello") === TYPE.STRING, "classify: string");

    assert(inferColumnType(["1", "2", "", "3"]) === TYPE.NUMBER, "infer: numeric column ignores empties");
    assert(inferColumnType(["1.234,56", "2.000,00", "7,50"]) === TYPE.NUMBER, "infer: German amounts");
    assert(inferColumnType(["2024-01-01", "2024-02-01"]) === TYPE.DATE, "infer: date column");
    assert(inferColumnType(["yes", "no", "yes"]) === TYPE.BOOLEAN, "infer: boolean column");
    assert(inferColumnType(["a", "b", "c"]) === TYPE.STRING, "infer: string column");
    assert(inferColumnType(["", "", ""]) === TYPE.EMPTY, "infer: all empty");
    assert(inferColumnType(["1", "2", "a", "b", "c"]) === TYPE.STRING, "infer: mixed falls back to string");
    assert(inferColumnType(["1", "2", "3", "4", "n/a"]) === TYPE.NUMBER, "infer: dominant numbers win");
    assert(inferColumnType(["2024-01-01T12:60", "2024-01-01T12:59:60", "2024-01-01T12:00+99:99", "2024-01-01", "2024-01-02"]) === TYPE.STRING,
        "infer: invalid datetimes cannot dominate a mixed column as dates");
}

// =============================================================================
// sorting
// =============================================================================
console.log("\n=== sorting ===");
{
    assert(compareCells("2", "10", TYPE.NUMBER) < 0, "sort: numeric order beats lexical");
    assert(compareCells("1.234,56", "999", TYPE.NUMBER) > 0, "sort: German number value");
    assert(compareCells("2024-01-01", "2024-02-01", TYPE.DATE) < 0, "sort: dates");
    assert(compareCells("apple", "Banana", TYPE.STRING) < 0, "sort: case-insensitive strings");
    assert(compareCells("", "x", TYPE.STRING) > 0, "sort: empty last (left)");
    assert(compareCells("x", "", TYPE.STRING) < 0, "sort: empty last (right)");
    assert(compareCells("", "", TYPE.STRING) === 0, "sort: both empty equal");
    assert(compareCells("n/a", "5", TYPE.NUMBER) > 0, "sort: unparseable after parsed values");
    assert(compareCells("2024-01-01T12:60", "2024-02-01", TYPE.DATE) > 0,
        "sort: normalized datetime follows valid dates");
    assert(compareCells("2024-01-01T12:00+99:99", "2024-02-01", TYPE.DATE) > 0,
        "sort: invalid zoned datetime follows valid dates without a NaN comparator");

    const values = ["10", "", "2", "abc", "1"];
    const sorted = [...values].sort((a, b) => compareCells(a, b, TYPE.NUMBER));
    assertEqual(sorted, ["1", "2", "10", "abc", ""], "sort: full numeric column order");
}

// =============================================================================
// filters
// =============================================================================
console.log("\n=== filters ===");
{
    assert(makeCellFilter("", TYPE.STRING) === null, "filter: empty expression is inactive");

    const substring = makeCellFilter("BER", TYPE.STRING);
    assert(substring("Berlin") === true, "filter: case-insensitive substring match");
    assert(substring("Paris") === false, "filter: substring miss");

    const greater = makeCellFilter(">100", TYPE.NUMBER);
    assert(greater("1.234,56") === true, "filter: >100 matches German number");
    assert(greater("50") === false, "filter: >100 rejects smaller");
    assert(greater("") === false, "filter: >100 rejects empty");

    const atMost = makeCellFilter("<=10", TYPE.NUMBER);
    assert(atMost("10") === true, "filter: <=10 inclusive");
    assert(atMost("11") === false, "filter: <=10 exclusive above");

    const range = makeCellFilter("5..10", TYPE.NUMBER);
    assert(range("5") && range("10") && range("7"), "filter: numeric range inclusive");
    assert(range("4") === false && range("11") === false, "filter: numeric range excludes outside");

    const dateRange = makeCellFilter("2024-01-01..2024-01-31", TYPE.DATE);
    assert(dateRange("2024-01-15") === true, "filter: date range match");
    assert(dateRange("2024-02-15") === false, "filter: date range miss");
    assert(dateRange("2024-01-01T12:60") === false, "filter: date range excludes invalid datetime components");

    const afterDate = makeCellFilter(">2024-01-01", TYPE.DATE);
    assert(afterDate("2024-06-01") === true, "filter: date greater-than");

    const equals = makeCellFilter("=42", TYPE.NUMBER);
    assert(equals("42") === true && equals("43") === false, "filter: numeric equality");

    const fallback = makeCellFilter(">abc", TYPE.NUMBER);
    assert(fallback(">abc") === true, "filter: unparseable operand falls back to substring");
}

// =============================================================================
// stats
// =============================================================================
console.log("\n=== stats ===");
{
    const numbers = computeStats(["1", "2", "3", "4", "", "2"], TYPE.NUMBER);
    assert(numbers.count === 6, "stats: count includes empties");
    assert(numbers.empty === 1, "stats: empty count");
    assert(numbers.distinct === 4, "stats: distinct non-empty values");
    assert(numbers.min === 1 && numbers.max === 4, "stats: min/max");
    assert(numbers.sum === 12, "stats: sum");
    assert(numbers.mean === 2.4, "stats: mean");
    assert(numbers.median === 2, "stats: median (odd count)");
    assertEqual(numbers.top[0], { value: "2", count: 2 }, "stats: most frequent value");

    const evenMedian = computeStats(["1", "2", "3", "4"], TYPE.NUMBER);
    assert(evenMedian.median === 2.5, "stats: median (even count)");

    const dates = computeStats(["2024-03-01", "2024-01-01", ""], TYPE.DATE);
    assert(dates.minDate === "2024-01-01" && dates.maxDate === "2024-03-01", "stats: date range");

    const mixedDates = computeStats(["2024-01-01T12:00+99:99", "2024-01-01T12:60", "2024-03-01", "2024-02-01"], TYPE.DATE);
    assert(mixedDates.minDate === "2024-02-01" && mixedDates.maxDate === "2024-03-01", "stats: invalid datetimes cannot contaminate the date range");
    const invalidDates = computeStats(["2024-01-01T12:60", "2024-01-01T12:00+99:99"], TYPE.DATE);
    assert(invalidDates.minDate === undefined && invalidDates.maxDate === undefined, "stats: all-invalid dates have no range");

    const strings = computeStats(["bb", "a", "cccc"], TYPE.STRING);
    assert(strings.shortest === "a" && strings.longest === "cccc", "stats: string lengths");
    assert(strings.top.length === 3, "stats: top list capped at existing values");

    const empty = computeStats([], TYPE.STRING);
    assert(empty.count === 0 && empty.distinct === 0, "stats: empty column");
}

// =============================================================================
// export formats
// =============================================================================
console.log("\n=== export formats ===");
{
    const header = ["a", "b"];
    const rows = [["1", "x|y"], ["2", "line1\nline2"]];

    const markdown = toMarkdown(header, rows);
    assert(markdown.includes("| a | b |"), "markdown: header row");
    assert(markdown.includes("| --- | --- |"), "markdown: separator row");
    assert(markdown.includes("x\\|y"), "markdown: pipe escaped");
    assert(markdown.includes("line1<br>line2"), "markdown: newline becomes br");

    for (const newline of ["\r\n", "\n", "\r"]) {
        const parsed = parseCsv(`"head${newline}tail"\n"a${newline}b"`, { hasHeader: true });
        assertEqual(parsed.warnings, [], `markdown: quoted ${JSON.stringify(newline)} parses without warnings`);
        assertEqual(toMarkdown(parsed.header, parsed.rows), "| head<br>tail |\n| --- |\n| a<br>b |\n",
            `markdown: ${JSON.stringify(newline)} stays inline in headers and cells`);
    }

    const mixedMarkdown = toMarkdown(["head\r\nmid\nend\rtail|\\"], [["\ra\r\nb\nc|\\\r"], ["plain"]]);
    assertEqual(mixedMarkdown, "| head<br>mid<br>end<br>tail\\|\\\\ |\n| --- |\n| <br>a<br>b<br>c\\|\\\\<br> |\n| plain |\n",
        "markdown: mixed cell breaks, empty lines, escaping, and ordinary row separators preserved");

    const html = toHtmlTable(header, [["<b>", "\"q\" & z"]]);
    assert(html.includes("<th scope=\"col\">a</th>"), "html: scoped header cell");
    assert(html.includes("&lt;b&gt;"), "html: tags escaped");
    assert(html.includes("&quot;q&quot; &amp; z"), "html: quotes and ampersand escaped");

    const objects = JSON.parse(toJsonObjects(header, rows));
    assertEqual(objects[0], { a: "1", b: "x|y" }, "json objects: header keys");
    assertEqual(objects[1], {
        a: "2",
        b: "line1\nline2",
    }, "json objects: all rows and cell text kept");

    const literalKeys = ["__proto__", "constructor", "toString", "", "ordinary"];
    const literalValues = ["keep", "own constructor", "own string", "empty name", "value"];
    const literalObject = JSON.parse(toJsonObjects(literalKeys, [literalValues]))[0];
    assertEqual(Object.keys(literalObject), literalKeys, "json objects: literal prototype and empty keys kept");
    assertEqual(literalKeys.map((key) => literalObject[key]), literalValues,
        "json objects: every literal-key column value survives");
    assert(Object.hasOwn(literalObject, "__proto__"), "json objects: __proto__ is an own property");

    for (const duplicateKeys of [["x", "x"], ["", ""], ["__proto__", "__proto__"]]) {
        let error;
        try {
            toJsonObjects(duplicateKeys, [["first", "second"]]);
        } catch (caught) {
            error = caught;
        }
        assert(error instanceof Error, `json objects: duplicate ${JSON.stringify(duplicateKeys)} blocked`);
        assert(error?.message.includes("JSON (array of arrays)") && error?.message.includes("Rename duplicate columns"),
            "json objects: duplicate error explains lossless alternatives");
    }

    assertEqual(JSON.parse(toJsonObjects(null, [["first", "second"]])),
        [{ column_1: "first", column_2: "second" }], "json objects: headerless columns retained");
    assertEqual(JSON.parse(toJsonObjects(["ordinary"], [[]])), [{ ordinary: "" }],
        "json objects: missing cells retain their column");

    const arrays = JSON.parse(toJsonRows(header, rows));
    assertEqual(arrays[0], header, "json arrays: header included");
    const arraysOnly = JSON.parse(toJsonRows(header, rows, false));
    assertEqual(arraysOnly[0], rows[0], "json arrays: header excluded");
}

// =============================================================================
// larger input smoke test
// =============================================================================
console.log("\n=== larger input ===");
{
    const lines = ["id,name,amount,date"];
    for (let i = 0; i < 20000; i++) {
        lines.push(`${i},name ${i},${i}.50,2024-01-01`);
    }
    const text = lines.join("\n");

    const start = Date.now();
    const parsed = parseCsv(text, { delimiter: detectDelimiter(text) });
    const elapsed = Date.now() - start;

    assert(parsed.rows.length === 20000, "large: all rows parsed");
    assert(parsed.warnings.length === 0, "large: no warnings");
    assert(elapsed < 5000, `large: parsed in under 5s (${elapsed}ms)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
}
