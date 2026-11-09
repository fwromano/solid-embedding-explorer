const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
const wrap=heading=>((heading%360)+360)%360;

// Drag the object, rather than moving the camera in the pointer's direction.
// A full preview width/height turns 180 degrees; elevation stays in the dataset.
export function orbitDragPose(pose,dx,dy,{width,height},[low,high]) {
  return {heading:wrap(pose.heading-dx*180/Math.max(1,width)),
    elevation:clamp(pose.elevation+dy*180/Math.max(1,height),low,high)};
}

export function orbitKeyPose(pose,event,[low,high]) {
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey)return null;
  const step=event.shiftKey?15:1;
  return {heading:event.key==='Home'?0:event.key==='End'?360:wrap(pose.heading+(event.key==='ArrowLeft'?step:event.key==='ArrowRight'?-step:0)),
    elevation:clamp(pose.elevation+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0),low,high)};
}

export function mountPreviewOrbit(element,{getPose,getElevationBounds,onRequest,onStart=()=>{},enabled=()=>true,
  requestFrame=callback=>requestAnimationFrame(callback),cancelFrame=id=>cancelAnimationFrame(id)}) {
  let drag=null,pending=null,frame=null;
  const listeners=[];
  const listen=(type,handler)=>{element.addEventListener(type,handler);listeners.push([type,handler]);};
  function flush(){
    if(frame!==null){cancelFrame(frame);frame=null;}
    const pose=pending;pending=null;
    if(pose)onRequest(pose);
  }
  function move(event){
    if(!drag||drag.id!==event.pointerId)return;
    event.preventDefault();
    drag.pose=orbitDragPose(drag.pose,event.clientX-drag.x,event.clientY-drag.y,drag,getElevationBounds());
    drag.x=event.clientX;drag.y=event.clientY;
    pending=drag.pose;
    if(frame===null)frame=requestFrame(()=>{frame=null;flush();});
  }
  function release(){
    if(!drag)return;
    const id=drag.id;drag=null;element.dataset.dragging='false';
    if(element.hasPointerCapture(id))element.releasePointerCapture(id);
  }
  listen('pointerdown',event=>{
    if(event.button!==0||event.isPrimary===false||drag||!enabled())return;
    const rect=element.getBoundingClientRect();
    onStart();event.preventDefault();element.focus({preventScroll:true});
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,pose:{...getPose()},width:rect.width,height:rect.height};
    element.dataset.dragging='true';element.setPointerCapture(event.pointerId);
  });
  listen('pointermove',move);
  listen('pointerup',event=>{if(drag?.id===event.pointerId){move(event);flush();release();}});
  for(const type of ['pointercancel','lostpointercapture'])listen(type,event=>{if(drag?.id===event.pointerId){flush();release();}});
  listen('dragstart',event=>event.preventDefault());
  listen('keydown',event=>{
    if(!enabled()||drag)return;
    const pose=orbitKeyPose(getPose(),event,getElevationBounds());
    if(!pose)return;
    event.preventDefault();onStart();onRequest(pose);
  });
  return {destroy(){pending=null;if(frame!==null)cancelFrame(frame);frame=null;release();for(const [type,handler] of listeners)element.removeEventListener(type,handler);}};
}
