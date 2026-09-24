import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Actions, DockLocation } from "flexlayout-react";
import "flexlayout-react/style/light.css";
import { PluginLayoutHost } from "../../src/plugin-layout-host";
import { pluginLayoutDocument, pluginLayoutModel } from "../../src/plugin-layout";
import type { PluginWindowNode } from "../../../sdk/plugin-protocol/index.js";

const source: PluginWindowNode = { kind: "split", id: "root", direction: "horizontal", weights: [2, 1], children: [
  { kind: "tabs", id: "main", views: ["first", "second"], selected: "first" },
  { kind: "tabs", id: "side", views: ["third"], selected: "third" },
] };
const names = new Map([["first", "Original"], ["second", "User branch"], ["third", "Inspector"]]);
const fixture = { loads: {} as Record<string, number>, closes: [] as string[], changes: 0 };
(window as any).fixture = fixture;
window.addEventListener("message", event => {
  if (event.data?.type === "loaded") fixture.loads[event.data.id] = (fixture.loads[event.data.id] ?? 0) + 1;
});
const frames = [...names].map(([id, title]) => ({ id, title, content: <iframe title={title} sandbox="allow-scripts"
  src={`/frame/${id}`} style={{ border: 0, width: "100%", height: "100%", display: "block" }} /> }));
function Fixture() {
  const [model, setModel] = useState(() => pluginLayoutModel(source, names));
  return <div style={{ display: "flex", flexDirection: "column", width: "100vw", height: "100vh", fontFamily: "sans-serif" }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 8 }}>
      <button onClick={() => model.doAction(Actions.moveNode("first", "side", DockLocation.CENTER, -1, true))}>Move original to side</button>
      <button onClick={() => model.doAction(Actions.moveNode("first", "main", DockLocation.CENTER, 0, true))}>Move original back</button>
      <button onClick={() => model.doAction(Actions.selectTab("first"))}>Show original</button>
      <button onClick={() => setModel(pluginLayoutModel(pluginLayoutDocument(model), names))}>Restore saved layout</button>
    </div>
    <div style={{ flex: 1, position: "relative" }}><PluginLayoutHost model={model} frames={frames}
      changed={() => fixture.changes++} close={id => fixture.closes.push(id)} /></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
