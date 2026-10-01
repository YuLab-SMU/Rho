import assert from 'node:assert/strict';
export async function testStudioAgent(module, operationRequestId, ViewRequestError) {
  const {AgentAssistance} = await module('agent'), clone = structuredClone;
  const revision='sha256:'+'a'.repeat(64),artifact='sha256:'+'b'.repeat(64);
  const branch={id:'chosen-branch',plugin:'example.panel',name:'panel 中文 Ω',head:revision,origin:revision};
  const identity={instance:'agent',plugin:'org.rho.agent',revision,artifact};
  const active={instance:{identity,project:'project',principal:'user',state:'active',alias:'Agent',purpose:'runtime'},observed_in_this_host:true};
  let saved=null, records=[], calls=[], fault=null, head=revision, observed=clone(active), current=true, saveFailed=false;
  const client={view:{view:'studio',window:'window',project:'project',principal:'user'},
    operation:async id=>clone(records.find(r=>r.operation.operation_id===id)),
    query:async(cap,args)=>{
      let data;
      if(cap.id==='plugins.branch_head')data={revision:head};
      else if(cap.id==='plugins.instance')data=observed;
      else if(cap.id==='plugins.instances')data={instances:[observed,{...active,instance:{...active.instance,identity:{...identity,instance:'preview'},purpose:'fixture_preview'}}],next:null,total:2};
      else if(cap.id==='plugins.inspect')data={summary:{revision,plugin:'org.rho.agent'},manifest:{views:[{id:'agent',configuration_schema:{properties:current?{studio_request:{}}:{}}}]}};
      else if(cap.id==='windows.layout')data={project:'project',principal:'user',window:'window',version:4,layout:{kind:'tabs',id:'group',views:['studio'],selected:'studio'}};
      else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
      else if(cap.id==='operation.get')data={record:records.find(r=>r.operation.operation_id===args.operation_id)};
      else throw Error(cap.id);
      return {status:'ready',completeness:'complete',data:clone(data)};
    },
    invoke:async(cap,args,options)=>{
      assert.equal(saved.pending.request,options.requestId);assert.equal(cap.id,'windows.open_view');calls.push(clone({cap,args}));
      if(fault==='reject')throw new ViewRequestError('Layout changed',{code:'content_changed'});
      const request=await operationRequestId(client.view.view,options.requestId);let record=records.find(r=>r.operation.client_request_id===request);
      if(!record){record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:clone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',error:null,
        output:{view:{...clone(args.view),view:'agent-view',project:'project',principal:'user',closed:false,state_version:0},layout:{version:5}}};records.push(record);}
      if(fault==='lost')throw Error('Lost view reply');
      return clone(record);
    }};
  const open=()=>{let agent;agent=new AgentAssistance(client,async()=>{if(saveFailed)throw Error('Draft save failed');saved=clone(agent.data);},()=>{});return agent;};
  let agent=open();await agent.prepare(branch);assert.equal(calls.length,0);assert.equal(agent.candidates.length,1,'preview instances excluded');
  agent.data.input.instance=identity;agent.data.input.goal='Please edit 中文 Ω';
  head='sha256:'+'c'.repeat(64);await assert.rejects(agent.open(),/branch changed/);assert.equal(calls.length,0);head=revision;
  current=false;await assert.rejects(agent.open(),/does not accept/);current=true;
  for(const change of [{observed_in_this_host:false},{instance:{...active.instance,state:'suspended'}},{instance:{...active.instance,principal:'other'}},{instance:{...active.instance,project:'other'}}]) {
    observed={...clone(active),...change};await assert.rejects(agent.open(),/unavailable/);assert.equal(calls.length,0);
  }observed=clone(active);
  saveFailed=true;await assert.rejects(agent.open(),/Draft save failed/);assert.equal(calls.length,0);saveFailed=false;
  fault='lost';await assert.rejects(agent.dispatch(),/Lost view reply/);assert.equal(records.length,1);
  const args=calls[0].args;assert.equal(args.expected_layout_version,4);assert.equal(args.group,'group');
  const config=args.view.configuration;assert.match(config.studio_request.text,/Please edit 中文 Ω/);
  assert.deepEqual(config.tools.filter(t=>t.target.capability.id==='plugins.checkpoint').map(t=>t.target.fixed_arguments),[{branch:branch.id,expected_head:revision}]);
  assert.ok(config.tools.every(t=>/^[a-z_]+$/.test(t.name)));
  assert.ok(config.tools.every(t=>!['plugins.build','plugins.activate','scenarios.apply'].includes(t.target.capability.id)));
  agent=open();agent.restore(saved);assert.equal(calls.length,1,'reopen cannot replay');client.view.view='replacement';await assert.rejects(agent.dispatch(),/original Studio view/);
  await agent.recover();assert.equal(calls.length,1);assert.equal(agent.data.opened.view,'agent-view');assert.equal(agent.data.pending,null);
  client.view.view='studio';await agent.prepare(branch);agent.data.input.instance=identity;agent.data.input.goal='next';fault='reject';await assert.rejects(agent.open(),/Layout changed/);assert.equal(agent.data.pending,null);
  fault='lost';await assert.rejects(agent.open(),/Lost view reply/);records.at(-1).output.view.instance.instance='foreign';
  await assert.rejects(agent.recover(),/differs/);assert.ok(agent.data.pending);
  console.log('Studio Agent: exact branch/checkpoint capture, current runtime selection, old-revision refusal, acknowledged intents, lost/rejected view replies and replacement-view recovery passed. No Host acceptance claimed.');
}
