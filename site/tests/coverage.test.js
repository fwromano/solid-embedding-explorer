import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageSummary,visibleCoverage,plotCoverage} from '../coverage.js';
import {expandSymmetryCatalog} from '../symmetry.js';
import {createRaster,rasterize} from '../core.js';

function source() {
  return {count:3,shapes:[{id:'cube',period:90}],colors:[{id:'red'},{id:'blue'}],
    rows:[{id:7,shape:'cube',color:'red',heading:0,elevation:0},{id:50,shape:'cube',color:'red',heading:1,elevation:0},{id:81,shape:'cube',color:'blue',heading:0,elevation:0}],
    series:[{id:'cube/red',shape:'cube',color:'red',count:2,expected:2},{id:'cube/blue',shape:'cube',color:'blue',count:1,expected:2}]};
}
test('coverage distinguishes measured rows, repeats, partial pairs, and expected views',()=>{
  const original=source(),expanded=expandSymmetryCatalog(original),summary=coverageSummary(original,expanded);
  assert.equal(summary.measured,3);assert.equal(summary.aliases,9);assert.equal(summary.views,12);
  assert.equal(summary.expectedMeasured,4);assert.equal(summary.expectedViews,16);
  assert.equal(summary.completePairs,1);assert.equal(summary.expectedPairs,2);
  assert.equal(summary.shapes[0].pairs[1].measured,1);assert.equal(summary.shapes[0].pairs[1].expectedMeasured,2);
  assert.deepEqual(summary.elevations,[0]);
  // Metadata cannot turn absent rows into measured data.
  original.series[1].count=2;assert.equal(coverageSummary(original,expanded).completePairs,1);
});
test('filter coverage counts views independently of repeated source embeddings',()=>{
  const expanded=expandSymmetryCatalog(source());
  const rows=expanded.rows.filter(row=>row.color==='red'&&[0,180].includes(row.heading));
  const summary=visibleCoverage(rows);
  assert.equal(summary.views,2);assert.equal(summary.sources,1);
  assert.equal(summary.byPair.get('cube/red'),2);assert.equal(summary.byShape.get('cube'),2);
  assert.equal(visibleCoverage([]).sources,0);
});
test('plot coverage accounts separately for overlapping and offscreen source points',()=>{
  const frame=createRaster(20,20),points=[{id:7,x:10,y:10,depth:2,color:0xff00ff00},{id:50,x:10,y:10,depth:1,color:0xffff0000},{id:81,x:100,y:100,depth:0,color:0xff0000ff}];
  rasterize(frame,points,[],2);
  assert.deepEqual(plotCoverage(points,frame,2),{points:3,inFrame:2,offscreen:1,painted:1,occluded:1});
  rasterize(frame,[],[],2);assert.deepEqual(plotCoverage([],frame,2),{points:0,inFrame:0,offscreen:0,painted:0,occluded:0});
});
