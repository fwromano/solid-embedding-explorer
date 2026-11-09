"""Synthetic-only release transaction and hostile archive tests (stdlib)."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / 'tools/release_bundle.py'
if MODULE.exists():
    spec = importlib.util.spec_from_file_location('release_bundle', MODULE)
    bundle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bundle)
else:
    bundle = None

RUNTIME = ('index.html', 'app.js', 'core.js', 'style.css', 'view-colors.js',
           'view-map.js', 'view-map.css', 'plot-annotations.js', 'transport.js',
           'diagnostics.js', 'vector-codec.js', 'diagnostics-worker.js', 'symmetry.js', 'coverage.js', 'preview-orbit.js')


def encoded(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class ReleaseBundleTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(bundle, 'release bundle implementation is missing')
        self.tmp = tempfile.TemporaryDirectory(prefix='release-fixture-', dir=os.environ['TMPDIR'])
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data-root'
        self.front = self.root / 'frontend'
        self.data.mkdir()
        self.front.mkdir()
        self.files = {'data/current.json': b'{"fixture":true}', 'media/tiny.png': b'not-production',
                      'vectors/128/tiny.bin.gz': b'synthetic-vector'}
        self.deployment = dict(schema='solids-static-synthetic-test-v1', build_id='build-synthetic-release',
                               count=2, source_catalog_sha256='a' * 64, files={}, vectors={})
        self.save_deployment()
        for name, raw in self.files.items():
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        for name in RUNTIME:
            (self.front / name).write_bytes(('fixture ' + name).encode())
        (self.front / 'test-secret.js').write_bytes(b'NOT FOR PUBLICATION')
        self.archive, self.manifest, self.out = (self.root / n for n in ('bundle.tar.gz', 'release.json', '_site'))

    def save_deployment(self):
        (self.data / 'deployment.json').write_bytes(encoded(self.deployment))

    def pack(self, **kwargs):
        return bundle.pack(self.data, self.archive, self.manifest, tag='data-v1',
                           asset='solids-static-data-v1.tar.gz', allow_synthetic=True, **kwargs)

    def restore(self, **kwargs):
        return bundle.restore(self.archive, self.manifest, self.front, self.out,
                              allow_synthetic=True, **kwargs)

    def rewrite_archive(self, entries=None, inventory_raw=None, *, refresh_inventory=False):
        with tarfile.open(self.archive, 'r:gz') as tf:
            original = [(m, tf.extractfile(m).read()) for m in tf.getmembers()]
        entries = entries if entries is not None else original[1:]
        inventory_raw = inventory_raw if inventory_raw is not None else original[0][1]
        if refresh_inventory:
            inventory_raw = encoded({m.name: {'bytes': len(raw), 'sha256': sha(raw)} for m, raw in entries})
        with tarfile.open(self.archive, 'w:gz', format=tarfile.USTAR_FORMAT) as tf:
            first = tarfile.TarInfo('inventory.json')
            first.size = len(inventory_raw)
            tf.addfile(first, io.BytesIO(inventory_raw))
            for member, raw in entries:
                member.size = len(raw)
                tf.addfile(member, io.BytesIO(raw))
        metadata = json.loads(self.manifest.read_bytes())
        metadata.update(archive_sha256=sha(self.archive.read_bytes()), archive_bytes=self.archive.stat().st_size,
                        inventory_sha256=sha(inventory_raw))
        if refresh_inventory:
            metadata.update(file_count=len(entries), site_bytes=sum(len(raw) for _, raw in entries))
        self.manifest.write_bytes(encoded(metadata))

    def describe_source(self):
        raw = self.files['data/current.json']
        self.deployment['files']['/data/current.json'] = dict(path='data/current.json', encoding='identity',
             bytes=len(raw), raw_bytes=len(raw), sha256=sha(raw), raw_sha256=sha(raw))
        catalog = b'{"synthetic":true}'
        catalog_gz = gzip.compress(catalog, mtime=0)
        (self.data / 'data/catalog.json.gz').write_bytes(catalog_gz)
        self.deployment['files']['/data/catalog.json'] = dict(path='data/catalog.json.gz', encoding='gzip',
             bytes=len(catalog_gz), raw_bytes=len(catalog), sha256=sha(catalog_gz), raw_sha256=sha(catalog))
        raw_vector = bytes(range(256)) * 4
        vector_gz = gzip.compress(b''.join(raw_vector[i::4] for i in range(4)), mtime=0)
        path = 'vectors/128/tiny.bin.gz'
        (self.data / path).write_bytes(vector_gz)
        self.deployment['vectors']['128'] = dict(dimension=128, count=2, dtype='<f4', raw_sha256=sha(raw_vector),
             chunks=[dict(path=path, start=0, count=2, bytes=len(vector_gz), raw_bytes=len(raw_vector),
                          sha256=sha(vector_gz), raw_sha256=sha(raw_vector))])
        self.save_deployment()

    def test_deployment_file_and_raw_vector_commitments(self):
        self.describe_source()
        self.pack()
        self.restore()
        good_dep = encoded(self.deployment)
        self.archive.unlink()
        self.manifest.unlink()
        for attack in ('encoded_hash', 'raw_hash', 'gzip_raw_hash', 'vector_hash', 'vector_coverage',
                       'vector_full_hash', 'unsafe_path', 'missing_path'):
            with self.subTest(attack=attack):
                self.archive, self.manifest = self.root / (attack + '.gz'), self.root / (attack + '.json')
                self.deployment = json.loads(good_dep)
                current = self.deployment['files']['/data/current.json']
                vector = self.deployment['vectors']['128']
                if attack == 'encoded_hash':
                    current['sha256'] = '0' * 64
                elif attack == 'raw_hash':
                    current['raw_sha256'] = '0' * 64
                elif attack == 'gzip_raw_hash':
                    self.deployment['files']['/data/catalog.json']['raw_sha256'] = '0' * 64
                elif attack == 'vector_hash':
                    vector['chunks'][0]['raw_sha256'] = '0' * 64
                elif attack == 'vector_coverage':
                    vector['chunks'][0]['start'] = 1
                elif attack == 'vector_full_hash':
                    vector['raw_sha256'] = '0' * 64
                else:
                    current['path'] = 'data/../deployment.json' if attack == 'unsafe_path' else 'data/missing'
                self.save_deployment()
                with self.assertRaises(ValueError):
                    self.pack()
                self.assertFalse(self.archive.exists())
                self.assertFalse(self.manifest.exists())
        self.archive, self.manifest = self.root / 'validated.gz', self.root / 'validated.json'
        self.deployment = json.loads(good_dep)
        self.save_deployment()
        self.pack()
        with tarfile.open(self.archive, 'r:gz') as tf:
            entries = [(m, tf.extractfile(m).read()) for m in tf.getmembers()[1:]]
        self.deployment['files']['/data/current.json']['sha256'] = '0' * 64
        entries = [(m, encoded(self.deployment) if m.name == 'deployment.json' else raw) for m, raw in entries]
        self.rewrite_archive(entries, refresh_inventory=True)
        self.out = self.root / 'out-bad-deployment'
        with self.assertRaises(ValueError):
            self.restore()
        self.assertFalse(self.out.exists())

    def test_source_changed_during_archive_stream_is_not_published(self):
        original_add = tarfile.TarFile.addfile
        changed = []
        def mutate_then_add(tf, entry, stream=None):
            if entry.name == 'media/tiny.png':
                path = self.data / entry.name
                path.write_bytes(b'X' * path.stat().st_size)
                changed.append(entry.name)
            return original_add(tf, entry, stream)
        with mock.patch.object(tarfile.TarFile, 'addfile', new=mutate_then_add):
            with self.assertRaisesRegex(ValueError, 'SHA256|changed|hash'):
                self.pack()
        self.assertEqual(changed, ['media/tiny.png'])
        self.assertFalse(self.archive.exists())
        self.assertFalse(self.manifest.exists())
        self.assertFalse(list(self.root.glob('.release-*')))

    def test_no_clobber_transactions_and_failure_cleanup(self):
        self.manifest.write_bytes(b'KEEP manifest')
        with self.assertRaises((ValueError, FileExistsError)):
            self.pack()
        self.assertEqual(self.manifest.read_bytes(), b'KEEP manifest')
        self.assertFalse(self.archive.exists())
        self.manifest.unlink()
        self.archive.write_bytes(b'KEEP archive')
        with self.assertRaises((ValueError, FileExistsError)):
            self.pack()
        self.assertEqual(self.archive.read_bytes(), b'KEEP archive')
        self.assertFalse(self.manifest.exists())
        self.archive.unlink()
        with mock.patch.object(bundle, 'ARCHIVE_LIMIT', 16):
            with self.assertRaises(ValueError):
                self.pack()
        self.assertFalse(self.archive.exists())
        self.assertFalse(self.manifest.exists())
        original_archive = self.archive
        self.archive = self.data / 'data/forbidden.tar.gz'
        with self.assertRaises(ValueError):
            self.pack()
        self.assertFalse(self.archive.exists())
        self.archive = original_archive
        self.pack()
        for kind in ('empty', 'nonempty', 'file', 'symlink'):
            with self.subTest(kind=kind):
                self.out = self.root / ('existing-' + kind)
                if kind in ('empty', 'nonempty'):
                    self.out.mkdir()
                    if kind == 'nonempty':
                        (self.out / 'KEEP').write_bytes(b'keep')
                elif kind == 'file':
                    self.out.write_bytes(b'KEEP')
                else:
                    self.out.symlink_to(self.front, target_is_directory=True)
                before = self.out.lstat()
                with self.assertRaises((ValueError, FileExistsError)):
                    self.restore()
                self.assertEqual(self.out.lstat().st_ino, before.st_ino)
        self.out = self.root / 'failed-out'
        (self.front / RUNTIME[-1]).unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.restore()
        self.assertFalse(self.out.exists())
        self.assertFalse(list(self.root.glob('.release-*')))

    def test_pack_requires_readonly_safe_completed_source(self):
        import fcntl
        lock = self.data.with_name(self.data.name + '.lock')
        lock.write_bytes(b'packager lock')
        lock_before = lock.stat()
        with lock.open('rb') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'lock|writer'):
                self.pack()
        self.assertFalse(self.archive.exists())
        original_digest = bundle.file_digest
        checked = []
        def check_shared(path):
            if Path(path).is_relative_to(self.data):
                with lock.open('rb') as probe:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                checked.append(path)
            return original_digest(path)
        with mock.patch.object(bundle, 'file_digest', side_effect=check_shared):
            self.pack()
        self.assertTrue(checked)
        self.assertEqual(lock.read_bytes(), b'packager lock')
        self.assertEqual(lock.stat().st_mtime_ns, lock_before.st_mtime_ns)
        self.archive.unlink()
        self.manifest.unlink()
        for attack in ('scope', 'symlink', 'hardlink', 'fifo', 'git', 'source_symlink', 'lock_symlink'):
            with self.subTest(attack=attack):
                bad = self.data / ('secret.txt' if attack == 'scope' else 'media/unsafe')
                original_data = self.data
                try:
                    if attack == 'scope':
                        bad.write_bytes(b'private')
                    elif attack == 'symlink':
                        bad.symlink_to(self.data / 'media/tiny.png')
                    elif attack == 'hardlink':
                        os.link(self.data / 'media/tiny.png', bad)
                    elif attack == 'fifo':
                        os.mkfifo(bad)
                    elif attack == 'git':
                        bad = self.root / '.git'
                        bad.mkdir()
                    elif attack == 'source_symlink':
                        bad = self.root / 'linked-source'
                        bad.symlink_to(self.data, target_is_directory=True)
                        self.data = bad
                    else:
                        bad = lock
                        lock.unlink()
                        lock.symlink_to(self.data / 'deployment.json')
                    with self.assertRaises(ValueError):
                        self.pack()
                    self.assertFalse(self.archive.exists())
                    self.assertFalse(self.manifest.exists())
                finally:
                    self.data = original_data
                    if bad.is_dir() and not bad.is_symlink():
                        bad.rmdir()
                    else:
                        bad.unlink(missing_ok=True)
                    self.archive.unlink(missing_ok=True)
                    self.manifest.unlink(missing_ok=True)

    def test_capacity_and_metadata_bounds(self):
        for name, limit in [('SITE_LIMIT', 5_000_001), ('TAR_LIMIT', 10240), ('ARCHIVE_LIMIT', 16),
                            ('JSON_LIMIT', 16), ('MAX_FILES', 2)]:
            with self.subTest(operation='pack', limit=name):
                self.archive = self.root / (name + '.tar.gz')
                self.manifest = self.root / (name + '.json')
                with mock.patch.object(bundle, name, limit, create=True):
                    with self.assertRaises(ValueError):
                        self.pack()
        self.archive, self.manifest = self.root / 'good.tar.gz', self.root / 'good.json'
        self.pack()
        for name, limit in [('SITE_LIMIT', 5_000_001), ('TAR_LIMIT', 10240), ('ARCHIVE_LIMIT', 16),
                            ('JSON_LIMIT', 16), ('MANIFEST_LIMIT', 16), ('MAX_FILES', 2)]:
            with self.subTest(operation='restore', limit=name):
                self.out = self.root / ('out-' + name)
                with mock.patch.object(bundle, name, limit, create=True):
                    with self.assertRaises(ValueError):
                        self.restore()
                self.assertFalse(self.out.exists())
        total = json.loads(self.manifest.read_bytes())['site_bytes']
        total += sum((self.front / name).stat().st_size for name in RUNTIME)
        self.out = self.root / 'out-final-site'
        with mock.patch.object(bundle, 'FRONTEND_RESERVE', 0, create=True), \
                mock.patch.object(bundle, 'SITE_LIMIT', total, create=True):
            with self.assertRaises(ValueError):
                self.restore()
        self.assertFalse(self.out.exists())

    def test_hostile_member_structure_is_rejected(self):
        self.pack()
        good_archive, good_manifest = self.archive.read_bytes(), self.manifest.read_bytes()
        attacks = ('traversal', 'absolute', 'dot', 'double_slash', 'backslash', 'scope',
                   'duplicate', 'extra', 'missing', 'symlink', 'hardlink', 'fifo', 'directory',
                   'pax', 'trailing', 'inventory_self', 'inventory_type', 'negative', 'bool_size')
        for attack in attacks:
            with self.subTest(attack=attack):
                self.out = self.root / ('out-' + attack)
                self.archive.write_bytes(good_archive)
                self.manifest.write_bytes(good_manifest)
                with tarfile.open(self.archive, 'r:gz') as tf:
                    entries = [(m, tf.extractfile(m).read()) for m in tf.getmembers()[1:]]
                    inventory = json.loads(tf.extractfile('inventory.json').read())
                if attack in ('inventory_self', 'inventory_type', 'negative', 'bool_size'):
                    if attack == 'inventory_self':
                        inventory['inventory.json'] = {'bytes': 0, 'sha256': sha(b'')}
                    elif attack == 'inventory_type':
                        inventory = []
                    else:
                        inventory['media/tiny.png']['bytes'] = -1 if attack == 'negative' else True
                    self.rewrite_archive(inventory_raw=encoded(inventory))
                elif attack == 'duplicate':
                    self.rewrite_archive(entries + [entries[0]])
                elif attack == 'missing':
                    self.rewrite_archive(entries[:-1])
                elif attack == 'extra':
                    entry = tarfile.TarInfo('data/extra')
                    self.rewrite_archive(entries + [(entry, b'extra')])
                elif attack in ('pax', 'trailing'):
                    raw = gzip.decompress(good_archive)
                    if attack == 'pax':
                        entry = tarfile.TarInfo('pax-header')
                        entry.type = tarfile.XHDTYPE
                        entry.size = 0
                        raw = entry.tobuf(format=tarfile.USTAR_FORMAT) + raw
                    else:
                        raw += b'UNEXPECTED TAIL'
                    self.archive.write_bytes(gzip.compress(raw, mtime=0))
                    meta = json.loads(good_manifest)
                    meta.update(archive_sha256=sha(self.archive.read_bytes()), archive_bytes=self.archive.stat().st_size)
                    self.manifest.write_bytes(encoded(meta))
                else:
                    entry = tarfile.TarInfo({'traversal': 'data/../../escaped', 'absolute': '/escaped',
                        'dot': 'data/./evil', 'double_slash': 'data//evil', 'backslash': 'data/evil\\escape',
                        'scope': 'private.txt'}.get(attack, 'data/evil'))
                    raw = b'hostile'
                    if attack in ('symlink', 'hardlink', 'fifo', 'directory'):
                        entry.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
                                      'fifo': tarfile.FIFOTYPE, 'directory': tarfile.DIRTYPE}[attack]
                        entry.linkname = 'data/current.json'
                        raw = b''
                    self.rewrite_archive(entries + [(entry, raw)], refresh_inventory=True)
                with self.assertRaises(ValueError):
                    self.restore()
                self.assertFalse(self.out.exists())
                self.assertFalse(list(self.root.glob('.release-staging-*')))

    def test_integrity_layers_fail_closed(self):
        self.pack()
        good_archive, good_manifest = self.archive.read_bytes(), self.manifest.read_bytes()
        for attack in ('archive', 'archive_bytes', 'inventory_sha256', 'file_hash', 'deployment_pins',
                       'manifest_duplicate', 'inventory_duplicate', 'deployment_duplicate', 'site_bytes', 'file_count'):
            with self.subTest(attack=attack):
                self.out = self.root / ('out-' + attack)
                self.archive.write_bytes(good_archive)
                self.manifest.write_bytes(good_manifest)
                metadata = json.loads(good_manifest)
                if attack == 'archive':
                    self.archive.write_bytes(b'X' + good_archive[1:])
                elif attack in ('archive_bytes', 'site_bytes', 'file_count'):
                    metadata[attack] += 1
                    self.manifest.write_bytes(encoded(metadata))
                elif attack == 'inventory_sha256':
                    metadata[attack] = '0' * 64
                    self.manifest.write_bytes(encoded(metadata))
                elif attack == 'manifest_duplicate':
                    self.manifest.write_bytes(b'{"count":2,' + good_manifest[1:])
                elif attack == 'inventory_duplicate':
                    with tarfile.open(self.archive, 'r:gz') as tf:
                        raw = tf.extractfile('inventory.json').read()
                    self.rewrite_archive(inventory_raw=b'{"deployment.json":{"bytes":0,"sha256":"' + b'0'*64 + b'"},' + raw[1:])
                else:
                    with tarfile.open(self.archive, 'r:gz') as tf:
                        entries = [(m, tf.extractfile(m).read()) for m in tf.getmembers()[1:]]
                    for index, (member, raw) in enumerate(entries):
                        if member.name == 'deployment.json':
                            if attack == 'deployment_pins':
                                dep = json.loads(raw)
                                dep['count'] = 3
                                raw = encoded(dep)
                            elif attack == 'deployment_duplicate':
                                raw = b'{"count":2,' + raw[1:]
                            else:
                                raw = raw[:-1] + b' '
                            entries[index] = (member, raw)
                    self.rewrite_archive(entries, refresh_inventory=attack != 'file_hash')
                with self.assertRaises(ValueError):
                    self.restore()
                self.assertFalse(self.out.exists())
                self.assertFalse(list(self.root.glob('.release-staging-*')))

    def test_production_boundary_rejects_synthetic_and_wrong_pins(self):
        with self.assertRaisesRegex(ValueError, 'production|synthetic'):
            bundle.pack(self.data, self.archive, self.manifest, tag='data-v1',
                        asset='solids-static-data-v1.tar.gz')
        self.assertFalse(self.archive.exists())
        self.pack()
        with self.assertRaisesRegex(ValueError, 'production|synthetic'):
            bundle.restore(self.archive, self.manifest, self.front, self.out)
        self.assertFalse(self.out.exists())
        for command in (
            ['pack', '--data', str(self.data), '--archive', str(self.root / 'cli.tar.gz'),
             '--manifest', str(self.root / 'cli.json'), '--tag', 'data-v1', '--asset', 'solids-static-data-v1.tar.gz'],
            ['restore', '--archive', str(self.archive), '--manifest', str(self.manifest),
             '--frontend', str(self.front), '--out', str(self.out)]):
            result = subprocess.run([sys.executable, str(MODULE), *command], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('synthetic', result.stderr)
        self.assertFalse(self.out.exists())
        self.assertFalse((self.root / 'cli.tar.gz').exists())
        for field, value in [('schema', 'solids-static-v1'), ('count', 94200), ('build_id', '../evil')]:
            original = self.deployment[field]
            self.deployment[field] = value
            self.save_deployment()
            with self.assertRaises(ValueError):
                bundle.pack(self.data, self.root / 'bad.tar.gz', self.root / 'bad.json',
                            tag='data-v1', asset='solids-static-data-v1.tar.gz', allow_synthetic=True)
            self.deployment[field] = original

    def test_deterministic_roundtrip_inventory_and_runtime_allowlist(self):
        before = {p.relative_to(self.data).as_posix(): p.read_bytes()
                  for p in self.data.rglob('*') if p.is_file()}
        result = self.pack()
        self.assertEqual(result, json.loads(self.manifest.read_bytes()))
        self.assertEqual(set(result), {'schema', 'tag', 'asset', 'archive_sha256', 'archive_bytes',
                         'inventory_sha256', 'build_id', 'count', 'source_catalog_sha256', 'site_bytes', 'file_count'})
        self.assertNotIn(str(self.root), self.manifest.read_text())
        self.assertEqual(result['site_bytes'], sum(map(len, before.values())))
        self.assertEqual(result['file_count'], len(before))
        with tarfile.open(self.archive, 'r:gz') as tf:
            members = tf.getmembers()
            self.assertEqual([m.name for m in members], ['inventory.json'] + sorted(before))
            self.assertTrue(all(m.isreg() and m.uid == m.gid == m.mtime == 0 for m in members))
            inventory_raw = tf.extractfile(members[0]).read()
        self.assertEqual(result['inventory_sha256'], sha(inventory_raw))
        self.assertEqual(json.loads(inventory_raw), {k: {'bytes': len(v), 'sha256': sha(v)} for k, v in before.items()})
        self.restore()
        actual = {p.relative_to(self.out).as_posix(): p.read_bytes()
                  for p in self.out.rglob('*') if p.is_file()}
        self.assertEqual(set(actual), set(before) | set(RUNTIME) | {'.nojekyll'})
        for name, raw in before.items():
            self.assertEqual(actual[name], raw)
            self.assertEqual((self.data / name).read_bytes(), raw)
        second = self.root / 'second.tar.gz'
        second_manifest = self.root / 'second.json'
        bundle.pack(self.data, second, second_manifest, tag='data-v1',
                    asset='solids-static-data-v1.tar.gz', allow_synthetic=True)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        self.assertEqual(self.manifest.read_bytes(), second_manifest.read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
