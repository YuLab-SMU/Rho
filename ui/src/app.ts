import { setNonce } from "get-nonce";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "flexlayout-react/style/light.css";
import "./style.css";
import { AppShell } from "./app-shell";

setNonce(
  document.querySelector<HTMLMetaElement>("meta[name=rho-csp-nonce]")!.content,
);
createRoot(document.getElementById("root")!).render(createElement(AppShell));
