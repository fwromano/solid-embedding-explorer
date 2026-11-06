/** Reference viewpoint colors. Angles are physical degrees, never shape-period coordinates. */
export const ANCHOR_NAMES = Object.freeze(['bottomLeft', 'topLeft', 'topRight', 'bottomRight']);
const DEFAULT_PALETTE = 'red-blue-green-yellow';
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const PALETTES = freeze({
  'red-blue-green-yellow': {label: 'Red / blue / green / yellow', names: {topLeft: 'green', topRight: 'red', bottomLeft: 'blue', bottomRight: 'yellow'}, anchors: {topLeft: [0,166,81], topRight: [230,57,70], bottomLeft: [38,98,255], bottomRight: [255,212,0]}},
  'teal-violet': {label: 'Teal × violet', names: {topLeft: 'teal', topRight: 'pale blue', bottomLeft: 'slate', bottomRight: 'violet'}, anchors: {topLeft: [95,208,184], topRight: [218,227,237], bottomLeft: [101,113,131], bottomRight: [180,160,229]}},
  'blue-amber': {label: 'Blue × amber', names: {topLeft: 'blue', topRight: 'ivory', bottomLeft: 'slate', bottomRight: 'amber'}, anchors: {topLeft: [104,174,223], topRight: [240,226,200], bottomLeft: [101,113,131], bottomRight: [228,181,108]}},
  'custom-corners': {label: 'Green / red / orange / black', names: {topLeft: 'green', topRight: 'red', bottomLeft: 'orange', bottomRight: 'black'}, anchors: {topLeft: [0,166,81], topRight: [230,57,70], bottomLeft: [245,140,35], bottomRight: [0,0,0]}},
  custom: {label: 'My colors · vivid blend', anchors: {bottomLeft: [38,98,255], topLeft: [0,166,81], topRight: [230,57,70], bottomRight: [255,212,0]}}
});
const ALIASES = Object.freeze({vivid:DEFAULT_PALETTE,teal:'teal-violet',amber:'blue-amber'});
function paletteKey(value) {
  return Object.hasOwn(PALETTES,value)?value:Object.hasOwn(ALIASES,value)?ALIASES[value]:null;
}
const validHex = value => typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value);
const hexRgb = hex => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const validRgb = value => Array.isArray(value) && value.length===3 && Array.from(value).every(v=>Number.isInteger(v)&&v>=0&&v<=255);
function readRgb(value) {
  return validHex(value)?hexRgb(value):validRgb(value)?value.slice():null;
}
function validatedPositions(positions, min, max) {
  const defaults=defaultPositions(min,max);
  const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[0]<=360&&p[1]>=min&&p[1]<=max;
  const points=Object.fromEntries(ANCHOR_NAMES.map(n=>[n,valid(positions?.[n])?positions[n].slice():defaults[n].slice()]));
  const state=positionState(points,min,max);
  if(ANCHOR_NAMES.some((n,i)=>ANCHOR_NAMES.slice(i+1).some(m=>state.distance(points[n],points[m])<1e-8))) return defaults;
  return points;
}
/**
 * Parse reference URL keys into plain JSON {palette,anchors,positions,elevationMin,elevationMax}.
 * savedOptional = {anchors: {name: RGB array or '#rrggbb'}, positions: {name:[h,e]}}.
 * Valid URL colors win per anchor. Any URL position suppresses ALL saved positions.
 * Named presets ignore custom color values. Unknown palettes fall back to custom iff
 * an anchor color parameter exists, otherwise the default. Old vivid/teal/amber aliases
 * resolve to canonical keys. No localStorage reads, mutations, methods, or shared arrays.
 */
