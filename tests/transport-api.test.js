import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticTransport} from '../site/tests/transport-fixtures.js';import {syntheticPrefix} from '../site/tests/transport-fixtures.js';
import {createStaticTransport} from '../site/transport.js';import {createWorkerHandler} from '../site/diagnostics-worker.js';
// Synthetic in-process worker boundary runs the actual handler and math.
function setup(){const f=syntheticTransport(),p=syntheticPrefix(),workers=[];f.manifest.vectors['128']=p.prefix;for(const [url,data] of p.data)f.files.set(url,data);
 const workerFactory=()=>{const w={postMessage:m=>{queueMicrotask(()=>handle(m));},terminate(){this.terminated=true;}};const handle=createWorkerHandler({postMessage:m=>{if(!w.terminated)queueMicrotask(()=>w.onmessage({data:m}));},nativeFetch:f.options.nativeFetch});workers.push(w);return w;};return {...f,workers,t:createStaticTransport({...f.options,workerFactory})};}
const route=(endpoint='neighbors',extra='')=>`/api/${endpoint}?build=build-synthetic&id=7&dimensions=128${extra}`;
test('API neighbors/reference/gallery run from one shared exact-prefix worker; status is vector-lazy',async()=>{
 const f=setup();await f.t.fetchStatic('/api/status');assert.equal(f.workers.length,0);
 const results=await Promise.all(['neighbors','reference','reference-gallery'].map(e=>f.t.fetchStatic(route(e))));
 for(const r of results)assert.equal(r.status,200);assert.equal(f.workers.length,1);
 const [n,r,g]=await Promise.all(results.map(r=>r.json()));assert.equal(n.neighbors[0].id,42);assert.equal(r.reference_id,7);assert.equal(g.neighbors.length,1);f.t.dispose();
});
test('API rejects malformed/duplicate/unknown fields, invalid integers/builds/ids and disallowed methods',async()=>{
 const f=setup();
 for(const url of [route('neighbors','&k=0'),route('neighbors','&k=-1'),route('neighbors','&k=1e2'),route('neighbors','&k=1000000000'),route('neighbors','&id=7'),route('neighbors','&extra=1'),route('neighbors','?ignored=1'),route('reference','&k=8'),route().replace('id=7','id='),route().replace('id=7','id=1.5'),route().replace('dimensions=128','dimensions=129'),route().replace('build=build-synthetic','build=-bad')])assert.equal((await f.t.fetchStatic(url)).status,400,url);
 for(const url of [route().replace('id=7','id=8'),route().replace('build=build-synthetic','build=missing')])assert.equal((await f.t.fetchStatic(url)).status,404,url);
 assert.equal((await f.t.fetchStatic('/api/status',{method:'POST'})).status,405);assert.equal((await f.t.fetchStatic('/api/status?bad=1')).status,400);assert.equal(f.workers.length,0);f.t.dispose();
});
