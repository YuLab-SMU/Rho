import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./styles/foundation.css";

const rootElement = document.getElementById("root");
if (rootElement == null) throw new Error("Rho frontend root is missing");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
