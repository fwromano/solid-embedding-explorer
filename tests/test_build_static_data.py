"""Synthetic-only packager tests; never open the production dataset."""
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

import numpy as np
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/build_static_data.py'

def load():
    if not SCRIPT.exists():
        raise AssertionError('static packager implementation is missing')
    spec = importlib.util.spec_from_file_location('build_static_data', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def sha(b):
    return hashlib.sha256(b).hexdigest()

class VectorTests(unittest.TestCase):
    def test_byte_planes_chunks_exact_and_deterministic(self):
        m = load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root = Path(tmp)
            # Include signed zero, NaN payload and subnormal bits: no float arithmetic.
            bits = np.array([0, 0x80000000, 0x7fc00001, 1, 0x3f800000, 0xff800000], dtype='<u4')
            a = bits.view('<f4').reshape(3, 2)
            np.save(root/'vectors.npy', a)
            desc = m.pack_vectors(root/'vectors.npy', root/'out', 2, 3, 2, sha((root/'vectors.npy').read_bytes()))
            raw = bytearray()
            for chunk in desc['chunks']:
                encoded = (root/'out'/chunk['path']).read_bytes()
                self.assertEqual(sha(encoded), chunk['sha256'])
                self.assertEqual(encoded[4:8], b'\0'*4)
                planes = gzip.decompress(encoded)
                n = len(planes)//4
                block = bytearray(len(planes))
                for i in range(4): block[i::4] = planes[i*n:(i+1)*n]
                self.assertEqual(sha(block), chunk['raw_sha256'])
                self.assertEqual(len(block), chunk['raw_bytes'])
                raw.extend(block)
            self.assertEqual(bytes(raw), a.tobytes())
            self.assertEqual(desc['raw_sha256'], sha(raw))
            self.assertEqual([c['start'] for c in desc['chunks']], [0, 2])
            self.assertEqual(desc, m.pack_vectors(root/'vectors.npy', root/'out', 2, 3, 2, sha((root/'vectors.npy').read_bytes())))

    def test_invalid_vectors_and_midstream_source_mutation_fail_closed(self):
        from unittest.mock import patch
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); source=root/'a.npy'
            np.save(source,np.zeros((3,2),dtype='<f4')); checksum=sha(source.read_bytes())
            with self.assertRaises(ValueError): m.pack_vectors(source,root/'out',2,3,-1,checksum)
            for dtype,shape in [('>f4',(3,2)),('<f8',(3,2)),('<f4',(2,3))]:
                np.save(source,np.zeros(shape,dtype=dtype))
                with self.assertRaises(ValueError): m.pack_vectors(source,root/'out',2,3,2,sha(source.read_bytes()))
            np.save(source,np.zeros((3,2),dtype='<f4')); checksum=sha(source.read_bytes())
            original_atomic=m.atomic_bytes
            def concurrent_change(path,data):
                original_atomic(path,data)
                with source.open('ab') as stream: stream.write(b'changed')
            with patch.object(m,'atomic_bytes',side_effect=concurrent_change):
                with self.assertRaisesRegex(ValueError,'vector.*changed'):
                    m.pack_vectors(source,root/'out',2,3,2,checksum)

DIMS = [128, 256, 512, 768]
FITS = ['all', 'balanced', 'shape', 'color', 'pls', 'pls-attributes', 'pls-pose']

