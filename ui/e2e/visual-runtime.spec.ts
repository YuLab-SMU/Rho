import {test, expect} from '@playwright/test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {compilePublicUiSdk} from '../../scripts/fixtures/plugin-ui.mjs';
let directory:string, sdk:string;
test.beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'rho-visual-runtime-'));sdk=compilePublicUiSdk(directory);});
test.afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
test('standalone visual components preserve drafts, read identities and explicit event boundaries',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:7777/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'});
  await route.fulfill({contentType:'text/javascript',body:await readFile(join(sdk,'..',basename(path)),'utf8')});
 });
 await page.goto('http://127.0.0.1:7777/');
 await page.evaluate(async()=>{
  const {mountVisualDocument,createVisualNode}=await import('/index.js');
  const d:any={format_version:1,root:'root',nodes:{},data_sources:{report:{capability:{id:'report.read',version:1},arguments:{},subscribe:true}},components:{chart:{source:'src/chart.ts',export:'Chart',properties_schema:{},input_schema:{},output_schema:{}}}};
  for(const kind of ['container','split','tabs','text','button','form','list','table','media','custom'])d.nodes[kind]=createVisualNode(kind);
  d.nodes.root=createVisualNode();d.nodes.root.children=['container','split','tabs','text','button','form','list','table','media','custom'];
  d.nodes.custom.component='chart';d.nodes.custom.bindings={text:{source:'report',path:['title']}};
  d.nodes.text.bindings={text:{source:'report',path:['title']}};
  d.nodes.container.visible_when={kind:'equals',binding:{source:'report',path:['show']},value:true};
  d.nodes.container.children=['conditional'];d.nodes.conditional={...createVisualNode('text'),properties:{text:'Conditional content'}};
  d.nodes.tabs.children=['first','second'];for(const id of ['first','second'])d.nodes[id]={...createVisualNode('text'),properties:{label:id,text:`Panel ${id}`}};
  d.nodes.button.properties={text:'Execute'};d.nodes.button.events={click:[{kind:'invoke',capability:{id:'report.run',version:1},arguments:{original:true}},{kind:'set_state',key:'never-after-failure',value:true}]};
  d.nodes.form.properties={fields:[{name:'note',label:'Note',value:'Initial'}],submit_label:'Send'};
  d.nodes.form.events={submit:[{kind:'set_state',key:'note',value:'literal'}]};
  d.nodes.list.bindings={items:{source:'report',path:['items']}};d.nodes.list.events={select:[{kind:'open_view',contribution:'report',resource:null}]};
  d.nodes.table.properties={columns:['label','value'],items:[{label:'First row',value:42}]};d.nodes.table.events=d.nodes.list.events;
  d.nodes.media.bindings={resource:{source:'report',path:['image']}};d.nodes.media.properties={alt:'Verified PNG'};
  d.nodes.split.style_tokens={gap:'space'};
  const w=window as any;w.calls=[];w.failures=[];w.disposals=0;w.unsubscribed=0;w.reads=[];
  let initial:(value:any)=>void=()=>{};
  const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
  const digest='sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  w.resource={owner:{plugin:'example.report',instance:'original',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)},resource:'image',digest,bytes:bytes.length,media_type:'image/png'};
  w.runtime=mountVisualDocument(document.querySelector('#root')!,d,{
   reader:{query:async(cap:any,args:any)=>{w.reads.push({cap,args});if(cap.id==='resources.read')return {data:{reference:w.resource,offset:0,base64:btoa(String.fromCharCode(...bytes)),next:null}};return new Promise(resolve=>{initial=resolve;});}},
   subscribe:(_source:any,receive:any)=>{w.receive=receive;return()=>w.unsubscribed++;},tokens:{space:'12px'},
   action:async(action:any,context:any)=>{w.calls.push({action,context});if(w.hold)await new Promise(resolve=>w.release=resolve);if(w.fail)throw Error('Original acknowledgement unknown');},
   components:{chart:{source:'src/chart.ts',export:'Chart',mount:(element:any)=>({update:(props:any)=>element.textContent='Custom '+props.text,dispose:()=>w.disposals++})}},
   onError:(error:any,location:any)=>w.failures.push({message:error.message,location})
  });
  await Promise.resolve();w.receive({title:'Current 中文 Ω',items:['Item A','Item B'],show:false,image:w.resource});initial({title:'Stale initial result',show:true});await w.runtime.ready;
 });
 await expect(page.locator('[data-visual-node=text]')).toHaveText('Current 中文 Ω');
 await expect(page.locator('[data-visual-node=custom]')).toHaveText('Custom Current 中文 Ω');
 await expect(page.getByText('Conditional content')).toBeHidden();
 await expect(page.locator('[data-visual-node]')).toHaveCount(14);
 await expect(page.getByAltText('Verified PNG')).toHaveJSProperty('naturalWidth',1);
 expect(await page.locator('[data-visual-node=split]').evaluate(el=>getComputedStyle(el).gap)).toBe('12px');
 expect(await page.evaluate(()=>(window as any).calls)).toEqual([]);
 await page.getByRole('button',{name:'Execute',exact:true}).evaluate((el:HTMLButtonElement)=>el.click());
 await page.locator('[data-visual-node=form]').evaluate((el:HTMLFormElement)=>el.requestSubmit());
 expect(await page.evaluate(()=>(window as any).calls)).toEqual([]);
 await page.getByLabel('Note',{exact:true}).fill('Draft 中文 Ω');
 await page.evaluate(()=>{const w=window as any;w.receive({title:'Refreshed',items:['New item'],show:true,image:w.resource});});
 await expect(page.getByLabel('Note',{exact:true})).toBeFocused();await expect(page.getByLabel('Note',{exact:true})).toHaveValue('Draft 中文 Ω');
 await expect(page.getByText('Conditional content')).toBeVisible();
 await page.getByRole('tab',{name:'second',exact:true}).click();await expect(page.getByText('Panel first')).toBeHidden();await expect(page.getByText('Panel second')).toBeVisible();
 await page.getByRole('tab',{name:'second',exact:true}).press('ArrowLeft');await expect(page.getByRole('tab',{name:'first',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('button',{name:'New item',exact:true}).click();await page.getByRole('button',{name:'First row',exact:true}).click();
 const actions=await page.evaluate(()=>(window as any).calls);
 expect(actions.map((c:any)=>c.action.kind)).toEqual(['set_state','open_view','open_view']);expect(actions[0].context.value).toEqual({note:'Draft 中文 Ω'});expect(actions[1].context.value).toEqual({index:0,item:'New item'});
 expect(new Set(actions.map((c:any)=>c.context.requestId)).size).toBe(3);
 await page.evaluate(()=>{(window as any).hold=true;});await page.getByRole('button',{name:'Execute',exact:true}).click();await page.getByRole('button',{name:'Execute',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).calls.length)).toBe(4);
 await page.evaluate(()=>{const w=window as any;w.fail=true;w.release();});await expect(page.getByRole('alert')).toContainText('Original acknowledgement unknown');
 await page.screenshot({path:info.outputPath('visual-components.png')});
 await page.evaluate(()=>{const w=window as any;w.runtime.dispose();w.receive({title:'After release'});});
 await expect(page.locator('#root')).toBeEmpty();expect(await page.evaluate(()=>{const w=window as any;return [w.unsubscribed,w.disposals,w.calls.length,w.reads.filter((r:any)=>r.cap.id==='resources.read').length];})).toEqual([1,1,4,1]);
 expect(errors).toEqual([]);
});
test('missing adapters fail before reads and bounded reads settle without callbacks after disposal',async({page})=>{
 await page.route('http://127.0.0.1:7777/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div>'});
  await route.fulfill({contentType:'text/javascript',body:await readFile(join(sdk,'..',basename(path)),'utf8')});
 });await page.goto('http://127.0.0.1:7777/');
 const result=await page.evaluate(async()=>{
  const {mountVisualDocument,createVisualNode}=await import('/index.js');
  const root=document.querySelector('#root')!,d:any={format_version:1,root:'root',nodes:{root:createVisualNode()},data_sources:{report:{capability:{id:'report.read',version:1},arguments:{},subscribe:true}},components:{}};
  let calls=0,active=0,peak=0,failures=0;
  const reader:any={query:async()=>{calls++;return {};}};let unsupported='';
  try{mountVisualDocument(root,d,{reader});}catch(e){unsupported=String(e);}
  const initial=[calls,root.childNodes.length];
  d.data_sources={};for(let i=0;i<256;i++)d.data_sources[`source-${i}`]={capability:{id:'report.read',version:1},arguments:{i},subscribe:false};
  const runtime=mountVisualDocument(root,d,{reader:{query:async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,0));active--;return null;}},onError:()=>failures++});await runtime.ready;runtime.dispose();
  const full=[calls,peak,failures];
  const releases:((value:any)=>void)[]=[];calls=0;
  const released=mountVisualDocument(root,d,{reader:{query:async()=>{calls++;return new Promise(resolve=>releases.push(resolve));}},onError:()=>failures++});
  await Promise.resolve();released.dispose();releases.forEach(release=>release(null));await released.ready;
  // Outstanding observations are not scientific work and no accepted mutation is cancelled.
  const final=[calls,root.childNodes.length,failures];
  return {unsupported,initial,full,final};
 });
 expect(result.unsupported).toContain('subscription adapter');expect(result.initial).toEqual([0,0]);expect(result.full).toEqual([256,8,0]);expect(result.final).toEqual([8,0,0]);
});
