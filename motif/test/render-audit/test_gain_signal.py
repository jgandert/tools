"""Measure gain signals and replacement timing in real Chromium audio."""
import argparse
import json
from pathlib import Path
import subprocess
from test_gain_owner import ROOT, AUDIT, OUTPUT, read_pcm, rms

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('name')
args = parser.parse_args()
if not args.name.startswith('f2-') or Path(args.name).name != args.name:
    parser.error('Use a fresh simple f2- name')
evidence = OUTPUT / args.name
audio = OUTPUT / 'audio' / args.name
evidence.mkdir(parents=True, exist_ok=False)
audio.mkdir(parents=True, exist_ok=False)
songs = AUDIT / args.name
songs.mkdir()
checks = []
base = '''Motif.setTempo(120);
Motif.master({gain: .1, limiter: true});
const t = Track("tone").synth("sine").freq([440]).stepLength(8).envelope({attack: .01, decay: .01, sustain: 1, release: .01});
'''


def render(name, body):
    song = songs / (name + '.js')
    song.write_text(base + body)
    wav = audio / (name + '.wav')
    with (evidence / (name + '.log')).open('x') as log:
        subprocess.run(
            ['python3', str(ROOT / 'render_wav.py'), str(song), str(wav), '--seconds', '6'],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=700)
    return read_pcm(wav)


def check(name, passed, **metrics):
    item = dict(name=name, passed=bool(passed), **metrics)
    checks.append(item)
    print(json.dumps(item), flush=True)


control = render('unity', 't.pan(0);')
variants = []
for order in ('before', 'after'):
    signal = 'gain(LFO.sine({min: .04, max: .09, frequency: 1}))'
    chain = f't.{signal}.pan(0);' if order == 'before' else f't.pan(0).{signal};'
    out = render(order, chain)
    variants.append(out)
    ratios = [rms(out, .2 + i * .025, .21 + i * .025) / rms(control, .2 + i * .025, .21 + i * .025)
              for i in range(180)]
    check(order + ': requested .04–.09 range',
          abs(min(ratios) - .04) < .001 and abs(max(ratios) - .09) < .001, minimum=min(ratios),
          maximum=max(ratios))
check('effect initialization order', variants[0] == variants[1])
changed = render('transitions', '''const shared = LFO.sine({min: .04, max: .09, frequency: 1});
t.gain(shared).pan(0);
Motif.schedule(1, () => t.gain(.3));
Motif.schedule(2, () => t.gain(LFO.sine({min: .2, max: .4, frequency: 1})));
Motif.schedule(3, () => t.gain(Ramp(.2, .6, 1)));
Motif.schedule(4.2, () => t.gain(0));
''')
ratio = rms(changed, 1.2, 1.8) / rms(control, 1.2, 1.8)
check('signal to scalar removes modulation', abs(ratio - .3) < .001, ratio=ratio)
ratio = rms(changed, 3.7, 3.8) / rms(control, 3.7, 3.8)
check('signal to Ramp absolute endpoints', .51 < ratio < .54, ratio=ratio)
check('scalar zero after Ramp', rms(changed, 4.5, 5.5) == 0)
arranged = render('arranged', '''const signal = LFO.sine({min: .04, max: .09, frequency: 1});
t.pan(0).gain(Ramp(.1, .1, 1)).gain(Ramp(.2, .6, 1));
Arrange([{tracks: [t], bars: 1}, {tracks: [t], bars: 2}]);
Motif.schedule(.5, () => t.gain(signal));
''')
delayed = render('delayed-reference', '''const signal = LFO.sine({min: .04, max: .09, frequency: 1});
t.pan(0).gain(Ramp(.1, .1, 1));
Arrange([{tracks: [t], bars: 1}, {tracks: [t], bars: 2}]);
Motif.schedule(.5, () => t.gain(signal));
''')
ratio = rms(arranged, 1.92, 1.96) / rms(delayed, 1.92, 1.96)
check('arranged Ramp preserves LFO during lookahead', abs(ratio - 1) < .001, ratio=ratio)
ratio = rms(arranged, 2.7, 2.8) / rms(control, 2.7, 2.8)
check('arranged Ramp suppresses LFO at onset', .48 < ratio < .52, ratio=ratio)
(evidence / 'checks.json').write_text(json.dumps(checks, indent=2) + '\n')
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
