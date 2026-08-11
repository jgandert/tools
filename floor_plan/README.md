# Floor Plan Optimizer

Floor-plan generator with two selectable algorithms. Simulated annealing is the default and produces rectangular rooms. `algo grid` explicitly selects constructive coarse-to-fine grid search with multipart grid geometry.

## DSL Specification

Optional positive parameters like `weight=1.5` can be appended to rules. For advisory raw weight `N`, SA first computes target `N <= 1 ? N : min(1 + log2(N), 25)`, then uses effective weight `1 + (target - 1) * min(initial_t / T / 100, 1)` during annealing. At `T=initial_t`, only 1% of target's offset from 1 applies; full target arrives at `T <= initial_t / 100`. For example, raw `weight=5` has compressed target `3.322`, starts at effective `1.023`, and final per-rule scores use `3.322`. `required` rules instead use `N * 50` and bypass compression and temperature ramp because hard-rule satisfaction is selected separately.

### 1. Global Settings

| Syntax                                                                     | Description                                                                                                                                                                                        |
|----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `algo grid`<br>`algo sa`                                                    | Selects optimizer. `sa` is the default when omitted. Use `algo grid` explicitly for multipart grid geometry. Algorithm cannot change inside an `inside` block.                                    |
| `canvas 500 500`<br>`canvas 500x500`                                       | SA constrains layout to these bounds. Grid ignores canvas and warns because its outline is selected from relative room areas.                                                                      |
| `ratio_max 3:1`                                                            | Global maximum aspect ratio for any room.                                                                                                                                                          |
| `area_min 100`<br>`side_min 10`<br>`side_min 10 flexible`<br>`side_max 50` | SA supports all listed constraints. Grid treats `side_min` as advisory and warns that `area_min` and `side_max` are ignored.                                                                         |
| `cwl 100`<br>`cwc 2`                                                       | Sets default connected wall length (`cwl`) and minimum connected wall count (`cwc`). Grid supports `cwl` and warns that `cwc` is ignored.                                                          |
| `shapes rect`<br>`shapes free`                                             | *Grid optimizer only.* Default room shape: `rect` (default) keeps every room rectangular; `free` allows polyomino shapes. Hallway-like hub rooms stay free-form under `rect` unless the room says otherwise. Inherited by `inside` blocks. |

### 2. Rooms & Variables

| Syntax                                   | Description                                                     |
|------------------------------------------|-----------------------------------------------------------------|
| `room A`                                 | Declare a room named `A`.                                       |
| `room A area=200`<br>`room A area=10x20` | Set target area or target dimensions for the room.              |
| `room A area_min=50 side_min=5`          | Override global min/max constraints for this specific room.     |
| `room A ratio=3:2`                       | Target aspect ratio for the room.                               |
| `room A ratio_max=2:1`                   | Override global maximum aspect ratio for this room.             |
| `room A shape=rect`<br>`room A shape=free` | *Grid optimizer only.* Per-room shape override; beats the `shapes` global and the hub exemption. |
| `group = [A, B]`                         | Define a variable containing multiple rooms for rule expansion. Lists may reference other groups: `[g1, C]`. |
| `group = g1 + g2 + [A]`                  | Concatenate groups and/or lists (duplicates removed).           |

### 3. Rules & Constraints

Rules enforce spatial relationships. You can append optional parameters like `weight=1.5` or `cwl=50`. Advisory weights use compressed targets capped at 25 and are temperature-ramped as described above; raw values are not direct multipliers throughout search.

| Syntax                                                                            | Description                                                                                                                                                      |
|-----------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `A close B`                                                                       | Minimize distance between rooms.                                                                                                                                 |
| `A far B`                                                                         | Maximize distance between rooms.                                                                                                                                 |
| `A connect B`                                                                     | Rooms must share a wall. Append `cwl=50` to override the required connected wall length.                                                                         |
| `A [rule] any [B, C]`<br>`A [rule] any list`                                      | The `any` modifier creates an **OR** condition. The rule is satisfied if it holds for *at least one* room in the list. Works with `connect`, `close`, and `far`. |
| `A [rule] [all but B]`<br>`A [rule] [all but B, C]`<br>`A [rule] [all but group]` | Expands to every declared room except those listed. Works as subject too: `[all but A] [rule] B`. Exclusion is comma-separated rooms and/or group names.         |
| `A at north`                                                                      | Snap room to the layout edge (`north`, `south`, `east`, `west`). If two directions given, the first is preferred on the longer side.                             |
| `A at edge`                                                                       | Snap room to any layout edge.                                                                                                                                    |
| `A not at north`<br>`A not at edge`<br>`A enclosed`                               | Penalize touching the specified layout bound.                                                                                                                    |

### 4. Inside Blocks

