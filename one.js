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

            const cleanup = (result) => {
                dialog.close();
                dialog.remove();
                resolve(result);
            };

            btnCancel.onclick = () => cleanup(false);
            btnConfirm.onclick = () => cleanup(true);

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

            const cleanup = (result) => {
                dialog.close();
                dialog.remove();
                resolve(result);
            };

            btnCancel.onclick = () => cleanup(null);
            btnConfirm.onclick = () => cleanup(input.value);

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

        setTimeout(() => {
            toast.classList.remove("show");
            toast.addEventListener("transitionend", () => toast.remove());
        }, duration);
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
         * Compress text into a Base64URL string formatted as a URL parameter.
         * @param {string} text - Input text to compress.
         * @param {string} [param="z"] - Parameter key name (pass null for bare Base64URL).
         * @returns {Promise<string>} e.g. "z=eJz..."
         */
        url: async (text, param = "z") => {
            if (!text) return "";
            if (typeof CompressionStream === "undefined") {
                return param ? `${param}=${encodeURIComponent(text)}` : encodeURIComponent(text);
            }
            try {
                const bytes = new TextEncoder().encode(text);
                const cs = new ReadableStream({
                    start(c) { c.enqueue(bytes); c.close(); }
                }).pipeThrough(new CompressionStream("deflate-raw"));
                const buf = await new Response(cs).arrayBuffer();
                const u8 = new Uint8Array(buf);
                let bin = "";
                for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
                const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
                return param ? `${param}=${b64}` : b64;
            } catch (err) {
                console.error("one.compress.url error:", err);
                return param ? `${param}=${encodeURIComponent(text)}` : encodeURIComponent(text);
            }
        }
    };

    const decompress = {
        /**
         * Extract and decompress a Base64URL payload from a hash, URL, or string.
         * @param {string} input - location.hash, full URL, or parameter string.
         * @param {string} [param="z"] - Parameter key to extract.
         * @returns {Promise<string|null>} Decompressed string or null on failure.
         */
        url: async (input, param = "z") => {
            if (!input) return null;
            let b64 = input;
            if (param) {
                const str = input.replace(/^[^?#]*[?#]/, "");
                b64 = new URLSearchParams(str).get(param);
                if (!b64) return null;
            }
            if (typeof DecompressionStream === "undefined") {
                try {
                    return decodeURIComponent(b64);
                } catch {
                    return null;
                }
            }
            b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) b64 += "=";
            try {
                const bin = atob(b64);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                const ds = new ReadableStream({
                    start(c) { c.enqueue(u8); c.close(); }
                }).pipeThrough(new DecompressionStream("deflate-raw"));
                const buf = await new Response(ds).arrayBuffer();
                return new TextDecoder().decode(buf);
            } catch {
                try {
                    return decodeURIComponent(b64);
                } catch {
                    return null;
                }
            }
        }
    };

    document.addEventListener("keydown", closeAsideDrawerOnEscape);

    return { alert, prompt, confirm, copy, getTimestamp, storage, compress, decompress };
})();
