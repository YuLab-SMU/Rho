import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { connectPluginView } from "../public/plugin-ui/index.js";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
import { HelpConnection } from "./connection.js";
import type { HelpCopy } from "./help.js";
import { HelpView } from "./view.js";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
try {
  const client = await connectPluginView();
  if (client.view.contribution !== "help") throw new Error("The Help contribution is missing.");
  const configuration = client.view.configuration as unknown as { source: InstanceRef; copy: HelpCopy | null; topic: string | null };
  if (configuration.copy === null) {
    if (configuration.topic !== null) throw new Error('Choose an installed package copy before opening a help topic.');
    await client.installCloseHandler({ async flush() {}, resume() {} });
    root.render(<main className="help-root"><div className="empty">Choose a package in Packages to browse its help.</div></main>);
    window.addEventListener('pagehide', () => { client.dispose(); root.unmount(); }, { once: true });
  } else {
    const connection = new HelpConnection(client, configuration.source, configuration.copy, configuration.topic);
    const closing = await client.installCloseHandler({ async flush() { await connection.pause(); await connection.flush(); }, resume() { connection.resume(); } });
    const ignore = (promise: Promise<unknown>) => { void promise.catch(() => undefined); };
    function App() {
      const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
      const close = useSyncExternalStore(closing.subscribe, closing.getSnapshot);
      return <main className="help-root">
        <HelpView help={connection.help} copyText={text => client.copyText(text)} openExternal={url => client.openExternal(url)} />
        {(close.error || state.notice || state.saveError) && <aside className="help-status" aria-label="Help status">
          {close.error && <p role="alert">{close.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
          {state.saveError && <p role="alert">{state.saveError}<button onClick={() => ignore(connection.flush())}>Retry Save</button></p>}
        </aside>}
      </main>;
    }
    root.render(<App />); ignore(connection.refresh());
    const polling = setInterval(() => ignore(connection.refresh()), 1500);
    window.addEventListener("pagehide", () => { clearInterval(polling); connection.stop(); client.dispose(); root.unmount(); }, { once: true });
  }
} catch (error) { root.render(<div className="empty" role="alert">{error instanceof Error ? error.message : String(error)}</div>); }
