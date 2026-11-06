#!/usr/bin/env python3
"""Deterministic static release bundles. Network-free; stdlib-only Python 3.12."""
import argparse
from contextlib import contextmanager
import re
import sys
import gzip
import hashlib
import io
import json
import os
import stat
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

RUNTIME_FILES = ('index.html', 'app.js', 'core.js', 'style.css', 'view-colors.js',
                 'view-map.js', 'view-map.css', 'plot-annotations.js', 'transport.js',
                 'diagnostics.js', 'vector-codec.js', 'diagnostics-worker.js')
RELEASE_SCHEMA = 'solids-release-v1'
SYNTHETIC_SCHEMA = 'solids-release-synthetic-test-v1'
PRODUCTION_BUILD = 'build-81cec6a56ad50b85d5afc982'
PRODUCTION_COUNT = 94200
PRODUCTION_SHA256 = '56dd1c2695c1724686d09d1b0312d64b3cd4719e39aa0794a4061f4a0fe85a34'
SITE_LIMIT = 1_000_000_000
FRONTEND_RESERVE = 5_000_000
TAR_LIMIT = 10_000_000_000
ARCHIVE_LIMIT = 2 ** 31
JSON_LIMIT = 64 * 1024 * 1024
MANIFEST_LIMIT = 64 * 1024
MAX_FILES = 250_000


def read_json_file(path, limit):
    with open_regular(path) as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('JSON byte limit exceeded')
    return strict_json(raw)


