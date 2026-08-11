importScripts("grid_optimizer.js");

self.onmessage = ({ data: parsed }) => {
    try {
        const raw = optimizeGrid(parsed, { seed: parsed.config.seed });
        if (raw.error) {
            throw new Error(raw.error);
        }
        self.postMessage({ result: gridResultToLayout(raw, parsed.warnings || []) });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
