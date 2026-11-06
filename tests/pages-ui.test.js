import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8'),html=await readFile(new URL('../site/index.html',import.meta.url),'utf8');
test('Pages preserves virtual protocol with explicit fetch adapter and safe links, no monkeypatch or root assets',()=>{
 assert.match(app,/import\s*\{[^}]*fetchStatic[^}]*assetURL[^}]*\}\s*from '\.\/transport.js'/);
 assert.match(app,/requestJSON\(url,options=\{\},fetcher=fetchStatic\)/);
 assert.match(app,/await fetchStatic\(nextFit.url\)/);assert.doesNotMatch(app,/await fetch\(/);assert.doesNotMatch(app,/globalThis.fetch\s*=/);
 for(const expression of ['row.image','row.mask','ref.image','other.image','fit.url','current.catalog_url','`/data/${build}/${fit.basis_file}`'])assert.ok(app.includes(`assetURL(${expression})`),expression);
 assert.doesNotMatch(html,/(?:href|src)="\/(?!\/)/);
 assert.match(html,/id="diagnostics-progress"[^>]*role="status"/);
 assert.match(app,/onDiagnosticsProgress\(/);assert.match(app,/void warmDiagnostics\(/);assert.doesNotMatch(app,/await warmDiagnostics\(/);
 assert.doesNotMatch(app,/location.origin\+'\/\?'/);
 assert.match(app,/validateCatalog\(await requestJSON\(current.catalog_url\)\)/);
});
