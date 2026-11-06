// DOM-free plot annotations. Feed segments to the same rasterize() call as
// paths and points; paint labels afterwards. Positive depth faces the camera.
import {projector, cameraBasis, packColor} from './core.js';

const GRID_COLOR=packColor(38,52,73);
const PLANAR_DEPTH=-1e-9;

/**
 * Return {x1,y1,x2,y2} pieces for a white stroke, not a locator cross.
 * radius is the final outline radius in frame pixels (no padding is added).
 * Visibility uses nearest-pixel depth, with 1e-9 * max(1, |depth|) tolerance.
 * -Infinity is the raster's empty sentinel; NaN/+Infinity never show through.
 * Invalid geometry returns []; inputs and the raster are never modified.
 */
export function selectionOutlineSegments(frame,point,radius,steps=64) {
  if(!frame || !point || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
    frame.width<1 || frame.height<1 || !frame.depth || frame.depth.length<frame.width*frame.height ||
    ![point.x,point.y,point.depth,radius].every(Number.isFinite) || radius<=0 ||
    !Number.isSafeInteger(steps) || steps<3) return [];
  const pieces=[],tolerance=1e-9*Math.max(1,Math.abs(point.depth));
  const visible=(x,y)=>{
    if(x<0 || y<0 || x>frame.width-1 || y>frame.height-1)return false;
    const depth=frame.depth[Math.round(y)*frame.width+Math.round(x)];
    return depth===-Infinity || (Number.isFinite(depth)&&depth<=point.depth+tolerance);
  };
  for(let i=0;i<steps;i++) {
    const a=2*Math.PI*i/steps,b=2*Math.PI*(i+1)/steps;
    const x=point.x+radius*Math.cos(a),y=point.y+radius*Math.sin(a);
    const dx=point.x+radius*Math.cos(b)-x,dy=point.y+radius*Math.sin(b)-y;
    // Split at nearest-pixel cell boundaries: endpoint-only tests can bridge a
    // foreground path that falls between the circle's polygon vertices.
    let first=0,last=1;
    for(const [start,delta,limit] of [[x,dx,frame.width-1],[y,dy,frame.height-1]]) {
      if(delta===0){if(start<0||start>limit)last=-1;}
      else {
        const a=-start/delta,b=(limit-start)/delta;
        first=Math.max(first,Math.min(a,b));last=Math.min(last,Math.max(a,b));
      }
    }
    if(last<=first)continue;
    const cuts=[first,last];
    for(const [start,delta] of [[x,dx],[y,dy]]) {
      if(delta===0)continue;
      const low=Math.min(start+delta*first,start+delta*last),high=Math.max(start+delta*first,start+delta*last);
      for(let pixel=Math.floor(low-.5)+1;pixel+.5<high;pixel++) cuts.push((pixel+.5-start)/delta);
    }
    cuts.sort((a,b)=>a-b);
    let run=null;
    const at=t=>visible(x+dx*t,y+dy*t);
    const emit=(lo,hi)=>{
      const inset=Math.min((hi-lo)/4,1e-7/Math.hypot(dx,dy));
      if(!at(lo))lo+=inset;if(!at(hi))hi-=inset;
      if(hi>lo)pieces.push({x1:x+dx*lo,y1:y+dy*lo,x2:x+dx*hi,y2:y+dy*hi});
    };
    for(let j=1;j<cuts.length;j++) {
      const lo=cuts[j-1],hi=cuts[j];if(hi<=lo)continue;
      if(!at((lo+hi)/2)) {if(run!==null){emit(run,lo);run=null;}continue;}
      if(run!==null&&!at(lo)){emit(run,lo);run=null;}
      if(run===null)run=lo;
    }
    if(run!==null)emit(run,last);
  }
  return pieces;
}


function tickText(value, pixelsPerUnit) {
  const digits=Math.min(15,Math.max(0,Math.ceil(Math.log10(Math.abs(pixelsPerUnit)))+1));
  return String(Number(value.toFixed(digits)));
}

/** Return depth-bearing scene lines and screen-space text anchors. */
export function buildPlotAxes(bounds,state,width,height,axisLabel) {
  const segments=[],labels=[],project=projector(bounds,state,width,height);
  if(state.mode==='3d') {
    const {toward}=cameraBasis(state.yaw,state.pitch);
    const origin=bounds.map((range,i)=>range[toward[i]>=0?0:1]);
    const opposite=bounds.map((range,i)=>range[toward[i]>=0?1:0]);
    for(let axis=0;axis<3;axis++) {
      const tip=[...origin];tip[axis]=opposite[axis];
      const start=project(origin),end=project(tip);
      segments.push({a:start,b:end,color:packColor(80,98,127)});
      labels.push({x:end.x+4,y:end.y+4,text:axisLabel(axis)});
      const length=Math.hypot(end.x-start.x,end.y-start.y);
      if(length/4>=40) for(let j=1;j<4;j++) {
        const v=[...origin];v[axis]=origin[axis]+(opposite[axis]-origin[axis])*j/4;
        const p=project(v);
        labels.push({x:p.x+8,y:p.y-8,text:tickText(v[axis],length/Math.abs(opposite[axis]-origin[axis]))});
      }
      for(let other=axis+1;other<3;other++) for(let j=0;j<5;j++) {
        const a=[...origin],b=[...origin];
        a[axis]=b[axis]=bounds[axis][0]+(bounds[axis][1]-bounds[axis][0])*j/4;
        b[other]=opposite[other];
        segments.push({a:project(a),b:project(b),color:GRID_COLOR});
      }
    }
    return {segments,labels};
  }
  const [a,b]=[...state.mode].map(Number),mid=bounds.map(([lo,hi])=>(lo+hi)/2);
  // Derive the inverse from the existing projector, not a second fit/zoom law.
  const center=project(mid),u=[...mid],v=[...mid];u[a]+=1;v[b]+=1;
  const sx=project(u).x-center.x,sy=project(v).y-center.y;
  for(let i=0;i<5;i++) {
    const x=50+(width-100)*i/4,y=height-50-(height-100)*i/4;
    segments.push(
      {a:{x,y:50,depth:PLANAR_DEPTH},b:{x,y:height-50,depth:PLANAR_DEPTH},color:GRID_COLOR},
      {a:{x:50,y,depth:PLANAR_DEPTH},b:{x:width-50,y,depth:PLANAR_DEPTH},color:GRID_COLOR}
    );
    labels.push({x,y:height-32,text:tickText(mid[a]+(x-center.x)/sx,sx)},
      {x:8,y,text:tickText(mid[b]+(y-center.y)/sy,sy)});
  }
  labels.push({x:width/2,y:height-10,text:axisLabel(a)},{x:8,y:20,text:axisLabel(b)});
  return {segments,labels};
}
