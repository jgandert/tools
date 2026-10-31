/* Pressure Recommender interface. No network calls, libraries, or build step. */
(() => {
    "use strict";
    const M = window.PressureModel, $ = id => document.getElementById(id);
    const STORAGE_KEY = "pressure-lab:setup:v1";
    let state = M.defaultState(), lastResult = null, liveTimer = null;
    let saveTimer = null;
    const mobile = window.matchMedia("(max-width: 899px)");
    const numberInputs = [...document.querySelectorAll("input[data-key]")];
    const keyToInput = new Map(numberInputs.map(el => [el.dataset.key, el.id]));
    const selectKeys = {
        "preset": "preset",
        "mass-unit": "massUnit",
        "width-unit": "widthUnit",
        "load-mode": "loadMode",
        "width-basis": "widthBasis",
        "front-bsd": "frontBsd",
        "rear-bsd": "rearBsd",
        "system": "system",
        "surface": "surface",
    };
    const checkKeys = { "same-width": "sameWidth", "same-wheel": "sameWheel", "impact": "impact" };
    $("rear-bsd").innerHTML = $("front-bsd").innerHTML;
    for (const el of numberInputs) {
        el.dataset.siMin = el.min;
        el.dataset.siMax = el.max;
    }
    const fmt = (n, d = 1) => Number.isFinite(n) ? Number(n.toFixed(d)).toString() : "—";
    const mass = n => `${fmt(state.massUnit === "lb" ? n / M.KG_PER_LB : n)} ${state.massUnit}`;
    const announce = text => {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => {
            $("live-status").textContent = text;
        }, 450);
    };

    function scale(quantity) {
        if (quantity === "mass") return state.massUnit === "lb" ? 1 / M.KG_PER_LB : 1;
        if (quantity === "width") return state.widthUnit === "in" ? 1 / 25.4 : 1;
        if (quantity === "percent") return 100;
        return 1;
    }

    function linkedState() {
        if (state.sameWidth) state.rearWidthMm = state.frontWidthMm;
        if (state.sameWheel) state.rearBsd = state.frontBsd;
    }

    function syncControls(all = true) {
        linkedState();
        for (const [id, key] of Object.entries(selectKeys)) $(id).value = String(state[key]);
        for (const [id, key] of Object.entries(checkKeys)) $(id).checked = Boolean(state[key]);
        for (const el of numberInputs) {
            const mult = scale(el.dataset.quantity), val = state[el.dataset.key];
            if (all || document.activeElement !== el) el.value = Number.isFinite(val) ? fmt(val * mult, el.dataset.quantity === "width" ? 4 : 3) : "";
            // Percent control limits were already in percent, all other limits were SI.
            const boundScale = el.dataset.quantity === "percent" ? 1 : mult;
            el.min = String(Number(el.dataset.siMin) * boundScale);
            el.max = String(Number(el.dataset.siMax) * boundScale);
        }
        $("estimated-load").hidden = state.loadMode !== "estimated";
        $("measured-load").hidden = state.loadMode !== "measured";
        $("rear-width").disabled = state.sameWidth;
        $("rear-wheel-control").hidden = state.sameWheel;
        $("rear-bsd").disabled = state.sameWheel;
        for (const el of document.querySelectorAll("[data-mass-unit]")) el.textContent = `(${state.massUnit})`;
        for (const el of document.querySelectorAll("[data-width-unit]")) el.textContent = `(${state.widthUnit})`;
        $("result-bar").checked = state.pressureUnit === "bar";
        $("result-psi").checked = state.pressureUnit === "psi";
    }

    function persist() {
        clearTimeout(saveTimer);
        saveTimer = null;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state }));
            $("storage-status").textContent = "Settings are saved automatically in this browser. No accounts, analytics or network requests. Check stored settings when changing equipment.";
        } catch {
            $("storage-status").textContent = "This browser did not allow saving. The calculator still works, but settings will be lost on reload.";
        }
    }

    function schedulePersist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 250);
    }

    function readStored() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            if (!saved || saved.version !== 1 || !saved.state || typeof saved.state !== "object" || Array.isArray(saved.state)) return;
            const candidate = M.defaultState();

            // Incomplete numbers can be saved; calculation validates them separately.

            for (const [key, defaultValue] of Object.entries(candidate)) {
                if (!Object.hasOwn(saved.state, key)) continue;
                const value = saved.state[key];
                const numeric = defaultValue === null || typeof defaultValue === "number";
                if (numeric ? value !== null && !Number.isFinite(value) : typeof value !== typeof defaultValue) return;
                candidate[key] = value;
            }
            for (const [id, key] of Object.entries(selectKeys)) {
                if (![...$(id).options].some(option => option.value === String(candidate[key]))) return;
            }
            if (!["bar", "psi"].includes(candidate.pressureUnit)) return;
            state = candidate;
        } catch { /* Corrupt or unavailable storage does not prevent a fresh calculation. */
        }
    }

    function updateDrawer() {
        const open = mobile.matches ? $("aside-state").checked : !$("aside-state").checked;
        document.querySelector(".aside-toggle-btn").setAttribute("aria-expanded", String(open));
        $("controls").inert = !open;
        $("workspace").inert = mobile.matches && open;
        document.body.style.overflow = mobile.matches && open ? "hidden" : "";
    }

    function openControls(targetId = null) {
        $("aside-state").checked = mobile.matches;
        updateDrawer();
        if (targetId) {
            const el = $(targetId);
            if (el) {
                for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
                requestAnimationFrame(() => {
                    el.scrollIntoView({ block: "center" });
                    el.focus({ preventScroll: true });
                });
            }
        }
    }

    function noticeNode(n) {
        const box = document.createElement("div");
        box.className = "notice";
        const p = document.createElement("p");
        p.className = "text-sm";
        p.textContent = n.text;
        box.append(p);
        return box;
    }

    function errorTarget(key) {
        if (state.loadMode === "measured" && ["riderKg", "frontShare"].includes(key)) return "measured-front";
        return keyToInput.get(key) || Object.keys(selectKeys).find(id => selectKeys[id] === key) || "preset";
    }

    function updateResults() {
        linkedState();
        const r = M.calculate(state);
        lastResult = r;
        for (const el of numberInputs) el.removeAttribute("aria-invalid");
        $("error-panel").hidden = r.valid;
        $("error-list").replaceChildren();
        if (!r.valid) for (const error of r.errors) {
            const id = errorTarget(error.field);
            if ($(id)) $(id).setAttribute("aria-invalid", "true");
            const p = document.createElement("p"), a = document.createElement("a");
            a.href = "#" + id;
            a.textContent = error.text;
            a.addEventListener("click", e => {
                e.preventDefault();
                openControls(id);
            });
            p.append(a);
            $("error-list").append(p);
        }
        $("pressure-results").dataset.blocked = String(r.blocked);
        $("status-tag").textContent = !r.valid ? "Check inputs" : "Outside model range";
        $("status-tag").hidden = r.valid && !r.blocked;
        for (const w of ["front", "rear"]) {
            const v = r.valid ? r[w] : null, allowed = v?.recommendedBar;
            const out = M.displayPressure(allowed, state.pressureUnit);
            const other = state.pressureUnit === "bar" ? "psi" : "bar";
            const alt = M.displayPressure(allowed, other);
            $(w + "-pressure").textContent = out.value;
            $(w + "-unit").textContent = state.pressureUnit;
            $(w + "-secondary").textContent = `${alt.value} ${other}`;
            $(w + "-caption").textContent = !r.valid ? "Check input values" : r.blocked ? "Outside model range" : "Estimated starting point";
            $(w + "-share-out").textContent = r.loads ? `${fmt(100 * r.loads[w] / r.loads.total, 0)}% load` : "—% load";
            $(w + "-load").textContent = v ? `${mass(v.loadKg)} on this wheel · ${fmt(v.widthMm, 1)}–${v.bsd}` : "—";
        }
        $("setup-summary").textContent = r.loads && r.valid ? `${mass(r.loads.total)} total · ${state.system === "tube" ? "inner tubes" : "tubeless"} · ${M.SURFACES[state.surface].label.toLowerCase()}` : "Correct your setup to calculate pressures.";
        const critical = r.notices.filter(n => n.level === "block" || n.level === "warn");
        const assumptions = r.notices.filter(n => n.level === "info");
        $("critical-notices").replaceChildren(...critical.map(noticeNode));
        $("assumption-notices").replaceChildren(...assumptions.map(noticeNode));
        if (r.valid) {
            const p = document.createElement("p");
            p.className = "text-sm";
            p.textContent = `Applied surface multiplier: ${fmt(r.factor, 2)}. After the tube floor: ${fmt(r.effectiveFactor, 2)}. Impact allowance: ${state.impact ? "1.10" : "1.00"}. ${r.loads.method}.`;
            $("assumption-notices").append(p);
        }
        $("assumptions-title").textContent = `Assumptions & adjustments${assumptions.length ? " · " + assumptions.length : ""}`;
        $("action-panel").dataset.level = r.blocked ? "block" : critical.length ? "warn" : "info";
        $("action-panel").hidden = critical.length === 0;
        $("copy-result").disabled = !r.valid || r.blocked;
        const announcement = r.valid && !r.blocked ? `Front ${$("front-pressure").textContent} ${state.pressureUnit}; rear ${$("rear-pressure").textContent} ${state.pressureUnit}.` : !r.valid ? "Inputs need correction." : "This setup is outside the model range.";
        announce(announcement);
        schedulePersist();
    }

    function presetSettings(key) {
        const p = M.PRESETS[key];
        if (!p) return;

        return {
            preset: key,
            bikeKg: p.bikeKg,
            frontWidthMm: p.widthMm,
            rearWidthMm: p.widthMm,
            frontBsd: p.bsd,
            rearBsd: p.bsd,
            frontShare: p.frontShare,
            surface: p.surface,
            system: p.system,
            impact: p.impact,
            loadMode: "estimated",
            sameWidth: true,
            sameWheel: true,
            widthBasis: "sidewall",
        };
    }

    async function applyPreset(key) {
        const settings = presetSettings(key);
        if (!settings || key === state.preset) return;

        const currentDefaults = presetSettings(state.preset);
        const customized = Object.entries(currentDefaults).some(([field, value]) => !Object.is(state[field], value));
        if (customized) {
            $("preset").value = state.preset;
            const confirmed = await one.confirm(
                `Apply the ${M.PRESETS[key].label} preset? This replaces your bike mass, tire and wheel settings, riding surface, load input mode, load split and impact allowance. Rider mass and cargo are kept.`,
                "Change bike preset",
            );
            if (!confirmed) return;
        }

        Object.assign(state, settings);
        syncControls();
        updateResults();
    }

    // Every input is parsed in its currently displayed unit into canonical SI state.
    for (const el of numberInputs) el.addEventListener("input", () => {
        const n = el.value.trim() === "" ? NaN : el.valueAsNumber / scale(el.dataset.quantity);
        state[el.dataset.key] = n;
        syncControls(false);
        updateResults();
    });
    for (const [id, key] of Object.entries(selectKeys)) $(id).addEventListener("change", () => {
        if (id === "preset") {
            applyPreset($(id).value);
            return;
        }
        state[key] = id.endsWith("-bsd") ? Number($(id).value) : $(id).value;
        syncControls();
        updateResults();
    });
    for (const [id, key] of Object.entries(checkKeys)) $(id).addEventListener("change", () => {
        state[key] = $(id).checked;
        syncControls();
        updateResults();
    });
    for (const radio of document.querySelectorAll("input[name=\"result-unit\"]")) radio.addEventListener("change", () => {
        if (radio.checked) {
            state.pressureUnit = radio.value;
            syncControls();
            updateResults();
        }
    });
    $("settings").addEventListener("submit", e => {
        e.preventDefault();
        $("show-results").click();
    });
    window.addEventListener("pagehide", () => {
        if (saveTimer !== null) persist();
    });
    $("aside-state").addEventListener("change", updateDrawer);
    document.querySelector(".aside-toggle-btn").addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            $("aside-state").checked = !$("aside-state").checked;
            updateDrawer();
        }
    });
    mobile.addEventListener("change", () => {
        $("aside-state").checked = false;
        updateDrawer();
    });
    document.addEventListener("keydown", e => {
        if (document.querySelector("dialog[open]")) return;

        if (e.key === "Escape" && mobile.matches && $("aside-state").checked) {
            $("aside-state").checked = false;
            updateDrawer();
            document.querySelector(".aside-toggle-btn").focus();
        }
        if (e.key === "Tab" && mobile.matches && $("aside-state").checked) {
            const items = [document.querySelector(".aside-toggle-btn"), ...[...$("controls").querySelectorAll("a,button,input,select,summary,[tabindex=\"0\"]")].filter(el => !el.disabled && el.getClientRects().length && !el.closest("[hidden]"))];
            if (e.shiftKey && document.activeElement === items[0]) {
                e.preventDefault();
                items.at(-1).focus();
            } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
                e.preventDefault();
                items[0].focus();
            }
        }
    });
    $("show-results").addEventListener("click", () => {
        if (mobile.matches) {
            $("aside-state").checked = false;
            updateDrawer();
        }
        $("workspace").scrollTop = 0;
        $("workspace").focus({ preventScroll: true });
        if (mobile.matches) window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("reset").addEventListener("click", () => $("reset-dialog").showModal());
    $("cancel-reset").addEventListener("click", () => $("reset-dialog").close());
    $("confirm-reset").addEventListener("click", () => {
        state = M.defaultState();
        syncControls();
        updateResults();
        persist();
        $("reset-dialog").close();
    });

    function summaryText() {
        const r = lastResult;
        if (!r?.valid || r.blocked) return "";
        const d = w => {
            const x = r[w];
            const a = M.displayPressure(x.recommendedBar, "bar"),
                b = M.displayPressure(x.recommendedBar, "psi");
            return `${w.toUpperCase()}: ${a.value} bar / ${b.value} psi; ${mass(x.loadKg)} load; ${fmt(x.widthMm, 2)}–${x.bsd}`;
        };
        return ["Pressure Recommender · model " + M.CONFIG.version, d("front"), d("rear"),
            `Total: ${mass(r.loads.total)}. ${r.loads.method}.`,
            `System: ${state.system}. Surface: ${M.SURFACES[state.surface].label}. Impact allowance: ${state.impact ? "10%" : "none"}.`,
            `Width source: ${state.widthBasis}.`,
            "Starting points only. Check manufacturer limits, compatibility and load ratings. Not a guarantee against flats or rim strikes.",
            ...r.notices.filter(n => n.level === "warn").map(n => n.text)].join("\n");
    }

    $("copy-result").addEventListener("click", async () => {
        const text = summaryText();
        if (!text) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
            await navigator.clipboard.writeText(text);
            one.alert("Pressures, setup and caveats copied.");
        } catch {
            $("copy-text").value = text;
            $("copy-dialog").showModal();
            $("copy-text").focus();
            $("copy-text").select();
        }
    });
    $("close-copy").addEventListener("click", () => $("copy-dialog").close());
    for (const surface of Object.values(M.SURFACES)) {
        const tr = document.createElement("tr");
        for (const val of [surface.label, surface.factor.toFixed(2), surface.basis]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.append(td);
        }
        $("surface-table").append(tr);
    }
    readStored();
    syncControls();
    updateDrawer();
    updateResults();
})();
