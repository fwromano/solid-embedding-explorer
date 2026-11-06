// Heading stays in the visual 0…360 domain. Only color interpolation is circular.
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const ANCHORS = ['bottomLeft','topLeft','topRight','bottomRight'];
const cloneColors = state => ({...state,
  anchors: Object.fromEntries(ANCHORS.map(name => [name, [...state.anchors[name]]])),
  positions: Object.fromEntries(ANCHORS.map(name => [name, [...state.positions[name]]])),
});

// Same normalized, circular collision threshold as the reference position editor.
export function editAnchor(state, edit) {
  const next = cloneColors(state), low = state.elevationMin, high = state.elevationMax;
  if (edit.type === 'reset') {
    next.positions = {bottomLeft:[0,low],topLeft:[0,high],topRight:[180,high],bottomRight:[180,low]};
  } else if (!ANCHORS.includes(edit.name)) return null;
  else if (edit.type === 'color') {
    if (!Array.isArray(edit.rgb) || edit.rgb.length !== 3 || !edit.rgb.every(Number.isFinite)) return null;
    next.palette = 'custom';
    next.anchors[edit.name] = edit.rgb.map(v => Math.round(clamp(v, 0, 255)));
  } else if (edit.type === 'move') {
    if (!Number.isFinite(edit.heading) || !Number.isFinite(edit.elevation)) return null;
    const point = [clamp(edit.heading, 0, 360), clamp(edit.elevation, low, high)];
    const collision = ANCHORS.some(name => {
      if (name === edit.name) return false;
      const other = state.positions[name], h = Math.abs(point[0] - other[0]) % 360;
      return (Math.min(h, 360 - h) / 180) ** 2 + ((point[1] - other[1]) / (high - low || 1)) ** 2 < 1e-8;
    });
    if (collision) return null;
    next.positions[edit.name] = point;
  } else return null;
  return next;
}

const colorSignature = state => JSON.stringify([state.palette,state.elevationMin,state.elevationMax,
  ...ANCHORS.map(name => [state.anchors[name],state.positions[name]])]);

// Bounded one-entry cache. Selection, camera and recreated rgbAt closures never invalidate it.
export function createGradientCache(width = 361, height = 121) {
  let signature, raster;
  return (colors, rgbAt) => {
    const next = colorSignature(colors);
    if (next === signature) return raster;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const h = x / Math.max(1, width - 1) * 360;
      const e = colors.elevationMax - y / Math.max(1, height - 1) * (colors.elevationMax - colors.elevationMin);
      data.set([...rgbAt(h, e),255], (y * width + x) * 4);
    }
    signature = next;
    raster = {width,height,data};
    return raster;
  };
}

export function keyboardPose(pose, event, low, high, editing = false, shiftStep = 15) {
  if (editing || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return null;
  const step = event.shiftKey ? shiftStep : 1;
  return {
    heading: clamp(event.key === 'Home' ? 0 : event.key === 'End' ? 360 : pose.heading + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), 0, 360),
    elevation: clamp(pose.elevation + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0), low, high),
  };
}

export function pointToPose(x, y, rect, elevationMin, elevationMax) {
  return {
    heading: clamp((x - rect.left) / Math.max(1, rect.width), 0, 1) * 360,
    elevation: elevationMin + (1 - clamp((y - rect.top) / Math.max(1, rect.height), 0, 1)) * (elevationMax - elevationMin),
  };
}

const MAP_RECT = {left:0,top:0,width:360,height:120};
const rounded = value => Number(value.toFixed(1));
const rgbCss = rgb => `rgb(${rgb.join(' ')})`;

