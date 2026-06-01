class GranularStretcherProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: "stretchFactor", defaultValue: 1.0, minValue: 0.1, maxValue: 10.0 },
            { name: "pitchRatio", defaultValue: 1.0, minValue: 0.1, maxValue: 4.0 },
            { name: "grainSize", defaultValue: 0.05 },
            { name: "overlap", defaultValue: 4 }
        ];
    }

    constructor() {
        super();
        this.leftBuffer = null;
        this.rightBuffer = null;
        this.grains = [];
        this.virtualReadPointer = 0;
        this.outputSampleCount = 0;
        this.lastSpawnCount = -Infinity;
        this._startTime = null;
        this._endTime = null;
        this._done = false;

        this.port.onmessage = ({ data }) => {
            if (data.leftBuffer) {
                this.leftBuffer = data.leftBuffer;
                this.rightBuffer = data.rightBuffer || data.leftBuffer;
            }
            if (data.type === "START") {
                this._startTime = data.startTime;
                if (data.offset !== undefined && data.offset !== null) {
                    this.virtualReadPointer = data.offset * sampleRate;
                    this.lastSpawnCount = -Infinity;
                }
            }
            if (data.type === "STOP_AT") {
                this._endTime = data.endTime;
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (this._done) return false;
        if (!this.leftBuffer || this._startTime === null) return true;

        const output = outputs[0];
        if (!output || !output[0]) return true;

        const leftChan = output[0];
        const rightChan = output[1] || leftChan;
        const len = leftChan.length;

        const stretchFactorArr = parameters.stretchFactor;
        const pitchRatioArr = parameters.pitchRatio;
        const grainSizeArr = parameters.grainSize;
        const overlapArr = parameters.overlap;

        const bufferLength = this.leftBuffer.length;

        for (let i = 0; i < len; i++) {
            const t = currentTime + i / sampleRate;

            if (t < this._startTime) {
                leftChan[i] = 0;
                if (output[1]) rightChan[i] = 0;
                continue;
            }

            if (this._endTime !== null && t >= this._endTime) {
                leftChan[i] = 0;
                if (output[1]) rightChan[i] = 0;
                if (!this._done) {
                    this._done = true;
                    this.port.postMessage({ type: "VOICE_ENDED" });
                }
                continue;
            }

            const stretchFactor = stretchFactorArr.length > 1 ? stretchFactorArr[i] : stretchFactorArr[0];
            const pitchRatio = pitchRatioArr.length > 1 ? pitchRatioArr[i] : pitchRatioArr[0];
            const grainSize = grainSizeArr.length > 1 ? grainSizeArr[i] : grainSizeArr[0];
            const overlap = overlapArr.length > 1 ? overlapArr[i] : overlapArr[0];

            // 1. Spawning new grains regularly when the playhead moves past boundaries
            const spawnInterval = (grainSize * sampleRate) / overlap;
            if (this.lastSpawnCount === -Infinity || this.outputSampleCount - this.lastSpawnCount >= spawnInterval) {
                if (this.virtualReadPointer < bufferLength) {
                    const grainLength = Math.round(grainSize * sampleRate);
                    this.grains.push({
                        position: this.virtualReadPointer,
                        age: 0,
                        length: grainLength
                    });
                    this.lastSpawnCount = this.outputSampleCount;
                }
            }

            // 2. Sum contribution of all active grains
            let leftSum = 0;
            let rightSum = 0;

            for (let g = 0; g < this.grains.length; g++) {
                const grain = this.grains[g];
                const readIndex = Math.floor(grain.position + (grain.age * pitchRatio));
                let leftVal = 0;
                let rightVal = 0;

                if (readIndex >= 0 && readIndex < bufferLength) {
                    leftVal = this.leftBuffer[readIndex];
                    rightVal = this.rightBuffer[readIndex];
                }

                // Hann window
                const windowVal = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * grain.age) / grain.length));
                
                leftSum += leftVal * windowVal;
                rightSum += rightVal * windowVal;

                grain.age++;
            }

            // Remove grains that reach their length limit
            this.grains = this.grains.filter(g => g.age < g.length);

            leftChan[i] = leftSum;
            if (output[1]) rightChan[i] = rightSum;

            // Advance playhead by 1 / stretchFactor per output sample
            this.virtualReadPointer += 1.0 / stretchFactor;
            this.outputSampleCount++;

            if (this.virtualReadPointer >= bufferLength && this.grains.length === 0) {
                if (!this._done) {
                    this._done = true;
                    this.port.postMessage({ type: "VOICE_ENDED" });
                }
                leftChan[i] = 0;
                if (output[1]) rightChan[i] = 0;
            }
        }

        return !this._done;
    }
}

registerProcessor("granular-stretcher", GranularStretcherProcessor);
