import assert from 'node:assert/strict';

export async function testModelSettings(ModelSettings, NativeAgentModel, operationRequestId) {
  const clone = structuredClone;
  const connection = { protocol: 'openai_completions', base_url: 'https://fixture.invalid/v1', model: 'fixture', credential: { kind: 'local_file', key_id: '' } };
  function fixture() {
    let saved = {}, version = 0, lost = '', saveFails = false, config = { version: 0, enabled: false, connection: null }, observePartial = false;
    const instance = { instance: 'agent', plugin: 'org.rho.agent', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) };
    const calls = [], records = [], writes = [], keys = new Map(), diagnostics = new Map();
    const client = {
      get view() { return { view: 'settings-view', window: 'window', project: 'project', instance, state: clone(saved), state_version: version }; },
      async setState(value) { writes.push(clone(value)); if (saveFails) throw Error('State save failed'); saved = clone(value); version++; return this.view; },
      async query(cap, args) {
        const input = args.arguments;
        let data, complete = true;
        if (cap.id === 'operation.list_recent') data = { operations: records.filter(r => r.operation.client_request_id === args.client_request_id).map(r => ({operation_id:r.operation.operation_id})) };
        else if (cap.id === 'agent.model.settings') data = clone(config);
        else if (cap.id === 'agent.model.key.status') {
          assert.equal(input.settings_version, config.version);
          data = { credential: config.connection?.credential ?? null, available: [...keys.values()].some(k => k.key_id === config.connection?.credential.key_id && k.available) };
        } else if (cap.id === 'agent.model.key.receipt') { const key = keys.get(input.request_id); data = { credential: key ? {kind:'local_file',key_id:key.key_id} : null, available: key?.available ?? false }; complete = !!key; }
        else if (cap.id === 'agent.model.diagnostic') data = diagnostics.get(input.request_id);
        else throw Error('Unexpected query ' + cap.id);
        return { status: 'ready', completeness: complete && !observePartial ? 'complete' : 'partial', data: clone(data) };
      },
      async control(cap, args) {
        assert.ok(saved.settings.key, 'Original key request must be confirmed before dispatch');
        const input = args.arguments; calls.push({id:cap.id,args:clone({...input,value:undefined})});
        let result;
        if (cap.id === 'agent.model.key.store') {
          let key = keys.get(input.request_id);
          if (!key) { key = {key_id:'key-'+keys.size,secret:input.value,available:true}; keys.set(input.request_id,key); }
          assert.equal(key.secret,input.value); assert.equal(key.available,true);
          result = {kind:'local_file',key_id:key.key_id};
        } else if (cap.id === 'agent.model.key.remove') {
          assert.equal(input.settings_version,config.version); assert.equal(input.key_id,config.connection.credential.key_id);
          for (const key of keys.values()) if (key.key_id === input.key_id) key.available = false;
          result = {credential:clone(config.connection.credential),available:false};
        } else throw Error('Unexpected Control');
        if (lost === cap.id) { lost = ''; throw Error('Lost key reply'); }
        return result;
      },
      async invoke(cap,args,options) {
        assert.ok(saved.settings.pending.some(p => p.intent.request === options.requestId)); calls.push({id:cap.id,args:clone(args)});
        const scoped = await operationRequestId('settings-view',options.requestId); let record = records.find(r=>r.operation.client_request_id===scoped);
        if (!record) {
          const input = args.arguments; let output, error = null;
          if (cap.id === 'agent.model.configure') {
            if (input.version !== config.version) error = 'Settings conflict';
            else { config = {...clone(input),version:input.version+1}; output = clone(config); }
          } else if (cap.id === 'agent.model.test') {
            output = {request_id:input.request_id,version:1,model_settings_version:input.model_settings_version,model:clone(config.connection),kind:input.kind,state:'succeeded',detail:'Synthetic test complete'};
            diagnostics.set(input.request_id,output);
          } else if (cap.id === 'agent.model.test.stop') {
            output = {...diagnostics.get(input.request_id),state:'stopping',version:input.expected_version+1}; diagnostics.set(input.request_id,output);
          } else throw Error('Unexpected Operation');
          record = {operation:{operation_id:'operation-'+records.length,caller:{kind:'plugin',id:'settings-view'},client_request_id:scoped,capability:cap,normalized_arguments:clone(args),preconditions:[]},
            status:error?'failed':'succeeded',outcome:error?'failed':'succeeded',output,error}; records.push(record);
        }
        if (lost === cap.id) { lost=''; throw Error('Lost Operation reply'); }
        return clone(record);
      },
      async operation(id) { return clone(records.find(r=>r.operation.operation_id===id)); },
    };
    return { client,calls,records,writes,keys,diagnostics,
      open() { const owner = new NativeAgentModel(client); return { owner, model:new ModelSettings(client,owner.state,()=>owner.save()) }; },
      lose(id) { lost=id; }, failSave(value) { saveFails=value; }, partial(value) { observePartial=value; },
      replace() { config={...config,version:config.version+1,connection:{...connection,model:'changed elsewhere',credential:{kind:'local_file',key_id:'replacement'}}}; },
    };
  }
  let count=0;
  async function check(name,work) { try { await work(); count++; } catch(error) { throw Error(name,{cause:error}); } }
  async function draft(model) { await model.refresh(); await model.edit({version:0,enabled:true,connection:clone(connection)}); }
  await check('opening settings reads only and persists through the shared Agent state writer',async()=>{
    const f=fixture(),{model,owner}=f.open(); await model.refresh(); assert.equal(f.calls.length,0);
    owner.state.selected='native-task'; await owner.save(); await model.edit({version:0,enabled:true,connection:clone(connection)});
    const reopened=f.open(); assert.equal(reopened.owner.state.selected,'native-task'); assert.equal(reopened.model.state.draft.enabled,true);
  });
  await check('key bytes stay out of view state, Operations and drafts',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); await model.configure('FIXTURE-SECRET-ONLY'); await model.refresh();
    assert.equal(model.current.version,1); assert.equal(model.credential.available,true); assert.equal(f.keys.size,1);
    assert.equal(JSON.stringify([f.writes,f.records,f.calls]).includes('FIXTURE-SECRET-ONLY'),false);
    assert.equal(f.calls.filter(c=>c.id==='agent.model.test').length,0);
  });
  await check('lost key receipt survives reload; inspection cannot configure or test',async()=>{
    const f=fixture(); let {model}=f.open(); await draft(model); f.lose('agent.model.key.store'); await assert.rejects(model.configure('fixture-key'),/Lost key reply/);
    const request=model.state.key.request; model=f.open().model; await model.refresh(); assert.equal(model.state.key.request,request);
    const before=f.calls.length; await model.inspectKey(); assert.equal(f.calls.length,before); assert.equal(model.state.key,null);
    assert.equal(model.state.draft.connection.credential.key_id,'key-0'); assert.equal(model.current.version,0);
    await model.configure(); assert.equal(model.current.version,1); assert.equal(f.keys.size,1);
  });
  await check('key retry uses the same request and never advances to model configuration',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.lose('agent.model.key.store'); await assert.rejects(model.configure('original'));
    const request=model.state.key.request; await model.retryKey('original'); assert.equal(f.keys.size,1); assert.equal(f.calls.at(-1).args.request_id,request);
    assert.equal(f.records.length,0); assert.equal(model.current.version,0);
  });
  await check('unconfirmed view persistence fences all key and Operation dispatch',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.failSave(true); await assert.rejects(model.configure('fixture-key'),/State save failed/);
    assert.equal(f.calls.length,0); f.failSave(false); await model.retryKey('fixture-key'); assert.equal(f.keys.size,1); assert.equal(f.records.length,0);
  });
  await check('lost configure reply inspects one original Operation after reload',async()=>{
    const f=fixture(); let {model}=f.open(); await draft(model); f.lose('agent.model.configure'); await assert.rejects(model.configure('fixture-key'),/Lost Operation reply/);
    model=f.open().model; const request=model.state.pending[0].intent.request; const before=f.calls.length;
    await model.refresh(); assert.equal(model.state.pending.length,1); await model.inspect(request);
    assert.equal(f.calls.length,before); assert.equal(f.records.length,1); assert.equal(model.dirty,false);
  });
  await check('changed Operation arguments are refused and original intent stays retained',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.lose('agent.model.configure'); await assert.rejects(model.configure('fixture-key'));
    f.records[0].operation.normalized_arguments.arguments.model='forged'; await assert.rejects(model.inspect(model.state.pending[0].intent.request),/original Agent request/);
    assert.equal(model.state.pending.length,1);
  });
  await check('an older original settings receipt cannot roll back a newer observation',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.lose('agent.model.configure'); await assert.rejects(model.configure('fixture-key'));
    f.replace(); await model.refresh(); await model.inspect(model.state.pending[0].intent.request);
    assert.equal(model.current.version,2); assert.equal(model.state.draft.version,1); assert.equal(model.dirty,true);
  });
  await check('stale settings preserve edits until explicit reload',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.replace(); await assert.rejects(model.configure(),/Settings conflict/);
    await model.refresh(); assert.equal(model.state.draft.connection.model,'fixture'); assert.equal(model.current.connection.model,'changed elsewhere');
    await model.useCurrent(); assert.equal(model.dirty,false);
  });
  await check('removal lost reply is read back without a new mutation',async()=>{
    const f=fixture(); let {model}=f.open(); await draft(model); await model.configure('fixture-key'); await model.refresh(); f.lose('agent.model.key.remove'); await assert.rejects(model.removeKey());
    model=f.open().model; const before=f.calls.length; await model.inspectKey(); assert.equal(f.calls.length,before); assert.equal(model.credential.available,false);
    assert.equal(model.state.key,null); assert.equal(f.keys.values().next().value.available,false);
  });
  await check('changed settings retire a removal intent without touching the replacement',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); await model.configure('fixture-key'); await model.refresh(); f.lose('agent.model.key.remove'); await assert.rejects(model.removeKey());
    f.replace(); const before=f.calls.length; await assert.rejects(model.inspectKey(),/Settings changed/); assert.equal(model.state.key,null); assert.equal(f.calls.length,before);
  });
  await check('explicit diagnostics retain originals and Stop is distinct from completion',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); await model.configure('fixture-key'); await model.refresh();
    f.lose('agent.model.test'); await assert.rejects(model.test('images')); const pending=model.state.pending[0];
    await model.inspect(pending.intent.request); await model.refresh(); assert.equal(f.records.filter(r=>r.operation.capability.id==='agent.model.test').length,1);
    const request=model.state.tests[0]; f.diagnostics.get(request).state='running'; await model.refresh(); await model.stopTest(request);
    assert.equal(model.diagnostics.get(request).state,'stopping');
  });
  await check('partial observations and changed view identity never establish recovery',async()=>{
    const f=fixture(),{model}=f.open(); await draft(model); f.lose('agent.model.key.store'); await assert.rejects(model.configure('fixture-key'));
    f.partial(true); await assert.rejects(model.inspectKey(),/incomplete/); assert.ok(model.state.key); f.partial(false);
    const saved=f.client.view.state; saved.settings.key.instance.instance='other'; await f.client.setState(saved); assert.throws(()=>f.open(),/another Agent view or instance/);
  });
  console.log(`Ordinary Rho settings: ${count} checks passed; scoped original requests, secret-free persistence, explicit tests and key removal. Native acceptance remains separate.`);
}