export function parseColorState(params, {min=-60,max=60} = {}, savedOptional) {
  const palette=paletteKey(params.get('palette')) ?? (ANCHOR_NAMES.some(n=>params.has('anchor-'+n))?'custom':DEFAULT_PALETTE);
  const anchors=Object.fromEntries(ANCHOR_NAMES.map(n=>[n,palette==='custom'
    ? (validHex(params.get('anchor-'+n))?hexRgb(params.get('anchor-'+n)):readRgb(savedOptional?.anchors?.[n]) ?? PALETTES[DEFAULT_PALETTE].anchors[n].slice())
    : PALETTES[palette].anchors[n].slice()]));
  const explicit=ANCHOR_NAMES.some(n=>params.has('anchor-pos-'+n));
  const raw=explicit?Object.fromEntries(ANCHOR_NAMES.filter(n=>params.has('anchor-pos-'+n)).map(n=>[n,params.get('anchor-pos-'+n).split(',').map(Number)])):savedOptional?.positions;
  return {palette,anchors,positions:validatedPositions(raw,min,max),elevationMin:min,elevationMax:max};
}
function normalizeState({palette=DEFAULT_PALETTE,anchors,positions,elevationMin=-60,elevationMax=60} = {}) {
  palette=paletteKey(palette) ?? DEFAULT_PALETTE;
  return {palette,anchors:Object.fromEntries(ANCHOR_NAMES.map(n=>[n,readRgb(anchors?.[n]) ?? PALETTES[palette].anchors[n].slice()])),
    positions:validatedPositions(positions,elevationMin,elevationMax),elevationMin,elevationMax};
}
/** Return a fresh JSON state, or null for unknown/nonfinite/colliding moves. */
export function movePosition(input, name, heading, elevation) {
  if(!ANCHOR_NAMES.includes(name)||!Number.isFinite(heading)||!Number.isFinite(elevation)) return null;
  const next=normalizeState(input), state=positionState(next.positions,next.elevationMin,next.elevationMax);
  const point=[Math.max(0,Math.min(360,heading)),Math.max(state.low,Math.min(state.high,elevation))];
  if(ANCHOR_NAMES.some(n=>n!==name&&state.distance(point,state.points[n])<1e-8)) return null;
  next.positions[name]=point;
  return next;
}
/** Mutates and returns params; clears stale anchor keys, preserves unrelated keys. */
export function appendColorParams(params, input) {
  const state=normalizeState(input), custom=positionState(state.positions,state.elevationMin,state.elevationMax).custom;
  params.set('palette',state.palette);
  for(const name of ANCHOR_NAMES) {
    params.delete('anchor-'+name);
    params.delete('anchor-pos-'+name);
    if(state.palette==='custom') params.set('anchor-'+name,'#'+state.anchors[name].map(v=>v.toString(16).padStart(2,'0')).join(''));
    if(custom) params.set('anchor-pos-'+name,state.positions[name].join(','));
  }
  return params;
}
function toHsv(rgb) {
  const [r,g,b] = rgb.map(v => v/255), v = Math.max(r,g,b), lo = Math.min(r,g,b), d = v-lo;
  const h = d === 0 ? 0 : v === r ? ((g-b)/d+6)%6 : v === g ? (b-r)/d+2 : (r-g)/d+4;
  return [h*60, v === 0 ? 0 : d/v, v];
}
function fromHsv([h,s,v]) {
  const c = v*s, x = c*(1-Math.abs(((h%360+360)%360)/60%2-1)), m = v-c;
  const sector = Math.floor(((h%360+360)%360)/60);
  // The reference serializes through CSS rgb(), which writes negative zero as 0.
  return [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][sector].map(n => Math.round(255*(n+m)) || 0);
}
function prepareViewHsv(anchors) {
  const hsv = Object.fromEntries(Object.entries(anchors).map(([name,rgb]) => [name,toHsv(rgb)]));
  const positions = {bottomLeft:[0,0],bottomRight:[1,0],topLeft:[0,1],topRight:[1,1]};
  const colored = ANCHOR_NAMES.filter(name => hsv[name][1]>0 && hsv[name][2]>0);
  for (const name of ANCHOR_NAMES) if (hsv[name][1] === 0 && colored.length) {
    const distance = other => positions[name].reduce((sum,v,i) => sum+(v-positions[other][i])**2,0);
    const neighbor = colored.reduce((best,other) => distance(other)<distance(best)?other:best,colored[0]);
    hsv[name][0] = hsv[neighbor][0];
    if (hsv[name][2] === 0) hsv[name][1] = hsv[neighbor][1];
  }
  const bl = hsv.bottomLeft[0]; let best = null, bestCost = Infinity;
  for (let a=-1;a<=1;a++) for (let b=-1;b<=1;b++) for (let c=-2;c<=2;c++) {
    const tl=hsv.topLeft[0]+360*a, br=hsv.bottomRight[0]+360*b, tr=hsv.topRight[0]+360*c;
    const cost=(tl-bl)**2+(br-bl)**2+(tr-tl)**2+(tr-br)**2;
    if (cost<bestCost) { bestCost=cost; best={topLeft:tl,bottomRight:br,topRight:tr}; }
  }
  for (const [name,hue] of Object.entries(best)) hsv[name][0]=hue;
  return hsv;
}
/** Fresh, plain JSON anchor positions; no storage or DOM dependencies. */
export function defaultPositions(min=-60, max=60) {
  if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min||!Number.isFinite(max-min)) throw new RangeError('Elevation bounds must be finite numbers with max > min and a finite span');
  return {bottomLeft:[0,min],topLeft:[0,max],topRight:[180,max],bottomRight:[180,min]};
}
function positionState(points, low, high) {
  const defaults = defaultPositions(low,high);
  const distance = (a,b) => {
    const h=Math.abs(a[0]-b[0])%360;
    return (Math.min(h,360-h)/180)**2+((a[1]-b[1])/(high-low))**2;
  };
  return {points,low,high,distance,custom:ANCHOR_NAMES.some(n => points[n].some((v,i) => v!==defaults[n][i]))};
}
function prepareRelocatedHsv(colors,state) {
  const names=ANCHOR_NAMES, hsv=Object.fromEntries(names.map(n=>[n,toHsv(colors[n])]));
  const colored=names.filter(n=>hsv[n][1]>0&&hsv[n][2]>0);
  for(const n of names) if(hsv[n][1]===0&&colored.length) {
    const near=colored.reduce((a,b)=>state.distance(state.points[n],state.points[b])<state.distance(state.points[n],state.points[a])?b:a);
    hsv[n][0]=hsv[near][0]; if(hsv[n][2]===0) hsv[n][1]=hsv[near][1];
  }
  let best=null,cost=Infinity; const first=hsv[names[0]][0];
  for(let a=-1;a<=1;a++) for(let b=-1;b<=1;b++) for(let c=-1;c<=1;c++) {
    const h=[first,hsv[names[1]][0]+360*a,hsv[names[2]][0]+360*b,hsv[names[3]][0]+360*c]; let value=0;
    for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) value+=(h[i]-h[j])**2/(.05+state.distance(state.points[names[i]],state.points[names[j]]));
    if(value<cost) {cost=value;best=h;}
  }
  names.forEach((n,i)=>hsv[n][0]=best[i]); return hsv;
}
/**
 * Snapshot state and prepare hue alignment once; use this SAME callable everywhere.
 * rgbAt(heading,elevation) returns a frozen, memoized RGB byte array. Heading must
 * be finite physical degrees; finite elevations clamp only in the default corner
 * blend (exactly as the reference). Null elevation means the dataset midpoint.
 * State changes require a new callable. Missing/default positions use corner math.
 */
