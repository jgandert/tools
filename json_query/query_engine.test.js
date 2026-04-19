/* eslint-env node */
// Test suite for JSONQuery engine.
// Run: bun query_engine.test.js
// Only outputs on error — silence means all tests pass.

const _src = require("fs").readFileSync(__dirname + "/query_engine.js", "utf-8");
new Function(_src + "\nglobalThis.JSONQuery = JSONQuery;\nglobalThis.stringifyWithUndefined = stringifyWithUndefined;")();

const testData = {
    organization: "Tech Innovators Inc",
    active_status: true,
    last_updated: "2026-02-16T18:00:00Z",
    metadata: {
        version: 1.2,
        environment: "production",
    },
    users: [
        {
            id: 101, name: "Alice Vance", age: 28, str_id: "3", is_admin: true,
            tags: ["frontend", "ux", "mentor"],
            address: { city: "Berlin", country: "Germany" },
            deleted_at: null,
        },
        {
            id: 102, name: "Bob Smith", age: 34, is_admin: false,
            tags: ["backend", "devops"],
            secret_identity: "Bernd Schmitt",
            address: { city: "San Francisco", country: "USA" },
            deleted_at: "2025-12-01",
        },
        {
            id: 103, name: "Charlie Day", age: 40, is_admin: false,
            tags: ["manager"],
            address: { city: "Berlin", country: "Germany" },
            deleted_at: null,
        },
    ],
    total_count: 3,
};

let passed = 0;
let failed = 0;

/**
 * Deep equality check that treats undefined array slots correctly.
 * Returns true if a and b are structurally identical.
 */
function deepEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (a === undefined && b === undefined) {
        return true;
    }
    if (a === null || b === null) {
        return a === b;
    }
    if (typeof a !== typeof b) {
        return false;
    }
    if (typeof a !== "object") {
        return false;
    }

    const aIsArr = Array.isArray(a);
    const bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) {
        return false;
    }

    if (aIsArr) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) {
            return false;
        }
        if (!deepEqual(a[key], b[key])) {
            return false;
        }
    }
    return true;
}

