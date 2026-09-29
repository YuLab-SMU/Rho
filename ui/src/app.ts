import { setNonce } from "get-nonce";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "flexlayout-react/style/light.css";
import "./style.css";
import "./shell.css";
import { AppShell } from "./app-shell";
import { PluginViewWindow } from "./plugin-view-window";
import { PluginWorkspaceWindow } from "./plugin-workspace-window";
import { HostClient, message } from "./host-client";

setNonce(
  document.querySelector<HTMLMetaElement>("meta[name=rho-csp-nonce]")!.content,
);
const pluginView = new URL(location.href).searchParams.get("plugin-view");
const root = createRoot(document.getElementById("root")!);
if (pluginView) root.render(createElement(PluginViewWindow, { view: pluginView }));
else if (new URL(location.href).searchParams.has("plugin-window") || new URL(location.href).searchParams.has("test-project")) root.render(createElement(PluginWorkspaceWindow));
else {
  // A bare project URL must honor the live Host's composition too. Only the
  // explicit fixed-workspace reference may construct the old Studio owners.
  root.render(createElement('div', { className: 'empty', role: 'status' }, 'Opening window…'));
  try {
    const client = HostClient.fromLocation();
    void client.info().then(info => {
      if (info.runtime === 'plugins') root.render(createElement(PluginWorkspaceWindow, { client }));
      else { client.stopReads(); root.render(createElement(AppShell)); }
    }).catch(error => root.render(createElement('div', { className: 'empty', role: 'alert' }, message(error))));
  } catch (error) { root.render(createElement('div', { className: 'empty', role: 'alert' }, message(error))); }
}
