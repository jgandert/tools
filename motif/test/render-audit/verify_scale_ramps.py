"""Compare rendered scale-degree and note-name glides across their full waveform."""

import argparse
import array
import json
import sys
import wave
from pathlib import Path


def read_wav(path):
    with wave.open(str(path), "rb") as stream:
        assert stream.getsampwidth() == 2 and stream.getnchannels() == 2
        rate = stream.getframerate()
        samples = array.array("h", stream.readframes(stream.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return rate, samples


def crossing_frequency(samples, rate, start, end):
    positions = []
    for frame in range(round(start * rate) + 1, round(end * rate)):
        previous, current = samples[(frame - 1) * 2], samples[frame * 2]
        if previous < 0 <= current:
            positions.append(frame - 1 - previous / (current - previous))
    return (len(positions) - 1) * rate / (positions[-1] - positions[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scaled", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("metrics", type=Path)
    args = parser.parse_args()
    rate, scaled = read_wav(args.scaled)
    reference_rate, reference = read_wav(args.reference)
    assert rate == reference_rate and len(scaled) == len(reference)
    windows = []
    for start, end in [(0.2, 1.8), (0.1, 0.4), (0.8, 1.1), (1.6, 1.9), (8.2, 9.8)]:
        left = crossing_frequency(scaled, rate, start, end)
        right = crossing_frequency(reference, rate, start, end)
        windows.append({"start": start, "end": end, "scaledHz": left, "referenceHz": right})
    difference_rms = (sum(((a - b) / 32768) ** 2 for a, b in zip(scaled, reference)) / len(
        scaled)) ** 0.5
    passed = difference_rms < 1e-5 and all(
        abs(w["scaledHz"] / w["referenceHz"] - 1) < 0.02 for w in windows)
    result = {"name": "Scale-degree glide matches equivalent MIDI glide", "pass": passed,
              "differenceRms": difference_rms, "windows": windows}
    with args.metrics.open("x") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    assert passed


if __name__ == "__main__":
    main()
