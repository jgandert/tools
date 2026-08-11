const { parseDSL } = require("./parser.js");

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

// =============================================================================
// basic DSL
// =============================================================================
console.log("\n=== basic DSL ===");
{
    const dsl = `
canvas 500x500
ratio_max 3:1
area_min 100
side_min 10
cwl 100
cwc 2

group = [B, C]

room A area=200 ratio_max=2:1 cwc=1
room B area=10x20
room C area_min=50 side_min=5

A close B
A connect any [B, C] weight=1.5 cwl=50
B at north east weight=2
C enclosed
A not at edge
A not at north
`;
    const r = parseDSL(dsl);

    assert(r.errors.length === 0, `basic: no errors (got: ${JSON.stringify(r.errors)})`);

    assert(r.config.canvasW === 500, "basic: canvasW=500");
    assert(r.config.canvasH === 500, "basic: canvasH=500");
    assert(r.config.ratioMax === 3, "basic: ratioMax=3");
    assert(r.config.areaMin === 100, "basic: areaMin=100");
    assert(r.config.sideMin === 10, "basic: sideMin=10");
    assert(r.config.cwl === 100, "basic: cwl=100");
    assert(r.config.cwc === 2, "basic: cwc=2");

    const A = r.modules.find(m => m.id === "A");
    const B = r.modules.find(m => m.id === "B");
    const C = r.modules.find(m => m.id === "C");

    assert(A !== undefined, "basic: room A exists");
    assert(A?.area === 200, "basic: A.area=200");
    assert(A?.ratioMax === 2, "basic: A.ratioMax=2 (per-room param)");
    assert(A?.cwc === 1, "basic: A.cwc=1");

    assert(B !== undefined, "basic: room B exists");
    assert(B?.w === 10, "basic: B.w=10");
    assert(B?.h === 20, "basic: B.h=20");
    assert(B?.area === 200, "basic: B.area=200");
    assert(B?.ratioMax === 3, "basic: B inherits global ratioMax=3");

    assert(C !== undefined, "basic: room C exists");
    assert(C?.areaMin === 50, "basic: C.areaMin=50");
    assert(C?.sideMin === 5, "basic: C.sideMin=5 (per-room overrides global 10)");
    assert(C?.ratioMax === 3, "basic: C inherits global ratioMax=3");

    const Ar = A?.rules ?? [];
    assert(Ar[0]?.type === "close", "basic: A.rules[0] type=close");
    assert(Ar[0]?.target === "B", "basic: A.rules[0] target=B");

    assert(Ar[1]?.type === "connect", "basic: A.rules[1] type=connect");
    assert(Ar[1]?.any === true, "basic: A.rules[1] any=true");
    assert(JSON.stringify(Ar[1]?.target) === JSON.stringify(["B", "C"]), "basic: A.rules[1] target=[B,C]");
    assert(Ar[1]?.weight === 1.5, "basic: A.rules[1] weight=1.5");
    assert(Ar[1]?.cwl === 50, "basic: A.rules[1] cwl=50");

    assert(Ar[2]?.type === "not_at", "basic: A.rules[2] type=not_at");
    assert(Ar[2]?.dir === "edge", "basic: A.rules[2] dir=edge");

    assert(Ar[3]?.type === "not_at", "basic: A.rules[3] type=not_at");
    assert(Ar[3]?.dir === "north", "basic: A.rules[3] dir=north");

    const Br = B?.rules ?? [];
    assert(Br[0]?.type === "at", "basic: B.rules[0] type=at");
    assert(JSON.stringify(Br[0]?.dir) === JSON.stringify(["north", "east"]), "basic: B.rules[0] dir=[north,east]");
    assert(Br[0]?.weight === 2, "basic: B.rules[0] weight=2");

    const Cr = C?.rules ?? [];
    assert(Cr[0]?.type === "enclosed", "basic: C.rules[0] type=enclosed");
    assert(Cr[0]?.weight === 1, "basic: C.rules[0] weight=1 (default)");
}

