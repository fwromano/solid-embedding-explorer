import test from 'node:test';
import assert from 'node:assert/strict';
import {packColor,unpackColor} from '../core.js';
import {preparePointColors,blendPointColors} from '../app.js';
import {parseColorState} from '../view-colors.js';

test('packed RGB round trips preserve all channels',()=>{
  for(const rgb of [[0,0,0],[255,255,255],[17,128,250]])assert.deepEqual(unpackColor(packColor(...rgb)),rgb);
});

test('all symmetry views contribute equally at shared coordinates regardless of row order',()=>{
  const source={id:1},rows=[source,...[2,3,4].map(id=>({id,symmetry_source:source}))];
  const colors=new Map([[1,packColor(255,0,0)],[2,packColor(0,255,0)],[3,packColor(0,0,255)],[4,packColor(255,255,255)]]);
  const result=blendPointColors(rows,colors);
  assert.deepEqual(unpackColor(result.packed.get(1)),[128,128,128]);
  assert.deepEqual(result,blendPointColors([...rows].reverse(),colors));
  assert.deepEqual(unpackColor(result.pathPacked.get(1)),[83,87,93]);
  assert.equal(blendPointColors([rows[2]],colors).packed.get(1),colors.get(3),'a filtered alias retains its own color');
  assert.deepEqual(unpackColor(blendPointColors(rows.slice(2),colors).packed.get(1)),[128,128,255]);
  assert.equal(blendPointColors([...rows,{id:5}],new Map([...colors,[5,packColor(1,2,3)]])).packed.get(5),packColor(1,2,3),'independent source rows are not merged');
  assert.equal(blendPointColors([],colors).packed.size,0);
  assert.throws(()=>blendPointColors(rows,new Map()),/Missing color/);
});

test('continuous 360-view colors include every heading and keep paint/shape colors exact',()=>{
  const source={id:1,heading:0,elevation:20,shape:'sphere',color:'red'};
  const rows=[source,...Array.from({length:359},(_,i)=>({...source,id:i+2,heading:i+1,symmetry_source:source}))];
  const catalog={rows,shapes:[{id:'sphere'}],colors:[{id:'red',hex:'#E53935'}]};
  const viewColors=parseColorState(new URLSearchParams(),{min:-60,max:60});
  const prepared=preparePointColors(catalog,{colorBy:'viewpoint',viewColors});
  const expected=[0,1,2].map(channel=>Math.round(rows.reduce((sum,row)=>sum+prepared.rgbAt(row.heading,row.elevation)[channel],0)/360));
  assert.deepEqual(unpackColor(blendPointColors(rows,prepared.packed).packed.get(1)),expected);
  assert.notEqual(blendPointColors(rows,prepared.packed).packed.get(1),prepared.packed.get(1));
  for(const colorBy of ['paint','shape']){
    const colors=preparePointColors(catalog,{colorBy,viewColors}).packed;
    assert.equal(blendPointColors(rows,colors).packed.get(1),colors.get(1));
  }
});
