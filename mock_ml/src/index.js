// Public API for the wireframe mockup compiler.

export { parse } from "./parser.js";
export { renderToString, esc, slug, uniqueId } from "./render.js";
export { connectNotes } from "./notes.js";

import { parse } from "./parser.js";
import { renderToString } from "./render.js";
import { connectNotes } from "./notes.js";

export function renderMock(src, options = {}) {
    return renderToString(parse(src), options);
}

export function mount(src, el, options = {}) {
    el.innerHTML = renderMock(src, options);
    connectNotes(el);
}
