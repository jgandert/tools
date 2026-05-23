// =============================================================================
// "The Grand Gallery" - A Systemic Showcase of Motif.js Instruments
// =============================================================================
//
// This master composition takes the listener through a 32-bar journey.
// It systematically triggers EVERY procedural synthesizer (27 synths) and
// EVERY static audio sample (17 samples) exactly ONCE.
//
// Structured in four thematic movements:
// 1. Part I: The Dawn (Ambient, pads, and noise textures)
// 2. Part II: The Spark (Pulse wave chiptunes and electronic percussion)
// 3. Part III: The Core (Heavy analog basses and physical modeling drums)
// 4. Part IV: The Resonance (Frequency modulation bells and organic plucks)
//
// Masterfully spatialized, EQed, and routed to a central spatial feedback bus.
// -----------------------------------------------------------------------------

Motif.setTempo(100);
Motif.master({
    gain: 0.8,
    limiter: true,
    eq: { low: 2.0, mid: -0.5, high: 1.5 },
});

// -----------------------------------------------------------------------------
// Global Spatial Reverb & Feedback Delay Bus
// -----------------------------------------------------------------------------
const spatialDelay = Bus("spatialDelay")
    .filter({ type: "bandpass", cutoff: 1400, resonance: 1.0 })
    .volume("-8dB")
    .pan(LFO.sine({ min: -0.6, max: 0.6, speed: "8b" }));

spatialDelay.feedback({ amount: 0.4 });

// -----------------------------------------------------------------------------
// PART I: THE DAWN (Ambient & Textures - Bars 1 to 8)
// -----------------------------------------------------------------------------

const s_ambient_pad = Track("s_ambient_pad")
    .synth("ambient-pad")
    .note([Parallel("C3", "E3", "G3")])
    .stepLength("1b")
    .envelope({ attack: 0.8, decay: 0.4, sustain: 0.8, release: 1.5 })
    .volume("-14dB")
    .pan(-0.4)
    .send(spatialDelay, 0.5);

const sm_wineglass = Track("sm_wineglass")
    .sample("wineglass")
    .note(["C5"])
    .stepLength("1b")
    .volume("-16dB")
    .pan(0.4)
    .send(spatialDelay, 0.6);

const s_tape_sine = Track("s_tape_sine")
    .synth("tape-sine")
    .note(["E3"])
    .stepLength("1b")
    .envelope({ attack: 0.4, decay: 0.6, sustain: 0.7, release: 1.2 })
    .volume("-12dB")
    .pan(0.3)
    .send(spatialDelay, 0.4);

const sm_water_drop = Track("sm_water_drop")
    .sample("water-drop")
    .note(["C5"])
    .stepLength("1b")
    .volume("-10dB")
    .pan(-0.3)
    .send(spatialDelay, 0.7);

const s_pad_choir = Track("s_pad_choir")
    .synth("pad-choir")
    .note(["G3"])
    .stepLength("1b")
    .envelope({ attack: 0.7, decay: 0.5, sustain: 0.8, release: 1.6 })
    .volume("-13dB")
    .pan(-0.2)
    .send(spatialDelay, 0.5);

const sm_shaker_soft = Track("sm_shaker_soft")
    .sample("shaker-soft")
    .note(["C4"])
    .stepLength("1b")
    .volume("-18dB")
    .pan(0.5);

const s_soft_square = Track("s_soft_square")
    .synth("soft-square")
    .note(["C4"])
    .stepLength("1b")
    .envelope({ attack: 0.3, decay: 0.5, sustain: 0.6, release: 1.0 })
    .volume("-15dB")
    .pan(0.2)
    .send(spatialDelay, 0.3);

const sm_music_box = Track("sm_music_box")
    .sample("music-box")
    .note(["E5"])
    .stepLength("1b")
    .volume("-12dB")
    .pan(-0.5)
    .send(spatialDelay, 0.5);

const s_noise_brown_deep = Track("s_noise_brown_deep")
    .synth("noise-brown-deep")
    .note(["C1"])
    .stepLength("1b")
    .envelope({ attack: 0.5, decay: 0.5, sustain: 1.0, release: 1.0 })
    .filter({ type: "lowpass", cutoff: 120 })
    .volume("-18dB");

