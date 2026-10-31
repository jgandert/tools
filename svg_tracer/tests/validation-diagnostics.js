/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
import {createSpiralDiagnostics} from "./spiral-diagnostics.js";
import {createDarkBoundaryDiagnostics} from "./dark-boundary-diagnostics.js";

// Instrument only the study's in-memory copy. The ordinary campaign run is an
// independent output-equivalence check, and production does not expose stages.
export function instrumentValidationCore(core) {
    const replace = (before, after) => {
        if (core.split(before).length !== 2) throw Error(`Diagnostic hook is not unique: ${before}`);
        core = core.replace(before, after);
    };
    replace("const sourceAliases=[];", "globalThis.validationStages.initialPalette=palette.map(p=>p.hex);globalThis.validationStages.sampleWeights=Array.from({length:n},(_,p)=>opaque[p]?sampleWeight(p):0);globalThis.validationStages.initialLabels=Array.from({length:n},(_,p)=>{if(!opaque[p])return -1;const v=lab(rgb[3*p],rgb[3*p+1],rgb[3*p+2]);let best=Infinity,index=0;palette.forEach((paint,i)=>{const d=cd(v,paint.lab);if(d<best){best=d;index=i;}});return index;});const sourceAliases=[];");
    replace("const modes=palette.map(()=>null);", "globalThis.validationStages.recoveryBins=[...bins.values()].map(bin=>({rgb:bin.s.map(v=>Math.round(v/bin.count)),count:bin.count,core:bin.core,footprintSupport:bin.footprintSupport,alphaSupport:bin.alphaSupport,eligible:bin.core>=1&&bin.count>=6||bin.count>=18}));globalThis.validationStages.recoveryAdmissions=[];const modes=palette.map(()=>null);");
    replace("if(palette.length>=32)break;", "const diagnosticAdmission={rgb:bin.s.map(v=>Math.round(v/bin.count)),count:bin.count,core:bin.core,footprintSupport:bin.footprintSupport,alphaSupport:bin.alphaSupport};globalThis.validationStages.recoveryAdmissions.push(diagnosticAdmission);if(palette.length>=32){diagnosticAdmission.reason='palette cap';break;}");
    replace("if(bin.footprintSupport<6&&bin.alphaSupport<6)continue;", "if(bin.footprintSupport<6&&bin.alphaSupport<6){diagnosticAdmission.reason='footprint and alpha support';continue;}");
    replace("if(palette.some(p=>cd(p.lab,v)<minSeparation||rgb.every((value,channel)=>Math.abs(value-p.rgb[channel])<=nearPaint)))continue;", "diagnosticAdmission.minimumLabSeparation=Math.min(...palette.map(p=>cd(p.lab,v)));if(palette.some(p=>cd(p.lab,v)<minSeparation||rgb.every((value,channel)=>Math.abs(value-p.rgb[channel])<=nearPaint))){diagnosticAdmission.reason='paint separation';continue;}");
    replace("if(residual<3*sq(Math.max(7,noise))&&bin.core<4)continue;", "diagnosticAdmission.residual=residual;if(residual<3*sq(Math.max(7,noise))&&bin.core<4){diagnosticAdmission.reason='mixture residual with fewer than four core samples';continue;}");
    replace("if(bin.core<1&&residual<3*sq(Math.max(14,noise*2.5)))continue;", "if(bin.core<1&&residual<3*sq(Math.max(14,noise*2.5))){diagnosticAdmission.reason='coreless mixture residual';continue;}");
    replace("palette.push({rgb,lab:lab(...rgb),hex:hex(rgb)});", "diagnosticAdmission.reason='admitted';diagnosticAdmission.index=palette.length;palette.push({rgb,lab:lab(...rgb),hex:hex(rgb)});");
    replace("for(let i=0;i<palette.length;i++)if(modes[i]) {", "globalThis.validationStages.modeUpdates=modes.flatMap((mode,i)=>mode?[{index:i,before:palette[i].hex,rgb:mode.rgb,score:mode.score}]:[]);for(let i=0;i<palette.length;i++)if(modes[i]) {");
    replace("const correction=resolveMixtures(rgb,opaque,labels,palette,w,h,noise);", "globalThis.validationStages.nearestLabels=Array.from(labels);globalThis.validationStages.recoveredPalette=palette.map(p=>p.hex);const correction=resolveMixtures(rgb,opaque,labels,palette,w,h,noise);");
    replace("const folded=foldSourceAliases", "globalThis.validationStages.correctedLabels=Array.from(labels);const folded=foldSourceAliases");
    replace("const started=Date.now();", "globalThis.validationStages={events:[]};const started=Date.now();");
    replace("progress('Separating regions and removing small speckles');", "globalThis.validationStages.preparedRGB=Array.from(rgb);progress('Separating regions and removing small speckles');");
    replace("const mark=(a,b)=>{bad.add(a);if(b!==undefined)bad.add(b);};", "const mark=(a,b,reason='unclassified',point=null)=>{bad.add(a);if(b!==undefined)bad.add(b);globalThis.validationStages.events.push({reason,point,chains:[a,...(b===undefined?[]:[b])],states:[a,...(b===undefined?[]:[b])].map(id=>({id,retry:g.chains[id].retry,tolerance:g.chains[id].fitTolerance,exact:!!g.chains[id].exact}))});};");
    replace("))mark(c.id);", "))mark(c.id,undefined,'bounds');");
    replace("if(segmentConflict(a,b,t.a,t.b,allowed))mark(c.id,t.c);", "if(segmentConflict(a,b,t.a,t.b,allowed))mark(c.id,t.c,'intersection',{a,b,c:t.a,d:t.b});");
    replace("mark(c.id,t.c);\n              uncertain", "mark(c.id,t.c,'flattening uncertainty',{a,b,c:t.a,d:t.b});\n              uncertain");
    replace("if(!q){mark(c.id);continue;}", "if(!q){mark(c.id,undefined,'collapsed junction');continue;}");
    replace("entries.forEach(e=>mark(e.id));", "entries.forEach(e=>mark(e.id,undefined,'junction order'));");
    replace("if(signed<=1e-8)g.loops[f.id].flat().forEach(h=>mark(h>>1));", "if(signed<=1e-8)g.loops[f.id].flat().forEach(h=>mark(h>>1,undefined,'face area',f.witness));");
    replace("if(inside(p,swept)){mark(c.id);localized=true;}", "if(inside(p,swept)){mark(c.id,undefined,'witness swept band',p);localized=true;}");
    replace("if(!localized)g.loops[id][j].forEach(h=>mark(h>>1));", "if(!localized)g.loops[id][j].forEach(h=>mark(h>>1,undefined,'witness loop',p));");
    replace("if(!found)g.loops[f.id].flat().forEach(h=>mark(h>>1));", "if(!found)g.loops[f.id].flat().forEach(h=>mark(h>>1,undefined,'witness face',p));");
    return core;
}

