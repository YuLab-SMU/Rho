// Renderer-only synthetic peer. It exercises the public opaque iframe channel;
// it is not native Agent, Host or scientific execution acceptance.
const copy = structuredClone, blank = () => ({ text: '', assets: [], context: [] });
const instance = { instance: 'agent', plugin: 'org.rho.agent', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) };
const tool = { name: 'run_selected_r', target: { type: 'provider', binding: { project: 'project', provider: { ...instance, instance: 'r', plugin: 'org.rho.r' }, capability: { id: 'r.execute', version: 2 }, target: 'session-one' } } };
let view = { view: 'agent-view', window: 'window', project: 'project', instance, state_version: 1,
  configuration: { tools: [tool] }, state: { schema: 1, selected: 'task-0', archived: false, drafts: {}, pending: [], tools: [], catalogs: {} } };
const details = new Map(), records = [], calls = [], events = new Map(), reads = {};
function detail(task, title) {
  return { summary: { observation_version: 1, history_generation: 1, task: { task_id: task, provider: 'kimi', title, archived: false, model: 'fixture-model', mode: null, native_session_id: null },
    attachment: { generation: 1, controller: { window_id: 'window', incarnation: 'view:agent-view' }, state: 'idle', control_frozen: false,
      capabilities: { models: [{ id: 'fixture-model', name: 'Fixture model' }], history: 'Retained native events' }, decisions: [] }, history_gap: false, unconfirmed: 0 },
    draft: { version: 1, content: blank() }, assets: [], receipts: [] };
}
details.set('task-0', detail('task-0', 'Inspect the selected R workspace'));
details.set('task-1', detail('task-1', 'Compare the saved analysis'));
events.set('task-0', [
  { cursor: 1, kind: 'text', role: 'user', text: 'Explain the result for 细胞类型 Ω and keep the original run.' },
  { cursor: 2, kind: 'text', role: 'assistant', text: 'The selected calculation returned 42. Its original record remains available.\n\nYou can continue this conversation or start a separate task.' },
  { cursor: 3, kind: 'reasoning', role: 'assistant', text: 'RENDERER_PRIVATE_REASONING' },
]);
events.get('task-0')[0].request_id='previous-context-send';
details.get('task-0').receipts.push({request_id:'previous-context-send',task_id:'task-0',command:'send',status:'succeeded',input_assets:[]});
const originalEvents = copy(events.get('task-0'));
let close = { phase: 'open' }, saveDelay = 0, loseFinish = false;
const staged = new Map();
let modelSettings = {version:0,enabled:false,connection:null}, loseSettings = '';
const modelKeys = new Map(), modelTests = new Map();
const rhoTasks = new Map(), rhoRuns = new Map(), rhoEvents = new Map();
let loseRho = '';
let contextFault = '', contextManifest;
const contextProvider = {...instance,instance:'editor-one',plugin:'org.rho.editor',revision:'sha256:'+'c'.repeat(64),artifact:'sha256:'+'d'.repeat(64)};
const contextReference = {provider:contextProvider,contribution:'documents',window:'window',selector:{draft:'draft-one',version:7,digest:'sha256:'+'e'.repeat(64)}};
const contextItem = {reference:contextReference,title:'分析 Ω.R',description:'Synchronized version 7 · selected lines 1–2',kind:'document'};