// =============================================================================
// inside block
// =============================================================================
console.log("\n=== inside block ===");
{
    const dsl = `
canvas 800 600

room living area=200000
room kitchen area=100000
room suite area=150000

living connect kitchen

inside suite {
  room bed area=80000
  room bath area=30000
  room dressing area=20000
  bed connect bath
  dressing enclosed
}
`;
    const r = parseDSL(dsl);

    assert(r.errors.length === 0, `inside: no errors (got: ${JSON.stringify(r.errors)})`);
    assert(r.warnings.length === 0, `inside: no warnings (got: ${JSON.stringify(r.warnings)})`);

    const suite = r.modules.find(m => m.id === "suite");
    assert(suite?.inside !== undefined, "inside: suite.inside exists");

    const inner = suite?.inside?.modules ?? [];
    assert(inner.length === 3, `inside: suite has 3 inner rooms (got ${inner.length})`);
    assert(inner.some(m => m.id === "bed"), "inside: bed is inner room");
    assert(inner.some(m => m.id === "bath"), "inside: bath is inner room");
    assert(inner.some(m => m.id === "dressing"), "inside: dressing is inner room");

    const bed = inner.find(m => m.id === "bed");
    assert(bed?.rules[0]?.type === "connect", "inside: bed.rules[0] type=connect");
    assert(bed?.rules[0]?.target === "bath", "inside: bed connects bath");

    const dressing = inner.find(m => m.id === "dressing");
    assert(dressing?.rules[0]?.type === "enclosed", "inside: dressing.rules[0] type=enclosed");

    const living = r.modules.find(m => m.id === "living");
    assert(living?.rules[0]?.type === "connect", "inside: living.rules[0] type=connect");
    assert(living?.rules[0]?.target === "kitchen", "inside: living connects kitchen");
}

// =============================================================================
// canvas inside block → error
// =============================================================================
console.log("\n=== canvas inside block (expect error) ===");
{
    const dsl = `
canvas 500 500
room A area=100
inside A {
  canvas 200 200
  room x area=50
}
`;
    const r = parseDSL(dsl);

    assert(r.errors.length >= 1, `canvas-inside: at least one error (got: ${JSON.stringify(r.errors)})`);
    assert(r.errors.some(e => /canvas/i.test(e) && /inside/i.test(e)),
        `canvas-inside: error mentions 'canvas' and 'inside' (got: ${JSON.stringify(r.errors)})`);
}

// =============================================================================
// nested inside (recursive)
// =============================================================================
console.log("\n=== nested inside (recursive) ===");
{
    const dsl = `
canvas 500 500
room outer area=200000

inside outer {
  room inner1 area=80000
  room inner2 area=80000
  inner1 connect inner2

  inside inner1 {
    room deep_a area=40000
    room deep_b area=30000
    deep_a close deep_b
  }
}
`;
    const r = parseDSL(dsl);

    assert(r.errors.length === 0, `nested: no errors (got: ${JSON.stringify(r.errors)})`);

    const outer = r.modules.find(m => m.id === "outer");
    assert(outer?.inside !== undefined, "nested: outer.inside exists");

    const l1 = outer?.inside?.modules ?? [];
    assert(l1.length === 2, `nested: outer has 2 inner rooms (got ${l1.length})`);
    assert(l1.some(m => m.id === "inner1"), "nested: inner1 exists");
    assert(l1.some(m => m.id === "inner2"), "nested: inner2 exists");

    const inner1 = l1.find(m => m.id === "inner1");
    assert(inner1?.inside !== undefined, "nested: inner1.inside exists");

    const l2 = inner1?.inside?.modules ?? [];
    assert(l2.length === 2, `nested: inner1 has 2 deep rooms (got ${l2.length})`);
    assert(l2.some(m => m.id === "deep_a"), "nested: deep_a exists");
    assert(l2.some(m => m.id === "deep_b"), "nested: deep_b exists");

    const deep_a = l2.find(m => m.id === "deep_a");
    assert(deep_a?.rules[0]?.type === "close", "nested: deep_a.rules[0] type=close");
    assert(deep_a?.rules[0]?.target === "deep_b", "nested: deep_a connects deep_b");
}

// =============================================================================
// undeclared room in inside → error
// =============================================================================
console.log("\n=== undeclared room in inside (expect error) ===");
{
    const dsl = `
canvas 500 500
room A area=100
inside B {
  room x area=50
}
`;
    const r = parseDSL(dsl);

    assert(r.errors.length >= 1, `undeclared-inside: at least one error (got: ${JSON.stringify(r.errors)})`);
    assert(r.errors.some(e => e.includes("'B'") || (e.includes("B") && e.includes("not declared"))),
        `undeclared-inside: error mentions room 'B' (got: ${JSON.stringify(r.errors)})`);
}

// =============================================================================
// cross-boundary connect (expect no error, crossBoundary=true)
// =============================================================================
console.log("\n=== cross-boundary connect ===");
{
    const dsl = `
canvas 500 500
room living area=200000
room suite area=150000

inside suite {
  room bed area=80000
  room bath area=30000
  bed connect living required
  bath close living
}
`;
    const r = parseDSL(dsl);
    const suiteInside = r.modules.find(m => m.id === "suite")?.inside;
    const bedRule = suiteInside?.modules?.find(m => m.id === "bed")?.rules[0];
    const bathRule = suiteInside?.modules?.find(m => m.id === "bath")?.rules[0];

    assert(r.errors.length === 0, `cross-boundary: no errors (got: ${JSON.stringify(r.errors)})`);
    assert(bedRule?.type === "connect", "cross-boundary: bed rule type=connect");
    assert(bedRule?.crossBoundary === true, "cross-boundary: bed rule crossBoundary=true");
    assert(bedRule?.required === true, "cross-boundary: connect required=true preserved");
    assert(bathRule?.crossBoundary === true, "cross-boundary: bath close crossBoundary=true");
    assert(bathRule?.required === false, "cross-boundary: close required stripped to false");
}

