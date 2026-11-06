import {describePose,projectionVariance,clamp,canonicalHeading,circularDistance,seriesOf,nearestSample,filterRows,pathRings,parseState,serializeState,projector,cameraBasis,createRaster,rasterize,pickPixel,packColor,validateCatalog,decodeProjection} from './core.js';

import {fetchStatic,assetURL,warmDiagnostics,onDiagnosticsProgress} from './transport.js';
import {parseColorState,createColorMapping} from './view-colors.js';
import {mountViewMap} from './view-map.js';
import {buildPlotAxes,selectionOutlineSegments} from './plot-annotations.js';

const SHAPE_COLORS=['#70b8ff','#efb95f','#bc8bff','#75cfaf','#f18f9d','#e378d4','#c2dc62','#55d8de','#e28e5c','#a4b0c2'];
export function preparePointColors(catalog,state) {
  const rgbAt=createColorMapping(state.viewColors),packed=new Map(),pathPacked=new Map();
  const paints=new Map(catalog.colors.map(c=>[c.id,hexRGB(c.hex)]));
  const shapes=new Map(catalog.shapes.map((s,i)=>[s.id,hexRGB(SHAPE_COLORS[i%SHAPE_COLORS.length])]));
  for(const row of catalog.rows){const rgb=state.colorBy==='paint'?paints.get(row.color):state.colorBy==='shape'?shapes.get(row.shape):rgbAt(row.heading,row.elevation);packed.set(row.id,packColor(...rgb));pathPacked.set(row.id,packColor(...rgb.map((v,i)=>Math.round(v*.6+[16,25,40][i]*.4))));}
  return {packed,pathPacked,rgbAt};
}
export function withMaskAlpha(rgb,mask) {
  if(rgb.length!==mask.length||rgb.length%4)throw Error('RGB/mask dimensions differ');
  const out=new Uint8ClampedArray(rgb);for(let i=3;i<out.length;i+=4)out[i]=mask[i-3];return out;
}
export const needsBuildReload=(buildId,status)=>!status.refreshing&&typeof status.build_id==='string'&&status.build_id!==buildId;
export const apiURL=(endpoint,parameters={})=>`/api/${endpoint}${Object.keys(parameters).length?'?'+new URLSearchParams(parameters):''}`;
export async function requestJSON(url,options={},fetcher=fetchStatic) {
  const response=await fetcher(url,{cache:'no-store',...options});
  if(!response.ok)throw Error(`${url}: HTTP ${response.status} · ${(await response.text()).slice(0,240)}`);
  return response.json();
}
export function createSelectionGate() {
  let version=0;
  return {cancel(){version++;},async run(id,load,commit){const token=++version;const image=await load();if(token===version){commit(id,image);return true;}return false;}};
}

