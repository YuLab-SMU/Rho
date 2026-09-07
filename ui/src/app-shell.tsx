import { useEffect, useRef, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Actions } from 'flexlayout-react';
import { message } from './host-client';
import { Modal } from './primitives';
import { DocumentPanel, EditorHub } from './panels/editor-panel';
import { FilesPanel, ObjectsPanel, ObjectViewer } from './panels/resource-panels';
import { useStudio } from './context';
import { ConsolePanel, PlotPanel } from './panels/output-panels';
import { LayoutHost, PanelLayout, defaultLayout, panelNames } from './layout-host';
import type { RProbe } from './generated/RProbe';

function ProjectDialog({onClose}:{onClose:()=>void}) {
  const s=useStudio(),[path,setPath]=useState(s.project ?? ''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function open(value:string) { setBusy(true);try {await s.selectProject(value);onClose();}catch(e){setError(message(e));}finally{setBusy(false);} }
  return <Modal title="打开项目" description="选择本机项目目录。切换项目会结束当前 R 会话内存。" onClose={onClose}>
    <form onSubmit={e=>{e.preventDefault();void open(path);}}><label>项目绝对路径<input autoFocus value={path} onChange={e=>setPath(e.target.value)} placeholder="/Users/…/project"/></label><button className="primary" disabled={busy || !path.trim()}>打开项目</button></form>
    {error && <p role="alert" className="error">{error}</p>}
    {!!s.recent.length && <><h3>最近项目</h3><div className="recent">{s.recent.map(p=><button key={p} disabled={busy} onClick={()=>void open(p)}>{p}</button>)}</div></>}
  </Modal>;
}
function SettingsDialog({onClose}:{onClose:()=>void}) {
  const s=useStudio(),[selection,setSelection]=useState(s.r?.current?.selection ?? s.r?.candidates[0] ?? {executable:'',ark:''});
  const [probe,setProbe]=useState<RProbe|null>(s.r?.current ?? null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function check() {setBusy(true);setError('');try{setProbe(await s.client.probeR(selection));}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function apply() {setBusy(true);setError('');try{s.r=await s.client.applyR(selection,confirmed);await s.refreshInfo();setError(s.r?.error ?? '');}catch(e){setError(message(e));}finally{setBusy(false);}}
  return <Modal title="本机 R 配置" description="使用已安装的 R 与 Ark；不会自动下载或安装依赖。" onClose={onClose}>
    {!!s.r?.candidates.length && <label>发现的 R<select value={selection.executable} onChange={e=>{const next=s.r!.candidates.find(c=>c.executable===e.target.value);if(next){setSelection(next);setProbe(null);}}}>{s.r.candidates.map(c=><option key={c.executable}>{c.executable}</option>)}</select></label>}
    <label>R 可执行文件<input value={selection.executable} onChange={e=>{setSelection({...selection,executable:e.target.value});setProbe(null);}}/></label>
    <label>Ark 可执行文件<input value={selection.ark} onChange={e=>{setSelection({...selection,ark:e.target.value});setProbe(null);}}/></label>
    <button disabled={busy} onClick={()=>void check()}>探测配置</button>
    {probe && <div className="probe"><p>R {probe.version ?? '未知'} · {probe.architecture ?? '未知'}</p><p>{probe.r_home}</p><p>jsonlite {probe.jsonlite?'可用':'缺失'} · rlang {probe.rlang?'可用':'缺失'} · Ark {probe.ark_available?'可用':'缺失'}</p>{probe.diagnostics.map((d,i)=><p key={i}>{d}</p>)}</div>}
    {s.project && <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认结束当前 R 会话内存并重启</label>}
    <button className="primary" disabled={busy || !probe?.usable || (!!s.project && !confirmed)} onClick={()=>void apply()}>应用并启动 R</button>
    {error && <p className="error" role="alert">{error}</p>}
  </Modal>;
}
export function AppShell() {
  const s=useStudio(),[dialog,setDialog]=useState<'project'|'settings'|'commands'|null>(null),layout=useRef<PanelLayout|null>(null);
  const [resetKey,setResetKey]=useState(0);
  useEffect(()=>{void s.start();const leave=(e:BeforeUnloadEvent)=>{if(s.unsynced){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',leave);return()=>{s.stop();window.removeEventListener('beforeunload',leave);};},[s]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setDialog('commands');}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  function reset(){s.layout=defaultLayout();s.persist();setResetKey(k=>k+1);}
  return <div className="app-shell">
    <header className="topbar"><strong className="wordmark">rho</strong><span className="divider"/><button className="project-button" onClick={()=>setDialog('project')}>▱ <span>{s.project?.split('/').at(-1) ?? '打开项目'}</span><small>⌄</small></button><span className="muted">Studio</span><div className="spacer"/>
      <Menu.Root><Menu.Trigger className="bordered">▦ 组件</Menu.Trigger><Menu.Portal><Menu.Content className="menu" sideOffset={6}>{Object.entries(panelNames).map(([id,name])=><Menu.Item key={id} onSelect={()=>layout.current?.show(id)}>{name}</Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root>
      <button className="secondary" onClick={reset}>恢复默认</button><button className="bordered" aria-label="命令入口" onClick={()=>setDialog('commands')}>⌕ <kbd>⌘ K</kbd></button>
    </header>
    <div className="work-area"><nav className="rail" aria-label="主导航"><button className="active" title="Studio" aria-label="Studio" onClick={()=>layout.current?.show('editor')}>▦</button><button title="项目文件" aria-label="项目文件" onClick={()=>layout.current?.show('files')}>▤</button><button title="组件" aria-label="组件" onClick={()=>setDialog('commands')}>⊞</button><div className="spacer"/><button aria-label="设置" onClick={()=>setDialog('settings')}>☷</button></nav>
      {s.project ? <LayoutHost key={`${s.project}:${resetKey}`} studio={s} onLayout={l=>{layout.current=l;s.showPanel=(component,id,name,config)=>l.show(component,id,name,config);}} registry={node=>{
        switch(node.getComponent()) {
          case 'console':return <ConsolePanel/>;
          case 'plots':return <PlotPanel/>;
          case 'editor':return <EditorHub/>;
          case 'document':return <DocumentPanel documentId={node.getId()}/>;
          case 'files':return <FilesPanel/>;
          case 'objects':return <ObjectsPanel/>;
          case 'viewer':return <ObjectViewer name={node.getConfig()?.name ?? ''}/>;
          default:return <div className="empty">组件不可用</div>;
        }
      }}/>
        : <main className="welcome"><div className="welcome-mark">rho</div><h1>你的本机科学工作空间</h1><p>打开项目，编辑 R 脚本，检查对象与图形。</p><button className="primary" onClick={()=>setDialog('project')}>打开项目</button><button onClick={()=>setDialog('settings')}>配置本机 R</button>{s.recent.map(p=><button key={p} onClick={()=>void s.selectProject(p).catch(e=>{s.error=message(e);s.emit();})}>{p}</button>)}</main>}
    </div>
    {(s.error || s.syncError) && <div className="notice" role="alert"><span>{s.syncError || s.error}</span>{s.syncError && <button onClick={()=>void s.flush()}>重试草稿同步</button>}<button aria-label="关闭提示" onClick={()=>{s.error='';s.emit();}}>×</button></div>}
    <footer className="statusbar"><button onClick={()=>setDialog('settings')}><i className={s.connected?'dot':'dot offline'}/>本机　R {s.r?.current?.version ?? '未配置'}</button><span>{s.connected?(s.busy?'运行中':s.runtime?.state==='idle'?'空闲':s.runtime?.state==='busy'?'运行中':'不可用'):'连接中断'}</span><span className="secondary" title={s.runtime?.notices.join("\n")}>内存 {s.runtime?.processes[0]?.memory_bytes == null ? "未知" : `${(s.runtime.processes[0].memory_bytes/1048576).toFixed(0)} MiB`}　CPU {s.runtime?.processes[0]?.cpu_percent == null ? "未知" : `${s.runtime.processes[0].cpu_percent.toFixed(1)}%`}</span><div className="spacer"/><span className="project-path">{s.project}</span><span>{s.unsynced?'草稿待同步':'草稿已同步'}</span><button onClick={()=>setDialog('settings')}>环境</button></footer>
    {dialog==='project' && <ProjectDialog onClose={()=>setDialog(null)}/>}{dialog==='settings' && <SettingsDialog onClose={()=>setDialog(null)}/>}
    {dialog==='commands' && <Modal title="命令与组件" description="打开组件或恢复默认工作区布局。" onClose={()=>setDialog(null)}><div className="command-list">{Object.entries(panelNames).map(([id,name])=><button key={id} onClick={()=>{layout.current?.show(id);setDialog(null);}}>{name}</button>)}<button onClick={()=>{reset();setDialog(null);}}>恢复默认布局</button><button onClick={()=>{const tabset=layout.current?.model.getActiveTabset();if(tabset)layout.current?.model.doAction(Actions.maximizeToggle(tabset.getId()));setDialog(null);}}>最大化 / 还原当前面板</button></div></Modal>}
  </div>;
}