def capacity(inventory, inventory_bytes):
    if len(inventory) > MAX_FILES or inventory_bytes > JSON_LIMIT:
        raise ValueError('inventory limit exceeded')
    if sum(v['bytes'] for v in inventory.values()) + FRONTEND_RESERVE >= SITE_LIMIT:
        raise ValueError('site size limit exceeded (including frontend reserve)')
    sizes = [inventory_bytes, *(v['bytes'] for v in inventory.values())]
    tar_bytes = ((sum(512 + ((s + 511) // 512) * 512 for s in sizes) + 1024 + 10239) // 10240) * 10240
    if tar_bytes >= TAR_LIMIT:
        raise ValueError('uncompressed tar limit exceeded')
    return tar_bytes


def validate_pins(value, *, release=False, allow_synthetic=False):
    if not isinstance(value, dict):
        raise ValueError('invalid deployment/release object')
    schema = value.get('schema')
    synthetic = schema == (SYNTHETIC_SCHEMA if release else 'solids-static-synthetic-test-v1')
    if synthetic:
        if not allow_synthetic:
            raise ValueError('synthetic data is forbidden in production CLI')
        if (not re.fullmatch(r'build-synthetic-[A-Za-z0-9_-]+', str(value.get('build_id', '')))
                or type(value.get('count')) is not int or not 1 <= value['count'] <= 64
                or not re.fullmatch('[0-9a-f]{64}', str(value.get('source_catalog_sha256', '')))):
            raise ValueError('invalid explicitly synthetic fixture')
    elif (schema != (RELEASE_SCHEMA if release else 'solids-static-v1')
          or value.get('build_id') != PRODUCTION_BUILD or type(value.get('count')) is not int
          or value['count'] != PRODUCTION_COUNT or value.get('source_catalog_sha256') != PRODUCTION_SHA256):
        raise ValueError('production deployment pins mismatch')
    return synthetic


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError('non-finite JSON number')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def file_digest(path):
    h = hashlib.sha256()
    with open_regular(path) as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tar_entry(name, size):
    entry = tarfile.TarInfo(name)
    entry.size = size
    entry.mode = 0o644
    return entry


def reject_links(path):
    path = Path(path).absolute()
    for node in (*reversed(path.parents), path):
        try:
            info = node.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('symlink path forbidden')
        if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError('hardlink or special file forbidden')


@contextmanager
def open_regular(path):
    reject_links(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('not an unlinked regular file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


@contextmanager
def source_lock(data):
    import fcntl
    reject_links(data)
    if not data.is_dir():
        raise ValueError('data must be a completed directory')
    if any(os.path.lexists(parent / '.git') for parent in (data, *data.parents)):
        raise ValueError('source data must be outside Git')
    lock = data.with_name(data.name + '.lock')
    if os.path.lexists(lock):
        with open_regular(lock) as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError('source packager has an active writer lock') from error
            yield
    else:
        yield


def source_inventory(data):
    inventory = {}
    for path in sorted(data.rglob('*')):
        reject_links(path)
        name = path.relative_to(data).as_posix()
        if path.is_dir():
            safe_path(name + '/placeholder')
            continue
        safe_path(name)
        inventory[name] = dict(bytes=path.stat().st_size, sha256=file_digest(path))
    return inventory


def pack(data, archive, manifest, *, tag, asset, allow_synthetic=False):
    """Import-only allow_synthetic never changes production pin requirements."""
    data, archive, manifest = (Path(p).absolute() for p in (data, archive, manifest))
    for target in (archive, manifest):
        require_absent(target)
        if target.is_relative_to(data):
            raise ValueError('bundle output overlaps read-only source')
    if archive == manifest:
        raise ValueError('archive and manifest must be distinct')
    with source_lock(data):
        with tempfile.TemporaryDirectory(prefix='.release-pack-', dir=archive.parent) as atmp, \
                tempfile.TemporaryDirectory(prefix='.release-pack-', dir=manifest.parent) as mtmp:
            staged_archive, staged_manifest = Path(atmp) / 'archive', Path(mtmp) / 'manifest'
            result = _pack_locked(data, staged_archive, staged_manifest, tag=tag, asset=asset,
                                  allow_synthetic=allow_synthetic)
            published = []
            try:
                for source, target in ((staged_archive, archive), (staged_manifest, manifest)):
                    identity = source.stat()
                    rename_absent(source, target)
                    published.append((target, identity))
                if read_json_file(manifest, MANIFEST_LIMIT) != result or archive.stat().st_size != result['archive_bytes']:
                    raise ValueError('publication readback mismatch')
            except BaseException:
                # Roll back only the inodes this transaction actually published.
                for target, identity in reversed(published):
                    current = target.lstat()
                    if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                        target.unlink()
                raise
            return result


def require_absent(path):
    reject_links(path)
    if os.path.lexists(path):
        raise FileExistsError(f'refusing existing output: {path}')
    if not path.parent.is_dir():
        raise ValueError('output parent must already exist')


def rename_absent(source, target):
    """Atomic no-replace rename, including pre-existing *empty* directories.

    Python's POSIX os.rename replaces empty directories, so never fall back to
    a racy exists()+rename(). Linux and macOS use libc through stdlib ctypes;
    other POSIX platforms fail closed if no exclusive primitive is available.
    """
    import ctypes
    require_absent(target)
    if os.name == 'nt':
        os.rename(source, target)  # Windows rename does not replace targets.
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith('linux') and hasattr(libc, 'renameat2'):
        operation = libc.renameat2
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        status = operation(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    elif sys.platform == 'darwin' and hasattr(libc, 'renamex_np'):
        operation = libc.renamex_np
        operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        status = operation(os.fsencode(source), os.fsencode(target), 4)
    else:
        raise ValueError('atomic no-replace rename is unsupported on this platform')
    if status:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def validate_deployment(root, deployment, inventory):
    """Verify stored and decoded commitments, including byte-plane vectors."""
    files, vectors = deployment.get('files'), deployment.get('vectors')
    if not isinstance(files, dict) or not isinstance(vectors, dict):
        raise ValueError('deployment files/vectors must be objects')

    def descriptor(info):
        if not isinstance(info, dict):
            raise ValueError('invalid deployment descriptor')
        name = safe_path(info.get('path'))
        if (name not in inventory or any(info.get(k) != inventory[name][k] for k in ('bytes', 'sha256'))
                or type(info.get('bytes')) is not int or type(info.get('raw_bytes')) is not int
                or not 0 <= info['raw_bytes'] < SITE_LIMIT
                or not isinstance(info.get('raw_sha256'), str)
                or not re.fullmatch('[0-9a-f]{64}', info['raw_sha256'])):
            raise ValueError('deployment file bytes/hash commitment mismatch')
        return name

    for virtual, info in files.items():
        if not isinstance(virtual, str) or not virtual.startswith('/data/'):
            raise ValueError('invalid virtual data path')
        safe_path(virtual[1:])
        name = descriptor(info)
        if not name.startswith('data/'):
            raise ValueError('deployment data path scope mismatch')
        if info.get('encoding') == 'identity':
            if info['raw_bytes'] != info['bytes'] or info['raw_sha256'] != info['sha256']:
                raise ValueError('identity raw commitment mismatch')
        elif info.get('encoding') == 'gzip':
            h, size = hashlib.sha256(), 0
            with open_regular(root / name) as stream, gzip.GzipFile(fileobj=stream, mode='rb') as decoded:
                while block := decoded.read(min(1024 * 1024, info['raw_bytes'] - size + 1)):
                    size += len(block)
                    if size > info['raw_bytes']:
                        raise ValueError('decoded data exceeds committed bytes')
                    h.update(block)
            if size != info['raw_bytes'] or h.hexdigest() != info['raw_sha256']:
                raise ValueError('gzip raw commitment mismatch')
        else:
            raise ValueError('unsupported deployment encoding')
    for key, vector in vectors.items():
        if (not isinstance(vector, dict) or type(vector.get('dimension')) is not int
                or str(vector['dimension']) != key or vector['dimension'] not in (128, 256, 512, 768)
                or type(vector.get('count')) is not int or vector['count'] != deployment['count']
                or vector.get('dtype') != '<f4' or not isinstance(vector.get('chunks'), list)):
            raise ValueError('invalid vector descriptor')
        start, full = 0, hashlib.sha256()
        for chunk in vector['chunks']:
            name = descriptor(chunk)
            if (not name.startswith(f'vectors/{key}/') or type(chunk.get('start')) is not int
                    or chunk['start'] != start or type(chunk.get('count')) is not int
                    or not 1 <= chunk['count'] <= 16384
                    or start + chunk['count'] > vector['count']
                    or chunk['raw_bytes'] != chunk['count'] * vector['dimension'] * 4):
                raise ValueError('vector coverage/bytes mismatch')
            with open_regular(root / name) as stream, gzip.GzipFile(fileobj=stream, mode='rb') as decoded:
                shuffled = decoded.read(chunk['raw_bytes'] + 1)
            if len(shuffled) != chunk['raw_bytes']:
                raise ValueError('vector decompression byte mismatch')
            raw = bytearray(len(shuffled))
            plane = len(shuffled) // 4
            for index in range(4):
                raw[index::4] = shuffled[index * plane:(index + 1) * plane]
            if digest(raw) != chunk['raw_sha256']:
                raise ValueError('vector raw SHA256 mismatch')
            full.update(raw)
            start += chunk['count']
        if start != vector['count'] or full.hexdigest() != vector.get('raw_sha256'):
            raise ValueError('full vector coverage/hash mismatch')


def _pack_locked(data, archive, manifest, *, tag, asset, allow_synthetic):
    data, archive, manifest = map(Path, (data, archive, manifest))
    deployment = read_json_file(data / 'deployment.json', JSON_LIMIT)
    synthetic = validate_pins(deployment, allow_synthetic=allow_synthetic)
    inventory = source_inventory(data)
    inventory_raw = json_bytes(inventory)
    capacity(inventory, len(inventory_raw))
    validate_deployment(data, deployment, inventory)
    with archive.open('xb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as gz:
            with tarfile.open(fileobj=gz, mode='w|', format=tarfile.USTAR_FORMAT) as tf:
                tf.addfile(tar_entry('inventory.json', len(inventory_raw)), io.BytesIO(inventory_raw))
                for name, info in sorted(inventory.items()):
                    with open_regular(data / name) as stream:
                        checked = HashingReader(stream)
                        tf.addfile(tar_entry(name, info['bytes']), checked)
                        if (checked.size != info['bytes'] or checked.hash.hexdigest() != info['sha256']
                                or stream.read(1)):
                            raise ValueError('source changed while packing: bytes/SHA256 mismatch')
    if read_json_file(data / 'deployment.json', JSON_LIMIT) != deployment:
        raise ValueError('deployment changed while packing')
    if archive.stat().st_size >= ARCHIVE_LIMIT:
        raise ValueError('compressed archive limit exceeded')
    result = dict(schema=SYNTHETIC_SCHEMA if synthetic else RELEASE_SCHEMA, tag=tag, asset=asset,
                  archive_sha256=file_digest(archive), archive_bytes=archive.stat().st_size,
                  inventory_sha256=digest(inventory_raw), build_id=deployment['build_id'],
                  count=deployment['count'], source_catalog_sha256=deployment['source_catalog_sha256'],
                  site_bytes=sum(v['bytes'] for v in inventory.values()), file_count=len(inventory))
    with manifest.open('xb') as stream:
        stream.write(json_bytes(result))
    return result


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.hash = hashlib.sha256()
        self.size = 0

    def read(self, size):
        raw = self.stream.read(size)
        self.hash.update(raw)
        self.size += len(raw)
        return raw


def safe_path(name):
    if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_./+-]+', name)
            or any(part in ('', '.', '..') for part in name.split('/'))
            or (name != 'deployment.json' and not (name.split('/')[0] in ('data', 'media', 'vectors') and '/' in name))):
        raise ValueError('noncanonical or out-of-scope relative path')
    return name


def validate_inventory(inventory, metadata):
    if not isinstance(inventory, dict) or 'deployment.json' not in inventory:
        raise ValueError('invalid inventory object')
    for name, info in inventory.items():
        safe_path(name)
        if (not isinstance(info, dict) or set(info) != {'bytes', 'sha256'}
                or type(info['bytes']) is not int or info['bytes'] < 0
                or not isinstance(info['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', info['sha256'])):
            raise ValueError('invalid inventory descriptor')
        if any(str(parent) in inventory for parent in PurePosixPath(name).parents):
            raise ValueError('inventory file/directory collision')
    if (len(inventory) != metadata['file_count']
            or sum(v['bytes'] for v in inventory.values()) != metadata['site_bytes']):
        raise ValueError('inventory totals mismatch')


class TarReader:
    """Read physical USTAR headers, never silently interpret PAX/GNU links."""
    def __init__(self, stream):
        self.stream = stream
        self.total = 0

    def read(self, size):
        if self.total + size >= TAR_LIMIT:
            raise ValueError('uncompressed tar limit exceeded')
        raw = self.stream.read(size)
        self.total += len(raw)
        if len(raw) != size:
            raise ValueError('truncated tar')
        return raw

    def header(self):
        raw = self.read(512)
        if raw == bytes(512):
            if self.read(512) != bytes(512):
                raise ValueError('invalid tar end marker')
            while block := self.stream.read(1024 * 1024):
                self.total += len(block)
                if self.total >= TAR_LIMIT:
                    raise ValueError('uncompressed tar limit exceeded')
                if any(block):
                    raise ValueError('unexpected bytes after tar end marker')
            return None
        try:
            entry = tarfile.TarInfo.frombuf(raw, 'utf-8', 'strict')
        except tarfile.HeaderError as error:
            raise ValueError('invalid tar header') from error
        if (entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or entry.linkname
                or entry.size < 0 or raw[257:263] != b'ustar\x00'):
            raise ValueError('only regular USTAR files are allowed')
        return entry

    def padding(self, size):
        if any(self.read((-size) % 512)):
            raise ValueError('nonzero tar member padding')


def extract_verified(source_archive, metadata, staging):
    with gzip.GzipFile(fileobj=source_archive, mode='rb') as gz:
        reader = TarReader(gz)
        first = reader.header()
        if first is None or first.name != 'inventory.json':
            raise ValueError('inventory must be the first regular member')
        if first.size > JSON_LIMIT:
            raise ValueError('inventory JSON byte limit exceeded')
        inventory_raw = reader.read(first.size)
        reader.padding(first.size)
        if digest(inventory_raw) != metadata['inventory_sha256']:
            raise ValueError('inventory SHA256 mismatch')
        inventory = strict_json(inventory_raw)
        validate_inventory(inventory, metadata)
        expected_tar_bytes = capacity(inventory, len(inventory_raw))
        seen = set()
        while (entry := reader.header()) is not None:
            safe_path(entry.name)
            if entry.name in seen or entry.name not in inventory:
                raise ValueError('duplicate or extra archive member')
            seen.add(entry.name)
            info = inventory[entry.name]
            if entry.size != info['bytes']:
                raise ValueError('member bytes mismatch')
            target = staging / entry.name
            target.parent.mkdir(parents=True, exist_ok=True)
            h = hashlib.sha256()
            remaining = entry.size
            with target.open('xb') as dest:
                while remaining:
                    block = reader.read(min(remaining, 1024 * 1024))
                    remaining -= len(block)
                    h.update(block)
                    dest.write(block)
            reader.padding(entry.size)
            if h.hexdigest() != info['sha256']:
                raise ValueError('member SHA256 mismatch')
        if seen != set(inventory):
            raise ValueError('missing archive member')
        if reader.total != expected_tar_bytes:
            raise ValueError('noncanonical tar size/padding')
        return inventory


def restore(archive, manifest, frontend, out, *, allow_synthetic=False):
    archive, manifest, frontend, out = (Path(p).absolute() for p in (archive, manifest, frontend, out))
    require_absent(out)
    metadata = read_json_file(manifest, MANIFEST_LIMIT)
    validate_pins(metadata, release=True, allow_synthetic=allow_synthetic)
    with tempfile.TemporaryDirectory(prefix='.release-staging-', dir=out.parent) as tmp:
        staging = Path(tmp) / 'site'
        staging.mkdir()
        with archive.open('rb') as source_archive:
            if os.fstat(source_archive.fileno()).st_size >= ARCHIVE_LIMIT:
                raise ValueError('compressed archive limit exceeded')
            h = hashlib.sha256()
            size = 0
            for block in iter(lambda: source_archive.read(1024 * 1024), b''):
                h.update(block)
                size += len(block)
                if size >= ARCHIVE_LIMIT:
                    raise ValueError('compressed archive limit exceeded')
            if size != metadata['archive_bytes'] or h.hexdigest() != metadata['archive_sha256']:
                raise ValueError('archive bytes/SHA256 mismatch before parsing')
            source_archive.seek(0)
            inventory = extract_verified(source_archive, metadata, staging)
        deployment = read_json_file(staging / 'deployment.json', JSON_LIMIT)
        synthetic = validate_pins(deployment, allow_synthetic=allow_synthetic)
        if (metadata['schema'] != (SYNTHETIC_SCHEMA if synthetic else RELEASE_SCHEMA)
                or any(deployment[k] != metadata[k] for k in ('build_id', 'count', 'source_catalog_sha256'))):
            raise ValueError('deployment/release pins mismatch')
        validate_deployment(staging, deployment, inventory)
        site_bytes = metadata['site_bytes']
        for name in RUNTIME_FILES:
            with (frontend / name).open('rb') as source, (staging / name).open('xb') as dest:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    site_bytes += len(block)
                    if site_bytes >= SITE_LIMIT:
                        raise ValueError('final site limit exceeded')
                    dest.write(block)
        (staging / '.nojekyll').touch()
        rename_absent(staging, out)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    packing = commands.add_parser('pack')
    for name in ('data', 'archive', 'manifest', 'tag', 'asset'):
        packing.add_argument('--' + name, required=True)
    restoring = commands.add_parser('restore')
    for name in ('archive', 'manifest', 'frontend', 'out'):
        restoring.add_argument('--' + name, required=True)
    args = vars(parser.parse_args(argv))
    command = args.pop('command')
    try:
        result = pack(**args) if command == 'pack' else restore(**args)
    except (ValueError, OSError, tarfile.TarError, EOFError) as error:
        print(f'release bundle: {error}', file=sys.stderr)
        return 1
    print(json_bytes(result).decode() if isinstance(result, dict) else str(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
