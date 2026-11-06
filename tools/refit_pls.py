#!/usr/bin/env python3
"""Refit exploratory PLS on verified ten-shape vectors; no rendering/inference.

Every shape/paint cell has equal total weight. Unobservable pose coordinates
have zero *centered contrast*, not an invented angle. These display fits have
no held-out performance claim. Original PCA and semantic bases are preserved.
"""
import argparse
from collections import Counter
import copy
import gzip
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np

SOURCE_BUILD = 'build-81cec6a56ad50b85d5afc982'
SOURCE_SHA = '56dd1c2695c1724686d09d1b0312d64b3cd4719e39aa0794a4061f4a0fe85a34'
KINDS = ('pls', 'pls-attributes', 'pls-pose')
POLICY = 'ten-shape-balanced-exploratory-pls-v1'


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def targets_and_weights(rows, shapes, paints):
    shape_ids = [s['id'] for s in shapes]
    counts = Counter((r['shape'], r['color']) for r in rows)
    expected = {(s, c) for s in shape_ids for c in paints}
    if set(counts) != expected or len({r['id'] for r in rows}) != len(rows):
        raise ValueError('Missing/unknown shape-paint cells or duplicate IDs')
    weights = np.array([1 / (len(counts) * counts[r['shape'], r['color']]) for r in rows])
    metadata = {s['id']: s for s in shapes}
    raw_shape = np.array([[r['shape'] == s for s in shape_ids] for r in rows], dtype=float)
    raw_paint = np.array([[r['color'] == c for c in paints] for r in rows], dtype=float)
    pose = np.zeros((len(rows), 4))
    observed = np.zeros_like(pose, dtype=bool)
    for i, row in enumerate(rows):
        shape = metadata[row['shape']]
        symmetry = shape.get('heading_symmetry', {})
        if shape.get('observable_heading', symmetry.get('kind') == 'discrete'):
            period = symmetry.get('period_deg', shape.get('period'))
            if period is None or not np.isfinite(period) or period <= 0:
                raise ValueError('Observable heading needs a positive symmetry period')
            phase = 2 * np.pi * row['heading'] / period
            pose[i, :2] = np.sin(phase), np.cos(phase)
            observed[i, :2] = True
        if shape.get('observable_elevation', True):
            elevation = np.deg2rad(row['elevation'])
            pose[i, 2:] = np.sin(elevation), np.cos(elevation)
            observed[i, 2:] = True
    columns = ('sin(canonical_phase)', 'cos(canonical_phase)', 'sin(elevation)', 'cos(elevation)')
    result, blocks = {}, []
    for name, raw, mask, labels in (
            ('shape', raw_shape, np.ones_like(raw_shape, bool), shape_ids),
            ('paint', raw_paint, np.ones_like(raw_paint, bool), paints),
            ('pose', pose, observed, columns)):
        mass = (weights[:, None] * mask).sum(axis=0)
        if np.any(mass <= 0):
            raise ValueError('Target coordinate has no observed labels')
        center = (weights[:, None] * raw * mask).sum(axis=0) / mass
        contrast = np.where(mask, raw - center, 0)
        ss = float(np.sum(weights[:, None] * contrast ** 2))
        if not np.isfinite(ss) or ss <= 0:
            raise ValueError('Target block has no variance')
        result[name] = contrast / np.sqrt(ss)
        blocks.append(dict(name=name, columns=list(labels), center=center.tolist(),
                           observed_count=mask.sum(axis=0).tolist(), observed_weight=mass.tolist(),
                           centered_weighted_sum_squares=ss, multiplier=1 / np.sqrt(ss),
                           normalized_weighted_sum_squares=float(np.sum(weights[:, None] * result[name] ** 2))))
    cells = [dict(shape=s, paint=c, count=counts[s, c], total_weight=1 / len(counts))
             for s in shape_ids for c in paints]
    return weights, result, blocks, cells


