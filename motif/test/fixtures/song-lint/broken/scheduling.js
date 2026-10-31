const track = Track("bad").synth("sine").note([60]);
track._schedule = () => {
    throw new Error("fixture scheduling failure");
};
