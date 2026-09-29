/** Small shared sender UI; it neither activates Agent nor chooses/creates a task. */
import {ComponentAgent, type AgentState, type ComponentSource} from './input.js';
import type {Client} from './operations.js';
export interface SenderOptions {
  client:Client; saved?:AgentState; persist(state:AgentState):Promise<void>; guard():void;
  capture(kind:string):ComponentSource; modes:{value:string;label:string}[];
}
export function componentInputDialog(options:SenderOptions){
  const dialog=document.createElement('dialog');dialog.className='rho-agent-input';dialog.setAttribute('aria-label','Ask about this input');
  dialog.innerHTML='<div class="input-heading"><strong>Ask about this input</strong><button data-input="close">Back to source</button></div><label>Include<select data-input="mode" aria-label="Include"></select></label><p data-input="title"></p><pre data-input="preview"></pre><label>Agent instance<select data-input="instance" aria-label="Agent instance"></select></label><p data-input="status" role="status"></p><p data-input="error" role="alert" hidden></p><div class="input-actions"><button data-input="prepare">Prepare current input</button><button data-input="refresh">Refresh Agents</button><button data-input="more" hidden>More Agents</button><button data-input="inspect" hidden>Check original request</button><button data-input="retry" hidden>Retry original request</button><button data-input="open">Open Agent</button></div>';
  const style=document.createElement('style');style.textContent=`.rho-agent-input{box-sizing:border-box;color:#263345;background:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:1px solid #d5dde8;border-radius:8px;padding:18px;width:min(470px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;box-shadow:0 16px 60px #26334525}.rho-agent-input::backdrop{background:#20293650}.rho-agent-input .input-heading,.rho-agent-input .input-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between}.rho-agent-input label{display:block;margin:12px 0}.rho-agent-input select{box-sizing:border-box;display:block;width:100%;max-width:100%;font:inherit;margin-top:6px}.rho-agent-input pre{position:static;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;width:auto;max-height:30vh;overflow:auto;font:12px/1.5 ui-monospace,monospace;padding:0;border:0;box-shadow:none}.rho-agent-input p{overflow-wrap:anywhere}.rho-agent-input button{font:inherit;color:inherit;background:#fff;border:1px solid #d8dfe7;border-radius:5px;padding:5px 10px;white-space:normal;cursor:pointer}.rho-agent-input button:disabled{opacity:.5;cursor:default}.rho-agent-input [role=alert]{color:#963e27}.rho-agent-input [hidden]{display:none!important}`;
  document.head.append(style);document.body.append(dialog);
  const get=<T extends HTMLElement>(name:string)=>dialog.querySelector(`[data-input="${name}"]`) as T;
  const mode=get<HTMLSelectElement>('mode'),instance=get<HTMLSelectElement>('instance');
  for(const item of options.modes)mode.add(new Option(item.label,item.value));
  let error='',preparing=false,disposed=false;
  const agent=new ComponentAgent(options.client,options.saved,options.persist,()=>{if(disposed)throw Error('The source view is closed.');options.guard();},render);
  function render(){
    const {input,pending,opened}=agent.data,busy=agent.busy||preparing;
    get('title').textContent=input?.title??'Prepare the selected source.';
    get('preview').textContent=agent.preview||'The original reference is retained and checked again before opening Agent.';
    const selected=input?.instance?.instance??'';
    instance.replaceChildren(new Option('Choose an active Agent instance',''));
    for(const item of agent.candidates)instance.add(new Option(`${item.instance.alias} · ${item.instance.identity.revision.slice(7,15)}`,item.instance.identity.instance));
    if(selected&&!agent.candidates.some(item=>item.instance.identity.instance===selected))instance.add(new Option('Captured Agent instance',selected));
    instance.value=selected;instance.disabled=busy||!input||!!pending||!!opened;mode.disabled=busy||!!pending;
    get('status').textContent=pending?'Original view request retained. Check its result before another request.':opened?'Agent view opened. Choose an editable task there, then add the captured context.':input&&!agent.candidates.length?'No active Agent instance on this page. Activate or restore one in Plugins, then refresh.':'Opening Agent does not create a task or send a message.';
    get('error').textContent=error;get('error').hidden=!error;
    for(const name of ['close','prepare','refresh','more','inspect','retry','open'])get<HTMLButtonElement>(name).disabled=busy;
    get<HTMLButtonElement>('prepare').disabled=busy||!!pending;
    get<HTMLButtonElement>('open').disabled=busy||!!error||!input?.instance||!!pending||!!opened;
    get('inspect').hidden=!pending;get('retry').hidden=!pending||pending.view!==options.client.view.view;get('more').hidden=!agent.next;
  }
  const act=(work:()=>Promise<void>)=>{error='';void work().catch(e=>{error=e instanceof Error?e.message:String(e);}).finally(render);};
  async function prepare(){preparing=true;render();try{await agent.prepare(options.capture(mode.value));}finally{preparing=false;}}
  get('close').onclick=()=>dialog.close();get('prepare').onclick=()=>act(prepare);mode.onchange=()=>act(prepare);
  get('refresh').onclick=()=>act(()=>agent.list());get('more').onclick=()=>act(()=>agent.list(true));
  get('inspect').onclick=()=>act(()=>agent.inspect());get('retry').onclick=()=>act(()=>agent.retry());get('open').onclick=()=>act(()=>agent.open());
  instance.onchange=()=>{const target=agent.candidates.find(item=>item.instance.identity.instance===instance.value)?.instance.identity??null;act(()=>agent.select(target));};
  dialog.addEventListener('cancel',event=>{if(agent.busy||preparing)event.preventDefault();});render();
  return {open(){options.guard();dialog.showModal();if(!agent.data.pending)act(prepare);},get busy(){return agent.busy||preparing;},dispose(){disposed=true;dialog.remove();style.remove();}};
}
