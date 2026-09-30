import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildVisualPlugin} from './visual-plugin.mjs';
/** Extend the independent declarative example with an explicitly bound Files
 * operation. Only this disposable consumer owns its durable intent/receipt. */
export function buildVisualSciencePlugin(directory,declaration) {
 const project=buildVisualPlugin(directory),manifest=JSON.parse(fs.readFileSync(path.join(project,'plugin.json'),'utf8'));
 manifest.id='example.visual-science';manifest.name='Declarative Files';manifest.views[0].title='Declarative Files';manifest.views[0].state_schema={type:'object'};
 manifest.requires=[{capability:{id:'files.read_text',version:1},scopes:['project.read']},{capability:{id:'files.apply_patch',version:1},scopes:['project.read','project.write']},...['operation.get','operation.list_recent'].map(id=>({capability:{id,version:1},scopes:['operation.read']}))];
 fs.writeFileSync(path.join(project,'plugin.json'),JSON.stringify(manifest,null,2));fs.writeFileSync(path.join(project,'views/report.json'),JSON.stringify(declaration,null,2));
 fs.writeFileSync(path.join(project,'src/index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Declarative Files</title><style>body{padding:24px;font:14px system-ui}button{padding:8px;margin:8px}output{display:block;white-space:pre-wrap}</style><div id="report"></div><button id="inspect">Inspect original operation</button><button id="stop">Stop observing</button><output id="receipt" role="status"></output><script type="module" src="./main.js"></script></html>');
 fs.writeFileSync(path.join(project,'src/main.js'),`import {connectPluginView,mountVisualDocument,createPollingVisualSubscription,verifyOriginalOperation,inspectOriginalOperation} from './sdk/index.js';
import declaration from './document.js';
const client=await connectPluginView(),status=document.querySelector('#receipt');
let intent=client.view.state.intent??null,receipt=client.view.state.receipt??null,work=null,stopped=false;
const describe=()=>status.textContent=receipt?receipt.status+' / '+receipt.operation.operation_id:intent?'Original request unconfirmed':'No scientific action sent';
const save=()=>client.setState({intent,receipt});
async function accept(record){receipt=await verifyOriginalOperation(record,intent);intent={...intent,operation:receipt.operation.operation_id};await save();describe();}
await client.installCloseHandler({flush:async()=>{if(work)await work;}});
const runtime=mountVisualDocument(document.querySelector('#report'),declaration,{reader:client,subscribe:createPollingVisualSubscription(client,{intervalMs:200}),action:async(action,event)=>{
 if(action.kind!=='invoke')throw Error('This example declares scientific invoke actions only.');
 if(intent)throw Error('Inspect the original request; this one-shot analysis action cannot be sent again.');
 intent={view:client.view.view,request:event.requestId,capability:action.capability,arguments:action.arguments,preconditions:[],operation:null};describe();
 work=(async()=>{await save();if(stopped)throw Error('View stopped before dispatch.');await accept(await client.invoke(intent.capability,intent.arguments,{requestId:intent.request,preconditions:intent.preconditions}));})();
 try{await work;}finally{work=null;}
}});
document.querySelector('#inspect').onclick=async()=>{if(!intent||work)return;work=(async()=>{await accept(await inspectOriginalOperation(client,intent));})();try{await work;}catch(error){status.textContent=error.message;}finally{work=null;}};
document.querySelector('#stop').onclick=()=>{runtime.dispose();status.textContent='Observation stopped; original operation retained';};
window.addEventListener('pagehide',()=>{stopped=true;runtime.dispose();client.dispose();});describe();`);
 execFileSync(process.execPath,[path.join(project,'build.mjs')],{cwd:project,stdio:'inherit'});return project;
}
