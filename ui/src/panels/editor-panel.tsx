import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { r } from '@codemirror/legacy-modes/mode/r';
import { useStudio } from '../context';
import { Modal } from '../primitives';
import { message } from '../host-client';
import type { DocumentModel } from '../documents';

export function EditorHub(){const s=useStudio();return <section className="panel editor-hub"><div className="editor-toolbar"><button className="primary" onClick={()=>s.documents.create()}>＋ 新建 R 文件</button><button onClick={()=>s.showPanel?.('files')}>打开文件</button></div><div className="empty"><h2>从一份脚本开始</h2><p>⌘ S 保存 · ⌘ Enter 运行选段 / 当前行</p><p>⌘ ⇧ Enter 保存并运行文件</p>{!!s.documents.items.size && <div className="document-list">{[...s.documents.items.values()].map(d=><button key={d.id} onClick={()=>s.documents.focus(d)}>{d.name}{d.dirty&&!d.draft.readonly?' · 未保存':''}</button>)}</div>}</div></section>;}

function CodeEditor({document,onSave,onRunFile}:{document:DocumentModel;onSave:()=>void;onRunFile:()=>void}){
  const s=useStudio(),parent=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),actions=useRef({onSave,onRunFile});actions.current={onSave,onRunFile};
  useEffect(()=>{
    const nonce=globalThis.document.querySelector<HTMLMetaElement>('meta[name=rho-csp-nonce]')?.content??'';
    const extensions=[history(),lineNumbers(),highlightActiveLine(),highlightSpecialChars(),drawSelection(),indentOnInput(),bracketMatching(),closeBrackets(),highlightSelectionMatches(),syntaxHighlighting(defaultHighlightStyle),StreamLanguage.define(r),EditorState.tabSize.of(4),indentUnit.of('    '),EditorView.cspNonce.of(nonce),EditorState.readOnly.of(!!document.draft.readonly),EditorView.contentAttributes.of({'aria-label':`代码编辑器 ${document.name}`}),
      keymap.of([
        {key:'Mod-s',run:()=>{actions.current.onSave();return true;}},
        {key:'Mod-Shift-Enter',run:()=>{actions.current.onRunFile();return true;}},
        {key:'Mod-Enter',run:()=>{void s.documents.runSelection(document).catch(e=>{document.error=message(e);s.emit();});return true;}},
        ...closeBracketsKeymap,...defaultKeymap,...historyKeymap,...searchKeymap,indentWithTab,
      ]),
      EditorView.domEventHandlers({focus:()=>{s.documents.active=document.id;s.emit();},scroll:(_event,v)=>{document.draft.scrollTop=v.scrollDOM.scrollTop;document.draft.scrollLeft=v.scrollDOM.scrollLeft;s.persist();}}),
    ];
    document.state=document.state.update({effects:StateEffect.reconfigure.of(extensions)}).state;
    const editor=new EditorView({parent:parent.current!,state:document.state,dispatchTransactions(transactions,v){for(const transaction of transactions)document.update(transaction);v.update(transactions);s.documents.changed();}});
    view.current=editor;
    const frame=requestAnimationFrame(()=>{editor.scrollDOM.scrollTop=document.draft.scrollTop;editor.scrollDOM.scrollLeft=document.draft.scrollLeft;});
    return()=>{cancelAnimationFrame(frame);document.draft.scrollTop=editor.scrollDOM.scrollTop;document.draft.scrollLeft=editor.scrollDOM.scrollLeft;editor.destroy();view.current=null;};
  },[s,document.id]);
  useEffect(()=>{if(view.current && view.current.state!==document.state)view.current.setState(document.state);});
  return <div className="code-editor" ref={parent}/>;
}
export function DocumentPanel({documentId}:{documentId:string}){
  const s=useStudio(),document=s.documents.items.get(documentId);
  const [saveAs,setSaveAs]=useState<{captured:string;run:boolean}|null>(null),[path,setPath]=useState(''),[overwrite,setOverwrite]=useState(false),[confirmDiscard,setConfirmDiscard]=useState(false);
  if(!document)return <div className="empty"><p>文档已丢弃或无法恢复。</p><button onClick={()=>s.showPanel?.('editor')}>打开编辑器</button></div>;
  const d=document;
  function attempt(work:()=>Promise<unknown>){d.error='';void work().catch(e=>{d.error=message(e);s.emit();});}
  function save(){if(!s.documents.canSave(d))return;if(!d.path){setPath(d.name);setSaveAs({captured:d.raw,run:false});}else attempt(()=>s.documents.save(d));}
  function runFile(){if(!s.documents.canRun(d))return;const captured=d.raw;if(!d.path){setPath(d.name);setSaveAs({captured,run:true});}else attempt(()=>s.documents.runFile(d,captured));}
  const selection=d.state.selection.main,line=d.state.doc.lineAt(selection.head);
  return <section className="panel document-panel" data-document-id={d.id}>
    <div className="editor-toolbar"><button className="primary" disabled={!s.documents.canRun(d)} onClick={()=>attempt(()=>s.documents.runSelection(d))}>▷ <span className="run-label">{selection.empty?'运行当前行':'运行选中'}</span></button><kbd className="editor-shortcut">⌘ Enter</kbd><button disabled={!s.documents.canRun(d)} onClick={runFile}>运行文件</button>
      <button className="editor-secondary" disabled={!s.documents.canRun(d)} onClick={()=>attempt(()=>s.documents.format(d))}>格式化</button><button className="editor-secondary" disabled={!s.documents.canSave(d)} onClick={save}>保存</button>
      <div className="spacer"/><span className="save-status">{d.saving?'保存中…':d.draft.readonly?'只读':d.dirty?'未保存':'✓ 已保存'}</span>
      <details className="editor-menu"><summary aria-label="文档操作">•••</summary><div className="menu"><button disabled={!s.documents.canSave(d)} onClick={save}>保存 ⌘ S</button><button disabled={!s.documents.canSave(d)} onClick={()=>{setPath(d.path??d.name);setOverwrite(false);setSaveAs({captured:d.raw,run:false});}}>另存为…</button><button disabled={!s.documents.canRun(d)} onClick={()=>attempt(()=>s.documents.format(d))}>格式化</button><button disabled={!d.path||d.saving} onClick={()=>attempt(()=>s.documents.compareDisk(d))}>比较磁盘 / 重新载入…</button><button onClick={()=>setConfirmDiscard(true)}>丢弃文档…</button></div></details>
    </div>
    {d.error && <div className="document-error" role="alert">{d.error}{d.path && <button onClick={()=>attempt(()=>s.documents.compareDisk(d))}>比较磁盘</button>}</div>}
    {d.draft.readonly && <div className="document-error">{d.draft.readonly}<br/>{d.path} · {d.draft.byteSize.toLocaleString()} bytes</div>}
    <CodeEditor document={d} onSave={save} onRunFile={runFile}/>
    <div className="panel-footer"><span>行 {line.number}, 列 {selection.head-line.from+1}</span><span>R　UTF-8{d.draft.bom?' BOM':''}　{d.draft.eol==='\r\n'?'CRLF':d.draft.eol==='\r'?'CR':'LF'}　4 空格</span></div>
    {saveAs && <Modal title={saveAs.run?'保存并运行文件':'另存为'} description="使用项目内的相对路径。保存结果未确认时不会执行。" onClose={()=>setSaveAs(null)}><form onSubmit={e=>{e.preventDefault();const snapshot=saveAs;attempt(async()=>{if(snapshot.run)await s.documents.runFile(d,snapshot.captured,path,overwrite);else await s.documents.save(d,snapshot.captured,path,overwrite);setSaveAs(null);s.documents.focus(d);});}}><label>文件路径<input autoFocus value={path} onChange={e=>setPath(e.target.value)} placeholder="analysis.R"/></label><label className="checkbox"><input type="checkbox" checked={overwrite} onChange={e=>setOverwrite(e.target.checked)}/>目标已存在时，确认替换其内容</label>{d.error && <p className="error">{d.error}</p>}<button className="primary" disabled={d.saving}>{saveAs.run?'保存并运行':'保存'}</button></form></Modal>}
    {confirmDiscard && <Modal title="丢弃文档" description={d.dirty?'文档有未保存修改。关闭面板会保留草稿；丢弃文档会移除这份草稿。':'从打开的文档中移除；磁盘文件仍保留。'} onClose={()=>setConfirmDiscard(false)}><button disabled={d.saving} onClick={()=>{if(d.dirty&&!d.draft.readonly)save();setConfirmDiscard(false);}}>先保存</button><button className="danger" disabled={d.saving} onClick={()=>{s.documents.discard(d);setConfirmDiscard(false);}}>放弃草稿并丢弃文档</button></Modal>}
    {d.diskComparison && <Modal title="本地草稿与磁盘内容" description="请检查差异。继续保留本地时，下次保存会使用此次观察到的磁盘摘要；不会自动运行。" onClose={()=>{d.diskComparison=null;s.emit();}}><div className="comparison"><div>本地草稿<pre>{d.raw}</pre></div><div>磁盘文件<pre>{d.diskComparison.raw}</pre></div></div><button onClick={()=>s.documents.acceptDiskBase(d,true)}>载入磁盘内容</button><button onClick={()=>s.documents.acceptDiskBase(d,false)}>确认保留本地，以此磁盘版本为基础</button></Modal>}
    {d.comparison && <Modal title="格式化期间文档已改变" description="当前编辑已保留。下方是请求时文本和格式化结果。" onClose={()=>{d.comparison=null;s.emit();}}><div className="comparison"><pre>{d.comparison.before}</pre><pre>{d.comparison.formatted}</pre></div><button onClick={()=>{d.replace(d.comparison!.formatted);d.comparison=null;s.documents.changed();}}>采用格式化结果（可撤销）</button></Modal>}
  </section>;
}
