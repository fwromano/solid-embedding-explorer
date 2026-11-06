import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projector, packColor, createRaster, rasterize} from '../core.js';
const annotations = await import('../plot-annotations.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/plot-annotations.js')) return {};
  throw error;
});
const context = vm.createContext({window:{}});
vm.runInContext(readFileSync(new URL('../../reference-viewer/new-data/view-controls.js', import.meta.url),'utf8'),context);
const original = context.window.VehicleViewControls;
const bounds = [[-2.3,4.7],[-.7,1.9],[-5.2,8.4]];
const state = {mode:'01',yaw:-.65,pitch:.55,zoom:1,panX:0,panY:0};
const near = (a,b,tolerance=1e-8) => assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);

test('3D backplanes preserve original corner convention and share raster depth with points', () => {
  const width=1000,height=700;
  for(const yaw of [-2,-.65,0,1.3]) for(const pitch of [-.6,.55]) {
    const s={...state,mode:'3d',yaw,pitch},project=projector(bounds,s,width,height);
    const {corner,opposite}=original.backPlanes(bounds,yaw,pitch);
    const result=annotations.buildPlotAxes(bounds,s,width,height,i=>`PC${i+1}`);
    const axes=result.segments.filter(line=>line.color===packColor(80,98,127));
    assert.equal(axes.length,3);assert.equal(result.segments.length,18);
    for(let i=0;i<3;i++) {
      const tip=[...corner];tip[i]=opposite[i];
      assert.deepEqual(axes[i].a,project(corner));assert.deepEqual(axes[i].b,project(tip));
      assert.ok(result.labels.some(l=>l.text===`PC${i+1}`));
    }
    const expectedGrid=[];
    for(let axis=0;axis<3;axis++) for(let other=axis+1;other<3;other++) for(let j=0;j<=4;j++) {
      const a=[...corner],b=[...corner];a[axis]=b[axis]=bounds[axis][0]+(bounds[axis][1]-bounds[axis][0])*j/4;
      b[other]=opposite[other];expectedGrid.push({a:project(a),b:project(b),color:packColor(38,52,73)});
    }
    assert.deepEqual(result.segments.filter(line=>line.color===packColor(38,52,73)),expectedGrid);
    assert.ok(result.labels.some(l=>Number.isFinite(Number(l.text))),'legible projected axes have numeric ticks');
    const frame=createRaster(width,height);rasterize(frame,[],result.segments,3);
    const k=frame.depth.findIndex((z,index)=>Number.isFinite(z)&&frame.pixels[index]===packColor(38,52,73));
    assert.ok(k>=0,'fixture contains rasterized grid pixels, not just axes');
    const depth=frame.depth[k],color=frame.pixels[k],x=k%width+.5,y=Math.floor(k/width)+.5;
    rasterize(frame,[{id:7,x,y,depth:depth-1,color:packColor(255,0,0)}],result.segments,3);
    assert.equal(frame.pixels[k],color,'nearer grid occludes farther point');
    rasterize(frame,[{id:8,x,y,depth:depth+1,color:packColor(255,0,0)}],result.segments,3);
    assert.equal(frame.ids[k],8,'nearer point occludes backplane');
  }
});

test('selection outline returns a closed circle of white-stroke pieces without mutating the raster', () => {
  assert.equal(typeof annotations.selectionOutlineSegments,'function');
  const frame=createRaster(80,60);rasterize(frame,[],[],1);
  const before=frame.depth.slice(),point={x:40,y:30,depth:2};
  const pieces=annotations.selectionOutlineSegments(frame,point,8);
  assert.equal(pieces.length,64);
  for(let i=0;i<pieces.length;i++) {
    const p=pieces[i],next=pieces[(i+1)%pieces.length];
    assert.deepEqual(Object.keys(p).sort(),['x1','x2','y1','y2']);
    near(Math.hypot(p.x1-point.x,p.y1-point.y),8);
    near(p.x2,next.x1);near(p.y2,next.y1);
  }
  assert.deepEqual(frame.depth,before);
});

test('outline clips foreground discs and one-pixel paths even between coarse polygon vertices', () => {
  const frame=createRaster(80,60),point={x:40,y:30,depth:2};
  rasterize(frame,[{id:9,x:51,y:30,depth:3,color:packColor(255,0,0)}],
    [{a:{x:40,y:0,depth:3},b:{x:40,y:59,depth:3},color:packColor(0,255,0)}],7);
  for(const steps of [4,64,128]) {
    const pieces=annotations.selectionOutlineSegments(frame,point,12,steps);
    assert.ok(pieces.length>0,'unoccluded portions survive');
    let length=0;
    for(const p of pieces) {
      length+=Math.hypot(p.x2-p.x1,p.y2-p.y1);
      for(let j=0;j<=100;j++) {
        const x=p.x1+(p.x2-p.x1)*j/100,y=p.y1+(p.y2-p.y1)*j/100;
        assert.ok(frame.depth[Math.round(y)*frame.width+Math.round(x)]<=point.depth+1e-9,`foreground leak at ${x},${y}`);
      }
    }
    assert.ok(length>20 && length<70,'clipping removes only hidden arcs');
  }
  rasterize(frame,[{id:10,x:40,y:30,depth:3,color:packColor(255,0,0)}],[],30);
  assert.deepEqual(annotations.selectionOutlineSegments(frame,point,12),[]);
});

