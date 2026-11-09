import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {sourceId} from '../symmetry.js';
const app=await import('../app.js').catch(()=>({}));
const source=await readFile(new URL('../app.js',import.meta.url),'utf8');

// Run the actual inspector functions with a small DOM and HTTP boundary, not
// a second implementation of their loading/selection logic.
class Element {
 constructor(){this.children=[];this.dataset={};this.hidden=false;this.attributes={};this.text='';}
 set textContent(value){this.text=value;this.children=[];}
 get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.text='';this.children=[...children];}
 setAttribute(key,value){this.attributes[key]=value;}
 removeAttribute(key){delete this.attributes[key];delete this[key];}
}
function diagnosticsHarness(respond=()=>null,alias=false){
 const elements=new Map(),requests=[],rows=[1931,1932,1933].map(id=>({id,image:`/${id}.png`,heading:id-1931,elevation:0,color:'red',shape:'cube'}));
 const state={selectedId:1931,dimensions:768},catalog={build_id:'build-test'};
 if(alias){rows.push({id:9000,heading:180,elevation:0,shape:'cube',color:'red',symmetry_source:rows[0]});state.selectedId=9000;}
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const context=vm.createContext({$,state,catalog,sourceId,byId:new Map(rows.map(row=>[row.id,row])),selected:()=>rows.find(row=>row.id===state.selectedId),
  assetURL:value=>value,document:{createElement:()=>new Element()},AbortController,neighborVersion:0,iouVersion:0,neighborsAbort:null,neighborTimer:0,playing:false,errorStatus:null,imageError:null,diagnosticErrors:new Map(),
  clearTimeout(){},setTimeout(){return 1;},stop(){},changed(){},selectRow(id){state.selectedId=id;},apiURL:app.apiURL,
  requestJSON:(url,options)=>app.requestJSON(url,options,async(url,options)=>{
   const parsed=new URL(url,'http://local'),endpoint=parsed.pathname.split('/').pop(),id=Number(parsed.searchParams.get('id'));
   requests.push({endpoint,signal:options.signal,id});
   const override=await respond(endpoint,id,options);
   if(override)return override;
   const data=endpoint==='iou'?{id,other:Number(parsed.searchParams.get('other')),binary_iou:.9,soft_iou:.8}:
    {query_id:id,dimensions:Number(parsed.searchParams.get('dimensions')),reference_id:1933,cosine:.95,neighbors:[{id:1933,cosine:.95}]};
   return {ok:true,json:async()=>data};
  })});
 vm.runInContext(source.slice(source.indexOf('  function scheduleNeighbors()'),source.indexOf('  function mountMatrix()'))+'\n'+source.slice(source.indexOf('function node('),source.indexOf('function hexRGB(')),context);
 return {context,$,state,catalog,requests,load:()=>context.loadNeighbors(),schedule:()=>context.scheduleNeighbors(),
  error:()=>vm.runInContext('({'+source.match(/get errorStatus\(\)\{[^}]+\}/)[0]+'}).errorStatus',context)};
}

test('reference-only HTTP 503 preserves healthy global neighbors, IoU and gallery',async()=>{
 const h=diagnosticsHarness(endpoint=>endpoint==='reference'?{ok:false,status:503,text:async()=> 'reference offline'}:null);
 h.schedule();await h.load();
 assert.equal(h.$('neighbors').children.length,1,'healthy neighbors must render');
 assert.equal(h.$('reference-gallery').children.length,1,'healthy gallery must render');
 assert.match(h.$('reference-score').textContent,/unavailable.*503/);
 await h.$('neighbors').children[0].children[2].onclick();
 assert.match(h.$('iou-result').textContent,/Source rows 1931 ↔ 1933: binary IoU 0.9000/);
 assert.deepEqual(h.requests.map(r=>r.endpoint),['neighbors','reference','reference-gallery','iou']);
});

