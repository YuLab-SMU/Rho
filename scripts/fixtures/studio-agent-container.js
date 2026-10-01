// Isolated Studio panel over synthetic public replies. The normal Studio shell,
// styles, Agent model and panel are retained; no Host or scientific claim.
import {AgentAssistance} from '/dist/src/agent.js';
import {agentPanel} from '/dist/src/agent-panel.js';
import {operationRequestId} from '/dist/public/plugin-ui/index.js';
const revision='sha256:'+'a'.repeat(64),artifact='sha256:'+'b'.repeat(64),copy=structuredClone;
const identity={instance:'agent',plugin:'org.rho.agent',revision,artifact};
const branch={id:'report-controls',name:'Report controls · 中文 Ω',plugin:'org.example.report',head:revision,origin:revision};
const observed={instance:{identity,project:'project',principal:'user',state:'active',alias:'Project Agent'},observed_in_this_host:true};
let saved=null,busy=false,lose=false,render=()=>{};
const records=[],calls=[];
const client={view:{view:'studio',window:'window',project:'project',principal:'user'},
  query:async(cap,args)=>{
    let data;
    if(cap.id==='plugins.branch_head')data={revision};
    else if(cap.id==='plugins.instances')data={instances:[observed],next:null,total:1};
    else if(cap.id==='plugins.instance')data=observed;
    else if(cap.id==='plugins.inspect')data={summary:{revision,plugin:'org.rho.agent'},manifest:{views:[{id:'agent',configuration_schema:{properties:{studio_request:{}}}}]}};
    else if(cap.id==='windows.layout')data={project:'project',principal:'user',window:'window',version:1,layout:{kind:'tabs',id:'group',views:['studio'],selected:'studio'}};
    else if(cap.id==='operation.list_recent')data={operations:records.filter(r=>r.operation.client_request_id===args.client_request_id).map(r=>({operation_id:r.operation.operation_id}))};
    else if(cap.id==='operation.get')data={record:records.find(r=>r.operation.operation_id===args.operation_id)};
    else throw Error(cap.id);
    return {status:'ready',data:copy(data)};
  },
  operation:async id=>copy(records.find(r=>r.operation.operation_id===id)),
  invoke:async(cap,args,options)=>{
    if(saved.pending.request!==options.requestId)throw Error('Missing acknowledged intent');calls.push({cap,args});
    const request=await operationRequestId(client.view.view,options.requestId);
    const record={operation:{operation_id:'op-'+records.length,caller:{kind:'plugin',id:client.view.view},client_request_id:request,capability:cap,normalized_arguments:copy(args),preconditions:[]},status:'succeeded',outcome:'succeeded',error:null,
      output:{view:{...copy(args.view),view:'opened-agent',project:'project',principal:'user',state_version:0,closed:false},layout:{version:2}}};records.push(record);
    if(lose){lose=false;throw Error('Connection lost. Inspect the original Agent view request.');}return copy(record);
  }};
const studio={client,branch,document:{dirty:false},assistance:null};
function mount(){studio.assistance=new AgentAssistance(client,async()=>{saved=copy(studio.assistance.data);},()=>{});if(saved)studio.assistance.restore(saved);render=agentPanel(studio,run,()=>{saved=copy(studio.assistance.data);render();},()=>busy);render();}
function run(work){if(busy)return;busy=true;document.querySelectorAll('.dialog-error').forEach(n=>{n.hidden=true;n.textContent='';});render();Promise.resolve().then(work).catch(error=>document.querySelectorAll('.dialog-error').forEach(n=>{n.hidden=false;n.textContent=error.message;})).finally(()=>{busy=false;render();});}
mount();document.getElementById('subtitle').textContent=branch.name;document.getElementById('editing').textContent='Editing / aaaaaaaa';
window.fixture={lose:()=>{lose=true;},reopen:()=>{mount();},snapshot:()=>copy({saved,calls,records})};