test('outline clips to the viewport rather than wrapping nearest-pixel indices across rows', () => {
  const frame=createRaster(30,25);rasterize(frame,[],[],1);
  for(const point of [{x:-2,y:12,depth:0},{x:29,y:12,depth:0},{x:15,y:-2,depth:0},{x:15,y:24,depth:0}]) {
    const pieces=annotations.selectionOutlineSegments(frame,point,8,8);
    assert.ok(pieces.length>0);
    for(const p of pieces) for(const [x,y] of [[p.x1,p.y1],[p.x2,p.y2]]) {
      assert.ok(x>=0 && x<=frame.width-1 && y>=0 && y<=frame.height-1,`unclipped ${x},${y}`);
    }
  }
  assert.deepEqual(annotations.selectionOutlineSegments(frame,{x:-100,y:12,depth:0},8),[]);
});

test('outline rejects malformed geometry and distinguishes empty depth from nonfinite occluders', () => {
  const frame=createRaster(30,25),point={x:15,y:12,depth:2};rasterize(frame,[],[],1);
  for(const key of ['x','y','depth']) for(const bad of [Infinity,-Infinity,NaN])
    assert.deepEqual(annotations.selectionOutlineSegments(frame,{...point,[key]:bad},5),[]);
  for(const bad of [0,-1,Infinity,NaN]) assert.deepEqual(annotations.selectionOutlineSegments(frame,point,bad),[]);
  for(const bad of [0,2,3.5,Infinity,NaN]) assert.deepEqual(annotations.selectionOutlineSegments(frame,point,5,bad),[]);
  for(const bad of [null,{}, {...frame,width:NaN},{...frame,depth:[]},{...frame,width:1.5}])
    assert.deepEqual(annotations.selectionOutlineSegments(bad,point,5),[]);
  assert.deepEqual(annotations.selectionOutlineSegments(frame,null,5),[]);
  for(const depth of [-Infinity,point.depth,point.depth+1e-12]) {
    frame.depth.fill(depth);assert.equal(annotations.selectionOutlineSegments(frame,point,5).length,64);
  }
  for(const depth of [Infinity,NaN,point.depth+1e-5]) {
    frame.depth.fill(depth);assert.deepEqual(annotations.selectionOutlineSegments(frame,point,5),[]);
  }
  frame.depth.fill(Infinity);
  assert.equal(annotations.selectionOutlineSegments(frame,{...point,depth:Number.MAX_VALUE},5).length,0,
    'depth tolerance overflow must not turn nonfinite foreground into a visible sample');
});

test('2D numeric ticks round-trip through actual and original projectors on every plane under pan/zoom', () => {
  assert.equal(typeof annotations.buildPlotAxes,'function');
  const width=640,height=420,mid=bounds.map(([lo,hi])=>(lo+hi)/2);
  for(const mode of ['01','02','12']) for(const camera of [
    {zoom:1,panX:0,panY:0},{zoom:3.7,panX:.28,panY:-.17},{zoom:.05,panX:-.63,panY:.41},{zoom:128,panX:1.3,panY:-.8}
  ]) {
    const s={...state,mode,...camera},[a,b]=[...mode].map(Number);
    const result=annotations.buildPlotAxes(bounds,s,width,height,i=>`LV${i+1}`);
    assert.equal(result.segments.length,10);
    assert.deepEqual(result.labels.filter(l=>l.text.startsWith('LV')).map(l=>l.text).sort(),[`LV${a+1}`,`LV${b+1}`]);
    const ticks=result.labels.filter(l=>Number.isFinite(Number(l.text)));
    assert.equal(ticks.length,10);
    const actual=projector(bounds,s,width,height);
    // The reference has 52px fit margins; calibrate only its public zoom to
    // the existing core projector's scale (50px). Its transform remains independent.
    const spans=bounds.map(([lo,hi])=>hi-lo);
    const coreScale=Math.max(1,Math.min((width-100)/spans[a],(height-100)/spans[b]));
    const referenceScale=Math.min((width-104)/spans[a],(height-104)/spans[b]);
    const reference=original.projector(bounds,mode,s.yaw,s.pitch,s.zoom*coreScale/referenceScale,s.panX,s.panY,width,height);
    for(let i=0;i<5;i++) {
      const x=50+(width-100)*i/4,y=height-50-(height-100)*i/4;
      const horizontal=ticks.find(l=>Math.abs(l.x-x)<1e-8 && l.y>height-50);
      const vertical=ticks.find(l=>l.x<50 && Math.abs(l.y-y)<1e-8);
      assert.ok(horizontal && vertical,'five legible ticks per screen axis');
      const vx=[...mid],vy=[...mid];vx[a]=Number(horizontal.text);vy[b]=Number(vertical.text);
      for(const project of [actual,reference]) {near(project(vx).x,x,.1);near(project(vy).y,y,.1);}
    }
    for(const segment of result.segments) {
      assert.equal(segment.color,packColor(38,52,73));
      for(const p of [segment.a,segment.b]) assert.ok(p.depth<0 && p.depth>-1e-5);
    }
    const frame=createRaster(width,height);
    rasterize(frame,[{x:50.5,y:50.5,depth:0,id:3,color:packColor(255,0,0)}],result.segments,2);
    assert.equal(frame.ids[50*width+50],3,'depth-zero planar points win over negative-epsilon grid');
  }
});