test('symmetry view diagnostics and IoU use the measured source row ID',async()=>{
 const h=diagnosticsHarness(()=>null,true);
 h.schedule();await h.load();await h.context.compareIoU(9000);
 assert.deepEqual(h.requests.map(request=>request.id),[1931,1931,1931,1931]);
 assert.equal(h.state.selectedId,9000);
 assert.equal(h.$('reference-score').dataset.queryId,'1931');
 assert.match(h.$('iou-result').textContent,/Source rows 1931 ↔ 1931/);
 assert.equal(h.error(),null);
});

test('selection changes clear stale reference identity, cosine and link before failure or recovery',async()=>{
 let failing=false;
 const h=diagnosticsHarness(endpoint=>failing&&endpoint==='reference'?{ok:false,status:503,text:async()=> 'reference offline'}:null);
 h.schedule();await h.load();
 assert.equal(h.$('reference-score').dataset.queryId,'1931');
 assert.equal(h.$('reference-source').href,'/1933.png');
 failing=true;h.state.selectedId=1932;h.schedule();
 assert.deepEqual(h.$('reference-score').dataset,{},'no prior reference metadata while loading another row');
 assert.equal(h.$('reference-source').href,undefined);
 assert.equal(h.$('reference-source').hidden,true);
 assert.equal(h.$('neighbors').children.length,0);
 assert.equal(h.$('reference-gallery').children.length,0);
 await h.load();
 assert.deepEqual(h.$('reference-score').dataset,{});
 assert.equal(h.$('reference-source').href,undefined);
 failing=false;h.schedule();await h.load();
 assert.equal(h.$('reference-score').dataset.queryId,'1932');
 assert.equal(h.$('reference-source').hidden,false);
});

test('reference failure on a same-row retry clears only its stale metadata and source link',async()=>{
 let failing=false;
 const h=diagnosticsHarness(endpoint=>failing&&endpoint==='reference'?{ok:false,status:503,text:async()=> 'reference offline'}:null);
 h.schedule();await h.load();
 assert.equal(h.$('reference-score').dataset.queryId,'1931');
 failing=true;await h.load();
 assert.deepEqual(h.$('reference-score').dataset,{});
 assert.equal(h.$('reference-source').hidden,true);
 assert.equal(h.$('reference-source').href,undefined);
 assert.equal(h.$('neighbors').children.length,1);
 assert.equal(h.$('reference-gallery').children.length,1);
});

test('successful diagnostic retries clear their own error without hiding another failure or unrelated error',async()=>{
 const failing=new Set(['reference','reference-gallery']);
 const h=diagnosticsHarness(endpoint=>failing.has(endpoint)?{ok:false,status:503,text:async()=>endpoint+' offline'}:null);
 h.schedule();await h.load();
 assert.match(h.error(),/reference-gallery.*503/);
 failing.delete('reference-gallery');await h.load();
 assert.match(h.error(),/\/api\/reference\?.*503/,'healthy gallery must not hide the remaining reference error');
 failing.clear();await h.load();
 assert.equal(h.error(),null,'a successful retry clears the current diagnostic error');
 failing.add('neighbors');await h.load();assert.match(h.error(),/neighbors.*503/);
 h.context.errorStatus='Status unavailable: offline';
 failing.clear();await h.load();
 assert.equal(h.error(),'Status unavailable: offline','diagnostic recovery must not erase an unrelated error');
});

test('changing or clearing selection discards diagnostics errors from the old row',async()=>{
 for(const clear of [false,true]){
  const h=diagnosticsHarness(endpoint=>endpoint==='reference'?{ok:false,status:503,text:async()=> 'reference offline'}:null);
  h.schedule();await h.load();assert.match(h.error(),/503/);
  if(clear){
   Object.assign(h.context,{selectionGate:{cancel(){}},visible:[],pendingId:null,scheduleMarker(){}});
   vm.runInContext(source.slice(source.indexOf('  function clearSelection()'),source.indexOf('  async function loadImage(')),h.context);
   h.context.clearSelection();
  }else{h.state.selectedId=1932;h.schedule();}
  assert.equal(h.error(),null,'old-row diagnostic errors must not describe the new selection');
 }
});

