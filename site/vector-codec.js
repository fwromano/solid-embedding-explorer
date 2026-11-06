// Byte-exact little-endian float32 transport, independent of diagnostics math.
export async function sha256(bytes) {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function decodeVectorChunk(encoded,descriptor) {
 if(encoded.byteLength!==descriptor.bytes||await sha256(encoded)!==descriptor.sha256)throw Error('Encoded vector checksum/length mismatch');
 const planes=new Uint8Array(await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
 if(planes.length!==descriptor.raw_bytes||planes.length%4)throw Error('Raw vector length mismatch');
 const raw=new Uint8Array(planes.length),n=raw.length/4;
 for(let p=0;p<4;p++)for(let i=0;i<n;i++)raw[4*i+p]=planes[p*n+i];
 if(await sha256(raw)!==descriptor.raw_sha256)throw Error('Raw vector checksum mismatch');
 const view=new DataView(raw.buffer),values=new Float32Array(n);
 for(let i=0;i<n;i++){values[i]=view.getFloat32(4*i,true);if(!Number.isFinite(values[i]))throw Error('Nonfinite vectors');}
 return values;
}
export function validatePrefix(prefix,dimension,count) {
 if(!prefix||![128,256,512,768].includes(dimension)||prefix.dimension!==dimension||prefix.count!==count||!Number.isSafeInteger(count)||count<1||prefix.dtype!=='<f4'||!/^[a-f0-9]{64}$/.test(prefix.raw_sha256)||!Array.isArray(prefix.chunks)||!prefix.chunks.length)throw Error('Invalid vector prefix');
 let start=0;
 for(const c of prefix.chunks){
  if(!c||c.start!==start||!Number.isSafeInteger(c.count)||c.count<1||c.raw_bytes!==c.count*dimension*4||!Number.isSafeInteger(c.bytes)||c.bytes<1||!/^[a-f0-9]{64}$/.test(c.sha256)||!/^[a-f0-9]{64}$/.test(c.raw_sha256)||c.path!==`vectors/${dimension}/${c.sha256}.bin.gz`)throw Error('Invalid vector chunk coverage or descriptor');
  start+=c.count;if(start>count)throw Error('Vector chunk coverage overflow');
 }
 if(start!==count)throw Error('Incomplete vector chunk coverage');
 return prefix;
}
