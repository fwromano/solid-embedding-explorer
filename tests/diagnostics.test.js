import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Dynamic import makes the first RED an explicit missing-feature assertion.
const module = await import('../site/diagnostics.js').catch(() => ({}));
const { ExactDiagnostics, maskIoU } = module;
const POLICY = 'One actual row per shape/paint (catalog color), nearest heading 0 and elevation 0; ' +
  'minimize circular physical heading distance (360 degrees) squared + elevation squared; ' +
  'ties by ascending original row ID; exact 0/0 preferred when available.';
const row = (id, extra = {}) => ({ id, shape: 'cube', color: 'red', heading: 0, elevation: 0, ...extra });
const vectors = (items, dimensions = 128) => {
  const values = new Float32Array(items.length * dimensions);
  items.forEach((item, i) => values.set(item, i * dimensions));
  return values;
};

test('neighbors ranks the complete float32 prefix, excludes self, and breaks exact ties by ID', () => {
  assert.equal(typeof ExactDiagnostics, 'function', 'ExactDiagnostics is implemented');
  const engine = new ExactDiagnostics([row(99), row(8), row(3), row(40), row(2)],
    vectors([[1, 0], [1, 1], [1, -1], [-1, 0], [1, 0]]), 128);
  const result = engine.neighbors(99);
  assert.deepEqual(Object.keys(result).sort(), ['dimensions', 'neighbors', 'query_id']);
  assert.equal(result.query_id, 99);
  assert.equal(result.dimensions, 128);
  assert.deepEqual(result.neighbors.map(n => n.id), [2, 3, 8, 40]);
  assert.deepEqual(result.neighbors.map(n => n.cosine), [1, 1 / Math.sqrt(2), 1 / Math.sqrt(2), -1]);
  assert.deepEqual(engine.neighbors(99, 2).neighbors, result.neighbors.slice(0, 2));
});

test('reference chooses physical zero pose per shape/paint with ascending original ID ties', () => {
  const rows = [row(90, { heading: 180 }), row(20, { heading: 359 }), row(10, { heading: -1 }),
    row(40, { heading: 0, elevation: 2 }), row(1, { color: 'blue' }),
    row(2, { shape: 'cone' }), row(30, { heading: 360, elevation: 0 })];
  const engine = new ExactDiagnostics(rows, vectors(rows.map(() => [1, 0])), 128);
  assert.equal(typeof engine.reference, 'function', 'reference is implemented');
  assert.deepEqual(engine.reference(90), { query_id: 90, dimensions: 128, policy: POLICY, reference_id: 30, cosine: 1 });
  const tied = new ExactDiagnostics(rows.slice(0, -1), vectors(rows.slice(0, -1).map(() => [1, 0])), 128);
  assert.equal(tied.reference(90).reference_id, 10);
  assert.equal(engine.reference(1).reference_id, 1);
  assert.equal(engine.reference(2).reference_id, 2);
});

test('gallery retains self, corrects exact normalized duplicates to one, but never merges near ties', () => {
  const rows = [row(50), row(9, { shape: 'sphere' }), row(2, { shape: 'cone' }),
    row(1, { shape: 'star' }), row(3, { shape: 'torus' }), row(0, { heading: 90 })];
  const engine = new ExactDiagnostics(rows,
    vectors([[1, 1], [1, 1], [2, 2], [1, 1 + 2 ** -22], [-1, -1], [1, 1]]), 128);
  assert.equal(typeof engine.gallery, 'function', 'gallery is implemented');
  const actual = engine.gallery(50);
  assert.deepEqual(Object.keys(actual).sort(), ['dimensions', 'neighbors', 'policy', 'query_id']);
  assert.equal(actual.query_id, 50);
  assert.equal(actual.dimensions, 128);
  assert.equal(actual.policy, POLICY);
  assert.deepEqual(actual.neighbors.map(n => n.id), [2, 9, 50, 1, 3]);
  assert.deepEqual(actual.neighbors.slice(0, 3).map(n => n.cosine), [1, 1, 1]);
  assert.ok(actual.neighbors[3].cosine < 1 && actual.neighbors[3].cosine > 0.999999999999);
  assert.equal(engine.reference(50).cosine, 1);
  assert.deepEqual(engine.gallery(50, 2).neighbors, actual.neighbors.slice(0, 2));
});

