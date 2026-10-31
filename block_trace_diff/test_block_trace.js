import strictAssert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { StringInterner, BlockTraceDiff } from "./block_trace_diff.js";

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

function assertDeepEqual(a, b, msg) {
    const strA = JSON.stringify(a);
    const strB = JSON.stringify(b);
    if (strA === strB) {
        passed++;
    } else {
        failed++;
        failures.push(`${msg} - expected ${strB}, got ${strA}`);
        console.log(`  FAIL: ${msg}\n    Expected: ${strB}\n    Got:      ${strA}`);
    }
}

function testCase(name, fn) {
    try {
        fn();
        assert(true, name);
    } catch (error) {
        assert(false, `${name}: ${error.stack || error}`);
    }
}

// Independent oracles and output checks verify that diffs preserve order and raw
// text, not just line-number coverage.
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
            strictAssert.equal(op.srcIdx, source);
            strictAssert.equal(op.targetIdx, target);
            strictAssert.ok(source < a.length && target < b.length);
            strictAssert.equal(a[source++], b[target++]);
        } else if (op.type === "DELETE") {
            strictAssert.equal(op.srcIdx, source++);
            strictAssert.equal(op.targetIdx, null);
            strictAssert.ok(source <= a.length);
            edits++;
        } else if (op.type === "INSERT") {
            strictAssert.equal(op.targetIdx, target++);
            strictAssert.equal(op.srcIdx, null);
            strictAssert.ok(target <= b.length);
            edits++;
        } else {
            strictAssert.fail(`Unexpected operation: ${op.type}`);
        }
    }
    strictAssert.equal(source, a.length, "incomplete source coverage");
    strictAssert.equal(target, b.length, "incomplete target coverage");
    strictAssert.equal(edits, insertionDeletionDistance(a, b), "non-minimal edit script");
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

function validatePublicDiff(source, target, ops, skipWhitespaceOps = false, sourceStart = 1, targetStart = 1, options = {}) {
    const matchingText = text => {
        if (options.ignoreLeadingWhitespace !== false) text = text.trimStart();
        if (options.ignoreTrailingWhitespace === true) text = text.trimEnd();
        if (options.ignoreInternalWhitespace === true) text = text.replace(/(\S)\s+(?=\S)/g, "$1 ");
        return text;
    };
    for (const [side, input, start] of [["source", source, sourceStart], ["target", target, targetStart]]) {
        let next = start;
        for (const line of lineNumbers(ops, side)) {
            strictAssert.ok(Number.isInteger(line) && line >= next && line < start + input.length,
                `${side}: duplicate, out-of-order, or invalid line ${line} after ${next - 1}`);
            while (next < line) {
                strictAssert.ok(skipWhitespaceOps && input[next - start].trim() === "", `${side}: missing line ${next}`);
                next++;
            }
            next++;
        }
        while (next < start + input.length) {
            strictAssert.ok(skipWhitespaceOps && input[next - start].trim() === "", `${side}: missing final line ${next}`);
            next++;
        }
    }

    const pairs = new Map();
    for (const op of ops) {
        const sourceText = source[op.srcLine - sourceStart];
        const targetText = target[op.targetLine - targetStart];
        if (op.type === "EQUAL") {
            strictAssert.equal(op.text, sourceText, "EQUAL.text belongs to the source");
            strictAssert.equal(op.sourceText, sourceText);
            strictAssert.equal(op.targetText, targetText);
            strictAssert.equal(op.isExact, sourceText === targetText);
            strictAssert.equal(matchingText(sourceText), matchingText(targetText), "EQUAL must obey the configured matching policy");
        } else if (op.type === "DELETE") {
            strictAssert.equal(op.text, sourceText);
        } else if (op.type === "INSERT") {
            strictAssert.equal(op.text, targetText);
        } else if (op.type === "REPLACE") {
            strictAssert.equal(op.text, targetText);
            strictAssert.deepEqual(op.lines, [targetText]);
            strictAssert.deepEqual(op.internalDiff, [
                { type: "DELETE", text: sourceText },
                { type: "INSERT", text: targetText },
            ]);
        } else if (op.type === "MOVE_FROM" || op.type === "MOVE_TO") {
            strictAssert.ok(typeof op.moveId === "string" && op.moveId.length > 0);
            strictAssert.ok(op.moveType === "MOVE_EXACT" || op.moveType === "MOVE_MODIFIED");
            strictAssert.ok(op.srcStartLine >= sourceStart && op.srcEndLine < sourceStart + source.length);
            strictAssert.ok(op.targetStartLine >= targetStart && op.targetEndLine < targetStart + target.length);
            strictAssert.ok(op.srcEndLine >= op.srcStartLine && op.targetEndLine >= op.targetStartLine);
            const sourceBlock = source.slice(op.srcStartLine - sourceStart, op.srcEndLine - sourceStart + 1);
            const targetBlock = target.slice(op.targetStartLine - targetStart, op.targetEndLine - targetStart + 1);
            strictAssert.deepEqual(op.lines, op.type === "MOVE_FROM" ? sourceBlock : targetBlock);
            const pair = pairs.get(op.moveId) || {};
            strictAssert.equal(pair[op.type], undefined, `duplicate ${op.type} for ${op.moveId}`);
            pair[op.type] = op;
            pairs.set(op.moveId, pair);
            if (op.type === "MOVE_TO" && op.internalDiff) {
                // Nested coordinates are absolute and must agree with the enclosing ranges.
                validatePublicDiff(sourceBlock, targetBlock, op.internalDiff, skipWhitespaceOps, op.srcStartLine, op.targetStartLine, options);
            }
        } else {
            strictAssert.fail(`Unexpected operation: ${op.type}`);
        }
    }
    for (const [id, pair] of pairs) {
        strictAssert.ok(pair.MOVE_FROM && pair.MOVE_TO, `unpaired move ${id}`);
        for (const key of ["moveType", "srcStartLine", "srcEndLine", "targetStartLine", "targetEndLine"]) {
            strictAssert.equal(pair.MOVE_FROM[key], pair.MOVE_TO[key], `${id}: inconsistent ${key}`);
        }
    }
}

function validateMoveRanges(moves) {
    for (const side of ["src", "target"]) {
        const ordered = moves.slice().sort((a, b) => a[`${side}Start`] - b[`${side}Start`]);
        let end = -1;
        for (const move of ordered) {
            strictAssert.ok(move[`${side}Start`] > end, `overlapping ${side} move ranges`);
            strictAssert.ok(move[`${side}End`] >= move[`${side}Start`]);
            end = move[`${side}End`];
        }
    }
}

function hasBlankEdit(ops) {
    return ops.some(op =>
        ((op.type === "INSERT" || op.type === "DELETE") && op.text.trim() === "") ||
        (op.internalDiff && hasBlankEdit(op.internalDiff)));
}

function createRandom(seed) {
    let state = seed;
    return n => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return Math.floor((state / 4294967296) * n);
    };
}

// Benchmarks are opt-in; ordinary tests use deterministic work-count checks instead
// of environment-sensitive timing thresholds. Run: node test_block_trace.js --benchmark
function runBenchmarks() {
    const median = values => values.slice().sort((a, b) => a - b)[values.length >> 1];
    console.log(`Node ${process.version}; milliseconds; median of three measured runs.`);
    for (let i = 0; i < 4; i++) {
        const lines = Array.from({ length: 1000 }, (_, j) => `line-${j}`);
        new BlockTraceDiff().diff(lines, lines.slice());
    }
    for (const modified of [false, true]) {
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
                const source = Array.from({ length: n }, (_, i) => `line-${i}`);
                const target = source.slice();
                if (modified) target[n >> 1] = "changed";
                const start = performance.now();
                const result = engine.diff(source, target);
                totals.push(performance.now() - start);
                strictAssert.equal(result.length, n);
                strictAssert.equal(result.filter(op => op.type === "REPLACE").length, modified ? 1 : 0);
            }
            console.log(JSON.stringify({
                case: modified ? "nearly-identical-unique" : "identical-unique", linesPerSide: n,
                totalMs: median(totals), seedExpandMs: median(expansionTimes),
            }));
        }
    }
    // Isolate run construction and weighted stationary selection, not Myers/output.
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
            engine._buildFinalOutput = () => [];
            const start = performance.now();
            engine._fallbackDiffAndReassemble(source, target, moves, a, b);
            times.push(performance.now() - start);
        }
        console.log(JSON.stringify({
            case: "run-building-and-stationary-selection", moves: count, linesPerSide: count * 3,
            totalMs: median(times),
        }));
    }
}