// =============================================================================
// all but syntax
// =============================================================================
console.log("\n=== all but syntax ===");
{
    const dsl = `
canvas 500 500
room A area=100
room B area=100
room C area=100
room D area=100

excl = [C, D]

A close [all but A]
B far [all but A, B]
C connect [all but excl] weight=1.5
[all but A] far D
any [all but A, B] close C
`;
    const r = parseDSL(dsl);

    assert(r.errors.length === 0, `allbut: no errors (got: ${JSON.stringify(r.errors)})`);

    const A = r.modules.find(m => m.id === "A");
    const B = r.modules.find(m => m.id === "B");
    const C = r.modules.find(m => m.id === "C");
    const D = r.modules.find(m => m.id === "D");

    // A close [all but A] → target [B,C,D]
    assert(A?.rules[0]?.type === "close", "allbut: A.rules[0] type=close");
    assert(JSON.stringify(A?.rules[0]?.target) === JSON.stringify(["B", "C", "D"]),
        `allbut: A.rules[0] target=[B,C,D] (got: ${JSON.stringify(A?.rules[0]?.target)})`);

    // B far [all but A, B] → target [C,D]
    assert(B?.rules[0]?.type === "far", "allbut: B.rules[0] type=far");
    assert(JSON.stringify(B?.rules[0]?.target) === JSON.stringify(["C", "D"]),
        `allbut: B.rules[0] target=[C,D] (got: ${JSON.stringify(B?.rules[0]?.target)})`);

    // C connect [all but excl=[C,D]] weight=1.5 → target [A,B]
    assert(C?.rules[0]?.type === "connect", "allbut: C.rules[0] type=connect");
    assert(JSON.stringify(C?.rules[0]?.target) === JSON.stringify(["A", "B"]),
        `allbut: C.rules[0] target=[A,B] (got: ${JSON.stringify(C?.rules[0]?.target)})`);
    assert(C?.rules[0]?.weight === 1.5, "allbut: C.rules[0] weight=1.5");

    // [all but A] far D → B, C, D each get far D
    assert(B?.rules[1]?.type === "far", "allbut: B.rules[1] type=far");
    assert(B?.rules[1]?.target === "D", "allbut: B.rules[1] target=D");
    assert(C?.rules[1]?.type === "far", "allbut: C.rules[1] type=far");
    assert(C?.rules[1]?.target === "D", "allbut: C.rules[1] target=D");
    assert(D?.rules[0]?.type === "far", "allbut: D.rules[0] type=far (D far itself)");
    assert(D?.rules[0]?.target === "D", "allbut: D.rules[0] target=D");

    // any [all but A, B] close C → C and D each get close C, subjectAny=true
    assert(C?.rules[2]?.type === "close", "allbut: C.rules[2] type=close");
    assert(C?.rules[2]?.target === "C", "allbut: C.rules[2] target=C");
    assert(C?.rules[2]?.subjectAny === true, "allbut: C.rules[2] subjectAny=true");
    assert(D?.rules[1]?.type === "close", "allbut: D.rules[1] type=close");
    assert(D?.rules[1]?.target === "C", "allbut: D.rules[1] target=C");
    assert(D?.rules[1]?.subjectAny === true, "allbut: D.rules[1] subjectAny=true");
}

// =============================================================================
// all but undeclared exclusion → error
// =============================================================================
console.log("\n=== all but undeclared exclusion (expect error) ===");
{
    const dsl = `
canvas 500 500
room A area=100
A close [all but Z]
`;
    const r = parseDSL(dsl);

    assert(r.errors.length >= 1, `allbut-err: at least one error (got: ${JSON.stringify(r.errors)})`);
    assert(r.errors.some(e => e.includes("'Z'") || e.includes("Z")),
        `allbut-err: error mentions 'Z' (got: ${JSON.stringify(r.errors)})`);
}