const s_noise_brown = Track("s_noise_brown")
    .synth("noise-brown")
    .note(["C2"])
    .stepLength("1b")
    .envelope({ attack: 0.4, decay: 0.6, sustain: 0.8, release: 1.0 })
    .filter({ type: "lowpass", cutoff: 350 })
    .volume("-22dB")
    .pan(-0.3);

const s_noise_pink = Track("s_noise_pink")
    .synth("noise-pink")
    .note(["C3"])
    .stepLength("1b")
    .envelope({ attack: 0.3, decay: 0.7, sustain: 0.7, release: 0.8 })
    .filter({ type: "bandpass", cutoff: 600 })
    .volume("-24dB")
    .pan(0.3);

const s_noise_white = Track("s_noise_white")
    .synth("noise-white")
    .note(["C4"])
    .stepLength("1b")
    .envelope({ attack: 0.2, decay: 0.8, sustain: 0.6, release: 0.8 })
    .filter({ type: "highpass", cutoff: 1500 })
    .volume("-26dB")
    .pan(-0.4);

const s_crackle = Track("s_crackle")
    .synth("crackle")
    .note(["C5"])
    .stepLength("1b")
    .volume("-20dB")
    .pan(0.4);

// -----------------------------------------------------------------------------
// PART II: THE SPARK (Pulse, Retro & Chiptune - Bars 9 to 16)
// -----------------------------------------------------------------------------

const s_chip_pulse = Track("s_chip_pulse")
    .synth("chip-pulse")
    .note(["C4"])
    .stepLength("1b")
    .envelope({ attack: 0.02, decay: 0.2, sustain: 0.4, release: 0.3 })
    .volume("-15dB")
    .pan(-0.3);

const sm_rimshot = Track("sm_rimshot")
    .sample("rimshot")
    .note(["C4"])
    .stepLength("1b")
    .volume("-14dB")
    .pan(0.3);

const s_pulse = Track("s_pulse")
    .synth("pulse")
    .note(["E4"])
    .stepLength("1b")
    .envelope({ attack: 0.05, decay: 0.15, sustain: 0.3, release: 0.2 })
    .volume("-16dB")
    .pan(0.2);

const sm_hihat_closed = Track("sm_hihat_closed")
    .sample("hihat-closed")
    .note(["C4"])
    .stepLength("1b")
    .volume("-18dB")
    .pan(-0.4);

const s_square = Track("s_square")
    .synth("square")
    .note(["G4"])
    .stepLength("1b")
    .envelope({ attack: 0.03, decay: 0.25, sustain: 0.4, release: 0.3 })
    .volume("-16dB")
    .pan(-0.2);

const sm_cymbal_ride = Track("sm_cymbal_ride")
    .sample("cymbal-ride")
    .note(["C4"])
    .stepLength("1b")
    .volume("-15dB")
    .pan(0.4)
    .send(spatialDelay, 0.3);

const s_bit_crush_sine = Track("s_bit_crush_sine")
    .synth("bit-crush-sine")
    .note(["C5"])
    .stepLength("1b")
    .envelope({ attack: 0.01, decay: 0.12, sustain: 0.2, release: 0.2 })
    .volume("-17dB")
    .pan(0.3);

const sm_clap_vintage = Track("sm_clap_vintage")
    .sample("clap-vintage")
    .note(["C4"])
    .stepLength("1b")
    .volume("-14dB")
    .pan(-0.3)
    .send(spatialDelay, 0.4);

const s_bytebeat = Track("s_bytebeat")
    .synth("bytebeat")
    .note(["G3"])
    .stepLength("1b")
    .envelope({ attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.2 })
    .volume("-20dB")
    .pan(-0.5);

const sm_snare_electronic = Track("sm_snare_electronic")
    .sample("snare-electronic")
    .note(["C4"])
    .stepLength("1b")
    .volume("-13dB")
    .pan(0.2);

const s_math_tan = Track("s_math_tan")
    .synth("math-tan")
    .note(["C4"])
    .stepLength("1b")
    .envelope({ attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.2 })
    .volume("-22dB")
    .pan(0.4);

