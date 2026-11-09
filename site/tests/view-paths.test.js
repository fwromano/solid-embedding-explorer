import test from 'node:test';
import assert from 'node:assert/strict';
import {viewPathLinks,parseState,serializeState} from '../core.js';
import {expandSymmetryCatalog} from '../symmetry.js';

const row=(id,heading,elevation,shape='cube',color='red')=>({id,heading,elevation,shape,color});
const base=[row(10,0,-5),row(11,0,0),row(12,0,5),row(20,1,-5),row(21,1,0),row(22,1,5)];

test('elevation paths connect ascending measured elevations at fixed heading, shape and paint without wrapping',()=>{
  const rows=[...base,row(30,0,0,'sphere'),row(40,0,0,'cube','blue')];
  const original=structuredClone(rows),links=viewPathLinks([...rows].reverse(),{elevation:true});
  assert.equal(links.length,4);
  assert.deepEqual(links.filter(l=>l.from<20).map(l=>[l.from,l.to,l.kind,l.dashed]),[[10,11,'elevation',false],[11,12,'elevation',false]]);
  assert.ok(links.every(l=>l.to-l.from===1));
  assert.deepEqual(rows,original);
  assert.deepEqual(viewPathLinks(rows),[]);
  assert.deepEqual(viewPathLinks(rows.filter(r=>r.elevation===0),{elevation:true}),[]);
});

test('filtered elevation gaps are dashed and paths use only visible rows',()=>{
  const links=viewPathLinks(base.filter(r=>r.elevation!==0),{elevation:true});
  assert.deepEqual(links,[{from:10,to:12,kind:'elevation',dashed:true},{from:20,to:22,kind:'elevation',dashed:true}]);
});

test('heading and elevation paths can be enabled together with no duplicate reverse or symmetry links',()=>{
  const source={rows:base,count:base.length,shapes:[{id:'cube',heading_symmetry:{kind:'discrete',period_deg:90}}],colors:[{id:'red'}],series:[{id:'cube/red',shape:'cube',color:'red',count:6,expected:6}]};
  const expanded=expandSymmetryCatalog(source),links=viewPathLinks(expanded.rows,{heading:true,elevation:true});
  assert.equal(expanded.rows.length,24);
  assert.equal(links.filter(l=>l.kind==='heading').length,3);
  assert.equal(links.filter(l=>l.kind==='elevation').length,4);
  assert.ok(links.every(l=>!l.dashed),'measured one-degree heading edges win over duplicate reverse gaps');
  const aliases=expanded.rows.filter(r=>r.heading>=90&&r.heading<=91);
  assert.deepEqual(viewPathLinks(aliases,{elevation:true}),viewPathLinks(base,{elevation:true}));
});

test('continuous symmetry yields one 24-segment elevation track across 360 heading copies',()=>{
  const rows=Array.from({length:25},(_,i)=>row(i+1,0,-60+i*5,'sphere'));
  const source={rows,count:25,shapes:[{id:'sphere',heading_symmetry:{kind:'continuous'}}],colors:[{id:'red'}],series:[{id:'sphere/red',shape:'sphere',color:'red',count:25,expected:25}]};
  const links=viewPathLinks(expandSymmetryCatalog(source).rows,{heading:true,elevation:true});
  assert.equal(links.length,24);assert.ok(links.every(l=>l.kind==='elevation'&&!l.dashed));
  assert.equal(links.at(-1).to,25);assert.equal(links[0].from,1);
});

test('heading loops retain their seam and both toggles round trip independently in shared links',()=>{
  const rows=[row(1,0,0),row(2,1,0),row(3,2,0)];
  assert.deepEqual(viewPathLinks(rows,{heading:true}),[
    {from:1,to:2,kind:'heading',dashed:false},{from:2,to:3,kind:'heading',dashed:false},{from:3,to:1,kind:'heading',dashed:true}
  ]);
  const catalog={rows,shapes:[{id:'cube',period:90}],colors:[{id:'red'}],series:[{id:'cube/red'}]};
  for(const paths of [false,true])for(const elevationPaths of [false,true]){
    const state=parseState(`?paths=${Number(paths)}&elevationPaths=${Number(elevationPaths)}&elevation=0`,catalog);
    assert.equal(state.paths,paths);assert.equal(state.elevationPaths,elevationPaths);
    assert.deepEqual(parseState(serializeState(state),catalog),state);
  }
  assert.equal(parseState('?paths=1',catalog).elevationPaths,false,'existing links retain heading-only behavior');
});
