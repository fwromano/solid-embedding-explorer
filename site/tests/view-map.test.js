import test from 'node:test';
import assert from 'node:assert/strict';
const map = await import('../view-map.js').catch(() => ({}));
const state = () => ({palette:'test', elevationMin:-60, elevationMax:60,
  anchors:{bottomLeft:[38,98,255],topLeft:[0,166,81],topRight:[230,57,70],bottomRight:[255,212,0]},
  positions:{bottomLeft:[0,-60],topLeft:[0,60],topRight:[180,60],bottomRight:[180,-60]}});

// A deliberately small DOM surface, not a browser/layout replacement or dependency.
class Element {
  constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.attributes={};this.style={};this.listeners={};this.hidden=false;this.value='';this.textContent='';}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children.forEach(n=>n.parentNode=null);this.children=[];this.append(...nodes);}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
  removeEventListener(k,f){this.listeners[k]=(this.listeners[k]??[]).filter(x=>x!==f);}
  getBoundingClientRect(){return {left:10,top:20,width:360,height:120};}
  setPointerCapture(id){this.capture=id;}
  hasPointerCapture(id){return this.capture===id;}
  releasePointerCapture(){this.capture=null;}
  focus(){this.ownerDocument.activeElement=this;}
  getContext(){return {createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:()=>{this.paints=(this.paints??0)+1;}};}
  get valueAsNumber(){return this.value.trim()===''?NaN:Number(this.value);}
}
function fixture(){
  const doc={createElement:tag=>new Element(tag,doc),createElementNS:(_,tag)=>new Element(tag,doc),activeElement:null};
  const root=new Element('div',doc);
  return {root,doc};
}
function all(root,predicate){return root.children.flatMap(n=>[...(predicate(n)?[n]:[]),...all(n,predicate)]);}
function by(root,name,value){return all(root,n=>n.getAttribute(name)===value)[0];}
function fire(node,type,fields={}){
  const event={type,target:node,button:0,pointerId:1,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...fields};
  for(let at=node;at;at=at.parentNode){event.currentTarget=at;for(const fn of at.listeners[type]??[])fn(event);if(event.stopped)break;}
  return event;
}

test('view map retains available views while identifying filtered-out symmetry aliases',()=>{
  const {root}=fixture(),controller=map.mountViewMap(root,{onRequest(){},onColors(){}});
  const source={id:1,heading:0,elevation:0},alias={id:2,heading:180,elevation:0,symmetry_source:source};
  const update={colors:state(),rgbAt:()=>[12,34,56],rows:[source,alias],visibleIds:new Set([1]),requested:{heading:180,elevation:0},recorded:null};
  controller.update(update);
  assert.equal(by(root,'data-row','2').getAttribute('data-visible'),'false');
  assert.equal(by(root,'data-row','2').getAttribute('data-alias'),'true');
  assert.match(by(root,'class','view-map-availability').textContent,/1 \/ 2 views/);
  controller.update({...update,visibleIds:new Set([1,2]),recorded:alias});
  assert.equal(by(root,'data-row','2').getAttribute('opacity'),'1');
  assert.match(by(root,'class','view-map-readout').textContent,/Symmetry view 180°.*source 0°/);
});

test('mounted map shows only supplied actual rows, separate requested/recorded markers, cached colors and clean teardown', () => {
  assert.equal(typeof map.mountViewMap,'function');
  const {root}=fixture(), calls=[];
  const controller=map.mountViewMap(root,{onRequest:(...p)=>calls.push(p),onColors:()=>assert.fail('update must not edit colors')});
  const rows=[{id:81,heading:30,elevation:-20},{id:82,heading:60,elevation:40}];
  const update={colors:state(),rgbAt:()=>[12,34,56],rows,requested:{heading:300,elevation:-40},recorded:rows[0]};
  controller.update(update);
  const dots=all(root,n=>n.getAttribute('data-row')!==null);
  assert.deepEqual(dots.map(n=>n.getAttribute('data-row')),['81','82']);
  assert.equal(dots[0].getAttribute('cx'),'30');
  assert.equal(dots[0].getAttribute('cy'),'80');
  assert.equal(dots[0].getAttribute('fill'),'rgb(12 34 56)');
  const requested=by(root,'data-marker','requested'), recorded=by(root,'data-marker','recorded');
  assert.equal(requested.getAttribute('transform'),'translate(300 100)');
  assert.equal(recorded.getAttribute('cx'),'30');
  const canvas=all(root,n=>n.tagName==='canvas')[0];
  assert.equal(canvas.paints,1);
  controller.update({...update,colors:structuredClone(update.colors),requested:{heading:10,elevation:0},rows:[rows[1]],recorded:null});
  assert.equal(canvas.paints,1);
  assert.deepEqual(all(root,n=>n.getAttribute('data-row')!==null).map(n=>n.getAttribute('data-row')),['82']);
  assert.equal(recorded.getAttribute('visibility'),'hidden');
  assert.deepEqual(calls,[]);
  controller.destroy();
  assert.equal(root.children.length,0);
  controller.update(update);
  assert.equal(root.children.length,0);
});

