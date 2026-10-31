// Copyright 2026 Joschua Gandert - License: Apache 2.0
/*
 * ZIP support adapted from the original clean-zip source supplied with this project.
 * Copyright (c) 2026 clean-zip contributors. SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint max-lines: "off" -- Shared helpers and ZIP support must work as one classic script. */

const one = (() => {
    const createElement = (tag, attrs = {}, children = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k.startsWith("data-")) {
                el.setAttribute(k, v);
                continue;
            }
            el[k] = v;
        }
        for (const child of children) {
            const node = typeof child === "string" ? document.createTextNode(child) : child;
            el.append(node);
        }
        return el;
    };

    // Dialogs come and go over the page lifetime and two can overlap (a confirm
    // raised from a prompt), so every one gets its own id suffix: fixed ids
    // would make `aria-labelledby`/`aria-describedby` resolve to the wrong,
    // possibly removed, element.
    let dialogSeq = 0;

    // A Node body owns its own markup, so it marks the element that describes
    // the dialog with `data-dialog-desc`; that element gets the generated id.
    const createDialog = (titleText, bodyContent, buttons) => {
        const uid = `one-dialog-${++dialogSeq}`;
        const titleId = `${uid}-title`;
        const descId = `${uid}-desc`;

        const title = createElement("h3", { id: titleId }, [titleText]);
        const header = createElement("header", {}, [title]);
        const isText = typeof bodyContent === "string";
        const body = isText
            ? createElement("p", { id: descId }, [bodyContent])
            : bodyContent;
        const footer = createElement("footer", {}, buttons);
        const article = createElement("article", {}, [header, body, footer]);
        const dialog = createElement("dialog", {
            "aria-labelledby": titleId,
            "aria-modal": "true",
        }, [article]);

        const desc = isText ? body : bodyContent.querySelector("[data-dialog-desc]");
        if (desc) {
            desc.id = descId;
            dialog.setAttribute("aria-describedby", descId);
        }

        document.body.appendChild(dialog);
        return dialog;
    };

    const confirm = (message, title = "Confirm Action") => {
        return new Promise((resolve) => {
            const btnCancel = createElement("button", {
                type: "button",
                "data-action": "cancel",
            }, ["Cancel"]);
            const btnConfirm = createElement("button", {
                type: "button",
                "data-action": "confirm",
                autofocus: true,
            }, ["Confirm"]);
            const dialog = createDialog(title, message, [btnCancel, btnConfirm]);

            let settled = false;
            const cleanup = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (dialog.open) {
                    dialog.close();
                }
                dialog.remove();
                resolve(result);
            };

            btnCancel.onclick = () => cleanup(false);
            btnConfirm.onclick = () => cleanup(true);

            dialog.addEventListener("cancel", (event) => {
                event.preventDefault();
                cleanup(false);
            });
            dialog.addEventListener("close", () => cleanup(false));

            dialog.addEventListener("click", (e) => {
                if (e.target === dialog) cleanup(false);
            });

            dialog.showModal();
        });
    };

    const prompt = (message, defaultValue = "", title = "Input Required") => {
        return new Promise((resolve) => {
            const input = createElement("input", { type: "text", value: defaultValue });
            const p = createElement("p", { "data-dialog-desc": "" }, [message]);
            const container = createElement("div", {}, [p, input]);

            const btnCancel = createElement("button", {
                type: "button",
                "data-action": "cancel",
            }, ["Cancel"]);
            const btnConfirm = createElement("button", {
                type: "button",
                "data-action": "confirm",
            }, ["Confirm"]);
            const dialog = createDialog(title, container, [btnCancel, btnConfirm]);
            // createDialog has just given the message paragraph its id; the box
            // has no visible label of its own, so the message is its name.
            input.setAttribute("aria-labelledby", p.id);

            let settled = false;
            const cleanup = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (dialog.open) {
                    dialog.close();
                }
                dialog.remove();
                resolve(result);
            };

            btnCancel.onclick = () => cleanup(null);
            btnConfirm.onclick = () => cleanup(input.value);

            dialog.addEventListener("cancel", (event) => {
                event.preventDefault();
                cleanup(null);
            });
            dialog.addEventListener("close", () => cleanup(null));

            input.onkeydown = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup(input.value);
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup(null);
                }
            };

            dialog.addEventListener("click", (e) => {
                if (e.target === dialog) cleanup(null);
            });

            dialog.showModal();
            input.focus();
        });
    };

    // Brysbaert's 2019 meta-analysis puts adult English readers at 238 wpm for
    // non-fiction, most falling in a 175-300 band. Toasts sit at the slow end:
    // they appear unannounced, carry no surrounding context, and often name
    // files or errors. Technical characters slow scanning further because they
    // can't be guessed from word shape; digits slow it down less.
    const TOAST_READING_SPEED_WPM = 190;
    const MS_PER_WORD = 60000 / TOAST_READING_SPEED_WPM;
    const NOTICE_MS = 500;
    const MS_PER_TECHNICAL_CHAR = 60;
    const MS_PER_DIGIT = 25;

    // Length past which a token stops reading as one word (paths, IDs, URLs).
    const LONG_TOKEN_CHARS = 10;
    const CHARS_PER_EXTRA_WORD = 6;

    const TECHNICAL_CHARS = new Set([..."`/_{}<>=|\\\"'"]);

    const countEffectiveWords = (text) => {
        const tokens = text.split(/\s+/).filter(Boolean);
        let words = 0;
        for (const token of tokens) {
            const overflow = Math.max(0, token.length - LONG_TOKEN_CHARS);
            words += 1 + Math.floor(overflow / CHARS_PER_EXTRA_WORD);
        }
        return words;
    };

    const estimateReadingTime = (text) => {
        let technical = 0;
        let digits = 0;
        for (const char of text) {
            if (TECHNICAL_CHARS.has(char)) technical++;
            else if (char >= "0" && char <= "9") digits++;
        }

        return Math.round(
            NOTICE_MS
            + countEffectiveWords(text) * MS_PER_WORD
            + technical * MS_PER_TECHNICAL_CHAR
            + digits * MS_PER_DIGIT,
        );
    };

    const activeToasts = new Set();
    let isHoveringToastStack = false;
    let resumeDebounceId = null;

    const pauseToastStack = () => {
        if (resumeDebounceId !== null) {
            clearTimeout(resumeDebounceId);
            resumeDebounceId = null;
        }
        isHoveringToastStack = true;
        activeToasts.forEach((t) => {
            t.pause();
        });
    };

    const resumeToastStack = () => {
        if (resumeDebounceId !== null) {
            clearTimeout(resumeDebounceId);
        }
        // 75ms debounce bridges the flex gap between stacked toasts without timer thrashing
        resumeDebounceId = setTimeout(() => {
            resumeDebounceId = null;
            isHoveringToastStack = false;
            activeToasts.forEach((t) => {
                t.resume();
            });
        }, 75);
    };

    // `type` is "info" (default, for confirmations/notices) or "error" --
    // kept visually distinct via a modifier class rather than a fixed look
    // for every message. `minDuration` floors the estimated reading time; pass
    // 0 to let short messages disappear as fast as they can be read.
    const alert = (message, type = "info", minDuration = 3000) => {
        const messageText = message instanceof Node ? message.textContent || "" : String(message);
        const duration = Math.max(minDuration, estimateReadingTime(messageText));

        let container = document.getElementById("one-toast-container");
        if (!container) {
            // The container is the live region and outlives every toast, so it
            // is already in the accessibility tree when a toast appears.
            container = createElement("div", { id: "one-toast-container" });
            container.setAttribute("aria-live", "polite");
            container.setAttribute("aria-atomic", "false");
            if (typeof container.showPopover === "function") {
                container.setAttribute("popover", "manual");
            }
            document.body.appendChild(container);
            if (typeof container.showPopover === "function") {
                container.showPopover();
            }
        }

        // An insertion is announced by the nearest live region that contains
        // it, self included: errors interrupt as assertive alerts, everything
        // else rides the container's polite region. Exactly one announcement
        // either way, because the toast's own role wins over the container's.
        const toast = createElement("div", { className: `toast toast-${type}` }, [message]);
        if (type === "error") {
            toast.setAttribute("role", "alert");
            toast.setAttribute("aria-live", "assertive");
        } else {
            toast.setAttribute("role", "status");
        }
        container.appendChild(toast);
        void toast.offsetHeight;
        toast.classList.add("show");

        const toastEntry = {
            toast,
            remaining: duration,
            startTime: 0,
            timerId: null,
            start(ms) {
                this.startTime = Date.now();
                this.timerId = setTimeout(() => {
                    this.dismiss();
                }, ms);
            },
            pause() {
                if (this.timerId !== null) {
                    clearTimeout(this.timerId);
                    this.timerId = null;
                    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startTime));
                }
            },
            resume() {
                if (this.timerId === null) {
                    // Minimum 1000ms on resume so the toast does not vanish instantaneously
                    this.start(Math.max(1000, this.remaining));
                }
            },
            dismiss() {
                activeToasts.delete(this);
                if (activeToasts.size === 0) {
                    if (resumeDebounceId !== null) {
                        clearTimeout(resumeDebounceId);
                        resumeDebounceId = null;
                    }
                    isHoveringToastStack = false;
                }
                toast.classList.remove("show");

                let removed = false;
                const removeToast = () => {
                    if (!removed) {
                        removed = true;
                        toast.remove();
                    }
                };
                toast.addEventListener("transitionend", removeToast, { once: true });
                setTimeout(removeToast, 500);
            },
        };

        activeToasts.add(toastEntry);

        const handlePointerEnter = (e) => {
            if (e.pointerType === "touch") {
                return;
            }
            pauseToastStack();
        };

        const handlePointerLeave = (e) => {
            if (e.pointerType === "touch") {
                return;
            }
            resumeToastStack();
        };

        toast.addEventListener("pointerenter", handlePointerEnter);
        toast.addEventListener("pointerleave", handlePointerLeave);
        toast.addEventListener("touchstart", pauseToastStack, { passive: true });
        toast.addEventListener("touchend", resumeToastStack, { passive: true });
        toast.addEventListener("touchcancel", resumeToastStack, { passive: true });
        toast.addEventListener("focusin", pauseToastStack);
        toast.addEventListener("focusout", resumeToastStack);

        if (!isHoveringToastStack) {
            toastEntry.start(duration);
        }
    };

    const copy = (text, silent = false) => {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text)
                .then(() => {
                    if (!silent) {
                        alert("Copied to clipboard");
                    }
                    return true;
                })
                .catch((err) => {
                    console.error("Clipboard error", err);
                    return fallbackCopy(text, silent);
                });
        }
        return Promise.resolve(fallbackCopy(text, silent));
    };

    const fallbackCopy = (text, silent = false) => {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        let success = false;
        try {
            success = document.execCommand("copy");
            if (!silent) {
                if (success) {
                    alert("Copied to clipboard");
                } else {
                    alert("Copy failed", "error");
                }
            }
        } catch (err) {
            console.error("Fallback copy failed", err);
            if (!silent) {
                alert("Copy failed", "error");
            }
        }
        document.body.removeChild(textArea);
        return success;
    };

    const getTimestamp = () => {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const hh = String(now.getHours()).padStart(2, "0");
        const min = String(now.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}_${hh}-${min}`;
    };

    const closeAsideDrawerOnEscape = (e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;

        // Desktop sidebar is persistent; only the mobile overlay drawer closes on Esc.
        const asideState = document.getElementById("aside-state");
        const isDesktop = window.matchMedia("(min-width: 900px)").matches;
        if (!asideState || !asideState.checked || isDesktop) return;

        // Open modals own the Escape key.
        if (document.querySelector("dialog[open]")) return;

        asideState.checked = false;
        asideState.focus();
    };

    const storage = (() => {
        const dbName = "one-storage";
        const storeName = "keyval";
        let dbPromise = null;

        const getDB = () => {
            if (dbPromise) return dbPromise;
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore(storeName);
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            return dbPromise;
        };

        const withStore = async (mode, callback) => {
            const db = await getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(storeName, mode);
                const store = transaction.objectStore(storeName);
                const request = callback(store);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        };

        return {
            /**
             * Retrieve a value by key.
             * @param {string} key
             * @returns {Promise<any>}
             */
            get: (key) => withStore("readonly", (store) => store.get(key)),

            /**
             * Set a value by key.
             * @param {string} key
             * @param {any} value
             * @returns {Promise<void>}
             */
            set: (key, value) => withStore("readwrite", (store) => store.put(value, key)),

            /**
             * Remove a value by key.
             * @param {string} key
             * @returns {Promise<void>}
             */
            del: (key) => withStore("readwrite", (store) => store.delete(key)),

            /**
             * Clear all values in the store.
             * @returns {Promise<void>}
             */
            clear: () => withStore("readwrite", (store) => store.clear()),

            /**
             * Retrieve all keys in the store.
             * @returns {Promise<string[]>}
             */
            keys: () => withStore("readonly", (store) => store.getAllKeys()),
        };
    })();

    const compress = {
        /**
         * Encode text as deflate Base64URL, or URI-encoded text with a raw "text:" prefix.
         * @param {string} text - Input text to compress.
         * @param {string|null} [param="z"] - Parameter key name (pass null for a bare payload).
         * @returns {Promise<string>} e.g. "z=y0jNyckHAA" or "z=text:hello%20world".
         */
        url: async (text, param = "z") => {
            if (!text) return "";
            if (typeof CompressionStream === "undefined") {
                const payload = `text:${encodeURIComponent(text)}`;
                return param ? `${param}=${payload}` : payload;
            }
            try {
                const bytes = new TextEncoder().encode(text);
                const cs = new ReadableStream({
                    start(c) {
                        c.enqueue(bytes);
                        c.close();
                    },
                }).pipeThrough(new CompressionStream("deflate-raw"));
                const buf = await new Response(cs).arrayBuffer();
                const u8 = new Uint8Array(buf);
                let bin = "";
                for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
                const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
                return param ? `${param}=${b64}` : b64;
            } catch (err) {
                console.error("one.compress.url error:", err);
                const payload = `text:${encodeURIComponent(text)}`;
                return param ? `${param}=${payload}` : payload;
            }
        },
    };

    const decompress = {
        /**
         * Decode a URL payload, including tagged plain text and existing untagged links.
         * @param {string} input - location.hash, full URL, or parameter string.
         * @param {string|null} [param="z"] - Parameter key to extract (pass null for a bare payload).
         * @returns {Promise<string|null>} Decompressed string or null on failure.
         */
        url: async (input, param = "z") => {
            if (!input) return null;
            let encodedPayload = input;
            let payload = input;
            if (param) {
                const str = input.replace(/^[^?#]*[?#]/, "");
                payload = null;
                for (const part of str.split("&")) {
                    const value = new URLSearchParams(part).get(param);
                    if (value === null) {
                        continue;
                    }
                    encodedPayload = part.slice(part.indexOf("=") + 1);
                    payload = value;
                    break;
                }
                if (!payload) {
                    return null;
                }
            } else {
                try {
                    payload = decodeURIComponent(encodedPayload);
                } catch {
                    return null;
                }
            }

            // Old URI-encoded text escapes the colon; only a raw prefix tags plain text.
            if (encodedPayload.startsWith("text:")) {
                return payload.slice(5);
            }
            if (typeof DecompressionStream === "undefined") {
                return payload;
            }

            let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) b64 += "=";
            try {
                const bin = atob(b64);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                const ds = new ReadableStream({
                    start(c) {
                        c.enqueue(u8);
                        c.close();
                    },
                }).pipeThrough(new DecompressionStream("deflate-raw"));
                const buf = await new Response(ds).arrayBuffer();
                return new TextDecoder().decode(buf);
            } catch {
                return payload;
            }
        },
    };

    const zip = (() => {
        /** Stable machine-readable errors. Runtime codec errors are retained as causes. */
        class ZipError extends Error {
            constructor(code, message, options) {
                super(message, options);
                this.name = "ZipError";
                this.code = code;
            }
        }

        function fail(code, message) {
            throw new ZipError(code, message);
        }

        function checkAbort(signal) {
            if (signal?.aborted) {
                throw new ZipError("ERR_ABORTED", "The operation was aborted.", { cause: signal.reason });
            }
        }

        function checkOptions(value, allowed, label = "options") {
            if (value === undefined) {
                return {};
            }
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                fail("ERR_ARGUMENT", `${label} must be an object.`);
            }
            for (const key of Object.keys(value)) {
                if (!allowed.includes(key)) {
                    fail("ERR_ARGUMENT", `Unknown ${label} field: ${key}.`);
                }
            }
            if (value.signal !== undefined && (
                !value.signal || typeof value.signal.aborted !== "boolean" ||
                typeof value.signal.addEventListener !== "function" ||
                typeof value.signal.removeEventListener !== "function"
            )) {
                fail("ERR_ARGUMENT", "signal must be an AbortSignal.");
            }
            return value;
        }

        function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
            if (!Number.isSafeInteger(value) || value < min || value > max) {
                fail("ERR_ARGUMENT", `${name} must be an integer between ${min} and ${max}.`);
            }
            return value;
        }

        const DEFAULT_LIMITS = Object.freeze({
            maxArchiveSize: 512 * 1024 * 1024,
            maxEntrySize: 128 * 1024 * 1024,
            maxTotalSize: 512 * 1024 * 1024,
            maxEntries: 10_000,
            // Absolute output limits are always active; ratio checking is opt-in.

            maxCompressionRatio: Infinity,
        });

        function resolveLimits(value) {
            const supplied = checkOptions(value, Object.keys(DEFAULT_LIMITS), "limits");
            const result = { ...DEFAULT_LIMITS };
            for (const key of Object.keys(DEFAULT_LIMITS)) {
                if (supplied[key] === undefined) {
                    continue;
                }
                if (key === "maxCompressionRatio") {
                    const ratio = supplied[key];
                    if (typeof ratio !== "number" || !(ratio >= 1)) {
                        fail("ERR_ARGUMENT", "maxCompressionRatio must be a number >= 1 (or Infinity).");
                    }
                    result[key] = ratio;
                } else {
                    result[key] = integer(supplied[key], key);
                }
            }
            return Object.freeze(result);
        }

        function within(size, maximum, label) {
            if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
                fail("ERR_LIMIT", `${label} exceeds the configured limit (${maximum} bytes/items).`);
            }
        }

        const encoder = new TextEncoder();
        const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

        /** Copy the caller's data so later mutation cannot alter parsed archive metadata. */
        async function toBytes(input, maxSize, signal, allowText = false) {
            checkAbort(signal);
            let view;
            if (typeof input === "string" && allowText) {
                // This precheck avoids encoding strings that already exceed the byte limit.

                within(input.length, maxSize, "Input");
                view = encoder.encode(input);
            } else if (ArrayBuffer.isView(input)) {
                within(input.byteLength, maxSize, "Input");
                view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            } else if (input instanceof ArrayBuffer) {
                within(input.byteLength, maxSize, "Input");
                view = new Uint8Array(input);
            } else if (typeof Blob !== "undefined" && input instanceof Blob) {
                within(input.size, maxSize, "Input");
                view = new Uint8Array(await input.arrayBuffer());
                checkAbort(signal);
                return view;
            } else if (typeof ReadableStream !== "undefined" && input instanceof ReadableStream) {
                return readInputStream(input, maxSize, signal);
            } else {
                fail("ERR_ARGUMENT", `Expected binary data${allowText ? " or a string" : ""}; paths and URLs are not read automatically.`);
            }
            within(view.byteLength, maxSize, "Input");
            checkAbort(signal);
            return new Uint8Array(view);
        }

        function concat(parts, size = parts.reduce((sum, part) => sum + part.length, 0)) {
            const result = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
                result.set(part, offset);
                offset += part.length;
            }
            return result;
        }

        function equal(a, b) {
            return a.length === b.length && a.every((byte, i) => byte === b[i]);
        }

        function decodeUTF8(bytes) {
            try {
                return utf8.decode(bytes);
            } catch (cause) {
                fail("ERR_FORMAT", `Invalid UTF-8 metadata: ${cause.message}`);
            }
        }

        function encodeMetadata(text, label) {
            if (typeof text !== "string") {
                fail("ERR_ARGUMENT", `${label} must be a string.`);
            }
            within(text.length, 0xffff, label);
            const bytes = encoder.encode(text);
            within(bytes.length, 0xffff, label);
            // TextEncoder replaces lone surrogates; reject instead of silently renaming.

            if (decodeUTF8(bytes) !== text) {
                fail("ERR_ARGUMENT", `${label} contains an unpaired surrogate.`);
            }
            return bytes;
        }

        /** All arithmetic and reads go through bounds-checked little-endian helpers. */
        class BinaryReader {
            constructor(bytes) {
                this.bytes = bytes;
                this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            }
            range(offset, length, end = this.bytes.length) {
                if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
                offset < 0 || length < 0 || offset > end || length > end - offset) {
                    fail("ERR_FORMAT", "Truncated binary record or out-of-bounds offset.");
                }
            }
            u16(offset) {
                this.range(offset, 2);
                return this.view.getUint16(offset, true);
            }
            u32(offset) {
                this.range(offset, 4);
                return this.view.getUint32(offset, true);
            }
            u64(offset) {
                this.range(offset, 8);
                const value = this.view.getBigUint64(offset, true);
                if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                    fail("ERR_LIMIT", "ZIP64 value exceeds JavaScript safe integer range.");
                }
                return Number(value);
            }
            slice(offset, length) {
                this.range(offset, length);
                return this.bytes.subarray(offset, offset + length);
            }
        }

        /** Extra fields are length-prefixed. Never accept ambiguous duplicate IDs. */
        function extraFields(bytes) {
            const r = new BinaryReader(bytes);
            const fields = new Map();
            for (let p = 0; p < bytes.length;) {
                r.range(p, 4);
                const id = r.u16(p), length = r.u16(p + 2);
                if (fields.has(id)) {
                    fail("ERR_FORMAT", `Duplicate ZIP extra field: ${id}.`);
                }
                fields.set(id, r.slice(p + 4, length));
                p += 4 + length;
            }
            return fields;
        }

        // Original implementation of the reflected CRC-32/ISO-HDLC recurrence.
        // Generate the table from the polynomial rather than embedding a copied table.

        const table = Uint32Array.from({ length: 256 }, (_, value) => {
            let remainder = value;
            for (let bit = 0; bit < 8; bit++) {
                remainder = (remainder >>> 1) ^ ((remainder & 1) ? 0xedb88320 : 0);
            }
            return remainder >>> 0;
        });

        function crc32(bytes) {
            let remainder = 0xffffffff;
            for (let i = 0; i < bytes.length; i++) {
                remainder = (remainder >>> 8) ^ table[(remainder ^ bytes[i]) & 0xff];
            }
            return (remainder ^ 0xffffffff) >>> 0;
        }

        /** Reject unsafe names, rather than normalize them into a different filename. */
        function validatePath(name) {
            if (typeof name !== "string" || name.length === 0) {
                fail("ERR_PATH", "Entry names must be nonempty strings.");
            }
            // ZIP paths cannot contain control characters.
            // eslint-disable-next-line no-control-regex
            if (name.startsWith("/") || /[\\:\u0000-\u001f\u007f]/u.test(name)) {
                fail("ERR_PATH", `Unsafe entry path: ${JSON.stringify(name)}.`);
            }
            const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
            for (const part of parts) {
                if (!part || part === "." || part === ".." || /[. ]$/u.test(part) ||
                /[<>"|?*]/u.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) {
                    fail("ERR_PATH", `Unsafe or nonportable entry path: ${JSON.stringify(name)}.`);
                }
            }
            return name;
        }

        /** Catch duplicate names and file/directory conflicts in either insertion order. */
        class PathIndex {
            #files = new Set();
            #directories = new Set();
            #explicit = new Set();

            add(name, directory) {
                const key = name.endsWith("/") ? name.slice(0, -1) : name;
                if (this.#explicit.has(key)) {
                    fail("ERR_DUPLICATE", `Duplicate entry: ${name}.`);
                }
                if ((directory && this.#files.has(key)) || (!directory && this.#directories.has(key))) {
                    fail("ERR_PATH", `File/directory conflict: ${name}.`);
                }
                const parts = key.split("/");
                let ancestor = "";
                for (let i = 0; i < parts.length - 1; i++) {
                    ancestor = ancestor ? `${ancestor}/${parts[i]}` : parts[i];
                    if (this.#files.has(ancestor)) {
                        fail("ERR_PATH", `A parent path is a file: ${ancestor}.`);
                    }
                    this.#directories.add(ancestor);
                }
                this.#explicit.add(key);
                (directory ? this.#directories : this.#files).add(key);
            }
        }

        // Encoding data for legacy ZIP filenames: CP437 bytes 128-255.

        const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

        function decodeLegacy(bytes) {
            let result = "";
            for (const value of bytes) {
                result += value < 128 ? String.fromCharCode(value) : CP437_HIGH[value - 128];
            }
            return result;
        }

        function decodeName(bytes, flags, fields, unicodeId = 0x7075) {
            if (flags & 0x0800) {
                return decodeUTF8(bytes);
            }
            const unicode = fields.get(unicodeId);
            if (unicode?.length >= 5 && unicode[0] === 1) {
                const reader = new BinaryReader(unicode);
                if (reader.u32(1) === crc32(bytes)) {
                    return decodeUTF8(unicode.subarray(5));
                }
            }
            return decodeLegacy(bytes);
        }

        function decodeArchiveComment(bytes) {
            try {
                return decodeUTF8(bytes);
            } catch {
                return decodeLegacy(bytes);
            }
        }

        function encodeDate(value) {
            // A fixed default makes archives reproducible; file timestamps are opt-in.

            if (value === undefined) {
                return { date: 33, time: 0, extra: new Uint8Array(0) };
            }
            if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
                fail("ERR_ARGUMENT", "mtime must be a valid Date.");
            }
            const year = value.getFullYear();
            if (year < 1980 || year > 2107) {
                fail("ERR_ARGUMENT", "mtime must be in the DOS date range 1980..2107.");
            }
            const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
            const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
            const epoch = Math.floor(value.getTime() / 1000);
            let extra = new Uint8Array(0);
            if (epoch >= 0 && epoch <= 0xffffffff) {
                extra = new Uint8Array(9);
                const view = new DataView(extra.buffer);
                view.setUint16(0, 0x5455, true);
                view.setUint16(2, 5, true);
                extra[4] = 1;
                view.setUint32(5, epoch, true);
            }
            return { date, time, extra };
        }

        function decodeDate(date, time, fields) {
            const timestamp = fields.get(0x5455);
            if (timestamp?.length >= 5 && (timestamp[0] & 1)) {
                return new BinaryReader(timestamp).u32(1) * 1000;
            }
            if (date === 0) {
                return null;
            }
            const year = 1980 + (date >>> 9), month = ((date >>> 5) & 15) - 1;
            const day = date & 31, hour = time >>> 11, minute = (time >>> 5) & 63, second = (time & 31) * 2;
            if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
                return null;
            }
            const result = new Date(year, month, day, hour, minute, second);
            if (result.getFullYear() !== year || result.getMonth() !== month || result.getDate() !== day) {
                return null;
            }
            return result.getTime();
        }

        function compressionName(method) {
            return ({ 0: "store", 8: "deflate" })[method] ?? `method-${method}`;
        }

        function compressionId(name) {
            if (name === "auto") {
                return 8;
            }
            const id = ({ store: 0, deflate: 8 })[name];
            if (typeof name !== "string" || !Number.isInteger(id)) {
                fail("ERR_ARGUMENT", "compression must be \"auto\", \"store\", or \"deflate\".");
            }
            return id;
        }

        class Bits {
            constructor(bytes) {
                this.bytes = bytes;
                this.position = 0;
            }
            read(width) {
                if (this.position + width > this.bytes.length * 8) {
                    fail("ERR_FORMAT", "Truncated DEFLATE bitstream.");
                }
                let result = 0;
                for (let shift = 0; shift < width; shift++, this.position++) {
                    const byte = this.bytes[Math.floor(this.position / 8)];
                    result |= ((byte >>> (this.position % 8)) & 1) << shift;
                }
                return result;
            }
            skipBytes(length) {
                const end = this.position + length * 8;
                if (end > this.bytes.length * 8) {
                    fail("ERR_FORMAT", "Truncated stored DEFLATE block.");
                }
                this.position = end;
            }
        }

        // Build canonical codes by walking symbols in (width, symbol) order.
        // The maps are bounded by the format's alphabet sizes, never output size.

        function alphabet(lengths) {
            const symbols = Array.from(lengths, (width, symbol) => ({ width, symbol }))
                .filter(item => item.width > 0).sort((a, b) => a.width - b.width || a.symbol - b.symbol);
            const maps = Array.from({ length: 16 }, () => new Map());
            let code = 0, width = 0;
            for (const item of symbols) {
                code *= 2 ** (item.width - width);
                width = item.width;
                if (width > 15 || code >= 2 ** width) {
                    fail("ERR_FORMAT", "Oversubscribed DEFLATE Huffman alphabet.");
                }
                maps[width].set(code++, item.symbol);
            }
            return {
                read(bits) {
                    let code = 0;
                    for (let length = 1; length <= width; length++) {
                        code = code * 2 + bits.read(1);
                        const value = maps[length].get(code);
                        if (value !== undefined) {
                            return value;
                        }
                    }
                    fail("ERR_FORMAT", "Invalid DEFLATE Huffman code.");
                },
            };
        }

        const fixedLiterals = alphabet(Array.from({ length: 288 }, (_, symbol) =>
            symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8));
        const fixedDistances = alphabet(new Array(32).fill(5));
        const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

        function dynamicAlphabets(bits) {
            const literalCount = bits.read(5) + 257, distanceCount = bits.read(5) + 1, orderCount = bits.read(4) + 4;
            if (literalCount > 286) {
                fail("ERR_FORMAT", "Invalid DEFLATE literal count.");
            }
            const codeLengths = new Array(19).fill(0);
            for (let i = 0; i < orderCount; i++) {
                codeLengths[codeLengthOrder[i]] = bits.read(3);
            }
            const lengthCodes = alphabet(codeLengths);
            const widths = [];
            const total = literalCount + distanceCount;
            while (widths.length < total) {
                const value = lengthCodes.read(bits);
                if (value <= 15) {
                    widths.push(value);
                    continue;
                }
                if (value === 16 && widths.length === 0) {
                    fail("ERR_FORMAT", "DEFLATE repeat has no previous code length.");
                }
                const repeatWidth = value === 16 ? widths[widths.length - 1] : 0;
                const count = value === 16 ? bits.read(2) + 3 : value === 17 ? bits.read(3) + 3 : bits.read(7) + 11;
                if (widths.length + count > total) {
                    fail("ERR_FORMAT", "DEFLATE code-length repeat exceeds alphabet size.");
                }
                for (let i = 0; i < count; i++) {
                    widths.push(repeatWidth);
                }
            }
            if (widths[256] === 0) {
                fail("ERR_FORMAT", "DEFLATE alphabet has no end-of-block symbol.");
            }
            return [alphabet(widths.slice(0, literalCount)), alphabet(widths.slice(literalCount))];
        }

        function matchLength(symbol, bits) {
            if (symbol === 285) {
                return 258;
            }
            if (symbol < 257 || symbol > 284) {
                fail("ERR_FORMAT", "Reserved DEFLATE length symbol.");
            }
            const index = symbol - 257;
            if (index < 8) {
                return index + 3;
            }
            const extra = Math.floor((index - 4) / 4);
            const base = 2 ** (extra + 2) + 3 + ((index - 8) % 4) * 2 ** extra;
            return base + bits.read(extra);
        }

        function matchDistance(symbol, bits) {
            if (symbol > 29) {
                fail("ERR_FORMAT", "Reserved DEFLATE distance symbol.");
            }
            if (symbol < 4) {
                return symbol + 1;
            }
            const extra = Math.floor(symbol / 2) - 1;
            return 2 ** (extra + 1) + 1 + (symbol % 2) * 2 ** extra + bits.read(extra);
        }

        /**
         * Walk the compressed structure without allocating decoded file content.
         * Browser streams do not expose bytes consumed, and some runtimes silently
         * accept trailing input. This validates the exact end boundary and size.
         * Actual inflation is still performed by the runtime's native codec.
         */
        function validateDeflate(bytes, maximum) {
            const bits = new Bits(bytes);
            let output = 0, final;
            do {
                final = bits.read(1);
                const type = bits.read(2);
                if (type === 0) {
                    bits.position = Math.ceil(bits.position / 8) * 8;
                    const length = bits.read(16), inverse = bits.read(16);
                    if ((length ^ inverse) !== 0xffff) {
                        fail("ERR_FORMAT", "Invalid stored DEFLATE block length.");
                    }
                    bits.skipBytes(length);
                    output += length;
                    within(output, maximum, "DEFLATE output");
                    continue;
                }
                if (type === 3) {
                    fail("ERR_FORMAT", "Reserved DEFLATE block type.");
                }
                const [literals, distances] = type === 1 ? [fixedLiterals, fixedDistances] : dynamicAlphabets(bits);
                while (true) {
                    const symbol = literals.read(bits);
                    if (symbol === 256) {
                        break;
                    }
                    if (symbol < 256) {
                        output++;
                    } else {
                        const length = matchLength(symbol, bits);
                        const distance = matchDistance(distances.read(bits), bits);
                        if (distance > output) {
                            fail("ERR_FORMAT", "DEFLATE back-reference exceeds available history.");
                        }
                        output += length;
                    }
                    within(output, maximum, "DEFLATE output");
                }
            } while (!final);
            if (Math.ceil(bits.position / 8) !== bytes.length) {
                fail("ERR_FORMAT", "Trailing bytes after the DEFLATE stream.");
            }
            return output;
        }

        const U32_MAX = 0xffffffff;

        function findEnd(reader) {
            const lower = Math.max(0, reader.bytes.length - 22 - 0xffff);
            for (let p = reader.bytes.length - 22; p >= lower; p--) {
                if (reader.u32(p) !== 0x06054b50 || p + 22 + reader.u16(p + 20) !== reader.bytes.length) {
                    continue;
                }
                // Avoid mistaking a signature inside the comment for an empty archive.

                if (reader.u16(p + 10) === 0 && (reader.u32(p + 12) !== 0 || reader.u32(p + 16) !== 0)) {
                    continue;
                }
                const hasLocator = p >= 20 && reader.u32(p - 20) === 0x07064b50;
                const size = reader.u32(p + 12), offset = reader.u32(p + 16);
                if (!hasLocator && size !== U32_MAX && offset !== U32_MAX && size + offset !== p) {
                    continue;
                }
                return p;
            }
            fail("ERR_FORMAT", "ZIP end record not found; trailing bytes and prefixed empty ZIPs are not supported.");
        }

        function readDirectoryLocation(r) {
            const end = findEnd(r);
            if (r.u16(end + 4) !== 0 || r.u16(end + 6) !== 0) {
                fail("ERR_UNSUPPORTED", "Split/multi-disk ZIP archives are not supported.");
            }
            const diskCount = r.u16(end + 8), classicCount = r.u16(end + 10);
            const classicSize = r.u32(end + 12), classicOffset = r.u32(end + 16);
            let count = classicCount, size = classicSize, offset = classicOffset, boundary = end;
            const needs64 = [diskCount, classicCount].includes(0xffff) || [classicSize, classicOffset].includes(U32_MAX);
            const zip64 = end >= 20 && r.u32(end - 20) === 0x07064b50;
            if (needs64 && !zip64) {
                fail("ERR_FORMAT", "Missing ZIP64 locator.");
            }
            if (zip64) {
                const locator = end - 20;
                if (r.u32(locator + 4) !== 0 || r.u32(locator + 16) !== 1) {
                    fail("ERR_UNSUPPORTED", "Split ZIP64 archives are not supported.");
                }
                const record = r.u64(locator + 8);
                r.range(record, 56, locator);
                if (r.u32(record) !== 0x06064b50) {
                    fail("ERR_FORMAT", "Missing ZIP64 end record.");
                }
                const recordSize = r.u64(record + 4);
                if (recordSize < 44 || recordSize !== locator - record - 12) {
                    fail("ERR_FORMAT", "Invalid ZIP64 end record length.");
                }
                if (r.u32(record + 16) !== 0 || r.u32(record + 20) !== 0) {
                    fail("ERR_UNSUPPORTED", "Split ZIP64 archives are not supported.");
                }
                count = r.u64(record + 32);
                if (r.u64(record + 24) !== count) {
                    fail("ERR_UNSUPPORTED", "Split ZIP64 entry counts are not supported.");
                }
                size = r.u64(record + 40);
                offset = r.u64(record + 48);
                for (const [classic, extended, marker] of [
                    [diskCount, count, 0xffff], [classicCount, count, 0xffff],
                    [classicSize, size, U32_MAX], [classicOffset, offset, U32_MAX],
                ]) {
                    if (classic !== marker && classic !== extended) {
                        fail("ERR_FORMAT", "ZIP64 and classic end records disagree.");
                    }
                }
                boundary = record;
            } else if (diskCount !== count) {
                fail("ERR_UNSUPPORTED", "Split ZIP entry counts are not supported.");
            }
            r.range(offset, size, boundary);
            if (size !== boundary - offset) {
                fail("ERR_FORMAT", "Central directory does not end at its declared boundary.");
            }
            if (count > Math.floor(size / 46)) {
                fail("ERR_FORMAT", "Entry count exceeds central directory capacity.");
            }
            if (count === 0 && (offset !== 0 || size !== 0)) {
                fail("ERR_FORMAT", "Nonempty data before an empty central directory.");
            }
            return { count, size, offset, zip64, comment: decodeArchiveComment(r.slice(end + 22, r.u16(end + 20))) };
        }

        function extendedValues(fields, size, compressedSize, offset, disk) {
            const required = size === U32_MAX || compressedSize === U32_MAX || offset === U32_MAX || disk === 0xffff;
            if (!required) {
                return { size, compressedSize, offset, disk };
            }
            const extra = fields.get(1);
            if (!extra) {
                fail("ERR_FORMAT", "Missing ZIP64 extended information.");
            }
            const r = new BinaryReader(extra);
            let p = 0;
            const next64 = () => {
                const value = r.u64(p);
                p += 8;
                return value;
            };
            if (size === U32_MAX) {
                size = next64();
            }
            if (compressedSize === U32_MAX) {
                compressedSize = next64();
            }
            if (offset === U32_MAX) {
                offset = next64();
            }
            if (disk === 0xffff) {
                disk = r.u32(p);
            }
            return { size, compressedSize, offset, disk };
        }

        function descriptorEnd(r, start, entry, wide, boundary) {
            const candidates = [];
            if (start + 4 <= boundary && r.u32(start) === 0x08074b50) {
                candidates.push(start + 4);
            }
            // A signature-shaped CRC can still belong to an unsigned descriptor.

            candidates.push(start);
            for (const p of candidates) {
                const length = wide ? 20 : 12;
                if (p + length > boundary || r.u32(p) !== entry.checksum) {
                    continue;
                }
                try {
                    const compressed = wide ? r.u64(p + 4) : r.u32(p + 4);
                    const size = wide ? r.u64(p + 12) : r.u32(p + 8);
                    if (compressed === entry.compressedSize && size === entry.size) {
                        return p + length;
                    }
                } catch (error) {
                    if (!(error instanceof ZipError)) {
                        throw error;
                    }
                }
            }
            fail("ERR_FORMAT", `Invalid or missing data descriptor: ${entry.name}.`);
        }

        function checkLocal(r, entry, centralOffset) {
            const p = entry.offset;
            r.range(p, 30, centralOffset);
            if (r.u32(p) !== 0x04034b50) {
                fail("ERR_FORMAT", `Missing local header: ${entry.name}.`);
            }
            if (r.u16(p + 6) !== entry.flags || r.u16(p + 8) !== entry.method) {
                fail("ERR_FORMAT", `Local/central method or flags mismatch: ${entry.name}.`);
            }
            const nameLength = r.u16(p + 26), extraLength = r.u16(p + 28);
            r.range(p + 30, nameLength + extraLength, centralOffset);
            const rawName = r.slice(p + 30, nameLength);
            if (!equal(rawName, entry.rawName)) {
                fail("ERR_FORMAT", `Local/central filename mismatch: ${entry.name}.`);
            }
            const fields = extraFields(r.slice(p + 30 + nameLength, extraLength));
            entry.zip64 ||= fields.has(1);
            if (fields.has(0x7075) && decodeName(rawName, entry.flags, fields) !== entry.name) {
                fail("ERR_FORMAT", `Conflicting Unicode filename: ${entry.name}.`);
            }
            const rawCompressed = r.u32(p + 18), rawSize = r.u32(p + 22);
            const local = extendedValues(fields, rawSize, rawCompressed, 0, 0);
            const hasDescriptor = Boolean(entry.flags & 8);
            const checksum = r.u32(p + 14);
            if (hasDescriptor) {
                if ((checksum !== 0 && checksum !== entry.checksum) ||
                (local.size !== 0 && local.size !== entry.size) ||
                (local.compressedSize !== 0 && local.compressedSize !== entry.compressedSize)) {
                    fail("ERR_FORMAT", `Local placeholder values conflict with central metadata: ${entry.name}.`);
                }
            } else if (checksum !== entry.checksum || local.size !== entry.size || local.compressedSize !== entry.compressedSize) {
                fail("ERR_FORMAT", `Local/central CRC or sizes mismatch: ${entry.name}.`);
            }
            entry.dataStart = p + 30 + nameLength + extraLength;
            r.range(entry.dataStart, entry.compressedSize, centralOffset);
            entry.dataEnd = entry.dataStart + entry.compressedSize;
            entry.recordEnd = hasDescriptor
                ? descriptorEnd(r, entry.dataEnd, entry, entry.wide || rawSize === U32_MAX || rawCompressed === U32_MAX || fields.has(1), centralOffset)
                : entry.dataEnd;
        }

        function parse(r, limits) {
            const directory = readDirectoryLocation(r);
            within(directory.count, limits.maxEntries, "Entry count");
            const entries = [], paths = new PathIndex();
            const boundary = directory.offset + directory.size;
            let p = directory.offset, totalSize = 0;
            for (let index = 0; index < directory.count; index++) {
                r.range(p, 46, boundary);
                if (r.u32(p) !== 0x02014b50) {
                    fail("ERR_FORMAT", "Invalid central directory signature.");
                }
                const flags = r.u16(p + 8), method = r.u16(p + 10);
                if (flags & 0x2041) {
                    fail("ERR_UNSUPPORTED", "Encrypted ZIP entries are not supported.");
                }
                if (flags & ~0x080e) {
                    fail("ERR_UNSUPPORTED", `Unsupported ZIP general-purpose flags: ${flags}.`);
                }
                const nameLength = r.u16(p + 28), extraLength = r.u16(p + 30), commentLength = r.u16(p + 32);
                r.range(p + 46, nameLength + extraLength + commentLength, boundary);
                const rawName = r.slice(p + 46, nameLength);
                const fields = extraFields(r.slice(p + 46 + nameLength, extraLength));
                const name = validatePath(decodeName(rawName, flags, fields));
                const attributes = r.u32(p + 38), creator = r.u16(p + 4) >>> 8;
                const fileType = (creator === 3 || creator === 19) ? (attributes >>> 16) & 0xf000 : 0;
                if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
                    fail("ERR_UNSUPPORTED", `Symlinks and special files are not supported: ${name}.`);
                }
                const isDirectory = name.endsWith("/") || Boolean(attributes & 16) || fileType === 0x4000;
                paths.add(name, isDirectory);
                const size32 = r.u32(p + 24), compressed32 = r.u32(p + 20);
                const sizes = extendedValues(fields, size32, compressed32, r.u32(p + 42), r.u16(p + 34));
                if (sizes.disk !== 0) {
                    fail("ERR_UNSUPPORTED", "Split ZIP entries are not supported.");
                }
                within(sizes.size, limits.maxEntrySize, `Entry ${name}`);
                totalSize += sizes.size;
                within(totalSize, limits.maxTotalSize, "Total uncompressed size");
                if (sizes.size / Math.max(sizes.compressedSize, 1) > limits.maxCompressionRatio) {
                    fail("ERR_LIMIT", `Compression ratio exceeds the configured limit: ${name}.`);
                }
                if (method === 0 && sizes.size !== sizes.compressedSize) {
                    fail("ERR_FORMAT", "Stored entry sizes must match.");
                }
                if (isDirectory && sizes.size !== 0) {
                    fail("ERR_FORMAT", `Directory entry has file content: ${name}.`);
                }
                const entry = {
                    name, rawName, flags, method, isDirectory, ...sizes,
                    checksum: r.u32(p + 16), zip64: fields.has(1), wide: size32 === U32_MAX || compressed32 === U32_MAX,
                    comment: decodeName(r.slice(p + 46 + nameLength + extraLength, commentLength), flags, fields, 0x6375),
                    timestamp: decodeDate(r.u16(p + 14), r.u16(p + 12), fields),
                };
                checkLocal(r, entry, directory.offset);
                entries.push(entry);
                p += 46 + nameLength + extraLength + commentLength;
            }
            if (p !== boundary) {
                fail("ERR_UNSUPPORTED", "Unexpected central directory data (including digital signatures) is not supported.");
            }
            const ordered = [...entries].sort((a, b) => a.offset - b.offset);
            let previousEnd = 0;
            if (ordered.length && ordered[0].offset !== 0) {
                fail("ERR_UNSUPPORTED", "Prefixed/self-extracting ZIP archives are not supported.");
            }
            for (const entry of ordered) {
                if (entry.offset < previousEnd) {
                    fail("ERR_FORMAT", "Overlapping ZIP entry records.");
                }
                previousEnd = entry.recordEnd;
            }
            return { entries, totalSize, comment: directory.comment, zip64: directory.zip64 || entries.some(entry => entry.zip64) };
        }

        class ZipEntry {
            #record;
            #bytes;
            #limits;
            constructor(record, bytes, limits) {
                this.#record = record;
                this.#bytes = bytes;
                this.#limits = limits;
                Object.freeze(this);
            }
            get name() {
                return this.#record.name;
            }
            get size() {
                return this.#record.size;
            }
            get compressedSize() {
                return this.#record.compressedSize;
            }
            get isDirectory() {
                return this.#record.isDirectory;
            }
            get compression() {
                return compressionName(this.#record.method);
            }
            get method() {
                return this.#record.method;
            }
            get crc32() {
                return this.#record.checksum;
            }
            get comment() {
                return this.#record.comment;
            }
            get mtime() {
                return this.#record.timestamp === null ? null : new Date(this.#record.timestamp);
            }

            async bytes(options) {
                const opts = checkOptions(options, ["maxSize", "signal"]);
                const maximum = opts.maxSize === undefined ? this.#limits.maxEntrySize
                    : Math.min(integer(opts.maxSize, "maxSize"), this.#limits.maxEntrySize);
                checkAbort(opts.signal);
                within(this.size, maximum, `Entry ${this.name}`);
                const record = this.#record;
                const compressed = this.#bytes.subarray(record.dataStart, record.dataEnd);
                let output;
                if (record.method === 0) {
                    output = new Uint8Array(compressed);
                } else {
                    if (record.method !== 8) {
                        fail("ERR_UNSUPPORTED", `Unsupported ZIP compression method: ${record.method}.`);
                    }
                    output = await transform(compressed, "decompress", {
                        // Enforce the declared size during inflation, not after an unbounded allocation.

                        maxOutputSize: Math.min(maximum, this.size), signal: opts.signal,
                    });
                }
                checkAbort(opts.signal);
                if (output.length !== this.size) {
                    fail("ERR_FORMAT", `Uncompressed size mismatch: ${this.name}.`);
                }
                if (crc32(output) !== this.crc32) {
                    fail("ERR_CRC", `CRC-32 mismatch: ${this.name}.`);
                }
                return output;
            }

            async text(options) {
                const opts = checkOptions(options, ["maxSize", "signal", "encoding", "fatal"]);
                if (opts.fatal !== undefined && typeof opts.fatal !== "boolean") {
                    fail("ERR_ARGUMENT", "fatal must be a boolean.");
                }
                if (opts.encoding !== undefined && typeof opts.encoding !== "string") {
                    fail("ERR_ARGUMENT", "encoding must be a string.");
                }
                let decoder;
                try {
                    decoder = new TextDecoder(opts.encoding ?? "utf-8", { fatal: opts.fatal ?? false });
                } catch (cause) {
                    throw new ZipError("ERR_ARGUMENT", "Unsupported text encoding.", { cause });
                }
                const bytes = await this.bytes({ maxSize: opts.maxSize, signal: opts.signal });
                try {
                    return decoder.decode(bytes);
                } catch (cause) {
                    throw new ZipError("ERR_ENCODING", `Invalid text encoding in ${this.name}.`, { cause });
                }
            }

            async arrayBuffer(options) {
                return (await this.bytes(options)).buffer;
            }

            async blob(options) {
                const opts = checkOptions(options, ["maxSize", "signal", "type"]);
                if (opts.type !== undefined && typeof opts.type !== "string") {
                    fail("ERR_ARGUMENT", "type must be a string.");
                }
                if (typeof Blob === "undefined") {
                    fail("ERR_UNSUPPORTED", "Blob is not available in this runtime.");
                }
                return new Blob([await this.bytes({ maxSize: opts.maxSize, signal: opts.signal })], { type: opts.type ?? "" });
            }
        }

        class ZipArchive {
            #entries;
            #byName;
            #comment;
            #totalSize;
            #zip64;
            constructor(parsed, bytes, limits) {
                this.#entries = Object.freeze(parsed.entries.map(record => new ZipEntry(record, bytes, limits)));
                this.#byName = new Map(this.#entries.map(entry => [entry.name, entry]));
                this.#comment = parsed.comment;
                this.#totalSize = parsed.totalSize;
                this.#zip64 = parsed.zip64;
                Object.freeze(this);
            }
            get entries() {
                return this.#entries;
            }
            get size() {
                return this.#entries.length;
            }
            get totalSize() {
                return this.#totalSize;
            }
            get comment() {
                return this.#comment;
            }
            get zip64() {
                return this.#zip64;
            }
            names() {
                return this.#entries.map(entry => entry.name);
            }
            get(name) {
                if (typeof name !== "string") {
                    fail("ERR_ARGUMENT", "Entry name must be a string.");
                }
                return this.#byName.get(name);
            }
            has(name) {
                return this.get(name) !== undefined;
            }
            #require(name) {
                const entry = this.get(name);
                if (!entry) {
                    fail("ERR_NOT_FOUND", `ZIP entry not found: ${name}.`);
                }
                return entry;
            }
            async read(name, options) {
                return this.#require(name).bytes(options);
            }
            async text(name, options) {
                return this.#require(name).text(options);
            }
            async verify(options) {
                const opts = checkOptions(options, ["signal"]);
                checkAbort(opts.signal);
                for (const entry of this.#entries) {
                    await entry.bytes(opts);
                }
            }
            [Symbol.iterator]() {
                return this.#entries[Symbol.iterator]();
            }
        }

        async function openZip(input, options) {
            const opts = checkOptions(options, ["limits", "signal"]);
            const limits = resolveLimits(opts.limits);
            const bytes = await toBytes(input, limits.maxArchiveSize, opts.signal);
            checkAbort(opts.signal);
            const parsed = parse(new BinaryReader(bytes), limits);
            return new ZipArchive(parsed, bytes, limits);
        }

        async function readInputStream(input, maxSize, signal) {
            if (input.locked) {
                fail("ERR_ARGUMENT", "The input stream is already being read.");
            }
            const reader = input.getReader();
            const abort = () => {
                void reader.cancel(signal.reason).catch(() => {});
            };
            signal?.addEventListener("abort", abort, { once: true });
            const parts = [];
            let size = 0;
            try {
                while (true) {
                    checkAbort(signal);
                    const { value, done } = await reader.read();
                    checkAbort(signal);
                    if (done) {
                        return concat(parts, size);
                    }
                    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
                        fail("ERR_ARGUMENT", "Input streams must contain binary chunks.");
                    }
                    size += value.byteLength;
                    within(size, maxSize, "Input stream");
                    parts.push(await toBytes(value, maxSize, signal));
                }
            } catch (cause) {
                try {
                    await reader.cancel(cause);
                } catch {
                // Preserve the input or limit error if cancellation also fails.

                }
                checkAbort(signal);
                if (cause instanceof ZipError) {
                    throw cause;
                }
                throw new ZipError("ERR_ARGUMENT", "Could not read the ZIP input stream.", { cause });
            } finally {
                signal?.removeEventListener("abort", abort);
                reader.releaseLock();
            }
        }

        function supportsDeflate(operation) {
            const Constructor = operation === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
            if (!Constructor) {
                return false;
            }
            try {
                new Constructor("deflate-raw");
                return true;
            } catch {
                return false;
            }
        }

        async function transform(input, operation, { maxOutputSize, signal }) {
            checkAbort(signal);
            if (!supportsDeflate(operation)) {
                fail("ERR_UNSUPPORTED", `This browser cannot ${operation} DEFLATE ZIP entries. Use a current browser or a stored ZIP.`);
            }
            if (operation === "decompress") {
                validateDeflate(input, maxOutputSize);
            }
            let position = 0;
            const source = new ReadableStream({
                pull(controller) {
                    if (position === input.length) {
                        controller.close();
                        return;
                    }
                    const end = Math.min(position + 64 * 1024, input.length);
                    controller.enqueue(input.subarray(position, end));
                    position = end;
                },
            });
            const Constructor = operation === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
            const reader = source.pipeThrough(new Constructor("deflate-raw"), { signal }).getReader();
            const parts = [];
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    checkAbort(signal);
                    if (done) {
                        return concat(parts, size);
                    }
                    size += value.byteLength;
                    within(size, maxOutputSize, "Codec output");
                    parts.push(value);
                }
            } catch (cause) {
                try {
                    await reader.cancel(cause);
                } catch {
                // Preserve the codec or limit error if cancellation also fails.

                }
                checkAbort(signal);
                if (cause instanceof ZipError) {
                    throw cause;
                }
                throw new ZipError(operation === "decompress" ? "ERR_FORMAT" : "ERR_CODEC", `DEFLATE ${operation} failed.`, { cause });
            } finally {
                reader.releaseLock();
            }
        }

        function* inputEntries(files) {
            if (files instanceof Map) {
                for (const [name, content] of files) {
                    yield { name, content };
                }
                return;
            }
            if (Array.isArray(files)) {
                for (const entry of files) {
                    yield checkOptions(entry, ["name", "content", "compression", "mtime", "comment"], "entry");
                }
                return;
            }
            if (files && (Object.getPrototypeOf(files) === Object.prototype || Object.getPrototypeOf(files) === null)) {
                for (const name of Object.keys(files)) {
                    yield { name, content: files[name] };
                }
                return;
            }
            fail("ERR_ARGUMENT", "files must be a filename-to-content object, Map, or array of entry descriptors.");
        }

        function zip32(value, label) {
            if (value >= 0xffffffff) {
                fail("ERR_ZIP64_REQUIRED", `${label} requires ZIP64 writing, which is not supported.`);
            }
        }

        /** Create a classic ZIP as bytes. Streams are bounded inputs, not streaming output. */
        async function createZip(files, options) {
            const opts = checkOptions(options, ["compression", "comment", "limits", "signal"]);
            const limits = resolveLimits(opts.limits);
            const defaultCompression = opts.compression ?? "auto";
            compressionId(defaultCompression);
            checkAbort(opts.signal);
            const archiveComment = encodeMetadata(opts.comment ?? "", "Archive comment");
            const paths = new PathIndex();
            const localParts = [];
            const centralParts = [];
            let localSize = 0;
            let centralSize = 0;
            let totalSize = 0;
            let count = 0;
            within(22 + archiveComment.length, limits.maxArchiveSize, "Archive");

            for (const entry of inputEntries(files)) {
                checkAbort(opts.signal);
                count++;
                within(count, limits.maxEntries, "Entry count");
                if (count >= 0xffff) {
                    fail("ERR_ZIP64_REQUIRED", "65,535 or more entries require ZIP64 writing.");
                }
                const name = validatePath(entry.name);
                const directory = name.endsWith("/");
                paths.add(name, directory);
                const nameBytes = encodeMetadata(name, "Filename");
                const comment = encodeMetadata(entry.comment ?? "", "Entry comment");
                const stamp = encodeDate(entry.mtime);
                const compression = entry.compression ?? defaultCompression;
                let method = compressionId(compression);
                const input = await toBytes(
                    entry.content === undefined && directory ? new Uint8Array(0) : entry.content,
                    Math.min(limits.maxEntrySize, limits.maxTotalSize - totalSize), opts.signal, true,
                );
                if (directory && input.length) {
                    fail("ERR_ARGUMENT", `Directory entry must be empty: ${name}.`);
                }
                totalSize += input.length;
                zip32(input.length, "Entry size");

                const headerSize = 30 + nameBytes.length + stamp.extra.length;
                const directorySize = 46 + nameBytes.length + stamp.extra.length + comment.length;
                const overhead = localSize + centralSize + headerSize + directorySize + 22 + archiveComment.length;
                within(overhead, limits.maxArchiveSize, "Archive");
                if (input.length === 0 || (compression === "auto" && (input.length < 64 || !supportsDeflate("compress")))) {
                    method = 0;
                }
                let data = input;
                if (method === 8) {
                    try {
                        data = await transform(input, "compress", {
                            signal: opts.signal,
                            maxOutputSize: Math.min(limits.maxArchiveSize - overhead, 0xfffffffe),
                        });
                    } catch (error) {
                        // DEFLATE can grow incompressible data past the output budget even
                        // when storing the original bytes still fits that budget.

                        if (compression !== "auto" || error.code !== "ERR_LIMIT" || input.length > limits.maxArchiveSize - overhead) {
                            throw error;
                        }
                        method = 0;
                        data = input;
                    }
                    // Already-compressed or incompressible content is smaller in STORE mode.

                    if (compression === "auto" && data.length >= input.length) {
                        method = 0;
                        data = input;
                    }
                }
                within(overhead + data.length, limits.maxArchiveSize, "Archive");
                zip32(data.length, "Compressed entry size");
                if (input.length / Math.max(data.length, 1) > limits.maxCompressionRatio) {
                    fail("ERR_LIMIT", `Compression ratio exceeds the configured limit: ${name}.`);
                }
                const checksum = crc32(input);
                const version = method === 0 && !directory ? 10 : 20;
                const local = new Uint8Array(headerSize);
                const lv = new DataView(local.buffer);
                lv.setUint32(0, 0x04034b50, true);
                lv.setUint16(4, version, true);
                lv.setUint16(6, 0x0800, true);
                lv.setUint16(8, method, true);
                lv.setUint16(10, stamp.time, true);
                lv.setUint16(12, stamp.date, true);
                lv.setUint32(14, checksum, true);
                lv.setUint32(18, data.length, true);
                lv.setUint32(22, input.length, true);
                lv.setUint16(26, nameBytes.length, true);
                lv.setUint16(28, stamp.extra.length, true);
                local.set(nameBytes, 30);
                local.set(stamp.extra, 30 + nameBytes.length);

                const central = new Uint8Array(directorySize);
                const cv = new DataView(central.buffer);
                cv.setUint32(0, 0x02014b50, true);
                // Unix creator with ordinary file/directory modes.

                cv.setUint16(4, (3 << 8) | version, true);
                central.set(local.subarray(4, 30), 6);
                cv.setUint16(32, comment.length, true);
                cv.setUint32(38, (((directory ? 0o40755 : 0o100644) << 16) | (directory ? 16 : 0)) >>> 0, true);
                cv.setUint32(42, localSize, true);
                central.set(nameBytes, 46);
                central.set(stamp.extra, 46 + nameBytes.length);
                central.set(comment, 46 + nameBytes.length + stamp.extra.length);
                localParts.push(local, data);
                centralParts.push(central);
                localSize += local.length + data.length;
                centralSize += central.length;
                zip32(localSize, "Central directory offset");
                zip32(centralSize, "Central directory size");
            }

            checkAbort(opts.signal);
            const end = new Uint8Array(22 + archiveComment.length);
            const ev = new DataView(end.buffer);
            ev.setUint32(0, 0x06054b50, true);
            ev.setUint16(8, count, true);
            ev.setUint16(10, count, true);
            ev.setUint32(12, centralSize, true);
            ev.setUint32(16, localSize, true);
            ev.setUint16(20, archiveComment.length, true);
            end.set(archiveComment, 22);
            zip32(localSize + centralSize + end.length, "Archive size");
            return concat([...localParts, ...centralParts, end], localSize + centralSize + end.length);
        }

        /** Create and download a ZIP. Entries use { name, content }. */
        const zip = async (files, filename = `archive-${getTimestamp()}.zip`, options) => {
            const blob = await zip.create(files, options);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            try {
                anchor.click();
            } finally {
                anchor.remove();
                // Let the browser start the download before releasing its URL.
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        };

        /** Return a ZIP Blob without downloading it. */
        zip.create = async (files, options) => {
            return new Blob([await createZip(files, options)], { type: "application/zip" });
        };

        /** Index a ZIP; entries are decompressed and CRC-checked when read. */
        zip.open = async (input, options) => {
            return openZip(input, options);
        };

        return zip;
    })();

    document.addEventListener("keydown", closeAsideDrawerOnEscape);

    return { alert, prompt, confirm, copy, getTimestamp, storage, compress, decompress, zip };
})();
