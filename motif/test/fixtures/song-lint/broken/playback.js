const track = Track('bad').synth('sine').note([60]);
track._playEvent = () => { throw new Error('fixture playback failure'); };