def fixture(root):
    build = root/'source'/'build-synthetic-test'
    build.mkdir(parents=True)
    dataset = root/'dataset'
    (dataset/'rgb').mkdir(parents=True)
    (dataset/'masks').mkdir()
    for name, mode in [('rgb', 'RGB'), ('masks', 'L')]:
        Image.new(mode, (8, 8), (1, 70, 210) if mode == 'RGB' else 191).save(dataset/name/'a.png')
    catalog = dict(schema='solids-explorer-v1', synthetic=True, build_id=build.name,
                   count=3, expected_count=3, complete=True, colors=[{'id':'red'}],
                   created_at='synthetic', feature_source='SYNTHETIC TEST ONLY', fits=FITS,
                   model='synthetic', projections={}, revision='synthetic', rows=[],
                   series=[], shapes=[{'id':'cube'}], dimensions=DIMS, artifacts={}, vector_files={},
                   dataset_sources={'synthetic':dict(config_sha256='a'*64, expected_count=3, id_offset=0)},
                   provenance={'source_config':'/PRIVATE/path'}, validation={'runtime':'/PRIVATE/path'})
    for d in DIMS:
        filename=f'vectors-{d}.npy'
        np.save(build/filename, np.arange(3*d, dtype='<f4').reshape(3,d))
        catalog['vector_files'][str(d)] = filename
        for fit in FITS:
            coord=f'{d}-{fit}.f32'; basis=f'{d}-{fit}-basis.json'
            (build/coord).write_bytes(np.arange(9, dtype='<f4').tobytes())
            (build/basis).write_text('{"synthetic_basis":true}')
            catalog['projections'][f'{d}/{fit}'] = dict(url=f'/data/{build.name}/{coord}', basis_file=basis)
        for path in build.iterdir(): catalog['artifacts'][path.name]=sha(path.read_bytes())
    for i in range(3):
        catalog['rows'].append(dict(id=i, key=f'synthetic-{i}', shape='cube', color='red',
            elevation=i, heading=i, source='synthetic', source_dataset='synthetic', source_row_index=i,
            image='/dataset/synthetic/rgb/a.png', mask='/dataset/synthetic/masks/a.png',
            image_sha256=sha((dataset/'rgb/a.png').read_bytes()), mask_sha256=sha((dataset/'masks/a.png').read_bytes())))
    (build/'catalog.json').write_text(json.dumps(catalog))
    registry=root/'registry.json'
    registry.write_text(json.dumps({'synthetic':dict(root=str(dataset), **catalog['dataset_sources']['synthetic'])}))
    return build, registry, catalog

