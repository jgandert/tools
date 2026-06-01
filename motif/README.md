# Motif: Language Design Specification

Motif is a declarative, native-JavaScript Domain-Specific Language (DSL) for algorithmic composition, functional reactive audio programming, and procedural sequencing. It models continuous time, pattern calculus, and directed acyclic audio graphs entirely through pure JavaScript functions, arrays, and objects.

---

## Global Transport & Master Output

The `Motif` global object controls the engine lifecycle, tempo, global swing, and master output stage.

* `Motif.setTempo(bpm: number)`: Sets the global tempo. Determines the wall-clock duration of 1 cycle/bar.
* `Motif.start()`: Starts the transport from the current position. **Must be called from a user-initiated event** (e.g., a click or keydown handler); browsers block all audio until the AudioContext is resumed by a user gesture.
* `Motif.stop()`: Stops the transport and resets position to zero.
* `Motif.pause()`: Suspends the transport without resetting position.
* `Motif.rampTempo(bpm: number, duration: string | number)`: Smoothly interpolates the global tempo to `bpm` over `duration`.
* `Motif.master(options: Object)`: Configures the master output bus — gain, limiting, and EQ applied to the final mix.
* `Motif.swing(amount: number)`: Sets the global swing amount (from `0` for straight to `1` for full triplet swing).

```javascript
Motif.setTempo(120); // 1 cycle = 500ms
Motif.swing(0.08);   // Apply subtle triplet swing

Motif.master({
  gain: 0.8,
  limiter: true,
  eq: { low: 1.0, mid: 0.9, high: 1.1 }
});

document.querySelector('#start').addEventListener('click', async () => {
  await Motif.start();
  Motif.rampTempo(180, '8b'); // ramp to 180 BPM over 8 bars
});
```

---

## Core Primitives: Pattern Calculus

Time in Motif is continuous and cycle-based. By default, 1 Cycle equals 1 Bar. Patterns are constructed using standard JavaScript syntax and one core primitive mapping.

### Sequential Execution (Standard Arrays)

Any standard JavaScript Array evaluated in a playback context inherently implies a sequential progression over time. Nesting arrays creates immediate, mathematically precise rhythmic subdivisions. Rests are denoted by `null`. Note ties — holding a note across multiple steps without re-triggering the envelope — are denoted by `Tie`.

```javascript
// C4 held across 3 steps, then a rest, then G4
const melody = ['C4', Tie, Tie, null, 'G4'];
```

### `Parallel(...items)`

Evaluates all internal arguments concurrently within the current temporal step (often referred to as a "stack" or chordal grouping in other DSLs).

```javascript
// A 4/4 rhythm. The nested array subdivides the second beat into 8th notes.
// The Parallel block triggers the kick and clap at the same exact time.
const rhythm = ['kick', ['hat', 'hat'], 'snare', Parallel('kick', 'clap')];

// Pattern Mathematics: Cross-product evaluation
const melody = ['C3', 'E3', 'G3'];
const octaves = [0, 12, -12];

// Evaluates to a polyrhythmic cross-product of notes and octave transpositions
const finalPattern = melody.add(octaves);
```

### `Ramp(from, to)`

Generates a continuous, linearly interpolated value between two endpoints over the duration of the current step. Used to express smooth pitch slides, filter sweeps, or any parameter that must glide rather than jump.

```javascript
// Smooth pitch glide from C4 to G4 over one cycle, then a discrete note
Track('lead')
  .synth('sine')
  .note([Ramp('C4', 'G4'), 'E4']);
```

---

## The `Track` Class

The `Track` object is the primary unit of execution. It represents an independent sequencer and audio source. The API is strictly chainable.

### Instantiation & Sources

* `Track(id: string)`: Creates or references a track by its unique ID.
* `.synth(type: string)`: Assigns a synthesizer engine (e.g., `'sine'`, `'saw'`, `'square'`, `'triangle'`; `'fm'`, `'pluck'`, and `'noise'` fall back to oscillators).
* `.sample(path: string)`: Assigns an audio buffer for playback.
* `.sampler(options: Object)`: Assigns a pitch-shifting multi-sample instrument. Provide a `urls` map of note names to file paths, an optional `baseUrl`, and an optional `release`.

