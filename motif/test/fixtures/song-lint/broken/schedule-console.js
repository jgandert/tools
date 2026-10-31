const track = Track("bad").synth("sine").note([60]);
track._playEvent = () => console.error("fixture playback console error");
