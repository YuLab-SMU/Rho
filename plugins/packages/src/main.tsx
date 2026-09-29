import {componentInputDialog} from '../public/agent-input/dialog.js';
import {packageContext,type PackageContextSelection} from './agent-source.js';
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { connectPluginView } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import { PackagesConnection } from "./connection.js";
import { PackagesActions } from "./actions.js";
import { PackagesViewContext } from "./view-services.js";
import { PackagesPanel } from "./views/packages-panel.js";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
try {
  const client = await connectPluginView();
  if (client.view.contribution !== "packages") throw new Error("The Packages contribution is missing.");
  const configuration = client.view.configuration as unknown as { source: InstanceRef; help: InstanceRef | null; help_group: string | null };
  const connection = new PackagesConnection(client, configuration.source);
  const actions = new PackagesActions(client, connection, configuration.help_group, configuration.help);
  let closingSource=false, selectedSource:PackageContextSelection|null=null;
  const sender=componentInputDialog({client,saved:connection.savedAgent,persist:state=>connection.saveAgent(state),
    guard:()=>{if(closingSource)throw Error('Packages is closing. The original request is retained.');},
    modes:[{value:'metadata',label:'Installed-copy metadata'}],capture:kind=>packageContext(connection.source,client.view.window,selectedSource,kind)});
  const closing = await client.installCloseHandler({ async flush() {closingSource=true;if(sender.busy)throw Error('Wait for the current Agent request before closing.'); await connection.pause(); await actions.settled(); await connection.flush(); }, resume() {closingSource=false; connection.resume(); } });
  const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
  function App() {
    const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot), action = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
    const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot), [linkError, setLinkError] = useState("");
    return <PackagesViewContext.Provider value={{ packages: connection.packages, session: state.session,
      agent: {blocked:close.preparing,recovering:!!connection.savedAgent?.pending,ask:copy=>{
        const p=connection.packages;selectedSource=p.session&&p.data?.observation_id?{session:p.session,observation:p.data.observation_id,copy:structuredClone(copy)}:null;sender.open();}},
      navigation: { blocked: close.preparing || action.working || !!action.pending, canOpenDocumentation: !!configuration.help,
        openDocumentation: copy => ignore(actions.openDocumentation(copy)),
        openLink: url => { setLinkError(""); void client.openExternal(url).catch(error => setLinkError(String(error))); } } }}>
      <main className="packages-root">{connection.savedAgent?.pending && <button disabled={close.preparing} onClick={()=>sender.open()}>Recover Agent request</button>}<PackagesPanel viewId={client.view.view} />
        {(close.error || state.notice || state.saveError || action.error || action.pending || action.receipt || linkError) && <aside className="packages-status" aria-label="Packages status">
          {close.error && <p role="alert">{close.error}</p>}{state.notice && <p role="status">{state.notice}</p>}{linkError && <p role="alert">{linkError}</p>}
          {state.saveError && <p role="alert">{state.saveError}<button onClick={() => ignore(connection.flush())}>Retry Save</button></p>}
          {action.error && <p role="alert">{action.error}</p>}
          {action.pending && <p>Navigation unconfirmed · <code>{action.pending.request}</code><button disabled={action.working} onClick={() => ignore(actions.retry())}>Retry Original Request</button><button disabled={action.working} onClick={() => ignore(actions.inspectPending())}>Find Original Operation</button></p>}
          {action.receipt && <p>Open documentation: {action.receipt.status} · <code>{action.receipt.id}</code><button disabled={action.working} onClick={() => ignore(actions.inspect())}>Inspect Operation</button>{action.receipt.error && <span className="error"> {action.receipt.error}</span>}</p>}
        </aside>}
      </main>
    </PackagesViewContext.Provider>;
  }
  root.render(<App />); ignore(connection.refresh()); const polling = setInterval(() => ignore(connection.refresh()), 1500);
  window.addEventListener("pagehide", () => { clearInterval(polling); sender.dispose(); actions.stop(); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
} catch (error) { root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>); }
