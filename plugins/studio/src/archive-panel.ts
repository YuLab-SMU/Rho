import type {Studio} from './model.js';
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const value=document.createElement(tag);value.textContent=text;return value;};
export function archivePanel(studio:Studio,run:(work:()=>Promise<unknown>)=>void,changed:()=>void,busy:()=>boolean,blocked:()=>boolean){
 const archives=studio.archives;let focusArtifact:string|null=null;
 get('archives').onclick=()=>{render();get<HTMLDialogElement>('archive-dialog').showModal();};
 get('close-archives').onclick=()=>get<HTMLDialogElement>('archive-dialog').close();
 get<HTMLInputElement>('archive-file').onchange=()=>run(async()=>{
  const input=get<HTMLInputElement>('archive-file'),file=input.files?.[0];if(!file)return;
  try{await archives.upload.choose(file,file.name);}finally{input.value='';}
 });
 get('stage-archive').onclick=()=>run(()=>archives.upload.stage(received=>{get('archive-progress').textContent=`${received.toLocaleString()} of ${archives.data.upload!.reference.bytes.toLocaleString()} bytes uploaded`;}));
 get('inspect-upload').onclick=()=>run(()=>archives.upload.inspect());
 get('import-archive').onclick=()=>run(()=>archives.import());
 get('inspect-import').onclick=()=>run(async()=>{await archives.inspectImport();get('archive-import-status').textContent='Original import result confirmed.';});
 get('open-imported').onclick=()=>run(async()=>{
  const revision=archives.data.upload?.imported?.revision;if(!revision)throw Error('Import the retained archive first.');
  await studio.select(revision);get<HTMLDialogElement>('archive-dialog').close();
 });
 get('discard-upload').onclick=()=>run(async()=>{await archives.upload.discard();get('archive-import-status').textContent='';});
 get('configure-export').onclick=()=>run(async()=>{if(!studio.document)throw Error('Choose a source checkpoint first.');await archives.configureExport(studio.document.data.revision);});
 get('source-only-export').onclick=()=>run(()=>archives.exported.select([]));
 get('prepare-export').onclick=()=>run(()=>archives.exported.prepare());
 get('download-export').onclick=()=>run(async()=>{await archives.exported.download();get('archive-download-status').textContent='Browser download requested. File saving is controlled by your browser.';});
 get('inspect-export').onclick=()=>run(async()=>{await archives.exported.inspect();get('archive-download-status').textContent='Original export result confirmed.';});
 get('discard-export').onclick=()=>run(async()=>{await archives.exported.discard();get('archive-download-status').textContent='';});
 get<HTMLInputElement>('archive-filename').oninput=()=>{if(blocked()||archives.data.pending||!archives.data.exported)return;archives.data.exported.filename=get<HTMLInputElement>('archive-filename').value;changed();};
 get('recover-archive').onclick=()=>run(()=>archives.recover());
 get('retry-archive').onclick=()=>run(()=>archives.dispatch());
 function render(){
  const {upload,exported,pending}=archives.data,locked=blocked()||!!pending;
  get<HTMLButtonElement>('archives').disabled=busy();
  get('archive-summary').hidden=!pending;
  get('archive-summary').textContent=pending?'An archive request is unconfirmed. Open Import / export to inspect its original result.':'';
  get('archive-progress').textContent=upload?`${upload.name} · ${upload.received.toLocaleString()} of ${upload.reference.bytes.toLocaleString()} bytes uploaded`:'No archive selected.';
  const details=get('archive-inspection');details.replaceChildren();
  if(upload){details.append(el('code',upload.reference.digest));if(!archives.upload.fileAvailable&&!upload.inspection)details.append(el('p','Reselect the identical file to resume.'));
   if(upload.inspection){const item=upload.inspection;details.append(el('h3',item.name),el('p',`${item.plugin} · ${item.version}`),el('p',item.description),el('code',item.revision),el('p',`${item.source_files} source file${item.source_files===1?'':'s'} · ${item.artifacts.length} artifact${item.artifacts.length===1?'':'s'}`));}
   if(upload.imported)details.append(el('p','Original import succeeded. Open its source explicitly to begin editing.'),el('code',upload.original!.operation!));
  }
  get<HTMLInputElement>('archive-file').disabled=locked||!!upload?.imported;
  get<HTMLButtonElement>('stage-archive').disabled=locked||!archives.upload.fileAvailable||!!upload?.inspection||!!upload?.imported;
  get<HTMLButtonElement>('inspect-upload').disabled=busy()||!upload;
  get<HTMLButtonElement>('import-archive').disabled=locked||!upload?.inspection||!!upload.imported;
  get<HTMLButtonElement>('inspect-import').disabled=busy()||!upload?.imported;
  get<HTMLButtonElement>('open-imported').disabled=locked||!upload?.imported||!!studio.document?.dirty;
  get<HTMLButtonElement>('discard-upload').disabled=locked||!upload;
  get('archive-open-help').textContent=studio.document?.dirty?'Checkpoint current edits before opening imported source.':'Importing keeps the current editor, scenario and running instances unchanged.';
  const output=get('archive-export-details');output.replaceChildren();
  get('archive-checkpoint').textContent=studio.document?`Current checkpoint: ${studio.document.data.revision}${studio.document.dirty?' · unsaved source changes are excluded':''}`:'Choose a source checkpoint to export.';
  if(exported){output.append(el('h3',exported.name),el('p',exported.plugin),el('code',exported.revision));
   for(const artifact of exported.artifacts){const label=el('label'),input=el('input'),text=el('span',artifact.target);input.type='checkbox';input.checked=exported.selected.includes(artifact.id);input.disabled=locked||!!exported.receipt;input.dataset.archiveArtifact=artifact.id;
    text.append(el('code',artifact.id));label.className='archive-artifact';label.append(input,text);output.append(label);
    input.onchange=()=>{const ids=input.checked?[...exported.selected,artifact.id]:exported.selected.filter(id=>id!==artifact.id);focusArtifact=artifact.id;run(()=>archives.exported.select(ids));};
   }
   output.append(el('p',exported.selected.length?`${exported.selected.length} artifact${exported.selected.length===1?'':'s'} selected`:'Source-only archive'));
   if(exported.receipt)output.append(el('p',`Original export succeeded · ${exported.receipt.reference.bytes.toLocaleString()} bytes`),el('code',exported.receipt.reference.digest),el('code',exported.original!.operation!));
  }
  get<HTMLButtonElement>('configure-export').disabled=locked||!studio.document||!!exported;
  get<HTMLButtonElement>('source-only-export').disabled=locked||!exported||!!exported.receipt;
  get<HTMLButtonElement>('prepare-export').disabled=locked||!exported||!!exported.receipt;
  get<HTMLButtonElement>('download-export').disabled=locked||!exported?.receipt;
  get<HTMLButtonElement>('inspect-export').disabled=busy()||!exported?.receipt;
  get<HTMLButtonElement>('discard-export').disabled=locked||!exported;
  const filename=get<HTMLInputElement>('archive-filename');filename.disabled=locked||!exported;if(document.activeElement!==filename)filename.value=exported?.filename??'';
  get('archive-pending').hidden=!pending;get('archive-request').textContent=pending?`${pending.capability.id}\n${pending.operation??pending.request}`:'';
  get<HTMLButtonElement>('recover-archive').disabled=busy();get<HTMLButtonElement>('retry-archive').disabled=busy()||studio.drafts.unresolved||pending?.view!==studio.client.view.view;
  if(focusArtifact&&!busy()){const input=Array.from(output.querySelectorAll<HTMLInputElement>('input[data-archive-artifact]')).find(item=>item.dataset.archiveArtifact===focusArtifact);if(input&&!input.disabled)input.focus({preventScroll:true});focusArtifact=null;}
 }
 return render;
}