class BuildTests(unittest.TestCase):
    def test_complete_synthetic_transport_preserves_rows_and_all_artifacts(self):
        m=load()
        self.assertTrue(hasattr(m, 'build_fixture'), 'fixture build entry point missing')
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build, registry, original=fixture(root); out=root/'output'
            report=m.build_fixture(build, registry, out, workers=1, chunk_rows=2)
            manifest=json.loads((out/'deployment.json').read_bytes())
            self.assertEqual(manifest['schema'], 'solids-static-synthetic-test-v1')
            self.assertEqual(manifest['count'], 3)
            self.assertEqual(manifest['source_catalog_sha256'],sha((build/'catalog.json').read_bytes()))
            self.assertEqual(len(manifest['files']),58)
            for virtual, desc in manifest['files'].items():
                encoded=(out/desc['path']).read_bytes()
                self.assertEqual(sha(encoded),desc['sha256'])
                raw=gzip.decompress(encoded) if desc['encoding']=='gzip' else encoded
                self.assertEqual(sha(raw),desc['raw_sha256'])
                if virtual.endswith('catalog.json'): derived=json.loads(raw)
                elif virtual.endswith('current.json'): current=json.loads(raw)
                else: self.assertEqual(raw,(build/virtual.rsplit('/',1)[1]).read_bytes())
            self.assertEqual(current['catalog_sha256'],sha(gzip.decompress((out/manifest['files'][f'/data/{build.name}/catalog.json']['path']).read_bytes())))
            self.assertNotIn('/PRIVATE',json.dumps(derived))
            for before,after in zip(original['rows'],derived['rows']):
                self.assertEqual(before,{k:v for k,v in after.items() if not k.endswith('_asset')})
            self.assertEqual(len(list((out/'media').iterdir())),2)
            for d in DIMS:
                desc=manifest['vectors'][str(d)]; raw=bytearray()
                for chunk in desc['chunks']:
                    planes=gzip.decompress((out/chunk['path']).read_bytes()); n=len(planes)//4
                    block=bytearray(len(planes))
                    for i in range(4): block[i::4]=planes[i*n:(i+1)*n]
                    raw.extend(block)
                self.assertEqual(bytes(raw),np.load(build/f'vectors-{d}.npy').tobytes())
            self.assertEqual(report['file_count'],len([p for p in out.rglob('*') if p.is_file()]))
            self.assertEqual(report['site_bytes'],sum(p.stat().st_size for p in out.rglob('*') if p.is_file()))
            self.assertFalse((out/'private-work').exists())

    def test_rejects_incomplete_or_misbound_metadata_before_publication(self):
        m=load()
        mutations = {
            'duplicate-id': lambda c: c['rows'][1].update(id=0),
            'wrong-source-index': lambda c: c['rows'][1].update(source_row_index=0),
            'bad-source-namespace': lambda c: c['rows'][0].update(source_dataset='other'),
            'missing-row': lambda c: c['rows'].pop(),
            'missing-projection': lambda c: c['projections'].pop('128/all'),
            'wrong-projection-url': lambda c: c['projections']['128/all'].update(url='/data/other/128-all.f32'),
            'bad-artifact-pin': lambda c: c['artifacts'].update({'128-all.f32':'bad'}),
            'bad-image-hash': lambda c: c['rows'][0].update(image_sha256='bad'),
            'wrong-completeness': lambda c: c.update(complete=False),
            'wrong-fit-list': lambda c: c.update(fits=['all']),
            'wrong-shape-label': lambda c: c['rows'][0].update(shape='unknown'),
            'bad-coordinate-size': lambda c: c['artifacts'].update({'128-all.f32':sha(b'bad')}),
            'traversal': lambda c: c['rows'][0].update(image='/dataset/synthetic/rgb/../a.png'),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
                root=Path(tmp); build,registry,c=fixture(root); mutate(c)
                if name=='bad-coordinate-size': (build/'128-all.f32').write_bytes(b'bad')
                (build/'catalog.json').write_text(json.dumps(c))
                with self.assertRaises(ValueError): m.build_fixture(build,registry,root/'out')
                self.assertFalse((root/'out/deployment.json').exists())

    def test_output_paths_never_touch_source_control_or_symlinks(self):
        m=load()
        for case in ('source','dataset','registry','parent','work-in-out','symlink','hardlink','unowned','repository'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
                root=Path(tmp); build,registry,c=fixture(root); out=root/'out'; work=root/'work'
                protected=registry.read_bytes()
                if case=='source': out=build
                elif case=='dataset': out=root/'dataset'/'new'
                elif case=='registry': out=registry
                elif case=='parent': out=root
                elif case=='work-in-out': work=out/'work'
                elif case=='symlink': out.symlink_to(root/'dataset',target_is_directory=True)
                elif case=='hardlink':
                    out.mkdir(); os.link(registry,out/'control.json')
                elif case=='unowned':
                    out.mkdir(); (out/'important.txt').write_text('keep')
                elif case=='repository':
                    repo=root/'repo'; (repo/'.git').mkdir(parents=True); out=repo/'output'
                with self.assertRaisesRegex(ValueError, 'unsafe|overlap|protected|owned|link|repository'):
                    m.build_fixture(build,registry,out,work=work)
                self.assertEqual(registry.read_bytes(),protected)
                self.assertFalse((build/'deployment.json').exists())

    def test_final_size_gate_tar_accounting_and_no_false_completion(self):
        m=load()
        self.assertTrue(hasattr(m,'enforce_limits'),'size gate missing')
        m.enforce_limits(994_999_999,1_100_000_000)
        for site,tar in [(995_000_000,1),(1,10_000_000_000)]:
            with self.assertRaises(ValueError): m.enforce_limits(site,tar)
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root); out=root/'out'
            report=m.build_fixture(build,registry,out,workers=2)
            # Independently build a tiny in-memory normalized USTAR (no archive on disk).
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as archive:
                for path in [out,*sorted(out.rglob('*'))]:
                    name='.' if path==out else path.relative_to(out).as_posix()
                    info=tarfile.TarInfo(name); info.mtime=0
                    if path.is_dir():
                        info.type=tarfile.DIRTYPE; archive.addfile(info)
                    else:
                        data=path.read_bytes(); info.size=len(data); archive.addfile(info,io.BytesIO(data))
            self.assertEqual(report['tar_bytes'],len(buffer.getvalue()))
            self.assertEqual(report['frontend_reserved_bytes'],5_000_000)
            manifest=(out/'deployment.json').read_bytes()
            resumed=m.build_fixture(build,registry,out,workers=2)
            self.assertEqual(resumed['media_cached'],2)
            self.assertEqual(manifest,(out/'deployment.json').read_bytes())
            # Corrupt a source AFTER successful output; a failed rerun must remove completion.
            (build/'128-all.f32').write_bytes(b'bad source')
            with self.assertRaises(ValueError): m.build_fixture(build,registry,out)
            self.assertFalse((out/'deployment.json').exists())

    def test_positive_elevation_source_paths_are_preserved(self):
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root)
            for sub in ('rgb','masks'): (root/'dataset'/sub/'a.png').rename(root/'dataset'/sub/'el+00.png')
            for row in c['rows']:
                row['image']=row['image'].replace('a.png','el+00.png')
                row['mask']=row['mask'].replace('a.png','el+00.png')
            (build/'catalog.json').write_text(json.dumps(c))
            m.build_fixture(build,registry,root/'out')
            self.assertTrue((root/'out/deployment.json').exists())

    def test_resume_cleans_only_private_atomic_temporaries_and_checks_catalog_snapshot(self):
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root); out=root/'out'
            m.build_fixture(build,registry,out)
            (out/'media/.pending-interrupted').write_bytes(b'incomplete')
            report=m.build_fixture(build,registry,out)
            self.assertEqual(report['media_cached'],2)
            self.assertFalse((out/'media/.pending-interrupted').exists())
            # The private engine must not accept different rows from the actual catalog snapshot.
            altered=json.loads(json.dumps(c)); altered['rows'][0]['heading']=42
            with self.assertRaisesRegex(ValueError,'catalog snapshot'):
                m._build(build,registry,root/'other',altered,workers=1,chunk_rows=2,method=0,work=None,synthetic=True)

    def test_private_engine_rechecks_catalog_before_work(self):
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root)
            wrong=json.loads(json.dumps(c)); wrong['rows'][0]['heading']=22
            with self.assertRaisesRegex(ValueError,'catalog snapshot'):
                m._build_locked(build,registry,root/'out',wrong,workers=1,chunk_rows=2,method=0,work=root/'work',synthetic=True)

    def test_report_counts_actual_deduplicated_assets_not_source_groups(self):
        from PIL.PngImagePlugin import PngInfo
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root)
            meta=PngInfo(); meta.add_text('synthetic','different PNG metadata, identical pixels')
            other=root/'dataset/rgb/other.png'
            Image.new('RGB',(8,8),(1,70,210)).save(other,pnginfo=meta)
            c['rows'][0].update(image='/dataset/synthetic/rgb/other.png',image_sha256=sha(other.read_bytes()))
            (build/'catalog.json').write_text(json.dumps(c))
            report=m.build_fixture(build,registry,root/'out',workers=2,method=3)
            self.assertEqual(report['media_unique'],2)
            self.assertEqual(report['media_source_groups'],3)

    def test_unreferenced_directories_cannot_bypass_exact_tar_accounting(self):
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root); out=root/'out'
            m.build_fixture(build,registry,out)
            (out/'unexpected-empty-directory').mkdir()
            with self.assertRaisesRegex(ValueError,'directory inventory'):
                m.build_fixture(build,registry,out)
            self.assertFalse((out/'deployment.json').exists())

