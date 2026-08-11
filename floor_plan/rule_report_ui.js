(function(root) {
    function verdictLabel(rule) {
        if (rule.satisfied === null) {
            return "conflict exempt";
        }
        return rule.satisfied ? "yes" : "no";
    }

    function dominanceHintText(rule, formatNumber) {
        if (!rule.dominanceHints) {
            return "";
        }
        if (!rule.dominanceHints.length) {
            return "Magnitude correlation only (not a causal counterfactual): no larger same-room rule penalty found.";
        }
        const hints = rule.dominanceHints.map(hint => `${hint.text} [${hint.ruleId}] ${formatNumber(hint.penalty)} vs ${formatNumber(rule.penalty)} (+${formatNumber(hint.penaltyDifference)}), shared ${hint.sharedRooms.join(", ")}`);
        return `Magnitude correlation only (not a causal counterfactual): ${hints.join("; ")}`;
    }

    function weightSemanticsText(semantics, formatNumber) {
        if (!semantics) {
            return "";
        }
        const example = semantics.example;
        return `Weight warning: advisory raw weight N is compressed to target ${semantics.compressedTargetFormula}; during annealing effective weight is ${semantics.annealingEffectiveFormula}. At T=initial_t only ${formatNumber(semantics.initialOffsetFraction * 100)}% of target's offset from 1 applies, and target is reached at T <= initial_t * ${formatNumber(semantics.fullTargetTemperatureFraction)}. Final rows use compressed target weight. Example weight=${example.rawWeight}: target ${formatNumber(example.compressedTargetWeight)}, start ${formatNumber(example.initialEffectiveWeight)}. required uses ${semantics.requiredWeightFormula} and bypasses compression and temperature ramp.`;
    }

    function farPenaltyDecompositionText(rule, formatNumber) {
        const split = rule.farPenaltyDecomposition;
        if (!split) {
            return "";
        }
        const distanceLimits = split.floorTerms
            .map(term => `${term.target}: current center distance ${formatNumber(term.centerDistance)}, max ${formatNumber(term.maximumCenterDistance)} (${term.maximumDistanceBasis.replaceAll("-", " ")})`)
            .join("; ");
        return `Required far penalty split: ${formatNumber(split.irreduciblePenalty)} irreducible floor + ${formatNumber(split.reduciblePenalty)} distance-reducible = ${formatNumber(rule.penalty)}. Formula: ${split.penaltyFormula}; required weight ${formatNumber(split.requiredWeight)}, scale ${formatNumber(split.penaltyScale)}, ${split.aggregation}. Canvas diagonal ${formatNumber(split.canvasDiagonal)}; ${split.boundedSubjectAssumption}. ${distanceLimits}.`;
    }

    function renderRuleReportHtml(report, escapeHtml, formatNumber) {
        if (!report) {
            return "";
        }
        if (report.availability !== "available") {
            return `<details class="rule-report"><summary>Per-rule scores</summary><p>${escapeHtml(report.reason || "Per-rule scores unavailable.")}</p></details>`;
        }

        const weightNote = weightSemanticsText(report.weightSemantics, formatNumber);
        const scopeHtml = report.scopes.map(scope => {
            const rows = scope.rules.map(rule => {
                const origin = rule.origin && rule.origin !== "dsl"
                    ? ` <span class="rule-origin">(${escapeHtml(rule.origin.replaceAll("-", " "))})</span>`
                    : "";
                const hintText = dominanceHintText(rule, formatNumber);
                const hintRow = hintText
                    ? `<tr class="rule-dominance-hint"><td colspan="4"><strong>Why not?</strong> ${escapeHtml(hintText)}</td></tr>`
                    : "";
                const farSplitText = farPenaltyDecompositionText(rule, formatNumber);
                const farSplitRow = farSplitText
                    ? `<tr class="rule-report-note"><td colspan="4">${escapeHtml(farSplitText)}</td></tr>`
                    : "";
                return `<tr><td><code>${escapeHtml(rule.text)}</code>${origin}</td><td>${escapeHtml(verdictLabel(rule))}</td><td class="val">${formatNumber(rule.penalty)}</td><td class="val">${formatNumber(rule.percentOfTotal)}%</td></tr>${farSplitRow}${hintRow}`;
            }).join("");
            const body = rows || `<tr><td colspan="4">No scored spatial rules in this scope.</td></tr>`;
            const unreported = Math.abs(scope.unreportedTopologicalPenalty) > 1e-6
                ? `<p class="rule-report-note">Other topological terms: ${formatNumber(scope.unreportedTopologicalPenalty)}. These include non-rule settings such as <code>cwc</code>.</p>`
                : "";
            return `<h4>${escapeHtml(scope.path)} · total ${formatNumber(scope.totalCost)}</h4><div class="table-container"><table class="breakdown-table rule-report-table"><thead><tr><th>Rule</th><th>Satisfied?</th><th class="val">Penalty</th><th class="val">% total</th></tr></thead><tbody>${body}</tbody></table></div>${unreported}`;
        }).join("");
        return `<details class="rule-report"><summary>Per-rule scores</summary><p class="rule-report-note">Final normalized SA penalties. Percentages use each scope's total cost.</p>${weightNote ? `<p class="rule-report-note">${escapeHtml(weightNote)}</p>` : ""}${scopeHtml}</details>`;
    }

    function printRuleReport(report, logger = console) {
        if (!report) {
            return;
        }
        if (report.availability !== "available") {
            logger.info?.(`Per-rule scores unavailable: ${report.reason || "unknown reason"}`);
            return;
        }

        logger.groupCollapsed?.("Per-rule score report (final normalized SA cost)");
        const weightNote = weightSemanticsText(report.weightSemantics, value => String(value));
        if (weightNote) {
            logger.log?.(weightNote);
        }
        for (const scope of report.scopes) {
            logger.log?.(`${scope.path}: total ${scope.totalCost}`);
            logger.table?.(scope.rules.map(rule => ({
                id: rule.id,
                rule: rule.text,
                satisfied: verdictLabel(rule),
                penalty: rule.penalty,
                percentOfTotal: rule.percentOfTotal,
                irreducibleFarFloor: rule.farPenaltyDecomposition?.irreduciblePenalty,
                distanceReducibleFarPenalty: rule.farPenaltyDecomposition?.reduciblePenalty,
                origin: rule.origin,
                whyNot: dominanceHintText(rule, value => String(value)),
            })));
            if (Math.abs(scope.unreportedTopologicalPenalty) > 1e-6) {
                logger.log?.(`Other topological terms: ${scope.unreportedTopologicalPenalty}`);
            }
        }
        logger.groupEnd?.();
    }

    const api = { dominanceHintText, farPenaltyDecompositionText, printRuleReport, renderRuleReportHtml, verdictLabel, weightSemanticsText };
    Object.assign(root, api);
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