Both algorithms resolve nested `inside` blocks recursively. SA projects referenced outer rectangles into each child scope as fixed phantoms, scores cross-boundary `connect` against their real shared-wall spans, and adds a parent-wall direction only as search guidance. Matching parent connections reserve aggregate child `cwl` across a full shared side. `required` uses physical adjacency and `cwl` in reachable nested layouts; it is not converted to a finite weight. Grid constructs child regions inside the delivered parent region and supports cross-boundary `connect` directly.

```
inside suite {
  room bed area=80000
  bed close kitchen       # kitchen is an outer room
  bed far loud            # loud is an outer room
  bed close any meal      # meal is an outer group
}
```

Grid deliberately ignores unsupported rules instead of rejecting otherwise portable DSL. Every ignored rule produces a warning. Current ignored cases are `any [subjects] ...`, `at`/`not_at`/`enclosed` inside an `inside` block, and cross-boundary `close`/`far`. Unsupported required rules are omitted and reported as ignored; they are never presented as satisfied.

### Feasibility warnings

Parser warnings prefixed with `[FEASIBILITY_INSIDE_FRONTAGE]`, `[FEASIBILITY_REQUIRED_AT_CONFLICT]`, or `[FEASIBILITY_AREA_OVERFLOW]` identify requested constraints that cannot all fit cleanly or carry contradictory directional intent. Frontage warnings are SA-specific: for each required cross-boundary target group they compare summed child frontage from `cwl`, non-flexible `side_min`, and requested `area`/`ratio_max` against parent room's maximum requested rectangular wall length. Area warnings compare known requested room areas with a strict SA canvas. Opposing required `north`/`south` or `east`/`west` pins warn that room must span full scope dimension; full-span geometry can be deliberate. Flexible or unknown bounds are not treated as proof of infeasibility. Warnings preserve parsed config/modules and appear before and after optimization, including cached default result.

## Files

| File                       | Role                                                                        |
|----------------------------|-----------------------------------------------------------------------------|
| `parser.js`                | DSL text → `{ config, modules, errors, warnings }`                          |
| `sa_optimized.js`          | Simulated annealing engine, NPE layout, cost function                       |
| `grid_optimizer.js`        | Constructive grid solver, refinement, nested scopes, result adapter         |
| `grid_worker.js`           | Browser worker wrapper for cancellable grid optimization                    |
| `orchestrator.js`          | Algorithm dispatch and SA nested-plan orchestration                          |
| `index.html`               | Browser UI; also the canonical DSL source for the cache                     |
| `update_cache.js`          | Bun script — pre-computes the default layout and embeds it in `index.html`  |
| `test_sa_optimized.js`     | SA integration and unit tests                                                |
| `test_grid_optimizer.js`   | Grid integration and unit tests                                              |
| `test_orchestrator.js`     | Default selection, dispatch, adapter, and recursive-grid tests               |
| `test_parser.js`           | Unit tests for the DSL parser                                               |
| `run_default_dsl.js`       | Quick orchestrated smoke run for the default DSL from `index.html`          |
| `dump_layout_json.js`      | Dumps the optimized room coordinates as JSON for inspection                 |

## Data flow

```
DSL text
  └─ parseDSL(text)
       └─ { config, modules[], errors[], warnings[] }
            └─ optimizeParsed(parsed, signal?)
                 ├─ grid: optimizeGrid(parsed) → fragment geometry
                 └─ sa: optimizeSaRecursive(modules, config) → rectangular geometry
```

Grid runs in a dedicated browser Worker so Stop terminates active work. Grid results contain rectangular `parts` for each active room; multiple parts faithfully render free-form hallway polyominoes. UI labels grid objective as a refinement score because it is algorithm-specific and not comparable with SA cost. SA results retain nested rectangular `inside.rooms` output and draggable shared walls.

After each SA solve, **Per-rule scores** in the results panel and browser console show canonical rule text, satisfaction, final normalized penalty, and percentage of that recursive scope's total cost. Report metadata and its visible warning state raw-to-target compression, temperature-ramp formula, `weight=5` example, and required-rule exception. Final penalties use compressed target weight, not early-anneal effective weight. An unsatisfied advisory rule also gets a **Why not?** hint: up to three larger current rule penalties from the same recursive scope that share a named room. These are penalty-magnitude correlations, not causal counterfactuals; they identify stronger overlapping score pressure but do not prove satisfying one rule would prevent satisfying another. An empty hint says no larger same-room penalty was found. A satisfied rule can retain a non-zero optimization penalty: for example, `far` is satisfied once rooms stop sharing a wall but continues rewarding more distance. Subject-`any` expansions appear once with the minimum scored penalty and an any-subject verdict. Derived cross-boundary guides are labeled by origin. Grid reports per-rule penalties and dominance hints as unavailable because its refinement score does not provide stable rule attribution; ignored grid semantics remain warnings.

## Key types

