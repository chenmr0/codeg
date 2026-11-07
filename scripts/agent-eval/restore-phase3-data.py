#!/usr/bin/env python3
"""Restore and verify the versioned Phase 3 data bundle with Python 3.10+."""

import argparse
import contextlib
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid


CHUNK = 1024 * 1024
CONTROL = '.phase3-restore'
DEFAULT_MANIFEST = Path(__file__).resolve().parents[2] / 'docs/benchmarks/phase3-data-20261108.json'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def size(value):
    require(type(value) is int and value >= 0, f'invalid byte count: {value}')
    return value


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), 'invalid SHA-256')
    return value


def plain(path):
    """Reject symlinks, including Windows junctions and other reparse points."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
            f'linked path is not allowed: {path}')


def filesystem_path(path):
    """Collapse ./.. lexically; on Windows keep every child on the long-path API."""
    value = os.path.normpath(os.path.abspath(os.fspath(path)))
    if os.name != 'nt':
        return Path(value)
    prefix = '\\\\?\\'
    if value.startswith(prefix):
        value = value[len(prefix):]
        if value[:4].upper() == 'UNC\\':
            value = '\\\\' + value[4:]
    if value.startswith('\\\\'):
        require(not value.startswith(('\\\\.\\', '\\\\?\\')), 'unsupported Windows device path')
        return Path(prefix + 'UNC\\' + value[2:])
    drive, tail = os.path.splitdrive(value)
    require(re.fullmatch(r'[A-Za-z]:', drive) and tail.startswith('\\'), 'expected absolute Windows drive or UNC')
    return Path(prefix + value)


def relative(name, directory=False):
    require(isinstance(name, str) and name and not name.startswith('/') and '\\' not in name,
            f'unsafe relative path: {name!r}')
    result = PurePosixPath(name)
    require(result.parts or directory, f'empty file name: {name!r}')
    for part in result.parts:
        require(part not in ('..',) and part.lower() not in ('.git', CONTROL)
                and not re.search(r'[\x00-\x1f<>:"|?*]', part) and not part.endswith(('.', ' '))
                and not re.fullmatch(r'(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?', part, re.I),
                f'unsafe path component in {name!r}')
    return Path(*result.parts)


def checked_path(root, rel):
    path = root
    plain(path)
    for part in rel.parts:
        path = path / part
        plain(path)
    return path


def file_identity(path):
    require(path.is_file(), f'missing regular file: {path}')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(CHUNK), b''):
            digest.update(block)
    return path.stat().st_size, digest.hexdigest()


def validate(manifest):
    require(manifest['version'] == 1 and manifest['groups'], 'unsupported or empty manifest')
    base = urllib.parse.urlsplit(manifest['releaseBaseUrl'])
    require(base.scheme == 'https' and base.netloc and not base.username and not base.query and not base.fragment,
            'releaseBaseUrl must be an HTTPS download base')
    names = set()
    for group in manifest['groups']:
        require(group['encoding'] in ('gzip', 'tar+gzip'), 'unsupported group encoding')
        relative(group['target'], directory=group['encoding'] == 'tar+gzip')
        sha(group['raw_sha256']); size(group['raw_bytes'])
        sha(group['compressed_sha256']); size(group['compressed_bytes'])
        total = 0
        for part in group['parts']:
            name = part['name']
            require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name) and name.lower() not in names,
                    f'invalid or duplicate asset name: {name!r}')
            relative(name)
            names.add(name.lower())
            total += size(part['bytes'])
            sha(part['sha256'])
        require(group['parts'] and total == group['compressed_bytes'], f"invalid part sizes: {group['id']}")


@contextlib.contextmanager
def joined_parts(paths):
    """A pipe lets gzip read through any split point without holding the whole archive."""
    class Parts(io.RawIOBase):
        def __init__(self):
            self.paths = iter(paths)
            self.current = None

        def readable(self):
            return True

        def readinto(self, buffer):
            while True:
                if self.current is None:
                    next_path = next(self.paths, None)
                    if next_path is None:
                        return 0
                    self.current = next_path.open('rb')
                count = self.current.readinto(buffer)
                if count:
                    return count
                self.current.close()
                self.current = None

        def close(self):
            if self.current is not None:
                self.current.close()
            super().close()

    with io.BufferedReader(Parts(), CHUNK) as source:
        yield source


class DigestReader:
    def __init__(self, source, length):
        self.source, self.limit = source, length
        self.count, self.digest = 0, hashlib.sha256()

    def read(self, amount=-1):
        data = self.source.read(amount)
        self.count += len(data)
        require(self.count <= self.limit, 'stream exceeded its specified size')
        self.digest.update(data)
        return data

    def verify(self, expected):
        require(self.count == self.limit and self.digest.hexdigest() == expected, 'stream size or SHA-256 mismatch')


def get_part(part, args, cache, base):
    name = part['name']
    path = (args.from_dir or cache) / name
    plain(path)
    expected = part['bytes'], part['sha256']
    if path.exists() and file_identity(path) == expected:
        return path
    if args.from_dir or args.verify_only:
        raise ValueError(f'missing or corrupt part: {path}')
    # Only the private download cache is replaceable. Restored data is never overwritten.
    url = base.rstrip('/') + '/' + urllib.parse.quote(name)
    for attempt in range(1, 4):
        tmp = None
        try:
            print(f'Downloading {name} (attempt {attempt}/3)', flush=True)
            request = urllib.request.Request(url, headers={'User-Agent': 'CodeGraph-Phase3-Restore/1'})
            with urllib.request.urlopen(request, timeout=90) as response, tempfile.NamedTemporaryFile(
                    dir=cache, prefix='download-', delete=False) as stream:
                tmp = Path(stream.name)
                received = DigestReader(response, part['bytes'])
                shutil.copyfileobj(received, stream, CHUNK)
                received.verify(part['sha256'])
            os.replace(tmp, path)
            return path
        except (OSError, EOFError, ValueError, http.client.HTTPException) as exc:
            if attempt == 3:
                raise RuntimeError(f'failed to download {name} after three attempts') from exc
            time.sleep(attempt * 2)
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)


def consume(source, stage, rel, max_size):
    target = stage / rel if stage is not None else None
    stream = contextlib.nullcontext(None)
    if target is not None:
        target.parent.mkdir(parents=True, exist_ok=True)
        stream = target.open('xb')
    received = DigestReader(source, max_size)
    with stream as output:
        for block in iter(lambda: received.read(CHUNK), b''):
            if output is not None:
                output.write(block)
    require(received.count == max_size, f'truncated file: {rel}')
    return received.count, received.digest.hexdigest()


def restore_group(group, paths, dest, stage):
    is_tar = group['encoding'] == 'tar+gzip'
    target = relative(group['target'], directory=is_tar)
    files = {}
    with joined_parts(paths) as source:
        compressed = DigestReader(source, group['compressed_bytes'])
        with gzip.GzipFile(fileobj=compressed) as gz:
            raw = DigestReader(gz, group['raw_bytes'])
            if is_tar:
                with tarfile.open(fileobj=raw, mode='r|') as archive:
                    for member in archive:
                        rel = target / relative(member.name, directory=member.isdir())
                        if member.isdir():
                            continue
                        require(member.isreg() and not member.sparse and member.size <= group['raw_bytes'],
                                f'unsupported tar member: {member.name}')
                        require(rel not in files, f'duplicate tar member: {member.name}')
                        with archive.extractfile(member) as entry:
                            files[rel] = consume(entry, stage, rel, member.size)
                while raw.read(CHUNK):  # Include tar padding in the original byte identity.
                    pass
            else:
                files[target] = consume(raw, stage, target, group['raw_bytes'])
            raw.verify(group['raw_sha256'])
        compressed.verify(group['compressed_sha256'])

    # Perform all conflict checks before publishing even one file from this group.
    missing = []
    for rel, identity in files.items():
        output = checked_path(dest, rel)
        if output.exists() or stage is None:
            require(file_identity(output) == identity, f'existing file does not match: {output}')
        else:
            missing.append(rel)
    for rel in missing:
        output = checked_path(dest, rel)
        output.parent.mkdir(exist_ok=True, parents=True)
        # Windows rename refuses an existing target. POSIX rename would replace it.
        if os.name == 'nt':
            os.rename(stage / rel, output)
        else:
            os.link(stage / rel, output)


@contextlib.contextmanager
def staging_directory(control):
    # Inherit the destination's ACL, including sandbox/service account access on Windows.
    path = control / ('unpack-' + uuid.uuid4().hex)
    path.mkdir()
    try:
        yield path
    finally:
        plain(path)
        require(path.resolve().parent == control.resolve(), 'unexpected staging directory')
        shutil.rmtree(path)


def check_inventory(dest, spec):
    inventory = checked_path(dest, relative(spec['path']))
    require(file_identity(inventory)[1] == sha(spec['sha256']), f'wrong file inventory: {inventory}')
    rows = json.loads(inventory.read_bytes())['files']
    root = checked_path(dest, relative(spec.get('root', '.'), directory=True))
    seen, byte_count = set(), 0
    for row in rows:
        rel = relative(row['path'])
        require(rel not in seen, f'duplicate inventory path: {rel}')
        seen.add(rel)
        path = checked_path(root, rel)
        expected = size(row['bytes']), sha(row['sha256'])
        require(file_identity(path) == expected, f'inventory mismatch: {path}')
        byte_count += expected[0]
    require(len(rows) == spec.get('count', len(rows)) and byte_count == spec.get('bytes', byte_count),
            f'inventory totals mismatch: {inventory}')
    print(f'Verified {len(rows)} files, {byte_count} bytes: {inventory}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--dest', type=Path, required=True, help='new destination, or an earlier restore of this manifest')
    parser.add_argument('--from-dir', type=Path, help='read release assets from this directory instead of downloading')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--download-only', action='store_true', help='fetch (or validate local) parts without unpacking')
    mode.add_argument('--verify-only', action='store_true', help='compare restored bytes with existing assets, without writing')
    args = parser.parse_args()
    data = filesystem_path(args.manifest).read_bytes()
    manifest = json.loads(data)
    validate(manifest)
    marker_value = hashlib.sha256(data).hexdigest()
    dest = filesystem_path(args.dest)
    plain(dest)
    if args.from_dir:
        args.from_dir = filesystem_path(args.from_dir)
        plain(args.from_dir)
        require(args.from_dir.is_dir(), f'missing asset directory: {args.from_dir}')
    control = dest / CONTROL
    plain(control)
    marker = control / 'manifest-sha256'
    plain(marker)
    if marker.is_file():
        require(marker.read_text(encoding='ascii').strip() == marker_value, 'destination belongs to another manifest')
    else:
        require(not args.verify_only and (not dest.exists() or not any(dest.iterdir())),
                'choose an empty destination or the directory of an earlier restore')
        control.mkdir(parents=True)
        with marker.open('x', encoding='ascii') as stream:
            stream.write(marker_value + '\n')
    cache = control / 'parts'
    plain(cache)
    if not args.verify_only:
        cache.mkdir(exist_ok=True)
    for group in sorted(manifest['groups'], key=lambda item: 'support' not in item['id'].lower()):
        print(f"Checking {group['id']}...", flush=True)
        parts = [get_part(part, args, cache, manifest['releaseBaseUrl']) for part in group['parts']]
        if args.download_only:
            continue
        if args.verify_only:
            restore_group(group, parts, dest, None)
        else:
            with staging_directory(control) as tmp:
                restore_group(group, parts, dest, tmp)
    if not args.download_only:
        check_inventory(dest, manifest['sourceManifest'])
        if manifest.get('supportFilesManifest'):
            check_inventory(dest, manifest['supportFilesManifest'])
    print('Verification complete.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, EOFError, tarfile.TarError) as exc:
        sys.exit(f'Restore failed: {exc}')
