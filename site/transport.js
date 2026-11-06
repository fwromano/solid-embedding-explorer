import {sha256,validatePrefix} from './vector-codec.js';
import {maskIoU} from './diagnostics.js';
const DEFAULT_BASE=new URL('.',import.meta.url);
const errorResponse=(error,status=503)=>Response.json({error:error.message||String(error)},{status});
const abortError=()=>new DOMException('Request cancelled','AbortError');
export function withAbort(promise,signal){
 if(!signal)return promise;
 if(signal.aborted)return Promise.reject(abortError());
 return new Promise((resolve,reject)=>{const abort=()=>reject(abortError());signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
const HASH=/^[a-f0-9]{64}$/;
function validateManifest(m,base){
 if(!m||m.schema!=='solids-static-v1'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(m.build_id)||!Number.isSafeInteger(m.count)||m.count<1||!HASH.test(m.source_catalog_sha256)||!m.files||!m.vectors)throw Error('Invalid deployment manifest');
 for(const [virtual,d] of Object.entries(m.files)){
  if(!virtual.startsWith('/data/')||!d||!['gzip','identity'].includes(d.encoding)||!HASH.test(d.sha256)||!HASH.test(d.raw_sha256)||!Number.isSafeInteger(d.bytes)||d.bytes<1||!Number.isSafeInteger(d.raw_bytes)||d.raw_bytes<1)throw Error('Invalid file descriptor');
  safeAssetURL(virtual.slice(1),base);safeAssetURL(d.path,base);
 }
}

export function safeAssetURL(path,baseURL=DEFAULT_BASE){
 if(typeof path!=='string'||!path||path.startsWith('/')||/[^A-Za-z0-9_./+-]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe asset path');
 const base=new URL(baseURL),url=new URL(path,base);
 if(url.origin!==base.origin||!url.href.startsWith(base.href))throw Error('Asset escapes deployment base');
 return url.href;
}
export async function decodeNativeMask(bytes){
 const signature=[137,80,78,71,13,10,26,10];
 if(bytes.length<33||signature.some((v,i)=>bytes[i]!==v)||bytes[24]!==8||bytes[25]!==0)throw Error('Mask must be native 8-bit grayscale PNG');
 const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=header.getUint32(16),height=header.getUint32(20);
 if(!width||!height||width*height>16777216)throw Error('Invalid native mask dimensions');
 const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
 try{
  if(bitmap.width!==width||bitmap.height!==height)throw Error('Native PNG dimensions differ');
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);
  const rgba=context.getImageData(0,0,width,height).data,samples=new Uint8Array(width*height);
  for(let i=0;i<samples.length;i++){if(rgba[4*i]!==rgba[4*i+1]||rgba[4*i]!==rgba[4*i+2]||rgba[4*i+3]!==255)throw Error('Mask is not opaque grayscale');samples[i]=rgba[4*i];}
  return {width,height,samples};
 }finally{bitmap.close();}
}
export function createStaticTransport({baseURL=DEFAULT_BASE,nativeFetch=(...args)=>globalThis.fetch(...args),workerFactory,maskDecoder=decodeNativeMask}={}){
 let manifest,current,catalog,initializing,initialized=false;const media=new Map(),listeners=new Set();
 const client=createDiagnosticClient({workerFactory,onProgress:p=>{for(const fn of listeners)fn(p);}});
 async function readFile(virtual){
  const d=manifest.files[virtual];if(!d)throw Error('Unknown static asset');
  const response=await nativeFetch(safeAssetURL(d.path,baseURL),{redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error(`Asset HTTP ${response.status}`);
  const encoded=new Uint8Array(await response.arrayBuffer());
  if(encoded.length!==d.bytes||await sha256(encoded)!==d.sha256)throw Error('Encoded asset checksum/length mismatch');
  const raw=d.encoding==='gzip'?new Uint8Array(await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()):encoded;
  if(raw.length!==d.raw_bytes||await sha256(raw)!==d.raw_sha256)throw Error('Raw asset checksum/length mismatch');
  return raw;
 }
 async function initialize(){
  if(!initializing)initializing=(async()=>{
   const response=await nativeFetch(safeAssetURL('deployment.json',baseURL),{redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error(`Deployment HTTP ${response.status}`);
   manifest=await response.json();validateManifest(manifest,baseURL);
   current=JSON.parse(new TextDecoder().decode(await readFile('/data/current.json')));
   if(current.schema!=='solids-explorer-v1'||current.build_id!==manifest.build_id||current.count!==manifest.count||current.catalog_url!==`/data/${manifest.build_id}/catalog.json`||!Number.isSafeInteger(current.expected_count)||current.expected_count<current.count||current.complete!==(current.count===current.expected_count))throw Error('Current manifest binding mismatch');
   catalog=JSON.parse(new TextDecoder().decode(await readFile(current.catalog_url)));
   if(catalog.schema!=='solids-explorer-v1'||catalog.build_id!==manifest.build_id||catalog.count!==manifest.count||!Array.isArray(catalog.rows)||catalog.rows.length!==manifest.count||new Set(catalog.rows.map(r=>r.id)).size!==catalog.rows.length)throw Error('Catalog binding mismatch');
   media.clear();
   for(const row of catalog.rows){
    if(!Number.isSafeInteger(row.id)||row.id<0)throw Error('Invalid row ID');
    for(const kind of ['image','mask']){
     const path=row[kind+'_asset'];if(typeof row[kind]!=='string'||!row[kind].startsWith('/dataset/')||!new RegExp('^media/[a-f0-9]{64}\\.'+(kind==='mask'?'png':'webp')+'$').test(path))throw Error('Invalid row media mapping');
     safeAssetURL(row[kind].slice(1),baseURL);safeAssetURL(path,baseURL);
     if(media.has(row[kind])&&media.get(row[kind])!==path)throw Error('Conflicting media mapping');media.set(row[kind],path);
    }
   }
   initialized=true;
  })().catch(error=>{initializing=null;initialized=false;throw error;});
  await initializing;
 }
 function assetURL(virtual){if(!initialized)throw Error('Static metadata is not verified');const path=manifest?.files[virtual]?.path??media.get(virtual);if(!path)throw Error('Unknown static asset');return safeAssetURL(path,baseURL);}
 function configuration(dimensions){
  const prefix=validatePrefix(manifest.vectors[String(dimensions)],dimensions,catalog.rows.length);
  return {build:manifest.build_id,dimensions,prefix,baseURL:String(baseURL),rows:catalog.rows.map(({id,shape,color,heading,elevation})=>({id,shape,color,heading,elevation}))};
 }
 async function api(virtual,options){
  const separator=virtual.indexOf('?'),path=separator<0?virtual:virtual.slice(0,separator),query=separator<0?'':virtual.slice(separator+1),endpoint=path.slice(5);
  if(endpoint==='status'){if(query)throw Object.assign(Error('Unknown query parameters'),{status:400});return {...current,refreshing:false,refresh_error:null,refresh_supported:false};}
  if(!['neighbors','reference','reference-gallery','iou'].includes(endpoint))throw Object.assign(Error('Unknown API route'),{status:404});
  const required=endpoint==='iou'?['build','id','other']:['build','id','dimensions'],optional=['neighbors','reference-gallery'].includes(endpoint)?['k']:[];
  const params=new URLSearchParams(query),keys=[...params.keys()];
  const invalid=message=>{throw Object.assign(Error(message),{status:400});};
  if(query.split('&').some(p=>!p.includes('='))||keys.length>12||new Set(keys).size!==keys.length||required.some(k=>!params.has(k))||keys.some(k=>!required.includes(k)&&!optional.includes(k))||[...params.values()].some(v=>!v))invalid('Missing, duplicate or unknown query parameters');
  const integer=(key,fallback,minimum=0)=>{const value=params.get(key)??fallback;if(!/^[0-9]{1,9}$/.test(value)||Number(value)<minimum)invalid('Invalid '+key);return Number(value);};
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(params.get('build')))invalid('Invalid build');
  const id=integer('id'),dimensions=endpoint==='iou'?null:integer('dimensions'),k=optional.length?integer('k','8',1):8;
  if(dimensions!==null&&![128,256,512,768].includes(dimensions))invalid('Invalid dimensions');
  if(params.get('build')!==manifest.build_id||!catalog.rows.some(r=>r.id===id))throw Object.assign(Error('Build or row not found'),{status:404});
  if(endpoint==='iou'){
   const other=integer('other');if(!catalog.rows.some(r=>r.id===other))throw Object.assign(Error('Unknown other row'),{status:404});
   const masks=await withAbort(Promise.all([id,other].map(async rowId=>{
    const row=catalog.rows.find(r=>r.id===rowId),url=assetURL(row.mask);
    const response=await nativeFetch(url,{redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if(!response.ok)throw Error(`Mask HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer());if(await sha256(bytes)!==row.mask_asset.slice(6,-4))throw Error('Native PNG checksum mismatch');
    return maskDecoder(bytes);
   })),options.signal);
   const [a,b]=masks;
   if(!Number.isInteger(a.width)||!Number.isInteger(a.height)||a.width<1||a.height<1||a.width!==b.width||a.height!==b.height||a.samples.length!==a.width*a.height||b.samples.length!==b.width*b.height)throw Error('Masks must have identical native dimensions');
   return maskIoU(a.samples,b.samples,id,other);
  }
  return client.request(configuration(dimensions),endpoint,id,endpoint==='neighbors'?Math.min(k,20):k,options);
 }
 async function fetchStatic(virtual,options={}){
  try{
   if(options.signal?.aborted)throw abortError();
   if(typeof virtual!=='string'||!/^\/(?:data|api|dataset)\//.test(virtual))return errorResponse(Error('Unknown static asset'),404);
   try{safeAssetURL(virtual.split('?')[0].slice(1),baseURL);}catch{return errorResponse(Error('Unsafe virtual path'),404);}
   if(virtual==='/api/refresh')return errorResponse(Error('Static publication cannot refresh or start inference'),409);
   if(options.method&&options.method.toUpperCase()!=='GET')return errorResponse(Error('Method not allowed'),405);
   await withAbort(initialize(),options.signal);
   if(virtual.startsWith('/api/'))return Response.json(await api(virtual,options));
   if(virtual==='/data/current.json')return Response.json(current);
   if(virtual===current.catalog_url)return Response.json(catalog);
   if(media.has(virtual)){
    const response=await nativeFetch(assetURL(virtual),{redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if(!response.ok)throw Error(`Media HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer()),path=media.get(virtual);
    if(await sha256(bytes)!==path.slice(6,path.lastIndexOf('.')))throw Error('Media checksum mismatch');
    return new Response(bytes,{headers:{'Content-Type':path.endsWith('.png')?'image/png':'image/webp'}});
   }
   if(!Object.hasOwn(manifest.files,virtual))return errorResponse(Error('Unknown static asset'),404);
   const raw=await withAbort(readFile(virtual),options.signal);return new Response(raw);
  }catch(error){if(error.name==='AbortError')throw error;return errorResponse(error,error.status??503);}
 }
 async function warmDiagnostics(dimensions){await initialize();return client.request(configuration(dimensions),'warm',null);}
 return {fetchStatic,assetURL,warmDiagnostics,onDiagnosticsProgress(fn){listeners.add(fn);return ()=>listeners.delete(fn);},dispose:()=>client.dispose()};
}
export function createDiagnosticClient({workerFactory=()=>new Worker(new URL('./diagnostics-worker.js',import.meta.url),{type:'module'}),onProgress=()=>{},cacheSize=64,timeout=180000}={}){
 let active=null,serial=0;const pending=new Map(),cache=new Map();
 function dispose(error=abortError()){
  const previous=active;active=null;previous?.worker.terminate();cache.clear();
  for(const p of pending.values())p.finish(error);pending.clear();
 }
 function ensure(config){
  if(active?.build===config.build&&active.dimensions===config.dimensions)return active;
  dispose();const worker=workerFactory(),state={worker,build:config.build,dimensions:config.dimensions};active=state;
  worker.onmessage=({data:m})=>{
   if(active!==state)return;
   if(m.build!==state.build||m.dimensions!==state.dimensions){const p=pending.get(m.requestId);p?.finish(Error('Worker response identity mismatch'));return;}
   if(m.type==='progress'){for(const p of pending.values())p.touch();onProgress(m);return;}
   if(m.type==='fatal'){onProgress({...m,phase:'error'});dispose(Error(m.error||'Worker failed'));return;}
   const p=pending.get(m.requestId);if(!p)return;
   if(m.endpoint!==p.endpoint||m.id!==p.id){p.finish(Error('Worker response identity mismatch'));return;}
   if(m.type==='error'){p.finish(Error(m.error));return;}
   if(m.type!=='result')return;
   if(p.endpoint!=='warm'&&(m.result?.query_id!==p.id||m.result?.dimensions!==state.dimensions)){p.finish(Error('Diagnostic response identity mismatch'));return;}
   cache.set(p.key,m.result);while(cache.size>cacheSize)cache.delete(cache.keys().next().value);p.finish(null,m.result);
  };
  worker.onerror=event=>{if(active===state){onProgress({phase:'error',dimensions:state.dimensions,error:event.message||'Worker failed'});dispose(Error(event.message||'Worker failed'));}};
  worker.onmessageerror=()=>worker.onerror({message:'Worker message decoding failed'});
  worker.postMessage({type:'init',...config});return state;
 }
 function request(config,endpoint,id,k=8,{signal}={}){
  if(signal?.aborted)return Promise.reject(abortError());
  let state;try{state=ensure(config);}catch(error){return Promise.reject(error);}
  const key=JSON.stringify([config.build,config.dimensions,endpoint,id,k]);
  if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return Promise.resolve(structuredClone(value));}
  const requestId=++serial;
  return new Promise((resolve,reject)=>{
   let timer;const abort=()=>{state.worker.postMessage({type:'cancel',requestId});finish(abortError());};
   const finish=(error,value)=>{if(!pending.delete(requestId))return;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(structuredClone(value));};
   const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(active===state){onProgress({phase:'error',dimensions:state.dimensions,error:'Diagnostics timed out; retry the selection'});dispose(Error('Diagnostics timed out; retry the selection'));}},timeout);};
   pending.set(requestId,{endpoint,id,key,finish,touch});signal?.addEventListener('abort',abort,{once:true});touch();
   state.worker.postMessage({type:'request',requestId,build:config.build,dimensions:config.dimensions,endpoint,id,k});
  });
 }
 return {request,dispose};
}
let singleton;
const transport=()=>singleton??=createStaticTransport();
export const fetchStatic=(...args)=>transport().fetchStatic(...args);
export const assetURL=(...args)=>transport().assetURL(...args);
export const warmDiagnostics=(...args)=>transport().warmDiagnostics(...args);
export const onDiagnosticsProgress=(...args)=>transport().onDiagnosticsProgress(...args);
