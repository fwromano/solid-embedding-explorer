import test from 'node:test';
import assert from 'node:assert/strict';
import {orbitDragPose,orbitKeyPose,mountPreviewOrbit} from '../preview-orbit.js';

const bounds=[-60,60],size={width:360,height:180};
test('object dragging reverses heading, changes elevation, wraps and clamps to recorded views',()=>{
  assert.deepEqual(orbitDragPose({heading:271,elevation:0},10,10,size,bounds),{heading:266,elevation:10});
  assert.deepEqual(orbitDragPose({heading:5,elevation:55},20,20,size,bounds),{heading:355,elevation:60});
  assert.deepEqual(orbitDragPose({heading:355,elevation:-55},-20,-20,size,bounds),{heading:5,elevation:-60});
  assert.deepEqual(orbitDragPose({heading:90,elevation:60},0,-1,size,bounds),{heading:90,elevation:59},'reverse immediately after hitting the limit');
});

test('keyboard follows object drag in both axes with larger Shift steps and explicit seam endpoints',()=>{
  const pose={heading:271,elevation:0};
  for(const [key,heading,elevation] of [['ArrowLeft',272,0],['ArrowRight',270,0],['ArrowUp',271,-1],['ArrowDown',271,1],['Home',0,0],['End',360,0]]){
    assert.deepEqual(orbitKeyPose(pose,{key},bounds),{heading,elevation});
  }
  assert.deepEqual(orbitKeyPose({heading:5,elevation:55},{key:'ArrowRight',shiftKey:true},bounds),{heading:350,elevation:55});
  assert.deepEqual(orbitKeyPose({heading:5,elevation:55},{key:'ArrowDown',shiftKey:true},bounds),{heading:5,elevation:60});
  for(const modifier of ['ctrlKey','altKey','metaKey'])assert.equal(orbitKeyPose(pose,{key:'ArrowLeft',[modifier]:true},bounds),null);
  assert.equal(orbitKeyPose(pose,{key:'Tab'},bounds),null);
});

function fixture(){
  const handlers=new Map(),frames=new Map(),requests=[],captured=new Set();
  let state={heading:271,elevation:0},seq=0,starts=0,enabled=true;
  const element={dataset:{},getBoundingClientRect:()=>size,focus(){},
    addEventListener(type,handler){handlers.set(type,handler);},removeEventListener(type){handlers.delete(type);},
    setPointerCapture(id){captured.add(id);},hasPointerCapture:id=>captured.has(id),releasePointerCapture(id){captured.delete(id);}};
  const control=mountPreviewOrbit(element,{getPose:()=>state,getElevationBounds:()=>bounds,enabled:()=>enabled,
    onStart:()=>starts++,onRequest(pose){state=pose;requests.push(pose);},
    requestFrame(fn){frames.set(++seq,fn);return seq;},cancelFrame(id){frames.delete(id);}});
  return {element,control,requests,frames,captured,handlers,get state(){return state;},get starts(){return starts;},disable(){enabled=false;},
    event(type,values={}){const e={pointerId:1,button:0,isPrimary:true,clientX:0,clientY:0,preventDefault(){this.prevented=true;},...values};handlers.get(type)?.(e);return e;},
    tick(){for(const [id,fn] of frames){frames.delete(id);fn();}}};
}

test('mouse and touch use captured two-axis motion and flush final coordinates before a frame',()=>{
  for(const pointerType of ['mouse','touch']){
    const f=fixture();f.event('pointerdown',{pointerType});
    assert.equal(f.starts,1);assert.ok(f.captured.has(1));assert.equal(f.element.dataset.dragging,'true');
    f.event('pointermove',{clientX:10,clientY:10});f.event('pointermove',{clientX:20,clientY:20});
    assert.equal(f.frames.size,1);assert.equal(f.requests.length,0);
    f.event('pointerup',{clientX:30,clientY:30});
    assert.deepEqual(f.requests,[{heading:256,elevation:30}]);assert.equal(f.frames.size,0);assert.equal(f.captured.size,0);
    assert.equal(f.element.dataset.dragging,'false');f.tick();assert.equal(f.requests.length,1);
  }
});

test('pointer identity, cancellation, teardown and keyboard prevent stale drag updates',()=>{
  const f=fixture();f.event('pointerdown',{button:2});f.event('pointerdown',{isPrimary:false});assert.equal(f.starts,0);
  f.event('pointerdown');f.event('pointerdown',{pointerId:2});f.event('pointermove',{pointerId:2,clientX:90});assert.equal(f.frames.size,0);
  f.event('keydown',{key:'ArrowRight'});assert.equal(f.requests.length,0);
  f.event('pointermove',{clientX:10,clientY:70});f.tick();assert.deepEqual(f.state,{heading:266,elevation:60});
  f.event('pointermove',{clientX:10,clientY:69});f.event('lostpointercapture');assert.deepEqual(f.state,{heading:266,elevation:59});
  assert.equal(f.captured.size,0);assert.equal(f.frames.size,0);
  f.event('pointerdown');f.event('pointermove',{clientX:10});f.event('pointercancel');assert.equal(f.captured.size,0);
  const afterCancel={...f.state};f.event('pointermove',{clientX:100});f.tick();assert.deepEqual(f.state,afterCancel);
  f.event('keydown',{key:'ArrowLeft'});assert.equal(f.state.heading,afterCancel.heading+1);
  f.event('pointerdown');f.event('pointermove',{clientX:10});const beforeDestroy={...f.state};
  f.control.destroy();f.tick();assert.deepEqual(f.state,beforeDestroy);assert.equal(f.handlers.size,0);assert.equal(f.captured.size,0);
  const disabled=fixture();disabled.disable();disabled.event('pointerdown');disabled.event('keydown',{key:'ArrowLeft'});assert.equal(disabled.starts,0);
});