export function createColorMapping(input = {}) {
  const normalized=normalizeState(input), {anchors,elevationMin,elevationMax}=normalized;
  const state=positionState(normalized.positions,elevationMin,elevationMax);
  const hsv=state.custom?prepareRelocatedHsv(anchors,state):prepareViewHsv(anchors);
  const cache=new Map();
  function compute(heading, elevation) {
    if(state.custom) {
      const names=ANCHOR_NAMES, query=[heading,elevation===null?(state.low+state.high)/2:elevation];
      const d=names.map(n=>state.distance(query,state.points[n]));
      const exact=d.findIndex(v=>v<1e-12);
      if(exact>=0) return fromHsv(hsv[names[exact]]);
      const weights=d.map(v=>1/v),sum=weights.reduce((a,b)=>a+b,0);
      return fromHsv([0,1,2].map(i=>names.reduce((v,n,j)=>v+weights[j]*hsv[n][i]/sum,0)));
    }
    const h=((heading%360)+360)%360, x=(h<=180?h:360-h)/180;
    const y=elevation===null?.5:Math.max(0,Math.min(1,(elevation-elevationMin)/(elevationMax-elevationMin)));
    const weights={bottomLeft:(1-x)*(1-y),bottomRight:x*(1-y),topLeft:(1-x)*y,topRight:x*y};
    return fromHsv([0,1,2].map(i => ANCHOR_NAMES.reduce((sum,name) => sum+weights[name]*hsv[name][i],0)));
  }
  return function rgbAt(heading,elevation) {
    if(!Number.isFinite(heading)||(elevation!==null&&!Number.isFinite(elevation))) throw new TypeError('Heading and elevation must be finite numbers (or null elevation)');
    const key=heading+','+elevation;
    if(!cache.has(key)) cache.set(key,Object.freeze(compute(heading,elevation)));
    return cache.get(key);
  };
}