### Sequencing & Envelopes

* `.note(pattern: Array<number | string>)`: Specifies pitch data (accepts MIDI numbers, Hz, or string notation).
* `.freq(pattern: Array<number>)`: Specifies continuous frequency pitch data.
* `.envelope(options: Object)`: Defines the ADSR amplitude curve (attack, decay, sustain, release).

### Mixing & Spatialization

* `.gain(level: number | string)`: Sets the track output level. Supports linear scalars (e.g. `0.0` - `1.0`) or decibel strings (e.g., `'-6dB'`), which are parsed exponentially.
* `.volume(db: number | string)`: Attenuates track level using dB values. Accepts numeric dB values (e.g. `-15`) or parsed decibel strings (e.g. `'-15dB'`).
* `.pan(amount: number | Signal)`: Positions the track in the stereo field (-1.0 full left, 0.0 center, 1.0 full right). Accepts a static value or a control signal (e.g., an LFO).
* `.filter(options: Object)`: Configures a track-level biquad filter (`type`, `cutoff` (number or Signal), `resonance`).
* `.distort(amount: number)`: Applies waveshaper distortion/saturation to the track signal chain (0.0 to 100+).
* `.eq(options: Object)`: Applies a track-level three-band EQ. Bands `low`, `mid`, `high` can be defined with gain/freq/Q values.
* `.compress(options: Object)`: Applies a track-level compressor (threshold, knee, ratio, attack, release).
* `.mute(state?: boolean)`: Mutes the track if `true` or toggles mute state if omitted.
* `.unmute()`: Unmutes the track.

### Polyphony

* `.voices(count: number, mode?: string)`: Sets the maximum simultaneous voices for a polyphonic synth. `mode` determines the voice-stealing algorithm (`'oldest'` | `'quietest'` | `'none'`).

```javascript
Track('bassline')
  .synth('saw')
  .note(['C2', 'Eb2', null, 'G1'])
  .envelope({ attack: 0.01, decay: 0.2, sustain: 0.5, release: 1.2 })
  .filter({ type: 'lowpass', cutoff: 350, resonance: 1.0 })
  .gain(0.9)
  .pan(-0.3);

Track('pad')
  .synth('saw')
  .note([Parallel('C4', 'E4', 'G4')])
  .voices(4, 'oldest')
  .volume(-3); // Attenuate by 3dB

Track('piano')
  .sampler({
    urls: { C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', A4: 'A4.mp3' },
    baseUrl: '/samples/piano/',
    release: 1,
  })
  .note(['C4', 'E4', 'G4', 'B4']);
```

---

## Polymeters & Time Stretching

By default, sequences stretch to fill exactly 1 global cycle. This behavior can be uncoupled to create polymeters, polyrhythms, and looping offsets.

* `.stepLength(fraction: string | number)`: Uncouples the pattern from the cycle, forcing *each step* to a specific musical duration (drifting against the global cycle).
* `.loopLength(fraction: string | number)`: Constrains the total loop duration of the sequence regardless of step count.

```javascript
Track('polymeter')
  .synth('square')
  .note(['C4', 'D4', 'E4', 'F4', 'G4']) // 5-step sequence
  .stepLength('1/16'); // Loops every 5/16ths of a bar
```

---

## Transformations & Time Masks

Tracks can be mutated algorithmically using higher-order functions.

* `.every(cycles: number, modifier: Function)`: Applies the callback transformation once every N cycles. Passes the array of parsed event objects to the modifier callback.
* `.mask(booleanArray: Array<boolean>, modifier: Function)`: Applies the transformation strictly to steps where the mask evaluates to `true`.
* `.subdivide(divisions: number, modifier: Function)`: Iteratively applies a transformation to a specific division of the beat.
* `.offset(timeShift: string, modifier: Function)`: Creates algorithmic counterpoint by overlaying a delayed, mutated copy of the sequence onto itself.
* `.swing(amount: number)`: Sets a track-specific swing amount (from `0` to `1`), overriding the global `Motif.swing(amount)` for this track.

