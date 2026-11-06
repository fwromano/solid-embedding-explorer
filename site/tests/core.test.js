import test from 'node:test';
import assert from 'node:assert/strict';
const core = await import('../core.js').catch(() => ({}));
const rows = [
  {id:100,shape:'cube',color:'red',heading:0,elevation:0},
  {id:220,shape:'cube',color:'red',heading:45,elevation:0},
  {id:300,shape:'cube',color:'red',heading:0,elevation:20},
  {id:700,shape:'tetrahedron',color:'blue',heading:60,elevation:0},
  {id:900,shape:'tetrahedron',color:'blue',heading:0,elevation:0}
];
const catalog = {schema:'solids-explorer-v1',build_id:'test',count:5,
 shapes:[{id:'cube',period:90},{id:'tetrahedron',period:120}],
 colors:[{id:'red',hex:'#E53935'},{id:'blue',hex:'#1E88E5'}],
 series:[{id:'cube/red'},{id:'tetrahedron/blue'}],rows};

test('filters preserve empty selections and alias heading targets per configuration/elevation ring', () => {
  assert.equal(typeof core.filterRows,'function');
  const state={series:['cube/red','tetrahedron/blue'],headingMode:'selected',headings:[90],elevationMode:'all'};
  assert.deepEqual(core.filterRows(catalog,state).map(r=>r.id),[100,300,700]);
  assert.deepEqual(core.filterRows(catalog,{...state,headings:[]}),[]);
  assert.deepEqual(core.filterRows(catalog,{...state,series:[]}),[]);
  assert.deepEqual(core.filterRows(catalog,{...state,headingMode:'all',elevationMode:'selected',elevations:[]}),[]);
  const paths=core.pathRings(rows);
  assert.deepEqual(paths.map(p=>p.map(r=>r.id)),[[100,220],[300],[900,700]]);
  assert.equal(new Set(paths.flat()).size,rows.length);
});

test('URL state round trips every setting, including explicit none and malformed parameters', () => {
  assert.equal(typeof core.parseState,'function');
  const state=core.parseState('?palette=teal',catalog);
  Object.assign(state,{series:[],headings:[],elevations:[],headingMode:'selected',elevationMode:'selected',selectedId:220,dimensions:128,fit:'shape',mode:'12',heading:360,elevation:20,paths:true,pointSize:3.25,colorBy:'shape',paintFocus:'red',imageMode:'mask',speed:60,yaw:2,pitch:-.4,zoom:3,panX:.12,panY:-.1});
  assert.deepEqual(core.parseState(core.serializeState(state),catalog),state);
  const bad=core.parseState('?dimensions=42&fit=fake&show=bad&id=999&zoom=Infinity&pitch=99&heading=oops&pointSize=-2&atHeading=NaN',catalog);
  assert.equal(bad.dimensions,768);assert.equal(bad.fit,'all');assert.equal(bad.zoom,1);assert.equal(bad.pitch,1.5);assert.equal(bad.heading,0);assert.equal(bad.pointSize,1);assert.equal(bad.selectedId,null);assert.deepEqual(bad.series,[]);assert.deepEqual(bad.headings,[]);
});

test('projection keeps real coordinates, handles flat bounds, and depth picking selects frontmost pixels', () => {
  assert.equal(typeof core.projector,'function');
  const state={mode:'01',yaw:0,pitch:0,zoom:1,panX:0,panY:0};
  const project=core.projector([[-1,1],[-1,1],[-1,1]],state,200,200);
  assert.deepEqual(project([0,0,0]),{x:100,y:100,depth:0});
  assert.ok(project([1,1,0]).x>100);assert.ok(project([1,1,0]).y<100);
  assert.ok(Object.values(core.projector([[0,0],[0,0],[0,0]],state,200,200)([0,0,0])).every(Number.isFinite));
  const frame=core.createRaster(20,20);
  const points=[{x:10,y:10,depth:2,id:220,color:core.packColor(255,0,0)}, {x:10,y:10,depth:1,id:100,color:core.packColor(0,0,255)}];
  core.rasterize(frame,points,[],2);
  assert.equal(core.pickPixel(frame,10,10),220);
  assert.equal(core.pickPixel(frame,0,0),null);
  assert.equal(core.pickPixel(frame,-1,0),null);
  assert.equal(frame.pixels[210],core.packColor(255,0,0));
  core.rasterize(frame,points,[{a:{x:0,y:10,depth:3},b:{x:20,y:10,depth:3},color:core.packColor(50,50,50)}],2);
  assert.equal(core.pickPixel(frame,10,10),null);
  core.rasterize(frame,[],[],2);assert.equal(core.pickPixel(frame,10,10),null);
});

