import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';
import {preparePointColors} from '../app.js';
import {parseColorState,createColorMapping} from '../view-colors.js';
const continuous={kind:'continuous',ideal_geometry:true,pixel_equivalence:'approximate finite-mesh raster'};
const rows=[{id:66600,shape:'sphere',color:'red',heading:0,elevation:-5},{id:66601,shape:'sphere',color:'red',heading:0,elevation:0},{id:66602,shape:'sphere',color:'red',heading:0,elevation:5}];
const sphere={id:'sphere',heading_symmetry:continuous,observable_heading:false,observable_elevation:false};

test('continuous alias selection uses typed kind, nearest actual retained elevation and stable new IDs',()=>{
  assert.equal(core.canonicalHeading(271,continuous),0);
  assert.equal(core.circularDistance(0,271,continuous),0);
  assert.equal(core.nearestSample(rows,271,3,continuous).id,66602);
  const catalog={rows,shapes:[sphere]};
  assert.deepEqual(core.filterRows(catalog,{series:['sphere/red'],headingMode:'current',heading:271,elevationMode:'all'}).map(r=>r.id),[66600,66601,66602]);
  assert.equal(core.canonicalHeading(181,{kind:'discrete',period_deg:180}),1);
  for(const invalid of [0,Infinity,{kind:'discrete',period_deg:0},{kind:'other'}])assert.throws(()=>core.canonicalHeading(17,invalid));
});

test('sphere full rotational aliases explicitly separate requested from recorded, not independent pose information',()=>{
  assert.equal(typeof core.describePose,'function');
  const info=core.describePose(sphere,271,3,rows[2]);
  assert.match(info.requested,/Requested 271° \/ 3°/);
  assert.match(info.requested,/Recorded 0° \/ 5°/);
  assert.match(info.requested,/full rotational alias/i);
  assert.match(info.requested,/heading and elevation are not independently observable/i);
  assert.match(info.requested,/finite-mesh/i);
  assert.notEqual(info.badge,'Exact view');
  const cylinder=core.describePose({...sphere,id:'cylinder',observable_elevation:true},270,3,rows[2]);
  assert.match(cylinder.requested,/continuous heading alias/i);
  assert.doesNotMatch(cylinder.requested,/heading and elevation are not independently observable/i);
});

test('actual image scrub and keyboard retain physical requests for continuous and discrete aliases',()=>{
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const handlers=source.slice(source.indexOf('    wrap.onpointerdown='),source.indexOf("    window.addEventListener('popstate'"));
  for(const policy of [continuous,{kind:'discrete',period_deg:180}]) {
    const state={heading:271},wrap={clientWidth:360,setPointerCapture(){}};
    const context=vm.createContext({state,wrap,scrub:null,scrubFrame:0,selected:()=>true,stop(){},currentPeriod:()=>policy,canonicalHeading:core.canonicalHeading,requestView(){},requestAnimationFrame(fn){fn();return 0;}});
    vm.runInContext(handlers,context);
    wrap.onpointerdown({pointerId:1,clientX:0});wrap.onpointermove({clientX:10});
    assert.equal(state.heading,281);
    wrap.onkeydown({key:'ArrowRight',shiftKey:false,preventDefault(){}});
    assert.equal(state.heading,282);
  }
});

test('playback advances the physical request rather than collapsing continuous aliases to zero',()=>{
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('  function animate(now)'),source.indexOf('  function bind()'));
  const state={heading:271,speed:30};
  const context=vm.createContext({state,playing:true,lastPlay:1000,playFrame:0,currentPeriod:()=>continuous,canonicalHeading:core.canonicalHeading,requestView(){},requestAnimationFrame(){return 1;}});
  vm.runInContext(body,context);context.animate(2000);
  assert.equal(state.heading,301);
});

test('expanded methods and coverage never imply a ten-shape supervised training cohort',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/five solids × six paints|max="66600"/);
  assert.match(html,/Original five-solid/);
  assert.match(html,/new shapes projected out of cohort/);
  assert.match(html,/full rotational alias/);
  const js=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.match(js,/source_dataset/);
  assert.match(js,/status\.refresh_supported===false/);
  assert.match(js,/Refresh gated/);
});

test('expanded UI routes aliases through typed metadata and keeps recorded physical heading colors',()=>{
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.match(source,/heading_symmetry/);
  assert.match(source,/describePose\(/);
  assert.doesNotMatch(source,/expected_count\|\|66600/);
  const catalog={rows:[...rows,{...rows[0],id:1,shape:'star',heading:90}],shapes:[sphere,{id:'star',heading_symmetry:{kind:'discrete',period_deg:180}}],colors:[{id:'red',hex:'#E53935'}]};
  const state={colorBy:'viewpoint',viewColors:parseColorState(new URLSearchParams(),{min:-5,max:5})};
  const result=preparePointColors(catalog,state),rgbAt=createColorMapping(state.viewColors);
  for(const row of catalog.rows)assert.equal(result.packed.get(row.id),core.packColor(...rgbAt(row.heading,row.elevation)));
});
