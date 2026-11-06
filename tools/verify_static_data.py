#!/usr/bin/env python3
"""Independent read-only verification of the pinned full static artifact."""
import math
import re
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import tarfile
from PIL import Image
import numpy as np


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_sha256(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_media_group(job):
    """Hash EVERY source pathname; decode once per exact source hash, no sampling."""
    kind = job['kind']
    require(kind in ('image', 'mask'), 'unknown media kind')
    mode = 'RGB' if kind == 'image' else 'L'
    native = None
    source_bytes = 0
    for name in job['sources']:
        content = Path(name).read_bytes()
        require(sha256(content) == job['source_sha256'], f'source media SHA mismatch: {name}')
        source_bytes += len(content)
        if native is None:
            native = content
    require(native is not None, 'empty source group')
    with Image.open(io.BytesIO(native)) as original:
        require((original.format, original.mode, original.size) == ('PNG', mode, (512, 512)), 'source media format/mode/size mismatch')
        original.load()
        original_pixels = original.tobytes()
    assets = {}
    maximum = 0
    for name in job['assets']:
        safe_relative(name)
        encoded = (Path(job['data'])/name).read_bytes()
        digest = sha256(encoded)
        require(name == f'media/{digest}.' + ('webp' if kind == 'image' else 'png'), 'media content-address mismatch')
        if kind == 'mask':
            require(encoded == native, 'native mask bytes differ')
        with Image.open(io.BytesIO(encoded)) as downloaded:
            require((downloaded.format, downloaded.mode, downloaded.size) == ('WEBP' if kind == 'image' else 'PNG', mode, (512, 512)), 'public media format/mode/size mismatch')
            downloaded.load()
            pixels = downloaded.tobytes()
        difference = int(np.abs(np.frombuffer(original_pixels, dtype=np.uint8).astype(np.int16) - np.frombuffer(pixels, dtype=np.uint8).astype(np.int16)).max())
        maximum = max(maximum, difference)
        require(pixels == original_pixels, f'pixel difference {difference}: {name}')
        assets[name] = {'bytes':len(encoded), 'sha256':digest}
    require(bool(assets), 'source group has no public assets')
    return dict(kind=kind, source_sha256=job['source_sha256'], source_paths=len(job['sources']),
                source_bytes=source_bytes, rows=job['rows'], assets=assets,
                pixels_sha256=sha256(original_pixels), maximum_pixel_difference=maximum)


def measure_tar_stream(root, inventory):
    """Actually serialize normalized USTAR into a counting/hash sink; store no tar.

    This uses tarfile's serializer, not the packager's size arithmetic. Every
    streamed file is hashed again and compared against the verification inventory.
    """
    class Sink:
        def __init__(self):
            self.size = 0
            self.digest = hashlib.sha256()
        def write(self, block):
            self.size += len(block)
            self.digest.update(block)
            return len(block)
    class Reader:
        def __init__(self, stream):
            self.stream = stream
            self.digest = hashlib.sha256()
        def read(self, size):
            block = self.stream.read(size)
            self.digest.update(block)
            return block
    directories = {'.'}
    for name in inventory:
        safe_relative(name)
        directories.update(str(p) for p in PurePosixPath(name).parents)
    sink = Sink()
    with tarfile.open(fileobj=sink, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(directories):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for name, expected in sorted(inventory.items()):
            path = root/name
            require(path.stat().st_size == expected['bytes'], f'tar readback size mismatch: {name}')
            entry = tarfile.TarInfo(name)
            entry.size = expected['bytes']
            entry.mode = 0o644
            with path.open('rb') as stream:
                reader = Reader(stream)
                archive.addfile(entry, reader)
                require(not stream.read(1), f'tar source grew: {name}')
                require(reader.digest.hexdigest() == expected['sha256'], f'tar readback hash mismatch: {name}')
    return dict(tar_bytes=sink.size, tar_sha256=sink.digest.hexdigest(),
                tar_format='normalized-ustar-10240-records', directory_count=len(directories),
                tar_files_rehashed=len(inventory))


def safe_relative(name):
    if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_./+\-]+', name)
            or any(part in ('', '.', '..') for part in name.split('/'))):
        raise ValueError(f'unsafe relative pathname: {name!r}')
    return name


def check_public_metadata(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if 'source_config' in key.lower() or key.lower() in ('runtime', 'executable'):
                raise ValueError(f'private metadata field: {key}')
            check_public_metadata(key)
            check_public_metadata(child)
    elif isinstance(value, list):
        for child in value:
            check_public_metadata(child)
    elif isinstance(value, str):
        if (re.search(r'(?:/(?:home|Users|root|tmp|mnt|media|private|var|opt)/|[A-Za-z]:\\|file://|~/)', value)
                or (value.startswith('/') and not value.startswith(('/data/', '/dataset/')))):
            raise ValueError(f'private absolute path in public metadata: {value[:100]}')
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError('nonfinite public metadata number')


def inverse_byteplanes(payload):
    """Reconstruct little-endian float32 words without packager imports."""
    if not payload or len(payload) % 4:
        raise ValueError('byteplane payload must contain complete nonempty words')
    return np.frombuffer(payload, dtype=np.uint8).reshape(4, -1).T.copy().tobytes()