const sm_tom_electronic = Track("sm_tom_electronic")
    .sample("tom-electronic")
    .note(["C4"])
    .stepLength("1b")
    .volume("-14dB")
    .pan(-0.2);

const s_math_fold = Track("s_math_fold")
    .synth("math-fold")
    .note(["D4"])
    .stepLength("1b")
    .envelope({ attack: 0.04, decay: 0.25, sustain: 0.3, release: 0.2 })
    .volume("-18dB")
    .pan(-0.3);

// -----------------------------------------------------------------------------
// PART III: THE CORE (Analog & Heavy Basses - Bars 17 to 24)
// -----------------------------------------------------------------------------

const s_sub_bass = Track("s_sub_bass")
    .synth("sub-bass")
    .note(["C2"])
    .stepLength("1b")
    .envelope({ attack: 0.08, decay: 0.4, sustain: 0.8, release: 0.6 })
    .volume("-8dB");

const sm_kick_electronic = Track("sm_kick_electronic")
    .sample("kick-electronic")
    .note(["C3"])
    .stepLength("1b")
    .volume("-6dB");

const s_sine = Track("s_sine")
    .synth("sine")
    .note(["E2"])
    .stepLength("1b")
    .envelope({ attack: 0.05, decay: 0.3, sustain: 0.7, release: 0.4 })
    .volume("-10dB")
    .pan(-0.2);

const sm_kick_lofi = Track("sm_kick_lofi")
    .sample("kick-lofi")
    .note(["C3"])
    .stepLength("1b")
    .volume("-7dB");

const s_triangle = Track("s_triangle")
    .synth("triangle")
    .note(["G2"])
    .stepLength("1b")
    .envelope({ attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.5 })
    .volume("-11dB")
    .pan(0.2);

const sm_kick_acoustic = Track("sm_kick_acoustic")
    .sample("kick-acoustic")
    .note(["C3"])
    .stepLength("1b")
    .volume("-6dB");

const s_sawtooth = Track("s_sawtooth")
    .synth("sawtooth")
    .note(["C3"])
    .stepLength("1b")
    .envelope({ attack: 0.05, decay: 0.35, sustain: 0.5, release: 0.5 })
    .filter({ type: "lowpass", cutoff: 600 })
    .volume("-12dB")
    .pan(-0.4);

const sm_timpani = Track("sm_timpani")
    .sample("timpani")
    .note(["C2"])
    .stepLength("1b")
    .volume("-8dB")
    .pan(0.3)
    .send(spatialDelay, 0.4);

const s_pwm_sweep = Track("s_pwm_sweep")
    .synth("pwm-sweep")
    .note(["C3"])
    .stepLength("1b")
    .envelope({ attack: 0.1, decay: 0.4, sustain: 0.6, release: 0.8 })
    .filter({ type: "lowpass", cutoff: 800 })
    .volume("-13dB")
    .pan(0.4);

const s_supersaw = Track("s_supersaw")
    .synth("supersaw")
    .note([Parallel("C3", "Eb3", "G3")])
    .stepLength("1b")
    .envelope({ attack: 0.15, decay: 0.4, sustain: 0.7, release: 1.0 })
    .filter({ type: "lowpass", cutoff: 1200 })
    .volume("-14dB")
    .pan(-0.3)
    .send(spatialDelay, 0.5);

const s_synth_brass = Track("s_synth_brass")
    .synth("synth-brass")
    .note([Parallel("F3", "A3", "C4")])
    .stepLength("1b")
    .envelope({ attack: 0.2, decay: 0.5, sustain: 0.6, release: 1.2 })
    .volume("-13dB")
    .pan(0.3)
    .send(spatialDelay, 0.4);

// -----------------------------------------------------------------------------
// PART IV: THE RESONANCE (Physical Bells & Plucks - Bars 25 to 32)
// -----------------------------------------------------------------------------

const s_fm_epiano = Track("s_fm_epiano")
    .synth("fm-epiano")
    .note(["C4"])
    .stepLength("1b")
    .envelope({ attack: 0.01, decay: 0.4, sustain: 0.5, release: 0.8 })
    .volume("-12dB")
    .pan(-0.4)
    .send(spatialDelay, 0.5);