class CLITests(unittest.TestCase):
    def test_webp_effort_matches_measured_quality_and_pins_codec(self):
        from unittest.mock import patch
        from PIL import features
        m = load()
        with tempfile.TemporaryDirectory(prefix='synthetic-webp-effort-') as tmp:
            root = Path(tmp)
            source = root/'source.png'
            Image.new('RGB', (8, 8), (70, 120, 190)).save(source)
            job = dict(kind='image', source_sha256=sha(source.read_bytes()), paths=[str(source)],
                       size=8, method=3, out=str(root/'out'), work=str(root/'work'))
            calls = []
            original = Image.Image.save
            def observed(image, fp, format=None, **params):
                if format == 'WEBP': calls.append(params.copy())
                return original(image, fp, format=format, **params)
            with patch.object(Image.Image, 'save', observed):
                m.pack_media(job)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].get('quality'), 100)
            receipt = json.loads(next((root/'work').glob('*.json')).read_bytes())
            self.assertEqual(receipt['identity']['quality'], 100)
            self.assertEqual(receipt['identity']['webp'], features.version('webp'))

    def test_production_defaults_use_method_three(self):
        import inspect
        m=load()
        self.assertEqual(inspect.signature(m.build_production).parameters['method'].default,3)
        self.assertEqual(inspect.signature(m.plan_production).parameters['method'].default,3)
        result=subprocess.run([sys.executable,str(SCRIPT),'--help'],text=True,capture_output=True)
        self.assertIn('Lossless WebP effort (default 3)',result.stdout)

    def test_help_and_cli_cannot_publish_fixtures_or_override_production_pins(self):
        help_result=subprocess.run([sys.executable,str(SCRIPT),'--help'],text=True,capture_output=True)
        self.assertEqual(help_result.returncode,0)
        self.assertIn('--plan',help_result.stdout)
        self.assertIn('--execute',help_result.stdout)
        self.assertIn('94200',help_result.stdout)
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root)
            for mode in ('--plan','--execute'):
                result=subprocess.run([sys.executable,str(SCRIPT),'--build',str(build),'--registry',str(registry),
                                       '--out',str(root/'out'),mode],capture_output=True,text=True)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('pinned production catalog SHA256',result.stderr)
                self.assertFalse((root/'out').exists())
            c['count']=94200; (build/'catalog.json').write_text(json.dumps(c))
            with self.assertRaisesRegex(ValueError,'synthetic.*64'): load().build_fixture(build,registry,root/'out')

