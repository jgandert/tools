/* Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0 */
/* global module */

(() => {
    "use strict";

    function readPreferences(stored) {
        const preferences = { version: 1, appendMode: true, normalizePunctuation: false };
        if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== preferences.version) {
            return preferences;
        }

        for (const key of ["appendMode", "normalizePunctuation"]) {
            if (typeof stored[key] === "boolean") {
                preferences[key] = stored[key];
            }
        }

        return preferences;
    }

    function paragraphSeparator(before, after) {
        if (!before || !after) {
            return "";
        }

        const boundary = before.match(/(?:^|[^ \t\r\n])([ \t\r\n]*)$/)[1] + after.match(/^[ \t\r\n]*/)[0];
        const lineBreaks = boundary.match(/\r\n|\r|\n/g)?.length || 0;
        return "\n".repeat(Math.max(0, 2 - lineBreaks));
    }

    function planInsertion(value, text, selection, appendMode = false) {
        if (!text) {
            return null;
        }

        if (appendMode) {
            return {
                start: value.length,
                end: value.length,
                text: paragraphSeparator(value, text) + text,
            };
        }

        return { start: selection.start, end: selection.end, text };
    }

    const api = { readPreferences, paragraphSeparator, planInsertion };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        globalThis.mdPaste = api;
    }
})();
