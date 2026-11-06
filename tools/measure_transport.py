#!/usr/bin/env python3
"""Read-only, real-data transport feasibility probe. Not a production exporter.

Run with ../platonic-solids/.venv/bin/python tools/measure_transport.py.
Only evidence/transport-sizing* and a scratch sample directory are written.
"""
from __future__ import annotations
import collections
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import statistics
import tempfile
import time
import zlib
from typing import Any

import numpy as np
import PIL
from PIL import Image, features

ROOT = Path('/home/fromano/MAAS/experiments')
BUILD = ROOT / 'shape-expansion/viewer/data/build-81cec6a56ad50b85d5afc982'
REGISTRY = ROOT / 'shape-expansion/provenance/expanded-production-sources.json'
EXPECTED_SHA = '56dd1c2695c1724686d09d1b0312d64b3cd4719e39aa0794a4061f4a0fe85a34'
OUT = ROOT / 'solids-pages/evidence/transport-sizing.json'
SEED = 'solids-pages-transport-v1'
CHUNK_ROWS = 256


def sha(data):
    return hashlib.sha256(data).hexdigest()


def ceil_bytes(n, block):
    return ((n + block - 1) // block) * block


def shuffle_f32(raw: bytes) -> bytes:
    """LE float32 row-major bytes -> four contiguous byte planes, no arithmetic."""
    if len(raw) % 4:
        raise ValueError('float32 byte length must be divisible by four')
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, 4).T.copy().tobytes()


def unshuffle_f32(planes: bytes) -> bytes:
    if len(planes) % 4:
        raise ValueError('float32 byte length must be divisible by four')
    return np.frombuffer(planes, dtype=np.uint8).reshape(4, -1).T.copy().tobytes()


def encode_f32_chunk(raw: bytes) -> bytes:
    return gzip.compress(shuffle_f32(raw), compresslevel=6, mtime=0)


def decode_f32_chunk(encoded: bytes) -> bytes:
    return unshuffle_f32(gzip.decompress(encoded))


def stable_sample(items, count, key):
    return sorted(items, key=lambda x: sha((SEED + key(x)).encode()))[:count]


def checkpoint(report):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + '\n')


