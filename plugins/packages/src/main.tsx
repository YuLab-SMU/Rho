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
  const closing = await client.installCloseHandler({ async flush() { await connection.pause(); await actions.settled(); await connection.flush(); }, resume() { connection.resume(); } });
  const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
  function App() {
    const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot), action = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
    const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot), [linkError, setLinkError] = useState("");
    return <PackagesViewContext.Provider value={{ packages: connection.packages, session: state.session,
      navigation: { blocked: close.preparing || action.working || !!action.pending, canOpenDocumentation: !!configuration.help,
        openDocumentation: copy => ignore(actions.openDocumentation(copy)),
        openLink: url => { setLinkError(""); void client.openExternal(url).catch(error => setLinkError(String(error))); } } }}>
      <main className="packages-root"><PackagesPanel viewId={client.view.view} />
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
  window.addEventListener("pagehide", () => { clearInterval(polling); actions.stop(); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
} catch (error) { root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>); }
