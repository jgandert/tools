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

    const diffCustom = new BlockTraceDiff({ kGramSize: 3, maxStitchGap: 1 });
    assert(diffCustom.kGramSize === 3, "custom kGramSize should be 3");
    assert(diffCustom.maxStitchGap === 1, "custom maxStitchGap should be 1");
}

// =============================================================================
// Normalization and Interning
// =============================================================================
console.log("\n=== BlockTraceDiff: Line Normalization ===");
{
    const engine = new BlockTraceDiff();
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
        "console.log(x);",
        "",
        "// A deleted line",
        "const toDelete = true;",
    ];

    const target = [
        "// A newly inserted line",
        "",
        "// Unchanged middle part",
        "const x = 42;",
        "console.log(x);",
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

    const complexMoveFrom = complexOps.find(o => o.type === "MOVE_FROM" && o.lines[0].includes("processUserData"));
    const complexMoveTo = complexOps.find(o => o.type === "MOVE_TO" && o.lines[0].includes("processUserData"));

    assert(complexMoveFrom !== undefined, "should identify moved processUserData function");
    assert(complexMoveTo !== undefined, "should identify processUserData target function");

    if (complexMoveFrom && complexMoveTo) {
        assert(complexMoveFrom.moveId === complexMoveTo.moveId, "processUserData move components should share move ID");
        assert(complexMoveFrom.moveType === "MOVE_MODIFIED", "processUserData move type should be MOVE_MODIFIED");
        assert(complexMoveTo.moveType === "MOVE_MODIFIED", "processUserData target type should be MOVE_MODIFIED");

        // Verify internal modifications of the moved block
        const internalDiff = complexMoveTo.internalDiff;
        assert(internalDiff !== undefined, "moved processUserData target should have internal diff");

        if (internalDiff) {
            const hasTryBlockInsert = internalDiff.some(d => d.type === "INSERT" && d.text.includes("try {"));
            const hasEmailDelete = internalDiff.some(d => d.type === "DELETE" && d.text.includes("no-email@example.com"));
            const hasEmailInsert = internalDiff.some(d => d.type === "INSERT" && d.text.includes("unknown@example.com"));

            assert(hasTryBlockInsert, "should detect inserted try block inside processUserData");
            assert(hasEmailDelete, "should detect deleted old email fallback line");
            assert(hasEmailInsert, "should detect inserted new email fallback line");
        }
    }
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
        { srcStart: 10, srcEnd: 14, targetStart: 10, targetEnd: 14, length: 5 }   // Candidate to trim
    ];
    const result1 = engine1._greedyMasking(candidates);
    const hasTrimmedCand = result1.some(c => c.srcStart === 12 && c.srcEnd === 13 && c.targetStart === 12 && c.targetEnd === 13);
    assert(hasTrimmedCand, "greedy masking should keep valid sub-blocks of trimmed candidates");

    // In this swap, delete_me and insert_me are in the same block, but MOVE_FROM interrupts them, preventing REPLACE.
    const engine2 = new BlockTraceDiff({ kGramSize: 2 });
    const src2 = ["delete_me", "A1", "A2", "B1", "B2"];
    const tgt2 = ["insert_me", "B1", "B2", "A1", "A2"];
    const ops2 = engine2.diff(src2, tgt2);
    const hasReplace2 = ops2.some(op => op.type === "REPLACE");
    assert(hasReplace2, "REPLACE should be identified even if a MOVE interrupts the contiguous delete/insert sequence");

    // If the interner is not cleared, reusing the same instance keeps growing the Map.
    const engine4 = new BlockTraceDiff();
    engine4.diff(["line1"], ["line2"]);
    const sizeBefore = engine4.interner.stringToInt.size;
    engine4.diff(["line3"], ["line4"]);
    // If the interner was cleared or reset, size should not accumulate from the previous run.
    assert(engine4.interner.stringToInt.size <= 2, `interner should clear or reset on each diff call (got size ${engine4.interner.stringToInt.size})`);
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
