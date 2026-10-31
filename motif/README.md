# Motif: Language Design Specification

Motif is a declarative, native-JavaScript Domain-Specific Language (DSL) for algorithmic composition, functional reactive audio programming, and procedural sequencing. It models continuous time, pattern calculus, and directed acyclic audio graphs entirely through pure JavaScript functions, arrays, and objects.

## Browser playground

Serve this directory over HTTP and open `index.html`. The server must expose the parent directory too: the page loads `../one.js`, `../md-renderer.js`, and `../one.css` alongside this project's `motif/` directory. These parent vendors are supplied by the surrounding application and are not included here.

`one.js` must expose `globalThis.one` with async-compatible `prompt(message, defaultValue)`, `confirm(message)`, `alert(message)`, and `storage.get(key)` / `storage.set(key, value)`. The Markdown renderer must expose `globalThis.renderMarkdownFileToElement(path, selector)` for the documentation dialog. Missing script features produce a warning in the playground log; editing, compilation, and playback remain available, while the affected preset, persistence, or documentation features are unavailable. Vendor operation failures are reported in the log. `one.css` supplies the surrounding application's shared styling.

Live edits preserve the current arrangement position and pattern phase. Replacement tracks use their previous playback origin; newly added tracks join the current transport position. Changes affect upcoming onsets, without replaying notes or cycle callbacks from elapsed cycles. Pausing cancels a pending automatic apply; edits made while paused are applied when resuming. Use Restart to replay from the beginning. The progress display follows the same beat timeline as scheduling, including tempo changes.

## Global Transport & Master Output

The `Motif` global object controls the engine lifecycle, tempo, global swing, and master output stage.

Use `setTempo()` and `rampTempo()` for tempo changes during playback. They take effect at the end of the already scheduled lookahead window (normally at most 0.1 seconds ahead). Section windows, musical pattern positions, section gain ramps, and the final arrangement boundary share integrated beat progress, including during smooth tempo ramps. Reusing a Track preserves its continuous pattern phase across sections. Numeric seconds and explicit second/millisecond durations retain clock timing. Notes and envelopes already submitted to Web Audio retain their scheduled timing. A section gain ramp with no explicit duration spans that section in beats; an explicit musical duration follows beats, while a numeric duration remains seconds.

* `Motif.setTempo(bpm: number)`: Sets a positive, finite BPM. Musical pattern lengths and arrangement sections follow the same beat timeline.
* `Motif.start()`: Starts the transport from the current position. **Must be called from a user-initiated event** (e.g., a click or keydown handler); browsers block all audio until the AudioContext is resumed by a user gesture.
* `Motif.stop()`: Stops the transport and resets position to zero.
* `Motif.pause()`: Suspends the transport without resetting position.
* `Motif.rampTempo(bpm: number, duration: string | number, options?: Object)`: Ramps the BPM audio parameter over `duration`. By default the scheduler changes tempo immediately; `{ smooth: true }` makes scheduler BPM linear in audio time too. Musical ramp durations use the average of the starting and target BPM.
* `Motif.master(options: Object)`: Configures the master output bus — gain, EQ, optional compression, and final limiting applied to the mix.
* `Motif.swing(amount: number)`: Sets the global swing amount (from `0` for straight to `1` for full triplet swing).
* `Motif.beatsPerBar`: Read/write property (default `4`). Controls how many beats constitute one bar, which determines the wall-clock duration of `bars:` in `Arrange()` and the default cycle length for tracks without an explicit `.stepLength()`. Set before playback for non-4/4 meters (e.g. `Motif.beatsPerBar = 3` for 3/4, `Motif.beatsPerBar = 7` for 7/4). BPM counts quarter-note beats. For 7/8 at quarter-note BPM, set `Motif.beatsPerBar = 3.5` and use `.stepLength("1/7")` for eighth notes. Do not halve BPM: `"1/8"` means one eighth of the transport bar, not necessarily an eighth note.
* `Motif.schedule(time: number, callback: (audioTime: number) => void)`: Enqueues `callback` to fire once the lookahead scheduler's clock reaches the absolute AudioContext `time` (seconds, as returned by `Motif.ctx.currentTime`). `callback` receives the actual audio time it fired at. Throws if `time` isn't a finite number or `callback` isn't a function. Useful for one-off events synced to the audio clock (e.g. triggering visuals or DOM updates) outside the normal Track/Arrange pattern flow.

Await `Motif.start()` to know when playback begins. A stop, pause, or newer start cancels a pending launch and resolves its promise with `undefined` immediately, even if its resource or context-resume operation never settles. A cancelled request cannot later start scheduling; late resource/resume failures remain logged. Active resume and enabled-limiter failures still reject startup. A restart after an engine pause/stop waits for any pending suspension before resuming. Startup waits for engine resources and the current sample/sampler loads of registered schedulable tracks, including asynchronous adoption of registered AudioBuffers. Replacing a track's source or removing the track while it loads makes startup follow the current registered sources; a superseded request cannot hold startup open or overwrite its replacement. A failed sample load logs an error and leaves that source silent. Samplers wait for all zones to settle, log failed zones, and use the nearest successfully loaded zone; an empty or wholly failed sampler stays silent. These source failures do not reject startup; an unavailable enabled master limiter still rejects it. During playback, events for a loading or failed sample/sampler source are skipped without creating an oscillator or replaying missed notes. Assigning a new sample clears the previous sample immediately. Failed URL loads are evicted from the shared buffer cache so assigning the source again can retry.

When every track with a nonempty pattern has a finite stop boundary, transport stops at the latest boundary and calls `Motif.onPlaybackFinished({ looped })` once. Slice-only and all-rest patterns count toward this timing; empty patterns do not. A track with a nonempty pattern and no finite stop keeps playback open. Trailing empty `Arrange()` sections extend the duration, and `{ loop: true }` restarts the arrangement after completion.