test('successful IoU retry clears only the IoU error and preserves a reference outage',async()=>{
 const failing=new Set(['reference','iou']);
 const h=diagnosticsHarness(endpoint=>failing.has(endpoint)?{ok:false,status:503,text:async()=>endpoint+' offline'}:null);
 h.schedule();await h.load();await h.context.compareIoU(1933);
 assert.match(h.error(),/iou.*503/);
 failing.delete('iou');await h.context.compareIoU(1933);
 assert.match(h.$('iou-result').textContent,/binary IoU 0.9000/);
 assert.match(h.error(),/reference.*503/);
 failing.clear();await h.load();assert.equal(h.error(),null);
});

test('late IoU success and failure cannot commit across row, build or request-version changes',async()=>{
 for(const invalidation of ['row','build','version'])for(const failure of [false,true]){
  let release;const held=new Promise(resolve=>release=resolve);
  const h=diagnosticsHarness(async endpoint=>{if(endpoint==='iou'){await held;return failure?{ok:false,status:503,text:async()=> 'old IoU failure'}:null;}});
  const pending=h.context.compareIoU(1933);
  if(invalidation==='row')h.state.selectedId=1932;
  if(invalidation==='build')h.catalog.build_id='new-build';
  if(invalidation==='version')h.context.iouVersion++;
  release();await pending;
  assert.equal(h.$('iou-result').textContent,'Comparing source masks…');
  assert.equal(h.error(),null);
 }
});

test('each list validates all entries before committing any rows',async()=>{
 for(const endpoint of ['neighbors','reference-gallery']){
  const h=diagnosticsHarness(name=>name===endpoint?{ok:true,json:async()=>({query_id:1931,dimensions:768,neighbors:[{id:1933,cosine:.95},{id:9999,cosine:.9}]})}:null);
  let committed=0;const panel=h.$(endpoint),append=panel.append.bind(panel);panel.append=(...items)=>{committed+=items.length;append(...items);};
  h.schedule();await h.load();
  assert.equal(committed,0,`${endpoint} must validate the full response before a DOM commit`);
  assert.match(panel.textContent,/unavailable/);
  assert.equal(h.$(endpoint==='neighbors'?'reference-gallery':'neighbors').children.length,1);
  assert.equal(h.$('reference-score').dataset.queryId,'1931');
 }
});

test('late success and failure cannot commit across row, build, prefix, request-version or abort changes',async()=>{
 for(const invalidation of ['row','build','prefix','version','abort'])for(const failure of [false,true]){
  let release;const held=new Promise(resolve=>release=resolve);
  const h=diagnosticsHarness(async()=>{await held;return failure?{ok:false,status:503,text:async()=> 'old failure'}:null;});
  h.schedule();const pending=h.load();
  if(invalidation==='row')h.state.selectedId=1932;
  if(invalidation==='build')h.catalog.build_id='new-build';
  if(invalidation==='prefix')h.state.dimensions=128;
  if(invalidation==='abort')h.context.neighborsAbort.abort();
  if(invalidation==='version'){h.schedule();assert.ok(h.requests.every(request=>request.signal.aborted));}
  release();await pending;
  assert.equal(h.$('neighbors').children.length,0,`${invalidation}: no stale neighbors`);
  assert.equal(h.$('reference-gallery').children.length,0,`${invalidation}: no stale gallery`);
  assert.deepEqual(h.$('reference-score').dataset,{},`${invalidation}: no stale reference metadata`);
  assert.doesNotMatch(h.$('reference-score').textContent,/unavailable/,`${invalidation}: no stale error`);
  assert.equal(h.error(),null);
 }
});

test('clearing selection removes the old reference link as well as diagnostic metadata',async()=>{
 const h=diagnosticsHarness();h.schedule();await h.load();
 Object.assign(h.context,{selectionGate:{cancel(){}},visible:[],pendingId:null,scheduleMarker(){}});
 vm.runInContext(source.slice(source.indexOf('  function clearSelection()'),source.indexOf('  async function loadImage(')),h.context);
 h.context.clearSelection();
 assert.equal(h.state.selectedId,null);
 assert.deepEqual(h.$('reference-score').dataset,{});
 assert.equal(h.$('reference-source').href,undefined);
 assert.equal(h.$('reference-source').hidden,true);
 assert.equal(h.$('neighbors').children.length,0);
 assert.equal(h.$('reference-gallery').children.length,0);
 assert.ok(h.requests.every(request=>request.signal.aborted));
});

