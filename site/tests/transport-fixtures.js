// Bounded synthetic fixtures only. No production data or claims.
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function syntheticTransport(options={}){
 const base='https://example.test/project/'; const files=new Map();const descriptors={};
 function add(virtual,path,value,gzip=false){const raw=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),encoded=gzip?gzipSync(raw):raw;files.set(base+path,encoded);descriptors[virtual]={path,encoding:gzip?'gzip':'identity',sha256:hash(encoded),raw_sha256:hash(raw),bytes:encoded.length,raw_bytes:raw.length};}
 const rows=[7,42].map((id,i)=>({id,shape:'cube',color:'red',heading:i,elevation:0,image:`/dataset/synthetic/rgb/${id}.png`,mask:`/dataset/synthetic/mask/${id}.png`,image_asset:`media/${String(i+1).repeat(64)}.webp`,mask_asset:`media/${String(i+3).repeat(64)}.png`}));
 const catalog={schema:'solids-explorer-v1',build_id:'build-synthetic',count:2,rows};
 const current={schema:'solids-explorer-v1',build_id:catalog.build_id,count:2,expected_count:2,complete:true,catalog_url:'/data/build-synthetic/catalog.json'};
 add('/data/current.json','data/current.json',current);add(current.catalog_url,'data/build-synthetic/catalog.json.gz',catalog,true);add('/data/build-synthetic/128-all.f32','data/build-synthetic/128-all.f32','synthetic-bytes');
 const manifest={schema:'solids-static-v1',build_id:catalog.build_id,count:2,source_catalog_sha256:'a'.repeat(64),files:descriptors,vectors:{}};
 const calls=[];const nativeFetch=async(url)=>{calls.push(String(url));if(String(url)===base+'deployment.json')return Response.json(manifest);const b=files.get(String(url));return b?new Response(b):new Response('missing',{status:404});};
 return {base,files,manifest,rows,catalog,current,calls,options:{baseURL:base,nativeFetch,...options}};
}
export function syntheticPrefix(dimension=128){
 const values=new Float32Array(2*dimension);values[0]=1;values[dimension]=.5;values[dimension+1]=.5;
 const data=new Map();const chunks=[];
 for(let row=0;row<2;row++){const raw=new Uint8Array(values.slice(row*dimension,(row+1)*dimension).buffer),planes=new Uint8Array(raw.length);for(let p=0;p<4;p++)for(let i=0;i<dimension;i++)planes[p*dimension+i]=raw[4*i+p];const encoded=gzipSync(planes),sha=hash(encoded),path=`vectors/${dimension}/${sha}.bin.gz`;data.set('https://example.test/project/'+path,encoded);chunks.push({path,start:row,count:1,bytes:encoded.length,raw_bytes:raw.length,sha256:sha,raw_sha256:hash(raw)});}
 const prefix={dimension,count:2,dtype:'<f4',raw_sha256:hash(new Uint8Array(values.buffer)),chunks};
 const rows=[{id:7,shape:'cube',color:'red',heading:0,elevation:0},{id:42,shape:'cube',color:'red',heading:1,elevation:0}];
 return {values,data,prefix,rows,config:{baseURL:'https://example.test/project/',build:'build-synthetic',dimensions:dimension,rows,prefix}};
}