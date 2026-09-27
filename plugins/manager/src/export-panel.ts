import type {PluginInspection} from '../public/plugin-protocol/index.js';
import type {Manager} from './model.js';
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
export function archiveExportPanel(manager:Manager,run:(work:()=>Promise<unknown>)=>void,changed:()=>void,busy:()=>boolean){
 const control=manager.archiveExport;
 let focusedArtifact:string|null=null;
 async function open(inspection?:PluginInspection){
  if(inspection)await control.configure(inspection);
  if(!manager.state.exported)throw Error('Select an installed revision to export.');
  render();get<HTMLDialogElement>('export-dialog').showModal();
 }
 get('retained-export').onclick=()=>run(()=>open());
 get('close-export').onclick=()=>get<HTMLDialogElement>('export-dialog').close();
 get('source-only-export').onclick=()=>run(()=>control.select([]));
 get('prepare-export').onclick=()=>run(()=>control.prepare());
 get('download-export').onclick=()=>run(async()=>{await control.download();get('export-download-status').textContent='Browser download requested. File saving is controlled by your browser.';});
 get('inspect-export').onclick=()=>run(async()=>{await control.inspect();get('export-download-status').textContent='Original export result confirmed.';});
 get('discard-export').onclick=()=>run(async()=>{await control.discard();get('export-download-status').textContent='';});
 get<HTMLInputElement>('export-filename').oninput=()=>{
  if(busy()||manager.state.pending||!manager.state.exported)return;
  manager.state.exported.filename=get<HTMLInputElement>('export-filename').value;changed();
 };
 function render(){
  const state=manager.state.exported,pending=!!manager.state.pending,blocked=busy()||pending,out=get('export-details');out.replaceChildren();
  get('retained-export').hidden=!state;
  if(state){
   out.append(el('h3',state.name),el('p',state.plugin),el('code',state.revision),el('p','Source is always included. Choose the exact build artifacts to include.'));
   for(const artifact of state.artifacts){
    const label=el('label'),checkbox=el('input');checkbox.type='checkbox';checkbox.dataset.exportArtifact=artifact.id;checkbox.checked=state.selected.includes(artifact.id);checkbox.disabled=blocked||!!state.receipt;
    const text=el('span',artifact.target);text.append(el('code',artifact.id));label.className='export-artifact';label.append(checkbox,text);out.append(label);
    checkbox.onchange=()=>{const selected=checkbox.checked?[...state.selected,artifact.id]:state.selected.filter(id=>id!==artifact.id);focusedArtifact=artifact.id;run(()=>control.select(selected));};
   }
   out.append(el('p',state.selected.length?`${state.selected.length} artifact${state.selected.length===1?'':'s'} selected`:'Source-only archive'));
   if(state.receipt)out.append(el('p',`Original export succeeded · ${state.receipt.reference.bytes.toLocaleString()} bytes`),el('code',state.receipt.reference.digest),el('code',state.original!.operation!));
  }else out.append(el('p','No export selected. Choose an installed revision.'));
  const filename=get<HTMLInputElement>('export-filename');if(document.activeElement!==filename)filename.value=state?.filename??'';filename.disabled=blocked||!state;
  get<HTMLButtonElement>('source-only-export').disabled=blocked||!state||!!state.receipt;
  get<HTMLButtonElement>('prepare-export').disabled=blocked||!state||!!state.receipt;
  get<HTMLButtonElement>('download-export').disabled=blocked||!state?.receipt;
  get<HTMLButtonElement>('inspect-export').disabled=busy()||!state?.receipt;
  get<HTMLButtonElement>('discard-export').disabled=blocked||!state;
  if(focusedArtifact&&!busy()){
   const target=[...out.querySelectorAll<HTMLInputElement>('input[data-export-artifact]')].find(input=>input.dataset.exportArtifact===focusedArtifact);
   if(target&&!target.disabled)target.focus({preventScroll:true});focusedArtifact=null;
  }
 }
 return{open,render};
}
