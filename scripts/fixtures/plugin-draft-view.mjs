import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildUiFixture } from './plugin-ui.mjs';

/** Disposable document protocol fixture, not the ordinary Editor implementation. */
export function buildDraftViewFixture(directory) {
  const project=buildUiFixture(directory),file=path.join(project,'plugin.json');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  manifest.id='fixture.draft-view';manifest.name='Draft transfer fixture';
  manifest.description='Independent large-draft transport and close cooperation acceptance';
  manifest.requires=['documents.inspect','documents.read','documents.stage','documents.save'].map(id=>({capability:{id,version:1},scopes:[['documents.inspect','documents.read'].includes(id)?'documents.read':'documents.write']}));
  manifest.views=[{id:'document',title:'Draft',entrypoint:'dist/index.html',state_schema:{type:'object'},configuration_schema:{type:'object'},resource_kinds:[]}];
  fs.writeFileSync(file,JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(project,'src/index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Draft transfer fixture</title><style>body{box-sizing:border-box;margin:0;padding:20px;font:14px/1.5 system-ui;color:#263345}h1{font-size:22px;margin:0 0 12px}label,output{display:block;margin:12px 0}textarea{box-sizing:border-box;width:100%;height:62vh;resize:vertical;font:13px/1.5 monospace;padding:12px;border:1px solid #bcc7d4;border-radius:6px}button{padding:7px 12px}</style><h1>Draft transfer fixture</h1><p>Generic storage and close cooperation through the public SDK.</p><label for="text">Draft text</label><textarea id="text" spellcheck="false"></textarea><button id="save" type="button">Save draft</button><output id="status" role="status">Connecting…</output><script type="module" src="./main.js"></script></html>`);
  fs.writeFileSync(path.join(project,'src/main.js'),`import {connectPluginView,captureDraftContent,stageDraftContent,readDraft} from './sdk/index.js';
const client=await connectPluginView(),input=document.querySelector('#text'),status=document.querySelector('#status');
let reference=client.view.state.draft??null;
const draft=reference?.draft??crypto.randomUUID(),source={revision:client.view.instance.revision,contribution:client.view.contribution};
if(reference){const record=(await client.query({id:'documents.inspect',version:1},{window:client.view.window,draft})).data;
  if(record?.version!==reference.version)throw new Error('Saved draft version changed');
  const restored=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readDraft(client,record)));
  if(typeof restored.text!=='string')throw new Error('Draft encoding is invalid');input.value=restored.text;}
async function save(){
  const capture=await captureDraftContent(new TextEncoder().encode(JSON.stringify({text:input.value}))),upload=crypto.randomUUID(),request=crypto.randomUUID();
  status.textContent='Saving captured draft';
  const content=await stageDraftContent(client,{draft,upload},capture);
  const args={window:client.view.window,draft,upload,source,expected_version:reference?.version??null,content,metadata:{encoding:'fixture-json-text'}};
  const pending={view:client.view.view,request,arguments:args};
  await client.setState({draft:reference,pending});
  const accepted=await client.invoke({id:'documents.save',version:1},args,{requestId:request});
  pending.operation=accepted.operation.operation_id;await client.setState({draft:reference,pending});
  let record=accepted;
  // Always inspect the original, even when admission raced with fast completion.
  do {record=await client.operation(accepted.operation.operation_id);if(['accepted','running','reconciling'].includes(record.status))await new Promise(resolve=>setTimeout(resolve,25));}
  while(['accepted','running','reconciling'].includes(record.status));
  if(record.status!=='succeeded'||!record.output)throw new Error('Original draft save is not confirmed');
  reference={draft,version:record.output.version};await client.setState({draft:reference,pending:null});status.textContent='Saved';
}
const closing=await client.installCloseHandler({flush:save});
closing.subscribe(()=>{if(closing.getSnapshot().error)status.textContent=closing.getSnapshot().error;});
document.querySelector('#save').onclick=()=>save().catch(error=>status.textContent=error.message);
status.textContent='Ready';window.addEventListener('pagehide',()=>client.dispose());`);
  execFileSync(process.execPath,[path.join(project,'build.mjs')],{cwd:project,stdio:'inherit'});
  return project;
}
