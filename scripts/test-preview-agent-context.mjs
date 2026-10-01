// One bounded Preview flow over the ordinary Host, Agent, Editor, Files and R.
// No implicit builds, no writes to the user's preview. Artifacts/receipts persist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as createResourceSocket} from 'node:net';
import {documentWorkflow} from './fixtures/agent-document-workflow.mjs';
import {PreviewHost} from './preview/workspace.mjs';
import {installPluginSet} from './plugin-set.mjs';
import {chromium} from '../ui/node_modules/playwright/index.mjs';
const options=Object.fromEntries(process.argv.slice(2).reduce((all,value,i,args)=>i%2?all:[...all,[value,args[i+1]]],[]));
if(options['--recheck']){
  // Recheck only retained evidence after a report-assertion failure. Never replay
  // a model request or scientific mutation to repair an event-assembly assertion.
  const previous=JSON.parse(fs.readFileSync(options['--recheck']));assert.ok(options['--report']);
  assert.equal(previous.live_run?.state,'completed');assert.match(previous.error??'',/lilac-orbit-527/);
  const data=path.join(previous.directory,'plugins-v1','instance-data-v1','instance-'+previous.instances.agent.instance,'agent-v1.sqlite');
  const retained=JSON.parse(execFileSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({'events':[json.loads(r[0]) for r in c.execute('select value from component_agent_events where run_id=? order by sequence',(sys.argv[2],))], 'tools':[json.loads(r[0])['receipt'] for r in c.execute('select value from component_agent_tools where run_id=?',(sys.argv[2],))]}))`,data,previous.live_run.run_id],{encoding:'utf8'}));
  assert.equal(retained.events.length,previous.live_run.event_cursor);
  for(const [i,event] of retained.events.entries())assert.equal(event.sequence,i+1);
  const answer=retained.events.filter(e=>e.content.kind==='text').map(e=>e.content.text).join('');assert.match(answer,/lilac-orbit-527/);
  for(const cap of ['files.read_text','editor.context.search','editor.edit','editor.save','editor.run'])assert.ok(retained.tools.some(t=>t.capability===cap&&t.phase==='resolved'));
  for(const cap of ['editor.edit','editor.save','editor.run'])assert.ok(retained.tools.some(t=>t.capability===cap&&t.result.status==='succeeded'));
  assert.equal(retained.tools.filter(t=>t.capability==='editor.run').length,1);
  assert.equal(previous.live_objects.status,'ready');assert.equal(previous.live_objects.data.values[0].number,57);
  assert.match(fs.readFileSync(path.join(previous.directory,'project/analysis.R'),'utf8'),/57L/);
  previous.rechecked_from=path.resolve(options['--recheck']);previous.recheck_scope='Read-only assembly of all retained streaming text events; no model or R work replayed';
  previous.original_report_error=previous.error;delete previous.error;previous.live_answer=answer;previous.live_events=retained.events;
  previous.stages.push('Real configured model reads files and Editor, edits/saves/runs once and observes 57 in R');
  previous.checks.push({name:'real model end-to-end',passed:true,model:previous.live_model});previous.status='passed';previous.completed=true;
  fs.writeFileSync(options['--report'],JSON.stringify(previous,null,2)+'\n');console.log(JSON.stringify({report:options['--report'],status:previous.status,recheck:previous.recheck_scope}));process.exit(0);
}
if(options['--recheck-disconnect']){
  await (async()=>{
  // Recheck retained recovery after a report/assertion-only failure. Do not
  // replay an Agent, Editor or native R request against the existing test DB.
  assert.ok(options['--rho']&&options['--report']);
  const source=path.resolve(options['--recheck-disconnect']),previous=JSON.parse(fs.readFileSync(source));
  assert.match(previous.error??'',/Disconnected instances must not retain a resume token/);
  assert.equal(previous.document_workflow?.complete,true);
  assert.equal(previous.document_workflow.cases.length,6);
  assert.ok(previous.document_workflow.cases.every(item=>item.status==='passed'));
  const noteCase=previous.document_workflow.cases.find(item=>item.id==='objects-script');
  assert.ok(noteCase);
  const frozen=noteCase.receipts.find(item=>item.capability==='annotations.document.freeze');
  const written=noteCase.receipts.find(item=>item.capability==='annotations.write');
  const agentRead=noteCase.receipts.find(item=>item.capability==='annotations.read');
  assert.equal(frozen?.result.status,'succeeded');assert.equal(written?.result.status,'succeeded');
  assert.equal(agentRead?.result.status,'ready','Agent itself must read back the saved annotation');
  assert.match(JSON.stringify(agentRead.result.data),/association is not causation/);
  assert.match(JSON.stringify(agentRead.result.data),/中文研究记录/);
  assert.match(JSON.stringify(agentRead.result.data),new RegExp(frozen.result.output.outcome.evidence_id));
  assert.equal(noteCase.receipts.filter(item=>item.capability==='r.observe_object').at(-1).result.data.metadata.preview[0].number,703984);
  const directory=previous.directory,project=path.join(directory,'project'),database=path.join(directory,'rho.sqlite');
  let host,api;
  const deadline=(promise,ms,label)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error(label+' timed out')),ms);t.unref();})]);
  try{
    host=spawn(options['--rho'],['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
    const exited=new Promise(resolve=>host.once('exit',(code,signal)=>resolve({code,signal})));
    const address=await deadline(new Promise((resolve,reject)=>{let log='';host.on('error',reject);host.stdout.on('data',bytes=>{log+=bytes;const match=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(match)resolve(match[0]);});exited.then(value=>reject(Error('Host exited '+JSON.stringify(value))));}),60000,'Recovery Host startup');
    api=new PreviewHost(address,project,path.join(directory,'workspace.json'));
    const query=(id,args)=>api.query(id,args),parentId=previous.interrupted_run.operation.operation_id;
    const retained=await query('plugins.instance',{instance:previous.instances.editor});
    assert.equal(retained.instance.state,'disconnected');assert.ok(retained.instance.suspension==null);
    const parent=(await query('operation.get',{operation_id:parentId})).record;
    assert.equal(parent.operation.operation_id,parentId);assert.equal(parent.operation.capability.id,'editor.run');assert.equal(parent.status,'uncertain');
    const history=await query('operation.list_recent',{limit:100,before_cursor:null});let execution;
    for(const summary of history.operations.filter(item=>item.capability.id==='r.execute')){
      const record=await api.port('get_operation',{operation_id:summary.operation_id});
      if(record.operation.causation_id===parentId)execution=record;
    }
    assert.ok(execution,'The original native R child remains in the Host operation journal');
    assert.equal(execution.operation.caller.id,previous.instances.editor.instance);
    assert.equal(execution.status,'succeeded');assert.equal(execution.operation.normalized_arguments.arguments.run.code,'workflow_crash <- 99L\nwriteLines("started", "crash.started")\nwhile (!file.exists("crash.release")) Sys.sleep(0.05)\ncat("one\\n", file="crash.effects", append=TRUE)\n');
    assert.equal((await query('plugins.instance',{instance:previous.instances.r})).instance.state,'suspended');
    assert.equal(fs.readFileSync(path.join(project,'crash.effects'),'utf8'),'one\n');
    previous.rechecked_from=source;previous.disconnect_recovery={editor_state:'disconnected',resume_token_retained:false,parent:parent.status,execution:execution.operation.operation_id,native:execution.status,one_effect:true,r_suspended:true,r_resumed:false};
    previous.stages.push('Verified after report assertion correction: disconnected Editor stays unavailable; original uncertain parent and succeeded R child survive Host restart without replay');
    previous.checks.push({name:'Host restart and interrupted child recovery recheck',passed:true,replay:false});
    previous.original_report_error=previous.error;delete previous.error;previous.completed=true;previous.status='passed';
    fs.writeFileSync(options['--report'],JSON.stringify(previous,null,2)+'\n');
    console.log(JSON.stringify({status:previous.status,report:options['--report'],editor:retained.instance.state,parent:parent.status,execution:execution.status,one_effect:true}));
  }finally{
    if(host&&host.exitCode===null){host.kill('SIGINT');const ended=await deadline(new Promise(resolve=>host.once('exit',(code,signal)=>resolve({code,signal}))),60000,'Recovery Host shutdown');assert.equal(ended.code,0);}
  }
  })();
  process.exit(0);
}
assert.ok(!(options['--document-workflow']==='true'&&options['--live-agent-data']),'Run deterministic document/restart acceptance separately from real-provider assessment');
for(const name of ['--set','--rho','--ark','--r-home','--report'])assert.ok(options[name],`Supply ${name}; no builds are implicit`);
const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-preview-agent-context-'))),project=path.join(directory,'project'),database=path.join(directory,'rho.sqlite');
fs.mkdirSync(project);execFileSync('git',['init','-q',project]);
fs.writeFileSync(path.join(project,'notes.txt'),'Preview context sentinel: lilac-orbit-527\n');
fs.writeFileSync(path.join(project,'analysis.R'),'preview_answer <- 2L\n');
fs.copyFileSync(new URL('../examples/rho-demo/data/raw/gapminder.csv',import.meta.url),path.join(project,'gapminder.csv'));
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),key=(id,version=1)=>({id,version});
const report={directory,source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source_dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),status:'running',stages:[],model:'deterministic tool peer',checks:[],completed:false};
const save=()=>fs.writeFileSync(options['--report'],JSON.stringify(report,null,2)+'\n');save();
let host,browser,peer,api,exited;
const deadline=(promise,ms,label)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error(label+' timed out')),ms);t.unref();})]);
let calls=[];
try{
  // Fail before import/build/browser work when the executor cannot support the
  // existing native resource transport. This is never a skipped passing stage.
  if(process.platform!=='win32'){
    const probe=createResourceSocket();
    try{await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(path.join(directory,'resource-probe.sock'),resolve);});}
    catch(error){report.status='blocked';report.blocker='Native plugin resource channel requires AF_UNIX sockets: '+error.message;throw error;}
    finally{if(probe.listening)await new Promise(resolve=>probe.close(resolve));}
  }
  // The full archive set was verified by assembly. Import only this flow's
  // consumers and annotation contract dependency; failed harness stages need no unrelated reinstall.
  const selectedSet=path.join(directory,'flow-packages');fs.mkdirSync(selectedSet);
  const fullIndex=JSON.parse(fs.readFileSync(path.join(options['--set'],'plugin-set.json')));
  const subset={...fullIndex,profile:'custom',packages:fullIndex.packages.filter(p=>['org.rho.files','org.rho.r','org.rho.editor','org.rho.agent','org.rho.objects','org.rho.annotations'].includes(p.plugin))};
  for(const entry of subset.packages)fs.copyFileSync(path.join(options['--set'],entry.file),path.join(selectedSet,entry.file));
  fs.writeFileSync(path.join(selectedSet,'plugin-set.json'),JSON.stringify(subset));
  installPluginSet({rho:options['--rho'],directory:selectedSet,database});
  const startHost=async()=>{
  host=spawn(options['--rho'],['--database',database,'--project',project,'--plugins-only','workbench'],{stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>host.once('exit',(code,signal)=>resolve({code,signal})));
  let log='',errors='';host.stderr.on('data',bytes=>{errors+=bytes;fs.writeFileSync(path.join(directory,'host.log'),errors.replace(/token=[a-z0-9]+/g,'token=<redacted>'));});
  const address=await deadline(new Promise((resolve,reject)=>{host.on('error',reject);host.stdout.on('data',bytes=>{log+=bytes;const match=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);if(match)resolve(match[0]);});exited.then(value=>reject(Error('Host exited '+JSON.stringify(value))));}),60000,'Host startup');
  api=new PreviewHost(address,project,path.join(directory,'workspace.json'));
  };
  await startHost();
  const query=(id,args)=>api.query(id,args);
  const invoke=async(id,args,version=1,expected='succeeded',request=randomUUID())=>{
    let record=await api.port('invoke',{capability:key(id,version),arguments:args,preconditions:[],client_request_id:request});
    const limit=Date.now()+180000;
    while(!['succeeded','failed','cancelled','uncertain'].includes(record.status)){
      assert.ok(Date.now()<limit,`${id} did not settle`);await new Promise(resolve=>setTimeout(resolve,50));record=await api.port('get_operation',{operation_id:record.operation.operation_id});
    }
    assert.equal(record.status,expected,`${id}: ${record.error}`);return record;
  };
  const index=JSON.parse(fs.readFileSync(path.join(options['--set'],'plugin-set.json'))),instances={};
  for(const name of ['files','r','editor','agent','objects','annotations']){
    const pkg=index.packages.find(p=>p.plugin==='org.rho.'+name),inspected=await query('plugins.inspect',{revision:pkg.revision});
    const optional=(inspected.manifest.optional_requires ?? []).map(g=>g.capability).filter(cap=>!cap.id.startsWith('process.')&&!cap.id.startsWith('remote.')&&!cap.id.startsWith('environment.')&&!cap.id.startsWith('slurm.'));
    const config=name==='r'?{ark:fs.realpathSync(options['--ark']),r_home:fs.realpathSync(options['--r-home']),execution_timeout_seconds:120}:{};
    instances[name]=(await invoke('plugins.activate',{revision:pkg.revision,artifact:pkg.artifacts[0].id,target:pkg.artifacts[0].target,alias:name,configuration:config,optional_capabilities:optional})).output.instance.identity;
  }
  report.instances=instances;save();
  const binding=async(name,id,version=1)=>query('plugins.resolve',{instance:instances[name],capability:key(id,version)});
  const pq=async(name,id,args,version=1)=>query(id,{binding:await binding(name,id,version),arguments:args,preconditions:null});
  const pi=async(name,id,args,version=1,expected='succeeded',request)=>invoke(id,{binding:await binding(name,id,version),arguments:args,preconditions:null},version,expected,request);
  const session=(await pi('r','r.create_session',{},1)).output.session_id;report.session=session;save();
  const file=(await pq('files','files.snapshot',{paths:['analysis.R'],limit:1})).files[0];
  const open=async(name,configuration,state={})=>{
    const layout=await query('windows.layout',{window:api.window});
    return (await invoke('windows.open_view',{expected_layout_version:layout.version,group:layout.layout.kind==='tabs'?layout.layout.id:null,view:{instance:instances[name],contribution:name,window:api.window,configuration,state}})).output.view;
  };
  const editor=await open('editor',{source:instances.files,file,runtime:instances.r});
  const projectId=editor.project;
  const selected=(name,id,version=1)=>({name:id.replaceAll('.','_'),target:{type:'provider',binding:{provider:instances[name],project:projectId,capability:key(id,version),target:null}}});
  const tools=[selected('r','r.session'),selected('r','r.execute',2),selected('files','files.read_text'),...['editor.context.search','editor.context.preview','editor.edit','editor.save','editor.run','editor.run.inspect'].map(id=>selected('editor',id)),...['annotations.read','annotations.write','annotations.document.freeze'].map(id=>selected('annotations',id))];
  const agent=await open('agent',{tools});report.agent_view=agent.view;save();
  await open('objects',{source:instances.r,object_group:null});
  // One browser connection per saved view; no duplicate renderers/sequence races.
  browser=await chromium.launch({...(options['--browser-path']?{executablePath:options['--browser-path']}:{channel:'chrome'}),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(api.browserUrl());
  // Generic core uses title/data attributes across revisions; select the unique editor content frame.
  const getFrame=async(label)=>{for(let n=0;n<200;n++){for(const frame of page.frames())if(await frame.getByLabel(label,{exact:true}).count())return frame;await new Promise(r=>setTimeout(r,50));}throw Error('Missing '+label);};
  await page.getByRole('tab',{name:'Editor',exact:true}).click();
  const editorUI=await getFrame('Code Editor');await editorUI.getByLabel('Code Editor',{exact:true}).click();
  let reference;
  for(let i=0;i<100;i++){const found=await pq('editor','editor.context.search',{window:api.window,text:'analysis.R',after:null,limit:20});if(found.items.length){reference=found.items[0].reference;break;}await new Promise(r=>setTimeout(r,50));}
  assert.ok(reference,'Editor must synchronize its current document');report.stages.push('real Editor document synchronized');save();
  const changed=await pi('editor','editor.edit',{reference,code:'preview_answer <- 42L\ncat(preview_answer, "\\n")\n'});reference=changed.output.reference;
  await editorUI.getByLabel('Code Editor',{exact:true}).filter({hasText:'42L'}).waitFor();
  await pi('editor','editor.edit',{reference:{...reference,selector:{...reference.selector,version:reference.selector.version-1}},code:'must not replace'},1,'failed');
  const saved=await pi('editor','editor.save',{reference});reference=saved.output.reference;
  assert.match(fs.readFileSync(path.join(project,'analysis.R'),'utf8'),/42L/);
  reference=(await pi('editor','editor.save',{reference})).output.reference;
  const retained=fs.readFileSync(path.join(project,'analysis.R'));
  fs.writeFileSync(path.join(project,'analysis.R'),'external writer\n');
  await pi('editor','editor.save',{reference},1,'failed');
  assert.equal(fs.readFileSync(path.join(project,'analysis.R'),'utf8'),'external writer\n');
  fs.writeFileSync(path.join(project,'analysis.R'),retained);
  const ran=await pi('editor','editor.run',{reference,runtime:instances.r,expected_session:session});assert.ok(ran.output.operations.length);
  const objects=await pq('r','r.list_objects',{expected_session:session,limit:20});assert.equal(objects.status,'ready');assert.match(JSON.stringify(objects),/preview_answer/);
  report.stages.push('Editor edit → resident update → stale edit refusal → save → captured real R run');save();
  // Local streaming peer exercises actual model tool dispatch; no native effects are mocked.
  let turn=0,plan=null;
  const setPlan=(steps,answer)=>plan={steps,answer,sent:0};
  peer=createServer(async(request,response)=>{
    try{
      let bytes='';for await(const part of request)bytes+=part;const body=JSON.parse(bytes);calls.push(body);
      const available=body.tools.map(t=>t.function.name);assert.ok(available.includes('files_read_text'));assert.ok(available.includes('editor_context_search'));assert.ok(available.includes('r_list_objects'));
      const actions=[['files_read_text',{path:'notes.txt',start_line:1,limit_lines:10}],['editor_context_search',{text:'analysis.R',after:null,limit:20}],['r_list_objects',{limit:20}]];
      const action=plan?plan.steps[plan.sent++]?.(body):actions[turn++];
      const delta=action?{tool_calls:[{index:0,id:'call-'+(plan?plan.sent:turn),type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:plan?.answer??'Read lilac-orbit-527, the synchronized analysis.R and the live preview_answer object.'};
      const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:'preview-context',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
      response.writeHead(200,{'content-type':'text/event-stream'});response.end(chunk(delta,null)+chunk({},action?'tool_calls':'stop')+'data: [DONE]\n\n');
    }catch(error){report.peer_error=error.message;save();response.writeHead(500);response.end('Model fixture assertion failed');}
  });await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));
  const credential=await api.port('control',{capability:key('agent.model.key.store'),arguments:{binding:await binding('agent','agent.model.key.store'),arguments:{request_id:randomUUID(),value:'disposable-preview-key'}}});
  const settings=(await pi('agent','agent.model.configure',{version:(await pq('agent','agent.model.settings',{})).version,enabled:true,connection:{protocol:'openai_completions',base_url:`http://127.0.0.1:${peer.address().port}/v1`,model:'preview-context-fixture',credential}})).output;
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const agentUI=await getFrame('Agent message');await agentUI.getByRole('button',{name:'New task',exact:true}).click();await agentUI.getByRole('button',{name:'Rho',exact:true}).click();
  await agentUI.getByLabel('Agent message',{exact:true}).fill('@');
  // fill does not emit the keydown that opens mentions; exercise actual keyboard input.
  await agentUI.getByLabel('Agent message',{exact:true}).fill('');await agentUI.getByLabel('Agent message',{exact:true}).press('@');
  await agentUI.getByRole('dialog',{name:'Choose context',exact:true}).waitFor();
  report.stages.push('Agent @ opens context picker in real browser');await page.screenshot({path:path.join(directory,'agent-mentions.png')});save();
  // Closing a picker never sends a model request. Source searches use live file/object owners.
  const fileSource=agentUI.locator('#context-source option').filter({hasText:'Project files'});await fileSource.waitFor({state:'attached'});
  await agentUI.getByLabel('Context source',{exact:true}).selectOption(await fileSource.getAttribute('value'));
  await agentUI.getByLabel('Search context',{exact:true}).fill('notes.txt');await agentUI.locator('#context-search-button').click();
  await agentUI.locator('#context-items button').filter({hasText:'notes.txt'}).first().click();
  await agentUI.locator('#context-inclusion').selectOption({label:'Text (up to 16 KiB)'});
  await agentUI.getByLabel('Context preview',{exact:true}).filter({hasText:'lilac-orbit-527'}).waitFor();
  await agentUI.getByRole('button',{name:'Add to draft',exact:true}).click();
  report.stages.push('@ discovers a previously unopened file, previews it and adds its exact reference to the message');save();
  for(const [sourceTitle,needle,previewText] of [['Workspace objects','preview_answer','42'],['Editor documents','analysis.R','42L']]){
    await agentUI.getByLabel('Agent message',{exact:true}).press('@');
    await agentUI.getByRole('dialog',{name:'Choose context',exact:true}).waitFor();
    const source=agentUI.locator('#context-source option').filter({hasText:sourceTitle});await source.waitFor({state:'attached'});
    await agentUI.getByLabel('Context source',{exact:true}).selectOption(await source.getAttribute('value'));
    await agentUI.getByLabel('Search context',{exact:true}).fill(needle);await agentUI.locator('#context-search-button').click();
    await agentUI.locator('#context-items button').filter({hasText:needle}).first().click();
    await agentUI.getByLabel('Context preview',{exact:true}).filter({hasText:previewText}).waitFor();
    await agentUI.getByRole('button',{name:'Add to draft',exact:true}).click();
  }
  report.stages.push('@ also captures a live R object and synchronized Editor text');save();
  await agentUI.getByLabel('Agent message',{exact:true}).fill('Inspect the project files, current editor and workspace objects.');
  await agentUI.getByRole('button',{name:'Send message',exact:true}).click();
  for(let i=0;i<600;i++){if(turn>=4)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(turn,4,report.peer_error??'Model did not use the workspace tools');
  assert.match(JSON.stringify(calls.at(-1).messages),/lilac-orbit-527/);assert.match(JSON.stringify(calls.at(-1).messages),/preview_answer/);
  report.stages.push('Actual Agent/Rig Send automatically reads Files, Editor and R objects');
  await agentUI.getByRole('button',{name:'Send message',exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:path.join(directory,'workspace-context.png')});
  await page.getByRole('tab',{name:'Editor',exact:true}).click();await page.reload();const reopened=await getFrame('Code Editor');assert.match(await reopened.getByLabel('Code Editor',{exact:true}).innerText(),/42L/);
  report.stages.push('Browser reload retains edited document and saved file');report.checks.push({name:'deterministic end-to-end',passed:true,model_calls:turn});
  if(options['--document-workflow']==='true') {
    await documentWorkflow({project,page,getFrame,pq,api,setPlan,report,save,directory});
    // An actual backend disconnect after native admission, not a fabricated
    // CommitPlan, must preserve the native child without another dispatch.
    const found=await pq('editor','editor.context.search',{window:api.window,text:'new-analysis.R',after:null,limit:20});
    const crashCode='workflow_crash <- 99L\nwriteLines("started", "crash.started")\nwhile (!file.exists("crash.release")) Sys.sleep(0.05)\ncat("one\\n", file="crash.effects", append=TRUE)\n';
    const captured=(await pi('editor','editor.edit',{reference:found.items[0].reference,code:crashCode})).output.reference;
    const running=pi('editor','editor.run',{reference:captured,runtime:instances.r,expected_session:session},1,'uncertain');
    const until=Date.now()+30000;
    while(!fs.existsSync(path.join(project,'crash.started'))){assert.ok(Date.now()<until,'Captured native run did not start');await new Promise(resolve=>setTimeout(resolve,50));}
    const instance=await query('plugins.instance',{instance:instances.editor});assert.ok(Number.isInteger(instance.process_id));
    process.kill(instance.process_id,'SIGKILL');fs.writeFileSync(path.join(project,'crash.release'),'release');
    const interrupted=await running;report.interrupted_run=interrupted;save();
    assert.equal(interrupted.recovery.kind,'plugin_boundary_failure');assert.equal(interrupted.recovery.candidate,null);
    const done=Date.now()+30000;let native;
    while(Date.now()<done){
      const history=await query('operation.list_recent',{limit:25,before_cursor:null});
      for(const summary of history.operations.filter(op=>op.capability.id==='r.execute')){
        const record=await api.port('get_operation',{operation_id:summary.operation_id});
        if(record.operation.causation_id===interrupted.operation.operation_id)native=record;
      }
      if(native?.status==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(native?.status,'succeeded');assert.equal(fs.readFileSync(path.join(project,'crash.effects'),'utf8'),'one\n');
    await browser.close();browser=null;
    host.kill('SIGINT');assert.equal((await deadline(exited,60000,'Original Host shutdown')).code,0);
    await startHost();
    const retained=await query('plugins.instance',{instance:instances.editor});
    assert.equal(retained.instance.state,'disconnected','A SIGKILLed Editor backend cannot be resumed as a confirmed Host suspension');
    assert.ok(retained.instance.suspension==null,'Disconnected instances must not retain a resume token');
    const parent=(await query('operation.get',{operation_id:interrupted.operation.operation_id})).record;
    const execution=(await query('operation.get',{operation_id:native.operation.operation_id})).record;
    assert.equal(parent.operation.operation_id,interrupted.operation.operation_id);
    assert.equal(parent.operation.capability.id,'editor.run');assert.equal(parent.status,'uncertain');
    assert.equal(execution.operation.operation_id,native.operation.operation_id);
    assert.equal(execution.operation.causation_id,interrupted.operation.operation_id);
    assert.equal(execution.operation.caller.id,instances.editor.instance);
    assert.equal(execution.operation.capability.id,'r.execute');
    assert.equal(execution.status,'succeeded');assert.equal(execution.operation.normalized_arguments.arguments.run.code,crashCode);
    assert.equal((await query('plugins.instance',{instance:instances.r})).instance.state,'suspended','Inspect cannot resume the old native R session');
    assert.equal(fs.readFileSync(path.join(project,'crash.effects'),'utf8'),'one\n');
    report.disconnect_recovery={editor_state:retained.instance.state,resume_token_retained:false,parent:parent.status,execution:native.operation.operation_id,native:execution.status,one_effect:true,r_suspended:true,r_resumed:false};
    report.stages.push('Actual Editor process disconnect → native completion → Host restart → retained parent/child operation inspection with one effect and no replay or R restart');save();
  }
  if(options['--live-agent-data']){
    // Read the explicitly selected existing connection locally. Key bytes only
    // enter this disposable instance's Control port, never an Operation/report.
    const data=path.resolve(options['--live-agent-data']);
    const settingsRows=JSON.parse(execFileSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps([json.loads(r[0]) for r in c.execute('select value from component_agent_settings')]))`,path.join(data,'agent-v1.sqlite')],{encoding:'utf8'}));
    assert.equal(settingsRows.length,1);const connection=settingsRows[0].connection;
    const keys=JSON.parse(fs.readFileSync(path.join(data,'model-credentials-v1.json')));
    const secret=keys.entries[connection.credential.key_id]?.key;assert.ok(secret,'Configured credential is unavailable');
    const liveCredential=await api.port('control',{capability:key('agent.model.key.store'),arguments:{binding:await binding('agent','agent.model.key.store'),arguments:{request_id:randomUUID(),value:secret}}});
    try{
      await pi('agent','agent.model.configure',{version:(await pq('agent','agent.model.settings',{})).version,enabled:true,connection:{...connection,credential:liveCredential}});
      report.live_model=connection.model;save();
      await page.getByRole('tab',{name:'Agent',exact:true}).click();const liveUI=await getFrame('Agent message');
      await liveUI.getByRole('button',{name:'New task',exact:true}).click();await liveUI.getByRole('button',{name:'Rho',exact:true}).click();
      await liveUI.getByRole('button',{name:'Tools',exact:true}).click();await liveUI.getByLabel('Read, edit and run in workspace',{exact:true}).check();await liveUI.getByRole('button',{name:'Tools',exact:true}).click();
      await liveUI.getByLabel('Agent message',{exact:true}).fill('Read notes.txt and the current open analysis.R editor through workspace tools. Tell me the sentinel in notes.txt. Then change preview_answer in the open Editor to 57L, save the document, and run that captured Editor document exactly once. Read the resulting R object and report its actual value. Use editor.edit, editor.save and editor.run for the document actions. Preserve the rest of the script.');
      await liveUI.getByRole('button',{name:'Send message',exact:true}).click();
      let run;const until=Date.now()+240000;
      while(Date.now()<until){
        const view=await query('views.inspect',{view:agent.view}),conversation=view.state.rho?.selected;
        if(conversation){const history=await pq('agent','agent.model.history',{conversation_id:conversation,before:null,limit:20});const recent=history.runs[0];if(recent){run=await pq('agent','agent.model.run.get',{run_id:recent.run_id});if(['completed','failed','interrupted','stopped'].includes(run.state))break;}}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      report.live_run=run;save();
      const receipts=run?await pq('agent','agent.model.run.tools',{run_id:run.run_id}):[];report.live_tools=receipts;save();
      assert.equal(run?.state,'completed',run?.reason??'Real model did not finish');
      for(const cap of ['files.read_text','editor.context.search','editor.edit','editor.save','editor.run'])assert.ok(receipts.some(r=>r.capability===cap&&r.phase==='resolved'),`Real model did not complete ${cap}`);
      assert.equal(receipts.filter(r=>r.capability==='editor.run').length,1,'Captured document must run once');
      assert.match(fs.readFileSync(path.join(project,'analysis.R'),'utf8'),/57L/);
      const observation=await pq('r','r.observe_object',{expected_session:session,name:'preview_answer'});
      assert.equal(observation.status,'ready');
      const values=await pq('r','r.read_object',{expected_session:session,object_ref:observation.data.object_ref,kind:'values',start:1,limit:1,column_limit:1});
      report.live_objects=values;assert.equal(values.status,'ready');assert.equal(values.data.values[0].number,57);
      let cursor=0,answer='';
      while(cursor<run.event_cursor){
        const events=await pq('agent','agent.model.run.events',{run_id:run.run_id,after:cursor,limit:100});assert.equal(events.history_gap,false);
        assert.ok(events.cursor>cursor,'Retained event cursor did not advance');cursor=events.cursor;
        answer+=events.events.filter(e=>e.content.kind==='text').map(e=>e.content.text).join('');
      }
      report.live_answer=answer;assert.match(answer,/lilac-orbit-527/);
      await page.screenshot({path:path.join(directory,'real-model-result.png')});
      report.stages.push('Real configured model reads files and Editor, edits/saves/runs once and observes 57 in R');report.checks.push({name:'real model end-to-end',passed:true,model:connection.model});
    }finally{const current=await pq('agent','agent.model.settings',{});await api.port('control',{capability:key('agent.model.key.remove'),arguments:{binding:await binding('agent','agent.model.key.remove'),arguments:{key_id:liveCredential.key_id,settings_version:current.version}}});}
  }
  report.completed=true;report.status='passed';save();console.log(JSON.stringify({status:report.status,report:options['--report'],directory,stages:report.stages}));
}catch(error){if(report.status!=='blocked')report.status='failed';report.error=error.stack;for(const context of browser?.contexts()??[])for(const page of context.pages())await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});save();throw error;}
finally{if(fs.existsSync(path.join(project,'crash.started')))fs.writeFileSync(path.join(project,'crash.release'),'release during cleanup');if(browser)await browser.close();if(peer)await new Promise(resolve=>peer.close(resolve));if(host&&host.exitCode===null){host.kill('SIGINT');const ended=await deadline(exited,60000,'Owned Host shutdown');report.shutdown=ended;save();assert.equal(ended.code,0);}}
