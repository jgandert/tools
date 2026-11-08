"""Render the published chord hold and longer-slot control at all supported rates."""

import argparse
import array
import json
from pathlib import Path
import subprocess
import sys
import wave

ROOT = Path(__file__).resolve().parents[2]


def rms(path, start, end):
    with wave.open(str(path), "rb") as wav:
        assert wav.getsampwidth() == 2
        wav.setpos(round(start * wav.getframerate()))
        pcm = array.array("h", wav.readframes(round((end - start) * wav.getframerate())))
        if sys.byteorder != "little":
            pcm.byteswap()
        return (sum((sample / 32768) ** 2 for sample in pcm) / len(pcm)) ** .5


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path,
                        help="Unused evidence directory, normally under test/render-audit/output/")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    if not output.is_relative_to(ROOT):
        parser.error("Evidence must remain inside the workspace")
    output.mkdir(parents=True, exist_ok=False)
    checks = []
    for rate in (44100, 48000, 96000):
        paths = {}
        for case in ("custom-chord-tie", "custom-chord-tie-reference"):
            name = f"{case}-{rate}"
            paths[case] = output / f"{name}.wav"
            with (output / f"{name}.log").open("x") as log:
                subprocess.run([
                    "python3", str(ROOT / "render_wav.py"),
                    str(ROOT / "test/render-audit/songs" / f"{case}.js"),
                    str(paths[case]), "--seconds", "10", "--sample-rate", str(rate),
                ], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=700)
        tied = paths["custom-chord-tie"]
        reference = paths["custom-chord-tie-reference"]
        measured = {
            "sampleRate": rate,
            "onsetRms": rms(tied, .1, .4),
            "heldRms": rms(tied, .6, .9),
            "restRms": rms(tied, 1.2, 1.8),
            "tailRms": rms(tied, 2, 9),
            "referenceHeldRms": rms(reference, .6, .9),
            "referenceRestRms": rms(reference, 1.2, 1.8),
        }
        passed = (measured["onsetRms"] > .01 and measured["heldRms"] > .01
                  and measured["restRms"] == 0 and measured["tailRms"] == 0
                  and measured["referenceRestRms"] == 0
                  and abs(measured["heldRms"] / measured["referenceHeldRms"] - 1) < .001)
        checks.append({"name": "Tied chord releases every voice", "pass": passed, **measured})
        print(json.dumps(checks[-1]), flush=True)
    with (output / "checks.json").open("x") as report:
        json.dump(checks, report, indent=2)
        report.write("\n")
    return 0 if all(check["pass"] for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
