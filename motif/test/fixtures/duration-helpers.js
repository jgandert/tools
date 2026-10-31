const fraction = parseDurationToFraction("1/16");
const seconds = parseDurationToSeconds("1/4", 120, 4);
if (fraction !== 0.0625 || seconds !== 0.5) throw new Error("duration helper result mismatch");

const ids = [
    "theme_main", "theme_hocket", "theme_dorian", "counter_line", "bass_groove",
    "bass_friction", "bass_climax", "cascade_arp", "cascade_crest", "stabs_groove",
    "stabs_climax", "flute_augmented", "outro_pickup",
];
const tracks = ids.map(id => Track(id).synth("sine").note([60]).gain(0.001));
Arrange([{ bars: fraction, tracks }]);