```javascript
Motif.setTempo(120); // Quarter-note beat = 500ms; default bar = 2 seconds
Motif.swing(0.08);   // Apply subtle triplet swing

Motif.master({
  gain: 0.8,
  limiter: true,
  // EQ gains are dB: 0 is neutral; these are +1, +0.9, +1.1 dB boosts.
  eq: { low: 1.0, mid: 0.9, high: 1.1 }
});

document.querySelector('#start').addEventListener('click', async () => {
  await Motif.start();
  Motif.rampTempo(180, '8b'); // ramp to 180 BPM over 8 bars
});
```

The master chain is gain → EQ → optional compressor → final limiter. Limiting is enabled by default; compression is disabled. `limiter: true` uses stereo-linked lookahead gain reduction with an eight-times oversampled peak detector and a −1 dBTP target. It reserves another 0.9 dB for reconstruction/envelope headroom, passes signals that stay below that threshold unchanged apart from delay, and adds `ceil(sampleRate × 0.005) + 128` samples of latency (about 7.7 ms at 48 kHz). True peaks are estimated with a finite interpolation filter, not a guarantee for every possible reconstruction or subsequent lossy encoding. Configure the master before starting playback; bypassing the limiter changes latency.

Use `limiter: { ceiling: -1, release: 0.1 }` to configure the ceiling in dBTP (−24 to −1) and release in seconds (0.01 to 2), or `limiter: false` to bypass protection. Use `compressor: true` for Web Audio's default compression, an object `{ threshold, knee, ratio, attack, release }` for custom compression, or `compressor: false` to bypass it. Compression settings belong in `compressor`, not `limiter`. Playback and offline export wait for the limiter worklet; failure stops protected playback/export instead of passing unprotected audio.

Track `.send()` is pre-fader: `.volume()` does not reduce the send. Set send amounts or the bus's `.volume()` explicitly to balance the wet mix. Keep the mix comfortably below the limiter ceiling so limiting catches occasional peaks rather than continuously reducing gain.

---

## Core Primitives: Pattern Calculus

Time in Motif is continuous and cycle-based. By default, 1 Cycle equals 1 Bar. Patterns are constructed using standard JavaScript syntax and one core primitive mapping.

### Sequential Execution (Standard Arrays)

Any standard JavaScript Array evaluated in a playback context inherently implies a sequential progression over time. Nesting arrays creates immediate, mathematically precise rhythmic subdivisions. Rests are denoted by `null`. Note ties — holding a note across multiple steps without re-triggering the envelope — are denoted by `Tie`. If a modifier removes a Tie or its onset is skipped during playback, the held note releases at its last surviving gate instead of sustaining indefinitely.

```javascript
// C4 held across 3 steps, then a rest, then G4
const melody = ['C4', Tie, Tie, null, 'G4'];
```

### `Parallel(...items)`

Evaluates all internal arguments concurrently within the current temporal step (often referred to as a "stack" or chordal grouping in other DSLs). `Parallel(...)` produces a value, NOT a Track — place it as an element inside the array passed to `.note([...])`. It cannot be chained (do not call Track methods on it) and cannot be passed as the top-level argument to a Track method.

```javascript
const notes = ['C4', 'E4', 'G4'];
Track('subdivision').note(['C4', ['D4', 'E4'], 'F4', Parallel(...notes)]);
```

The nested array splits one parent slot into two successive notes. `Parallel(...notes)` sounds all three notes together; `Parallel(notes)` has one sequential array branch and therefore is not a chord.

Array `.add()`, `.sub()`, `.mul()`, and `.div()` calculate a Cartesian product in left-element order. `[60, 64].add([0, 12])` returns `[60, 72, 64, 76]`, a flat sequential pattern, not simultaneous voices. Note-name operands convert through MIDI. Arithmetic coerces `null` rather than preserving rests: `[60, null].add([12])` returns `[72, 12]`. For a flat MIDI pattern without `.scale()`, preserve rests explicitly:

```javascript
const pattern = [60, null, 67];
const octaveUp = pattern.map(v => v == null ? v : v + 12);
Track('octave-up').note(octaveUp);
```

### `Ramp(from, to, duration?)`

Pitch Ramps glide linearly in Hz on pitched synths, FM, pluck, and custom DSP using its frequency argument. Noise, samples, and samplers reject pitch Ramps. Omitted duration spans the scheduled gate; explicit positive finite durations use seconds for numbers and the beat timeline from onset for musical strings. Shorter glides hold the target for the remaining gate; longer glides reach the target at gate end. They do not change gate or release length. Numeric `.note()` endpoints are MIDI without a scale and degrees with a scale; note names include octaves and bypass degree mapping. `.freq()` endpoints are Hz. Gain and effect Ramps have their own scheduling contracts; Ramp is not a universal effect argument.

```javascript
// Glide from C4 to G4 across the first half-bar slot, then E4
Track('lead')
  .synth('sine')
  .note([Ramp('C4', 'G4'), 'E4']);
```

---

## The `Track` Class

The `Track` object is the primary unit of execution. It represents an independent sequencer and audio source. The API is strictly chainable.

### Instantiation & Sources

* `Track(id: string)`: Creates a new track and registers its unique ID. Calling `Track(id)` again replaces that registry entry; retain the returned instance to reuse it.
* `.synth(type: string)`: Assigns a synthesizer engine. Supports built-in synthesizers (e.g. `'sine'`, `'supersaw'`, `'keys-drift'`, `'bass-acid-hq'`, `'fm-epiano'`) or a custom DSP name already registered in `Motif.synthRegistry`. Unknown names throw immediately without changing the track's current source. If the name belongs to `Motif.sampleRegistry`, the error directs you to `.sample(name)` or `.sound(name)`. Calling `.synth()` without a name selects `'sine'`; `'saw'` remains an alias for `'sawtooth'`.
* `.sample(path: string)`: Assigns an audio buffer. Accepts file paths or built-in procedural sample names (e.g., `'kick-electronic'`, `'water-drop'`, `'pickup-chime'`). Step semantics: `null` and `undefined` are the only rests; every other value (including `0` and `false`) triggers a one-shot. When `.note(...)` is set, numeric step values are interpreted as MIDI notes and pitch-shift the sample relative to MIDI 60 (C4) — so `.note([1])` triggers but plays drastically pitched down. To fire at native pitch use `.note([60])` or `.freq([midiToHz(60)])`. When combined with `.scale(root, name)` and integer-degree `.note(...)`, the integer is first resolved to a MIDI note via the scale and then the same pitch-shift formula applies, so e.g. `.scale('C5', 'minor').note([0])` plays the sample up one octave.
* `.sound(name: string)`: Convenience method that automatically routes to `.synth()` or `.sample()` by looking up `name` in the synth registry first, then the sample registry. Eliminates the need to know which registry a built-in name belongs to. File paths (not found in either registry) fall through to `.sample()`.
* `.sampler(options: Object)`: Assigns a pitch-shifting multi-sample instrument. Provide a `urls` map of note names to file paths, an optional `baseUrl`, and an optional `release`. `.note()` selects the nearest loaded MIDI root (after scale mapping); `.freq()` selects it from positive finite Hz and transposes by the corresponding frequency ratio. Invalid Hz events are silent. `.fit()` multiplies the selected zone's playback rate.

