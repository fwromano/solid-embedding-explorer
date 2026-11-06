import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const colors = await import('../view-colors.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

// Independent oracle: execute the OWNED, unmodified original source blocks.
const reference = readFileSync(new URL('../../reference-viewer/embedding.html', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../../reference-viewer/new-data/view-controls.js', import.meta.url), 'utf8');
const block = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `reference block exists: ${start}`);
  return source.slice(a, b);
};
function oracle(query = '', {min = -60, max = 60, savedColors = {}, savedPositions = {}} = {}) {
  const context = vm.createContext({params: new URLSearchParams(query), D: {elevations: [min, max]},
    localStorage: {getItem: key => JSON.stringify(key === 'vehicle-view-hsv-colors' ? savedColors : savedPositions)}});
  vm.runInContext(block(controls, '  const clamp=', '  function cameraBasis(') + block(controls, '  function positions(', '  function mountAnchors(') +
    '\nconst VehicleViewControls={positions,prepareHsv,color};\n' +
    block(reference, "const defaultPalette=", 'let viewpointColors=') +
    '\nglobalThis.result={viewPalettes,anchorNames,anchorPositions,customAnchors,palette,toHsv,fromHsv,viewpointColor};', context);
  const result = context.result;
  result.rgbAt = (heading, elevation) => Array.from(result.viewpointColor(heading, elevation).match(/-?\d+/g), Number);
  return result;
}
const plain = value => JSON.parse(JSON.stringify(value));
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
function queryFor(palette, anchors, positions) {
  const q = new URLSearchParams({palette});
  for (const [name, rgb] of Object.entries(anchors ?? {})) q.set('anchor-' + name, hex(rgb));
  for (const [name, point] of Object.entries(positions ?? {})) q.set('anchor-pos-' + name, point.join(','));
  return q;
}
const headings = [-1080, -361, -360, -180, -1, 0, .01, 15, 45, 71, 89, 90, 119, 120, 179.99, 180, 181, 270, 359.99, 360, 361, 720];
const elevations = [-120, -60, -59.9, -30, 0, 30, 59.9, 60, 120, null];

test('moving anchors returns an independent state with reference clamps and circular collision rejection', () => {
  assert.equal(typeof colors.movePosition,'function');
  let state=colors.parseColorState(new URLSearchParams(),{min:-60,max:60});
  const ref=oracle();
  const moves=[['bottomLeft',30,-40],['topRight',359,59],['bottomRight',720,-90],
    ['topLeft',-15,120],['bottomLeft',360,60],['bottomLeft',.00001,60],
    ['bottomLeft',0,60],['bottomRight',Infinity,0],['topRight',45,NaN],['topLeft',30,45]];
  for(const [name,h,e] of moves) {
    const before=plain(state),expected=ref.anchorPositions.move(name,h,e);
    const next=colors.movePosition(state,name,h,e);
    assert.equal(next!==null,expected,`${name},${h},${e}`);
    assert.deepEqual(state,before,'input is never changed');
    if(next) {
      assert.deepEqual(next.positions,plain(ref.anchorPositions.points));
      assert.notEqual(next.anchors,state.anchors);
      for(const n of colors.ANCHOR_NAMES) {assert.notEqual(next.positions[n],state.positions[n]);assert.notEqual(next.anchors[n],state.anchors[n]);}
      state=next;
    }
  }
  assert.equal(colors.movePosition(state,'__proto__',1,2),null);
  assert.equal(colors.movePosition(state,'missing',1,2),null);
});

test('mapping snapshots and memoizes safe RGB arrays while rejecting nonfinite inputs', () => {
  const state=colors.parseColorState(queryFor('custom',{bottomLeft:[17,23,29]},{bottomLeft:[25,-45]}),{min:-60,max:60});
  const rgbAt=colors.createColorMapping(state), expected=rgbAt(13,14);
  assert.equal(rgbAt(13,14),expected,'cached RGB is reused');
  assert.ok(Object.isFrozen(expected),'caller cannot corrupt cached RGB');
  state.anchors.bottomLeft[0]=255;state.positions.bottomLeft[0]=350;
  assert.equal(rgbAt(13,14),expected);
  assert.deepEqual(rgbAt(40,20),oracle(queryFor('custom',{bottomLeft:[17,23,29]},{bottomLeft:[25,-45]})).rgbAt(40,20));
  assert.throws(()=>{expected[0]=100},TypeError);
  assert.throws(()=>{colors.PALETTES.custom.anchors.bottomLeft[0]=1},TypeError);
  const fresh=colors.defaultPositions(-60,60);fresh.bottomLeft[0]=99;
  assert.equal(colors.defaultPositions(-60,60).bottomLeft[0],0);
  for(const [min,max] of [[0,0],[60,-60],[NaN,60],[-60,Infinity],['-60',60],[-1e308,1e308]]) {
    assert.throws(()=>colors.defaultPositions(min,max),RangeError);
    assert.throws(()=>colors.parseColorState(new URLSearchParams(),{min,max}),RangeError);
    assert.throws(()=>colors.createColorMapping({elevationMin:min,elevationMax:max}),RangeError);
    assert.throws(()=>colors.appendColorParams(new URLSearchParams(),{elevationMin:min,elevationMax:max}),RangeError);
  }
  for(const invalid of [NaN,Infinity,-Infinity,undefined,'0',null]) assert.throws(()=>rgbAt(invalid,0),TypeError);
  for(const invalid of [NaN,Infinity,-Infinity,undefined,'0']) assert.throws(()=>rgbAt(0,invalid),TypeError);
  const defaults=colors.createColorMapping();
  const badPositions=[{}, {bottomLeft:[NaN,0]}, {bottomLeft:[180,-60]}, {bottomLeft:Array(2)}];
  for(const positions of badPositions) assert.deepEqual(colors.createColorMapping({positions})(52,21),defaults(52,21));
  for(const anchors of [{bottomLeft:[256,0,0]}, {bottomLeft:Array(3)}, {bottomLeft:[NaN,0,0]}, {bottomLeft:[1.5,0,0]}]) {
    assert.deepEqual(colors.createColorMapping({anchors})(52,21),defaults(52,21));
  }
});

test('serialization round trips reference keys without stale colors or positions', () => {
  assert.equal(typeof colors.appendColorParams, 'function');
  const bounds={min:-60,max:60};
  const moved={...colors.defaultPositions(-60,60),bottomLeft:[37,-41]};
  for(const palette of Object.keys(colors.PALETTES)) for(const positions of [colors.defaultPositions(-60,60),moved]) {
    const q=queryFor(palette,palette==='custom'?{bottomLeft:[0,0,0],topLeft:[12,34,56]}:undefined,positions);
    const state=colors.parseColorState(q,bounds);
    const before=plain(state), target=new URLSearchParams('unrelated=keep&anchor-topLeft=stale&anchor-pos-topLeft=stale&palette=stale');
    assert.equal(colors.appendColorParams(target,state),target);
    assert.deepEqual(state,before);
    assert.equal(target.get('unrelated'),'keep');
    assert.equal(target.get('palette'),palette);
    assert.deepEqual(colors.parseColorState(target,bounds),state);
    const ref=oracle(q), expectedPositions=new URLSearchParams();
    ref.anchorPositions.write(expectedPositions);
    for(const name of colors.ANCHOR_NAMES) {
      assert.equal(target.get('anchor-pos-'+name),expectedPositions.get('anchor-pos-'+name));
      assert.equal(target.get('anchor-'+name),palette==='custom'?hex(state.anchors[name]):null);
    }
  }
  const params=new URLSearchParams();
  colors.appendColorParams(params,{palette:'teal',elevationMin:-60,elevationMax:60});
  assert.equal(params.get('palette'),'teal-violet');
});

test('URL parsing returns canonical JSON state with reference validation and saved-value precedence', () => {
  assert.equal(typeof colors.parseColorState, 'function');
  const min=-60,max=60;
  const saved={anchors:{bottomLeft:[3,4,5],topLeft:'#aabbcc',topRight:'#ffffff',bottomRight:'#111111'},positions:{bottomLeft:[12,-50],topLeft:[20,45],topRight:[200,50],bottomRight:[190,-55]}};
  const refSaved={savedColors:Object.fromEntries(Object.entries(saved.anchors).map(([n,v])=>[n,Array.isArray(v)?hex(v):v])),savedPositions:saved.positions};
  const queries=['','palette=custom','palette=unknown','palette=__proto__','palette=custom-corners',
    'anchor-bottomLeft=%23aBcDef','anchor-topLeft=bad','palette=teal-violet&anchor-bottomLeft=%23ff0000',
    'palette=custom&anchor-bottomLeft=%23000102&anchor-topLeft=%23bad',
    'anchor-pos-bottomLeft=30,-40','anchor-pos-bottomLeft=NaN,0','anchor-pos-topRight=Infinity,50',
    'anchor-pos-topRight=361,50','anchor-pos-topRight=100,61','anchor-pos-topRight=1,2,3',
    'anchor-pos-bottomLeft=180,-60','anchor-pos-bottomLeft=360,60',
    'anchor-pos-bottomLeft=0,0&anchor-pos-topLeft=360,0'];
  for(const savedOptional of [undefined,saved]) for(const query of queries) {
    const params=new URLSearchParams(query), before=params.toString();
    const expected=oracle(query,savedOptional?refSaved:{});
    const actual=colors.parseColorState(params,{min,max},savedOptional);
    assert.deepEqual(actual,{palette:expected.palette,anchors:plain(expected.viewPalettes[expected.palette].anchors),positions:plain(expected.anchorPositions.points),elevationMin:min,elevationMax:max},query);
    assert.equal(params.toString(),before);
    assert.deepEqual(plain(actual),actual,'only plain finite JSON values');
  }
  for(const [alias,canonical] of [['vivid','red-blue-green-yellow'],['teal','teal-violet'],['amber','blue-amber']]) {
    const state=colors.parseColorState(new URLSearchParams({palette:alias}),{min,max});
    assert.equal(state.palette,canonical);
    assert.deepEqual(state.anchors,colors.PALETTES[canonical].anchors);
    assert.deepEqual(colors.createColorMapping({palette:alias})(78,23),colors.createColorMapping({palette:canonical})(78,23));
  }
  const broken={anchors:{bottomLeft:[256,0,0],topLeft:[1.5,0,0],topRight:[NaN,0,0],bottomRight:[1,2]},positions:{bottomLeft:[Infinity,0]}};
  assert.deepEqual(colors.parseColorState(new URLSearchParams('palette=custom'),{min,max},broken),colors.parseColorState(new URLSearchParams('palette=custom'),{min,max}));
  const state=colors.parseColorState(new URLSearchParams('palette=custom'),{min,max},saved);
  state.anchors.bottomLeft[0]=99;state.positions.bottomLeft[0]=99;
  assert.equal(saved.anchors.bottomLeft[0],3);assert.equal(saved.positions.bottomLeft[0],12);
});

test('all five named palettes reproduce the reference absolute-heading corner blend', () => {
  assert.equal(typeof colors.createColorMapping, 'function');
  const ref = oracle();
  assert.deepEqual(Object.keys(colors.PALETTES), Object.keys(ref.viewPalettes));
  assert.deepEqual(colors.ANCHOR_NAMES, plain(ref.anchorNames));
  for (const [palette, definition] of Object.entries(ref.viewPalettes)) {
    assert.deepEqual(colors.PALETTES[palette], plain(definition));
    const expected = oracle(`palette=${palette}`);
    const rgbAt = colors.createColorMapping({palette, elevationMin: -60, elevationMax: 60});
    for (const h of headings) for (const e of elevations) assert.deepEqual(rgbAt(h, e), expected.rgbAt(h, e), `${palette} at ${h},${e}`);
    assert.deepEqual(rgbAt(0, -60), plain(definition.anchors.bottomLeft));
    assert.deepEqual(rgbAt(180, 60), plain(definition.anchors.topRight));
    assert.notDeepEqual(rgbAt(0, 0), rgbAt(90, 0), 'physical heading is not divided by a shape period');
  }
});

test('relocated anchors use the exact circular distance, inverse weights, and global hue alignment', () => {
  assert.equal(typeof colors.defaultPositions, 'function');
  const customSets = [
    {bottomLeft:[0,0,0], topLeft:[128,128,128], topRight:[255,0,0], bottomRight:[0,0,255]},
    {bottomLeft:[0,0,0], topLeft:[100,100,100], topRight:[255,255,255], bottomRight:[30,30,30]},
    {bottomLeft:[255,0,1], topLeft:[255,1,0], topRight:[1,255,0], bottomRight:[1,0,255]}
  ];
  for (const [min,max] of [[-60,60],[-5,90]]) {
    const defaults = {bottomLeft:[0,min],topLeft:[0,max],topRight:[180,max],bottomRight:[180,min]};
    assert.deepEqual(colors.defaultPositions(min,max), defaults);
    const dragged = {bottomLeft:[359,min+3],topLeft:[45,max-6],topRight:[210,max-15],bottomRight:[130,min+9]};
    for (const positions of [undefined, defaults, dragged, {...defaults, bottomLeft:[360,min]}]) {
      for (const palette of Object.keys(colors.PALETTES)) {
        const sets = palette === 'custom' ? customSets : [colors.PALETTES[palette].anchors];
        for (const anchors of sets) {
          const ref = oracle(queryFor(palette,anchors,positions),{min,max});
          const rgbAt = colors.createColorMapping({palette,anchors,positions,elevationMin:min,elevationMax:max});
          for (const h of headings) for (const e of [...elevations,min,max]) assert.deepEqual(rgbAt(h,e),ref.rgbAt(h,e), `${palette} at ${h},${e}, positions=${JSON.stringify(positions)}`);
          for (const [name,[h,e]] of Object.entries(positions ?? defaults)) assert.deepEqual(rgbAt(h,e), anchors[name]);
          for (let h=0;h<=360;h+=7) for (let e=min;e<=max;e+=11) assert.deepEqual(rgbAt(h,e),ref.rgbAt(h,e));
        }
      }
    }
  }
});
