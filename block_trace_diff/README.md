# Block Trace Diff

Block Trace Diff compares arrays of lines, identifies moved blocks, and reports edits within moved blocks. The library is a dependency-free JavaScript ES module. The browser keeps its original markup and styling, including the shared `../one.css` dependency. Serve the parent directory containing `one.css` and `block_trace_diff/` over HTTP.

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000/block_trace_diff/](http://127.0.0.1:8000/block_trace_diff/).

## Library usage

```js
import { BlockTraceDiff } from "./block_trace_diff.js";

const engine = new BlockTraceDiff({ skipWhitespaceOps: false });
const operations = engine.diff(sourceLines, targetLines);
```

Both arguments must be **dense arrays of primitive strings**. Empty arrays are valid and mean zero lines. Sparse arrays, inherited array entries, boxed strings, nonstring entries, and non-array containers throw `TypeError`, identifying the argument and, where applicable, its zero-based index. Validation happens before comparison state is reset. Caller arrays are not modified, and frozen arrays are supported.

The engine can be reused for successive comparisons. Its seven configuration properties are readable and **read-only** after construction; create a new engine to change settings. The options object is not retained, so later edits to that object have no effect.

Matching ignores leading whitespace by default. Internal and trailing whitespace remain significant, so a change from `"a  b"` to `"a b"` is reported. Blank-only insertions, deletions, and moves are hidden by default. For exact comparison without suppressing any lines:

```js
const engine = new BlockTraceDiff({
    ignoreLeadingWhitespace: false,
    ignoreTrailingWhitespace: false,
    ignoreInternalWhitespace: false,
    skipWhitespaceOps: false,
});
```

When converting text into lines, choose the newline policy appropriate to your caller. The browser uses the following convention, preserving a trailing empty line in nonempty text:

```js
const splitLines = text => text === "" ? [] : text.split("\n");
```

The library itself receives lines and does not interpret line terminators.

## Comparison options

| Option | Default | Accepted values |
|---|---|---|
| `kGramSize` | `2` | Safe integer >= 1 |
| `maxStitchGap` | `2` | Safe integer >= 0 |
| `maxOccurrences` | `5` | Safe integer >= 0; zero disables block anchoring |
| `ignoreLeadingWhitespace` | `true` | Boolean |
| `ignoreTrailingWhitespace` | `false` | Boolean |
| `ignoreInternalWhitespace` | `false` | Boolean |
| `skipWhitespaceOps` | `true` | Boolean |

`kGramSize` sets the minimum consecutive matching lines used to seed a block. `maxStitchGap` limits the unmatched gap on each side when combining neighboring matched blocks. `maxOccurrences` limits repeated anchor matches on each side. Raising it allows more candidate pairings and can increase work substantially. Zero disables anchoring and move detection, giving a minimum insertion/deletion edit script under the configured normalization, before presentation and blank suppression. A replacement counts as one deletion plus one insertion for that guarantee.

Each whitespace option is independent. Internal normalization collapses whitespace between nonblank characters, including whitespace inside literals; enable it only when those differences should be ignored. To request leading, trailing, and internal normalization together:

```js
const engine = new BlockTraceDiff({
    ignoreLeadingWhitespace: true,
    ignoreTrailingWhitespace: true,
    ignoreInternalWhitespace: true,
});
```

Omitted options and explicit `undefined` use the defaults. Invalid numeric options throw `RangeError`; invalid boolean options or a null, non-object, or array options argument throw `TypeError` during construction.

## Output contracts

Operations are `EQUAL`, `DELETE`, `INSERT`, `REPLACE`, `MOVE_FROM`, or `MOVE_TO`. Source-consuming operations stay in source order, and target-consuming operations stay in target order. With suppression disabled, each input line is represented exactly once. With suppression enabled, omitted lines are blank-only edits; matched blank lines remain visible. Line numbers are one-based.

| Operation | Text and position fields |
|---|---|
| `EQUAL` | Source-owned `text`, `sourceText`, `targetText`, `isExact`, `srcLine`, `targetLine` |
| `DELETE` | Source-owned `text`, `srcLine` |
| `INSERT` | Target-owned `text`, `targetLine` |
| `REPLACE` | Target-owned `text`, `lines: [text]`, `srcLine`, `targetLine`, and `internalDiff` containing the deleted and inserted text |
| `MOVE_FROM`, `MOVE_TO` | Shared `moveId`, `moveType`, both source and target start/end lines, and the corresponding document's `lines`; a destination can also have `internalDiff` |

`EQUAL` preserves both raw texts even when normalization ignores a formatting difference. `isExact` is true only when those raw strings are identical. The browser displays `targetText` for equal lines, including inside moves.

For a `REPLACE`, the two `internalDiff` entries are `{ type: "DELETE", text: ... }` and `{ type: "INSERT", text: ... }`; their positions are given by the enclosing replacement. For a moved block's `internalDiff`, the nested `EQUAL`, `DELETE`, and `INSERT` operations use absolute line numbers. Nested move edits remain deletions and insertions rather than becoming replacements.

Every visible move ID has exactly one `MOVE_FROM` and one `MOVE_TO`, with disjoint claimed ranges on each side. Stationary blocks maximize retained exact-block lines among the claimed blocks; stitched gaps do not contribute to those weights. Move detection is a deterministic heuristic, not a guarantee of a globally minimum number of moves or edits. Do not rely on a particular alignment when several shortest fallback scripts are possible across versions.

`MOVE_EXACT` means equal under the configured normalization. A destination includes `internalDiff` when its raw text differs, even for a normalized exact move. Blank suppression also applies inside moves and never hides just one half of a visible move.

### Reconstructing each document

With `skipWhitespaceOps: false`, traverse operations in returned order. For the source, consume `EQUAL.sourceText`, `DELETE.text`, the deleted entry of `REPLACE.internalDiff`, and `MOVE_FROM.lines`. For the target, consume `EQUAL.targetText`, `INSERT.text`, `REPLACE.text`, and `MOVE_TO.lines`. Ignore operations that consume only the other side. Do not also consume a move's nested edits: the corresponding move `lines` already contain its complete raw text.

## Algorithm and performance

The implementation validates and normalizes the input, interns line strings, finds exact anchor windows, expands and claims nonoverlapping blocks, stitches nearby blocks, selects stationary blocks by retained-line weight, and solves the remaining gaps with Myers before presentation.

The main performance safeguards are:

- Normalized-equal inputs go directly to lossless `EQUAL` output.
- Long anchor windows use exact pair-interned identities built by doubling window spans. Their construction is `O((N + M) log k)` rather than rebuilding every `k`-line key. Matching does not rely on probabilistic hash equality.
- Anchor occurrence lists stop retaining positions after the configured cutoff, and target indexing ignores unusable source keys.
- Byte arrays track claimed lines; unmatched run nodes reuse normalized line records.
- Fallback gaps use array ranges rather than copied slices and remapped scripts. Empty, single-line, and sufficiently large disjoint gaps have direct shortest-script paths.
- Myers uses an explicit work stack and clips impossible diagonals to the edit grid. It does not depend on JavaScript recursion depth.
- Presentation preserves each side's order with linear partitioning rather than redundant sorting.

These shortcuts do not make every workload linear. Difficult overlapping inputs can still incur Myers' quadratic worst case, and large occurrence limits can increase candidate generation. Results are materialized as operations in memory. The browser computes synchronously; a worker or paged result view would be a separate extension for very large interactive workloads.

## Verification

The algorithm tests use only Node's built-in modules; installing browser dependencies is unnecessary for this command:

```sh
npm test
```

Equivalent explicit commands:

```sh
node test_block_trace.js
node --test review_block_trace.mjs test_diff_properties.mjs
```

The suites cover raw-text reconstruction, line coverage/order, move pairing/ranges, nested edits, whitespace and Unicode behavior, strict inputs and immutable options, deterministic engine reuse, weighted stationary selection, independent edit-distance and anchor oracles, and 150,000-line cases. Performance regressions use bounded work checks rather than timing assertions.

### Benchmarks

```sh
npm run benchmark
node benchmark_block_trace.mjs --only large-k-grams --profile
```

The runner uses deterministic workloads, including dense edits over shared values, two warmups and five measurements per workload and implementation. Both implementations finish warming before measurement; measured rounds interleave them and alternate their order. It reports milliseconds as JSON lines, including medians and ranges, and checks input coverage outside the timed section. Profiling adds inclusive phase measurements. `--baseline` imports a separate original ES module without changing it. Benchmarks now have one dedicated entry point; the old `--benchmark` modes in the correctness test files were removed.

### Browser regressions

```sh
npm install
npx playwright install chromium
npm run test:browser
```

An existing Chromium executable can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The runner starts and closes its own Node HTTP server and browser. Its checks cover operation order, literal changes, blank suppression, target formatting, exact comparison, zero-valued and invalid numeric controls, empty documents and final newlines, single-fragment output replacement, concise diagnostics with retained history beyond 30 entries, file loading, literal HTML, and narrow/wide controls.

The implementation was verified with Node.js 24.22.1. Full browser execution requires Chromium, and styled layout checks require the existing `../one.css`. Diagnostic messages exclude raw operations and document contents, preserve the global console methods, and have no entry-count cutoff.
