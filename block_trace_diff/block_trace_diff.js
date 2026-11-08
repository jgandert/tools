// --- Core Algorithm ---
class StringInterner {
    constructor() {
        this.stringToInt = new Map();
        this.intToString = [];
    }

    intern(str) {
        let id = this.stringToInt.get(str);
        if (id === undefined) {
            id = this.intToString.length;
            this.stringToInt.set(str, id);
            this.intToString.push(str);
        }
        return id;
    }
}

class BlockTraceDiff {
    constructor(options = {}) {
        if (options === null || typeof options !== "object" || Array.isArray(options)) {
            throw new TypeError("options must be an object");
        }
        this.kGramSize = options.kGramSize !== undefined ? options.kGramSize : 2;
        this.maxStitchGap = options.maxStitchGap !== undefined ? options.maxStitchGap : 2;
        this.maxOccurrences = options.maxOccurrences !== undefined ? options.maxOccurrences : 5;
        this.ignoreLeadingWhitespace = options.ignoreLeadingWhitespace !== undefined ? options.ignoreLeadingWhitespace : true;
        // Internal/trailing whitespace is significant by default, including inside literals.
        // Set all ignore* options and skipWhitespaceOps to false for an exact, lossless diff.
        // Opt-in normalization is textual, not syntax-aware; EQUAL retains both raw texts.
        this.ignoreTrailingWhitespace = options.ignoreTrailingWhitespace !== undefined ? options.ignoreTrailingWhitespace : false;
        this.ignoreInternalWhitespace = options.ignoreInternalWhitespace !== undefined ? options.ignoreInternalWhitespace : false;
        this.skipWhitespaceOps = options.skipWhitespaceOps !== undefined ? options.skipWhitespaceOps : true;

        for (const [name, minimum] of [["kGramSize", 1], ["maxStitchGap", 0], ["maxOccurrences", 0]]) {
            if (!Number.isSafeInteger(this[name]) || this[name] < minimum) {
                throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
            }
        }
        for (const name of ["ignoreLeadingWhitespace", "ignoreTrailingWhitespace", "ignoreInternalWhitespace", "skipWhitespaceOps"]) {
            if (typeof this[name] !== "boolean") {
                throw new TypeError(`${name} must be a boolean`);
            }
        }
        // A configured engine can be reused, but its validated settings cannot
        // be replaced with unchecked values between comparisons.
        for (const name of ["kGramSize", "maxStitchGap", "maxOccurrences", "ignoreLeadingWhitespace", "ignoreTrailingWhitespace", "ignoreInternalWhitespace", "skipWhitespaceOps"]) {
            Object.defineProperty(this, name, { writable: false, configurable: false });
        }
        // maxOccurrences: 0 intentionally disables anchoring (Myers-only fallback).
        this.interner = new StringInterner();
        this.moveCounter = 0;
    }

    diff(sourceLines, targetLines) {
        this._validateLines(sourceLines, "sourceLines");
        this._validateLines(targetLines, "targetLines");
        this.moveCounter = 0;
        this.interner = new StringInterner();
        const src = this._normalizeAndIntern(sourceLines);
        const target = this._normalizeAndIntern(targetLines);

        // Normalized equality needs neither anchors nor an edit graph. Preserve
        // the two raw texts, including matched blanks and ignored formatting.
        if (src.length === target.length && src.every((line, i) => line.intVal === target[i].intVal)) {
            return src.map((line, i) => this._formatEqual(line, target[i]));
        }

        const anchors = this._findAnchors(src, target);
        const candidates = this._seedAndExpand(anchors, src, target);

        const claimedExactMoves = this._greedyMasking(candidates);
        const moves = this._gapStitching(claimedExactMoves);

        const rawOps = this._fallbackDiffAndReassemble(src, target, moves, sourceLines, targetLines);
        return this._presentOperations(rawOps);
    }

    _validateLines(lines, name) {
        if (!Array.isArray(lines)) throw new TypeError(`${name} must be an array of strings`);
        for (let i = 0; i < lines.length; i++) {
            if (!Object.hasOwn(lines, i) || typeof lines[i] !== "string") {
                throw new TypeError(`${name}[${i}] must be a string`);
            }
        }
    }

