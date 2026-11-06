#!/usr/bin/env python3
"""Byte-exact, fail-closed static transport packager. No inference or uploads."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile

import numpy as np

DIMENSIONS = (128, 256, 512, 768)
FITS = ('all', 'balanced', 'shape', 'color', 'pls', 'pls-attributes', 'pls-pose')
PRODUCTION_BUILD = 'build-81cec6a56ad50b85d5afc982'
PRODUCTION_SHA256 = '56dd1c2695c1724686d09d1b0312d64b3cd4719e39aa0794a4061f4a0fe85a34'
PRODUCTION_COUNT = 94200


def build_fixture(build, registry, out, *, workers=1, chunk_rows=2, method=0, work=None):
    """IMPORT ONLY: tiny explicitly synthetic fixtures; cannot create a public schema."""
    build = Path(build)
    catalog = json.loads((build/'catalog.json').read_bytes())
    if catalog.get('synthetic') is not True or not catalog['build_id'].startswith('build-synthetic-') or not 1 <= catalog['count'] <= 64:
        raise ValueError('fixture must be explicitly synthetic and bounded to 64 rows')
    return _build(build, Path(registry), Path(out), catalog, workers=workers,
                  chunk_rows=chunk_rows, method=method, work=work, synthetic=True)


def safe_relative(value):
    if not isinstance(value, str) or not value or not re.fullmatch(r'[A-Za-z0-9_./+-]+', value):
        raise ValueError('unsafe relative path')
    if any(p in ('', '.', '..') for p in value.split('/')) or PurePosixPath(value).is_absolute():
        raise ValueError('unsafe relative path')
    return value


def validate_catalog(catalog, registry, build):
    """Validate exact coverage and bindings before creating public output."""
    required = {'schema','build_id','count','colors','created_at','feature_source','fits','model',
                'projections','revision','rows','series','shapes','dimensions','expected_count',
                'complete','artifacts','vector_files','dataset_sources'}
    if not isinstance(catalog, dict) or not required <= catalog.keys():
        raise ValueError('missing catalog fields')
    build_id = safe_relative(catalog['build_id'])
    if '/' in build_id:
        raise ValueError('invalid build ID')
    count = catalog['count']
    if type(count) is not int or count < 1 or catalog['expected_count'] != count or catalog['complete'] is not True or len(catalog['rows']) != count:
        raise ValueError('catalog count/completeness mismatch')
    if catalog['dimensions'] != list(DIMENSIONS) or catalog['fits'] != list(FITS):
        raise ValueError('prefix/fit coverage mismatch')
    expected_artifacts = {f'vectors-{d}.npy' for d in DIMENSIONS}
    expected_artifacts |= {f'{d}-{f}{suffix}' for d in DIMENSIONS for f in FITS for suffix in ('.f32','-basis.json')}
    if set(catalog['artifacts']) != expected_artifacts:
        raise ValueError('artifact coverage mismatch')
    if catalog['vector_files'] != {str(d):f'vectors-{d}.npy' for d in DIMENSIONS}:
        raise ValueError('vector mapping mismatch')
    if set(catalog['projections']) != {f'{d}/{f}' for d in DIMENSIONS for f in FITS}:
        raise ValueError('projection coverage mismatch')
    for d in DIMENSIONS:
        for fit in FITS:
            p = catalog['projections'][f'{d}/{fit}']
            if p.get('url') != f'/data/{build_id}/{d}-{fit}.f32' or p.get('basis_file') != f'{d}-{fit}-basis.json':
                raise ValueError('projection path mismatch')
    for name, expected in catalog['artifacts'].items():
        if not isinstance(expected,str) or not re.fullmatch('[0-9a-f]{64}', expected):
            raise ValueError('invalid artifact SHA256')
        if name.endswith('.f32') and (build/name).stat().st_size != count*3*4:
            raise ValueError('coordinate size mismatch')
    if not isinstance(registry,dict) or set(registry) != set(catalog['dataset_sources']):
        raise ValueError('registry namespaces mismatch')
    for ns, value in registry.items():
        safe_relative(ns)
        if '/' in ns or any(value.get(k) != catalog['dataset_sources'][ns].get(k) for k in ('config_sha256','expected_count','id_offset')):
            raise ValueError('registry metadata binding mismatch')
    shapes = {s['id'] for s in catalog['shapes']}
    colors = {s['id'] for s in catalog['colors']}
    seen = set()
    counts = dict.fromkeys(registry,0)
    row_keys = {'id','key','shape','color','elevation','heading','source','source_dataset','source_row_index','image','mask','image_sha256','mask_sha256'}
    for index, row in enumerate(catalog['rows']):
        if not isinstance(row,dict) or not row_keys <= row.keys() or type(row['id']) is not int or row['id'] != index:
            raise ValueError('row ID/order/metadata mismatch')
        ns = row['source_dataset']
        if ns not in registry or type(row['source_row_index']) is not int or row['source_row_index'] != index-registry[ns]['id_offset'] or not 0 <= row['source_row_index'] < registry[ns]['expected_count']:
            raise ValueError('source ID binding mismatch')
        if row['shape'] not in shapes or row['color'] not in colors or not isinstance(row['key'],str) or (ns,row['key']) in seen:
            raise ValueError('row label/key mismatch')
        seen.add((ns,row['key']))
        counts[ns] += 1
        for kind in ('image','mask'):
            url = row[kind]
            prefix = f'/dataset/{ns}/'
            if not isinstance(url,str) or not url.startswith(prefix):
                raise ValueError('source namespace path mismatch')
            relative = safe_relative(url[len(prefix):])
            if relative.split('/')[0] not in (('rgb','images') if kind == 'image' else ('masks',)) or not relative.lower().endswith('.png'):
                raise ValueError('source media path mismatch')
            root = Path(registry[ns]['root']).resolve()
            if not (root/relative).resolve().is_relative_to(root):
                raise ValueError('source path escapes registry root')
            if not isinstance(row[kind+'_sha256'],str) or not re.fullmatch('[0-9a-f]{64}',row[kind+'_sha256']):
                raise ValueError('invalid source SHA256')
    if any(counts[k] != registry[k]['expected_count'] for k in registry):
        raise ValueError('dataset count mismatch')


def reject_links(path, tree=False):
    import stat
    path = Path(path).absolute()
    nodes = [path, *path.parents]
    if tree and path.is_dir() and not path.is_symlink():
        nodes.extend(path.rglob('*'))
    for node in nodes:
        if node.is_symlink():
            raise ValueError('unsafe symlink in destination')
        if node.exists():
            info = node.stat()
            if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                raise ValueError('unsafe hardlink or special file in destination')


def validate_destinations(build, registry_path, registry, out, work):
    protected = [build.resolve(), registry_path.resolve(), Path(__file__).resolve().parents[1]]
    protected.extend(Path(v['root']).resolve() for v in registry.values())
    for target in (out, work):
        reject_links(target, tree=True)
        resolved = target.resolve()
        if any(resolved.is_relative_to(p) or p.is_relative_to(resolved) for p in protected):
            raise ValueError('destination overlaps protected source/control path')
        if any((parent/'.git').exists() for parent in (resolved, *resolved.parents)):
            raise ValueError('destination must be outside a Git repository')
        if target.exists() and not target.is_dir():
            raise ValueError('unsafe destination type')
    if out.resolve().is_relative_to(work.resolve()) or work.resolve().is_relative_to(out.resolve()):
        raise ValueError('private work and public output overlap')


def _build(build, registry_path, out, catalog, *, workers, chunk_rows, method, work, synthetic):
    """Lock the isolated destination, then run the fallible publication transaction."""
    import fcntl
    import stat
    registry = json.loads(registry_path.read_bytes())
    snapshot = (build/'catalog.json').read_bytes()
    if json.loads(snapshot) != catalog:
        raise ValueError('catalog snapshot changed or supplied metadata differs')
    if not synthetic and digest(snapshot) != PRODUCTION_SHA256:
        raise ValueError('pinned production catalog SHA256 mismatch')
    if synthetic and (catalog.get('synthetic') is not True or not catalog['build_id'].startswith('build-synthetic-') or not 1 <= catalog['count'] <= 64):
        raise ValueError('fixture must be explicitly synthetic and bounded to 64 rows')
    work = Path(work) if work else out.with_name(out.name+'.private-work')
    validate_destinations(build,registry_path,registry,out,work)
    lock = out.with_name(out.name+'.lock')
    reject_links(lock)
    lock.parent.mkdir(parents=True,exist_ok=True)
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe writer lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('destination already has an active writer') from error
        validate_destinations(build,registry_path,registry,out,work)
        owner = dict(schema='static-packager-owner-v1', out=str(out.resolve()), source_catalog_sha256=file_digest(build/'catalog.json'))
        owner_path = work/'owner.json'
        if owner_path.exists():
            if json.loads(owner_path.read_bytes()) != owner:
                raise ValueError('private work ownership mismatch')
        elif (out.exists() and any(out.iterdir())) or (work.exists() and any(work.iterdir())):
            raise ValueError('refusing nonempty unowned output/private work')
        work.mkdir(parents=True,exist_ok=True,mode=0o700)
        atomic_bytes(owner_path,json_bytes(owner))
        # Only owned, exclusively locked staging trees may lose interrupted atomic temps.
        for tree in (out,work):
            for pending in tree.rglob('.pending-*'):
                if pending.is_file(): pending.unlink()
        return _build_locked(build,registry_path,out,catalog,workers=workers,chunk_rows=chunk_rows,
                             method=method,work=work,synthetic=synthetic)
    finally:
        os.close(fd)


def _build_locked(build, registry_path, out, catalog, *, workers, chunk_rows, method, work, synthetic):
    from concurrent.futures import ProcessPoolExecutor
    # Invalidate completion before any fallible revalidation of owned output.
    manifest_path = out/'deployment.json'
    manifest_path.unlink(missing_ok=True)
    registry = json.loads(registry_path.read_bytes())
    validate_catalog(catalog, registry, build)
    if type(workers) is not int or not 1 <= workers <= 32 or type(chunk_rows) is not int or not 1 <= chunk_rows <= 16384 or method not in (0,3):
        raise ValueError('invalid worker/chunk/method settings')
    work = Path(work) if work else out.with_name(out.name+'.private-work')
    snapshot = (build/'catalog.json').read_bytes()
    if json.loads(snapshot) != catalog:
        raise ValueError('catalog snapshot changed before work')
    source_hash = digest(snapshot)
    if not synthetic and source_hash != PRODUCTION_SHA256:
        raise ValueError('pinned production catalog SHA256 mismatch')
    build_id = catalog['build_id']
    count = catalog['count']
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out/'deployment.json'
    manifest_path.unlink(missing_ok=True)
    files = {}

    def publish(virtual, relative, raw, encoding='identity'):
        encoded = gzip.compress(raw, compresslevel=9, mtime=0) if encoding == 'gzip' else raw
        atomic_bytes(out/relative, encoded)
        if file_digest(out/relative) != digest(encoded):
            raise ValueError('published file readback mismatch')
        files[virtual] = dict(path=relative, encoding=encoding, sha256=digest(encoded),
                              raw_sha256=digest(raw), bytes=len(encoded), raw_bytes=len(raw))

    vectors = {}
    for dimension in DIMENSIONS:
        name = catalog['vector_files'][str(dimension)]
        vectors[str(dimension)] = pack_vectors(build/name, out, dimension, count, chunk_rows,
                                               catalog['artifacts'][name])
        for fit in FITS:
            projection = catalog['projections'][f'{dimension}/{fit}']
            for name in (f'{dimension}-{fit}.f32', projection['basis_file']):
                raw = (build/name).read_bytes()
                if digest(raw) != catalog['artifacts'][name]:
                    raise ValueError('source artifact SHA256 mismatch')
                publish(f'/data/{build_id}/{name}', f'data/{build_id}/{name}', raw)

    groups = {}
    for row in catalog['rows']:
        for kind in ('image', 'mask'):
            checksum = row[kind+'_sha256']
            parts = row[kind].split('/')
            source = Path(registry[parts[2]]['root']).joinpath(*parts[3:])
            key = (kind, checksum)
            if key not in groups:
                groups[key] = dict(kind=kind, source_sha256=checksum, paths=set(), size=8 if synthetic else 512,
                                   method=method, out=str(out), work=str(work))
            groups[key]['paths'].add(str(source))
    jobs = [{**job, 'paths': sorted(job['paths'])} for job in groups.values()]
    if workers == 1:
        results = list(map(pack_media, jobs))
    else:
        with ProcessPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(pack_media, jobs, chunksize=8))
    media = dict(zip(groups, results))
    public_keys = ('schema', 'build_id', 'count', 'colors', 'created_at', 'feature_source', 'fits',
                   'model', 'projections', 'revision', 'rows', 'series', 'shapes', 'dimensions',
                   'expected_count', 'complete', 'artifacts', 'vector_files', 'catalog_url')
    derived = {key: catalog[key] for key in public_keys if key in catalog}
    derived['dataset_sources'] = {key: {k:v for k,v in value.items() if k in ('config_sha256', 'expected_count', 'id_offset')}
                                  for key,value in catalog['dataset_sources'].items()}
    derived['provenance'] = dict(source_catalog_sha256=source_hash,
                                transport='Private source_config/runtime and validation omitted; bound by original catalog SHA256. Original row metadata retained; RGB lossless pixel-verified WebP, native mask PNG, byte-exact vectors/projections/bases.')
    derived['rows'] = [{**row, 'image_asset':media[('image',row['image_sha256'])]['path'],
                       'mask_asset':media[('mask',row['mask_sha256'])]['path']} for row in catalog['rows']]
    catalog_raw = json_bytes(derived)
    publish(f'/data/{build_id}/catalog.json', f'data/{build_id}/catalog.json.gz', catalog_raw, 'gzip')
    current = {key:catalog[key] for key in ('schema','build_id','count','complete','expected_count','created_at','dimensions','fits')}
    current.update(catalog_url=f'/data/{build_id}/catalog.json',catalog_sha256=digest(catalog_raw))
    publish('/data/current.json','data/current.json',json_bytes(current))
    manifest = dict(schema='solids-static-synthetic-test-v1' if synthetic else 'solids-static-v1',
                    build_id=build_id,count=count,source_catalog_sha256=source_hash, files=files,vectors=vectors)
    inventory = {d['path']:(d['bytes'],d['sha256']) for d in files.values()}
    for v in vectors.values():
        for d in v['chunks']: inventory[d['path']] = (d['bytes'],d['sha256'])
    for d in results: inventory[d['path']] = (d['bytes'],d['sha256'])
    reject_links(out,tree=True)
    actual = {p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()}
    if actual != set(inventory):
        raise ValueError('unexpected output inventory; use a fresh isolated output for changed settings')
    expected_dirs = {str(parent) for name in inventory for parent in PurePosixPath(name).parents if str(parent) != '.'}
    actual_dirs = {p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_dir()}
    if actual_dirs != expected_dirs:
        raise ValueError('unexpected output directory inventory')
    for relative,(size,checksum) in inventory.items():
        safe_relative(relative)
        if (out/relative).stat().st_size != size or file_digest(out/relative) != checksum:
            raise ValueError('final output readback SHA256/size mismatch')
    if file_digest(build/'catalog.json') != source_hash:
        raise ValueError('source catalog changed during build')
    manifest_raw = json_bytes(manifest)
    sizes = {p:s[0] for p,s in inventory.items()}
    sizes['deployment.json'] = len(manifest_raw)
    totals = deployment_totals(sizes)
    enforce_limits(totals['site_bytes'],totals['tar_bytes'])
    # Last public write: never expose a completed manifest until all proofs and gates pass.
    atomic_bytes(manifest_path,manifest_raw)
    if manifest_path.read_bytes() != manifest_raw:
        manifest_path.unlink(missing_ok=True)
        raise ValueError('manifest readback failed')
    return dict(**totals, source_catalog_sha256=source_hash,
                media_unique=len({r['path'] for r in results}),media_source_groups=len(results),
                media_cached=sum(bool(r['cached']) for r in results),synthetic=synthetic)


def enforce_limits(site_bytes, tar_bytes):
    if site_bytes + 5_000_000 >= 1_000_000_000:
        raise ValueError('site size gate failed (1GB, with 5MB frontend reserve)')
    if tar_bytes >= 10_000_000_000:
        raise ValueError('uncompressed tar size gate failed (10GB)')


def deployment_totals(sizes):
    """Exact normalized USTAR bytes: root+directory headers, padded files, 10KiB records.

    No archive is created. Assumes one entry per file/directory, uid/gid/mtime=0,
    no PAX extensions, regular files only. Recheck after frontend assembly.
    """
    import tarfile
    directories = {'.'}
    for name in sizes:
        safe_relative(name)
        # Prove each pathname is representable without extension records.
        tarfile.TarInfo(name).tobuf(format=tarfile.USTAR_FORMAT)
        directories.update(str(p) for p in PurePosixPath(name).parents if str(p) != '.')
    body = len(directories)*512 + sum(512 + ((size+511)//512)*512 for size in sizes.values())
    tar_bytes = ((body+1024+10239)//10240)*10240
    return dict(file_count=len(sizes),directory_count=len(directories),site_bytes=sum(sizes.values()),
                tar_bytes=tar_bytes,tar_format='normalized-ustar-10240-records',
                frontend_reserved_bytes=5_000_000,site_limit_bytes=1_000_000_000,tar_limit_bytes=10_000_000_000)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def pack_media(job):
    """One content-addressed source group; revalidate ALL sources and cache pixels."""
    from PIL import Image, features, __version__ as pillow_version
    kind = job['kind']
    mode = 'RGB' if kind == 'image' else 'L'
    if kind not in ('image', 'mask') or job['method'] not in (0, 3):
        raise ValueError('unsupported media settings')
    native = pixels = None
    for path in job['paths']:
        data = Path(path).read_bytes()
        if digest(data) != job['source_sha256']:
            raise ValueError('source media SHA256 mismatch')
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'PNG' or image.mode != mode or image.size != (job['size'], job['size']):
                raise ValueError('source media native format/mode/dimensions mismatch')
            image.load()
            pixels = image.tobytes()
        native = data
    if native is None:
        raise ValueError('missing source media')
    identity = dict(schema='pixel-proof-v1', kind=kind, source_sha256=job['source_sha256'],
                    size=job['size'], mode=mode, method=job['method'], lossless=True,
                    pillow=pillow_version, webp=features.version('webp'), quality=100,
                    pixels_sha256=digest(pixels))
    receipt_path = Path(job['work'])/(digest(json_bytes(identity))+'.json')

    def proof(encoded):
        with Image.open(io.BytesIO(encoded)) as image:
            if image.format != ('WEBP' if kind == 'image' else 'PNG') or image.mode != mode or image.size != (job['size'], job['size']):
                raise ValueError('encoded media format mismatch')
            if image.tobytes() != pixels:
                raise ValueError('encoded pixel comparison failed')
        if kind == 'mask' and encoded != native:
            raise ValueError('native mask bytes changed')

    cached = False
    try:
        receipt = json.loads(receipt_path.read_bytes())
        if not isinstance(receipt, dict) or receipt.get('identity') != identity:
            raise ValueError('receipt identity mismatch')
        checksum = receipt['sha256']
        if not re.fullmatch('[0-9a-f]{64}', checksum):
            raise ValueError('bad cache hash')
        relative = f'media/{checksum}.' + ('webp' if kind == 'image' else 'png')
        encoded = (Path(job['out'])/relative).read_bytes()
        if digest(encoded) != checksum or len(encoded) != receipt['bytes']:
            raise ValueError('cache bytes changed')
        proof(encoded)
        cached = True
    except (OSError, ValueError, KeyError, TypeError):
        if kind == 'image':
            image = Image.frombytes(mode, (job['size'], job['size']), pixels)
            stream = io.BytesIO()
            image.save(stream, format='WEBP', lossless=True, method=job['method'], quality=100, exact=True)
            encoded = stream.getvalue()
        else:
            encoded = native
        proof(encoded)
        checksum = digest(encoded)
        relative = f'media/{checksum}.' + ('webp' if kind == 'image' else 'png')
        atomic_bytes(Path(job['out'])/relative, encoded)
        readback = (Path(job['out'])/relative).read_bytes()
        if readback != encoded:
            raise ValueError('media output readback mismatch')
        proof(readback)
        atomic_bytes(receipt_path, json_bytes(dict(identity=identity, sha256=checksum, bytes=len(encoded))))
    return dict(path=relative, sha256=checksum, bytes=len(encoded), cached=cached)


def pack_vectors(source, out, dimension, count, chunk_rows, expected_sha256):
    if any(type(n) is not int or n < 1 for n in (dimension,count,chunk_rows)) or chunk_rows > 16384:
        raise ValueError('invalid vector dimension/count/chunk size')
    if file_digest(source) != expected_sha256:
        raise ValueError('vector artifact SHA256 mismatch')
    a = np.load(source, mmap_mode='r', allow_pickle=False)
    if a.dtype.str != '<f4' or a.shape != (count, dimension) or not a.flags.c_contiguous:
        raise ValueError('vector dtype/shape/order mismatch')
    chunks = []
    full = hashlib.sha256()
    for start in range(0, count, chunk_rows):
        raw = a[start:start + chunk_rows].tobytes(order='C')
        full.update(raw)
        shuffled = b''.join(raw[i::4] for i in range(4))
        encoded = gzip.compress(shuffled, compresslevel=9, mtime=0)
        checksum = digest(encoded)
        relative = f'vectors/{dimension}/{checksum}.bin.gz'
        atomic_bytes(Path(out)/relative, encoded)
        if file_digest(Path(out)/relative) != checksum:
            raise ValueError('vector output readback failed')
        chunks.append(dict(path=relative, start=start, count=len(raw)//(4*dimension),
                           bytes=len(encoded), raw_bytes=len(raw), sha256=checksum,
                           raw_sha256=digest(raw)))
    if file_digest(source) != expected_sha256:
        raise ValueError('vector source changed during packaging')
    return dict(dimension=dimension, count=count, dtype='<f4', raw_sha256=full.hexdigest(), chunks=chunks)


def load_production(build):
    raw = (Path(build)/'catalog.json').read_bytes()
    if digest(raw) != PRODUCTION_SHA256:
        raise ValueError('pinned production catalog SHA256 mismatch; CLI never accepts fixtures')
    catalog = json.loads(raw)
    if catalog.get('build_id') != PRODUCTION_BUILD or catalog.get('count') != PRODUCTION_COUNT or catalog.get('synthetic'):
        raise ValueError('pinned production build/count mismatch')
    return catalog


def plan_production(build, registry_path, out, *, work=None, workers=4, chunk_rows=4096, method=3):
    """READ ONLY: metadata and file sizes; no media decode, compression or writes."""
    build,registry_path,out = Path(build),Path(registry_path),Path(out)
    catalog = load_production(build)
    registry = json.loads(registry_path.read_bytes())
    work = Path(work) if work else out.with_name(out.name+'.private-work')
    validate_destinations(build,registry_path,registry,out,work)
    validate_catalog(catalog,registry,build)
    if not 1 <= workers <= 32 or not 1 <= chunk_rows <= 16384 or method not in (0,3):
        raise ValueError('invalid worker/chunk/method settings')
    return dict(mode='read-only-plan', build_id=PRODUCTION_BUILD,count=PRODUCTION_COUNT,
                source_catalog_sha256=PRODUCTION_SHA256, dimensions=list(DIMENSIONS),
                coordinates=28,bases=28,source_artifacts=60,
                source_artifact_bytes=sum((build/name).stat().st_size for name in catalog['artifacts']),
                vector_raw_bytes=sum(PRODUCTION_COUNT*d*4 for d in DIMENSIONS),
                unique_source_rgb=len({r['image_sha256'] for r in catalog['rows']}),
                unique_source_masks=len({r['mask_sha256'] for r in catalog['rows']}),
                workers=workers,chunk_rows=chunk_rows,webp_method=method,
                site_limit_bytes=1_000_000_000,frontend_reserved_bytes=5_000_000,
                tar_limit_bytes=10_000_000_000, fits_pages=None,
                note='No production artifacts hashed/encoded or written. Final measured site/tar gates run only after complete validation; this is NOT a fit claim.')


def build_production(build, registry_path, out, *, work=None, workers=4, chunk_rows=4096, method=3):
    build = Path(build)
    catalog = load_production(build)
    return _build(build,Path(registry_path),Path(out),catalog,work=work,workers=workers,
                  chunk_rows=chunk_rows,method=method,synthetic=False)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description='Package only the pinned 94200-row production build into an isolated directory outside Git. No archive/upload. Requires NumPy/Pillow and POSIX writer locks.')
    parser.add_argument('--build',required=True,type=Path,help='Accepted build directory (relocatable, catalog SHA256 is fixed)')
    parser.add_argument('--registry',required=True,type=Path,help='Dataset registry JSON; roots may be relocated')
    parser.add_argument('--out',required=True,type=Path,help='Isolated public output; never site/ or a source directory')
    parser.add_argument('--work',type=Path,help='Private receipts, default OUT.private-work; must be outside OUT')
    parser.add_argument('--workers',type=int,default=4,help='Process pool size, 1..32 (default 4)')
    parser.add_argument('--chunk-rows',type=int,default=4096,help='Vector rows per gzip chunk, 1..16384')
    parser.add_argument('--webp-method',type=int,choices=(0,3),default=3,help='Lossless WebP effort (default 3)')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan',action='store_true',help='Read-only planning; no decode/conversion, no fit claim')
    mode.add_argument('--execute',action='store_true',help='Explicitly authorize full conversion; manifest written last after size gates')
    args = parser.parse_args(argv)
    try:
        operation = plan_production if args.plan else build_production
        result = operation(args.build,args.registry,args.out,work=args.work,workers=args.workers,
                           chunk_rows=args.chunk_rows,method=args.webp_method)
        print(json.dumps(result,sort_keys=True,indent=2))
        return 0
    except (ValueError,OSError,KeyError,TypeError) as error:
        parser.exit(2, f'packager refused: {error}\n')


if __name__ == '__main__':
    raise SystemExit(main())
