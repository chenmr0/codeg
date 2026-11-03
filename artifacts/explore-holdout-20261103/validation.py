"""Trusted provenance and source parsing checks for the frozen holdout."""
import hashlib
import json
from pathlib import Path
import re

FROZEN_GOLD_SHA256 = '7fb04d1755e79b6cb7874a49598e88046ece81db020e37d4ac019458d1f56dfb'

def check_frozen_inputs(directory):
    directory = Path(directory)
    raw = (directory / 'queries-gold.json').read_bytes()
    freeze = json.loads((directory / 'FREEZE.json').read_text())
    if hashlib.sha256(raw).hexdigest() != FROZEN_GOLD_SHA256 or freeze.get('sha256') != FROZEN_GOLD_SHA256:
        raise ValueError('inputs do not match the trusted frozen gold digest')
    return json.loads(raw), freeze

def checked_source(root, name, tracked):
    root = Path(root).resolve()
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or name not in tracked:
        raise ValueError('source path must be a tracked relative path: ' + name)
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target.relative_to(root).as_posix() not in tracked or not target.is_file():
        raise ValueError('source path escapes checkout or is not a tracked file: ' + name)
    return target

def extract_source(text, validate_path):
    out = {}; current = None; fence = False; in_source = False
    for line in text.splitlines():
        if not fence and line.strip() == '**Source Code**':
            in_source = True
            continue
        if not in_source:
            continue
        if not fence and (line.startswith('**Not shown above') or line.startswith('---')):
            break
        match = re.match(r'\*\*`([^`]+)`\*\*', line)
        if not fence and match:
            current = match[1]
            validate_path(current)
        if line.startswith('```'):
            fence = not fence
            continue
        match = re.match(r'(\d+)\t(.*)', line)
        if fence and match:
            if current is None:
                raise ValueError('numbered source without file header')
            key = (current, int(match[1])); value = match[2]
            if key in out and out[key] != value:
                raise ValueError('conflicting duplicate source line: ' + repr(key))
            out[key] = value
    if fence:
        raise ValueError('unclosed source fence')
    return out
