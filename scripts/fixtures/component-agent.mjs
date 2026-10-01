import assert from 'node:assert/strict';
export async function checkComponentAgent({ComponentAgent,sdk}) {
  const clone=structuredClone,digest=letter=>'sha256:'+letter.repeat(64);
  const editor={instance:'editor',plugin:'org.rho.editor',revision:digest('a'),artifact:digest('b')};
  const target={instance:'agent',plugin:'org.rho.agent',revision:digest('c'),artifact:digest('d')};
  function fixture(){
    let saved,early=false,failSave=false,lost=false,fault=null,closed=false;const records=[],calls=[],queries=[];
    const observation={instance:{identity:target,alias:'Agent',project:'project',principal:'principal',state:'active',purpose:'runtime'},observed_in_this_host:true};
    const client={view:{view:'editor-view',instance:editor,window:'window',project:'project',principal:'principal'},
      async query(cap,args){queries.push(clone({cap,args}));let data;
        if(cap.id==='r.context.help.preview'){
          if(fault==='source')throw Error('Source changed');
          data={item:{reference:clone(args.arguments.reference)},text:'Selected 中文',truncated:fault==='partial',resources:[]};
        }else if(cap.id==='plugins.instances')data={instances:[observation,{...observation,instance:{...observation.instance,identity:{...target,instance:'foreign'},principal:'other'}}],next:null};
        else if(cap.id==='plugins.instance')data=fault==='inactive'?{...observation,instance:{...observation.instance,state:'suspended'}}:observation;
        else if(cap.id==='plugins.inspect')data={summary:{revision:target.revision},manifest:{id:target.plugin,views:[{id:'agent',configuration_schema:{properties:fault==='old'?{}:{component_request:{}}}}]}};
        else if(cap.id==='windows.layout')data={window:'window',project:'project',principal:fault==='layout'?'other':'principal',version:7,layout:{kind:'tabs',id:'group'}};
        else if(cap.id==='operation.get')data={record:records.find(record=>record.operation.operation_id===args.operation_id)};
        else if(cap.id==='operation.list_recent')data={operations:records.filter(record=>record.operation.client_request_id===args.client_request_id).map(record=>({operation_id:record.operation.operation_id}))};
        else throw Error('Unexpected query '+cap.id);return{status:'ready',completeness:'complete',data:clone(data)};
      },
      async invoke(cap,args,options){
        assert.ok(saved.pending,'Save exact request before opening');assert.deepEqual(saved.pending.arguments,args);calls.push(clone({cap,args,options}));
        const request=await sdk.operationRequestId(client.view.view,options.requestId);let record=records.find(record=>record.operation.client_request_id===request);
        if(!record){record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:clone(cap),normalized_arguments:clone(args),preconditions:[]},status:'succeeded',outcome:'succeeded',error:null,
          output:{view:{...clone(args.view),view:'opened-view',project:'project',principal:'principal',state_version:0,purpose:'runtime',closed:false}}};records.push(record);}
        if(lost){lost=false;throw Error('Lost original reply');}if(early){early=false;return{...clone(record),status:'accepted',outcome:null,output:null};}return clone(record);
      },async operation(id){return clone(records.find(record=>record.operation.operation_id===id));}};
    const open=()=>new ComponentAgent(client,saved,async state=>{if(failSave)throw Error('Unconfirmed view save');saved=clone(state);},()=>{if(closed)throw Error('Closing');},()=>{});
    return{client,records,calls,queries,open,state:()=>clone(saved),lose:()=>lost=true,acceptEarly:()=>early=true,saveFailure:()=>failSave=true,fault:value=>fault=value,close:()=>closed=true};
  }
  let count=0;const check=async(name,work)=>{try{await work();count++;}catch(error){throw Error(name,{cause:error});}};
  async function prepare(f){const agent=f.open();await agent.prepare({title:'Help demo::topic',reference:{provider:{...editor,plugin:'org.rho.r',instance:'r-source'},window:'window',contribution:'help',selector:{session:'native',topic:'topic'}},inclusion:{kind:'text'},preview:{id:'r.context.help.preview',version:1}});await agent.select(target);return agent;}
  await check('capture preserves exact source and selection; only public view opening mutates',async()=>{
    const f=fixture(),agent=await prepare(f);assert.equal(f.calls.length,0);assert.equal(agent.candidates.length,1);assert.equal(agent.preview,'Selected 中文');
    await agent.open();assert.equal(f.calls.length,1);const config=f.calls[0].args.view.configuration;
    assert.equal(config.tools,undefined);assert.equal(config.component_request.sources[0].inclusion,'{"kind":"text"}');
    assert.deepEqual(config.component_request.sources[0].reference.selector,{session:'native',topic:'topic'});
    assert.equal(f.calls[0].cap.id,'windows.open_view');assert.equal(agent.data.opened.view,'opened-view');
    await assert.rejects(agent.open(),/prepare a new input/);
    const reopened=f.open();assert.equal(reopened.data.opened.view,'opened-view');assert.equal(f.calls.length,1);
  });
  await check('accepted opening is observed to completion without another invoke',async()=>{
    const f=fixture(),agent=await prepare(f);f.acceptEarly();await agent.open();
    assert.equal(agent.data.pending,null);assert.equal(agent.data.opened.view,'opened-view');assert.equal(f.calls.length,1);
  });
  await check('lost view acknowledgement is inspected without source reread or another view',async()=>{
    const f=fixture(),agent=await prepare(f);f.lose();await assert.rejects(agent.open(),/Lost original reply/);
    const input=clone(agent.data.input),reads=f.queries.length;f.fault('source');const reopened=f.open();await reopened.inspect();
    assert.deepEqual(reopened.data.input,input);assert.equal(reopened.data.opened.view,'opened-view');assert.equal(f.calls.length,1);
    assert.ok(f.queries.slice(reads).every(query=>query.cap.id==='operation.list_recent'));
  });
  await check('retry repeats the same request and does not choose a newer source',async()=>{
    const f=fixture(),agent=await prepare(f);f.lose();await assert.rejects(agent.open());const original=clone(f.calls[0]);
    const reopened=f.open();f.fault('source');await reopened.retry();assert.equal(f.records.length,1);assert.deepEqual(f.calls[1],original);
  });
  await check('stale source, old Agent, wrong layout or inactive instance dispatch nothing',async()=>{
    for(const fault of ['source','partial','old','layout','inactive']){const f=fixture(),agent=await prepare(f);f.fault(fault);await assert.rejects(agent.open());assert.equal(f.calls.length,0);assert.equal(agent.data.pending,null);}
  });
  await check('failed request persistence and closing never dispatch',async()=>{
    for(const close of [false,true]){const f=fixture(),agent=await prepare(f);if(close)f.close();else f.saveFailure();await assert.rejects(agent.open());assert.equal(f.calls.length,0);}
  });
  await check('another source view cannot recover or retry the captured view request',async()=>{
    const f=fixture(),agent=await prepare(f);f.lose();await assert.rejects(agent.open());f.client.view.window='other-window';assert.throws(()=>f.open(),/another source view/);
  });
  await check('reopened source view can inspect but cannot replay the old view request',async()=>{
    const f=fixture(),agent=await prepare(f);f.lose();await assert.rejects(agent.open());f.client.view.view='reopened';
    const reopened=f.open();await assert.rejects(reopened.retry(),/original source view/);await reopened.inspect();
    assert.equal(reopened.data.opened.view,'opened-view');assert.equal(f.calls.length,1);
  });
  await check('a forged successful view receipt cannot acknowledge the original input',async()=>{
    const f=fixture(),agent=await prepare(f);f.lose();await assert.rejects(agent.open());f.records[0].output.view.configuration.component_request.sources[0].reference.selector.session='other-session';
    await assert.rejects(agent.inspect(),/differs from the original/);assert.ok(agent.data.pending);assert.equal(agent.data.opened,null);
  });
  await check('original image bytes are verified and decoded before any request or persistence',async()=>{
    const originalDecoder=globalThis.createImageBitmap;
    try {
      for(const fault of [null,'digest','owner','size','decode','pixels']) {
        const f=fixture(),baseQuery=f.client.query,bytes=new Uint8Array([1,2,3]);let closed=0,reads=0;
        const reference={owner:{...editor,plugin:'org.rho.r',instance:'r-source'},resource:'original-image',media_type:'image/png',bytes:3,
          digest:'sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex')};
        const source={title:'Plot 1',reference:{provider:clone(reference.owner),window:'window',contribution:'plots',selector:{}},inclusion:{kind:'images'},preview:{id:'r.context.plots.preview',version:1}};
        if(fault==='owner')reference.owner.instance='foreign';if(fault==='size')reference.bytes=2*1024*1024+1;
        f.client.query=async(cap,args)=>{
          if(cap.id==='r.context.plots.preview')return {status:'ready',completeness:'complete',data:{item:{reference:clone(source.reference)},text:'Original plot',truncated:false,resources:[clone(reference)]}};
          if(cap.id==='resources.read'){reads++;return {data:{reference:clone(reference),offset:0,next:null,base64:Buffer.from(fault==='digest'?[4,5,6]:bytes).toString('base64')}};}
          return baseQuery(cap,args);
        };
        globalThis.createImageBitmap=async()=>{if(fault==='decode')throw Error('Undecodable image');return {width:fault==='pixels'?20000:2,height:2000,close(){closed++;}};};
        const sender=f.open();
        if(fault){await assert.rejects(sender.prepare(source));assert.equal(f.state(),undefined);assert.equal(sender.images.length,0);}
        else{await sender.prepare(source);assert.equal(sender.images.length,1);assert.deepEqual(new Uint8Array(await sender.images[0].arrayBuffer()),bytes);assert.equal(closed,1);assert.ok(!JSON.stringify(f.state()).includes('base64'));}
        if(['owner','size'].includes(fault))assert.equal(reads,0);
        if(fault==='pixels')assert.equal(closed,1);
        assert.equal(f.calls.length,0);
      }
    }finally{globalThis.createImageBitmap=originalDecoder;}
  });
  console.log(`Public component Agent sender: ${count} checks passed; exact capture, observed target, original view request and failure/reload recovery. No Host acceptance claimed.`);
}
