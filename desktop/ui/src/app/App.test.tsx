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
    expect(container.textContent).toContain("2 independent views");
    expect(container.querySelectorAll(".rho-synthetic-surface")).toHaveLength(2);
    expect(container.querySelectorAll("button")).toHaveLength(3);
    expect(document.documentElement.dataset.rsrReady).toBe("true");
  });

  it("keeps component-local state with stable instance keys when a sibling closes", async () => {
    const transport = createMockUiKernelTransport();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<App transport={transport} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const cards = [...container.querySelectorAll<HTMLElement>(".rho-synthetic-surface")];
    const firstCard = cards[0];
    const secondCard = cards[1];
    if (firstCard == null || secondCard == null) throw new Error("fixture cards are missing");
    const survivorId = secondCard.dataset.instanceId;
    const firstInput = firstCard.querySelector<HTMLInputElement>("input")!;
    const secondInput = secondCard.querySelector<HTMLInputElement>("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setValue.call(firstInput, "first draft");
      firstInput.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(secondInput, "survivor draft");
      secondInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(secondInput.value).toBe("survivor draft");

    await act(async () => {
      firstCard.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const remaining = container.querySelector<HTMLElement>(".rho-synthetic-surface")!;
    expect(container.querySelectorAll(".rho-synthetic-surface")).toHaveLength(1);
    expect(remaining.dataset.instanceId).toBe(survivorId);
    expect(remaining.querySelector<HTMLInputElement>("input")!.value).toBe("survivor draft");
  });
});
