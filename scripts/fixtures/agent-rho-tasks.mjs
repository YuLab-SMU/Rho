import assert from 'node:assert/strict';

export async function testRhoTasks(RhoModel, NativeAgentModel, operationRequestId) {
  const clone=structuredClone, empty=()=>({text:'',assets:[],context:[]});
  function fixture() {
    let state={},version=0,lost='',gate=null,failSave=false,keyAvailable=true;
    const instance={instance:'agent',plugin:'org.rho.agent',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
    const settings={version:1,enabled:true,connection:{model:'fixture',protocol:'openai_completions',base_url:'https://fixture.invalid',credential:{kind:'local_file',key_id:'fixture'}}};
    const conversations=new Map(),runs=new Map(),events=new Map(),records=[],calls=[],reads=[];
    const overrides=new Map();
    const client={
      get view(){return {view:'view-one',window:'window-one',project:'project',instance,state:clone(state),state_version:version};},
      async setState(value){if(failSave)throw Error('State save failed');state=clone(value);version++;return this.view;},
      async query(cap,args){
        reads.push({id:cap.id,args:clone(args)});const input=args.arguments;let data;
        if(overrides.has(cap.id))data=await overrides.get(cap.id)(input);
        else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
        else if(cap.id==='agent.model.settings')data=settings;
        else if(cap.id==='agent.model.key.status'){assert.equal(input.settings_version,settings.version);data={credential:settings.connection.credential,available:keyAvailable};}
        else if(cap.id==='agent.model.conversation')data=conversations.get(input.conversation_id);
        else if(cap.id==='agent.model.run.get')data=runs.get(input.run_id);
        else if(cap.id==='agent.model.run.admission')data={binding:{provider:instance,project:'project',capability:{id:'agent.model.run',version:1},target:null},r:runs.get(input.run_id).request.r??null};
        else if(cap.id==='agent.model.run.request')data=[...runs.values()].find(r=>r.request.request_id===input.request_id);
        else if(cap.id==='agent.model.history'){
          const rows=[...runs.values()].filter(r=>r.request.conversation_id===input.conversation_id).reverse();
          const start=input.before?rows.findIndex(r=>r.run_id===input.before)+1:0, page=rows.slice(start,start+input.limit);
          data={conversation_id:input.conversation_id,runs:page.map(r=>({run_id:r.run_id,request_id:r.request.request_id,conversation_id:r.request.conversation_id,state:r.state,text_excerpt:r.request.text})),next:start+input.limit<rows.length?page.at(-1).run_id:null};
        }else if(cap.id==='agent.model.run.events')data={events:(events.get(input.run_id)??[]).filter(e=>e.sequence>input.after).slice(0,input.limit),cursor:runs.get(input.run_id).event_cursor,history_gap:false};
        else throw Error('Unexpected query '+cap.id);
        return {status:'ready',completeness:'complete',data:clone(data)};
      },
      async invoke(cap,args,options){
        const pending=state.rho.pending.find(p=>p.intent.request===options.requestId);assert.ok(pending,'Original intent must be saved before invocation');assert.deepEqual(pending.intent.arguments,args);
        calls.push(clone({cap,args,options}));const scoped=await operationRequestId('view-one',options.requestId);let record=records.find(r=>r.operation.client_request_id===scoped);
        if(!record){
          const input=args.arguments,kind=cap.id.slice('agent.model.'.length);let output,error=null,status='succeeded',conversation=conversations.get(input.conversation_id);
          if(kind==='create'){
            conversation={conversation_id:input.conversation_id,title:'New task',archived:false,profile:input.profile,version:1,draft_version:1,draft:'',draft_content:empty(),controller:{window_id:'window-one',incarnation:'view:view-one'},active_run_id:null};
            conversations.set(conversation.conversation_id,conversation);output=clone(conversation);
          }else if(kind==='draft'){
            if(input.draft_version!==conversation.draft_version)error='Draft conflict';
            else{conversation.draft_content=clone(input.content);conversation.draft=input.content.text;conversation.draft_version++;conversation.version++;output=clone(conversation);}
          }else if(kind==='update'||kind==='take_control'){
            if(input.expected_version!==conversation.version)error='Version conflict';
            else{conversation.version++;if(kind==='take_control'){conversation.controller={window_id:'window-one',incarnation:'view:view-one'};conversation.active_run_id=null;}else{if(input.title!==undefined)conversation.title=input.title.trim();if(input.archived!==undefined)conversation.archived=input.archived;}output=clone(conversation);}
          }else if(kind==='run'){
            assert.equal(input.conversation_version,conversation.version);assert.equal(input.text,conversation.draft_content.text);assert.deepEqual(input.sources,conversation.draft_content.context);
            const run={run_id:'run-'+runs.size,request:{...clone(input),grant:{mode:input.mode??'explain',session:null,files:[],documents:[]},window:clone(conversation.controller)},state:'running',updated_at_ms:runs.size+1,event_cursor:0,reason:null};runs.set(run.run_id,run);
            conversation.draft_content=empty();conversation.draft='';conversation.draft_version++;conversation.version++;conversation.active_run_id=run.run_id;status='running';output=null;
          }else if(kind==='run.stop'){
            const run=runs.get(input.run_id);run.state='stopping';run.updated_at_ms++;output=clone(run);
          }else if(kind==='run.reconcile'){
            const run=runs.get(input.run_id),task=conversations.get(run.request.conversation_id);
            assert.equal(input.conversation_version,task.version);assert.equal(task.active_run_id,null);
            run.recovery={version:1,digest:'retained-report',checked_at_ms:1,unresolved_mutations:0,tools:[]};run.updated_at_ms++;task.version++;output=clone(run);
          }else throw Error('Unexpected Operation '+kind);
          if(error)status='failed';record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:'view-one'},client_request_id:scoped,capability:clone(cap),normalized_arguments:clone(args),preconditions:[]},status,outcome:status==='running'?null:status,output,error};records.push(record);
        }
        if(lost===cap.id){lost='';throw Error('Lost original reply');}
        if(gate){const wait=gate;gate=null;await wait;}return clone(record);
      },
      async operation(id){return clone(records.find(r=>r.operation.operation_id===id));},
    };
    return {client,conversations,runs,records,calls,reads,overrides,
      open(){const native=new NativeAgentModel(client);return {native,model:new RhoModel(client,native)};},
      lose(id){lost=id;},hold(wait){gate=wait;},failSave(value){failSave=value;},missingKey(){keyAvailable=false;},
      finish(id,text='Answer 中文 Ω'){
        const run=runs.get(id);run.state='completed';run.updated_at_ms++;run.event_cursor=1;events.set(id,[{run_id:id,sequence:1,content:{kind:'text',text}}]);
        const conversation=conversations.get(run.request.conversation_id);conversation.active_run_id=null;conversation.version++;
        const record=records.find(r=>r.operation.capability.id==='agent.model.run'&&r.operation.normalized_arguments.arguments.request_id===run.request.request_id);record.status='succeeded';record.outcome='succeeded';record.output=clone(run);
      },
    };
  }
  let count=0;async function check(name,fn){try{await fn();count++;}catch(error){throw Error(name,{cause:error});}}
  async function task(f){const opened=f.open();await opened.model.create();const id=opened.model.state.selected;await opened.model.observe(id);return {...opened,id};}
  async function draft(model,id,text='Send exactly this draft'){model.edit(id,{...empty(),text});await model.flush(id);}
  await check('create and observation use one shared view writer without model work',async()=>{
    const f=fixture(),{model,native,id}=await task(f);assert.equal(model.canControl(id),true);assert.equal(native.state.selected,null);assert.equal(f.calls.length,1);
    await model.observe(id);assert.equal(f.calls.length,1);await draft(model,id);assert.equal(f.open().model.state.drafts[id].content.text,'Send exactly this draft');
  });
  await check('lost creation remains selected and recoverable after a true reopen',async()=>{
    const f=fixture();let {model}=f.open();f.lose('agent.model.create');await assert.rejects(model.create(),/Lost original reply/);
    const id=model.state.selected,request=model.state.pending[0].intent.request;assert.ok(id);
    model=f.open().model;await model.refresh();assert.equal(model.state.selected,id);assert.equal(f.calls.length,1);
    await assert.rejects(model.create(),/original task creation/);await model.inspect(request);await model.observe(id);
    assert.equal(model.canControl(id),true);assert.equal(f.calls.length,1);
  });
  await check('accepted Operation is retained before its Agent run exists',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);const invoke=f.client.invoke;
    f.client.invoke=async(...args)=>{const record=await invoke(...args);if(args[0].id==='agent.model.run'){const saved=f.records.at(-1);saved.status='accepted';record.status='accepted';}return record;};
    f.overrides.set('agent.model.run.request',()=>{throw Error('Run not admitted yet');});
    await model.send(id);assert.equal(model.state.pending[0].status,'accepted');assert.ok(f.open().model.state.pending[0].intent.operation);
    assert.equal(model.draft(id).text,'Send exactly this draft');f.overrides.delete('agent.model.run.request');
    f.records.at(-1).status='running';await model.inspect(model.state.pending[0].intent.request);
    assert.equal(model.draft(id).text,'');assert.equal(f.runs.size,1);
  });
  await check('an original Send consumes only its draft and retains next input through reload',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);let release;f.hold(new Promise(resolve=>release=resolve));
    const sent=model.send(id);while(!f.runs.size)await new Promise(resolve=>setTimeout(resolve,0));
    model.edit(id,{...empty(),text:'Keep this next input'});release();await sent;await model.observe(id);
    assert.equal(model.draft(id).text,'Keep this next input');assert.equal(model.state.drafts[id].conflict,null);await model.flush(id);
    const reopened=f.open().model;await reopened.observe(id);assert.equal(reopened.draft(id).text,'Keep this next input');assert.equal(f.runs.size,1);
    f.finish('run-0');await reopened.refresh();assert.equal(reopened.transcripts.get('run-0').text,'Answer 中文 Ω');assert.equal(f.runs.size,1);
  });
  await check('lost Send reply is inspected as one original; reload dispatches no work',async()=>{
    const f=fixture();let {model,id}=await task(f);await draft(model,id);f.lose('agent.model.run');await assert.rejects(model.send(id),/Lost original reply/);
    const request=model.state.pending[0].intent.request,before=f.calls.length;model=f.open().model;await model.refresh();assert.equal(f.calls.length,before);
    await model.inspect(request);assert.equal(f.runs.size,1);assert.equal(f.calls.length,before);assert.equal(model.state.drafts[id].content.text,'');
    assert.equal(model.state.pending[0].intent.request,request);assert.equal(model.state.pending[0].status,'running');
  });
  await check('lost tool inspection is recovered as its original request without sending a model turn',async()=>{
    const f=fixture();let {model,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();
    await draft(model,id,'Keep the next input');f.lose('agent.model.run.reconcile');await assert.rejects(model.reconcile(id,'run-0'),/Lost original reply/);
    const pending=model.state.pending.find(p=>p.kind==='run.reconcile'),before=f.calls.length;assert.ok(pending);
    model=f.open().model;await model.refresh();await model.inspect(pending.intent.request);
    assert.equal(f.calls.length,before);assert.equal(f.calls.filter(c=>c.cap.id==='agent.model.run').length,1);
    assert.equal(model.runs.get('run-0').recovery.digest,'retained-report');assert.equal(model.draft(id).text,'Keep the next input');assert.equal(model.state.pending.length,0);
  });
  await check('tool inspection refuses an active run or a run from another task',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);await model.send(id);const before=f.calls.length;
    await assert.rejects(model.reconcile(id,'run-0'),/finished run/);f.finish('run-0');await model.refresh();
    await assert.rejects(model.reconcile('another-task','run-0'),/finished run/);assert.equal(f.calls.length,before);
  });
  await check('Continue captures the checked run and lost replies never turn into fresh sends',async()=>{
    const f=fixture();let {model,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();await model.reconcile(id,'run-0');
    await draft(model,id,'Continue from that result Ω');f.lose('agent.model.run');await assert.rejects(model.send(id,'run-0'),/Lost original reply/);
    const args=f.calls.at(-1).args.arguments;assert.deepEqual(args.continuation,{run_id:'run-0',recovery_digest:'retained-report'});assert.equal(args.mode,'explain');assert.equal(args.r,null);
    const before=f.calls.length;model=f.open().model;await model.refresh();await model.inspect(model.state.pending[0].intent.request);
    assert.equal(f.calls.length,before);assert.equal(f.runs.size,2);assert.equal(model.runs.get('run-1').request.continuation.run_id,'run-0');
  });
  await check('Continue refuses unresolved recovery or a substituted original provider and preserves the draft',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();await model.reconcile(id,'run-0');await draft(model,id,'Keep my input');
    const before=f.calls.length;f.runs.get('run-0').recovery.unresolved_mutations=1;await assert.rejects(model.send(id,'run-0'),/original tool outcomes/);
    f.runs.get('run-0').recovery.unresolved_mutations=0;f.overrides.set('agent.model.run.admission',()=>({binding:{provider:{instance:'other'}},r:null}));
    await assert.rejects(model.send(id,'run-0'),/different native admission/);assert.equal(f.calls.length,before);assert.equal(model.draft(id).text,'Keep my input');
  });
  await check('next draft waits for original consumption after a lost Continue reply',async()=>{
    const f=fixture();let {model,native,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();await model.reconcile(id,'run-0');
    await draft(model,id,'Continue');f.lose('agent.model.run');await assert.rejects(model.send(id,'run-0'),/Lost original reply/);
    model.edit(id,{...empty(),text:'Immediate next input'});await native.save();const before=f.calls.length;
    assert.equal(model.draftAwaitingRun(id),true);await assert.rejects(model.flush(id),/Inspect the original Send/);assert.equal(f.calls.length,before);
    model=f.open().model;await model.refresh();assert.equal(model.draftAwaitingRun(id),false);await model.flush(id);
    assert.equal(model.draft(id).text,'Immediate next input');assert.equal(f.conversations.get(id).draft,'Immediate next input');assert.equal(f.runs.size,2);
  });
  await check('typing during Continue admission reads retains the newer draft without dispatch',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();await model.reconcile(id,'run-0');await draft(model,id,'Continue');
    const before=f.calls.length;
    f.overrides.set('agent.model.run.admission',async()=>{
      await model.observe(id);model.edit(id,{...empty(),text:'Newer input'});
      return {binding:{provider:f.client.view.instance,project:'project',capability:{id:'agent.model.run',version:1},target:null},r:null};
    });
    await assert.rejects(model.send(id,'run-0'),/draft changed while preparing Continue/);
    assert.equal(f.calls.length,before);assert.equal(model.draft(id).text,'Newer input');
  });
  await check('Continue keeps the exact original native R target',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);await model.send(id);f.finish('run-0');await model.refresh();await model.reconcile(id,'run-0');await draft(model,id,'Continue R');
    const binding={provider:{instance:'r',plugin:'org.rho.r',revision:'sha256:'+'c'.repeat(64),artifact:'sha256:'+'d'.repeat(64)},project:'project',capability:{id:'r.execute',version:2},target:'original-session'};
    f.runs.get('run-0').request.grant.mode='run';f.runs.get('run-0').request.r=clone(binding);
    await model.send(id,'run-0');assert.deepEqual(f.calls.at(-1).args.arguments.r,binding);assert.equal(f.calls.at(-1).args.arguments.mode,'run');
  });
  await check('identical retry recovers one run and a forged result never clears the draft',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);f.lose('agent.model.run');await assert.rejects(model.send(id));
    const request=model.state.pending[0].intent.request;await model.retry(request);assert.equal(f.runs.size,1);assert.equal(f.calls.at(-1).options.requestId,request);
    const g=fixture(),other=await task(g);await draft(other.model,other.id);g.lose('agent.model.run');await assert.rejects(other.model.send(other.id));
    g.overrides.set('agent.model.run.request',()=>({...g.runs.get('run-0'),request:{...g.runs.get('run-0').request,request_id:'foreign'}}));
    await assert.rejects(other.model.inspect(other.model.state.pending[0].intent.request),/another original Send/);assert.equal(other.model.draft(other.id).text,'Send exactly this draft');
  });
  await check('unconfirmed view persistence prevents all new model dispatch',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);const before=f.calls.length;f.failSave(true);await assert.rejects(model.send(id),/State save failed/);assert.equal(f.calls.length,before);assert.equal(f.runs.size,0);
  });
  await check('context belongs to the original Send and later reference edits survive its receipt',async()=>{
    const f=fixture(),{model,id}=await task(f),source={source:'plugin',label:'Selected document',reference:{version:7},inclusion:'{"kind":"selection"}'};
    model.edit(id,{...empty(),text:'Explain context',context:[source]});await model.flush(id);
    let release;f.hold(new Promise(resolve=>release=resolve));const sent=model.send(id);
    while(!f.runs.size)await new Promise(resolve=>setTimeout(resolve,0));
    const later={...source,reference:{version:8}};model.edit(id,{...empty(),text:'Explain context',context:[later]});release();await sent;
    assert.deepEqual(f.runs.get('run-0').request.sources,[source]);assert.deepEqual(model.draft(id).context,[later]);await model.flush(id);
    const reopened=f.open().model;await reopened.observe(id);assert.deepEqual(reopened.draft(id).context,[later]);assert.equal(f.runs.size,1);
  });
  await check('a different captured selection cannot acknowledge the original Rho Send',async()=>{
    const f=fixture(),{model,id}=await task(f),source={source:'plugin',label:'Source',reference:{version:7},inclusion:'{"kind":"document"}'};
    model.edit(id,{...empty(),text:'Explain context',context:[source]});await model.flush(id);
    f.overrides.set('agent.model.run.request',()=>({...f.runs.get('run-0'),request:{...f.runs.get('run-0').request,sources:[{...source,reference:{version:8}}]}}));
    await assert.rejects(model.send(id),/original Send/);assert.deepEqual(model.draft(id).context,[source]);assert.equal(model.state.pending[0].consumed,false);
  });
  await check('over-limit Rho context preserves the complete local draft without dispatch',async()=>{
    const f=fixture(),{model,id}=await task(f);model.edit(id,{...empty(),text:'Explain',context:Array.from({length:17},(_,version)=>({source:'plugin',label:'Source',reference:{version},inclusion:'{}'}))});
    const before=f.calls.length;await assert.rejects(model.send(id),/16 context/);assert.equal(f.calls.length,before);assert.equal(model.draft(id).context.length,17);
  });
  await check('missing model key and unsupported selected sources preserve the draft',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);f.missingKey();await assert.rejects(model.send(id),/key is unavailable/);assert.equal(model.draft(id).text,'Send exactly this draft');assert.equal(f.runs.size,0);
    model.edit(id,{...empty(),text:'Retain selected input',assets:['not-yet-composed']});await assert.rejects(model.send(id),/sources/);assert.equal(model.draft(id).assets.length,1);
  });
  await check('conflicting draft stays local until explicit resolution',async()=>{
    const f=fixture(),{model,id}=await task(f);model.edit(id,{...empty(),text:'Local'});const remote=f.conversations.get(id);remote.draft_content={...empty(),text:'Other view'};remote.draft_version++;remote.version++;
    await model.observe(id);assert.equal(model.draft(id).text,'Local');assert.equal(model.state.drafts[id].conflict.text,'Other view');await model.resolveDraft(id,true);await model.flush(id);assert.equal(f.conversations.get(id).draft,'Local');
  });
  await check('a late draft receipt cannot erase a newer conflict',async()=>{
    const f=fixture(),{model,id}=await task(f);model.edit(id,{...empty(),text:'Original save'});let release;
    f.hold(new Promise(resolve=>release=resolve));const saving=model.flush(id);
    while(f.records.length<2)await new Promise(resolve=>setTimeout(resolve,0));
    model.edit(id,{...empty(),text:'Later local typing'});const remote=f.conversations.get(id);
    remote.draft_content={...empty(),text:'Other controller'};remote.draft_version++;remote.version++;
    await model.observe(id);release();await saving;
    assert.equal(model.draft(id).text,'Later local typing');assert.equal(model.state.drafts[id].conflict.text,'Other controller');
    await assert.rejects(model.flush(id),/conflict/);await model.resolveDraft(id,true);await model.flush(id);
    assert.equal(f.conversations.get(id).draft,'Later local typing');
  });
  await check('cross-view control, archive and Stop follow original owner state',async()=>{
    const f=fixture(),{model,id}=await task(f);f.conversations.get(id).controller.incarnation='view:other';f.conversations.get(id).version++;await model.observe(id);
    assert.throws(()=>model.edit(id,{...empty(),text:'Unauthorized'}),/read-only/);await model.takeOver(id);await model.archive(id,true);assert.throws(()=>model.edit(id,empty()),/read-only/);
    await model.archive(id,false);await draft(model,id);await model.send(id);await model.observe(id);await model.stop(id);assert.equal(model.runs.get('run-0').state,'stopping');assert.equal(f.records.find(r=>r.operation.capability.id==='agent.model.run').status,'running');
  });
  await check('history paging remains selected through refresh and refuses foreign cursors',async()=>{
    const f=fixture(),{model,id}=await task(f);for(let i=0;i<7;i++){await draft(model,id,'Turn '+i);await model.send(id);f.finish('run-'+i);await model.refresh();}
    assert.equal(model.history.get(id).page.runs.length,5);await model.earlier(id);assert.equal(model.history.get(id).page.runs[0].run_id,'run-1');await model.refresh();assert.equal(model.history.get(id).page.runs[0].run_id,'run-1');
    await model.latest(id);assert.equal(model.history.get(id).page.runs[0].run_id,'run-6');
    let release;f.overrides.set('agent.model.history',()=>new Promise(resolve=>release=resolve));
    const polling=model.observe(id);while(!release)await new Promise(resolve=>setTimeout(resolve,0));
    const oldPage=clone(model.history.get(id).page);await model.earlier(id);release(oldPage);await polling;f.overrides.delete('agent.model.history');
    await model.refresh();assert.equal(model.history.get(id).page.runs[0].run_id,'run-1');const before=f.calls.length;
    f.overrides.set('agent.model.history',()=>({conversation_id:'foreign',runs:[],next:null}));await assert.rejects(model.observe(id),/history page/);assert.equal(f.calls.length,before);
  });
  await check('foreign retained requests are refused before any query or dispatch',async()=>{
    const f=fixture(),{model,id}=await task(f);await draft(model,id);f.lose('agent.model.run');await assert.rejects(model.send(id));const saved=f.client.view.state;saved.rho.pending[0].intent.arguments.binding.provider.instance='other';await f.client.setState(saved);
    assert.throws(()=>f.open(),/another task, view or instance/);
  });
  console.log(`Ordinary Rho task model: ${count} checks passed; task control, original Send, next drafts, history paging and explicit recovery. Native acceptance remains separate.`);
}