test('healthy panels commit before a delayed reference settles',async()=>{
 let release;const held=new Promise(resolve=>release=resolve);
 const h=diagnosticsHarness(async endpoint=>{if(endpoint==='reference')await held;});
 h.schedule();const pending=h.load();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.$('neighbors').children.length,1);
 assert.equal(h.$('reference-gallery').children.length,1);
 assert.deepEqual(h.$('reference-score').dataset,{});
 release();await pending;assert.equal(h.$('reference-score').dataset.queryId,'1931');
});

test('each endpoint rejects mismatched response identities without hiding the other panels',async()=>{
 for(const endpoint of ['neighbors','reference','reference-gallery'])for(const mismatch of ['query_id','dimensions']){
  const h=diagnosticsHarness(name=>name===endpoint?{ok:true,json:async()=>({query_id:1931,dimensions:768,reference_id:1933,cosine:.95,neighbors:[{id:1933,cosine:.95}],[mismatch]:-1})}:null);
  h.schedule();await h.load();
  const panel=endpoint==='reference'?'reference-score':endpoint;
  assert.match(h.$(panel).textContent,/unavailable.*does not match/);
  for(const other of ['neighbors','reference-gallery'].filter(other=>other!==endpoint))assert.equal(h.$(other).children.length,1);
  if(endpoint!=='reference')assert.equal(h.$('reference-score').dataset.queryId,'1931');
  else assert.deepEqual(h.$('reference-score').dataset,{});
 }
});

function refreshHarness(respond=async()=>{throw Error('HTTP 503: missing current.json');}) {
 const elements=new Map(),requests=[],errors=[];
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const refreshTag=html.match(/<button\b[^>]*\bid="refresh"[^>]*>/)[0];
 $('refresh').disabled=/\bdisabled\b/.test(refreshTag);
 $('refresh').textContent=html.match(/id="refresh"[^>]*>([^<]*)/)[1];
 const context=vm.createContext({$,onDiagnosticsProgress(){},number:String,createSelectionGate:app.createSelectionGate,needsBuildReload:app.needsBuildReload,
  document:{querySelector:()=>({inert:true}),body:{dataset:{}}},ctx:{clearRect(){}},marker:{clearRect(){}},
  stop(){},clearError(){},clearTimeout(){},setTimeout(){return 1;},fail(error,scope){errors.push({error:error.message,scope});},
  requestJSON:async(url,options)=>{requests.push({url,options});return respond(url,options);}});
 vm.runInContext(source.slice(source.indexOf('  let catalog='),source.indexOf('  const plot='))+'\n'+
  source.slice(source.indexOf('  async function loadBuild()'),source.indexOf('  function zoomAt(')),context);
 return {context,$,requests,errors};
}
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('refresh is gated before startup and stays gated when the initial pointer is missing',async()=>{
 const h=refreshHarness();
 assert.equal(h.$('refresh').disabled,true,'HTML must gate refresh before JavaScript or capabilities load');
 assert.equal(h.$('refresh').textContent,'Refresh gated');
 await h.context.loadBuild();
 assert.equal(h.$('refresh').disabled,true);
 assert.deepEqual(h.requests.map(r=>r.url),['/data/current.json']);
 assert.match(h.errors[0].error,/503/);
 assert.match(h.$('coverage').textContent,/No substitute data/);
});

test('coverage enables refresh only for an explicit true capability and retains known false',()=>{
 const h=refreshHarness(),status={count:5,expected_count:5,complete:true};
 h.context.updateCoverage(status);
 assert.equal(h.$('refresh').disabled,true,'missing capability is not permission');
 h.context.updateCoverage({...status,refresh_supported:false});
 h.context.updateCoverage(status);
 assert.equal(h.$('refresh').disabled,true,'build metadata must not erase the known false capability');
 assert.equal(h.$('refresh').textContent,'Refresh gated');
 h.context.updateCoverage({...status,refresh_supported:true});
 assert.equal(h.$('refresh').disabled,false,'explicit supported idle status remains usable');
 h.context.updateCoverage({...status,refreshing:true});
 assert.equal(h.$('refresh').disabled,true,'an active refresh stays disabled');
});