**Module** (input to SA):

```js
{
  id: string,
  area?: number,          // target area (sq units)
  w?: number, h?: number, // or explicit dimensions
  areaMin?: number,
  sideMin?: number,
  ratioMax?: number,
  rules: Rule[],
  inside?: { config, modules }  // sub-plan, populated by parser
}
```

**Config** (DSL globals + algorithm settings):

```js
{
  algo,                    // "sa" (default) or "grid"
  canvasW, canvasH,        // SA bounding box; ignored by grid
  canvasFlexible,          // soft vs. hard canvas enforcement
  ratioMax, sideMin, sideMax, areaMin, cwl, cwc,
  seed,                    // PRNG seed; absent = Math.random (non-deterministic)
  iter,                    // moves-per-temperature multiplier
  k,                       // annealing effort scale used in moves per temperature
  coolingRate, initialT, minT
}
```

**Layout room** (SA output):

```js
{ id, x, y, w, h, centerX, centerY }
```

**Rule report** (public result envelope):

```js
{
  availability: "available",             // "unavailable" for grid
  metric: "sa-normalized-delivered-cost",
  percentBasis: "scope-total-cost",
  weightSemantics: {
    mode: "compressed-target-temperature-ramp",
    compressedTargetFormula, annealingEffectiveFormula,
    initialOffsetFraction, fullTargetTemperatureFraction,
    finalReportUses, requiredWeightFormula, requiredBypasses,
    example: { rawWeight, compressedTargetWeight, initialEffectiveWeight }
  },
  dominanceHintBasis: "shared-room-current-penalty-magnitude-correlation",
  dominanceHintLimit: 3,
  scopes: [{
    path: "top / suite",
    totalCost,
    topologicalPenalty,
    reportedPenalty,
    unreportedTopologicalPenalty,
    rules: [{
      id, text, subjects, participants, type, required, satisfied, penalty, percentOfTotal, origin,
      farPenaltyDecomposition?: {
        mode: "required-inverse-distance-floor",
        penaltyFormula, aggregation, distanceBasis, boundedSubjectAssumption,
        requiredWeight, penaltyScale, canvasDiagonal, resolvedTargetCount,
        floorTerms: [{ target, centerDistance, maximumCenterDistance, maximumDistanceBasis }],
        irreduciblePenalty, reduciblePenalty
      },
      dominanceHints?: [{
        kind: "penalty-magnitude-correlation",
        counterfactualComputed: false,
        ruleId, scopePath, text, sharedRooms, penalty, penaltyDifference
      }]
    }]
  }]
}
```

`participants` contains named subject and target rooms used for overlap matching. `dominanceHints` exists only on unsatisfied advisory rules and can be empty. Candidate `ruleId` values include the recursive scope path. `satisfied: null` marks a hard-verdict exemption for a same-pair required `connect` plus required `far`; the `far` penalty remains part of the score and still carries `farPenaltyDecomposition`.

Required `far` keeps the inverse-distance penalty `requiredWeight * 1,000,000 / (1 + centerDistance / canvasDiagonal)`. Its report splits the exact final penalty into `irreduciblePenalty + reduciblePenalty`. Local room centers are assumed bounded by their scope, so their maximum center distance is the scope canvas diagonal and each resolved pair has a half-scale floor. A fixed external phantom target instead uses its distance to the farthest scope corner. Multi-target rules sum floors; `any` rules use the minimum target penalty and minimum floor. Advisory `far` has a zero cutoff at one canvas diagonal, or half a diagonal when an advisory `connect` exists, so it never receives an irreducible-floor field. Grid reports no per-rule score or invented split.

`unreportedTopologicalPenalty` contains topology costs that do not originate from a rule object, currently `cwc`.

## Algorithm: constructive grid

Grid search samples coarse outlines, converts relative areas to cell quotas, paints corridor spines, places constrained seeds, constructs required connections, grows regions, repairs required rules, rectangularizes ordinary rooms, and refines twice. Nested scopes are solved inside their delivered parent masks. Hallway hubs remain free-form unless overridden with `shape=rect`.

Grid ignores exact canvas size. `ratio_max`, `side_min`, `enclosed`, and `far` remain advisory interests; required `connect`, `at`, and `not_at` participate in constructive placement and repair.

## Algorithm: NPE + Simulated Annealing

Layouts are represented as **Normalized Polish Expressions** (NPE) — sequences of room IDs and cut operators (`H` / `V`) encoding a slicing floorplan. Two invariants:

- *Balloting*: operands strictly outnumber operators at every prefix.
- *Skewed tree*: no two consecutive identical operators.

SA explores the space with four move types:

| Move | Operation                                                         |
|------|-------------------------------------------------------------------|
| M1   | Swap two adjacent operands                                        |
| M2   | Complement a maximal operator chain (`HVH` → `VHV`)               |
| M3   | Swap an adjacent operand–operator pair (validity-checked in O(1)) |
| M4   | Swap two non-neighboring operands                                 |