test('maskIoU uses native uint8 threshold >=128 and min/max soft overlap', () => {
  assert.equal(typeof maskIoU, 'function', 'maskIoU is implemented');
  const a = new Uint8Array([0, 127, 128, 255]);
  const b = new Uint8Array([255, 128, 127, 255]);
  const expected = { id: 8, other: 2, binary_iou: 1 / 4, soft_iou: 509 / 766,
    note: 'Native uint8 masks; binary threshold >=128; soft min/max; no alignment or registration.' };
  assert.deepEqual(maskIoU(a, b, 8, 2), expected);
  assert.deepEqual(maskIoU(b, a, 8, 2), expected);
  assert.equal(maskIoU(a, a, 8, 8).binary_iou, 1);
  assert.equal(maskIoU(a, a, 8, 8).soft_iou, 1);
  assert.equal(maskIoU(new Uint8Array(4), new Uint8Array(4), 0, 1).binary_iou, 1);
  assert.equal(maskIoU(new Uint8Array(4), new Uint8Array(4), 0, 1).soft_iou, 1);
  assert.throws(() => maskIoU(a, new Uint8Array(2), 0, 1), /identical native dimensions/);
  assert.throws(() => maskIoU(new Float32Array(4), b, 0, 1), /uint8/);
});

test('invalid vectors and query parameters fail explicitly; neighbor k alone is capped at 20', () => {
  assert.throws(() => new ExactDiagnostics([row(1)], new Float64Array(128), 128), /float32/);
  assert.throws(() => new ExactDiagnostics([row(1)], new Float32Array(127), 128), /shape/);
  assert.throws(() => new ExactDiagnostics([row(1)], vectors([[1]]), 64), /Dimensions/);
  assert.throws(() => new ExactDiagnostics([row(1)], vectors([[NaN]]), 128), /Nonfinite/);
  assert.throws(() => new ExactDiagnostics([row(1)], vectors([[Infinity]]), 128), /Nonfinite/);
  assert.throws(() => new ExactDiagnostics([row(1)], vectors([[0]]), 128), /norms/);
  assert.throws(() => new ExactDiagnostics([row(1), row(1)], vectors([[1], [1]]), 128), /row IDs/);
  const rows = Array.from({ length: 25 }, (_, i) => row(i, { shape: `shape${i}` }));
  const engine = new ExactDiagnostics(rows, vectors(rows.map(() => [1])), 128);
  for (const method of ['neighbors', 'reference', 'gallery']) {
    assert.throws(() => engine[method](1234), /Unknown row id/);
    for (const id of [-1, 0.5, NaN, '0', null]) assert.throws(() => engine[method](id), /Invalid id/);
  }
  for (const method of ['neighbors', 'gallery']) {
    for (const k of [0, -1, 1.5, Infinity, '2', 1e9]) assert.throws(() => engine[method](0, k), /Invalid k/);
  }
  assert.equal(engine.neighbors(0, 25).neighbors.length, 20);
  assert.equal(engine.gallery(0, 25).neighbors.length, 25);
  assert.equal(engine.neighbors(0).neighbors.length, 8);
});

test('reference rejects invalid finite/physical metadata rather than selecting arbitrary rows', () => {
  const invalid = [{ heading: NaN }, { heading: Infinity }, { heading: '0' }, { heading: true },
    { elevation: -Infinity }, { elevation: 90.01 }, { elevation: -90.01 }, { elevation: null },
    { shape: '' }, { color: 1 }];
  for (const metadata of invalid) {
    assert.throws(() => new ExactDiagnostics([row(1), row(2, metadata)], vectors([[1], [1]]), 128).reference(1),
      /Invalid reference metadata/, JSON.stringify(metadata));
  }
  for (const elevation of [-90, 90]) {
    assert.equal(new ExactDiagnostics([row(1, { elevation, heading: -720 })], vectors([[1]]), 128).reference(1).reference_id, 1);
  }
});