/** Mount once; update with current plain color state and only the selected series' actual rows. */
export function mountViewMap(root, {onRequest, onColors}) {
  const doc = root.ownerDocument;
  const html = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgNode = (tag, attributes = {}) => {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const section = html('section','view-map');
  section.setAttribute('aria-label','Heading and elevation view map');
  const title = html('h3','view-map-title','Heading × elevation');
  const chart = html('div','view-map-chart');
  const pad = html('div','view-map-pad');
  pad.setAttribute('tabindex','0');
  pad.setAttribute('role','group');
  const canvas = html('canvas','view-map-gradient');
  canvas.setAttribute('aria-hidden','true');
  const svg = svgNode('svg',{viewBox:'0 0 360 120',preserveAspectRatio:'none','aria-hidden':'true',class:'view-map-overlay'});
  const grid = svgNode('g',{class:'view-map-grid'}), samples = svgNode('g',{class:'view-map-samples'});
  const recorded = svgNode('circle',{'data-marker':'recorded',r:4,class:'view-map-recorded',visibility:'hidden'});
  const requested = svgNode('g',{'data-marker':'requested',class:'view-map-requested'});
  requested.append(svgNode('circle',{r:5}), svgNode('path',{d:'M -9 0 H -3 M 3 0 H 9 M 0 -9 V -3 M 0 3 V 9'}));
  svg.append(grid,samples,recorded,requested);
  pad.append(canvas,svg);
  const headingAxis = html('div','view-map-heading-axis');
  for (const h of [0,90,180,270,360]) headingAxis.append(html('span','',`${h}°`));
  const elevationAxis = html('div','view-map-elevation-axis');
  chart.append(pad,elevationAxis,headingAxis,html('div','view-map-axis-title','Heading → · Elevation ↑'));
  const readout = html('p','view-map-readout');
  const help = html('p','view-map-help','Drag to request a view. Arrow keys move 1°; Shift moves 15°. Crosshair: request · ring: recorded sample. Dots are actual measured views.');
  section.append(title,chart,readout,help);
  root.append(section);
  const gradient = createGradientCache();
  let current, destroyed = false, lastRaster, lastSamples, drag = null, editing = false;
  const listeners = [];
  function listen(node,type,fn) {
    node.addEventListener(type,fn);
    listeners.push(() => node.removeEventListener(type,fn));
  }
  function releaseDrag() {
    if (!drag) return;
    const pointer = drag.pointer;
    drag = null;
    if (pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer);
  }
  function request(pose) {
    current.requested = pose;
    markers();
    onRequest(pose.heading,pose.elevation);
  }
  function pointerPose(event) {
    const p = pointToPose(event.clientX,event.clientY,pad.getBoundingClientRect(),current.colors.elevationMin,current.colors.elevationMax);
    return {heading:Math.round(p.heading),elevation:Math.round(p.elevation)};
  }
  function movePointer(event) {
    const pose = pointerPose(event);
    if (drag.anchor) changeColorState({type:'move',name:drag.anchor,...pose});
    else request(pose);
  }
  listen(pad,'keydown',event => {
    if (!current) return;
    const pose = keyboardPose(current.requested,event,current.colors.elevationMin,current.colors.elevationMax,editing);
    if (pose) { event.preventDefault(); request(pose); }
  });
  listen(pad,'pointerdown',event => {
    if (!current || event.button !== 0 || drag) return;
    let anchor = null;
    if (editing) {
      for (let node = event.target; node && node !== pad; node = node.parentNode) {
        anchor = node.getAttribute('data-anchor-handle');
        if (anchor) break;
      }
      if (!anchor) return;
    }
    drag = {pointer:event.pointerId,anchor};
    pad.setPointerCapture(event.pointerId);
    (anchor ? controls[anchor].handle : pad).focus({preventScroll:true});
    event.preventDefault();
    if (!anchor) movePointer(event);
  });
  listen(pad,'pointermove',event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault(); movePointer(event);
  });
  listen(pad,'pointerup',event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    movePointer(event); releaseDrag();
  });
  listen(pad,'pointercancel',event => { if (drag?.pointer === event.pointerId) releaseDrag(); });
  listen(pad,'lostpointercapture',event => { if (drag?.pointer === event.pointerId) drag = null; });
  const colorInputs = html('div','view-map-colors');
  colorInputs.setAttribute('role','group'); colorInputs.setAttribute('aria-label','Viewpoint anchor colors');
  const editor = html('details','view-map-editor');
  editor.append(html('summary','','Place colors on the view map'));
  const tools = html('div','view-map-tools');
  const reset = html('button','','Reset positions'); reset.type = 'button'; reset.setAttribute('data-action','reset-positions');
  const toggle = html('button','','Move colors on map'); toggle.type = 'button';
  toggle.setAttribute('data-action','edit-positions'); toggle.setAttribute('aria-pressed','false');
  tools.append(toggle,reset); editor.append(tools);
  const positionHelp = html('p','view-map-help','Colors stay tied to viewing pose; 0° and 360° agree. Enter heading and elevation for A–D.');
  positionHelp.setAttribute('role','status'); editor.append(positionHelp);
  const controls = {};
  section.append(colorInputs,editor);
  function changeColorState(edit) {
    if (!current) return;
    const next = editAnchor(current.colors,edit);
    if (!next) {
      positionHelp.textContent = 'Keep color anchors at distinct positions and enter finite angles.';
      syncEditor(true); return;
    }
    positionHelp.textContent = edit.type === 'reset' ? 'Default positions restored. Your chosen colors are unchanged.' : 'Movable HSV blend · circular heading. Colors stay tied to viewing pose.';
    if (colorSignature(next) === colorSignature(current.colors)) { syncEditor(true); return; }
    current.colors = next; syncEditor(true);
    // Never expose internal mutable arrays to the owner or retain the callback payload.
    onColors(cloneColors(next));
  }
  ANCHORS.forEach((name,index) => {
    const letter = String.fromCharCode(65+index);
    const label = html('label','view-map-color');
    const color = html('input'); color.type = 'color'; color.setAttribute('aria-label',`Color ${letter}`);
    const caption = html('span','view-map-caption'); caption.setAttribute('data-caption',name);
    label.append(color,caption); colorInputs.append(label);
    const editColor = () => {
      if (!/^#[0-9a-f]{6}$/i.test(color.value)) return;
      changeColorState({type:'color',name,rgb:[1,3,5].map(i => parseInt(color.value.slice(i,i+2),16))});
    };
    listen(color,'input',editColor); listen(color,'change',editColor);
    const row = html('div','view-map-anchor-row'); row.append(html('strong','',letter));
    const angles = ['Heading','Elevation'].map((title,index) => {
      const label = html('label','',title);
      const input = html('input'); input.type = 'number'; input.step = '1';
      input.setAttribute('aria-label',`Color ${letter} ${title.toLowerCase()}`);
      listen(input,'change',() => {
        if (!current) return;
        const pose = current.colors.positions[name];
        changeColorState({type:'move',name,heading:index === 0 ? input.valueAsNumber : pose[0],elevation:index === 1 ? input.valueAsNumber : pose[1]});
      });
      label.append(input); row.append(label); return input;
    });
    const handle = html('button','view-map-handle',letter); handle.type = 'button'; handle.hidden = true;
    handle.setAttribute('aria-label',`Move color ${letter}`); handle.setAttribute('data-anchor-handle',name);
    listen(handle,'keydown',event => {
      if (!current || !editing || !event.key.startsWith('Arrow')) return;
      const p = current.colors.positions[name];
      const pose = keyboardPose({heading:p[0],elevation:p[1]},event,current.colors.elevationMin,current.colors.elevationMax,false,10);
      if (pose) { event.preventDefault(); event.stopPropagation(); changeColorState({type:'move',name,...pose}); }
    });
    pad.append(handle);
    controls[name] = {color,caption,angles,handle}; editor.append(row);
  });
  function setEditing(value) {
    releaseDrag(); editing = value;
    toggle.setAttribute('aria-pressed',String(editing));
    toggle.textContent = editing ? 'Done moving colors' : 'Move colors on map';
    pad.setAttribute('data-editing',String(editing));
    for (const {handle} of Object.values(controls)) handle.hidden = !editing;
    positionHelp.textContent = editing ? 'Drag A–D or use their arrow keys; Shift moves 10°. View selection is paused while editing colors.' : 'Colors stay tied to viewing pose; 0° and 360° agree.';
  }
  listen(toggle,'click',() => setEditing(!editing));
  listen(editor,'toggle',() => { if (!editor.open && editing) setEditing(false); });
  listen(reset,'click',() => changeColorState({type:'reset'}));
  function syncEditor(force = false) {
    if (!current) return;
    ANCHORS.forEach((name,index) => {
      const {color,caption,angles,handle} = controls[name], pose = current.colors.positions[name];
      const p = point({heading:pose[0],elevation:pose[1]});
      handle.style.left = `${p.x/360*100}%`; handle.style.top = `${p.y/120*100}%`;
      handle.style.backgroundColor = rgbCss(current.colors.anchors[name]);
      handle.title = `Color ${String.fromCharCode(65+index)}: ${rounded(pose[0])}° heading, ${rounded(pose[1])}° elevation. Arrow keys move 1°; Shift moves 10°.`;
      if (force || doc.activeElement !== color) color.value = '#' + current.colors.anchors[name].map(v => v.toString(16).padStart(2,'0')).join('');
      caption.textContent = `${String.fromCharCode(65+index)} · ${rounded(pose[0])}°, ${rounded(pose[1])}°`;
      angles.forEach((input,j) => {
        input.min = String(j ? current.colors.elevationMin : 0); input.max = String(j ? current.colors.elevationMax : 360);
        if (force || doc.activeElement !== input) input.value = String(rounded(pose[j]));
      });
    });
  }
  const point = pose => poseToPoint(pose, MAP_RECT, current.colors.elevationMin, current.colors.elevationMax);
  function markers() {
    const p = point(current.requested);
    requested.setAttribute('transform',`translate(${p.x} ${p.y})`);
    const row = current.recorded;
    recorded.setAttribute('visibility',row ? 'visible' : 'hidden');
    if (row) {
      const r = point(row);
      recorded.setAttribute('cx',r.x); recorded.setAttribute('cy',r.y);
      recorded.setAttribute('fill',rgbCss(current.rgbAt(row.heading,row.elevation)));
    }
    const poseLabel = pose => `${rounded(pose.heading)}° heading, ${rounded(pose.elevation)}° elevation`;
    readout.textContent = `Requested ${poseLabel(current.requested)} · ${row ? `Recorded ${poseLabel(row)}` : 'No recorded sample'}`;
    pad.setAttribute('aria-label',`${readout.textContent}. Arrow keys request a view; Shift steps 15 degrees.`);
  }
  function update(next) {
    if (destroyed) return;
    current = {...next,colors:cloneColors(next.colors),requested:{...next.requested}};
    const raster = gradient(current.colors,current.rgbAt);
    if (raster !== lastRaster) {
      canvas.width = raster.width; canvas.height = raster.height;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(raster.width,raster.height);
      image.data.set(raster.data); ctx.putImageData(image,0,0);
      lastRaster = raster;
    }
    // Value-based key also handles selected-series arrays recreated (or mutated) by the parent.
    const sampleKey = JSON.stringify([colorSignature(current.colors),current.rows.map(r => [r.id,r.heading,r.elevation])]);
    if (sampleKey !== lastSamples) {
      samples.replaceChildren();
      for (const row of current.rows) {
        const p = point(row);
        samples.append(svgNode('circle',{cx:p.x,cy:p.y,r:1.6,'data-row':row.id,fill:rgbCss(current.rgbAt(row.heading,row.elevation))}));
      }
      grid.replaceChildren(); elevationAxis.replaceChildren();
      for (const h of [0,90,180,270,360]) grid.append(svgNode('line',{x1:h,x2:h,y1:0,y2:120}));
      const {elevationMin:low,elevationMax:high} = current.colors;
      for (const e of [...new Set([high,(low+high)/2,low])]) {
        const y = point({heading:0,elevation:e}).y;
        grid.append(svgNode('line',{x1:0,x2:360,y1:y,y2:y}));
        const label = html('span','',`${rounded(e)}°`); label.style.top = `${y/120*100}%`;
        elevationAxis.append(label);
      }
      lastSamples = sampleKey;
    }
    markers(); syncEditor();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; releaseDrag();
    for (const remove of listeners) remove();
    current = null; section.remove();
  }
  return {update,destroy};
}

export function poseToPoint(pose, rect, elevationMin, elevationMax) {
  const t = elevationMax === elevationMin ? .5 : clamp((elevationMax - pose.elevation) / (elevationMax - elevationMin), 0, 1);
  return {
    x: rect.left + clamp(pose.heading, 0, 360) / 360 * rect.width,
    y: rect.top + t * rect.height,
  };
}