### Sequencing & Envelopes

* `.note(pattern: Array<number | string | Ramp | Parallel | Tie | null>)`: Specifies pitch data. Accepts MIDI numbers, note-name strings, `Ramp(from, to, duration?)` step values (for in-step glides), `Parallel(...)` (for chordal stacks at a single step), `Tie` (hold the preceding note or chord without retriggering; all held voices release after the final Tie), and `null` (rest). Without `.scale()`, numbers are MIDI; with it, use integer scale degrees. Note-name strings must include octaves and bypass degree mapping.
* `.freq(pattern: Array<number>)`: Specifies pitch in Hz, bypassing scale-degree mapping; also accepts pitch Ramp steps.
* `.envelope(options: Object)`: Defines the ADSR amplitude curve (attack, decay, sustain, release).

### Mixing & Spatialization

* `.gain(level: number | string | RampNode | Signal)`: Sets the track output level. Supports linear scalars (e.g. `0.0` - `1.0`), decibel strings (e.g., `'-6dB'`), a `Ramp(...)` object for gain automation, or a control signal for continuous linear-gain modulation (e.g., `.gain(LFO.sine({min: 0.04, max: 0.09, frequency: 1}))`). Gain is independent of effect initialization order. Scalar or signal replacements cancel submitted gain automation; a queued Ramp replaces signal modulation at its scheduled onset. `.volume()` remains a separate downstream fader.
* `.volume(db: number | string | Signal)`: Attenuates track level using dB values. Accepts numeric dB values (e.g. `-15`), parsed decibel strings (e.g. `'-15dB'`), or a control signal for continuous modulation.
* `.pan(amount: number | Signal)`: Positions the track in the stereo field (-1.0 full left, 0.0 center, 1.0 full right). Accepts a static value or a control signal (e.g., an LFO).
* `.filter(options: Object)`: Configures a track-level biquad filter. `type`, `cutoff` (number or Signal), `resonance` (number only — static; modulate via `.modulate('filter.resonance', source, { depth })`).
* `.distort(amount: number)`: Applies waveshaper distortion/saturation to the track signal chain (0.0 to 100+).
* `.eq(options: Object)`: Applies a track-level three-band EQ. Bands `low`, `mid`, `high` can be defined as a number (gain) or an object `{ gain, frequency, Q }`. Bands also support modulation. Low-shelf default is 320Hz, peaking mid default is 1000Hz (Q=1), high-shelf default is 3200Hz.
* `.compress(options: Object)`: Applies a track-level compressor. All options (`threshold`, `knee`, `ratio`, `attack`, `release`) support control signals/modulators.
* `.delay(options: Object)`: Adds a feedback-delay (echo) effect. Sugar that lazily creates a dedicated internal feedback bus (`<id>__delay`) and routes the track into it via a send. `time` is the delay length as seconds or a musical duration string (initial default `"3/16"`) and must resolve to between the 128-frame safety delay and 60 seconds, inclusive; unsupported values throw a `RangeError`. `feedback` is the loop amount in `0..0.95` controlling tail length (default `0.3`). Repeated calls reuse the same bus; an explicit `time` updates its rhythm, while omitting `time` preserves the current delay. For a delay shared across multiple tracks, build the bus manually instead (see Buses & Feedback Loops).
* `.mute(state?: boolean)`: Mutes the track if `true` or toggles mute state if omitted.
* `.unmute()`: Unmutes the track.
* `.s()`: Chainable alias for `.solo()`.
* `.seed(val: number)`: Seeds the track's pseudo-random number generator for deterministic probabilistic modifiers (e.g. `.degrade()`, `.mutate()`).
* `.degrade(probability: number)`: Drops events based on a probability threshold (0.0 to 1.0) on every cycle.
* `.mutate(options: Object)`: Applies Markov-chain-like random transformations per step on every cycle.
* `.offset(timeShift: string, modifier: Function)`: Creates algorithmic counterpoint on every cycle by overlaying a delayed, mutated copy of the sequence.

Cycle modifiers are evaluated once per scheduled cycle, and their transformed events stay fixed across scheduler ticks. Calling `.note()`, `.freq()`, `.seed()`, or adding a modifier rebuilds the remaining events in the current cycle; already-scheduled notes are unaffected. Cycles skipped during a scheduling stall do not run modifier callbacks. Transport resets discard retained events and reset smooth chord-voicing history.

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

* `.stepLength(fraction: string | number)`: Uncouples the pattern from the cycle, setting each top-level slot duration: numbers are seconds, musical strings follow beats. Nested arrays subdivide that slot.
* `.loopLength(fraction: string | number)`: Sets the repeat interval independently of pattern duration. A shorter loop skips events starting at or beyond its end and clips event durations there; a longer loop leaves a gap instead of stretching the pattern.

```javascript
Track('polymeter')
  .synth('square')
  .note(['C4', 'D4', 'E4', 'F4', 'G4']) // 5-step sequence
  .stepLength('1/16'); // Loops every 5/16ths of a bar
```

`parseDurationToSeconds(duration, bpm, beatsPerBar)` interprets numeric step/loop lengths as seconds, fractions such as `"1/16"` or `"1/16b"` as fractions of a bar, `"1 beat"` as one quarter-note beat, and `"250ms"` as clock time. In 3/4 at 120 BPM, a bar lasts 1.5 seconds: `"1/4"` is 0.375 seconds, while a conventional quarter note (`"1 beat"` or `"1/3"` of this bar) is 0.5 seconds.

