// Pure numerical core: one caller-owned float32 prefix; no DOM, I/O or projections.
const clip = value => Math.max(-1, Math.min(1, value));
const rank = (a, b) => b.cosine - a.cosine || a.id - b.id;
export const REFERENCE_POLICY = 'One actual row per shape/paint (catalog color), nearest heading 0 and elevation 0; ' +
  'minimize circular physical heading distance (360 degrees) squared + elevation squared; ' +
  'ties by ascending original row ID; exact 0/0 preferred when available.';
const paintKey = row => JSON.stringify([row.shape, row.color]);
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 999999999) throw new Error(`Invalid ${name}`);
  return value;
}

// Flat native grayscale samples; the decoder/caller must also check width and height.
export function maskIoU(first, second, id, other) {
  if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array)) {
    throw new Error('Masks must be native uint8 grayscale');
  }
  if (first.length !== second.length) throw new Error('Masks must have identical native dimensions');
  let intersection = 0, union = 0, softIntersection = 0, softUnion = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i], b = second[i];
    if (a >= 128 && b >= 128) intersection++;
    if (a >= 128 || b >= 128) union++;
    softIntersection += Math.min(a, b);
    softUnion += Math.max(a, b);
  }
  return { id, other, binary_iou: union ? intersection / union : 1,
    soft_iou: softUnion ? softIntersection / softUnion : 1,
    note: 'Native uint8 masks; binary threshold >=128; soft min/max; no alignment or registration.' };
}

export class ExactDiagnostics {
  constructor(rows, values, dimensions) {
    if (![128, 256, 512, 768].includes(dimensions)) throw new Error('Dimensions must be 128, 256, 512 or 768');
    if (!(values instanceof Float32Array)) throw new Error('Vectors must be float32');
    if (!Array.isArray(rows) || values.length !== rows.length * dimensions) throw new Error('Invalid vector shape');
    if (rows.some(row => !row || !Number.isSafeInteger(row.id) || row.id < 0) ||
        new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid row IDs');
    this.rows = rows;
    this.values = values;
    this.dimensions = dimensions;
    this.index = new Map(rows.map((row, i) => [row.id, i]));
    this.norms = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      let sum = 0;
      for (let d = 0; d < dimensions; d++) {
        const value = values[i * dimensions + d];
        if (!Number.isFinite(value)) throw new Error('Nonfinite vectors');
        sum += value * value;
      }
      this.norms[i] = Math.sqrt(sum);
      if (!(this.norms[i] > 0) || !Number.isFinite(this.norms[i])) throw new Error('Invalid vector norms');
    }
  }

  references() {
    if (this.referenceIndices) return this.referenceIndices;
    const chosen = new Map();
    this.rows.forEach((row, i) => {
      if (typeof row.shape !== 'string' || !row.shape || typeof row.color !== 'string' || !row.color ||
          !Number.isFinite(row.heading) || !Number.isFinite(row.elevation) || row.elevation < -90 || row.elevation > 90) {
        throw new Error('Invalid reference metadata');
      }
      // Do not add 360 to an already positive residue: that rounds tiny positive headings.
      let heading = row.heading % 360;
      if (heading < 0) heading += 360;
      const distance = Math.min(heading, 360 - heading) ** 2 + row.elevation ** 2;
      const key = paintKey(row), previous = chosen.get(key);
      if (!previous || distance < previous.distance || (distance === previous.distance && row.id < previous.id)) {
        chosen.set(key, { distance, id: row.id, index: i });
      }
    });
    this.referenceIndices = new Map([...chosen].map(([key, value]) => [key, value.index]));
    return this.referenceIndices;
  }

  queryIndex(id) {
    integer(id, 'id');
    if (!this.index.has(id)) throw new Error('Unknown row id in requested build');
    return this.index.get(id);
  }

  referenceCosine(query, candidate) {
    let dot = 0, identical = true;
    for (let d = 0; d < this.dimensions; d++) {
      const first = this.values[query * this.dimensions + d] / this.norms[query];
      const second = this.values[candidate * this.dimensions + d] / this.norms[candidate];
      identical &&= first === second;
      dot += first * second;
    }
    // Equality is component-exact, not a cosine tolerance (near ties stay distinct).
    return identical ? 1 : clip(dot);
  }

  reference(id) {
    const query = this.queryIndex(id);
    const candidate = this.references().get(paintKey(this.rows[query]));
    return { query_id: id, dimensions: this.dimensions, policy: REFERENCE_POLICY,
      reference_id: this.rows[candidate].id, cosine: this.referenceCosine(query, candidate) };
  }

  gallery(id, k = 8) {
    integer(k, 'k', 1);
    const query = this.queryIndex(id);
    const neighbors = [...this.references().values()].map(candidate => ({
      id: this.rows[candidate].id, cosine: this.referenceCosine(query, candidate),
    })).sort(rank).slice(0, k);
    return { query_id: id, dimensions: this.dimensions, policy: REFERENCE_POLICY, neighbors };
  }

  neighbors(id, k = 8) {
    k = Math.min(integer(k, 'k', 1), 20);
    const query = this.queryIndex(id);
    const unit = new Float64Array(this.dimensions);
    for (let d = 0; d < this.dimensions; d++) {
      unit[d] = this.values[query * this.dimensions + d] / this.norms[query];
    }
    const best = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (i === query) continue;
      let dot = 0;
      for (let d = 0; d < this.dimensions; d++) dot += this.values[i * this.dimensions + d] * unit[d];
      const candidate = { id: this.rows[i].id, cosine: dot / this.norms[i] };
      // Keep only k entries. Rank BEFORE clipping, as the server does.
      let at = best.length;
      while (at > 0 && rank(candidate, best[at - 1]) < 0) at--;
      if (at < k) {
        best.splice(at, 0, candidate);
        if (best.length > k) best.pop();
      }
    }
    return { query_id: id, dimensions: this.dimensions,
      neighbors: best.map(({ id, cosine }) => ({ id, cosine: clip(cosine) })) };
  }
}
