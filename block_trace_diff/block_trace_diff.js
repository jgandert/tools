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
            let sStart = cand.srcStart;
            let sEnd = cand.srcEnd;
            let tStart = cand.targetStart;
            let tEnd = cand.targetEnd;

            // Edge Trimming: Shrink the boundaries if they overlap on the edges
            while (sStart <= sEnd && (claimedSrc.has(sStart) || claimedTarget.has(tStart))) {
                sStart++;
                tStart++;
            }
            while (sEnd >= sStart && (claimedSrc.has(sEnd) || claimedTarget.has(tEnd))) {
                sEnd--;
                tEnd--;
            }

            // Only keep it if we still have a valid k-gram sized block after trimming
            if (sEnd - sStart + 1 >= this.kGramSize) {
                // Double check for internal overlaps that can't be edge-trimmed
                let valid = true;
                for (let i = sStart; i <= sEnd; i++) if (claimedSrc.has(i)) valid = false;
                for (let i = tStart; i <= tEnd; i++) if (claimedTarget.has(i)) valid = false;

                if (valid) {
                    for (let i = sStart; i <= sEnd; i++) claimedSrc.add(i);
                    for (let i = tStart; i <= tEnd; i++) claimedTarget.add(i);
                    finalMoves.push({
                        srcStart: sStart, srcEnd: sEnd,
                        targetStart: tStart, targetEnd: tEnd,
                        length: sEnd - sStart + 1,
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
        const N = a.length, M = b.length, max = N + M;
        const v = new Int32Array(2 * max + 1), trace = [];
        v[max + 1] = 0;

        for (let d = 0; d <= max; d++) {
            const row = new Int32Array(2 * d + 1);
            for (let k = -d; k <= d; k += 2) {
                const vIndex = k + max;
                let x = (k === -d || (k !== d && v[vIndex - 1] < v[vIndex + 1])) ? v[vIndex + 1] : v[vIndex - 1] + 1;
                let y = x - k;
                while (x < N && y < M && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[vIndex] = x;
                row[k + d] = x;
                if (x >= N && y >= M) {
                    trace.push(row);
                    return this._backtrackMyers(trace, a, b, d, max);
                }
            }
            trace.push(row);
        }
        return [];
    }

    _backtrackMyers(trace, a, b, d, max) {
        let x = a.length, y = b.length;
        const script = [];
        for (let step = d; step > 0; step--) {
            const k = x - y;
            const prevRow = trace[step - 1];
            const prevK = (k === -step || (k !== step && prevRow[k + step - 2] < prevRow[k + step])) ? k + 1 : k - 1;
            const prevX = prevRow[prevK + (step - 1)], prevY = prevX - prevK;
            while (x > prevX && y > prevY) script.unshift({
                type: "EQUAL",
                srcIdx: --x,
                targetIdx: --y,
            });
            if (x > prevX) script.unshift({ type: "DELETE", srcIdx: --x, targetIdx: null });
            else script.unshift({ type: "INSERT", srcIdx: null, targetIdx: --y });
            x = prevX;
            y = prevY;
        }
        while (x > 0 && y > 0) script.unshift({ type: "EQUAL", srcIdx: --x, targetIdx: --y });
        return script;
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
            if (ops[i].type === "DELETE") {
                const deletes = [];
                while (i < n && ops[i].type === "DELETE") {
                    deletes.push(ops[i]);
                    i++;
                }

                const inserts = [];
                while (i < n && ops[i].type === "INSERT") {
                    inserts.push(ops[i]);
                    i++;
                }

                if (inserts.length > 0) {
                    const K = Math.min(deletes.length, inserts.length);
                    for (let j = 0; j < K; j++) {
                        result.push({
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
                    for (let j = K; j < deletes.length; j++) {
                        result.push(deletes[j]);
                    }
                    for (let j = K; j < inserts.length; j++) {
                        result.push(inserts[j]);
                    }
                } else {
                    result.push(...deletes);
                }
            } else {
                result.push(ops[i]);
                i++;
            }
        }
        return result;
    }
}

export { StringInterner, BlockTraceDiff };