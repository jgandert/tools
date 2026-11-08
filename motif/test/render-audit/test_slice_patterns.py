"""Render native and pitched nested slice patterns with safe independent tone buffers."""
import argparse
import array
import json
import math
from pathlib import Path
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[2]
AUDIT = Path(__file__).resolve().parent
OUTPUT = AUDIT / "output"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    args = parser.parse_args()
    if not args.tag.replace("-", "").isalnum():
        raise ValueError("Use an alphanumeric unused tag")
    work = OUTPUT / f"f10-{args.tag}"
    work.mkdir(parents=True)
    songs = AUDIT / f"f10-{args.tag}"
    songs.mkdir()
    (OUTPUT / "audio").mkdir(parents=True, exist_ok=True)
    results = []
    for mode in ("stretch", "repitch"):
        for pitched in (False, True):
            name = f"{mode}-{'pitched' if pitched else 'native'}"
            source = songs / f"{name}.js"
            source.write_text('''Motif.setTempo(120);
Motif.master({ gain: 0.2, limiter: true });
const buffer = Motif.ctx.createBuffer(2, 96000, 48000);
for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
        const slice = Math.floor(i / 24000);
        data[i] = 0.3 * Math.sin(2 * Math.PI * (200 + slice * 200) * (i % 24000) / 48000);
    }
}
Motif.sampleRegistry.set("slice-tones", buffer);
Track("slices").sample("slice-tones").chop(4)
    .pattern([0, 1, [2, 2], 3])
''' + (
                '    .note([60, 60, 72, 60])\n' if pitched else '') + f'''    .stepLength(1).fit(4, {{ mode: "{mode}", grainSize: 0.04, overlap: 4 }})
    .start(0).stop(4);
''')
            output = OUTPUT / "audio" / f"f10-{args.tag}-{name}.wav"
            if output.exists():
                raise FileExistsError(output)
            with (work / f"{name}.log").open("x") as log:
                subprocess.run(
                    ["python3", str(ROOT / "render_wav.py"), str(source), str(output), "--seconds",
                     "5"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=700)
            with wave.open(str(output)) as wav:
                rate = wav.getframerate()
                samples = array.array("h", wav.readframes(wav.getnframes()))

            def rms(start, end):
                values = samples[2 * round(start * rate):2 * round(end * rate):2]
                return math.sqrt(sum((value / 32768) ** 2 for value in values) / len(values))

            def frequency(start, end):
                crossings = []
                for frame in range(round(start * rate) + 1, round(end * rate)):
                    previous, current = samples[2 * (frame - 1)], samples[2 * frame]
                    if previous < 0 <= current:
                        crossings.append(frame - 1 - previous / (current - previous))
                if len(crossings) < 2:
                    return 0
                return (len(crossings) - 1) * rate / (crossings[-1] - crossings[0])

            pitches = [frequency(onset + 0.1, onset + 0.3) for onset in (0, 1, 2, 2.5, 3)]
            expected = [200, 400, 1200 if pitched else 600, 1200 if pitched else 600, 800]
            if mode == "repitch":
                expected = [value / 2 for value in expected]
            energies = [rms(onset + 0.35, onset + 0.45) for onset in (0, 1, 2, 2.5, 3)]
            tail = rms(4.08, 4.9)
            passed = all(
                abs(actual - target) < 8 for actual, target in zip(pitches, expected)) and min(
                energies) > 0.005 and tail < 0.0001
            results.append(dict(case=name, passed=passed, frequencies=pitches, expected=expected,
                                late_slot_rms=energies, tail_rms=tail))
            print(results[-1], flush=True)
    with (work / "checks.json").open("x") as stream:
        json.dump(results, stream, indent=2)
        stream.write("\n")
    if not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