test('mounted request drag and keyboard invoke only onRequest, clamp at bounds, and release capture on teardown', () => {
  const {root}=fixture(), requests=[], edits=[];
  const controller=map.mountViewMap(root,{onRequest:(...p)=>requests.push(p),onColors:c=>edits.push(c)});
  const input={colors:state(),rgbAt:()=>[1,2,3],rows:[],requested:{heading:20,elevation:0},recorded:null};
  controller.update(input);
  const pad=by(root,'class','view-map-pad');
  fire(pad,'pointermove',{clientX:100,clientY:100});
  fire(pad,'pointerdown',{button:2,clientX:100,clientY:100});
  assert.equal(requests.length,0);
  fire(pad,'pointerdown',{clientX:190,clientY:80});
  assert.deepEqual(requests.at(-1),[180,0]);
  fire(pad,'pointermove',{pointerId:2,clientX:20,clientY:20});
  assert.equal(requests.length,1);
  fire(pad,'pointermove',{clientX:900,clientY:-200});
  assert.deepEqual(requests.at(-1),[360,60]);
  fire(pad,'pointerup',{clientX:100,clientY:140});
  assert.deepEqual(requests.at(-1),[90,-60]);
  assert.equal(pad.capture,null);
  const e=fire(pad,'keydown',{key:'ArrowLeft',shiftKey:true});
  assert.equal(e.defaultPrevented,true);
  assert.deepEqual(requests.at(-1),[75,-60]);
  assert.deepEqual(input.requested,{heading:20,elevation:0});
  assert.equal(fire(pad,'keydown',{key:'Tab'}).defaultPrevented,undefined);
  assert.deepEqual(edits,[]);
  fire(pad,'pointerdown',{clientX:20,clientY:20});
  const count=requests.length;
  controller.destroy();
  assert.equal(pad.capture,null);
  fire(pad,'keydown',{key:'Home'});
  fire(pad,'pointermove',{clientX:50,clientY:50});
  assert.equal(requests.length,count);
});

test('color inputs and numeric editor emit isolated plain states without requesting views and preserve open/draft state on updates', () => {
  const {root,doc}=fixture(), edits=[];
  const controller=map.mountViewMap(root,{onRequest:()=>assert.fail('anchor edit requested a view'),onColors:c=>edits.push(c)});
  const input={colors:state(),rgbAt:()=>[1,2,3],rows:[],requested:{heading:120,elevation:0},recorded:null};
  controller.update(input);
  const color=by(root,'aria-label','Color A');
  assert.ok(color,'accessible Color A input');
  assert.equal(all(root,n=>n.type==='color').length,4);
  color.value='#010203';fire(color,'input');fire(color,'change');
  assert.equal(edits.length,1);
  assert.equal(edits[0].palette,'custom');
  assert.deepEqual(edits[0].anchors.bottomLeft,[1,2,3]);
  assert.deepEqual(edits[0].positions,input.colors.positions);
  const editor=by(root,'class','view-map-editor');editor.open=true;
  const heading=by(root,'aria-label','Color A heading'), elevation=by(root,'aria-label','Color A elevation');
  assert.equal(heading.min,'0');assert.equal(heading.max,'360');
  assert.equal(elevation.min,'-60');assert.equal(elevation.max,'60');
  heading.value='23.456';fire(heading,'change');
  assert.deepEqual(edits.at(-1).positions.bottomLeft,[23.456,-60]);
  assert.equal(heading.value,'23.5');
  assert.equal(by(root,'data-caption','bottomLeft').textContent,'A · 23.5°, -60°');
  const updated=structuredClone(edits.at(-1));
  edits.at(-1).anchors.bottomLeft[0]=255;
  heading.value='24';fire(heading,'change');
  assert.equal(edits.at(-1).anchors.bottomLeft[0],1,'callback mutation cannot leak back');
  heading.focus();heading.value='123.';
  controller.update({...input,colors:updated,requested:{heading:180,elevation:30}});
  assert.equal(editor.open,true);assert.equal(heading.value,'123.');
  doc.activeElement=null;
  const bElevation=by(root,'aria-label','Color B elevation');
  bElevation.value='-60';fire(bElevation,'change'); // B=(0,-60) is free now A moved.
  const aHeading=by(root,'aria-label','Color A heading');
  aHeading.value='360';const before=edits.length;fire(aHeading,'change');
  assert.equal(edits.length,before,'0/360 anchor collision rejected');
  assert.match(by(root,'role','status').textContent,/distinct/i);
  fire(by(root,'data-action','reset-positions'),'click');
  assert.deepEqual(edits.at(-1).positions,state().positions);
  assert.deepEqual(edits.at(-1).anchors,updated.anchors);
  assert.equal(input.colors.palette,'test');
  assert.deepEqual(input.colors.positions,state().positions);
  controller.destroy();
});

