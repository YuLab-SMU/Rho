import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { connectPluginView } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import type { ObjectPathElement } from "../public/r-protocol/index.js";
import { ObjectsConnection } from "./connection.js";
import { ObjectsActions } from "./actions.js";
import { ObjectsViewContext } from "./view-services.js";
import { ObjectsPanel, ObjectViewer } from "./views/object-panel.js";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
try {
  const client = await connectPluginView();
  const configuration = client.view.configuration as unknown as {
    source: InstanceRef; object_group: string | null; object?: { name: string; path: ObjectPathElement[] };
  };
  if (!["objects", "object"].includes(client.view.contribution) || client.view.contribution === "object" && !configuration.object)
    throw new Error("The Objects contribution or object configuration is missing.");
  const connection = new ObjectsConnection(client, configuration.source);
  const actions = new ObjectsActions(client, connection, configuration.object_group);
  const closing = await client.installCloseHandler({
    async flush() { await connection.pause(); await actions.settled(); await connection.flush(); },
    resume() { connection.resume(); },
  });
  const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
  function App() {
    const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
    const action = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
    const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot);
    const receipt = action.receipt;
    return <ObjectsViewContext.Provider value={{ objects: connection.objects, session: state.session,
      navigation: { blocked: close.preparing || action.working || !!action.pending, openObject: (name, path) => ignore(actions.openObject(name, path)) },
      execution: { blocked: close.preparing || action.working || !!action.pending, run: (code, mode) => actions.run(code, mode).catch(() => undefined) }, clipboard: client }}>
      <main className="objects-root">
        {client.view.contribution === "object" ? <ObjectViewer {...configuration.object!} viewId={client.view.view} /> : <ObjectsPanel viewId={client.view.view} />}
        {(close.error || state.notice || state.saveError || action.error || action.pending || action.retained.length > 0 || receipt) && <aside className="objects-status" aria-label="Objects status">
          {close.error && <p role="alert">{close.error}</p>}
          {state.notice && <p role="status">{state.notice}</p>}
          {state.saveError && <p role="alert">{state.saveError}<button onClick={() => ignore(connection.flush())}>Retry Save</button></p>}
          {action.error && <p role="alert">{action.error}</p>}
          {action.pending && <p>Action unconfirmed · <code>{action.pending.request}</code><button disabled={action.working || action.pending.view !== client.view.view} onClick={() => ignore(actions.retry())}>Retry Original Request</button><button disabled={action.working} onClick={() => ignore(actions.inspectPending())}>Find Original Operation</button><button disabled={action.working} onClick={() => ignore(actions.setAside())}>Set Aside</button></p>}
          {action.retained.length > 0 && <details open><summary>Requests set aside ({action.retained.length})</summary>
            <p>These requests remain unconfirmed. Setting one aside does not cancel or undo it.</p>
            {action.retained.map(item => <p key={`${item.view}:${item.request}`}>{item.capability === "r.execute" ? "Plot execution" : "Open object"} · <code>{item.request}</code>
              <button disabled={action.working} onClick={() => ignore(actions.inspectRetained(item.view, item.request))}>Inspect Saved Request</button></p>)}
          </details>}
          {receipt && <p>{receipt.capability === "r.execute" ? "Plot execution" : "Open object"}: {receipt.status} · <code>{receipt.id}</code>
            <button disabled={action.working} onClick={() => ignore(actions.inspect())}>Inspect Operation</button>{receipt.error && <span className="error"> {receipt.error}</span>}</p>}
        </aside>}
      </main>
    </ObjectsViewContext.Provider>;
  }
  root.render(<App />);
  ignore(connection.refresh());
  const polling = setInterval(() => ignore(connection.refresh()), 1500);
  window.addEventListener("pagehide", () => { clearInterval(polling); actions.stop(); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
} catch (error) {
  root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>);
}
