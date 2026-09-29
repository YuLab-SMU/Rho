import assert from 'node:assert/strict';
import fs from 'node:fs';
export async function testContextPicker(ContextPicker, inclusionChoices, root) {
  const manifest = JSON.parse(fs.readFileSync(root + '/plugins/editor/plugin.json', 'utf8'));
  const identity = {instance:'source',plugin:manifest.id,revision:'sha256:'+'c'.repeat(64),artifact:'sha256:'+'d'.repeat(64)};
  const reference = {provider:identity,contribution:'documents',window:'window',selector:{draft:'draft-one',version:7,digest:'sha256:'+'e'.repeat(64)}};
  const item = {reference,title:'分析 Ω.R',description:'Synchronized version 7',kind:'document'};
  function fixture() {
    const queries=[];
    let instancePage={instances:[{identity,project:'project',state:'active',alias:'Editor'}],next:null,total:1};
    let inspected={summary:{revision:identity.revision},manifest,artifacts:[{id:identity.artifact}]};
    let page={items:[structuredClone(item)],notices:[],next:null};
    let preview={item:structuredClone(item),text:'selected_value <- 42 # 中文 Ω',data:{version:7},truncated:false,resources:[]};
    let complete='complete', gate=null;
    const original={request_id:'original-send',task_id:'task-one',contexts:[{selection:{source:'plugin',label:'Saved',reference:structuredClone(reference),inclusion:'{"kind":"selection"}'},title:'Original',description:'At Send',text:'original <- 7',data:{version:7}}]};
    const rho={run_id:'rho-original',request:{conversation_id:'rho-task',sources:[]},context:{sources:[],history:{kind:'conversation',truncated:false,notice:'Saved input',turns:[{run_id:'earlier',state:'completed',user_text:'Earlier question 中文',assistant_text:'Earlier answer Ω',history_gap:false,text_truncated:false,references:[],references_truncated:false}]}}};
    const client={view:{project:'project',window:'window',instance:{instance:'agent'}},async query(cap,args){
      queries.push(structuredClone({cap,args}));
      if(cap.id==='agent.native.context'){ assert.equal(args.binding.provider.instance,'agent'); return {status:'ready',completeness:'complete',data:structuredClone(original)}; }
      if(cap.id==='agent.model.run.get'){ assert.equal(args.binding.provider.instance,'agent'); return {status:'ready',completeness:'complete',data:structuredClone(rho)}; }
      if(cap.id==='plugins.instances') { const result=structuredClone(instancePage); if(gate){const wait=gate;gate=null;await wait;}return{status:'ready',completeness:'complete',data:result}; }
      if(cap.id==='plugins.inspect') return{status:'ready',completeness:'complete',data:structuredClone(inspected)};
      assert.deepEqual(args.binding,{project:'project',provider:identity,capability:cap,target:null});assert.equal(args.preconditions,null);
      const data=cap.id.endsWith('search')?page:preview;
      return {status:'ready',completeness:complete,data:structuredClone(data)};
    }};
    return {picker:new ContextPicker(client),queries,client,page,preview,inspected,instancePage,original,rho,completeness:v=>complete=v,wait:p=>gate=p};
  }
  let count=0; async function check(name,fn){try{await fn();count++;}catch(error){throw Error(name,{cause:error});}}
  await check('declared choices come from the actual Editor manifest',async()=>{
    const choices=inclusionChoices(manifest.capabilities.find(c=>c.capability.id==='editor.context.preview').input_schema);
    assert.deepEqual(choices.map(c=>c.value),[{kind:'document'},{kind:'selection'}]);assert.equal(inclusionChoices({properties:{inclusion:{}}}).length,0);
  });
  await check('discovery and preview keep exact owner identity and never mutate or acquire tools',async()=>{
    const f=fixture();await f.picker.discover();const source=f.picker.sources[0];await f.picker.search(source,'分析');
    const preview=await f.picker.preview(source,reference,{kind:'selection'});const selected=f.picker.selection(source,preview,{kind:'selection'});
    assert.deepEqual(selected.reference,reference);assert.equal(selected.inclusion,'{"kind":"selection"}');assert.match(selected.label,/Editor.*分析 Ω/);
    assert.equal(f.queries.at(-1).args.arguments.max_bytes,16384);assert.equal(f.queries[0].args.include_previews,false);
  });
  await check('inactive, preview and different-project instances are not queried or resumed',async()=>{
    const f=fixture();f.instancePage.instances.push(...['suspended','failed','disconnected'].map(state=>({identity,project:'project',state,alias:state})),{identity,project:'other',state:'active'},{identity,project:'project',state:'active',purpose:'fixture_preview'});
    await f.picker.discover();assert.equal(f.picker.sources.length,1);assert.equal(f.queries.filter(q=>q.cap.id==='plugins.inspect').length,1);
  });
  await check('partial searches retain notices but partial previews cannot be selected',async()=>{
    const f=fixture();await f.picker.discover();f.completeness('partial');assert.match((await f.picker.search(f.picker.sources[0],'')).notices.join(),/Partial/);
    await assert.rejects(f.picker.preview(f.picker.sources[0],reference,{kind:'selection'}),/fully available/);
  });
  await check('changed references, oversized UTF8 and unsupported resources preserve the caller draft',async()=>{
    for(const fault of ['version','size','resources','truncated']){
      const f=fixture();await f.picker.discover();const source=f.picker.sources[0];
      if(fault==='version')f.preview.item.reference.selector.version=8;
      if(fault==='size')f.preview.text='中'.repeat(6000);
      if(fault==='resources')f.preview.resources=[{}];
      if(fault==='truncated')f.preview.truncated=true;
      if(['version','size'].includes(fault))await assert.rejects(f.picker.preview(source,reference,{kind:'selection'}),/differs/);
      else assert.throws(()=>f.picker.selection(source,f.preview,{kind:'selection'}),/complete text/);
    }
  });
  await check('saved contexts retain their original window and declared inclusion',async()=>{
    const f=fixture();await f.picker.discover();const old=structuredClone(reference);old.window='original-window';f.preview.item.reference=old;
    const retained=await f.picker.retained({source:'plugin',label:'Saved',reference:old,inclusion:'{"kind":"selection"}'});
    assert.equal(retained.preview.item.reference.window,'original-window');assert.equal(f.queries.at(-1).args.arguments.reference.window,'original-window');
    await assert.rejects(f.picker.retained({source:'plugin',label:'Saved',reference:old,inclusion:'{"kind":"invented"}'}),/not declared/);
  });
  await check('different version or artifact never supplies a usable source',async()=>{
    const f=fixture();f.inspected.artifacts=[];await f.picker.discover();assert.equal(f.picker.sources.length,0);assert.match(f.picker.notices[0],/version/);
  });
  await check('repeated discovery cursor is refused',async()=>{
    const f=fixture();f.instancePage.next='source';await f.picker.discover();await assert.rejects(f.picker.discover(true),/next page/);
  });
  await check('late discovery cannot overwrite a new picker observation',async()=>{
    const f=fixture();let done;f.wait(new Promise(resolve=>done=resolve));const first=f.picker.discover();f.instancePage.instances=[];await f.picker.discover();done();await first;assert.equal(f.picker.sources.length,0);
  });
  await check('original sent context reads only its Agent record and rejects another message',async()=>{
    const f=fixture();const captures=await f.picker.original('task-one','original-send');assert.equal(captures[0].text,'original <- 7');
    assert.deepEqual(f.queries.map(q=>q.cap.id),['agent.native.context']);f.original.request_id='another-send';
    await assert.rejects(f.picker.original('task-one','original-send'),/original message/);
  });
  await check('original Rho history reads only retained input, including partial flags',async()=>{
    const f=fixture();f.rho.context.history.turns[0].history_gap=true;f.rho.context.history.truncated=true;
    const captured=await f.picker.originalRho('rho-task','rho-original');assert.deepEqual(captured.sources,[]);assert.equal(captured.history.turns[0].assistant_text,'Earlier answer Ω');assert.equal(captured.history.truncated,true);assert.equal(captured.history.turns[0].history_gap,true);
    assert.deepEqual(f.queries.map(q=>q.cap.id),['agent.model.run.get']);
    f.rho.request.conversation_id='another-task';await assert.rejects(f.picker.originalRho('rho-task','rho-original'),/original Rho message/);
  });
  await check('malformed or oversized Rho history is never rendered as complete input',async()=>{
    for(const fault of ['kind','turns','unicode','missing-flag','budget']){
      const f=fixture(),history=f.rho.context.history;
      if(fault==='kind')history.kind='invented';
      if(fault==='turns')history.turns=Array(9).fill(history.turns[0]);
      if(fault==='unicode')history.turns[0].assistant_text='中'.repeat(1400);
      if(fault==='missing-flag')delete history.turns[0].history_gap;
      if(fault==='budget')history.notice='x'.repeat(24576);
      await assert.rejects(f.picker.originalRho('rho-task','rho-original'),/incomplete or exceeds/);
    }
  });
  await check('continuation input remains tied to its original checked run and digest',async()=>{
    const f=fixture();f.rho.request.continuation={run_id:'earlier',recovery_digest:'checked-digest'};
    Object.assign(f.rho.context.history,{kind:'continuation',previous_run_id:'earlier',recovery:{digest:'checked-digest'},tools:[],tools_truncated:false,prior_sources:[],prior_sources_truncated:false});
    assert.equal((await f.picker.originalRho('rho-task','rho-original')).history.kind,'continuation');
    f.rho.context.history.recovery.digest='replacement';await assert.rejects(f.picker.originalRho('rho-task','rho-original'),/original task/);
  });
  console.log(`Ordinary context picker: ${count} checks passed; exact source, inclusion, partial/changed input and bounded reads. Native/Host acceptance remains separate.`);
}