test('A–D handle drag and keyboard edit only colors, preserve edit mode across parent updates, and stop on close', () => {
  const {root}=fixture(), requests=[], edits=[];
  let input={colors:state(),rgbAt:()=>[1,2,3],rows:[],requested:{heading:120,elevation:0},recorded:null};
  const controller=map.mountViewMap(root,{onRequest:(...p)=>requests.push(p),onColors:colors=>{edits.push(colors);input={...input,colors};controller.update(input);}});
  controller.update(input);
  const editor=by(root,'class','view-map-editor'), pad=by(root,'class','view-map-pad');
  const toggle=by(root,'data-action','edit-positions');
  assert.ok(toggle,'editing toggle exists');
  editor.open=true;fire(toggle,'click');
  assert.equal(toggle.getAttribute('aria-pressed'),'true');
  const handle=by(root,'aria-label','Move color A');
  assert.equal(all(root,n=>n.getAttribute('data-anchor-handle')!==null).length,4);
  assert.equal(handle.hidden,false);
  fire(pad,'pointerdown',{clientX:30,clientY:30});fire(pad,'keydown',{key:'ArrowRight'});
  assert.deepEqual(requests,[]);
  fire(handle,'keydown',{key:'ArrowRight',shiftKey:true});
  assert.deepEqual(edits.at(-1).positions.bottomLeft,[10,-60]);
  assert.equal(toggle.getAttribute('aria-pressed'),'true');assert.equal(editor.open,true);
  fire(handle,'pointerdown',{clientX:20,clientY:140});
  fire(pad,'pointermove',{clientX:190,clientY:80});
  assert.deepEqual(edits.at(-1).positions.bottomLeft,[180,0]);
  const count=edits.length;
  fire(pad,'pointermove',{clientX:190,clientY:20});
  assert.equal(edits.length,count,'drag collision rejected');
  fire(pad,'pointerup',{clientX:110,clientY:100});
  assert.deepEqual(edits.at(-1).positions.bottomLeft,[100,-20]);
  assert.deepEqual(requests,[]);
  fire(handle,'pointerdown',{clientX:110,clientY:100});
  editor.open=false;fire(editor,'toggle');
  assert.equal(toggle.getAttribute('aria-pressed'),'false');assert.equal(handle.hidden,true);
  assert.equal(pad.capture,null);
  fire(pad,'pointermove',{clientX:250,clientY:50});
  assert.deepEqual(requests,[]);
  fire(pad,'keydown',{key:'ArrowRight',shiftKey:true});
  assert.deepEqual(requests.at(-1),[135,0]);
  controller.destroy();
});

