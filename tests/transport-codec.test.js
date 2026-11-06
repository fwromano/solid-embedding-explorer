// Strictly synthetic bounded fixtures; no production vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const codec=await import('../site/vector-codec.js').catch(()=>({}));
const hash=b=>createHash('sha256').update(b).digest('hex');
export function fixture(values=new Float32Array([1,-0,1/3,-7.25])) {
 const raw=new Uint8Array(values.buffer),planes=new Uint8Array(raw.length);
 for(let p=0;p<4;p++)for(let i=0;i<values.length;i++)planes[p*values.length+i]=raw[4*i+p];
 const encoded=gzipSync(planes);
 return {raw,encoded,descriptor:{bytes:encoded.length,raw_bytes:raw.length,sha256:hash(encoded),raw_sha256:hash(raw)}};
}
test('synthetic codec reverses four byte planes bit-exactly and verifies both hashes',async()=>{
 assert.equal(typeof codec.decodeVectorChunk,'function');
 const f=fixture();const decoded=await codec.decodeVectorChunk(f.encoded,f.descriptor);
 assert.deepEqual(new Uint8Array(decoded.buffer),f.raw);
});
test('codec rejects encoded/raw corruption, wrong sizes and nonfinite values',async()=>{
 const f=fixture();
 for(const bad of [{sha256:'0'.repeat(64)},{raw_sha256:'0'.repeat(64)},{bytes:1},{raw_bytes:3}])await assert.rejects(codec.decodeVectorChunk(f.encoded,{...f.descriptor,...bad}));
 for(const value of [NaN,Infinity,-Infinity]){const x=fixture(new Float32Array([value]));await assert.rejects(codec.decodeVectorChunk(x.encoded,x.descriptor),/finite/i);}
});
test('prefix descriptors require exact contiguous coverage, sizes and allowed dimensions',()=>{
 assert.equal(typeof codec.validatePrefix,'function');
 const f=fixture(new Float32Array(128)),chunk={...f.descriptor,start:0,count:1,path:'vectors/128/'+f.descriptor.sha256+'.bin.gz'};
 const prefix={dimension:128,count:1,dtype:'<f4',raw_sha256:hash(f.raw),chunks:[chunk]};
 assert.equal(codec.validatePrefix(prefix,128,1),prefix);
 for(const mutate of [p=>p.dimension=256,p=>p.count=2,p=>p.dtype='>f4',p=>p.chunks=[],p=>p.chunks[0].start=1,p=>p.chunks[0].count=2,p=>p.chunks[0].raw_bytes=4,p=>p.chunks.push({...chunk}),p=>p.chunks[0].path='../escape.gz']){
  const p=structuredClone(prefix);mutate(p);assert.throws(()=>codec.validatePrefix(p,128,1));
 }
});
