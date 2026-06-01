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

    return { alert, prompt, confirm, copy };
})();