if (process.argv.includes("--benchmark")) {
    runBenchmarks();
    process.exit(0);
}

// =============================================================================
// StringInterner
// =============================================================================
console.log("\n=== StringInterner: Basic Interning ===");
{
    const interner = new StringInterner();

    // Interning basic strings
    const idA1 = interner.intern("hello");
    const idA2 = interner.intern("hello");
    const idB = interner.intern("world");

    assert(idA1 === idA2, "interning identical strings should yield same ID");
    assert(idA1 !== idB, "interning different strings should yield different IDs");
    assert(idA1 === 0, `first ID should be 0, got ${idA1}`);
    assert(idB === 1, `second ID should be 1, got ${idB}`);

    // Empty and space strings
    const idEmpty = interner.intern("");
    const idSpace = interner.intern(" ");
    assert(idEmpty !== idSpace, "empty string and space should have different IDs");

    // Case sensitivity in interner
    const idLower = interner.intern("abc");
    const idUpper = interner.intern("ABC");
    assert(idLower !== idUpper, "interner should be case sensitive");
}

// =============================================================================
// BlockTraceDiff Options
// =============================================================================
console.log("\n=== BlockTraceDiff: Initialization and Options ===");
{
    const diffDefault = new BlockTraceDiff();
    assert(diffDefault.kGramSize === 2, "default kGramSize should be 2");
    assert(diffDefault.maxStitchGap === 2, "default maxStitchGap should be 2");
    assert(diffDefault.maxOccurrences === 5, "default maxOccurrences should be 5");
    assert(diffDefault.ignoreLeadingWhitespace === true, "default should still ignore indentation");
    assert(diffDefault.ignoreTrailingWhitespace === false, "default should preserve trailing whitespace");
    assert(diffDefault.ignoreInternalWhitespace === false, "default should preserve internal whitespace");
    assert(diffDefault.skipWhitespaceOps === true, "default should still hide blank-only edits");

    const diffCustom = new BlockTraceDiff({ kGramSize: 3, maxStitchGap: 1 });
    assert(diffCustom.kGramSize === 3, "custom kGramSize should be 3");
    assert(diffCustom.maxStitchGap === 1, "custom maxStitchGap should be 1");
}

// =============================================================================
// Normalization and Interning
// =============================================================================
console.log("\n=== BlockTraceDiff: Line Normalization ===");
{
    // Legacy whitespace collapsing remains available explicitly, not as a hidden default.
    const engine = new BlockTraceDiff({
        ignoreTrailingWhitespace: true,
        ignoreInternalWhitespace: true,
    });
    const source = [
        "  function foo() {  ",
        "let x = 1; \t ",
        "  let   y   =   2;  ",
    ];

    const normalized = engine._normalizeAndIntern(source);

    assert(normalized.length === 3, "should have normalized 3 lines");
    assert(normalized[0].originalText === source[0], "should keep originalText");
    assert(normalized[0].normalizedText === "function foo() {", "should trim leading/trailing space");
    assert(normalized[0].originalIndex === 0, "should record originalIndex");

    assert(normalized[1].normalizedText === "let x = 1;", "should handle tabs and trailing spaces");
    assert(normalized[2].normalizedText === "let y = 2;", "should collapse multiple internal spaces");

    // Test that distinct original texts with identical normalized texts get the same intVal
    const sameNormalized = engine._normalizeAndIntern(["foo  bar", "  foo bar  "]);
    assert(sameNormalized[0].intVal === sameNormalized[1].intVal, "identical normalized texts should get the same interned ID");
}

// =============================================================================
// Myers Diff Algorithm
// =============================================================================
console.log("\n=== BlockTraceDiff: Myers Diff Core ===");
{
    const engine = new BlockTraceDiff();

    // 1. Fully equal
    const scriptEq = engine._myersDiff([1, 2, 3], [1, 2, 3]);
    assert(scriptEq.length === 3, `fully equal should have 3 ops, got ${scriptEq.length}`);
    assert(scriptEq.every(op => op.type === "EQUAL"), "every op should be EQUAL");

    // 2. Pure insertions
    const scriptIns = engine._myersDiff([], [1, 2]);
    assert(scriptIns.length === 2, "pure insert should have 2 ops");
    assert(scriptIns.every(op => op.type === "INSERT" && op.srcIdx === null), "every op should be INSERT with srcIdx null");

    // 3. Pure deletions
    const scriptDel = engine._myersDiff([1, 2], []);
    assert(scriptDel.length === 2, "pure delete should have 2 ops");
    assert(scriptDel.every(op => op.type === "DELETE" && op.targetIdx === null), "every op should be DELETE with targetIdx null");

    // 4. Substitution (Myers produces DELETE then INSERT in this engine's backtrack order)
    const scriptSub = engine._myersDiff([1], [2]);
    assert(scriptSub.length === 2, `substitute should have 2 ops, got ${scriptSub.length}`);
    assert(scriptSub[0].type === "DELETE", "first op should be DELETE");
    assert(scriptSub[1].type === "INSERT", "second op should be INSERT");

    // 5. Complex path
    const scriptComplex = engine._myersDiff([1, 2, 3, 5], [1, 2, 4, 5]);
    const expected = [
        { type: "EQUAL", srcIdx: 0, targetIdx: 0 },
        { type: "EQUAL", srcIdx: 1, targetIdx: 1 },
        { type: "DELETE", srcIdx: 2, targetIdx: null },
        { type: "INSERT", srcIdx: null, targetIdx: 2 },
        { type: "EQUAL", srcIdx: 3, targetIdx: 3 },
    ];
    assertDeepEqual(scriptComplex, expected, "complex Myers path mapping");
}

// =============================================================================
// Anchors Matching and Boilerplate Rejection
// =============================================================================
console.log("\n=== BlockTraceDiff: Anchor Matching and Boilerplate ===");
{
    const engine = new BlockTraceDiff({ kGramSize: 2 });

    // Normal anchor matching
    const src1 = engine._normalizeAndIntern(["A", "B", "C"]);
    const target1 = engine._normalizeAndIntern(["X", "A", "B", "Y"]);
    const anchors1 = engine._findAnchors(src1, target1);

    assert(anchors1.length === 1, `should find 1 anchor, got ${anchors1.length}`);
    assert(anchors1[0].srcStart === 0, `anchor srcStart should be 0, got ${anchors1[0].srcStart}`);
    assert(anchors1[0].targetStart === 1, `anchor targetStart should be 1, got ${anchors1[0].targetStart}`);

    // Boilerplate rejection: repeated more than maxOccurrences (5)
    // 6 repeats of "{", "}" (length 12)
    // 2-gram "{,}" occurs 6 times -> rejected (0 anchors)
    // 2-gram "},{" occurs 5 times -> accepted (5 * 5 = 25 anchors)
    const srcLines = [];
    const targetLines = [];
    for (let i = 0; i < 6; i++) {
        srcLines.push("{", "}");
        targetLines.push("{", "}");
    }

    const src2 = engine._normalizeAndIntern(srcLines);
    const target2 = engine._normalizeAndIntern(targetLines);
    const anchors2 = engine._findAnchors(src2, target2);

    assert(anchors2.length === 25, `6 repeats should generate 25 anchors due to the overlapping inverse 2-gram, got ${anchors2.length}`);

    // Under maxOccurrences: 5 repeats of "{", "}" (length 10)
    // 2-gram "{,}" occurs 5 times -> accepted (5 * 5 = 25 anchors)
    // 2-gram "},{" occurs 4 times -> accepted (4 * 4 = 16 anchors)
    // Total = 41 anchors
    const srcLines3 = [];
    const targetLines3 = [];
    for (let i = 0; i < 5; i++) {
        srcLines3.push("{", "}");
        targetLines3.push("{", "}");
    }
    const src3 = engine._normalizeAndIntern(srcLines3);
    const target3 = engine._normalizeAndIntern(targetLines3);
    const anchors3 = engine._findAnchors(src3, target3);
    assert(anchors3.length === 41, `5 occurrences in both should generate 41 anchors, got ${anchors3.length}`);
}

