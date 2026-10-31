/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

export function summarizeNormals(normals) {
    const result = {};
    for (const key of ["labels", "raw", "samples", "flat", "emitted"]) {
        if (!normals.every(normal => normal[key])) continue;
        const offsets = [];
        let missing = 0;
        let extra = 0;
        for (const normal of normals) {
            const available = new Set(normal[key].map((_, i) => i));
            for (const source of normal.source) {
                const candidates = [...available].filter(i => {
                    const hit = normal[key][i];
                    return hit.paints ? hit.paints.includes(source.from) && hit.paints.includes(source.to)
                        : hit.from === source.from && hit.to === source.to;
                });
                if (!candidates.length) {
                    missing++;
                    continue;
                }
                const index = candidates.reduce((a, b) => Math.abs(normal[key][a].at - source.at) < Math.abs(normal[key][b].at - source.at) ? a : b);
                available.delete(index);
                offsets.push(Math.abs(normal[key][index].at - source.at));
            }
            extra += available.size;
        }
        result[key] = {
            matched: offsets.length,
            missing,
            extra,
            meanPx: offsets.length ? offsets.reduce((s, x) => s + x, 0) / offsets.length : null,
            maxPx: offsets.length ? Math.max(...offsets) : null,
        };
    }
    const gaps = normals.flatMap(normal => {
        const start = normal.source.find(hit => hit.from === 1 && hit.to === 0);
        const end = normal.source.find(hit => hit.from === 0 && hit.to === 2 && hit.at > (start?.at ?? Infinity));
        if (!start || !end || end.at - start.at > 1.25) return [];
        const actualGaps = key => {
            const list = normal[key] || [];
            const entries = list.filter(hit => hit.paints ? hit.paints.includes(1) && hit.paints.includes(0) : hit.from === 1 && hit.to === 0);
            const exits = list.filter(hit => hit.paints ? hit.paints.includes(0) && hit.paints.includes(2) : hit.from === 0 && hit.to === 2);
            return entries.flatMap(a => exits.filter(b => b.at > a.at && Math.min(end.at, b.at) > Math.max(start.at, a.at)).map(b => ({
                entry: a.at,
                exit: b.at,
            })));
        };
        return [{
            origin: normal.origin, width: end.at - start.at,
            ...Object.fromEntries(["labels", "raw", "samples", "flat", "emitted"].filter(key => normal[key]).map(key => [key, normal.gapCoverage?.[key] || actualGaps(key)])),
        }];
    });
    result.separator = {
        sourceStations: gaps.length,
        ...Object.fromEntries(["labels", "raw", "samples", "flat", "emitted"].filter(key => normals.every(normal => normal[key])).map(key => [key, {
            missingLocal: gaps.filter(gap => !gap[key].length).length,
            widestLostPx: Math.max(0, ...gaps.filter(gap => !gap[key].length).map(gap => gap.width)),
        }])),
    };
    return result;
}

if (import.meta.main) {
    const report = await Bun.file(process.argv[2]).json();
    console.log(JSON.stringify({
        procedural: report.procedural.map(record => ({
            id: record.id,
            noise: record.noise,
            summary: summarizeNormals(record.normals),
        })),
        controls: report.controls.map(record => ({
            id: record.id,
            colorMode: record.colorMode,
            noise: record.noise,
            fallbackChains: record.fallbackChains,
            regions: record.regions,
            missingIntendedPaints: record.missingIntendedPaints,
            remoteIntrusionPixels: record.remoteIntrusionPixels,
            localSeamIntrusionPixels: record.localSeamIntrusionPixels,
            centerAlpha: record.centerAlpha,
            summary: summarizeNormals(record.normals),
        })),
    }, null, 2));
}
