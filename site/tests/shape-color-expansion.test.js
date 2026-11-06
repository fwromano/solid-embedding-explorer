import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePointColors} from '../app.js';
import {packColor} from '../core.js';
import {parseColorState} from '../view-colors.js';

test('ten expanded shape colors are distinct while the original five stay unchanged',()=>{
  const names=['tetrahedron','cube','octahedron','dodecahedron','icosahedron','cylinder','star','cone','sphere','torus'];
  const catalog={shapes:names.map(id=>({id})),colors:[{id:'red',hex:'#E53935'}],rows:names.map((shape,id)=>({id,shape,color:'red',heading:0,elevation:0}))};
  const state={colorBy:'shape',viewColors:parseColorState(new URLSearchParams())};
  const prepared=preparePointColors(catalog,state);
  const values=catalog.rows.map(r=>prepared.packed.get(r.id));
  assert.deepEqual(values.slice(0,5),[[112,184,255],[239,185,95],[188,139,255],[117,207,175],[241,143,157]].map(rgb=>packColor(...rgb)));
  assert.equal(new Set(values).size,10,'Each of the ten registered shapes needs its own category color');
  const viewpoint=preparePointColors(catalog,{...state,colorBy:'viewpoint'});
  assert.equal(new Set(catalog.rows.map(r=>viewpoint.packed.get(r.id))).size,1,'Identical physical headings/elevations keep one shared viewpoint color');
});