// =============================================================================
// Seed and Expand
// =============================================================================
console.log("\n=== BlockTraceDiff: Seed and Expand ===");
{
    const engine = new BlockTraceDiff({ kGramSize: 2 });

    const src = engine._normalizeAndIntern(["header", "line1", "line2", "line3", "line4", "footer"]);
    const target = engine._normalizeAndIntern(["other", "line1", "line2", "line3", "line4", "another"]);

    const anchors = engine._findAnchors(src, target);
    assert(anchors.length === 3, `should find 3 overlapping anchors, got ${anchors.length}`);

    const candidates = engine._seedAndExpand(anchors, src, target);

    assert(candidates.length === 1, `candidates should be deduplicated to 1, got ${candidates.length}`);

    const cand = candidates[0];
    assert(cand.srcStart === 1, `srcStart should expand to 1, got ${cand.srcStart}`);
    assert(cand.srcEnd === 4, `srcEnd should expand to 4, got ${cand.srcEnd}`);
    assert(cand.targetStart === 1, `targetStart should expand to 1, got ${cand.targetStart}`);
    assert(cand.targetEnd === 4, `targetEnd should expand to 4, got ${cand.targetEnd}`);
    assert(cand.length === 4, `length should be 4, got ${cand.length}`);
}

// =============================================================================
// Greedy Masking and Edge Trimming
// =============================================================================
console.log("\n=== BlockTraceDiff: Greedy Masking and Edge Trimming ===");
{
    const engine = new BlockTraceDiff({ kGramSize: 2 });

    const candidates = [
        { srcStart: 1, srcEnd: 5, targetStart: 1, targetEnd: 5, length: 5 },
        { srcStart: 4, srcEnd: 7, targetStart: 4, targetEnd: 7, length: 4 },
    ];

    const finalMoves = engine._greedyMasking(candidates);

    assert(finalMoves.length === 2, `should keep both moves after edge trimming, got ${finalMoves.length}`);
    assert(finalMoves[0].srcStart === 1 && finalMoves[0].srcEnd === 5, "first move should be Candidate A unchanged");
    assert(finalMoves[1].srcStart === 6 && finalMoves[1].srcEnd === 7, `second move should be trimmed to [6..7], got ${finalMoves[1].srcStart}`);
    assert(finalMoves[1].length === 2, `second move length should be 2, got ${finalMoves[1].length}`);

    const candidates2 = [
        { srcStart: 1, srcEnd: 5, targetStart: 1, targetEnd: 5, length: 5 },
        { srcStart: 4, srcEnd: 5, targetStart: 4, targetEnd: 5, length: 2 },
    ];

    const finalMoves2 = engine._greedyMasking(candidates2);
    assert(finalMoves2.length === 1, `overlapping candidate should be discarded, got ${finalMoves2.length} moves`);
    assert(finalMoves2[0].srcStart === 1 && finalMoves2[0].srcEnd === 5, "remaining move should be Candidate A");
}

// =============================================================================
// Gap Stitching
// =============================================================================
console.log("\n=== BlockTraceDiff: Gap Stitching ===");
{
    const engine = new BlockTraceDiff({ maxStitchGap: 2 });

    // Case 1: Single exact block -> MOVE_EXACT
    const exactMoves1 = [
        { srcStart: 0, srcEnd: 2, targetStart: 5, targetEnd: 7, length: 3 },
    ];
    const stitched1 = engine._gapStitching(exactMoves1);
    assert(stitched1.length === 1, "should have 1 stitched block");
    assert(stitched1[0].type === "MOVE_EXACT", `type should be MOVE_EXACT, got ${stitched1[0].type}`);
    assert(stitched1[0].srcStart === 0 && stitched1[0].srcEnd === 2, "src boundary should match");
    assert(stitched1[0].targetStart === 5 && stitched1[0].targetEnd === 7, "target boundary should match");

    // Case 2: Two exact blocks with small gap (gap size 1) -> MOVE_MODIFIED
    const exactMoves2 = [
        { srcStart: 0, srcEnd: 2, targetStart: 5, targetEnd: 7, length: 3 },
        { srcStart: 4, srcEnd: 6, targetStart: 9, targetEnd: 11, length: 3 },
    ];
    const stitched2 = engine._gapStitching(exactMoves2);
    assert(stitched2.length === 1, `should stitch into 1 block, got ${stitched2.length}`);
    assert(stitched2[0].type === "MOVE_MODIFIED", `type should be MOVE_MODIFIED, got ${stitched2[0].type}`);
    assert(stitched2[0].srcStart === 0 && stitched2[0].srcEnd === 6, "src boundaries should be merged");
    assert(stitched2[0].targetStart === 5 && stitched2[0].targetEnd === 11, "target boundaries should be merged");

    // Case 3: Two exact blocks with gap too large (gap size 3) -> separate blocks
    const exactMoves3 = [
        { srcStart: 0, srcEnd: 2, targetStart: 5, targetEnd: 7, length: 3 },
        { srcStart: 6, srcEnd: 8, targetStart: 11, targetEnd: 13, length: 3 },
    ];
    const stitched3 = engine._gapStitching(exactMoves3);
    assert(stitched3.length === 2, `should NOT stitch when gap > maxStitchGap, got ${stitched3.length}`);
    assert(stitched3[0].type === "MOVE_EXACT" && stitched3[1].type === "MOVE_EXACT", "both should remain MOVE_EXACT");
}

