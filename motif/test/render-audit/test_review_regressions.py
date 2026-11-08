"""Run retained native Chromium regressions with an unused artifact name."""
import argparse
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
AUDIT = Path(__file__).resolve().parent
OUTPUT = AUDIT / "output"
renderer = ROOT / 'tools/render-wav'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('name', help='Unused review- prefix for JSON metrics and log')
args = parser.parse_args()
if not re.fullmatch(r'review-[a-zA-Z0-9_-]+', args.name):
    parser.error('Use a simple review- name')
OUTPUT.mkdir(exist_ok=True)
if list(OUTPUT.glob(args.name + '*')):
    parser.error('Artifacts already exist; choose an unused prefix')

image = 'localhost/motif-render-wav:1.63.0'
subprocess.run(['podman', 'build', '--quiet', '--pull=missing', '--tag', image,
                '--file', str(renderer / 'Containerfile'), str(renderer)], check=True)
command = [
    'podman', 'run', '--rm', '--init', '--timeout', '120', '--userns', 'keep-id',
    '--user', f'{os.getuid()}:{os.getgid()}', '--network', 'none', '--ipc', 'private',
    '--shm-size', '512m', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--read-only', '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
    '--security-opt', f'seccomp={renderer / "seccomp_profile.json"}',
    '--tmpfs', '/tmp:rw,nodev,nosuid,size=512m,mode=1777', '--env', 'HOME=/tmp',
    '--volume', f'{ROOT / "motif.js"}:/motif/motif.js:ro,z',
    '--volume', f'{ROOT / "src"}:/motif/src:ro,z',
    '--volume', f'{ROOT / "index.html"}:/motif/index.html:ro,z',
    '--volume',
    f'{renderer / "test-review-regressions.mjs"}:/renderer/test-review-regressions.mjs:ro,z',
    '--volume', f'{renderer / "offline.mjs"}:/renderer/offline.mjs:ro,z',
    '--volume', f'{AUDIT}:/audit:rw,z', '--entrypoint', 'node', image,
    '/renderer/test-review-regressions.mjs', f'/audit/output/{args.name}.json',
]
with (OUTPUT / f'{args.name}.log').open('x') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=140)
print((OUTPUT / f'{args.name}.log').read_text(), end='')
raise SystemExit(result.returncode)
