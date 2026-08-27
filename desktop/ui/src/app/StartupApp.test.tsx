import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "../transport/mock";
import type {
  WorkspacePreparation,
  WorkspacePreparationProgressListener,
} from "../transport";
import { App } from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

const readyPreparation: WorkspacePreparation = {
  status: "ready",
  phase: "project_ready",
  workspace_ready: true,
  restored_project_status: "ready",
  issue: null,
};

const projectAttention: WorkspacePreparation = {
  status: "needs_attention",
  phase: "project_restore_incomplete",
  workspace_ready: true,
  restored_project_status: "unavailable",
  issue: {
    code: "PROJECT_RESTORE_INCOMPLETE",
    title: "The saved project could not be restored",
    message: "Choose another project.",
    technical_detail: "/missing/project",
  },
};

describe("startup application admission", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    delete document.documentElement.dataset.rsrReady;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(element: React.ReactNode) {
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
      root.render(element);
      await settle();
    });
    return { container, root };
  }

  function rowStates(container: HTMLElement) {
    return [...container.querySelectorAll<HTMLElement>(".rho-startup-step")]
      .map((row) => row.dataset.state);
  }

  it("starts the backend once in React StrictMode and waits for final ready after all progress", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    let progress: WorkspacePreparationProgressListener | undefined;
    const prepare = vi.fn((
      _chooseRscript?: boolean,
      onProgress?: WorkspacePreparationProgressListener,
    ) => {
      progress = onProgress;
      onProgress?.({ stage: "runtime", state: "active" });
      return final.promise;
    });
    transport.prepareWorkspace = prepare;
    const { container } = await render(
      <StrictMode><App transport={transport} /></StrictMode>,
    );

    expect(prepare).toHaveBeenCalledOnce();
    expect(rowStates(container)).toEqual(["active", "waiting", "waiting"]);
    await act(async () => {
      progress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      progress?.({ stage: "workspace", state: "active" });
      progress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
      progress?.({ stage: "project", state: "active" });
      progress?.({ stage: "project", state: "complete", project_root: "/project" });
      await settle();
    });
    expect(rowStates(container)).toEqual(["complete", "complete", "complete"]);
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      "Startup steps are complete. Confirming workspace readiness.",
    );
    expect(container.querySelector(".rho-startup-ledger")?.getAttribute("aria-busy"))
      .toBe("true");
    expect(container.querySelector(".rho-studio-shell")).toBeNull();

    await act(async () => {
      final.resolve(readyPreparation);
      await settle(24);
    });
    expect(container.querySelector(".rho-startup-ledger")).toBeNull();
    expect(container.querySelector(".rho-studio-shell")).not.toBeNull();
  });

  it("turns an all-complete observer gap into attention only when the final result says so", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    transport.prepareWorkspace = vi.fn((_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      onProgress?.({ stage: "workspace", state: "active" });
      onProgress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
      onProgress?.({ stage: "project", state: "active" });
      onProgress?.({ stage: "project", state: "complete", project_root: "/project" });
      return final.promise;
    });
    const { container } = await render(<App transport={transport} />);

    expect(rowStates(container)).toEqual(["complete", "complete", "complete"]);
    expect(container.querySelector(".rho-startup-ledger")?.getAttribute("aria-busy"))
      .toBe("true");
    expect(container.querySelector("[role='alert']")).toBeNull();

    await act(async () => {
      final.resolve(projectAttention);
      await settle();
    });
    expect(rowStates(container)).toEqual(["complete", "complete", "attention"]);
    expect(container.querySelector(".rho-startup-ledger")?.hasAttribute("aria-busy"))
      .toBe(false);
    expect(container.querySelector("[role='alert']")?.textContent)
      .toContain("The saved project could not be restored");
    expect(container.querySelector(".rho-studio-shell")).toBeNull();
  });

  it("offers Workspace failure Retry only and restarts truthfully at runtime once", async () => {
    const transport = createMockUiKernelTransport();
    const retry = deferred<WorkspacePreparation>();
    let attempt = 0;
    const prepare = vi.fn((
      _chooseRscript?: boolean,
      onProgress?: WorkspacePreparationProgressListener,
    ) => {
      attempt += 1;
      onProgress?.({ stage: "runtime", state: "active" });
      if (attempt === 1) {
        onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
        onProgress?.({ stage: "workspace", state: "active" });
        return Promise.resolve({
          status: "needs_attention",
          phase: "workspace_start_failed",
          workspace_ready: false,
          restored_project_status: null,
          issue: {
            code: "WORKSPACE_START_FAILED",
            title: "Workspace R could not start",
            message: "Retry startup.",
            technical_detail: "Workspace broker unavailable",
          },
        } as const);
      }
      return retry.promise;
    });
    transport.prepareWorkspace = prepare;
    const { container } = await render(<App transport={transport} />);

    const actions = [...container.querySelectorAll<HTMLButtonElement>(
      ".rho-startup-actions button",
    )];
    expect(actions.map((button) => button.textContent)).toEqual(["Retry"]);
    expect(actions[0]?.classList.contains("rho-primary-action")).toBe(true);
    expect(container.textContent).not.toContain("Choose Rscript");

    await act(async () => {
      actions[0]?.click();
      actions[0]?.click();
      await settle();
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]?.[0]).toBe(false);
    expect(rowStates(container)).toEqual(["active", "waiting", "waiting"]);
  });

  it("restores the new project chooser's focus after cancel and focuses a new picker failure", async () => {
    const transport = createMockUiKernelTransport();
    transport.prepareWorkspace = vi.fn(async (_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      onProgress?.({ stage: "workspace", state: "active" });
      onProgress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
      onProgress?.({ stage: "project", state: "active" });
      return projectAttention;
    });
    const cancel = deferred<ReturnType<typeof cancelledProjectResponse>>();
    const pick = vi.fn()
      .mockImplementationOnce(() => cancel.promise)
      .mockRejectedValueOnce(new Error("native picker failed"));
    transport.pickProjectDirectory = pick;
    const { container } = await render(<App transport={transport} />);

    const initialHeading = container.querySelector<HTMLHeadingElement>(
      ".rho-startup-attention h2",
    );
    expect(document.activeElement).toBe(initialHeading);
    const chooser = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Choose project")!;
    await act(async () => {
      chooser.click();
      chooser.click();
      await settle();
    });
    expect(pick).toHaveBeenCalledOnce();
    expect(rowStates(container)).toEqual(["complete", "complete", "active"]);

    await act(async () => {
      cancel.resolve(cancelledProjectResponse());
      await settle();
    });
    const restoredChooser = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Choose project")!;
    expect(document.activeElement).toBe(restoredChooser);

    await act(async () => {
      restoredChooser.click();
      await settle();
    });
    const failedHeading = container.querySelector<HTMLHeadingElement>(
      ".rho-startup-attention h2",
    );
    expect(failedHeading?.textContent).toBe("The project picker could not open the selected project");
    expect(document.activeElement).toBe(failedHeading);
    expect(container.textContent).toContain("native picker failed");
  });

  it("ignores stale completion after a transport replacement and after unmount", async () => {
    const firstTransport = createMockUiKernelTransport();
    const firstFinal = deferred<WorkspacePreparation>();
    firstTransport.prepareWorkspace = vi.fn((_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      return firstFinal.promise;
    });
    const secondTransport = createMockUiKernelTransport();
    const secondFinal = deferred<WorkspacePreparation>();
    secondTransport.prepareWorkspace = vi.fn((_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      return secondFinal.promise;
    });
    const { container, root } = await render(<App transport={firstTransport} />);

    await act(async () => {
      root.render(<App transport={secondTransport} />);
      await settle();
      firstFinal.resolve(readyPreparation);
      await settle();
    });
    expect(firstTransport.prepareWorkspace).toHaveBeenCalledOnce();
    expect(secondTransport.prepareWorkspace).toHaveBeenCalledOnce();
    expect(rowStates(container)).toEqual(["active", "waiting", "waiting"]);
    expect(container.querySelector(".rho-studio-shell")).toBeNull();

    await act(async () => {
      root.unmount();
      await settle();
      secondFinal.resolve(readyPreparation);
      await settle();
    });
    roots.splice(roots.indexOf(root), 1);
    expect(container.childElementCount).toBe(0);
  });
});

function cancelledProjectResponse() {
  return {
    status: "cancelled",
    project: null,
    session: {},
    unavailable: null,
    blocker: null,
    reason_code: null,
    message: null,
    restored_root: null,
    restart_required: false,
  } as const;
}