// =============================================================================
// group expansion inside inside block
// Outer scope declares wing = [bed, bath]; inner rule uses wing as a subject.
// Expected: rule expands to both bed and bath, no undeclared-room error.
// NOTE: this test will FAIL until parser.js is fixed to consult outerGroups
// when resolving rule subjects (currently only groups[] is checked, not outerGroups[]).
// =============================================================================
console.log("\n=== group expansion inside inside block ===");
{
    const dsl = `
canvas 500 500
room outer area=200000
wing = [bed, bath]

inside outer {
  room bed area=80000
  room bath area=30000
  room closet area=10000
  wing connect closet
  closet connect wing
}
`;
    const r = parseDSL(dsl);
    const inner = r.modules.find(m => m.id === "outer")?.inside?.modules ?? [];
    const bed = inner.find(m => m.id === "bed");
    const bath = inner.find(m => m.id === "bath");
    const closet = inner.find(m => m.id === "closet");

    // wing as subject: bed and bath should each get a connect-closet rule
    assert(r.errors.length === 0, `group-inside: no errors (got: ${JSON.stringify(r.errors)})`);
    assert(bed?.rules.some(rule => rule.type === "connect" && rule.target === "closet"),
        "group-inside: bed gets connect-closet rule (wing as subject expands)");
    assert(bath?.rules.some(rule => rule.type === "connect" && rule.target === "closet"),
        "group-inside: bath gets connect-closet rule (wing as subject expands)");

    // wing as target: closet should connect to both bed and bath
    assert(closet?.rules.some(rule => rule.type === "connect" &&
            (Array.isArray(rule.target) ? rule.target.includes("bed") && rule.target.includes("bath") : false)),
        "group-inside: closet connect wing expands to [bed,bath] target");
}

// =============================================================================
// malformed value inputs (document parser behavior; currently silent NaN/Infinity)
// =============================================================================
console.log("\n=== malformed value inputs ===");
{
    // ratio_max 3:0 → Infinity
    {
        const r = parseDSL("canvas 100 100\nratio_max 3:0");
        assert(r.errors.length > 0 || !isFinite(r.config.ratioMax),
            `malformed: ratio_max 3:0 produces error or Infinity (got ratioMax=${r.config.ratioMax})`);
    }

    // canvas 300 (single dimension) → canvasH not a finite number
    {
        const r = parseDSL("canvas 300");
        assert(r.errors.length > 0 || !Number.isFinite(r.config.canvasH),
            `malformed: canvas 300 produces error or non-finite canvasH (got canvasH=${r.config.canvasH})`);
    }

    // room A area= (empty value) → m.area is NaN
    {
        const r = parseDSL("canvas 100 100\nroom A area=");
        const A = r.modules.find(m => m.id === "A");
        assert(r.errors.length > 0 || isNaN(A?.area),
            `malformed: area= produces error or NaN (got area=${A?.area})`);
    }

    // side_min with no argument → config.sideMin is NaN
    {
        const r = parseDSL("canvas 100 100\nside_min");
        assert(r.errors.length > 0 || isNaN(r.config.sideMin),
            `malformed: side_min no arg produces error or NaN (got sideMin=${r.config.sideMin})`);
    }

    // area_min with no argument → config.areaMin is NaN
    {
        const r = parseDSL("canvas 100 100\narea_min");
        assert(r.errors.length > 0 || isNaN(r.config.areaMin),
            `malformed: area_min no arg produces error or NaN (got areaMin=${r.config.areaMin})`);
    }
}

// =============================================================================
// comment brace depth tracking
// =============================================================================
console.log("\n=== comment brace depth tracking ===");
{
    const dsl = `
canvas 500 500
room A area=100
inside A {
  # check balance }
  // check balance2 {
  room x area=50
}
`;
    const r = parseDSL(dsl);
    assert(r.errors.length === 0, `comment-depth: no errors (got: ${JSON.stringify(r.errors)})`);
    const A = r.modules.find(m => m.id === "A");
    assert(A?.inside !== undefined, "comment-depth: A.inside exists");
    assert(A?.inside?.modules?.length === 1, "comment-depth: A has 1 module");
}

// =============================================================================
// braces positioning sensitivity in inside declarations
// =============================================================================
console.log("\n=== braces positioning sensitivity ===");
{
    const dsl = `
canvas 500 500
room suite area=150000

inside suite
{
  room bed area=80000
  room bath area=30000
  bed connect bath
}
`;
    const r = parseDSL(dsl);
    assert(r.errors.length === 0, `braces-positioning: no errors (got: ${JSON.stringify(r.errors)})`);
    const suite = r.modules.find(m => m.id === "suite");
    assert(suite?.inside !== undefined, "braces-positioning: suite.inside exists");
    assert(suite?.inside?.modules?.length === 2, "braces-positioning: suite has 2 modules");
}

// =============================================================================
// circular group references (no infinite recursion)
// =============================================================================
console.log("\n=== circular group references ===");
{
    const dsl = `
canvas 500 500
room A area=100
a = [b]
b = [a]
A close a
`;
    // Must terminate (no infinite loop).
    // resolveIds returns the literal group content without recursive expansion,
    // so 'b' (which is not a declared room) triggers a target-undeclared error
    // rather than an infinite loop.
    const r = parseDSL(dsl);
    assert(typeof r === "object" && r !== null, "circular-groups: parseDSL returns an object (no infinite loop)");
    assert(r.errors.length > 0 || r.modules !== undefined,
        "circular-groups: result has errors array or modules array");
}

