// Pure, package-free math and state. Catalog IDs are never array indices.
import {parseColorState,appendColorParams} from './view-colors.js';
import {sourceRow} from './symmetry.js';
export const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
export function projectionVariance(ratio,mode='3d') {
  if(!ratio)return null;
  return (mode==='3d'?[0,1,2]:[...mode].map(Number)).reduce((sum,i)=>sum+ratio[i],0);
}
export function elevationFraction(value,[lo,hi]) {return hi===lo?.5:clamp((value-lo)/(hi-lo),0,1);}
function headingPolicy(value) {
  const policy=typeof value==='number'?{kind:'discrete',period_deg:value}:value;
  if(policy?.kind==='continuous')return policy;
  if(policy?.kind!=='discrete'||!Number.isFinite(policy.period_deg)||policy.period_deg<=0)throw Error('Invalid typed heading symmetry');
  return policy;
}
export function canonicalHeading(value, symmetry) {
  const policy=headingPolicy(symmetry);
  if(policy.kind==='continuous')return 0; // Representative alias, not a numeric period.
  const period=policy.period_deg;
  return ((value % period) + period) % period;
}
export function circularDistance(a, b, symmetry) {
  const policy=headingPolicy(symmetry);
  if(policy.kind==='continuous')return 0;
  const period=policy.period_deg,d=canonicalHeading(a-b,policy);
  return Math.min(d, period-d);
}
export function describePose(shape, heading, elevation, recorded=null) {
  const policy=headingPolicy(shape.heading_symmetry??shape.period),angle=n=>Number(n.toFixed(1));
  const canonical=canonicalHeading(heading,policy),continuous=policy.kind==='continuous';
  const full=continuous&&shape.observable_elevation===false;
  const meaning=full?'Ideal full rotational alias: heading and elevation are not independently observable.':continuous?'Ideal continuous heading alias: heading is not independently observable.':`Canonical ${angle(canonical)}°; period ${policy.period_deg}°.`;
  const approximation=continuous?` ${policy.pixel_equivalence||'Approximate finite-mesh raster; not a pixel-equivalence guarantee'}.`:'';
  const request=`Requested ${angle(heading)}° / ${angle(elevation)}°.`;
  const source=recorded&&sourceRow(recorded);
  const alias=Boolean(recorded?.symmetry_source);
  const actual=recorded?`${alias?` Symmetry view ${recorded.heading}° / ${recorded.elevation}°; reuses source embedding ${source.id}.`:''} Recorded ${source.heading}° / ${source.elevation}°.`:'';
  const exact=recorded&&circularDistance(recorded.heading,heading,policy)<1e-6&&Math.abs(recorded.elevation-elevation)<1e-6;
  return {summary:`${request} ${meaning}${approximation} Full-heading views reuse source embeddings.`,requested:`${request}${actual} ${meaning}${approximation}`,badge:alias?'Repeated by symmetry':continuous?'Ideal rotational alias':exact?'Exact view':'Nearest encoded'};
}
export const seriesOf = row => `${row.shape}/${row.color}`;
export function pathRings(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${seriesOf(row)}@${row.elevation}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(ring => ring.sort((a,b) => a.heading-b.heading || a.id-b.id));
}
export function viewPathLinks(rows,{heading=false,elevation=false}={}) {
  const links=new Map();
  function add(a,b,kind,dashed) {
    const from=sourceRow(a).id,to=sourceRow(b).id;
    if(from===to)return;
    const key=`${kind}:${Math.min(from,to)}/${Math.max(from,to)}`,previous=links.get(key);
    // Symmetry copies can repeat the same segment; a sampled step beats a gap.
    if(!previous||(previous.dashed&&!dashed))links.set(key,{from,to,kind,dashed});
  }
  if(heading)for(const ring of pathRings(rows)) {
    if(ring.length<2)continue;
    for(let i=1;i<=ring.length;i++) {
      const a=ring[i-1],b=ring[i%ring.length];
      add(a,b,'heading',i===ring.length||b.heading-a.heading>1.01);
    }
  }
  if(elevation) {
    const tracks=new Map();
    for(const row of rows) {
      const key=`${seriesOf(row)}@${row.heading}`;
      if(!tracks.has(key))tracks.set(key,[]);
      tracks.get(key).push(row);
    }
    for(const track of tracks.values()) {
      track.sort((a,b)=>a.elevation-b.elevation||a.id-b.id);
      // Elevation is bounded, not circular: never join the top to the bottom.
      for(let i=1;i<track.length;i++)add(track[i-1],track[i],'elevation',track[i].elevation-track[i-1].elevation>5.01);
    }
  }
  return [...links.values()];
}
export function filterRows(catalog, state) {
  const active = new Set(state.series), elevations = new Set(state.elevations || []);
  let candidates = catalog.rows.filter(row => active.has(seriesOf(row)));
  if (state.elevationMode === 'selected') candidates = candidates.filter(row => elevations.has(row.elevation));
  if (state.elevationMode === 'current') {
    const nearest = new Map();
    for (const row of candidates) {
      const key=seriesOf(row), prev=nearest.get(key);
      if (prev===undefined || Math.abs(row.elevation-state.elevation)<Math.abs(prev-state.elevation)) nearest.set(key,row.elevation);
    }
    candidates=candidates.filter(row=>row.elevation===nearest.get(seriesOf(row)));
  }
  if (state.headingMode === 'all') return candidates;
  const targets=state.headingMode==='current'?[state.heading]:(state.headings || []);
  const periods=new Map(catalog.shapes.map(s=>[s.id,s.heading_symmetry??s.period])), ids=new Set();
  for (const ring of pathRings(candidates)) for (const target of targets) {
    const nearest=nearestSample(ring,target,ring[0].elevation,catalog.symmetry_expanded?360:periods.get(ring[0].shape));
    if (nearest) ids.add(nearest.id);
  }
  return candidates.filter(row=>ids.has(row.id));
}
export function parseState(query, catalog, savedColors) {
  const p = new URLSearchParams(query);
  const choice=(key,options,fallback)=>options.includes(p.get(key))?p.get(key):fallback;
  const number=(key,fallback,min,max)=>{
    const raw=p.get(key), n=raw===null||raw.trim()===''?NaN:Number(raw);
    return Number.isFinite(n)?clamp(n,min,max):fallback;
  };
  const ids=new Set(catalog.rows.map(r=>r.id));
  const selectedId=p.has('id')&&p.get('id')!==''&&ids.has(Number(p.get('id')))?Number(p.get('id')):null;
  const seriesIds=catalog.series.map(s=>s.id), colorIds=catalog.colors.map(c=>c.id);
  const elevations=[...new Set(catalog.rows.map(r=>r.elevation))];
  let min=elevations.length?Math.min(...elevations):-60,max=elevations.length?Math.max(...elevations):60;
  if(min===max){min-=1;max+=1;}
  const viewColors=parseColorState(p,{min,max},savedColors);
  const numericList=(key,min,max)=>[...new Set(p.getAll(key).filter(s=>s.trim()!=='').map(Number).filter(n=>Number.isFinite(n)&&n>=min&&n<=max))];
  return {
    dimensions:Number(choice('dimensions',['128','256','512','768'],'768')),
    fit:choice('fit',Array.isArray(catalog.fits)?catalog.fits:['all','balanced','shape','color'],'all'),mode:choice('mode',['3d','01','02','12'],'3d'),
    series:p.has('show')?[...new Set(p.getAll('show').filter(id=>seriesIds.includes(id)))]:seriesIds,
    selectedId,seriesId:choice('seriesId',seriesIds,seriesIds[0]||''),
    headingMode:choice('headingMode',['all','current','selected'],'all'),
    elevationMode:choice('elevationMode',['all','current','selected'],'all'),
    headings:numericList('atHeading',0,360),elevations:numericList('atElevation',-90,90).filter(n=>elevations.includes(n)),
    heading:number('heading',0,-36000,36000),elevation:number('elevation',20,Math.min(...elevations,0),Math.max(...elevations,0)),
    paths:p.get('paths')==='1',elevationPaths:p.get('elevationPaths')==='1',pointSize:number('pointSize',2,1,5),
    colorBy:choice('colorBy',['viewpoint','paint','shape'],'viewpoint'),palette:viewColors.palette,viewColors,
    paintFocus:choice('paintFocus',['all','custom',...colorIds],'all'),imageMode:choice('imageMode',['rgb','mask','cutout'],'rgb'),
    speed:number('speed',30,1,120),yaw:number('yaw',-.65,-100,100),pitch:number('pitch',.55,-1.5,1.5),zoom:number('zoom',1,.05,128),panX:number('panX',0,-1000,1000),panY:number('panY',0,-1000,1000)
  };
}
export function serializeState(state) {
  const p=new URLSearchParams();
  for(const [key,value] of Object.entries(state)) {
    if(['series','headings','elevations','selectedId','viewColors'].includes(key)) continue;
    p.set(key,typeof value==='boolean'?(value?'1':'0'):String(value));
  }
  if(state.selectedId!==null) p.set('id',state.selectedId);
  for(const [key,values] of [['show',state.series],['atHeading',state.headings],['atElevation',state.elevations]]) {
    for(const value of values) p.append(key,String(value));
    if(!values.length) p.append(key,'');
  }
  if(state.viewColors){
    appendColorParams(p,{...state.viewColors,palette:state.palette});
    // A shared view must override recipient preferences even at default positions.
    for(const [name,position] of Object.entries(state.viewColors.positions))p.set('anchor-pos-'+name,position.join(','));
  }
  return p.toString();
}
export function cameraBasis(yaw,pitch) {
  const c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  return {right:[c,-s,0],up:[sp*s,sp*c,cp],toward:[-s*cp,-c*cp,sp]};
}
export function projector(bounds,state,width,height) {
  const mid=bounds.map(([a,b])=>(a+b)/2), spans=bounds.map(([a,b])=>Math.max(1e-6,b-a));
  const cx=width*(.5+state.panX),cy=height*(.5+state.panY);
  if(state.mode!=='3d') {
    const [a,b]=[...state.mode].map(Number),scale=Math.max(1,Math.min((width-100)/spans[a],(height-100)/spans[b]))*state.zoom;
    return v=>({x:cx+(v[a]-mid[a])*scale,y:cy-(v[b]-mid[b])*scale,depth:0});
  }
  const {right,up,toward}=cameraBasis(state.yaw,state.pitch),scale=Math.min(width*.68,height*.72)*state.zoom/Math.max(...spans);
  return v=>{const x=v[0]-mid[0],y=v[1]-mid[1],z=v[2]-mid[2];return {x:cx+(right[0]*x+right[1]*y)*scale,y:cy-(up[0]*x+up[1]*y+up[2]*z)*scale,depth:toward[0]*x+toward[1]*y+toward[2]*z};};
}
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
export function packColor(r,g,b) {return (littleEndian?(255<<24)|(b<<16)|(g<<8)|r:(r<<24)|(g<<16)|(b<<8)|255)>>>0;}
export function unpackColor(value) {return littleEndian?[value&255,(value>>>8)&255,(value>>>16)&255]:[(value>>>24)&255,(value>>>16)&255,(value>>>8)&255];}
export function createRaster(width,height) {
  const bytes=new Uint8ClampedArray(width*height*4);
  return {width,height,bytes,pixels:new Uint32Array(bytes.buffer),depth:new Float64Array(width*height),ids:new Int32Array(width*height)};
}
export function rasterize(frame,points,segments,radius) {
  const {width,height,pixels,depth,ids}=frame;
  pixels.fill(0);depth.fill(-Infinity);ids.fill(-1);
  // Each line pixel has interpolated camera depth; distant paths cannot cover front points.
  for(const {a,b,color,dashed} of segments) {
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(length<1e-8) continue;
    // Clip the parameter interval before traversal, including zoomed-outside endpoints.
    let lo=0,hi=1;
    for(const [start,delta,limit] of [[a.x,dx,width],[a.y,dy,height]]) {
      if(Math.abs(delta)<1e-10){if(start<0||start>=limit){hi=-1;break;}}
      else {let x=-start/delta,y=(limit-1-start)/delta;if(x>y)[x,y]=[y,x];lo=Math.max(lo,x);hi=Math.min(hi,y);}
    }
    if(hi<lo) continue;
    const steps=Math.max(1,Math.ceil(length*(hi-lo)*1.5));
    for(let j=0;j<=steps;j++) {
      const t=lo+(hi-lo)*j/steps;
      if(dashed&&t*length%9>4)continue;
      const x=Math.round(a.x+dx*t),y=Math.round(a.y+dy*t),z=a.depth+(b.depth-a.depth)*t;
      if(x<0||y<0||x>=width||y>=height)continue;
      const k=y*width+x;if(z>=depth[k]){depth[k]=z;pixels[k]=color;ids[k]=-1;}
    }
  }
  const rr=radius*radius;
  for(const p of points) {
    const x0=Math.max(0,Math.floor(p.x-radius)),x1=Math.min(width-1,Math.ceil(p.x+radius));
    const y0=Math.max(0,Math.floor(p.y-radius)),y1=Math.min(height-1,Math.ceil(p.y+radius));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      if((x+.5-p.x)**2+(y+.5-p.y)**2>rr)continue;
      const k=y*width+x;
      if(p.depth>depth[k]||(p.depth===depth[k]&&p.id>=ids[k])){depth[k]=p.depth;pixels[k]=p.color;ids[k]=p.id;}
    }
  }
  return frame;
}
export function pickPixel(frame,x,y) {
  x=Math.floor(x);y=Math.floor(y);
  if(x<0||y<0||x>=frame.width||y>=frame.height)return null;
  const id=frame.ids[y*frame.width+x];return id<0?null:id;
}
export function validateCatalog(catalog) {
  if(catalog.schema!=='solids-explorer-v1'||!Array.isArray(catalog.rows))throw Error('Unsupported catalog schema');
  if(catalog.count!==catalog.rows.length)throw Error('Catalog count mismatch');
  const ids=new Set(),shapes=new Map(catalog.shapes.map(s=>[s.id,s.heading_symmetry??s.period])),colors=new Set(catalog.colors.map(c=>c.id));
  for(const row of catalog.rows){
    if(!Number.isSafeInteger(row.id)||row.id<0||ids.has(row.id))throw Error('Invalid or duplicate row ID');ids.add(row.id);
    if(!shapes.has(row.shape)||!colors.has(row.color)||!Number.isFinite(row.heading)||!Number.isFinite(row.elevation))throw Error('Invalid row metadata');
    if(![row.image,row.mask].every(url=>typeof url==='string'&&url.startsWith('/dataset/')&&!url.includes('..')))throw Error('Invalid dataset image URL');
  }
  return catalog;
}
export function decodeProjection(buffer,count) {
  if(buffer.byteLength!==count*3*4)throw Error('Projection/catalog alignment mismatch');
  const data=new DataView(buffer),values=new Float32Array(count*3);
  for(let i=0;i<values.length;i++){
    const value=data.getFloat32(i*4,true);if(!Number.isFinite(value))throw Error('Projection contains non-finite coordinates');values[i]=value;
  }
  return values;
}
export function nearestSample(rows, heading, elevation, period) {
  let best = null, bestElevation = Infinity, bestHeading = Infinity;
  for (const row of rows) {
    const de = Math.abs(row.elevation - elevation);
    const dh = circularDistance(row.heading, heading, period);
    if (de < bestElevation || (de === bestElevation && (dh < bestHeading || (dh === bestHeading && row.id < best.id)))) {
      best = row; bestElevation = de; bestHeading = dh;
    }
  }
  return best;
}