// =============================================================================
// Full Integration Test: Code Movement & Modification
// Keep the unchanged middle larger than the helper's retained matching lines so
// size-aware stationary selection reports the modified helper as the moved block.
// =============================================================================
console.log("\n=== BlockTraceDiff: Full Integration ===");
{
    const engine = new BlockTraceDiff({ kGramSize: 2, maxStitchGap: 2 });

    const source = [
        "// A function we will move",
        "function helper() {",
        "    let a = 1;",
        "    let b = 2;",
        "    return a + b;",
        "}",
        "",
        "// Unchanged middle part",
        "const x = 42;",
        "const y = x + 1;",
        "const z = x + y;",
        "console.log(x);",
        "console.log(y);",
        "console.log(z);",
        "",
        "// A deleted line",
        "const toDelete = true;",
    ];

    const target = [
        "// A newly inserted line",
        "",
        "// Unchanged middle part",
        "const x = 42;",
        "const y = x + 1;",
        "const z = x + y;",
        "console.log(x);",
        "console.log(y);",
        "console.log(z);",
        "",
        "// A function we will move",
        "function helper() {",
        "    let a = 1;",
        "    let b = 20;", // Modified line!
        "    return a + b;",
        "}",
    ];

    const ops = engine.diff(source, target);

    const moveFrom = ops.find(o => o.type === "MOVE_FROM");
    const moveTo = ops.find(o => o.type === "MOVE_TO");

    assert(moveFrom !== undefined, "should have found MOVE_FROM operation");
    assert(moveTo !== undefined, "should have found MOVE_TO operation");

    if (moveFrom && moveTo) {
        assert(moveFrom.moveId === moveTo.moveId, "MOVE_FROM and MOVE_TO should share the same moveId");
        assert(moveFrom.moveType === "MOVE_MODIFIED", "moveType should be MOVE_MODIFIED");
        assert(moveTo.moveType === "MOVE_MODIFIED", "moveType should be MOVE_MODIFIED");

        const expectedFromLines = [
            "// A function we will move",
            "function helper() {",
            "    let a = 1;",
            "    let b = 2;",
            "    return a + b;",
            "}",
        ];
        assertDeepEqual(moveFrom.lines, expectedFromLines, "MOVE_FROM lines should be original helper lines");

        const expectedToLines = [
            "// A function we will move",
            "function helper() {",
            "    let a = 1;",
            "    let b = 20;",
            "    return a + b;",
            "}",
        ];
        assertDeepEqual(moveTo.lines, expectedToLines, "MOVE_TO lines should be target helper lines");

        assert(moveTo.internalDiff !== undefined, "MOVE_TO should have internalDiff");
        if (moveTo.internalDiff) {
            const diffTypes = moveTo.internalDiff.map(d => d.type);
            assert(diffTypes.includes("DELETE"), "internalDiff should contain a DELETE");
            assert(diffTypes.includes("INSERT"), "internalDiff should contain an INSERT");

            const deletedOp = moveTo.internalDiff.find(d => d.type === "DELETE");
            const insertedOp = moveTo.internalDiff.find(d => d.type === "INSERT");

            assert(deletedOp.text === "    let b = 2;", `deleted text should be '    let b = 2;', got '${deletedOp.text}'`);
            assert(insertedOp.text === "    let b = 20;", `inserted text should be '    let b = 20;', got '${insertedOp.text}'`);
        }
    }
}

// =============================================================================
// REPLACE Operations for line replacement
// =============================================================================
console.log("\n=== BlockTraceDiff: REPLACE Operations ===");
{
    const engine = new BlockTraceDiff();

    // Case 1: Simple single line replacement
    const ops1 = engine.diff(["let x = 1;"], ["let x = 2;"]);
    assert(ops1.length === 1, "should return exactly 1 operation");
    assert(ops1[0].type === "REPLACE", "operation should be REPLACE");
    assert(ops1[0].text === "let x = 2;", "replaced text should match target");
    assertDeepEqual(ops1[0].internalDiff, [
        { type: "DELETE", text: "let x = 1;" },
        { type: "INSERT", text: "let x = 2;" },
    ], "internalDiff should have the delete and insert pair");

    // Case 2: Unequal number of deletes and inserts
    const ops2 = engine.diff(["A", "B"], ["X"]);
    assert(ops2.length === 2, "should return 2 operations");
    assert(ops2[0].type === "REPLACE", "first op should be REPLACE");
    assert(ops2[1].type === "DELETE", "second op should be DELETE");
}

// =============================================================================
// Comprehensive Edge Cases and Stress Tests
// =============================================================================
console.log("\n=== BlockTraceDiff: Comprehensive Edge Cases and Stress Tests ===");
{
    const engine = new BlockTraceDiff();

    // 1. Empty Inputs
    const emptyOps = engine.diff([], []);
    assert(emptyOps.length === 0, `empty input should return 0 ops, got ${emptyOps.length}`);

    // 2. One Empty, One populated
    const emptySrcOps = engine.diff([], ["A", "B"]);
    assert(emptySrcOps.length === 2, "empty src should return 2 ops");
    assert(emptySrcOps.every(op => op.type === "INSERT"), "all ops should be INSERT");

    const emptyTargetOps = engine.diff(["A", "B"], []);
    assert(emptyTargetOps.length === 2, "empty target should return 2 ops");
    assert(emptyTargetOps.every(op => op.type === "DELETE"), "all ops should be DELETE");

    // 3. No Matches / Complete Replacement
    const replaceOps = engine.diff(["A", "B", "C"], ["X", "Y", "Z"]);
    const expectedReplace = [
        {
            type: "REPLACE",
            text: "X",
            lines: ["X"],
            srcLine: 1,
            targetLine: 1,
            internalDiff: [
                { type: "DELETE", text: "A" },
                { type: "INSERT", text: "X" },
            ],
        },
        {
            type: "REPLACE",
            text: "Y",
            lines: ["Y"],
            srcLine: 2,
            targetLine: 2,
            internalDiff: [
                { type: "DELETE", text: "B" },
                { type: "INSERT", text: "Y" },
            ],
        },
        {
            type: "REPLACE",
            text: "Z",
            lines: ["Z"],
            srcLine: 3,
            targetLine: 3,
            internalDiff: [
                { type: "DELETE", text: "C" },
                { type: "INSERT", text: "Z" },
            ],
        },
    ];
    assertDeepEqual(replaceOps, expectedReplace, "complete replacement");

    // 4. Case Sensitivity check
    const caseOps = engine.diff(["FOO BAR", "FOO BAZ"], ["foo bar", "foo baz"]);
    assert(caseOps.every(op => op.type === "REPLACE"), "casing differences should fall back to replaced operations");

    // 5. Multiple moves swapping places
    const srcMulti = ["A1", "A2", "A3", "middle", "B1", "B2", "B3"];
    const targetMulti = ["B1", "B2", "B3", "middle", "A1", "A2", "A3"];

    const multiOps = engine.diff(srcMulti, targetMulti);

    const moveFroms = multiOps.filter(o => o.type === "MOVE_FROM");
    const moveTos = multiOps.filter(o => o.type === "MOVE_TO");

    assert(moveFroms.length === 1, `should find exactly 1 MOVE_FROM, got ${moveFroms.length}`);
    assert(moveTos.length === 1, `should find exactly 1 MOVE_TO, got ${moveTos.length}`);

    if (moveFroms.length === 1 && moveTos.length === 1) {
        assert(moveFroms[0].moveId === moveTos[0].moveId, "MOVE_FROM and MOVE_TO should share the same moveId");
        assert(moveFroms[0].moveType === "MOVE_EXACT", "moveType should be MOVE_EXACT");
        assertDeepEqual(moveFroms[0].lines, ["A1", "A2", "A3"], "should have moved A1, A2, A3");
    }

    // Complex swap and inline modification (Programmer-focused diff)
    const complexSource = [
        "function processUserData(user) {",
        "    if (!user) return null;",
        "    const name = user.firstName + \" \" + user.lastName;",
        "    const email = user.email || \"no-email@example.com\";",
        "    console.log(\"Processing user: \" + name);",
        "    return {",
        "        fullName: name,",
        "        contact: email,",
        "        active: user.status === \"active\"",
        "    };",
        "}",
        "",
        "function calculateBilling(user, items) {",
        "    let total = 0;",
        "    for (const item of items) {",
        "        if (item.taxable) {",
        "            total += item.price * 1.15;",
        "        } else {",
        "            total += item.price;",
        "        }",
        "    }",
        "    if (user.isPremium) {",
        "        total = total * 0.9;",
        "    }",
        "    return total;",
        "}",
    ];

    const complexTarget = [
        "function calculateBilling(customer, items) {",
        "    let total = 0;",
        "    for (const item of items) {",
        "        total += item.price * getTaxRate(item.taxable);",
        "    }",
        "    if (customer.isPremium) {",
        "        console.log(\"Applying premium discount for customer\");",
        "        total = total * 0.85;",
        "    }",
        "    return total;",
        "}",
        "",
        "function getTaxRate(taxable) {",
        "    return taxable ? 1.15 : 1.0;",
        "}",
        "",
        "function processUserData(user) {",
        "    if (!user) return null;",
        "    try {",
        "        const name = user.firstName + \" \" + user.lastName;",
        "        const email = user.email || \"unknown@example.com\";",
        "        console.log(\"Processing user: \" + name);",
        "        return {",
        "            fullName: name,",
        "            contact: email,",
        "            active: user.status === \"active\"",
        "        };",
        "    } catch (err) {",
        "        console.error(\"Failed to process user data\", err);",
        "        return null;",
        "    }",
        "}",
    ];

    const complexEngine = new BlockTraceDiff({ kGramSize: 2, maxStitchGap: 3 });
    const complexOps = complexEngine.diff(complexSource, complexTarget);

    // Size-aware attribution keeps the larger retained processUserData region
    // stationary and moves the smaller surviving billing blocks instead.
    const processEqual = complexOps.find(o => o.type === "EQUAL" && o.text.includes("function processUserData"));
    assert(processEqual !== undefined, "should keep the larger processUserData match stationary");
    assert(complexOps.some(o => o.type === "MOVE_FROM"), "should identify moved billing source blocks");
    assert(complexOps.some(o => o.type === "MOVE_TO"), "should identify moved billing target blocks");
    assert(!complexOps.some(o => o.type === "MOVE_FROM" && o.lines[0].includes("processUserData")), "should not move the larger retained function");

    // Verify modifications still appear when a stitched modified block is stationary.
    const hasTryBlockInsert = complexOps.some(o => o.type === "INSERT" && o.text.includes("try {"));
    const emailReplace = complexOps.find(o => o.type === "REPLACE" && o.text.includes("unknown@example.com"));
    assert(hasTryBlockInsert, "should detect inserted try block inside processUserData");
    assert(emailReplace !== undefined, "should detect changed email fallback line");
    if (emailReplace) {
        assert(emailReplace.internalDiff[0].text.includes("no-email@example.com"), "should retain deleted old email fallback line");
        assert(emailReplace.internalDiff[1].text.includes("unknown@example.com"), "should retain inserted new email fallback line");
    }
    testCase("complex swap preserves coverage, order, text, and move pairs", () => {
        validatePublicDiff(complexSource, complexTarget, complexOps, true);
    });
}

