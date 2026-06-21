// Post-layout SVG connector lines for `<-` notes.
// Runs AFTER DOM insertion (needs measured geometry).

export function connectNotes(rootEl) {
    if (typeof document === "undefined") return;

    const mockRoot = rootEl.closest ? (rootEl.classList.contains("mock-root") ? rootEl : rootEl.querySelector(".mock-root")) : rootEl;
    if (!mockRoot) return;

    // Ensure overlay svg
    let svg = mockRoot.querySelector(":scope > svg.mock-note-lines");
    if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "mock-note-lines");
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.pointerEvents = "none";
        // mock-root must be positioned for the overlay to anchor correctly
        const cs = getComputedStyle(mockRoot);
        if (cs.position === "static") mockRoot.style.position = "relative";
        mockRoot.appendChild(svg);
    }

    // Clear prior lines (idempotent / re-runnable on resize)
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const rootRect = mockRoot.getBoundingClientRect();
    const mockEl = mockRoot.querySelector(".mock");
    const mockRect = mockEl ? mockEl.getBoundingClientRect() : null;

    const noteBoxes = mockRoot.querySelectorAll(".mock-note[data-note-for]");
    const total = noteBoxes.length;
    let index = 0;

    for (const noteBox of noteBoxes) {
        const targetId = noteBox.getAttribute("data-note-for");
        const target = mockRoot.querySelector(`[data-note-id="${targetId}"]`);
        if (!target) continue;

        const color = noteOklch(index, total);
        index++;

        noteBox.style.setProperty("--note-color", color);
        target.style.setProperty("--note-color", color);

        const tr = target.getBoundingClientRect();
        const nr = noteBox.getBoundingClientRect();

        const tl = tr.left - rootRect.left;
        const trgt = tr.right - rootRect.left;
        const tmidY = (tr.top + tr.bottom) / 2 - rootRect.top;

        const nl = nr.left - rootRect.left;
        const nmidY = (nr.top + nr.bottom) / 2 - rootRect.top;

        // Default straight line fallback.

        let pathD = `M ${tl + tr.width / 2} ${tr.bottom - rootRect.top} L ${nl} ${nmidY}`;

        if (mockRect) {
            const ml = mockRect.left - rootRect.left;
            const mr = mockRect.right - rootRect.left;
            const mb = mockRect.bottom - rootRect.top;
            const nmidX = (nr.left + nr.right) / 2 - rootRect.left;
            const mockCenterX = (ml + mr) / 2;
            const routeLeft = nmidX < mockCenterX;

            // Route outside of the mock container.

            const offset = 12 + index * 6;
            const routeX = routeLeft
                ? Math.max(4, ml - offset)
                : Math.min(rootRect.width - 4, mr + offset);

            const startX = routeLeft ? tl : trgt;
            const startY = tmidY;
            const bypassY = mb + offset;

            pathD = `M ${startX} ${startY} H ${routeX} V ${bypassY} H ${nl - offset} V ${nmidY} H ${nl}`;
        }

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1");
        path.style.setProperty("--note-color", color);
        svg.appendChild(path);
    }
}

function noteOklch(index, total) {
    const lightness = 0.65;
    const chroma = 0.15;
    const hue = (index / Math.max(total, 1)) * 360;

    return `oklch(${lightness} ${chroma} ${hue})`;
}