    _presentOperations(ops, pairReplacements = true) {
        // Keep the complete edit model until presentation. Hidden blank edits must not
        // consume replacement partners, and both halves of a move stay visible together.
        const visibleMoves = new Set();
        if (this.skipWhitespaceOps) {
            for (const op of ops) {
                if ((op.type === "MOVE_FROM" || op.type === "MOVE_TO") && op.lines.some(line => line.trim() !== "")) {
                    visibleMoves.add(op.moveId);
                }
            }
        }

        const visible = [];
        for (const op of ops) {
            if (this.skipWhitespaceOps) {
                if (op.type === "MOVE_FROM" || op.type === "MOVE_TO") {
                    if (!visibleMoves.has(op.moveId)) continue;
                } else if (op.type !== "EQUAL" && op.text.trim() === "") {
                    continue;
                }
            }
            if (op.type === "MOVE_TO" && op.internalDiff) {
                // Preserve the existing nested DELETE/INSERT contract rather than
                // turning internal edits into another layer of REPLACE operations.
                visible.push({
                    ...op,
                    internalDiff: this._presentOperations(op.internalDiff, false),
                });
            } else {
                visible.push(op);
            }
        }
        return pairReplacements ? this._identifyReplacements(visible) : this._sortOperations(visible);
    }

    _normalizeAndIntern(lines) {
        return lines.map((line, index) => {
            let normalized = line;
            if (this.ignoreLeadingWhitespace) normalized = normalized.trimStart();
            if (this.ignoreTrailingWhitespace) normalized = normalized.trimEnd();
            if (this.ignoreInternalWhitespace) {
                // Collapse only whitespace between nonblank characters, preserving
                // either boundary unless its own ignore option is enabled.
                const start = normalized.search(/\S/);
                if (start !== -1) {
                    const end = normalized.trimEnd().length;
                    normalized = normalized.slice(0, start) + normalized.slice(start, end).replace(/\s+/g, " ") + normalized.slice(end);
                }
            }
            return {
                originalText: line,
                normalizedText: normalized,
                originalIndex: index,
                intVal: this.interner.intern(normalized),
            };
        });
    }

