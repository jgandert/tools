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

    const createDialog = (titleText, bodyContent, buttons) => {
        const title = createElement("h3", { id: "one-dialog-title" }, [titleText]);
        const header = createElement("header", {}, [title]);
        const body = typeof bodyContent === "string"
            ? createElement("p", { id: "one-dialog-desc" }, [bodyContent])
            : bodyContent;
        const footer = createElement("footer", {}, buttons);
        const article = createElement("article", {}, [header, body, footer]);
        const dialog = createElement("dialog", {
            "aria-labelledby": "one-dialog-title",
            "aria-modal": "true",
        }, [article]);

        if (typeof bodyContent === "string") {
            dialog.setAttribute("aria-describedby", "one-dialog-desc");
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
            const p = createElement("p", { id: "one-dialog-desc" }, [message]);
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

    const alert = (message, duration = 3000) => {
        let container = document.getElementById("one-toast-container");
        if (!container) {
            container = createElement("div", { id: "one-toast-container" });
            if (typeof container.showPopover === "function") {
                container.setAttribute("popover", "manual");
            }
            document.body.appendChild(container);
            if (typeof container.showPopover === "function") {
                container.showPopover();
            }
        }

        const toast = createElement("div", { className: "toast" }, [message]);
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
                    alert("Copy failed");
                }
            }
        } catch (err) {
            console.error("Fallback copy failed", err);
            if (!silent) {
                alert("Copy failed");
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

    document.addEventListener("keydown", closeAsideDrawerOnEscape);

    return { alert, prompt, confirm, copy, getTimestamp, storage };
})();