def fit_pls_covariance(cxx, cxy):
    """Weighted PLS2 regression via residual covariance deflation.

    Equivalent to X-score deflation of sqrt(weight)*centered X and Y, with
    no recentering after row weighting and no feature standardization.
    """
    xx, xy = np.array(cxx, float, copy=True), np.array(cxy, float, copy=True)
    if (xx.ndim != 2 or xy.ndim != 2 or xx.shape != (len(xx), len(xx))
            or xy.shape[0] != len(xx) or len(xx) < 3 or xy.shape[1] < 1
            or not np.isfinite(xx).all() or not np.isfinite(xy).all()):
        raise ValueError('Invalid covariance matrices')
    scale = np.linalg.norm(xy)
    weights, loadings, y_loadings = [], [], []
    for component in range(3):
        u, singular, _ = np.linalg.svd(xy, full_matrices=False)
        if singular[0] <= np.finfo(float).eps * max(xy.shape) * scale:
            raise ValueError('PLS covariance exhausted before three components')
        w = u[:, 0]
        if w[np.argmax(np.abs(w))] < 0:
            w = -w
        variance = float(w @ xx @ w)
        if variance <= np.finfo(float).eps * np.linalg.norm(cxx):
            raise ValueError('PLS score variance exhausted')
        p, q = xx @ w / variance, xy.T @ w / variance
        weights.append(w); loadings.append(p); y_loadings.append(q)
        xx -= variance * np.outer(p, p)
        xy -= variance * np.outer(p, q)
    w, p, q = (np.column_stack(v) for v in (weights, loadings, y_loadings))
    rotation = np.linalg.solve((p.T @ w).T, w.T).T
    return dict(rotation=rotation, basis=rotation.T, x_weights=w, x_loadings=p, y_loadings=q)