async function requestId(request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('agent-view:' + request));
  return 'sha256:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function handle(body) {
  if (body.type === 'register_close_handler') return {};
  if (body.type === 'observe_lifecycle') return { view: view.view, close };
  if (body.type === 'prepare_close' || body.type === 'refuse_close') { calls.push(copy(body)); return {}; }
  if (body.type === 'set_state') {
    if (body.expected_version !== view.state_version) throw Error('Stale view state');
    view = { ...view, state: copy(body.state), state_version: view.state_version + 1 }; return { status: 'succeeded', output: copy(view) };
  }
  if (body.type === 'get_operation') return copy(records.find(r => r.operation.operation_id === body.operation_id));
  if (body.type === 'query') {
    const id = body.capability.id, args = body.arguments.arguments;
    reads[id] = (reads[id] ?? 0) + 1;
    let data;
    if (id === 'operation.list_recent') data = { operations: records.filter(r => r.operation.client_request_id === body.arguments.client_request_id).map(r => ({ operation_id: r.operation.operation_id })) };
    else if (id === 'agent.native.context') {
      const reference=copy(contextReference);reference.selector.version=6;
      data={request_id:args.request_id,task_id:'task-0',contexts:[{selection:{source:'plugin',label:'Captured selection',reference,inclusion:'{"kind":"selection"}'},title:'分析 Ω.R · selection',description:'Original synchronized version 6',text:'original_value <- 7 # 中文 Ω',data:{version:6}}]};
    }
    else if (id === 'plugins.instances') data = {instances:[{identity:contextProvider,project:'project',state:'active',alias:'Editor'}],next:null,total:1};
    else if (id === 'plugins.inspect') {
      contextManifest ??= await fetch('/editor-context-manifest.json').then(r=>r.json());
      data={summary:{revision:contextProvider.revision},manifest:contextManifest,artifacts:[{id:contextProvider.artifact}]};
    }
    else if (id === 'editor.context.search') data={items:[contextItem],next:null,notices:[]};
    else if (id === 'editor.context.preview') {
      if(JSON.stringify(body.arguments.binding.provider)!==JSON.stringify(contextProvider)||args.reference.selector.version!==7)throw Error('Source changed. The draft is retained.');
      if(contextFault==='changed') throw Error('Source changed. The draft is retained.');
      data={item:contextItem,text:args.inclusion.kind==='selection'?'selected_value <- 42 # 中文 Ω':'# Synchronized analysis document\nselected_value <- 42 # 中文 Ω\nprint(selected_value)',truncated:contextFault==='truncated',data:{inclusion:args.inclusion.kind},resources:[]};
    }
    else if (id === 'agent.model.settings') data = modelSettings;
    else if (id === 'agent.model.key.status') {
      if (args.settings_version !== modelSettings.version) throw Error('Settings changed');
      data = {credential:modelSettings.connection?.credential??null,available:[...modelKeys.values()].some(k=>k.key_id===modelSettings.connection?.credential.key_id&&k.available)};
    }
    else if (id === 'agent.model.key.receipt') { const key=modelKeys.get(args.request_id); data={credential:key?{kind:'local_file',key_id:key.key_id}:null,available:!!key?.available}; }
    else if (id === 'agent.model.diagnostic') data = modelTests.get(args.request_id);
    else if (id === 'agent.model.conversation') data = rhoTasks.get(args.conversation_id);
    else if (id === 'agent.model.run.get') data = rhoRuns.get(args.run_id);
    else if (id === 'agent.model.run.request') data = [...rhoRuns.values()].find(r => r.request.request_id === args.request_id);
    else if (id === 'agent.model.run.events') data = {events:(rhoEvents.get(args.run_id)??[]).filter(e=>e.sequence>args.after).slice(0,args.limit),cursor:rhoRuns.get(args.run_id).event_cursor,history_gap:false};
    else if (id === 'agent.model.history') {
      const all=[...rhoRuns.values()].filter(r=>r.request.conversation_id===args.conversation_id).reverse();
      const start=args.before?all.findIndex(r=>r.run_id===args.before)+1:0, page=all.slice(start,start+args.limit);
      data={conversation_id:args.conversation_id,runs:page.map(r=>({run_id:r.run_id,conversation_id:r.request.conversation_id,state:r.state})),next:start+args.limit<all.length?page.at(-1).run_id:null};
    }
    else if (id === 'agent.tasks') {
      const tasks = [...details.values()].filter(d => d.summary.task.archived === args.archived).map(d => ({ reference: { kind: 'native', task_id: d.summary.task.task_id }, title: d.summary.task.title, provider: d.summary.task.provider, state: d.summary.attachment.state, archived: d.summary.task.archived }));
      tasks.push(...[...rhoTasks.values()].filter(t=>t.archived===args.archived).map(t=>({reference:{kind:'rho',conversation_id:t.conversation_id},title:t.title,provider:null,state:t.active_run_id?rhoRuns.get(t.active_run_id).state:'idle',archived:t.archived})));
      const before = Number(args.before ?? 0), end = before + args.limit;
      data = { tasks: tasks.slice(before,end), next: end < tasks.length ? String(end) : null };
    }
    else if (id === 'agent.native.task') data = details.get(args.task_id);
    else if (id === 'agent.native.receipt') data = [...details.values()].flatMap(d => d.receipts).find(r => r.request_id === args.request_id);
    else if (id === 'agent.native.events') {
      const all = (events.get(args.task_id) ?? []).map(event => ({ ...event, sequence: event.cursor, event_id: `${args.task_id}:${event.cursor}`, observed_at_ms: event.cursor,
        native_session_id: 'fixture-session', source: 'observation' }));
      const available = all.filter(event => (args.after === null || event.sequence > args.after) && (args.before === null || event.sequence < args.before));
      const page = args.after === null ? available.slice(-args.limit) : available.slice(0,args.limit);
      data = { task_id: args.task_id, events: page, history_generation: details.get(args.task_id).summary.history_generation, has_more: available.length > page.length, history_gap: false,
        next_cursor: args.after === null ? page[0]?.sequence ?? 0 : page.at(-1)?.sequence ?? args.after, durable_cursor: all.at(-1)?.sequence ?? 0, oldest_cursor: all[0]?.sequence ?? 0 };
    }
    else throw Error('Unexpected query ' + id);
    return { status: 'ready', completeness: 'complete', data: copy(data) };
  }
  if (body.type === 'control') {
    if (body.capability.id.startsWith('agent.model.key.')) {
      const args=body.arguments.arguments; if (!view.state.settings?.key) throw Error('Original key request was not retained');
      calls.push({type:body.type,capability:copy(body.capability),arguments:{...copy(args),value:undefined}});
      let result;
      if (body.capability.id === 'agent.model.key.store') {
        let key=modelKeys.get(args.request_id); if(!key){key={key_id:'key-'+modelKeys.size,available:true};modelKeys.set(args.request_id,key);}
        result={kind:'local_file',key_id:key.key_id};
      } else if(body.capability.id==='agent.model.key.remove') {
        if(args.settings_version!==modelSettings.version||args.key_id!==modelSettings.connection?.credential.key_id) throw Error('Settings changed');
        for(const key of modelKeys.values()) if(key.key_id===args.key_id) key.available=false;
        result={credential:copy(modelSettings.connection.credential),available:false};
      } else throw Error('Unexpected settings Control');
      if(loseSettings===body.capability.id){loseSettings='';throw Error('Lost settings reply');}
      return result;
    }
    const { upload, offset, data } = body.arguments.arguments;
    if (!view.state.uploads.some(p => JSON.stringify(p.upload) === JSON.stringify(upload))) throw Error('Attachment identity was not retained');
    calls.push({ ...copy(body), arguments: { upload: copy(upload), offset, encoded_bytes: data?.length ?? 0 } });
    if (body.capability.id === 'agent.native.assets.stage') {
      const part = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      let entry = staged.get(upload.request_id);
      if (!entry) { entry = { bytes: new Uint8Array(upload.bytes), received: 0 }; staged.set(upload.request_id, entry); }
      if (part.length > 65536 || offset > entry.received) throw Error('Invalid chunk range');
      entry.bytes.set(part, offset); entry.received = Math.max(entry.received, offset + part.length);
      return { upload: copy(upload), received: entry.received, complete: entry.received === upload.bytes };
    }
    if (body.capability.id !== 'agent.native.assets.finish') throw Error('Unexpected attachment Control');
    const entry = staged.get(upload.request_id); if (entry?.received !== upload.bytes) throw Error('Incomplete file');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', entry.bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== upload.sha256) throw Error('Changed file bytes');
    const detail = details.get(upload.control.task_id), receipt = { request_id: upload.request_id, task_id: upload.control.task_id, command: 'add_asset', status: 'succeeded' };
    detail.assets.push({ asset_id: upload.request_id, name: upload.name, mime_type: upload.mime_type, bytes: upload.bytes, sha256: upload.sha256 });
    detail.receipts.push(receipt); detail.summary.observation_version++; staged.delete(upload.request_id);
    if (loseFinish) { loseFinish = false; throw Error('Lost attachment reply'); }
    return copy({ receipt, detail });
  }
  if (body.type === 'invoke') {
    calls.push(copy(body));
    if (['create','draft','update','take_control','run','run.stop'].some(kind=>body.capability.id===`agent.model.${kind}`)) {
      const retained=view.state.rho?.pending.find(p=>p.intent.request===body.request_id);
      if(!retained || JSON.stringify(retained.intent.arguments)!==JSON.stringify(body.arguments)) throw Error('Original Rho intent was not retained');
      const scoped=await requestId(body.request_id);let record=records.find(r=>r.operation.client_request_id===scoped);
      if(!record){
        const args=body.arguments.arguments,kind=body.capability.id.slice('agent.model.'.length);let task=rhoTasks.get(args.conversation_id),output,status='succeeded';
        if(kind==='create'){
          task={conversation_id:args.conversation_id,title:'New Rho task',profile:args.profile,archived:false,version:1,draft_version:1,draft:'',draft_content:blank(),controller:{window_id:view.window,incarnation:'view:'+view.view},active_run_id:null};rhoTasks.set(task.conversation_id,task);output=copy(task);
        }else if(kind==='draft'){
          if(args.draft_version!==task.draft_version)throw Error('Draft conflict');task.draft_content=copy(args.content);task.draft=args.content.text;task.draft_version++;task.version++;output=copy(task);
        }else if(kind==='update'||kind==='take_control'){
          if(args.expected_version!==task.version)throw Error('Task changed');task.version++;
          if(kind==='take_control'){task.controller={window_id:view.window,incarnation:'view:'+view.view};task.active_run_id=null;}
          else{if(args.title!==undefined)task.title=args.title.trim();if(args.archived!==undefined)task.archived=args.archived;}
          output=copy(task);
        }else if(kind==='run'){
          if(args.conversation_version!==task.version||args.text!==task.draft_content.text)throw Error('Original draft changed');
          const earlier=[...rhoRuns.values()].find(run=>run.request.conversation_id===task.conversation_id);
          const capturedContext=args.sources.length||earlier?{history:earlier?{kind:'conversation',truncated:false,notice:'Fixture retained input',turns:[{run_id:earlier.run_id,state:'completed',user_text:earlier.request.text,assistant_text:'Retained Rho answer · 中文 Ω',history_gap:false,text_truncated:false,references:[],references_truncated:false}]}:null,sources:args.sources.map(selection=>({selection:copy(selection),title:contextItem.title,description:contextItem.description,text:JSON.parse(selection.inclusion).kind==='selection'?'selected_value <- 42 # 中文 Ω':'# Synchronized analysis document\nselected_value <- 42 # 中文 Ω\nprint(selected_value)',native_data:{version:7},truncated:false,observations:[],evidence:[]}))}:null;
          const run={run_id:'rho-run-'+rhoRuns.size,request:{...copy(args),window:copy(task.controller)},context:capturedContext,state:'running',updated_at_ms:Date.now(),event_cursor:0,reason:null};rhoRuns.set(run.run_id,run);
          task.draft_content=blank();task.draft='';task.draft_version++;task.version++;task.active_run_id=run.run_id;status='running';output=null;
        }else{const run=rhoRuns.get(args.run_id);run.state='stopping';run.updated_at_ms=Date.now();output=copy(run);}
        record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:view.view},client_request_id:scoped,capability:copy(body.capability),normalized_arguments:copy(body.arguments),preconditions:[]},status,outcome:status==='running'?null:status,output,error:null};records.push(record);
      }
      if(loseRho===body.capability.id){loseRho='';throw Error('Lost original Rho reply');}return copy(record);
    }
    if (body.capability.id.startsWith('agent.model.')) {
      if (!view.state.settings.pending.some(p=>p.intent.request===body.request_id)) throw Error('Original settings intent was not retained');
      const scoped=await requestId(body.request_id); let record=records.find(r=>r.operation.client_request_id===scoped);
      if(!record){
        const args=body.arguments.arguments; let output;
        if(body.capability.id==='agent.model.configure'){
          if(args.version!==modelSettings.version) throw Error('Settings changed'); modelSettings={...copy(args),version:args.version+1}; output=copy(modelSettings);
        } else if(body.capability.id==='agent.model.test'){
          output={request_id:args.request_id,version:1,model_settings_version:args.model_settings_version,model:copy(modelSettings.connection),kind:args.kind,state:'succeeded',detail:'Synthetic connection verified. No external model was contacted.'}; modelTests.set(args.request_id,copy(output));
        } else throw Error('Unexpected settings Operation');
        record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:view.view},client_request_id:scoped,capability:copy(body.capability),normalized_arguments:copy(body.arguments),preconditions:[]},status:'succeeded',outcome:'succeeded',output,error:null};records.push(record);
      }
      if(loseSettings===body.capability.id){loseSettings='';throw Error('Lost settings reply');}
      return copy(record);
    }
    if (!view.state.pending.some(p => p.intent.request === body.request_id)) throw Error('Original intent was not retained');
    const scoped = await requestId(body.request_id), original = records.find(r => r.operation.client_request_id === scoped);
    if (original) return copy(original);
    const command = body.arguments.arguments.command, sentAssets = command?.kind === 'send' ? copy(details.get(command.control.task_id).draft.content.assets) : [], task = command?.control?.task_id ?? 'task-' + details.size;
    let d = details.get(task), output;
    if (body.capability.id === 'agent.native.discover') {
      output = { provider: body.arguments.arguments.provider, selected_model: 'fixture-model', selected_effort: null, models: [{ id: 'fixture-model', name: 'Fixture model' }], error: null };
    } else {
      if (command.kind === 'create') { d = detail(task, 'New task'); d.summary.task.provider = command.provider; details.set(task, d); }
      else if (command.kind === 'save_draft') {
        if (command.version !== d.draft.version) throw Error('Stale native draft');
        d.draft = { version: d.draft.version + 1, content: copy(command.content) };
      } else if (command.kind === 'send') {
        if (command.draft_version !== d.draft.version) throw Error('Stale sent draft');
        events.set(task, [...(events.get(task) ?? []), { cursor: 4, kind: 'text', role: 'user', request_id: body.request_id, text: d.draft.content.text }]);
        d.draft = { version: d.draft.version + 1, content: blank() }; d.summary.attachment.state = 'running';
      } else if (command.kind === 'rename') d.summary.task.title = command.title;
      else if (command.kind === 'archive') d.summary.task.archived = command.archived;
      else if (command.kind === 'stop') d.summary.attachment.state = 'stopping';
      else throw Error('Unexpected fixture command ' + command.kind);
      const receipt = { request_id: body.request_id, command: command.kind, task_id: task, input_assets: sentAssets, status: command.kind === 'send' ? 'submitted' : 'succeeded', submitted_draft_version: command.kind === 'send' ? command.draft_version : null };
      d.summary.observation_version++; d.receipts.push(receipt); output = { receipt, detail: copy(d) };
    }
    const running = command?.kind === 'send';
    const record = { operation: { operation_id: 'op-' + records.length, caller: { kind: 'plugin', id: view.view }, client_request_id: scoped, capability: body.capability, normalized_arguments: copy(body.arguments), preconditions: [] },
      status: running ? 'running' : 'succeeded', outcome: running ? null : 'succeeded', output: running ? null : output, error: null };
    records.push(record);
    if (command?.kind === 'save_draft' && saveDelay) await new Promise(done => setTimeout(done, saveDelay));
    return copy(record);
  }
  throw Error('Unexpected fixture request ' + body.type);
}
const frame = document.querySelector('iframe');
let reloaded = null;
addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data.type !== 'rho:view:ready' || event.data.nonce !== 'fixture-nonce') return;
  const channel = new MessageChannel(), connection = crypto.randomUUID(); let sequence = 0;
  channel.port1.onmessage = async ({ data: message }) => {
    let reply;
    try { reply = { ok: true, result: await handle(message.body) }; } catch (error) { reply = { ok: false, error: error.message }; }
    channel.port1.postMessage({ protocol_version: 1, connection, view: view.view, sequence: ++sequence, request: message.request, ...reply });
  };
  frame.contentWindow.postMessage({ type: 'rho:view:connect', nonce: 'fixture-nonce', protocol_version: 1, connection, view: copy(view), features: ['view_close_v1'] }, '*', [channel.port2]);
  if (reloaded) { const resolve = reloaded; reloaded = null; resolve(); }
});
window.fixture = {
  snapshot: () => copy({ view, calls, details: [...details], records, reads, rhoTasks:[...rhoTasks], rhoRuns:[...rhoRuns] }),
  contextFault: value => { contextFault=value; },
  loseRhoReply: id => { loseRho=id; },
  finishRho: id => {
    const run=rhoRuns.get(id);run.state='completed';run.updated_at_ms=Date.now();run.event_cursor=2;
    rhoEvents.set(id,[{run_id:id,sequence:1,content:{kind:'text',text:'Retained Rho answer · 中文 Ω.\nThis is a renderer fixture; no model was contacted.'}},{run_id:id,sequence:2,content:{kind:'reasoning',text:'RHO_PRIVATE_REASONING'}}]);
    const task=rhoTasks.get(run.request.conversation_id);task.active_run_id=null;task.version++;
    const record=records.find(r=>r.operation.capability.id==='agent.model.run'&&r.operation.normalized_arguments.arguments.request_id===run.request.request_id);record.status='succeeded';record.outcome='succeeded';record.output=copy(run);
  },
  pagedTasks: enabled => {
    for (let index = 2; index < 25; index++) {
      const id = `task-${index}`; if (enabled) details.set(id, detail(id, `Earlier task ${index}`)); else details.delete(id);
    }
  },
  pagedHistory: enabled => {
    events.set('task-0', enabled ? Array.from({ length: 220 }, (_, i) => ({ cursor: i+1, role: i % 2 ? 'assistant' : 'user', kind: 'text', text: `Retained message ${i+1} · 中文 Ω` })) : copy(originalEvents));
    const d = details.get('task-0'); d.summary.history_generation++; d.summary.observation_version++;
  },
  delaySave: milliseconds => { saveDelay = milliseconds; },
  loseAttachmentReply: () => { loseFinish = true; },
  loseSettingsReply: id => { loseSettings = id; },
  close: () => { close = { phase: 'requested', operation: 'close-original' }; },
  reload: () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reloaded = null; reject(Error('Renderer did not reconnect after reload')); }, 10000);
    reloaded = () => { clearTimeout(timeout); resolve(); };
    // A same-fragment assignment can be a same-document navigation. A new
    // query forces a new document and public MessagePort handshake.
    frame.src = '/index.html?reload=' + crypto.randomUUID() + '#rho-view-nonce=fixture-nonce';
  }),
};
frame.src = '/index.html#rho-view-nonce=fixture-nonce';