// =============================================================================
// ignoreLeadingWhitespace and skipWhitespaceOps Options
// =============================================================================
console.log("\n=== BlockTraceDiff: ignoreLeadingWhitespace and skipWhitespaceOps ===");
{
    // ignoreLeadingWhitespace = false
    const engineNoIgnore = new BlockTraceDiff({
        ignoreLeadingWhitespace: false,
        skipWhitespaceOps: false,
    });
    const normalizedNoIgnore = engineNoIgnore._normalizeAndIntern(["  let x = 1;"]);
    assert(normalizedNoIgnore[0].normalizedText === "  let x = 1;", "should keep leading whitespace when ignoreLeadingWhitespace is false");

    // ignoreLeadingWhitespace = true
    const engineIgnore = new BlockTraceDiff({
        ignoreLeadingWhitespace: true,
        skipWhitespaceOps: false,
    });
    const normalizedIgnore = engineIgnore._normalizeAndIntern(["  let x = 1;"]);
    assert(normalizedIgnore[0].normalizedText === "let x = 1;", "should trim leading whitespace when ignoreLeadingWhitespace is true");

    // skipWhitespaceOps = true
    const engineSkip = new BlockTraceDiff({ skipWhitespaceOps: true });
    const opsSkip = engineSkip.diff(["A"], ["A", "  ", "B"]);
    const hasWhitespaceIns = opsSkip.some(op => op.type === "INSERT" && op.text.trim() === "");
    assert(!hasWhitespaceIns, "should skip whitespace-only insertions when skipWhitespaceOps is true");

    // skipWhitespaceOps = false
    const engineNoSkip = new BlockTraceDiff({ skipWhitespaceOps: false });
    const opsNoSkip = engineNoSkip.diff(["A"], ["A", "  ", "B"]);
    const hasWhitespaceInsNoSkip = opsNoSkip.some(op => op.type === "INSERT" && op.text.trim() === "");
    assert(hasWhitespaceInsNoSkip, "should keep whitespace-only insertions when skipWhitespaceOps is false");
}

// =============================================================================
// Edge cases & Bugs: Greedy Masking, REPLACE Interruption, and Memory Leaks
// =============================================================================
console.log("\n=== BlockTraceDiff: Edge cases & Bugs ===");
{
    // We expect the main candidate [10..14] to have a remaining valid segment [12..13] that is >= kGramSize (2).
    // The other candidates claim src 10, target 11, and src 14, leaving target 12..14 and src 11..13 unclaimed.
    const engine1 = new BlockTraceDiff({ kGramSize: 2 });
    const candidates = [
        { srcStart: 5, srcEnd: 10, targetStart: 105, targetEnd: 110, length: 6 }, // Claims src 5..10
        { srcStart: 200, srcEnd: 205, targetStart: 6, targetEnd: 11, length: 6 }, // Claims target 6..11
        { srcStart: 14, srcEnd: 19, targetStart: 300, targetEnd: 305, length: 6 }, // Claims src 14..19
        { srcStart: 10, srcEnd: 14, targetStart: 10, targetEnd: 14, length: 5 },   // Candidate to trim
    ];
    const result1 = engine1._greedyMasking(candidates);
    const hasTrimmedCand = result1.some(c => c.srcStart === 12 && c.srcEnd === 13 && c.targetStart === 12 && c.targetEnd === 13);
    assert(hasTrimmedCand, "greedy masking should keep valid sub-blocks of trimmed candidates");

    // In this swap, MOVE_FROM interrupts delete_me and insert_me in the same
    // change block. It must not prevent REPLACE or disturb either side's order.
    const engine2 = new BlockTraceDiff({ kGramSize: 2 });
    const src2 = ["delete_me", "A1", "A2", "B1", "B2"];
    const tgt2 = ["insert_me", "B1", "B2", "A1", "A2"];
    const ops2 = engine2.diff(src2, tgt2);
    const hasReplace2 = ops2.some(op => op.type === "REPLACE");
    assert(hasReplace2, "REPLACE should be identified even if a MOVE interrupts the contiguous delete/insert sequence");

    // If the interner is not cleared, reusing the same instance keeps growing the Map.
    const engine4 = new BlockTraceDiff();
    engine4.diff(["line1"], ["line2"]);
    engine4.diff(["line3"], ["line4"]);
    // If the interner was cleared or reset, size should not accumulate from the previous run.
    assert(engine4.interner.stringToInt.size <= 2, `interner should clear or reset on each diff call (got size ${engine4.interner.stringToInt.size})`);
}