`parseDurationToFraction()` is a separate normalized-position parser used by `.offset()`: `"1/8"` and numeric `0.125` mean one eighth of the pattern duration, independently of meter, not seconds. It accepts bare fraction/numeric strings; unit strings such as `"1 beat"` or `"250ms"` return zero here.

---

## Transformations & Time Masks

Tracks can be mutated algorithmically using higher-order functions.

* `.every(n: number, modifier: Function)`: Invokes the callback at cycle zero, n, 2n, and so on. The repeat interval is `.loopLength()` when supplied; otherwise it is top-level array length × `.stepLength()`, or one bar when no step length is set. Five steps at `"1/16"` with `.every(4)` fire every 5/4 bars, including the initial loop; adding `.loopLength("1b")` makes that four bars.
* `.mask(booleanArray: Array<boolean>, modifier?: Function)`: Indexes flattened parsed events, including rests and each individual `Parallel()` tone, wrapping the mask by event index. With no callback it retains only true positions; with a callback it transforms true positions and retains false positions.
* `.subdivide(divisions: number, modifier: Function)`: Groups events by onset into equal normalized pattern chunks and calls `modifier(chunkEvents, chunkIndex)`, including empty chunks. It does not automatically create faster notes.
* `.offset(timeShift: string | number, modifier?: Function)`: Retains original events and adds shifted copies. The shift is a normalized pattern fraction, not a move of the original pattern. Copies beyond the ordinary pattern cycle remain pending alongside later cycles; copies beyond an explicit `.loopLength()` boundary are clipped.
* `.swing(amount: number)`: Sets a track-specific swing amount (from `0` to `1`), overriding the global `Motif.swing(amount)` for this track.

### `MotifEventArray` Modifier Prototypes

Only `.every()` supplies a `MotifEventArray`. Return an event array to replace the cycle; a non-array return retains the input events (in-place event edits still apply). `.mask()` and `.offset()` supply individual events: return an event or leave the return undefined to retain it; `.offset()` may return `null` to omit a copy. To silence a masked event return `{ ...e, value: null }`. `.subdivide()` supplies a plain array plus chunk index: return an array to replace that chunk, or a non-array to retain it. Neither individual events nor plain arrays have `.fast()`/`.transpose()`. For example, `.subdivide(2, (chunk, index) => index === 0 ? chunk.map(e => ({ ...e, duration: e.duration / 2 })) : chunk)` shortens first-half gates without changing onsets.

`MotifEventArray` inherits from `Array` and provides chainable in-place modification methods:

Cycle transforms run once per entered cycle while its inputs are unchanged. A scheduling stall skips missed onsets and wholly missed cycles without replaying their callbacks, while previously generated delayed copies with future onsets remain pending. Changing the pitch/slice pattern, adding a modifier, changing the seed, step/loop length, or meter cancels unscheduled copies from older cycles and rebuilds unscheduled events in the current cycle. Transport reset clears every pending copy. Tempo edits move pending musical onsets and gates through the tempo timeline; clock-based step lengths retain seconds. Already submitted notes keep their timing.

Cycle callbacks receive independent Ramp values, so endpoint edits do not change the input pattern or another track. Offset and ratchet copies also own their Ramp endpoints. Direct `.transpose()` replaces each event's Ramp value before shifting its endpoints, preserving the caller's Ramp and shallow event copies; the event itself is still modified in place.

* `.transpose(semitones: number)`: Adds the offset to numeric values before scale conversion: MIDI semitones without a scale, scale degrees with one. On C minor, degree 0 transposed by 2 becomes Eb, not D. Note-name values shift chromatically and bypass scale mapping. Numeric/name Ramp endpoints follow the same rules; `.freq()` numeric values are Hz, so this is not a semitone conversion for Hz patterns.
* `.fast(factor: number)`: Speeds up the events in time by the specified factor.
* `.rev()`: Reverses the sequence of events.
* `.degrade(probability: number)`: Drops events based on a probability threshold (0.0 to 1.0).
* `.mutate(options: Object)`: Mutates events (ratchet, reverse, etc.) based on Markov-style options.
* `.offset(timeShift: string | number, modifier: Function)`: Duplicates and shifts events in time, applying the modifier function to the shifted copy.

