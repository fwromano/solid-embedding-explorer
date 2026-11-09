import {sourceId} from './symmetry.js';

// Counts are computed from actual rows, separately from expected dataset counts.
export function coverageSummary(source, expanded) {
  const pairs = new Map(source.series.map(pair => [pair.id, {
    id:pair.id, shape:pair.shape, paint:pair.color, measured:0,
    expectedMeasured:pair.expected, views:0,
    expectedViews:expanded.series.find(other => other.id===pair.id)?.expected ?? 0,
  }]));
  for (const row of source.rows) {
    const pair=pairs.get(`${row.shape}/${row.color}`);
    if (!pair) throw Error('Measured row has no shape/paint coverage entry');
    pair.measured++;
  }
  for (const row of expanded.rows) {
    const pair=pairs.get(`${row.shape}/${row.color}`);
    if (!pair) throw Error('View has no shape/paint coverage entry');
    pair.views++;
  }
  const sum=(rows,key)=>rows.reduce((n,row)=>n+row[key],0);
  const shapes=source.shapes.map(shape=>{
    const rows=[...pairs.values()].filter(pair=>pair.shape===shape.id);
    return {id:shape.id,label:shape.label??shape.id,pairs:rows,
      measured:sum(rows,'measured'),expectedMeasured:sum(rows,'expectedMeasured'),
      views:sum(rows,'views'),expectedViews:sum(rows,'expectedViews'),
      completePairs:rows.filter(pair=>pair.measured===pair.expectedMeasured&&pair.views===pair.expectedViews).length};
  });
  return {shapes,pairs,measured:source.rows.length,views:expanded.rows.length,
    aliases:expanded.rows.length-source.rows.length,
    expectedMeasured:sum([...pairs.values()],'expectedMeasured'),expectedViews:sum([...pairs.values()],'expectedViews'),
    completePairs:shapes.reduce((n,shape)=>n+shape.completePairs,0),
    expectedPairs:source.shapes.length*source.colors.length,
    elevations:[...new Set(source.rows.map(row=>row.elevation))].sort((a,b)=>a-b)};
}

export function visibleCoverage(rows) {
  const sources=new Set(),byShape=new Map(),byPair=new Map();
  for(const row of rows){
    sources.add(sourceId(row));
    byShape.set(row.shape,(byShape.get(row.shape)??0)+1);
    const pair=`${row.shape}/${row.color}`;byPair.set(pair,(byPair.get(pair)??0)+1);
  }
  return {views:rows.length,sources:sources.size,byShape,byPair};
}

export function plotCoverage(points,frame,radius) {
  let inFrame=0;
  for(const p of points)if(p.x+radius>=0&&p.x-radius<frame.width&&p.y+radius>=0&&p.y-radius<frame.height)inFrame++;
  const painted=new Set();
  for(const id of frame.ids)if(id>=0)painted.add(id);
  return {points:points.length,inFrame,offscreen:points.length-inFrame,painted:painted.size,occluded:inFrame-painted.size};
}
