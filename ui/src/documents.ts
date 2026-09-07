import { EditorState } from '@codemirror/state';
import type { Transaction } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { Studio } from './studio';
import { message } from './host-client';
import type { FilePage } from './generated/FilePage';
import type { ProjectSnapshot } from './generated/ProjectSnapshot';
import type { ProjectPatchResult } from './generated/ProjectPatchResult';
import type { RunROutput } from './generated/RunROutput';
import type { FormatResult } from './generated/FormatResult';

export const MAX_EDIT_BYTES=512*1024;
export const normalizeText=(raw:string)=>raw.replace(/\r\n|\r/g,'\n');
export const bytes=(text:string)=>new TextEncoder().encode(text);
export async function sha256(text:string){return 'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export function validatePath(path:string){if(!path || bytes(path).length>1024 || /[\\\x00-\x1f\x7f:]/u.test(path) || path.startsWith('/') || path.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git'))throw new Error('路径必须是项目内的相对文件路径，不能包含 .git 或 ..');}
const quotePath=(path:string)=>`"${path.replace(/"/g,'\\"')}"`;
export function filePatch(path:string,before:string|null,after:string):string{
  validatePath(path);
  const a=quotePath('a/'+path),b=quotePath('b/'+path);
  const hunks=createTwoFilesPatch(before===null?'/dev/null':'a/'+path,'b/'+path,before??'',after,'','',{context:3,stripTrailingCr:false,timeout:1000,maxEditLength:20000,headerOptions:FILE_HEADERS_ONLY});
  if(hunks===undefined)throw new Error('差异过大，未生成补丁；草稿已保留');
  const patch=`diff --git ${a} ${b}\n${before===null?'new file mode 100644\n':''}${hunks}`;
  if(bytes(patch).length>200*1024)throw new Error('保存补丁超过 200 KiB 上限；草稿已保留，未写入文件');
  return patch;
}
function rawOffset(raw:string,offset:number){let position=0;for(let count=0;count<offset && position<raw.length;count++,position++){if(raw[position]==='\r'&&raw[position+1]==='\n')position++;}return position;}
export interface Draft {
  id:string; path:string|null; raw:string; bom:boolean; eol:string; baseRaw:string|null; baseHash:string|null;
  readonly:string|null; byteSize:number; anchor:number; head:number; scrollTop:number; scrollLeft:number;
}
export class DocumentModel {
  state:EditorState;
  saving=false;
  error='';
  comparison: {before:string;formatted:string}|null=null;
  diskComparison: {raw:string;hash:string}|null=null;
  constructor(public draft:Draft){this.state=EditorState.create({doc:normalizeText(draft.raw),selection:{anchor:Math.min(draft.anchor,normalizeText(draft.raw).length),head:Math.min(draft.head,normalizeText(draft.raw).length)},extensions:[history()]});}
  get id(){return this.draft.id;}get path(){return this.draft.path;}get name(){return this.path?.split('/').at(-1)??'未命名.R';}
  get raw(){return (this.draft.bom?'\uFEFF':'')+this.draft.raw;}
  get dirty(){return this.draft.baseRaw!==this.raw;}
  update(transaction:Transaction){
    if(transaction.docChanged){let value='',end=0;const raw=this.draft.raw;
      transaction.changes.iterChanges((from,to,_fromB,_toB,inserted)=>{value+=raw.slice(end,rawOffset(raw,from))+inserted.toString().replace(/\n/g,this.draft.eol);end=rawOffset(raw,to);});
      this.draft.raw=value+raw.slice(end);
    }
    this.state=transaction.state;this.draft.anchor=this.state.selection.main.anchor;this.draft.head=this.state.selection.main.head;
  }
  replace(text:string){this.update(this.state.update({changes:{from:0,to:this.state.doc.length,insert:normalizeText(text)},selection:{anchor:0}}));}
}
export class Documents {
  items=new Map<string,DocumentModel>();
  active:string|null=null;
  constructor(private studio:Studio){}
  get current(){return this.active?this.items.get(this.active)??null:null;}
  serialize(){return {active:this.active,items:[...this.items.values()].map(d=>d.draft)};}
  restore(value:unknown){this.items.clear();this.active=null;if(!value || typeof value!=='object')return;const data=value as {active?:string;items?:Draft[]};
    if(!Array.isArray(data.items))return;
    for(const raw of data.items.slice(0,64)){
      if(typeof raw.id!=='string'||typeof raw.raw!=='string'||typeof raw.baseRaw!=='string'&&raw.baseRaw!==null||bytes(raw.raw).length>MAX_EDIT_BYTES*2)continue;
      try{if(raw.path)validatePath(raw.path);const draft={...raw,eol:['\n','\r\n','\r'].includes(raw.eol)?raw.eol:'\n',anchor:Number.isSafeInteger(raw.anchor)&&raw.anchor>=0?raw.anchor:0,head:Number.isSafeInteger(raw.head)&&raw.head>=0?raw.head:0};this.items.set(draft.id,new DocumentModel(draft));}catch{this.studio.error='部分草稿状态损坏，未自动覆盖项目文件。';}
    }
    this.active=data.active&&this.items.has(data.active)?data.active:null;
  }
  changed(){this.studio.persist();this.studio.emit();}
  focus(document:DocumentModel){this.active=document.id;this.studio.showPanel?.('document',document.id,document.name,{documentId:document.id});this.changed();}
  create(){const document=new DocumentModel({id:crypto.randomUUID(),path:null,raw:'',bom:false,eol:'\n',baseRaw:null,baseHash:null,readonly:null,byteSize:0,anchor:0,head:0,scrollTop:0,scrollLeft:0});this.items.set(document.id,document);this.focus(document);return document;}
  async open(path:string,byteSize?:number){
    validatePath(path);const existing=[...this.items.values()].find(d=>d.path===path);if(existing){this.focus(existing);return existing;}
    const project=this.studio.project;if(!project)throw new Error('先打开项目');
    let raw='',baseRaw:string|null=null,hash:string|null=null,bom=false,readonly:string|null=null,size=byteSize??0;
    if(size>MAX_EDIT_BYTES)readonly=`文件为 ${(size/1048576).toFixed(1)} MiB；编辑上限为 512 KiB。未读取或修改完整文件。`;
    else {
      const collected:number[]=[];let offset=0;
      do {
        const snapshot=await this.studio.client.query(project,'project.read_file',{path,offset,limit_bytes:65536,expected_sha256:hash});
        if(snapshot.status!=='ready')throw new Error(snapshot.notices.join('\n'));
        const page=snapshot.data as FilePage;
        if(page.offset!==offset || page.file.path!==path || (hash && hash!==page.file.sha256))throw new Error('文件在读取期间发生变化；请重新打开');
        hash=page.file.sha256;size=page.file.byte_size;
        if(size>MAX_EDIT_BYTES){readonly='文件超过 512 KiB 编辑上限。未读取完整内容。';break;}
        collected.push(...page.bytes);offset+=page.bytes.length;
        if(!page.has_more)break;if(!page.bytes.length)throw new Error('文件读取未取得进展');
      }while(offset<MAX_EDIT_BYTES);
      if(!readonly){try{const data=new Uint8Array(collected);bom=data[0]===239&&data[1]===187&&data[2]===191;const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);if(text.includes('\0'))throw new Error('binary');baseRaw=text;raw=bom?text.slice(1):text;}catch{readonly='二进制或非 UTF-8 文件；仅显示有界字节预览。';raw=collected.slice(0,128).map(b=>b.toString(16).padStart(2,'0')).join(' ');}}
    }
    if(project!==this.studio.project)throw new Error('项目已切换');
    const document=new DocumentModel({id:crypto.randomUUID(),path,raw,bom,eol:raw.match(/\r\n|\r|\n/)?.[0]??'\n',baseRaw,baseHash:hash,readonly,byteSize:size,anchor:0,head:0,scrollTop:0,scrollLeft:0});
    this.items.set(document.id,document);this.focus(document);return document;
  }
  canSave(document:DocumentModel){return !!this.studio.project&&this.studio.connected&&!document.saving&&!document.draft.readonly&&!this.studio.busy&&!this.studio.pending.length;}
  canRun(document:DocumentModel){return this.studio.canRun&&!document.saving&&!document.draft.readonly;}
  async save(document:DocumentModel,captured=document.raw,target=document.path,overwrite=false){
    if(!this.canSave(document))throw new Error('当前无法保存');if(!target)throw new Error('新文件需要先另存为');validatePath(target);
    const project=this.studio.project!;document.saving=true;document.error='';this.studio.emit();
    try{
      if(bytes(captured).length>MAX_EDIT_BYTES)throw new Error('文本超过 512 KiB 编辑上限；草稿已保留');
      let baseRaw=document.draft.baseRaw,baseHash=document.draft.baseHash;
      if(target!==document.path){
        if([...this.items.values()].some(d=>d!==document&&d.path===target))throw new Error('目标文件已在另一个文档中打开');
        const snapshot=await this.studio.client.query(project,'project.snapshot',{paths:[target],limit:1});
        if(snapshot.status!=='ready')throw new Error(snapshot.notices.join('\n'));
        const file=(snapshot.data as ProjectSnapshot).files[0];
        if(file.kind!=='absent'){
          if(!overwrite)throw new Error('目标已存在。确认替换后再保存，或选择新路径。');
          const page=await this.studio.client.query(project,'project.read_file',{path:target,offset:0,limit_bytes:65536,expected_sha256:file.sha256});
          if(page.status!=='ready')throw new Error(page.notices.join('\n'));
          // Existing Save As targets use the same bounded, digest-checked reader.
          let offset=0;const content:number[]=[];let current=page.data as FilePage;
          do{content.push(...current.bytes);offset+=current.bytes.length;if(offset>MAX_EDIT_BYTES)throw new Error('另存为目标超过编辑范围');if(!current.has_more)break;const next=await this.studio.client.query(project,'project.read_file',{path:target,offset,limit_bytes:65536,expected_sha256:file.sha256});if(next.status!=='ready')throw new Error(next.notices.join('\n'));current=next.data as FilePage;}while(offset<MAX_EDIT_BYTES);
          if(current.has_more)throw new Error('另存为目标超过编辑范围');
          baseRaw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(new Uint8Array(content));baseHash=file.sha256;
        }else{baseRaw=null;baseHash=null;}
      }
      const expected=await sha256(captured);
      if(baseRaw===captured && baseHash){
        const observed=await this.studio.client.query(project,'project.read_file',{path:target,offset:0,limit_bytes:1,expected_sha256:baseHash});
        if(observed.status!=='ready' || (observed.data as FilePage).file.sha256!==expected)throw new Error('磁盘内容已变化；保存未确认');
      }else{
        const patch=filePatch(target,baseRaw,captured);
        const record=await this.studio.invoke('project.apply_patch',{patch},[{kind:'file.sha256',subject:target,expected:baseHash}]);
        if(record.status!=='succeeded')throw new Error(record.error??`保存${record.status}`);
        const result=record.output as ProjectPatchResult;
        const actual=result.after.files.find(file=>file.path===target);
        if(actual?.sha256!==expected)throw new Error('保存后的真实文件摘要不匹配；运行已停止');
      }
      document.draft.path=target;document.draft.baseRaw=captured;document.draft.baseHash=expected;document.draft.byteSize=bytes(captured).length;
      this.changed();return captured;
    }catch(error){document.error=message(error);this.changed();throw error;}
    finally{document.saving=false;this.studio.emit();}
  }
  async runFile(document:DocumentModel,captured=document.raw,target=document.path,overwrite=false){
    if(!this.canRun(document))throw new Error('当前无法运行文件');
    const saved=await this.save(document,captured,target,overwrite);
    // Dispatch this exact captured snapshot only after authoritative save verification.
    if(!this.studio.connected)throw new Error('连接中断；保存后没有执行');
    await this.studio.invoke('workspace.run_r',{code:saved});
  }
  async runSelection(document:DocumentModel){if(!this.canRun(document))return;const selection=document.state.selection.main;const code=selection.empty?document.state.doc.lineAt(selection.head).text:document.state.sliceDoc(selection.from,selection.to);if(code.trim())await this.studio.run(code);}
  async format(document:DocumentModel){
    if(!this.canRun(document))return;const captured=document.state.doc.toString();
    const record=await this.studio.invoke('workspace.format',{code:captured});
    if(record.status!=='succeeded')throw new Error(record.error??'格式化失败');
    const result=(record.output as RunROutput).value as FormatResult;
    if(typeof result.code!=='string')throw new Error('格式化结果缺少文本');
    if(document.state.doc.toString()===captured)document.replace(result.code);else document.comparison={before:captured,formatted:result.code};
    this.changed();
  }
  async compareDisk(document:DocumentModel){
    if(!this.studio.project||!document.path)throw new Error('文档尚未保存到文件');
    let offset=0,hash:string|null=null;const content:number[]=[];
    do {
      const observed=await this.studio.client.query(this.studio.project,'project.read_file',{path:document.path,offset,limit_bytes:65536,expected_sha256:hash});
      if(observed.status!=='ready')throw new Error(observed.notices.join('\n'));
      const page=observed.data as FilePage;if(page.file.byte_size>MAX_EDIT_BYTES)throw new Error('磁盘文件超过编辑范围');
      hash=page.file.sha256;content.push(...page.bytes);offset+=page.bytes.length;
      if(!page.has_more)break;if(!page.bytes.length)throw new Error('未能完整读取磁盘内容');
    }while(offset<MAX_EDIT_BYTES);
    const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(new Uint8Array(content));
    if(raw.includes('\0')||!hash)throw new Error('磁盘内容不支持文本比较');
    document.diskComparison={raw,hash};this.studio.emit();
  }
  acceptDiskBase(document:DocumentModel,useDisk:boolean){
    const comparison=document.diskComparison;if(!comparison)return;
    document.draft.baseHash=comparison.hash;document.draft.baseRaw=comparison.raw;
    if(useDisk){document.draft.bom=comparison.raw.startsWith('\uFEFF');document.draft.eol=comparison.raw.match(/\r\n|\r|\n/)?.[0]??'\n';document.replace(comparison.raw.replace(/^\uFEFF/,''));}
    document.diskComparison=null;document.error='';this.changed();
  }
  discard(document:DocumentModel){if(document.saving)throw new Error('保存期间不能丢弃文档');this.items.delete(document.id);if(this.active===document.id)this.active=null;this.changed();}
}
