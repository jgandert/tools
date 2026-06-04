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
        this.kGramSize = options.kGramSize || 2;
        this.maxStitchGap = options.maxStitchGap !== undefined ? options.maxStitchGap : 2;
        this.maxOccurrences = options.maxOccurrences !== undefined ? options.maxOccurrences : 5;
        this.ignoreLeadingWhitespace = options.ignoreLeadingWhitespace !== undefined ? options.ignoreLeadingWhitespace : true;
        this.skipWhitespaceOps = options.skipWhitespaceOps !== undefined ? options.skipWhitespaceOps : true;
        this.interner = new StringInterner();
        this.moveCounter = 0;
    }

    diff(sourceLines, targetLines) {
        this.moveCounter = 0;
        this.interner = new StringInterner();
        const src = this._normalizeAndIntern(sourceLines);
        const target = this._normalizeAndIntern(targetLines);

        const anchors = this._findAnchors(src, target);
        const candidates = this._seedAndExpand(anchors, src, target);

        const claimedExactMoves = this._greedyMasking(candidates);
        const moves = this._gapStitching(claimedExactMoves);

        const rawOps = this._fallbackDiffAndReassemble(src, target, moves, sourceLines, targetLines);
        const sortedOps = this._sortOperations(rawOps);
        let finalOps = this._identifyReplacements(sortedOps);

        if (this.skipWhitespaceOps) {
            finalOps = finalOps.filter(op => {
                if (op.type === "EQUAL") {
                    return true;
                }
                if (op.type === "MOVE_FROM" || op.type === "MOVE_TO") {
                    return op.lines && op.lines.some(line => line.trim() !== "");
                }
                if (op.type === "REPLACE") {
                    if (op.internalDiff) {
                        return op.internalDiff.some(mod => mod.text.trim() !== "");
                    }
                    return op.text.trim() !== "";
                }
                return op.text.trim() !== "";
            });
        }

        return finalOps;
    }

    _normalizeAndIntern(lines) {
        return lines.map((line, index) => {
            let leading = "";
            let normalized = line;
            if (this.ignoreLeadingWhitespace) {
                normalized = normalized.trimStart();
            } else {
                const match = normalized.match(/^\s*/);
                if (match) {
                    leading = match[0];
                    normalized = normalized.slice(leading.length);
                }
            }
            normalized = leading + normalized.trimEnd().replace(/\s+/g, " ");
            return {
                originalText: line,
                normalizedText: normalized,
                originalIndex: index,
                intVal: this.interner.intern(normalized),
            };
        });
    }

    _findAnchors(src, target) {
        const hashKGram = (arr, startIndex, k) => {
            let hash = "";
            for (let i = 0; i < k; i++) hash += arr[startIndex + i].intVal + ",";
            return hash;
        };

        const buildMap = (arr) => {
            const map = new Map();
            for (let i = 0; i <= arr.length - this.kGramSize; i++) {
                const hash = hashKGram(arr, i, this.kGramSize);
                if (!map.has(hash)) map.set(hash, []);
                map.get(hash).push(i);
            }
            return map;
        };

        const srcMap = buildMap(src);
        const targetMap = buildMap(target);
        const anchors = [];

        for (const [hash, srcIndices] of srcMap.entries()) {
            const targetIndices = targetMap.get(hash);
            // Bounded N:M matching handles duplicated blocks without combinatorial explosions
            if (targetIndices && srcIndices.length <= this.maxOccurrences && targetIndices.length <= this.maxOccurrences) {
                for (const s of srcIndices) {
                    for (const t of targetIndices) {
                        anchors.push({ srcStart: s, targetStart: t });
                    }
                }
            }
        }
        return anchors;
    }

    _seedAndExpand(anchors, src, target) {
        const candidates = [];
        const seen = new Set();

        for (const anchor of anchors) {
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

            // Trim leading/trailing blank lines so they don't capture spacing padding
            while (sStart <= sEnd && src[sStart].normalizedText === "") {
                sStart++;
                tStart++;
            }
            while (sEnd >= sStart && src[sEnd].normalizedText === "") {
                sEnd--;
                tEnd--;
            }

            if (sEnd - sStart + 1 >= this.kGramSize) {
                const id = `${sStart}-${sEnd}-${tStart}-${tEnd}`;
                if (!seen.has(id)) {
                    seen.add(id);
                    candidates.push({
                        srcStart: sStart,
                        srcEnd: sEnd,
                        targetStart: tStart,
                        targetEnd: tEnd,
                        length: sEnd - sStart + 1,
                    });
                }
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

        const claimedSrc = new Set(), claimedTarget = new Set(), finalMoves = [];

        for (const cand of candidates) {
            let i = 0;
            const length = cand.length;
            const sStart = cand.srcStart;
            const tStart = cand.targetStart;

            while (i < length) {
                while (i < length && (claimedSrc.has(sStart + i) || claimedTarget.has(tStart + i))) {
                    i++;
                }
                if (i >= length) break;

                const segStart = i;
                while (i < length && !claimedSrc.has(sStart + i) && !claimedTarget.has(tStart + i)) {
                    i++;
                }
                const segEnd = i - 1;
                const segLength = segEnd - segStart + 1;

                if (segLength >= this.kGramSize) {
                    const matchedSrcStart = sStart + segStart;
                    const matchedSrcEnd = sStart + segEnd;
                    const matchedTargetStart = tStart + segStart;
                    const matchedTargetEnd = tStart + segEnd;

                    for (let j = matchedSrcStart; j <= matchedSrcEnd; j++) claimedSrc.add(j);
                    for (let j = matchedTargetStart; j <= matchedTargetEnd; j++) claimedTarget.add(j);

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
        const stitched = [];
        let group = [exactMoves[0]];

        for (let i = 1; i < exactMoves.length; i++) {
            const prev = exactMoves[i - 1], curr = exactMoves[i];
            const srcGap = curr.srcStart - prev.srcEnd - 1;
            const targetGap = curr.targetStart - prev.targetEnd - 1;

            if (srcGap >= 0 && srcGap <= this.maxStitchGap && targetGap >= 0 && targetGap <= this.maxStitchGap && curr.targetStart > prev.targetEnd) {
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

    _fallbackDiffAndReassemble(src, target, moves, rawSrc, rawTarget) {
        let moveIdCounter = -10000;
        moves.forEach(m => m.tokenVal = moveIdCounter--);

        const srcRun = [], targetRun = [];
        const buildRun = (arr, isSrc, runTarget) => {
            let i = 0;
            while (i < arr.length) {
                const move = moves.find(m => isSrc ? m.srcStart === i : m.targetStart === i);
                if (move) {
                    runTarget.push({ isToken: true, val: move.tokenVal, move });
                    i = isSrc ? move.srcEnd + 1 : move.targetEnd + 1;
                } else {
                    runTarget.push({ isToken: false, val: arr[i].intVal, data: arr[i] });
                    i++;
                }
            }
        };

        buildRun(src, true, srcRun);
        buildRun(target, false, targetRun);

        const myersScript = this._myersDiff(srcRun.map(x => x.val), targetRun.map(x => x.val));
        return this._buildFinalOutput(myersScript, srcRun, targetRun, rawSrc, rawTarget, src, target);
    }

    _myersDiff(a, b) {
        const script = [];
        this._myersLinear(a, 0, a.length, b, 0, b.length, script);
        return script;
    }

    _myersLinear(a, aStart, aEnd, b, bStart, bEnd, script) {
        let N = aEnd - aStart;
        let M = bEnd - bStart;

        while (N > 0 && M > 0 && a[aStart] === b[bStart]) {
            script.push({ type: "EQUAL", srcIdx: aStart, targetIdx: bStart });
            aStart++;
            bStart++;
            N--;
            M--;
        }

        let suffixLength = 0;
        while (N > 0 && M > 0 && a[aStart + N - 1] === b[bStart + M - 1]) {
            suffixLength++;
            N--;
            M--;
        }
        aEnd -= suffixLength;
        bEnd -= suffixLength;

        if (N === 0) {
            for (let i = 0; i < M; i++) {
                script.push({ type: "INSERT", srcIdx: null, targetIdx: bStart + i });
            }
        } else if (M === 0) {
            for (let i = 0; i < N; i++) {
                script.push({ type: "DELETE", srcIdx: aStart + i, targetIdx: null });
            }
        } else {
            const split = this._findMiddleSnake(a, aStart, aEnd, b, bStart, bEnd);
            this._myersLinear(a, aStart, aStart + split.x, b, bStart, bStart + split.y, script);
            this._myersLinear(a, aStart + split.x, aEnd, b, bStart + split.y, bEnd, script);
        }

        for (let i = 0; i < suffixLength; i++) {
            script.push({ type: "EQUAL", srcIdx: aEnd + i, targetIdx: bEnd + i });
        }
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

        vf[vOffset] = 0;
        vb[vOffset] = N;

        for (let d = 1; d <= max; d++) {
            for (let k = d; k >= -d; k -= 2) {
                const kc = k + vOffset;
                let x_prev;
                let y_prev;
                if (k === -d || (k !== d && vf[kc - 1] < vf[kc + 1])) {
                    x_prev = vf[kc + 1];
                    y_prev = x_prev - (k + 1);
                } else {
                    x_prev = vf[kc - 1];
                    y_prev = x_prev - (k - 1);
                }

                let px;
                if (k === -d || (k !== d && vf[kc - 1] < vf[kc + 1])) {
                    px = vf[kc + 1];
                } else {
                    px = vf[kc - 1] + 1;
                }

                let x = px;
                let y = x - k;

                while (x < N && y < M && a[aStart + x] === b[bStart + y]) {
                    x++;
                    y++;
                }
                vf[kc] = x;

                if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
                    if (x >= vb[kc - delta]) {
                        return { x: x_prev, y: y_prev };
                    }
                }
            }

            for (let k = d; k >= -d; k -= 2) {
                const kc = k + vOffset;
                let midX;
                if (k === d || (k !== -d && vb[kc - 1] < vb[kc + 1])) {
                    midX = vb[kc - 1];
                } else {
                    midX = vb[kc + 1] - 1;
                }
                let midY = midX - (k + delta);

                let x = midX;
                let y = midY;

                while (x > 0 && y > 0 && a[aStart + x - 1] === b[bStart + y - 1]) {
                    x--;
                    y--;
                }
                vb[kc] = x;

                if (!odd && (k + delta) >= -d && (k + delta) <= d) {
                    if (x <= vf[kc + delta]) {
                        return { x: midX, y: midY };
                    }
                }
            }
        }
        return { x: 0, y: 0 };
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
                            output.push({
                                type: "EQUAL",
                                text: fullSrc[i].originalText,
                                srcLine: i + 1,
                                targetLine: i + offset + 1,
                            });
                        }
                    } else if (n.move.type === "MOVE_MODIFIED") {
                        output.push(...this._calcInternalMod(n.move, fullSrc, fullTarget));
                    }
                } else {
                    const nTarget = targetRun[op.targetIdx];
                    output.push({
                        type: "EQUAL",
                        text: n.data.originalText,
                        srcLine: n.data.originalIndex + 1,
                        targetLine: nTarget.data.originalIndex + 1,
                    });
                }
            } else if (op.type === "DELETE") {
                const n = srcRun[op.srcIdx];
                if (n.isToken) {
                    output.push(this._formatMove(n.move, "MOVE_FROM", rawSrc, rawTarget, fullSrc, fullTarget));
                } else {
                    output.push({
                        type: "DELETE",
                        text: n.data.originalText,
                        srcLine: n.data.originalIndex + 1,
                    });
                }
            } else if (op.type === "INSERT") {
                const n = targetRun[op.targetIdx];
                if (n.isToken) {
                    output.push(this._formatMove(n.move, "MOVE_TO", rawSrc, rawTarget, fullSrc, fullTarget));
                } else {
                    output.push({
                        type: "INSERT",
                        text: n.data.originalText,
                        targetLine: n.data.originalIndex + 1,
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
        if (move.type === "MOVE_MODIFIED" && direction === "MOVE_TO") {
            payload.internalDiff = this._calcInternalMod(move, fullSrc, fullTarget);
        }
        return payload;
    }

    _calcInternalMod(move, src, target) {
        const internal = [];
        const blocks = move.exactBlocks;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            for (let j = b.targetStart; j <= b.targetEnd; j++) {
                internal.push({
                    type: "EQUAL",
                    text: target[j].originalText,
                    srcLine: b.srcStart + (j - b.targetStart) + 1,
                    targetLine: j + 1,
                });
            }
            if (i < blocks.length - 1) {
                const next = blocks[i + 1];
                const srcVals = src.slice(b.srcEnd + 1, next.srcStart).map(x => x.intVal);
                const targetVals = target.slice(b.targetEnd + 1, next.targetStart).map(x => x.intVal);
                const gapScript = this._myersDiff(srcVals, targetVals);
                for (const op of gapScript) {
                    if (op.type === "EQUAL") {
                        internal.push({
                            type: "EQUAL",
                            text: target[b.targetEnd + 1 + op.targetIdx].originalText,
                            srcLine: b.srcEnd + 1 + op.srcIdx + 1,
                            targetLine: b.targetEnd + 1 + op.targetIdx + 1,
                        });
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
                const block = [];
                while (i < n && ops[i].type !== "EQUAL") {
                    block.push(ops[i]);
                    i++;
                }
                block.sort((a, b) => {
                    const aIsDel = a.type === "DELETE" || a.type === "MOVE_FROM";
                    const bIsDel = b.type === "DELETE" || b.type === "MOVE_FROM";
                    if (aIsDel && !bIsDel) return -1;
                    if (!aIsDel && bIsDel) return 1;
                    return 0;
                });
                result.push(...block);
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
            const block = [];
            while (i < n && ops[i].type !== "EQUAL") {
                block.push(ops[i]);
                i++;
            }
            const deletes = block.filter(op => op.type === "DELETE");
            const inserts = block.filter(op => op.type === "INSERT");
            const moveFroms = block.filter(op => op.type === "MOVE_FROM");
            const moveTos = block.filter(op => op.type === "MOVE_TO");
            const replaces = [];
            const K = Math.min(deletes.length, inserts.length);
            for (let j = 0; j < K; j++) {
                replaces.push({
                    type: "REPLACE",
                    text: inserts[j].text,
                    lines: [inserts[j].text],
                    srcLine: deletes[j].srcLine,
                    targetLine: inserts[j].targetLine,
                    internalDiff: [
                        { type: "DELETE", text: deletes[j].text },
                        { type: "INSERT", text: inserts[j].text },
                    ],
                });
            }
            const leftoverDeletes = deletes.slice(K);
            const leftoverInserts = inserts.slice(K);
            result.push(...replaces);
            result.push(...leftoverDeletes);
            result.push(...moveFroms);
            result.push(...leftoverInserts);
            result.push(...moveTos);
        }
        return result;
    }
}

export { StringInterner, BlockTraceDiff };