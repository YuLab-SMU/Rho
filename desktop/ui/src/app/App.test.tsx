import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "../transport/mock";
import type { LayoutChild } from "../transport/types";
import { WorkbenchProjectionStore } from "../transport/workbench-store";
import { App } from "./App";
import type { FileMutationWorkflow } from "./FileResourceView";
import { ConsoleExecutionRouter } from "./controllers/console-execution-router";
import { StudioMutationController } from "./controllers/studio-mutation-controller";
import type { SourceExecutionSubmission } from "./source-execution";
import {
  runRevocableFileMutationWorkflow,
  settleWorkbenchMutationQueues,
} from "./workbench/WorkbenchRoot";
import { workbenchOperationTrace } from "./operation-trace";
import { loadProjectHistory, saveProjectHistory } from "./project-history";
import {
  defaultToolbarLayout,
  loadToolbarLayout,
  saveToolbarLayout,
  setToolbarComponentVisible,
} from "./toolbar-model";

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
    window.localStorage.clear();
    workbenchOperationTrace.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderApp(transport = createMockUiKernelTransport()) {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal("ResizeObserver", class TestResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      });
    }
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

  it("turns an Agent Studio presentation into an independent code-and-results Scene", async () => {
    const transport = createMockUiKernelTransport();
    const runtimeSnapshot = await transport.loadRuntimes();
    const surfaceSnapshot = await transport.loadSurfaces();
    const runtime = runtimeSnapshot.instances.find((candidate) => candidate.primary_scientific_runtime);
    const console = surfaceSnapshot.catalog.instances.find((candidate) => candidate.surface_id === "rho.console");
    if (runtime == null || console == null) throw new Error("mock execution target is unavailable");
    const started = await transport.startRuntimeExecution({
      runtime: {
        project_id: runtimeSnapshot.project_id,
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        activation_generation: runtime.activation_generation,
        expected_project_revision: runtimeSnapshot.project_revision,
        expected_state_revision: runtime.state_revision,
      },
      console_instance_id: console.instance_id,
      expected_console_revision: console.surface_revision,
      code: "summary(iris)",
      source_context: null,
    });
    const detail = await transport.getAgentTurnDetail("agent-turn:mock-1");
    if (detail == null) throw new Error("mock Agent turn is unavailable");
    transport.getAgentTurnDetail = vi.fn(async (turnId) => turnId === detail.turn.turn_id ? {
      ...detail,
      events: [...detail.events, {
        id: 4,
        turn_id: detail.turn.turn_id,
        timestamp: "2026-08-28T12:00:00Z",
        event_type: "tool.call_completed",
        title: "Studio presentation prepared",
        body: JSON.stringify({
          kind: "rho.studio_presentation",
          title: "Analysis results",
          code_paths: ["analysis.R"],
          execution_id: started.execution.execution_id,
          plot_id: null,
          show_plots: true,
          show_environment: false,
        }),
        status: "completed",
        tool: "present_in_studio",
        request_id: null,
        code: null,
        details_json: "{}",
      }],
    } : null);
    const duplicate = vi.spyOn(transport, "duplicateUiProfileScene");
    const open = vi.spyOn(transport, "openSurface");
    const apply = vi.spyOn(transport, "applyStudio");
    const { container } = await renderApp(transport);
    await act(async () => {
      for (let index = 0; index < 60; index += 1) await Promise.resolve();
    });

    expect(duplicate).toHaveBeenCalledOnce();
    expect(open.mock.calls.map(([request]) => request.surface_id)).toEqual(expect.arrayContaining([
      "rho.file-source",
      "rho.console",
      "rho.plots",
    ]));
    expect(apply.mock.calls.some(([request]) => request.edit.kind === "replace_root")).toBe(true);
    const profile = await transport.loadUiProfile();
    expect(profile.profile.studio_scenes).toHaveLength(2);
    expect(profile.profile.studio_scenes.find(
      (scene) => scene.scene_id === profile.profile.active_studio_scene_id,
    )?.label).toBe("Result · Analysis results");
    const surfaces = await transport.loadSurfaces();
    const agent = surfaces.catalog.instances.find((instance) => instance.surface_id === "rho.agent");
    expect(agent?.view_state).toEqual(expect.objectContaining({
      studio_presentations: { "agent-turn:mock-1:4": "presented" },
    }));
    expect(container.querySelector("[data-surface-id='rho.agent']")).toBeNull();
    expect(container.querySelector("[data-surface-id='rho.console'] .rho-console-command")?.textContent)
      .toContain("summary(iris)");
  });

  it("recovers an unavailable saved project through the project picker instead of Rscript", async () => {
    const transport = createMockUiKernelTransport();
    transport.prepareWorkspace = vi.fn(async () => ({
      status: "needs_attention" as const,
      phase: "project_restore_incomplete",
      workspace_ready: true,
      restored_project_status: "unavailable",
      issue: {
        code: "PROJECT_RESTORE_INCOMPLETE",
        title: "The saved project could not be restored",
        message: "Workspace R is available. Choose or reopen a project to continue.",
        technical_detail: "Saved project: /missing/project\nReason: directory does not exist",
      },
    }));
    const openProject = transport.openProject.bind(transport);
    const pick = vi.fn(() => openProject("/projects/recovered"));
    transport.pickProjectDirectory = pick;
    const { container } = await renderApp(transport);

    expect(container.textContent).toContain("The saved project could not be restored");
    expect(container.textContent).toContain("Choose project");
    expect(container.textContent).not.toContain("Choose Rscript");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Choose project")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(pick).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-studio-shell")).not.toBeNull();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain("/projects/recovered");
  });

  it("keeps unavailable-project recovery after picker cancellation and reports picker failure", async () => {
    const transport = createMockUiKernelTransport();
    transport.prepareWorkspace = vi.fn(async () => ({
      status: "needs_attention" as const,
      phase: "project_restore_incomplete",
      workspace_ready: true,
      restored_project_status: "unavailable",
      issue: {
        code: "PROJECT_RESTORE_INCOMPLETE",
        title: "The saved project could not be restored",
        message: "Choose another project.",
        technical_detail: null,
      },
    }));
    const pick = vi.fn()
      .mockResolvedValueOnce({
        status: "cancelled",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: null,
        message: null,
        restored_root: null,
        restart_required: false,
      })
      .mockRejectedValueOnce(new Error("native picker failed"));
    transport.pickProjectDirectory = pick;
    const { container } = await renderApp(transport);
    const chooseProject = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Choose project")!;

    await act(async () => { chooseProject().click(); await settle(); });
    expect(container.textContent).toContain("The saved project could not be restored");
    expect(chooseProject()).not.toBeNull();
    await act(async () => { chooseProject().click(); await settle(); });
    expect(container.textContent).toContain("PROJECT_SELECTION_FAILED");
    expect(container.textContent).toContain("native picker failed");
    expect(container.textContent).not.toContain("Choose Rscript");
  });

  it("retains Rscript selection only for runtime preparation failures", async () => {
    const transport = createMockUiKernelTransport();
    const prepare = vi.fn(async () => ({
      status: "needs_attention" as const,
      phase: "needs_attention",
      workspace_ready: false,
      restored_project_status: null,
      issue: {
        code: "R_NOT_FOUND",
        title: "R was not found",
        message: "Choose Rscript manually.",
        technical_detail: null,
      },
    }));
    transport.prepareWorkspace = prepare;
    const { container } = await renderApp(transport);
    expect(container.textContent).toContain("Choose Rscript");
    expect(container.textContent).not.toContain("Choose project");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Choose Rscript")!
        .click();
      await settle();
    });
    expect(prepare).toHaveBeenLastCalledWith(true, expect.any(Function));
  });

  async function showToolbarComponent(container: HTMLElement, label: string) {
    if ([...container.querySelectorAll<HTMLElement>("[data-toolbar-component]")]
      .some((component) => component.textContent?.includes(label))) return;
    await openToolbarCustomizer(container);
    const option = [...container.querySelectorAll<HTMLLabelElement>(".rho-toolbar-option label")]
      .find((candidate) => candidate.textContent === label);
    if (option == null) throw new Error(`Toolbar option ${label} is missing.`);
    await act(async () => {
      option.querySelector<HTMLInputElement>("input")!.click();
      container.querySelector<HTMLButtonElement>(".rho-toolbar-customizer footer .rho-primary-action")!.click();
      await settle();
    });
  }

  async function openInspector(container: HTMLElement) {
    await showToolbarComponent(container, "Compose");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-bar-compose")!.click();
      await settle();
    });
  }

  async function openRhoMenu(container: HTMLElement) {
    const menu = container.querySelector<HTMLDetailsElement>(".rho-rho-menu")!;
    if (!menu.open) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button[aria-label='Rho menu']")!.click();
        await settle();
      });
    }
    return menu;
  }

  async function openToolbarCustomizer(container: HTMLElement) {
    if (container.querySelector(".rho-toolbar-customizer") != null) return;
    const menu = await openRhoMenu(container);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Customize toolbar…")!.click();
      await settle();
    });
  }

  async function invokePaletteCommand(container: HTMLElement, label: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }));
      await settle();
      const search = container.querySelector<HTMLInputElement>("[aria-label='Search commands']")!;
      search.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      setValue.call(search, label);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      [...container.querySelectorAll<HTMLButtonElement>(".rho-command-results button")]
        .find((button) => button.textContent?.includes(label))!.click();
      await settle();
    });
  }

  async function openSurfaceMenu(surface: Element) {
    const instanceId = (surface as HTMLElement).dataset.instanceId;
    const actionsHost = [...document.querySelectorAll<HTMLElement>("[data-rho-surface-actions-host]")]
      .find((candidate) => candidate.dataset.rhoSurfaceActionsHost === instanceId);
    const trigger = (actionsHost ?? surface)
      .querySelector<HTMLButtonElement>(".rho-surface-actions [aria-label^='More actions for']");
    if (trigger == null) throw new Error("Surface action menu trigger is missing.");
    await act(async () => {
      trigger.click();
      await settle();
    });
    const menu = surface.querySelector<HTMLElement>(".rho-surface-actions .rho-menu-popover-panel") ??
      [...document.querySelectorAll<HTMLElement>(".rho-menu-popover-panel")]
        .find((candidate) => candidate.getAttribute("aria-label") === trigger.getAttribute("aria-label"));
    if (menu == null) throw new Error("Surface action menu did not open.");
    return menu;
  }

  async function closeSurface(surface: HTMLElement) {
    const tab = document.querySelector<HTMLElement>(
      `[data-rho-tab-instance-id='${surface.dataset.instanceId}']`,
    );
    const close = tab?.closest(".dv-tab")?.querySelector<HTMLButtonElement>("[aria-label='Close tab']");
    if (close == null) throw new Error("Dockview close action is missing.");
    await act(async () => {
      close.click();
      await settle();
    });
  }

  function installPointerCapture() {
    const capture = new Set<number>();
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: (id: number) => { capture.add(id); } },
      hasPointerCapture: { configurable: true, value: (id: number) => capture.has(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => { capture.delete(id); } },
    });
  }

  function pointer(target: EventTarget, type: string, clientX: number, clientY: number, pointerId = 11) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
    });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    target.dispatchEvent(event);
  }

  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function hitTest(...elements: Element[]) {
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => elements),
    });
  }

  it("merges toolbar customization into the two fixed Rho and mode anchors", async () => {
    const { container } = await renderApp();
    const bar = container.querySelector<HTMLElement>(".rho-studio-bar")!;
    const rhoMenuTrigger = bar.querySelector("button[aria-label='Rho menu']")!;
    expect(rhoMenuTrigger.closest(".rho-toolbar-anchor-right")).not.toBeNull();
    expect(bar.querySelector(".rho-mode-switch")).not.toBeNull();
    expect(bar.querySelector("[aria-label='Customize toolbar']")).toBeNull();
    expect(bar.querySelectorAll("[data-toolbar-component]")).toHaveLength(0);
    expect(container.querySelector(".rho-statusbar")).not.toBeNull();
    expect(container.querySelector(".rho-statusbar")?.textContent).not.toContain("No tasks running");

    await openToolbarCustomizer(container);
    const customizer = bar.querySelector<HTMLElement>(".rho-toolbar-customizer")!;
    expect(customizer.textContent).toContain("Rho menu");
    expect(customizer.textContent).toContain("Studio / Vibe");
    expect(customizer.textContent).toContain("Command search");
    expect(customizer.textContent).toContain("Compose");
    expect(customizer.querySelectorAll("[data-toolbar-option-id]")).toHaveLength(2);
    await act(async () => {
      pointer(document.body, "pointerdown", 500, 500);
      await settle();
    });
    expect(bar.querySelector(".rho-toolbar-customizer")).toBeNull();
    await openToolbarCustomizer(container);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(bar.querySelector(".rho-toolbar-customizer")).toBeNull();
  });

  it("gives every placed component a compact left-rail tools menu", async () => {
    const transport = createMockUiKernelTransport();
    const updateSurface = vi.spyOn(transport, "updateSurface");
    const { container } = await renderApp(transport);
    const tools = [...container.querySelectorAll<HTMLElement>(".rho-open-surface-tool")];
    expect(tools.length).toBeGreaterThanOrEqual(6);
    for (const label of ["Navigator", "Source editor", "R Console", "Environment"]) {
      expect(container.querySelector(`[aria-label='Tools for ${label}']`)).not.toBeNull();
    }

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Tools for Navigator']")!.click();
      await settle();
    });
    const navigatorTools = [...document.querySelectorAll<HTMLElement>(".rho-surface-tool-panel")]
      .find((panel) => panel.getAttribute("aria-label") === "Tools for Navigator")!;
    expect(navigatorTools.textContent).toContain("Focus component");
    expect(navigatorTools.textContent).toContain("Component mode");
    expect(navigatorTools.textContent).toContain("Files");
    expect(navigatorTools.textContent).toContain("History");
    expect(navigatorTools.textContent).toContain("Search the current project tree");
    await act(async () => {
      [...navigatorTools.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "History")!.click();
      await settle();
    });
    expect(updateSurface).toHaveBeenCalledWith(expect.objectContaining({
      mutation: { kind: "set_mode", mode_id: "runs" },
    }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Tools for R Console']")!.click();
      await settle();
    });
    const consoleTools = [...document.querySelectorAll<HTMLElement>(".rho-surface-tool-panel")]
      .find((panel) => panel.getAttribute("aria-label") === "Tools for R Console")!;
    expect(consoleTools.textContent).toContain("Interrupt runtime");
    expect(consoleTools.textContent).toContain("Restart runtime");
    expect(consoleTools.textContent).toContain("Shift+Return inserts a new line");
  });

  it("opens and focuses the singleton Settings plugin from the menu and command search", async () => {
    const transport = createMockUiKernelTransport();
    const open = vi.spyOn(transport, "openSurface");
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Settings…")!.click();
      await settle();
    });
    expect(container.querySelectorAll("[data-surface-id='rho.settings']")).toHaveLength(1);
    expect(container.querySelector("[data-surface-id='rho.settings']")?.textContent).toContain("Providers");

    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }));
      await settle();
      const search = container.querySelector<HTMLInputElement>("[aria-label='Search commands']")!;
      setInput.call(search, "Open Settings");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      [...container.querySelectorAll<HTMLButtonElement>(".rho-command-results button")]
        .find((button) => button.textContent?.includes("rho.surface.open.settings"))!.click();
      await settle();
    });
    expect(container.querySelectorAll("[data-surface-id='rho.settings']")).toHaveLength(1);
    const surfaceMenu = await openSurfaceMenu(container.querySelector("[data-surface-id='rho.settings']")!);
    expect(surfaceMenu.textContent).not.toContain("Duplicate component");
    expect(open).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("restores the existing unplaced Settings singleton from the Rho menu", async () => {
    const transport = createMockUiKernelTransport();
    const open = vi.spyOn(transport, "openSurface");
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Settings…")!.click();
      await settle();
    });
    await closeSurface(container.querySelector<HTMLElement>("[data-surface-id='rho.settings']")!);
    expect(container.querySelector("[data-surface-id='rho.settings']")).toBeNull();
    const restoreMenu = await openRhoMenu(container);
    await act(async () => {
      [...restoreMenu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Settings…")!.click();
      await settle();
    });
    expect(container.querySelectorAll("[data-surface-id='rho.settings']")).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("switches A→B→A from the project card and recent rows without leaking project UI state", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const pick = vi.fn(() => transport.openProject(projectB));
    transport.pickProjectDirectory = pick;
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    expect(container.querySelector<HTMLButtonElement>(".rho-mode-switch button[aria-pressed='true']")?.textContent)
      .toBe("Vibe");

    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(pick).toHaveBeenCalledOnce();
    expect(menu.open).toBe(false);
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(container.querySelector<HTMLButtonElement>(".rho-mode-switch button[aria-pressed='true']")?.textContent)
      .toBe("Studio");
    expect(loadProjectHistory(window.localStorage).history.paths).toEqual([projectB, projectA]);

    await openRhoMenu(container);
    const recentA = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectA}']`)!;
    await act(async () => {
      recentA.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    expect(container.querySelector<HTMLButtonElement>(".rho-mode-switch button[aria-pressed='true']")?.textContent)
      .toBe("Vibe");
    expect(loadProjectHistory(window.localStorage).history.paths).toEqual([projectA, projectB]);
  });

  it("flushes a dirty Vibe manuscript before switching projects", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const apply = vi.spyOn(transport, "applyVibePage");
    const open = vi.spyOn(transport, "openProject");
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull());
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      await settle();
    });
    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(projectB);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
  });

  it("keeps the current project when a dirty Vibe manuscript cannot be saved", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    vi.spyOn(transport, "applyVibePage").mockRejectedValue(
      new Error("Vibe Page rejected: Page revision is stale."),
    );
    const open = vi.spyOn(transport, "openProject");
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull());
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      await settle();
    });
    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });

    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull();
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("处理保存问题");
  });

  it("disables project switching while a Vibe mode transition is in flight", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const { container } = await renderApp(transport);
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    const setMode = transport.setUiProfileMode.bind(transport);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    transport.setUiProfileMode = vi.fn(async (request) => {
      await blocked;
      return setMode(request);
    });

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Studio")!
        .click();
      await Promise.resolve();
    });
    const menu = await openRhoMenu(container);
    expect(menu.querySelector<HTMLButtonElement>(".rho-rho-project")?.disabled).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)?.disabled).toBe(true);

    await act(async () => {
      release();
      await settle();
    });
  });

  it("drains controller siblings and the Store before reporting a quiescence failure", async () => {
    const order: string[] = [];
    let releaseSibling = () => {};
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    }).then(() => { order.push("controller-sibling"); });
    const task = settleWorkbenchMutationQueues([
      Promise.reject(new Error("controller drain failed")),
      sibling,
    ], async () => { order.push("store"); });

    await Promise.resolve();
    expect(order).toEqual([]);
    releaseSibling();
    await expect(task).rejects.toThrow("controller drain failed");
    expect(order).toEqual(["controller-sibling", "store"]);

    await expect(settleWorkbenchMutationQueues([], async () => {
      throw new Error("Store drain failed");
    })).rejects.toThrow("Store drain failed");
  });

  it.each([
    ["controller", (error: Error) => (
      vi.spyOn(StudioMutationController.prototype, "settled").mockRejectedValueOnce(error)
    )],
    ["Store", (error: Error) => (
      vi.spyOn(WorkbenchProjectionStore.prototype, "settled").mockRejectedValueOnce(error)
    )],
  ] as const)("keeps a %s quiescence failure visible, writes no mode, and recovers", async (
    boundary,
    rejectNextSettlement,
  ) => {
    const transport = createMockUiKernelTransport();
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const failure = new Error(`Injected ${boundary} quiescence failure.`);
    const settlement = rejectNextSettlement(failure);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe")!;

    await act(async () => {
      vibe.click();
      await vi.waitFor(() => expect(settlement).toHaveBeenCalledOnce());
      await settle();
    });

    expect(setMode).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-action-error")?.textContent ?? "")
      .toContain(failure.message);
    expect(container.querySelector<HTMLButtonElement>(
      ".rho-mode-switch button[aria-pressed='true']",
    )?.textContent).toBe("Studio");

    await act(async () => {
      vibe.click();
      await vi.waitFor(() => expect(
        container.querySelector<HTMLButtonElement>(
          ".rho-mode-switch button[aria-pressed='true']",
        )?.textContent,
      ).toBe("Vibe"));
    });
    expect(setMode).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("waits for Console Profile persistence before one latest-revision Vibe mode write", async () => {
    const transport = createMockUiKernelTransport();
    const originalUpdate = transport.updateSurface.bind(transport);
    let releaseConsolePersistence = () => {};
    const consolePersistenceBlocked = new Promise<void>((resolve) => {
      releaseConsolePersistence = resolve;
    });
    let markConsoleProfileApplied = () => {};
    const consoleProfileApplied = new Promise<void>((resolve) => {
      markConsoleProfileApplied = resolve;
    });
    let heldConsolePersistence = false;
    transport.updateSurface = vi.fn(async (request) => {
      const viewState = request.mutation.kind === "set_view_state"
        ? request.mutation.view_state as { readonly schema_version?: number }
        : null;
      if (
        !heldConsolePersistence
        && request.target.instance_id === "instance:console-a"
        && viewState?.schema_version === 4
      ) {
        heldConsolePersistence = true;
        const result = await originalUpdate(request);
        markConsoleProfileApplied();
        await consolePersistenceBlocked;
        return result;
      }
      return originalUpdate(request);
    });
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    await act(async () => {
      await consoleProfileApplied;
    });
    const advanced = (await transport.loadUiProfile()).profile;
    expect(advanced.revision).toBeGreaterThan(1);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(setMode).not.toHaveBeenCalled();

    await act(async () => {
      releaseConsolePersistence();
      await vi.waitFor(() => expect(
        container.querySelector<HTMLButtonElement>(
          ".rho-mode-switch button[aria-pressed='true']",
        )?.textContent,
      ).toBe("Vibe"));
    });

    expect(setMode).toHaveBeenCalledOnce();
    expect(setMode.mock.calls[0]?.[0].target).toEqual({
      project_id: advanced.project_id,
      expected_profile_revision: advanced.revision,
    });
    expect((await transport.loadUiProfile()).profile.active_mode).toBe("vibe");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("reports a sole latest-revision mode failure and recovers on the next explicit gesture", async () => {
    const transport = createMockUiKernelTransport();
    const originalUpdate = transport.updateSurface.bind(transport);
    const originalSetMode = transport.setUiProfileMode.bind(transport);
    let releaseConsolePersistence = () => {};
    const consolePersistenceBlocked = new Promise<void>((resolve) => {
      releaseConsolePersistence = resolve;
    });
    let markConsoleProfileApplied = () => {};
    const consoleProfileApplied = new Promise<void>((resolve) => {
      markConsoleProfileApplied = resolve;
    });
    let heldConsolePersistence = false;
    transport.updateSurface = vi.fn(async (request) => {
      const viewState = request.mutation.kind === "set_view_state"
        ? request.mutation.view_state as { readonly schema_version?: number }
        : null;
      if (
        !heldConsolePersistence
        && request.target.instance_id === "instance:console-a"
        && viewState?.schema_version === 4
      ) {
        heldConsolePersistence = true;
        const result = await originalUpdate(request);
        markConsoleProfileApplied();
        await consolePersistenceBlocked;
        return result;
      }
      return originalUpdate(request);
    });
    const setMode = vi.fn<typeof transport.setUiProfileMode>()
      .mockRejectedValueOnce(new Error("Injected single mode failure."))
      .mockImplementation(originalSetMode);
    transport.setUiProfileMode = setMode;
    const { container } = await renderApp(transport);
    await act(async () => {
      await consoleProfileApplied;
    });
    const advanced = (await transport.loadUiProfile()).profile;
    expect(advanced.revision).toBeGreaterThan(1);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe")!;

    await act(async () => {
      vibe.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(setMode).not.toHaveBeenCalled();

    await act(async () => {
      releaseConsolePersistence();
      await vi.waitFor(() => expect(setMode).toHaveBeenCalledOnce());
      await settle();
    });

    expect(setMode).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-action-error")?.textContent ?? "")
      .toContain("Injected single mode failure.");
    expect(setMode.mock.calls[0]?.[0].target).toEqual({
      project_id: advanced.project_id,
      expected_profile_revision: advanced.revision,
    });
    expect((await transport.loadUiProfile()).profile.active_mode).toBe("studio");
    expect(container.querySelector<HTMLButtonElement>(
      ".rho-mode-switch button[aria-pressed='true']",
    )?.textContent).toBe("Studio");

    await act(async () => {
      vibe.click();
      await vi.waitFor(() => expect(
        container.querySelector<HTMLButtonElement>(
          ".rho-mode-switch button[aria-pressed='true']",
        )?.textContent,
      ).toBe("Vibe"));
    });
    expect(setMode).toHaveBeenCalledTimes(2);
    expect(setMode.mock.calls[1]?.[0].target).toEqual({
      project_id: advanced.project_id,
      expected_profile_revision: advanced.revision,
    });
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("does not send an old-project mode mutation while a Studio project switch is in flight", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const openProject = transport.openProject.bind(transport);
    let markProjectOpenRequested = () => {};
    const projectOpenRequested = new Promise<void>((resolve) => {
      markProjectOpenRequested = resolve;
    });
    let releaseProjectOpen = () => {};
    const projectOpenBlocked = new Promise<void>((resolve) => {
      releaseProjectOpen = resolve;
    });
    transport.openProject = vi.fn(async (path) => {
      markProjectOpenRequested();
      await projectOpenBlocked;
      return openProject(path);
    });
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe")!;
    const menu = await openRhoMenu(container);
    const openB = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;

    await act(async () => {
      openB.click();
      vibe.click();
      await projectOpenRequested;
      await settle();
    });

    expect([...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .every((button) => button.disabled)).toBe(true);
    expect(setMode).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);

    await act(async () => {
      releaseProjectOpen();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });

    expect(setMode).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(container.querySelector<HTMLButtonElement>(".rho-mode-switch button[aria-pressed='true']")?.textContent)
      .toBe("Studio");
    expect(vibe.disabled).toBe(false);
  });

  it("keeps a cancelled picker silent and suppresses repeated switch clicks while pending", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    let finish: (response: Awaited<ReturnType<typeof transport.pickProjectDirectory>>) => void = () => {};
    const pick = vi.fn(() => new Promise<Awaited<ReturnType<typeof transport.pickProjectDirectory>>>((resolve) => {
      finish = resolve;
    }));
    transport.pickProjectDirectory = pick;
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const projectButton = menu.querySelector<HTMLButtonElement>(".rho-rho-project")!;
    await act(async () => {
      projectButton.click();
      projectButton.click();
      await Promise.resolve();
    });
    expect(pick).toHaveBeenCalledOnce();
    expect(projectButton.disabled).toBe(true);
    await act(async () => {
      finish({
        status: "cancelled",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: null,
        message: null,
        restored_root: null,
        restart_required: false,
      });
      await settle();
    });
    expect(menu.open).toBe(true);
    expect(projectButton.disabled).toBe(false);
    expect(menu.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
  });

  it("keeps a blocked switch beside the action and succeeds on explicit retry", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const open = transport.openProject.bind(transport);
    const switchProject = vi.fn(async (path: string) => {
      if (switchProject.mock.calls.length === 1) return {
        status: "blocked" as const,
        project: null,
        session: {},
        unavailable: null,
        blocker: {
          kind: "active_run" as const,
          message: "Stop the active run before switching projects.",
          pending_count: 1,
          run_id: "run:fixture",
          turn_id: null,
          request_id: null,
          operation_status: "running",
        },
        reason_code: "project_switch_blocked",
        message: "Stop the active run before switching projects.",
        restored_root: null,
        restart_required: false,
      };
      return open(path);
    });
    transport.openProject = switchProject;
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const target = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
    await act(async () => {
      target.click();
      await settle();
    });
    expect(menu.open).toBe(true);
    expect(container.querySelector(".rho-project-switch-error")?.textContent).toContain("Stop the active run");
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    await act(async () => {
      target.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(switchProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(menu.open).toBe(false);
  });

  it("resets bounded operation diagnostics when the accepted project identity changes", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const { container } = await renderApp(transport);
    const active = workbenchOperationTrace.start("test.before-switch");
    workbenchOperationTrace.succeed(active);
    expect(workbenchOperationTrace.snapshot()).toHaveLength(2);
    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(workbenchOperationTrace.snapshot()).toEqual([]);
  });

  it("reopens an advanced exact source after failed_restored and admits new source work", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const restoreProject = transport.openProject.bind(transport);
    const restoreFailure = vi.fn(async () => {
      await restoreProject(projectA);
      return {
        status: "failed_restored",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: "project_switch_watcher_failed",
        message: "Target watcher failed.",
        restored_root: projectA,
        restart_required: false,
      } as const;
    });
    transport.openProject = restoreFailure;
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const consoleA1 = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composerA1 = consoleA1.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composerA1, "A1_CACHE_HISTORY()");
      composerA1.dispatchEvent(new Event("input", { bubbles: true }));
      composerA1.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    await act(async () => {
      setTextarea.call(composerA1, "A1 activation-local draft");
      composerA1.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(composerA1.value).toBe("A1 activation-local draft");
    const menu = await openRhoMenu(container);
    const target = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;

    await act(async () => {
      target.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-project-switch-error")?.textContent).toContain("Rho restored project-a");
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    const consoleA2 = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(consoleA2).not.toBe(consoleA1);
    const composerA2 = consoleA2.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(composerA2.value).toBe("");
    await act(async () => {
      composerA2.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await settle();
    });
    expect(composerA2.value).toBe("");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    expect(setMode).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull();
  });

  it("keeps mutation admission permanently closed after an explicit fatal switch", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const switchProject = vi.fn(async () => ({
        status: "fatal",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: "project_switch_restore_failed",
        message: "Previous project could not be restored.",
        restored_root: null,
        restart_required: false,
      } as const));
    transport.openProject = switchProject;
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const target = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;

    await act(async () => {
      target.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    const fatalAlert = container.querySelector<HTMLElement>(
      ".rho-project-switch-error[role='alert']",
    )!;
    expect(fatalAlert.textContent).toContain("recovery did not complete");
    expect(fatalAlert.textContent).toContain("Restart Rho before continuing project work");
    expect(fatalAlert.closest("details")).toBeNull();
    expect(container.querySelector(".rho-action-error")).toBeNull();
    expect(container.querySelector("[data-surface-id]")).toBeNull();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      target.click();
      await settle();
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(switchProject).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
  });

  it("keeps admission closed when a nominally ready broker response requires restart", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const openProject = transport.openProject.bind(transport);
    const switchProject = vi.fn(async (path: string) => ({
      ...await openProject(path),
      restart_required: true,
    }));
    transport.openProject = switchProject;
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);

    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(container.querySelector("[data-surface-id]")).toBeNull();
    expect(container.querySelector(".rho-project-switch-error")?.textContent)
      .toContain("Restart Rho before continuing project work");
    expect(container.querySelector(".rho-project-switch-error")?.closest("details")).toBeNull();
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(switchProject).toHaveBeenCalledOnce();
  });

  it("refreshes and reopens a coherent source after a thrown broker error", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    transport.openProject = vi.fn().mockRejectedValue(
      new Error("Project validation rejected this directory."),
    );
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);

    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-project-switch-error")?.textContent).toContain("Project validation rejected");
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    expect(container.querySelector("[data-surface-id='rho.console']")).not.toBeNull();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    expect(setMode).toHaveBeenCalledOnce();
  });

  it("keeps admission closed when thrown-switch recovery cannot refresh source truth", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    transport.openProject = vi.fn().mockRejectedValue(new Error("Project validation rejected."));
    const loadProjection = transport.loadWorkbenchProjection.bind(transport);
    let rejectRefresh = false;
    transport.loadWorkbenchProjection = vi.fn(async () => {
      if (rejectRefresh) throw new Error("Previous-project refresh failed.");
      return loadProjection();
    });
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);
    rejectRefresh = true;
    const menu = await openRhoMenu(container);
    const target = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;

    await act(async () => {
      target.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector("[data-surface-id]")).toBeNull();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      target.click();
      await settle();
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(transport.openProject).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);

    const summary = container.querySelector<HTMLButtonElement>("button[aria-label='Rho menu']")!;
    target.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("drains a deferred A Pin before A→B without copying it into B", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const sourceProjectId = (await transport.loadUiProfile()).profile.project_id;
    const { container } = await renderApp(transport);
    const loadProjection = transport.loadWorkbenchProjection.bind(transport);
    let markRefreshRequested = () => {};
    const refreshRequested = new Promise<void>((resolve) => { markRefreshRequested = resolve; });
    let releaseRefresh = () => {};
    const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let deferNextRefresh = true;
    transport.loadWorkbenchProjection = vi.fn(async () => {
      if (deferNextRefresh) {
        deferNextRefresh = false;
        markRefreshRequested();
        await refreshBlocked;
      }
      return loadProjection();
    });
    const applyPage = vi.spyOn(transport, "applyVibePage");
    const openProject = vi.spyOn(transport, "openProject");
    const menu = await openRhoMenu(container);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("[data-surface-id='rho.agent'] button")]
        .find((button) => button.textContent === "Pin to Vibe")!
        .click();
      await refreshRequested;
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      await Promise.resolve();
    });
    expect(openProject).not.toHaveBeenCalled();

    await act(async () => {
      releaseRefresh();
      for (let index = 0; index < 32; index += 1) await Promise.resolve();
    });
    expect(openProject).toHaveBeenCalledOnce();
    expect(applyPage).toHaveBeenCalledOnce();
    expect(applyPage.mock.calls[0]?.[0]).toMatchObject({
      target: { project_id: sourceProjectId },
      page_id: "page:project-review",
    });
    expect(applyPage.mock.invocationCallOrder[0]).toBeLessThan(
      openProject.mock.invocationCallOrder[0]!,
    );
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(JSON.stringify((await transport.loadUiProfile()).profile.vibe_pages))
      .not.toContain("agent-turn:mock-1");

    const returnMenu = await openRhoMenu(container);
    await act(async () => {
      returnMenu.querySelector<HTMLButtonElement>(`[data-project-path='${projectA}']`)!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(JSON.stringify((await transport.loadUiProfile()).profile.vibe_pages))
      .toContain("agent-turn:mock-1");
  });

  it("drains a deferred A1 Pin before same-root A2 and admits a second A2 Pin", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const openProject = transport.openProject.bind(transport);
    const reopen = vi.fn(() => openProject(projectA));
    transport.pickProjectDirectory = reopen;
    const { container } = await renderApp(transport);
    const loadProjection = transport.loadWorkbenchProjection.bind(transport);
    let markRefreshRequested = () => {};
    const refreshRequested = new Promise<void>((resolve) => { markRefreshRequested = resolve; });
    let releaseRefresh = () => {};
    const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let deferNextRefresh = true;
    transport.loadWorkbenchProjection = vi.fn(async () => {
      if (deferNextRefresh) {
        deferNextRefresh = false;
        markRefreshRequested();
        await refreshBlocked;
      }
      return loadProjection();
    });
    const applyPage = vi.spyOn(transport, "applyVibePage");
    const menu = await openRhoMenu(container);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("[data-surface-id='rho.agent'] button")]
        .find((button) => button.textContent === "Pin to Vibe")!
        .click();
      await refreshRequested;
      menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      await Promise.resolve();
    });
    expect(reopen).not.toHaveBeenCalled();

    await act(async () => {
      releaseRefresh();
      for (let index = 0; index < 32; index += 1) await Promise.resolve();
    });
    expect(reopen).toHaveBeenCalledOnce();
    expect(applyPage).toHaveBeenCalledOnce();
    expect(JSON.stringify((await transport.loadUiProfile()).profile.vibe_pages))
      .toContain("agent-turn:mock-1");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("[data-surface-id='rho.agent'] button")]
        .find((button) => button.textContent === "Pin to Vibe")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(applyPage).toHaveBeenCalledTimes(2);
    const profileJson = JSON.stringify((await transport.loadUiProfile()).profile.vibe_pages);
    expect(profileJson.match(/agent-turn:mock-1/gu)).toHaveLength(2);
  });

  it("uses the latest same-epoch revision for Console success and visible failure", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const initialProjectRevision = (await transport.loadSnapshot()).context.project_revision;
    const updateSurface = transport.updateSurface.bind(transport);
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
    };
    let markUpdateRequested = () => {};
    const updateRequested = new Promise<void>((resolve) => { markUpdateRequested = resolve; });
    let releaseUpdate = () => {};
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let deferFirstUpdate = true;
    const pendingSurfaceUpdates = new Set<Promise<unknown>>();
    let completedConsolePersists = 0;
    const revisionedUpdate = vi.fn((request: Parameters<typeof transport.updateSurface>[0]) => {
      const operation = (async () => {
        const navigatorUpdate = request.target.instance_id === "instance:navigator";
        if (deferFirstUpdate && navigatorUpdate) {
          deferFirstUpdate = false;
          markUpdateRequested();
          await updateBlocked;
        }
        const result = await updateSurface(request);
        if (navigatorUpdate) await advanceProjectRevision();
        if (
          request.target.instance_id === "instance:console-a"
          && request.mutation.kind === "set_view_state"
        ) completedConsolePersists += 1;
        return result;
      })();
      pendingSurfaceUpdates.add(operation);
      void operation.then(
        () => pendingSurfaceUpdates.delete(operation),
        () => pendingSurfaceUpdates.delete(operation),
      );
      return operation;
    });
    transport.updateSurface = revisionedUpdate;
    const startExecution = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;

    await act(async () => {
      [...navigator.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent === "History")!
        .click();
      await updateRequested;
    });
    await act(async () => {
      const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
      const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(composer, "SAME_EPOCH_CODE()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    expect(startExecution).not.toHaveBeenCalled();

    await act(async () => {
      releaseUpdate();
      await vi.waitFor(() => expect(startExecution).toHaveBeenCalledOnce());
    });
    expect(startExecution.mock.calls[0]?.[0]).toMatchObject({
      runtime: {
        project_id: expect.any(String),
        expected_project_revision: initialProjectRevision + 1,
      },
      code: "SAME_EPOCH_CODE()",
    });
    expect(container.querySelector(".rho-action-error")).toBeNull();
    await act(async () => {
      await vi.waitFor(() => expect(revisionedUpdate.mock.calls.some(([request]) => (
        request.target.instance_id === "instance:console-a"
        && request.mutation.kind === "set_view_state"
      ))).toBe(true));
      await vi.waitFor(() => expect(
        container.querySelector("[data-surface-id='rho.console'] .rho-console-busybar"),
      ).toBeNull());
      await vi.waitFor(() => expect(completedConsolePersists).toBeGreaterThan(0));
      await vi.waitFor(() => expect(pendingSurfaceUpdates.size).toBe(0));
      await settle();
    });
    const settledFirstPhaseUpdateCount = revisionedUpdate.mock.calls.length;
    await act(async () => {
      await settle();
    });
    expect(revisionedUpdate).toHaveBeenCalledTimes(settledFirstPhaseUpdateCount);

    let markSecondUpdateRequested = () => {};
    const secondUpdateRequested = new Promise<void>((resolve) => {
      markSecondUpdateRequested = resolve;
    });
    let releaseSecondUpdate = () => {};
    const secondUpdateBlocked = new Promise<void>((resolve) => { releaseSecondUpdate = resolve; });
    transport.updateSurface = vi.fn(async (request) => {
      const navigatorUpdate = request.target.instance_id === "instance:navigator";
      if (navigatorUpdate) {
        markSecondUpdateRequested();
        await secondUpdateBlocked;
      }
      const result = await updateSurface(request);
      if (navigatorUpdate) await advanceProjectRevision();
      return result;
    });
    startExecution.mockRejectedValueOnce(new Error("Rebased Runtime start failed."));
    await act(async () => {
      [...navigator.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent === "Files")!
        .click();
      await secondUpdateRequested;
    });
    await act(async () => {
      const composer = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!
        .querySelector<HTMLTextAreaElement>("textarea")!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(composer, "SAME_EPOCH_FAILURE()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    expect(startExecution).toHaveBeenCalledOnce();
    await act(async () => {
      releaseSecondUpdate();
      await vi.waitFor(() => expect(startExecution).toHaveBeenCalledTimes(2));
      await settle();
    });
    const failureAdmissionProjectRevision = (
      await transport.loadSnapshot()
    ).context.project_revision;
    expect(startExecution.mock.calls[1]?.[0]).toMatchObject({
      runtime: { expected_project_revision: failureAdmissionProjectRevision },
      code: "SAME_EPOCH_FAILURE()",
    });
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("Rebased Runtime start failed");

    await act(async () => {
      const composer = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!
        .querySelector<HTMLTextAreaElement>("textarea")!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(composer, "SAME_EPOCH_RECOVERY()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await vi.waitFor(() => expect(startExecution).toHaveBeenCalledTimes(3));
      await settle();
    });
    expect(startExecution.mock.calls[2]?.[0].code).toBe("SAME_EPOCH_RECOVERY()");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("creates and persists Agent New as one exact admitted workflow", async () => {
    const transport = createMockUiKernelTransport();
    const createAgentConversation = transport.createAgentConversation.bind(transport);
    const updateSurface = transport.updateSurface.bind(transport);
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      return nextProjectRevision;
    };
    let createdConversationId: string | null = null;
    let createdProjectRevision: number | null = null;
    const create = vi.fn(async () => {
      const conversation = await createAgentConversation();
      createdConversationId = conversation.conversation_id;
      createdProjectRevision = await advanceProjectRevision();
      return conversation;
    });
    let markPersistRequested = () => {};
    const persistRequested = new Promise<void>((resolve) => { markPersistRequested = resolve; });
    let releasePersist = () => {};
    const persistBlocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      if (
        request.target.instance_id === "instance:agent-shared"
        && request.mutation.kind === "set_view_state"
        && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
          === createdConversationId
      ) {
        markPersistRequested();
        await persistBlocked;
      }
      return updateSurface(request);
    });
    transport.createAgentConversation = create;
    transport.updateSurface = update;
    const initialAgent = (await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    )!;
    const { container } = await renderApp(transport);
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const picker = agent.querySelector<HTMLSelectElement>("select[aria-label^='Conversation for']")!;
    const initialConversationId = picker.value;
    const newButton = [...agent.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;

    await act(async () => {
      newButton.click();
      await persistRequested;
    });
    expect(createdConversationId).toMatch(/^agent-conversation:mock-/u);
    expect(create).toHaveBeenCalledOnce();
    expect(picker.value).toBe(initialConversationId);
    const persisted = update.mock.calls.find(([request]) => (
      request.target.instance_id === "instance:agent-shared"
      && request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === createdConversationId
    ));
    expect(persisted).toBeDefined();
    expect(persisted![0].target.expected_project_revision).toBe(createdProjectRevision);
    expect(persisted![0].target.activation_generation).toBe(initialAgent.activation_generation);
    const persistedIndex = update.mock.calls.findIndex((call) => call === persisted);
    expect(create.mock.invocationCallOrder[0])
      .toBeLessThan(update.mock.invocationCallOrder[persistedIndex]!);

    await act(async () => {
      releasePersist();
      await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>(
        "[data-surface-id='rho.agent'] select[aria-label^='Conversation for']",
      )?.value).toBe(createdConversationId));
      await settle();
    });
    expect((await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === initialAgent.instance_id,
    )?.view_state).toMatchObject({ conversation_id: createdConversationId });
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("keeps failed Agent creation and stale selection persistence truthful, then recovers", async () => {
    const transport = createMockUiKernelTransport();
    const createAgentConversation = transport.createAgentConversation.bind(transport);
    const updateSurface = transport.updateSurface.bind(transport);
    const createdConversationIds: string[] = [];
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) {
        throw new Error("Agent conversation creation rejected for test.");
      }
      const conversation = await createAgentConversation();
      createdConversationIds.push(conversation.conversation_id);
      return conversation;
    });
    let rejectFirstSelectionPersist = true;
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      const conversationId = request.mutation.kind === "set_view_state"
        ? (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        : null;
      if (
        rejectFirstSelectionPersist
        && request.target.instance_id === "instance:agent-shared"
        && typeof conversationId === "string"
        && conversationId !== "agent-conversation:mock-shared"
      ) {
        rejectFirstSelectionPersist = false;
        throw new Error("Agent selection persist stale for test.");
      }
      return updateSurface(request);
    });
    transport.createAgentConversation = create;
    transport.updateSurface = update;
    const { container } = await renderApp(transport);
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const picker = agent.querySelector<HTMLSelectElement>("select[aria-label^='Conversation for']")!;
    const newButton = () => [...agent.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;

    await act(async () => {
      newButton().click();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(".rho-action-error")?.textContent)
        .toContain("Agent conversation creation rejected for test."));
    });
    expect(picker.value).toBe("agent-conversation:mock-shared");

    await act(async () => {
      newButton().click();
      await vi.waitFor(() => expect(createdConversationIds).toHaveLength(1));
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(".rho-action-error")?.textContent)
        .toContain("Agent selection persist stale for test."));
    });
    const durableButUnselectedId = createdConversationIds[0]!;
    expect([...picker.options].map((option) => option.value)).toContain(durableButUnselectedId);
    expect(picker.value).toBe("agent-conversation:mock-shared");

    await act(async () => {
      newButton().click();
      await vi.waitFor(() => expect(createdConversationIds).toHaveLength(2));
      await vi.waitFor(() => expect(picker.value).toBe(createdConversationIds[1]));
      await settle();
    });
    expect(picker.value).not.toBe(durableButUnselectedId);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("rejects a queued picker persist after exact Agent activation replacement and recovers", async () => {
    const transport = createMockUiKernelTransport();
    const updateSurface = transport.updateSurface.bind(transport);
    const firstCandidate = await transport.createAgentConversation();
    const replacementCandidate = await transport.createAgentConversation();
    const initialSurfaces = await transport.loadSurfaces();
    const initialAgent = initialSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    )!;
    let releaseQueue = () => {};
    const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    let queueIsBlocked = false;
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      if (
        !queueIsBlocked
        && request.target.instance_id === initialAgent.instance_id
        && request.mutation.kind === "set_view_state"
        && (request.mutation.view_state as { auto_approve?: unknown }).auto_approve === true
      ) {
        queueIsBlocked = true;
        await queueGate;
        return transport.loadSurfaces();
      }
      return updateSurface(request);
    });
    transport.updateSurface = update;
    const { container } = await renderApp(transport);
    const currentAgent = () => container.querySelector<HTMLElement>(
      "[data-surface-id='rho.agent']",
    )!;
    const currentPicker = () => currentAgent().querySelector<HTMLSelectElement>(
      "select[aria-label^='Conversation for']",
    )!;
    const initialPicker = currentPicker();

    await act(async () => {
      currentAgent().querySelector<HTMLButtonElement>(".rho-agent-auto-approve")!.click();
      await vi.waitFor(() => expect(queueIsBlocked).toBe(true));
    });
    await act(async () => {
      initialPicker.value = firstCandidate.conversation_id;
      initialPicker.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    expect(update.mock.calls.some(([request]) => (
      request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === firstCandidate.conversation_id
    ))).toBe(false);

    const replacementGeneration = initialAgent.activation_generation + 1;
    const replacementSurfaces = structuredClone(await transport.loadSurfaces());
    const replacementInstances = replacementSurfaces.catalog.instances.map(
      (instance) => instance.instance_id === initialAgent.instance_id
        ? {
            ...instance,
            activation_generation: replacementGeneration,
            surface_revision: instance.surface_revision + 1,
            view_state: initialAgent.view_state,
        }
        : instance,
    );
    await act(async () => {
      transport.publishSurfaces({
        ...replacementSurfaces,
        catalog: { ...replacementSurfaces.catalog, instances: replacementInstances },
      });
      await vi.waitFor(() => expect(currentPicker()).not.toBe(initialPicker));
    });
    expect(currentPicker().value).toBe("agent-conversation:mock-shared");

    await act(async () => {
      releaseQueue();
      await settle();
      await settle();
    });
    expect(update.mock.calls.some(([request]) => (
      request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === firstCandidate.conversation_id
    ))).toBe(false);
    expect(currentPicker().value).toBe("agent-conversation:mock-shared");
    expect((await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === initialAgent.instance_id,
    )).toMatchObject({
      activation_generation: replacementGeneration,
      view_state: { conversation_id: "agent-conversation:mock-shared" },
    });
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      currentPicker().value = replacementCandidate.conversation_id;
      currentPicker().dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(currentPicker().value)
        .toBe(replacementCandidate.conversation_id));
      await settle();
    });
    const replacementPersist = update.mock.calls.find(([request]) => (
      request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === replacementCandidate.conversation_id
    ));
    expect(replacementPersist).toBeDefined();
    expect(replacementPersist![0].target).toMatchObject({
      instance_id: initialAgent.instance_id,
      activation_generation: replacementGeneration,
    });
    expect((await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === initialAgent.instance_id,
    )?.view_state).toMatchObject({ conversation_id: replacementCandidate.conversation_id });
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("keeps an accepted no-conversation Agent Send exactly once across persist failure and recovery", async () => {
    const transport = createMockUiKernelTransport();
    const initialKernel = await transport.loadSnapshot();
    transport.publish({
      ...initialKernel,
      health: {
        ...initialKernel.health,
        agent: { state: "ready", label: "Agent runtime ready", detail: null },
      },
    });
    const initialSurfaces = await transport.loadSurfaces();
    const initialAgent = initialSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    )!;
    transport.publishSurfaces({
      ...initialSurfaces,
      catalog: {
        ...initialSurfaces.catalog,
        instances: initialSurfaces.catalog.instances.map((instance) => (
          instance.instance_id === initialAgent.instance_id
            ? {
                ...instance,
                surface_revision: instance.surface_revision + 1,
                view_state: {
                  conversation_id: null,
                  mode: "ask",
                  composer: "",
                  auto_approve: false,
                },
              }
            : instance
        )),
      },
    });
    const listAgentConversations = transport.listAgentConversations.bind(transport);
    const runAgent = transport.runAgent.bind(transport);
    const updateSurface = transport.updateSurface.bind(transport);
    let conversationsVisible = false;
    transport.listAgentConversations = vi.fn((limit = 50) => (
      conversationsVisible ? listAgentConversations(limit) : Promise.resolve([])
    ));
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      return nextProjectRevision;
    };
    const createdConversationIds: string[] = [];
    const createdProjectRevisions: number[] = [];
    const run = vi.fn(async (request: Parameters<typeof transport.runAgent>[0]) => {
      const response = await runAgent(request);
      createdConversationIds.push(response.conversation_id);
      conversationsVisible = true;
      createdProjectRevisions.push(await advanceProjectRevision());
      return response;
    });
    let releaseFirstPersistFailure = () => {};
    const firstPersistFailureBlocked = new Promise<void>((resolve) => {
      releaseFirstPersistFailure = resolve;
    });
    let rejectFirstPersist = true;
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      const conversationId = request.mutation.kind === "set_view_state"
        ? (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        : null;
      if (
        rejectFirstPersist
        && request.target.instance_id === initialAgent.instance_id
        && typeof conversationId === "string"
      ) {
        rejectFirstPersist = false;
        await firstPersistFailureBlocked;
        throw new Error("Agent Send selection persist stale for test.");
      }
      return updateSurface(request);
    });
    transport.runAgent = run;
    transport.updateSurface = update;
    const { container } = await renderApp(transport);
    const currentAgent = () => container.querySelector<HTMLElement>(
      "[data-surface-id='rho.agent']",
    )!;
    const currentPicker = () => currentAgent().querySelector<HTMLSelectElement>(
      "select[aria-label^='Conversation for']",
    )!;
    const currentComposer = () => currentAgent().querySelector<HTMLTextAreaElement>(
      ".rho-agent-composer textarea",
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(currentComposer(), "Start a durable Agent task");
      currentComposer().dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(currentComposer().value).toBe("Start a durable Agent task");
    expect(currentAgent().querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!.disabled).toBe(false);
    await act(async () => {
      currentAgent().querySelector<HTMLButtonElement>(
        ".rho-agent-context-controls .rho-primary-action",
      )!.click();
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(update.mock.calls.some(([request]) => (
        request.target.instance_id === initialAgent.instance_id
        && request.mutation.kind === "set_view_state"
      ))).toBe(true));
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].conversation_id).toBeNull();
    expect(currentPicker().value).toBe(createdConversationIds[0]);
    expect(currentComposer().value).toBe("");
    const firstPersist = update.mock.calls.find(([request]) => (
      request.target.instance_id === initialAgent.instance_id
      && request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === createdConversationIds[0]
    ));
    expect(firstPersist).toBeDefined();
    expect(firstPersist![0].target.expected_project_revision).toBe(createdProjectRevisions[0]);
    expect(firstPersist![0].target.activation_generation).toBe(initialAgent.activation_generation);

    await act(async () => {
      releaseFirstPersistFailure();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(".rho-action-error")?.textContent)
        .toContain("Agent Send selection persist stale for test."));
    });
    expect(currentPicker().value).toBe(createdConversationIds[0]);
    expect(currentComposer().value).toBe("");
    expect([...currentPicker().options].map((option) => option.value))
      .toContain(createdConversationIds[0]);
    expect((await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === initialAgent.instance_id,
    )?.view_state).toMatchObject({ conversation_id: null });

    const sendAfterFailure = currentAgent().querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;
    expect(sendAfterFailure.disabled).toBe(true);
    await act(async () => {
      sendAfterFailure.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(run).toHaveBeenCalledOnce();
    expect(update.mock.calls.filter(([request]) => (
      request.target.instance_id === initialAgent.instance_id
      && request.mutation.kind === "set_view_state"
      && typeof (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === "string"
    ))).toHaveLength(1);
    expect(currentComposer().value).toBe("");
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("Agent Send selection persist stale for test.");
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drains a no-conversation Agent Send before %s and isolates the accepted activation", async (
    _label,
    sameRoot,
  ) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const initialKernel = await transport.loadSnapshot();
    transport.publish({
      ...initialKernel,
      health: {
        ...initialKernel.health,
        agent: { state: "ready", label: "Agent runtime ready", detail: null },
      },
    });
    const initialSurfaces = await transport.loadSurfaces();
    const initialAgent = initialSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    )!;
    transport.publishSurfaces({
      ...initialSurfaces,
      catalog: {
        ...initialSurfaces.catalog,
        instances: initialSurfaces.catalog.instances.map((instance) => (
          instance.instance_id === initialAgent.instance_id
            ? {
                ...instance,
                surface_revision: instance.surface_revision + 1,
                view_state: {
                  conversation_id: null,
                  mode: "ask",
                  composer: "",
                  auto_approve: false,
                },
              }
            : instance
        )),
      },
    });
    const listAgentConversations = transport.listAgentConversations.bind(transport);
    const runAgent = transport.runAgent.bind(transport);
    const updateSurface = transport.updateSurface.bind(transport);
    const openProject = transport.openProject.bind(transport);
    let conversationsVisible = false;
    transport.listAgentConversations = vi.fn((limit = 50) => (
      conversationsVisible ? listAgentConversations(limit) : Promise.resolve([])
    ));
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      return nextProjectRevision;
    };
    let markRunRequested = () => {};
    const runRequested = new Promise<void>((resolve) => { markRunRequested = resolve; });
    let releaseRun = () => {};
    const runBlocked = new Promise<void>((resolve) => { releaseRun = resolve; });
    let createdConversationId: string | null = null;
    let createdProjectRevision: number | null = null;
    const run = vi.fn(async (request: Parameters<typeof transport.runAgent>[0]) => {
      if (run.mock.calls.length === 1) {
        markRunRequested();
        await runBlocked;
      }
      const response = await runAgent(request);
      conversationsVisible = true;
      if (run.mock.calls.length === 1) {
        createdConversationId = response.conversation_id;
        createdProjectRevision = await advanceProjectRevision();
      }
      return response;
    });
    let markPersistRequested = () => {};
    const persistRequested = new Promise<void>((resolve) => { markPersistRequested = resolve; });
    let releasePersist = () => {};
    const persistBlocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      if (
        update.mock.calls.length >= 1
        && request.target.instance_id === initialAgent.instance_id
        && request.mutation.kind === "set_view_state"
        && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
          === createdConversationId
      ) {
        markPersistRequested();
        await persistBlocked;
      }
      return updateSurface(request);
    });
    const broker = vi.fn(async (path: string) => {
      const response = await openProject(path);
      const kernel = await transport.loadSnapshot();
      transport.publish({
        ...kernel,
        health: {
          ...kernel.health,
          agent: { state: "ready", label: "Agent runtime ready", detail: null },
        },
      });
      return response;
    });
    transport.runAgent = run;
    transport.updateSurface = update;
    transport.openProject = broker;
    if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const currentAgent = () => container.querySelector<HTMLElement>(
      "[data-surface-id='rho.agent']",
    )!;
    const currentComposer = () => currentAgent().querySelector<HTMLTextAreaElement>(
      ".rho-agent-composer textarea",
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(currentComposer(), "Admitted before project transition");
      currentComposer().dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      currentAgent().querySelector<HTMLButtonElement>(
        ".rho-agent-context-controls .rho-primary-action",
      )!.click();
      await runRequested;
    });
    await act(async () => {
      const target = sameRoot
        ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
        : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
      target.click();
      await settle();
    });
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      releaseRun();
      await persistRequested;
    });
    expect(broker).not.toHaveBeenCalled();
    const persisted = update.mock.calls.find(([request]) => (
      request.target.instance_id === initialAgent.instance_id
      && request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === createdConversationId
    ));
    expect(persisted).toBeDefined();
    expect(persisted![0].target.expected_project_revision).toBe(createdProjectRevision);
    expect(persisted![0].target.activation_generation).toBe(initialAgent.activation_generation);

    await act(async () => {
      releasePersist();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(broker).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(container.querySelector(
        "[data-surface-id='rho.agent']",
      )).not.toBeNull());
    });
    expect(update.mock.invocationCallOrder[update.mock.calls.indexOf(persisted!)])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    const targetPicker = () => currentAgent().querySelector<HTMLSelectElement>(
      "select[aria-label^='Conversation for']",
    )!;
    expect(targetPicker().value === createdConversationId).toBe(sameRoot);
    const targetConversationIds = [...targetPicker().options].map((option) => option.value);
    expect(targetConversationIds.includes(createdConversationId!)).toBe(sameRoot);
    if (!sameRoot) {
      expect(currentAgent().textContent).not.toContain("Admitted before project transition");
    }
    expect(container.querySelector(".rho-action-error")).toBeNull();
    const targetConversationId = targetPicker().value;

    await act(async () => {
      setValue.call(currentComposer(), "Target activation retry");
      currentComposer().dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      currentAgent().querySelector<HTMLButtonElement>(
        ".rho-agent-context-controls .rho-primary-action",
      )!.click();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(currentComposer().value).toBe(""));
      await settle();
    });
    expect(run.mock.calls[1]?.[0].conversation_id).toBe(targetConversationId || null);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drains Agent New before %s and isolates the accepted target activation", async (
    _label,
    sameRoot,
  ) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const createAgentConversation = transport.createAgentConversation.bind(transport);
    const updateSurface = transport.updateSurface.bind(transport);
    const openProject = transport.openProject.bind(transport);
    const initialSurfaces = await transport.loadSurfaces();
    const initialAgent = initialSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    )!;
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      return nextProjectRevision;
    };
    let markCreateRequested = () => {};
    const createRequested = new Promise<void>((resolve) => { markCreateRequested = resolve; });
    let releaseCreate = () => {};
    const createBlocked = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createdConversationId: string | null = null;
    let createdProjectRevision: number | null = null;
    const create = vi.fn(async () => {
      if (create.mock.calls.length === 1) {
        markCreateRequested();
        await createBlocked;
      }
      const conversation = await createAgentConversation();
      if (create.mock.calls.length === 1) {
        createdConversationId = conversation.conversation_id;
        createdProjectRevision = await advanceProjectRevision();
      }
      return conversation;
    });
    let markPersistRequested = () => {};
    const persistRequested = new Promise<void>((resolve) => { markPersistRequested = resolve; });
    let releasePersist = () => {};
    const persistBlocked = new Promise<void>((resolve) => { releasePersist = resolve; });
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      if (
        request.target.instance_id === initialAgent.instance_id
        && request.mutation.kind === "set_view_state"
        && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
          === createdConversationId
      ) {
        markPersistRequested();
        await persistBlocked;
      }
      return updateSurface(request);
    });
    const broker = vi.fn((path: string) => openProject(path));
    transport.createAgentConversation = create;
    transport.updateSurface = update;
    transport.openProject = broker;
    if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;

    await act(async () => {
      [...agent.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
        .find((button) => button.textContent === "New")!
        .click();
      await createRequested;
    });
    await act(async () => {
      const target = sameRoot
        ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
        : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
      target.click();
      await settle();
    });
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      releaseCreate();
      await persistRequested;
    });
    expect(broker).not.toHaveBeenCalled();
    const persisted = update.mock.calls.find(([request]) => (
      request.target.instance_id === initialAgent.instance_id
      && request.mutation.kind === "set_view_state"
      && (request.mutation.view_state as { conversation_id?: unknown }).conversation_id
        === createdConversationId
    ));
    expect(persisted).toBeDefined();
    expect(persisted![0].target.expected_project_revision).toBe(createdProjectRevision);
    expect(persisted![0].target.activation_generation).toBe(initialAgent.activation_generation);

    await act(async () => {
      releasePersist();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(broker).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(
        container.querySelector("[data-surface-id='rho.agent']"),
      ).not.toBeNull());
    });
    expect(createdConversationId).not.toBeNull();
    expect(create.mock.invocationCallOrder[0])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    expect(update.mock.invocationCallOrder[update.mock.calls.indexOf(persisted!)])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    const targetAgent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const targetPicker = targetAgent.querySelector<HTMLSelectElement>(
      "select[aria-label^='Conversation for']",
    )!;
    expect(targetPicker.value === createdConversationId).toBe(sameRoot);
    expect([...targetPicker.options].some((option) => option.value === createdConversationId))
      .toBe(sameRoot);
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      [...targetAgent.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
        .find((button) => button.textContent === "New")!
        .click();
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>(
        "[data-surface-id='rho.agent'] select[aria-label^='Conversation for']",
      )?.value).not.toBe(createdConversationId));
      await settle();
    });
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])(
    "revokes returned and retained File workflows before the accepted %s Console can use them",
    async (_label, sameRoot) => {
      const projectA = "/projects/project-a";
      const projectB = "/projects/project-b";
      saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
      const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
      const openProject = transport.openProject.bind(transport);
      const broker = vi.fn((path: string) => openProject(path));
      transport.openProject = broker;
      if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
      const initial = await transport.loadSnapshot();
      const { container } = await renderApp(transport);
      const router = new ConsoleExecutionRouter();
      router.activate({
        epoch: 1,
        projectId: initial.project.project_id,
        projectRevision: initial.context.project_revision,
      });
      const sourceSubmit = vi.fn(() => ({ accepted: true, message: null }));
      router.register({ instanceId: "console:A", submitSource: sourceSubmit });
      router.markPreferred("console:A");
      const targetSubmit = vi.fn(() => ({ accepted: true, message: null }));
      const prepare = vi.fn(async () => ({
        instanceId: "console:unexpected",
        submitSource: targetSubmit,
      }));
      const report = vi.fn();
      const updateDraft = vi.fn(async (content: Parameters<FileMutationWorkflow["updateDraft"]>[0]) => {
        return content;
      });
      const save = vi.fn(async (content: Parameters<FileMutationWorkflow["save"]>[0]) => {
        return content;
      });
      const ports: FileMutationWorkflow = {
        updateDraft,
        save,
        runSourceExecution: (execution) => router.run(
          "source:A",
          execution,
          prepare,
          report,
        ),
      };
      const escaped = await runRevocableFileMutationWorkflow(
        async (workflow) => workflow,
        ports,
      );
      let retained: FileMutationWorkflow | null = null;
      await expect(runRevocableFileMutationWorkflow(
        async (workflow) => {
          retained = workflow;
          throw new Error("Outer File workflow rejected for test.");
        },
        ports,
      )).rejects.toThrow("Outer File workflow rejected for test");

      const menu = await openRhoMenu(container);
      await act(async () => {
        const target = sameRoot
          ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
          : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
        target.click();
        await vi.waitFor(() => expect(broker).toHaveBeenCalledOnce());
        await settle();
      });
      const target = await transport.loadSnapshot();
      if (sameRoot) {
        expect(target.project.project_id).toBe(initial.project.project_id);
        expect(target.context.project_revision).toBeGreaterThan(initial.context.project_revision);
      } else {
        expect(target.project.project_id).not.toBe(initial.project.project_id);
      }
      router.activate({
        epoch: 2,
        projectId: target.project.project_id,
        projectRevision: target.context.project_revision,
      });
      router.register({ instanceId: "console:target", submitSource: targetSubmit });
      router.markPreferred("console:target");
      const execution: SourceExecutionSubmission = {
        kind: "expression",
        code: "A_ESCAPED_RUN()",
        start: 0,
        end: 15,
        range: {
          start_line: 1,
          start_column: 1,
          end_line: 1,
          end_column: 16,
        },
        next_cursor: null,
        source_path: "analysis.R",
        document_version: 1,
      };
      const content = {} as Parameters<FileMutationWorkflow["save"]>[0];

      await expect(escaped.updateDraft(content, "escaped"))
        .rejects.toThrow("File workflow capability has expired");
      await expect(escaped.save(content))
        .rejects.toThrow("File workflow capability has expired");
      await expect(escaped.runSourceExecution(execution))
        .rejects.toThrow("File workflow capability has expired");
      await expect(retained!.updateDraft(content, "retained"))
        .rejects.toThrow("File workflow capability has expired");
      await expect(retained!.save(content))
        .rejects.toThrow("File workflow capability has expired");
      await expect(retained!.runSourceExecution(execution))
        .rejects.toThrow("File workflow capability has expired");
      expect(updateDraft).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(sourceSubmit).not.toHaveBeenCalled();
      expect(targetSubmit).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drains one dirty File Save composite before %s and admits a target retry", async (
    _label,
    sameRoot,
  ) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const updateResourceDraft = transport.updateResourceDraft.bind(transport);
    const saveResource = transport.saveResource.bind(transport);
    const openProject = transport.openProject.bind(transport);
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      return nextProjectRevision;
    };
    let markDraftRequested = () => {};
    const draftRequested = new Promise<void>((resolve) => { markDraftRequested = resolve; });
    let releaseDraft = () => {};
    const draftBlocked = new Promise<void>((resolve) => { releaseDraft = resolve; });
    let markSaveRequested = () => {};
    const saveRequested = new Promise<void>((resolve) => { markSaveRequested = resolve; });
    let releaseSave = () => {};
    const saveBlocked = new Promise<void>((resolve) => { releaseSave = resolve; });
    let firstDraftResult: Awaited<ReturnType<typeof transport.updateResourceDraft>> | null = null;
    let settledDraftProjectRevision: number | null = null;
    const updateDraft = vi.fn(async (
      request: Parameters<typeof transport.updateResourceDraft>[0],
    ) => {
      if (updateDraft.mock.calls.length === 1) {
        markDraftRequested();
        await draftBlocked;
      }
      const result = await updateResourceDraft(request);
      if (updateDraft.mock.calls.length === 1) {
        firstDraftResult = result;
        settledDraftProjectRevision = await advanceProjectRevision();
      }
      return result;
    });
    const save = vi.fn(async (request: Parameters<typeof transport.saveResource>[0]) => {
      if (save.mock.calls.length === 1) {
        markSaveRequested();
        await saveBlocked;
      }
      return saveResource(request);
    });
    const broker = vi.fn((path: string) => openProject(path));
    transport.updateResourceDraft = updateDraft;
    transport.saveResource = save;
    transport.openProject = broker;
    if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const sourceMarker = `A_SAVE_${sameRoot ? "SAME_ROOT" : "TO_B"} <- TRUE\n`;

    await act(async () => {
      setValue.call(editor, sourceMarker);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      source.querySelector<HTMLButtonElement>(".rho-file-save")!.click();
      await draftRequested;
    });
    await act(async () => {
      const target = sameRoot
        ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
        : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
      target.click();
      await settle();
    });
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      releaseDraft();
      await saveRequested;
    });
    expect(firstDraftResult).not.toBeNull();
    expect(save.mock.calls[0]?.[0].expected_document_revision)
      .toBe(firstDraftResult!.document_revision);
    expect(save.mock.calls[0]?.[0].target.expected_project_revision)
      .toBe(settledDraftProjectRevision);
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      releaseSave();
      await vi.waitFor(() => expect(
        broker,
        container.querySelector(".rho-project-switch-error")?.textContent ?? container.textContent ?? "",
      ).toHaveBeenCalledOnce());
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(
        container.querySelector("[data-surface-id='rho.file-source']"),
        container.querySelector(".rho-project-switch-error")?.textContent
          ?? container.textContent
          ?? "",
      ).not.toBeNull());
    });
    expect(updateDraft.mock.invocationCallOrder[0])
      .toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(save.mock.invocationCallOrder[0])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    const targetEditor = container.querySelector<HTMLTextAreaElement>(
      "[data-surface-id='rho.file-source'] .rho-source-editor",
    )!;
    expect(targetEditor.value.includes(sourceMarker.trim())).toBe(sameRoot);
    expect(container.querySelector<HTMLButtonElement>(
      "[data-surface-id='rho.file-source'] .rho-file-save",
    )?.disabled).toBe(true);

    const targetMarker = `TARGET_SAVE_${sameRoot ? "A2" : "B"} <- TRUE\n`;
    await act(async () => {
      setValue.call(targetEditor, targetMarker);
      targetEditor.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>(
        "[data-surface-id='rho.file-source'] .rho-file-save",
      )!.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(
        "[data-surface-id='rho.file-source'] .rho-file-save",
      )?.disabled).toBe(true));
      await settle();
    });
    const targetProjectId = (await transport.loadResources()).project_id;
    expect(save.mock.calls[1]?.[0].target.project_id).toBe(targetProjectId);
    expect(container.querySelector(".rho-action-error")).toBeNull();

    if (!sameRoot) {
      const returnMenu = await openRhoMenu(container);
      await act(async () => {
        returnMenu.querySelector<HTMLButtonElement>(`[data-project-path='${projectA}']`)!.click();
        await vi.waitFor(() => expect(
          container.querySelector(".rho-statusbar")?.textContent,
        ).toContain(projectA));
      });
      expect(container.querySelector<HTMLTextAreaElement>(
        "[data-surface-id='rho.file-source'] .rho-source-editor",
      )?.value).toBe(sourceMarker);
    }
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drains a rejected File Save before %s, isolates its error, and admits target retry", async (
    _label,
    sameRoot,
  ) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const update = vi.spyOn(transport, "updateResourceDraft");
    const saveResource = transport.saveResource.bind(transport);
    const openProject = transport.openProject.bind(transport);
    let markSaveRequested = () => {};
    const saveRequested = new Promise<void>((resolve) => { markSaveRequested = resolve; });
    let releaseSaveFailure = () => {};
    const saveFailureBlocked = new Promise<void>((resolve) => {
      releaseSaveFailure = resolve;
    });
    const save = vi.fn(async (request: Parameters<typeof transport.saveResource>[0]) => {
      if (save.mock.calls.length === 1) {
        markSaveRequested();
        await saveFailureBlocked;
        throw new Error("Old File save rejected for test.");
      }
      return saveResource(request);
    });
    const broker = vi.fn((path: string) => openProject(path));
    transport.saveResource = save;
    transport.openProject = broker;
    if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const sourceMarker = `OLD_SAVE_FAILURE_${sameRoot ? "A1" : "A"} <- TRUE\n`;

    await act(async () => {
      setValue.call(editor, sourceMarker);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      source.querySelector<HTMLButtonElement>(".rho-file-save")!.click();
      await saveRequested;
    });
    expect(update).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      const target = sameRoot
        ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
        : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
      target.click();
      await settle();
    });
    expect(broker).not.toHaveBeenCalled();

    await act(async () => {
      releaseSaveFailure();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(
        broker,
        container.querySelector(".rho-project-switch-error")?.textContent
          ?? container.textContent
          ?? "",
      ).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(
        container.querySelector("[data-surface-id='rho.file-source']"),
      ).not.toBeNull());
    });
    expect(save.mock.invocationCallOrder[0])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    expect(container.querySelector(".rho-action-error")).toBeNull();
    const targetEditor = container.querySelector<HTMLTextAreaElement>(
      "[data-surface-id='rho.file-source'] .rho-source-editor",
    )!;
    expect(targetEditor.value.includes(sourceMarker.trim())).toBe(sameRoot);

    const targetMarker = `TARGET_SAVE_RECOVERY_${sameRoot ? "A2" : "B"} <- TRUE\n`;
    await act(async () => {
      setValue.call(targetEditor, targetMarker);
      targetEditor.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>(
        "[data-surface-id='rho.file-source'] .rho-file-save",
      )!.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>(
        "[data-surface-id='rho.file-source'] .rho-file-save",
      )?.disabled).toBe(true));
    });
    const targetProjectId = (await transport.loadResources()).project_id;
    expect(save.mock.calls[1]?.[0].target.project_id).toBe(targetProjectId);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drains dirty File Run preparation before %s, drops the old handoff, and admits the target Run", async (
    _label,
    sameRoot,
  ) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const studio = await transport.loadStudio();
    const nextStudio = structuredClone(studio);
    const root = nextStudio.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(nextStudio);
    const updateResourceDraft = transport.updateResourceDraft.bind(transport);
    const applyStudio = transport.applyStudio.bind(transport);
    const openProject = transport.openProject.bind(transport);
    let markDraftRequested = () => {};
    const draftRequested = new Promise<void>((resolve) => { markDraftRequested = resolve; });
    let releaseDraft = () => {};
    const draftBlocked = new Promise<void>((resolve) => { releaseDraft = resolve; });
    const updateDraft = vi.fn(async (
      request: Parameters<typeof transport.updateResourceDraft>[0],
    ) => {
      if (updateDraft.mock.calls.length === 1) {
        markDraftRequested();
        await draftBlocked;
      }
      return updateResourceDraft(request);
    });
    let markPreparationRequested = () => {};
    const preparationRequested = new Promise<void>((resolve) => {
      markPreparationRequested = resolve;
    });
    let releasePreparation = () => {};
    const preparationBlocked = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const apply = vi.fn(async (request: Parameters<typeof transport.applyStudio>[0]) => {
      if (apply.mock.calls.length === 1) {
        markPreparationRequested();
        await preparationBlocked;
      }
      return applyStudio(request);
    });
    const broker = vi.fn((path: string) => openProject(path));
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    transport.updateResourceDraft = updateDraft;
    transport.applyStudio = apply;
    transport.openProject = broker;
    if (sameRoot) transport.pickProjectDirectory = vi.fn(() => broker(projectA));
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const runButton = source.querySelector<HTMLButtonElement>(
      "[aria-label='Run selection or current R expression in Console']",
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const sourceCode = `A_RUN_${sameRoot ? "SAME_ROOT" : "TO_B"}()`;

    await act(async () => {
      setValue.call(editor, `${sourceCode}\n`);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.setSelectionRange(0, 0);
      runButton.click();
      await draftRequested;
    });
    await act(async () => {
      releaseDraft();
      await preparationRequested;
    });
    expect(updateDraft).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(broker).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await act(async () => {
      const target = sameRoot
        ? menu.querySelector<HTMLButtonElement>(".rho-rho-project")!
        : menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;
      target.click();
      await settle();
    });
    expect(broker).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await act(async () => {
      releasePreparation();
      await vi.waitFor(() => expect(
        broker,
        container.querySelector(".rho-project-switch-error")?.textContent ?? container.textContent ?? "",
      ).toHaveBeenCalledOnce());
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(
        container.querySelector("[data-surface-id='rho.file-source']"),
        container.querySelector(".rho-project-switch-error")?.textContent
          ?? container.textContent
          ?? "",
      ).not.toBeNull());
    });
    expect(updateDraft.mock.invocationCallOrder[0])
      .toBeLessThan(apply.mock.invocationCallOrder[0]!);
    expect(apply.mock.invocationCallOrder[0])
      .toBeLessThan(broker.mock.invocationCallOrder[0]!);
    expect(execute).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-action-error")).toBeNull();
    const targetEditor = container.querySelector<HTMLTextAreaElement>(
      "[data-surface-id='rho.file-source'] .rho-source-editor",
    )!;
    expect(targetEditor.value.includes(sourceCode)).toBe(sameRoot);

    const targetCode = `TARGET_RUN_${sameRoot ? "A2" : "B"}()`;
    await act(async () => {
      setValue.call(targetEditor, `${targetCode}\n`);
      targetEditor.dispatchEvent(new Event("input", { bubbles: true }));
      targetEditor.setSelectionRange(0, 0);
      container.querySelector<HTMLButtonElement>(
        "[data-surface-id='rho.file-source'] [aria-label='Run selection or current R expression in Console']",
      )!.click();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await settle();
    });
    const targetRuntime = await transport.loadRuntimes();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      runtime: {
        project_id: targetRuntime.project_id,
        expected_project_revision: targetRuntime.project_revision,
      },
      code: targetCode,
    });
    expect(execute.mock.calls.some(([request]) => request.code === sourceCode)).toBe(false);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("drops a not-yet-admitted A Console start before A→B and admits a new B execution", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const updateSurface = transport.updateSurface.bind(transport);
    let markUpdateRequested = () => {};
    const updateRequested = new Promise<void>((resolve) => { markUpdateRequested = resolve; });
    let releaseUpdate = () => {};
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let deferFirstUpdate = true;
    const update = vi.fn(async (request: Parameters<typeof transport.updateSurface>[0]) => {
      if (deferFirstUpdate) {
        deferFirstUpdate = false;
        markUpdateRequested();
        await updateBlocked;
      }
      return updateSurface(request);
    });
    transport.updateSurface = update;
    const startExecution = vi.spyOn(transport, "startRuntimeExecution");
    const openProject = vi.spyOn(transport, "openProject");
    const { container } = await renderApp(transport);
    const sourceProjectId = (await transport.loadSurfaces()).project_id;
    const menu = await openRhoMenu(container);
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;
    const history = [...navigator.querySelectorAll<HTMLButtonElement>("[role='tab']")]
      .find((button) => button.textContent === "History")!;

    await act(async () => {
      history.click();
      await updateRequested;
    });
    await act(async () => {
      const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
      const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(composer, "A_ONLY_CODE()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      await Promise.resolve();
    });
    expect(startExecution).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();

    await act(async () => {
      releaseUpdate();
      await vi.waitFor(() => expect(
        openProject,
        container.querySelector(".rho-project-switch-error")?.textContent ?? container.textContent ?? "",
      ).toHaveBeenCalledOnce());
    });
    expect(startExecution).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
    expect(container.querySelector(".rho-action-error")).toBeNull();
    expect(update.mock.calls[0]?.[0].target.project_id).toBe(sourceProjectId);

    const navigatorB = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;
    update.mockRejectedValueOnce(new Error("B Navigator persistence failed."));
    await act(async () => {
      [...navigatorB.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent === "History")!
        .click();
      await settle();
    });
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("B Navigator persistence failed");
    await act(async () => {
      [...navigatorB.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent === "Files")!
        .click();
      await settle();
    });
    expect(container.querySelector(".rho-action-error")).toBeNull();
    const navigatorState = (await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.surface_id === "rho.navigator",
    )?.view_state as { tab?: unknown } | null;
    expect(navigatorState?.tab).toBe("files");

    const consoleB = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composerB = consoleB.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composerB, "B_CURRENT_CODE()");
      composerB.dispatchEvent(new Event("input", { bubbles: true }));
      composerB.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(startExecution).toHaveBeenCalledOnce();
    expect(startExecution.mock.calls[0]?.[0].code).toBe("B_CURRENT_CODE()");
  });

  it("remounts same-id Console on A1→A2 and rejects a pre-admission A1 start", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const reopenProject = transport.openProject.bind(transport);
    const reopen = vi.fn(() => reopenProject(projectA));
    transport.pickProjectDirectory = reopen;
    const updateSurface = transport.updateSurface.bind(transport);
    let markUpdateRequested = () => {};
    const updateRequested = new Promise<void>((resolve) => { markUpdateRequested = resolve; });
    let releaseUpdate = () => {};
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let deferFirstUpdate = true;
    transport.updateSurface = vi.fn(async (request) => {
      if (deferFirstUpdate) {
        deferFirstUpdate = false;
        markUpdateRequested();
        await updateBlocked;
      }
      return updateSurface(request);
    });
    const startExecution = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const consoleA1 = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const beforeSurfaces = await transport.loadSurfaces();
    const beforeInstance = beforeSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === consoleA1.dataset.instanceId,
    )!;
    const menu = await openRhoMenu(container);
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;

    await act(async () => {
      [...navigator.querySelectorAll<HTMLButtonElement>("[role='tab']")]
        .find((button) => button.textContent === "History")!
        .click();
      await updateRequested;
    });
    await act(async () => {
      const composer = consoleA1.querySelector<HTMLTextAreaElement>("textarea")!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(composer, "A1_ONLY_CODE()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      await Promise.resolve();
    });
    expect(reopen).not.toHaveBeenCalled();
    expect(startExecution).not.toHaveBeenCalled();

    await act(async () => {
      releaseUpdate();
      await vi.waitFor(() => expect(
        reopen,
        container.querySelector(".rho-project-switch-error")?.textContent ?? container.textContent ?? "",
      ).toHaveBeenCalledOnce());
    });
    expect(startExecution).not.toHaveBeenCalled();
    const consoleA2 = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(consoleA2).not.toBe(consoleA1);
    expect(consoleA2.dataset.instanceId).toBe(consoleA1.dataset.instanceId);
    const afterSurfaces = await transport.loadSurfaces();
    const afterInstance = afterSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === consoleA2.dataset.instanceId,
    )!;
    expect(afterInstance.activation_generation).toBe(beforeInstance.activation_generation);
    expect(consoleA2.textContent).not.toContain("A1_ONLY_CODE()");
    expect(container.querySelector(".rho-action-error")).toBeNull();

    const composerA2 = consoleA2.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composerA2, "A2_CURRENT_CODE()");
      composerA2.dispatchEvent(new Event("input", { bubbles: true }));
      composerA2.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(startExecution).toHaveBeenCalledOnce();
    expect(startExecution.mock.calls[0]?.[0].code).toBe("A2_CURRENT_CODE()");
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("isolates a deferred A Console follow across %s and keeps target follow live", async (_label, sameRoot) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const originalFollow = transport.followRuntimeOutput.bind(transport);
    let markFirstFollowRequested = () => {};
    const firstFollowRequested = new Promise<void>((resolve) => {
      markFirstFollowRequested = resolve;
    });
    let releaseFirstFollow = () => {};
    const firstFollowBlocked = new Promise<void>((resolve) => { releaseFirstFollow = resolve; });
    let firstFollow = true;
    transport.followRuntimeOutput = vi.fn(async (executionId, afterSequence, listener) => {
      if (!firstFollow) return originalFollow(executionId, afterSequence, listener);
      firstFollow = false;
      const pendingDeliveries: Array<() => void> = [];
      await originalFollow(executionId, afterSequence, (frame) => {
        const lateFrame = frame.type === "chunks"
          ? {
              ...frame,
              chunks: frame.chunks.map((chunk, index) => index === 0
                ? {
                    ...chunk,
                    text_payload: "A_LATE_FOLLOW_ONLY",
                    payload_bytes: 18,
                  }
                : chunk),
            }
          : frame;
        pendingDeliveries.push(() => listener(lateFrame));
      });
      markFirstFollowRequested();
      await firstFollowBlocked;
      for (const deliver of pendingDeliveries) deliver();
      throw new Error("A late follow rejection");
    });
    transport.queueRuntimeEvents([{
      sequence: 1,
      runtime_instance_id: "runtime:workspace-r",
      console_instance_id: "instance:console-a",
      kind: "workspace_result",
      payload: {
        execution: {
          ok: true,
          code: "A_FOLLOW_SOURCE()",
          stdout: "",
          value: "A_DURABLE_OUTPUT",
          messages: [],
          warnings: [],
          error: null,
        },
      },
    }]);
    const reopenProject = transport.openProject.bind(transport);
    const reopen = vi.fn(() => reopenProject(projectA));
    if (sameRoot) transport.pickProjectDirectory = reopen;
    const switchProject = sameRoot ? reopen : vi.spyOn(transport, "openProject");
    const startExecution = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const sourceConsole = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const sourceInstance = (await transport.loadSurfaces()).catalog.instances.find(
      (instance) => instance.instance_id === sourceConsole.dataset.instanceId,
    )!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

    await act(async () => {
      const composer = sourceConsole.querySelector<HTMLTextAreaElement>("textarea")!;
      setTextarea.call(composer, "A_FOLLOW_SOURCE()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await firstFollowRequested;
    });
    expect(startExecution).toHaveBeenCalledOnce();
    expect(transport.followRuntimeOutput).toHaveBeenCalledOnce();

    const menu = await openRhoMenu(container);
    await act(async () => {
      if (sameRoot) {
        menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      } else {
        menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      }
      await vi.waitFor(() => expect(switchProject).toHaveBeenCalledOnce());
      for (let index = 0; index < 48; index += 1) await Promise.resolve();
    });
    const targetConsole = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(sourceConsole.isConnected).toBe(false);
    expect(targetConsole).not.toBe(sourceConsole);
    expect(container.querySelector(".rho-action-error")).toBeNull();
    if (sameRoot) {
      expect(targetConsole.dataset.instanceId).toBe(sourceConsole.dataset.instanceId);
      const targetInstance = (await transport.loadSurfaces()).catalog.instances.find(
        (instance) => instance.instance_id === targetConsole.dataset.instanceId,
      )!;
      expect(targetInstance.activation_generation).toBe(sourceInstance.activation_generation);
    } else {
      expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectB);
      expect(targetConsole.textContent).not.toContain("A_FOLLOW_SOURCE()");
      expect(targetConsole.textContent).not.toContain("A_DURABLE_OUTPUT");
    }

    const targetMarker = sameRoot ? "A2_TARGET_FOLLOW" : "B_TARGET_FOLLOW";
    const targetCode = `${targetMarker}()`;
    transport.queueRuntimeEvents([{
      sequence: 1,
      runtime_instance_id: "runtime:workspace-r",
      console_instance_id: "instance:console-a",
      kind: "workspace_result",
      payload: {
        execution: {
          ok: true,
          code: targetCode,
          stdout: "",
          value: targetMarker,
          messages: [],
          warnings: [],
          error: null,
        },
      },
    }]);
    await act(async () => {
      const composer = targetConsole.querySelector<HTMLTextAreaElement>("textarea")!;
      setTextarea.call(composer, targetCode);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await vi.waitFor(() => expect(startExecution).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(transport.followRuntimeOutput).toHaveBeenCalledTimes(2));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(targetConsole.textContent).toContain(targetMarker);
    const baselineText = targetConsole.textContent;
    const baselineEntries = targetConsole.querySelectorAll(".rho-console-entry").length;

    await act(async () => {
      releaseFirstFollow();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(targetConsole.textContent).toBe(baselineText);
    expect(targetConsole.querySelectorAll(".rho-console-entry")).toHaveLength(baselineEntries);
    expect(targetConsole.textContent).not.toContain("A_LATE_FOLLOW_ONLY");
    expect(container.querySelector(".rho-action-error")?.textContent ?? "")
      .not.toContain("A late follow rejection");

    const otherTab = container.querySelector<HTMLElement>(
      "[data-rho-tab-instance-id='instance:console-b']",
    )!;
    await act(async () => {
      const dockviewTab = otherTab.closest<HTMLElement>(".dv-tab")!;
      pointer(dockviewTab, "pointerdown", 10, 10);
      pointer(dockviewTab, "pointerup", 10, 10);
      otherTab.click();
      await settle();
    });
    const targetTab = container.querySelector<HTMLElement>(
      "[data-rho-tab-instance-id='instance:console-a']",
    )!;
    await act(async () => {
      const dockviewTab = targetTab.closest<HTMLElement>(".dv-tab")!;
      pointer(dockviewTab, "pointerdown", 10, 10);
      pointer(dockviewTab, "pointerup", 10, 10);
      targetTab.click();
      await settle();
    });
    const restoredTarget = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    expect(restoredTarget.dataset.instanceId).toBe("instance:console-a");
    expect(restoredTarget.textContent).toContain(targetMarker);
    expect(restoredTarget.textContent).not.toContain("A_LATE_FOLLOW_ONLY");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it.each([
    ["A→B", false],
    ["same-root A1→A2", true],
  ])("drops a deferred A Runtime reference after %s", async (_label, sameRoot) => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    transport.queueRuntimeEvents([{
      sequence: 1,
      runtime_instance_id: "runtime:workspace-r",
      console_instance_id: "instance:console-a",
      kind: "workspace_result",
      payload: {
        execution: {
          ok: true,
          code: "summary(mtcars)",
          stdout: "summary output",
          value: "summary value",
          messages: [],
          warnings: [],
          error: null,
        },
      },
    }]);
    const ready = structuredClone(await transport.loadSnapshot());
    (ready.health as { agent: typeof ready.health.agent }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (ready.context as { agent_health: "ready" }).agent_health = "ready";
    transport.publish(ready);
    const reopenProject = transport.openProject.bind(transport);
    const reopen = vi.fn(() => reopenProject(projectA));
    if (sameRoot) transport.pickProjectDirectory = reopen;
    const openProject = sameRoot ? null : vi.spyOn(transport, "openProject");
    const runAgent = vi.spyOn(transport, "runAgent");
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "summary(mtcars)");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.runs']")!
        .querySelector<HTMLButtonElement>("button")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    const history = container.querySelector<HTMLElement>("[data-surface-id='rho.runs']")!;
    const createReference = transport.createRuntimeOutputReference.bind(transport);
    let markReferenceRequested = () => {};
    const referenceRequested = new Promise<void>((resolve) => { markReferenceRequested = resolve; });
    let releaseReference = () => {};
    const referenceBlocked = new Promise<void>((resolve) => { releaseReference = resolve; });
    transport.createRuntimeOutputReference = vi.fn(async (
      executionId: string,
      startSequence?: number,
      endSequence?: number,
    ) => {
      markReferenceRequested();
      await referenceBlocked;
      return createReference(executionId, startSequence, endSequence);
    });
    const menu = await openRhoMenu(container);
    await act(async () => {
      [...history.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Use output in Agent")!
        .click();
      await referenceRequested;
      if (sameRoot) menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      else menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!.click();
      await vi.waitFor(() => {
        if (sameRoot) expect(reopen).toHaveBeenCalledOnce();
        else expect(openProject).toHaveBeenCalledOnce();
        expect(container.querySelector(".rho-statusbar")?.textContent)
          .toContain(sameRoot ? projectA : projectB);
      });
    });

    await act(async () => {
      releaseReference();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-agent-context-chip")).toBeNull();
    expect(container.querySelector(".rho-action-error")).toBeNull();

    const currentReady = structuredClone(await transport.loadSnapshot());
    (currentReady.health as { agent: typeof currentReady.health.agent }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (currentReady.context as { agent_health: "ready" }).agent_health = "ready";
    await act(async () => {
      transport.publish(currentReady);
      await settle();
    });
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const agentComposer = agent.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await act(async () => {
      setTextarea.call(agentComposer, "Explain the current project without old output");
      agentComposer.dispatchEvent(new Event("input", { bubbles: true }));
      [...agent.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Send")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].runtime_output_context).toBeNull();
  }, 10_000);

  it("shows, hides, and persists an optional toolbar component", async () => {
    const transport = createMockUiKernelTransport();
    const projectId = (await transport.loadUiProfile()).profile.project_id;
    const { container } = await renderApp(transport);
    await showToolbarComponent(container, "Compose");
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    expect(loadToolbarLayout(window.localStorage, projectId).layout.visible).toEqual(["compose"]);

    await openToolbarCustomizer(container);
    const compose = [...container.querySelectorAll<HTMLLabelElement>(".rho-toolbar-option label")]
      .find((candidate) => candidate.textContent === "Compose")!;
    await act(async () => {
      compose.querySelector<HTMLInputElement>("input")!.click();
      await settle();
    });
    expect(container.querySelector("[data-toolbar-component='compose']")).toBeNull();
    expect(loadToolbarLayout(window.localStorage, projectId).layout.visible).toEqual([]);
  });

  it("resets visibility and ordering to the minimal default", async () => {
    const transport = createMockUiKernelTransport();
    const projectId = (await transport.loadUiProfile()).profile.project_id;
    const configured = setToolbarComponentVisible(
      {
        ...defaultToolbarLayout(),
        order: [
          "compose",
          "command_search",
        ],
      },
      "compose",
      true,
    );
    saveToolbarLayout(window.localStorage, projectId, configured);
    const { container } = await renderApp(transport);
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    await openToolbarCustomizer(container);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-toolbar-customizer footer button")!.click();
      await settle();
    });
    expect(container.querySelectorAll("[data-toolbar-component]")).toHaveLength(0);
    expect(loadToolbarLayout(window.localStorage, projectId).layout).toEqual(defaultToolbarLayout());
  });

  it("pointer-reorders the optional list and persists only on release", async () => {
    installPointerCapture();
    const transport = createMockUiKernelTransport();
    const projectId = (await transport.loadUiProfile()).profile.project_id;
    saveToolbarLayout(window.localStorage, projectId, defaultToolbarLayout());
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const { container } = await renderApp(transport);
    await openToolbarCustomizer(container);
    persist.mockClear();
    const projectRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='command_search']")!;
    const composeRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='compose']")!;
    Object.defineProperty(projectRow, "getBoundingClientRect", { configurable: true, value: () => rect(0, 100, 240, 40) });
    hitTest(projectRow);
    const grip = composeRow.querySelector<HTMLButtonElement>(".rho-toolbar-grip")!;
    await act(async () => {
      pointer(grip, "pointerdown", 12, 12, 71);
      pointer(grip, "pointermove", 12, 104, 71);
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>("[data-toolbar-option-id]")?.dataset.toolbarOptionId)
      .toBe("compose");
    await act(async () => {
      pointer(grip, "pointerup", 12, 104, 71);
      await settle();
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(loadToolbarLayout(window.localStorage, projectId).layout.order[0]).toBe("compose");
  });

  it("restores a pointer preview on Escape and supports Arrow-key reorder", async () => {
    installPointerCapture();
    const { container } = await renderApp();
    await openToolbarCustomizer(container);
    const projectRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='command_search']")!;
    const composeRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='compose']")!;
    Object.defineProperty(projectRow, "getBoundingClientRect", { configurable: true, value: () => rect(0, 100, 240, 40) });
    hitTest(projectRow);
    const composeGrip = composeRow.querySelector<HTMLButtonElement>(".rho-toolbar-grip")!;
    await act(async () => {
      pointer(composeGrip, "pointerdown", 12, 12, 72);
      pointer(composeGrip, "pointermove", 12, 104, 72);
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    const rowsAfterCancel = [...container.querySelectorAll<HTMLElement>("[data-toolbar-option-id]")];
    expect(rowsAfterCancel.at(-1)?.dataset.toolbarOptionId).toBe("compose");

    const gripAfterCancel = rowsAfterCancel.at(-1)!.querySelector<HTMLButtonElement>(".rho-toolbar-grip")!;
    await act(async () => {
      gripAfterCancel.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await settle();
    });
    const rowsAfterKeyboard = [...container.querySelectorAll<HTMLElement>("[data-toolbar-option-id]")];
    expect(rowsAfterKeyboard.at(-2)?.dataset.toolbarOptionId).toBe("compose");
  });

  it("opens hidden command search with the global shortcut without pinning it", async () => {
    const { container } = await renderApp();
    expect(container.querySelector(".rho-command-search")).toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }));
      await settle();
    });
    const input = container.querySelector<HTMLInputElement>(".rho-toolbar-command-overlay [aria-label='Search commands']");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(container.querySelector("[data-toolbar-component='command_search']")).toBeNull();
  });

  it("keeps a failed toolbar write usable for the current session", async () => {
    const { container } = await renderApp();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await showToolbarComponent(container, "Compose");
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Toolbar changed for this session",
    );
  });

  it("reloads toolbar preferences when the exact project identity changes", async () => {
    const firstPath = "/tmp/toolbar-first";
    const secondPath = "/tmp/toolbar-other";
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(firstPath)}`);
    const first = await transport.loadUiProfile();
    const firstLayout = setToolbarComponentVisible(defaultToolbarLayout(), "compose", true);
    saveToolbarLayout(window.localStorage, first.profile.project_id, firstLayout);
    const secondProjectId = `project:mock:${encodeURIComponent(secondPath)}`;
    const secondLayout = setToolbarComponentVisible(defaultToolbarLayout(), "command_search", true);
    saveToolbarLayout(window.localStorage, secondProjectId, secondLayout);
    saveProjectHistory(window.localStorage, { version: 1, paths: [firstPath, secondPath] });
    const { container } = await renderApp(transport);
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(`[data-project-path='${secondPath}']`)!.click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(container.querySelector("[data-toolbar-component='compose']")).toBeNull();
    expect(container.querySelector("[data-toolbar-component='command_search']")).not.toBeNull();
  });

  it("renders a recursive asymmetric scene while Agent degradation stays isolated", async () => {
    const { container } = await renderApp(
      createMockUiKernelTransport("?project=%2Ftmp%2FRho%20Lab"),
    );
    expect(container.textContent).toContain("Rho Lab");
    expect(container.querySelectorAll(".rho-environment-taskbar-metric")).toHaveLength(3);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Environment realtime information']")!.click();
      await settle();
    });
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.textContent).toContain("Agent runtime needs attention");
    expect(container.textContent).toContain("Source editor");
    expect(container.textContent).toContain("Navigator");
    await openInspector(container);
    expect(container.textContent).toContain("2 tabs");
    expect(container.querySelectorAll(".dv-split-view-container")).toHaveLength(4);
    expect(container.querySelectorAll(".dv-sash[role='separator']")).toHaveLength(3);
    expect(container.querySelector(".rho-layout-mini-map")).not.toBeNull();
    expect(container.querySelector(".rho-layout-mini-map [data-focused='true']")).not.toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".rho-recent-closed")?.open).toBe(false);
    expect(container.querySelector(".rho-recent-closed")?.textContent).toContain("Recently closed views");
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

  it("renders fixed Scene policies through the controlled Dockview path", async () => {
    const transport = createMockUiKernelTransport();
    const studio = structuredClone(await transport.loadStudio());
    if (studio.scene.root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    (studio.scene.root as unknown as { children: LayoutChild[] }).children = studio.scene.root.children.map(
      (entry, index) => ({
        ...entry,
        basis: { kind: "fixed", logical_pixels: [260, 380, 370][index] ?? 240 },
      }),
    );
    transport.publishStudio(studio);
    const { container } = await renderApp(transport);
    expect(container.querySelector(".rho-dockview-scene")).not.toBeNull();
    expect(container.querySelectorAll(".dv-groupview")).toHaveLength(4);
    expect(container.querySelector(".rho-layout-container")).toBeNull();
  });

  it("names adaptive collapsed regions by component and restores them without leaking layout ids", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const { container } = await renderApp();
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback([{
          target: document.body,
          contentRect: { width: 600, height: 900 },
        } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
      await settle();
    });

    const rail = container.querySelector<HTMLElement>(".rho-collapse-rail")!;
    expect(rail.getAttribute("aria-label")).toBe("Hidden components");
    expect(rail.textContent).toContain("Show Agent");
    expect(rail.textContent).not.toContain("node:");
    expect(rail.textContent).not.toContain("layout-");
    const restore = rail.querySelector<HTMLButtonElement>(".rho-collapse-restore")!;
    expect(restore.getAttribute("aria-label")).toBe("Show collapsed Agent");
    await act(async () => {
      restore.click();
      await settle();
    });
    expect(container.querySelector(".rho-collapse-rail")?.textContent).toContain("Show Navigator");
    expect(container.querySelector(".rho-collapse-rail")?.textContent).not.toContain("Show Agent");
    expect(container.querySelector("[data-surface-id='rho.agent']")).not.toBeNull();
  });

  it("keeps Surface diagnostics and management out of the focused default chrome", async () => {
    const { container } = await renderApp();
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    expect(source.querySelector(".rho-surface-chrome .rho-eyebrow")).toBeNull();
    expect(source.querySelector(".rho-surface-meta")).toBeNull();
    expect(source.textContent).not.toContain("rho.file-source");

    const menu = await openSurfaceMenu(source);
    expect(menu.textContent).toContain("Component");
    expect(menu.textContent).toContain("rho.file-source");
    expect(menu.textContent).toContain("Revision");
    expect(menu.textContent).toContain("Duplicate component");

    await act(async () => {
      pointer(document.body, "pointerdown", 600, 600);
      await settle();
    });
    expect(document.querySelector("[role='dialog'][aria-label='More actions for Source editor']")).toBeNull();

    await act(async () => {
      source.querySelector<HTMLButtonElement>("[aria-label^='File information for']")!.click();
      await settle();
    });
    const fileInfo = source.querySelector<HTMLElement>(".rho-file-commandbar .rho-menu-popover-panel")!;
    expect(fileInfo.textContent).toContain("Media type");
    expect(fileInfo.textContent).toContain("Document revision");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(source.querySelector(".rho-file-commandbar .rho-menu-popover-panel")).toBeNull();
    expect(document.activeElement).toBe(source.querySelector("[aria-label^='File information for']"));
    expect(source.textContent).not.toContain("Apply view group");
    expect(source.textContent).not.toContain("Rename file");
    await act(async () => {
      source.querySelector<HTMLButtonElement>("[aria-label^='More file actions for']")!.click();
      await settle();
    });
    const fileActions = source.querySelector<HTMLElement>(".rho-file-more-menu")!;
    expect(fileActions.textContent).toContain("Apply view group");
    expect(fileActions.textContent).toContain("Rename file");
    expect(fileActions.textContent).toContain("Delete file");
  });

  it("uses Dockview tabs as the sole component title and hosts management beside them", async () => {
    const { container } = await renderApp();
    for (const [surfaceId, title] of [
      ["rho.navigator", "Navigator"],
      ["rho.console", "R Console"],
      ["rho.file-source", "Source editor"],
    ] as const) {
      const surface = container.querySelector<HTMLElement>(`[data-surface-id='${surfaceId}']`)!;
      const instanceId = surface.dataset.instanceId;
      const tab = container.querySelector<HTMLElement>(`[data-rho-tab-instance-id='${instanceId}']`)!;
      const actionsHost = [...container.querySelectorAll<HTMLElement>("[data-rho-surface-actions-host]")]
        .find((candidate) => candidate.dataset.rhoSurfaceActionsHost === instanceId);
      expect(tab.textContent).toContain(title);
      expect(surface.querySelector(":scope > .rho-surface-chrome")).toBeNull();
      expect(actionsHost?.querySelector(`[aria-label='More actions for ${title}']`)).not.toBeNull();
      expect(surface.querySelector("[aria-label^='Remove']")).toBeNull();
      expect(tab.closest(".dv-tab")?.querySelector("[aria-label='Close tab']")).not.toBeNull();
    }
  });

  it("runs the complete Source expression in the exact visible Console with provenance and advances once", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const consoleDraft = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(consoleDraft, "draft stays here");
      consoleDraft.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
      editor.setSelectionRange(2, 2);
      source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      console_instance_id: "instance:console-a",
      code: "library(ggplot2)",
      runtime: { runtime_instance_id: "runtime:workspace-r" },
      source_context: {
        source_path: "analysis.R",
        execution_mode: "expression",
        document_version: 1,
        source_range: { start_line: 1, start_column: 1, end_line: 1, end_column: 17 },
      },
    });
    expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
    expect(editor.selectionEnd).toBe(editor.selectionStart);
    expect(document.activeElement).toBe(editor);
    expect(consoleDraft.value).toBe("draft stays here");
    expect(consoleView.querySelector(".rho-console-entry")?.textContent).toContain("library(ggplot2)");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("runs a literal Source selection from the shortcut without moving it", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    const start = editor.value.indexOf("plot(");
    const end = editor.value.indexOf("\n", start);
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(start, end);
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        ctrlKey: true,
      }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].code).toBe("plot(mtcars$wt, mtcars$mpg)");
    expect(editor.selectionStart).toBe(start);
    expect(editor.selectionEnd).toBe(end);
    expect(document.activeElement).toBe(editor);
  });

  it("runs the complete multiline R expression when Command+Enter starts inside it", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    const expression = [
      "df <- do.call(rbind, lapply(c(\"A\", \"B\", \"C\"), function(g) {",
      "  intercept <- switch(g,",
      "    A = 2,",
      "    B = 5,",
      "    C = 8",
      "  )",
      "  data.frame(",
      "    x = runif(34, 0, 10),",
      "    y = intercept + 0.8 * runif(34, 0, 10),",
      "    group = g",
      "  )",
      "}))",
    ].join("\n");
    const document = `${expression}\nafter <- 2`;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(editor, document);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const cursor = document.indexOf("intercept <-");
      editor.setSelectionRange(cursor, cursor);
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      }));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      code: expression,
      source_context: {
        source_path: "analysis.R",
        execution_mode: "expression",
        document_version: 2,
        source_range: { start_line: 1, start_column: 1, end_line: 12, end_column: 4 },
      },
    });
    expect(editor.selectionStart).toBe(expression.length + 1);
  });

  it("skips blank and comment-only gaps between sequential Source expressions", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    const document = "library(ggplot2)\n\n# ---- generate data ----\n   # details\nset.seed(42)";
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(editor, document);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
      editor.setSelectionRange(0, 0);
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Enter", metaKey: true,
      }));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(editor.selectionStart).toBe(document.indexOf("set.seed"));
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      const gap = document.indexOf("# ----");
      editor.setSelectionRange(gap, gap);
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Enter", metaKey: true,
      }));
      await settle();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(editor.selectionStart).toBe(document.indexOf("set.seed"));
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("treats a terminal empty Source line as a quiet navigation no-op", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      run.click();
      await settle();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(editor.selectionStart).toBe(editor.value.length);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("rejects a busy Console before advancing or dispatching Source code", async () => {
    const transport = createMockUiKernelTransport();
    const runtimes = await transport.loadRuntimes();
    const next = structuredClone(runtimes);
    (next.instances[0] as { status: string }).status = "busy";
    transport.publishRuntimes(next);
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      run.click();
      await settle();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(editor.selectionStart).toBe(0);
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("is busy");
  });

  it("rejects unbound and recovering Console targets without advancing Source", async () => {
    const unboundTransport = createMockUiKernelTransport();
    const surfaces = await unboundTransport.loadSurfaces();
    const unbound = structuredClone(surfaces);
    const unboundConsole = unbound.catalog.instances.find(
      (instance) => instance.instance_id === "instance:console-a",
    );
    if (unboundConsole == null) throw new Error("Mock primary Console is missing.");
    (unboundConsole as { runtime_binding: null }).runtime_binding = null;
    unboundTransport.publishSurfaces(unbound);
    const unboundExecute = vi.spyOn(unboundTransport, "startRuntimeExecution");
    const { container: unboundContainer } = await renderApp(unboundTransport);
    const unboundSource = unboundContainer.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const unboundEditor = unboundSource.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      unboundEditor.setSelectionRange(0, 0);
      unboundSource.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      await settle();
    });
    expect(unboundExecute).not.toHaveBeenCalled();
    expect(unboundEditor.selectionStart).toBe(0);
    expect(unboundContainer.querySelector(".rho-action-error")?.textContent).toContain("not attached");

    const recoveringTransport = createMockUiKernelTransport();
    const runtimes = await recoveringTransport.loadRuntimes();
    const recovering = structuredClone(runtimes);
    (recovering.instances[0] as { status: string }).status = "restarting";
    recoveringTransport.publishRuntimes(recovering);
    const recoveringExecute = vi.spyOn(recoveringTransport, "startRuntimeExecution");
    const { container: recoveringContainer } = await renderApp(recoveringTransport);
    const recoveringSource = recoveringContainer.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const recoveringEditor = recoveringSource.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      recoveringEditor.setSelectionRange(0, 0);
      recoveringSource.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      await settle();
    });
    expect(recoveringExecute).not.toHaveBeenCalled();
    expect(recoveringEditor.selectionStart).toBe(0);
    expect(recoveringContainer.querySelector(".rho-action-error")?.textContent).toContain("is recovering");
  });

  it("keeps an admitted line advanced through Runtime failure and accepts the next retry", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    execute.mockRejectedValueOnce(new Error("Workspace R rejected this expression."));
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      run.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const secondLine = editor.value.indexOf("\n") + 1;
    expect(editor.selectionStart).toBe(secondLine);
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("Workspace R rejected");

    await act(async () => {
      run.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0].code).toBe("plot(mtcars$wt, mtcars$mpg)");
    expect(container.querySelector("[data-surface-id='rho.console'] .rho-console-entry")?.textContent)
      .toContain("plot(mtcars$wt, mtcars$mpg)");
  });

  it("preserves a bounded raw Tauri Runtime rejection instead of a generic failure", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    execute.mockRejectedValueOnce("Console Surface request is stale; wait for the current execution to finish.");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Enter", metaKey: true,
      }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toBe("Console Surface request is stale; wait for the current execution to finish.");
    expect(container.querySelector(".rho-action-error")?.textContent)
      .not.toBe("Runtime operation failed.");
  });

  it("renders a large Runtime result without copying transcript payloads into Surface view state", async () => {
    const transport = createMockUiKernelTransport();
    const update = vi.spyOn(transport, "updateSurface");
    transport.queueRuntimeEvents([{
        sequence: 1,
        runtime_instance_id: "runtime:workspace-r",
        console_instance_id: "instance:console-a",
        kind: "mock_result",
        payload: { text: `useful-prefix-${"x".repeat(280_000)}` },
      }]);
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "large_result()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    expect(consoleView.querySelector(".rho-console-result")?.textContent).toContain("useful-prefix-");
    const consoleWrites = update.mock.calls.flatMap(([request]) => (
      request.target.instance_id === "instance:console-a" && request.mutation.kind === "set_view_state"
        ? [request.mutation.view_state]
        : []
    ));
    expect(consoleWrites.length).toBeGreaterThan(0);
    for (const viewState of consoleWrites) {
      expect(new TextEncoder().encode(JSON.stringify(viewState)).byteLength).toBeLessThan(64 * 1024);
      expect(viewState).toEqual(expect.objectContaining({
        schema_version: 4,
        follow_tail: expect.any(Boolean),
      }));
      expect(viewState).not.toHaveProperty("outputs");
      expect(viewState).not.toHaveProperty("history");
      expect(viewState).not.toHaveProperty("draft");
    }
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("does not admit the next Source expression until Console state persistence settles", async () => {
    const transport = createMockUiKernelTransport();
    const originalUpdate = transport.updateSurface.bind(transport);
    let releaseConsolePersist: (() => void) | null = null;
    let heldConsolePersist = false;
    let consolePersistCount = 0;
    transport.updateSurface = vi.fn(async (request) => {
      const viewState = request.mutation.kind === "set_view_state"
        ? request.mutation.view_state as { readonly schema_version?: number }
        : null;
      if (request.target.instance_id === "instance:console-a" && viewState?.schema_version === 4) {
        consolePersistCount += 1;
      }
      if (
        !heldConsolePersist && request.target.instance_id === "instance:console-a" &&
        viewState?.schema_version === 4 && consolePersistCount === 2
      ) {
        heldConsolePersist = true;
        await new Promise<void>((resolve) => { releaseConsolePersist = resolve; });
      }
      return originalUpdate(request);
    });
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    const runShortcut = () => editor.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "Enter", metaKey: true,
    }));

    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      runShortcut();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(releaseConsolePersist).not.toBeNull();
    expect(editor.selectionStart).toBe(editor.value.indexOf("plot("));

    await act(async () => {
      runShortcut();
      await settle();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("is busy");

    await act(async () => {
      releaseConsolePersist?.();
      for (let index = 0; index < 64; index += 1) await Promise.resolve();
      runShortcut();
      for (let index = 0; index < 32; index += 1) await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0].code).toBe("plot(mtcars$wt, mtcars$mpg)");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("reuses and places an unplaced Console below Source before continuing execution", async () => {
    const transport = createMockUiKernelTransport();
    const open = vi.spyOn(transport, "openSurface");
    const attach = vi.spyOn(transport, "attachRuntime");
    const apply = vi.spyOn(transport, "applyStudio");
    const studio = await transport.loadStudio();
    const next = structuredClone(studio);
    const root = next.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(next);
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
      await settle();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      console_instance_id: "instance:console-a",
      code: "library(ggplot2)",
    });
    expect(open).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit.kind).toBe("replace_root");
    expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
    const emerged = container.querySelector<HTMLElement>("[data-instance-id='instance:console-a']")!;
    expect(emerged).not.toBeNull();
    expect(emerged.querySelector(".rho-console-composer textarea")).not.toBeNull();
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await openInspector(container);
    const undo = [...container.querySelectorAll<HTMLButtonElement>(".rho-inspector-actions button")]
      .find((button) => button.textContent === "Undo")!;
    await act(async () => {
      undo.click();
      await settle();
    });
    expect(container.querySelector("[data-instance-id='instance:console-a']")).toBeNull();
  });

  it("activates a compatible hidden Console tab without moving or creating it", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const next = structuredClone(studio);
    const root = next.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    const context = root.children[2]?.child;
    if (center?.kind !== "container" || context?.kind !== "stack") {
      throw new Error("Mock Studio center/context layout is unavailable.");
    }
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    (context as unknown as { instances: string[] }).instances = [
      ...context.instances,
      "instance:console-a",
    ];
    transport.publishStudio(next);
    const open = vi.spyOn(transport, "openSurface");
    const apply = vi.spyOn(transport, "applyStudio");
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(open).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit).toMatchObject({
      kind: "set_stack_active",
      stack_node_id: context.node_id,
      instance_id: "instance:console-a",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].console_instance_id).toBe("instance:console-a");
    expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
  });

  it("keeps Source mounted when one Console shares its Stack by reusing another Console", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const next = structuredClone(studio);
    const root = next.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = [{
      ...center.children[0]!,
      child: {
        kind: "stack",
        node_id: "node:source-console-stack",
        active_instance_id: "instance:file-source",
        instances: ["instance:file-source", "instance:console-a"],
      },
    }];
    transport.publishStudio(next);
    const apply = vi.spyOn(transport, "applyStudio");
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      container.querySelector<HTMLButtonElement>("[data-surface-id='rho.file-source'] [aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 18; index += 1) await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit.kind).toBe("replace_root");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].console_instance_id).toBe("instance:console-b");
    expect(container.querySelector("[data-rho-pane-node-id='node:source-console-stack']")).not.toBeNull();
    expect(container.querySelector("[data-surface-id='rho.file-source'] [aria-label^='Source']")).toBe(editor);
    expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
  });

  it("attaches an unplaced Console to the exact primary Runtime and rejects emergence without one", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const nextStudio = structuredClone(studio);
    const root = nextStudio.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(nextStudio);
    const surfaces = await transport.loadSurfaces();
    const nextSurfaces = structuredClone(surfaces);
    const consoleA = nextSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:console-a",
    );
    if (consoleA == null) throw new Error("Mock Console A is missing.");
    (consoleA as { runtime_binding: null }).runtime_binding = null;
    (nextSurfaces.catalog as unknown as { instances: typeof nextSurfaces.catalog.instances })
      .instances = nextSurfaces.catalog.instances.filter(
        (instance) => instance.surface_id !== "rho.console" || instance.instance_id === "instance:console-a",
      );
    transport.publishSurfaces(nextSurfaces);
    const attach = vi.spyOn(transport, "attachRuntime");
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0]?.[0]).toMatchObject({
      runtime: { runtime_instance_id: "runtime:workspace-r" },
      surface: { instance_id: "instance:console-a" },
    });
    expect(execute).toHaveBeenCalledOnce();

    const noRuntimeTransport = createMockUiKernelTransport();
    const noRuntimeStudio = await noRuntimeTransport.loadStudio();
    const noRuntimeLayout = structuredClone(noRuntimeStudio);
    const noRuntimeRoot = noRuntimeLayout.scene.root;
    if (noRuntimeRoot.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const noRuntimeCenter = noRuntimeRoot.children[1]?.child;
    if (noRuntimeCenter?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (noRuntimeCenter as unknown as { children: LayoutChild[] }).children = noRuntimeCenter.children.slice(0, 1);
    noRuntimeTransport.publishStudio(noRuntimeLayout);
    const runtimes = await noRuntimeTransport.loadRuntimes();
    const noRuntime = structuredClone(runtimes);
    (noRuntime as unknown as { instances: [] }).instances = [];
    noRuntimeTransport.publishRuntimes(noRuntime);
    const noRuntimeOpen = vi.spyOn(noRuntimeTransport, "openSurface");
    const noRuntimeExecute = vi.spyOn(noRuntimeTransport, "startRuntimeExecution");
    const { container: noRuntimeContainer } = await renderApp(noRuntimeTransport);
    const noRuntimeSource = noRuntimeContainer.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const noRuntimeEditor = noRuntimeSource.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      noRuntimeEditor.setSelectionRange(0, 0);
      noRuntimeSource.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      await settle();
    });
    expect(noRuntimeOpen).not.toHaveBeenCalled();
    expect(noRuntimeExecute).not.toHaveBeenCalled();
    expect(noRuntimeEditor.selectionStart).toBe(0);
    expect(noRuntimeContainer.querySelector(".rho-action-error")?.textContent).toContain("No primary scientific Runtime");
  });

  it("shows preparation and does not overwrite a cursor moved while Console placement is pending", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const next = structuredClone(studio);
    const root = next.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(next);
    const originalApply = transport.applyStudio.bind(transport);
    let release: (() => void) | null = null;
    transport.applyStudio = vi.fn((request: Parameters<typeof originalApply>[0]) =>
      new Promise<Awaited<ReturnType<typeof originalApply>>>((resolve, reject) => {
      release = () => { void originalApply(request).then(resolve, reject); };
      }));
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      run.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(run.disabled).toBe(true);
    expect(run.textContent).toContain("Preparing");
    const movedCursor = editor.value.indexOf("plot(");
    editor.setSelectionRange(movedCursor, movedCursor);
    await act(async () => {
      release?.();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].code).toBe("library(ggplot2)");
    expect(editor.selectionStart).toBe(movedCursor);
    expect(run.disabled).toBe(false);
  });

  it("reports a delayed current-epoch File Run handoff failure at the advanced revision and recovers", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const nextStudio = structuredClone(studio);
    const root = nextStudio.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(nextStudio);

    const updateResourceDraft = transport.updateResourceDraft.bind(transport);
    const applyStudio = transport.applyStudio.bind(transport);
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, currentStudio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...currentStudio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      return nextProjectRevision;
    };
    let settledDraftProjectRevision: number | null = null;
    const updateDraft = vi.fn(async (
      request: Parameters<typeof transport.updateResourceDraft>[0],
    ) => {
      const result = await updateResourceDraft(request);
      if (updateDraft.mock.calls.length === 1) {
        settledDraftProjectRevision = await advanceProjectRevision();
      }
      return result;
    });
    let markHandoffRequested = () => {};
    const handoffRequested = new Promise<void>((resolve) => {
      markHandoffRequested = resolve;
    });
    let releaseHandoffFailure = () => {};
    const handoffFailureBlocked = new Promise<void>((resolve) => {
      releaseHandoffFailure = resolve;
    });
    const apply = vi.fn(async (request: Parameters<typeof transport.applyStudio>[0]) => {
      if (apply.mock.calls.length === 1) {
        markHandoffRequested();
        await handoffFailureBlocked;
        throw new Error("Console handoff rejected for test.");
      }
      return applyStudio(request);
    });
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    transport.updateResourceDraft = updateDraft;
    transport.applyStudio = apply;
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>(
      "[aria-label='Run selection or current R expression in Console']",
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const code = "DELAYED_HANDOFF_FAILURE()";

    await act(async () => {
      setValue.call(editor, `${code}\n`);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.setSelectionRange(0, 0);
      run.click();
      await handoffRequested;
    });
    expect(updateDraft).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(settledDraftProjectRevision).not.toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      releaseHandoffFailure();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(".rho-action-error")?.textContent)
        .toContain("Console handoff rejected for test."));
    });
    expect(run.disabled).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    await act(async () => {
      run.click();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await settle();
    });
    expect(updateDraft).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ code });
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("creates at most one Console for rapid repeated Run gestures", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const nextStudio = structuredClone(studio);
    const root = nextStudio.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (center as unknown as { children: LayoutChild[] }).children = center.children.slice(0, 1);
    transport.publishStudio(nextStudio);
    const surfaces = await transport.loadSurfaces();
    const nextSurfaces = structuredClone(surfaces);
    (nextSurfaces.catalog as unknown as { instances: typeof nextSurfaces.catalog.instances })
      .instances = nextSurfaces.catalog.instances.filter((instance) => instance.surface_id !== "rho.console");
    transport.publishSurfaces(nextSurfaces);
    const open = vi.spyOn(transport, "openSurface");
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const editor = container.querySelector<HTMLTextAreaElement>("[data-surface-id='rho.file-source'] [aria-label^='Source']")!;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(0, 0);
      for (let index = 0; index < 2; index += 1) {
        editor.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          ctrlKey: true,
        }));
      }
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(open).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    const createdId = execute.mock.calls[0]?.[0].console_instance_id;
    expect(createdId).toMatch(/^surface-instance:mock-/u);
    expect(container.querySelectorAll("[data-surface-id='rho.console']")).toHaveLength(1);
    expect(editor.selectionStart).toBe(editor.value.indexOf("\n") + 1);
  });

  it("preserves a paused Console and recovers from one failed placement on retry", async () => {
    const pausedTransport = createMockUiKernelTransport();
    const pausedStudio = await pausedTransport.loadStudio();
    const pausedLayout = structuredClone(pausedStudio);
    const pausedRoot = pausedLayout.scene.root;
    if (pausedRoot.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const pausedCenter = pausedRoot.children[1]?.child;
    if (pausedCenter?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (pausedCenter as unknown as { children: LayoutChild[] }).children = pausedCenter.children.slice(0, 1);
    pausedTransport.publishStudio(pausedLayout);
    const pausedSurfaces = await pausedTransport.loadSurfaces();
    const paused = structuredClone(pausedSurfaces);
    for (const instance of paused.catalog.instances) {
      if (instance.surface_id === "rho.console") {
        (instance as { lifecycle_state: string }).lifecycle_state = "suspended";
      }
    }
    pausedTransport.publishSurfaces(paused);
    const pausedOpen = vi.spyOn(pausedTransport, "openSurface");
    const pausedExecute = vi.spyOn(pausedTransport, "startRuntimeExecution");
    const { container: pausedContainer } = await renderApp(pausedTransport);
    const pausedSource = pausedContainer.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const pausedEditor = pausedSource.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      pausedEditor.setSelectionRange(0, 0);
      pausedSource.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      await settle();
    });
    expect(pausedOpen).not.toHaveBeenCalled();
    expect(pausedExecute).not.toHaveBeenCalled();
    expect(pausedEditor.selectionStart).toBe(0);
    expect(pausedContainer.querySelector(".rho-action-error")?.textContent).toContain("paused");

    const retryTransport = createMockUiKernelTransport();
    const retryStudio = await retryTransport.loadStudio();
    const retryLayout = structuredClone(retryStudio);
    const retryRoot = retryLayout.scene.root;
    if (retryRoot.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const retryCenter = retryRoot.children[1]?.child;
    if (retryCenter?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    (retryCenter as unknown as { children: LayoutChild[] }).children = retryCenter.children.slice(0, 1);
    retryTransport.publishStudio(retryLayout);
    const originalApply = retryTransport.applyStudio.bind(retryTransport);
    const apply = vi.fn(originalApply);
    apply.mockRejectedValueOnce(new Error("Injected placement failure."));
    retryTransport.applyStudio = apply;
    const retryExecute = vi.spyOn(retryTransport, "startRuntimeExecution");
    const { container: retryContainer } = await renderApp(retryTransport);
    const retrySource = retryContainer.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const retryEditor = retrySource.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const retryRun = retrySource.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      retryEditor.setSelectionRange(0, 0);
      retryRun.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(retryExecute).not.toHaveBeenCalled();
    expect(retryEditor.selectionStart).toBe(0);
    expect(retryContainer.querySelector(".rho-action-error")?.textContent).toContain("Injected placement failure");
    await act(async () => {
      retryRun.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(retryExecute).toHaveBeenCalledOnce();
    expect(retryEditor.selectionStart).toBe(retryEditor.value.indexOf("\n") + 1);
  });

  it("requires an explicit choice when two Consoles are visible, then isolates the chosen target", async () => {
    const transport = createMockUiKernelTransport();
    const studio = await transport.loadStudio();
    const next = structuredClone(studio);
    const root = next.scene.root;
    if (root.kind !== "container") throw new Error("Mock Studio root must be a container.");
    const center = root.children[1]?.child;
    if (center?.kind !== "container") throw new Error("Mock Studio center must be a container.");
    const consoleChild = center.children[1];
    if (consoleChild == null) throw new Error("Mock Studio Console child is missing.");
    (center.children as LayoutChild[])[1] = {
      ...consoleChild,
      child: {
        kind: "container",
        node_id: "node:split-consoles",
        axis: "horizontal",
        children: ["instance:console-a", "instance:console-b"].map((instanceId, index) => ({
          child: { kind: "surface", node_id: `node:split-console-${index}`, instance_id: instanceId },
          basis: { kind: "fraction", weight: 1 },
          resizable: true,
          collapse_priority: null,
        })),
      },
    };
    transport.publishStudio(next);
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    const run = source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      run.click();
      await settle();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(editor.selectionStart).toBe(0);
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("More than one R Console");

    const consoleB = container.querySelector<HTMLElement>("[data-instance-id='instance:console-b']")!;
    await act(async () => {
      consoleB.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await settle();
      run.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].console_instance_id).toBe("instance:console-b");
    expect(consoleB.querySelector(".rho-console-entry")?.textContent).toContain("library(ggplot2)");
    expect(container.querySelector("[data-instance-id='instance:console-a'] .rho-console-entry")).toBeNull();
  });

  it("keeps a large repeatable-instance Stack bounded to one mounted renderer", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?stress=large"));
    expect(container.querySelectorAll("[data-rho-pane-node-id='node:stress-stack']")).toHaveLength(96);
    expect(container.querySelectorAll("[data-surface-id='rho.surface-playground']")).toHaveLength(1);
    const evidence = JSON.parse(
      container.querySelector("#rsrPreviewEvidence")?.textContent ?? "{}",
    ) as { surfaceInstanceCount?: number };
    expect(evidence.surfaceInstanceCount).toBeGreaterThanOrEqual(100);
  });

  it("closes a stacked Surface from its tab close control", async () => {
    const transport = createMockUiKernelTransport();
    const original = transport.applyStudio.bind(transport);
    const apply = vi.fn(original);
    transport.applyStudio = apply;
    const { container } = await renderApp(transport);
    const closeButtons = [...container.querySelectorAll<HTMLButtonElement>(
      "[data-rho-pane-node-id='node:consoles'] .dv-default-tab-action",
    )];
    expect(closeButtons).toHaveLength(2);
    await act(async () => {
      closeButtons[1]!.click();
      await settle();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit).toMatchObject({
      kind: "close_surface_placement",
      instance_id: "instance:console-b",
    });
    expect(container.querySelector("[data-instance-id='instance:console-b']")).toBeNull();
    expect(container.querySelectorAll("[data-instance-id='instance:console-a']")).toHaveLength(1);
  });

  it("opens a Navigator file into the center document container", async () => {
    const transport = createMockUiKernelTransport();
    const original = transport.applyStudio.bind(transport);
    const apply = vi.fn(original);
    transport.applyStudio = apply;
    const { container } = await renderApp(transport);
    const navigator = container.querySelector("[data-surface-id='rho.navigator']")!;
    expect(navigator.textContent).toContain("Files");
    expect(navigator.textContent).toContain("History");
    expect(navigator.querySelector("[role='tab'][aria-label='Artifacts']")).toBeNull();
    const fileRow = navigator.querySelector<HTMLButtonElement>("[data-nav-file='analysis.R']");
    expect(fileRow).not.toBeNull();
    const before = container.querySelectorAll("[data-surface-id='rho.file-source']").length;
    await act(async () => {
      fileRow!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const insert = apply.mock.calls
      .map((call) => call[0].edit)
      .find((edit) => edit.kind === "insert_surface");
    expect(insert).toMatchObject({
      kind: "insert_surface",
      target_container_node_id: "node:center",
      child_index: 0,
    });
    expect(container.querySelectorAll("[data-surface-id='rho.file-source']").length)
      .toBeGreaterThan(before);
  });

  it("uses Navigator height for files until search or recent output is requested", async () => {
    const transport = createMockUiKernelTransport();
    const loadDomain = transport.loadDomainSurface.bind(transport);
    transport.loadDomainSurface = async (surfaceId) => {
      const data = await loadDomain(surfaceId);
      return surfaceId === "rho.plots" ? { ...data, items: [] } : data;
    };
    const { container } = await renderApp(transport);
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;
    expect(navigator.querySelector(".rho-navigator-recent")).toBeNull();
    expect(navigator.querySelector(".rho-navigator-search")).toBeNull();

    await act(async () => {
      navigator.querySelector<HTMLButtonElement>("[aria-label='Search project files']")!.click();
      await settle();
    });
    const search = navigator.querySelector<HTMLInputElement>("[aria-label='Filter project files']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(search, "missing-file");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(navigator.textContent).toContain("No files match this search.");
    expect(navigator.querySelector("[data-nav-file]")).toBeNull();
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(navigator.querySelector(".rho-navigator-search")).toBeNull();
    expect(document.activeElement).toBe(navigator.querySelector(".rho-navigator-search-toggle"));
    expect(navigator.querySelector("[data-nav-file='analysis.R']")).not.toBeNull();
  });

  it("makes Navigator sections keyboard-operable and turns recent-output information into an action", async () => {
    const transport = createMockUiKernelTransport();
    const update = vi.spyOn(transport, "updateSurface");
    const { container } = await renderApp(transport);
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;
    const controls = navigator.querySelector<HTMLElement>(".rho-navigator-controls")!;
    const tablist = controls.querySelector<HTMLElement>(".rho-navigator-tabs")!;
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>("[role='tab']")];
    const searchToggle = controls.querySelector<HTMLButtonElement>(".rho-navigator-search-toggle")!;
    expect(tabs.map((tab) => [tab.textContent, tab.tabIndex, tab.getAttribute("aria-selected")]))
      .toEqual([
        ["Files", 0, "true"],
        ["History", -1, "false"],
      ]);
    expect([...controls.children]).toEqual([tablist, searchToggle]);
    expect(searchToggle.getAttribute("aria-label")).toBe("Search project files");
    update.mockClear();
    await act(async () => {
      tabs[0]!.click();
      await settle();
    });
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      tabs[0]!.focus();
      tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      await settle();
    });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(navigator.querySelector("[role='tabpanel']")?.getAttribute("aria-labelledby"))
      .toBe(tabs[1]!.id);

    const recent = navigator.querySelector<HTMLDetailsElement>(".rho-navigator-recent")!;
    expect(recent.open).toBe(true);
    const openOutputs = navigator.querySelector<HTMLButtonElement>(".rho-navigator-open-outputs")!;

    await act(async () => {
      openOutputs.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await settle();
    });
    expect(openOutputs.isConnected).toBe(true);

    await act(async () => {
      openOutputs.click();
      await settle();
    });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-surface-id='rho.plots']")).not.toBeNull();
  });

  it("keeps the idle Console focused on runtime, output, and one compact composer", async () => {
    const transport = createMockUiKernelTransport();
    const restart = vi.spyOn(transport, "restartRuntime");
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const runtime = consoleView.querySelector<HTMLSelectElement>("[aria-label^='Runtime for']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;

    expect(runtime.selectedOptions[0]?.textContent).toBe("Workspace R");
    expect(consoleView.querySelector(".rho-runtime-state")?.textContent).toBe("ready");
    expect(consoleView.querySelector(".rho-console-empty")?.textContent).toContain("Ready for R code");
    expect(consoleView.querySelector("[aria-label^='Filter output']")).toBeNull();
    expect(consoleView.querySelector("[aria-label='Filter Console output']")).toBeNull();
    expect(consoleView.querySelector(".rho-console-runtime-bar")?.textContent).not.toContain("Interrupt");
    expect(consoleView.querySelector(".rho-console-runtime-bar")?.textContent).not.toContain("Restart");
    expect(composer.rows).toBe(1);
    expect(consoleView.querySelector(".rho-console-input-hint")?.textContent).toContain("Return to run");
    expect(document.activeElement).not.toBe(composer);

    const menu = await openSurfaceMenu(consoleView);
    expect(menu.classList.contains("rho-menu-popover-panel-viewport")).toBe(true);
    expect(menu.style.position).toBe("fixed");
    const restartAction = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Restart Workspace R")!;
    const clear = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Start new transcript")!;
    expect(restartAction.disabled).toBe(false);
    expect(clear.disabled).toBe(true);
    await act(async () => {
      restartAction.click();
      await settle();
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("More actions for R Console");
  });

  it("groups consecutive Console commands by Workspace and separates commands from output", async () => {
    const transport = createMockUiKernelTransport();
    const initialRuntimes = await transport.loadRuntimes();
    const runtimeSnapshot = await transport.createRuntime({
      project_id: initialRuntimes.project_id,
      runtime_provider_id: initialRuntimes.providers[0]!.definition.runtime_provider_id,
      expected_project_revision: initialRuntimes.project_revision,
      expected_snapshot_revision: initialRuntimes.snapshot_revision,
      display_label: "Auxiliary R",
    });
    const auxiliary = runtimeSnapshot.instances.find((runtime) => !runtime.primary_scientific_runtime)!;
    const { container } = await renderApp(transport);
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    const consoleView = () => container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const run = async (code: string, expectedCount: number) => {
      const composer = consoleView().querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        setTextarea.call(composer, code);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(consoleView().querySelectorAll(".rho-console-entry")).toHaveLength(expectedCount);
      });
    };

    await run("first_workspace_command()", 1);
    await run("second_workspace_command()", 2);
    let entries = [...consoleView().querySelectorAll<HTMLElement>(".rho-console-entry")];
    expect(entries.map((entry) => entry.dataset.runtimeGroupStart)).toEqual(["true", "false"]);
    expect(entries.flatMap((entry) =>
      [...entry.querySelectorAll<HTMLElement>(".rho-console-workspace-label")].map((label) => label.textContent)
    )).toEqual(["Workspace R"]);
    expect(entries[0]?.querySelector(".rho-console-command")?.textContent).toContain("first_workspace_command()");
    expect(entries[0]?.querySelector(":scope > .rho-console-results")?.textContent)
      .toContain("Mock evaluation: first_workspace_command()");

    const runtimePicker = consoleView().querySelector<HTMLSelectElement>("[aria-label^='Runtime for']")!;
    await act(async () => {
      setSelect.call(runtimePicker, auxiliary.runtime_instance_id);
      runtimePicker.dispatchEvent(new Event("change", { bubbles: true }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(consoleView().querySelector<HTMLSelectElement>("[aria-label^='Runtime for']")?.value)
        .toBe(auxiliary.runtime_instance_id);
    });
    await run("auxiliary_command()", 3);

    const primary = runtimeSnapshot.instances.find((runtime) => runtime.primary_scientific_runtime)!;
    const auxiliaryPicker = consoleView().querySelector<HTMLSelectElement>("[aria-label^='Runtime for']")!;
    await act(async () => {
      setSelect.call(auxiliaryPicker, primary.runtime_instance_id);
      auxiliaryPicker.dispatchEvent(new Event("change", { bubbles: true }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(consoleView().querySelector<HTMLSelectElement>("[aria-label^='Runtime for']")?.value)
        .toBe(primary.runtime_instance_id);
    });
    await run("workspace_after_switch()", 4);

    entries = [...consoleView().querySelectorAll<HTMLElement>(".rho-console-entry")];
    expect(entries.map((entry) => entry.dataset.runtimeGroupStart))
      .toEqual(["true", "false", "true", "true"]);
    expect(entries.flatMap((entry) =>
      [...entry.querySelectorAll<HTMLElement>(".rho-console-workspace-label")].map((label) => label.textContent)
    )).toEqual(["Workspace R", "Auxiliary R", "Workspace R"]);

    await act(async () => {
      consoleView().querySelector<HTMLButtonElement>("[aria-label='Filter Console output']")!.click();
      await settle();
    });
    const filter = consoleView().querySelector<HTMLInputElement>("[aria-label^='Filter output']")!;
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setInput.call(filter, "workspace");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    entries = [...consoleView().querySelectorAll<HTMLElement>(".rho-console-entry")];
    expect(entries.map((entry) => entry.dataset.runtimeGroupStart)).toEqual(["true", "false", "true"]);
    expect(entries.flatMap((entry) =>
      [...entry.querySelectorAll<HTMLElement>(".rho-console-workspace-label")].map((label) => label.textContent)
    )).toEqual(["Workspace R", "Workspace R"]);

    await act(async () => {
      setInput.call(filter, "second_workspace_command");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    entries = [...consoleView().querySelectorAll<HTMLElement>(".rho-console-entry")];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.dataset.runtimeGroupStart).toBe("true");
    expect(entries[0]?.querySelector(".rho-console-workspace-label")?.textContent).toBe("Workspace R");
  });

  it("opens Console output filtering on demand and never leaves a hidden filter active", async () => {
    const { container } = await renderApp();
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "letters[1:3]");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(consoleView.querySelectorAll(".rho-console-entry")).toHaveLength(1);

    await act(async () => {
      const filterButton = consoleView.querySelector<HTMLButtonElement>("[aria-label='Filter Console output']");
      expect(filterButton, consoleView.innerHTML).not.toBeNull();
      filterButton!.click();
      await settle();
    });
    const filter = consoleView.querySelector<HTMLInputElement>("[aria-label^='Filter output']")!;
    expect(document.activeElement).toBe(filter);
    expect(consoleView.querySelector(".rho-console-filterbar")?.textContent).toContain("1 / 1");
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setInput.call(filter, "missing-result");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(consoleView.querySelectorAll(".rho-console-entry")).toHaveLength(0);
    expect(consoleView.textContent).toContain("No output matches “missing-result”");
    await act(async () => {
      [...consoleView.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Clear filter")!
        .click();
      await settle();
    });
    expect(consoleView.querySelectorAll(".rho-console-entry")).toHaveLength(1);
    expect(filter.value).toBe("");
    await act(async () => {
      setInput.call(filter, "letters");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      filter.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(consoleView.querySelector(".rho-console-filterbar")).toBeNull();
    expect(consoleView.querySelectorAll(".rho-console-entry")).toHaveLength(1);
  });

  it("renders Workspace results as a human transcript and excludes bridge details from filtering", async () => {
    const transport = createMockUiKernelTransport();
    transport.queueRuntimeEvents([{
        sequence: 1,
        runtime_instance_id: "runtime:workspace-r",
        console_instance_id: "instance:console-a",
        kind: "workspace_result",
        payload: {
          execution_id: "exec_internal_456",
          artifact_id: null,
          execution: {
            ok: true,
            code: "1 + 1",
            stdout: "",
            value: "[1] 2",
            messages: ["Result is ready"],
            warnings: ["Example warning"],
            error: null,
            traceback: [],
            calls: [],
          },
          events: [{
            parent_id: "parent_internal_789",
            type: "execute_input",
            code: "private bridge wrapper",
          }],
          workspace: { workspace_id: "workspace_internal_012" },
        },
      }]);
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "1 + 1");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    const entry = consoleView.querySelector<HTMLElement>(".rho-console-entry")!;
    expect(entry.getAttribute("aria-label")).toBe("R Console execution 1");
    expect(entry.querySelector(".rho-console-result-value")?.textContent).toBe("[1] 2");
    expect(entry.querySelector(".rho-console-result-message")?.textContent).toContain("Result is ready");
    expect(entry.querySelector(".rho-console-result-warning")?.textContent).toContain("Example warning");
    expect(entry.textContent).not.toContain("exec_internal_456");
    expect(entry.textContent).not.toContain("parent_internal_789");
    expect(entry.textContent).not.toContain("private bridge wrapper");
    expect(entry.textContent).not.toContain("workspace_internal_012");
    expect(entry.textContent).not.toContain("execution_id");

    await act(async () => {
      consoleView.querySelector<HTMLButtonElement>("[aria-label='Filter Console output']")!.click();
      await settle();
    });
    const filter = consoleView.querySelector<HTMLInputElement>("[aria-label^='Filter output']")!;
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setInput.call(filter, "private bridge wrapper");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(consoleView.querySelector(".rho-console-entry")).toBeNull();
    expect(consoleView.textContent).toContain("No output matches");
  });

  it("runs on Return, preserves multiline cursor movement, and retains failed drafts", async () => {
    const transport = createMockUiKernelTransport();
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const output = consoleView.querySelector<HTMLElement>(".rho-console-output")!;
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 240 });
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composer, "1 + 1");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true }));
      await settle();
    });
    expect(execute).not.toHaveBeenCalled();
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("source_context");
    expect(composer.value).toBe("");
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(output.scrollTop).toBe(240);
    expect(document.activeElement).not.toBe(output);

    await act(async () => {
      setValue.call(composer, "line one\nline two");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.setSelectionRange(4, 4);
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await settle();
    });
    expect(composer.value).toBe("line one\nline two");
    await act(async () => {
      composer.setSelectionRange(0, 0);
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await settle();
    });
    expect(composer.value).toBe("1 + 1");

    execute.mockRejectedValueOnce(new Error("Workspace R rejected this expression."));
    await act(async () => {
      setValue.call(composer, "stop('keep me')");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(composer.value).toBe("stop('keep me')");
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("Workspace R rejected");
  });

  it("pauses tail following when the reader scrolls up and resumes only on request", async () => {
    const { container } = await renderApp(createMockUiKernelTransport());
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const output = consoleView.querySelector<HTMLElement>(".rho-console-output")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    let scrollHeight = 240;
    Object.defineProperty(output, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(output, "clientHeight", { configurable: true, value: 100 });

    await act(async () => {
      setValue.call(composer, "first()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(output.scrollTop).toBe(240);

    await act(async () => {
      output.scrollTop = 40;
      output.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settle();
    });
    expect(output.dataset.followTail).toBe("false");
    expect(consoleView.querySelector<HTMLButtonElement>(".rho-console-jump-latest")?.textContent)
      .toBe("Jump to latest");

    scrollHeight = 480;
    await act(async () => {
      setValue.call(composer, "second()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(output.scrollTop).toBe(40);

    await act(async () => {
      consoleView.querySelector<HTMLButtonElement>(".rho-console-jump-latest")!.click();
      await settle();
    });
    expect(output.scrollTop).toBe(480);
    expect(output.dataset.followTail).toBe("true");
  });

  it("uses the same human output in Console and History and keeps it after starting a new transcript", async () => {
    const transport = createMockUiKernelTransport();
    transport.queueRuntimeEvents([{
        sequence: 1,
        runtime_instance_id: "runtime:workspace-r",
        console_instance_id: "instance:console-a",
        kind: "workspace_result",
        payload: { execution: { ok: true, code: "answer()", stdout: "", value: "[1] 42", messages: [], warnings: [], error: null } },
      }]);
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composer, "answer()");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(consoleView.querySelector(".rho-console-result-value")?.textContent).toBe("[1] 42");

    const menu = await openSurfaceMenu(consoleView);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Start new transcript")!.click();
      await settle();
    });
    expect(consoleView.querySelector(".rho-console-entry")).toBeNull();

    // Starting a transcript hides the entry, so open the independent durable History component.
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.runs']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const history = container.querySelector<HTMLElement>("[data-surface-id='rho.runs']")!;
    expect(history.querySelector(".rho-runtime-history-code")?.textContent).toBe("answer()");
    expect(history.querySelector(".rho-console-result-value")?.textContent).toBe("[1] 42");

    await act(async () => {
      [...history.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Prune output payload…")!.click();
      await settle();
    });
    const pruneDialog = history.querySelector<HTMLElement>("[aria-label='Confirm output prune']")!;
    expect(pruneDialog.textContent).toContain("Runs, Artifacts, and Agent receipts are kept");
    await act(async () => {
      [...pruneDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Prune payload")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(history.querySelector(".rho-console-result-status")?.textContent).toContain("payload was pruned");
    expect(history.textContent).toContain("completed · pruned");

    await act(async () => {
      [...history.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Delete execution record…")!.click();
      await settle();
    });
    const deleteDialog = history.querySelector<HTMLElement>("[aria-label='Confirm execution deletion']")!;
    expect(deleteDialog.textContent).toContain("Linked Workspace Runs and Artifacts are kept");
    await act(async () => {
      [...deleteDialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Delete record")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(history.querySelector(".rho-runtime-history-code")?.textContent).not.toBe("answer()");
  });

  it("adds an immutable History output reference to Agent only after an explicit context review", async () => {
    const transport = createMockUiKernelTransport();
    transport.queueRuntimeEvents([{
      sequence: 1,
      runtime_instance_id: "runtime:workspace-r",
      console_instance_id: "instance:console-a",
      kind: "workspace_result",
      payload: {
        execution: {
          ok: true,
          code: "summary(mtcars)",
          stdout: "summary output",
          value: "summary value",
          messages: ["summary message"],
          warnings: [],
          error: null,
        },
      },
    }]);
    const ready = structuredClone(await transport.loadSnapshot());
    (ready.health as { agent: typeof ready.health.agent }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (ready.context as { agent_health: "ready" }).agent_health = "ready";
    transport.publish(ready);
    const createReference = vi.spyOn(transport, "createRuntimeOutputReference");
    const preview = vi.spyOn(transport, "previewAgentContext");
    const runAgent = vi.spyOn(transport, "runAgent");
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const consoleComposer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(consoleComposer, "summary(mtcars)");
      consoleComposer.dispatchEvent(new Event("input", { bubbles: true }));
      consoleComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });

    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.runs']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    const history = container.querySelector<HTMLElement>("[data-surface-id='rho.runs']")!;
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      const start = history.querySelector<HTMLInputElement>("[aria-label='Agent context start chunk']")!;
      const end = history.querySelector<HTMLInputElement>("[aria-label='Agent context end chunk']")!;
      setInput.call(start, "2");
      start.dispatchEvent(new Event("input", { bubbles: true }));
      setInput.call(end, "3");
      end.dispatchEvent(new Event("input", { bubbles: true }));
      [...history.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Use output in Agent")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });

    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    expect(createReference).toHaveBeenCalledWith(expect.stringMatching(/^runtime-execution:/), 2, 3);
    expect(agent.querySelector(".rho-agent-context-chip")?.textContent).toContain("Chunks 2–3");
    const composer = agent.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await act(async () => {
      setValue.call(composer, "Explain this Runtime result");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      [...agent.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Review context")!.click();
      await settle();
    });
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]?.[0].runtime_output_context?.execution_id).toMatch(/^runtime-execution:/);
    expect(preview.mock.calls[0]?.[0].runtime_output_context).toMatchObject({
      start_sequence: 2,
      end_sequence: 3,
    });
    expect(agent.querySelector(".rho-agent-context-preview")?.textContent).toContain("runtime output");

    await act(async () => {
      [...agent.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Send")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0].runtime_output_context).not.toBeNull();
    expect(runAgent.mock.calls[0]?.[0].context_plan_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.textContent).toContain("Context used");
    expect(agent.querySelector(".rho-agent-context-chip")).toBeNull();
  });

  it("searches the durable Console journal beyond the mounted transcript and reports incomplete scope", async () => {
    const transport = createMockUiKernelTransport();
    const startExecution = vi.spyOn(transport, "startRuntimeExecution");
    const followExecution = vi.spyOn(transport, "followRuntimeOutput");
    const search = vi.spyOn(transport, "searchRuntimeOutput").mockResolvedValue({
      query: "archived warning",
      searched_execution_count: 12,
      matched_execution_count: 1,
      incomplete_execution_count: 2,
      truncated: false,
      hits: [{
        execution_id: "runtime-execution:older",
        sequence: 41,
        presentation_kind: "warning",
        storage_kind: "inline_text",
        preview: "archived warning from durable output",
        reference_kind: null,
        reference_id: null,
        payload_sha256: "d".repeat(64),
      }],
    });
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector<HTMLElement>("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "1 + 1");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
      await settle();
      expect(consoleView.isConnected).toBe(true);
      expect(container.querySelector("[data-surface-id='rho.console']")).toBe(consoleView);
      expect(startExecution).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(followExecution).toHaveBeenCalledOnce());
      expect(followExecution).toHaveBeenCalledOnce();
      const durableFilterButton = consoleView.querySelector<HTMLButtonElement>("[aria-label='Filter Console output']");
      expect(durableFilterButton, consoleView.innerHTML).not.toBeNull();
      durableFilterButton!.click();
      await settle();
    });
    const filter = consoleView.querySelector<HTMLInputElement>("[aria-label^='Filter output']")!;
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setInput.call(filter, "archived warning");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      await settle();
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: "archived warning",
      console_instance_id: "instance:console-a",
      limit: 100,
    }));
    expect(consoleView.querySelector(".rho-console-search-scope")?.textContent)
      .toContain("Searched 12 durable executions");
    expect(consoleView.querySelector(".rho-console-search-scope")?.textContent)
      .toContain("2 had partial, unavailable, or pruned output");
    expect(consoleView.querySelector(".rho-console-durable-search-results")?.textContent)
      .toContain("archived warning from durable output");
  });

  it("keeps Runtime storage policy closed by default and saves unlimited capture with revision authority", async () => {
    const transport = createMockUiKernelTransport();
    const updatePolicy = vi.spyOn(transport, "updateRuntimeOutputPolicy");
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.runs']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const history = container.querySelector<HTMLElement>("[data-surface-id='rho.runs']")!;
    expect(history.querySelector(".rho-runtime-history-policy")).toBeNull();
    await act(async () => {
      [...history.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Storage")!.click();
      await settle();
    });
    const policy = history.querySelector<HTMLFormElement>(".rho-runtime-history-policy")!;
    expect(policy.textContent).toContain("automatic pruning stays off");
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      const capture = policy.querySelector<HTMLInputElement>("[aria-label='Capture per execution MiB']")!;
      const warning = policy.querySelector<HTMLInputElement>("[aria-label='Project warning MiB']")!;
      const rows = policy.querySelector<HTMLInputElement>("[aria-label='Execution warning count']")!;
      setInput.call(capture, "");
      capture.dispatchEvent(new Event("input", { bubbles: true }));
      setInput.call(warning, "512");
      warning.dispatchEvent(new Event("input", { bubbles: true }));
      setInput.call(rows, "10000");
      rows.dispatchEvent(new Event("input", { bubbles: true }));
      policy.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
      await settle();
    });
    expect(updatePolicy).toHaveBeenCalledWith({
      expected_revision: 0,
      max_runtime_output_bytes_per_execution: null,
      runtime_output_project_warning_bytes: 512 * 1024 * 1024,
      max_runtime_execution_rows: 10_000,
      auto_prune_enabled: false,
    });
    expect(policy.textContent).toContain("policy r1");
  });

  it("does not attach Runtime output to an ordinary Agent turn", async () => {
    const transport = createMockUiKernelTransport();
    const ready = structuredClone(await transport.loadSnapshot());
    (ready.health as { agent: typeof ready.health.agent }).agent = {
      state: "ready",
      label: "Agent runtime ready",
      detail: null,
    };
    (ready.context as { agent_health: "ready" }).agent_health = "ready";
    transport.publish(ready);
    const runAgent = vi.spyOn(transport, "runAgent");
    const { container } = await renderApp(transport);
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const composer = agent.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composer, "Summarize the project");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(runAgent.mock.calls[0]?.[0].runtime_output_context).toBeNull();
    expect(runAgent.mock.calls[0]?.[0].context_plan_digest).toBeNull();
  });

  it("keeps model configuration in Settings and deep-links there from Agent", async () => {
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
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    expect(agent.querySelector(".rho-agent-capacity")).toBeNull();

    await act(async () => {
      [...agent.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Models")!.click();
      await settle();
    });
    const settings = container.querySelector<HTMLElement>("[data-surface-id='rho.settings']")!;
    expect(settings).not.toBeNull();
    expect(settings.textContent).toContain("Mock Provider · Model");
    expect(settings.textContent).toContain("mock-model");
    expect(settings.textContent).toContain("What this model can do");
  });

  it("exposes Console busy state with a reachable Stop control", async () => {
    const transport = createMockUiKernelTransport();
    let release: () => void = () => {};
    const startRuntimeExecution = transport.startRuntimeExecution.bind(transport);
    transport.startRuntimeExecution = ((request: Parameters<typeof transport.startRuntimeExecution>[0]) =>
      new Promise((resolve, reject) => {
        release = () => {
          void startRuntimeExecution(request).then(resolve, reject);
        };
      })) as typeof transport.startRuntimeExecution;
    const interrupt = vi.fn(transport.interruptRuntime.bind(transport));
    transport.interruptRuntime = interrupt;
    const { container } = await renderApp(transport);
    const consoleView = container.querySelector("[data-surface-id='rho.console']")!;
    const composer = consoleView.querySelector<HTMLTextAreaElement>("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(composer, "1 + 1");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const runButton = [...consoleView.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Run")!;
    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });
    expect(consoleView.querySelector(".rho-console-busybar")).not.toBeNull();
    const stop = [...consoleView.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Stop");
    expect(stop).not.toBeNull();
    await act(async () => {
      stop!.click();
      await settle();
    });
    expect(interrupt).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await settle();
    });
    expect([...consoleView.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "Run")).toBe(true);
  });

  it("shows the Agent running state with elapsed time and a Stop control", async () => {
    const transport = createMockUiKernelTransport();
    const turns = await transport.listAgentTurns("agent-conversation:mock-shared", 20);
    expect(turns.length).toBeGreaterThan(0);
    const running = {
      ...turns[0]!,
      status: "running",
      started_at: new Date(Date.now() - 65_000).toISOString(),
      finished_at: null,
    };
    transport.listAgentTurns = (async () => [running, ...turns.slice(1)]) as typeof transport.listAgentTurns;
    const cancel = vi.fn(async () => ({}));
    transport.cancelAgentTurn = cancel as unknown as typeof transport.cancelAgentTurn;
    const { container } = await renderApp(transport);
    const agent = container.querySelector("[data-surface-id='rho.agent']")!;
    expect(agent.textContent).toContain("Agent running");
    const stop = [...agent.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Stop");
    expect(stop).not.toBeNull();
    await act(async () => {
      stop!.click();
      await settle();
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("gives Dockview sole ownership of split, tab and pointer docking mechanics", async () => {
    const { container } = await renderApp();
    expect(container.querySelector(".rho-dockview-scene .dv-dockview")).not.toBeNull();
    expect(container.querySelectorAll("[data-rho-pane-node-id='node:consoles']")).toHaveLength(2);
    expect(container.querySelector("[data-studio-drag-source]")).toBeNull();
    expect(container.querySelector(".rho-studio-drag-ghost")).toBeNull();
    expect(container.querySelector(".rho-drop-overlay")).toBeNull();
  });

  it("publishes a Dockview tab activation as the existing revisioned Scene edit", async () => {
    const transport = createMockUiKernelTransport();
    const original = transport.applyStudio.bind(transport);
    const apply = vi.fn(original);
    transport.applyStudio = apply;
    const { container } = await renderApp(transport);
    const inactive = container.querySelector<HTMLElement>(
      "[data-rho-tab-instance-id='instance:console-b']",
    )!;
    const dockviewTab = inactive.closest<HTMLElement>(".dv-tab")!;
    await act(async () => {
      pointer(dockviewTab, "pointerdown", 10, 10);
      pointer(dockviewTab, "pointerup", 10, 10);
      inactive.click();
      await settle();
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit).toMatchObject({
      kind: "set_stack_active",
      stack_node_id: "node:consoles",
      instance_id: "instance:console-b",
    });
  });

  it("switches to a document-composed Vibe Page without carrying the inspector chrome", async () => {
    const { container } = await renderApp();
    await openInspector(container);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe");
    if (vibe == null) throw new Error("Vibe mode control is missing");
    await act(async () => {
      vibe.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.textContent).toContain("Project review");
    expect([...container.querySelectorAll(".rho-vibe-workspace h2")].map((heading) => heading.textContent))
      .toEqual(expect.arrayContaining(["手稿", "自主探索", "查验与结论"]));
    expect(container.querySelector(".rho-vibe-live-surface")).toBeNull();
    expect(container.querySelector(".rho-vibe-manuscript-atom-surface_ref")).not.toBeNull();
    expect(container.querySelector("[aria-label='Selected block actions']")).toBeNull();
    expect(container.querySelector(".rho-vibe-manuscript-header")?.textContent).not.toContain("· r");
    expect(container.querySelector(".rho-studio-inspector")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".rho-bar-compose")?.textContent)
      .toBe("Compose");
    expect(container.querySelector(".rho-vibe-manuscript")?.getAttribute("aria-busy")).toBeNull();
    expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");

    await act(async () => {
      container.querySelector("[data-block-id='block:check']")!.dispatchEvent(
        new Event("pointerdown", { bubbles: true, cancelable: true }),
      );
      await settle();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-correspondence")?.textContent)
      .toContain("该组件尚未提供精确探索或查验关系");
    expect(container.querySelector(".rho-vibe-verification")?.textContent).toContain("尚无精确关联");
  });

  it("commits Vibe composition through exact Page transactions", async () => {
    const transport = createMockUiKernelTransport();
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const apply = vi.spyOn(transport, "applyVibePage");
    const { container } = await renderApp(transport);
    const vibe = [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
      .find((button) => button.textContent === "Vibe")!;
    await act(async () => {
      vibe.click();
      await settle();
    });
    const before = container.querySelectorAll(".rho-vibe-block-rich_text").length;
    const start = container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!;
    await act(async () => {
      start.click();
      await settle();
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-manuscript-toolbar button")]
      .find((button) => button.textContent === "Save now")!;
    await act(async () => {
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
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent).toBe("Saved");
  });

  it("opens the local Agent record without flushing or entering Studio", async () => {
    const transport = createMockUiKernelTransport("?mode=vibe");
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const applyPage = vi.spyOn(transport, "applyVibePage");
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const openSurface = vi.spyOn(transport, "openSurface");
    const updateSurface = vi.spyOn(transport, "updateSurface");
    const applyStudio = vi.spyOn(transport, "applyStudio");
    const { container } = await renderApp(transport);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-region-switcher button[data-region='exploration']",
      )!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent)
      .toBe("Unsaved changes");
    applyPage.mockClear();
    setMode.mockClear();
    openSurface.mockClear();
    updateSurface.mockClear();
    applyStudio.mockClear();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-exploration button[data-agent-record-trigger='record']",
      )!.click();
      await settle();
    });

    const host = container.querySelector<HTMLElement>(".rho-vibe-agent-record-host")!;
    expect(host).not.toBeNull();
    expect(host.textContent).toContain("What should we inspect first?");
    expect(host.textContent).toContain("Start with the project structure and runtime health.");
    expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull();
    expect(container.querySelector("[data-surface-id='rho.agent']")).toBeNull();
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent)
      .toBe("Unsaved changes");
    expect(applyPage).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(openSurface).not.toHaveBeenCalled();
    expect(updateSurface).not.toHaveBeenCalled();
    expect(applyStudio).not.toHaveBeenCalled();
  });

  it("uses the accepted same-root epoch for Vibe verification and drops the deferred A1 read", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(
      `?mode=vibe&project=${encodeURIComponent(projectA)}`,
    );
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )!;
    const mutablePage = page as unknown as {
      sections: typeof page.sections;
      focused_block_id: string | null;
    };
    mutablePage.sections = [{
      section_id: "section:verification-epoch",
      heading: "Epoch verification",
      layout: { kind: "flow" },
      blocks: [{
        block_id: "block:verification-epoch",
        content: {
          kind: "artifact_ref",
          artifact_id: "artifact:plot-1",
          label: "Epoch-scoped artifact",
        },
      }],
    }];
    mutablePage.focused_block_id = "block:verification-epoch";
    transport.publishUiProfile(profile);
    const reopenProject = transport.openProject.bind(transport);
    const reopen = vi.fn(() => reopenProject(projectA));
    transport.pickProjectDirectory = reopen;
    const listArtifacts = transport.listArtifactRecords.bind(transport);
    let markA1ReadRequested = () => {};
    const a1ReadRequested = new Promise<void>((resolve) => { markA1ReadRequested = resolve; });
    let releaseA1Read = () => {};
    const a1ReadBlocked = new Promise<void>((resolve) => { releaseA1Read = resolve; });
    let firstRead = true;
    transport.listArtifactRecords = vi.fn(async (...args) => {
      const records = await listArtifacts(...args);
      if (firstRead) {
        firstRead = false;
        markA1ReadRequested();
        await a1ReadBlocked;
        return records.map((record) => ({ ...record, output_path: "plots/A1-stale.png" }));
      }
      return records.map((record) => ({ ...record, output_path: "plots/A2-current.png" }));
    });
    const { container } = await renderApp(transport);
    const vibeA1 = container.querySelector<HTMLElement>(".rho-vibe-workspace")!;
    await a1ReadRequested;
    await vi.waitFor(() => expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable"))
      .toBe("true"));
    const menu = await openRhoMenu(container);

    await act(async () => {
      menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      for (let index = 0; index < 48; index += 1) await Promise.resolve();
    });
    expect(reopen).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(
      container.querySelector(".rho-vibe-workspace"),
      container.textContent ?? "",
    ).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector(".rho-vibe-verification")?.textContent)
      .toContain("plots/A2-current.png"));
    const vibeA2 = container.querySelector<HTMLElement>(".rho-vibe-workspace")!;
    expect(vibeA2).not.toBe(vibeA1);

    await act(async () => {
      releaseA1Read();
      await settle();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-verification")?.textContent)
      .toContain("plots/A2-current.png");
    expect(container.querySelector(".rho-vibe-verification")?.textContent)
      .not.toContain("plots/A1-stale.png");
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("saves before the explicit Agent Studio handoff and restores Vibe once", async () => {
    const transport = createMockUiKernelTransport("?mode=vibe");
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const surfacesBeforeHandoff = structuredClone(await transport.loadSurfaces());
    const mountedAgentBeforeHandoff = surfacesBeforeHandoff.catalog.instances.find(
      (instance) => instance.instance_id === "instance:agent-shared",
    );
    if (mountedAgentBeforeHandoff == null) throw new Error("Mock Agent instance is missing");
    (mountedAgentBeforeHandoff as { view_state: unknown }).view_state = {
      conversation_id: null,
      mode: "ask",
      composer: "",
      auto_approve: false,
    };
    const agentInstanceIdsBeforeHandoff = new Set(
      surfacesBeforeHandoff.catalog.instances
        .filter((instance) => instance.surface_id === "rho.agent")
        .map((instance) => instance.instance_id),
    );
    transport.publishSurfaces(surfacesBeforeHandoff);
    const applyPage = vi.spyOn(transport, "applyVibePage");
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const openSurface = vi.spyOn(transport, "openSurface");
    const applyStudio = vi.spyOn(transport, "applyStudio");
    const { container } = await renderApp(transport);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-region-switcher button[data-region='exploration']",
      )!.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-exploration button[data-agent-record-trigger='record']",
      )!.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent)
      .toBe("Unsaved changes");
    applyPage.mockClear();
    setMode.mockClear();
    openSurface.mockClear();
    applyStudio.mockClear();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-agent-record-host button")]
        .find((button) => button.textContent === "在 Studio 中深入检查")!
        .click();
      for (let index = 0; index < 48; index += 1) await Promise.resolve();
    });

    expect(applyPage).toHaveBeenCalledOnce();
    expect(setMode).toHaveBeenCalledOnce();
    expect(setMode.mock.calls[0]?.[0]).toMatchObject({ mode: "studio" });
    expect(applyPage.mock.invocationCallOrder[0]).toBeLessThan(
      setMode.mock.invocationCallOrder[0]!,
    );
    expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
      surface_id: "rho.agent",
      instance_disposition: "new_instance",
      view_state: expect.objectContaining({
        conversation_id: "agent-conversation:mock-shared",
        mode: "act",
        composer: "",
        auto_approve: false,
      }),
    }));
    const surfacesAfterHandoff = await transport.loadSurfaces();
    const createdExactAgents = surfacesAfterHandoff.catalog.instances.filter((instance) =>
      instance.surface_id === "rho.agent"
      && !agentInstanceIdsBeforeHandoff.has(instance.instance_id)
      && (instance.view_state as { conversation_id?: unknown } | null)?.conversation_id
        === "agent-conversation:mock-shared"
    );
    expect(createdExactAgents).toHaveLength(1);
    const createdExactAgentId = createdExactAgents[0]!.instance_id;
    expect(applyStudio).toHaveBeenCalledWith(expect.objectContaining({
      edit: expect.objectContaining({ instance_id: createdExactAgentId }),
    }));
    const agent = container.querySelector<HTMLElement>(
      `[data-surface-id='rho.agent'][data-instance-id='${createdExactAgentId}']`,
    )!;
    expect(agent).not.toBeNull();
    expect(agent.querySelector<HTMLSelectElement>(
      `[aria-label='Conversation for ${createdExactAgentId}']`,
    )?.value).toBe("agent-conversation:mock-shared");
    expect(agent.textContent).toContain("What should we inspect first?");

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      for (let index = 0; index < 32; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("focus-exploration");
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-active-region"))
      .toBe("exploration");

    const restoredProfile = structuredClone(await transport.loadUiProfile());
    const restoredPage = restoredProfile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === "page:project-review",
    )!;
    const secondPage = {
      ...structuredClone(restoredPage),
      page_id: "page:agent-return-check",
      label: "Agent return check",
      page_revision: 1,
      sections: [],
      focused_block_id: null,
    };
    (restoredProfile.profile as { revision: number }).revision += 1;
    (restoredProfile.profile as { active_vibe_page_id: string | null }).active_vibe_page_id =
      secondPage.page_id;
    (restoredProfile.profile as { vibe_pages: typeof restoredProfile.profile.vibe_pages })
      .vibe_pages = [...restoredProfile.profile.vibe_pages, secondPage];
    await act(async () => {
      transport.publishUiProfile(restoredProfile);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("overview");

    const originalProfile = structuredClone(await transport.loadUiProfile());
    (originalProfile.profile as { revision: number }).revision += 1;
    (originalProfile.profile as { active_vibe_page_id: string | null }).active_vibe_page_id =
      restoredPage.page_id;
    await act(async () => {
      transport.publishUiProfile(originalProfile);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("overview");
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-active-region"))
      .toBe("manuscript");
  });

  it("keeps exact artifact verification in Vibe without reopening the retired component", async () => {
    const transport = createMockUiKernelTransport();
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as {
      sections: Array<{
        section_id: string;
        heading: string | null;
        layout: { kind: "flow" };
        blocks: Array<{
          block_id: string;
          content: { kind: "artifact_ref"; artifact_id: string; label: string };
        }>;
      }>;
      focused_block_id: string | null;
    };
    page.sections = [{
      section_id: "section:artifact-review",
      heading: "Candidate output",
      layout: { kind: "flow" },
      blocks: [{
        block_id: "block:artifact-review",
        content: {
          kind: "artifact_ref",
          artifact_id: "artifact:plot-1",
          label: "QC plot candidate",
        },
      }],
    }];
    page.focused_block_id = "block:artifact-review";
    transport.publishUiProfile(profile);
    const openSurface = vi.spyOn(transport, "openSurface");
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-vibe-verification")?.textContent)
      .toContain("QC plot candidate");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-region-switcher button[data-region='verification']",
      )!.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("focus-verification");
    expect(container.querySelector<HTMLElement>("[data-block-id='block:artifact-review']")?.dataset.vibeActive)
      .toBe("true");
    expect([...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-verification button")]
      .some((button) => button.textContent === "在 Studio 中查看")).toBe(false);
    expect(container.querySelector("[data-surface-id='rho.artifacts']")).toBeNull();
    expect(container.querySelector("[data-surface-factory='rho.artifacts']")).not.toBeNull();
    expect(openSurface).not.toHaveBeenCalled();
    expect(setMode.mock.calls.some(([request]) => request.mode === "studio")).toBe(false);
  });

  it("clears an A1 Vibe return point when a same-project transition is cancelled", async () => {
    const projectA = "/projects/project-a";
    const transport = createMockUiKernelTransport(
      `?mode=vibe&project=${encodeURIComponent(projectA)}`,
    );
    const surfaces = structuredClone(await transport.loadSurfaces());
    const checkResult = await transport.runCheckProject({
      project_id: surfaces.project_id,
      expected_project_revision: surfaces.project_revision,
    });
    const checkSurface = surfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:check",
    )!;
    (checkSurface as { view_state: unknown }).view_state = {
      check_result_id: checkResult.result.result_id,
    };
    transport.publishSurfaces(surfaces);
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )!;
    const mutablePage = page as unknown as {
      sections: typeof page.sections;
      focused_block_id: string | null;
    };
    mutablePage.sections = [{
      section_id: "section:return-epoch",
      heading: "Return epoch",
      layout: { kind: "flow" },
      blocks: [{
        block_id: "block:return-epoch",
        content: {
          kind: "surface_ref",
          instance_id: "instance:check",
          live: true,
        },
      }],
    }];
    mutablePage.focused_block_id = "block:return-epoch";
    transport.publishUiProfile(profile);
    const cancelPick = vi.fn(async () => ({
      status: "cancelled",
      project: null,
      session: {},
      unavailable: null,
      blocker: null,
      reason_code: null,
      message: null,
      restored_root: null,
      restart_required: false,
    } as const));
    transport.pickProjectDirectory = cancelPick;
    const { container } = await renderApp(transport);
    await vi.waitFor(() => expect(container.querySelector(".rho-vibe-verification-check"))
      .not.toBeNull());

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        ".rho-vibe-region-switcher button[data-region='verification']",
      )!.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("focus-verification");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-verification button")]
        .find((button) => button.textContent === "在 Studio 中查看")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".rho-canvas-studio")).not.toBeNull());
    });

    const menu = await openRhoMenu(container);
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(".rho-rho-project")!.click();
      await vi.waitFor(() => expect(cancelPick).toHaveBeenCalledOnce());
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".rho-vibe-workspace")).not.toBeNull());
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("overview");
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-active-region"))
      .toBe("manuscript");
  });

  it("keeps Vibe active when pending manuscript edits fail to save before a mode change", async () => {
    const transport = createMockUiKernelTransport();
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const rejection = new Error("Vibe Page rejected: Page revision is stale.");
    vi.spyOn(transport, "applyVibePage").mockRejectedValue(rejection);
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    setMode.mockClear();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      await settle();
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Studio")!
        .click();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(setMode).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull();
    expect(container.querySelector(".rho-vibe-manuscript-save-state[role='alert']")?.textContent)
      .toContain("Save failed");
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("处理保存问题");
  });

  it("redacts Vibe operation failures before presenting them in the Workbench", async () => {
    const transport = createMockUiKernelTransport();
    const failure = new Error(
      "Export failed for page_id=page:internal-77 at /Users/alice/private/rho/page.json.",
    );
    const exportPage = vi.spyOn(transport, "exportVibePage").mockRejectedValue(failure);
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull());
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-document-actions button")]
        .find((button) => button.textContent === "导出只读手稿")!
        .click();
      await settle();
    });

    expect(exportPage).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("[internal reference]");
    expect(container.querySelector(".rho-action-error")?.textContent).toContain("[local path]");
    expect(container.querySelector(".rho-action-error")?.textContent).not.toContain("page:internal-77");
    expect(container.querySelector(".rho-action-error")?.textContent).not.toContain("/Users/alice");
  });

  it("locks manuscript mutations after flush while the Studio mode mutation is pending", async () => {
    const transport = createMockUiKernelTransport();
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as { sections: unknown[]; focused_block_id: string | null };
    page.sections = [];
    page.focused_block_id = null;
    transport.publishUiProfile(profile);
    const apply = vi.spyOn(transport, "applyVibePage");
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
    });
    const setMode = transport.setUiProfileMode.bind(transport);
    let markStudioModeRequested = () => {};
    const studioModeRequested = new Promise<void>((resolve) => {
      markStudioModeRequested = resolve;
    });
    let releaseStudioMode = () => {};
    const studioModeBlocked = new Promise<void>((resolve) => {
      releaseStudioMode = resolve;
    });
    transport.setUiProfileMode = vi.fn(async (request) => {
      if (request.mode === "studio") {
        markStudioModeRequested();
        await studioModeBlocked;
      }
      return setMode(request);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".rho-vibe-manuscript-empty button")!.click();
      await settle();
    });
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent)
      .toBe("Unsaved changes");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Studio")!
        .click();
      await studioModeRequested;
      await settle();
    });

    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    const editorHtml = editor.innerHTML;
    expect(apply).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-vibe-manuscript")?.getAttribute("aria-busy")).toBe("true");
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    const formatting = [...container.querySelectorAll<HTMLButtonElement>(
      ".rho-vibe-manuscript-toolbar button",
    )];
    expect(formatting.every((button) => button.disabled)).toBe(true);
    await act(async () => {
      formatting[0]!.click();
      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "must-not-be-drafted",
        inputType: "insertText",
      }));
      await settle();
    });
    expect(editor.innerHTML).toBe(editorHtml);
    expect(apply).toHaveBeenCalledOnce();
    expect(container.querySelector(".rho-vibe-manuscript-save-state")?.textContent).toBe("Saved");

    await act(async () => {
      releaseStudioMode();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-canvas-studio")).not.toBeNull();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("rejects an exact Studio intent when the latest manuscript block now references another target", async () => {
    const transport = createMockUiKernelTransport();
    const surfaces = structuredClone(await transport.loadSurfaces());
    const checkResult = await transport.runCheckProject({
      project_id: surfaces.project_id,
      expected_project_revision: surfaces.project_revision,
    });
    const checkSurface = surfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:check",
    )!;
    (checkSurface as { view_state: unknown }).view_state = {
      check_result_id: checkResult.result.result_id,
    };
    transport.publishSurfaces(surfaces);
    const profile = structuredClone(await transport.loadUiProfile());
    const page = profile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === profile.profile.active_vibe_page_id,
    )! as unknown as {
      page_revision: number;
      sections: Array<{
        section_id: string;
        heading: string | null;
        layout: { kind: "flow" };
        blocks: Array<{
          block_id: string;
          content: { kind: "surface_ref"; instance_id: string; live: boolean };
        }>;
      }>;
      focused_block_id: string | null;
    };
    page.sections = [{
      section_id: "section:exact-current",
      heading: "Candidate output",
      layout: { kind: "flow" },
      blocks: [{
        block_id: "block:stable-id",
        content: {
          kind: "surface_ref",
          instance_id: "instance:check",
          live: true,
        },
      }],
    }];
    page.focused_block_id = "block:stable-id";
    transport.publishUiProfile(profile);
    const setMode = vi.spyOn(transport, "setUiProfileMode");
    const openSurface = vi.spyOn(transport, "openSurface");
    const { container } = await renderApp(transport);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      await settle();
      await settle();
    });
    setMode.mockClear();
    openSurface.mockClear();
    const staleAction = [...container.querySelectorAll<HTMLButtonElement>(
      ".rho-vibe-verification button",
    )].find((button) => button.textContent === "在 Studio 中查看")!;
    const changed = structuredClone(await transport.loadUiProfile());
    const changedPage = changed.profile.vibe_pages.find(
      (candidate) => candidate.page_id === changed.profile.active_vibe_page_id,
    )! as unknown as typeof page;
    changedPage.page_revision += 1;
    changedPage.sections[0]!.blocks[0]!.content = {
      kind: "surface_ref",
      instance_id: "instance:console-a",
      live: true,
    };
    (changed.profile as { revision: number }).revision += 1;

    await act(async () => {
      transport.publishUiProfile(changed);
      staleAction.click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });

    expect(setMode).not.toHaveBeenCalled();
    expect(openSurface).not.toHaveBeenCalled();
    expect(container.querySelector(".rho-canvas-vibe")).not.toBeNull();
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("reference changed");
  });

  it("runs repeatable Check commands into independent typed result Surfaces", async () => {
    const { container } = await renderApp();
    await invokePaletteCommand(container, "Check project");
    expect(container.querySelectorAll(".rho-check-result")).toHaveLength(1);
    expect(container.querySelector(".rho-check-outcome")?.textContent).toContain("2 findings to review");
    expect(container.querySelector(".rho-check-result-meta summary")?.textContent).toBe("Result details");
    expect(container.querySelector(".rho-check-rule-meta summary")?.textContent).toBe("Rule details");
    expect(container.textContent).toContain("Random result may change");
    expect(container.textContent).toContain("Rho core");
    expect(container.textContent).toContain("Workspace rule pack · org.example.project-checks · g3");
    expect(container.querySelector(".rho-check-references button")?.textContent).toContain("analysis.R:2:1");

    await invokePaletteCommand(container, "Check project");
    const results = [...container.querySelectorAll<HTMLElement>(".rho-check-result")];
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.dataset.resultId)).size).toBe(2);
  });

  it("keeps dirty-source Check rejection actionable without breaking the workspace", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?check=dirty"));
    await invokePaletteCommand(container, "Check project");
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Save modified source files before checking: analysis.R",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Environment realtime information']")!.click();
      await settle();
    });
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.querySelector("[data-surface-id='rho.file-source']")).not.toBeNull();
  });

  it("keeps instance-local state when a sibling placement closes", async () => {
    const { container } = await renderApp();
    await openInspector(container);
    const developer = container.querySelector<HTMLDetailsElement>(".rho-developer-components")!;
    await act(async () => {
      developer.querySelector<HTMLElement>("summary")!.click();
      await settle();
    });
    for (let index = 0; index < 2; index += 1) {
      const factory = container.querySelector<HTMLElement>("[data-surface-factory='rho.surface-playground']")!;
      await act(async () => {
        factory.querySelector<HTMLButtonElement>("button")!.click();
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
    await closeSurface(firstCard);
    const remaining = container.querySelector<HTMLElement>("[data-surface-id='rho.surface-playground']")!;
    expect(container.querySelectorAll("[data-surface-id='rho.surface-playground']")).toHaveLength(1);
    expect(remaining.dataset.instanceId).toBe(survivorId);
    expect(remaining.querySelector<HTMLInputElement>("input")!.value).toBe("survivor draft");
  });

  it("makes Dockview sashes keyboard accessible and commits one authoritative resize", async () => {
    const transport = createMockUiKernelTransport();
    const original = transport.applyStudio.bind(transport);
    const apply = vi.fn(original);
    transport.applyStudio = apply;
    const { container } = await renderApp(transport);
    const handle = container.querySelector<HTMLElement>(".dv-sash[role='separator']")!;
    expect(handle).not.toBeNull();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.dataset.rhoDockviewBranch).toBe("0");
    expect(handle.dataset.rhoDockviewBoundary).toBe("0");
    const resizeKey = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    await act(async () => {
      handle.dispatchEvent(resizeKey);
      await settle();
    });
    expect(resizeKey.defaultPrevented).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].edit).toMatchObject({
      kind: "resize_boundary",
      container_node_id: "node:root",
      before_child_index: 0,
    });
  });

  it("keeps Console drafts, histories, and output origins instance-local on a shared Runtime", async () => {
    const { container } = await renderApp();
    expect(container.querySelectorAll("[data-surface-id='rho.console']")).toHaveLength(1);
    const tabs = [...container.querySelectorAll<HTMLElement>("[data-rho-pane-node-id='node:consoles']")];
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
    expect(first.querySelector(".rho-console-entry")?.getAttribute("aria-label"))
      .toBe("R Console execution 1");
    expect(first.querySelector(".rho-console-entry")?.textContent).not.toContain("instance:console-a");

    await act(async () => {
      const dockviewTab = tabs[1]!.closest<HTMLElement>(".dv-tab")!;
      pointer(dockviewTab, "pointerdown", 10, 10);
      pointer(dockviewTab, "pointerup", 10, 10);
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
    expect(second.querySelector(".rho-console-entry")?.getAttribute("aria-label"))
      .toBe("R Console execution 1");
    const secondMenu = await openSurfaceMenu(second);
    await act(async () => {
      [...secondMenu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Start new transcript")!
        .click();
      await settle();
    });
    expect(second.querySelectorAll(".rho-console-entry")).toHaveLength(0);
    secondComposer.setSelectionRange(0, 0);
    await act(async () => {
      secondComposer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
      await settle();
    });
    expect(secondComposer.value).toBe("2 + 2");
    await act(async () => {
      const firstTab = container.querySelector<HTMLElement>(
        "[data-rho-tab-instance-id='instance:console-a']",
      )!;
      const dockviewTab = firstTab.closest<HTMLElement>(".dv-tab")!;
      pointer(dockviewTab, "pointerdown", 10, 10);
      pointer(dockviewTab, "pointerup", 10, 10);
      firstTab.click();
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
    const menu = await openSurfaceMenu(source);
    const pause = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Pause component")!;
    await act(async () => {
      pause.click();
      await settle();
    });
    const paused = container.querySelector<HTMLElement>(`[data-instance-id='${instanceId}']`)!;
    expect(paused.textContent).toContain("Component paused");
    expect(paused.querySelector(".rho-task-state-paused")).not.toBeNull();
    expect(paused.querySelector(".rho-source-editor-shell")).toBeNull();
    expect(suspend).toHaveBeenCalledOnce();
    await act(async () => {
      [...paused.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Resume component")!
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
    const menu = await openSurfaceMenu(original);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Duplicate component")!
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
      expect(agent.textContent).toContain("Mock act response");
    }
  });

  it("keeps completed Agent metadata quiet and exposes Broker posture without workflow modes", async () => {
    const { container } = await renderApp();
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const completed = agent.querySelector<HTMLElement>(".rho-agent-turn-completed")!;
    expect(completed.querySelector(":scope > header > code")).toBeNull();
    expect(completed.querySelector(":scope > header > .rho-agent-turn-status")).toBeNull();
    expect(completed.querySelector(".rho-agent-turn-meta summary")?.textContent).toBe("Details");
    expect(agent.querySelector(".rho-agent-mode")).toBeNull();
    expect(agent.querySelector(".rho-agent-auto-approve")?.textContent)
      .toContain("Auto-approve project tools for this conversation");
    expect(agent.querySelector(".rho-agent-mode-hint")?.textContent)
      .toBe("Observe → plan → request effect → re-observe");
    expect(agent.querySelector(".rho-agent-overview")?.textContent)
      .toContain("Goal-driven scientific work");
  });

  it("makes read-only Authority health the primary Environment view", async () => {
    const transport = createMockUiKernelTransport();
    const health = vi.spyOn(transport, "environmentHealth");
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.environment']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const environment = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.environment']")]
      .find((surface) => surface.querySelector(".rho-environment-health") != null)!;
    expect(environment).toBeDefined();
    expect(environment.textContent).toContain("Realized and observed");
    expect(environment.textContent).toContain("Authority facts");
    expect(environment.textContent).toContain("environment-receipt:mock");
    expect(environment.textContent).toContain("Immutable exact plan");
    const callsBeforeRefresh = health.mock.calls.length;
    expect(callsBeforeRefresh).toBeGreaterThan(0);
    await act(async () => {
      [...environment.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Refresh")!.click();
      await settle();
    });
    expect(health).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
  });

  it("removes the retired Environment resource taskbar and keeps Authority health contextual", async () => {
    const transport = createMockUiKernelTransport();
    const health = vi.spyOn(transport, "environmentHealth");
    const { container } = await renderApp(transport);
    expect(container.querySelector("[aria-label='Environment realtime information']")).toBeNull();
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.environment']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(container.querySelector("[data-surface-id='rho.environment'] .rho-environment-health"))
      .not.toBeNull();
    expect(health).toHaveBeenCalled();
  });

  it("maps a retired package mode to Authority health without generic payload rendering", async () => {
    const transport = createMockUiKernelTransport();
    const surfaces = structuredClone(await transport.loadSurfaces());
    const environment = surfaces.catalog.instances.find(
      (instance) => instance.surface_id === "rho.environment",
    )!;
    (environment as { mode_id: string | null }).mode_id = "packages";
    transport.publishSurfaces(surfaces);
    const generic = vi.spyOn(transport, "loadDomainSurface");
    const { container } = await renderApp(transport);
    const surface = container.querySelector<HTMLElement>("[data-surface-id='rho.environment']")!;
    expect(surface.querySelector(".rho-environment-health")).not.toBeNull();
    expect(surface.textContent).toContain("Authority facts");
    expect(generic.mock.calls.some(([surfaceId]) => surfaceId === "rho.environment")).toBe(false);
  });

  it("maps a retired request mode to immutable plan and Authority activity", async () => {
    const transport = createMockUiKernelTransport();
    const surfaces = structuredClone(await transport.loadSurfaces());
    const environment = surfaces.catalog.instances.find((instance) => instance.surface_id === "rho.environment")!;
    (environment as { mode_id: string | null }).mode_id = "requests";
    transport.publishSurfaces(surfaces);
    const { container } = await renderApp(transport);
    const surface = container.querySelector<HTMLElement>("[data-surface-id='rho.environment']")!;
    expect(surface.querySelector(".rho-environment-health")).not.toBeNull();
    expect(surface.textContent).toContain("Immutable exact plan");
    expect(surface.textContent).toContain("Operation activity");
    expect(surface.textContent).not.toContain("/private/project");
  });

  it("exposes only Health, Plans and Activity Environment modes", async () => {
    const transport = createMockUiKernelTransport();
    const update = vi.spyOn(transport, "updateSurface");
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.environment']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const environments = [...container.querySelectorAll<HTMLElement>("[data-surface-id='rho.environment']")];
    const environment = environments.at(-1)!;
    const menu = await openSurfaceMenu(environment);
    const health = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Health"));
    const plans = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Plans"));
    const activity = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Activity"));
    expect(health?.getAttribute("aria-pressed")).toBe("true");
    expect(plans?.getAttribute("aria-pressed")).toBe("false");
    expect(activity?.getAttribute("aria-pressed")).toBe("false");
    expect(menu.textContent).not.toContain("Packages");
    expect(menu.textContent).not.toContain("Requests");
    await act(async () => {
      activity!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ instance_id: environment.dataset.instanceId }),
      mutation: { kind: "set_mode", mode_id: "activity" },
    }));
    expect(environment.textContent).toContain("Operation activity");
  });

  it("keeps contextual failed-run Problems out of Compose but reachable by command", async () => {
    const { container } = await renderApp();
    await openInspector(container);
    expect(container.querySelector("[data-surface-factory='rho.problems']")).toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }));
      await settle();
      const search = container.querySelector<HTMLInputElement>("[aria-label='Search commands']")!;
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setInputValue.call(search, "rho.surface.open.problems");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      [...container.querySelectorAll<HTMLButtonElement>(".rho-command-results button")]
        .find((button) => button.textContent?.includes("rho.surface.open.problems"))!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(container.querySelector("[data-surface-id='rho.problems']")?.classList)
      .toContain("rho-surface-strip");
  });

  it("keeps normal components focused while separating project and developer components", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?plugin=surface"));
    await openInspector(container);

    const catalog = container.querySelector<HTMLElement>(".rho-surface-catalog")!;
    expect(container.querySelector(".rho-studio-inspector > header")?.textContent).toContain("Arrange workspace");
    expect(container.querySelector<HTMLDetailsElement>(".rho-compose-layout")?.open).toBe(false);
    expect([...container.querySelectorAll<HTMLDetailsElement>(".rho-compose-advanced")].every((section) => !section.open)).toBe(true);
    expect(catalog.querySelector(".rho-surface-catalog-heading")?.textContent).toContain("Core components");
    expect(catalog.querySelector(".rho-surface-catalog-heading")?.textContent).not.toContain("factories");
    expect(catalog.querySelector(":scope > [data-surface-factory='rho.surface-playground']")).toBeNull();
    expect(catalog.querySelector("[data-surface-factory='rho.settings']")).toBeNull();
    expect(catalog.querySelector("[data-surface-factory='rho.check-result']")).toBeNull();
    expect(catalog.querySelector("[data-surface-factory='rho.jobs']")).not.toBeNull();
    expect(catalog.querySelector("[data-surface-factory='rho.problems']")).toBeNull();
    const flowGroups = [...catalog.querySelectorAll<HTMLElement>(".rho-surface-catalog-flow")];
    expect(flowGroups.map((group) => group.dataset.flowStage)).toEqual([
      "work", "run", "results", "collaborate", "project",
    ]);
    const coreFactories = [...catalog.querySelectorAll<HTMLElement>(
      ".rho-surface-catalog-flow > [data-surface-factory]",
    )];
    expect(coreFactories.map((factory) => factory.dataset.surfaceFactory)).toEqual([
      "rho.navigator", "rho.file-source", "rho.console", "rho.plots",
      "rho.runs", "rho.agent", "rho.environment", "rho.git",
    ]);
    expect(catalog.querySelector("[data-surface-factory='ui.surface.differential-expression'] .rho-component-origin")?.textContent)
      .toBe("Project component");

    const projectExtensions = catalog.querySelector<HTMLDetailsElement>(".rho-project-components")!;
    expect(projectExtensions.querySelector("[data-surface-factory='ui.surface.differential-expression']")).not.toBeNull();
    const developer = catalog.querySelector<HTMLDetailsElement>(".rho-developer-components:not(.rho-project-components)")!;
    expect(developer.open).toBe(false);
    expect(developer.querySelector("[data-surface-factory='rho.surface-playground']")).not.toBeNull();
    await act(async () => {
      developer.querySelector<HTMLElement>("summary")!.click();
      await settle();
    });
    expect(developer.open).toBe(true);
    await act(async () => {
      developer.querySelector<HTMLButtonElement>("[data-surface-factory='rho.surface-playground'] button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const playground = container.querySelector<HTMLElement>("[data-surface-id='rho.surface-playground']")!;
    expect(playground.querySelector(".rho-playground-draft")?.textContent).toContain("Developer preview");
    expect(playground.querySelector(".rho-playground-draft > strong")?.textContent).toBe("Instance-local state sandbox");
    expect(playground.querySelector<HTMLDetailsElement>(".rho-playground-draft details")?.open).toBe(false);
  });

  it("renders scientific domain Surfaces by task without exposing generic JSON cards", async () => {
    const transport = createMockUiKernelTransport();
    const retry = vi.spyOn(transport, "retryRun");
    const fallback = transport.loadDomainSurface.bind(transport);
    const domainLoad = vi.spyOn(transport, "loadDomainSurface").mockImplementation(async (surfaceId) => {
      const fixtures = {
        "rho.runs": [{ id: "run:secret", title: "workspace.execute", subtitle: "analysis.R", status: "failed", detail: "{\"run_id\":\"secret\",\"project_root\":\"/private/project\",\"workspace_id\":\"internal-workspace\",\"source_path\":\"analysis.R\",\"execution_mode\":\"expression\",\"code_preview\":\"plot(x)\",\"error_message\":\"object x not found\",\"started_at\":\"2026-08-22T10:00:00Z\"}" }],
        "rho.plots": [{ id: "plot:mock-1", title: "QC plot", subtitle: "image/png", status: "ready", detail: "{\"media_type\":\"image/png\",\"source_path\":\"analysis.R\",\"payload_json\":\"private-payload\"}" }],
        "rho.problems": [{ id: "problem:1", title: "object x not found", subtitle: "analysis.R", status: "error", detail: "{\"source_path\":\"analysis.R\",\"line_number\":7,\"workspace_id\":\"internal-workspace\"}" }],
        "rho.logs": [{ id: "log:1", title: "Startup diagnostics", subtitle: "now", status: "current", detail: "{\"detail\":\"Ark ready\\nWorkspace R ready\",\"project_root\":\"/private/project\"}" }],
        "rho.git": [{ id: "rho.git:1", title: "main", subtitle: null, status: null, detail: "{\"dirty\":true,\"staged\":1,\"modified\":2,\"untracked\":0,\"project_root\":\"/private/project\"}" }],
        "rho.help": [{ id: "rho.build", title: "Rho 0.4.1", subtitle: null, status: "current", detail: "{\"summary\":\"Exact build identity\",\"detail\":\"Commit: abc\\nPlatform: macOS\",\"executable_path\":\"/private/bin\"}" }],
      } as const;
      const items = fixtures[surfaceId as keyof typeof fixtures];
      return items == null ? fallback(surfaceId) : {
        surface_id: surfaceId,
        loaded_at: "2026-08-22T12:00:00Z",
        summary: `${items.length} records`,
        items,
      };
    });
    const { container } = await renderApp(transport);
    await openInspector(container);
    expect(container.querySelector("[data-surface-factory='rho.artifacts']")).not.toBeNull();
    const open = async (surfaceId: string) => {
      const factory = container.querySelector<HTMLElement>(`[data-surface-factory='${surfaceId}']`);
      await act(async () => {
        if (factory != null) {
          factory.querySelector<HTMLButtonElement>("button")!.click();
        } else {
          document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }));
          await settle();
          const search = container.querySelector<HTMLInputElement>("[aria-label='Search commands']")!;
          const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
          const commandId = `rho.surface.open.${surfaceId.slice("rho.".length)}`;
          setInputValue.call(search, commandId);
          search.dispatchEvent(new Event("input", { bubbles: true }));
          await settle();
          const command = [...container.querySelectorAll<HTMLButtonElement>(".rho-command-results button")]
            .find((button) => button.textContent?.includes(commandId));
          if (command == null) throw new Error(`Contextual command ${commandId} is unavailable`);
          command.click();
          search.blur();
          await new Promise((resolve) => window.setTimeout(resolve, 140));
        }
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      return container.querySelector<HTMLElement>(`[data-surface-id='${surfaceId}']`)!;
    };

    const runs = await open("rho.runs");
    expect(runs.querySelector("[data-domain-kind='timeline']")).not.toBeNull();
    expect(runs.textContent).toContain("1 execution needs attention");
    expect(runs.querySelector(".rho-runtime-history-code")?.textContent).toBe("plot(x)");
    expect(runs.textContent).toContain("object x not found");
    expect(runs.textContent).not.toContain("/private/project");
    expect(runs.textContent).not.toContain("internal-workspace");
    expect(runs.querySelector("[aria-label='Filter History']")).not.toBeNull();
    const runLoadsBeforeRefresh = domainLoad.mock.calls.filter(([surfaceId]) => surfaceId === "rho.runs").length;
    await act(async () => {
      runs.querySelector<HTMLButtonElement>("[aria-label='Refresh History']")!.click();
      await settle();
    });
    expect(domainLoad.mock.calls.filter(([surfaceId]) => surfaceId === "rho.runs")).toHaveLength(runLoadsBeforeRefresh + 1);
    const runLoadsBeforeExecution = domainLoad.mock.calls.filter(([surfaceId]) => surfaceId === "rho.runs").length;
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const sourceEditor = source.querySelector<HTMLTextAreaElement>("[aria-label^='Source']")!;
    await act(async () => {
      sourceEditor.setSelectionRange(0, 0);
      source.querySelector<HTMLButtonElement>("[aria-label='Run selection or current R expression in Console']")!.click();
      for (let index = 0; index < 16; index += 1) await Promise.resolve();
    });
    expect(domainLoad.mock.calls.filter(([surfaceId]) => surfaceId === "rho.runs").length)
      .toBeGreaterThan(runLoadsBeforeExecution);
    const runFilter = runs.querySelector<HTMLInputElement>("[aria-label='Filter History']")!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setInputValue.call(runFilter, "no such run");
      runFilter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(runs.querySelector(".rho-domain-empty")?.textContent).toContain("No executions match this search");
    expect(runs.querySelector(".rho-task-state-empty")).not.toBeNull();
    await act(async () => {
      setInputValue.call(runFilter, "");
      runFilter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect([...runs.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "Run again")).toBe(false);
    expect(retry).not.toHaveBeenCalled();

    const plots = await open("rho.plots");
    expect(plots.querySelector(".rho-domain-output-image")?.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
    expect(plots.textContent).not.toContain("private-payload");

    const problems = await open("rho.problems");
    expect(problems.querySelector(".rho-domain-strip[data-domain-kind='stream']")).not.toBeNull();
    expect(problems.textContent).toContain("object x not found");
    const logs = await open("rho.logs");
    expect(logs.querySelector(".rho-domain-disclosure summary")?.textContent).toBe("Open diagnostic text");

    const git = await open("rho.git");
    expect(git.querySelector("[data-domain-kind='git']")?.textContent).toContain("1 staged · 2 modified · 0 untracked");
    const help = await open("rho.help");
    expect(help.querySelector("[data-domain-kind='help']")?.textContent).toContain("Exact build identity");
    expect(help.querySelector(".rho-domain-disclosure summary")?.textContent).toBe("Build details");
    expect(help.textContent).not.toContain("/private/bin");
    expect([...container.querySelectorAll<HTMLElement>(".rho-domain-records details > summary")]
      .some((summary) => summary.textContent === "Details")).toBe(false);
  });

  it("recovers a scientific domain Surface through its existing read lane", async () => {
    const transport = createMockUiKernelTransport();
    const fallback = transport.loadDomainSurface.bind(transport);
    let runLoads = 0;
    vi.spyOn(transport, "loadDomainSurface").mockImplementation(async (surfaceId) => {
      if (surfaceId !== "rho.runs") return fallback(surfaceId);
      runLoads += 1;
      if (runLoads === 1) throw new Error("Run history unavailable");
      return fallback(surfaceId);
    });
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.runs']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const runs = container.querySelector<HTMLElement>("[data-surface-id='rho.runs']")!;
    expect(runs.querySelector("[role='alert']")?.textContent).toContain("Run history unavailable");
    expect(runs.querySelector(".rho-task-state-error")).not.toBeNull();
    await act(async () => {
      [...runs.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Try again")!.click();
      await settle();
    });
    expect(runs.querySelector("[role='alert']")).toBeNull();
    expect(runs.querySelector("[data-domain-id='run:mock-1']")).not.toBeNull();
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
    await openInspector(container);
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

    const closedViews = container.querySelector<HTMLDetailsElement>(".rho-recent-closed")!;
    await act(async () => {
      closedViews.querySelector<HTMLElement>("summary")!.click();
      await settle();
    });
    const previewItem = [...closedViews.querySelectorAll<HTMLElement>(".rho-recent-closed-item")]
      .find((item) => item.textContent?.includes("File preview"))!;
    await act(async () => {
      previewItem.querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const save = sourceViews[0]!.querySelector<HTMLButtonElement>(".rho-file-save")!;
    await act(async () => {
      save.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    const preview = container.querySelector<HTMLElement>("[data-surface-id='rho.file-preview']")!;
    expect(preview.textContent).toContain("stale");
    expect(preview.textContent).toContain("Refresh");
  });

  it("serializes rapid File Save activation and recovers draft and save failures", async () => {
    const transport = createMockUiKernelTransport();
    const updateDraft = transport.updateResourceDraft.bind(transport);
    const saveResource = transport.saveResource.bind(transport);
    const advanceProjectRevision = async () => {
      const [kernel, surfaces, studio, runtimes, resources] = await Promise.all([
        transport.loadSnapshot(),
        transport.loadSurfaces(),
        transport.loadStudio(),
        transport.loadRuntimes(),
        transport.loadResources(),
      ]);
      const nextProjectRevision = kernel.context.project_revision + 1;
      transport.publish({
        ...kernel,
        context: { ...kernel.context, project_revision: nextProjectRevision },
      });
      transport.publishSurfaces({ ...surfaces, project_revision: nextProjectRevision });
      transport.publishStudio({ ...studio, project_revision: nextProjectRevision });
      transport.publishRuntimes({ ...runtimes, project_revision: nextProjectRevision });
      transport.publishResources({ ...resources, project_revision: nextProjectRevision });
      return nextProjectRevision;
    };
    let settledDraftProjectRevision: number | null = null;
    const update = vi.fn(async (request: Parameters<typeof transport.updateResourceDraft>[0]) => {
      if (update.mock.calls.length === 1) throw new Error("Draft revision rejected for test.");
      const result = await updateDraft(request);
      if (update.mock.calls.length === 2) {
        settledDraftProjectRevision = await advanceProjectRevision();
      }
      return result;
    });
    let markSaveFailureRequested = () => {};
    const saveFailureRequested = new Promise<void>((resolve) => {
      markSaveFailureRequested = resolve;
    });
    let releaseSaveFailure = () => {};
    const saveFailureBlocked = new Promise<void>((resolve) => {
      releaseSaveFailure = resolve;
    });
    const save = vi.fn(async (request: Parameters<typeof transport.saveResource>[0]) => {
      if (save.mock.calls.length === 1) {
        markSaveFailureRequested();
        await saveFailureBlocked;
        throw new Error("Resource save rejected for test.");
      }
      return saveResource(request);
    });
    transport.updateResourceDraft = update;
    transport.saveResource = save;
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(editor, "saved_without_blur <- TRUE\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    const saveButton = source.querySelector<HTMLButtonElement>(".rho-file-save")!;
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(update).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(editor.value).toBe("saved_without_blur <- TRUE\n");
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled).toBe(false);
    expect(container.textContent).toContain("Draft revision rejected for test.");

    await act(async () => {
      source.querySelector<HTMLButtonElement>(".rho-file-save")!.click();
      source.querySelector<HTMLButtonElement>(".rho-file-save")!.click();
      await saveFailureRequested;
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      expected_document_revision: 1,
      content: "saved_without_blur <- TRUE\n",
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ expected_document_revision: 2 });
    expect(save.mock.calls[0]?.[0].target.expected_project_revision)
      .toBe(settledDraftProjectRevision);
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled).toBe(true);
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.getAttribute("aria-busy"))
      .toBe("true");
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.textContent)
      .toBe("Saving…");
    expect(container.querySelector(".rho-action-error")).toBeNull();

    await act(async () => {
      releaseSaveFailure();
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(".rho-action-error")?.textContent)
        .toContain("Resource save rejected for test."));
    });
    expect(container.querySelector(".rho-action-error")?.textContent)
      .toContain("Resource save rejected for test.");
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled).toBe(false);
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.hasAttribute("aria-busy"))
      .toBe(false);
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.textContent).toBe("Save");

    await act(async () => {
      source.querySelector<HTMLButtonElement>(".rho-file-save")!.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await settle();
    });
    await act(async () => {
      await vi.waitFor(() => expect(
        source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled,
      ).toBe(true));
      await settle();
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toMatchObject({ expected_document_revision: 2 });
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled).toBe(true);
    expect(container.querySelector(".rho-action-error")).toBeNull();
  });

  it("keeps keyboard focus transfer between File workflow actions inside the Save or Run admission", async () => {
    const transport = createMockUiKernelTransport();
    const update = vi.spyOn(transport, "updateResourceDraft");
    const save = vi.spyOn(transport, "saveResource");
    const execute = vi.spyOn(transport, "startRuntimeExecution");
    const { container } = await renderApp(transport);
    const source = container.querySelector<HTMLElement>("[data-surface-id='rho.file-source']")!;
    const editor = source.querySelector<HTMLTextAreaElement>(".rho-source-editor")!;
    const run = source.querySelector<HTMLButtonElement>(".rho-file-run")!;
    const saveButton = source.querySelector<HTMLButtonElement>(".rho-file-save")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

    await act(async () => {
      setValue.call(editor, "KEYBOARD_SAVE_WORKFLOW <- TRUE\n");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
      run.focus();
      await settle();
      saveButton.focus();
      await settle();
    });
    expect(document.activeElement).toBe(saveButton);
    expect(update).not.toHaveBeenCalled();

    await act(async () => {
      saveButton.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
      saveButton.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
      await settle();
    });
    expect(update).toHaveBeenCalledOnce();

    await act(async () => {
      editor.focus();
      setValue.call(editor, "KEYBOARD_RUN_WORKFLOW()");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.setSelectionRange(0, 0);
      saveButton.focus();
      await settle();
      run.focus();
      await settle();
    });
    expect(document.activeElement).toBe(run);
    expect(update).toHaveBeenCalledOnce();

    await act(async () => {
      run.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
      run.click();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await settle();
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].code).toBe("KEYBOARD_RUN_WORKFLOW()");
    expect(container.querySelector(".rho-action-error")).toBeNull();
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
              {
                kind: "tabs" as const,
                active_tab_id: "summary",
                tabs: [
                  { tab_id: "summary", label: "Summary", blocks: [{ kind: "text" as const, text: "Summary panel" }] },
                  { tab_id: "details", label: "Details", blocks: [{ kind: "text" as const, text: "Details panel" }] },
                ],
              },
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
    expect(plugin?.getAttribute("aria-label")).toBe("Differential expression component");
    expect(plugin?.getAttribute("data-surface-area")).toBe("context");
    const pluginTab = container.querySelector<HTMLElement>(
      `[data-rho-tab-instance-id='${plugin?.dataset.instanceId}']`,
    );
    expect(pluginTab?.textContent).toContain("Differential expression");
    expect(plugin?.querySelector(".rho-surface-title")).toBeNull();
    expect(plugin?.textContent).toContain("Differential expression explorer");
    expect(plugin?.querySelector(".rho-plugin-surface-document > header > span")?.textContent).toBe("Project component");
    expect(plugin?.querySelector(".rho-plugin-document-meta summary")?.textContent).toBe("Document details");
    expect(plugin?.querySelector<HTMLDetailsElement>(".rho-plugin-document-meta")?.open).toBe(false);
    expect(plugin?.textContent).toContain("<script>window.__TAURI__.invoke()</script> is literal text");
    expect(plugin?.querySelector("script")).toBeNull();
    const injectedTabs = plugin!.querySelector<HTMLElement>(".rho-plugin-tabs")!;
    const pluginTabs = [...injectedTabs.querySelectorAll<HTMLButtonElement>("[role='tab']")];
    expect(pluginTabs.map((tab) => [tab.textContent, tab.tabIndex, tab.getAttribute("aria-selected")]))
      .toEqual([["Summary", 0, "true"], ["Details", -1, "false"]]);
    await act(async () => {
      pluginTabs[1]!.click();
      await settle();
    });
    expect(pluginTabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(injectedTabs.querySelector("[role='tabpanel']")?.textContent).toContain("Details panel");

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

    const menu = await openSurfaceMenu(plugin!);
    await act(async () => {
      [...menu.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Duplicate component")!
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

  it("uses the shared loading and failure states for project components", async () => {
    const loadingTransport = createMockUiKernelTransport("?plugin=surface");
    const originalLoad = loadingTransport.loadPluginSurfaceDocument.bind(loadingTransport);
    let release: (() => void) | undefined;
    loadingTransport.loadPluginSurfaceDocument = async (request) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalLoad(request);
    };
    const loading = await renderApp(loadingTransport);
    const plugin = loading.container.querySelector<HTMLElement>(
      "[data-surface-id='ui.surface.differential-expression']",
    )!;
    expect(plugin.querySelector(".rho-task-state-loading")?.textContent).toContain("Loading project component");
    await act(async () => {
      release?.();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(plugin.querySelector(".rho-plugin-surface-document")).not.toBeNull();

    const failedTransport = createMockUiKernelTransport("?plugin=surface");
    failedTransport.loadPluginSurfaceDocument = vi.fn(async () => {
      throw new Error("Project component document unavailable");
    });
    const failed = await renderApp(failedTransport);
    const failedPlugin = failed.container.querySelector<HTMLElement>(
      "[data-surface-id='ui.surface.differential-expression']",
    )!;
    expect(failedPlugin.querySelector(".rho-task-state-error")?.textContent)
      .toContain("Project component unavailable");
    expect([...failedPlugin.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "Try again")).toBe(true);
  });
});