```javascript
Track('lead')
  .note(['C4', 'E4', 'G4'])
  // Transpose down an octave on the 2nd cycle
  .every(2, (events) => {
    events.forEach(e => {
      if (typeof e.value === 'string' && e.value !== 'Tie') {
        const m = noteToMidi(e.value);
        if (m) e.value = midiToNote(m - 12);
      }
    });
    return events;
  })
  // Transpose step 0 and 2 up a perfect 5th (7 semitones)
  .mask([true, false, true, false], (e) => {
    if (typeof e.value === 'string' && e.value !== 'Tie') {
      const m = noteToMidi(e.value);
      if (m) e.value = midiToNote(m + 7);
    }
    return e;
  })
  // Add a pitch-doubled echo offset by an 8th note
  .offset('1/8', (e) => {
    if (typeof e.value === 'string' && e.value !== 'Tie') {
      const m = noteToMidi(e.value);
      if (m) e.value = midiToNote(m + 12);
    }
    return e;
  });
```

---

## Generative & Stochastic Logic

Motif handles probabilities and algorithmic generation deterministically.

* `.euclid(pulses: number, steps: number, rotate?: number)` or `.euclid({ pulses: number, steps: number, rotate?: number })`: Distributes `pulses` evenly across `steps`.
* `.degrade(probability: number)`: Drops events based on a probability threshold (0.0 to 1.0).
* `.mutate(options: Object)`: Applies Markov-chain-like random transformations per step.

```javascript
Track('hihats')
  .sample('drums/hat')
  .euclid(5, 8)
  .mutate({
    chance: 0.25,
    actions: {
      ratchet: 2, // Subdivide note triggers
      reverse: 1
    }
  });
```

### `SimplexNoise`

For smooth procedural/generative parameter modulation and non-repeating algorithmic sequences, Motif includes a built-in `SimplexNoise` utility.

* `new SimplexNoise(seedOrRandom?: number | Function)`: Instantiates a Simplex Noise generator. If a seed number is provided, it uses a deterministic `mulberry32` PRNG internally for reproducibility.
* `.noise1D(x: number)`: Returns a smooth 1D simplex noise value between `-1` and `1`.
* `.noise2D(x: number, y: number)`: Returns a smooth 2D simplex noise value between `-1` and `1`.

```javascript
// Instantiating a seeded, deterministic Simplex Noise generator
const simplex = new SimplexNoise(42);

// Generate 16 steps using 1D noise mapped to diatonic scale degrees
const notesPattern = Array.from({ length: 16 }, (_, i) => {
  // Use slightly larger steps for more distinct and active note transitions
  const step = i * 0.35;
  const n = simplex.noise1D(step);
  
  // 1. Organic Rhythmic Rests: check a secondary noise coordinate
  if (simplex.noise1D(step + 100) < -0.3) {
    return null;
  }
  
  // 2. Wide Melodic Span: expand narrow noise range to a full 2-octave diatonic scale
  const expanded = Math.min(Math.max(n * 1.6, -1), 1);
  let degree = Math.floor((expanded + 1) * 7); // degrees 0 to 14
  
  // 3. Dynamic Octave Accents: inject high accents using a third noise coordinate
  if (simplex.noise1D(step + 200) > 0.5) {
    degree += 7; // shift up one octave
  }
  
  return degree;
});

Track('procedural-lead')
  .synth('pluck')
  .note(notesPattern)
  .scale('C3', 'major')
  .gain(0.2);
```

---

## Sample Slicing & Breakbeat Manipulation

Advanced audio buffer manipulation is handled through explicit fractional mapping arrays.

