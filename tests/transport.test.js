// Synthetic two-row transport metadata only; never production-data evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const mod=await import('../site/transport.js').catch(()=>({}));
const hash=b=>createHash('sha256').update(b).digest('hex');
import {syntheticTransport} from '../site/tests/transport-fixtures.js';
test('explicit static adapter verifies compressed catalog, immutable status and safe nested base URLs',async()=>{
 assert.equal(typeof mod.createStaticTransport,'function');
 const f=syntheticTransport(),t=mod.createStaticTransport(f.options);
 assert.deepEqual(await (await t.fetchStatic('/data/current.json')).json(),f.current);
 assert.deepEqual(await (await t.fetchStatic(f.current.catalog_url)).json(),f.catalog);
 assert.equal(t.assetURL(f.rows[0].image),f.base+f.rows[0].image_asset);
 assert.equal(t.assetURL(f.rows[0].mask),f.base+f.rows[0].mask_asset);
 assert.equal(t.assetURL(f.current.catalog_url),f.base+'data/build-synthetic/catalog.json.gz');
 const status=await (await t.fetchStatic('/api/status')).json();assert.equal(status.count,2);assert.equal(status.refresh_supported,false);assert.equal(status.refreshing,false);
 assert.equal((await t.fetchStatic('/api/refresh',{method:'POST'})).status,409);
 assert.ok(f.calls.every(url=>url.startsWith(f.base)));assert.ok(!f.calls.some(url=>url.includes('/api/')));
});
test('native positive-elevation filenames preserve literal plus signs through catalog initialization',async()=>{
 const f=syntheticTransport();
 f.rows[0].image='/dataset/synthetic/rgb/heading000/el+00.png';
 f.rows[0].mask='/dataset/synthetic/masks/heading000/el+00.png';
 const raw=Buffer.from(JSON.stringify(f.catalog)),encoded=gzipSync(raw),d=f.manifest.files[f.current.catalog_url];
 Object.assign(d,{sha256:hash(encoded),raw_sha256:hash(raw),bytes:encoded.length,raw_bytes:raw.length});
 f.files.set(f.base+d.path,encoded);
 const t=mod.createStaticTransport(f.options),response=await t.fetchStatic('/api/status');
 assert.equal(response.status,200,await response.clone().text());
 assert.equal(t.assetURL(f.rows[0].image),f.base+f.rows[0].image_asset);
 assert.equal(t.assetURL(f.rows[0].mask),f.base+f.rows[0].mask_asset);
 assert.equal(mod.safeAssetURL('dataset/synthetic/rgb/el+00.png',f.base),f.base+'dataset/synthetic/rgb/el+00.png');
});
test('paths fail closed before normalization, origin changes, query injection or unknown virtual lookup',async()=>{
 for(const p of ['../x','a/../x','a/./x','/x','//evil/x','https://evil/x','a\\x','a%2fx','a?x','a#x','a//x','a\u0000x'])assert.throws(()=>mod.safeAssetURL(p,'https://host/project/'));
 const f=syntheticTransport(),t=mod.createStaticTransport(f.options);await t.fetchStatic('/api/status');
 for(const p of ['/dataset/../secret','https://evil/x','//evil/x','/data/current.json?x']){assert.throws(()=>t.assetURL(p));assert.equal((await t.fetchStatic(p)).status,404);}
});
test('manifest binds current/catalog count, build, descriptor encoding and safe hashed media',async()=>{
 for(const mutate of [f=>f.manifest.count=3,f=>f.manifest.build_id='wrong',f=>f.manifest.source_catalog_sha256='bad',f=>f.manifest.files['/data/current.json'].encoding='brotli',f=>f.manifest.files[f.current.catalog_url].raw_sha256='b'.repeat(64),f=>f.manifest.files[f.current.catalog_url].path='../evil']){
  const f=syntheticTransport();mutate(f);const response=await mod.createStaticTransport(f.options).fetchStatic('/api/status');assert.equal(response.status,503);
 }
 const f=syntheticTransport();const corrupted=Buffer.from(f.files.get(f.base+'data/build-synthetic/catalog.json.gz'));corrupted[10]^=1;f.files.set(f.base+'data/build-synthetic/catalog.json.gz',corrupted);
 assert.equal((await mod.createStaticTransport(f.options).fetchStatic('/api/status')).status,503);
});
test('static initialization uses bounded fetches and failed validation cannot publish asset URLs',async()=>{
 const f=syntheticTransport(),seen=[];const t=mod.createStaticTransport({...f.options,nativeFetch:(url,options)=>{seen.push(options);return f.options.nativeFetch(url,options);}});
 await t.fetchStatic('/api/status');assert.ok(seen.every(o=>o.redirect==='error'&&o.signal instanceof AbortSignal));
 const bad=syntheticTransport();bad.manifest.count=3;const invalid=mod.createStaticTransport(bad.options);await invalid.fetchStatic('/api/status');assert.throws(()=>invalid.assetURL('/data/current.json'),/verified|initialized/i);
});
test('abort returns promptly without poisoning shared initialization; failed init retries',{timeout:1000},async()=>{
 const f=syntheticTransport();let release;const held=new Promise(r=>release=r);const fetcher=f.options.nativeFetch;
 const t=mod.createStaticTransport({...f.options,nativeFetch:async(...args)=>{await held;return fetcher(...args);}});
 const controller=new AbortController();const first=t.fetchStatic('/api/status',{signal:controller.signal});const second=t.fetchStatic('/api/status');controller.abort();
 await assert.rejects(first,{name:'AbortError'});release();assert.equal((await second).status,200);
 let fail=true;const retry=mod.createStaticTransport({...f.options,nativeFetch:(...args)=>fail?Promise.reject(Error('network')):fetcher(...args)});
 assert.equal((await retry.fetchStatic('/api/status')).status,503);fail=false;assert.equal((await retry.fetchStatic('/api/status')).status,200);
});
