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
