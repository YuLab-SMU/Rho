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
    expect(container.textContent).toContain("19 commands");
    expect(container.textContent).toContain("Source editor");
    expect(container.textContent).toContain("2 tabs");
    expect(container.querySelectorAll(".rho-layout-container")).toHaveLength(2);
    expect(container.querySelectorAll(".rho-resize-handle")).toHaveLength(2);
    expect(container.querySelectorAll(".rho-inventory-item")).toHaveLength(4);
    expect(container.querySelector("[data-surface-id='rho.agent']")?.textContent).toContain("Project direction");
    const agent = container.querySelector("[data-surface-id='rho.agent']");
    expect(agent?.textContent).toContain("aisdk");
    expect(agent?.textContent).toContain("1.4.12");
    expect(agent?.textContent).toContain("required:  >= 1.5.0");
    expect(agent?.textContent).toContain("CRAN currently provides 1.4.12");
    expect(agent?.textContent).toContain("/project/renv/library/R-4.6/aarch64-apple-darwin/aisdk");
    expect(agent?.textContent).toContain("Copy diagnostics");
    expect(document.documentElement.dataset.rsrReady).toBe("true");
  });

  it("keeps a large repeatable-instance Stack bounded to one mounted renderer", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?stress=large"));
    const stack = container.querySelector<HTMLElement>("[data-node-id='node:stress-stack']")!;
    expect(stack.querySelectorAll("[role='tab']")).toHaveLength(96);
    expect(stack.querySelectorAll("[data-surface-id='rho.surface-playground']")).toHaveLength(1);
    const evidence = JSON.parse(
      container.querySelector("#rsrPreviewEvidence")?.textContent ?? "{}",
    ) as { surfaceInstanceCount?: number };
    expect(evidence.surfaceInstanceCount).toBeGreaterThanOrEqual(100);
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
    expect(container.querySelector(".rho-vibe-live-surface [data-surface-id='rho.check-result']"))
      .not.toBeNull();
    expect(container.querySelector(".rho-studio-inspector")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".rho-primary-action")?.textContent)
      .toBe("Compose");
  });

  it("commits Vibe composition through exact Page transactions", async () => {
    const transport = createMockUiKernelTransport();
    const apply = vi.spyOn(transport, "applyVibePage");
    const { container } = await renderApp(transport);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe")!;
    await act(async () => {
      vibe.click();
      await settle();
    });
    const before = container.querySelectorAll(".rho-vibe-block-rich_text").length;
    const text = [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-toolbar button")]
      .find((button) => button.textContent === "+ Text")!;
    const save = [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-toolbar button")]
      .find((button) => button.textContent === "Save now")!;
    await act(async () => {
      text.click();
      save.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      page_id: "page:project-review",
      expected_page_revision: 1,
      mutation: { kind: "replace_sections" },
    });
    expect(container.querySelectorAll(".rho-vibe-block-rich_text")).toHaveLength(before + 1);
    expect(container.querySelector(".rho-vibe-save-state")?.textContent).toBe("Saved");
  });

  it("runs repeatable Check commands into independent typed result Surfaces", async () => {
    const { container } = await renderApp();
    const check = container.querySelector<HTMLButtonElement>(".rho-command-projection button");
    expect(check?.textContent).toBe("Check project");
    await act(async () => {
      check!.click();
      await settle();
      await settle();
    });
    expect(container.querySelectorAll(".rho-check-result")).toHaveLength(1);
    expect(container.textContent).toContain("Random result may change");
    expect(container.textContent).toContain("Rho core");
    expect(container.textContent).toContain("Workspace rule pack · org.example.project-checks · g3");
    expect(container.querySelector(".rho-check-evidence button")?.textContent).toContain("analysis.R:2:1");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-command-projection button")!.click();
      await settle();
      await settle();
    });
    const results = [...container.querySelectorAll<HTMLElement>(".rho-check-result")];
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.dataset.resultId)).size).toBe(2);
  });

  it("keeps dirty-source Check rejection actionable without breaking the workspace", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?check=dirty"));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-command-projection button")!.click();
      await settle();
    });
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Save modified source files before checking: analysis.R",
    );
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.querySelector("[data-surface-id='rho.file-source']")).not.toBeNull();
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
    await act(async () => handle.focus());
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemax")).toBe("944");
    expect(handle.getAttribute("aria-valuenow")).toBe("700");
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
    apply.mockClear();
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
      await settle();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit).toMatchObject({
      kind: "resize_boundary",
      before_basis: { kind: "fixed", logical_pixels: 56 },
    });
  });

  it("keeps Console drafts, histories, and output origins instance-local on a shared Runtime", async () => {
    const { container } = await renderApp();
    expect(container.querySelectorAll("[data-surface-id='rho.console']")).toHaveLength(1);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>(".rho-stack-tabs [role='tab']")];
    expect(tabs).toHaveLength(2);
    const first = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
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

    await act(async () => {
      tabs[1]!.click();
      await settle();
    });
    const second = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(second.dataset.instanceId).toBe("instance:console-b");
    expect(second.querySelectorAll(".rho-console-entry")).toHaveLength(0);
    const secondComposer = second.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      setValue.call(secondComposer, "2 + 2");
      secondComposer.dispatchEvent(new Event("input", { bubbles: true }));
      secondComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(second.querySelectorAll(".rho-console-entry")).toHaveLength(1);
    expect(second.textContent).toContain("instance:console-b");
    await act(async () => {
      tabs[0]!.click();
      await settle();
    });
    const restoredFirst = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(restoredFirst.dataset.instanceId).toBe("instance:console-a");
    expect(restoredFirst.querySelectorAll(".rho-console-entry")).toHaveLength(1);
  });

  it("releases and resumes one Surface renderer without changing its binding", async () => {
    const transport = createMockUiKernelTransport();
    const suspend = vi.spyOn(transport, "suspendSurface");
    const resume = vi.spyOn(transport, "resumeSurface");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const instanceId = source.dataset.instanceId;
    const pause = [...source.querySelectorAll<HTMLButtonElement>(".rho-surface-actions button")]
      .find((button) => button.textContent === "Pause")!;
    await act(async () => {
      pause.click();
      await settle();
    });
    const paused = container.querySelector<HTMLElement>(`[data-instance-id='${instanceId}']`)!;
    expect(paused.textContent).toContain("Surface paused");
    expect(paused.querySelector(".rho-source-editor-shell")).toBeNull();
    expect(suspend).toHaveBeenCalledOnce();
    await act(async () => {
      [...paused.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Resume Surface")!
        .click();
      await settle();
    });
    const restored = container.querySelector<HTMLElement>(`[data-instance-id='${instanceId}']`)!;
    expect(restored.querySelector(".rho-source-editor-shell")).not.toBeNull();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("shares durable Agent conversation truth while keeping repeated composers instance-local", async () => {
    const transport = createMockUiKernelTransport();
    const ready = structuredClone(await transport.loadSnapshot());
    (ready.health as { agent: typeof ready.health.agent }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (ready.context as { agent_health: "ready" }).agent_health = "ready";
    transport.publish(ready);
    const { container } = await renderApp(transport);
    const original = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    await act(async () => {
      [...original.querySelectorAll<HTMLButtonElement>(".rho-surface-actions button")]
        .find((button) => button.textContent === "Duplicate")!
        .click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const agents = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.agent']")];
    expect(agents).toHaveLength(2);
    const firstComposer = agents[0]!.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    const secondComposer = agents[1]!.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(firstComposer, "Compare both views");
      firstComposer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(firstComposer.value).toBe("Compare both views");
    expect(secondComposer.value).toBe("");
    await act(async () => {
      firstComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    for (const agent of agents) {
      expect(agent.textContent).toContain("Compare both views");
      expect(agent.textContent).toContain("Mock ask response");
    }
  });

  it("creates intrinsic and full domain Surfaces from the shared factory catalog", async () => {
    const { container } = await renderApp();
    const open = async (surfaceId: string) => {
      const factory = container.querySelector<HTMLElement>(
        `[data-surface-factory='${surfaceId}']`,
      );
      if (factory == null) throw new Error(`Factory ${surfaceId} is missing`);
      await act(async () => {
        factory.querySelector<HTMLButtonElement>("button")!.click();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
    };
    await open("rho.problems");
    await open("rho.environment");
    expect(container.querySelector("[data-surface-id='rho.problems']")?.classList)
      .toContain("rho-surface-strip");
    expect(container.querySelector("[data-surface-id='rho.environment']")).not.toBeNull();
  });

  it("reviews Agent file proposals through the shared Resource document and broker mutation", async () => {
    const transport = createMockUiKernelTransport();
    const apply = vi.spyOn(transport, "applyAgentFileEdit");
    const { container } = await renderApp(transport);
    const proposal = container.querySelector<HTMLElement>(".rho-agent-file-proposal");
    if (proposal == null) throw new Error("Agent file proposal is missing");
    expect(proposal?.textContent).toContain("analysis.R");
    expect(proposal?.textContent).toContain("Reviewed by Agent");
    const applyButton = [...proposal.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply")!;
    await act(async () => {
      applyButton.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      turn_id: "agent-turn:mock-1",
      proposal_event_id: 3,
      path: "analysis.R",
      before_content: "library(ggplot2)\nplot(mtcars$wt, mtcars$mpg)\n",
    });
    expect(proposal.textContent).toContain("Undo applied edit");
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

  it("renders repeated workspace-plugin Surfaces through trusted React blocks and routes controls per instance", async () => {
    const transport = createMockUiKernelTransport("?plugin=surface");
    const originalLoad = transport.loadPluginSurfaceDocument.bind(transport);
    transport.loadPluginSurfaceDocument = async (request) => {
      const view = await originalLoad(request);
      return {
        ...view,
        document: {
          ...view.document,
          blocks: [{
            kind: "column" as const,
            blocks: [
              { kind: "text" as const, text: "<script>window.__TAURI__.invoke()</script> is literal text" },
              ...view.document.blocks,
            ],
          }],
        },
      };
    };
    const originalDispatch = transport.dispatchPluginSurfaceEvent.bind(transport);
    const dispatch = vi.fn(originalDispatch);
    transport.dispatchPluginSurfaceEvent = dispatch;
    const { container } = await renderApp(transport);
    const plugin = container.querySelector<HTMLElement>(
      "[data-surface-id='ui.surface.differential-expression']",
    );
    expect(plugin).not.toBeNull();
    expect(plugin?.textContent).toContain("Differential expression explorer");
    expect(plugin?.textContent).toContain("<script>window.__TAURI__.invoke()</script> is literal text");
    expect(plugin?.querySelector("script")).toBeNull();

    await act(async () => {
      [...plugin!.querySelectorAll<HTMLButtonElement>(".rho-plugin-command")][0]!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      control_id: "apply",
      event_kind: "activate",
      value: "",
      target: { instance_id: "surface-instance:plugin-analysis" },
    });

    await act(async () => {
      [...plugin!.querySelectorAll<HTMLButtonElement>(".rho-surface-actions button")]
        .find((button) => button.textContent === "Duplicate")!
        .click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const repeated = container.querySelectorAll(
      "[data-surface-id='ui.surface.differential-expression']",
    );
    expect(repeated).toHaveLength(2);
    expect(repeated[0]?.getAttribute("data-instance-id"))
      .not.toBe(repeated[1]?.getAttribute("data-instance-id"));
  });
});
