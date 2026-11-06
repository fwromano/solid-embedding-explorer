// Bounded synthetic two-row chunks; no real dataset or timing claim.
import test from 'node:test';import assert from 'node:assert/strict';import {gzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
const worker=await import('../site/diagnostics-worker.js').catch(()=>({}));
const hash=b=>createHash('sha256').update(b).digest('hex');
import {syntheticPrefix} from '../site/tests/transport-fixtures.js';
test('worker loads strict chunks once, reports byte progress and computes actual pure-math routes',async()=>{
 assert.equal(typeof worker.createWorkerHandler,'function');const f=syntheticPrefix(),messages=[],calls=[];
 const handle=worker.createWorkerHandler({postMessage:m=>messages.push(m),nativeFetch:async url=>{calls.push(url);return new Response(f.data.get(url));}});
 await handle({type:'init',...f.config});
 await Promise.all(['neighbors','reference','reference-gallery'].map((endpoint,i)=>handle({type:'request',requestId:i+1,build:f.config.build,dimensions:128,endpoint,id:7,k:8})));
 const results=messages.filter(m=>m.type==='result');assert.equal(results.length,3);assert.equal(calls.length,2);
 assert.equal(results.find(m=>m.endpoint==='neighbors').result.neighbors[0].id,42);
 assert.equal(results.find(m=>m.endpoint==='reference').result.cosine,1);
 assert.equal(messages.filter(m=>m.type==='progress').at(-1).phase,'ready');
 assert.equal(messages.filter(m=>m.type==='progress').at(-1).loaded,f.prefix.chunks.reduce((n,c)=>n+c.bytes,0));
});
test('worker reports streamed byte progress before each chunk finishes',async()=>{
 const f=syntheticPrefix(),messages=[];const handle=worker.createWorkerHandler({postMessage:m=>messages.push(m),nativeFetch:async url=>{const bytes=f.data.get(url);return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,5));controller.enqueue(bytes.subarray(5));controller.close();}}));}});
 await handle({type:'init',...f.config});await handle({type:'request',requestId:1,build:f.config.build,dimensions:128,endpoint:'warm',id:null});
 assert.ok(messages.some(m=>m.type==='progress'&&m.phase==='downloading'&&m.loaded===5));
});
test('worker rejects wrong identity/endpoint, suppresses cancelled requests and fails corrupt chunks closed',async()=>{
 const f=syntheticPrefix(),messages=[];let release;const held=new Promise(r=>release=r);
 const handle=worker.createWorkerHandler({postMessage:m=>messages.push(m),nativeFetch:async url=>{await held;return new Response(f.data.get(url));}});
 await handle({type:'init',...f.config});
 const req={type:'request',requestId:1,build:f.config.build,dimensions:128,endpoint:'neighbors',id:7,k:8};
 const pending=handle(req);await handle({type:'cancel',requestId:1});release();await pending;
 assert.ok(!messages.some(m=>m.type==='result'&&m.requestId===1));
 for(const patch of [{build:'wrong'},{dimensions:256},{endpoint:'bogus'}]){await handle({...req,...patch,requestId:2});assert.equal(messages.at(-1).type,'error');}
 for(const mutate of [x=>x.prefix.chunks[0].start=1,x=>x.prefix.raw_sha256='0'.repeat(64),x=>x.data.set([...x.data.keys()][0],new Uint8Array([1,2]))]){
  const bad=syntheticPrefix();mutate(bad);const out=[];const h=worker.createWorkerHandler({postMessage:m=>out.push(m),nativeFetch:async url=>new Response(bad.data.get(url))});await h({type:'init',...bad.config});await h(req);assert.ok(out.some(m=>m.type==='fatal'));assert.ok(!out.some(m=>m.type==='result'));
 }
});