export function startExplorer() {
  const $=id=>document.getElementById(id),number=n=>Number(n).toLocaleString(),angle=n=>Number(n.toFixed(1));
  let catalog=null,state=null,coordinates=null,fit=null,byId=new Map(),indexById=new Map(),groups=new Map(),periods=new Map();
  let visible=[],visibleIds=new Set(),rings=[],colors=new Map(),pathColors=new Map(),screen=[],screenById=new Map(),raster=null,imageData=null;
  let projectionCache=new Map(),frame=0,markerFrame=0,urlTimer=0,refreshTimer=0,neighborTimer=0,playing=false,playFrame=0,lastPlay=0;
  let width=0,height=0,loadVersion=0,projectionVersion=0,neighborVersion=0,iouVersion=0,pendingId=null,errorStatus=null,renderStats={frames:0};
  let selectionGate=createSelectionGate(),imageCache=new Map(),busy=false,neighborsAbort=null,viewMap=null,viewRGB=null;
  let refreshSupported=false;
  onDiagnosticsProgress(progress=>{
    if(!state||progress.dimensions!==state.dimensions)return;
    const element=$('diagnostics-progress');
    element.textContent=progress.phase==='ready'?`${progress.dimensions}D exact diagnostics ready · verified vectors`:
      progress.phase==='error'?`Exact diagnostics unavailable: ${progress.error}. Select a row or prefix to retry.`:
      `${progress.dimensions}D diagnostics · ${progress.phase==='verifying'?'verifying exact vectors':`downloading ${(progress.loaded/1048576).toFixed(1)} / ${(progress.total/1048576).toFixed(1)} MiB`} · plot controls remain usable`;
  });
  const plot=$('plot'),canvas=$('plot-canvas'),overlay=$('marker-canvas'),ctx=canvas.getContext('2d'),marker=overlay.getContext('2d');
  const offscreen=document.createElement('canvas'),pixelContext=offscreen.getContext('2d');
  const pairControls=new Map(),groupControls=new Map(),headingControls=new Map(),elevationControls=new Map();
  const diagnosticErrors=new Map();
  const clearError=()=>{errorStatus=null;$('error').hidden=true;$('error').textContent='';};
  function fail(error,scope='Data load') {
    errorStatus=`${scope}: ${error.message||error}`;$('error').textContent=errorStatus;$('error').hidden=false;console.error(error);
  }
  const selected=()=>state?byId.get(state.selectedId)||null:null;
  const coords=row=>{const i=indexById.get(row.id)*3;return [coordinates[i],coordinates[i+1],coordinates[i+2]];};
  const currentPeriod=()=>periods.get(state.seriesId.split('/')[0]);
  const currentShape=()=>catalog.shapes.find(s=>s.id===state.seriesId.split('/')[0]);
  const axis=i=>(fit?.method==='semantic'?'S':fit?.method?.toLowerCase()==='pls'?'LV':'PC')+(i+1);
  function syncURL() {clearTimeout(urlTimer);urlTimer=setTimeout(()=>{if(state)history.replaceState(null,'','?'+serializeState(state));},160);}
  function schedule() {if(!frame)frame=requestAnimationFrame(draw);}
  function scheduleMarker() {if(!markerFrame)markerFrame=requestAnimationFrame(()=>{markerFrame=0;drawMarker();});}
  function changed({filters=false,recolor=false}={}) {
    if(filters) updateVisible();
    if(recolor) cacheColors();
    syncControls();schedule();syncURL();
  }
  function cacheColors() {
    const prepared=preparePointColors(catalog,state);colors=prepared.packed;pathColors=prepared.pathPacked;viewRGB=prepared.rgbAt;
    const legend=$('color-legend');legend.replaceChildren();
    if(state.colorBy==='viewpoint')legend.textContent='Viewpoint colors: physical heading × elevation, shared across all solids. The map below is the color key; drag A–D to edit it.';
    else{
      legend.append(document.createTextNode(state.colorBy==='paint'?'Paint colors: ':'Shape colors: '));
      const entries=state.colorBy==='paint'?catalog.colors.map(c=>[c.id,c.hex]):catalog.shapes.map((s,i)=>[s.label,SHAPE_COLORS[i%SHAPE_COLORS.length]]);
      for(const [label,color] of entries){const item=node('span'),dot=node('span','dot');dot.style.background=color;item.append(dot,document.createTextNode(' '+label+' · '));legend.append(item);}
      legend.append(document.createTextNode('The view map still shows pose colors.'));
    }
  }
  function savedColors() {
    try{return JSON.parse(localStorage.getItem('solids-view-colors')||'null');}catch{return null;}
  }
  function applyColors(next) {
    stop();state.viewColors=next;state.palette=next.palette;state.colorBy='viewpoint';
    try{const saved=savedColors()||{};saved.positions=next.positions;if(next.palette==='custom')saved.anchors=next.anchors;localStorage.setItem('solids-view-colors',JSON.stringify(saved));}catch{/* Storage may be disabled; URL state still works. */}
    changed({recolor:true});
  }
  function updateVisible() {
    visible=filterRows(catalog,state);visibleIds=new Set(visible.map(r=>r.id));rings=pathRings(visible);
    const counts=new Map();for(const row of visible)counts.set(seriesOf(row),(counts.get(seriesOf(row))||0)+1);
    for(const s of catalog.series) {
      const entry=pairControls.get(s.id);if(entry)entry.count.textContent=`${number(counts.get(s.id)||0)} / ${number(s.count)} / ${number(s.expected)}`;
    }
    $('visible-count').textContent=`· ${state.series.length} pairs · ${number(visible.length)} views`;
    $('plot-empty').hidden=visible.length!==0||busy;
    if(selected()&&!visibleIds.has(state.selectedId))clearSelection();
  }
  function syncControls() {
    if(!state)return;
    if(fit&&!busy)$('variance').textContent=fit.ratio?`${(projectionVariance(fit.ratio,state.mode)*100).toFixed(1)}% of fit-cohort variance shown · ${number(fit.fit_count)} fit views`:'Supervised semantic display · not held-out accuracy';
    if(![...$('speed').options].some(option=>Number(option.value)===state.speed))$('speed').add(new Option(state.speed+'° / sec',String(state.speed)));
    const controls={fit:'fit',dimensions:'dimensions',projection:'mode',palette:'palette','point-color':'colorBy','point-size':'pointSize','heading-mode':'headingMode','elevation-mode':'elevationMode',speed:'speed','image-mode':'imageMode',series:'seriesId','paint-focus':'paintFocus'};
    for(const [id,key] of Object.entries(controls))$(id).value=state[key];
    $('paths').checked=state.paths;$('all-headings').checked=state.headingMode==='all';$('all-elevations').checked=state.elevationMode==='all';
    const mapHeading=state.heading>=0&&state.heading<=360?state.heading:canonicalHeading(state.heading,360);
    $('heading').value=mapHeading;$('elevation').value=state.elevation;
    $('heading-value').textContent=angle(state.heading)+'°';$('elevation-value').textContent=angle(state.elevation)+'°';
    $('request-summary').textContent=describePose(currentShape(),state.heading,state.elevation).summary;
    $('zoom-level').textContent=state.zoom.toFixed(1)+'×';$('play').disabled=!visible.length||busy;
    $('slice-summary').textContent=`${state.headingMode==='all'?'All headings':state.headingMode==='current'?'Follow requested heading':state.headings.length+' heading targets'} · ${state.elevationMode==='all'?'all elevations':state.elevationMode==='current'?'follow requested elevation':state.elevations.length+' elevations'}`;
    for(const [id,entry] of pairControls){entry.input.checked=state.series.includes(id);entry.label.dataset.inspected=String(seriesOf(selected()||{})===id);}
    for(const entry of groupControls.values()){const n=entry.ids.filter(id=>state.series.includes(id)).length;entry.input.checked=n===entry.ids.length;entry.input.indeterminate=n>0&&n<entry.ids.length;entry.count.textContent=`${n} / ${entry.ids.length}`;}
    for(const [v,input] of headingControls)input.checked=state.headingMode==='all'||(state.headingMode==='selected'?state.headings.includes(v):v===canonicalHeading(state.heading,360));
    for(const [v,input] of elevationControls)input.checked=state.elevationMode==='all'||(state.elevationMode==='selected'?state.elevations.includes(v):v===state.elevation);
    if(viewRGB)viewMap?.update({colors:state.viewColors,rgbAt:viewRGB,rows:groups.get(state.seriesId)||[],requested:{heading:mapHeading,elevation:state.elevation},recorded:selected()});
  }
  function draw() {
    frame=0;if(!coordinates||!fit||!width||busy)return;
    const started=performance.now(),project=projector(fit.bounds,state,width,height);
    ctx.clearRect(0,0,width,height);
    const annotations=buildPlotAxes(fit.bounds,state,width,height,i=>axis(i)+(state.mode==='3d'&&fit.ratio?` · ${(fit.ratio[i]*100).toFixed(1)}%`:''));
    screen=visible.map(row=>({...project(coords(row)),id:row.id,color:colors.get(row.id)}));
    screenById=new Map(screen.map(p=>[p.id,p]));
    const segments=[...annotations.segments];
    if(state.paths)for(const ring of rings) {
      if(ring.length<2)continue;
      for(let i=1;i<=ring.length;i++){
        const a=ring[i-1],b=ring[i%ring.length];
        segments.push({a:screenById.get(a.id),b:screenById.get(b.id),color:pathColors.get(b.id),dashed:i===ring.length||b.heading-a.heading>1.01});
      }
    }
    rasterize(raster,screen,segments,state.pointSize);
    pixelContext.putImageData(imageData,0,0);ctx.drawImage(offscreen,0,0,width,height);
    ctx.font='11px system-ui';ctx.fillStyle='#a4b3c9';for(const label of annotations.labels)ctx.fillText(label.text,label.x,label.y);
    renderStats={frames:renderStats.frames+1,ms:performance.now()-started,points:screen.length,segments:segments.length-annotations.segments.length,gridSegments:annotations.segments.length,axisLabels:annotations.labels,renderer:'cached CPU pixel depth buffer',width,height,depthPicking:true};
    drawMarker();
  }

  function drawMarker() {
    marker.clearRect(0,0,width,height);if(!state)return;
    const row=selected(),p=row&&screenById.get(row.id);
    if(p&&visibleIds.has(row.id)) {
      const occluded=pickPixel(raster,p.x,p.y)!==row.id;
      marker.save();marker.strokeStyle='#fff';marker.lineWidth=1.6;marker.beginPath();for(const s of selectionOutlineSegments(raster,p,state.pointSize+5)){marker.moveTo(s.x1,s.y1);marker.lineTo(s.x2,s.y2);}marker.stroke();marker.setLineDash(occluded?[3,3]:[]);
      if(occluded){marker.beginPath();marker.moveTo(p.x-12,p.y);marker.lineTo(p.x-7,p.y);marker.moveTo(p.x+7,p.y);marker.lineTo(p.x+12,p.y);marker.stroke();}marker.restore();
      $('selection-status').textContent=occluded?'Selected row is occluded: dashed crosshair locates it. Rotate or zoom to reveal the actual point.':'White outline: inspected source row. Its image and point share one row ID.';
    } else $('selection-status').textContent=visible.length?'Click a measured point to inspect its source image.':'No encoded views match these filters.';
    if(state.mode==='3d') {
      const {right,up}=cameraBasis(state.yaw,state.pitch),cx=width-50,cy=height-42;
      for(let i=0;i<3;i++){marker.strokeStyle=['#ed8686','#7dd7b3','#8facff'][i];marker.fillStyle=marker.strokeStyle;marker.font='10px system-ui';marker.beginPath();marker.moveTo(cx,cy);marker.lineTo(cx+right[i]*25,cy-up[i]*25);marker.stroke();marker.fillText(axis(i),cx+right[i]*33,cy-up[i]*33);}
    }
  }
  function resize() {
    const rect=plot.getBoundingClientRect();width=Math.max(1,Math.round(rect.width));height=Math.max(1,Math.round(rect.height));
    // Point raster is at CSS-pixel resolution; text/selection retain device resolution.
    const dpr=Math.min(devicePixelRatio||1,2);
    for(const [c,context] of [[canvas,ctx],[overlay,marker]]){c.width=Math.round(width*dpr);c.height=Math.round(height*dpr);context.setTransform(dpr,0,0,dpr,0,0);}
    offscreen.width=width;offscreen.height=height;raster=createRaster(width,height);imageData=new ImageData(raster.bytes,width,height);schedule();
  }
  function clearSelection() {
    diagnosticErrors.clear();
    selectionGate.cancel();pendingId=null;state.selectedId=null;neighborVersion++;iouVersion++;neighborsAbort?.abort();
    $('preview').hidden=true;$('preview').removeAttribute('src');delete $('preview').dataset.rowId;
    $('image-loading').hidden=false;$('image-loading').textContent=visible.length?'Select an encoded view':'No views selected';
    $('selected-view').textContent='No selected row';$('mismatch').textContent='—';
    for(const id of ['requested-view','row-info','source-info','coordinates','neighbors','image-error'])$(id).replaceChildren();
    $('reference-score').textContent='Select an encoded view.';delete $('reference-score').dataset.referenceId;delete $('reference-score').dataset.cosine;delete $('reference-score').dataset.queryId;$('reference-gallery').replaceChildren();$('reference-source').hidden=true;$('reference-source').removeAttribute('href');
    $('original').hidden=true;$('mask-original').hidden=true;$('iou-result').textContent='Choose “IoU” beside a neighbor.';scheduleMarker();
  }
  async function loadImage(url,key=url) {
    if(imageCache.has(key))return imageCache.get(key);
    const image=new Image();image.decoding='async';image.src=url;await image.decode();
    imageCache.set(key,image);while(imageCache.size>20)imageCache.delete(imageCache.keys().next().value);return image;
  }
  async function loadPreview(row,mode) {
    if(mode!=='cutout')return loadImage(mode==='mask'?assetURL(row.mask):assetURL(row.image));
    const key='cutout:'+row.image;if(imageCache.has(key))return imageCache.get(key);
    const [rgb,mask]=await Promise.all([loadImage(assetURL(row.image)),loadImage(assetURL(row.mask))]);
    if(rgb.naturalWidth!==mask.naturalWidth||rgb.naturalHeight!==mask.naturalHeight)throw Error('RGB/mask dimensions differ');
    const c=document.createElement('canvas');c.width=rgb.naturalWidth;c.height=rgb.naturalHeight;const context=c.getContext('2d');
    context.drawImage(mask,0,0);const alpha=context.getImageData(0,0,c.width,c.height).data;
    context.drawImage(rgb,0,0);const pixels=context.getImageData(0,0,c.width,c.height);
    pixels.data.set(withMaskAlpha(pixels.data,alpha));context.putImageData(pixels,0,0);
    return loadImage(c.toDataURL('image/png'),key);
  }
  async function selectRow(id,{request=true,reveal=false}={}) {
    if(!coordinates||busy)return false;
    const row=byId.get(Number(id));if(!row)return false;
    if(reveal){state.series=[...new Set([...state.series,seriesOf(row)])];state.paintFocus='custom';state.headingMode='all';state.elevationMode='all';updateVisible();}
    if(!visibleIds.has(row.id))return false;
    state.seriesId=seriesOf(row);if(request){state.heading=row.heading;state.elevation=row.elevation;}
    syncControls();pendingId=row.id;const epoch=loadVersion,mode=state.imageMode;
    $('image-error').textContent='';$('image-loading').hidden=false;$('image-loading').textContent=`Loading row ${row.id}…`;
    try {
      return await selectionGate.run(row.id,()=>loadPreview(row,mode),(actual,image)=>{
        if(epoch!==loadVersion||!visibleIds.has(actual))return;
        pendingId=null;state.selectedId=actual;
        const preview=$('preview');preview.src=image.src;preview.hidden=false;preview.dataset.rowId=String(actual);preview.dataset.imageMode=mode;preview.alt=`${row.color} ${row.shape}, recorded heading ${row.heading}°, elevation ${row.elevation}°, source row ${row.id}`;
        $('image-loading').hidden=true;updateInspector();scheduleMarker();syncControls();syncURL();scheduleNeighbors();
      });
    }catch(error){if(epoch===loadVersion&&pendingId===row.id){pendingId=null;$('image-loading').hidden=true;$('image-error').textContent=`Source image failed for row ${row.id}: ${error.message}. No substitute image is shown.`;errorStatus=$('image-error').textContent;stop();}return false;}
  }
  function updateInspector() {
    const row=selected();if(!row)return;
    const description=describePose(catalog.shapes.find(s=>s.id===row.shape),state.heading,state.elevation,row);
    $('selected-view').textContent=`${row.color} ${row.shape} · ${row.heading}° / ${row.elevation}°`;
    $('mismatch').textContent=description.badge;
    $('requested-view').textContent=description.requested;
    $('row-info').textContent=`Global row ${row.id} · ${row.source_dataset??'original'} local row ${row.source_row_index??row.id} · ${state.dimensions} values · ${row.source==='full'?'dense':'balanced'} sample`;
    $('source-info').textContent=row.key;
    $('image-tag').textContent=`${state.imageMode==='cutout'?'DISPLAY CUTOUT':state.imageMode==='mask'?'SOURCE MASK':'SOURCE RGB'} / ROW ${row.id}`;
    $('coordinates').replaceChildren(...coords(row).map((value,i)=>{const div=node('div','coordinate');div.append(node('b','',axis(i)),node('span','',value.toFixed(4)));return div;}));
    $('original').href=assetURL(row.image);$('original').hidden=false;$('mask-original').href=assetURL(row.mask);$('mask-original').hidden=false;
  }
  function requestView() {
    if(!catalog||busy)return;
    if(state.headingMode==='current'||state.elevationMode==='current'){updateVisible();schedule();}
    const candidates=visible.filter(r=>seriesOf(r)===state.seriesId),row=nearestSample(candidates,state.heading,state.elevation,currentPeriod());
    if(row){if(row.id===state.selectedId&&state.imageMode===$('preview').dataset.imageMode){updateInspector();syncControls();syncURL();}else selectRow(row.id,{request:false});}
    else {clearSelection();syncControls();syncURL();}
  }
  function scheduleNeighbors() {
    diagnosticErrors.clear();
    $('reference-score').textContent='Loading exact reference cosine…';delete $('reference-score').dataset.referenceId;delete $('reference-score').dataset.cosine;delete $('reference-score').dataset.queryId;$('reference-gallery').replaceChildren();$('reference-source').hidden=true;$('reference-source').removeAttribute('href');
    clearTimeout(neighborTimer);neighborVersion++;neighborsAbort?.abort();$('neighbors').textContent='Loading exact cosine neighbors…';$('iou-result').textContent='Choose “IoU” beside a neighbor.';iouVersion++;
    neighborTimer=setTimeout(loadNeighbors,playing?350:120);
  }
  async function loadNeighbors() {
    const row=selected();if(!row)return;
    const version=++neighborVersion,build=catalog.build_id,dimensions=state.dimensions;neighborsAbort=new AbortController();
    const signal=neighborsAbort.signal,current=()=>!signal.aborted&&version===neighborVersion&&row.id===state.selectedId&&build===catalog.build_id&&dimensions===state.dimensions;
    await Promise.all(['neighbors','reference','reference-gallery'].map(async endpoint=>{
    try {
      const result=await requestJSON(apiURL(endpoint,{build,id:row.id,dimensions,...(endpoint==='reference'?{}:{k:8})}),{signal});
      if(!current())return;
      if(result.query_id!==row.id||result.dimensions!==dimensions)throw Error('Diagnostic response does not match the selected row/prefix');
      if(endpoint==='reference'){
      const reference=result,ref=byId.get(reference.reference_id);
      if(!ref||!Number.isFinite(reference.cosine))throw Error('Invalid reference row or cosine');
      $('reference-score').textContent=`cos ${reference.cosine.toFixed(6)} · ${dimensions}D · row ${row.id} ↔ ${ref.id} (${ref.heading}° / ${ref.elevation}°). Same shape and paint; fixed reference independent of projection.`;
      Object.assign($('reference-score').dataset,{referenceId:String(ref.id),queryId:String(row.id),cosine:String(reference.cosine)});$('reference-source').href=assetURL(ref.image);$('reference-source').hidden=false;
      }else if(endpoint==='reference-gallery'){
      if(!Array.isArray(result.neighbors))throw Error('Invalid reference gallery');
      for(const n of result.neighbors)if(!n||!byId.has(n.id)||!Number.isFinite(n.cosine))throw Error('Invalid reference gallery entry');
      $('reference-gallery').replaceChildren();
      for(const n of result.neighbors){
        const other=byId.get(n.id);
        const item=node('div','neighbor'),image=node('img');image.src=assetURL(other.image);image.alt=`Reference ${other.color} ${other.shape}`;image.loading='lazy';
        const choose=node('button','neighbor-select',`${other.color} ${other.shape}`);choose.append(node('small','',`${other.heading}° / ${other.elevation}° · cos ${n.cosine.toFixed(5)}`));choose.onclick=()=>{stop();selectRow(other.id,{reveal:true});changed();};item.dataset.rowId=String(other.id);item.append(image,choose);$('reference-gallery').append(item);
      }
      }else{
      if(!Array.isArray(result.neighbors))throw Error('Invalid neighbors');
      for(const n of result.neighbors)if(!n||!byId.has(n.id)||!Number.isFinite(n.cosine))throw Error('Invalid neighbor row or cosine');
      $('neighbors').replaceChildren();
      for(const n of result.neighbors){
        const other=byId.get(n.id);
        const item=node('div','neighbor'),image=node('img');image.src=assetURL(other.image);image.alt=`${other.color} ${other.shape}`;image.loading='lazy';
        const choose=node('button','neighbor-select',`${other.color} ${other.shape}`);choose.append(node('small','',`${other.heading}° / ${other.elevation}° · cos ${n.cosine.toFixed(5)}`));choose.onclick=()=>{stop();selectRow(other.id,{reveal:true});changed();};
        const compare=node('button','', 'IoU');compare.setAttribute('aria-label',`Compare silhouette with row ${other.id}`);compare.onclick=()=>compareIoU(other.id);item.append(image,choose,compare);$('neighbors').append(item);
      }
      if(!result.neighbors.length)$('neighbors').textContent='No other encoded rows in this build.';
      }
      diagnosticErrors.delete(endpoint);
    }catch(error){if(error.name!=='AbortError'&&current()){
      const panel=endpoint==='reference'?'reference-score':endpoint;
      if(endpoint==='reference'){delete $(panel).dataset.referenceId;delete $(panel).dataset.cosine;delete $(panel).dataset.queryId;$('reference-source').hidden=true;$('reference-source').removeAttribute('href');}
      $(panel).textContent=`${endpoint==='neighbors'?'Neighbors':endpoint==='reference'?'Reference diagnostics':'Reference gallery'} unavailable: ${error.message}`;diagnosticErrors.set(endpoint,error.message);
    }}
    }));
  }
  async function compareIoU(other) {
    const row=selected();if(!row)return;const version=++iouVersion,build=catalog.build_id;$('iou-result').textContent='Comparing source masks…';
    try {
      const value=await requestJSON(apiURL('iou',{build,id:row.id,other}));
      if(version!==iouVersion||state.selectedId!==row.id||catalog.build_id!==build)return;
      if(value.id!==row.id||value.other!==other||!Number.isFinite(value.binary_iou)||!Number.isFinite(value.soft_iou))throw Error('Invalid IoU response');
      $('iou-result').textContent=`Rows ${row.id} ↔ ${other}: binary IoU ${value.binary_iou.toFixed(4)} · soft IoU ${value.soft_iou.toFixed(4)}. ${value.note||''}`;
      diagnosticErrors.delete('iou');
    }catch(error){if(version===iouVersion&&state.selectedId===row.id&&catalog.build_id===build){$('iou-result').textContent=`IoU unavailable: ${error.message}`;diagnosticErrors.set('iou',error.message);}}
  }
  function mountMatrix() {
    $('matrix').replaceChildren();$('series').replaceChildren();pairControls.clear();groupControls.clear();
    $('paint-focus').replaceChildren(new Option('All paints','all'),new Option('Custom pairs','custom'),...catalog.colors.map(c=>new Option('Only '+c.id,c.id)));
    for(const shape of catalog.shapes){
      const ids=catalog.series.filter(s=>s.shape===shape.id).map(s=>s.id),group=node('section','legend-group'),head=node('div','legend-group-head'),label=node('label'),input=node('input'),only=node('button','','Only'),paints=node('div','legend-paints');
      input.type='checkbox';input.setAttribute('aria-label','Show all '+shape.label+' colors');label.append(input,node('strong','',shape.label));head.append(label,only);group.append(head,paints);$('matrix').append(group);const count=node('span','group-count small');count.setAttribute('aria-label',shape.label+' selected paint count');head.insertBefore(count,only);groupControls.set(shape.id,{input,ids,count});
      only.setAttribute('aria-label','Only '+shape.label);only.onclick=()=>setSeries(ids);input.onchange=()=>setSeries(input.checked?[...new Set([...state.series,...ids])]:state.series.filter(id=>!ids.includes(id)));
      const optgroup=node('optgroup');optgroup.label=shape.label;$('series').append(optgroup);
      for(const color of catalog.colors){
        const id=`${shape.id}/${color.id}`,series=catalog.series.find(s=>s.id===id);if(!series)continue;
        optgroup.append(new Option(`${shape.label} / ${color.id}`,id));
        const label=node('label','paint-label'),input=node('input'),dot=node('span','dot'),count=node('span','sample-count');input.type='checkbox';input.setAttribute('aria-label',`Show ${shape.label} ${color.id}`);dot.style.background=color.hex;label.append(input,dot,document.createTextNode(color.id),count);paints.append(label);
        pairControls.set(id,{input,label,count});input.onchange=()=>setSeries(input.checked?[...new Set([...state.series,id])]:state.series.filter(s=>s!==id),input.checked?id:null);
      }
    }
    mountChoices('heading', [...new Set([...Array.from({length:24},(_,i)=>i*15),72,...state.headings])].sort((a,b)=>a-b),headingControls);
    mountChoices('elevation',[...new Set(catalog.rows.map(r=>r.elevation))].sort((a,b)=>a-b),elevationControls);
    const elevations=[...elevationControls.keys()];$('elevation').min=Math.min(...elevations);$('elevation').max=Math.max(...elevations);
  }
  function mountChoices(kind,values,map) {
    $(kind+'-choices').replaceChildren();map.clear();
    for(const value of values){const label=node('label'),input=node('input');input.type='checkbox';input.setAttribute('aria-label',`Compare ${kind} ${value} degrees`);label.append(input,document.createTextNode(value+'°'));$(kind+'-choices').append(label);map.set(value,input);
      input.onchange=()=>{stop();const key=kind==='heading'?'headings':'elevations',mode=kind+'Mode';const next=new Set(state[mode]==='all'?values:state[mode]==='current'?[state[kind]]:state[key]);input.checked?next.add(value):next.delete(value);state[key]=[...next];state[mode]='selected';changed({filters:true});ensureSelection();};}
  }
  function setSeries(ids,previewSeries=null) {
    stop();state.series=[...new Set(ids)];const paints=new Set(ids.map(id=>id.split('/')[1]));state.paintFocus=paints.size===1?[...paints][0]:ids.length===catalog.series.length?'all':'custom';
    if(previewSeries)state.seriesId=previewSeries;changed({filters:true});ensureSelection(Boolean(previewSeries));
  }
  function ensureSelection(force=false) {
    if(!visible.length){clearSelection();syncURL();return;}
    if(!force&&selected()&&visibleIds.has(state.selectedId))return;
    if(!visible.some(r=>seriesOf(r)===state.seriesId))state.seriesId=seriesOf(visible[0]);requestView();
  }
  async function loadProjection() {
    const version=++projectionVersion,build=catalog.build_id,key=`${state.dimensions}/${state.fit}`;
    const diagnosticsDimensions=state.dimensions;
    void warmDiagnostics(diagnosticsDimensions).catch(error=>{if(error.name!=='AbortError'&&state.dimensions===diagnosticsDimensions)$('diagnostics-progress').textContent=`Exact diagnostics unavailable: ${error.message}. Select a row or prefix to retry.`;});
    busy=true;document.querySelector('.layout').inert=true;document.body.dataset.loading='true';$('variance').textContent='Loading actual projection…';clearError();
    try {
      const nextFit=catalog.projections[key];if(!nextFit)throw Error('Requested projection is absent from the catalog');
      if(!nextFit.url.startsWith(`/data/${build}/`))throw Error('Projection URL is outside the current build');
      let values=projectionCache.get(key);
      if(!values){const response=await fetchStatic(nextFit.url);if(!response.ok)throw Error(`Projection HTTP ${response.status}`);values=decodeProjection(await response.arrayBuffer(),catalog.rows.length);}
      if(version!==projectionVersion||catalog.build_id!==build)return false;
      projectionCache.set(key,values);coordinates=values;fit=nextFit;
      if(!Array.isArray(fit.bounds)||fit.bounds.length!==3||!fit.bounds.every(b=>b.length===2&&b.every(Number.isFinite)&&b[0]<=b[1]))throw Error('Invalid projection bounds');
      $('plot-title').textContent=`EmbeddingGemma 2 · ${state.dimensions}D · ${fit.label}`;
      $('variance').textContent=fit.ratio?`${(projectionVariance(fit.ratio,state.mode)*100).toFixed(1)}% of fit-cohort variance shown · ${number(fit.fit_count)} fit views`:'Supervised semantic display · not held-out accuracy';
      $('fit-note').textContent=fit.note;
      $('projection-download').href=assetURL(fit.url);$('basis-download').href=assetURL(`/data/${build}/${fit.basis_file}`);updateInspector();if(selected())scheduleNeighbors();
      return true;
    }catch(error){if(version===projectionVersion){coordinates=null;fit=null;$('variance').textContent='Projection unavailable';screen=[];screenById.clear();rasterize(raster,[],[],state.pointSize);clearSelection();ctx.clearRect(0,0,width,height);marker.clearRect(0,0,width,height);fail(error,'Projection unavailable');}return false;}
    finally{if(version===projectionVersion){busy=false;document.querySelector('.layout').inert=false;document.body.dataset.loading='false';syncControls();schedule();}}
  }
  async function loadBuild() {
    const epoch=++loadVersion;stop();selectionGate.cancel();neighborsAbort?.abort();neighborVersion++;iouVersion++;pendingId=null;
    busy=true;document.querySelector('.layout').inert=true;$('copy-link').disabled=true;document.body.dataset.loading='true';clearError();
    try {
      const current=await requestJSON('/data/current.json');
      if(current.schema!=='solids-explorer-v1'||typeof current.catalog_url!=='string'||!current.catalog_url.startsWith(`/data/${current.build_id}/`))throw Error('Invalid current-build manifest');
      const next=validateCatalog(await requestJSON(current.catalog_url));if(next.build_id!==current.build_id||next.count!==current.count)throw Error('Manifest/catalog build mismatch');
      if(epoch!==loadVersion)return;
      const query=state?serializeState(state):location.search;catalog=next;state=parseState(query,catalog,savedColors());
      coordinates=null;fit=null;projectionCache.clear();imageCache.clear();screen=[];screenById.clear();
      byId=new Map(catalog.rows.map(r=>[r.id,r]));indexById=new Map(catalog.rows.map((r,i)=>[r.id,i]));periods=new Map(catalog.shapes.map(s=>[s.id,s.heading_symmetry??s.period]));groups=new Map();
      for(const row of catalog.rows){const key=seriesOf(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
      const restoreId=state.selectedId;state.selectedId=null;
      $('fit').replaceChildren(...catalog.fits.map(id=>new Option(catalog.projections[`${state.dimensions}/${id}`].label,id)));
      mountMatrix();cacheColors();updateVisible();clearSelection();syncControls();$('copy-link').disabled=false;
      $('catalog-link').href=assetURL(current.catalog_url);$('catalog-link').textContent='Build catalog (.json.gz) ↗';$('footer-build').textContent=`${number(catalog.count)} encoded rows · build ${catalog.build_id}`;
      $('provenance').textContent=`${catalog.model} · revision ${catalog.revision} · source ${catalog.feature_source} · created ${catalog.created_at}`;
      updateCoverage(current);
      await loadProjection();if(epoch!==loadVersion)return;
      if(restoreId!==null&&visibleIds.has(restoreId))await selectRow(restoreId,{request:false});else ensureSelection();
      syncControls();resize();await checkStatus();
    }catch(error){if(epoch===loadVersion){busy=false;document.body.dataset.loading='false';coordinates=null;screen=[];screenById.clear();ctx.clearRect(0,0,width,height);marker.clearRect(0,0,width,height);$('coverage').textContent='Build could not be loaded. No substitute data is used.';fail(error);}}
  }
  function updateCoverage(status) {
    const expected=status.expected_count;$('coverage-progress').max=expected;$('coverage-progress').value=status.count||0;
    $('coverage').textContent=`${number(status.count||0)} / ${number(expected)} verified embeddings · ${status.complete?'complete build':'partial build'}${status.created_at?' · '+status.created_at:''}${status.refreshing?' · refreshing local export…':''}`;
    const partial=catalog?catalog.series.filter(s=>s.count<s.expected).length:0,balanced=catalog?catalog.rows.filter(r=>r.source==='balanced').length:0;
    if(status.refresh_supported===false||status.refresh_supported===true)refreshSupported=status.refresh_supported;
    const gated=!refreshSupported;
    $('coverage-detail').textContent=gated?'Verified static publication across registered source datasets. Diagnostics download exact vectors in this browser; refresh requires a new publication. No inference is started.':`${partial} incomplete dense groups · ${number(balanced)} retained balanced-source rows.`;
    $('refresh').disabled=gated||Boolean(status.refreshing);$('refresh').textContent=gated?'Refresh gated':status.refreshing?'Refreshing…':'Refresh local data';
  }
  async function checkStatus() {
    clearTimeout(refreshTimer);
    try {
      const status=await requestJSON('/api/status');updateCoverage(status);
      if(status.refresh_error)fail(Error(status.refresh_error),'Refresh failed');
      if(status.refreshing)refreshTimer=setTimeout(checkStatus,1200);
      else if(needsBuildReload(catalog?.build_id??null,status))await loadBuild();
    }catch(error){$('refresh').disabled=!refreshSupported;fail(error,'Status unavailable');}
  }
  async function refresh() {
    $('refresh').disabled=true;clearError();
    try {const result=await requestJSON('/api/refresh',{method:'POST'});if(!('refreshing' in result))throw Error('Invalid refresh response');await checkStatus();}
    catch(error){$('refresh').disabled=!refreshSupported;fail(error,'Refresh failed');}
  }
  function zoomAt(factor,x=width/2,y=height/2) {
    const previous=state.zoom;state.zoom=clamp(state.zoom*factor,.05,128);const ratio=state.zoom/previous;
    state.panX=(x-(x-width*(.5+state.panX))*ratio)/width-.5;state.panY=(y-(y-height*(.5+state.panY))*ratio)/height-.5;changed();
  }
  function reset(){Object.assign(state,{yaw:-.65,pitch:.55,zoom:1,panX:0,panY:0});changed();}
  function fitVisible() {
    if(!visible.length||!coordinates)return;state.zoom=1;state.panX=state.panY=0;
    const project=projector(fit.bounds,state,width,height);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for(const row of visible){const p=project(coords(row));minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
    state.panX=.5-(minX+maxX)/2/width;state.panY=.5-(minY+maxY)/2/height;zoomAt(Math.min((width-90)/Math.max(20,maxX-minX),(height-90)/Math.max(20,maxY-minY)));
  }
  function stop(){playing=false;cancelAnimationFrame(playFrame);lastPlay=0;$('play').textContent='▶ Play';$('play').setAttribute('aria-pressed','false');if(state)syncURL();}
  function animate(now) {
    if(!playing)return;
    if(!lastPlay)lastPlay=now;
    if(now-lastPlay>=100){state.heading=canonicalHeading(state.heading+(now-lastPlay)*state.speed/1000,360);lastPlay=now;requestView();}
    playFrame=requestAnimationFrame(animate);
  }
  function bind() {
    const comparison=document.querySelector('.comparison');
    try{comparison.open=localStorage.getItem('solids-comparison-open')!=='0';}catch{}
    comparison.addEventListener('toggle',()=>{try{localStorage.setItem('solids-comparison-open',comparison.open?'1':'0');}catch{}});
    for(const button of document.querySelectorAll('[data-request-heading]'))button.onclick=()=>{if(!state||busy)return;stop();state.heading=Number(button.dataset.requestHeading);requestView();};
    $('heading-opposite').onclick=()=>{if(!state||busy)return;stop();state.headings=[0,180];state.headingMode='selected';changed({filters:true});ensureSelection();};
    viewMap=mountViewMap($('view-map'),{onRequest(heading,elevation){if(!state||busy)return;stop();state.heading=heading;state.elevation=elevation;requestView();},onColors:applyColors});
    $('refresh').onclick=refresh;
    $('copy-link').onclick=async()=>{try{history.replaceState(null,'','?'+serializeState(state));await navigator.clipboard.writeText(location.href);$('copy-link').textContent='Link copied';setTimeout(()=>$('copy-link').textContent='Copy view link',1600);}catch(error){fail(error,'Copy link failed — copy the address bar instead');}};
    for(const id of ['fit','dimensions'])$(id).onchange=async()=>{stop();state[id]=id==='dimensions'?Number($(id).value):$(id).value;if(id==='fit')Object.assign(state,{yaw:-.65,pitch:.55,zoom:1,panX:0,panY:0});syncURL();await loadProjection();};
    for(const [id,key] of [['projection','mode'],['point-color','colorBy']])$(id).onchange=()=>{state[key]=$(id).value;changed({recolor:key!=='mode'});};
    $('palette').onchange=()=>{const next=parseColorState(new URLSearchParams({palette:$('palette').value}),{min:state.viewColors.elevationMin,max:state.viewColors.elevationMax},savedColors());next.positions=structuredClone(state.viewColors.positions);applyColors(next);};
    $('point-size').oninput=()=>{state.pointSize=Number($('point-size').value);changed();};$('paths').onchange=()=>{state.paths=$('paths').checked;changed();};
    for(const kind of ['heading','elevation']) {
      $(kind+'-mode').onchange=()=>{stop();state[kind+'Mode']=$(kind+'-mode').value;changed({filters:true});ensureSelection();};
      $('all-'+kind+'s').onchange=()=>{state[kind+'Mode']=$('all-'+kind+'s').checked?'all':'current';changed({filters:true});ensureSelection();};
      $(kind+'-all').onclick=()=>{state[kind+'Mode']='all';changed({filters:true});ensureSelection();};
      $(kind+'-none').onclick=()=>{state[kind+'Mode']='selected';state[kind==='heading'?'headings':'elevations']=[];changed({filters:true});ensureSelection();};
      $(kind).oninput=()=>{stop();state[kind]=Number($(kind).value);requestView();};
    }
    $('only-series').onclick=()=>setSeries([state.seriesId]);$('all-series').onclick=()=>setSeries(catalog.series.map(s=>s.id));$('clear-series').onclick=()=>setSeries([]);
    $('paint-focus').onchange=()=>{const paint=$('paint-focus').value;if(paint==='custom')return;let shapes=new Set(state.series.map(s=>s.split('/')[0]));if(!shapes.size)shapes=new Set(catalog.shapes.map(s=>s.id));setSeries(catalog.series.filter(s=>shapes.has(s.shape)&&(paint==='all'||s.color===paint)).map(s=>s.id));state.paintFocus=paint;syncControls();};
    $('series').onchange=()=>{state.seriesId=$('series').value;setSeries([...new Set([...state.series,state.seriesId])],state.seriesId);};
    $('image-mode').onchange=()=>{state.imageMode=$('image-mode').value;if(selected())selectRow(state.selectedId,{request:false});syncURL();};
    $('zoom-in').onclick=()=>zoomAt(1.4);$('zoom-out').onclick=()=>zoomAt(1/1.4);$('reset').onclick=reset;$('fit-visible').onclick=fitVisible;
    $('focus-point').onclick=()=>{const p=selected()&&screenById.get(state.selectedId);if(p){state.panX+=(width/2-p.x)/width;state.panY+=(height/2-p.y)/height;zoomAt(2);}};
    $('speed').onchange=()=>{state.speed=Number($('speed').value);syncURL();};
    $('play').onclick=()=>{if(playing){stop();return;}playing=true;$('play').textContent='Ⅱ Pause';$('play').setAttribute('aria-pressed','true');playFrame=requestAnimationFrame(animate);};
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
    let drag=null,hover=null,hoverFrame=0;
    overlay.onpointerdown=e=>{if(!state||busy)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,pan:e.shiftKey||e.button!==0||state.mode!=='3d'};overlay.setPointerCapture(e.pointerId);overlay.focus({preventScroll:true});};
    overlay.onpointermove=e=>{
      if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.moved ||= Math.abs(e.clientX-drag.startX)+Math.abs(e.clientY-drag.startY)>3;drag.x=e.clientX;drag.y=e.clientY;
        if(drag.pan){state.panX+=dx/width;state.panY+=dy/height;}else{state.yaw+=dx*.008;state.pitch=clamp(state.pitch+dy*.008,-1.5,1.5);}schedule();$('tooltip').hidden=true;return;}
      hover={x:e.clientX,y:e.clientY};if(!hoverFrame)hoverFrame=requestAnimationFrame(()=>{hoverFrame=0;if(!hover||!raster)return;const rect=overlay.getBoundingClientRect(),x=hover.x-rect.left,y=hover.y-rect.top,id=pickPixel(raster,x,y),row=byId.get(id);$('tooltip').hidden=!row;if(row){$('tooltip').textContent=`${row.color} ${row.shape} · ${row.heading}° / ${row.elevation}°\nRow ${row.id} · ${row.source}`;$('tooltip').style.left=clamp(x+12,4,Math.max(4,width-240))+'px';$('tooltip').style.top=clamp(y+12,4,height-58)+'px';}});
    };
    overlay.onpointerup=e=>{if(!drag)return;const moved=drag.moved;drag=null;if(!moved){const r=overlay.getBoundingClientRect(),id=pickPixel(raster,e.clientX-r.left,e.clientY-r.top);if(id!==null){stop();selectRow(id);}}changed();};
    overlay.onpointercancel=()=>{drag=null;};overlay.onpointerleave=()=>{hover=null;$('tooltip').hidden=true;};overlay.oncontextmenu=e=>e.preventDefault();
    overlay.addEventListener('wheel',e=>{if(!state)return;e.preventDefault();const r=overlay.getBoundingClientRect();zoomAt(Math.exp(-clamp(e.deltaY,-240,240)*.002),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    overlay.onkeydown=e=>{if(!state)return;const step=e.shiftKey?.15:.05;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(e.key))e.preventDefault();if(e.key==='0')reset();else if(e.key==='+'||e.key==='=')zoomAt(1.3);else if(e.key==='-')zoomAt(1/1.3);else if(e.key.startsWith('Arrow')){if(e.key==='ArrowLeft')state.yaw-=step;if(e.key==='ArrowRight')state.yaw+=step;if(e.key==='ArrowUp')state.pitch=clamp(state.pitch-step,-1.5,1.5);if(e.key==='ArrowDown')state.pitch=clamp(state.pitch+step,-1.5,1.5);changed();}};
    const wrap=$('image-wrap');wrap.tabIndex=0;wrap.setAttribute('role','group');wrap.setAttribute('aria-label','Selected image: drag or use left and right keys to change heading');let scrub=null,scrubFrame=0;
    wrap.onpointerdown=e=>{if(!selected())return;stop();scrub={id:e.pointerId,x:e.clientX,heading:state.heading};wrap.setPointerCapture(e.pointerId);};
    wrap.onpointermove=e=>{if(!scrub)return;state.heading=canonicalHeading(scrub.heading+(e.clientX-scrub.x)*360/wrap.clientWidth,360);if(!scrubFrame)scrubFrame=requestAnimationFrame(()=>{scrubFrame=0;requestView();});};wrap.onpointerup=wrap.onpointercancel=()=>scrub=null;
    wrap.onkeydown=e=>{if(!state||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();stop();state.heading=e.key==='Home'?0:e.key==='End'?360:canonicalHeading(state.heading+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?15:1),360);requestView();};
    window.addEventListener('popstate',()=>{if(!catalog)return;stop();state=parseState(location.search,catalog);const restore=state.selectedId;state.selectedId=null;changed({filters:true,recolor:true});loadProjection().then(()=>restore!==null&&visibleIds.has(restore)?selectRow(restore,{request:false}):ensureSelection());});
  }
  window.solidsExplorer={
    get selectedId(){return state?.selectedId??null;},get selected_id(){return state?.selectedId??null;},get visibleCount(){return visible.length;},get visiblecount(){return visible.length;},get buildId(){return catalog?.build_id??null;},get buildid(){return catalog?.build_id??null;},get errorStatus(){return errorStatus??[...diagnosticErrors.values()].at(-1)??null;},get errorstatus(){return this.errorStatus;},get renderStats(){return {...renderStats};},get renderstats(){return {...renderStats};},get pendingId(){return pendingId;},get playing(){return playing;},
    get imageRowId(){return $('preview').hidden?null:Number($('preview').dataset.rowId);},get markerRowId(){return selected()&&visibleIds.has(state.selectedId)?state.selectedId:null;},
    get state(){return state?structuredClone(state):null;},get catalog(){return catalog;},get visibleIds(){return visible.map(r=>r.id);},get screenPoints(){return screen.map(p=>({...p}));},colorAt:(heading,elevation)=>viewRGB?.(heading,elevation),
    exportState(){return {schema:'solids-explorer-view-v1',build_id:catalog?.build_id,state:state?structuredClone(state):null,url:state?location.origin+location.pathname+'?'+serializeState(state):location.href,renderStats:{...renderStats}};},
    async setState(patch){if(!catalog)throw Error('Catalog not loaded');state=parseState(serializeState({...state,...patch}),catalog);const id=state.selectedId;state.selectedId=null;changed({filters:true,recolor:true});await loadProjection();if(id!==null&&visibleIds.has(id))await selectRow(id,{request:false});else ensureSelection();},
    selectRow,refresh,fitVisible,reset,compareIoU,pick:(x,y)=>raster?pickPixel(raster,x,y):null,
    neighbors:()=>selected()?requestJSON(apiURL('neighbors',{build:catalog.build_id,id:state.selectedId,dimensions:state.dimensions,k:8})):Promise.resolve(null)
  };
  bind();new ResizeObserver(resize).observe(plot);resize();loadBuild();
  return window.solidsExplorer;
}
function node(tag,className='',text='') {const element=document.createElement(tag);if(className)element.className=className;if(text)element.textContent=text;return element;}
function hexRGB(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}

if(typeof document!=='undefined')startExplorer();
