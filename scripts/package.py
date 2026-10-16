#!/usr/bin/env python3
"""Build a portable extension ZIP from an explicit runtime allowlist."""
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
manifest = json.loads((ROOT / 'manifest.json').read_text())
files = [
    'manifest.json', 'common.js', 'background.js', 'adapter.js',
    'content.js', 'content.css', 'dashboard.html', 'dashboard.js', 'dashboard.css',
    'popup.html', 'popup.js', 'popup.css', 'README.md', 'LICENSE',
    'icons/16.png', 'icons/48.png', 'icons/128.png',
]
for filename in files:
    if not (ROOT / filename).is_file():
        raise SystemExit(f'Missing runtime file: {filename}')
destination = ROOT / 'dist' / f"claude-compass-{manifest['version']}.zip"
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(ROOT / filename, filename)
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read('manifest.json'))['version'] == manifest['version']
print(f'Created {destination.name}: {len(files)} files, {destination.stat().st_size:,} bytes')