def main():
    start = time.perf_counter()
    catalog_raw = (BUILD / 'catalog.json').read_bytes()
    assert sha(catalog_raw) == EXPECTED_SHA
    cat = json.loads(catalog_raw)
    rows = cat['rows']
    assert cat['count'] == len(rows) == 94200
    assert [r['id'] for r in rows] == list(range(94200))
    registry_raw = REGISTRY.read_bytes()
    registry = json.loads(registry_raw)
    roots = {}
    for name, source in registry.items():
        root = Path(source['root']).resolve(strict=True)
        # Registry config pins bind the accepted catalog's source provenance;
        # they are not the on-disk renderer config.json file hashes.
        for r in rows:
            if r['source_dataset'] == name:
                assert r['id'] == source['id_offset'] + r['source_row_index']
        assert source['expected_count'] == sum(r['source_dataset'] == name for r in rows)
        assert all(cat['dataset_sources'][name][k] == source[k] for k in ('config_sha256', 'expected_count', 'id_offset'))
        roots[name] = root
    scratch = Path(tempfile.mkdtemp(prefix='transport-sizing-', dir=os.environ.get('TMPDIR', '/home/fromano/.hermes/cache/scratch')))
    report: dict[str, Any] = dict(schema='transport-sizing-v1', complete=False, catalog_sha256=EXPECTED_SHA,
                  registry_sha256=sha(registry_raw), tool_sha256=sha(Path(__file__).read_bytes()),
                  build=str(BUILD), count=len(rows), scratch=str(scratch),
                  environment=dict(python=platform.python_version(), pillow=PIL.__version__, numpy=np.__version__,
                                   webp=features.version('webp'), zlib=zlib.ZLIB_RUNTIME_VERSION),
                  assumptions=dict(pages_conservative_limit_bytes=1_000_000_000, gib_bytes=2**30,
                                   gzip_level=6, chunk_rows=CHUNK_ROWS, webp_quality=100,
                                   webp_lossless=True, webp_exact=True, seed=SEED),
                  sources=[{'title':'GitHub Pages limits', 'url':'https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits'},
                           {'title':'Pillow WebP options', 'url':'https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#webp'}])
    unique = {'image': {}, 'mask': {}}
    inventory = {}
    ts = time.perf_counter()
    for kind in ('image', 'mask'):
        total = allocated = 0
        by_group = collections.Counter()
        for row in rows:
            name = row['source_dataset']
            prefix = f'/dataset/{name}/'
            assert row[kind].startswith(prefix)
            path = (roots[name] / row[kind][len(prefix):]).resolve(strict=True)
            assert path.is_relative_to(roots[name])
            data = path.read_bytes()
            digest = sha(data)
            assert digest == row[kind + '_sha256'], str(path)
            size = len(data)
            total += size
            allocated += path.stat().st_blocks * 512
            if digest not in unique[kind]:
                unique[kind][digest] = dict(path=str(path), bytes=size, row=row)
                by_group[(row['shape'], row['color'])] += 1
            else:
                assert unique[kind][digest]['bytes'] == size
        inventory[kind] = dict(references=len(rows), verified_file_hashes=len(rows), referenced_png_bytes=total,
                               source_allocated_bytes=allocated, unique_hashes=len(unique[kind]),
                               unique_png_bytes=sum(x['bytes'] for x in unique[kind].values()),
                               unique_png_tar_payload_padded=sum(ceil_bytes(x['bytes'],512) for x in unique[kind].values()),
                               unique_png_4k_allocated=sum(ceil_bytes(x['bytes'],4096) for x in unique[kind].values()),
                               unique_hashes_by_first_representative_group={'/'.join(k):v for k,v in sorted(by_group.items())})
        print('HASH INVENTORY', kind, inventory[kind]['unique_hashes'], inventory[kind]['unique_png_bytes'], flush=True)
    report['inventory'] = inventory
    report['inventory_seconds'] = time.perf_counter() - ts
    checkpoint(report)

    # Every unique PNG hash belongs to one deterministic representative stratum.
    # 10 shape x 6 paint; five elevation rank bins, two heading rank bins.
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row['shape'], row['color'])].append(row['id'])
    assert len(groups) == 60
    for ids in groups.values():
        assert ids == list(range(ids[0], ids[-1]+1)), 'chunk design requires contiguous group rows'
    elevations = {g: sorted({rows[i]['elevation'] for i in ids}) for g,ids in groups.items()}
    headings = {g: sorted({rows[i]['heading'] for i in ids}) for g,ids in groups.items()}
    cells = collections.defaultdict(list)
    for digest, entry in unique['image'].items():
        r = entry['row']; g = (r['shape'], r['color'])
        eb = elevations[g].index(r['elevation']) * 5 // len(elevations[g])
        hb = headings[g].index(r['heading']) * 2 // len(headings[g])
        cells[g + (eb, hb)].append(digest)
    sample_records = []
    cell_records = []
    ts = time.perf_counter()
    for cell, hashes in sorted(cells.items()):
        selected = stable_sample(hashes, 2, lambda h:h)
        measurements = []
        for digest in selected:
            entry = unique['image'][digest]; row = entry['row']
            with Image.open(entry['path']) as im:
                im.load()
                assert im.mode == 'RGB' and im.size == (512,512)
                raw_rgb = im.tobytes()
                rec: dict[str, Any] = dict(id=row['id'], shape=row['shape'], color=row['color'], heading=row['heading'],
                           elevation=row['elevation'], png_sha256=digest, rgb_sha256=sha(raw_rgb), png_bytes=entry['bytes'], methods={})
                for method in (0,3):
                    dest = io.BytesIO(); t = time.perf_counter()
                    im.save(dest, format='WEBP', lossless=True, exact=True, quality=100, method=method)
                    seconds = time.perf_counter()-t; encoded = dest.getvalue()
                    t = time.perf_counter()
                    with Image.open(io.BytesIO(encoded)) as decoded:
                        decoded.load()
                        assert decoded.size == im.size
                        assert decoded.convert('RGB').tobytes() == raw_rgb
                    decode_seconds = time.perf_counter()-t
                    rec['methods'][str(method)] = dict(bytes=len(encoded), encode_seconds=seconds,
                        decode_verify_seconds=decode_seconds, exact_rgb=True, sha256=sha(encoded))
                    # Retain one actual sample of each method, not a full conversion.
                    if not sample_records:
                        (scratch / f'sample-{row["id"]}-m{method}.webp').write_bytes(encoded)
                measurements.append(rec)
                sample_records.append(rec)
        cell_records.append(dict(cell=list(cell), population=len(hashes), samples=len(selected),
                                 sample_ids=[r['id'] for r in measurements]))
    assert len(sample_records) >= 300
    assert len({r['shape'] for r in sample_records}) == 10
    assert len({r['color'] for r in sample_records}) == 6
    by_id = {r['id']:r for r in sample_records}
    webp_summary = {}
    for method in ('0','3'):
        estim = {k:0.0 for k in ('bytes','tar_padded','allocated_4k','encode_seconds')}
        variance = 0.0
        for cell in cell_records:
            vals = [by_id[i]['methods'][method] for i in cell['sample_ids']]
            n,N = len(vals),cell['population']
            estim['bytes'] += N * statistics.mean(v['bytes'] for v in vals)
            estim['tar_padded'] += N * statistics.mean(ceil_bytes(v['bytes'],512) for v in vals)
            estim['allocated_4k'] += N * statistics.mean(ceil_bytes(v['bytes'],4096) for v in vals)
            estim['encode_seconds'] += N * statistics.mean(v['encode_seconds'] for v in vals)
            if n>1:
                variance += N*N*(1-n/N)*statistics.variance(v['bytes'] for v in vals)/n
        webp_summary[method] = dict(measured_sample_bytes=sum(r['methods'][method]['bytes'] for r in sample_records),
            measured_sample_encode_seconds=sum(r['methods'][method]['encode_seconds'] for r in sample_records),
            measured_sample_decode_verify_seconds=sum(r['methods'][method]['decode_verify_seconds'] for r in sample_records),
            estimated_full_unique=estim, approximate_stratified_standard_error_bytes=math.sqrt(variance))
    report['webp'] = dict(sample_count=len(sample_records), strata_count=len(cells), seconds=time.perf_counter()-ts,
        sampling='two SHA256-seeded representatives without replacement in each shape/paint/elevation-rank-quintile/heading-rank-half stratum; unique PNG hashes are population units',
        note='Full totals extrapolated with each stratum population weight, NOT unweighted sample mean. SE is diagnostic only; deterministic sample is not a guaranteed bound.',
        methods=webp_summary, cells=cell_records, samples=sample_records)
    checkpoint(report)
    print('WEBP', len(sample_records), webp_summary, flush=True)

    # Per-shape/paint contiguous chunks: three sampled full chunks + exact tail.
    vector_summaries = {}
    vector_records = []
    vector_file_count = 0
    ts = time.perf_counter()
    for dim in (128,256,512,768):
        path = BUILD / cat['vector_files'][str(dim)]
        digest = sha(path.read_bytes())
        assert digest == cat['artifacts'][path.name]
        arr = np.load(path, mmap_mode='r', allow_pickle=False)
        assert arr.dtype.str == '<f4' and arr.shape == (94200,dim) and arr.flags.c_contiguous
        summary: dict[str, Any] = dict(source_npy_sha256=digest, source_npy_bytes=path.stat().st_size, raw_float32_bytes=arr.nbytes,
                       measured_raw_bytes=0, measured_gzip_bytes=0, measured_plain_gzip_bytes=0,
                       encode_seconds=0., decode_verify_seconds=0., estimated_gzip_bytes=0.,
                       estimated_tar_padded=0., estimated_allocated_4k=0., chunk_count=0, strata=[])
        for g, ids in sorted(groups.items()):
            chunks = [(lo,min(lo+CHUNK_ROWS,ids[-1]+1)) for lo in range(ids[0],ids[-1]+1,CHUNK_ROWS)]
            summary['chunk_count'] += len(chunks)
            classes = collections.defaultdict(list)
            for lo,hi in chunks:
                classes[hi-lo].append((lo,hi))
            for length, choices in sorted(classes.items()):
                chosen = stable_sample(choices,3,lambda x:f'{g}/{x[0]}')
                vals = []
                for lo,hi in chosen:
                    raw = arr[lo:hi].tobytes(order='C')
                    t = time.perf_counter(); encoded = encode_f32_chunk(raw); encode_s=time.perf_counter()-t
                    t = time.perf_counter(); decoded = decode_f32_chunk(encoded); decode_s=time.perf_counter()-t
                    assert decoded == raw
                    t = time.perf_counter(); plain = gzip.compress(raw,compresslevel=6,mtime=0); plain_s=time.perf_counter()-t
                    rec: dict[str, Any] = dict(dimension=dim, shape=g[0], color=g[1], row_start=lo, row_stop=hi,
                               rows=hi-lo, raw_bytes=len(raw), shuffled_gzip_bytes=len(encoded), plain_gzip_bytes=len(plain),
                               encode_seconds=encode_s, decode_verify_seconds=decode_s, plain_encode_seconds=plain_s,
                               raw_sha256=sha(raw), encoded_sha256=sha(encoded), byte_identical=True)
                    if not any(r['dimension']==dim for r in vector_records):
                        (scratch/f'vectors-{dim}-{lo}-{hi}.f32bp.gz').write_bytes(encoded)
                    vector_records.append(rec); vals.append(len(encoded))
                    summary['measured_raw_bytes'] += len(raw)
                    summary['measured_gzip_bytes'] += len(encoded)
                    summary['measured_plain_gzip_bytes'] += len(plain)
                    summary['encode_seconds'] += encode_s
                    summary['decode_verify_seconds'] += decode_s
                N = len(choices)
                summary['estimated_gzip_bytes'] += N*statistics.mean(vals)
                summary['estimated_tar_padded'] += N*statistics.mean(ceil_bytes(n,512) for n in vals)
                summary['estimated_allocated_4k'] += N*statistics.mean(ceil_bytes(n,4096) for n in vals)
                summary['strata'].append(dict(shape=g[0],color=g[1],rows_per_chunk=length,population_chunks=N,
                    sampled_chunks=len(chosen), sample_byte_min=min(vals),sample_byte_max=max(vals)))
        vector_file_count += summary['chunk_count']
        vector_summaries[str(dim)] = summary
        print('VECTORS',dim,{k:v for k,v in summary.items() if k!='strata'},flush=True)
    report['vectors'] = dict(layout='gzip level 6, mtime=0, no NPY header; four LE byte planes across C-order rows, 256 rows per chunk, chunk boundaries reset per contiguous shape/paint group',
                             all_samples_byte_identical=True, seconds=time.perf_counter()-ts,
                             dimensions=vector_summaries, samples=vector_records)
    checkpoint(report)

    # All existing coords, bases, catalog and build metadata measured, not sampled.
    auxiliary = []
    for path in sorted(BUILD.iterdir()):
        if path.name.startswith('vectors-') or not path.is_file():
            continue
        raw=path.read_bytes()
        if path.name in cat['artifacts']:
            assert sha(raw)==cat['artifacts'][path.name]
        t=time.perf_counter(); encoded=gzip.compress(raw,compresslevel=6,mtime=0); duration=time.perf_counter()-t
        assert gzip.decompress(encoded)==raw
        auxiliary.append(dict(file=path.name,raw_bytes=len(raw),gzip_bytes=len(encoded),seconds=duration,sha256=sha(raw)))
    auxbytes=sum(r['gzip_bytes'] for r in auxiliary)
    auxtar=sum(ceil_bytes(r['gzip_bytes'],512) for r in auxiliary)
    auxalloc=sum(ceil_bytes(r['gzip_bytes'],4096) for r in auxiliary)
    report['auxiliary'] = dict(files=auxiliary,raw_bytes=sum(r['raw_bytes'] for r in auxiliary),gzip_bytes=auxbytes,
                              tar_padded_bytes=auxtar,allocated_4k=auxalloc)
    # A conservative, explicit reserve is NOT a measurement of the future app.
    reserve=10_000_000
    nfiles=inventory['image']['unique_hashes']+inventory['mask']['unique_hashes']+vector_file_count+len(auxiliary)
    ndirs=1+2*(1+256)+1+4+1
    estimates={}
    for method in ('0','3'):
        image=webp_summary[method]['estimated_full_unique']
        payload=image['bytes']+inventory['mask']['unique_png_bytes']+sum(v['estimated_gzip_bytes'] for v in vector_summaries.values())+auxbytes
        tar_padded=image['tar_padded']+inventory['mask']['unique_png_tar_payload_padded']+sum(v['estimated_tar_padded'] for v in vector_summaries.values())+auxtar
        tar_total=ceil_bytes(math.ceil(tar_padded)+512*(nfiles+ndirs)+1024,10240)
        allocated=image['allocated_4k']+inventory['mask']['unique_png_4k_allocated']+sum(v['estimated_allocated_4k'] for v in vector_summaries.values())+auxalloc+4096*ndirs
        estimates[method]=dict(estimated_payload_bytes=payload,estimated_ustar_bytes=tar_total,
            estimated_4k_allocated_bytes=allocated,app_and_transport_index_reserve_bytes=reserve,
            estimated_payload_plus_reserve=payload+reserve,estimated_ustar_plus_reserve=tar_total+reserve,
            estimated_4k_allocated_plus_reserve=allocated+reserve,
            headroom_decimal_1GB_payload=1_000_000_000-payload-reserve,
            headroom_decimal_1GB_ustar=1_000_000_000-tar_total-reserve,
            headroom_decimal_1GB_4k=1_000_000_000-allocated-reserve)
    report['site_estimates']=dict(methods=estimates,data_file_count=nfiles,assumed_directory_count=ndirs,
        assumptions='One file per unique RGB hash and native mask hash, 2-hex fanout; one file per vector chunk; individually gzipped existing coords/bases/catalog/build. Compact transport mapping + frontend reserved 10 MB, not built. USTAR assumes short paths, no PAX records, 512-byte headers/padding plus final 10240-byte record alignment. Disk is a separate 4096-byte allocation scenario, not an additive tar charge; filesystem metadata beyond directory block allowance is unknown. Archive tar is NOT stored inside the deployed site.',
        verdict='SAMPLED FEASIBILITY ONLY: final full export and actual Pages artifact still require byte counts and end-to-end verification.')
    # Optional pack scenario is arithmetic sizing, not an exported architecture.
    # Concatenate <=256 whole image streams per pack, no inter-image padding;
    # a separate compressed index holds source hash, pack ID, offset, length.
    pack_count = math.ceil(inventory['image']['unique_hashes']/256) + math.ceil(inventory['mask']['unique_hashes']/256)
    pack_files = pack_count + vector_file_count + len(auxiliary)
    pack_dirs = 9
    pack_payload = estimates['3']['estimated_payload_bytes']
    report['optional_packed_scenario'] = dict(status='hypothetical layout; NOT built or benchmarked',
        asset_streams_per_pack_max=256, asset_pack_count=pack_count, data_file_count=pack_files,
        method3_estimated_payload_bytes=pack_payload,
        method3_estimated_4k_bytes_upper_with_10MB_reserve=math.ceil(pack_payload)+4095*pack_files+4096*pack_dirs+reserve,
        method3_estimated_ustar_bytes_upper_with_10MB_reserve=math.ceil(pack_payload)+1023*pack_files+512*pack_dirs+1024+10239+reserve,
        note='Bounds apply only to allocation/header overhead around the still-estimated payload. Whole-pack fetch plus Blob slice avoids assuming HTTP range support. Transport index/frontend are reserved, not measured; no per-entry padding or separate per-entry files.')
    report['complete']=True
    report['total_seconds']=time.perf_counter()-start
    checkpoint(report)
    print('SITE',json.dumps(report['site_estimates'],indent=2),flush=True)
    print('REPORT',OUT,'SECONDS',report['total_seconds'],flush=True)


if __name__=='__main__':
    main()
