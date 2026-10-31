/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */

// This factory is DOM-free; the study injects it and the existing intersection
// helper into Chromium so source, labels and fitted chains use one ray model.
export function createDarkBoundaryDiagnostics(intersections) {
    const bounds = points => points.reduce((box, p) => ({
        minX: Math.min(box.minX, p.x), minY: Math.min(box.minY, p.y),
        maxX: Math.max(box.maxX, p.x), maxY: Math.max(box.maxY, p.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

    function matchPalette(intended, palette, threshold = 52) {
        const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const targets = intended.map(rgb);
        const colors = palette.map(rgb);
        const used = new Set();
        let best = { count: -1, distance: Infinity, mapping: Array(colors.length).fill(-2) };
        const search = (target, mapping, count, distance) => {
            if (target === targets.length) {
                if (count > best.count || count === best.count && distance < best.distance) best = {
                    count,
                    distance,
                    mapping: [...mapping],
                };
                return;
            }
            search(target + 1, mapping, count, distance);
            for (let i = 0; i < colors.length; i++) {
                if (used.has(i)) continue;
                const delta = Math.hypot(...targets[target].map((c, channel) => c - colors[i][channel]));
                if (delta > threshold) continue;
                used.add(i);
                mapping[i] = target;
                search(target + 1, mapping, count + 1, distance + delta);
                used.delete(i);
                mapping[i] = -2;
            }
        };
        search(0, Array(colors.length).fill(-2), 0, 0);
        return best.mapping;
    }

    function transitions(ownerAt, origin, normal, radius = 3, step = 1 / 64) {
        const at = t => ownerAt(origin.x + t * normal.x, origin.y + t * normal.y);
        const hits = [];
        let from = at(-radius);
        for (let t = -radius + step; t <= radius + 1e-9; t += step) {
            const to = at(t);
            if (to === from) continue;
            let low = t - step;
            let high = t;
            for (let i = 0; i < 14; i++) {
                const mid = (low + high) / 2;
                if (at(mid) === from) low = mid;
                else high = mid;
            }
            hits.push({ at: (low + high) / 2, from, to });
            from = to;
        }
        return hits;
    }

    function chainHits(debug, origin, normal, key, radius = 3) {
        return debug.chains.flatMap(chain => {
            const paints = [chain.right, chain.left].map(face => face < 0 ? -1 : debug.faces[face].color);
            return intersections.crossings(origin, normal, [chain[key]])
                .filter(at => Math.abs(at) <= radius)
                .map(at => ({ at, chain: chain.id, paints }));
        }).sort((a, b) => a.at - b.at);
    }

    function separatorCoverage(debug, origin, normal, source, labelAt, outputAt) {
        const start = source.find(hit => hit.from === 1 && hit.to === 0);
        const end = source.find(hit => hit.from === 0 && hit.to === 2 && hit.at > (start?.at ?? Infinity));
        if (!start || !end || end.at - start.at > 1.25) return null;
        const overlaps = interval => Math.min(end.at, interval.exit) > Math.max(start.at, interval.entry);
        const ownerIntervals = ownerAt => {
            const initial = ownerAt(origin.x - 3 * normal.x, origin.y - 3 * normal.y);
            const stops = [{
                at: -3,
                to: initial,
            }, ...transitions(ownerAt, origin, normal), { at: 3, to: null }];
            return stops.slice(0, -1).flatMap((hit, i) => hit.to === 0 ? [{
                entry: hit.at,
                exit: stops[i + 1].at,
            }] : []).filter(overlaps);
        };
        const result = { labels: ownerIntervals(labelAt) };
        if (outputAt) result.emitted = ownerIntervals(outputAt);
        for (const key of ["raw", "samples", "flat"]) {
            result[key] = debug.faces.filter(face => face.color === 0).flatMap(face => {
                const polylines = debug.loops[face.id].flat().map(he => debug.chains[he >> 1][key]);
                return intersections.intervals(origin, normal, polylines, face.id).filter(overlaps);
            });
        }
        return result;
    }

    function endpointGroups(debug) {
        const groups = new Map();
        for (const chain of debug.chains) {
            for (const [end, p] of [[0, chain.raw[0]], [1, chain.raw.at(-1)]]) {
                const key = `${p.x},${p.y}`;
                const group = groups.get(key) || { raw: p, ends: [] };
                group.ends.push({
                    chain: chain.id,
                    end,
                    sample: end ? chain.samples.at(-1) : chain.samples[0],
                    flat: end ? chain.flat.at(-1) : chain.flat[0],
                });
                groups.set(key, group);
            }
        }
        return [...groups.values()].filter(group => group.ends.length >= 3).map(group => ({
            ...group,
            spread: Math.max(...group.ends.flatMap(a => group.ends.map(b => Math.hypot(a.flat.x - b.flat.x, a.flat.y - b.flat.y)))),
        }));
    }

    function components(debug, input) {
        const byId = new Map();
        for (let p = 0; p < debug.labels.length; p++) {
            const id = debug.componentIds[p];
            let component = byId.get(id);
            if (!component) {
                component = {
                    id,
                    paint: debug.labels[p],
                    count: 0,
                    sum: [0, 0, 0, 0],
                    min: [255, 255, 255, 255],
                    max: [0, 0, 0, 0],
                    pixels: [],
                    box: { minX: input.width, minY: input.height, maxX: 0, maxY: 0 },
                };
                byId.set(id, component);
            }
            component.count++;
            const x = p % input.width;
            const y = Math.floor(p / input.width);
            component.box.minX = Math.min(component.box.minX, x);
            component.box.minY = Math.min(component.box.minY, y);
            component.box.maxX = Math.max(component.box.maxX, x + 1);
            component.box.maxY = Math.max(component.box.maxY, y + 1);
            for (let c = 0; c < 4; c++) {
                const value = input.data[4 * p + c];
                component.sum[c] += value;
                component.min[c] = Math.min(component.min[c], value);
                component.max[c] = Math.max(component.max[c], value);
            }
            if (component.pixels.length < 48) component.pixels.push({
                x,
                y,
                rgba: Array.from(input.data.slice(4 * p, 4 * p + 4)),
            });
        }
        return [...byId.values()].map(({ sum, ...component }) => ({
            ...component,
            mean: sum.map(value => value / component.count),
        }));
    }

    return {
        bounds,
        matchPalette,
        transitions,
        chainHits,
        separatorCoverage,
        endpointGroups,
        components,
    };
}
