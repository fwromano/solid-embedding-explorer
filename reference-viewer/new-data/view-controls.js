/* Shared interaction math for the vehicle embedding plots. No data fitting. */
'use strict';
window.VehicleViewControls=(()=>{
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function cameraBasis(yaw,pitch){
    const co=Math.cos(yaw),si=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
    const right=[co,-si,0],up=[sp*si,sp*co,cp];
    // In a right-handed camera, right cross up points toward the eye.
    const towardCamera=[right[1]*up[2],-right[0]*up[2],right[0]*up[1]-right[1]*up[0]];
    return {right,up,towardCamera};
  }
  function backPlanes(ranges,yaw,pitch){
    const {towardCamera}=cameraBasis(yaw,pitch);
    return {towardCamera,corner:ranges.map((r,i)=>r[towardCamera[i]>=0?0:1]),opposite:ranges.map((r,i)=>r[towardCamera[i]>=0?1:0])};
  }
  function projector(ranges,mode,yaw,pitch,zoom,panX,panY,width,height){
    const mx=(ranges[0][0]+ranges[0][1])/2,my=(ranges[1][0]+ranges[1][1])/2,mz=(ranges[2][0]+ranges[2][1])/2;
    const cx=width*(.5+panX),cy=height*(.5+panY);
    if(mode!=='3d'){
      const a=+mode[0],b=+mode[1],mid=[mx,my,mz],s=Math.min((width-104)/(ranges[a][1]-ranges[a][0]),(height-104)/(ranges[b][1]-ranges[b][0]))*zoom;
      return v=>({x:cx+(v[a]-mid[a])*s,y:cy-(v[b]-mid[b])*s,depth:0});
    }
    const {right:r,up:u,towardCamera:n}=cameraBasis(yaw,pitch);
    const s=Math.min(width*.56,height*.60)*zoom/Math.max(...ranges.map(r=>r[1]-r[0]));
    return v=>{const x=v[0]-mx,y=v[1]-my,z=v[2]-mz;return{x:cx+(r[0]*x+r[1]*y)*s,y:cy-(u[0]*x+u[1]*y+u[2]*z)*s,depth:n[0]*x+n[1]*y+n[2]*z};};
  }
  function orderPoints(points,mode){
    // Positive camera depth is nearer. Stable source-ID ties remove group-order bias.
    points.sort((a,b)=>(mode==='3d'?a.depth-b.depth:0)||a.row.embedding_row-b.row.embedding_row);
    return points;
  }
  function drawPoints(ctx,points,mode){
    orderPoints(points,mode);
    ctx.globalAlpha=1;
    for(const p of points){ctx.fillStyle=p.fill;ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();}
  }
  const colorCache=new Map();
  function rgb(fill){
    if(colorCache.has(fill))return colorCache.get(fill);
    if(colorCache.size>8192)colorCache.clear();
    const value=fill.startsWith('#')?[1,3,5].map(k=>parseInt(fill.slice(k,k+2),16)):(fill.match(/[\d.]+/g)||[255,255,255]).slice(0,3).map(Number);
    colorCache.set(fill,value);return value;
  }
  function pathColor(fill){return `rgb(${rgb(fill).map((v,i)=>Math.round(v*.6+[16,25,40][i]*.4)).join(' ')})`;}
  function lineSample(s,x,y){
    const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y,length2=dx*dx+dy*dy;
    if(length2<1e-16)return null;
    const t=((x-s.a.x)*dx+(y-s.a.y)*dy)/length2;
    if(t<0||t>1||(s.dashed&&t*Math.sqrt(length2)%9>=4))return null;
    const distance=((x-s.a.x)*dy-(y-s.a.y)*dx)**2/length2;
    return distance<=(s.width||1)**2/4?s.a.depth+t*(s.b.depth-s.a.depth):null;
  }
  function closest(points,x,y,segments=[]){
    // The same opaque discs and butt-ended/dashed segments as the scene renderer.
    let hit=null;
    for(let i=points.length-1;i>=0;i--){const p=points[i];if((p.x-x)**2+(p.y-y)**2<=p.radius**2){hit=p;break;}}
    if(!hit)return null;
    for(const s of segments){const d=lineSample(s,x,y);if(d!==null&&d>hit.depth)return null;}
    return hit.row;
  }
  function rasterScene(points,segments,width,height,scaleX,scaleY,storage){
    // CPU fallback uses the same per-pixel depth law as WebGL; no painter-order
    // approximation for crossing segments. Buffers are retained between frames.
    if(!storage.image||storage.image.width!==width||storage.image.height!==height){
      storage.image=new ImageData(width,height);storage.depth=new Float64Array(width*height);
    }
    const image=storage.image,bytes=image.data,z=storage.depth;
    bytes.fill(0);z.fill(-Infinity);
    const write=(x,y,d,color)=>{
      const k=y*width+x;if(d<z[k])return;z[k]=d;
      const q=k*4;bytes[q]=color[0];bytes[q+1]=color[1];bytes[q+2]=color[2];bytes[q+3]=255;
    };
    for(const s of segments){
      const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y,r=(s.width||1)/2,color=rgb(s.fill);
      if(dx*dx+dy*dy<1e-16)continue;
      // Traverse a narrow strip along the major axis, not a diagonal's entire box.
      const horizontal=Math.abs(dx*scaleX)>=Math.abs(dy*scaleY);
      const a=horizontal?s.a.x:s.a.y,b=horizontal?s.b.x:s.b.y;
      const majorScale=horizontal?scaleX:scaleY,minorScale=horizontal?scaleY:scaleX;
      const majorSize=horizontal?width:height,minorSize=horizontal?height:width;
      const start=Math.max(0,Math.floor((Math.min(a,b)-r)*majorScale)),end=Math.min(majorSize-1,Math.ceil((Math.max(a,b)+r)*majorScale));
      const slope=horizontal?dy/dx:dx/dy,pad=r*(1+Math.abs(slope));
      for(let i=start;i<=end;i++){
        const major=(i+.5)/majorScale,center=(horizontal?s.a.y:s.a.x)+(major-a)*slope;
        const lo=Math.max(0,Math.floor((center-pad)*minorScale)),hi=Math.min(minorSize-1,Math.ceil((center+pad)*minorScale));
        for(let j=lo;j<=hi;j++){
          const x=horizontal?i:j,y=horizontal?j:i,d=lineSample(s,(x+.5)/scaleX,(y+.5)/scaleY);
          if(d!==null)write(x,y,d,color);
        }
      }
    }
    for(const p of points){
      const color=rgb(p.fill),r2=p.radius*p.radius;
      const x0=Math.max(0,Math.floor((p.x-p.radius)*scaleX)),x1=Math.min(width-1,Math.ceil((p.x+p.radius)*scaleX));
      const y0=Math.max(0,Math.floor((p.y-p.radius)*scaleY)),y1=Math.min(height-1,Math.ceil((p.y+p.radius)*scaleY));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)
        if(((x+.5)/scaleX-p.x)**2+((y+.5)/scaleY-p.y)**2<=r2)write(x,y,p.depth,color);
    }
    return image;
  }
  function renderer(canvas,preference='auto'){
    let gl=null,pipes=null,failed=false,frame=null;
    const cpu=document.createElement('canvas'),cpuCtx=cpu.getContext('2d'),storage={};
    canvas.style.pointerEvents='none';canvas.style.zIndex='1';
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();failed=true;canvas.style.display='none';});
    canvas.addEventListener('webglcontextrestored',()=>{failed=false;gl=null;pipes=null;});
    function init(){
      if(failed)return false;if(pipes)return true;
      try{
        gl=canvas.getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
        if(!gl){failed=true;return false;}
        const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
        const common=`#version 300 es
          precision highp float;uniform vec4 viewport;
          vec4 clip(vec2 p,float z){return vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,z,1.);}
        `;
        const pointVertex=common+`
          layout(location=0) in vec3 position;layout(location=1) in vec4 appearance;
          flat out vec2 center;flat out vec3 color;flat out float radius;
          const vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
          void main(){center=position.xy;color=appearance.xyz;radius=appearance.w;gl_Position=clip(center+corners[gl_VertexID]*(radius+1.),position.z);}
        `;
        const pointFragment=`#version 300 es
          precision highp float;uniform vec4 viewport;flat in vec2 center;flat in vec3 color;flat in float radius;out vec4 pixel;
          void main(){vec2 p=vec2(gl_FragCoord.x,viewport.w-gl_FragCoord.y)*viewport.xy/viewport.zw;
            if(distance(p,center)>radius)discard;pixel=vec4(color,1.);}
        `;
        const lineVertex=common+`
          layout(location=0) in vec3 start;layout(location=1) in vec3 end;
          layout(location=2) in vec4 appearance;layout(location=3) in float dash;
          flat out vec2 a;flat out vec2 b;flat out vec3 color;flat out float dashed;flat out float width;
          const vec2 corners[6]=vec2[6](vec2(0,-1),vec2(1,-1),vec2(1,1),vec2(0,-1),vec2(1,1),vec2(0,1));
          void main(){a=start.xy;b=end.xy;color=appearance.xyz;dashed=dash;width=appearance.w;
            vec2 delta=b-a,normal=vec2(-delta.y,delta.x)/max(length(delta),.000001),c=corners[gl_VertexID];
            float t=c.x+(c.x*2.-1.)/max(length(delta),.000001);
            gl_Position=clip(mix(a,b,t)+normal*c.y*(width*.5+1.),mix(start.z,end.z,t));}
        `;
        const lineFragment=`#version 300 es
          precision highp float;uniform vec4 viewport;flat in vec2 a;flat in vec2 b;flat in vec3 color;flat in float dashed;flat in float width;out vec4 pixel;
          void main(){vec2 p=vec2(gl_FragCoord.x,viewport.w-gl_FragCoord.y)*viewport.xy/viewport.zw,delta=b-a;
            float t=dot(p-a,delta)/max(dot(delta,delta),.000001);
            if(t<0.||t>1.||distance(p,a+t*delta)>width*.5||dot(delta,delta)<.000001)discard;
            if(dashed>.5&&mod(t*length(delta),9.)>=4.)discard;pixel=vec4(color,1.);}
        `;
        function pipe(vertex,fragment,stride,attributes){
          const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment),program=gl.createProgram();
          gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
          if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
          const vao=gl.createVertexArray(),buffer=gl.createBuffer();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
          let offset=0;attributes.forEach((size,i)=>{gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,size,gl.FLOAT,false,stride*4,offset*4);gl.vertexAttribDivisor(i,1);offset+=size;});
          return {program,vao,buffer,stride,viewport:gl.getUniformLocation(program,'viewport'),array:new Float32Array(0),capacity:0};
        }
        pipes={points:pipe(pointVertex,pointFragment,7,[3,4]),lines:pipe(lineVertex,lineFragment,11,[3,3,4,1])};
        gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.clearColor(0,0,0,0);return true;
      }catch(error){failed=true;pipes=null;return false;}
    }
    function upload(pipe,n,width,height,w,h){
      gl.useProgram(pipe.program);gl.bindVertexArray(pipe.vao);gl.bindBuffer(gl.ARRAY_BUFFER,pipe.buffer);
      if(pipe.capacity<pipe.array.byteLength){gl.bufferData(gl.ARRAY_BUFFER,pipe.array.byteLength,gl.DYNAMIC_DRAW);pipe.capacity=pipe.array.byteLength;}
      gl.bufferSubData(gl.ARRAY_BUFFER,0,pipe.array.subarray(0,n*pipe.stride));
      gl.uniform4f(pipe.viewport,width,height,w,h);gl.drawArraysInstanced(gl.TRIANGLES,0,6,n);
    }
    return {draw(ctx,points,mode,width,height,segments=[]){
      orderPoints(points,mode);
      const dpr=globalThis.devicePixelRatio||1,w=Math.max(1,Math.round(width*dpr)),h=Math.max(1,Math.round(height*dpr));
      frame={points,segments,scaleX:w/width,scaleY:h/height};
      // GPU is optional: the CPU path also handles crossings with a depth buffer.
      const gpu=points.length>0&&preference!=='canvas'&&(preference==='webgl'||points.length>=10000)&&init();
      canvas.style.display=gpu?'':'none';
      if(!gpu){
        if(cpu.width!==w||cpu.height!==h){cpu.width=w;cpu.height=h;}
        cpuCtx.putImageData(rasterScene(points,segments,w,h,w/width,h/height,storage),0,0);
        ctx.drawImage(cpu,0,0,width,height);return failed?'canvas depth fallback':'canvas depth buffer';
      }
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);
      let min=Infinity,max=-Infinity;
      for(const p of points){min=Math.min(min,p.depth);max=Math.max(max,p.depth);}
      for(const s of segments){min=Math.min(min,s.a.depth,s.b.depth);max=Math.max(max,s.a.depth,s.b.depth);}
      const clip=d=>.9-1.8*(d-min)/Math.max(1e-12,max-min);
      // Normalize in JS double precision before upload. The affine map is shared
      // by points/segments; ordinal point ranks cannot interpolate crossing paths.
      const pointPipe=pipes.points,linePipe=pipes.lines;
      if(pointPipe.array.length<points.length*7)pointPipe.array=new Float32Array(points.length*7);
      for(let i=0;i<points.length;i++){
        const p=points[i],c=rgb(p.fill),j=i*7,a=pointPipe.array;
        a[j]=p.x;a[j+1]=p.y;a[j+2]=clip(p.depth);a[j+3]=c[0]/255;a[j+4]=c[1]/255;a[j+5]=c[2]/255;a[j+6]=p.radius;
      }
      if(linePipe.array.length<segments.length*11)linePipe.array=new Float32Array(segments.length*11);
      for(let i=0;i<segments.length;i++){
        const s=segments[i],c=rgb(s.fill),j=i*11,a=linePipe.array;
        a[j]=s.a.x;a[j+1]=s.a.y;a[j+2]=clip(s.a.depth);a[j+3]=s.b.x;a[j+4]=s.b.y;a[j+5]=clip(s.b.depth);
        a[j+6]=c[0]/255;a[j+7]=c[1]/255;a[j+8]=c[2]/255;a[j+9]=s.width||1;a[j+10]=s.dashed?1:0;
      }
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      if(segments.length)upload(linePipe,segments.length,width,height,w,h);
      upload(pointPipe,points.length,width,height,w,h);
      return 'WebGL2 depth buffer';
    },pick(x,y){
      if(!frame)return null;
      const {points,segments,scaleX,scaleY}=frame;
      return closest(points,(Math.floor(x*scaleX)+.5)/scaleX,(Math.floor(y*scaleY)+.5)/scaleY,segments);
    },get graphics(){return gl;}};
  }
  function selection(ctx,points,row,segments=[]){
    const index=points.findIndex(p=>p.row.embedding_row===row.embedding_row);if(index<0)return null;
    const p=points[index],occluded=closest(points,p.x,p.y,segments)?.embedding_row!==row.embedding_row;
    if(!occluded){
      const radius=p.radius+4;
      ctx.save();ctx.globalAlpha=1;ctx.lineWidth=1.5;ctx.strokeStyle='#fff';
      ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.stroke();
      ctx.globalCompositeOperation='destination-out';ctx.fillStyle='#000';
      for(let i=index+1;i<points.length;i++){
        const q=points[i];if((q.x-p.x)**2+(q.y-p.y)**2>(radius+q.radius+1)**2)continue;
        ctx.beginPath();ctx.arc(q.x,q.y,q.radius+.5,0,Math.PI*2);ctx.fill();
      }
      ctx.strokeStyle='#000';
      for(const s of segments){
        if(Math.max(s.a.depth,s.b.depth)<=p.depth)continue;
        if(p.x+radius<Math.min(s.a.x,s.b.x)-2||p.x-radius>Math.max(s.a.x,s.b.x)+2||p.y+radius<Math.min(s.a.y,s.b.y)-2||p.y-radius>Math.max(s.a.y,s.b.y)+2)continue;
        let start=0,end=1;
        if(s.a.depth<=p.depth)start=(p.depth-s.a.depth)/(s.b.depth-s.a.depth);
        if(s.b.depth<=p.depth)end=(p.depth-s.a.depth)/(s.b.depth-s.a.depth);
        const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y;
        ctx.setLineDash(s.dashed?[4,5]:[]);ctx.lineDashOffset=start*Math.hypot(dx,dy);ctx.lineWidth=(s.width||1)+1;
        ctx.beginPath();ctx.moveTo(s.a.x+start*dx,s.a.y+start*dy);ctx.lineTo(s.a.x+end*dx,s.a.y+end*dy);ctx.stroke();
      }
      ctx.restore();
    }
    return {x:p.x,y:p.y,row:row.embedding_row,fill:p.fill,occluded,highlight:'depth-clipped outline'};
  }
  function orientation(ctx,width,height,yaw,pitch,caption){
    const {right,up}=cameraBasis(yaw,pitch),cx=width-53,cy=height-43;
    const axes=right.map((r,i)=>[r,-up[i]]),colors=['#ed8686','#7dd7b3','#8facff'];
    ctx.save();ctx.font='10px system-ui';ctx.lineWidth=1.5;ctx.textAlign='center';
    axes.forEach(([x,y],i)=>{ctx.strokeStyle=colors[i];ctx.fillStyle=colors[i];ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+x*27,cy+y*27);ctx.stroke();ctx.fillText(caption(i).split(' · ')[0],cx+x*37,cy+y*37+3);});ctx.restore();
  }
  function positions(params,names,low,high){
    const defaults={bottomLeft:[0,low],topLeft:[0,high],topRight:[180,high],bottomRight:[180,low]};
    let saved={};try{saved=JSON.parse(localStorage.getItem('vehicle-view-anchor-positions')||'{}')}catch{}
    const explicit=names.some(n=>params.has('anchor-pos-'+n));
    const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[0]<=360&&p[1]>=low&&p[1]<=high;
    const points=Object.fromEntries(names.map(n=>{const p=explicit?(params.has('anchor-pos-'+n)?params.get('anchor-pos-'+n).split(',').map(Number):defaults[n]):saved[n];return[n,valid(p)?p.slice():defaults[n].slice()];}));
    const distance=(a,b)=>{const h=Math.abs(a[0]-b[0])%360;return (Math.min(h,360-h)/180)**2+((a[1]-b[1])/(high-low))**2;};
    // Invalid saved/URL collisions fall back as a group to a reproducible default.
    if(names.some((n,i)=>names.slice(i+1).some(m=>distance(points[n],points[m])<1e-8)))for(const n of names)points[n]=defaults[n].slice();
    const api={points,low,high,distance,get custom(){return names.some(n=>points[n].some((v,i)=>v!==defaults[n][i]));},
      move(n,h,e){if(!Number.isFinite(h)||!Number.isFinite(e))return false;const p=[clamp(h,0,360),clamp(e,low,high)];if(names.some(m=>m!==n&&distance(p,points[m])<1e-8))return false;points[n]=p;return true;},
      reset(){for(const n of names)points[n]=defaults[n].slice();api.save();},
      save(){try{localStorage.setItem('vehicle-view-anchor-positions',JSON.stringify(points))}catch{}},
      write(q){for(const n of names){q.delete('anchor-pos-'+n);if(api.custom)q.set('anchor-pos-'+n,points[n].join(','));}}
    };return api;
  }
  function prepareHsv(colors,state,toHsv,names){
    const hsv=Object.fromEntries(names.map(n=>[n,toHsv(colors[n])]));
    const colored=names.filter(n=>hsv[n][1]>0&&hsv[n][2]>0);
    for(const n of names)if(hsv[n][1]===0&&colored.length){const near=colored.reduce((a,b)=>state.distance(state.points[n],state.points[b])<state.distance(state.points[n],state.points[a])?b:a);hsv[n][0]=hsv[near][0];if(hsv[n][2]===0)hsv[n][1]=hsv[near][1];}
    let best=null,cost=Infinity;const first=hsv[names[0]][0];
    for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)for(let c=-1;c<=1;c++){
      const h=[first,hsv[names[1]][0]+360*a,hsv[names[2]][0]+360*b,hsv[names[3]][0]+360*c];let value=0;
      for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)value+=(h[i]-h[j])**2/(.05+state.distance(state.points[names[i]],state.points[names[j]]));
      if(value<cost){cost=value;best=h;}
    }
    names.forEach((n,i)=>hsv[n][0]=best[i]);return hsv;
  }
  function color(heading,elevation,state,hsv,fromHsv,names){
    const query=[heading,elevation===null?(state.low+state.high)/2:elevation],d=names.map(n=>state.distance(query,state.points[n]));
    const exact=d.findIndex(v=>v<1e-12);if(exact>=0)return `rgb(${fromHsv(hsv[names[exact]]).join(' ')})`;
    const weights=d.map(v=>1/v),sum=weights.reduce((a,b)=>a+b,0);
    return `rgb(${fromHsv([0,1,2].map(i=>names.reduce((v,n,j)=>v+weights[j]*hsv[n][i]/sum,0))).join(' ')})`;
  }
  function mountAnchors({pad,names,state,colors,onChange}){
    const svg=pad.querySelector('svg'),ns='http://www.w3.org/2000/svg';
    const panel=document.createElement('details');panel.className='anchor-position-editor';panel.id='anchor-position-editor';
    const summary=document.createElement('summary');summary.textContent='Place colors on the view map';panel.append(summary);
    const tools=document.createElement('div');tools.className='anchor-tools';
    const toggle=document.createElement('button');toggle.type='button';toggle.id='move-color-anchors';toggle.textContent='Move colors on map';toggle.setAttribute('aria-pressed','false');
    const reset=document.createElement('button');reset.type='button';reset.id='reset-color-positions';reset.textContent='Reset positions';
    const help=document.createElement('p');help.className='small';help.id='anchor-position-help';help.textContent='Drag A–D while editing, or enter heading/elevation below. Colors stay tied to viewing pose; 0° and 360° agree.';
    tools.append(toggle,reset);panel.append(tools,help);document.getElementById('view-color-anchors').after(panel);
    const handles=document.createElementNS(ns,'g');handles.id='color-anchor-handles';handles.style.display='none';svg.append(handles);
    let active=null,frame=0;const inputs={},nodes={};const api={editing:false,sync};
    function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;onChange();sync();});}
    function change(n,h,e){if(!state.move(n,h,e)){help.textContent='Keep color anchors at distinct positions.';sync();return;}help.textContent='Movable HSV blend · circular heading. Drag A–D, or enter their angles below.';state.save();sync();schedule();}
    names.forEach((n,i)=>{
      const letter=String.fromCharCode(65+i),row=document.createElement('div');row.className='anchor-position-row';
      const name=document.createElement('strong');name.textContent=letter;row.append(name);inputs[n]=[];
      for(const [j,title,min,max]of [[0,'Heading',0,360],[1,'Elevation',state.low,state.high]]){
        const label=document.createElement('label');label.textContent=title+' ';const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step='1';input.setAttribute('aria-label',`Color ${letter} ${title.toLowerCase()}`);input.onchange=()=>change(n,j===0?input.valueAsNumber:state.points[n][0],j===1?input.valueAsNumber:state.points[n][1]);label.append(input);row.append(label);inputs[n].push(input);
      }panel.append(row);
      const g=document.createElementNS(ns,'g');g.dataset.anchorHandle=n;g.setAttribute('tabindex','0');g.setAttribute('role','button');g.setAttribute('aria-label','Move color '+letter);
      const circle=document.createElementNS(ns,'circle');circle.setAttribute('r','8');const text=document.createElementNS(ns,'text');text.textContent=letter;text.setAttribute('text-anchor','middle');text.setAttribute('y','3');g.append(circle,text);handles.append(g);nodes[n]=g;
      g.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const p=state.points[n],step=e.shiftKey?10:1;change(n,p[0]+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),p[1]+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0));});
      const colorInput=document.querySelector(`[data-view-anchor=${n}]`);colorInput.parentElement.replaceChildren(colorInput);const caption=document.createElement('span');caption.className='anchor-caption';colorInput.parentElement.append(caption);colorInput.setAttribute('aria-label','Color '+letter);
    });
    function sync(){const box=svg.getBoundingClientRect();names.forEach((n,i)=>{const [h,e]=state.points[n];inputs[n][0].value=Number(h.toFixed(1));inputs[n][1].value=Number(e.toFixed(1));nodes[n].setAttribute('transform',`translate(${42+400*h/360} ${120-106*(e-state.low)/(state.high-state.low)}) scale(${460/Math.max(1,box.width)} ${154/Math.max(1,box.height)})`);nodes[n].querySelector('circle').setAttribute('fill',`rgb(${colors()[n].join(' ')})`);document.querySelector(`[data-view-anchor=${n}]`).nextElementSibling.textContent=`${String.fromCharCode(65+i)} · ${Number(h.toFixed(1))}°, ${Number(e.toFixed(1))}°`;});}
    toggle.onclick=()=>{api.editing=!api.editing;toggle.setAttribute('aria-pressed',String(api.editing));toggle.textContent=api.editing?'Done moving colors':'Move colors on map';handles.style.display=api.editing?'':'none';svg.setAttribute('aria-hidden',String(!api.editing));svg.setAttribute('role','group');svg.setAttribute('aria-label','Color positions on the heading and elevation map');pad.classList.toggle('editing-colors',api.editing);onChange();};
    reset.onclick=()=>{state.reset();help.textContent='Default corner positions restored. Your chosen colors are unchanged.';sync();schedule();};
    function move(e){if(!active)return;const r=pad.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*460,y=(e.clientY-r.top)/r.height*154;change(active,Math.round((x-42)/400*360),Math.round(state.low+(120-y)/106*(state.high-state.low)));}
    pad.addEventListener('pointerdown',e=>{if(!api.editing||e.button!==0)return;const g=e.target.closest('[data-anchor-handle]');if(!g)return;active=g.dataset.anchorHandle;pad.setPointerCapture(e.pointerId);e.preventDefault();},true);
    pad.addEventListener('pointermove',e=>{if(active){e.preventDefault();move(e);}},true);
    pad.addEventListener('pointerup',e=>{if(active){move(e);active=null;}},true);pad.addEventListener('pointercancel',()=>active=null);
    panel.addEventListener('toggle',()=>{if(!panel.open&&api.editing)toggle.click();});new ResizeObserver(sync).observe(pad);sync();return api;
  }
  return {cameraBasis,backPlanes,projector,orderPoints,drawPoints,renderer,closest,selection,rasterScene,lineSample,pathColor,orientation,positions,prepareHsv,color,mountAnchors};
})();
