"""Check track gain ownership against real Chromium audio; retain fresh evidence."""

import argparse
import array
import json
from pathlib import Path
import subprocess
import sys
import wave

ROOT = Path(__file__).resolve().parents[2]
AUDIT = ROOT / "test/render-audit"
OUTPUT = AUDIT / "output"


def read_pcm(path):
    with wave.open(str(path), "rb") as wav:
        rate = wav.getframerate()
        pcm = array.array("h", wav.readframes(wav.getnframes()))
        if sys.byteorder != "little":
            pcm.byteswap()
        return rate, pcm


def rms(audio, start, end):
    rate, pcm = audio
    values = pcm[round(start * rate) * 2:round(end * rate) * 2]
    return (sum((value / 32768) ** 2 for value in values) / len(values)) ** .5


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="Fresh evidence name, beginning with f3-")
    args = parser.parse_args()
    if not args.name.startswith("f3-") or Path(args.name).name != args.name:
        parser.error("Use a simple name beginning with f3-")
    evidence = OUTPUT / args.name
    audio_dir = OUTPUT / "audio" / args.name
    evidence.mkdir(parents=True, exist_ok=False)
    audio_dir.mkdir(parents=True, exist_ok=False)
    songs = AUDIT / args.name / "songs"
    songs.mkdir(parents=True)
    checks = []

    def render(name, source=None):
        song = AUDIT / "songs" / f"{name}.js"
        if source is not None:
            song = songs / f"{name}.js"
            song.write_text(source)
        path = audio_dir / f"{name}.wav"
        with (evidence / f"{name}.log").open("x") as log:
            subprocess.run(
                ["python3", str(ROOT / "render_wav.py"), str(song), str(path), "--seconds", "6"],
                stdout=log, stderr=subprocess.STDOUT, check=True, timeout=700)
        return read_pcm(path)

    def check(name, passed, **metrics):
        result = {"name": name, "pass": bool(passed), **metrics}
        checks.append(result)
        print(json.dumps(result), flush=True)

    before = render("custom-gain-before-pan")
    after = render("custom-gain-after-pan")
    ratio = rms(after, .1, 1.9) / rms(before, .1, 1.9)
    check("Gain is independent of effect initialization order", before == after,
          afterToBeforeRatio=ratio)

    for kind in ("synth", "sample"):
        setup = '''Motif.setTempo(120);
Motif.master({gain: 0.1, limiter: true});
const buffer = Motif.ctx.createBuffer(1, 48000 * 6, 48000);
const pcm = buffer.getChannelData(0);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
Motif.sampleRegistry.set("tone", buffer);
'''
        instrument = '.synth("sine").freq([440])' if kind == "synth" else '.sample("tone").note([60])'
        base = setup + f'const t = Track("tone"){instrument}.stepLength(2).envelope({{attack: .01, decay: .02, sustain: .7, release: .05}});\n'
        control = render(f"{kind}-unity", base + 't.pan(0);\n')
        variants = []
        for order in ("before", "after"):
            chain = 't.gain(.5).pan(0);' if order == "before" else 't.pan(0).gain(.5);'
            source = base + chain + '''
Motif.schedule(1, () => t.gain(.25));
Motif.schedule(2.5, () => t.gain(Ramp(.2, .6, 1)));
Motif.schedule(3, () => t.gain(.3));
Motif.schedule(3.5, () => Motif.setTempo(90));
Motif.schedule(4.5, () => t.gain(0));
'''
            changed = render(f"{kind}-{order}", source)
            variants.append(changed)
            for label, start, end, expected in [("initial", .2, .8, .5),
                                                ("active voice edit", 1.2, 1.8, .25),
                                                ("new voice after edit", 2.15, 2.3, .25),
                                                ("Ramp replacement", 3.2, 3.4, .3),
                                                ("replacement after tempo edit", 3.7, 3.9, .3)]:
                ratio = rms(changed, start, end) / rms(control, start, end)
                check(f"{kind} {order}: {label}", abs(ratio - expected) < .002, ratio=ratio,
                      expected=expected)
            ramp_ratio = rms(changed, 2.7, 2.8) / rms(control, 2.7, 2.8)
            check(f"{kind} {order}: live Ramp starts at edit", .27 < ramp_ratio < .33,
                  ratio=ramp_ratio)
            check(f"{kind} {order}: zero silences active and new voices",
                  rms(changed, 4.7, 5.8) == 0)
        check(f"{kind}: live chains are PCM-identical", variants[0] == variants[1])
        arranged = render(f"{kind}-arranged", base + '''t.gain(.5).pan(0);
Arrange([{tracks: [t.gain(Ramp(.2, .6, "2 bars"))], bars: 3}]);
Motif.schedule(1, () => t.gain(.3));
Motif.schedule(1.5, () => Motif.rampTempo(90, 1, {smooth: true}));
''')
        ratio = rms(arranged, .2, .4) / rms(control, .2, .4)
        check(f"{kind}: arranged Ramp endpoints are absolute", .225 < ratio < .235, ratio=ratio)
        ratio = rms(arranged, 2.2, 2.8) / rms(control, 2.2, 2.8)
        check(f"{kind}: scalar overrides arranged Ramp across tempo change", abs(ratio - .3) < .002,
              ratio=ratio)

    with (evidence / "checks.json").open("x") as report:
        json.dump(checks, report, indent=2)
        report.write("\n")
    return 0 if all(check["pass"] for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
