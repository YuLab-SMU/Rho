import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "../transport/mock";
import { App } from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Studio foundation app", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function renderApp(transport = createMockUiKernelTransport()) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<App transport={transport} />);
      await settle();
    });
    return { container, transport };
  }

  it("renders a recursive asymmetric scene while Agent degradation stays isolated", async () => {
    const { container } = await renderApp(
      createMockUiKernelTransport("?project=%2Ftmp%2FRho%20Lab"),
    );
    expect(container.textContent).toContain("Rho Lab");
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.textContent).toContain("Agent runtime needs attention");
    expect(container.textContent).toContain("6 commands");
    expect(container.textContent).toContain("Source editor");
    expect(container.textContent).toContain("2 tabs");
    expect(container.querySelectorAll(".rho-layout-container")).toHaveLength(2);
    expect(container.querySelectorAll(".rho-resize-handle")).toHaveLength(1);
    expect(container.querySelectorAll(".rho-inventory-item")).toHaveLength(4);
    expect(document.documentElement.dataset.rsrReady).toBe("true");
  });

  it("switches to a document-composed Vibe Page without carrying the inspector chrome", async () => {
    const { container } = await renderApp();
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe");
    if (vibe == null) throw new Error("Vibe mode control is missing");
    await act(async () => {
      vibe.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-page")?.textContent).toContain("Project review");
    expect(container.querySelector(".rho-vibe-live-surface [data-surface-id='rho.check']"))
      .not.toBeNull();
    expect(container.querySelector(".rho-studio-inspector")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".rho-primary-action")?.textContent)
      .toBe("Compose");
  });

  it("keeps instance-local state when a sibling placement closes", async () => {
    const { container } = await renderApp();
    for (let index = 0; index < 2; index += 1) {
      const item = [...container.querySelectorAll<HTMLElement>(".rho-inventory-item")]
        .find((candidate) => candidate.textContent?.includes("rho.surface-playground"));
      if (item == null) throw new Error("playground inventory item is missing");
      await act(async () => {
        item.querySelector<HTMLButtonElement>("button")!.click();
        await settle();
      });
    }
    const cards = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.surface-playground']")];
    const firstCard = cards[0];
    const secondCard = cards[1];
    if (firstCard == null || secondCard == null) throw new Error("placed playgrounds are missing");
    const survivorId = secondCard.dataset.instanceId;
    const firstInput = firstCard.querySelector<HTMLInputElement>("input")!;
    const secondInput = secondCard.querySelector<HTMLInputElement>("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(firstInput, "first draft");
      firstInput.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(secondInput, "survivor draft");
      secondInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      firstCard.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click();
      await settle();
    });
    const remaining = container.querySelector<HTMLElement>("[data-surface-id='rho.surface-playground']")!;
    expect(container.querySelectorAll("[data-surface-id='rho.surface-playground']")).toHaveLength(1);
    expect(remaining.dataset.instanceId).toBe(survivorId);
    expect(remaining.querySelector<HTMLInputElement>("input")!.value).toBe("survivor draft");
  });

  it("previews pointer resizing without durable edits and commits once on release", async () => {
    const transport = createMockUiKernelTransport();
    const original = transport.applyStudio.bind(transport);
    const apply = vi.fn(original);
    transport.applyStudio = apply;
    const capture = new Set<number>();
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: (id: number) => { capture.add(id); } },
      hasPointerCapture: { configurable: true, value: (id: number) => capture.has(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => { capture.delete(id); } },
    });
    const { container } = await renderApp(transport);
    const handle = container.querySelector<HTMLButtonElement>(".rho-resize-handle")!;
    const before = handle.previousElementSibling as HTMLElement;
    const after = handle.nextElementSibling as HTMLElement;
    const rect = (left: number, width: number): DOMRect => ({
      x: left, y: 0, top: 0, left, right: left + width, bottom: 500,
      width, height: 500, toJSON: () => ({}),
    });
    vi.spyOn(before, "getBoundingClientRect").mockReturnValue(rect(0, 700));
    vi.spyOn(after, "getBoundingClientRect").mockReturnValue(rect(700, 300));
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX });
      Object.defineProperty(event, "pointerId", { value: 7 });
      handle.dispatchEvent(event);
    };
    await act(async () => {
      pointer("pointerdown", 700);
      pointer("pointermove", 760);
      await Promise.resolve();
    });
    expect(apply).not.toHaveBeenCalled();
    await act(async () => {
      pointer("pointerup", 760);
      await settle();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit.kind).toBe("resize_boundary");
    apply.mockClear();
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      await settle();
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("keeps Console drafts, histories, and output origins instance-local on a shared Runtime", async () => {
    const { container } = await renderApp();
    const consoles = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.console']")];
    expect(consoles).toHaveLength(2);
    const first = consoles[0]!;
    const second = consoles[1]!;
    const firstComposer = first.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(firstComposer, "1 + 1");
      firstComposer.dispatchEvent(new Event("input", { bubbles: true }));
      firstComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(first.querySelectorAll(".rho-console-entry")).toHaveLength(1);
    expect(first.textContent).toContain("runtime:workspace-r");
    expect(first.textContent).toContain("instance:console-a");
    expect(second.querySelectorAll(".rho-console-entry")).toHaveLength(0);

    const secondComposer = second.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      setValue.call(secondComposer, "2 + 2");
      secondComposer.dispatchEvent(new Event("input", { bubbles: true }));
      secondComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(first.querySelectorAll(".rho-console-entry")).toHaveLength(1);
    expect(second.querySelectorAll(".rho-console-entry")).toHaveLength(1);
    expect(second.textContent).toContain("instance:console-b");
  });

  it("opens repeated file modes and makes immutable previews visibly stale after save", async () => {
    const { container } = await renderApp();
    expect(container.querySelectorAll("[data-surface-id='rho.file-source']")).toHaveLength(1);
    const sourceButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-resource-open-actions button")]
      .find((button) => button.textContent === "Source")!;
    await act(async () => {
      sourceButton.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-surface-id='rho.file-source']")).toHaveLength(2);
    const sourceViews = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.file-source']")];
    const firstEditor = sourceViews[0]!.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const secondEditor = sourceViews[1]!.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(firstEditor, "shared <- TRUE\n");
      firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      firstEditor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(secondEditor.value).toBe("shared <- TRUE\n");

    const previewItem = [...container.querySelectorAll<HTMLElement>(".rho-inventory-item")]
      .find((item) => item.textContent?.includes("rho.file-preview"))!;
    await act(async () => {
      previewItem.querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const save = sourceViews[0]!.querySelector<HTMLButtonElement>(".rho-resource-actions button")!;
    await act(async () => {
      save.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const preview = container.querySelector<HTMLElement>("[data-surface-id='rho.file-preview']")!;
    expect(preview.textContent).toContain("stale");
    expect(preview.textContent).toContain("Refresh view");
  });
});