// =============================================================================
// group arithmetic (+) and group references inside [ ]
// =============================================================================
console.log("\n=== group arithmetic ===");
{
    const dsl = `
canvas 500x500
room a area=100
room b area=100
room c area=100
room d area=100
g1 = [a, b]
g2 = [c]
combo = g1 + g2 + [d]
nested = [g1, d]
overlap = g1 + [a]
combo at edge required
nested enclosed
overlap at north
[g2, d] not at south
`;
    const r = parseDSL(dsl);
    assert(r.errors.length === 0, `group-arith: no errors (got: ${JSON.stringify(r.errors)})`);

    const rulesOf = (id, type) => r.modules.find(m => m.id === id)?.rules.filter(x => x.type === type) ?? [];

    for (const id of ["a", "b", "c", "d"]) {
        assert(rulesOf(id, "at").some(x => x.dir === "edge" && x.required),
            `group-arith: '${id}' gets at-edge from 'combo = g1 + g2 + [d]'`);
    }

    for (const id of ["a", "b", "d"]) {
        assert(rulesOf(id, "enclosed").length === 1,
            `group-arith: '${id}' gets enclosed from 'nested = [g1, d]'`);
    }
    assert(rulesOf("c", "enclosed").length === 0, "group-arith: 'c' not in nested");

    assert(rulesOf("a", "at").filter(x => x.dir === "north").length === 1,
        "group-arith: overlap 'g1 + [a]' dedupes — 'a' gets at-north once");

    for (const id of ["c", "d"]) {
        assert(rulesOf(id, "not_at").some(x => x.dir === "south"),
            `group-arith: '${id}' gets not-at-south from inline '[g2, d]'`);
    }
    assert(rulesOf("a", "not_at").length === 0, "group-arith: 'a' not in '[g2, d]'");
}

console.log("\n=== group arithmetic errors ===");
{
    const r1 = parseDSL("canvas 500x500\nroom a area=100\ng = [a] + + [a]");
    assert(r1.errors.some(e => e.includes("empty term")), "group-arith-err: empty term reported");

    const r2 = parseDSL("canvas 500x500\nroom a area=100\ng = [a + a]");
    assert(r2.errors.some(e => e.includes("cannot parse group term")),
        `group-arith-err: malformed term reported (got: ${JSON.stringify(r2.errors)})`);
}

// =============================================================================
// ratio_max normalization (ratio_max ≥ 1, orientation-agnostic; target ratio untouched)
// =============================================================================
console.log("\n=== ratio_max normalization ===");
{
    const inverted = parseDSL("canvas 100x100\nroom A area=100000 ratio_max=1:6");
    const normal = parseDSL("canvas 100x100\nroom A area=100000 ratio_max=6:1");
    const Ai = inverted.modules.find(m => m.id === "A");
    const An = normal.modules.find(m => m.id === "A");

    assert(Ai?.ratioMax === 6, `ratio_max: 1:6 normalizes to 6 (got ${Ai?.ratioMax})`);
    assert(An?.ratioMax === 6, `ratio_max: 6:1 stays 6 (got ${An?.ratioMax})`);
    assert(Ai?.ratioMax === An?.ratioMax, "ratio_max: 1:6 behaves identically to 6:1");

    const globalInverted = parseDSL("canvas 100x100\nratio_max 1:6\nroom B area=100000");
    assert(globalInverted.config.ratioMax === 6, `ratio_max: global 1:6 normalizes to 6 (got ${globalInverted.config.ratioMax})`);

    const targetRatio = parseDSL("canvas 100x100\nroom A area=100000 ratio=1:6");
    const Ar = targetRatio.modules.find(m => m.id === "A");
    assert(Math.abs((Ar?.ratio ?? 0) - (1 / 6)) < 1e-9, `ratio: target ratio=1:6 stays raw n/d=0.1667 (got ${Ar?.ratio})`);
}

// =============================================================================
// algo selection
// =============================================================================
console.log("\n=== algo selection ===");
{
    const absent = parseDSL("room A area=100");
    assert(absent.config.algo === undefined, "algo: absent stays unset");

    const sa = parseDSL("algo sa\nroom A area=100");
    assert(sa.config.algo === "sa", `algo: 'sa' parsed (got ${sa.config.algo})`);
    assert(sa.errors.length === 0, "algo: 'sa' has no errors");

    const grid = parseDSL("algo grid\nroom A area=100");
    assert(grid.config.algo === "grid", `algo: 'grid' parsed (got ${grid.config.algo})`);
    assert(grid.errors.length === 0, "algo: 'grid' has no errors");

    for (const invalid of ["algo", "algo anneal", "algo sa extra", "algo grid extra"]) {
        const parsed = parseDSL(`${invalid}\nroom A area=100`);
        assert(parsed.errors.some(e => e.includes("'algo' expects exactly 'sa' or 'grid'")),
            `algo: '${invalid}' is rejected (got: ${JSON.stringify(parsed.errors)})`);
        assert(parsed.config.algo === undefined, `algo: '${invalid}' stays unset`);
    }

    const nested = parseDSL("algo grid\nroom P area=100\ninside P {\nalgo sa\nroom C area=50\n}");
    assert(nested.errors.some(e => e.includes("'algo' is not allowed inside an 'inside' block")),
        `algo: inside override is rejected (got: ${JSON.stringify(nested.errors)})`);
    const parent = nested.modules.find(m => m.id === "P");
    assert(parent?.inside?.config?.algo === undefined, "algo: inside config stays unset");
}