test('status failures cannot enable refresh after false or unknown capability',async()=>{
 for(const knownFalse of [false,true]){
  let failing=false;
  const h=refreshHarness(async()=>{if(failing)throw Error('HTTP 503: status offline');return {count:5,expected_count:5,refresh_supported:false};});
  if(knownFalse)await h.context.checkStatus();
  failing=true;await h.context.checkStatus();
  assert.equal(h.$('refresh').disabled,true);
  assert.equal(h.$('refresh').textContent,'Refresh gated');
  assert.equal(h.errors.at(-1).scope,'Status unavailable');
 }
});

test('refresh rejection cannot enable refresh after false or unknown capability',async()=>{
 for(const knownFalse of [false,true]){
  const h=refreshHarness(async()=>{throw Error('HTTP 409: expanded refresh gated');});
  if(knownFalse)h.context.updateCoverage({count:5,expected_count:5,refresh_supported:false});
  await h.context.refresh();
  assert.equal(h.$('refresh').disabled,true);
  assert.equal(h.$('refresh').textContent,'Refresh gated');
  assert.equal(h.errors.at(-1).scope,'Refresh failed');
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].url,'/api/refresh');
  assert.equal(h.requests[0].options.method,'POST');
 }
});

test('status triggers build recovery only after export is idle',()=>{
 assert.equal(typeof app.needsBuildReload,'function');
 assert.equal(app.needsBuildReload(null,{build_id:'b',refreshing:false}),true);
 assert.equal(app.needsBuildReload('a',{build_id:'b',refreshing:true}),false);
 assert.equal(app.needsBuildReload('a',{build_id:'b',refreshing:false}),true);
 assert.equal(app.needsBuildReload('a',{build_id:'a',refreshing:false}),false);
});

test('API requests use exact contract parameters and expose HTTP/JSON failures',async()=>{
 assert.equal(typeof app.apiURL,'function');
 assert.equal(app.apiURL('neighbors',{build:'b1',id:401,dimensions:128,k:8}),'/api/neighbors?build=b1&id=401&dimensions=128&k=8');
 assert.equal(app.apiURL('iou',{build:'b1',id:401,other:900}),'/api/iou?build=b1&id=401&other=900');
 assert.deepEqual(await app.requestJSON('/api/status',{},async()=>({ok:true,json:async()=>({count:5})})),{count:5});
 await assert.rejects(app.requestJSON('/api/status',{},async()=>({ok:false,status:503,text:async()=> 'Not exported'})),/503.*Not exported/);
});

test('selection commits only matching loaded image; stale image loads cannot change the selected row',async()=>{
 assert.equal(typeof app.createSelectionGate,'function');
 const gate=app.createSelectionGate();const commits=[];let resolve;
 const first=gate.run(100,()=>new Promise(r=>resolve=r),(id,value)=>commits.push([id,value]));
 await gate.run(220,async()=> 'image220',(id,value)=>commits.push([id,value]));
 resolve('image100');await first;
 assert.deepEqual(commits,[[220,'image220']]);
 const pending=gate.run(300,()=>new Promise(r=>resolve=r),(id,value)=>commits.push([id,value]));
 gate.cancel();resolve('image300');await pending;assert.equal(commits.length,1);
});

test('late image failures cannot override a newer preview for the same row',async()=>{
 for(const cancel of [false,true]){
  const gate=app.createSelectionGate();let reject;const commits=[];
  const stale=gate.run(7,()=>new Promise((_,fail)=>reject=fail),(id,image)=>commits.push(image));
  if(cancel)gate.cancel();else await gate.run(7,async()=> 'new RGB',(id,image)=>commits.push(image));
  reject(Error('old mask failed'));assert.equal(await stale,false);
  assert.deepEqual(commits,cancel?[]:['new RGB']);
 }
 const gate=app.createSelectionGate();
 await assert.rejects(gate.run(7,async()=>{throw Error('current image failed');},()=>assert.fail('must not commit')),/current image failed/);
});