* `.chop(slices: number)`: Divides the loaded sample into equal slices.
* `.pattern(sliceIndices: Array)`: Reorders and subdivides slices.
* `.fit(duration: string | number, options?: { mode?: 'stretch' | 'repitch', grainSize?: number, overlap?: number })`: Warps the buffer length to strictly fit a temporal constraint. By default, `mode: 'stretch'` uses a granular OLA time-stretcher to stretch or compress time while preserving original pitch. Pass `mode: 'repitch'` to fall back to pitch-linked playback rate scaling. `grainSize` (seconds, default `0.05`) and `overlap` (integer, default `4`) customize the stretcher parameters.
* `.splitStereo(modifier: Function)`: Applies a transformation exclusively to the right stereo channel (historically known as `jux` or juxtapose).

```javascript
Track('amen')
  .sample('breaks/amen.wav')
  .chop(8)
  .pattern([0, 1, 2, [3, 3], 4, 5, [7, 6], 0])
  .fit('1b', { mode: 'stretch', grainSize: 0.05, overlap: 4 })
  .splitStereo((p) => p.rev()); // Right ear plays in reverse
```

---

## Audio Graphs, Modulation & FX

Audio routing in Motif utilizes Directed Acyclic Graphs (DAGs). Reactivity is achieved natively by assigning control signals to standard JavaScript variables.

### Control Signals & Variables

`LFO` (Low Frequency Oscillator) generates control-rate modulation mapped to musical timing. Standard `const` and `let` declarations manage reactive state.

```javascript
const filterSweep = LFO.sine({ min: 200, max: 2000, speed: '2b' });
const autoPan = LFO.triangle({ min: -1, max: 1, speed: '4b' });

Track('pad')
  .synth('sine')
  .note(['C4', 'F4'])
  .filter({ type: 'lowpass', cutoff: filterSweep })
  .pan(autoPan);
```

### Audio-Rate Modulation (FM) & Sidechaining

Tracks can directly modulate the parameters of other tracks at the sample rate.

* `.modulate(parameter: string, source: Track, options: Object)`: Modulate a track parameter with another track's audio output.
* `.sidechain(target: Track, options: Object)`: Amplitude ducking driven by another track (commonly known as `duck`).

```javascript
const modSource = Track('mod').synth('sine').note([100, 200]).mute();

Track('carrier')
  .synth('saw')
  .note(['C3', 'G3'])
  .modulate('filter.cutoff', modSource, { depth: 500 })
  .sidechain(Track('kick'), { attack: 0.01, release: 0.18 }); // Ducking
```

### Buses & Feedback Loops

Global FX buses allow multi-track sending. Recursive routing is supported via a specific `.feedback()` method on Bus instances.

* `Bus(id: string)`: Instantiates an audio bus.
* `.send(bus: Bus, amount: number)`: Sends audio from a Track to a Bus.

```javascript
const dubDelay = Bus('dub')
  .filter({ type: 'highpass', cutoff: 400 })
  .feedback({ amount: 0.75 });

Track('stab')
  .synth('square')
  .note(['C4', null, null, null])
  .send(dubDelay, 0.8);
```

---

## Custom DSP Generation

For sample-accurate algorithmic synthesis, tracks accept pure mathematical functions compiled to WebAudio AudioWorklets via the `.dsp()` method. Context provides time (`t`), phase (`p`), and input (`i`).

```javascript
Track('generative_wave')
  .dsp((context) => {
    // Folded-sine math
    let wave = Math.sin(context.p * Math.PI * 2);
    return Math.abs(wave) * 2.0 - 1.0; 
  })
  .freq([100, 200, 150]);
```

DSP functions run inside an `AudioWorkletProcessor` which delivers exactly **128 frames per block**. Per-sample functions (like the example above) are unaffected. If your function accumulates samples internally — for example, collecting frames to run an FFT — you must implement a ring buffer to queue frames until your required block size is reached.

---

## Harmony & Xenharmonics

Motif supports continuous frequency modulation, MIDI pitch representation, strict microtonal/xenharmonic frameworks, and diatonic scale mapping.

