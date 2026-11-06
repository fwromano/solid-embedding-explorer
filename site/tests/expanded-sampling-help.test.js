import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('expanded sampling help includes star and continuous aliases without promising partial cohorts',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/star prism 180°/u);
 assert.match(html,/cylinder, cone, sphere and torus use heading-0° representatives/u);
 assert.doesNotMatch(html,/while dense groups are incomplete/u);
});
