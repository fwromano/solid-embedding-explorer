import test from 'node:test';
import assert from 'node:assert/strict';
import {expandSymmetryCatalog,sourceRow,sourceId,plotRepresentatives,symmetryCSV} from '../symmetry.js';
import {filterRows,nearestSample,parseState,serializeState,describePose,packColor} from '../core.js';
import {preparePointColors} from '../app.js';

function fixture() {
  const shapes = Object.entries({tetrahedron:120,cube:90,octahedron:90,dodecahedron:72,icosahedron:72,star:180,cylinder:null,cone:null,sphere:null,torus:null})
    .map(([id,period]) => ({id,heading_symmetry:period?{kind:'discrete',period_deg:period}:{kind:'continuous'},observable_elevation:id!=='sphere'}));
  const rows = shapes.flatMap((shape,i) => [-5,0,5].map((elevation,j) => ({id:100+i*10+j,shape:shape.id,color:'red',heading:0,elevation,image:`/dataset/${i}-${j}.png`,mask:`/dataset/${i}-${j}-mask.png`})));
  return {rows,count:rows.length,shapes,colors:[{id:'red',hex:'#E53935'}],series:shapes.map(shape => ({id:shape.id+'/red',shape:shape.id,color:'red',count:3,expected:3}))};
}

test('all ten shapes expand by their own axial symmetry without inventing elevations or mutating source rows',()=>{
  const source=fixture(), before=structuredClone(source), catalog=expandSymmetryCatalog(source);
  for(const shape of source.shapes) {
    const rows=catalog.rows.filter(row=>row.shape===shape.id), period=shape.heading_symmetry.period_deg??1;
    assert.equal(rows.length,3*360/period);
    for(const elevation of [-5,0,5])assert.deepEqual(rows.filter(r=>r.elevation===elevation).map(r=>r.heading).sort((a,b)=>a-b),Array.from({length:360/period},(_,i)=>i*period));
    for(const row of rows){assert.equal(sourceRow(row).shape,row.shape);assert.equal(sourceRow(row).color,row.color);assert.equal(sourceRow(row).elevation,row.elevation);}
  }
  assert.equal(new Set(catalog.rows.map(r=>r.id)).size,catalog.count);
  assert.deepEqual(source,before);
  for(const row of source.rows)assert.equal(catalog.rows.find(r=>r.id===row.id),row);
  const reversed=expandSymmetryCatalog({...source,rows:[...source.rows].reverse()});
  assert.deepEqual(reversed.rows.filter(r=>r.symmetry_source),catalog.rows.filter(r=>r.symmetry_source));
});

test('cube 0/90/180/270 remain independently selectable and repeat the exact same source index',()=>{
  const source=fixture(),catalog=expandSymmetryCatalog(source);
  const state={series:['cube/red'],headingMode:'selected',headings:[0,90,180,270],elevationMode:'selected',elevations:[0]};
  const rows=filterRows(catalog,state);
  assert.equal(rows.length,4);assert.equal(new Set(rows.map(sourceId)).size,1);
  for(const heading of state.headings)assert.equal(nearestSample(rows,heading,0,360).heading,heading);
  assert.equal(nearestSample(rows,360,0,360).heading,0);
  assert.equal(filterRows(catalog,{...state,headingMode:'current',heading:180})[0].heading,180);
  assert.deepEqual(filterRows(catalog,{...state,headings:[]}),[]);
  const alias=rows.find(r=>r.heading===270), parsed=parseState(`?id=${alias.id}&heading=270&elevation=0`,catalog);
  assert.equal(parsed.selectedId,alias.id);assert.deepEqual(parseState(serializeState(parsed),catalog),parsed);
  const info=describePose(catalog.shapes.find(s=>s.id==='cube'),270,0,alias);
  assert.equal(info.badge,'Repeated by symmetry');assert.match(info.requested,/Recorded 0° \/ 0°/);
  const csv=symmetryCSV(catalog,source).join('').trim().split('\n').slice(1).map(line=>line.split(','));
  for(const row of rows){const line=csv.find(line=>Number(line[0])===row.id);assert.equal(Number(line[1]),sourceId(row));assert.equal(source.rows[Number(line[2])],sourceRow(row));assert.equal(Number(line[5]),row.heading);}
  const colors=preparePointColors(catalog,{...parsed,colorBy:'viewpoint'});
  for(const row of rows)assert.equal(colors.packed.get(row.id),packColor(...colors.rgbAt(row.heading,row.elevation)));
});

test('existing measurements win over aliases and partial grids gain only symmetry-equivalent views',()=>{
  const source=fixture();source.rows=[{...source.rows[3],id:1,heading:0},{...source.rows[3],id:2,heading:180},{...source.rows[3],id:3,heading:1}];source.count=3;
  const catalog=expandSymmetryCatalog(source);
  assert.equal(catalog.count,8);
  assert.deepEqual(catalog.rows.map(r=>r.heading).sort((a,b)=>a-b),[0,1,90,91,180,181,270,271]);
  assert.equal(catalog.rows.find(r=>r.heading===180),source.rows[1]);
  for(const row of catalog.rows)assert.ok(source.rows.includes(sourceRow(row)));
});

test('plot representatives stay fixed during playback and selection, and follow explicit filters',()=>{
  const catalog=expandSymmetryCatalog(fixture()),rows=catalog.rows.filter(r=>r.shape==='cube'&&r.elevation===0);
  const selected=rows.find(r=>r.heading===270);
  for(const heading of [0,90,180,270,359])assert.equal(plotRepresentatives(rows,heading,selected.id)[0].heading,0);
  assert.equal(plotRepresentatives(rows.filter(row=>row.heading>=180))[0].heading,180);
  assert.equal(plotRepresentatives([selected])[0],selected);
});

test('continuous symmetry preserves each recorded elevation and labels reused finite-mesh samples',()=>{
  const catalog=expandSymmetryCatalog(fixture());
  const rows=filterRows(catalog,{series:['sphere/red'],headingMode:'current',heading:271,elevationMode:'current',elevation:3});
  assert.equal(rows.length,1);assert.equal(rows[0].heading,271);assert.equal(rows[0].elevation,5);
  const info=describePose(catalog.shapes.find(s=>s.id==='sphere'),271,3,rows[0]);
  assert.match(info.requested,/full rotational alias/i);assert.match(info.requested,/finite-mesh/);
  assert.equal(info.badge,'Repeated by symmetry');
});

test('continuous fallback uses a stable measured source when heading zero is missing',()=>{
  const source=fixture(),sphere=source.rows.find(row=>row.shape==='sphere');
  source.rows=[{...sphere,id:8,heading:20},{...sphere,id:2,heading:10}];source.count=2;
  const catalog=expandSymmetryCatalog(source),reversed=expandSymmetryCatalog({...source,rows:[...source.rows].reverse()});
  assert.equal(catalog.count,360);
  assert.equal(sourceId(catalog.rows.find(row=>row.heading===0)),2);
  assert.deepEqual(catalog.rows.filter(row=>row.symmetry_source),reversed.rows.filter(row=>row.symmetry_source));
});
