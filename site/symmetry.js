// Display aliases reference measured rows; vectors, images and fitted axes stay shared.
export const sourceRow = row => row.symmetry_source ?? row;
export const sourceId = row => sourceRow(row).id;

export function expandSymmetryCatalog(catalog) {
  const shapes = new Map(catalog.shapes.map(shape => [shape.id, shape]));
  const rings = new Map(), counts = new Map();
  const ordered = [...catalog.rows].sort((a,b) => a.id-b.id);
  let nextId = 0;
  for (const row of ordered) {
    nextId = Math.max(nextId, row.id + 1);
    const key = `${row.shape}/${row.color}/${row.elevation}`;
    if (!rings.has(key)) rings.set(key, new Map());
    rings.get(key).set(row.heading, row);
  }
  const rows = [...catalog.rows];
  // Sorting keeps alias IDs stable even if the source catalog order changes.
  for (const row of ordered) {
    const shape = shapes.get(row.shape);
    const policy = shape.heading_symmetry ?? {kind:'discrete', period_deg:shape.period};
    const step = policy.kind === 'continuous' ? 1 : policy.period_deg;
    if (!['continuous','discrete'].includes(policy.kind) || !Number.isFinite(step) || step <= 0 || !Number.isInteger(360 / step)) {
      throw Error(`Unsupported heading symmetry for ${shape.id}`);
    }
    const ring = rings.get(`${row.shape}/${row.color}/${row.elevation}`);
    // Continuous aliases use the heading-0 representative, retaining all measured views.
    if (policy.kind === 'continuous' && row !== (ring.get(0) ?? [...ring.values()].find(r => !r.symmetry_source))) continue;
    for (let turn = 0; turn < 360 / step; turn++) {
      const heading = policy.kind === 'continuous' ? turn : ((row.heading + turn * step) % 360 + 360) % 360;
      if (ring.has(heading)) continue;
      if (nextId > 2147483647) throw Error('Symmetry view IDs exceed the plot ID range');
      const alias = {id:nextId++, shape:row.shape, color:row.color, heading, elevation:row.elevation, symmetry_source:row};
      rows.push(alias);ring.set(heading, alias);
    }
  }
  for (const row of rows) {
    const key = `${row.shape}/${row.color}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {...catalog, rows, count:rows.length, source_count:catalog.count, symmetry_expanded:true,
    series:catalog.series.map(series => {
      const shape = shapes.get(series.shape), policy = shape.heading_symmetry ?? {kind:'discrete',period_deg:shape.period};
      const factor = policy.kind === 'continuous' ? 360 : 360 / policy.period_deg;
      return {...series, source_count:series.count, count:counts.get(series.id) ?? 0, expected:series.expected * factor};
    })};
}

// Use a stable picking ID for each shared source position. Color is blended
// separately from every visible copy; selection belongs to the overlay.
export function plotRepresentatives(rows) {
  const representatives = new Map();
  for (const row of rows) {
    const key = sourceId(row), previous = representatives.get(key);
    if (!previous || row.heading < previous.heading || (row.heading === previous.heading && row.id < previous.id)) representatives.set(key,row);
  }
  return [...representatives.values()];
}

// source_index addresses every unchanged vector prefix and projection file.
export function symmetryCSV(catalog, sourceCatalog) {
  const indices = new Map(sourceCatalog.rows.map((row,index) => [row.id,index]));
  const chunks = ['view_id,source_row_id,source_index,shape,paint,heading,elevation,is_symmetry_alias\n'];
  let lines = [];
  for (const row of catalog.rows) {
    lines.push([row.id,sourceId(row),indices.get(sourceId(row)),row.shape,row.color,row.heading,row.elevation,Number(Boolean(row.symmetry_source))].join(',')+'\n');
    if (lines.length === 4096) {chunks.push(lines.join(''));lines = [];}
  }
  if (lines.length) chunks.push(lines.join(''));
  return chunks;
}
