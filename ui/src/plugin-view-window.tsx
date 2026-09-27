import { useEffect, useRef, useState } from "react";
import type { PluginViewConnection } from "../../sdk/plugin-protocol/index.js";
import { HostClient } from "./host-client";
import { mountPluginFrame } from "./plugin-frame";

/** Standalone composition of the generic frame available to scenario layouts.
 * The view itself is explicitly opened through Host lifecycle operations. */
export function PluginViewWindow({ view }: { view: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [testName, setTestName] = useState<string>();
  useEffect(() => {
    let client: HostClient;
    try { client = HostClient.fromLocation(); } catch (error) { setError(String(error instanceof Error ? error.message : error)); return; }
    let stopped = false, dispose: (() => void) | undefined;
    void (async () => {
      const info = await client.info();
      if (!info.project_root) throw new Error("Select a project before opening this view.");
      const test = await client.testProjectObservation(info.project_root);
      if (!stopped && test) setTestName(test.project.selection.name);
      const snapshot = await client.port<{ data?: PluginViewConnection }>(info.project_root, { method: "query_snapshot", params: { capability: { id: "views.connection", version: 1 }, arguments: { view } } });
      if (!snapshot.data) throw new Error("The view connection is unavailable.");
      if (snapshot.data.view.window !== client.windowId) throw new Error("This view belongs to another window.");
      if (!stopped && container.current) dispose = mountPluginFrame(container.current, client, info.project_root, snapshot.data, setError);
    })().catch(error => { if (!stopped) setError(String(error instanceof Error ? error.message : error)); });
    return () => { stopped = true; dispose?.(); client.stopReads(); };
  }, [view]);
  return error ? <div role="alert" className="empty">{error}</div> : <main style={{ width: "100%", height: "100dvh", display: "flex", flexDirection: "column" }}>
    {testName !== undefined && <div role="note" style={{ flex: "none", padding: "8px 12px", borderBottom: "1px solid var(--color-border)", background: "var(--color-subtle)", overflowWrap: "anywhere" }}>Disposable test workspace · {testName}</div>}
    <div ref={container} style={{ width: "100%", flex: 1, minHeight: 0 }} />
  </main>;
}