test('stylesheet is scoped, responsive, keeps pointer overlays transparent, and preserves visible focus/hidden handles', async () => {
  const {readFile}=await import('node:fs/promises');
  const css=await readFile(new URL('../view-map.css',import.meta.url),'utf8').catch(()=> '');
  assert.ok(css.length,'map stylesheet exists');
  assert.match(css,/\.view-map\s*\{/);
  assert.match(css,/touch-action:\s*none/);
  assert.match(css,/pointer-events:\s*none/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css,/@media\s*\(max-width:/);
  assert.match(css,/\.view-map-requested/);
  assert.match(css,/\.view-map-recorded/);
});

test('gradient pixels use the supplied point-cloud rgbAt and cache by color values, not selection or callback identity', () => {
  assert.equal(typeof map.createGradientCache,'function');
  const gradient=map.createGradientCache(5,3), colors=state();
  let calls=0;
  const rgbAt=(h,e)=>{calls++;return [Math.round(h/2),e+60,42];};
  const first=gradient(colors,rgbAt);
  assert.equal(calls,15);
  for(let y=0;y<3;y++)for(let x=0;x<5;x++){
    assert.deepEqual([...first.data.slice((y*5+x)*4,(y*5+x)*4+4)],[Math.round(x*90/2),120-y*60,42,255]);
  }
  assert.equal(gradient(structuredClone(colors),()=>{throw Error('must reuse gradient');}),first);
  colors.positions.topLeft=[20,55];
  assert.notEqual(gradient(colors,rgbAt),first);
  assert.equal(calls,30);
  colors.anchors.topLeft=[1,2,3];gradient(colors,rgbAt);
  assert.equal(calls,45);
});

test('anchor edits clone state, preserve colors on moves/reset, and reject circular collisions', () => {
  assert.equal(typeof map.editAnchor, 'function');
  const original=state(), before=structuredClone(original);
  const colored=map.editAnchor(original,{type:'color',name:'topLeft',rgb:[1,2,3]});
  assert.equal(colored.palette,'custom');
  assert.deepEqual(colored.anchors.topLeft,[1,2,3]);
  assert.deepEqual(colored.positions,original.positions);
  assert.notEqual(colored.positions.topLeft,original.positions.topLeft);
  const moved=map.editAnchor(original,{type:'move',name:'topLeft',heading:500,elevation:12});
  assert.deepEqual(moved.positions.topLeft,[360,12]);
  assert.equal(moved.palette,'test');
  assert.deepEqual(moved.anchors,original.anchors);
  assert.equal(map.editAnchor(original,{type:'move',name:'topLeft',heading:360,elevation:-60}),null);
  assert.equal(map.editAnchor(original,{type:'move',name:'topLeft',heading:NaN,elevation:10}),null);
  assert.equal(map.editAnchor(original,{type:'move',name:'topLeft',heading:.001,elevation:-60}),null);
  const reset=map.editAnchor({...moved,palette:'custom'},{type:'reset'});
  assert.deepEqual(reset.positions,original.positions);
  assert.equal(reset.palette,'custom');
  assert.deepEqual(reset.anchors,original.anchors);
  assert.deepEqual(original,before);
});

test('keyboard arrows request bounded poses with Shift 15° and never navigate during color editing', () => {
  assert.equal(typeof map.keyboardPose, 'function');
  const pose={heading:359,elevation:59};
  assert.deepEqual(map.keyboardPose(pose,{key:'ArrowLeft',shiftKey:true},-60,60),{heading:344,elevation:59});
  assert.deepEqual(map.keyboardPose(pose,{key:'ArrowRight',shiftKey:true},-60,60),{heading:360,elevation:59});
  assert.deepEqual(map.keyboardPose(pose,{key:'ArrowUp',shiftKey:true},-60,60),{heading:359,elevation:60});
  assert.deepEqual(map.keyboardPose({heading:0,elevation:-60},{key:'ArrowDown'},-60,60),{heading:0,elevation:-60});
  assert.deepEqual(map.keyboardPose(pose,{key:'Home'},-60,60),{heading:0,elevation:59});
  assert.deepEqual(map.keyboardPose(pose,{key:'End'},-60,60),{heading:360,elevation:59});
  assert.equal(map.keyboardPose(pose,{key:'a'},-60,60),null);
  assert.equal(map.keyboardPose(pose,{key:'ArrowRight'},-60,60,true),null);
});

test('map coordinate conversion uses the entire 360° domain and clamps to actual elevation limits', () => {
  assert.equal(typeof map.pointToPose, 'function');
  const rect={left:10,top:20,width:400,height:120};
  assert.deepEqual(map.pointToPose(210,80,rect,-60,60), {heading:180,elevation:0});
  assert.deepEqual(map.pointToPose(-100,200,rect,-60,60), {heading:0,elevation:-60});
  assert.deepEqual(map.pointToPose(600,-10,rect,-60,60), {heading:360,elevation:60});
  assert.deepEqual(map.poseToPoint({heading:270,elevation:-30},rect,-60,60), {x:310,y:110});
  assert.deepEqual(map.pointToPose(110,20,rect,15,15), {heading:90,elevation:15});
  assert.deepEqual(map.poseToPoint({heading:0,elevation:15},rect,15,15), {x:10,y:80});
});
