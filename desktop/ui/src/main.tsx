import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./styles/foundation.css";

const rootElement = document.getElementById("root");
if (rootElement == null) throw new Error("Rho frontend root is missing");

document.documentElement.dataset.rsrBuildId = __RHO_FRONTEND_BUILD_ID__;

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