export function createValidationDiagnostics(intersections, dark) {
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const histogram = values => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    const labelAt = (labels, width, height) => (x, y) => x < 0 || y < 0 || x >= width || y >= height ? -1 : labels[Math.floor(y) * width + Math.floor(x)];

    function coverageMasks(fixture, ownerAt) {
        const masks = Object.keys(fixture.paints).map(() => []);
        for (let y = 0; y < fixture.height; y++) for (let x = 0; x < fixture.width; x++) {
            const counts = new Map();
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
                const owner = ownerAt(x + (dx + .5) / 4, y + (dy + .5) / 4);
                if (owner >= 0) counts.set(owner, (counts.get(owner) || 0) + 1);
            }
            for (const [owner, count] of counts) masks[owner].push({pixel: y * fixture.width + x, coverage: count / 16});
        }
        return masks;
    }

    function sourceNormal(ownerAt, origin, from, to, ray) {
        let low = -.13;
        let high = .13;
        const query = t => ownerAt(origin.x + ray.x * t, origin.y + ray.y * t);
        if (query(low) !== from || query(high) !== to) return {available: false, reason: "No isolated source crossing in original sample bracket"};
        for (let i = 0; i < 24; i++) {
            const mid = (low + high) / 2;
            if (query(mid) === from) low = mid;
            else high = mid;
        }
        const center = {x: origin.x + ray.x * (low + high) / 2, y: origin.y + ray.y * (low + high) / 2};
        const radius = .1;
        const circleOwner = angle => ownerAt(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle));
        const angles = [];
        let previous = circleOwner(0);
        for (let i = 1; i <= 128; i++) {
            const angle = i * Math.PI * 2 / 128;
            const next = circleOwner(angle);
            if (![from, to].includes(next)) return {available: false, center, reason: "Third paint at source station"};
            if (next !== previous) {
                let a = angle - Math.PI * 2 / 128;
                let b = angle;
                for (let j = 0; j < 20; j++) {
                    const mid = (a + b) / 2;
                    if (circleOwner(mid) === previous) a = mid;
                    else b = mid;
                }
                angles.push((a + b) / 2);
            }
            previous = next;
        }
        if (angles.length !== 2) return {available: false, center, reason: "Source tangent is not isolated"};
        const tangent = {x: Math.cos(angles[0]) - Math.cos(angles[1]), y: Math.sin(angles[0]) - Math.sin(angles[1])};
        const length = Math.hypot(tangent.x, tangent.y);
        let normal = {x: -tangent.y / length, y: tangent.x / length};
        if (ownerAt(center.x + .02 * normal.x, center.y + .02 * normal.y) !== to) normal = {x: -normal.x, y: -normal.y};
        return {available: true, origin: center, normal};
    }

    function localCorrespondence(source, candidates, radius = 3) {
        const available = new Set(candidates.map((_, i) => i));
        const matches = [];
        const missing = [];
        for (const expected of source) {
            const pair = [expected.from, expected.to].sort((a, b) => a - b);
            const choices = [...available].filter(i => Math.abs(candidates[i].at - expected.at) <= radius &&
                (candidates[i].from === undefined
                    ? JSON.stringify([...candidates[i].paints].sort((a, b) => a - b)) === JSON.stringify(pair)
                    : candidates[i].from === expected.from && candidates[i].to === expected.to));
            if (!choices.length) {
                missing.push(expected);
                continue;
            }
            const index = choices.reduce((a, b) => Math.abs(candidates[a].at - expected.at) < Math.abs(candidates[b].at - expected.at) ? a : b);
            available.delete(index);
            matches.push({source: expected, candidate: candidates[index], offset: candidates[index].at - expected.at});
        }
        return {matches, missing, extra: [...available].map(i => candidates[i])};
    }

    function stageCrossings(debug, mapping, origin, normal, key) {
        const hits = dark.chainHits(debug, origin, normal, key).map(candidate => ({...candidate, resultLabels: candidate.paints, paints: candidate.paints.map(paint => paint < 0 ? -1 : mapping[paint])}));
        const faces = debug.faces.map(face => ({paint: face.color < 0 ? -1 : mapping[face.color],
            intervals: intersections.intervals(origin, normal, debug.loops[face.id].flat().map(he => debug.chains[he >> 1][key]), face.id)}));
        const stops = [...new Set([-3.0001, 3.0001, ...hits.map(hit => hit.at)])].sort((a, b) => a - b);
        const owner = at => {
            const owners = faces.filter(face => face.intervals.some(interval => at > interval.entry && at < interval.exit)).map(face => face.paint);
            return owners.length === 1 ? owners[0] : owners.length ? -3 : -1;
        };
        return hits.map(hit => {
            const index = stops.indexOf(hit.at);
            return {...hit, from: owner((stops[index - 1] + hit.at) / 2), to: owner((stops[index + 1] + hit.at) / 2)};
        });
    }

    function probeOwnership(label, mapping, palette, intendedRGB) {
        const nativeRGB = label < 0 ? null : rgb(palette[label]);
        return {nativeLabel: label, nativeRGB, operationalOwner: label < 0 ? -1 : mapping[label],
            distanceFromIntendedRGB: nativeRGB ? Math.hypot(...nativeRGB.map((value, channel) => value - intendedRGB[channel])) : null};
    }

    function diagnose({fixture, paths, input, traced, stages, masks, contour, probes, outputAt, nativeOutputAt, operationalMapping}) {
        const {width, height} = fixture;
        const paints = Object.keys(fixture.paints);
        const pixelLabels = labelAt(traced.debug.labels, width, height);
        const operationalLabels = labelAt(traced.debug.labels.map(label => label < 0 ? -1 : operationalMapping[label]), width, height);
        const nativeLabelStages = (origin, normal) => Object.fromEntries([["initial", stages.initialLabels], ["nearest", stages.nearestLabels], ["corrected", stages.correctedLabels], ["final", traced.debug.labels]]
            .map(([key, labels]) => [key, dark.transitions(labelAt(labels, width, height), origin, normal, 3, 1 / 256)]));
        const paintEvidence = masks.map((mask, owner) => {
            const majority = mask.filter(p => p.coverage >= .5);
            const core = mask.filter(p => p.coverage >= .9);
            const paletteDistances = palette => palette.map((color, index) => ({index, color, distance: Math.hypot(...rgb(color).map((c, channel) => c - rgb(fixture.paints[paints[owner]])[channel]))})).sort((a, b) => a.distance - b.distance);
            return {paint: paints[owner], intendedRGB: rgb(fixture.paints[paints[owner]]), coveredPixels: mask.length, majorityPixels: majority.length, corePixels: core.length,
                decodedCore: (() => {
                    const values = core.map(({pixel}) => Array.from(input.data.slice(4 * pixel, 4 * pixel + 4)));
                    return {count: values.length, min: [0, 1, 2, 3].map(c => values.reduce((value, rgba) => Math.min(value, rgba[c]), 255)),
                        max: [0, 1, 2, 3].map(c => values.reduce((value, rgba) => Math.max(value, rgba[c]), 0)),
                        mean: [0, 1, 2, 3].map(c => values.reduce((value, rgba) => value + rgba[c], 0) / values.length), samples: values.slice(0, 16)};
                })(),
                paletteDistances: {initial: paletteDistances(stages.initialPalette), recovered: paletteDistances(stages.recoveredPalette), final: paletteDistances(traced.stats.palette)},
                sampleWeight: {majority: majority.reduce((sum, {pixel}) => sum + stages.sampleWeights[pixel], 0), core: core.reduce((sum, {pixel}) => sum + stages.sampleWeights[pixel], 0)},
                recoveryBins: stages.recoveryBins.map(bin => ({...bin, distance: Math.hypot(...bin.rgb.map((c, channel) => c - rgb(fixture.paints[paints[owner]])[channel]))})).sort((a, b) => a.distance - b.distance).slice(0, 8),
                admissions: stages.recoveryAdmissions.map(bin => ({...bin, distance: Math.hypot(...bin.rgb.map((c, channel) => c - rgb(fixture.paints[paints[owner]])[channel]))})).sort((a, b) => a.distance - b.distance).slice(0, 8),
                stageLabels: Object.fromEntries([["initial", stages.initialLabels], ["nearest", stages.nearestLabels], ["corrected", stages.correctedLabels], ["final", traced.debug.labels]].map(([key, labels]) => [key, {majority: histogram(majority.map(({pixel}) => labels[pixel])), core: histogram(core.map(({pixel}) => labels[pixel]))}])),
                operationalResultLabels: operationalMapping.flatMap((target, index) => target === owner ? [index] : []),
            };
        });
        const failedProbes = probes.results.filter(probe => !probe.pass).map(probe => {
            const original = fixture.probes.find(p => p.name === probe.name);
            const owner = paths.paintIndex.get(original.paint);
            const pixel = Math.floor(original.y) * width + Math.floor(original.x);
            const localMask = new Map(masks[owner].map(item => [item.pixel, item]));
            const originalMask = new Map(localMask);
            const connected = [];
            const queue = localMask.has(pixel) ? [pixel] : [];
            localMask.delete(pixel);
            while (queue.length) {
                const next = queue.pop();
                connected.push(originalMask.get(next));
                for (const neighbor of [next % width ? next - 1 : -1, next % width + 1 < width ? next + 1 : -1, next - width, next + width]) {
                    if (!localMask.has(neighbor)) continue;
                    queue.push(neighbor);
                    localMask.delete(neighbor);
                }
            }
            const sourceComponent = {
                coveredPixels: connected.length, majorityPixels: connected.filter(item => item.coverage >= .5).length,
                corePixels: connected.filter(item => item.coverage >= .9).length,
                pixels: connected.slice(0, 256).map(({pixel, coverage}) => ({x: pixel % width, y: Math.floor(pixel / width), coverage,
                    rgba: Array.from(input.data.slice(4 * pixel, 4 * pixel + 4)), preparedRGB: stages.preparedRGB.slice(3 * pixel, 3 * pixel + 3),
                    nearestLabel: stages.nearestLabels[pixel], correctedLabel: stages.correctedLabels[pixel], finalLabel: traced.debug.labels[pixel]})),
            };
            const probeStations = [];
            for (let direction = 0; direction < 32; direction++) {
                const angle = direction * Math.PI * 2 / 32;
                const ray = {x: Math.cos(angle), y: Math.sin(angle)};
                for (let at = 1 / 32; at <= 4; at += 1 / 32) {
                    const to = paths.ownerAt(original.x + ray.x * at, original.y + ray.y * at);
                    if (to === owner) continue;
                    let low = at - 1 / 32;
                    let high = at;
                    for (let j = 0; j < 20; j++) {
                        const mid = (low + high) / 2;
                        if (paths.ownerAt(original.x + ray.x * mid, original.y + ray.y * mid) === owner) low = mid;
                        else high = mid;
                    }
                    const boundary = {x: original.x + ray.x * (low + high) / 2, y: original.y + ray.y * (low + high) / 2};
                    probeStations.push({distance: (low + high) / 2, ...sourceNormal(paths.ownerAt, boundary, owner, to, ray)});
                    break;
                }
            }
            const probeNormal = probeStations.sort((a, b) => a.distance - b.distance).find(station => station.available);
            let localBoundary = null;
            if (probeNormal) {
                const {origin, normal} = probeNormal;
                const source = dark.transitions(paths.ownerAt, origin, normal, 3, 1 / 256);
                const stages = Object.fromEntries(["raw", "samples", "flat"].map(key => [key, stageCrossings(traced.debug, operationalMapping, origin, normal, key)]));
                localBoundary = {...probeNormal, source, nativeLabelStages: nativeLabelStages(origin, normal), labels: dark.transitions(operationalLabels, origin, normal, 3, 1 / 256),
                    ...stages, correspondence: Object.fromEntries(Object.entries(stages).map(([key, hits]) => [key, localCorrespondence(source, hits)])),
                    emitted: dark.transitions(outputAt, origin, normal, 3, 1 / 256)};
            }
            return {...probe, sourceComponent, localBoundary, x: original.x, y: original.y, intendedPaint: original.paint, intendedRGB: rgb(fixture.paints[original.paint]),
                decodedRGBA: Array.from(input.data.slice(4 * pixel, 4 * pixel + 4)), preparedRGB: stages.preparedRGB.slice(3 * pixel, 3 * pixel + 3),
                sourcePixelCoverage: masks[owner].find(p => p.pixel === pixel)?.coverage || 0,
                emittedNativeOwnership: probeOwnership(nativeOutputAt(original.x, original.y), operationalMapping, traced.stats.palette, rgb(fixture.paints[original.paint])),
                nearestLabel: stages.nearestLabels[pixel], correctedLabel: stages.correctedLabels[pixel], finalLabel: pixelLabels(original.x, original.y), component: traced.debug.componentIds[pixel],
                operationalLabelOwner: operationalLabels(original.x, original.y), emittedResultLabel: nativeOutputAt(original.x, original.y), emittedOperationalOwner: outputAt(original.x, original.y),
                paintEvidenceIndex: owner};
        });
        const normals = contour.lines.flatMap(line => {
            const expected = [...line.matched.map(hit => ({...hit.expected, originalMatch: hit})), ...line.unmatchedExpected];
            return expected.map(hit => {
                const point = line.axis === "h" ? {x: hit.at, y: line.at} : {x: line.at, y: hit.at};
                const station = sourceNormal(paths.ownerAt, point, hit.from, hit.to, line.axis === "h" ? {x: 1, y: 0} : {x: 0, y: 1});
                if (!station.available) return {line: {axis: line.axis, at: line.at}, original: hit, ...station};
                const {origin, normal} = station;
                const source = dark.transitions(paths.ownerAt, origin, normal, 3, 1 / 256);
                const chainStages = Object.fromEntries(["raw", "samples", "flat"].map(key => [key, stageCrossings(traced.debug, operationalMapping, origin, normal, key)]));
                const stops = [...new Set([-3, 3, ...chainStages.flat.map(candidate => candidate.at), ...source.map(candidate => candidate.at)])].sort((a, b) => a - b);
                const emittedMidpoints = stops.slice(1).map((end, i) => {
                    const start = stops[i];
                    const at = (start + end) / 2;
                    return {start, end, at, sourceOwner: paths.ownerAt(origin.x + at * normal.x, origin.y + at * normal.y), emittedResultLabel: nativeOutputAt(origin.x + at * normal.x, origin.y + at * normal.y), emittedOwner: outputAt(origin.x + at * normal.x, origin.y + at * normal.y)};
                }).filter(interval => interval.end - interval.start > 1e-8);
                return {line: {axis: line.axis, at: line.at}, original: hit, ...station, source, nativeLabelStages: nativeLabelStages(origin, normal),
                    labels: dark.transitions(operationalLabels, origin, normal, 3, 1 / 256),
                    ...chainStages, correspondence: Object.fromEntries(Object.entries(chainStages).map(([key, candidates]) => [key, localCorrespondence(source, candidates)])),
                    emitted: dark.transitions(outputAt, origin, normal, 3, 1 / 256), emittedMidpoints};
            });
        });
        const fallbackChains = traced.debug.chains.filter(chain => chain.exact).map(chain => ({...chain, rawBox: dark.bounds(chain.raw), sampleBox: dark.bounds(chain.samples),
            faces: [chain.left, chain.right].filter(id => id >= 0).map(id => traced.debug.faces[id]),
            events: stages.events.filter(event => event.chains.includes(chain.id)),
            nearbySourcePixels: (() => {
                const box = dark.bounds(chain.raw);
                const rows = [];
                for (let y = Math.max(0, Math.floor(box.minY) - 1); y < Math.min(height, Math.ceil(box.maxY) + 1); y++) for (let x = Math.max(0, Math.floor(box.minX) - 1); x < Math.min(width, Math.ceil(box.maxX) + 1); x++) {
                    const pixel = y * width + x;
                    rows.push({x, y, rgba: Array.from(input.data.slice(4 * pixel, 4 * pixel + 4)), sourceOwner: paths.ownerAt(x + .5, y + .5), label: traced.debug.labels[pixel], component: traced.debug.componentIds[pixel]});
                }
                return rows;
            })()}));
        return {palettes: {initial: stages.initialPalette, recovered: stages.recoveredPalette, final: traced.stats.palette}, failedProbes, paintEvidence, modeUpdates: stages.modeUpdates, normals, fallbackChains, validationEvents: stages.events};
    }

    return {coverageMasks, sourceNormal, localCorrespondence, stageCrossings, probeOwnership, diagnose};
}

export const validationDiagnosticFactories = `${createSpiralDiagnostics}\n${createDarkBoundaryDiagnostics}\n${createValidationDiagnostics}\nwindow.validationDiagnostics=createValidationDiagnostics(createSpiralDiagnostics(),createDarkBoundaryDiagnostics(createSpiralDiagnostics()));`;