// Run one prefix per Node process, so completed prefixes cannot remain resident:
// for d in 128 256 512 768; do DIAGNOSTICS_PREFIX=$d node --test tests/diagnostics.test.js; done
// Optional DIAGNOSTICS_SOURCE and DIAGNOSTICS_PYTHON override the local source/interpreter.
test('full 94200-row prefix matches independent NumPy rankings across all ten shapes',
  { skip: !process.env.DIAGNOSTICS_PREFIX }, () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const source = process.env.DIAGNOSTICS_SOURCE || resolve(root, '../shape-expansion/viewer/data/build-81cec6a56ad50b85d5afc982');
    const python = process.env.DIAGNOSTICS_PYTHON || resolve(root, '../platonic-solids/.venv/bin/python');
    const dimensions = Number(process.env.DIAGNOSTICS_PREFIX);
    assert.ok([128, 256, 512, 768].includes(dimensions));
    const start = performance.now();
    const child = spawnSync(python, [resolve(root, 'evidence/diagnostics-oracle.py'), source, String(dimensions)],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OPENBLAS_NUM_THREADS: '1' } });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const oracle = JSON.parse(child.stdout);
    writeFileSync(resolve(root, `evidence/diagnostics-oracle-${dimensions}.json`), JSON.stringify(oracle, null, 2));
    const catalogBytes = readFileSync(resolve(source, 'catalog.json'));
    const catalog = JSON.parse(catalogBytes);
    const bytes = readFileSync(resolve(source, catalog.vector_files[String(dimensions)]));
    assert.equal(bytes.subarray(0, 6).toString('latin1'), '\x93NUMPY');
    const headerLength = bytes[6] === 1 ? bytes.readUInt16LE(8) : bytes.readUInt32LE(8);
    const offset = (bytes[6] === 1 ? 10 : 12) + headerLength;
    const header = bytes.subarray(bytes[6] === 1 ? 10 : 12, offset).toString();
    assert.match(header, /'descr': '<f4'/);
    assert.match(header, /'fortran_order': False/);
    assert.equal(bytes.length - offset, catalog.rows.length * dimensions * 4);
    const values = new Float32Array(bytes.buffer, bytes.byteOffset + offset, catalog.rows.length * dimensions);
    const sha = input => createHash('sha256').update(input).digest('hex');
    assert.equal(sha(bytes), oracle.source_hashes[catalog.vector_files[String(dimensions)]]);
    assert.equal(sha(catalogBytes), oracle.source_hashes['catalog.json']);
    assert.equal(catalog.rows.length, 94200);
    const initializedAt = performance.now();
    const engine = new ExactDiagnostics(catalog.rows, values, dimensions);
    const initializedMs = performance.now() - initializedAt;
    const report = { dimensions, row_count: catalog.rows.length, shapes: oracle.shapes, source_hashes: oracle.source_hashes,
      implementation_sha256: sha(readFileSync(resolve(root, 'site/diagnostics.js'))),
      contract_sha256: sha(readFileSync(resolve(root, '../shape-expansion/expanded_server.py'))),
      test_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      oracle_sha256: sha(readFileSync(resolve(root, 'evidence/diagnostics-oracle.py'))),
      oracle_seconds: oracle.oracle_seconds, initialized_ms: initializedMs,
      duplicate_pairs: oracle.duplicate_pairs, max_absolute_error: 0, mismatches: [], results: [] };
    const compare = (actual, expected, queryId, method) => {
      if (JSON.stringify(actual.map(n => n.id)) !== JSON.stringify(expected.map(n => n.id))) {
        report.mismatches.push({ query_id: queryId, method, actual_ids: actual.map(n => n.id), expected_ids: expected.map(n => n.id) });
      }
      for (const neighbor of actual) {
        const match = expected.find(n => n.id === neighbor.id);
        if (match) report.max_absolute_error = Math.max(report.max_absolute_error, Math.abs(match.cosine - neighbor.cosine));
      }
    };
    for (const expected of oracle.results) {
      const before = performance.now();
      const actual = { id: expected.id, shape: expected.shape, reason: expected.reason };
      if (expected.neighbors) {
        actual.neighbors = engine.neighbors(expected.id, 20).neighbors;
        compare(actual.neighbors, expected.neighbors, expected.id, 'neighbors');
      }
      actual.gallery = engine.gallery(expected.id, 20).neighbors;
      compare(actual.gallery, expected.gallery, expected.id, 'gallery');
      const reference = engine.reference(expected.id);
      actual.reference = { reference_id: reference.reference_id, cosine: reference.cosine };
      compare([{ id: reference.reference_id, cosine: reference.cosine }],
        [{ id: expected.reference.reference_id, cosine: expected.reference.cosine }], expected.id, 'reference');
      assert.equal(reference.policy, POLICY);
      assert.equal(reference.query_id, expected.id);
      assert.equal(reference.dimensions, dimensions);
      actual.elapsed_ms = performance.now() - before;
      report.results.push(actual);
    }
    report.total_ms = performance.now() - start;
    report.ranked_query_count = report.results.filter(result => result.neighbors).length;
    report.reference_gallery_query_count = report.results.length;
    report.rankings_identical = report.mismatches.length === 0;
    writeFileSync(resolve(root, `evidence/diagnostics-real-${dimensions}.json`), JSON.stringify(report, null, 2));
    assert.deepEqual(new Set(report.results.filter(r => r.reason === 'shape-coverage').map(r => r.shape)), new Set(oracle.shapes));
    assert.ok(report.duplicate_pairs.length > 0);
    assert.ok(report.max_absolute_error < 1e-12, `Maximum cosine error ${report.max_absolute_error}`);
    assert.deepEqual(report.mismatches, [], 'Every ranked ID must match, without epsilon-based tie merging');
    console.log(JSON.stringify({ dimensions, ranked_queries: report.ranked_query_count,
      reference_gallery_queries: report.reference_gallery_query_count, max_absolute_error: report.max_absolute_error,
      initialized_ms: initializedMs, total_ms: report.total_ms }));
  });

