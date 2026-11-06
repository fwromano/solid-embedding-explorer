import {ExactDiagnostics} from './diagnostics.js';
import {decodeVectorChunk,validatePrefix,sha256} from './vector-codec.js';
import {safeAssetURL} from './transport.js';

export function createWorkerHandler({postMessage,nativeFetch=(...args)=>fetch(...args)}){
 let config,loading;const pending=new Set(),cancelled=new Set();
 async function load(){
  const {prefix,dimensions,rows,baseURL,build}=config;
  validatePrefix(prefix,dimensions,rows.length);
  const total=prefix.chunks.reduce((n,c)=>n+c.bytes,0),values=new Float32Array(rows.length*dimensions);let loaded=0;
  const progress=phase=>postMessage({type:'progress',build,dimensions,loaded,total,phase});progress('downloading');
  for(const chunk of prefix.chunks){
   const response=await nativeFetch(safeAssetURL(chunk.path,baseURL),{redirect:'error',signal:AbortSignal.timeout(90000)});
   if(!response.ok)throw Error(`Vector HTTP ${response.status}`);
   if(!response.body)throw Error('Missing vector response body');
   const reader=response.body.getReader(),bytes=new Uint8Array(chunk.bytes);let offset=0;
   try{while(true){const {value,done}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw Error('Encoded vector length overflow');bytes.set(value,offset);offset+=value.length;loaded+=value.length;progress('downloading');}}
   catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
   if(offset!==bytes.length)throw Error('Encoded vector length mismatch');
   values.set(await decodeVectorChunk(bytes,chunk),chunk.start*dimensions);
  }
  progress('verifying');
  if(await sha256(new Uint8Array(values.buffer))!==prefix.raw_sha256)throw Error('Complete vector checksum mismatch');
  const math=new ExactDiagnostics(rows,values,dimensions);progress('ready');return math;
 }
 return async function handle(message){
  if(message.type==='init'){
   config=message;loading=load();loading.catch(error=>postMessage({type:'fatal',build:config.build,dimensions:config.dimensions,error:error.message}));return;
  }
  if(message.type==='cancel'){if(pending.has(message.requestId))cancelled.add(message.requestId);return;}
  if(message.type!=='request')return;
  const {requestId,build,dimensions,endpoint,id,k}=message;
  const identity={requestId,build,dimensions,endpoint,id};pending.add(requestId);
  try{
   if(!config||build!==config.build||dimensions!==config.dimensions||!['warm','neighbors','reference','reference-gallery'].includes(endpoint))throw Error('Worker request identity mismatch');
   const math=await loading;if(cancelled.has(requestId))return;
   const result=endpoint==='warm'?{ready:true}:endpoint==='neighbors'?math.neighbors(id,k):endpoint==='reference'?math.reference(id):math.gallery(id,k);
   postMessage({type:'result',...identity,result});
  }catch(error){if(!cancelled.has(requestId))postMessage({type:'error',...identity,error:error.message});}
  finally{pending.delete(requestId);cancelled.delete(requestId);}
 };
}
if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope){
 const handle=createWorkerHandler({postMessage:message=>self.postMessage(message)});
 self.onmessage=event=>{void handle(event.data);};
}
