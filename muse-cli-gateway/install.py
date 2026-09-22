#!/usr/bin/env python3
"""Render/install only the Muse gateway LaunchAgent; never restart siblings."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--render-only', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
user_home = Path.home()
node = user_home / '.openclaw/tools/node/bin/node'
if not node.is_file():
    node = Path(shutil.which('node') or '/nonexistent')
cli = user_home / '.local/bin/muse'
if not node.is_file() or not cli.is_file():
    parser.error('Install Node and the official Muse Code CLI first')
label = 'ai.openclaw.muse-cli-gateway'
logs = user_home / '.openclaw/logs'
spec = {
    'Label': label, 'ProgramArguments': [str(node), str(repo / 'muse-cli-gateway/server.mjs')],
    'WorkingDirectory': str(repo), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
    'EnvironmentVariables': {'HOME': str(user_home), 'PATH': f'{node.parent}:{user_home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
                            'MUSE_CLI_GATEWAY_PORT': '4571', 'MUSE_CLI_GATEWAY_MAX_CONCURRENT': '2'},
    'StandardOutPath': str(logs / 'muse-cli-gateway.stdout.log'),
    'StandardErrorPath': str(logs / 'muse-cli-gateway.stderr.log'),
}
destination = args.render_only or user_home / 'Library/LaunchAgents' / (label + '.plist')
destination.parent.mkdir(parents=True, exist_ok=True)
if not args.render_only and destination.exists():
    old = plistlib.loads(destination.read_bytes())
    if old != spec:
        parser.error('Existing Muse LaunchAgent differs; inspect and back it up before replacing')
destination.write_bytes(plistlib.dumps(spec))
destination.chmod(0o600)
if args.render_only:
    print(f'Rendered {destination}')
else:
    logs.mkdir(parents=True, exist_ok=True)
    target = f'gui/{os.getuid()}/{label}'
    existing = subprocess.run(['launchctl', 'print', target], capture_output=True)
    if existing.returncode == 0:
        print(f'Already loaded: {label}; no service was restarted')
    else:
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(destination)], check=True)
        print(f'Started {label}')
