/**
 * Independent public-contract regressions. Run with:
 *   node --test test_diff_properties.mjs
 *
 * These checks reconstruct both raw inputs from the public operations. Small
 * fallback diffs are compared with an independent longest-common-subsequence
 * oracle; move-aware diffs are not required to minimize insertion/deletion cost.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BlockTraceDiff } from "./block_trace_diff.js";

const EXACT = {
    ignoreLeadingWhitespace: false,
    ignoreTrailingWhitespace: false,
    ignoreInternalWhitespace: false,
    skipWhitespaceOps: false,
};

function randomFrom(seed) {
    let state = seed;
    return limit => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        // Use the full word, rather than the short cycle of the low bits.
        return Math.floor(state / 0x100000000 * limit);
    };
}

// Tokenize whitespace runs independently of the implementation's trimming and
// slicing so that each option can be checked without reusing engine internals.
function matchingText(line, options) {
    const parts = line.match(/\s+|\S+/gu) ?? [];
    return parts.map((part, i) => {
        if (/\S/u.test(part)) return part;
        if (i === 0 && options.ignoreLeadingWhitespace !== false) return "";
        if (i === parts.length - 1 && options.ignoreTrailingWhitespace === true) return "";
        if (i > 0 && i < parts.length - 1 && options.ignoreInternalWhitespace === true) return " ";
        return part;
    }).join("");
}

function editDistance(source, target) {
    // LCS gives the optimum number of retained lines. A replacement costs two
    // edits: one deletion plus one insertion, matching the public API's model.
    let previous = new Uint16Array(target.length + 1);
    for (const sourceLine of source) {
        const row = new Uint16Array(target.length + 1);
        for (let j = 1; j <= target.length; j++) {
            row[j] = sourceLine === target[j - 1]
                ? previous[j - 1] + 1
                : Math.max(previous[j], row[j - 1]);
        }
        previous = row;
    }
    return source.length + target.length - 2 * previous[target.length];
}

function assertReplay(source, target, operations, options, sourceStart = 1, targetStart = 1, nested = false) {
    const sourceProjection = [], targetProjection = [];
    const moves = new Map();
    const suppressed = options.skipWhitespaceOps !== false;

    for (const op of operations) {
        if (nested) assert.ok(["EQUAL", "DELETE", "INSERT"].includes(op.type), "nested move edits retain DELETE/INSERT");
        switch (op.type) {
            case "EQUAL":
                assert.equal(op.text, op.sourceText, "EQUAL.text is source-owned");
                assert.equal(op.isExact, op.sourceText === op.targetText);
                assert.equal(matchingText(op.sourceText, options), matchingText(op.targetText, options));
                sourceProjection.push([op.srcLine, op.sourceText]);
                targetProjection.push([op.targetLine, op.targetText]);
                break;
            case "DELETE":
                if (suppressed) assert.notEqual(op.text.trim(), "", "blank deletion must be suppressed");
                sourceProjection.push([op.srcLine, op.text]);
                break;
            case "INSERT":
                if (suppressed) assert.notEqual(op.text.trim(), "", "blank insertion must be suppressed");
                targetProjection.push([op.targetLine, op.text]);
                break;
            case "REPLACE": {
                assert.deepEqual(op.internalDiff.map(edit => edit.type), ["DELETE", "INSERT"]);
                const [deleted, inserted] = op.internalDiff;
                assert.equal(op.text, inserted.text);
                assert.deepEqual(op.lines, [inserted.text]);
                if (suppressed) {
                    assert.notEqual(deleted.text.trim(), "", "blank deletion cannot consume a replacement partner");
                    assert.notEqual(inserted.text.trim(), "", "blank insertion cannot consume a replacement partner");
                }
                sourceProjection.push([op.srcLine, deleted.text]);
                targetProjection.push([op.targetLine, inserted.text]);
                break;
            }
            case "MOVE_FROM":
            case "MOVE_TO": {
                assert.equal(typeof op.moveId, "string");
                assert.notEqual(op.moveId, "");
                assert.ok(["MOVE_EXACT", "MOVE_MODIFIED"].includes(op.moveType));
                for (const [start, end, offset, length] of [
                    [op.srcStartLine, op.srcEndLine, sourceStart, source.length],
                    [op.targetStartLine, op.targetEndLine, targetStart, target.length],
                ]) {
                    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end));
                    assert.ok(start >= offset && end >= start && end < offset + length, "move range is valid");
                }
                const from = source.slice(op.srcStartLine - sourceStart, op.srcEndLine - sourceStart + 1);
                const to = target.slice(op.targetStartLine - targetStart, op.targetEndLine - targetStart + 1);
                const pair = moves.get(op.moveId) ?? {};
                assert.equal(pair[op.type], undefined, "move half appears once");
                pair[op.type] = op;
                moves.set(op.moveId, pair);
                if (op.moveType === "MOVE_EXACT") {
                    assert.deepEqual(from.map(line => matchingText(line, options)), to.map(line => matchingText(line, options)));
                }
                const isSource = op.type === "MOVE_FROM";
                const projection = isSource ? sourceProjection : targetProjection;
                const start = isSource ? op.srcStartLine : op.targetStartLine;
                assert.deepEqual(op.lines, isSource ? from : to);
                op.lines.forEach((line, i) => projection.push([start + i, line]));
                if (!isSource) {
                    if (from.length !== to.length || from.some((line, i) => line !== to[i])) {
                        assert.ok(Array.isArray(op.internalDiff), "raw differences in a move require an internal diff");
                    }
                    if (op.internalDiff) assertReplay(from, to, op.internalDiff, options, op.srcStartLine, op.targetStartLine, true);
                }
                break;
            }
            default:
                assert.fail(`unknown operation ${op.type}`);
        }
    }

    for (const [id, pair] of moves) {
        assert.ok(pair.MOVE_FROM && pair.MOVE_TO, `move ${id} has both halves`);
        for (const name of ["moveType", "srcStartLine", "srcEndLine", "targetStartLine", "targetEndLine"]) {
            assert.equal(pair.MOVE_FROM[name], pair.MOVE_TO[name], `${id}: matching ${name}`);
        }
        if (suppressed) assert.ok([...pair.MOVE_FROM.lines, ...pair.MOVE_TO.lines].some(line => line.trim() !== ""));
    }

    for (const [name, input, projection, offset] of [
        ["source", source, sourceProjection, sourceStart],
        ["target", target, targetProjection, targetStart],
    ]) {
        let next = offset;
        for (const [line, text] of projection) {
            assert.ok(Number.isSafeInteger(line) && line >= next && line < offset + input.length,
                `${name}: duplicate, reordered, or invalid line ${line}`);
            while (next < line) {
                assert.ok(suppressed && input[next - offset].trim() === "", `${name}: missing line ${next}`);
                next++;
            }
            assert.equal(text, input[line - offset], `${name}: raw text of line ${line}`);
            next++;
        }
        while (next < offset + input.length) {
            assert.ok(suppressed && input[next - offset].trim() === "", `${name}: missing last line ${next}`);
            next++;
        }
        if (!suppressed) assert.deepEqual(projection.map(([, text]) => text), input, `${name} reconstruction`);
    }
}

function verify(source, target, options, context) {
    try {
        const engine = new BlockTraceDiff(options);
        const operations = engine.diff(source, target);
        assertReplay(source, target, operations, options);
        return operations;
    } catch (error) {
        error.message = `${context}: ${error.message}`;
        throw error;
    }
}

test("input containers must be arrays, under both default and exact comparison", () => {
    const invalid = [undefined, null, false, 3, 3n, Symbol("lines"), "text", new String("text"),
        new Set(["text"]), new Uint8Array([1]), { 0: "text", length: 1 }, { map: () => [] }, () => []];
    for (const options of [EXACT, {}]) {
        for (const value of invalid) {
            for (const argument of ["sourceLines", "targetLines"]) {
                const engine = new BlockTraceDiff(options);
                const call = () => argument === "sourceLines" ? engine.diff(value, []) : engine.diff([], value);
                assert.throws(call, error => error instanceof TypeError && error.message.includes(argument), argument);
                assert.deepEqual(engine.diff(["valid"], ["valid"]), new BlockTraceDiff(options).diff(["valid"], ["valid"]));
            }
        }
    }
});

test("input entries must be present primitive strings, with a useful argument and index", () => {
    const invalid = [undefined, null, false, 3, 3n, Symbol("line"), new String("text"), {}, []];
    const badArrays = invalid.map(value => ["valid prefix", value, "valid suffix"]);
    badArrays.push(["valid prefix", , "valid suffix"]);
    const inheritedHole = ["valid prefix", , "valid suffix"];
    Object.setPrototypeOf(inheritedHole, Object.assign(Object.create(Array.prototype), { 1: "inherited value" }));
    badArrays.push(inheritedHole);
    for (const options of [EXACT, {}]) {
        for (const value of badArrays) {
            for (const argument of ["sourceLines", "targetLines"]) {
                const engine = new BlockTraceDiff(options);
                const call = () => argument === "sourceLines" ? engine.diff(value, []) : engine.diff([], value);
                assert.throws(call, error => error instanceof TypeError && error.message.includes(`${argument}[1]`), argument);
                assert.deepEqual(engine.diff([], []), []);
            }
        }
    }
});

test("validated comparison settings cannot be changed or deleted after construction", () => {
    const options = { ...EXACT, kGramSize: 3, maxStitchGap: 0, maxOccurrences: 1 };
    const engine = new BlockTraceDiff(options);
    const configured = { ...options };
    for (const [name, value] of Object.entries(configured)) {
        options[name] = typeof value === "boolean" ? !value : -1;
        assert.equal(engine[name], value, "caller-owned options are copied");
        assert.throws(() => { engine[name] = options[name]; }, TypeError, name);
        assert.throws(() => { delete engine[name]; }, TypeError, name);
        assert.throws(() => Object.defineProperty(engine, name, { value: options[name] }), TypeError, name);
        assert.equal(engine[name], value);
    }
    assertReplay([" A", "B"], ["A", "B"], engine.diff([" A", "B"], ["A", "B"]), configured);
});

test("public Myers fallback has optimal edit cost for every binary pair through length four", () => {
    const sequences = [[]];
    for (let length = 1; length <= 4; length++) {
        for (let bits = 0; bits < 2 ** length; bits++) {
            sequences.push(Array.from({ length }, (_, i) => bits & (1 << i) ? "alpha" : "beta"));
        }
    }
    const options = { ...EXACT, maxOccurrences: 0 };
    for (const source of sequences) for (const target of sequences) {
        const operations = verify(source, target, options, JSON.stringify({ source, target }));
        assert.ok(operations.every(op => !op.type.startsWith("MOVE_")));
        const edits = operations.reduce((sum, op) => sum + (op.type === "EQUAL" ? 0 : op.type === "REPLACE" ? 2 : 1), 0);
        assert.equal(edits, editDistance(source, target));
    }
});

test("public Myers cost remains optimal under every combination of whitespace normalization", () => {
    const random = randomFrom(0x375afd01);
    const vocabulary = ["", "\t", "a", " a", "a ", "a  b", "a\tb", "a b", "\u00a0a", "a\u00a0", "\u200ba", "😀", "e\u0301", "é"];
    for (let flags = 0; flags < 8; flags++) {
        const options = {
            ...EXACT,
            maxOccurrences: 0,
            ignoreLeadingWhitespace: Boolean(flags & 1),
            ignoreTrailingWhitespace: Boolean(flags & 2),
            ignoreInternalWhitespace: Boolean(flags & 4),
        };
        for (let iteration = 0; iteration < 125; iteration++) {
            const source = Array.from({ length: random(19) }, () => vocabulary[random(vocabulary.length)]);
            const target = Array.from({ length: random(19) }, () => vocabulary[random(vocabulary.length)]);
            const operations = verify(source, target, options, `whitespace flags=${flags}, iteration=${iteration}`);
            const edits = operations.reduce((sum, op) => sum + (op.type === "EQUAL" ? 0 : op.type === "REPLACE" ? 2 : 1), 0);
            assert.equal(edits, editDistance(source.map(line => matchingText(line, options)), target.map(line => matchingText(line, options))));
        }
    }
});

test("long and highly asymmetric fallback gaps retain the optimal edit cost", () => {
    const random = randomFrom(0x48214397);
    const options = { ...EXACT, maxOccurrences: 0 };
    const fixtures = [];
    for (let iteration = 0; iteration < 64; iteration++) {
        fixtures.push([
            Array.from({ length: 64 + random(97) }, () => String(random(13))),
            Array.from({ length: 64 + random(97) }, () => String(random(13))),
        ]);
    }
    for (const shortLength of [2, 3, 5, 9]) {
        for (const longLength of [127, 128, 511, 512]) {
            const short = Array.from({ length: shortLength }, () => String(random(17)));
            const long = Array.from({ length: longLength }, () => String(random(17)));
            fixtures.push([short, long], [long, short]);
        }
    }
    for (const [index, [source, target]] of fixtures.entries()) {
        const operations = verify(source, target, options, `long fallback fixture=${index}`);
        assert.equal(operations.reduce((sum, op) => sum + (op.type === "EQUAL" ? 0 : op.type === "REPLACE" ? 2 : 1), 0),
            editDistance(source, target), `long fallback fixture=${index}`);
    }
});

test("Unicode whitespace boundaries, invisible non-whitespace, and literal content remain distinct", () => {
    const spaces = [" ", "\t", "\r", "\n", "\v", "\f", "\u00a0", "\u1680", "\u2000", "\u2003", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
    for (const space of spaces) {
        const source = [`${space}α${space}${space}😀${space}`, space + space];
        for (let flags = 0; flags < 8; flags++) {
            const options = {
                ...EXACT,
                ignoreLeadingWhitespace: Boolean(flags & 1),
                ignoreTrailingWhitespace: Boolean(flags & 2),
                ignoreInternalWhitespace: Boolean(flags & 4),
            };
            const target = source.map(line => matchingText(line, options));
            const operations = verify(source, target, options, `space=${JSON.stringify(space)}, flags=${flags}`);
            assert.ok(operations.every(op => op.type === "EQUAL"));
        }
    }
    for (const marker of ["\0", "\u0085", "\u180e", "\u200b", "\u2060"]) {
        const operations = verify([`${marker}text`], ["text"], { skipWhitespaceOps: false }, `non-whitespace ${JSON.stringify(marker)}`);
        assert.equal(operations[0].type, "REPLACE");
    }
    for (const [source, target] of [["é", "e\u0301"], ["😀", "😁"], ["\ud800", "\ud801"], ['"a  b"', '"a b"']]) {
        assert.equal(verify([source], [target], EXACT, "literal content")[0].type, "REPLACE");
    }
});

test("repetitive and degenerate inputs reconstruct both sides across anchor thresholds", () => {
    const repeat = (pattern, count) => Array.from({ length: count }, () => pattern).flat();
    const fixtures = [
        [[], []], [[], ["", "\t", "text"]], [["", "\t", "text"], []],
        [Array(40).fill("x"), Array(39).fill("x")],
        [repeat(["{", "}"], 25), repeat(["}", "{"], 25)],
        [repeat(["", " ", "\t"], 20), repeat(["\t", "", " "], 20)],
        [["__proto__", "constructor", "toString", "0", "-10000", "1,2"], ["1,2", "0", "-10000", "toString", "constructor", "__proto__"]],
        [[...repeat(["same", "same"], 12), "only source", ...repeat(["same", "same"], 12)],
            [...repeat(["same", "same"], 9), "only target", ...repeat(["same", "same"], 15)]],
        [["A", "B", "C"], ["C", "B", "A"]],
    ];
    const configurations = [
        { kGramSize: 1, maxOccurrences: 0 },
        { kGramSize: 1, maxOccurrences: 1, maxStitchGap: 0 },
        { kGramSize: 2, maxOccurrences: 5, maxStitchGap: 2 },
        { kGramSize: 3, maxOccurrences: 100, maxStitchGap: 100 },
        { kGramSize: Number.MAX_SAFE_INTEGER, maxOccurrences: Number.MAX_SAFE_INTEGER, maxStitchGap: Number.MAX_SAFE_INTEGER },
    ];
    for (const [index, [source, target]] of fixtures.entries()) {
        for (const configuration of configurations) {
            for (const skipWhitespaceOps of [false, true]) {
                const options = { ...EXACT, ...configuration, skipWhitespaceOps };
                verify(source, target, options, `fixture=${index}, options=${JSON.stringify(options)}`);
            }
        }
    }
});

test("moved modified blocks retain unequal gaps, raw formatting, and absolute nested coordinates", () => {
    const retained = Array.from({ length: 20 }, (_, i) => `retained ${i}`);
    const from = ["  A1", "  A2", "old", " ", "  A3", "  A4"];
    const to = ["A1", "A2", "new one", "new two", "\t", "A3", "A4"];
    for (const [source, target] of [
        [[...from, ...retained], [...retained, ...to]],
        [[...retained, ...to], [...from, ...retained]],
    ]) {
        for (const skipWhitespaceOps of [false, true]) {
            const options = { maxStitchGap: 3, skipWhitespaceOps };
            const operations = verify(source, target, options, `modified move, suppression=${skipWhitespaceOps}`);
            const moved = operations.find(op => op.type === "MOVE_TO");
            assert.ok(moved?.internalDiff, "fixture must exercise a moved block's internal edits");
            assert.ok(moved.internalDiff.some(op => op.type === "DELETE"));
            assert.ok(moved.internalDiff.some(op => op.type === "INSERT"));
            assert.ok(moved.internalDiff.some(op => op.type === "EQUAL" && !op.isExact));
        }
    }
});

test("structured block permutations and edits are lossless and deterministic on a reused engine", () => {
    const random = randomFrom(0x83b5a214);
    for (let iteration = 0; iteration < 180; iteration++) {
        const blocks = Array.from({ length: 2 + random(6) }, (_, block) =>
            Array.from({ length: 2 + random(5) }, (_, line) => `block ${block} line ${line}`));
        const source = blocks.flatMap(block => ["", ...block]);
        const shuffled = blocks.map(block => block.slice());
        for (let i = shuffled.length - 1; i > 0; i--) {
            const other = random(i + 1);
            [shuffled[i], shuffled[other]] = [shuffled[other], shuffled[i]];
        }
        if (iteration % 3 === 0) shuffled.splice(random(shuffled.length + 1), 0, blocks[random(blocks.length)].slice());
        const target = shuffled.flatMap((block, index) => {
            const changed = block.map(line => iteration % 2 === 0 ? `\t${line}` : line);
            if (index === iteration % shuffled.length) changed.splice(1, random(2), "edited value", " ");
            return [...changed, "\t"];
        });
        Object.freeze(source);
        Object.freeze(target);
        const options = {
            kGramSize: 1 + random(4), maxOccurrences: 1 + random(5), maxStitchGap: random(5),
            ignoreLeadingWhitespace: iteration % 3 !== 0,
            ignoreTrailingWhitespace: iteration % 4 === 0,
            ignoreInternalWhitespace: iteration % 5 === 0,
            skipWhitespaceOps: iteration % 2 === 0,
        };
        const operations = verify(source, target, options, `block permutation iteration=${iteration}`);
        const engine = new BlockTraceDiff(options);
        engine.diff(["unrelated", "document"], ["other", "content"]);
        assert.deepEqual(engine.diff(source, target), operations, `reuse iteration=${iteration}`);
        assert.deepEqual(engine.diff(source, target), operations, `repeat iteration=${iteration}`);
        verify(target, source, options, `inverse block permutation iteration=${iteration}`);
    }
});

test("anchor matching agrees with literal window equality and occurrence limits", () => {
    const random = randomFrom(0x5ea32478);
    const vocabulary = ["", " ", "A", " A", "B", "a  b", "a b", "1,2", "12,", "__proto__", "\0", "😀"];
    for (let iteration = 0; iteration < 240; iteration++) {
        const source = Array.from({ length: random(24) }, () => vocabulary[random(vocabulary.length)]);
        const target = iteration % 4 === 0 ? source.slice().reverse() : Array.from({ length: random(24) }, () => vocabulary[random(vocabulary.length)]);
        const options = {
            kGramSize: 1 + random(26),
            maxOccurrences: [0, 1, 2, 5, Number.MAX_SAFE_INTEGER][random(5)],
            ignoreLeadingWhitespace: iteration % 2 === 0,
            ignoreInternalWhitespace: iteration % 3 === 0,
        };
        const engine = new BlockTraceDiff(options);
        const k = options.kGramSize;
        const windows = lines => Array.from({ length: Math.max(0, lines.length - k + 1) }, (_, start) =>
            JSON.stringify(lines.slice(start, start + k).map(line => matchingText(line, options))));
        const sourceWindows = windows(source), targetWindows = windows(target);
        const expected = [];
        for (let s = 0; s < sourceWindows.length; s++) {
            for (let t = 0; t < targetWindows.length; t++) {
                if (sourceWindows[s] === targetWindows[t] &&
                    sourceWindows.filter(window => window === sourceWindows[s]).length <= options.maxOccurrences &&
                    targetWindows.filter(window => window === targetWindows[t]).length <= options.maxOccurrences) expected.push([s, t]);
            }
        }
        const actual = engine._findAnchors(engine._normalizeAndIntern(source), engine._normalizeAndIntern(target))
            .map(anchor => [anchor.srcStart, anchor.targetStart]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        assert.deepEqual(actual, expected, `anchor oracle iteration=${iteration}, k=${k}`);
    }
});

test("large overlapping k-grams do not reread every line in every window", () => {
    const count = 1536;
    const engine = new BlockTraceDiff({ kGramSize: 513 });
    const lines = Array.from({ length: count }, (_, i) => `unique ${i}`);
    const source = engine._normalizeAndIntern(lines);
    const target = engine._normalizeAndIntern(lines);
    let reads = 0;
    for (const line of [...source, ...target]) {
        const value = line.intVal;
        Object.defineProperty(line, "intVal", { get() { reads++; return value; } });
    }
    const anchors = engine._findAnchors(source, target);
    assert.equal(anchors.length, count - engine.kGramSize + 1);
    assert.ok(anchors.every((anchor, index) => anchor.srcStart === index && anchor.targetStart === index));
    assert.ok(reads <= 16 * (source.length + target.length), `${reads} token reads indicates repeated window construction`);
});

test("normalized-equal documents bypass move discovery while preserving raw and blank lines", () => {
    const source = Array.from({ length: 5000 }, (_, i) => i % 10 === 0 ? " \t" : `  line ${i}`);
    const target = source.map(line => line.trimStart());
    const options = { skipWhitespaceOps: true };
    const engine = new BlockTraceDiff(options);
    engine._findAnchors = () => assert.fail("equal documents must not discover move anchors");
    for (const destination of [source, target]) {
        const operations = engine.diff(source, destination);
        assert.equal(operations.length, source.length, "equal blank lines remain visible");
        assert.ok(operations.every(op => op.type === "EQUAL"));
        assertReplay(source, destination, operations, options);
    }
});

test("disjoint and one-line fallback gaps avoid middle-snake searches and retain exact output", () => {
    const engine = new BlockTraceDiff({ ...EXACT, maxOccurrences: 0 });
    engine._findMiddleSnake = () => assert.fail("a trivial fallback gap must not search a middle snake");
    const otherLines = Array.from({ length: 9000 }, (_, i) => `target ${i}`);
    const fixtures = [
        [Array.from({ length: 12000 }, (_, i) => `source ${i}`), otherLines, 21000],
        [["found"], [...otherLines.slice(0, 4000), "found", ...otherLines.slice(4000)], 9000],
        [[...otherLines.slice(0, 4000), "found", ...otherLines.slice(4000)], ["found"], 9000],
    ];
    for (const [source, target, expectedCost] of fixtures) {
        const operations = engine.diff(source, target);
        assertReplay(source, target, operations, EXACT);
        assert.equal(operations.reduce((sum, op) => sum + (op.type === "EQUAL" ? 0 : op.type === "REPLACE" ? 2 : 1), 0), expectedCost);
    }
});