    _findAnchors(src, target) {
        if (this.maxOccurrences === 0 || src.length < this.kGramSize || target.length < this.kGramSize) return [];
        const [srcKeys, targetKeys] = this._kGramKeys(src, target);
        const buildMap = (keys, acceptedKeys) => {
            const map = new Map();
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                if (acceptedKeys && !acceptedKeys.get(key)) continue;
                const indices = map.get(key);
                if (indices === undefined) {
                    map.set(key, [i]);
                } else if (indices !== null) {
                    // Once an anchor is too common, discard its positions and
                    // retain only the rejection marker, regardless of file size.
                    if (indices.length === this.maxOccurrences) map.set(key, null);
                    else indices.push(i);
                }
            }
            return map;
        };
        const srcMap = buildMap(srcKeys);
        const targetMap = buildMap(targetKeys, srcMap);
        const anchors = [];
        for (const [key, srcIndices] of srcMap) {
            const targetIndices = targetMap.get(key);
            if (srcIndices && targetIndices) {
                for (const s of srcIndices) {
                    for (const t of targetIndices) {
                        anchors.push({ srcStart: s, targetStart: t });
                    }
                }
            }
        }
        return anchors;
    }

    _kGramKeys(src, target) {
        const k = this.kGramSize;
        let sourceRanks = src.map(line => line.intVal);
        let targetRanks = target.map(line => line.intVal);
        if (k === 1) return [sourceRanks, targetRanks];

        // Intern pairs of equal-length windows, doubling their span each pass.
        // The final prefix/suffix windows may overlap; together they cover all
        // k lines. Keys are exact identities, without probabilistic hash matches,
        // and building long windows takes O((N + M) log k), not O((N + M) k).
        let span = 1;
        while (span * 2 < k) {
            const pairs = new Map();
            const rankPairs = ranks => {
                const result = new Int32Array(ranks.length - span);
                for (let i = 0; i < result.length; i++) {
                    const pair = `${ranks[i]},${ranks[i + span]}`;
                    let rank = pairs.get(pair);
                    if (rank === undefined) {
                        rank = pairs.size;
                        pairs.set(pair, rank);
                    }
                    result[i] = rank;
                }
                return result;
            };
            sourceRanks = rankPairs(sourceRanks);
            targetRanks = rankPairs(targetRanks);
            span *= 2;
        }
        const keys = (ranks, length) => {
            const result = new Array(length - k + 1);
            for (let i = 0; i < result.length; i++) result[i] = `${ranks[i]},${ranks[i + k - span]}`;
            return result;
        };
        return [keys(sourceRanks, src.length), keys(targetRanks, target.length)];
    }

    _seedAndExpand(anchors, src, target) {
        const candidates = [];
        // Source-ordered anchors let each diagonal remember just its last expanded
        // end. Skip covered seeds BEFORE scanning, including subsequently trimmed padding.
        const expandedEnds = new Map();
        const orderedAnchors = anchors.slice().sort((a, b) => a.srcStart - b.srcStart);

        for (const anchor of orderedAnchors) {
            const diagonal = anchor.targetStart - anchor.srcStart;
            if (expandedEnds.has(diagonal) && anchor.srcStart + this.kGramSize - 1 <= expandedEnds.get(diagonal)) continue;
            let s = anchor.srcStart;
            let t = anchor.targetStart;

            while (s > 0 && t > 0 && src[s - 1].intVal === target[t - 1].intVal) {
                s--;
                t--;
            }
            let sStart = s;
            let tStart = t;

            s = anchor.srcStart + this.kGramSize - 1;
            t = anchor.targetStart + this.kGramSize - 1;

            while (s < src.length - 1 && t < target.length - 1 && src[s + 1].intVal === target[t + 1].intVal) {
                s++;
                t++;
            }
            let sEnd = s;
            let tEnd = t;
            expandedEnds.set(diagonal, sEnd);

            // Trim leading/trailing blank lines so they don't capture spacing padding
            while (sStart <= sEnd && src[sStart].originalText.trim() === "") {
                sStart++;
                tStart++;
            }
            while (sEnd >= sStart && src[sEnd].originalText.trim() === "") {
                sEnd--;
                tEnd--;
            }

            if (sEnd - sStart + 1 >= this.kGramSize) {
                candidates.push({
                    srcStart: sStart,
                    srcEnd: sEnd,
                    targetStart: tStart,
                    targetEnd: tEnd,
                    length: sEnd - sStart + 1,
                });
            }
        }
        return candidates;
    }

    _greedyMasking(candidates) {
        // Sort by length (descending), then minimal displacement
        candidates.sort((a, b) => {
            if (b.length !== a.length) return b.length - a.length;
            return Math.abs(a.srcStart - a.targetStart) - Math.abs(b.srcStart - b.targetStart);
        });

        let sourceLength = 0, targetLength = 0;
        for (const candidate of candidates) {
            sourceLength = Math.max(sourceLength, candidate.srcEnd + 1);
            targetLength = Math.max(targetLength, candidate.targetEnd + 1);
        }
        // Claiming dense line indices needs one byte per line, rather than a
        // hash-set entry for every claimed position in both documents.
        const claimedSrc = new Uint8Array(sourceLength);
        const claimedTarget = new Uint8Array(targetLength);
        const finalMoves = [];

        for (const cand of candidates) {
            let i = 0;
            const length = cand.length;
            const sStart = cand.srcStart;
            const tStart = cand.targetStart;

            while (i < length) {
                while (i < length && (claimedSrc[sStart + i] || claimedTarget[tStart + i])) {
                    i++;
                }
                if (i >= length) break;

                const segStart = i;
                while (i < length && !claimedSrc[sStart + i] && !claimedTarget[tStart + i]) {
                    i++;
                }
                const segEnd = i - 1;
                const segLength = segEnd - segStart + 1;

                if (segLength >= this.kGramSize) {
                    const matchedSrcStart = sStart + segStart;
                    const matchedSrcEnd = sStart + segEnd;
                    const matchedTargetStart = tStart + segStart;
                    const matchedTargetEnd = tStart + segEnd;

                    claimedSrc.fill(1, matchedSrcStart, matchedSrcEnd + 1);
                    claimedTarget.fill(1, matchedTargetStart, matchedTargetEnd + 1);

                    finalMoves.push({
                        srcStart: matchedSrcStart,
                        srcEnd: matchedSrcEnd,
                        targetStart: matchedTargetStart,
                        targetEnd: matchedTargetEnd,
                        length: segLength,
                    });
                }
            }
        }
        return finalMoves.sort((a, b) => a.srcStart - b.srcStart);
    }

    _gapStitching(exactMoves) {
        if (exactMoves.length === 0) return [];
        exactMoves = exactMoves.slice().sort((a, b) => a.srcStart - b.srcStart);
        const targetOrder = exactMoves.slice().sort((a, b) => a.targetStart - b.targetStart);
        const targetRank = new Map(targetOrder.map((move, i) => [move, i]));
        const stitched = [];
        let group = [exactMoves[0]];

        for (let i = 1; i < exactMoves.length; i++) {
            const prev = exactMoves[i - 1], curr = exactMoves[i];
            const srcGap = curr.srcStart - prev.srcEnd - 1;
            const targetGap = curr.targetStart - prev.targetEnd - 1;

            // Consecutive source blocks may have another block between them in the
            // target. Stitch only across unclaimed gaps on BOTH sides.
            const consecutive = targetRank.get(curr) === targetRank.get(prev) + 1;
            if (consecutive && srcGap >= 0 && srcGap <= this.maxStitchGap && targetGap >= 0 && targetGap <= this.maxStitchGap) {
                group.push(curr);
            } else {
                stitched.push(this._finalizeMoveGroup(group));
                group = [curr];
            }
        }
        stitched.push(this._finalizeMoveGroup(group));
        return stitched;
    }

    _finalizeMoveGroup(group) {
        const first = group[0], last = group[group.length - 1];
        this.moveCounter++;
        return {
            id: `move-${this.moveCounter}`,
            type: group.length === 1 ? "MOVE_EXACT" : "MOVE_MODIFIED",
            srcStart: first.srcStart, srcEnd: last.srcEnd,
            targetStart: first.targetStart, targetEnd: last.targetEnd,
            exactBlocks: group,
        };
    }

    _selectStationaryMoves(moves) {
        // Maximum-weight increasing subsequence: retain matching lines, not just
        // the largest number of block tokens. A Fenwick tree keeps this O(B log B).
        const sourceOrder = moves.slice().sort((a, b) => a.srcStart - b.srcStart);
        const targetOrder = moves.slice().sort((a, b) => a.targetStart - b.targetStart);
        const ranks = new Map(targetOrder.map((move, i) => [move, i + 1]));
        const tree = new Int32Array(moves.length + 1);
        const scores = new Float64Array(moves.length + 1);
        const previous = new Int32Array(moves.length + 1);
        const better = (a, b) => {
            if (scores[a] !== scores[b]) return scores[a] > scores[b] ? a : b;
            if (a === 0 || b === 0) return a || b;
            // Resolve equal weights deterministically, favoring the earlier target.
            return sourceOrder[a - 1].targetStart < sourceOrder[b - 1].targetStart ? a : b;
        };
        const query = rank => {
            let best = 0;
            for (let i = rank; i > 0; i -= i & -i) best = better(best, tree[i]);
            return best;
        };

        for (let i = 1; i <= sourceOrder.length; i++) {
            const move = sourceOrder[i - 1];
            const rank = ranks.get(move);
            previous[i] = query(rank - 1);
            // Unmatched stitched gaps do not count as retained lines.
            scores[i] = scores[previous[i]] + move.exactBlocks.reduce((sum, block) => sum + block.length, 0);
            for (let j = rank; j < tree.length; j += j & -j) tree[j] = better(tree[j], i);
        }

        const stationary = new Set();
        for (let i = query(moves.length); i !== 0; i = previous[i]) stationary.add(sourceOrder[i - 1].id);
        return stationary;
    }

    _fallbackDiffAndReassemble(src, target, moves, rawSrc, rawTarget) {
        let moveIdCounter = -10000;
        moves.forEach(m => m.tokenVal = moveIdCounter--);
        const bySourceStart = new Map(moves.map(m => [m.srcStart, m]));
        const byTargetStart = new Map(moves.map(m => [m.targetStart, m]));

        const buildRun = (arr, isSrc) => {
            if (moves.length === 0) return arr;
            const run = [];
            const byStart = isSrc ? bySourceStart : byTargetStart;
            let i = 0;
            while (i < arr.length) {
                const move = byStart.get(i);
                if (move) {
                    run.push({ isToken: true, val: move.tokenVal, move });
                    i = isSrc ? move.srcEnd + 1 : move.targetEnd + 1;
                } else {
                    run.push(arr[i]);
                    i++;
                }
            }
            return run;
        };
        const srcRun = buildRun(src, true);
        const targetRun = buildRun(target, false);

        const stationary = this._selectStationaryMoves(moves);
        const targetPositions = new Map();
        targetRun.forEach((node, i) => {
            if (node.isToken) targetPositions.set(node.move.id, i);
        });
        const srcVals = srcRun.map(node => node.isToken ? node.val : node.intVal);
        // Nonstationary tokens must produce both a deletion and an insertion.
        // Keep their target values disjoint from source tokens and interned lines.
        const targetVals = targetRun.map(node => node.isToken
            ? node.val - (stationary.has(node.move.id) ? 0 : moves.length)
            : node.intVal);
        const myersScript = [];
        let srcStart = 0, targetStart = 0;
        const appendGap = (srcEnd, targetEnd) => {
            const script = this._myersDiff(srcVals, targetVals, srcStart, srcEnd, targetStart, targetEnd);
            for (const op of script) myersScript.push(op);
        };
        for (let i = 0; i < srcRun.length; i++) {
            const node = srcRun[i];
            if (!node.isToken || !stationary.has(node.move.id)) continue;
            const j = targetPositions.get(node.move.id);
            appendGap(i, j);
            myersScript.push({ type: "EQUAL", srcIdx: i, targetIdx: j });
            srcStart = i + 1;
            targetStart = j + 1;
        }
        appendGap(srcRun.length, targetRun.length);
        return this._buildFinalOutput(myersScript, srcRun, targetRun, rawSrc, rawTarget, src, target);
    }

    _myersDiff(a, b, aStart = 0, aEnd = a.length, bStart = 0, bEnd = b.length) {
        const script = [];
        this._myersLinear(a, aStart, aEnd, b, bStart, bEnd, script);
        return script;
    }

    _myersLinear(a, aStart, aEnd, b, bStart, bEnd, script) {
        // An explicit stack avoids depending on the runtime's recursion limit.
        // Suffix tasks keep the output in order while each split is processed.
        const pending = [{ aStart, aEnd, bStart, bEnd }];
        while (pending.length) {
            const range = pending.pop();
            ({ aStart, aEnd, bStart, bEnd } = range);
            if (range.equalLength !== undefined) {
                for (let i = 0; i < range.equalLength; i++) {
                    script.push({ type: "EQUAL", srcIdx: aStart + i, targetIdx: bStart + i });
                }
                continue;
            }
            while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
                script.push({ type: "EQUAL", srcIdx: aStart++, targetIdx: bStart++ });
            }
            let suffixLength = 0;
            while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
                aEnd--;
                bEnd--;
                suffixLength++;
            }
            if (suffixLength) pending.push({ aStart: aEnd, bStart: bEnd, equalLength: suffixLength });

            const N = aEnd - aStart, M = bEnd - bStart;
            if (N === 0 || M === 0 || (N + M >= 128 && !this._haveCommonValues(a, aStart, aEnd, b, bStart, bEnd))) {
                // Disjoint ranges have a known shortest script. In particular,
                // unrelated large files should not search a quadratic edit graph.
                for (let i = aStart; i < aEnd; i++) script.push({ type: "DELETE", srcIdx: i, targetIdx: null });
                for (let i = bStart; i < bEnd; i++) script.push({ type: "INSERT", srcIdx: null, targetIdx: i });
            } else if (N === 1) {
                let match = bStart;
                while (match < bEnd && a[aStart] !== b[match]) match++;
                if (match === bEnd) script.push({ type: "DELETE", srcIdx: aStart, targetIdx: null });
                for (let i = bStart; i < bEnd; i++) {
                    script.push(i === match
                        ? { type: "EQUAL", srcIdx: aStart, targetIdx: i }
                        : { type: "INSERT", srcIdx: null, targetIdx: i });
                }
            } else if (M === 1) {
                let match = aStart;
                while (match < aEnd && a[match] !== b[bStart]) match++;
                for (let i = aStart; i < aEnd; i++) {
                    script.push(i === match
                        ? { type: "EQUAL", srcIdx: i, targetIdx: bStart }
                        : { type: "DELETE", srcIdx: i, targetIdx: null });
                }
                if (match === aEnd) script.push({ type: "INSERT", srcIdx: null, targetIdx: bStart });
            } else {
                const split = this._findMiddleSnake(a, aStart, aEnd, b, bStart, bEnd);
                if ((split.x === 0 && split.y === 0) || (split.x === N && split.y === M)) {
                    throw new Error("Myers split did not make progress");
                }
                pending.push({ aStart: aStart + split.x, aEnd, bStart: bStart + split.y, bEnd });
                pending.push({ aStart, aEnd: aStart + split.x, bStart, bEnd: bStart + split.y });
            }
        }
    }

    _haveCommonValues(a, aStart, aEnd, b, bStart, bEnd) {
        if (aEnd - aStart > bEnd - bStart) return this._haveCommonValues(b, bStart, bEnd, a, aStart, aEnd);
        const values = new Set();
        for (let i = aStart; i < aEnd; i++) values.add(a[i]);
        for (let i = bStart; i < bEnd; i++) if (values.has(b[i])) return true;
        return false;
    }

    _findMiddleSnake(a, aStart, aEnd, b, bStart, bEnd) {
        const N = aEnd - aStart;
        const M = bEnd - bStart;
        const delta = N - M;
        const odd = delta % 2 !== 0;
        const max = Math.ceil((N + M) / 2);

        const vf = new Int32Array(2 * max + 3);
        const vb = new Int32Array(2 * max + 3);
        const vOffset = max + 1;
        vf.fill(-1);
        vb.fill(N + 1);
        vf[vOffset] = 0;
        vb[vOffset] = N;

        // Clipped bounds move one diagonal per layer, so each predecessor is
        // from the previous layer or is an untouched sentinel. Valid predecessors
        // are already in the grid: a step only needs to check its changed axis.
        for (let d = 1; d <= max; d++) {
            // A path cannot delete more than N or insert more than M values.
            // Clipping those impossible diagonals is crucial for uneven inputs.
            const forwardMin = Math.max(-d, d - 2 * M);
            const forwardMax = Math.min(d, 2 * N - d);
            for (let k = forwardMax; k >= forwardMin; k -= 2) {
                const kc = k + vOffset;
                const down = vf[kc + 1], right = vf[kc - 1] + 1;
                const canDown = down >= 0 && down - k <= M;
                const canRight = right > 0 && right <= N;
                if (!canDown && !canRight) {
                    vf[kc] = -1;
                    continue;
                }
                const fromDown = canDown && (!canRight || down >= right);
                const previousX = fromDown ? down : right - 1;
                const previousY = previousX - (fromDown ? k + 1 : k - 1);
                let x = fromDown ? down : right;
                let y = x - k;
                while (x < N && y < M && a[aStart + x] === b[bStart + y]) {
                    x++;
                    y++;
                }
                vf[kc] = x;
                if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
                    if (x >= vb[kc - delta]) return { x: previousX, y: previousY };
                }
            }

            const backwardMin = Math.max(-d, d - 2 * N);
            const backwardMax = Math.min(d, 2 * M - d);
            for (let k = backwardMax; k >= backwardMin; k -= 2) {
                const kc = k + vOffset;
                const diagonal = k + delta;
                const up = vb[kc - 1], left = vb[kc + 1] - 1;
                const canUp = up <= N && up - diagonal >= 0;
                const canLeft = left < N && left >= 0;
                if (!canUp && !canLeft) {
                    vb[kc] = N + 1;
                    continue;
                }
                const midX = canUp && (!canLeft || up <= left) ? up : left;
                const midY = midX - diagonal;
                let x = midX;
                let y = midY;
                while (x > 0 && y > 0 && a[aStart + x - 1] === b[bStart + y - 1]) {
                    x--;
                    y--;
                }
                vb[kc] = x;
                if (!odd && diagonal >= -d && diagonal <= d) {
                    if (x <= vf[kc + delta]) return { x: midX, y: midY };
                }
            }
        }
        throw new Error("Myers search could not find an overlap");
    }

    _formatEqual(src, target) {
        // text consistently belongs to the source; callers can reconstruct either
        // document even when an explicitly ignored whitespace difference matches.
        return {
            type: "EQUAL",
            text: src.originalText,
            sourceText: src.originalText,
            targetText: target.originalText,
            isExact: src.originalText === target.originalText,
            srcLine: src.originalIndex + 1,
            targetLine: target.originalIndex + 1,
        };
    }

    _buildFinalOutput(script, srcRun, targetRun, rawSrc, rawTarget, fullSrc, fullTarget) {
        const output = [];
        for (const op of script) {
            if (op.type === "EQUAL") {
                const n = srcRun[op.srcIdx];
                if (n.isToken) {
                    if (n.move.type === "MOVE_EXACT") {
                        const offset = n.move.targetStart - n.move.srcStart;
                        for (let i = n.move.srcStart; i <= n.move.srcEnd; i++) {
                            output.push(this._formatEqual(fullSrc[i], fullTarget[i + offset]));
                        }
                    } else if (n.move.type === "MOVE_MODIFIED") {
                        for (const mod of this._calcInternalMod(n.move, fullSrc, fullTarget)) output.push(mod);
                    }
                } else {
                    const nTarget = targetRun[op.targetIdx];
                    output.push(this._formatEqual(n, nTarget));
                }
            } else if (op.type === "DELETE") {
                const n = srcRun[op.srcIdx];
                if (n.isToken) {
                    output.push(this._formatMove(n.move, "MOVE_FROM", rawSrc, rawTarget, fullSrc, fullTarget));
                } else {
                    output.push({
                        type: "DELETE",
                        text: n.originalText,
                        srcLine: n.originalIndex + 1,
                    });
                }
            } else if (op.type === "INSERT") {
                const n = targetRun[op.targetIdx];
                if (n.isToken) {
                    output.push(this._formatMove(n.move, "MOVE_TO", rawSrc, rawTarget, fullSrc, fullTarget));
                } else {
                    output.push({
                        type: "INSERT",
                        text: n.originalText,
                        targetLine: n.originalIndex + 1,
                    });
                }
            }
        }
        return output;
    }

    _formatMove(move, direction, rawSrc, rawTarget, fullSrc, fullTarget) {
        const payload = {
            type: direction,
            moveId: move.id,
            moveType: move.type,
            lines: direction === "MOVE_FROM" ? rawSrc.slice(move.srcStart, move.srcEnd + 1) : rawTarget.slice(move.targetStart, move.targetEnd + 1),
            srcStartLine: move.srcStart + 1,
            srcEndLine: move.srcEnd + 1,
            targetStartLine: move.targetStart + 1,
            targetEndLine: move.targetEnd + 1,
        };
        if (direction === "MOVE_TO") {
            // MOVE_EXACT means exact under the configured matching normalization.
            // Expose raw whitespace differences inside such a move as well.
            const rawDifference = move.type === "MOVE_MODIFIED" || payload.lines.some((line, i) => line !== rawSrc[move.srcStart + i]);
            if (rawDifference) payload.internalDiff = this._calcInternalMod(move, fullSrc, fullTarget);
        }
        return payload;
    }

    _calcInternalMod(move, src, target) {
        const internal = [];
        const blocks = move.exactBlocks;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            for (let j = b.targetStart; j <= b.targetEnd; j++) {
                internal.push(this._formatEqual(src[b.srcStart + (j - b.targetStart)], target[j]));
            }
            if (i < blocks.length - 1) {
                const next = blocks[i + 1];
                const srcVals = src.slice(b.srcEnd + 1, next.srcStart).map(x => x.intVal);
                const targetVals = target.slice(b.targetEnd + 1, next.targetStart).map(x => x.intVal);
                const gapScript = this._myersDiff(srcVals, targetVals);
                for (const op of gapScript) {
                    if (op.type === "EQUAL") {
                        internal.push(this._formatEqual(src[b.srcEnd + 1 + op.srcIdx], target[b.targetEnd + 1 + op.targetIdx]));
                    } else if (op.type === "DELETE") {
                        internal.push({
                            type: "DELETE",
                            text: src[b.srcEnd + 1 + op.srcIdx].originalText,
                            srcLine: b.srcEnd + 1 + op.srcIdx + 1,
                        });
                    } else if (op.type === "INSERT") {
                        internal.push({
                            type: "INSERT",
                            text: target[b.targetEnd + 1 + op.targetIdx].originalText,
                            targetLine: b.targetEnd + 1 + op.targetIdx + 1,
                        });
                    }
                }
            }
        }
        return internal;
    }

    _sortOperations(ops) {
        const result = [];
        let i = 0;
        const n = ops.length;
        while (i < n) {
            if (ops[i].type === "EQUAL") {
                result.push(ops[i]);
                i++;
            } else {
                const start = i;
                while (i < n && ops[i].type !== "EQUAL") i++;
                // Stable partition preserves each document's consuming order.
                for (let j = start; j < i; j++) {
                    if (ops[j].type === "DELETE" || ops[j].type === "MOVE_FROM") result.push(ops[j]);
                }
                for (let j = start; j < i; j++) {
                    if (ops[j].type !== "DELETE" && ops[j].type !== "MOVE_FROM") result.push(ops[j]);
                }
            }
        }
        return result;
    }

    _identifyReplacements(ops) {
        const result = [];
        let i = 0;
        const n = ops.length;

        while (i < n) {
            if (ops[i].type === "EQUAL") {
                result.push(ops[i]);
                i++;
                continue;
            }
            const source = [], target = [];
            while (i < n && ops[i].type !== "EQUAL") {
                const op = ops[i++];
                if (op.type === "DELETE" || op.type === "MOVE_FROM") source.push(op);
                else target.push(op);
            }
            // Keep each side's consuming operations in order. Moves can interrupt
            // replacement pairing, but must be emitted before any later line on
            // their own side; grouping all move operations at the end breaks this.
            let s = 0, t = 0;
            while (s < source.length || t < target.length) {
                if (s < source.length && source[s].type === "MOVE_FROM") {
                    result.push(source[s++]);
                } else if (t < target.length && target[t].type === "MOVE_TO") {
                    result.push(target[t++]);
                } else if (s < source.length && t < target.length) {
                    const deleted = source[s++], inserted = target[t++];
                    result.push({
                        type: "REPLACE",
                        text: inserted.text,
                        lines: [inserted.text],
                        srcLine: deleted.srcLine,
                        targetLine: inserted.targetLine,
                        internalDiff: [
                            { type: "DELETE", text: deleted.text },
                            { type: "INSERT", text: inserted.text },
                        ],
                    });
                } else if (s < source.length) {
                    result.push(source[s++]);
                } else {
                    result.push(target[t++]);
                }
            }
        }
        return result;
    }
}

export { StringInterner, BlockTraceDiff };
