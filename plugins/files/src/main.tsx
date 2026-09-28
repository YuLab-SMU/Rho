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
  const connection = new FilesConnection(client);
  const actions = new FilesActions(client, connection, configuration.editor_group ?? null, configuration.editor ?? null, configuration.runtime ?? null);
  const closing = await client.installCloseHandler({
    async flush() { await connection.pause(); await actions.settled(); await connection.flush(); },
    resume() { connection.resume(); },
  });
  const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
  function App() {
    const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot), action = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
    const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot), [open, setOpen] = useState(false);
    const blocked = close.preparing || action.working || !!action.pending || !state.connected;
    return <main className="files-root" inert={close.preparing || undefined}>
      <FilesPanel files={connection.files} navigation={{ blocked, canOpen: !!configuration.editor,
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
  window.addEventListener("pagehide", () => { clearInterval(polling); actions.stop(); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
} catch (error) { root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>); }
