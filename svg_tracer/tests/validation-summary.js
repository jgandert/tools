/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

export function compareCampaignResults(baseline, diagnostic) {
    if (baseline.metadata.coreSHA256 !== diagnostic.metadata.coreSHA256 || baseline.metadata.fixtureSHA256 !== diagnostic.metadata.fixtureSHA256) {
        throw Error("Baseline and diagnostic must use the same frozen core and source definitions.");
    }
    const normalize = row => {
        const result = structuredClone(row);
        delete result.diagnostics;
        delete result.cropFiles;
        delete result.svgFile;
        if (result.stats) delete result.stats.ms;
        return result;
    };
    const original = new Map(baseline.results.map(row => [`${row.fixtureId}/${row.noise}/${row.colorMode}`, normalize(row)]));
    const changed = diagnostic.results.flatMap(row => {
        const key = `${row.fixtureId}/${row.noise}/${row.colorMode}`;
        return isDeepStrictEqual(original.get(key), normalize(row)) ? [] : [key];
    });
    if (original.size !== diagnostic.results.length) changed.push("case count");
    return { compared: diagnostic.results.length, changed };
}

export function summarizeValidation(report) {
    const groups = new Map();
    for (const row of report.results) {
        if (row.status !== "ok" || !row.diagnostics) throw Error("Expected a successful --diagnose campaign report.");
        for (const probe of row.diagnostics.failedProbes) {
            const key = `${row.fixtureId}/${probe.name}`;
            const group = groups.get(key) || {
                fixture: row.fixtureId,
                probe: probe.name,
                cases: [],
            };
            const evidence = row.diagnostics.paintEvidence[probe.paintEvidenceIndex];
            group.cases.push({
                noise: row.noise,
                mode: row.colorMode,
                rgba: probe.decodedRGBA,
                coverage: probe.sourcePixelCoverage,
                allocatedOperationalLabels: evidence.operationalResultLabels,
                labels: [probe.nearestLabel, probe.correctedLabel, probe.finalLabel, probe.emittedResultLabel],
                native: probe.emittedNativeOwnership,
                localSourceCorePixels: probe.sourceComponent.corePixels,
                boundary: probe.localBoundary ? Object.fromEntries(["raw", "samples", "flat"].map(key => [key, probe.localBoundary.correspondence[key].matches.map(match => match.offset)])) : null,
            });
            groups.set(key, group);
        }
    }
    const normals = report.results.flatMap(row => row.diagnostics.normals);
    const stages = Object.fromEntries(["raw", "samples", "flat"].map(key => {
        const valid = normals.filter(normal => normal.available);
        const comparisons = valid.flatMap(normal => normal.correspondence[key].matches);
        return [key, {
            matches: comparisons.length,
            missing: valid.reduce((sum, normal) => sum + normal.correspondence[key].missing.length, 0),
            maxLocalOffset: comparisons.length ? Math.max(...comparisons.map(match => Math.abs(match.offset))) : null,
        }];
    }));
    return {
        round: report.metadata.round, coreSHA256: report.metadata.coreSHA256,
        failedProbes: [...groups.values()].reduce((sum, group) => sum + group.cases.length, 0),
        nativeLabelVsEmissionDifferences: report.results.flatMap(row => row.diagnostics.failedProbes).filter(probe => probe.finalLabel !== probe.emittedResultLabel).length,
        sourceNormals: {
            stations: normals.length,
            available: normals.filter(normal => normal.available).length,
            stages,
        },
        groups: [...groups.values()],
        fallbackChains: report.results.flatMap(row => row.diagnostics.fallbackChains.map(chain => ({
            fixture: row.fixtureId,
            noise: row.noise,
            mode: row.colorMode,
            id: chain.id,
            rawBox: chain.rawBox,
            reasons: [...new Set(chain.events.map(event => event.reason))],
            witnesses: [...new Set(chain.events.filter(event => event.point?.x !== undefined).map(event => `${event.point.x},${event.point.y}`))],
        }))),
    };
}

if (import.meta.main) {
    if (![3, 4].includes(process.argv.length)) throw Error("Usage: bun tests/validation-summary.js DIAGNOSTIC_REPORT.json [BASELINE_REPORT.json]");
    const report = JSON.parse(await readFile(process.argv[2], "utf8"));
    const summary = summarizeValidation(report);
    if (process.argv[3]) summary.baselineComparison = compareCampaignResults(JSON.parse(await readFile(process.argv[3], "utf8")), report);
    console.log(JSON.stringify(summary, null, 2));
}
