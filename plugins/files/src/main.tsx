import {componentInputDialog} from '../public/agent-input/dialog.js';
import {fileContext} from './agent-source.js';
import type {TextIdentity,TextPage} from '../sdk/index.js';
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { connectPluginView } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import { FilesConnection } from "./connection.js";
import { FilesActions } from "./actions.js";
import { FilesPanel } from "./files-panel.js";
import "./style.css";

function OpenFile({ close, open, disabled }: { close(): void; open(path: string): Promise<void>; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), [path, setPath] = useState(""), [error, setError] = useState(""), [working, setWorking] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = () => {
    if (disabled || working || !path) return;
    setWorking(true); setError("");
    void open(path).then(close).catch(error => setError(String(error))).finally(() => setWorking(false));
  };
  return <dialog ref={dialog} className="dialog" aria-labelledby="open-title" onCancel={event => { if (working) event.preventDefault(); else close(); }}>
    <h2 id="open-title">Open File</h2>
    <div className="open-file-form">
      <label>Path within this project<input autoFocus value={path} onChange={event => setPath(event.target.value)} disabled={disabled || working} placeholder="analysis.R"
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } }} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button type="button" disabled={working} onClick={close}>Cancel</button><button type="button" disabled={disabled || working || !path} onClick={submit}>Open</button></div>
    </div>
  </dialog>;
}
const root = createRoot(document.getElementById("root")!);
try {
  const client = await connectPluginView();
  if (client.view.contribution !== "files") throw new Error("The Files contribution is missing.");
  const configuration = client.view.configuration as unknown as { editor: InstanceRef | null; editor_group: string | null; runtime?: InstanceRef | null };
  // Files has one native observation lane. Counts, navigation and explicit
  // source capture share it so a quick hover followed by a click cannot race.
  let fileReads:Promise<unknown>=Promise.resolve();
  const query:typeof client.query=<T=unknown>(capability:Parameters<typeof client.query>[0],arguments_:Parameters<typeof client.query>[1]):Promise<T>=>{
    if(!capability.id.startsWith('files.'))return client.query<T>(capability,arguments_);
    const read=fileReads.then(()=>client.query<T>(capability,arguments_));
    fileReads=read.catch(()=>undefined);return read;
  };
  const connection = new FilesConnection({view:client.view,query,setState:client.setState.bind(client)});
  const actions = new FilesActions(client, connection, configuration.editor_group ?? null, configuration.editor ?? null, configuration.runtime ?? null);
  let closingSource=false, capturing=false, selectedSource:TextIdentity|null=null,noteObservation=0;
  const sender=componentInputDialog({client:{view:client.view,query,setState:client.setState.bind(client),invoke:client.invoke.bind(client),operation:client.operation.bind(client),control:client.control.bind(client)},saved:connection.savedAgent,persist:state=>connection.saveAgent(state),
    guard:()=>{if(closingSource)throw Error('Files is closing. The original request is retained.');},
    modes:[{value:'metadata',label:'File information'},{value:'text',label:'Text (up to 16 KiB)'}],capture:kind=>fileContext(connection.source,client.view.window,selectedSource,kind)});
  const closing = await client.installCloseHandler({
    async flush() { closingSource=true;if(sender.busy||capturing)throw Error("Wait for the current Agent request before closing."); await connection.pause(); await actions.settled(); await connection.flush(); },
    resume() { closingSource=false;connection.resume(); },
  });
  const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
  function App() {
    const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot), action = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
    const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot), [open, setOpen] = useState(false);
    const [askError,setAskError]=useState(''),[asking,setAsking]=useState(false);
    const ask=async(path:string,annotation=false)=>{if(capturing||closingSource)return;if(annotation&&connection.savedAgent?.annotation?.pending){sender.annotate();return;}if(!annotation&&connection.savedAgent?.pending){sender.open();return;}capturing=true;noteObservation++;setAsking(true);setAskError('');try {
      const page=(await connection.read<TextPage>('files.read_text',{path,start_line:1,limit_lines:1})).data;
      if(!page?.file||page.skipped)throw Error(page?.skipped?.detail??'This file is not available as text.');
      selectedSource=structuredClone(page.file);if(annotation)sender.annotate();else sender.open();
    }catch(error){setAskError(String(error));}finally{capturing=false;setAsking(false);}};
    const blocked = asking || close.preparing || action.working || !!action.pending || !state.connected;
    return <main className="files-root" inert={close.preparing || undefined}>
      {connection.savedAgent?.pending && <button disabled={close.preparing} onClick={()=>sender.open()}>Recover Agent request</button>}
      {askError && <p role="alert">{askError}</p>}
      <FilesPanel files={connection.files} navigation={{ blocked, observeNote:async path=>{if(capturing)return;const request=++noteObservation;try{const page=(await connection.read<TextPage>('files.read_text',{path,start_line:1,limit_lines:1})).data;if(request!==noteObservation)return;selectedSource=page?.file&&!page.skipped?structuredClone(page.file):null;const button=document.querySelector<HTMLButtonElement>('[data-annotation-entry]');if(button)button.dispatchEvent(new Event('annotation-source-ready'));}catch{if(request===noteObservation)selectedSource=null;}},ask:path=>ignore(ask(path)), annotate:path=>ignore(ask(path,true)), canOpen: !!configuration.editor,
        openDocument: path => ignore(actions.openDocument(path)), createDocument: () => ignore(actions.openDocument(null)),
        openFile: () => setOpen(true), refresh: () => ignore(connection.refresh(true)),
      }} />
      {(close.error || state.notice || state.saveError || action.error || action.pending || action.receipt) && <aside className="files-status" aria-label="Files status">
        {close.error && <p role="alert">{close.error}</p>}
        {state.notice && <p role="status">{state.notice}<button onClick={() => ignore(connection.refresh(true))}>Refresh</button></p>}
        {state.saveError && <p role="alert">{state.saveError}<button onClick={() => ignore(connection.flush())}>Retry Save</button></p>}
        {action.error && <p role="alert">{action.error}</p>}
        {action.pending && <p>Open unconfirmed · <code>{action.pending.request}</code><button disabled={action.working} onClick={() => ignore(actions.retry())}>Retry Original Request</button><button disabled={action.working} onClick={() => ignore(actions.inspectPending())}>Find Original Operation</button></p>}
        {action.receipt && <details><summary>Open file: {action.receipt.status}</summary><code>{action.receipt.id}</code><button disabled={action.working} onClick={() => ignore(actions.inspect())}>Inspect Operation</button>{action.receipt.error && <p className="error">{action.receipt.error}</p>}</details>}
      </aside>}
      {open && <OpenFile disabled={blocked} close={() => setOpen(false)} open={path => actions.openDocument(path)} />}
    </main>;
  }
  root.render(<App />); ignore(connection.refresh());
  const polling = setInterval(() => { if (!document.hidden) ignore(connection.refresh("directories")); }, 5000);
  window.addEventListener("pagehide", () => { clearInterval(polling); sender.dispose(); actions.stop(); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
} catch (error) { root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>); }
