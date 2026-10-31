"use strict";
// Run: bun test model.test.js. No npm install required.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./model.js");
const state = (overrides = {}) => ({ ...M.defaultState(), ...overrides });
const calc = (overrides = {}) => M.calculate(state(overrides));
const close = (a, b, tol = 1e-10) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

test("Default uses rider + actual bike mass and static split", () => {
    const r = calc();
    assert.equal(r.valid, true);
    assert.equal(r.blocked, false);
    close(r.loads.total, 96);
    close(r.loads.front, 38.4);
    close(r.loads.rear, 57.6);
    close(r.front.rawBar, 2.070253090323739);
    close(r.rear.rawBar, 3.1053796354856082);
});
test("Reference coefficient is reproduced exactly", () => close(M.basePressure(42.5, 28, 622), 4.53));
test("Weight is linear at fixed width and geometry", () => close(M.basePressure(60, 40, 622), 2 * M.basePressure(30, 40, 622)));
test("No arbitrary rear-pressure offset: equal loads and tires give equal pressure", () => {
    const r = calc({ frontShare: .5 });
    close(r.front.rawBar, r.rear.rawBar);
});
test("Front axle cargo can reverse the pressure difference", () => {
    const r = calc({ riderKg: 60, bikeKg: 10, frontCargoKg: 25 });
    assert.ok(r.front.rawBar > r.rear.rawBar);
});
test("Central luggage is split; axle cargo affects only its named axle", () => {
    const a = calc(), b = calc({ frontCargoKg: 5 }), c = calc({ rearCargoKg: 5 }),
        d = calc({ gearKg: 5 });
    close(b.loads.front, a.loads.front + 5);
    close(b.loads.rear, a.loads.rear);
    close(c.loads.rear, a.loads.rear + 5);
    close(c.loads.front, a.loads.front);
    close(d.loads.front, a.loads.front + 2);
    close(d.loads.rear, a.loads.rear + 3);
});
test("Actual e-bike mass changes both axle loads; bike label adds no surcharge", () => {
    const a = calc({ bikeKg: 17 }), b = calc({ bikeKg: 27 });
    assert.ok(b.front.rawBar > a.front.rawBar && b.rear.rawBar > a.rear.rawBar);
    close(calc({ preset: "mtb" }).front.rawBar, a.front.rawBar);
});
test("Measured loads replace all rider, bike and cargo entries without double counting", () => {
    const r = calc({
        loadMode: "measured",
        measuredFrontKg: 40,
        measuredRearKg: 60,
        riderKg: NaN,
        bikeKg: NaN,
        gearKg: 1000,
        frontCargoKg: 1000,
    });
    assert.equal(r.valid, true);
    close(r.loads.total, 100);
    close(r.loads.front, 40);
});
test("Measured mode starts blank, not with fabricated measurements", () => {
    const s = M.defaultState();
    assert.equal(s.measuredFrontKg, null);
    assert.equal(calc({ loadMode: "measured" }).valid, false);
});
test("A wider rear tire can need less pressure than a narrower front", () => {
    const r = calc({ sameWidth: false, frontWidthMm: 25, rearWidthMm: 47 });
    assert.ok(r.front.rawBar > r.rear.rawBar);
});
test("Same-width and same-wheel flags use the linked front dimensions", () => {
    const a = calc({ rearWidthMm: 25, rearBsd: 406 }), b = calc();
    close(a.rear.rawBar, b.rear.rawBar);
});
test("Mixed wheel sizes are honored when unlinked", () => {
    const a = calc({ sameWheel: false, rearBsd: 406 }), b = calc();
    assert.ok(a.rear.rawBar > b.rear.rawBar);
    close(a.front.rawBar, b.front.rawBar);
});
test("Small-wheel correction has the stated continuous diameter ratio", () => close(M.basePressure(40, 40, 406) / M.basePressure(40, 40, 622), Math.sqrt(702 / 486)));
test("Width has no discontinuity at the old 35/36 or 40/41 mm boundaries", () => {
    for (const w of [35, 36, 40, 41]) {
        const p = M.basePressure(40, w, 622), q = M.basePressure(40, w + .00001, 622);
        assert.ok(Math.abs(p - q) < .00001);
    }
});
test("Tubeless and tubes have the same baseline on ordinary pavement", () => close(calc({
    system: "tube",
    impact: false,
}).front.rawBar, calc({ system: "tubeless", impact: false }).front.rawBar));
test("Tube support floor applies on rough surfaces, not a universal bar offset", () => {
    const a = calc({ surface: "gravel", system: "tube", impact: false }),
        b = calc({ surface: "gravel", system: "tubeless", impact: false });
    close(a.effectiveFactor, 1);
    close(b.effectiveFactor, .87);
    close(a.front.rawBar / b.front.rawBar, 1 / .87);
    assert.notEqual(a.front.rawBar - b.front.rawBar, a.rear.rawBar - b.rear.rawBar);
});
test("Impact allowance is proportional and exactly 10%", () => close(calc({ impact: true }).front.rawBar / calc({ impact: false }).front.rawBar, 1.1));
test("Roughness lowers the tubeless target, but the model does not guarantee impact safety", () => {
    assert.ok(calc({
        system: "tubeless",
        surface: "coarse",
    }).front.rawBar < calc({ system: "tubeless", surface: "road" }).front.rawBar);
    assert.ok(calc({ impact: true }).notices.some(n => n.code === "impact"));
});
test("Displayed recommendations use the model estimate", () => {
    for (const setup of [{}, { frontWidthMm: 32 }, { system: "tubeless", surface: "gravel" }]) {
        const r = calc(setup);
        assert.equal(r.blocked, false);
        close(r.front.recommendedBar, r.front.rawBar);
        close(r.rear.recommendedBar, r.rear.rawBar);
    }
});
test("Pressures outside the model range withhold both recommendations", () => {
    for (const setup of [
        { riderKg: 150, bikeKg: 10, frontWidthMm: 23, frontBsd: 305 },
        {
            loadMode: "measured",
            measuredFrontKg: 20,
            measuredRearKg: 60,
            frontWidthMm: 75,
            system: "tubeless",
            surface: "coarse",
            impact: false,
        },
    ]) {
        const r = calc(setup);
        assert.equal(r.valid, true);
        assert.equal(r.blocked, true);
        assert.equal(r.front.recommendedBar, null);
        assert.equal(r.rear.recommendedBar, null);
        assert.ok(r.notices.some(n => n.level === "block"));
    }
});
test("Blank, nonfinite, string, zero and negative required physical inputs are rejected", () => {
    for (const value of [null, NaN, Infinity, -Infinity, "79", 0, -1]) assert.equal(calc({ riderKg: value }).valid, false);
    for (const value of [NaN, Infinity, 0, -1, "47"]) assert.equal(calc({ frontWidthMm: value }).valid, false);
});
test("Unsupported tire widths, wheel diameters and enum inputs are rejected", () => {
    for (const o of [{ frontWidthMm: 22 }, { frontWidthMm: 76 }, { frontBsd: 700 }, { surface: "ice" }, { system: "tubular" }, { loadMode: "other" }]) assert.equal(calc(o).valid, false);
});
test("Scope limits constrain total and per-wheel loads", () => {
    assert.equal(calc({ riderKg: 150, bikeKg: 50 }).valid, false);
    assert.equal(calc({
        loadMode: "measured",
        measuredFrontKg: 5,
        measuredRearKg: 50,
    }).valid, false);
    assert.equal(calc({
        loadMode: "measured",
        measuredFrontKg: 20,
        measuredRearKg: 20,
    }).valid, false);
});
test("Wider and heavier inputs remain monotonic across a representative grid", () => {
    for (const load of [15, 25, 40, 60, 90]) for (const width of [25, 28, 32, 35, 40, 47, 55, 61, 70]) for (const bsd of [349, 406, 559, 584, 622, 635]) {
        const base = M.basePressure(load, width, bsd);
        assert.ok(Number.isFinite(base) && base > 0);
        assert.ok(M.basePressure(load + 1, width, bsd) > base);
        assert.ok(M.basePressure(load, width + .1, bsd) < base);
    }
});
test("Pressure units round to the nearest pump increment", () => {
    for (const unit of ["bar", "psi"]) {
        const scale = unit === "psi" ? M.PSI_PER_BAR : 1;
        const increment = unit === "psi" ? 1 : .1;
        for (const pressure of [.611, 1.011, 2.041, 2.45, 3.004, 9.99]) {
            const displayed = Number(M.displayPressure(pressure, unit).value);
            assert.ok(Math.abs(displayed - pressure * scale) <= increment / 2 + 1e-10);
        }
    }
});
test("Pressure conversion and deliberate pump-level rounding", () => {
    assert.equal(M.displayPressure(2.070253, "bar").value, "2.1");
    assert.equal(M.displayPressure(2.070253, "psi").value, "30");
    assert.equal(M.displayPressure(null).value, "—");
});
