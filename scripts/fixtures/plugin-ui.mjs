import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
/** Only public SDK sources are copied into the external build. No private client
 * bundles, core contracts or repository modules participate in its implementation. */
export function compilePublicUiSdk(directory) {
  fs.mkdirSync(directory,{recursive:true});
  fs.cpSync(path.join(root,"sdk/plugin-protocol"),path.join(directory,"plugin-protocol"),{recursive:true});
  fs.cpSync(path.join(root,"sdk/plugin-ui"),path.join(directory,"plugin-ui"),{recursive:true});
  fs.writeFileSync(path.join(directory,"package.json"),'{"type":"module"}');
  execFileSync(process.execPath,[path.join(root,"ui/node_modules/typescript/bin/tsc"),"--strict","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2022","--lib","ES2022,DOM","--rootDir",directory,"--outDir",path.join(directory,"build"),path.join(directory,"plugin-ui/index.ts")],{cwd:directory,stdio:"inherit"});
  return path.join(directory,"build/plugin-ui/index.js");
}
export function buildUiFixture(directory) {
  const sdk=compilePublicUiSdk(path.join(directory,"public-sdk"));
  const project=path.join(directory,"external-plugin");
  fs.mkdirSync(path.join(project,"src"),{recursive:true});
  fs.copyFileSync(sdk,path.join(project,"src/sdk.js"));
  fs.copyFileSync(path.join(root,"LICENSE"),path.join(project,"LICENSE"));
  fs.writeFileSync(path.join(project,"src/index.html"),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Independent View</title><style>body{margin:0;padding:24px;font:14px/1.5 system-ui;color:#202936}h1{font-size:22px}label{display:block;margin:20px 0 6px}input{width:90%;max-width:480px;padding:8px}button{margin:12px 8px 12px 0;padding:6px 12px}output{display:block;white-space:pre-wrap}</style><h1>Independent View</h1><p>Loaded from an ordinary immutable plugin package.</p><output id="connection">Connecting…</output><label for="text">View note</label><input id="text"><button id="save">Save note</button><button id="query">Read plugins</button><button id="denied">Try undeclared read</button><output id="result"></output><script type="module" src="./main.js"></script></html>`);
  fs.writeFileSync(path.join(project,"src/main.js"),`import {connectPluginView} from './sdk.js';
const client=await connectPluginView();
document.querySelector('#connection').textContent='Connected';
const input=document.querySelector('#text'),result=document.querySelector('#result');
input.value=client.view.state.text;
document.querySelector('#save').onclick=async()=>{try{await client.setState({text:input.value});result.textContent='Saved';}catch(e){result.textContent=e.message;}};
document.querySelector('#query').onclick=async()=>{try{const data=await client.query({id:'plugins.list',version:1},{after:null,limit:10});result.textContent='Plugins: '+data.data.total;}catch(e){result.textContent=e.message;}};
document.querySelector('#denied').onclick=async()=>{try{await client.query({id:'plugins.instances',version:1},{after:null,limit:10});result.textContent='Unexpectedly allowed';}catch(e){result.textContent=e.message;}};
window.addEventListener('pagehide',()=>client.dispose());`);
  fs.writeFileSync(path.join(project,"build.mjs"),"import{cpSync}from'node:fs';cpSync(new URL('./src/',import.meta.url),new URL('./dist/',import.meta.url),{recursive:true});");
  fs.writeFileSync(path.join(project,"BUILD.md"),"Run node build.mjs. All source, including the compiled public browser SDK, is present. No download or core checkout is needed.");
  fs.writeFileSync(path.join(project,"dependencies.lock"),"Rho public UI SDK 0.1.0, compiled from the accompanying public SDK sources; runtime closure is src/sdk.js. No third-party runtime dependencies.\n");
  fs.writeFileSync(path.join(project,"plugin.json"),JSON.stringify({protocol_version:1,id:"example.external-ui",name:"Independent View",version:"1.0",description:"External public-SDK view conformance",license:"AGPL-3.0-only",
    source:{files:["src/index.html","src/main.js","src/sdk.js","build.mjs","LICENSE"],lockfiles:["dependencies.lock"],build_instructions:"BUILD.md",build:{command:["node","build.mjs"]}},dependencies:{},
    requires:[{capability:{id:"plugins.list",version:1},scopes:["plugins.read"]}],views:[{id:"view",title:"Independent View",entrypoint:"dist/index.html",state_schema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},configuration_schema:{type:"object",additionalProperties:false},resource_kinds:[]}],capabilities:[],contexts:[],backend:null,configuration_schema:{type:"object",additionalProperties:false},default_configuration:{}},null,2));
  execFileSync(process.execPath,[path.join(project,"build.mjs")],{cwd:project,stdio:"inherit"});
  return project;
}
