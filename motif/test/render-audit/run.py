"""Render audit cases sequentially, retaining WAVs and diagnostics without overwriting."""

import argparse
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
AUDIT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("group", choices=["features", "games", "custom"])
    parser.add_argument("--output-dir", type=Path, default=AUDIT / "output")
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    (output_dir / "audio").mkdir(parents=True, exist_ok=True)
    (output_dir / "logs").mkdir(parents=True, exist_ok=True)
    if args.group == "games":
        sources = [ROOT / song for song in
                   json.loads((AUDIT / "game-coverage.json").read_text())["selected"]]
    else:
        pattern = "feature-*.js" if args.group == "features" else "custom-*.js"
        sources = sorted((AUDIT / "songs").glob(pattern))
    for source in sources:
        name = ("game-" if args.group == "games" else "") + source.stem
        output = output_dir / "audio" / (name + ".wav")
        log = output_dir / "logs" / (name + ".log")
        if output.exists() or log.exists():
            print(f"SKIP {name}: existing artifacts", flush=True)
            continue
        command = ["python3", str(ROOT / "render_wav.py"), str(source), str(output)]
        if args.group != "games":
            command += ["--seconds", "10"]
        started = time.monotonic()
        with log.open("x") as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=700)
        print(
            f"{'PASS' if result.returncode == 0 else 'FAIL'} {name} ({time.monotonic() - started:.1f}s)",
            flush=True)


if __name__ == "__main__":
    main()
