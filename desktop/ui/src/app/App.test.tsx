import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "../transport/mock";
import type { LayoutChild, LayoutNode } from "../transport/types";
import { App } from "./App";
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
    expect(prepare).toHaveBeenLastCalledWith(true);
  });

  async function showToolbarComponent(container: HTMLElement, label: string) {
    if ([...container.querySelectorAll<HTMLElement>("[data-toolbar-component]")]
      .some((component) => component.textContent?.includes(label))) return;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
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
        menu.querySelector<HTMLElement>("summary")!.click();
        await settle();
      });
    }
    return menu;
  }

  async function openSurfaceMenu(surface: Element) {
    const trigger = surface.querySelector<HTMLButtonElement>(".rho-surface-actions [aria-label^='More actions for']");
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

  it("starts with only the three fixed toolbar anchors and exposes every optional projection", async () => {
    const { container } = await renderApp();
    const bar = container.querySelector<HTMLElement>(".rho-studio-bar")!;
    expect(bar.querySelector("[aria-label='Rho menu']")).not.toBeNull();
    expect(bar.querySelector(".rho-mode-switch")).not.toBeNull();
    expect(bar.querySelector("[aria-label='Customize toolbar']")).not.toBeNull();
    expect(bar.querySelectorAll("[data-toolbar-component]")).toHaveLength(0);
    expect(container.querySelector(".rho-statusbar")).not.toBeNull();
    expect(container.querySelector(".rho-statusbar")?.textContent).not.toContain("No tasks running");

    await act(async () => {
      bar.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
    const customizer = bar.querySelector<HTMLElement>(".rho-toolbar-customizer")!;
    expect(customizer.textContent).toContain("Rho menu");
    expect(customizer.textContent).toContain("Studio / Vibe");
    expect(customizer.textContent).toContain("Project context");
    expect(customizer.textContent).toContain("Scene selector");
    expect(customizer.textContent).toContain("Command search");
    expect(customizer.textContent).toContain("Project action");
    expect(customizer.textContent).toContain("Runtime status");
    expect(customizer.textContent).toContain("Compose");
    await act(async () => {
      pointer(document.body, "pointerdown", 500, 500);
      await settle();
    });
    expect(bar.querySelector(".rho-toolbar-customizer")).toBeNull();
    await act(async () => {
      bar.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(bar.querySelector(".rho-toolbar-customizer")).toBeNull();
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
    expect(container.querySelector("[data-surface-id='rho.settings']")?.textContent).toContain("Model routing");

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
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-surface-id='rho.settings'] [aria-label^='Remove surface-instance:']")!.click();
      await settle();
    });
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
      await settle();
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
      await settle();
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
    expect(menu.querySelector("[role='alert']")?.textContent).toContain("Stop the active run");
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

  it("projects restored, fatal, and thrown switch failures without admitting their targets", async () => {
    const projectA = "/projects/project-a";
    const projectB = "/projects/project-b";
    saveProjectHistory(window.localStorage, { version: 1, paths: [projectA, projectB] });
    const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(projectA)}`);
    const failures = vi.fn()
      .mockResolvedValueOnce({
        status: "failed_restored",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: "project_switch_watcher_failed",
        message: "Target watcher failed.",
        restored_root: projectA,
        restart_required: false,
      })
      .mockResolvedValueOnce({
        status: "fatal",
        project: null,
        session: {},
        unavailable: null,
        blocker: null,
        reason_code: "project_switch_restore_failed",
        message: "Previous project could not be restored.",
        restored_root: null,
        restart_required: true,
      })
      .mockRejectedValueOnce(new Error("Project validation rejected this directory."));
    transport.openProject = failures;
    const { container } = await renderApp(transport);
    const menu = await openRhoMenu(container);
    const target = menu.querySelector<HTMLButtonElement>(`[data-project-path='${projectB}']`)!;

    await act(async () => { target.click(); await settle(); });
    expect(menu.querySelector("[role='alert']")?.textContent).toContain("Rho restored project-a");
    expect(container.querySelector(".rho-statusbar")?.textContent).toContain(projectA);
    await act(async () => { target.click(); await settle(); });
    expect(menu.querySelector("[role='alert']")?.textContent).toContain("recovery did not complete");
    await act(async () => { target.click(); await settle(); });
    expect(menu.querySelector("[role='alert']")?.textContent).toContain("Project validation rejected");
    expect(loadProjectHistory(window.localStorage).history.paths).toEqual([projectA, projectB]);

    const summary = menu.querySelector<HTMLElement>("summary")!;
    target.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await settle();
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("shows, hides, and persists an optional toolbar component", async () => {
    const transport = createMockUiKernelTransport();
    const projectId = (await transport.loadUiProfile()).profile.project_id;
    const { container } = await renderApp(transport);
    await showToolbarComponent(container, "Compose");
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    expect(loadToolbarLayout(window.localStorage, projectId).layout.visible).toEqual(["compose"]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
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
          "runtime_status",
          "project_action",
          "command_search",
          "scene_selector",
          "project_context",
        ],
      },
      "compose",
      true,
    );
    saveToolbarLayout(window.localStorage, projectId, configured);
    const { container } = await renderApp(transport);
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
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
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
    persist.mockClear();
    const projectRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='project_context']")!;
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
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Customize toolbar']")!.click();
      await settle();
    });
    const projectRow = container.querySelector<HTMLElement>("[data-toolbar-option-id='project_context']")!;
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
    const transport = createMockUiKernelTransport();
    const first = await transport.loadUiProfile();
    const firstLayout = setToolbarComponentVisible(defaultToolbarLayout(), "compose", true);
    saveToolbarLayout(window.localStorage, first.profile.project_id, firstLayout);
    const secondPath = "/tmp/toolbar-other";
    const secondProjectId = `project:mock:${encodeURIComponent(secondPath)}`;
    const secondLayout = setToolbarComponentVisible(defaultToolbarLayout(), "runtime_status", true);
    saveToolbarLayout(window.localStorage, secondProjectId, secondLayout);
    const { container } = await renderApp(transport);
    expect(container.querySelector("[data-toolbar-component='compose']")).not.toBeNull();
    await act(async () => {
      await transport.openProject(secondPath);
      await settle();
      await settle();
    });
    expect(container.querySelector("[data-toolbar-component='compose']")).toBeNull();
    expect(container.querySelector("[data-toolbar-component='runtime_status']")).not.toBeNull();
  });

  it("renders a recursive asymmetric scene while Agent degradation stays isolated", async () => {
    const { container } = await renderApp(
      createMockUiKernelTransport("?project=%2Ftmp%2FRho%20Lab"),
    );
    expect(container.textContent).toContain("Rho Lab");
    expect(container.textContent).toContain("Workspace R ready");
    expect(container.textContent).toContain("Agent runtime needs attention");
    expect(container.textContent).toContain("Source editor");
    expect(container.textContent).toContain("Navigator");
    await openInspector(container);
    expect(container.textContent).toContain("2 tabs");
    expect(container.querySelectorAll(".dv-split-view-container")).toHaveLength(4);
    expect(container.querySelectorAll(".dv-sash[role='separator']")).toHaveLength(3);
    expect(container.querySelectorAll(".rho-inventory-item")).toHaveLength(5);
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
    expect(source.querySelector(".rho-surface-actions .rho-menu-popover-panel")).toBeNull();

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
        schema_version: 3,
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
      if (request.target.instance_id === "instance:console-a" && viewState?.schema_version === 3) {
        consolePersistCount += 1;
      }
      if (
        !heldConsolePersist && request.target.instance_id === "instance:console-a" &&
        viewState?.schema_version === 3 && consolePersistCount === 2
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

    await showToolbarComponent(container, "Scene selector");
    await act(async () => {
      container.querySelector<HTMLElement>(".rho-rail-popover summary")!.click();
      await settle();
    });
    const undo = [...container.querySelectorAll<HTMLButtonElement>(".rho-rail-popover button")]
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
    expect(navigator.textContent).toContain("Artifacts");
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
    expect(navigator.querySelector("[data-nav-file='analysis.R']")).not.toBeNull();
  });

  it("makes Navigator sections keyboard-operable and turns recent-output information into an action", async () => {
    const { container } = await renderApp(createMockUiKernelTransport());
    const navigator = container.querySelector<HTMLElement>("[data-surface-id='rho.navigator']")!;
    const tabs = [...navigator.querySelectorAll<HTMLButtonElement>("[role='tab']")];
    expect(tabs.map((tab) => [tab.textContent, tab.tabIndex, tab.getAttribute("aria-selected")]))
      .toEqual([
        ["Files", 0, "true"],
        ["History", -1, "false"],
        ["Artifacts", -1, "false"],
      ]);
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
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(navigator.querySelector("[role='tabpanel']")?.textContent).toContain("plots/qc.png");
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
    expect(document.activeElement).toBe(consoleView.querySelector("[aria-label='More actions for R Console']"));
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
      consoleView.querySelector<HTMLButtonElement>("[aria-label='Filter Console output']")!.click();
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
      consoleView.querySelector<HTMLButtonElement>("[aria-label='Filter Console output']")!.click();
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

  it("keeps model context capacity focused by default and saves a revision-bound user declaration", async () => {
    const transport = createMockUiKernelTransport();
    const saveCapacity = vi.spyOn(transport, "setAgentContextCapacity");
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
        .find((button) => button.textContent === "Context")!.click();
      await settle();
    });
    const capacity = agent.querySelector<HTMLFormElement>(".rho-agent-capacity")!;
    expect(capacity.textContent).toContain("conservative default");
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      const context = capacity.querySelector<HTMLInputElement>("[aria-label='Context window tokens']")!;
      const reserve = capacity.querySelector<HTMLInputElement>("[aria-label='Reserved output tokens']")!;
      setInput.call(context, "131072");
      context.dispatchEvent(new Event("input", { bubbles: true }));
      setInput.call(reserve, "8192");
      reserve.dispatchEvent(new Event("input", { bubbles: true }));
      capacity.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
      await settle();
    });
    expect(saveCapacity).toHaveBeenCalledWith({
      model_id: "mock-profile",
      expected_revision: 1,
      context_window_tokens: 131_072,
      reserved_output_tokens: 8_192,
    });
    expect(capacity.textContent).toContain("user declared");

    const composer = agent.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer, "Review the context budget");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      [...agent.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Review context")!.click();
      await settle();
    });
    expect(agent.querySelector(".rho-agent-context-preview")?.textContent).toContain("122,880 tokens");
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

  it("opens one exact referenced artifact in Studio and restores the in-session Vibe focus", async () => {
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

    const setMode = transport.setUiProfileMode.bind(transport);
    let markStudioModeRequested = () => {};
    const studioModeRequested = new Promise<void>((resolve) => {
      markStudioModeRequested = resolve;
    });
    let releaseStudioMode = () => {};
    const studioModeBlocked = new Promise<void>((resolve) => {
      releaseStudioMode = resolve;
    });
    let interceptedStudioMode = false;
    transport.setUiProfileMode = vi.fn(async (request) => {
      if (request.mode === "studio" && !interceptedStudioMode) {
        interceptedStudioMode = true;
        markStudioModeRequested();
        await studioModeBlocked;
      }
      return setMode(request);
    });

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-vibe-verification button")]
        .find((button) => button.textContent === "在 Studio 中查看")!
        .click();
      await studioModeRequested;
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("focus-verification");
    expect(container.querySelector<HTMLElement>("[data-block-id='block:artifact-review']")?.dataset.vibeActive)
      .toBe("true");

    await act(async () => {
      releaseStudioMode();
      for (let index = 0; index < 32; index += 1) await Promise.resolve();
    });
    expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
      surface_id: "rho.artifacts",
      mode_id: "list",
      view_state: { selected_id: "artifact:plot-1", filter: "" },
    }));
    expect(container.querySelector(".rho-canvas-studio")).not.toBeNull();
    expect(container.querySelector("[data-surface-id='rho.artifacts'] [data-domain-id='artifact:plot-1']"))
      .not.toBeNull();

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".rho-mode-switch button")]
        .find((button) => button.textContent === "Vibe")!
        .click();
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
    });
    expect(container.querySelector(".rho-vibe-workspace")).not.toBeNull();
    expect(container.querySelector<HTMLElement>("[data-block-id='block:artifact-review']")?.dataset.vibeActive)
      .toBe("true");
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout"))
      .toBe("focus-verification");

    const pageBProfile = structuredClone(await transport.loadUiProfile());
    const restoredPage = pageBProfile.profile.vibe_pages.find(
      (candidate) => candidate.page_id === "page:project-review",
    )!;
    const secondPage = {
      ...structuredClone(restoredPage),
      page_id: "page:second-review",
      label: "Second review",
      page_revision: 1,
      sections: [],
      focused_block_id: null,
    };
    (pageBProfile.profile as { revision: number }).revision += 1;
    (pageBProfile.profile as { active_vibe_page_id: string | null }).active_vibe_page_id = secondPage.page_id;
    (pageBProfile.profile as { vibe_pages: typeof pageBProfile.profile.vibe_pages }).vibe_pages = [
      ...pageBProfile.profile.vibe_pages,
      secondPage,
    ];
    await act(async () => {
      transport.publishUiProfile(pageBProfile);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout")).toBe("overview");

    const pageAProfile = structuredClone(await transport.loadUiProfile());
    (pageAProfile.profile as { revision: number }).revision += 1;
    (pageAProfile.profile as { active_vibe_page_id: string | null }).active_vibe_page_id = restoredPage.page_id;
    await act(async () => {
      transport.publishUiProfile(pageAProfile);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-workspace")?.getAttribute("data-layout")).toBe("overview");
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
      await settle();
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
          content: { kind: "artifact_ref"; artifact_id: string; label: string };
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
          kind: "artifact_ref",
          artifact_id: "artifact:plot-1",
          label: "Current QC candidate",
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
      kind: "artifact_ref",
      artifact_id: "artifact:replacement",
      label: "Replacement candidate",
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
    await showToolbarComponent(container, "Project action");
    const check = container.querySelector<HTMLButtonElement>(".rho-command-projection button");
    expect(check?.getAttribute("aria-label")).toBe("Check project");
    await act(async () => {
      check!.click();
      await settle();
      await settle();
    });
    expect(container.querySelectorAll(".rho-check-result")).toHaveLength(1);
    expect(container.querySelector(".rho-check-outcome")?.textContent).toContain("2 findings to review");
    expect(container.querySelector(".rho-check-result-meta summary")?.textContent).toBe("Result details");
    expect(container.querySelector(".rho-check-rule-meta summary")?.textContent).toBe("Rule details");
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
    await showToolbarComponent(container, "Project action");
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
    await openInspector(container);
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
      expect(agent.textContent).toContain("Mock ask response");
    }
  });

  it("keeps completed Agent metadata quiet and reveals Act-only approval deliberately", async () => {
    const { container } = await renderApp();
    const agent = container.querySelector<HTMLElement>("[data-surface-id='rho.agent']")!;
    const completed = agent.querySelector<HTMLElement>(".rho-agent-turn-completed")!;
    expect(completed.querySelector(":scope > header > code")).toBeNull();
    expect(completed.querySelector(":scope > header > .rho-agent-turn-status")).toBeNull();
    expect(completed.querySelector(".rho-agent-turn-meta summary")?.textContent).toBe("Details");
    expect(agent.querySelector(".rho-agent-auto-approve")).toBeNull();
    expect(agent.querySelector(".rho-agent-mode-hint")?.textContent).toBe("Ask about this project");

    const actButton = [...agent.querySelectorAll<HTMLButtonElement>(".rho-agent-mode button")]
      .find((button) => button.textContent === "act")!;
    await act(async () => {
      actButton.click();
      await settle();
    });
    expect(agent.querySelector(".rho-agent-auto-approve")?.textContent)
      .toContain("Auto-approve project tools for this conversation");
    expect(agent.querySelector(".rho-agent-mode-hint")?.textContent).toBe("Work with project tools");

    const askButton = [...agent.querySelectorAll<HTMLButtonElement>(".rho-agent-mode button")]
      .find((button) => button.textContent === "ask")!;
    await act(async () => {
      askButton.click();
      await settle();
    });
    expect(agent.querySelector(".rho-agent-auto-approve")).toBeNull();
  });

  it("presents Environment inventory semantically with on-demand search and no raw payload", async () => {
    const transport = createMockUiKernelTransport();
    const persist = vi.spyOn(transport, "updateSurface");
    const loadDomainSurface = transport.loadDomainSurface.bind(transport);
    vi.spyOn(transport, "loadDomainSurface").mockImplementation(async (surfaceId) => {
      if (surfaceId !== "rho.environment") return loadDomainSurface(surfaceId);
      return {
        surface_id: surfaceId,
        loaded_at: "2026-08-22T12:00:00Z",
        summary: "raw generic summary",
        items: [
          { id: "package:rho", title: "rho", subtitle: "0.4.1-dev.14", status: "installed", detail: "Project library" },
          { id: "package:aisdk", title: "aisdk", subtitle: "required >= 1.5.0", status: "incompatible", detail: "{\"installed_version\":\"1.4.12\",\"required_version\":\"1.5.0\",\"resolved_path\":\"/private/library\"}" },
          { id: "environment-request:1", title: "Restore project library", subtitle: null, status: "running", detail: "{\"operation\":\"restore\",\"request_id\":\"internal-id\"}" },
        ],
      };
    });
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.environment']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const environment = container.querySelector<HTMLElement>("[data-surface-id='rho.environment']")!;
    expect(environment.querySelector(".rho-environment-toolbar")?.textContent)
      .toContain("1 package needs attention");
    expect(environment.querySelectorAll(".rho-environment-record")).toHaveLength(2);
    expect(environment.textContent).toContain("Installed: 1.4.12 · Required: 1.5.0");
    expect(environment.textContent).not.toContain("resolved_path");
    expect(environment.textContent).not.toContain("/private/library");
    expect(environment.querySelector("[aria-label='Filter environment']")).toBeNull();

    await act(async () => {
      environment.querySelector<HTMLButtonElement>("[aria-label='Search environment']")!.click();
      await settle();
    });
    const input = environment.querySelector<HTMLInputElement>("[aria-label='Filter environment']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "aisdk");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(environment.querySelectorAll(".rho-environment-record")).toHaveLength(1);
    expect(environment.querySelector(".rho-environment-record")?.textContent).toContain("aisdk");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await settle();
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      mutation: { kind: "set_view_state", view_state: { filter: "aisdk" } },
    }));
  });

  it("keeps Environment operation requests in their own mode", async () => {
    const transport = createMockUiKernelTransport();
    const surfaces = structuredClone(await transport.loadSurfaces());
    const environment = surfaces.catalog.instances.find((instance) => instance.surface_id === "rho.environment")!;
    (environment as { mode_id: string | null }).mode_id = "requests";
    transport.publishSurfaces(surfaces);
    const studio = structuredClone(await transport.loadStudio());
    const activate = (node: LayoutNode): boolean => {
      if (node.kind === "stack" && node.instances.includes(environment.instance_id)) {
        (node as { active_instance_id: string }).active_instance_id = environment.instance_id;
        return true;
      }
      return node.kind === "container" && node.children.some((child) => activate(child.child));
    };
    expect(activate(studio.scene.root)).toBe(true);
    transport.publishStudio(studio);
    const loadDomainSurface = transport.loadDomainSurface.bind(transport);
    vi.spyOn(transport, "loadDomainSurface").mockImplementation(async (surfaceId) => surfaceId === "rho.environment" ? {
      surface_id: surfaceId,
      loaded_at: "2026-08-22T12:00:00Z",
      summary: "2 records",
      items: [
        { id: "package:rho", title: "rho", subtitle: "0.4.1", status: "installed", detail: "Project library" },
        { id: "environment-request:restore", title: "Restore project library", subtitle: "requested now", status: "running", detail: "{\"operation\":\"restore\",\"project_root\":\"/private/project\"}" },
      ],
    } : loadDomainSurface(surfaceId));
    const { container } = await renderApp(transport);
    const surface = container.querySelector<HTMLElement>("[data-surface-id='rho.environment']")!;
    expect(surface.querySelector(".rho-environment-toolbar")?.textContent).toContain("1 active operation");
    expect(surface.querySelectorAll(".rho-environment-record")).toHaveLength(1);
    expect(surface.textContent).toContain("Restore project library");
    expect(surface.textContent).not.toContain("rho0.4.1");
    expect(surface.textContent).not.toContain("/private/project");
  });

  it("exposes component views as actions and switches Environment with the latest Surface revision", async () => {
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
    const packages = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Packages"));
    const requests = [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Requests"));
    expect(packages?.getAttribute("aria-pressed")).toBe("true");
    expect(requests?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      requests!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ instance_id: environment.dataset.instanceId }),
      mutation: { kind: "set_mode", mode_id: "requests" },
    }));
    expect(environment.querySelector(".rho-environment-toolbar")?.textContent)
      .toMatch(/operation|request/iu);
  });

  it("offers truthful Environment recovery after a load failure", async () => {
    const transport = createMockUiKernelTransport();
    const loadDomainSurface = transport.loadDomainSurface.bind(transport);
    let environmentAttempts = 0;
    vi.spyOn(transport, "loadDomainSurface").mockImplementation(async (surfaceId) => {
      if (surfaceId !== "rho.environment") return loadDomainSurface(surfaceId);
      environmentAttempts += 1;
      if (environmentAttempts === 1) throw new Error("Environment broker unavailable at /Users/alice/private-project");
      return loadDomainSurface(surfaceId);
    });
    const { container } = await renderApp(transport);
    await openInspector(container);
    await act(async () => {
      container.querySelector<HTMLElement>("[data-surface-factory='rho.environment']")!
        .querySelector<HTMLButtonElement>("button")!.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const environment = container.querySelector<HTMLElement>("[data-surface-id='rho.environment']")!;
    expect(environment.querySelector("[role='alert']")?.textContent).toContain("Environment broker unavailable");
    expect(environment.querySelector("[role='alert']")?.textContent).toContain("[local path]");
    expect(environment.querySelector("[role='alert']")?.textContent).not.toContain("/Users/alice");
    expect(environment.querySelector(".rho-task-state-error")).not.toBeNull();
    await act(async () => {
      [...environment.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Try again")!.click();
      await settle();
    });
    expect(environment.querySelector("[role='alert']")).toBeNull();
    expect(environment.querySelectorAll(".rho-environment-record")).toHaveLength(2);
  });

  it("creates intrinsic and full domain Surfaces from the shared factory catalog", async () => {
    const { container } = await renderApp();
    await openInspector(container);
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

  it("keeps normal components focused while separating project and developer components", async () => {
    const { container } = await renderApp(createMockUiKernelTransport("?plugin=surface"));
    await openInspector(container);

    const catalog = container.querySelector<HTMLElement>(".rho-surface-catalog")!;
    expect(container.querySelector(".rho-studio-inspector > header")?.textContent).toContain("Arrange workspace");
    expect(container.querySelector<HTMLDetailsElement>(".rho-compose-layout")?.open).toBe(false);
    expect([...container.querySelectorAll<HTMLDetailsElement>(".rho-compose-advanced")].every((section) => !section.open)).toBe(true);
    expect(catalog.querySelector(".rho-surface-catalog-heading")?.textContent).toContain("Components");
    expect(catalog.querySelector(".rho-surface-catalog-heading")?.textContent).not.toContain("factories");
    expect(catalog.querySelector(":scope > [data-surface-factory='rho.surface-playground']")).toBeNull();
    expect(catalog.querySelector("[data-surface-factory='ui.surface.differential-expression'] .rho-component-origin")?.textContent)
      .toBe("Project component");

    const developer = catalog.querySelector<HTMLDetailsElement>(".rho-developer-components")!;
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
        "rho.render-jobs": [{ id: "render:1", title: "analysis.qmd → HTML", subtitle: "analysis.qmd", status: "completed", detail: "{\"source_path\":\"analysis.qmd\",\"request_type\":\"render\",\"started_at\":\"2026-08-22T10:00:00Z\"}" }],
        "rho.artifacts": [{ id: "artifact:1", title: "plots/qc.png", subtitle: "image/png", status: "available", detail: "{\"artifact_kind\":\"plot\",\"media_type\":\"image/png\",\"source_path\":\"analysis.R\",\"project_root\":\"/private/project\"}" }],
        "rho.plots": [{ id: "plot:mock-1", title: "QC plot", subtitle: "image/png", status: "ready", detail: "{\"media_type\":\"image/png\",\"source_path\":\"analysis.R\",\"payload_json\":\"private-payload\"}" }],
        "rho.problems": [{ id: "problem:1", title: "object x not found", subtitle: "analysis.R", status: "error", detail: "{\"source_path\":\"analysis.R\",\"line_number\":7,\"workspace_id\":\"internal-workspace\"}" }],
        "rho.logs": [{ id: "log:1", title: "Startup diagnostics", subtitle: "now", status: "current", detail: "{\"detail\":\"Ark ready\\nWorkspace R ready\",\"project_root\":\"/private/project\"}" }],
        "rho.evidence": [{ id: "claim:1", title: "Analysis uses a fixed seed", subtitle: "analysis.R", status: null, detail: "{\"kind\":\"source_claim\",\"source_path\":\"analysis.R\",\"start_line\":1,\"source_excerpt\":\"set.seed(42)\",\"linked_evidence_ids\":[1],\"project_root\":\"/private/project\"}" }],
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
    const open = async (surfaceId: string) => {
      await act(async () => {
        container.querySelector<HTMLElement>(`[data-surface-factory='${surfaceId}']`)!
          .querySelector<HTMLButtonElement>("button")!.click();
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

    const artifacts = await open("rho.artifacts");
    expect(artifacts.querySelector("[data-domain-kind='outputs']")).not.toBeNull();
    expect(artifacts.querySelector(".rho-domain-output-preview")).toBeNull();
    expect(artifacts.textContent).toContain("Recorded artifacts and provenance");
    expect(artifacts.querySelector(".rho-domain-row-action")).toBeNull();
    const plots = await open("rho.plots");
    expect(plots.querySelector(".rho-domain-output-image")?.getAttribute("src"))
      .toMatch(/^data:image\/png;base64,/);
    expect(plots.textContent).not.toContain("private-payload");

    const problems = await open("rho.problems");
    expect(problems.querySelector(".rho-domain-strip[data-domain-kind='stream']")).not.toBeNull();
    expect(problems.textContent).toContain("object x not found");
    const logs = await open("rho.logs");
    expect(logs.querySelector(".rho-domain-disclosure summary")?.textContent).toBe("Open diagnostic text");

    const evidence = await open("rho.evidence");
    expect(evidence.querySelector("[data-domain-kind='claims']")?.textContent).toContain("set.seed(42)");
    expect(evidence.textContent).not.toContain("/private/project");
    const git = await open("rho.git");
    expect(git.querySelector("[data-domain-kind='git']")?.textContent).toContain("1 staged · 2 modified · 0 untracked");
    const renderJobs = await open("rho.render-jobs");
    expect(renderJobs.querySelector("[data-domain-kind='timeline']")?.textContent).toContain("Document output history");
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

    const previewItem = [...container.querySelectorAll<HTMLElement>(".rho-inventory-item")]
      .find((item) => item.textContent?.includes("rho.file-preview"))!;
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

  it("saves an active local draft in one action and recovers after draft rejection", async () => {
    const transport = createMockUiKernelTransport();
    const updateDraft = transport.updateResourceDraft.bind(transport);
    const update = vi.fn(async (request: Parameters<typeof transport.updateResourceDraft>[0]) => {
      if (update.mock.calls.length === 1) throw new Error("Draft revision rejected for test.");
      return updateDraft(request);
    });
    const save = vi.spyOn(transport, "saveResource");
    transport.updateResourceDraft = update;
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
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      expected_document_revision: 1,
      content: "saved_without_blur <- TRUE\n",
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ expected_document_revision: 2 });
    expect(source.querySelector<HTMLButtonElement>(".rho-file-save")!.disabled).toBe(true);
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
    expect(plugin?.querySelector(".rho-surface-title strong")?.textContent).toBe("Differential expression");
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