def refit(source_build, static_data, out):
    source_build, static_data, out = map(lambda p: Path(p).resolve(), (source_build, static_data, out))
    if out.exists() or any(out.is_relative_to(p) or p.is_relative_to(out) for p in (source_build, static_data)):
        raise ValueError('Use a new isolated output directory')
    raw = (source_build / 'catalog.json').read_bytes()
    if digest(raw) != SOURCE_SHA:
        raise ValueError('Source catalog pin mismatch')
    source = json.loads(raw)
    deployment = json.loads((static_data / 'deployment.json').read_bytes())
    if deployment['build_id'] != SOURCE_BUILD or deployment['source_catalog_sha256'] != SOURCE_SHA:
        raise ValueError('Static source pin mismatch')
    old_catalog = deployment['files'][f'/data/{SOURCE_BUILD}/catalog.json']
    packed = (static_data / old_catalog['path']).read_bytes()
    raw_catalog = gzip.decompress(packed)
    if digest(packed) != old_catalog['sha256'] or digest(raw_catalog) != old_catalog['raw_sha256']:
        raise ValueError('Static catalog hash mismatch')
    catalog = json.loads(raw_catalog)
    rows = catalog['rows']
    if len(rows) != 94200 or any(any(row[k] != original[k] for k in original) for row, original in zip(rows, source['rows'], strict=True)):
        raise ValueError('Static/source row binding mismatch')
    weights, targets, blocks, cells = targets_and_weights(rows, catalog['shapes'], [c['id'] for c in catalog['colors']])
    provenance = dict(policy=POLICY, source_build=SOURCE_BUILD, source_catalog_sha256=SOURCE_SHA,
                      fitter_sha256=file_hash(__file__), numpy_version=np.__version__, cells=cells,
                      fit_ids_digest=digest(encoded([r['id'] for r in rows])), count=len(rows),
                      target_blocks=blocks, weights='Each shape/paint cell has total weight 1/60; all real rows used',
                      pose='Unobservable heading/elevation has zero centered pose contrast; never an invented angle',
                      interpretation='Exploratory display fitted to all current rows; no held-out evaluation or accuracy claim')
    new_id = 'build-' + digest(encoded(provenance))[:24]
    shutil.copytree(static_data, out)
    old_dir, new_dir = out / 'data' / SOURCE_BUILD, out / 'data' / new_id
    old_dir.rename(new_dir)
    deployment['build_id'] = new_id
    deployment['files'] = {key.replace(SOURCE_BUILD, new_id):dict(value, path=value['path'].replace(SOURCE_BUILD, new_id))
                           for key, value in deployment['files'].items()}
    catalog['build_id'] = new_id
    catalog['catalog_url'] = f'/data/{new_id}/catalog.json'
    catalog.setdefault('provenance', {})['pls_refit'] = provenance
    catalog['provenance']['fixed_fit_policy'] = 'Original PCA/semantic bases retained; PLS refitted across all ten shapes with equal shape/paint weight'
    catalog['artifacts'] = copy.deepcopy(catalog.get('artifacts', {}))

    def write_asset(name, data, compress=False):
        payload = gzip.compress(data, mtime=0) if compress else data
        path = f'data/{new_id}/{name}' + ('.gz' if compress else '')
        (out / path).write_bytes(payload)
        deployment['files'][f'/data/{new_id}/{name}'] = dict(path=path, encoding='gzip' if compress else 'identity',
            sha256=digest(payload), raw_sha256=digest(data), bytes=len(payload), raw_bytes=len(data))
        return digest(data)

    for dim in (128, 256, 512, 768):
        vector_path = source_build / source['vector_files'][str(dim)]
        if file_hash(vector_path) != source['artifacts'][vector_path.name]:
            raise ValueError('Original prefix artifact hash mismatch')
        native = np.load(vector_path, allow_pickle=False, mmap_mode='r')
        if native.shape != (len(rows), dim) or native.dtype != np.dtype('<f4') or digest(native.tobytes()) != deployment['vectors'][str(dim)]['raw_sha256']:
            raise ValueError('Source/static prefix mismatch')
        x = np.asarray(native, dtype=np.float64)
        if not np.isfinite(x).all() or not np.allclose(np.linalg.norm(x, axis=1), 1, atol=2e-6, rtol=0):
            raise ValueError('Prefix is not finite and normalized')
        center = weights @ x
        x -= center
        xx = x.T @ (weights[:, None] * x)
        for kind in KINDS:
            names = ['shape', 'paint', 'pose'] if kind == 'pls' else ['shape', 'paint'] if kind == 'pls-attributes' else ['pose']
            y = np.concatenate([targets[name] for name in names], axis=1)
            fit = fit_pls_covariance(xx, x.T @ (weights[:, None] * y))
            coords = (x @ fit['rotation']).astype('<f4')
            if not np.isfinite(coords).all():
                raise ValueError('Nonfinite PLS coordinates')
            bounds = np.stack((coords.min(axis=0), coords.max(axis=0)), axis=1).tolist()
            target_label = {'pls':'shape + paint + observable pose', 'pls-attributes':'shape + paint', 'pls-pose':'observable pose contrasts'}[kind]
            note = provenance['interpretation'] + '. Equal total weight per shape/paint cell. ' + provenance['pose'] + '.'
            fit.update(center=center, y_center=np.zeros(y.shape[1]), method='PLS', ratio=None, dimensions=dim,
                       n_components=3, fit_id=kind, fit_count=len(rows), fit_ids=[r['id'] for r in rows],
                       fit_ids_digest=provenance['fit_ids_digest'], fit_cohort='All 94,200 real views / ten shapes / six paints; equal cell weights',
                       target_blocks=[b for b in blocks if b['name'] in names], target_dimensions=y.shape[1],
                       weighting=cells, fit_bounds=bounds, fixed_under_display_filters=True, display_axes=[0,1,2],
                       feature_scaling='none; weighted center only', formula='(normalized_vector - center) @ rotation',
                       algorithm='Weighted PLS2 regression; residual cross-covariance SVD; X-score deflation of both blocks',
                       interpretation=note, source_catalog_sha256=SOURCE_SHA, refit_policy=POLICY)
            fit = {k:v.tolist() if isinstance(v, np.ndarray) else v for k,v in fit.items()}
            basis, coordinates = f'{dim}-{kind}-basis.json', f'{dim}-{kind}.f32'
            catalog['artifacts'][basis] = write_asset(basis, encoded(fit))
            catalog['artifacts'][coordinates] = write_asset(coordinates, coords.tobytes())
            catalog['projections'][f'{dim}/{kind}'] = dict(method='PLS', fit_count=len(rows), ratio=None,
                label=f'PLS — {target_label} — ten shapes, balanced weights', note=note,
                axis_labels=['LV1','LV2','LV3'], url=f'/data/{new_id}/{coordinates}', basis_file=basis,
                bounds=bounds, fit_bounds=bounds, fixed_under_display_filters=True)
            print(f'{dim}D {kind}: {len(rows)} real rows, 60 equally weighted cells', flush=True)
        del x, native
    for projection in catalog['projections'].values():
        projection['url'] = projection['url'].replace(SOURCE_BUILD, new_id)
    catalog_hash = write_asset('catalog.json', encoded(catalog), compress=True)
    current = json.loads((out / 'data/current.json').read_bytes())
    current.update(build_id=new_id, catalog_url=f'/data/{new_id}/catalog.json', catalog_sha256=catalog_hash)
    payload = encoded(current)
    (out / 'data/current.json').write_bytes(payload)
    deployment['files']['/data/current.json'] = dict(path='data/current.json', encoding='identity', sha256=digest(payload), raw_sha256=digest(payload), bytes=len(payload), raw_bytes=len(payload))
    # build.json is part of the original mapped transport as well.
    if f'/data/{new_id}/build.json' in deployment['files']:
        write_asset('build.json', payload)
    (out / 'deployment.json').write_bytes(encoded(deployment))
    print(json.dumps(dict(build_id=new_id, source_catalog_sha256=SOURCE_SHA, catalog_sha256=catalog_hash)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source-build', 'static-data', 'out'):
        parser.add_argument('--'+name, required=True)
    args = parser.parse_args()
    refit(args.source_build, args.static_data, args.out)
