/** Marks use coordinates in the retained image, independent of panel size. */
export type Point = {x:number;y:number};
export type Mark = {kind:'pen';points:Point[]} | {kind:'rectangle';x:number;y:number;width:number;height:number} |
  {kind:'arrow';from:Point;to:Point} | {kind:'text';x:number;y:number;text:string};
export type Tool = 'select'|'pen'|'rectangle'|'arrow'|'text';
export function point(event:{clientX:number;clientY:number},bounds:{left:number;top:number;width:number;height:number}):Point {
  if(bounds.width<=0||bounds.height<=0)throw Error('The captured image has no visible dimensions.');
  const clamp=(value:number)=>Math.max(0,Math.min(1,value));
  return {x:clamp((event.clientX-bounds.left)/bounds.width),y:clamp((event.clientY-bounds.top)/bounds.height)};
}
export function shape(tool:Tool,points:Point[],text:string):Mark|null {
  const from=points[0],to=points.at(-1);if(!from||!to)return null;
  if(tool==='text')return text.trim()?{kind:'text',...from,text:text.trim()}:null;
  if(tool==='pen')return points.length>=2?{kind:'pen',points:structuredClone(points)}:null;
  if(tool==='arrow')return Math.hypot(to.x-from.x,to.y-from.y)>.002?{kind:'arrow',from,to}:null;
  if(tool==='rectangle'){
    const width=Math.abs(to.x-from.x),height=Math.abs(to.y-from.y);
    return width>.002&&height>.002?{kind:'rectangle',x:Math.min(from.x,to.x),y:Math.min(from.y,to.y),width,height}:null;
  }
  return null;
}
export function draw(canvas:HTMLCanvasElement,marks:readonly Mark[],selected:number|null=null){
  const context=canvas.getContext('2d');if(!context)return;
  const w=canvas.width,h=canvas.height;context.clearRect(0,0,w,h);
  context.lineWidth=Math.max(2,w/350);context.lineCap='round';context.lineJoin='round';
  context.font=`${Math.max(14,w/42)}px sans-serif`;
  marks.forEach((mark,index)=>{
    context.strokeStyle=index===selected?'#2863D6':'#C2410C';context.fillStyle=context.strokeStyle;context.beginPath();
    let label:Point;
    if(mark.kind==='rectangle'){context.rect(mark.x*w,mark.y*h,mark.width*w,mark.height*h);label=mark;}
    else if(mark.kind==='pen'){mark.points.forEach((p,i)=>i?context.lineTo(p.x*w,p.y*h):context.moveTo(p.x*w,p.y*h));label=mark.points[0];}
    else if(mark.kind==='arrow'){
      const a=mark.from,b=mark.to,angle=Math.atan2((b.y-a.y)*h,(b.x-a.x)*w),size=Math.max(9,w/55);
      context.moveTo(a.x*w,a.y*h);context.lineTo(b.x*w,b.y*h);
      for(const delta of [-.5,.5]){context.moveTo(b.x*w,b.y*h);context.lineTo(b.x*w-size*Math.cos(angle+delta),b.y*h-size*Math.sin(angle+delta));}label=a;
    }else{context.fillText(mark.text,mark.x*w,mark.y*h);label=mark;}
    context.stroke();context.fillText(String(index+1),Math.max(2,Math.min(w-20,label.x*w+4)),Math.max(18,label.y*h-5));
  });
}
