import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('title accurately describes the solids dataset rather than a hemisphere', async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/<h1>Expanded solid embeddings<\/h1>/);
  assert.doesNotMatch(html,/hemisphere/i);
});

test('all literal DOM bindings exist and modules remain same-origin and package-free', async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.has(match[1]),match[1]);
  assert.equal(ids.size,[...html.matchAll(/id="([^"]+)"/g)].length,'no duplicate DOM IDs');
  assert.doesNotMatch(script,/https?:\/\//);
});

test('explorer surface exposes accessible plot, real image inspector, matrix, request and coverage controls', async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8').catch(()=> '');
  for(const id of ['plot','plot-canvas','marker-canvas','series','preview','image-mode','neighbors','iou-result','matrix','fit','dimensions','heading','elevation','play','refresh','coverage','error','copy-link','heading-mode','elevation-mode','fit-visible','point-size','paint-focus']) assert.match(html,new RegExp(`id="${id}"`),id);
  assert.match(html,/class="layout" inert/,'controls are inert until a catalog is loaded');
  assert.match(html,/id="copy-link" disabled/,'cannot serialize an uninitialized view');
  assert.match(html,/<script type="module" src="\.\/app.js"/);
  assert.match(html,/role="alert"/);
  assert.match(html,/aria-label="Embedding point cloud/);
});
