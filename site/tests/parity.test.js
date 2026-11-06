import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';
import {readFile} from 'node:fs/promises';

test('variance annotation includes only the displayed axes',()=>{
  assert.equal(typeof core.projectionVariance,'function');
  assert.equal(core.projectionVariance([.5,.25,.125],'3d'),.875);
  assert.equal(core.projectionVariance([.5,.25,.125],'01'),.75);
  assert.equal(core.projectionVariance([.5,.25,.125],'02'),.625);
  assert.equal(core.projectionVariance([.5,.25,.125],'12'),.375);
  assert.equal(core.projectionVariance(null,'3d'),null);
});

test('color anchors and positions survive complete viewer URL serialization',()=>{
  const catalog={rows:[{id:0,shape:'cube',color:'red',heading:0,elevation:-60},{id:1,shape:'cube',color:'red',heading:1,elevation:60}],shapes:[{id:'cube',period:90}],colors:[{id:'red'}],series:[{id:'cube/red'}]};
  const state=core.parseState('?palette=custom&anchor-bottomLeft=%23123456&anchor-pos-bottomLeft=35,-40',catalog);
  assert.deepEqual(state.viewColors?.anchors.bottomLeft,[18,52,86]);
  assert.deepEqual(state.viewColors.positions.bottomLeft,[35,-40]);
  assert.deepEqual(core.parseState(core.serializeState(state),catalog),state);
  assert.equal(core.parseState('?palette=teal',catalog).palette,'teal-violet');
  assert.ok(!core.serializeState(state).includes('object'));
});

test('plot colors use the same absolute-heading mapping as the view map',async()=>{
  const app=await import('../app.js');
  assert.equal(typeof app.preparePointColors,'function');
  const catalog={rows:[{id:0,shape:'cube',color:'red',heading:45,elevation:20},{id:1,shape:'tetrahedron',color:'red',heading:45,elevation:20}],shapes:[{id:'cube',period:90},{id:'tetrahedron',period:120}],colors:[{id:'red',hex:'#ff0000'}],series:[{id:'cube/red'},{id:'tetrahedron/red'}]};
  const state=core.parseState('?palette=red-blue-green-yellow',catalog), result=app.preparePointColors(catalog,state);
  assert.equal(result.packed.get(0),result.packed.get(1));
  assert.equal(result.packed.get(0),core.packColor(...result.rgbAt(45,20)));
  assert.equal(result.pathPacked?.get(0),core.packColor(...result.rgbAt(45,20).map((v,i)=>Math.round(v*.6+[16,25,40][i]*.4))));
  assert.equal(app.preparePointColors(catalog,{...state,colorBy:'paint'}).packed.get(0),core.packColor(255,0,0));
});

test('color map is mounted with every canonical reference palette',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const {PALETTES}=await import('../view-colors.js');
  assert.match(html,/id="view-map"/);
  assert.match(html,/view-map.css/);
  for(const key of Object.keys(PALETTES))assert.ok(html.includes(`value="${key}"`),key);
});

test('actual exported PLS fits are valid restorable selections',()=>{
  const catalog={rows:[{id:0,shape:'cube',color:'red',heading:0,elevation:0}],shapes:[{id:'cube',period:90}],colors:[{id:'red'}],series:[{id:'cube/red'}],fits:['all','balanced','shape','color','pls','pls-attributes','pls-pose']};
  for(const fit of ['pls','pls-attributes','pls-pose']){
    const state=core.parseState('?fit='+fit,catalog);assert.equal(state.fit,fit);
    assert.equal(core.parseState(core.serializeState(state),catalog).fit,fit);
  }
});

test('reference diagnostics and fitted basis have distinct visible controls',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  for(const id of ['reference-score','reference-gallery','reference-source','basis-download'])assert.ok(html.includes(`id="${id}"`),id);
});

test('display cutout keeps RGB and derives only alpha from the native mask',async()=>{
  const {withMaskAlpha}=await import('../app.js');assert.equal(typeof withMaskAlpha,'function');
  const rgb=new Uint8ClampedArray([10,20,30,255,40,50,60,255]),mask=new Uint8ClampedArray([0,0,0,255,128,128,128,255]);
  assert.deepEqual([...withMaskAlpha(rgb,mask)],[10,20,30,0,40,50,60,128]);assert.equal(rgb[3],255);
  assert.throws(()=>withMaskAlpha(rgb,new Uint8ClampedArray(4)),/dimensions/);
});

test('shared default anchor positions override another browser saved positions',()=>{
  const catalog={rows:[{id:0,shape:'cube',color:'red',heading:0,elevation:-60},{id:1,shape:'cube',color:'red',heading:1,elevation:60}],shapes:[{id:'cube',period:90}],colors:[{id:'red'}],series:[{id:'cube/red'}]};
  const state=core.parseState('',catalog),saved={positions:{...state.viewColors.positions,bottomLeft:[35,-40]}};
  assert.deepEqual(core.parseState(core.serializeState(state),catalog,saved).viewColors,state.viewColors);
});

test('semantic method describes the actual training heading split',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/TRAIN headings 0° and 20°/);
  assert.doesNotMatch(html,/TRAIN elevations 0° and 20°/);
});