class MediaTests(unittest.TestCase):
    def test_lossless_media_native_masks_and_verified_resume(self):
        m = load()
        self.assertTrue(hasattr(m, 'pack_media'), 'media packager is missing')
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root = Path(tmp)
            for kind, mode in [('image', 'RGB'), ('mask', 'L')]:
                source = root/(kind+'.png')
                Image.new(mode, (8, 8), (4, 80, 200) if mode == 'RGB' else 127).save(source)
                job = dict(kind=kind, paths=[str(source)], source_sha256=sha(source.read_bytes()),
                           size=8, method=0, out=str(root/'out'), work=str(root/'work'))
                first = m.pack_media(job)
                target = root/'out'/first['path']
                original = target.read_bytes()
                self.assertEqual(first['sha256'], sha(original))
                with Image.open(target) as decoded, Image.open(source) as native:
                    self.assertEqual(decoded.mode, native.mode)
                    self.assertEqual(decoded.tobytes(), native.tobytes())
                if kind == 'mask': self.assertEqual(original, source.read_bytes())
                self.assertFalse(first['cached'])
                self.assertTrue(m.pack_media(job)['cached'])
                target.write_bytes(b'corrupt encoded output')
                fixed = m.pack_media(job)
                self.assertFalse(fixed['cached'])
                self.assertEqual(target.read_bytes(), original)
                for receipt in (root/'work').glob('*.json'): receipt.write_text('null')
                self.assertFalse(m.pack_media(job)['cached'])
                source.write_bytes(b'corrupt source')
                with self.assertRaisesRegex(ValueError, 'source.*SHA256'):
                    m.pack_media(job)

class IntegrityCoverageTests(unittest.TestCase):
    def test_native_format_dimensions_and_method_bound_cache(self):
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); source=root/'source.png'
            for mode,size,format in [('L',(8,8),'PNG'),('RGB',(9,8),'PNG'),('RGB',(8,8),'JPEG')]:
                Image.new(mode,size).save(source,format=format)
                job=dict(kind='image',paths=[str(source)],source_sha256=sha(source.read_bytes()),
                         size=8,method=3,out=str(root/'out'),work=str(root/'work'))
                with self.assertRaisesRegex(ValueError,'native format'): m.pack_media(job)
            pixels=bytes(range(192)); Image.frombytes('RGB',(8,8),pixels).save(source)
            job['source_sha256']=sha(source.read_bytes())
            result=m.pack_media(job)
            self.assertFalse(result['cached']); self.assertTrue(m.pack_media(job)['cached'])
            with Image.open(root/'out'/result['path']) as decoded: self.assertEqual(decoded.tobytes(),pixels)
            job['method']=0
            self.assertFalse(m.pack_media(job)['cached'])
            self.assertTrue(m.pack_media(job)['cached'])

    def test_exclusive_writer_and_hardlink_lock_rejected(self):
        import fcntl
        m=load()
        with tempfile.TemporaryDirectory(prefix='synthetic-packager-') as tmp:
            root=Path(tmp); build,registry,c=fixture(root)
            lock=root/'out.lock'
            with lock.open('wb') as stream:
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaisesRegex(ValueError,'active writer'): m.build_fixture(build,registry,root/'out')
            lock.unlink(); os.link(registry,lock)
            with self.assertRaisesRegex(ValueError,'hardlink'): m.build_fixture(build,registry,root/'out')
            self.assertFalse((root/'out').exists())

if __name__ == '__main__':
    unittest.main()
