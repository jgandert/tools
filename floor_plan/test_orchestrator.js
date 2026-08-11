const fs = require("fs");
const { parseDSL } = require("./parser.js");
const { attachDominanceHints, optimizeParsed } = require("./orchestrator.js");
const { printRuleReport, renderRuleReportHtml } = require("./rule_report_ui.js");

let passed = 0;

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
    passed++;
}

async function main() {
    const defaultParsed = parseDSL(`
        seed 2
        k 1
        room a area=10000
        room b area=10000
        a far b
        inside a {
            room c area=5000
            room d area=5000
            c connect d required
            c far d required
        }
    `);
    const originalLog = console.log;
    console.log = () => {};
    const defaultResult = await optimizeParsed(defaultParsed);
    console.log = originalLog;
    assert(defaultResult.algo === "sa", "missing algo selects simulated annealing");
    assert(defaultResult.schemaVersion === 1, "default SA result carries schema version");
    assert(Array.isArray(defaultResult.unsatisfied), "SA result carries required-rule verdicts");
    assert(defaultResult.rooms.every(room => !room.parts), "default result keeps rectangular room schema");
    assert(defaultResult.ruleReport.availability === "available", "SA result carries an available per-rule score report");
    assert(defaultResult.ruleReport.metric === "sa-normalized-delivered-cost", "SA report names normalized delivered metric");
    assert(defaultResult.ruleReport.scopes.map(scope => scope.path).join("|") === "top|top / a", "SA report flattens recursive scope paths");
    const topScope = defaultResult.ruleReport.scopes[0];
    const innerScope = defaultResult.ruleReport.scopes[1];
    assert(topScope.totalCost === defaultResult.cost, "top rule percentages use final top-level cost");
    assert(innerScope.totalCost === defaultResult.rooms.find(room => room.id === "a").inside.cost, "inner rule percentages use final inner cost");
    assert(topScope.rules[0].text === "a far b", "top report preserves named canonical rule text");
    assert(innerScope.rules[0].id.startsWith("top / a::"), "recursive rule identity includes scope path");
    const innerRequiredFar = innerScope.rules.find(rule => rule.type === "far");
    assert(topScope.rules[0].farPenaltyDecomposition === undefined, "advisory far report does not invent an irreducible floor");
    assert(innerRequiredFar.farPenaltyDecomposition?.irreduciblePenalty > 0
        && Math.abs(innerRequiredFar.farPenaltyDecomposition.irreduciblePenalty
            + innerRequiredFar.farPenaltyDecomposition.reduciblePenalty - innerRequiredFar.penalty) < 1e-9,
        "recursive required far report carries an exact additive floor split");
    assert(innerRequiredFar.satisfied === null, "recursive connect/far conflict exemption retains required far split");
    assert(defaultResult.ruleReport.dominanceHintBasis === "shared-room-current-penalty-magnitude-correlation", "SA report labels dominance hints as magnitude correlations");
    assert(defaultResult.ruleReport.weightSemantics.example.rawWeight === 5
        && Math.abs(defaultResult.ruleReport.weightSemantics.example.compressedTargetWeight - (1 + Math.log2(5))) < 1e-12,
        "SA report publishes raw and compressed weight=5 semantics separately");

    const hintedRules = attachDominanceHints([
        { id: "rule:0:0", text: "bed connect bath", participants: ["bed", "bath"], required: false, satisfied: false, penalty: 5, percentOfTotal: 5 },
        { id: "rule:0:1", text: "bed at north", participants: ["bed"], required: false, satisfied: false, penalty: 12, percentOfTotal: 12 },
        { id: "rule:1:0", text: "bath close hall required", participants: ["bath", "hall"], required: true, satisfied: false, penalty: 20, percentOfTotal: 20 },
        { id: "rule:2:0", text: "office enclosed", participants: ["office"], required: false, satisfied: false, penalty: 100, percentOfTotal: 100 },
        { id: "rule:0:2", text: "bath at west", participants: ["bath"], required: false, satisfied: true, penalty: 4, percentOfTotal: 4 },
    ], "top / suite");
    const unsatisfiedConnect = hintedRules[0];
    const noDominator = hintedRules[3];
    assert(unsatisfiedConnect.dominanceHints.map(hint => hint.text).join("|") === "bath close hall required|bed at north", "dominance hints rank only larger same-room penalties by magnitude");
    assert(unsatisfiedConnect.dominanceHints[0].ruleId === "top / suite::rule:1:0" && unsatisfiedConnect.dominanceHints[0].scopePath === "top / suite", "dominance hints carry stable scoped rule identity and path");
    assert(unsatisfiedConnect.dominanceHints[0].penalty === 20 && unsatisfiedConnect.dominanceHints[0].penaltyDifference === 15, "dominance hints quantify candidate and penalty difference");
    assert(unsatisfiedConnect.dominanceHints.every(hint => hint.kind === "penalty-magnitude-correlation" && hint.counterfactualComputed === false), "dominance hints explicitly reject a causal counterfactual interpretation");
    assert(noDominator.dominanceHints.length === 0, "unsatisfied advisory rules expose an empty hint list when no larger same-room penalty exists");
    assert(hintedRules[1].dominanceHints?.length === 0 && hintedRules[2].dominanceHints === undefined && hintedRules[4].dominanceHints === undefined, "hints exist only on unsatisfied advisory rules");

    const gridParsed = parseDSL(`
        algo grid
        seed 2
        room a area=10000
        room b area=10000
        a connect b required
    `);
    const grid = await optimizeParsed(gridParsed);
    assert(grid.algo === "grid", "algo grid selects grid");
    assert(grid.schemaVersion === 1, "grid result carries schema version");
    assert(grid.geometry === "grid", "grid result carries geometry marker");
    assert(grid.rooms.length === 2, "grid adapter returns both rooms");
    assert(grid.rooms.every(room => room.parts.length > 0), "grid rooms contain renderable parts");
    assert(grid.unsatisfied.length === 0, "grid required connection is satisfied");
    assert(grid.ruleReport.availability === "unavailable", "grid avoids inventing per-rule refinement penalties");
    assert(grid.ruleReport.dominanceHintBasis === undefined, "grid avoids inventing dominance hints");
    assert(grid.ruleReport.farPenaltyDecomposition === undefined && grid.ruleReport.scopes.length === 0,
        "grid avoids inventing required far floor decomposition");
    assert(grid.ruleReport.reason.includes("Unsupported grid semantics"), "grid report explains unsupported semantics remain warnings");

    const saParsed = parseDSL(`
        algo sa
        seed 2
        k 1
        room a area=10000
        room b area=10000
    `);
    console.log = () => {};
    const sa = await optimizeParsed(saParsed);
    console.log = originalLog;
    assert(sa.algo === "sa", "algo sa selects simulated annealing");
    assert(sa.schemaVersion === 1, "SA result carries schema version");
    assert(sa.rooms.length === 2, "SA result returns both rooms");
    assert(sa.rooms.every(room => !room.parts), "SA result keeps rectangular room schema");

    const warningParsed = parseDSL(`
        algo sa
        seed 2
        k 1
        canvas 100x100
        room A area=6000
        room B area=5000
    `);
    console.log = () => {};
    const warningResult = await optimizeParsed(warningParsed);
    console.log = originalLog;
    const feasibilityWarnings = warningResult.warnings.filter(warning => warning.includes("[FEASIBILITY_AREA_OVERFLOW]"));
    assert(feasibilityWarnings.length === 1 && feasibilityWarnings[0] === warningParsed.warnings[0],
        "optimizeParsed preserves each parser feasibility warning exactly once");

    const browserHtml = fs.readFileSync("index.html", "utf8");
    assert(browserHtml.includes("showParseMessages(errors, warnings)")
        && browserHtml.includes("showParseMessages([], result.warnings || warnings)"),
    "browser displays parser warnings before optimization and propagated result warnings after optimization");
    assert(browserHtml.includes("showParseMessages([], _DEFAULT_CACHE.result.warnings || [])"),
        "browser displays cached default-result warnings on initial load");

    const nestedParsed = parseDSL(`
        algo grid
        seed 3
        room shell area=30000
        room other area=10000
        inside shell {
            room sub area=20000
            room sibling area=10000
            inside sub {
                room leaf_a area=10000
                room leaf_b area=10000
            }
        }
    `);
    const nested = await optimizeParsed(nestedParsed);
    const names = new Set(nested.rooms.map(room => room.name));
    assert(names.has("shell / sub / leaf_a"), "grid resolves second-level inside leaf A");
    assert(names.has("shell / sub / leaf_b"), "grid resolves second-level inside leaf B");
    assert(!names.has("shell / sub"), "resolved grid parent is replaced by leaves");

    const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const reportHtml = renderRuleReportHtml(defaultResult.ruleReport, escapeHtml, value => value.toFixed(2));
    assert(reportHtml.includes("Per-rule scores") && reportHtml.includes("a far b"), "UI renderer exposes named SA rules");
    assert(reportHtml.includes("Penalty") && reportHtml.includes("% total"), "UI renderer labels score columns");
    assert(reportHtml.includes("Weight warning") && reportHtml.includes("weight=5")
        && reportHtml.includes("target 3.32") && reportHtml.includes("start 1.02"),
        "UI renderer visibly explains compressed and temperature-ramped weight=5 behavior");
    assert(reportHtml.includes("Required far penalty split:") && reportHtml.includes("irreducible floor")
        && reportHtml.includes("scope canvas diagonal"),
        "UI renderer discloses recursive required far floor and its distance bound");
    const hintedReport = {
        availability: "available",
        scopes: [{ path: "top / suite", totalCost: 100, unreportedTopologicalPenalty: 0, rules: hintedRules }],
    };
    const hintedHtml = renderRuleReportHtml(hintedReport, escapeHtml, value => value.toFixed(2));
    assert(hintedHtml.includes("Why not?") && hintedHtml.includes("bath close hall required") && hintedHtml.includes("20.00 vs 5.00 (+15.00)"), "UI renders named magnitude hints with numbers");
    assert(hintedHtml.includes("not a causal counterfactual") && hintedHtml.includes("no larger same-room rule penalty found"), "UI labels correlation limits and empty hint behavior");
    const gridHtml = renderRuleReportHtml(grid.ruleReport, escapeHtml, value => value.toFixed(2));
    assert(gridHtml.includes("does not expose stable per-rule penalty terms"), "UI renderer explains grid report unavailability");
    assert(!gridHtml.includes("irreducible floor"), "grid UI never claims a far floor");

    const consoleCalls = { tables: [], lines: [] };
    printRuleReport(defaultResult.ruleReport, {
        groupCollapsed: line => consoleCalls.lines.push(line),
        log: line => consoleCalls.lines.push(line),
        table: rows => consoleCalls.tables.push(rows),
        groupEnd: () => {},
    });
    assert(consoleCalls.tables.length === 2, "console renderer prints one table per recursive SA scope");
    assert(consoleCalls.tables[0][0].rule === "a far b", "console table exposes named rule values");
    const innerFarConsoleRow = consoleCalls.tables[1].find(row => row.rule === "c far d required");
    assert(innerFarConsoleRow.irreducibleFarFloor > 0
        && innerFarConsoleRow.distanceReducibleFarPenalty >= 0,
        "console table separates recursive required far floor from distance-reducible penalty");
    assert(consoleCalls.lines.some(line => line.includes("Weight warning") && line.includes("weight=5")),
        "console report visibly explains advisory weight semantics");
    const hintedConsoleCalls = { tables: [] };
    printRuleReport(hintedReport, {
        groupCollapsed: () => {},
        log: () => {},
        table: rows => hintedConsoleCalls.tables.push(rows),
        groupEnd: () => {},
    });
    assert(hintedConsoleCalls.tables[0][0].whyNot.includes("bath close hall required") && hintedConsoleCalls.tables[0][0].whyNot.includes("20 vs 5 (+15)"), "console prints named magnitude hints with numbers");

    const html = fs.readFileSync("index.html", "utf8");
    const cacheMatch = html.match(/<script id="default-result-cache" type="application\/json">([\s\S]*?)<\/script>/);
    const cached = JSON.parse(cacheMatch[1]);
    assert(cached.result.ruleReport.availability === "available", "embedded default cache carries per-rule scores");
    assert(cached.result.ruleReport.dominanceHintBasis === "shared-room-current-penalty-magnitude-correlation", "embedded default cache carries dominance-hint semantics");
    assert(cached.result.ruleReport.weightSemantics?.mode === "compressed-target-temperature-ramp",
        "embedded default cache carries advisory weight semantics");
    const cachedHintedRule = cached.result.ruleReport.scopes.flatMap(scope => scope.rules).find(rule => rule.dominanceHints?.length);
    assert(cachedHintedRule?.dominanceHints[0].ruleId.includes("::"), "embedded default cache carries a scoped named dominance hint");
    assert(html.includes('<script src="rule_report_ui.js"></script>'), "browser loads per-rule UI renderer");

    console.log(`RESULTS: ${passed} passed, 0 failed`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