// =============================================================================
// Public Options and Explicit Whitespace Contracts
// =============================================================================
console.log("\n=== BlockTraceDiff: Public Options and Whitespace Contracts ===");
testCase("invalid numeric options fail in the constructor", () => {
    for (const [name, minimum] of [["kGramSize", 1], ["maxStitchGap", 0], ["maxOccurrences", 0]]) {
        for (const value of [-1, 0.5, 1.5, NaN, Infinity, -Infinity, "2", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
            strictAssert.throws(() => new BlockTraceDiff({ [name]: value }),
                error => error instanceof RangeError && error.message.includes(name), `${name}=${String(value)}`);
        }
        strictAssert.equal(new BlockTraceDiff({ [name]: minimum })[name], minimum);
        strictAssert.equal(new BlockTraceDiff({ [name]: undefined })[name], new BlockTraceDiff()[name]);
    }
    strictAssert.throws(() => new BlockTraceDiff({ kGramSize: 0 }), RangeError);
});

testCase("boolean options and the options object are validated", () => {
    for (const name of ["ignoreLeadingWhitespace", "ignoreTrailingWhitespace", "ignoreInternalWhitespace", "skipWhitespaceOps"]) {
        for (const value of [0, 1, "false", null, NaN, {}, []]) {
            strictAssert.throws(() => new BlockTraceDiff({ [name]: value }),
                error => error instanceof TypeError && error.message.includes(name));
        }
        strictAssert.equal(new BlockTraceDiff({ [name]: false })[name], false);
        strictAssert.equal(new BlockTraceDiff({ [name]: true })[name], true);
    }
    for (const value of [null, [], "options", 1, false]) strictAssert.throws(() => new BlockTraceDiff(value), TypeError);
});

testCase("maxOccurrences: 0 intentionally disables anchoring", () => {
    const engine = new BlockTraceDiff({ maxOccurrences: 0, skipWhitespaceOps: false });
    const source = ["A1", "A2", "B1", "B2"];
    const target = ["B1", "B2", "A1", "A2"];
    strictAssert.deepEqual(engine._findAnchors(engine._normalizeAndIntern(source), engine._normalizeAndIntern(target)), []);
    const ops = engine.diff(source, target);
    strictAssert.ok(ops.every(op => op.type !== "MOVE_FROM" && op.type !== "MOVE_TO"));
    validatePublicDiff(source, target, ops);
});

testCase("internal and trailing whitespace changes are visible by default", () => {
    for (const [source, target] of [
        ["const s = \"a  b\";", "const s = \"a b\";"],
        ["const r = /a  b/;", "const r = /a b/;"],
        ["const s = `a\tb`;", "const s = `a b`;"],
        ["value  ", "value"],
    ]) {
        const ops = new BlockTraceDiff().diff([source], [target]);
        strictAssert.equal(ops.length, 1);
        strictAssert.equal(ops[0].type, "REPLACE");
        validatePublicDiff([source], [target], ops);
    }
});

testCase("disabling whitespace options provides an exact, lossless diff", () => {
    const engine = new BlockTraceDiff({ ignoreLeadingWhitespace: false, skipWhitespaceOps: false });
    for (const [source, target] of [["  a", "a"], ["a\t", "a"], ["a  b", "a b"], [" \t", ""], ["\u00a0a", "a"]]) {
        const ops = engine.diff([source], [target]);
        strictAssert.equal(ops[0].type, "REPLACE");
        validatePublicDiff([source], [target], ops, false, 1, 1, engine);
    }
    validatePublicDiff(["", "old"], ["new", "\t"], engine.diff(["", "old"], ["new", "\t"]), false, 1, 1, engine);
});

testCase("leading, internal, and trailing normalization options are independent", () => {
    const line = " \talpha  \t beta\t ";
    for (const leading of [false, true]) {
        for (const internal of [false, true]) {
            for (const trailing of [false, true]) {
                const engine = new BlockTraceDiff({
                    ignoreLeadingWhitespace: leading,
                    ignoreInternalWhitespace: internal,
                    ignoreTrailingWhitespace: trailing,
                });
                const expected = (leading ? "" : " \t") + (internal ? "alpha beta" : "alpha  \t beta") + (trailing ? "" : "\t ");
                strictAssert.equal(engine._normalizeAndIntern([line])[0].normalizedText, expected);
            }
        }
    }
    const internalOnly = new BlockTraceDiff({
        ignoreLeadingWhitespace: false,
        ignoreInternalWhitespace: true,
    });
    strictAssert.equal(internalOnly._normalizeAndIntern([" \t "])[0].normalizedText, " \t ");
});

testCase("explicitly ignored differences preserve both raw texts", () => {
    const engine = new BlockTraceDiff({
        ignoreInternalWhitespace: true,
        ignoreTrailingWhitespace: true,
        skipWhitespaceOps: false,
    });
    const source = ["  const s = \"a  b\";  "];
    const target = ["const s = \"a b\";"];
    const ops = engine.diff(source, target);
    strictAssert.equal(ops[0].type, "EQUAL");
    strictAssert.equal(ops[0].isExact, false);
    validatePublicDiff(source, target, ops, false, 1, 1, engine);
});

testCase("EQUAL ownership is consistent for ordinary, exact, stitched, and gap matches", () => {
    const source = ["  A", "  B", "old", "  C", "  D"];
    const target = ["A", "B", "new", "C", "D"];
    const equalPayloads = [];
    for (const maxStitchGap of [0, 2]) {
        const ops = new BlockTraceDiff({
            maxStitchGap,
            skipWhitespaceOps: false,
        }).diff(source, target);
        equalPayloads.push(ops.filter(op => op.type === "EQUAL"));
        validatePublicDiff(source, target, ops);
    }
    strictAssert.deepEqual(equalPayloads[0], equalPayloads[1]);
    const gapSource = ["  A", "  B", "old1", "  gap", "old2", "  C", "  D"];
    const gapTarget = ["A", "B", "new1", "gap", "new2", "C", "D"];
    const gapOps = new BlockTraceDiff({
        maxStitchGap: 3,
        skipWhitespaceOps: false,
    }).diff(gapSource, gapTarget);
    strictAssert.ok(gapOps.some(op => op.type === "EQUAL" && op.sourceText === "  gap" && op.targetText === "gap"));
    validatePublicDiff(gapSource, gapTarget, gapOps);
    validatePublicDiff(["  only"], ["only"], new BlockTraceDiff().diff(["  only"], ["only"]));
});

testCase("normalized exact moves expose raw differences in internalDiff", () => {
    const source = ["  A1", "  A2", "B1", "B2", "B3"];
    const target = ["B1", "B2", "B3", "A1", "A2"];
    const ops = new BlockTraceDiff({ skipWhitespaceOps: false }).diff(source, target);
    const moved = ops.find(op => op.type === "MOVE_TO");
    strictAssert.equal(moved.moveType, "MOVE_EXACT");
    strictAssert.ok(moved.internalDiff.every(op => op.type === "EQUAL" && !op.isExact));
    validatePublicDiff(source, target, ops);
});

testCase("blank edits do not consume visible replacement partners", () => {
    for (const [source, target] of [
        [["", "old"], ["new"]],
        [["old"], ["\t", "new"]],
        [["", "old", " "], ["\t", "new", "\t\t"]],
    ]) {
        const engine = new BlockTraceDiff({
            ignoreLeadingWhitespace: false,
            skipWhitespaceOps: true,
        });
        const ops = engine.diff(source, target);
        const replacements = ops.filter(op => op.type === "REPLACE");
        strictAssert.equal(replacements.length, 1);
        strictAssert.deepEqual(replacements[0].internalDiff, [
            { type: "DELETE", text: "old" },
            { type: "INSERT", text: "new" },
        ]);
        strictAssert.equal(hasBlankEdit(ops), false);
        validatePublicDiff(source, target, ops, true, 1, 1, engine);
    }
});

testCase("blank edit suppression applies inside modified moves in either direction", () => {
    const a = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "B5"];
    const b = ["B1", "B2", "B3", "B4", "B5", "A1", "A2", "", "A3", "A4"];
    for (const [source, target] of [[a, b], [b, a]]) {
        for (const skipWhitespaceOps of [false, true]) {
            const ops = new BlockTraceDiff({ skipWhitespaceOps }).diff(source, target);
            const moved = ops.find(op => op.type === "MOVE_TO");
            strictAssert.ok(moved && moved.internalDiff, "exercise a nested modified move, not just top-level edits");
            strictAssert.equal(hasBlankEdit(ops), !skipWhitespaceOps);
            validatePublicDiff(source, target, ops, skipWhitespaceOps);
        }
    }
});

// =============================================================================
// Move Integrity, Operation Ordering, and Size-Aware Attribution
// =============================================================================
console.log("\n=== BlockTraceDiff: Move Integrity and Operation Ordering ===");
testCase("stitching cannot swallow another move's destination", () => {
    const a = ["C1", "C2", "A1", "A2", "B1", "B2"];
    const b = ["A1", "A2", "C1", "C2", "B1", "B2"];
    for (const [source, target] of [[a, b], [b, a]]) {
        const engine = new BlockTraceDiff({ skipWhitespaceOps: false });
        const src = engine._normalizeAndIntern(source);
        const tgt = engine._normalizeAndIntern(target);
        const exact = engine._greedyMasking(engine._seedAndExpand(engine._findAnchors(src, tgt), src, tgt));
        const stitched = engine._gapStitching(exact);
        strictAssert.equal(stitched.length, 3, "the target gap is already claimed");
        validateMoveRanges(stitched);
        validatePublicDiff(source, target, engine.diff(source, target));
    }
});

