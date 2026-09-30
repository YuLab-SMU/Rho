/** Capture the displayed sandbox document, including its current controls/canvases.
 * Pixels are user evidence, never data IDs or an original scientific image. */
function bridge(){
 window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.type!=='rho-viewer-capture'||!event.ports[0])return;
  const port=event.ports[0];
  void (async()=>{
   await document.fonts.ready;
   const width=innerWidth,height=innerHeight;
   if(width<1||height<1||width*height>8*1024*1024)throw Error('The current viewport exceeds the capture limit.');
   const original=document.body,copy=original.cloneNode(true) as HTMLElement;
   const originals=[original,...original.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
   for(let i=0;i<originals.length;i++){
    const from=originals[i],to=copies[i];if(!(from instanceof Element)||!(to instanceof Element))continue;
    if(['SCRIPT','STYLE','LINK','IFRAME','OBJECT','EMBED'].includes(from.tagName)){to.remove();continue;}
    for(const attribute of [...to.attributes])if(attribute.name.startsWith('on'))to.removeAttribute(attribute.name);
    const computed=getComputedStyle(from);to.setAttribute('style',Array.from(computed).map(key=>`${key}:${computed.getPropertyValue(key)};`).join(''));
    if(computed.backgroundImage!=='none'&&/url\(/.test(computed.backgroundImage))throw Error('A background image cannot be captured. Write a whole-topic note instead.');
    if(from instanceof HTMLCanvasElement||from instanceof HTMLImageElement){
     const canvas=document.createElement('canvas');canvas.width=from instanceof HTMLImageElement?from.naturalWidth:from.width;canvas.height=from instanceof HTMLImageElement?from.naturalHeight:from.height;
     if(!canvas.width||!canvas.height)throw Error('An image is not ready for capture.');
     canvas.getContext('2d')!.drawImage(from,0,0);const image=document.createElement('img');image.src=canvas.toDataURL('image/png');image.setAttribute('style',to.getAttribute('style')!);to.replaceWith(image);
    }else if(from instanceof HTMLInputElement){to.setAttribute('value',from.value);if(from.checked)to.setAttribute('checked','');else to.removeAttribute('checked');}
    else if(from instanceof HTMLTextAreaElement)to.textContent=from.value;
    else if(from instanceof HTMLSelectElement){for(const [index,option] of [...to.querySelectorAll('option')].entries())if(from.options[index]?.selected)option.setAttribute('selected','');else option.removeAttribute('selected');}
    if(from.scrollTop||from.scrollLeft){const wrapper=document.createElement('div');while(to.firstChild)wrapper.append(to.firstChild);wrapper.style.transform=`translate(${-from.scrollLeft}px,${-from.scrollTop}px)`;to.append(wrapper);}
   }
   copy.style.margin='0';copy.style.position='absolute';copy.style.left=`${-scrollX}px`;copy.style.top=`${-scrollY}px`;copy.style.width=`${document.body.clientWidth}px`;
   const content=new XMLSerializer().serializeToString(copy);
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:white">${content}</div></foreignObject></svg>`;
   const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await image.decode();
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d')!.drawImage(image,0,0);
   const base64=canvas.toDataURL('image/png').split(',')[1];if(base64.length>768*1024)throw Error('The current view exceeds the 576 KiB PNG capture limit.');
   port.postMessage({base64,width,height});
  })().catch(error=>port.postMessage({error:error instanceof Error?error.message:String(error)})).finally(()=>port.close());
 });
}
export function captureDocument(html:string){
 const script='<script>('+bridge.toString()+')()<\/script>';
 // Prepend before artifact scripts so the bridge is ready at frame load.
 return html.replace(/<head(?:\s[^>]*)?>/i,match=>match+script)===html?script+html:html.replace(/<head(?:\s[^>]*)?>/i,match=>match+script);
}
export async function captureViewer(frame:HTMLIFrameElement):Promise<string>{
 if(!frame.contentWindow)throw Error('The displayed Viewer is unavailable.');
 const channel=new MessageChannel();
 try{return await new Promise<string>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('This Viewer cannot provide a capture. Write a whole-topic note instead.')),10000);
  channel.port1.onmessage=event=>{clearTimeout(timer);const value=event.data;if(value.error){reject(Error(value.error));return;}
   if(typeof value.base64!=='string'||value.base64.length>768*1024||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1){reject(Error('The captured view is incomplete.'));return;}
   resolve(value.base64);
  };
  frame.contentWindow!.postMessage({type:'rho-viewer-capture'},'*',[channel.port2]);
 });}finally{channel.port1.close();channel.port2.close();}
}
