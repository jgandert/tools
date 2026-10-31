/**
 * Review regression tests for block_trace_diff.js.
 *
 * Place this file beside the library and run with Node.js or Bun:
 *   node --test review_block_trace.mjs
 *   bun test ./review_block_trace.mjs
 *   node review_block_trace.mjs --benchmark
 *
 * These tests assert edit-script correctness and the public diff contracts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { BlockTraceDiff } from "./block_trace_diff.js";

function insertionDeletionDistance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            next[j] = a[i - 1] === b[j - 1]
                ? row[j - 1]
                : 1 + Math.min(row[j], next[j - 1]);
        }
        row = next;
    }
    return row[b.length];
}

function validateMyers(a, b, script) {
    let source = 0, target = 0, edits = 0;
    for (const op of script) {
        if (op.type === "EQUAL") {
            if (op.srcIdx !== source || op.targetIdx !== target ||
                source >= a.length || target >= b.length || a[source] !== b[target]) {
                throw new Error(`Invalid EQUAL: ${JSON.stringify({ a, b, op })}`);
            }
            source++;
            target++;
        } else if (op.type === "DELETE") {
            if (op.srcIdx !== source || source >= a.length || op.targetIdx !== null) {
                throw new Error(`Invalid DELETE: ${JSON.stringify({ a, b, op })}`);
            }
            source++;
            edits++;
        } else if (op.type === "INSERT") {
            if (op.targetIdx !== target || target >= b.length || op.srcIdx !== null) {
                throw new Error(`Invalid INSERT: ${JSON.stringify({ a, b, op })}`);
            }
            target++;
            edits++;
        } else {
            throw new Error(`Unexpected operation: ${op.type}`);
        }
    }
    if (source !== a.length || target !== b.length) throw new Error("Incomplete coverage");
    if (edits !== insertionDeletionDistance(a, b)) throw new Error("Non-minimal edit script");
}

function lineNumbers(ops, side) {
    const result = [];
    for (const op of ops) {
        const line = side === "source" ? op.srcLine : op.targetLine;
        const consumesLine = op.type === "EQUAL" || op.type === "REPLACE" ||
            op.type === (side === "source" ? "DELETE" : "INSERT");
        if (consumesLine) result.push(line);
        if (op.type === (side === "source" ? "MOVE_FROM" : "MOVE_TO")) {
            const start = side === "source" ? op.srcStartLine : op.targetStartLine;
            const end = side === "source" ? op.srcEndLine : op.targetEndLine;
            for (let i = start; i <= end; i++) result.push(i);
        }
    }
    return result;
}

function movePairsAreValid(ops) {
    const pairs = new Map();
    for (const op of ops) {
        if (op.type !== "MOVE_FROM" && op.type !== "MOVE_TO") continue;
        const types = pairs.get(op.moveId) ?? [];
        types.push(op.type);
        pairs.set(op.moveId, types);
    }
    return [...pairs.values()].every(types =>
        types.length === 2 && types.includes("MOVE_FROM") && types.includes("MOVE_TO"));
}

function hasBlankEdit(ops) {
    return ops.some(op =>
        ((op.type === "INSERT" || op.type === "DELETE") && op.text.trim() === "") ||
        (op.internalDiff && hasBlankEdit(op.internalDiff)));
}

function runBenchmarks() {
    const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
    console.log(`Node ${process.version}; milliseconds; median of three measured runs.`);
    for (let i = 0; i < 4; i++) {
        const lines = Array.from({ length: 1000 }, (_, j) => `line-${j}`);
        new BlockTraceDiff().diff(lines, [...lines]);
    }
    for (const n of [2000, 4000, 8000, 16000]) {
        const totals = [], expansionTimes = [];
        for (let rep = 0; rep < 3; rep++) {
            const engine = new BlockTraceDiff();
            const original = engine._seedAndExpand;
            engine._seedAndExpand = function(...args) {
                const start = performance.now();
                const result = original.apply(this, args);
                expansionTimes.push(performance.now() - start);
                return result;
            };
            const lines = Array.from({ length: n }, (_, i) => `line-${i}`);
            const start = performance.now();
            const result = engine.diff(lines, [...lines]);
            totals.push(performance.now() - start);
            assert.equal(result.length, n);
            assert.ok(result.every(op => op.type === "EQUAL"));
        }
        console.log(JSON.stringify({
            case: "identical-unique", linesPerSide: n,
            totalMs: median(totals), seedExpandMs: median(expansionTimes),
        }));
    }
    // Isolate run construction, not overall diff runtime: Myers/output are stubbed.
    // maxStitchGap=0 preserves independent exact two-line blocks separated by edits.
    for (const count of [1000, 2000, 4000, 8000]) {
        const times = [];
        for (let rep = 0; rep < 3; rep++) {
            const engine = new BlockTraceDiff({ maxStitchGap: 0 });
            const a = Array.from({ length: count }, (_, i) =>
                [`block-${i}-a`, `block-${i}-b`, `src-${i}`]).flat();
            const b = Array.from({ length: count }, (_, i) =>
                [`block-${i}-a`, `block-${i}-b`, `dst-${i}`]).flat();
            const source = engine._normalizeAndIntern(a);
            const target = engine._normalizeAndIntern(b);
            const moves = engine._gapStitching(engine._greedyMasking(engine._seedAndExpand(
                engine._findAnchors(source, target), source, target)));
            engine._myersDiff = () => [];
            const start = performance.now();
            engine._fallbackDiffAndReassemble(source, target, moves, a, b);
            times.push(performance.now() - start);
        }
        console.log(JSON.stringify({
            case: "run-building-only", moves: count, linesPerSide: count * 3,
            totalMs: median(times),
        }));
    }
}

if (process.argv.includes("--benchmark")) {
    runBenchmarks();
} else {
    test("Myers: all 65,025 binary sequence pairs of lengths 0 through 7", () => {
        const sequences = [[]];
        for (let n = 1; n <= 7; n++) {
            for (let mask = 0; mask < 2 ** n; mask++) {
                sequences.push(Array.from({ length: n }, (_, i) => (mask >> i) & 1));
            }
        }
        const engine = new BlockTraceDiff();
        for (const a of sequences) for (const b of sequences) {
            validateMyers(a, b, engine._myersDiff(a, b));
        }
    });

    test("Myers: 20,000 deterministic randomized cases versus a distance oracle", () => {
        let state = 123456789;
        const rand = n => {
            state = (Math.imul(1664525, state) + 1013904223) >>> 0;
            return state % n;
        };
        const engine = new BlockTraceDiff();
        for (let i = 0; i < 20000; i++) {
            const a = Array.from({ length: rand(60) }, () => rand(7));
            const b = Array.from({ length: rand(60) }, () => rand(7));
            validateMyers(a, b, engine._myersDiff(a, b));
        }
    });

    test("Public API: coverage, order, and move pairs in 10,000 deterministic synthetic cases", () => {
        let state = 0x7187369;
        const rand = n => {
            state = (Math.imul(1664525, state) + 1013904223) >>> 0;
            return Math.floor((state / 4294967296) * n);
        };
        for (let i = 0; i < 10000; i++) {
            const a = Array.from({ length: rand(35) }, () => String.fromCharCode(65 + rand(6)));
            const b = Array.from({ length: rand(35) }, () => String.fromCharCode(65 + rand(6)));
            const ops = new BlockTraceDiff({ skipWhitespaceOps: false }).diff(a, b);
            for (const [side, input] of [["source", a], ["target", b]]) {
                const actual = lineNumbers(ops, side);
                const expected = Array.from({ length: input.length }, (_, j) => j + 1);
                assert.deepEqual(actual, expected, `${side} coverage and order`);
            }
            assert.ok(movePairsAreValid(ops), "Every move must have both halves");
        }
    });

    test("REGRESSION: stitching must not swallow another move destination", () => {
        const ops = new BlockTraceDiff().diff(
            ["C1", "C2", "A1", "A2", "B1", "B2"],
            ["A1", "A2", "C1", "C2", "B1", "B2"]);
        assert.ok(movePairsAreValid(ops), "A MOVE_FROM was emitted without its MOVE_TO");
    });

    test("REGRESSION: target-consuming operations must preserve target order", () => {
        const ops = new BlockTraceDiff().diff(
            ["A1", "A2", "B1", "B2"], ["B1", "B2", "A1", "A2", "X"]);
        assert.deepEqual(lineNumbers(ops, "target"), [1, 2, 3, 4, 5]);
    });

    test("REGRESSION: source-consuming operations must preserve source order", () => {
        const ops = new BlockTraceDiff().diff(
            ["A1", "A2", "X", "B1", "B2"], ["B1", "B2", "A1", "A2"]);
        assert.deepEqual(lineNumbers(ops, "source"), [1, 2, 3, 4, 5]);
    });

    test("API CONTRACT: disabling whitespace options must reveal literal changes", () => {
        const engine = new BlockTraceDiff({
            ignoreLeadingWhitespace: false,
            skipWhitespaceOps: false,
        });
        const ops = engine.diff(["const s = \"a  b\";"], ["const s = \"a b\";"]);
        assert.ok(ops.some(op => op.type !== "EQUAL"), "A semantic string-literal change was hidden");
    });

    test("REGRESSION: a 150,000-line pure insertion must not overflow function arguments", () => {
        // This exact threshold is runtime-dependent; 150k reproduces on Node 22.16.0.
        const target = Array(150000).fill("X");
        let result;
        assert.doesNotThrow(() => {
            result = new BlockTraceDiff().diff([], target);
        });
        assert.equal(result.length, target.length);
        assert.ok(result.every(op => op.type === "INSERT"));
    });

    test("API CONTRACT: EQUAL.text must not change just because stitching is enabled", () => {
        const a = ["  A", "  B", "old", "  C", "  D"];
        const b = ["A", "B", "new", "C", "D"];
        const equalText = gap => new BlockTraceDiff({ maxStitchGap: gap }).diff(a, b)
            .filter(op => op.type === "EQUAL").map(op => op.text);
        assert.deepEqual(equalText(2), equalText(0));
    });

    test("API CONTRACT: skipWhitespaceOps should apply inside moved-block internalDiff", () => {
        const ops = new BlockTraceDiff({ skipWhitespaceOps: true }).diff(
            ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "B5"],
            ["B1", "B2", "B3", "B4", "B5", "A1", "A2", "", "A3", "A4"]);
        assert.equal(hasBlankEdit(ops), false);
    });

    test("API CONTRACT: invalid kGramSize should fail immediately with a clear RangeError", () => {
        for (const value of [-1, 0, 0.5, 1.5, NaN, Infinity, "2", null]) {
            assert.throws(() => new BlockTraceDiff({ kGramSize: value }), RangeError,
                `kGramSize=${String(value)} must be rejected in the constructor`);
        }
    });
}