// =============================================================================
// shapes / shape (grid optimizer)
// =============================================================================
console.log("\n=== shapes / shape ===");
{
    const rect = parseDSL("canvas 100x100\nshapes rect\nroom A area=100");
    assert(rect.config.shapes === "rect", `shapes: global 'rect' parsed (got ${rect.config.shapes})`);
    assert(rect.errors.length === 0, "shapes: global 'rect' has no errors");

    const free = parseDSL("canvas 100x100\nshapes free\nroom A area=100");
    assert(free.config.shapes === "free", `shapes: global 'free' parsed (got ${free.config.shapes})`);

    const required = parseDSL("canvas 100x100\nshape rect required\nroom A area=100");
    assert(required.config.shapes === "rect" && required.config.shapeRequired === true,
        "shape: global required rectangle parsed");
    assert(required.errors.length === 0, "shape: global required rectangle has no errors");

    const bad = parseDSL("canvas 100x100\nshapes round\nroom A area=100");
    assert(bad.errors.some(e => e.includes("shapes")), "shapes: invalid value is an error");

    const missing = parseDSL("canvas 100x100\nshapes\nroom A area=100");
    assert(missing.errors.some(e => e.includes("shapes")), "shapes: missing value is an error");

    const badGlobal = parseDSL("canvas 100x100\nshape rect\nroom A area=100");
    assert(badGlobal.errors.length > 0, "shape: incomplete global required form is an error");

    const namedShape = parseDSL("room shape area=100\nroom A area=100\nshape connect A");
    assert(namedShape.errors.length === 0, "shape: existing room name remains valid");

    const roomShape = parseDSL("canvas 100x100\nroom A area=100 shape=free\nroom B area=100 shape=rect\nroom C area=100 shape=rect:required");
    const A = roomShape.modules.find(m => m.id === "A");
    const B = roomShape.modules.find(m => m.id === "B");
    const C = roomShape.modules.find(m => m.id === "C");
    assert(A?.shape === "free", `shape: room param 'free' parsed (got ${A?.shape})`);
    assert(B?.shape === "rect", `shape: room param 'rect' parsed (got ${B?.shape})`);
    assert(C?.shape === "rect" && C?.shapeRequired === true,
        "shape: per-room required rectangle parsed");

    const badRoom = parseDSL("canvas 100x100\nroom A area=100 shape=blob");
    assert(badRoom.errors.some(e => e.includes("shape")), "shape: invalid room value is an error");

    const badRequiredRoom = parseDSL("canvas 100x100\nroom A area=100 shape=free:required");
    assert(badRequiredRoom.errors.some(e => e.includes("rect:required")),
        "shape: required free-form room is rejected");

    const typo = parseDSL("canvas 100x100\nroom A area=100 shap=rect");
    assert(typo.errors.some(e => e.includes("did you mean 'shape'")), "shape: typo suggestion offered");

    const inherited = parseDSL("canvas 100x100\nshapes free\nroom P area=100\ninside P {\nroom C area=10\n}");
    const P = inherited.modules.find(m => m.id === "P");
    assert(P?.inside?.config?.shapes === "free", `shapes: inherited into inside block (got ${P?.inside?.config?.shapes})`);

    const inheritedRequired = parseDSL("shape rect required\nroom P area=100\ninside P {\nroom C area=10\n}");
    const requiredParent = inheritedRequired.modules.find(m => m.id === "P");
    assert(requiredParent?.inside?.config?.shapeRequired === true,
        "shape: global required rectangle inherited into inside block");
}

