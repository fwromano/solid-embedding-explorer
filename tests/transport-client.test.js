// Synthetic worker-message boundary tests (no production load claims).
import test from 'node:test';import assert from 'node:assert/strict';
const mod=await import('../site/transport.js');
function harness(limit=2){const workers=[],progress=[];const factory=()=>{const w={messages:[],postMessage(m){this.messages.push(m);},terminate(){this.terminated=true;},emit(m){this.onmessage({data:m});}};workers.push(w);return w;};const client=mod.createDiagnosticClient({workerFactory:factory,onProgress:p=>progress.push(p),cacheSize:limit});return {client,workers,progress};}
const config=(dimensions=128)=>({build:'build-synthetic',dimensions,rows:[],prefix:{},baseURL:'https://example.test/project/'});
function respond(w,patch={}){const req=w.messages.findLast(m=>m.type==='request');w.emit({...req,type:'result',result:req.endpoint==='warm'?{ready:true}:{query_id:req.id,dimensions:req.dimensions,neighbors:[]},...patch});}
test('one active prefix, same-prefix shared worker, identity checks, abort and retry',async()=>{
 assert.equal(typeof mod.createDiagnosticClient,'function');const h=harness(),c=h.client;
 const a=c.request(config(),'neighbors',7,8),b=c.request(config(),'reference-gallery',42,8);assert.equal(h.workers.length,1);const w=h.workers[0];
 respond(w);assert.equal((await b).query_id,42);w.emit({...w.messages.find(m=>m.endpoint==='neighbors'),type:'result',result:{query_id:7,dimensions:128,neighbors:[]}});await a;
 const bad=c.request(config(),'neighbors',42,8);respond(w,{id:999});await assert.rejects(bad,/identity/i);
 const ctrl=new AbortController(),aborted=c.request(config(),'neighbors',50,8,{signal:ctrl.signal});ctrl.abort();await assert.rejects(aborted,{name:'AbortError'});respond(w);
 const old=c.request(config(),'neighbors',60,8);const rejection=assert.rejects(old,{name:'AbortError'});const next=c.request(config(256),'neighbors',60,8);await rejection;assert.equal(w.terminated,true);respond(w);respond(h.workers[1]);await next;
 const failed=c.request(config(256),'neighbors',70,8);h.workers[1].emit({type:'fatal',build:'build-synthetic',dimensions:256,error:'bad hash'});await assert.rejects(failed,/bad hash/);assert.equal(h.workers[1].terminated,true);
 const retry=c.request(config(256),'neighbors',70,8);respond(h.workers[2]);await retry;c.dispose();
});
test('progress resets the inactivity timeout; silent workers fail and permit retry',async()=>{
 let worker;const progress=[];const client=mod.createDiagnosticClient({timeout:80,onProgress:p=>progress.push(p),workerFactory:()=>worker={messages:[],postMessage(m){this.messages.push(m);},terminate(){this.terminated=true;},emit(m){this.onmessage({data:m});}}});
 const pending=client.request(config(),'neighbors',7);const result=pending.then(x=>x,e=>({error:e.message}));
 await new Promise(r=>setTimeout(r,50));worker.emit({type:'progress',build:'build-synthetic',dimensions:128,phase:'downloading',loaded:5,total:10});
 await new Promise(r=>setTimeout(r,50));respond(worker);assert.equal((await result).query_id,7,'active download must not be timed out');
 const stalled=client.request(config(),'neighbors',42);await assert.rejects(stalled,/timed out/);assert.equal(worker.terminated,true);assert.equal(progress.at(-1).phase,'error');
 const retry=client.request(config(),'neighbors',42);respond(worker);await retry;client.dispose();
});
test('bounded result cache is true LRU, isolated by endpoint, k and prefix; errors are not cached',async()=>{
 assert.equal(typeof mod.createDiagnosticClient,'function');const h=harness(),c=h.client;
 for(const id of [1,2]){const p=c.request(config(),'neighbors',id,8);respond(h.workers[0]);await p;}
 const w=h.workers[0],count=()=>w.messages.filter(m=>m.type==='request').length;
 const n=count();await c.request(config(),'neighbors',1,8);assert.equal(count(),n);
 let p=c.request(config(),'neighbors',3,8);respond(w);await p;
 p=c.request(config(),'neighbors',2,8);assert.equal(count(),n+2);respond(w);await p;
 p=c.request(config(),'neighbors',2,1);assert.equal(count(),n+3);respond(w);await p;
 p=c.request(config(),'reference-gallery',2,1);respond(w,{type:'error',error:'retry me'});await assert.rejects(p,/retry me/);
 p=c.request(config(),'reference-gallery',2,1);assert.equal(count(),n+5);respond(w);await p;c.dispose();
});
