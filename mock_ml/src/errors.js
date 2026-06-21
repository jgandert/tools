// Shared error type for malformed wireframe input.
// Carries `.pos` (char offset into source) so callers can locate the problem.
export class WireframeError extends Error {
    constructor(message, pos = -1) {
        super(pos >= 0 ? `${message} (at ${pos})` : message);
        this.name = "WireframeError";
        this.pos = pos;
    }
}
