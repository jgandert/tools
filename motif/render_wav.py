#!/usr/bin/env python3
"""Render a Motif song to stereo PCM16 WAV using rootless Podman."""

import argparse
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid


def bounded_number(minimum, maximum):
    def parse(value):
        number = float(value)
        if not math.isfinite(number) or not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"Must be between {minimum} and {maximum}.")
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("song", type=Path, help="Song file, e.g. examples/chiptune_1.motif.js")
    parser.add_argument("output", nargs="?", type=Path, help="Output path; defaults to SONG.wav")
    parser.add_argument("--seconds", type=bounded_number(0.001, 1800), help="Total duration; defaults to one Arrange() pass plus tail")
    parser.add_argument("--tail", type=bounded_number(0, 60), default=2, help="Extra seconds after arrangement (default: 2); ignored with --seconds")
    parser.add_argument("--sample-rate", type=int, choices=[44100, 48000, 96000], default=48000)
    args = parser.parse_args()
    song = args.song.resolve(strict=True)
    if not song.is_file():
        parser.error("Song must be a regular file.")
    default_name = song.name.removesuffix(".js").removesuffix(".motif") + ".wav"
    output = (args.output or song.with_name(default_name)).absolute()
    if output.exists() or output.is_symlink():
        parser.error(f"Output already exists: {output}")
    if not output.parent.is_dir():
        parser.error("Output directory does not exist.")
    root = Path(__file__).resolve().parent
    renderer = root / "tools/render-wav"
    for mount in [root, song.parent]:
        if ":" in str(mount):
            parser.error("Podman volume source paths cannot contain a colon.")
    info = subprocess.check_output(["podman", "info", "--format", "{{.Host.Security.Rootless}}"], text=True)
    if info.strip() != "true":
        parser.error("Rootless Podman is required.")

    image = "localhost/motif-render-wav:1.63.0"
    subprocess.run([
        "podman", "build", "--quiet", "--pull=missing", "--tag", image,
        "--file", str(renderer / "Containerfile"), str(renderer),
    ], check=True, stdout=sys.stderr)
    container = f"motif-render-{uuid.uuid4().hex}"
    command = [
        "podman", "run", "--rm", "--name", container, "--init", "--timeout", "600", "--stop-timeout", "5",
        "--userns", "keep-id", "--user", f"{os.getuid()}:{os.getgid()}",
        "--network", "none", "--ipc", "private", "--shm-size", "512m",
        "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
        "--read-only", "--cap-drop", "all", "--security-opt", "no-new-privileges",
        "--security-opt", f"seccomp={renderer / 'seccomp_profile.json'}",
        "--tmpfs", "/tmp:rw,nodev,nosuid,size=512m,mode=1777", "--env", "HOME=/tmp",
        "--volume", f"{root / 'motif.js'}:/motif/motif.js:ro,z",
        "--volume", f"{root / 'src'}:/motif/src:ro,z",
        "--volume", f"{song.parent}:/song:ro,z",
        image, song.name, str(args.seconds) if args.seconds is not None else "auto",
        str(args.tail), str(args.sample_rate),
    ]
    created = False
    success = False
    try:
        with output.open("xb") as wav:
            created = True
            subprocess.run(command, check=True, stdout=wav, timeout=630)
            if wav.tell() <= 44:
                raise RuntimeError("Renderer produced no audio data.")
        success = True
    finally:
        try:
            subprocess.run(["podman", "rm", "--ignore", "--force", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        finally:
            if created and not success:
                output.unlink(missing_ok=True)
    print(f"Wrote {output}", file=sys.stderr)


def interrupted(signum, frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except subprocess.CalledProcessError as error:
        print(f"Error: Podman {error.cmd[1]} failed (exit {error.returncode}); see diagnostic above.", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