// =============================================================================
// SA advisory weight semantics warning
// =============================================================================
console.log("\n=== SA advisory weight semantics warning ===");
{
    const weighted = parseDSL("room A area=100\nroom B area=100\nA far B weight=5");
    const weightWarnings = weighted.warnings.filter(warning => warning.includes("SA advisory weight=N"));
    assert(weightWarnings.length === 1, `weight-warning: emitted once (got ${JSON.stringify(weighted.warnings)})`);
    assert(weightWarnings[0].includes("min(1 + log2(N), 25)")
        && weightWarnings[0].includes("min(initial_t / T / 100, 1)"),
        "weight-warning: names compressed target and temperature ramp separately");
    assert(weightWarnings[0].includes("weight=5 therefore targets 3.322, starts at 1.023")
        && weightWarnings[0].includes("final per-rule scores use 3.322"),
        "weight-warning: gives concrete weight=5 target/start/report example");
    assert(weightWarnings[0].includes("required bypasses compression and ramp"),
        "weight-warning: distinguishes required-rule semantics");

    const nested = parseDSL("room P area=200\ninside P {\nroom A area=100\nroom B area=100\nA close B weight=0.5\n}");
    assert(nested.warnings.filter(warning => warning.includes("SA advisory weight=N")).length === 1,
        "weight-warning: nested advisory weights produce one root warning");

    const requiredOnly = parseDSL("room A area=100\nroom B area=100\nA far B weight=5 required");
    assert(!requiredOnly.warnings.some(warning => warning.includes("SA advisory weight=N")),
        "weight-warning: required-only weights do not produce advisory warning");

    const grid = parseDSL("algo grid\nroom A area=100\nroom B area=100\nA far B weight=5");
    assert(!grid.warnings.some(warning => warning.includes("SA advisory weight=N")),
        "weight-warning: grid DSL does not receive SA warning");

    for (const invalidWeight of ["0", "-1", "nope"]) {
        const invalid = parseDSL(`room A area=100\nroom B area=100\nA far B weight=${invalidWeight}`);
        assert(invalid.errors.some(error => error.includes("'weight'")),
            `weight-warning: invalid weight '${invalidWeight}' is rejected`);
    }
}

