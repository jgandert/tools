// Shared Web Audio API mocks for test_motif.js and the headless song tools
// run_song.js and check_patterns.js. They model the API surface needed for
// setup and scheduling checks, but do not process audio or prove audible output.

export class MockAudioParam {
    constructor(value = 0) {
        this.value = value;
    }

    setValueAtTime(value) {
        this.value = value;
        return this;
    }

    linearRampToValueAtTime(value) {
        this.value = value;
        return this;
    }

    exponentialRampToValueAtTime(value) {
        this.value = value;
        return this;
    }

    setTargetAtTime() {
        return this;
    }

    cancelAndHoldAtTime() {
        return this;
    }

    cancelScheduledValues() {
        return this;
    }
}

export class MockAudioNode {
    constructor() {
        this.numberOfInputs = 1;
        this.numberOfOutputs = 1;
        this.channelCount = 2;
        this.channelCountMode = "max";
        this.channelInterpretation = "speakers";
    }

    connect(dest) {
        return dest;
    }

    disconnect() {
    }
}

export class MockGainNode extends MockAudioNode {
    constructor(value = 1.0) {
        super();
        this.gain = new MockAudioParam(value);
    }
}

export class MockOscillatorNode extends MockAudioNode {
    constructor(frequencyValue = 440) {
        super();
        this.frequency = new MockAudioParam(frequencyValue);
        this.detune = new MockAudioParam(0);
        this.type = "sine";
        this.startTime = null;
        this.stopTime = null;
        this._started = false;
    }

    start(when = 0) {
        this.startTime = when;
        this._started = true;
    }

    stop(when = 0) {
        this.stopTime = when;
    }
}

// Models AudioBuffer dimensions and channel storage for scheduling tests. It
// does not process audio, and the runners' no-op worklet postMessage stubs do
// not model ArrayBuffer detachment from transfer lists.
export class MockAudioBuffer {
    constructor(numberOfChannels = 1, length = 44100, sampleRate = 44100) {
        this.numberOfChannels = numberOfChannels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.duration = length / sampleRate;
        this._channelData = Array.from(
            { length: numberOfChannels },
            () => new Float32Array(length),
        );
    }

    getChannelData(channel) {
        return this._channelData[channel];
    }

    copyFromChannel(destination, channel, start = 0) {
        destination.set(this._channelData[channel].subarray(start, start + destination.length));
    }

    copyToChannel(source, channel, start = 0) {
        const destination = this._channelData[channel];
        destination.set(source.subarray(0, destination.length - start), start);
    }
}

// AudioContext mock shared by the tests and headless song tools. `verbose`
// optionally enables per-node console.log tracing for diagnostic runs.
export class MockAudioContext {
    constructor({ verbose = false } = {}) {
        this.currentTime = 0;
        this.state = "running";
        this.sampleRate = 44100;
        this.destination = new MockAudioNode();
        this.verbose = verbose;
        this.audioWorklet = {
            addModule: async () => {
            },
        };
    }

    log(...args) {
        if (this.verbose) console.log(...args);
    }

    createGain() {
        return new MockGainNode();
    }

    createBiquadFilter() {
        const filter = new MockAudioNode();
        filter.type = "lowshelf";
        filter.frequency = new MockAudioParam();
        filter.gain = new MockAudioParam();
        filter.Q = new MockAudioParam();
        filter.detune = new MockAudioParam();
        return filter;
    }

    createDynamicsCompressor() {
        const comp = new MockAudioNode();
        comp.threshold = new MockAudioParam();
        comp.knee = new MockAudioParam();
        comp.ratio = new MockAudioParam();
        comp.attack = new MockAudioParam();
        comp.release = new MockAudioParam();
        return comp;
    }

    createConstantSource() {
        const src = new MockAudioNode();
        src.offset = new MockAudioParam();
        src.start = (t) => this.log(`[ConstantSource] start at ${(t ?? 0).toFixed(2)}`);
        return src;
    }

    createOscillator() {
        const osc = new MockAudioNode();
        osc.frequency = new MockAudioParam();
        osc.detune = new MockAudioParam();
        osc.start = (t) => this.log(`[Oscillator] start at ${(t ?? 0).toFixed(2)}`);
        osc.stop = (t) => this.log(`[Oscillator] stop at ${(t ?? 0).toFixed(2)}`);
        return osc;
    }

    createBuffer(numberOfChannels = 1, length = this.sampleRate, sampleRate = this.sampleRate) {
        return new MockAudioBuffer(numberOfChannels, length, sampleRate);
    }

    createBufferSource() {
        const src = new MockAudioNode();
        src.playbackRate = new MockAudioParam();
        src.start = (t) => this.log(`[BufferSource] start at ${(t ?? 0).toFixed(2)}`);
        src.stop = (t) => this.log(`[BufferSource] stop at ${(t ?? 0).toFixed(2)}`);
        return src;
    }

    createWaveShaper() {
        const shaper = new MockAudioNode();
        shaper.curve = new Float32Array(2);
        shaper.oversample = "none";
        return shaper;
    }

    createStereoPanner() {
        const panner = new MockAudioNode();
        panner.pan = new MockAudioParam();
        return panner;
    }

    createDelay(maxDelayTime = 1) {
        const delay = new MockAudioNode();
        delay.delayTime = new MockAudioParam();
        delay.delayTime.maxValue = maxDelayTime;
        return delay;
    }

    createChannelMerger(numberOfInputs = 6) {
        const merger = new MockAudioNode();
        merger.numberOfInputs = numberOfInputs;
        return merger;
    }
}

// Installs a fresh MockAudioContext class as globalThis.AudioContext (and
// globalThis.window, matching what index.html would provide) so `Motif.init()`
// picks it up. Returns the class so callers can `new` it directly if needed.
export function installMockAudioContext({ verbose = false } = {}) {
    class ConfiguredMockAudioContext extends MockAudioContext {
        constructor() {
            super({ verbose });
        }
    }

    globalThis.window = globalThis;
    globalThis.AudioContext = ConfiguredMockAudioContext;
    return ConfiguredMockAudioContext;
}
