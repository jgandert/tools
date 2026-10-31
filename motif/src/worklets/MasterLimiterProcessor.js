// The detector oversamples only the sidechain; audio stays at its native rate.
// A shared gain envelope preserves stereo balance and leaves quiet audio intact.

const TAPS = 128;
const HALF = TAPS / 2;
const PHASES = 8;
// Reserve headroom for finite reconstruction filters and the gain envelope.
const GUARD_DB = 0.9;

const kernels = Array.from({ length: PHASES - 1 }, (_, phase) => {
    const coefficients = new Float64Array(TAPS);
    let sum = 0;
    for (let tap = 0; tap < TAPS; tap++) {
        const x = tap - (HALF - 1) - (phase + 1) / PHASES;
        const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
        const window = 0.42 + 0.5 * Math.cos(Math.PI * x / HALF) + 0.08 * Math.cos(2 * Math.PI * x / HALF);
        coefficients[tap] = sinc * window;
        sum += coefficients[tap];
    }
    for (let tap = 0; tap < TAPS; tap++) coefficients[tap] /= sum;
    return coefficients;
});

class MasterLimiterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: "ceiling",
                defaultValue: -1,
                minValue: -24,
                maxValue: -1,
                automationRate: "k-rate",
            },
            {
                name: "release",
                defaultValue: 0.1,
                minValue: 0.01,
                maxValue: 2,
                automationRate: "k-rate",
            },
        ];
    }

    constructor() {
        super();
        this.attackFrames = Math.ceil(sampleRate * 0.005);
        this.latency = this.attackFrames + TAPS;
        let size = 1;
        while (size <= this.latency + TAPS) size *= 2;
        this.mask = size - 1;
        this.audio = [new Float32Array(size), new Float32Array(size)];
        this.peakValues = new Float64Array(size);
        this.peakTimes = new Float64Array(size);
        this.head = 0;
        this.tail = 0;
        this.gains = new Float64Array(this.attackFrames + 1).fill(1);
        this.gainSum = this.gains.length;
        this.gainPosition = 0;
        this.gain = 1;
        this.ceiling = null;
        this.frame = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        const ceiling = Math.pow(10, (parameters.ceiling[0] - GUARD_DB) / 20);
        const release = Math.exp(-1 / (parameters.release[0] * sampleRate));
        if (this.ceiling !== null && ceiling < this.ceiling) {
            const ratio = ceiling / this.ceiling;
            this.gain *= ratio;
            this.gainSum *= ratio;
            for (let i = 0; i < this.gains.length; i++) this.gains[i] *= ratio;
        }
        this.ceiling = ceiling;
        for (let i = 0; i < output[0].length; i++) {
            const n = this.frame++;
            const slot = n & this.mask;
            let peak = 0;
            for (let channel = 0; channel < 2; channel++) {
                const samples = input[channel] || input[0];
                const value = samples ? samples[i] : 0;
                const history = this.audio[channel];
                history[slot] = Number.isFinite(value) ? value : 0;
                peak = Math.max(peak, Math.abs(history[(n - HALF) & this.mask]));
                for (const kernel of kernels) {
                    let interpolated = 0;
                    for (let tap = 0; tap < TAPS; tap++) {
                        interpolated += kernel[tap] * history[(n - TAPS + 1 + tap) & this.mask];
                    }
                    peak = Math.max(peak, Math.abs(interpolated));
                }
            }

            // Sliding maximum plus a moving-average attack: every gain contributing
            // to an output sample has already seen that sample's interpolation support.

            while (this.head < this.tail && this.peakTimes[this.head & this.mask] < n - this.latency) this.head++;
            while (this.head < this.tail && this.peakValues[(this.tail - 1) & this.mask] <= peak) this.tail--;
            this.peakValues[this.tail & this.mask] = peak;
            this.peakTimes[this.tail & this.mask] = n;
            this.tail++;
            const maximum = this.peakValues[this.head & this.mask];
            const target = maximum > ceiling ? ceiling / maximum : 1;
            this.gain = Math.min(target, 1 - (1 - this.gain) * release);
            this.gainSum += this.gain - this.gains[this.gainPosition];
            this.gains[this.gainPosition] = this.gain;
            this.gainPosition = (this.gainPosition + 1) % this.gains.length;
            const gain = Math.max(0, Math.min(1, this.gainSum / this.gains.length));
            for (let channel = 0; channel < output.length; channel++) {
                output[channel][i] = this.audio[channel][(n - this.latency) & this.mask] * gain;
            }
        }
        return true;
    }
}

registerProcessor("master-limiter", MasterLimiterProcessor);
