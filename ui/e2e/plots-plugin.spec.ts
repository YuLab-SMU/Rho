/** Ordinary Plots presentation fixture; native science is separate. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { buildPlotsPlugin } from "../../scripts/build-plots-plugin.mjs";
let directory: string, server: Server, origin: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-plots-views-")); buildPlotsPlugin(join(directory, "plots"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body style="margin:0"><nav style="height:36px;display:flex;gap:8px;padding:4px;box-sizing:border-box"></nav><main></main></body></html>'); return; }
    const file = resolve(directory, "." + path);
    if (!file.startsWith(directory + "/")) { response.writeHead(404).end(); return; }
    try {
      response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'; img-src data: blob:; frame-src 'none'");
      response.end(readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });
test("Plots retains verified originals, responsive transforms and independently pinned comparisons",async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
 await page.evaluate(async()=>{
  const r={instance:'r-one',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)},plots={...r,instance:'plots',plugin:'org.rho.plots'};
  const view={view:'plots',instance:plots,project:'project',principal:'principal',contribution:'plots',window:'window',configuration:{source:r,selection:null,pinned:false,plot_group:'main'},state:{},state_version:0,closed:false};
  const fixture={views:{plots:view} as Record<string,any>,records:[] as any[],calls:[] as any[],failSave:false,images:new Map<string,any>(),executions:new Map<string,any>(),
   layout:{project:'project',principal:'principal',window:'window',version:1,layout:{kind:'tabs',id:'main',views:['plots'],selected:'plots'}}};(window as any).fixture=fixture;
  const hash=async(bytes:Uint8Array<ArrayBuffer>)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const append=async(n:number)=>{
   const name=`run-${n}`,bytes=new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="600" height="400" fill="white"/><path d="M60 30V340H565" fill="none" stroke="#65717d" stroke-width="2"/><path d="M80 300L180 220L290 250L420 100L540 50" stroke="${n===1?'#2863d6':'#25775b'}" stroke-width="5" fill="none"/><text x="60" y="375" fill="#202936" font-family="sans-serif" font-size="16">Retained plot ${n} · 中文 αβ</text></svg>`);
   const reference={owner:r,resource:`image-${n}`,digest:await hash(bytes),bytes:bytes.length,media_type:'image/svg+xml'},source={view_id:'script',label:'分析.R',kind:'file'};
   const record={operation:{operation_id:name,accepted_at_ms:n,capability:{id:'r.execute',version:2},normalized_arguments:{binding:{provider:r,target:'native'},arguments:{run:{source}}}},status:'succeeded',output:{operation_id:name,session_id:'native',source,outputs:[{reference,native:{operation_id:name,sequence:1,mime_type:reference.media_type,byte_size:reference.bytes,sha256:reference.digest,display_id:null}}]}};
   fixture.images.set(reference.resource,{reference,bytes});fixture.executions.set(name,record);
  };await append(1);await append(2);(fixture as any).append=append;
  const show=(id:string)=>{for(const frame of document.querySelectorAll<HTMLIFrameElement>('iframe'))frame.style.display=frame.title===id?'block':'none';};
  const mount=(record:any)=>{
   const button=document.createElement('button');button.textContent=record.view==='plots'?'Plots':record.view;button.onclick=()=>show(record.view);document.querySelector('nav')!.append(button);
   const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');frame.title=record.view;frame.style.cssText='width:100vw;height:calc(100vh - 36px);border:0;display:block';
   frame.src=`/plots/dist/index.html#rho-view-nonce=${record.view}`;document.querySelector('main')!.append(frame);show(record.view);
  };
  window.addEventListener('message',event=>{
   if(event.data?.type!=='rho:view:ready')return;const record=fixture.views[event.data.nonce];if(!record)return;
   const channel=new MessageChannel();let sequence=0;
   channel.port1.onmessage=async event=>{
    const message=event.data,body=message.body;fixture.calls.push({view:record.view,...structuredClone(body)});let result:any,error:string|undefined;
    if(body.type==='query'){
     if(body.capability.id==='operation.list_recent')result={status:'ready',data:{operations:[...fixture.executions.values()].reverse().map(r=>({operation_id:r.operation.operation_id,capability:r.operation.capability,status:r.status})),next_cursor:null}};
     else if(body.capability.id==='operation.get')result={status:'ready',data:{record:fixture.executions.get(body.arguments.operation_id)??fixture.records.find(r=>r.operation.operation_id===body.arguments.operation_id)}};
     else if(body.capability.id==='resources.read'){
      const image=fixture.images.get(body.arguments.reference.resource),offset=body.arguments.offset,end=Math.min(offset+body.arguments.limit,image.bytes.length);
      result={status:'ready',data:{reference:image.reference,offset,base64:btoa(String.fromCharCode(...image.bytes.subarray(offset,end))),next:end===image.bytes.length?null:end}};
     }else if(body.capability.id==='windows.layout')result={status:'ready',data:fixture.layout};
     else error=`Unexpected query ${body.capability.id}`;
    }else if(body.type==='set_state'){
     if(fixture.failSave)error='Fixture storage failure';else{record.state=body.state;record.state_version++;result={status:'succeeded',output:record};}
    }else if(body.type==='invoke'&&body.capability.id==='windows.open_view'){
     result={status:'succeeded',outcome:'succeeded',operation:{operation_id:`navigation-${fixture.records.length+1}`,caller:{kind:'plugin',id:record.view},capability:body.capability,client_request_id:await hash(new TextEncoder().encode(`${record.view}:${body.request_id}`)),normalized_arguments:body.arguments}};
     fixture.records.push(result);const opened={...body.arguments.view,view:`comparison-${fixture.records.length}`,project:'project',principal:'principal',state_version:0,closed:false};
     fixture.views[opened.view]=opened;fixture.layout.version++;fixture.layout.layout.views.push(opened.view);fixture.layout.layout.selected=opened.view;mount(opened);
    }else if(['register_close_handler','observe_lifecycle'].includes(body.type))result={view:record.view,state_version:record.state_version,close:{phase:'open'}};
    else error=`Unexpected request ${body.type}`;
    channel.port1.postMessage({protocol_version:1,connection:`connection-${record.view}`,view:record.view,sequence:++sequence,request:message.request,ok:!error,result:structuredClone(result),error});
   };
   (event.source as Window).postMessage({type:'rho:view:connect',nonce:record.view,protocol_version:1,connection:`connection-${record.view}`,view:record,features:['view_close_v1']},'*',[channel.port2]);
  });mount(view);
 });
 const frame=page.frameLocator('iframe[title="plots"]'),canvas=frame.getByLabel('Plot Canvas');
 await expect(frame.getByLabel('Plot History').getByRole('button',{name:/Select Plot/})).toHaveCount(2);
 await expect(frame.locator('.plot-original img')).toBeVisible();await expect(frame.getByLabel('Select Plot 2')).toHaveAttribute('aria-pressed','true');
 for(const width of [1440,1920,390,240]){
  await page.setViewportSize({width,height:900});await expect.poll(()=>canvas.evaluate(()=>innerWidth)).toBe(width);
  expect(await canvas.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await canvas.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:info.outputPath(`plots-plugin-${width}.png`)});
 }
 await page.setViewportSize({width:1440,height:900});await frame.getByLabel('Select Plot 1').click();
 await expect(frame.getByText('Inspecting history',{exact:false})).toBeVisible();
 await frame.getByRole('button',{name:'Zoom In',exact:true}).click();await frame.getByRole('button',{name:'Zoom In',exact:true}).click();
 const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+30);await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>Object.values((window as any).fixture.views.plots.state.plots?.plotViews.plots.transforms??{}).some((t:any)=>t.x!==0||t.y!==0))).toBe(true);
 await canvas.focus();await canvas.press('0');await expect.poll(()=>page.evaluate(()=>Object.values((window as any).fixture.views.plots.state.plots.plotViews.plots.transforms).every((t:any)=>t.zoom===null))).toBe(true);
 await frame.getByRole('button',{name:'Details',exact:true}).click();await expect(frame.getByRole('dialog')).toContainText('分析.R');await expect(frame.getByRole('dialog')).toContainText('image-1');
 await page.screenshot({path:info.outputPath('plots-details-1440.png')});await page.keyboard.press('Escape');
 await page.evaluate(()=>{(window as any).fixture.failSave=true;});
 await frame.getByRole('button',{name:'Plot Actions',exact:true}).click();await frame.getByRole('menuitem',{name:'Open Plot in New View',exact:true}).click();
 await expect(frame.getByText('Comparison unconfirmed',{exact:false})).toBeVisible();expect(await page.evaluate(()=>(window as any).fixture.records.length)).toBe(0);
 await page.evaluate(()=>{(window as any).fixture.failSave=false;});await frame.getByRole('button',{name:'Retry Original Request',exact:true}).click();
 const comparison=page.frameLocator('iframe[title="comparison-1"]');await expect(comparison.locator('.plot-original img')).toBeVisible();await expect(comparison.locator('.panel-footer')).toContainText('Pinned plot');
 expect(await page.evaluate(()=>(window as any).fixture.views['comparison-1'].configuration.selection)).toEqual({operation_id:'run-1',resource_id:'image-1'});
 await page.evaluate(async()=>{await (window as any).fixture.append(3);});
 await expect(comparison.getByLabel('Plot History').getByRole('button',{name:/Select Plot/})).toHaveCount(3);await expect(comparison.getByLabel('Select Plot 1')).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Plots',exact:true}).click();await frame.getByRole('button',{name:'Inspect Operation',exact:true}).click();
 await frame.getByRole('button',{name:'Go to Latest',exact:true}).click();await expect(frame.getByLabel('Select Plot 3')).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>(window as any).fixture.calls.some((c:any)=>c.capability?.id==='r.execute'))).toBe(false);expect(errors).toEqual([]);
});