The cost function combines area deviation, aspect-ratio penalties, canvas overflow, topological rule violations (connect/close/far/at), and required-rule hard penalties. Distance and canvas terms use canvas-relative normalization. Room aspect uses threshold excess, `side_min` uses relative shortfall, and area deviation remains an absolute-area term.

SA auto-scales the iteration budget from rule count and room count (`weightedRules / √n`). Stagnation recovery reheats and tries NPE flips, candidate injection, or random perturbation.

### Why root shape isn't fixed to canvas

Forcing `rootShape = canvasW × canvasH` doesn't reduce search and degrades quality:

- **Stockmeyer leaf curves are discrete Pareto points.** Profile shows mean rootCurve = 5.8 shapes per evaluateCost — that loop is already cheap. Removing it saves ~0% of wall.
- **No curve point equals canvas exactly.** Snapping root=canvas means either (a) accepting a small mismatch — then you still need an overflow penalty for the gap (so it's not actually a hard constraint), or (b) scaling all rooms uniformly — which deforms each room's area/aspect away from its declared target, *increasing* roomPenalty.
- **The rootShape sweep is the lever** that lets leaf aspect/area tradeoffs propagate up with Pareto optimality. Fixing the root collapses that lever, so the SA can no longer pick a leaf-shape-set whose aggregate fits the canvas — only one whose aggregate *equals* canvas, which is generally infeasible given discrete leaf curves.
- **Fixed-outline floorplanning is a known harder variant** (Adya-Markov 2003, Chang TCG). It requires either continuous shape curves, slack redistribution, or different SA move operators. Not a free lunch.

Strict-canvas scoring evaluates overflowing candidates at their delivered full-canvas dimensions, so post-SA stretching does not introduce a cost jump. The root-shape sweep remains part of slicing-tree evaluation.

## Running tests

```sh
bun test_parser.js
bun test_grid_optimizer.js
bun test_sa_optimized.js
bun test_orchestrator.js
bun run_default_dsl.js
bun dump_layout_json.js
```

Run `bun bench/grid_seeds.js` after changing grid solver behavior. It gates required rules, relative-area deviation, and rectangularity across seeds 1–20.

## Cache management

The default example in `index.html` is cached. `update_cache.js` dispatches through selected algorithm and writes result into a `<script id="default-result-cache" type="application/json">` slot. Browser accepts cache only when DSL, algorithm marker, and result schema version match.

**Re-generate after changing the default DSL:**

```sh
bun update_cache.js
```

The script fails fast if the DSL has parse errors, or if the cache slot tag is missing from `index.html`. The embedded JSON escapes `</script>` to prevent premature tag closure.

## Adding a DSL rule

1. **Parser** (`parser.js`): handle the new verb in the `else` branch inside the rule-parsing loop. Attach a rule object to `m.rules`.
2. **Grid** (`grid_optimizer.js`): add constructive enforcement, repair, or explicit ignore warning. Never silently treat an unsupported rule as satisfied.
3. **SA** (`sa_optimized.js`): add a penalty term in `calculateTopologicalPenalties` or `evaluateLayoutCost`. Use canvas-relative normalization for distance or boundary terms and threshold-relative normalization for room geometry.
4. **Tests**: add focused parser, grid, SA, and dispatch cases as applicable.
5. **Docs**: add syntax to DSL table in `index.html`'s info dialog.

## Future ideas and rejected directions

- **Top-K root-shape filter in `evaluateCost`** — implemented two-stage filter: cheap-cost (area + aspect + canvas) for all rootCurve shapes, full-eval only top-K. RootCurve mean 39 / max 76 on user's DSL. Tested K∈{1,2,3,5,10} across 7 seeds. K=2 was the best by a clear margin, with 1.3–1.7× speedup. **But:** apples-to-apples re-evaluation of K=2's final NPE through baseline (unfiltered) `evaluateCost` at cwm=1 showed 5/7 seeds improved (-7% to -59%) and 2/7 regressed (+43%, +51%). Doc gate is "≤ baseline across 5+ seeds" — fail. Increasing K to 3/5/10 was uniformly worse on the same metric (and on filtered-cost), so the standard escape hatch didn't apply. Per doc guidance, skipped. **Smell: ** larger K sometimes giving worse cost is a tuning-noise effect — the inner shape-pick reshapes the SA cost surface, so K is effectively a hyperparameter, not a strict superset of K-1 candidates. Future attempt should either redesign the filter (e.g. add Pareto-curve diversity rather than pure cheap-cost ranking) or change the SA acceptance to be filter-aware.
- `A above B` / `A left of B` directional rules
- MILP backend for ≤15-room problems (provably optimal)