```javascript
Track('lead')
  .note(['C4', 'E4', 'G4'])
  .every(2, (events) => events.transpose(-12).fast(2).rev())
  // Transform flattened event indices selected by the repeating mask
  .mask([true, false, true, false], (e) => {
    if (typeof e.value === 'string' && e.value !== 'Tie') {
      const m = noteToMidi(e.value);
      if (m) e.value = midiToNote(m + 7);
    }
    return e;
  })
  // Add an octave-up copy shifted by one eighth of the pattern duration
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

* `.euclid(pulses: number, steps: number, rotate?: number)` or `.euclid({ pulses: number, steps: number, rotate?: number })`: Replaces the current note pattern with evenly distributed `true` triggers and `null` rests across `steps`; it does not mask existing pitches. A later `.note()` replaces the Euclidean pattern.
* `.degrade(probability: number)`: Drops events based on a probability threshold (0.0 to 1.0).
* `.mutate({ chance, actions: { name: weight | true | (events) => events, ... } })`: On each pattern loop, with probability `chance`, picks **one** action by weighted random and applies it. Built-in actions: `ratchet` (doubles each event into two half-duration copies) and `reverse` (reverses event order). Pass `true` for default weight 1, a number for explicit weight, or a function `(events) => events` for a custom transform. Multiple listed actions are alternatives, not stacked.

```javascript
Track('hihats')
  .sample('drums/hat')
  .euclid(5, 8)
  .mutate({
    chance: 0.25,
    actions: {
      // 25% chance per loop: 2/3 odds pick ratchet, 1/3 odds pick reverse
      ratchet: 2,
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
* `.pattern(sliceIndices: Array)`: Schedules slices without `.note()`. Integer indices wrap within the slice count; nested arrays subdivide their parent slot, repeated indices retrigger it, and `null` is a rest. The pattern occupies one bar by default; `.stepLength()` sets each top-level slot duration and `.loopLength()` sets the repeat interval. Native playback defaults to MIDI 60 independently of `.scale()`. An explicit `.note()` or `.freq()` supplies pitches active at each slice onset on the normalized pitch-pattern timeline, including parallel pitches and rests; the slice pattern still owns onsets and gate lengths, regardless of setter order. With explicit `.note()`, scale mapping applies normally. `.note([0, 1, 2, 3])` supplies pitches, not slice indices. `.pattern(null)` removes slice scheduling and restores the explicit pitch rhythm; `.pattern([])` is silent.
* `.fit(duration: string | number, options?: { mode?: 'stretch' | 'repitch', grainSize?: number, overlap?: number })`: Fits the whole source buffer to the specified duration; each slice inherits that source-length ratio. This changes playback speed, not the pattern repeat interval. Slice playback stops at its scheduled gate or the fitted slice end, whichever comes first. By default, `mode: 'stretch'` uses a granular OLA time-stretcher to stretch or compress time while preserving original pitch. Pass `mode: 'repitch'` to fall back to pitch-linked playback rate scaling. `grainSize` (seconds, default `0.05`) and `overlap` (integer, default `4`) customize the stretcher parameters.
* `.splitStereo(modifier?: Function)`: Creates a right-channel Track and passes that Track to `modifier`; the callback does not receive an event array. Call after `.note()`/`.freq()` or `.pattern()` and source selection: the existing pattern and source are copied at split time, including sources still loading. The right channel adopts the captured buffer or sampler zones when ready; later parent source or pattern edits are not mirrored. Right-side `.synth()`, `.sample()`, or `.sampler()` overrides remain independent even if the captured load completes later. Configure right-side timing, scale, envelope, gain, sample slicing/fit, and modifiers explicitly inside the callback; these settings are not generally copied. Both channels obey the parent's `Arrange()` segments or direct `.start().stop()` boundaries, whether splitting happens before or after arrangement setup. Right-side pattern transforms remain independent. Set transport boundaries on the parent. The generated `<id>_right` Track ID is reserved; do not create or arrange it separately.

```javascript
Track('amen')
  .sample('breaks/amen.wav')
  .chop(8)
  .pattern([0, 1, 2, [3, 3], 4, 5, [7, 6], 0])
  .fit('1b', { mode: 'stretch', grainSize: 0.05, overlap: 4 })
  .splitStereo(right => right.chop(8).fit('1b', { mode: 'stretch', grainSize: 0.05, overlap: 4 }).every(1, events => events.rev())); // Right ear plays in reverse
```

---

## Audio Graphs, Modulation & FX

Audio routing in Motif utilizes Directed Acyclic Graphs (DAGs). Reactivity is achieved natively by assigning control signals to standard JavaScript variables.

### Control Signals & Variables

`LFO` (Low Frequency Oscillator) generates control-rate modulation mapped to musical timing. Calling `LFO(frequencyOrOptions, min?, max?)` returns a sine LFO signal by default.

Waveform constructors:

* `LFO.sine(options)`
* `LFO.triangle(options)`
* `LFO.square(options)`
* `LFO.saw(options)`

The `options` object supports:

* `frequency`: Frequency in Hz (defaults to `1.0`).
* `speed`: Musical duration string or number (e.g., `'4b'`, `'2s'`), which computes frequency dynamically.
* `min` / `max`: Mapped output range.
* `depth` / `gain`: Scaling depth multiplier (defaults to `1.0`).
* `offset`: Constant offset value (defaults to `0.0`).

Standard `const` and `let` declarations manage reactive state.

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

Tracks can directly modulate the parameters of other tracks at the sample rate. Supported parameter names for `.modulate()` include:

* **Filter:** `'filter.cutoff'` (or `'filter.frequency'`), `'filter.resonance'` (or `'filter.Q'`), `'filter.gain'`
* **Spatial & Level:** `'pan'`, `'volume'`, `'gain'`
* **EQ:** `'eq.low'`, `'eq.mid'`, `'eq.high'`
* **Dynamics:** `'compress.threshold'`, `'compress.ratio'`, `'compress.knee'`, `'compress.attack'`, `'compress.release'`

Methods & parameters:

* `.modulate(parameter: string, source: Track, options: Object)`: Modulate a track parameter with another track's audio output.
* `.sidechain(target: Track | string, options?: Object)`: Amplitude ducking driven by another track (commonly known as `duck`). Accepts either a Track instance or a track's unique string ID (e.g. `'kick'`). If the target track has not yet been instantiated, the connection is queued dynamically. `options` accepts `attack` (default: `0.005`s) and `release` (default: `0.2`s). Each trigger ducks the receiver to a fixed linear gain of `0.0001`, then returns to unity; depth is not configurable. `bass.sidechain(kick)` ducks the bass when the kick triggers, not the reverse.

```javascript
const modSource = Track('mod').synth('sine').note([100, 200]).mute();

Track('bass')
  .synth('saw')
  .note(['C3', 'G3'])
  .modulate('filter.cutoff', modSource, { depth: 500 })
  .sidechain('kick', { attack: 0.01, release: 0.18 }); // Bass receives ducking from kick triggers
```

### Buses & Feedback Loops

Global FX buses allow multi-track sending. Recursive routing is supported via a specific `.feedback()` method on Bus instances.

* `Bus(id: string)`: Instantiates an audio bus.
* `.send(bus: Bus, amount: number)`: Sends audio from a Track to a Bus.
* `.feedback({ amount, time })`: Adds a feedback loop to a Bus. `time` accepts seconds or a musical duration string and must resolve to between the 128-frame safety delay (`128 / AudioContext.sampleRate` seconds) and 60 seconds, inclusive; unsupported values throw a `RangeError` without changing an existing delay or feedback amount. The first call defaults to the safety delay when `time` is omitted; later calls without `time` preserve the current delay, while a valid explicit `time` updates the existing node.

```javascript
const dubDelay = Bus('dub')
  .filter({ type: 'highpass', cutoff: 400 })
  .feedback({ amount: 0.75, time: '3/16' });

Track('stab')
  .synth('square')
  .note(['C4', null, null, null])
  .send(dubDelay, 0.8);
```

---

## Custom DSP Generation

`.dsp(context => sample)` runs once per sample and channel of each scheduled voice, before its envelope, track gain, and effects. Return a finite number: Motif writes that sample to the output channel. Returning `0` means silence and keeps processing; booleans, missing returns, and non-finite values are errors. Motif supplies the AudioWorklet lifetime return and stops the processor at the voice's scheduled end, including tie release and voice stealing.

The context contains:

* `t`: seconds of rendered audio since this note started, beginning at zero.
* `p`: normalized phase in `[0, 1)`, beginning at zero and advancing by `freq / sampleRate` each frame. Pitch Ramps integrate their automated frequency without resetting phase.
* `i`: this voice's source sample for the current channel, before its envelope and effects. The default source is a sine; `.synth()`, `.sample()`, and `.sampler()` choose the input. Missing input is zero.
* `freq`: this note's frequency in Hz after note/scale/tuning conversion; sample notes use their requested pitch, independently of buffer playback rate.
* `sampleRate`: the audio context's sample rate in Hz.
* `channel`: zero-based output channel index. Mono inputs are duplicated to stereo.
* `state`: a mutable object retained for this voice and channel; each new note starts with an empty object.

```javascript
Track('generative_wave')
  .dsp(context => Math.sin(context.p * 2 * Math.PI))
  .freq([440])
  .gain(0.1);
```

This example produces a 440 Hz sine. For a source transform, `.dsp(context => context.i * 0.5)` halves each source sample. Replacing `.dsp()` affects subsequently allocated voices; active voices retain their callback. `splitStereo()` copies the callback at split time.

The callback is serialized and evaluated in AudioWorklet scope: surrounding song variables, imports, DOM APIs, and closures are unavailable. Use context fields, `Math`, literals, and `context.state`; define helper functions inside the callback. Do not write Web Audio output arrays or return a processor-lifetime boolean. Worklet render blocks are handled internally; sample accumulation such as an FFT requires your own buffer in `state`.

---

## Harmony & Xenharmonics

Motif supports continuous frequency modulation, MIDI pitch representation, strict microtonal/xenharmonic frameworks, and diatonic scale mapping.

* `.scale(root: string, name: string)`: Maps integer step values to diatonic scale degrees. Integers are interpreted as scale degrees (0-indexed), octave-qualified note names bypass degree mapping. `root` is a note-name string and **MUST include an octave** (e.g. `'C3'`, `'A2'`, `'F#4'`). An octave-less root like `'A'` is not parseable by `noteToMidi` and yields NaN MIDI values, producing silence.
* `.arp(mode: string)`: Unrolls a chord voicing into a sequential arpeggio. Modes: `'up'`, `'down'`, `'upDown'`, `'random'`.
* `.tuning(system: string)`: Snaps numeric integers to explicit Equal Divisions of the Octave (EDO) or custom ratios.
* `.chordVoicing(options: Object)`: Algorithmic voice leading.

Numeric `.note()` values are MIDI without a scale and integer degrees with one. Note names such as `'C4'` bypass degree mapping; `.freq()` uses Hz. Unknown scale names fall back to major; fractional degrees index nonexistent intervals and produce NaN. Whole-tone or octatonic material needs explicit MIDI/note-name patterns without an invented `.scale()` name. `.arp()` subdivides simultaneous event groups, such as `Parallel(...)`, into successive notes; an ordinary sequential melody has no chord group to subdivide.

```javascript
// Integer steps mapped to C minor: 0→C3, 2→Eb3, 4→G3, 7→C4
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

`Arrange()` stores Track references and activity windows on a continuous pattern timeline. Section entrances gate eligible onsets; they do not restart phrases, and existing notes can release beyond a section boundary. A 16-bar pattern entering at elapsed bar 8 starts halfway through its cycle. Boundaries at multiples of eight do not guarantee alignment with a 16-bar cycle. Deliberate five-step polymeters should retain their drift; choose entrance positions against their actual repeat interval.

`bars` counts transport bars (`Motif.beatsPerBar` quarter-note beats each), independently of track step/loop lengths. Windows, musical phase, section gain ramps, and final stop integrate BPM through `_beatAtTime()`/`_timeAtBeat()`. Empty final sections count toward duration. Automatic offline duration evaluates scheduled tempo callbacks in a disposable scheduler probe before rendering.

For non-looping playback, the final boundary stops new arranged onsets while submitted notes finish their gates and releases. The transport and WAV recording remain active until these voices and the master limiter's buffered output finish; the progress display stays at 100% and shows "Arrangement complete" during this interval. Delay/reverb effect tails do not extend completion. Explicit `Motif.stop()` still cancels voices immediately. Arrangement loops restart at their section boundary without an added release delay.

Tracks omitted from every section retain unrestricted activity unless separately bounded or muted. Section `tracks` must contain instances, not IDs or factory functions; values without `start()`/`stop()` are silently skipped. `{ tracks: [lead.note(a)] }` followed by `{ tracks: [lead.note(b)] }` immediately edits the same object twice, so both sections use the final pattern `b`. Use separate uniquely named tracks for different section patterns, and reuse an instance only when configuration should remain shared. Calling `Track('lead')` again creates a replacement registry entry rather than retrieving the instance.

```javascript
const leadA = Track('lead-a').synth('sine').note(['C4', 'Eb4']);
const leadB = Track('lead-b').synth('sine').note(['G4', 'Bb4']);
const sparseNotes = Array(16).fill(null);
sparseNotes[8] = 60;
const accent = Track('entrance-accent').sample('kick-electronic')
  .note(sparseNotes).stepLength('1b');

Arrange([
  { bars: 8, tracks: [leadA] },
  { bars: 1, tracks: [leadB, accent] },
  { bars: 7, tracks: [leadB] },
  { bars: 2, tracks: [] }
]);
```

The accent's 16-bar cycle has a native-pitch one-shot at index 8, matching its entrance at elapsed bar 8. Putting it only at index 0 would not trigger at this entrance. The one-bar gate permits its tail; choose gates for the source duration. The arrangement window restricts this accent to one onset.

`Arrange()` consumes one queued `.gain(Ramp(...))` per Track occurrence (duplicates inside one section count once). A single queued Ramp applies to the first occurrence only, not every reused section. Queue two Ramps before arranging a Track used in two sections, for example `leadA.gain(Ramp(0, 0.2)).gain(Ramp(0.2, 0))`. Without explicit duration each Ramp spans its assigned section. Ramp endpoints are absolute linear track gains, owned by the same stage as scalar/signal `.gain()`; `.volume()` remains a separate fader.

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

Solo selection applies across the entire track registry, including tracks omitted from the arrangement. Multiple tracks can be soloed simultaneously; all non-solo tracks are excluded.

```javascript
Track('bass').synth('fm').note(['C2', 'Eb2', 'F2', 'G2']).solo()
```

---

## Interactive Debugging & Section Testing

To isolate tracks or sections during development:

### Arrangement Start Flag

Add `s: 1` (or `start: true`) to a section inside the `Arrange` block to skip all sections prior to it, allowing you to test specific sections immediately during playback. If multiple sections have a start flag, the last one wins.

```javascript
Arrange([
  { bars: 8, tracks: [darkKeys] },
  // Skips the first section and starts here immediately
  { bars: 8, tracks: [darkKeys, subBass], s: 1 } 
]);
```

---

## Built-in Synthesizers & Procedural Samples

Motif includes a rich suite of built-in DSP synthesizers and procedurally generated samples, accessible directly by name.

### Built-in Synthesizers (`.synth(type)`)

* **Classic Analog & Retro:**
    * `'sine'`, `'sawtooth'`, `'square'`, `'triangle'`: Standard core geometric oscillators.
    * `'pulse'`, `'chip-pulse'`: Retro chiptune pulse waves with 15% and 25% duty cycles.
    * `'pwm-sweep'`: Sweeping pulse width modulation driven by an internal LFO.
    * `'sub-bass'`: Saturated driven sub-bass.
    * `'sub-sweep'`: Sustained sine sub with pitch-sweep transient (starts at 2× frequency, falls to played note — shape amplitude with `.envelope()`).
    * `'supersaw'`: Five detuned sawtooth oscillators for thick pads/leads.
    * `'soft-square'`: Warm additive square wave (fundamental + 3rd + 5th harmonics).
    * `'bass-acid-hq'`: Silver-box emulator with 4-pole resonant lowpass sweep.
    * `'bass-rubber-idm'`: Squelchy FM bass with punchy exponential envelopes.
    * `'bass-reese'`: Detuned saw stack through an LFO-swept lowpass with a clean sub octave below.
    * `'arp-narrow-drift'`: Narrow PolyBLEP pulse with restrained PWM, pitch drift and a decaying lowpass contour.
    * `'bass-compact-saw'`: Two closely detuned PolyBLEP saws through a short lowpass contour, plus a clean sub octave.
    * `'pad-dusk-saws'`: Three gently detuned PolyBLEP saws through a slowly breathing lowpass. Use `.envelope()` for the pad's attack and release.
    * `'chip-lead-pd'`: Phase distortion Casio-style lead synthesizer.
    * `'chip-bass-fm'`: FM sub-bass with 2x ratio modulator transient.
* **Tape & Ambient Textures:**
    * `'tape-sine'`: Sine wave with tape wow and flutter pitch drift.
    * `'ambient-pad'`: Swelling pad using slightly detuned, low-passed sines.
    * `'keys-drift'`: Rhodes-like electric piano with pitch instability and saturation.
    * `'pad-hauntology'`: Dusty, degraded pad with tape hiss and slow lowpass sweep.
    * `'lead-vintage-board'`: Drifting lead synth with attack portamento slur.
    * `'drone-abyss'`: Dark ambient drone combining sub-sine and detuned saws.
    * `'pad-shimmer'`: Ethereal FM pad with upper-harmonic shimmer.
    * `'drone-beating'`: Meditative dual sines spaced 1Hz apart for natural acoustic beating.
    * `'alien-glow-pad'`: Warm, slow LFO-modulated FM pad.
    * `'magnetic-hover'`: Muffled SVF lowpass filtered triangle waves.
    * `'tectonic-drone'`: Heavily detuned low waves through a dark, low-resonance SVF.
* **Noise & Texture:**
    * `'noise-white'`: Pure random digital static.
    * `'noise-pink'`: Pink noise (-3dB/oct) using Kellett's approximation.
    * `'noise-brown'`, `'noise-brown-deep'`: Leaky integrator lowpass filtered noise.
    * `'crackle'`: Vinyl pop/dust crackles (approx. 5 random pops/sec).
    * `'ambient-wind'`: Lowpass filtered noise swept by a slow LFO.
* **Glitch & Generative:**
    * `'bytebeat'`: Algorithmic bitwise fractal tearing at 8kHz.
    * `'bit-crush-sine'`: 8-level quantized amplitude sine wave.
    * `'math-tan'`: Attenuated tangent wave clamped for metallic digital glitching.
    * `'math-fold'`: Self-modulating wavefolded sine wave.
    * `'neuro-fold'`: Aggressive IDM wavefolded bass wobble.
    * `'glitch-scatter'`: Quantized amplitude with randomized sample freezing.
* **Instrument Modeling:**
    * `'fm-epiano'`, `'keys-fm-hq'`: FM electric piano synthesizers.
    * `'ambient-bell'`: FM bell with inharmonic overtone decay.
    * `'tine-fm'`: Generative kalimba with thumb click transient.
    * `'karplus-strong'`: Physically modeled plucked string (guitar/harp).
    * `'pad-choir'`: Formant-filtered choral pad generating an "Ah" vowel.
    * `'synth-brass'`: Resonant lowpass swept sawtooth brass section.
    * `'organ-drawbar'`: Additive tonewheel organ with percussion transient and rotary vibrato/tremolo.
    * `'strings-ensemble'`: Solina-style string machine with per-layer chorus LFOs and bow-noise shimmer.
    * `'glass-mallet'`: Woody/glassy pluck using inharmonic FM.
    * `'chip-arp-pluck'`: Fast-decaying inharmonic FM pluck for rapid arpeggiation.
    * `'hollow-wood-flute'`: Breath/vibrato modulated flute with woody overtones.
    * `'gamelan-saron'`: Inharmonic FM model of a bronze metallophone.
    * `'suling-flute'`: Traditional bamboo flute modeled via SVF filtered noise.
* **Orchestral Solo Instruments:**
    * `'orch-violin'`, `'orch-cello'`: Bowed solo strings with body-weighted harmonics, bow onset and delayed vibrato.
    * `'orch-french-horn'`: Rounded brass harmonics with a gradual brightness bloom.
    * `'orch-flute'`: Concert flute with tapered harmonics, breath onset and pressure bloom.
    * `'orch-oboe'`: Formant-weighted reed tone with a focused attack and delayed vibrato.

These are sustained mono voice models; use `.envelope()` for note-off release. Their harmonic profiles update at a slower control rate while oscillator pitch follows each sample. Violin and cello complement the existing string-machine ensemble; concert flute and French horn complement the wooden/bamboo flutes and synth brass.

### Procedural Samples (`.sample(name)`)

Avoid loading external assets by playing procedurally rendered static one-shots:

* **Drums:** `'kick-electronic'`, `'kick-lofi'`, `'snare-electronic'`, `'tom-electronic'`, `'rimshot'`, `'hihat-closed'`, `'hihat-open'`, `'hihat-pedal'`, `'cymbal-ride'`, `'cymbal-crash'`, `'cymbal-reverse'`, `'shaker-soft'`, `'clap-vintage'`
* **Dark Percussion/FX:** `'dark-thud'` (muted kick, 0.46 seconds), `'dark-gated-snare'` (rounded gated snare, 0.22 seconds), `'dark-shadow-hat'` (damped metallic tick, 0.145 seconds), `'dark-reverse-glass'` (rising glass and noise swell, 1.2 seconds). These are generated buffers; no audio files are required.
* **Percussion/FX:** `'water-drop'`, `'block-hollow'`, `'snare-micro'`, `'cowbell-808'`, `'perc-stutter'`, `'impact-deep'`, `'break-snare-ghost'`, `'glitch-data-burst'`, `'sub-boom'`, `'chip-kick-laser'`, `'chip-snare-burst'`, `'gravitational-ripple'`
* **Acoustic/Physical:** `'kick-acoustic'`, `'snare-acoustic'`, `'tambourine'`, `'conga'`, `'bongo'`, `'kalimba-pluck'`, `'kalimba-warm'`, `'music-box'`, `'wineglass'`, `'timpani'`, `'ui-blip'`, `'pickup-chime'`, `'gong-tibetan'`, `'void-chime'`, `'ocean-swell'`, `'mossy-stone-strike'`
* **Orchestral Pitched One-Shots:** `'orch-harp-c4'` (C4, 5.5 seconds), `'orch-celesta-c5'` (C5, 5.8 seconds), `'orch-tubular-bells-c5'` (nominal C5 strike pitch, 5.8 seconds). `'timpani'` uses a D2 membrane-mode model with a felt strike, a settling pitch glide and a 3.8-second buffer.

`.sample(name).note([60])` plays any of these buffers at its recorded pitch: MIDI 60 is the native-rate trigger, regardless of the root in the name. For concert-pitch melodies, use the existing sampler with the actual root: `{ C4: 'orch-harp-c4' }`, `{ C5: 'orch-celesta-c5' }`, `{ D2: 'timpani' }`, or `{ C5: 'orch-tubular-bells-c5' }`. Tubular bells have an inharmonic spectrum, so C5 describes the intended strike pitch rather than the strongest spectral peak.

```javascript
const celesta = Track('celesta')
    .sampler({ urls: { C5: 'orch-celesta-c5' }, release: 0.2 })
    .stepLength('1/2')
    .note(['C5', 'E5', 'G5', 'C6']);
```

Sample gates and releases still determine how much of each tail plays. Transposing a buffer also changes its duration and spectral shape; these single-root instruments are best suited to moderate transpositions.

Every noise-based procedural sample renders deterministically: seed `0` (the default) always produces the same canonical buffer, so a given sample sounds identical across sessions and machines. Use `Motif.sampleSeed(n)` to explore variations:

* `Motif.sampleSeed(42)` — sets an explicit seed. Same seed always re-renders byte-identical audio.
* `Motif.sampleSeed()` — no argument picks a random 32-bit seed, applies it, and returns it so you can log or replay that exact variation later.
* Re-seeding mid-session invalidates already-rendered buffers — the next time each procedural sample plays, it re-renders under the new seed. Real-time synths (`'noise-white'`, `'crackle'`, etc.) are unaffected; only offline one-shot buffers are seeded.

---

## Utility Functions & Built-in Scales

Motif exports several helper functions, mathematical helpers, and scales:

### Exported Functions

* `noteToMidi(note: string): number` — Converts note names (e.g. `'C4'`) to MIDI values (e.g. `60`).
* `midiToNote(midi: number): string` — Converts MIDI values to note names.
* `midiToHz(midi: number): number` — Converts MIDI values to frequencies in Hz.
* `degreeToMidi(degree: number, root: string, scaleName: string): number` — Resolves scale degree to MIDI note.
* `parseDurationToFraction(duration: string | number): number` — Parses duration strings (e.g. `'1/16'`) to numeric fractions.
* `parseDurationToSeconds(duration: string | number, bpm: number, beatsPerBar: number): number` — Resolves duration strings to absolute seconds.

### Built-in Scales (`SCALES`)

Passed to `.scale(root, name)`. Accessible via the exported `SCALES` object:

* `major` / `ionian`
* `minor` / `aeolian`
* `dorian`
* `phrygian`
* `lydian`
* `mixolydian`
* `locrian`
* `harmonicMinor`
* `melodicMinor`
* `pentatonicMajor`
* `pentatonicMinor`

---

## External I/O & Asynchronous Operations

Motif utilizes native JavaScript `await` functionality for sample loading.

```javascript
// Asynchronous sample fetching
await Motif.loadSamples('https://api.domain.com/packs/drums.json');
```