test('binary coordinates align with catalog order, not global row ID; corrupt data is rejected', () => {
  assert.equal(typeof core.decodeProjection,'function');
  const values=new Float32Array(rows.length*3);values[3]=.25;values[4]=-.5;
  const decoded=core.decodeProjection(values.buffer,rows.length);
  assert.equal(decoded[3],.25);assert.equal(decoded[4],-.5);
  assert.throws(()=>core.decodeProjection(new ArrayBuffer(4),rows.length),/alignment/);
  values[7]=NaN;assert.throws(()=>core.decodeProjection(values.buffer,rows.length),/finite/);
  const valid={...catalog,rows:rows.map(r=>({...r,image:'/dataset/a.png',mask:'/dataset/a-mask.png'}))};
  assert.equal(core.validateCatalog(valid),valid);
  assert.throws(()=>core.validateCatalog({...valid,count:7}),/count/);
  assert.throws(()=>core.validateCatalog({...valid,rows:[valid.rows[0],valid.rows[0],...valid.rows.slice(2)]}),/ID/);
  assert.throws(()=>core.validateCatalog({...valid,rows:valid.rows.map(r=>({...r,image:'javascript:alert(1)'}))}),/image/);
});

test('3D camera uses right-handed depth and renderer clips huge offscreen segments', () => {
  const state={mode:'3d',yaw:0,pitch:0,zoom:1,panX:0,panY:0};
  const project=core.projector([[-1,1],[-1,1],[-1,1]],state,200,200);
  assert.ok(project([0,-1,0]).depth>project([0,1,0]).depth);
  assert.ok(project([0,0,1]).y<project([0,0,0]).y);
  const frame=core.createRaster(30,30),red=core.packColor(255,0,0);
  core.rasterize(frame,[{id:100,x:15,y:15,depth:0,color:red}], [{a:{x:-1e8,y:15,depth:2},b:{x:1e8,y:15,depth:2},color:red}],2);
  assert.equal(core.pickPixel(frame,15,15),null);
});

test('URL validation falls back on blank values and preserves arbitrary supported playback speeds',()=>{
  const state=core.parseState('?speed=17&id=&zoom=&show=&elevationMode=selected&atElevation=',catalog);
  assert.equal(state.speed,17);assert.equal(state.zoom,1);assert.equal(state.selectedId,null);assert.deepEqual(state.elevations,[]);
  assert.deepEqual(core.parseState(core.serializeState(state),catalog),state);
});

test('viewpoint elevation color spans the actual negative-to-positive catalog range',()=>{
 assert.equal(typeof core.elevationFraction,'function');
 assert.equal(core.elevationFraction(-60,[-60,60]),0);
 assert.equal(core.elevationFraction(0,[-60,60]),.5);
 assert.equal(core.elevationFraction(60,[-60,60]),1);
 assert.equal(core.elevationFraction(90,[-60,60]),1);
 assert.equal(core.elevationFraction(0,[0,0]),.5);
});

test('canonical headings wrap by each solid period; nearest samples retain real row IDs', () => {
  assert.equal(typeof core.canonicalHeading, 'function');
  for (const period of [120,90,90,72,72]) {
    assert.equal(core.canonicalHeading(period, period), 0);
    assert.equal(core.canonicalHeading(-1, period), period - 1);
    assert.equal(core.circularDistance(period-1, 1, period), 2);
  }
  const rows = [{id:400, heading:0,elevation:20},{id:900,heading:60,elevation:20},{id:42,heading:0,elevation:0}];
  assert.equal(core.nearestSample(rows, 120, 20, 120).id,400);
  assert.equal(core.nearestSample(rows, 119, 19, 120).id,400);
  assert.equal(core.nearestSample([], 0, 0, 120), null);
});