// =============================================================================
// Parse-time feasibility lints
// =============================================================================
console.log("\n=== parse-time feasibility lints ===");
{
    const frontage = parseDSL(`
        canvas 1400x1100
        ratio_max 5:3
        side_min 175
        cwl 125
        room foyer
        room hallway
        room loud area=300000
        hub = [foyer, hallway]
        inside loud {
            room child_1 area=100000
            room child_2 area=100000
            room child_3 area=100000
            [child_1, child_2, child_3] connect any hub required
        }
        loud connect any hub required
    `);
    const frontageWarnings = frontage.warnings.filter(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]"));
    assert(frontageWarnings.length === 1,
        `feasibility-frontage: one deduplicated warning (got ${JSON.stringify(frontage.warnings)})`);
    assert(["top / loud", "top / loud / child_1", "top / loud / child_2", "top / loud / child_3", "top / foyer", "top / hallway"]
        .every(path => frontageWarnings[0].includes(path)),
    "feasibility-frontage: warning names parent, children, and target room paths");
    assert(frontageWarnings[0].includes("734.8 cm")
        && frontageWarnings[0].includes("707.1 cm")
        && frontageWarnings[0].includes("shortfall 27.7 cm")
        && frontageWarnings[0].includes("area=300000 cm²")
        && frontageWarnings[0].includes("ratio_max=1.667"),
    `feasibility-frontage: warning quantifies inherited geometry conflict (got ${frontageWarnings[0]})`);
    assert(frontage.errors.length === 0, `feasibility-frontage: fixture parses (got ${JSON.stringify(frontage.errors)})`);
    assert(frontage.modules.find(module => module.id === "loud")?.inside?.modules.every(child => child.ratioMax === 5 / 3 && child.sideMin === 175),
        "feasibility-frontage: lint reads inherited geometry without changing parsed children");
    assert(!JSON.stringify(frontage.modules).includes("FEASIBILITY_"),
        "feasibility-frontage: lint does not annotate parser AST");

    const duplicateRule = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=10000
        inside parent {
            room child
            child connect outside required
            child connect outside required
        }
    `);
    assert(!duplicateRule.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: duplicate child constraint does not double-count frontage");

    const feasibleFrontage = parseDSL(`
        ratio_max 1:1
        side_min 50
        room outside area=10000
        room parent area=40000
        inside parent {
            room child_a area=10000
            room child_b area=10000
            [child_a, child_b] connect outside required
        }
    `);
    assert(!feasibleFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: exact-fit requested frontage is not warned");

    const nestedFrontage = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outer area=40000
        inside outer {
            room outside area=10000
            room middle area=10000
            inside middle {
                room child_a
                room child_b
                [child_a, child_b] connect outside required
            }
        }
    `);
    const nestedFrontageWarnings = nestedFrontage.warnings.filter(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]"));
    assert(nestedFrontageWarnings.length === 1 && nestedFrontageWarnings[0].includes("top / outer / middle")
        && nestedFrontageWarnings[0].includes("top / outer / middle / child_a")
        && nestedFrontageWarnings[0].includes("top / outer / outside"),
    `feasibility-frontage: lint recurses with fully scoped paths (got ${JSON.stringify(nestedFrontageWarnings)})`);

    const subjectAnyFrontage = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            any [child_a, child_b] connect outside required
        }
    `);
    assert(!subjectAnyFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: subject-any group contributes one feasible frontage requirement");

    const infeasibleSubjectAny = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=2500
        inside parent {
            room child_a
            room child_b
            any [child_a, child_b] connect outside required
        }
    `);
    const subjectAnyWarnings = infeasibleSubjectAny.warnings.filter(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]"));
    assert(subjectAnyWarnings.length === 1 && subjectAnyWarnings[0].includes("any [top / parent / child_a, top / parent / child_b] adds at least 60 cm")
        && subjectAnyWarnings[0].includes("shortfall 10 cm"),
    `feasibility-frontage: infeasible subject-any group contributes one conservative requirement (got ${JSON.stringify(subjectAnyWarnings)})`);

    const overlappingSubjectAny = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            any [child_a, child_b] connect outside required
            any [child_a, child_b] connect outside required
        }
    `);
    assert(!overlappingSubjectAny.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: overlapping subject-any groups are not double-counted");

    const flexibleFrontage = parseDSL(`
        ratio_max 1:1
        side_min 150 flexible
        cwl 20
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            [child_a, child_b] connect outside required
        }
    `);
    assert(!flexibleFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: flexible side_min is not claimed as required frontage");

    const unknownFrontage = parseDSL(`
        side_min 100
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            [child_a, child_b] connect outside required
        }
    `);
    assert(!unknownFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: unknown parent area/ratio does not produce a feasibility claim");

    const advisoryFrontage = parseDSL(`
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            [child_a, child_b] connect outside
        }
    `);
    assert(!advisoryFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: advisory cross-boundary connects do not produce required-frontage warning");

    const gridFrontage = parseDSL(`
        algo grid
        ratio_max 1:1
        side_min 60
        room outside area=10000
        room parent area=10000
        inside parent {
            room child_a
            room child_b
            [child_a, child_b] connect outside required
        }
    `);
    assert(!gridFrontage.warnings.some(warning => warning.includes("[FEASIBILITY_INSIDE_FRONTAGE]")),
        "feasibility-frontage: SA rectangular bound is not claimed for grid geometry");

    const contradictoryAt = parseDSL(`
        room outer area=10000
        inside outer {
            room middle area=5000
            inside middle {
                room leaf area=1000
                leaf at north required
                leaf at south required
            }
        }
    `);
    const atWarnings = contradictoryAt.warnings.filter(warning => warning.includes("[FEASIBILITY_REQUIRED_AT_CONFLICT]"));
    assert(atWarnings.length === 1 && atWarnings[0].includes("top / outer / middle / leaf")
        && atWarnings[0].includes("at north required") && atWarnings[0].includes("at south required")
        && atWarnings[0].includes("full scope height"),
    `feasibility-at: recursive warning names room path and opposing constraints (got ${JSON.stringify(atWarnings)})`);

    const compatibleAt = parseDSL(`
        room A area=1000
        room B area=1000
        room C area=1000
        A at north east required
        B at north
        B at south
        any [B, C] at north south required
    `);
    assert(!compatibleAt.warnings.some(warning => warning.includes("[FEASIBILITY_REQUIRED_AT_CONFLICT]")),
        "feasibility-at: perpendicular required, advisory opposing, and subject-any pins avoid false conflict warning");

    const areaOverflow = parseDSL(`
        canvas 100x100
        room A area=6000
        room B area=5000
        room unknown
    `);
    const areaWarnings = areaOverflow.warnings.filter(warning => warning.includes("[FEASIBILITY_AREA_OVERFLOW]"));
    assert(areaWarnings.length === 1 && areaWarnings[0].includes("top / A") && areaWarnings[0].includes("top / B")
        && areaWarnings[0].includes("11000 cm²") && areaWarnings[0].includes("10000 cm²")
        && areaWarnings[0].includes("shortfall 1000 cm²"),
    `feasibility-area: strict-canvas warning names known rooms and quantifies shortfall (got ${JSON.stringify(areaWarnings)})`);

    for (const dsl of [
        "canvas 100x100\nroom A area=6000\nroom B area=4000",
        "canvas 100x100 flexible\nroom A area=6000\nroom B area=5000",
        "algo grid\ncanvas 100x100\nroom A area=6000\nroom B area=5000",
        "room A area=6000\nroom B area=5000",
    ]) {
        const parsed = parseDSL(dsl);
        assert(!parsed.warnings.some(warning => warning.includes("[FEASIBILITY_AREA_OVERFLOW]")),
            `feasibility-area: equal, flexible, grid, or unknown canvas avoids overflow claim (got ${JSON.stringify(parsed.warnings)})`);
    }
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