testCase("stitching accepts only adjacent blocks on both sides and preserves its input", () => {
    const engine = new BlockTraceDiff({ maxStitchGap: 2 });
    const blocks = [
        { srcStart: 6, srcEnd: 7, targetStart: 16, targetEnd: 17, length: 2 },
        { srcStart: 0, srcEnd: 1, targetStart: 10, targetEnd: 11, length: 2 },
        { srcStart: 3, srcEnd: 4, targetStart: 13, targetEnd: 14, length: 2 },
    ];
    const before = JSON.stringify(blocks);
    const stitched = engine._gapStitching(blocks);
    strictAssert.equal(stitched.length, 1);
    strictAssert.equal(stitched[0].exactBlocks.length, 3);
    strictAssert.equal(stitched[0].srcEnd, 7);
    strictAssert.equal(stitched[0].targetEnd, 17);
    strictAssert.equal(JSON.stringify(blocks), before);
    validateMoveRanges(stitched);
});

testCase("ordinary edits before and after moves preserve both consuming orders", () => {
    for (const [source, target] of [
        [["A1", "A2", "B1", "B2"], ["B1", "B2", "A1", "A2", "X"]],
        [["A1", "A2", "X", "B1", "B2"], ["B1", "B2", "A1", "A2"]],
        [["delete_me", "A1", "A2", "B1", "B2"], ["insert_me", "B1", "B2", "A1", "A2"]],
        [["old", "A1", "A2", "X", "B1", "B2"], ["new", "B1", "B2", "Y", "A1", "A2", "Z"]],
    ]) {
        for (const [a, b] of [[source, target], [target, source]]) {
            const ops = new BlockTraceDiff({ skipWhitespaceOps: false }).diff(a, b);
            strictAssert.ok(ops.some(op => op.type === "MOVE_FROM"));
            validatePublicDiff(a, b, ops);
        }
    }
});

testCase("replacement pairing preserves mixed move/edit order within a hunk", () => {
    // The paired halves of these moves can be in other hunks. Isolate this hunk's
    // source and target projections so attribution heuristics cannot mask a regression.
    const ops = [
        { type: "MOVE_FROM", srcStartLine: 1, srcEndLine: 2 },
        { type: "DELETE", srcLine: 3, text: "old1" },
        { type: "MOVE_FROM", srcStartLine: 4, srcEndLine: 5 },
        { type: "DELETE", srcLine: 6, text: "old2" },
        { type: "INSERT", targetLine: 1, text: "new1" },
        { type: "MOVE_TO", targetStartLine: 2, targetEndLine: 3 },
        { type: "INSERT", targetLine: 4, text: "new2" },
        { type: "MOVE_TO", targetStartLine: 5, targetEndLine: 6 },
        { type: "INSERT", targetLine: 7, text: "extra" },
    ];
    const engine = new BlockTraceDiff();
    const result = engine._identifyReplacements(engine._sortOperations(ops));
    strictAssert.deepEqual(lineNumbers(result, "source"), [1, 2, 3, 4, 5, 6]);
    strictAssert.deepEqual(lineNumbers(result, "target"), [1, 2, 3, 4, 5, 6, 7]);
    strictAssert.equal(result.filter(op => op.type === "REPLACE").length, 2);
});

testCase("unequal block swaps move two lines instead of one hundred", () => {
    const a = Array.from({ length: 100 }, (_, i) => `A${i + 1}`);
    const b = ["B1", "B2"];
    for (const [source, target] of [[a.concat(b), b.concat(a)], [b.concat(a), a.concat(b)]]) {
        const ops = new BlockTraceDiff({ skipWhitespaceOps: false }).diff(source, target);
        strictAssert.equal(ops.filter(op => op.type === "EQUAL").length, 100);
        strictAssert.deepEqual(ops.find(op => op.type === "MOVE_FROM").lines, b);
        strictAssert.deepEqual(ops.find(op => op.type === "MOVE_TO").lines, b);
        validatePublicDiff(source, target, ops);
    }
});

testCase("weighted stationary selection matches an exhaustive subset oracle", () => {
    const rand = createRandom(0x917156);
    const engine = new BlockTraceDiff();
    for (let iteration = 0; iteration < 500; iteration++) {
        const n = rand(9);
        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
            const j = rand(i + 1);
            [order[i], order[j]] = [order[j], order[i]];
        }
        const moves = order.map((targetRank, i) => ({
            id: `test-${i}`, srcStart: i * 20, targetStart: targetRank * 20,
            exactBlocks: [{ length: 1 + rand(10) }],
        }));
        let optimum = 0;
        for (let mask = 0; mask < 2 ** n; mask++) {
            let lastTarget = -1, weight = 0, increasing = true;
            for (let i = 0; i < n; i++) {
                if (!(mask & (1 << i))) continue;
                if (moves[i].targetStart <= lastTarget) increasing = false;
                lastTarget = moves[i].targetStart;
                weight += moves[i].exactBlocks[0].length;
            }
            if (increasing) optimum = Math.max(optimum, weight);
        }
        const stationary = engine._selectStationaryMoves(moves);
        const selected = moves.filter(move => stationary.has(move.id));
        strictAssert.equal(selected.reduce((sum, move) => sum + move.exactBlocks[0].length, 0), optimum);
        strictAssert.ok(selected.every((move, i) => i === 0 || selected[i - 1].targetStart < move.targetStart));
        strictAssert.deepEqual(stationary, engine._selectStationaryMoves(moves.slice().reverse()));
    }
});

testCase("unmatched stitched gaps do not inflate stationary weights", () => {
    const moves = [
        {
            id: "large-gap",
            srcStart: 0,
            srcEnd: 999,
            targetStart: 20,
            targetEnd: 1019,
            exactBlocks: [{ length: 2 }, { length: 2 }],
        },
        {
            id: "retained",
            srcStart: 1000,
            srcEnd: 1009,
            targetStart: 0,
            targetEnd: 9,
            exactBlocks: [{ length: 10 }],
        },
    ];
    strictAssert.deepEqual(new BlockTraceDiff()._selectStationaryMoves(moves), new Set(["retained"]));
});

// =============================================================================
// Exhaustive and Deterministic Randomized Correctness Checks
// =============================================================================
console.log("\n=== BlockTraceDiff: Exhaustive and Randomized Invariants ===");
testCase("Myers: all 65,025 binary sequence pairs of lengths 0 through 7", () => {
    const sequences = [[]];
    for (let n = 1; n <= 7; n++) {
        for (let mask = 0; mask < 2 ** n; mask++) {
            sequences.push(Array.from({ length: n }, (_, i) => (mask >> i) & 1));
        }
    }
    const engine = new BlockTraceDiff();
    for (const a of sequences) for (const b of sequences) validateMyers(a, b, engine._myersDiff(a, b));
});

testCase("Myers: 20,000 deterministic randomized cases versus a distance oracle", () => {
    const rand = createRandom(123456789);
    const engine = new BlockTraceDiff();
    for (let i = 0; i < 20000; i++) {
        const a = Array.from({ length: rand(60) }, () => rand(7));
        const b = Array.from({ length: rand(60) }, () => rand(7));
        validateMyers(a, b, engine._myersDiff(a, b));
    }
});

