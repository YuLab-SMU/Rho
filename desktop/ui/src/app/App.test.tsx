import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { BootstrapTransport } from "../transport";
import { App } from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("foundation app", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.replaceChildren();
  });

  it("renders project identity and truthful degraded startup health", async () => {
    let loadCalls = 0;
    const transport: BootstrapTransport = {
      async loadBootstrap() {
        loadCalls += 1;
        return {
          source: "mock",
          project: { root: "/tmp/Rho Lab", label: "Rho Lab" },
          startup: {
            state: "needs_attention",
            phase: "needs_attention",
            title: "Agent runtime needs attention",
            detail: "The editor remains available.",
          },
        };
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<App transport={transport} />);
    });

    expect(container.textContent).toContain("Rho Lab");
    expect(container.textContent).toContain("Agent runtime needs attention");
    expect(container.textContent).toContain("The editor remains available.");
    expect(document.documentElement.dataset.rsrReady).toBe("true");
    expect(loadCalls).toBe(1);
  });
});
