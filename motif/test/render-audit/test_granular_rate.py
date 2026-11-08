"""Render rate-aware granular pitch, natural duration, and flat-slice offsets."""
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
    logs = OUTPUT / f"f9-{args.tag}-logs"
    logs.mkdir(parents=True)
    (OUTPUT / "audio").mkdir(parents=True, exist_ok=True)
    results = []
    for rate in (24000, 48000, 96000):
        for sliced in (False, True):
            name = f"{rate}-{'slice' if sliced else 'full'}"
            source = AUDIT / "songs" / f"f9-{name}.js"
            output = OUTPUT / "audio" / f"f9-{args.tag}-{name}.wav"
            if output.exists():
                raise FileExistsError(output)
            command = ["python3", str(ROOT / "render_wav.py"), str(source), str(output),
                       "--seconds", "3"]
            with (logs / f"{name}.log").open("x") as log:
                subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True,
                               timeout=700)
            with wave.open(str(output)) as wav:
                output_rate = wav.getframerate()
                samples = array.array("h", wav.readframes(wav.getnframes()))

            def rms(start, end):
                values = samples[2 * round(start * output_rate):2 * round(end * output_rate):2]
                return math.sqrt(sum((v / 32768) ** 2 for v in values) / len(values))

            def frequency(start, end):
                crossings = []
                for frame in range(round(start * output_rate) + 1, round(end * output_rate)):
                    previous, current = samples[2 * (frame - 1)], samples[2 * frame]
                    if previous < 0 <= current:
                        crossings.append(frame - 1 - previous / (current - previous))
                return (len(crossings) - 1) * output_rate / (crossings[-1] - crossings[0])

            expected_duration = 1 if sliced else 2
            pitch = frequency(0.015, 0.04)
            late_rms = rms(expected_duration - 0.15, expected_duration - 0.05)
            tail_rms = rms(expected_duration + 0.07, 2.9)
            active = [frame for frame in range(len(samples) // 2) if abs(samples[2 * frame]) > 100]
            end = active[-1] / output_rate
            passed = abs(pitch - 440) < 10 and late_rms > 0.01 and tail_rms < 0.0001 and abs(
                end - expected_duration) < 0.06
            results.append(
                dict(case=name, passed=passed, pitch_hz=pitch, expected_duration=expected_duration,
                     active_end=end, late_rms=late_rms, tail_rms=tail_rms))
            print(results[-1], flush=True)
    with (OUTPUT / f"f9-{args.tag}-checks.json").open("x") as stream:
        json.dump(results, stream, indent=2)
        stream.write("\n")
    if not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
