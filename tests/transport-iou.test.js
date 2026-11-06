// Synthetic mask fetch/decoder boundary. Native browser decode is tested separately.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {syntheticTransport} from '../site/tests/transport-fixtures.js';import {createStaticTransport} from '../site/transport.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function setup(){const f=syntheticTransport(),samples=[new Uint8Array([0,128,255,64]),new Uint8Array([0,255,128,0])];
 const bytes=samples.map((_,i)=>Buffer.from('SYNTHETIC decoder boundary '+i));for(let i=0;i<2;i++){f.rows[i].mask_asset=`media/${hash(bytes[i])}.png`;f.files.set(f.base+f.rows[i].mask_asset,bytes[i]);}
 const raw=Buffer.from(JSON.stringify(f.catalog)),encoded=gzipSync(raw),d=f.manifest.files[f.current.catalog_url];Object.assign(d,{bytes:encoded.length,raw_bytes:raw.length,sha256:hash(encoded),raw_sha256:hash(raw)});f.files.set(f.base+d.path,encoded);
 const maskDecoder=async data=>({width:2,height:2,samples:samples[bytes.findIndex(b=>b.equals(Buffer.from(data))) ]});return {...f,bytes,samples,maskDecoder};}
const route='/api/iou?build=build-synthetic&id=7&other=42';
test('IoU verifies native PNG hash, compares helper samples, checks shape, and never loads vectors',async()=>{
 const f=setup(),t=createStaticTransport({...f.options,maskDecoder:f.maskDecoder,workerFactory:()=>{throw Error('IoU must not load vectors');}});
 const response=await t.fetchStatic(route);assert.equal(response.status,200);const value=await response.json();assert.equal(value.binary_iou,1);assert.equal(value.soft_iou,256/574);assert.equal(value.id,7);assert.equal(value.other,42);
 assert.equal((await t.fetchStatic(route.replace('other=42','other=999'))).status,404);
 assert.equal((await t.fetchStatic(route.replace('other=42','other=-1'))).status,400);
 const media=await t.fetchStatic(f.rows[0].mask);assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),f.bytes[0]);
 assert.equal((await t.fetchStatic('/api/iou?build=build-synthetic&id=%37&other=42')).status,200);
 const mismatch=createStaticTransport({...f.options,maskDecoder:async data=>({...await f.maskDecoder(data),width:Buffer.from(data).equals(f.bytes[0])?1:2,height:Buffer.from(data).equals(f.bytes[0])?4:2})});assert.equal((await mismatch.fetchStatic(route)).status,503);
 const bad=setup();bad.files.set(bad.base+bad.rows[0].mask_asset,Buffer.from('corrupt'));assert.equal((await createStaticTransport({...bad.options,maskDecoder:bad.maskDecoder}).fetchStatic(route)).status,503);
});