* `.scale(root: string, name: string)`: Maps integer step values to diatonic scale degrees. Integers are interpreted as scale degrees (0-indexed), non-integer note names pass through unchanged.
* `.arp(mode: string)`: Unrolls a chord voicing into a sequential arpeggio. Modes: `'up'`, `'down'`, `'upDown'`, `'random'`.
* `.tuning(system: string)`: Snaps numeric integers to explicit Equal Divisions of the Octave (EDO) or custom ratios.
* `.chordVoicing(options: Object)`: Algorithmic voice leading.

```javascript
// Integer steps mapped to C minor: 0→C3, 2→Eb3, 4→G3, 7→Bb3
Track('chords')
  .synth('pad')
  .note([0, 2, 4, 7])
  .scale('C3', 'minor');

// Chord arpeggiated upward then back down
Track('arp')
  .synth('pluck')
  .note([Parallel('C4', 'E4', 'G4')])
  .arp('upDown');

Track('microtonal')
  .synth('pluck')
  .note([60.5, 62, 63.25, 65]) // Fractional MIDI
  .tuning('17-EDO')
  .chordVoicing({ mode: 'smooth', drop: 2 });
```

---

## Macro-Arrangement

By default, an unarranged track loops its sequence infinitely. Infinite loops are managed and structured via a declarative `Arrange` block, defining sequential phases of execution with guaranteed phase alignment.

**Important:** Placing a track inside an `Arrange` block implicitly bounds its active playback window. The track will automatically start playing at the designated section start time and automatically stop/finish playing once its designated section concludes.

```javascript
const drums = Track('drums').sample('kick').subdivide(4, (chunkEvents) => {
  return chunkEvents.flatMap(e => {
    const e1 = { ...e, duration: e.duration / 2 };
    const e2 = { ...e1, startTime: e1.startTime + e1.duration };
    return [e1, e2];
  });
});
const chords = Track('chords').synth('pad').note(['Cmaj7', 'Fmaj7']);

Arrange([
  { bars: 4,  tracks: [chords] },
  { bars: 8,  tracks: [chords, drums] },
  { bars: 16, tracks: [chords, drums] }
]);
```

### Looping

Pass a second options argument to loop the entire arrangement indefinitely. The engine stops at the natural end of the sequence, fires `onPlaybackFinished` (triggering any active WAV recording download for the first pass only), then seamlessly restarts.

- `loop: boolean` — enables continuous looping.
- `loopDelay: string | number` — gap between the end of one pass and the start of the next. Accepts the same duration strings as the rest of the API (`"2s"`, `"1 bar"`, `"4 beats"`, `0.5`, …). Defaults to `0` (gapless).

```javascript
Arrange([
  { bars: 8,  tracks: [intro] },
  { bars: 16, tracks: [intro, main] },
  { bars: 8,  tracks: [intro, main, outro] }
], { loop: true, loopDelay: "2s" });
```

### Solo

Chain `.solo()` (or `.s()`) on any track to hear only that instrument. The arrangement is bypassed — the soloed track loops continuously. Remove `.solo()` and re-run to restore normal playback.

Multiple tracks can be soloed simultaneously.

```javascript
Track('bass').synth('fm').note([0, 3, 5, 7]).solo()
```

### Arrangement Start

Add `s: 1` (or `start: true`) to a section inside the `Arrange` block to skip all sections prior to it, allowing you to test specific sections immediately during playback. If multiple sections have a start flag, the last one wins.

```javascript
Arrange([
  { bars: 8, tracks: [darkKeys] },
  // Skips the first section and starts here immediately
  { bars: 8, tracks: [darkKeys, subBass], s: 1 } 
]);
```

---

## External I/O & Asynchronous Operations

Motif utilizes native JavaScript `await` functionality for sample loading.

```javascript
// Asynchronous sample fetching
await Motif.loadSamples('https://api.domain.com/packs/drums.json');
```
