import { setNonce } from "get-nonce";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "flexlayout-react/style/light.css";
import "./style.css";
import { PluginViewWindow } from "./plugin-view-window";
import { PluginWorkspaceWindow } from "./plugin-workspace-window";

setNonce(
  document.querySelector<HTMLMetaElement>("meta[name=rho-csp-nonce]")!.content,
);
const pluginView = new URL(location.href).searchParams.get("plugin-view");
const root = createRoot(document.getElementById("root")!);
if (pluginView) root.render(createElement(PluginViewWindow, { view: pluginView }));
else root.render(createElement(PluginWorkspaceWindow));