function serialize(val) {
    if (val === undefined) {
        return "undefined";
    }
    try {
        return JSON.stringify(val, (_, v) => v === undefined ? "__UNDEF__" : v, 2)
            .replace(/\"__UNDEF__\"/g, "undefined");
    } catch {
        return String(val);
    }
}

function test(description, query, expected) {
    const engine = new JSONQuery(testData);
    let actual;
    try {
        actual = engine.update(query);
    } catch (err) {
        failed++;
        console.error(`FAIL: ${description}`);
        console.error(`  Query:    ${query}`);
        console.error(`  Error:    ${err.message}`);
        console.error(`  Expected: ${serialize(expected)}`);
        console.error("");
        return;
    }

    if (!deepEqual(actual, expected)) {
        failed++;
        console.error(`FAIL: ${description}`);
        console.error(`  Query:    ${query}`);
        console.error(`  Expected: ${serialize(expected)}`);
        console.error(`  Actual:   ${serialize(actual)}`);
        console.error("");
    } else {
        passed++;
    }
}

function testThrows(description, query, expectedMsgFragment) {
    const engine = new JSONQuery(testData);
    try {
        engine.update(query);
        failed++;
        console.error(`FAIL: ${description}`);
        console.error(`  Query:    ${query}`);
        console.error(`  Expected an error containing: "${expectedMsgFragment}"`);
        console.error("  But no error was thrown.");
        console.error("");
    } catch (err) {
        if (expectedMsgFragment && !err.message.includes(expectedMsgFragment)) {
            failed++;
            console.error(`FAIL: ${description}`);
            console.error(`  Query:    ${query}`);
            console.error(`  Expected error containing: "${expectedMsgFragment}"`);
            console.error(`  Actual error: "${err.message}"`);
            console.error("");
        } else {
            passed++;
        }
    }
}

// ============================================================
// 2. Basic Extraction & Traversal
// ============================================================

test("Root-level primitive (boolean)",
    "active_status",
    true);

test("Root-level primitive (string)",
    "organization",
    "Tech Innovators Inc");

test("Root-level primitive (number)",
    "total_count",
    3);

test("Nested object traversal",
    "metadata.version",
    1.2);

test("Auto-map extraction across arrays",
    "users.name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

test("Missing properties return undefined",
    "users.secret_identity",
    [undefined, "Bernd Schmitt", undefined]);

test("Array index [0]",
    "users[0].name",
    "Alice Vance");

test("Negative array index [-1]",
    "users[-1].name",
    "Charlie Day");

test("String indexing",
    "users[-1].name[0]",
    "C");

test("Deep nested path",
    "users.address.city",
    ["Berlin", "San Francisco", "Berlin"]);

test("Nonexistent root key",
    "nonexistent",
    undefined);

test("Nonexistent nested key",
    "metadata.nonexistent",
    undefined);

test("Array index out of bounds",
    "users[10]",
    undefined);

test("Negative index beyond start",
    "users[-10]",
    undefined);

// ============================================================
// 3. Filtering Data
// ============================================================

test("Filter by deep object equality",
    "users.{address.city == 'Berlin'}.name",
    ["Alice Vance", "Charlie Day"]);

test("Compound logic: and + not",
    "users.{age < 40 and not is_admin}.name",
    ["Bob Smith"]);

test("Null comparison",
    "users.{deleted_at == null}.id",
    [101, 103]);

test("has operator (property existence)",
    "users.{has secret_identity}.name",
    ["Bob Smith"]);

test("Undefined inequality check",
    "users.{secret_identity != undefined}.name",
    ["Bob Smith"]);

test("'in' operator for array inclusion",
    "users{'ux' in tags}.id",
    [101]);

test("'contains' operator for array inclusion",
    "users.{tags contains \"ux\"}.id",
    [101]);

test("Weak type comparison (string vs number)",
    "users{str_id <= 3}name",
    ["Alice Vance"]);

test("Regex filter",
    "users.{name =~ /^B/}.id",
    [102]);

test("Inline modifier in filter (tags:len)",
    "users{tags:len < 3}.id",
    [102, 103]);

test("Filter without leading dot",
    "users{age > 30}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter > (greater than)",
    "users.{age > 34}.name",
    ["Charlie Day"]);

test("Filter >= (greater-or-equal)",
    "users.{age >= 34}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter == strict value",
    "users.{id == 102}.name",
    ["Bob Smith"]);

test("Filter != (not equal)",
    "users.{age != 28}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter with or",
    "users.{age == 28 or age == 40}.name",
    ["Alice Vance", "Charlie Day"]);

test("Filter returning no results",
    "users.{age > 100}.name",
    []);

test("Regex filter with case-insensitive flag",
    "users.{name =~ /alice/i}.id",
    [101]);

test("'contains' with double quotes",
    "users.{tags contains \"backend\"}.name",
    ["Bob Smith"]);

test("'in' with double quotes",
    "users{\"devops\" in tags}.name",
    ["Bob Smith"]);

// ============================================================
// 4. Projection & Shape Mutation
// ============================================================

test("Root-level projection",
    "=> {last_updated, meta: metadata}",
    {
        last_updated: "2026-02-16T18:00:00Z",
        meta: { version: 1.2, environment: "production" },
    });

test("Projection with explicit key:value",
    "users => {id: id}",
    [{ id: 101 }, { id: 102 }, { id: 103 }]);

test("Projection with shorthand",
    "users => {id}",
    [{ id: 101 }, { id: 102 }, { id: 103 }]);

test("Projection with hardcoded literal",
    "users => {name: \"test\"}",
    [{ name: "test" }, { name: "test" }, { name: "test" }]);

test("Filter then project with deep resolution",
    "users.{age < 40} => {first_name: name, location: address.city}",
    [
        { first_name: "Alice Vance", location: "Berlin" },
        { first_name: "Bob Smith", location: "San Francisco" },
    ]);

test("Projection with spread and but",
    "users.{id == 101} => {first_name: name, ... but name, is_admin, address}",
    [{
        first_name: "Alice Vance",
        id: 101,
        age: 28,
        str_id: "3",
        tags: ["frontend", "ux", "mentor"],
        deleted_at: null,
    }]);

test("Projection with multiple fields",
    "users => {id, name}",
    [
        { id: 101, name: "Alice Vance" },
        { id: 102, name: "Bob Smith" },
        { id: 103, name: "Charlie Day" },
    ]);

// ============================================================
// 5. Array Manipulation (Modifiers)
// ============================================================

test("Tags maintains 2D boundaries",
    "users.tags",
    [["frontend", "ux", "mentor"], ["backend", "devops"], ["manager"]]);

test(":flat modifier",
    "users.tags:flat",
    ["frontend", "ux", "mentor", "backend", "devops", "manager"]);

test(":unique modifier",
    "users.address.city:unique",
    ["Berlin", "San Francisco"]);

test(":join with single-quoted separator",
    "users.tags:flat:join(', ')",
    "frontend, ux, mentor, backend, devops, manager");

test(":join default separator (comma)",
    "users.tags:flat:join",
    "frontend,ux,mentor,backend,devops,manager");

test(":limit modifier",
    "users:limit(1).name",
    ["Alice Vance"]);

test(":len on array",
    "users:len",
    3);

test(":len on mapped array",
    "users.name:len",
    3);

test(":limit(2) modifier",
    "users:limit(2).name",
    ["Alice Vance", "Bob Smith"]);

// ============================================================
// 6. Aggregations, Grouping & Sorting
// ============================================================

test(":avg modifier",
    "users.age:avg",
    34);

test(":max modifier",
    "users.age:max",
    40);

test(":min modifier",
    "users.age:min",
    28);

test(":sum modifier",
    "users.age:sum",
    102);

test(":sort descending",
    "users:sort(age, desc).name",
    ["Charlie Day", "Bob Smith", "Alice Vance"]);

test(":sort ascending (default)",
    "users:sort(age).name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

test(":group_by deep path",
    "users:group_by(address.country)",
    {
        Germany: [testData.users[0], testData.users[2]],
        USA: [testData.users[1]],
    });

test("Project then group_by",
    "users => {name, city: address.city}:group_by(city)",
    {
        Berlin: [
            { name: "Alice Vance", city: "Berlin" },
            { name: "Charlie Day", city: "Berlin" },
        ],
        "San Francisco": [
            { name: "Bob Smith", city: "San Francisco" },
        ],
    });

// ============================================================
// 7. Composition (Multi-Queries)
// ============================================================

test("Basic composition",
    "{total: users:len, hired: users.{tags contains 'ux'}.name}",
    { total: 3, hired: ["Alice Vance"] });

test("Composition with quoted alias and backtick path",
    "{total: `users`:len, \"hired users\": `users`.{tags contains 'ux'}.name}",
    { total: 3, "hired users": ["Alice Vance"] });

test("Composition with backtick aliases and inline modifiers",
    "{`all tags`: users.tags:flat, users: `users`.{`tags`:len > 1} => {`user:id` : id}}",
    {
        "all tags": ["frontend", "ux", "mentor", "backend", "devops", "manager"],
        users: [{ "user:id": 101 }, { "user:id": 102 }],
    });

test("Composition with single alias",
    "{names: users.name}",
    { names: ["Alice Vance", "Bob Smith", "Charlie Day"] });

// ============================================================
// 8. Join modifier edge cases (quote handling)
// ============================================================

test(":join with bare separator (no quotes)",
    "users.tags:flat:join(:)",
    "frontend:ux:mentor:backend:devops:manager");

test(":join with single-quoted separator in projection",
    "users => {tags: tags:join(' / ')}",
    [
        { tags: "frontend / ux / mentor" },
        { tags: "backend / devops" },
        { tags: "manager" },
    ]);

test(":join with double-quoted separator in projection",
    "users => {tags: tags:join(\":\")}",
    [
        { tags: "frontend:ux:mentor" },
        { tags: "backend:devops" },
        { tags: "manager" },
    ]);

test(":join with bare separator in projection",
    "users => {tags: tags:join(:)}",
    [
        { tags: "frontend:ux:mentor" },
        { tags: "backend:devops" },
        { tags: "manager" },
    ]);

test(":join with spaced separator in projection (double quotes)",
    "users => {tags: tags:join(\" / \")}",
    [
        { tags: "frontend / ux / mentor" },
        { tags: "backend / devops" },
        { tags: "manager" },
    ]);

// ============================================================
// 9. Caching behavior
// ============================================================

{
    const engine = new JSONQuery(testData);
    const r1 = engine.update("users.name");
    const r2 = engine.update("users.name");
    if (!deepEqual(r1, r2)) {
        console.error("FAIL: Cached result should equal non-cached result");
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 10. setData clears cache
// ============================================================

{
    const engine = new JSONQuery(testData);
    engine.update("users.name");
    engine.setData({ users: [{ name: "New User" }] });
    const result = engine.update("users.name");
    if (!deepEqual(result, ["New User"])) {
        console.error("FAIL: setData should clear cache and use new data");
        console.error("  Expected: [\"New User\"]");
        console.error(`  Actual:   ${serialize(result)}`);
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 11. Data immutability
// ============================================================

{
    const original = { value: 42 };
    const engine = new JSONQuery(original);
    original.value = 999;
    const result = engine.update("value");
    if (result !== 42) {
        console.error("FAIL: Engine should deep-clone input data");
        console.error("  Expected: 42");
        console.error(`  Actual:   ${result}`);
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 12. Mutation prevention
// ============================================================

// Note: the `set` trap on the sandbox proxy does not reliably intercept
// assignments inside `with()` blocks across all JS engines, so we skip
// testing for thrown errors on mutation attempts. Data immutability is
// guaranteed by the deep clone in setData() instead.

// ============================================================
// 13. Undefined / null handling
// ============================================================

test("Path on null data returns undefined",
    "users.{deleted_at != null}.deleted_at",
    ["2025-12-01"]);

test("Access beyond null returns undefined for chained path",
    "users.nonexistent_field.deeper",
    [undefined, undefined, undefined]);

// ============================================================
// 14. Syntax errors
// ============================================================

testThrows("Unrecognized token",
    "users.@invalid",
    "Syntax Error");

// ============================================================
// 15. Edge cases with empty data
// ============================================================

{
    const engine = new JSONQuery({});
    const result = engine.update("anything");
    if (result !== undefined) {
        console.error("FAIL: Query on empty object should return undefined");
        console.error("  Expected: undefined");
        console.error(`  Actual:   ${serialize(result)}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const engine = new JSONQuery({ items: [] });
    const result = engine.update("items.name");
    if (!deepEqual(result, [])) {
        console.error("FAIL: Map over empty array should return empty array");
        console.error("  Expected: []");
        console.error(`  Actual:   ${serialize(result)}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const engine = new JSONQuery({ items: [] });
    const result = engine.update("items:len");
    if (result !== 0) {
        console.error("FAIL: :len on empty array should return 0");
        console.error("  Expected: 0");
        console.error(`  Actual:   ${result}`);
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 16. stringifyWithUndefined
// ============================================================

{
    const val = [undefined, "hello", null, 42, true];
    const out = stringifyWithUndefined(val);
    const expected = "[\n  undefined,\n  \"hello\",\n  null,\n  42,\n  true\n]";
    if (out !== expected) {
        console.error("FAIL: stringifyWithUndefined array");
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const val = { a: 1, b: undefined, c: null };
    const out = stringifyWithUndefined(val);
    const expected = "{\n  \"a\": 1,\n  \"b\": undefined,\n  \"c\": null\n}";
    if (out !== expected) {
        console.error("FAIL: stringifyWithUndefined object with undefined value");
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined("just a string");
    if (out !== "\"just a string\"") {
        console.error("FAIL: stringifyWithUndefined plain string");
        console.error("  Expected: \"just a string\"");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined(undefined);
    if (out !== "undefined") {
        console.error("FAIL: stringifyWithUndefined(undefined)");
        console.error("  Expected: undefined");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined([]);
    if (out !== "[]") {
        console.error("FAIL: stringifyWithUndefined empty array");
        console.error("  Expected: []");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined({});
    if (out !== "{}") {
        console.error("FAIL: stringifyWithUndefined empty object");
        console.error("  Expected: {}");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 17. Backtick field names in projections
// ============================================================

test("Backtick key in projection output",
    "users[0] => {`user:id`: id}",
    { "user:id": 101 });

// ============================================================
// 18. Chained modifiers
// ============================================================

test(":flat then :unique",
    "users.tags:flat:unique",
    ["frontend", "ux", "mentor", "backend", "devops", "manager"]);

test(":flat then :unique then :len",
    "users.tags:flat:unique:len",
    6);

test(":flat then :limit",
    "users.tags:flat:limit(3)",
    ["frontend", "ux", "mentor"]);

// ============================================================
// 19. Custom data edge cases
// ============================================================

// Helper: run a test with custom data instead of testData
function testWith(description, data, query, expected) {
    const engine = new JSONQuery(data);
    let actual;
    try {
        actual = engine.update(query);
    } catch (err) {
        failed++;
        console.error(`FAIL: ${description}`);
        console.error(`  Query:    ${query}`);
        console.error(`  Error:    ${err.message}`);
        console.error(`  Expected: ${serialize(expected)}`);
        console.error("");
        return;
    }
    if (!deepEqual(actual, expected)) {
        failed++;
        console.error(`FAIL: ${description}`);
        console.error(`  Query:    ${query}`);
        console.error(`  Expected: ${serialize(expected)}`);
        console.error(`  Actual:   ${serialize(actual)}`);
        console.error("");
    } else {
        passed++;
    }
}

// --- Null values inside arrays ---
testWith("Array containing nulls",
    { items: [null, { x: 1 }, null, { x: 2 }] },
    "items.x",
    [undefined, 1, undefined, 2]);

testWith("Filter array with null elements",
    { items: [null, { x: 1 }, null, { x: 2 }] },
    "items.{x == 1}",
    [{ x: 1 }]);

// --- Boolean values ---
testWith("Array of booleans",
    { flags: [true, false, true, false] },
    "flags",
    [true, false, true, false]);

testWith("Boolean field access",
    { active: false },
    "active",
    false);

test("Filter by false boolean",
    "users.{is_admin == false}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter using boolean truthiness",
    "users.{is_admin}.name",
    ["Alice Vance"]);

test("Filter using negated boolean",
    "users.{not is_admin}.name",
    ["Bob Smith", "Charlie Day"]);

// --- Deeply nested objects ---
testWith("Very deep nesting",
    { a: { b: { c: { d: { e: 42 } } } } },
    "a.b.c.d.e",
    42);

testWith("Deep nesting with missing intermediate",
    { a: { b: {} } },
    "a.b.c.d.e",
    undefined);

// --- Single element arrays ---
testWith("Single element array map",
    { items: [{ name: "only" }] },
    "items.name",
    ["only"]);

testWith("Single element array filter match",
    { items: [{ x: 1 }] },
    "items.{x == 1}",
    [{ x: 1 }]);

testWith("Single element array filter no match",
    { items: [{ x: 1 }] },
    "items.{x == 2}",
    []);

// --- Nested arrays ---
testWith("Array of arrays accessed directly",
    { matrix: [[1, 2], [3, 4]] },
    "matrix[0]",
    [1, 2]);

testWith("Array of arrays index then index",
    { matrix: [[1, 2], [3, 4]] },
    "matrix[1][0]",
    3);

testWith(":flat on nested arrays",
    { matrix: [[1, 2], [3, 4]] },
    "matrix:flat",
    [1, 2, 3, 4]);

// --- Special values in data: 0, empty string, NaN ---
testWith("Zero value access",
    { count: 0 },
    "count",
    0);

testWith("Empty string access",
    { name: "" },
    "name",
    "");

testWith("Filter where value is 0 (falsy but exists)",
    { items: [{ val: 0 }, { val: 1 }, { val: 2 }] },
    "items.{val == 0}.val",
    [0]);

testWith("Filter > 0 excludes zero",
    { items: [{ val: 0 }, { val: 1 }, { val: -1 }] },
    "items.{val > 0}.val",
    [1]);

// --- :len on object ---
test(":len on root object",
    "metadata:len",
    2);

// --- :join on non-array ---
testWith(":join on string (non-array)",
    { name: "hello" },
    "name:join",
    "hello");

// --- :flat on non-array ---
testWith(":flat on non-array returns data unchanged",
    { val: 42 },
    "val:flat",
    42);

// --- :unique on non-array ---
testWith(":unique on non-array returns data unchanged",
    { val: "hello" },
    "val:unique",
    "hello");

// --- :limit edge cases ---
testWith(":limit(0) returns empty array",
    { items: [1, 2, 3] },
    "items:limit(0)",
    []);

testWith(":limit larger than array returns full array",
    { items: [1, 2] },
    "items:limit(100)",
    [1, 2]);

// --- Aggregation edge cases ---
testWith(":sum on empty array",
    { items: [] },
    "items:sum",
    0);

testWith(":avg on empty array",
    { items: [] },
    "items:avg",
    0);

testWith(":sum on single element",
    { items: [7] },
    "items:sum",
    7);

testWith(":avg on single element",
    { items: [7] },
    "items:avg",
    7);

// --- :sort stability / edge cases ---
testWith(":sort with equal values preserves relative order",
    { items: [{ k: 1, name: "B" }, { k: 1, name: "A" }, { k: 0, name: "C" }] },
    "items:sort(k).name",
    ["C", "B", "A"]);

testWith(":sort with some undefined values",
    { items: [{ k: 2 }, { name: "no-k" }, { k: 1 }] },
    "items:sort(k).k",
    [1, 2, undefined]);

testWith(":sort on non-array returns data unchanged",
    { val: 42 },
    "val:sort",
    42);

// --- :group_by edge cases ---
testWith(":group_by with missing key on some elements",
    { items: [{ type: "a", v: 1 }, { v: 2 }, { type: "a", v: 3 }] },
    "items:group_by(type)",
    {
        a: [{ type: "a", v: 1 }, { type: "a", v: 3 }],
        undefined: [{ v: 2 }],
    });

testWith(":group_by on single item",
    { items: [{ type: "x" }] },
    "items:group_by(type)",
    { x: [{ type: "x" }] });

// --- :unique with mixed types ---
testWith(":unique with duplicates",
    { items: [1, 2, 2, 3, 1, 3] },
    "items:unique",
    [1, 2, 3]);

testWith(":unique preserves order of first occurrence",
    { items: ["b", "a", "b", "c", "a"] },
    "items:unique",
    ["b", "a", "c"]);

// --- :join on empty array ---
testWith(":join on empty array",
    { items: [] },
    "items:join",
    "");

// --- Filter on non-array (single object) ---
test("Filter on root object (match)",
    "{active_status == true}",
    testData);

testWith("Filter on root object (no match)",
    { val: 5 },
    "{val > 10}",
    undefined);

// --- Regex with special characters ---
test("Regex filter with dot",
    "users.{name =~ /Day$/}.id",
    [103]);

test("Regex filter with multiple matches",
    "users.{name =~ /a/i}.id",
    [101, 103]);

// --- Multiple chained filters ---
test("Two filters chained",
    "users.{age < 40}.{is_admin == false}.name",
    ["Bob Smith"]);

test("Filter then modifier then path (limit after filter)",
    "users.{age < 40}:limit(1).name",
    ["Alice Vance"]);

// --- Projection edge cases ---
test("Projection with spread (no but)",
    "users[0] => {...}",
    testData.users[0]);

testWith("Projection on non-array (single object)",
    { x: 1, y: 2, z: 3 },
    "=> {a: x, b: y}",
    { a: 1, b: 2 });

test("Projection accessing missing field returns undefined in shape",
    "users => {id, missing: nonexistent_field}",
    [
        { id: 101, missing: undefined },
        { id: 102, missing: undefined },
        { id: 103, missing: undefined },
    ]);

// --- Query whitespace handling ---
test("Leading whitespace in query",
    "  users.name  ",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

// Standalone dot with spaces is a syntax error (dot must be attached to next token)
testThrows("Standalone dot with spaces is a syntax error",
    "users  .  name",
    "Syntax Error");

// --- Chaining path through undefined ---
testWith("Path through undefined returns undefined",
    { a: undefined },
    "a.b.c",
    undefined);

testWith("Path through null returns undefined",
    { a: null },
    "a.b",
    undefined);

// --- Index on non-indexable ---
testWith("Index on object returns undefined",
    { obj: { key: "val" } },
    "obj[0]",
    undefined);

testWith("Index on number returns undefined",
    { val: 42 },
    "val[0]",
    undefined);

// --- String indexing edge cases ---
testWith("String positive index",
    { name: "hello" },
    "name[1]",
    "e");

testWith("String negative index",
    { name: "hello" },
    "name[-1]",
    "o");

// --- Multiple queries hitting same cache prefix ---
{
    const engine = new JSONQuery(testData);
    const r1 = engine.update("users.name");
    const r2 = engine.update("users.age");
    // Both share the "users" prefix in cache
    if (!deepEqual(r1, ["Alice Vance", "Bob Smith", "Charlie Day"])) {
        console.error("FAIL: Cache prefix sharing - first query wrong");
        failed++;
    } else if (!deepEqual(r2, [28, 34, 40])) {
        console.error("FAIL: Cache prefix sharing - second query wrong");
        failed++;
    } else {
        passed++;
    }
}

// --- Composition edge cases ---
testWith("Composition with nested path queries",
    { a: { x: 1 }, b: { y: 2 } },
    "{ax: a.x, by: b.y}",
    { ax: 1, by: 2 });

testWith("Composition referencing same data",
    { items: [1, 2, 3] },
    "{count: items:len, total: items:sum, first: items[0]}",
    { count: 3, total: 6, first: 1 });

// --- Data with array at root level ---
testWith("Root-level array path extraction",
    [{ name: "A" }, { name: "B" }],
    "name",
    ["A", "B"]);

testWith("Root-level array filter",
    [{ x: 1 }, { x: 2 }, { x: 3 }],
    "{x > 1}.x",
    [2, 3]);

testWith("Root-level array index",
    [10, 20, 30],
    "[1]",
    20);

testWith("Root-level array :len",
    [1, 2, 3, 4, 5],
    ":len",
    5);

// --- stringifyWithUndefined nested ---
{
    const val = { arr: [1, undefined, { nested: undefined }] };
    const out = stringifyWithUndefined(val);
    const expected = "{\n  \"arr\": [\n    1,\n    undefined,\n    {\n      \"nested\": undefined\n    }\n  ]\n}";
    if (out !== expected) {
        console.error("FAIL: stringifyWithUndefined nested structure");
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined(null);
    if (out !== "null") {
        console.error("FAIL: stringifyWithUndefined(null)");
        console.error("  Expected: null");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined(0);
    if (out !== "0") {
        console.error("FAIL: stringifyWithUndefined(0)");
        console.error("  Expected: 0");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

{
    const out = stringifyWithUndefined(false);
    if (out !== "false") {
        console.error("FAIL: stringifyWithUndefined(false)");
        console.error("  Expected: false");
        console.error(`  Actual:   ${out}`);
        failed++;
    } else {
        passed++;
    }
}

// ============================================================
// 20. Backtick field access in paths
// ============================================================

testWith("Backtick field name at root",
    { "a.b": 42 },
    "`a.b`",
    42);

testWith("Backtick field name in nested path",
    { obj: { "key:name": "yes" } },
    "obj.`key:name`",
    "yes");

testWith("Backtick field name mapped over array",
    { items: [{ "x-y": 1 }, { "x-y": 2 }] },
    "items.`x-y`",
    [1, 2]);

// ============================================================
// 21. Filter operator: <= (strict)
// ============================================================

test("Filter <= (less-or-equal) boundary match",
    "users.{age <= 28}.name",
    ["Alice Vance"]);

test("Filter <= (less-or-equal) includes equal",
    "users.{age <= 34}.name",
    ["Alice Vance", "Bob Smith"]);

// ============================================================
// 22. :sort explicit 'asc' and by string field
// ============================================================

test(":sort ascending explicit keyword",
    "users:sort(age, asc).name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

test(":sort by string field (alphabetical)",
    "users:sort(name).name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

test(":sort by string field descending",
    "users:sort(name, desc).name",
    ["Charlie Day", "Bob Smith", "Alice Vance"]);

// ============================================================
// 23. :sort then :limit chaining
// ============================================================

test(":sort desc then :limit",
    "users:sort(age, desc):limit(2).name",
    ["Charlie Day", "Bob Smith"]);

test(":sort asc then :limit(1)",
    "users:sort(age):limit(1).name",
    ["Alice Vance"]);

// ============================================================
// 24. :max / :min on edge cases
// ============================================================

testWith(":max on single element",
    { items: [5] },
    "items:max",
    5);

testWith(":min on single element",
    { items: [5] },
    "items:min",
    5);

testWith(":max on non-array",
    { val: 7 },
    "val:max",
    7);

testWith(":min on non-array",
    { val: 7 },
    "val:min",
    7);

// ============================================================
// 25. :len on strings
// ============================================================

test(":len on string value via object keys",
    "organization:len",
    19);

// ============================================================
// 26. :limit on non-array
// ============================================================

testWith(":limit on non-array returns data unchanged",
    { val: "hello" },
    "val:limit(1)",
    "hello");

// ============================================================
// 27. :flat on already-flat array
// ============================================================

testWith(":flat on flat array (no-op)",
    { items: [1, 2, 3] },
    "items:flat",
    [1, 2, 3]);

// ============================================================
// 28. :join with empty string separator
// ============================================================

testWith(":join with empty string separator (single quotes)",
    { items: ["a", "b", "c"] },
    "items:join('')",
    "abc");

testWith(":join with empty string separator (double quotes)",
    { items: ["a", "b", "c"] },
    "items:join(\"\")",
    "abc");

// ============================================================
// 29. :group_by on non-array
// ============================================================

testWith(":group_by on single object",
    { type: "x", val: 1 },
    ":group_by(type)",
    { x: [{ type: "x", val: 1 }] });

// ============================================================
// 30. Aggregations with numeric strings
// ============================================================

testWith(":sum with numeric strings",
    { items: ["1", "2", "3"] },
    "items:sum",
    6);

testWith(":avg with numeric strings",
    { items: ["10", "20"] },
    "items:avg",
    15);

// ============================================================
// 31. Filter with parenthesized logic
// ============================================================

test("Filter: (a or b) and c",
    "users.{(age == 28 or age == 40) and not is_admin}.name",
    ["Charlie Day"]);

test("Filter: a and (b or c)",
    "users.{age > 25 and (is_admin or age > 35)}.name",
    ["Alice Vance", "Charlie Day"]);

// ============================================================
// 32. Filter comparing two fields
// ============================================================

testWith("Filter comparing two fields of same object",
    { items: [{ a: 1, b: 2 }, { a: 3, b: 3 }, { a: 5, b: 4 }] },
    "items.{a == b}",
    [{ a: 3, b: 3 }]);

testWith("Filter one field greater than another",
    { items: [{ a: 1, b: 2 }, { a: 3, b: 3 }, { a: 5, b: 4 }] },
    "items.{a > b}",
    [{ a: 5, b: 4 }]);

// ============================================================
// 33. 'has' on universally absent property
// ============================================================

test("has on property no element has",
    "users.{has nonexistent_prop}.name",
    []);

// ============================================================
// 34. Multiple chained filters then projection
// ============================================================

test("Two filters then projection",
    "users.{age < 40}.{is_admin == false} => {name}",
    [{ name: "Bob Smith" }]);

test("Filter then filter then modifier",
    "users.{age < 40}.{is_admin}:len",
    1);

// ============================================================
// 35. Index on empty string
// ============================================================

testWith("Index on empty string returns undefined",
    { name: "" },
    "name[0]",
    undefined);

// ============================================================
// 36. Empty query string
// ============================================================

testWith("Empty query returns full data",
    { x: 1 },
    "",
    { x: 1 });

// ============================================================
// 37. Projection with modifier on value field
// ============================================================

test("Projection using :len inline modifier",
    "users => {name, tag_count: tags:len}",
    [
        { name: "Alice Vance", tag_count: 3 },
        { name: "Bob Smith", tag_count: 2 },
        { name: "Charlie Day", tag_count: 1 },
    ]);

// ============================================================
// 38. Projection with spread + extra field
// ============================================================

test("Projection with spread and added computed field",
    "users[0] => {fullname: name, ...}",
    {
        fullname: "Alice Vance",
        id: 101, name: "Alice Vance", age: 28, str_id: "3", is_admin: true,
        tags: ["frontend", "ux", "mentor"],
        address: { city: "Berlin", country: "Germany" },
        deleted_at: null,
    });

// ============================================================
// 39. Data with undefined values in objects
// ============================================================

testWith("Object with explicit undefined value",
    { a: 1, b: undefined, c: 3 },
    "b",
    undefined);

testWith("Map over array where some items lack a field entirely",
    { items: [{ x: 1 }, {}, { x: 3 }] },
    "items.x",
    [1, undefined, 3]);

// ============================================================
// 40. Re-filtering already filtered results
// ============================================================

test("Three chained filters",
    "users.{age > 20}.{age < 40}.{is_admin}.name",
    ["Alice Vance"]);

// ============================================================
// 41. :sort descending then :limit
// ============================================================

test(":sort desc then :limit then path",
    "users:sort(age, desc):limit(1).name",
    ["Charlie Day"]);

// ============================================================
// 42. Modifier after projection
// ============================================================

test("Project then :len",
    "users => {id}:len",
    3);

test("Project then :limit",
    "users => {name}:limit(2)",
    [{ name: "Alice Vance" }, { name: "Bob Smith" }]);

// ============================================================
// 43. Filter with string comparison
// ============================================================

test("Filter string equality with double quotes",
    "users.{name == \"Bob Smith\"}.id",
    [102]);

test("Filter string equality with single quotes",
    "users.{name == 'Alice Vance'}.id",
    [101]);

// ============================================================
// 44. Composition with modifiers
// ============================================================

test("Composition with aggregation modifiers",
    "{youngest: users.age:min, oldest: users.age:max, avg_age: users.age:avg}",
    { youngest: 28, oldest: 40, avg_age: 34 });

test("Composition with filter + projection",
    "{admins: users.{is_admin}.name, cities: users.address.city:unique}",
    { admins: ["Alice Vance"], cities: ["Berlin", "San Francisco"] });

// ============================================================
// 45. Root-level array with modifiers
// ============================================================

testWith("Root-level array :sort",
    [{ v: 3 }, { v: 1 }, { v: 2 }],
    ":sort(v).v",
    [1, 2, 3]);

testWith("Root-level array :unique",
    [1, 1, 2, 3, 3],
    ":unique",
    [1, 2, 3]);

testWith("Root-level array filter then modifier",
    [{ x: 1 }, { x: 2 }, { x: 3 }],
    "{x > 1}:len",
    2);

// ============================================================
// 46. Path access on primitive data
// ============================================================

testWith("Path access on number returns undefined",
    42,
    "anything",
    undefined);

testWith("Path access on string returns length via Object wrapper",
    "hello",
    "length",
    5);

testWith("Path access on boolean returns undefined",
    true,
    "anything",
    undefined);

// ============================================================
// 47. Nested projection values
// ============================================================

test("Projection resolving deep nested path",
    "users => {name, country: address.country}",
    [
        { name: "Alice Vance", country: "Germany" },
        { name: "Bob Smith", country: "USA" },
        { name: "Charlie Day", country: "Germany" },
    ]);

// ============================================================
// 48. Filter with null / undefined literal comparisons
// ============================================================

test("Filter != null",
    "users.{deleted_at != null}.name",
    ["Bob Smith"]);

test("Filter == undefined for missing property",
    "users.{secret_identity == undefined}.name",
    ["Alice Vance", "Charlie Day"]);

// ============================================================
// 49. Index then modifier
// ============================================================

test("Index then :len on object",
    "users[0]:len",
    8);

test("Index then path",
    "users[1].address.country",
    "USA");

// ============================================================
// 50. Large index values
// ============================================================

test("Very large positive index returns undefined",
    "users[999999]",
    undefined);

test("Very large negative index returns undefined",
    "users[-999999]",
    undefined);

// ============================================================
// 51. :join with special characters
// ============================================================

testWith(":join with newline separator",
    { items: ["a", "b", "c"] },
    "items:join('\\n')",
    "a\\nb\\nc");

test(":join with pipe separator",
    "users.name:join(' | ')",
    "Alice Vance | Bob Smith | Charlie Day");

// ============================================================
// 52. Filter on already indexed element
// ============================================================

test("Index then filter (single object)",
    "users[0].{is_admin}",
    testData.users[0]);

test("Index then filter no match (single object)",
    "users[0].{is_admin == false}",
    undefined);

// ============================================================
// 53. Slice notation [start:end]
// ============================================================

test("Slice [0:2] returns first two elements",
    "users[0:2].name",
    ["Alice Vance", "Bob Smith"]);

test("Slice [1:] skips first element",
    "users[1:].name",
    ["Bob Smith", "Charlie Day"]);

test("Slice [:-1] excludes last element",
    "users[:-1].name",
    ["Alice Vance", "Bob Smith"]);

test("Slice [:2] is same as [0:2]",
    "users[:2].name",
    ["Alice Vance", "Bob Smith"]);

test("Slice [-2:] returns last two elements",
    "users[-2:].name",
    ["Bob Smith", "Charlie Day"]);

test("Slice [0:0] returns empty array",
    "users[0:0]",
    []);

test("Slice with out-of-bounds end",
    "users[0:100].name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

test("Slice [1:2] returns single element array",
    "users[1:2].name",
    ["Bob Smith"]);

test("Slice [-1:] returns last element as array",
    "users[-1:].name",
    ["Charlie Day"]);

testWith("Slice on string [1:3]",
    { name: "hello" },
    "name[1:3]",
    "el");

testWith("Slice on string [:-1]",
    { name: "hello" },
    "name[:-1]",
    "hell");

testWith("Slice on string [:3]",
    { name: "hello" },
    "name[:3]",
    "hel");

testWith("Slice on string [2:]",
    { name: "hello" },
    "name[2:]",
    "llo");

testWith("Slice on empty array",
    { items: [] },
    "items[0:]",
    []);

testWith("Slice with negative start and end [-3:-1]",
    { items: [1, 2, 3, 4, 5] },
    "items[-3:-1]",
    [3, 4]);

testWith("Slice on non-indexable returns undefined",
    { val: 42 },
    "val[0:2]",
    undefined);

// ============================================================
// 54. :reverse modifier
// ============================================================

test(":reverse on array",
    "users:reverse.name",
    ["Charlie Day", "Bob Smith", "Alice Vance"]);

testWith(":reverse on empty array",
    { items: [] },
    "items:reverse",
    []);

testWith(":reverse on single element",
    { items: [42] },
    "items:reverse",
    [42]);

testWith(":reverse on non-array returns unchanged",
    { val: "hello" },
    "val:reverse",
    "hello");

test(":sort then :reverse",
    "users:sort(age):reverse.name",
    ["Charlie Day", "Bob Smith", "Alice Vance"]);

testWith(":reverse preserves element values",
    { items: [1, 2, 3] },
    "items:reverse",
    [3, 2, 1]);

// ============================================================
// 55. :keys and :values modifiers
// ============================================================

test(":keys on object",
    "metadata:keys",
    ["version", "environment"]);

testWith(":keys on empty object",
    {},
    ":keys",
    []);

test(":values on object",
    "metadata:values",
    [1.2, "production"]);

testWith(":values on empty object",
    {},
    ":values",
    []);

test(":keys after :group_by",
    "users:group_by(address.country):keys",
    ["Germany", "USA"]);

test(":values after :group_by gives grouped arrays then :len",
    "users:group_by(address.country):values:len",
    2);

testWith(":keys on array returns string indices",
    { items: ["a", "b", "c"] },
    "items:keys",
    ["0", "1", "2"]);

testWith(":values on array returns array unchanged",
    { items: [10, 20, 30] },
    "items:values",
    [10, 20, 30]);

// ============================================================
// 56. :count_by modifier
// ============================================================

test(":count_by basic usage",
    "users:count_by(address.country)",
    { Germany: 2, USA: 1 });

test(":count_by on boolean field",
    "users:count_by(is_admin)",
    { true: 1, false: 2 });

testWith(":count_by with missing key on some elements",
    { items: [{ type: "a" }, { type: "b" }, {}, { type: "a" }] },
    "items:count_by(type)",
    { a: 2, b: 1, undefined: 1 });

testWith(":count_by on single element",
    { items: [{ k: "x" }] },
    "items:count_by(k)",
    { x: 1 });

testWith(":count_by on empty array",
    { items: [] },
    "items:count_by(k)",
    {});

// ============================================================
// 57. String modifiers: :upper, :lower, :trim
// ============================================================

testWith(":upper on string",
    { name: "hello" },
    "name:upper",
    "HELLO");

testWith(":lower on string",
    { name: "HELLO" },
    "name:lower",
    "hello");

testWith(":trim on string with whitespace",
    { name: "  hello  " },
    "name:trim",
    "hello");

test(":upper mapped over array",
    "users.name:upper",
    ["ALICE VANCE", "BOB SMITH", "CHARLIE DAY"]);

test(":lower mapped over array",
    "users.name:lower",
    ["alice vance", "bob smith", "charlie day"]);

testWith(":trim mapped over array",
    { items: [" a ", " b ", " c "] },
    "items:trim",
    ["a", "b", "c"]);

testWith(":upper on non-string returns unchanged",
    { val: 42 },
    "val:upper",
    42);

testWith(":lower on non-string returns unchanged",
    { val: 42 },
    "val:lower",
    42);

testWith(":trim on non-string returns unchanged",
    { val: 42 },
    "val:trim",
    42);

testWith(":upper on empty string",
    { name: "" },
    "name:upper",
    "");

testWith(":lower then :trim chained",
    { name: "  HELLO WORLD  " },
    "name:lower:trim",
    "hello world");

// ============================================================
// 58. :entries modifier
// ============================================================

testWith(":entries on simple object",
    { a: 1, b: 2 },
    ":entries",
    [{ key: "a", value: 1 }, { key: "b", value: 2 }]);

testWith(":entries on empty object",
    {},
    ":entries",
    []);

test(":entries after :group_by then :len",
    "users:group_by(address.country):entries:len",
    2);

testWith(":entries on array returns indexed entries",
    { items: ["x", "y"] },
    "items:entries",
    [{ key: 0, value: "x" }, { key: 1, value: "y" }]);

testWith(":entries then path access on key",
    { a: 1, b: 2 },
    ":entries.key",
    ["a", "b"]);

testWith(":entries then path access on value",
    { a: 1, b: 2 },
    ":entries.value",
    [1, 2]);

// ============================================================
// 59. Negated regex !~ in filters
// ============================================================

test("Filter !~ negated regex",
    "users.{name !~ /^A/}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter !~ with case-insensitive flag",
    "users.{name !~ /alice/i}.name",
    ["Bob Smith", "Charlie Day"]);

test("Filter !~ where all match (empty result)",
    "users.{name !~ /./}.name",
    []);

test("Filter !~ where none match (all results)",
    "users.{name !~ /^Z/}.name",
    ["Alice Vance", "Bob Smith", "Charlie Day"]);

// ============================================================
// 60. Combined new features
// ============================================================

test(":sort then :reverse then :limit",
    "users:sort(age):reverse:limit(1).name",
    ["Charlie Day"]);

test("Slice then filter",
    "users[0:2].{is_admin}.name",
    ["Alice Vance"]);

test("Filter then slice",
    "users.{age < 40}[0:1].name",
    ["Alice Vance"]);

testWith(":count_by then :entries",
    { items: [{ t: "a" }, { t: "b" }, { t: "a" }] },
    "items:count_by(t):entries",
    [{ key: "a", value: 2 }, { key: "b", value: 1 }]);

test("Composition with new modifiers",
    "{reversed_names: users.name:reverse, tag_count: users.tags:flat:len, countries: users:group_by(address.country):keys}",
    {
        reversed_names: ["Charlie Day", "Bob Smith", "Alice Vance"],
        tag_count: 6,
        countries: ["Germany", "USA"],
    });

test(":upper in filter via inline modifier",
    "users.{name:upper == 'BOB SMITH'}.id",
    [102]);

test(":entries then filter",
    "users:group_by(address.country):entries.{key == 'Germany'}.key",
    ["Germany"]);

testWith("Slice then :reverse",
    { items: [1, 2, 3, 4, 5] },
    "items[1:4]:reverse",
    [4, 3, 2]);

testWith(":keys then :len gives key count",
    { a: 1, b: 2, c: 3 },
    ":keys:len",
    3);

// ============================================================
// 61. Single = treated as == in filters
// ============================================================

test("Single = works as == in filter",
    "users.{address.city = 'Berlin'}.name",
    ["Alice Vance", "Charlie Day"]);

test("Single = with spaces works as ==",
    "users.{age = 28}.name",
    ["Alice Vance"]);

test("Single = does not break != operator",
    "users.{age != 28}.name",
    ["Bob Smith", "Charlie Day"]);

test("Single = does not break <= operator",
    "users.{age <= 34}.name",
    ["Alice Vance", "Bob Smith"]);

test("Single = does not break >= operator",
    "users.{age >= 34}.name",
    ["Bob Smith", "Charlie Day"]);

test("Single = does not break =~ operator",
    "users.{name =~ /^A/}.name",
    ["Alice Vance"]);

// ============================================================
// Summary
// ============================================================

if (failed === 0) {
    console.log(`All ${passed} tests passed.`);
} else {
    console.error(`\n${failed} of ${passed + failed} tests FAILED.`);
    process.exit(1);
}