testCase("Public API: coverage, ordering, text, and move pairs in 10,000 synthetic cases", () => {
    const rand = createRandom(0x7187369);
    const engine = new BlockTraceDiff({ skipWhitespaceOps: false });
    const originalStitching = engine._gapStitching;
    engine._gapStitching = function(...args) {
        const moves = originalStitching.apply(this, args);
        validateMoveRanges(moves);
        return moves;
    };
    for (let i = 0; i < 10000; i++) {
        const source = Array.from({ length: rand(35) }, () => String.fromCharCode(65 + rand(6)));
        const target = Array.from({ length: rand(35) }, () => String.fromCharCode(65 + rand(6)));
        const ops = engine.diff(source, target);
        // Check ordered coverage, text fidelity, and move relationships.
        validatePublicDiff(source, target, ops);
    }
});

testCase("Public API: 5,000 cases with whitespace, suppression, and varied matching options", () => {
    const rand = createRandom(0x9716241);
    const lines = ["", " ", "\t", "A", "  A", "A ", "B", "B\t", "C", "a  b", "a b", "s = \"a  b\";", "s = \"a b\";"];
    for (let i = 0; i < 5000; i++) {
        const engine = new BlockTraceDiff({
            kGramSize: 1 + rand(4), maxStitchGap: rand(5), maxOccurrences: rand(8),
            ignoreLeadingWhitespace: rand(2) === 1,
            ignoreTrailingWhitespace: rand(2) === 1,
            ignoreInternalWhitespace: rand(2) === 1,
            skipWhitespaceOps: rand(2) === 1,
        });
        const source = Array.from({ length: rand(35) }, () => lines[rand(lines.length)]);
        const target = Array.from({ length: rand(35) }, () => lines[rand(lines.length)]);
        const ops = engine.diff(source, target);
        validatePublicDiff(source, target, ops, engine.skipWhitespaceOps, 1, 1, engine);
        if (engine.skipWhitespaceOps) strictAssert.equal(hasBlankEdit(ops), false);
    }
});

testCase("reusing an engine is deterministic and does not mutate caller arrays", () => {
    const source = Object.freeze(["A1", "A2", "B1", "B2", "old"]);
    const target = Object.freeze(["B1", "B2", "A1", "A2", "new"]);
    const engine = new BlockTraceDiff({ skipWhitespaceOps: false });
    const first = engine.diff(source, target);
    engine.diff(["unrelated"], ["content"]);
    const second = engine.diff(source, target);
    strictAssert.deepEqual(second, first);
    validatePublicDiff(source, target, second);
});

// =============================================================================
// Large Inputs and Deterministic Performance Regressions
// =============================================================================
console.log("\n=== BlockTraceDiff: Large Inputs and Bounded Work ===");
for (const insertion of [true, false]) {
    testCase(`150,000-line pure ${insertion ? "insertion" : "deletion"} does not overflow function arguments`, () => {
        // The original argument-spread crash reproduced at 150k on Node 22.16.0;
        // this also exercises presentation and both replacement-assembly leftovers.
        const lines = Array(150000).fill("X");
        const source = insertion ? [] : lines;
        const target = insertion ? lines : [];
        const ops = new BlockTraceDiff({ skipWhitespaceOps: false }).diff(source, target);
        strictAssert.equal(ops.length, lines.length);
        strictAssert.ok(ops.every(op => op.type === (insertion ? "INSERT" : "DELETE")));
        validatePublicDiff(source, target, ops);
    });
}

testCase("a large stitched modified block expands without argument spreading", () => {
    const source = ["A1", "A2"].concat(Array(150000).fill("removed"), ["B1", "B2"]);
    const target = ["A1", "A2", "B1", "B2"];
    const engine = new BlockTraceDiff({ maxStitchGap: 150000, skipWhitespaceOps: false });
    let expanded = false;
    const original = engine._calcInternalMod;
    engine._calcInternalMod = function(...args) {
        expanded = true;
        return original.apply(this, args);
    };
    const ops = engine.diff(source, target);
    strictAssert.ok(expanded, "must exercise modified-block expansion");
    strictAssert.equal(ops.length, source.length);
    strictAssert.equal(ops.filter(op => op.type === "DELETE").length, 150000);
    validatePublicDiff(source, target, ops);
});

testCase("150,000 replacements can be assembled without overflowing function arguments", () => {
    // Isolate output assembly; a completely unrelated 150k-by-150k Myers problem
    // would test quadratic edit distance rather than the argument-spread regression.
    const source = Array.from({ length: 150000 }, (_, i) => ({
        type: "DELETE",
        srcLine: i + 1,
        text: "old",
    }));
    const target = Array.from({ length: 150000 }, (_, i) => ({
        type: "INSERT",
        targetLine: i + 1,
        text: "new",
    }));
    const ops = new BlockTraceDiff()._identifyReplacements(source.concat(target));
    strictAssert.equal(ops.length, 150000);
    strictAssert.ok(ops.every((op, i) => op.type === "REPLACE" && op.srcLine === i + 1 && op.targetLine === i + 1));
});

testCase("seed expansion scans each equal diagonal run once, including nearly identical files", () => {
    for (const n of [4000, 8000]) {
        for (const change of ["none", "replace", "insert"]) {
            const engine = new BlockTraceDiff({ skipWhitespaceOps: false });
            const source = Array.from({ length: n }, (_, i) => `line-${i}`);
            const target = source.slice();
            if (change === "replace") target[n >> 1] = "changed";
            if (change === "insert") target.splice(n >> 1, 0, "inserted");
            const src = engine._normalizeAndIntern(source);
            const tgt = engine._normalizeAndIntern(target);
            const anchors = engine._findAnchors(src, tgt).reverse();
            let reads = 0;
            for (const arr of [src, tgt]) {
                for (const line of arr) {
                    const value = line.intVal;
                    Object.defineProperty(line, "intVal", {
                        get() {
                            reads++;
                            return value;
                        },
                    });
                }
            }
            const candidates = engine._seedAndExpand(anchors, src, tgt);
            strictAssert.equal(candidates.length, change === "none" ? 1 : 2);
            strictAssert.ok(reads < n * 8 + 50, `${change}, n=${n}: ${reads} interned-value reads indicates repeated expansion`);
            validatePublicDiff(source, target, engine.diff(source, target));
        }
    }
});

testCase("expansion caches full runs before trimming blank padding", () => {
    const engine = new BlockTraceDiff({ kGramSize: 1, ignoreLeadingWhitespace: false });
    const source = engine._normalizeAndIntern(["\t", "A", "B", " ", "changed", "C", "D", "\t"]);
    const target = engine._normalizeAndIntern(["\t", "A", "B", " ", "other", "C", "D", "\t"]);
    const anchors = engine._findAnchors(source, target).reverse();
    const candidates = engine._seedAndExpand(anchors, source, target);
    strictAssert.deepEqual(candidates.map(c => [c.srcStart, c.srcEnd, c.targetStart, c.targetEnd]), [[1, 2, 1, 2], [5, 6, 5, 6]]);
});

testCase("run construction indexes moves instead of rescanning the move list", () => {
    const count = 1000;
    const engine = new BlockTraceDiff({ maxStitchGap: 0 });
    const source = Array.from({ length: count }, (_, i) => [`A${i}`, `B${i}`, `old${i}`]).flat();
    const target = Array.from({ length: count }, (_, i) => [`A${i}`, `B${i}`, `new${i}`]).flat();
    const src = engine._normalizeAndIntern(source);
    const tgt = engine._normalizeAndIntern(target);
    const moves = engine._gapStitching(engine._greedyMasking(engine._seedAndExpand(engine._findAnchors(src, tgt), src, tgt)));
    strictAssert.equal(moves.length, count);
    let reads = 0;
    const tracked = new Proxy(moves, {
        get(array, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) reads++;
            return Reflect.get(array, key, receiver);
        },
    });
    engine._myersDiff = () => [];
    engine._buildFinalOutput = () => [];
    engine._fallbackDiffAndReassemble(src, tgt, tracked, source, target);
    strictAssert.ok(reads < count * 30, `${reads} move-index reads indicates repeated linear searches`);
});

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