const sm_kalimba_pluck = Track("sm_kalimba_pluck")
    .sample("kalimba-pluck")
    .note(["C4"])
    .stepLength("1b")
    .volume("-10dB")
    .pan(0.4)
    .send(spatialDelay, 0.4);

const s_ambient_bell = Track("s_ambient_bell")
    .synth("ambient-bell")
    .note(["E4"])
    .stepLength("1b")
    .envelope({ attack: 0.01, decay: 0.8, sustain: 0.2, release: 1.5 })
    .volume("-14dB")
    .pan(0.3)
    .send(spatialDelay, 0.6);

const sm_kalimba_warm = Track("sm_kalimba_warm")
    .sample("kalimba-warm")
    .note(["C4"])
    .stepLength("1b")
    .volume("-11dB")
    .pan(-0.3)
    .send(spatialDelay, 0.4);

const s_tine_fm = Track("s_tine_fm")
    .synth("tine-fm")
    .note(["G4"])
    .stepLength("1b")
    .envelope({ attack: 0.005, decay: 0.6, sustain: 0.3, release: 1.0 })
    .volume("-12dB")
    .pan(-0.2)
    .send(spatialDelay, 0.5);

const sm_block_hollow = Track("sm_block_hollow")
    .sample("block-hollow")
    .note(["C4"])
    .stepLength("1b")
    .volume("-12dB")
    .pan(0.3)
    .send(spatialDelay, 0.4);

const s_karplus_strong = Track("s_karplus_strong")
    .synth("karplus-strong")
    .note(["C5"])
    .stepLength("1b")
    .volume("-14dB")
    .pan(0.4)
    .send(spatialDelay, 0.5);

// -----------------------------------------------------------------------------
// Arrangement Definition (32 Bars Total)
// -----------------------------------------------------------------------------
Arrange([
    // Part I: The Dawn (Ambient, pads, and noise textures - Bars 1 to 8)
    { bars: 1, tracks: [s_ambient_pad, sm_wineglass] },
    { bars: 1, tracks: [s_tape_sine, sm_water_drop] },
    { bars: 1, tracks: [s_pad_choir, sm_shaker_soft] },
    { bars: 1, tracks: [s_soft_square, sm_music_box] },
    { bars: 1, tracks: [s_noise_brown_deep, s_noise_brown] },
    { bars: 1, tracks: [s_noise_pink, s_noise_white] },
    { bars: 1, tracks: [s_crackle] },
    { bars: 1, tracks: [] }, // Breath transition

    // Part II: The Spark (Pulse, Retro & Chiptune - Bars 9 to 16)
    { bars: 1, tracks: [s_chip_pulse, sm_rimshot] },
    { bars: 1, tracks: [s_pulse, sm_hihat_closed] },
    { bars: 1, tracks: [s_square, sm_cymbal_ride] },
    { bars: 1, tracks: [s_bit_crush_sine, sm_clap_vintage] },
    { bars: 1, tracks: [s_bytebeat, sm_snare_electronic] },
    { bars: 1, tracks: [s_math_tan, sm_tom_electronic] },
    { bars: 1, tracks: [s_math_fold] },
    { bars: 1, tracks: [] }, // Breath transition

    // Part III: The Core (Analog & Heavy Basses - Bars 17 to 24)
    { bars: 1, tracks: [s_sub_bass, sm_kick_electronic] },
    { bars: 1, tracks: [s_sine, sm_kick_lofi] },
    { bars: 1, tracks: [s_triangle, sm_kick_acoustic] },
    { bars: 1, tracks: [s_sawtooth, sm_timpani] },
    { bars: 1, tracks: [s_pwm_sweep] },
    { bars: 1, tracks: [s_supersaw] },
    { bars: 1, tracks: [s_synth_brass] },
    { bars: 1, tracks: [] }, // Breath transition

    // Part IV: The Resonance (Physical Bells & Plucks - Bars 25 to 32)
    { bars: 1, tracks: [s_fm_epiano, sm_kalimba_pluck] },
    { bars: 1, tracks: [s_ambient_bell, sm_kalimba_warm] },
    { bars: 1, tracks: [s_tine_fm, sm_block_hollow] },
    { bars: 1, tracks: [s_karplus_strong] },
    { bars: 4, tracks: [] }, // Final decay loop fade out
]);
