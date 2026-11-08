"""Check fresh split-stereo Chromium renders, including automatic duration."""
import json
import math
from pathlib import Path
import struct
import wave

root = Path(__file__).resolve().parent / 'output'
results = []
for name, seconds, right_pitch in [('f6-arrange', 10, 440), ('f6-late-auto', 8, 660),
                                   ('f6-direct', 10, 660)]:
    with wave.open(str(root / 'audio' / (name + '.wav'))) as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        assert wav.getnchannels() == 2
        samples = struct.unpack('<' + 'h' * frames * 2, wav.readframes(frames))


    def rms(start, end, channel):
        values = samples[round(start * rate) * 2 + channel:round(end * rate) * 2:2]
        return math.sqrt(sum((v / 32768) ** 2 for v in values) / len(values))


    def pitch(channel):
        values = samples[round(2.2 * rate) * 2 + channel:round(3.8 * rate) * 2:2]
        crossings = [i for i in range(1, len(values)) if values[i - 1] < 0 <= values[i]]
        return (len(crossings) - 1) * rate / (crossings[-1] - crossings[0])


    measured = dict(name=name, seconds=frames / rate, before=[rms(.1, 1.9, c) for c in range(2)],
                    during=[rms(2.2, 3.8, c) for c in range(2)],
                    after=[rms(4.3, 7, c) for c in range(2)], pitch=[pitch(c) for c in range(2)])
    assert abs(measured['seconds'] - seconds) < .05, measured
    assert max(measured['before'] + measured['after']) < .0001, measured
    assert min(measured['during']) > .05, measured
    assert abs(measured['pitch'][0] - 440) < 1 and abs(
        measured['pitch'][1] - right_pitch) < 1, measured
    results.append(measured)
report = dict(check='Split stereo obeys parent arrangement boundaries', passed=True,
              renders=results)
(root / 'f6-metrics.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
