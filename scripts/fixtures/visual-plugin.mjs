import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {compilePublicUiSdk} from './plugin-ui.mjs';
/** A package built outside the checkout using only the public SDK. The build
 * consumes the declaration, so changing its checkpoint changes the actual UI. */
export function buildVisualPlugin(directory) {
  let sdk;
  if(process.env.RHO_VISUAL_SDK_ARCHIVE){
    const archive=JSON.parse(fs.readFileSync(process.env.RHO_VISUAL_SDK_ARCHIVE));
    const prefix='dist/public/plugin-ui/',output=path.join(directory,'delivered-sdk');fs.mkdirSync(output,{recursive:true});
    assert.equal(archive.revision.manifest.id,'org.rho.studio');assert.equal(archive.artifacts.length,1);
    for(const [name,entry] of Object.entries(archive.artifacts[0].files).filter(([name])=>name.startsWith(prefix))){
      const file=name.slice(prefix.length);assert.match(file,/^[a-z0-9-]+\.js$/);
      const bytes=Buffer.from(archive.blobs[entry.digest],'base64');assert.equal(bytes.length,entry.bytes);
      assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),entry.digest);
      fs.writeFileSync(path.join(output,file),bytes,{flag:'wx'});
    }
    sdk=path.join(output,'index.js');assert.ok(fs.existsSync(sdk),'Delivered Studio must include the compiled public SDK');
  }else sdk=compilePublicUiSdk(path.join(directory,'public-sdk'));
  const project=path.join(directory,'declarative-plugin');fs.mkdirSync(path.join(project,'src'),{recursive:true});fs.mkdirSync(path.join(project,'views'));
  fs.cpSync(path.dirname(sdk),path.join(project,'src/sdk'),{recursive:true});
  const node=kind=>({kind,children:[],properties:{},style_tokens:{},bindings:{},visible_when:null,events:{},component:null});
  const declaration={format_version:1,root:'root',nodes:{root:{...node('container'),children:['title','count','save','badge']},title:{...node('text'),properties:{text:'Original declaration'}},count:{...node('text'),bindings:{text:{source:'catalog',path:['data','total']}}},save:{...node('button'),properties:{text:'Remember selection'},events:{click:[{kind:'set_state',key:'selection',value:'original'}]}},badge:{...node('custom'),component:'badge',properties:{text:'Opaque component 中文'}}},data_sources:{catalog:{capability:{id:'plugins.list',version:1},arguments:{after:null,limit:10},subscribe:false}},components:{badge:{source:'src/badge.js',export:'Badge',properties_schema:{},input_schema:{},output_schema:{}}}};
  fs.writeFileSync(path.join(project,'views/report.json'),JSON.stringify(declaration,null,2)+'\n');
  fs.writeFileSync(path.join(project,'src/index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Declarative Report</title><style>body{padding:24px;font:14px system-ui}button{padding:8px;margin-top:12px}output{display:block;margin-top:12px}</style><div id="report"></div><output id="receipt" role="status"></output><script type="module" src="./main.js"></script></html>');
  fs.writeFileSync(path.join(project,'src/badge.js'),"export function Badge(element){return {update(properties){element.textContent=properties.text;},dispose(){element.replaceChildren();}};}\n");
  fs.writeFileSync(path.join(project,'src/main.js'),`import {connectPluginView,mountVisualDocument} from './sdk/index.js';
import declaration from './document.js';
import {Badge} from './badge.js';
const client=await connectPluginView(),receipt=document.querySelector('#receipt');
receipt.textContent=client.view.state.selection??'No selection saved';
let pending=Promise.resolve();
await client.installCloseHandler({flush:()=>pending});
const runtime=mountVisualDocument(document.querySelector('#report'),declaration,{reader:client,components:Object.fromEntries(Object.entries(declaration.components).filter(([,definition])=>definition.source==='src/badge.js'&&definition.export==='Badge').map(([id,definition])=>[id,{source:definition.source,export:definition.export,mount:Badge}])),action:async(action)=>{
 if(action.kind!=='set_state')throw Error('This example supports only intrinsic view-state actions.');
 pending=client.setState({...client.view.state,[action.key]:action.value});await pending;receipt.textContent=client.view.state.selection;
}});
window.addEventListener('pagehide',()=>{runtime.dispose();client.dispose();});`);
  fs.writeFileSync(path.join(project,'build.mjs'),`import{cpSync,readFileSync,writeFileSync}from'node:fs';
import{parseVisualDocument}from'./src/sdk/index.js';
const declaration=parseVisualDocument(readFileSync(new URL('./views/report.json',import.meta.url),'utf8'));
cpSync(new URL('./src/',import.meta.url),new URL('./dist/',import.meta.url),{recursive:true});
writeFileSync(new URL('./dist/document.js',import.meta.url),'export default '+JSON.stringify(declaration)+';\\n');`);
  fs.writeFileSync(path.join(project,'BUILD.md'),'Run node build.mjs. The build validates views/report.json with the included public SDK and emits that exact declaration into dist/document.js. No core checkout or dependency download is needed.');
  fs.writeFileSync(path.join(project,'dependencies.lock'),'Public Rho UI SDK source modules included under src/sdk; no third-party runtime dependency.\n');
  fs.copyFileSync(new URL('../../LICENSE',import.meta.url),path.join(project,'LICENSE'));
  const manifest={protocol_version:1,id:'example.declarative-report',name:'Declarative Report',version:'1.0',description:'Executable public visual declaration example',license:'AGPL-3.0-only',source:{files:['src/index.html','src/main.js','src/badge.js','views/report.json',...fs.readdirSync(path.join(project,'src/sdk')).filter(n=>n.endsWith('.js')).map(n=>`src/sdk/${n}`),'build.mjs','LICENSE'],lockfiles:['dependencies.lock'],build_instructions:'BUILD.md',build:{command:['node','build.mjs']}},dependencies:{},requires:[{capability:{id:'plugins.list',version:1},scopes:['plugins.read']}],views:[{id:'report',title:'Declarative Report',entrypoint:'dist/index.html',state_schema:{type:'object',properties:{selection:{type:'string'}},additionalProperties:false},configuration_schema:{type:'object',additionalProperties:false},resource_kinds:[]}],capabilities:[],contexts:[],backend:null,configuration_schema:{type:'object',additionalProperties:false},default_configuration:{}};
  fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(manifest,null,2));
  execFileSync(process.execPath,[path.join(project,'build.mjs')],{cwd:project,stdio:'inherit'});
  return project;
}
