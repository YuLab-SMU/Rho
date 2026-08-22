import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "../transport/mock";
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

  it("renders broker context while keeping Agent degradation isolated", async () => {
    const transport = createMockUiKernelTransport("?project=%2Ftmp%2FRho%20Lab");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<App transport={transport} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Rho Lab");
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.textContent).toContain("Agent runtime needs attention");
    expect(container.textContent).toContain("6 commands");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(document.documentElement.dataset.rsrReady).toBe("true");
  });
});
