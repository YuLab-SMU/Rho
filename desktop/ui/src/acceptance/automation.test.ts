import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecuteRequest,
  RuntimeOutputPage,
  WorkbenchProjection,
  WorkbenchStoreSnapshot,
} from "../transport";
import {
  ACCEPTANCE_EVAL_EVENT,
  AutomationRequestError,
  createAutomationSurface,
  installAcceptanceAutomation,
  parseAutomationRequest,
} from "./automation";
import type {
  AutomationActions,
  AutomationHost,
  AutomationStore,
} from "./automation";

const READY_PROJECTION = {
  kernel: {
    project: { project_id: "project-1", display_label: "Fixture", display_path: "/tmp/fixture" },
    context: {
      workspace_health: "ready",
      agent_health: "ready",
      active_operations: [],
    },
  },
  surfaces: {
    catalog: {
      instances: [
        {
          instance_id: "console-1",
          surface_id: "rho.console",
          mode_id: null,
          lifecycle_state: "active",
          surface_revision: 3,
          runtime_binding: {
            runtime_provider_id: "rho.r-session",
            runtime_instance_id: "runtime-1",
            activation_generation: 1,
          },
        },
        {
          instance_id: "files-1",
          surface_id: "rho.file-source",
          mode_id: "source",
          lifecycle_state: "active",
          surface_revision: 1,
          runtime_binding: null,
        },
      ],
    },
  },
  studio: {
    scene: { focused_surface_instance_id: "console-1" },
  },
  runtimes: {
    project_revision: 7,
    instances: [
      {
        project_id: "project-1",
        runtime_provider_id: "rho.r-session",
        runtime_instance_id: "runtime-1",
        runtime_kind: "r",
        activation_generation: 1,
        state_revision: 2,
        status: "ready",
        attach_capabilities: [],
        primary_scientific_runtime: true,
      },
    ],
  },
  resources: { resources: [] },
  profile: {
    profile: { project_id: "project-1", active_mode: "studio", revision: 5 },
  },
} as unknown as WorkbenchProjection;

function execution(status: string): RuntimeExecution {
  return {
    execution_id: "exec-1",
    status,
    output_state: "complete",
  } as unknown as RuntimeExecution;
}

interface FakeStore extends AutomationStore {
  publish(state: WorkbenchStoreSnapshot): void;
  startExecution: Mock<(request: RuntimeExecuteRequest) => Promise<RuntimeExecutionStartResponse>>;
  getExecution: Mock<(executionId: string) => Promise<RuntimeExecution>>;
  listExecutions: Mock<(limit?: number) => Promise<readonly RuntimeExecution[]>>;
  outputPage: Mock<(executionId: string, afterSequence?: number) => Promise<RuntimeOutputPage>>;
}

function createFakeStore(initial: WorkbenchStoreSnapshot): FakeStore {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    publish(next) {
      state = next;
      for (const listener of listeners) listener();
    },
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: vi.fn(async () => undefined),
    startExecution: vi.fn<(request: RuntimeExecuteRequest) => Promise<RuntimeExecutionStartResponse>>(
      async () => ({
        execution: execution("admitted"),
        committed_through: 0,
      }),
    ),
    getExecution: vi.fn<(executionId: string) => Promise<RuntimeExecution>>(
      async () => execution("completed"),
    ),
    listExecutions: vi.fn<(limit?: number) => Promise<readonly RuntimeExecution[]>>(
      async () => [],
    ),
    outputPage: vi.fn<(executionId: string, afterSequence?: number) => Promise<RuntimeOutputPage>>(
      async () => ({
        chunks: [{
          presentation_kind: "stdout",
          storage_kind: "inline",
          text_payload: "[1] 42",
        }],
      }) as unknown as RuntimeOutputPage,
    ),
    refresh: vi.fn(async () => undefined),
  };
}

function createActions(): AutomationActions & {
  openProject: Mock<(path: string) => Promise<void>>;
  openSurface: Mock<(surfaceId: string) => Promise<void>>;
  focusInstance: Mock<(instanceId: string) => Promise<void>>;
  closeInstance: Mock<(instanceId: string) => Promise<void>>;
  setMode: Mock<(mode: "studio" | "vibe") => Promise<void>>;
} {
  return {
    openProject: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    openSurface: vi.fn<(surfaceId: string) => Promise<void>>(async () => undefined),
    focusInstance: vi.fn<(instanceId: string) => Promise<void>>(async () => undefined),
    closeInstance: vi.fn<(instanceId: string) => Promise<void>>(async () => undefined),
    setMode: vi.fn<(mode: "studio" | "vibe") => Promise<void>>(async () => undefined),
  };
}

function createHost(overrides: Partial<AutomationHost> = {}): AutomationHost {
  return {
    store: createFakeStore({ status: "loading" }),
    actions: createActions(),
    getEvidence: () => ({ ready: false }),
    ...overrides,
  };
}

const readyState: WorkbenchStoreSnapshot = {
  status: "ready",
  source: "tauri",
  snapshot: READY_PROJECTION,
};

function createReadyHost(evidence: Record<string, unknown> = { ready: true }): AutomationHost & {
  readonly store: FakeStore;
  readonly actions: ReturnType<typeof createActions>;
} {
  const store = createFakeStore(readyState);
  const actions = createActions();
  return { store, actions, getEvidence: () => evidence };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("acceptance automation", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete window.__rhoAutomation;
    vi.restoreAllMocks();
  });

  describe("parseAutomationRequest", () => {
    it("parses requests from objects and JSON strings", () => {
      expect(parseAutomationRequest({ command: "ready" })).toEqual({ command: "ready" });
      expect(parseAutomationRequest("{\"command\":\"snapshot\"}")).toEqual({ command: "snapshot" });
      expect(parseAutomationRequest({
        command: "query",
        selector: ".x",
        all: true,
        attribute: "data-id",
      })).toEqual({ command: "query", selector: ".x", all: true, attribute: "data-id" });
    });

    it("parses every act kind", () => {
      const cases: readonly unknown[] = [
        { kind: "open_project", path: "/tmp/p" },
        { kind: "console_submit", code: "1+1", timeout_ms: 500 },
        { kind: "open_surface", surface_id: "rho.console" },
        { kind: "focus_instance", instance_id: "i-1" },
        { kind: "close_instance", instance_id: "i-1" },
        { kind: "set_mode", mode: "vibe" },
        { kind: "click", selector: "#a" },
        { kind: "type", selector: "#a", text: "hi" },
        { kind: "key", key: "Enter" },
        { kind: "wait", until: { kernel_idle: true }, timeout_ms: 100 },
      ];
      for (const action of cases) {
        const parsed = parseAutomationRequest({ command: "act", action });
        expect(parsed.command).toBe("act");
      }
    });

    it("rejects malformed requests with AutomationRequestError", () => {
      expect(() => parseAutomationRequest("not json")).toThrow(AutomationRequestError);
      expect(() => parseAutomationRequest(null)).toThrow(AutomationRequestError);
      expect(() => parseAutomationRequest({ command: "eval" })).toThrow(AutomationRequestError);
      expect(() => parseAutomationRequest({ command: "query" })).toThrow(AutomationRequestError);
      expect(() => parseAutomationRequest({ command: "act", action: { kind: "set_mode", mode: "zen" } }))
        .toThrow(AutomationRequestError);
      expect(() => parseAutomationRequest({ command: "act", action: { kind: "wait", until: {} } }))
        .toThrow(AutomationRequestError);
    });

    it("rejects unknown act kinds", () => {
      expect(() => parseAutomationRequest({ command: "act", action: { kind: "rm_rf" } }))
        .toThrow(/Unknown act kind/);
    });

    it("keeps caller-provided action timeouts below the bridge timeout", () => {
      expect(parseAutomationRequest({
        command: "act",
        action: { kind: "console_submit", code: "1+1", timeout_ms: 240_000 },
      })).toEqual({
        command: "act",
        action: { kind: "console_submit", code: "1+1", timeout_ms: 240_000 },
      });
      for (const action of [
        { kind: "console_submit", code: "1+1", timeout_ms: 240_001 },
        { kind: "console_submit", code: "1+1", timeout_ms: 0 },
        { kind: "wait", until: { kernel_idle: true }, timeout_ms: Number.POSITIVE_INFINITY },
        { kind: "wait", until: { kernel_idle: true }, timeout_ms: 1.5 },
        { kind: "wait", until: { kernel_idle: true }, timeout_ms: null },
      ]) {
        expect(() => parseAutomationRequest({ command: "act", action }))
          .toThrow(/timeout_ms must be an integer between 1 and 240000ms/);
      }
    });
  });

  describe("ready and snapshot", () => {
    it("reports the ready shape from the projection and evidence", () => {
      const surface = createAutomationSurface(createReadyHost());
      const value = surface.ready();
      expect(value.rsrReady).toBe(true);
      expect(value.kernelStatus).toBe("ready");
      expect(value.projectPath).toBe("/tmp/fixture");
      expect(value.activeMode).toBe("studio");
      expect(value.editorReady).toBe(false);
      expect(value.evidence).toEqual({ ready: true });
    });

    it("detects a ready editor", () => {
      const editor = document.createElement("div");
      editor.setAttribute("data-editor-ready", "true");
      document.body.append(editor);
      const surface = createAutomationSurface(createReadyHost());
      expect(surface.ready().editorReady).toBe(true);
    });

    it("reports nulls while the store is loading", () => {
      const surface = createAutomationSurface(createHost());
      const value = surface.ready();
      expect(value.rsrReady).toBe(false);
      expect(value.kernelStatus).toBeNull();
      expect(value.projectPath).toBeNull();
      expect(value.activeMode).toBeNull();
    });

    it("reports the bounded snapshot shape", () => {
      document.body.textContent = "Workbench body";
      const surface = createAutomationSurface(createReadyHost());
      const value = surface.snapshot();
      expect(value.kernel).toMatchObject({ project_id: "project-1", workspace_health: "ready" });
      expect(value.surfaces).toEqual([
        {
          instance_id: "console-1",
          surface_id: "rho.console",
          mode_id: null,
          lifecycle_state: "active",
        },
        {
          instance_id: "files-1",
          surface_id: "rho.file-source",
          mode_id: "source",
          lifecycle_state: "active",
        },
      ]);
      expect(value.focusedInstance).toBe("console-1");
      expect(value.runtimes).toEqual([{ runtime_instance_id: "runtime-1", status: "ready" }]);
      expect(value.profile).toEqual({ active_mode: "studio", revision: 5 });
      expect(value.project).toEqual({ project_id: "project-1", display_path: "/tmp/fixture" });
      expect(value.visibleText).toBe("Workbench body");
      expect(value.counts).toMatchObject({ surfaces: 2, runtimes: 1, resources: 0 });
    });

    it("bounds visibleText to 8000 characters", () => {
      document.body.textContent = "x".repeat(20_000);
      const surface = createAutomationSurface(createReadyHost());
      expect(surface.snapshot().visibleText.length).toBeLessThanOrEqual(8_000);
    });
  });

  describe("query", () => {
    it("returns the first match by default and bounds all matches to 50", async () => {
      for (let index = 0; index < 60; index += 1) {
        const item = document.createElement("span");
        item.className = "q-item";
        item.textContent = `item ${index}`;
        document.body.append(item);
      }
      const host = createReadyHost();
      const surface = createAutomationSurface(host);
      const single = await surface.request({ command: "query", selector: ".q-item" }) as unknown[];
      expect(single).toHaveLength(1);
      const all = await surface.request({
        command: "query",
        selector: ".q-item",
        all: true,
      }) as unknown[];
      expect(all).toHaveLength(50);
    });

    it("truncates item text to 500 characters and reads attributes", async () => {
      const item = document.createElement("div");
      item.className = "q-long";
      item.textContent = "y".repeat(600);
      item.setAttribute("data-state", "done");
      document.body.append(item);
      const surface = createAutomationSurface(createReadyHost());
      const [first] = await surface.request({
        command: "query",
        selector: ".q-long",
        attribute: "data-state",
      }) as readonly { text: string; value: string | null }[];
      expect(first!.text).toHaveLength(500);
      expect(first!.value).toBe("done");
    });
  });

  describe("act", () => {
    it("rejects unknown act kinds through request", async () => {
      const surface = createAutomationSurface(createReadyHost());
      await expect(surface.request({ command: "act", action: { kind: "explode" } }))
        .rejects.toThrow(/Unknown act kind/);
    });

    it("delegates open_surface, focus_instance, close_instance, and set_mode to host actions", async () => {
      const host = createReadyHost();
      const surface = createAutomationSurface(host);
      await surface.request({ command: "act", action: { kind: "open_surface", surface_id: "rho.plots" } });
      await surface.request({ command: "act", action: { kind: "focus_instance", instance_id: "files-1" } });
      await surface.request({ command: "act", action: { kind: "close_instance", instance_id: "files-1" } });
      await surface.request({ command: "act", action: { kind: "set_mode", mode: "vibe" } });
      expect(host.actions.openSurface).toHaveBeenCalledWith("rho.plots");
      expect(host.actions.focusInstance).toHaveBeenCalledWith("files-1");
      expect(host.actions.closeInstance).toHaveBeenCalledWith("files-1");
      expect(host.actions.setMode).toHaveBeenCalledWith("vibe");
    });

    it("opens a project and waits for readiness", async () => {
      const host = createReadyHost();
      const surface = createAutomationSurface(host);
      const value = await surface.request({
        command: "act",
        action: { kind: "open_project", path: "/tmp/next" },
      });
      expect(host.actions.openProject).toHaveBeenCalledWith("/tmp/next");
      expect(value).toEqual({ project: "/tmp/next" });
    });

    it("submits console code and resolves with the terminal status and preview", async () => {
      const host = createReadyHost();
      host.store.getExecution
        .mockResolvedValueOnce(execution("admitted"))
        .mockResolvedValueOnce(execution("running"))
        .mockResolvedValue(execution("completed"));
      const surface = createAutomationSurface(host);
      const value = await surface.request({
        command: "act",
        action: { kind: "console_submit", code: "40 + 2" },
      }) as { status: string; preview: string; execution_id: string };
      expect(host.store.startExecution).toHaveBeenCalledWith(expect.objectContaining({
        console_instance_id: "console-1",
        expected_console_revision: 3,
        code: "40 + 2",
        runtime: expect.objectContaining({
          runtime_instance_id: "runtime-1",
          expected_project_revision: 7,
          expected_state_revision: 2,
        }),
      }));
      expect(value).toEqual({ status: "completed", preview: "[1] 42", execution_id: "exec-1" });
    });

    it("rejects console_submit when no console is open", async () => {
      const store = createFakeStore({
        status: "ready",
        source: "tauri",
        snapshot: {
          ...READY_PROJECTION,
          surfaces: { catalog: { instances: [] } },
        } as unknown as WorkbenchProjection,
      });
      const surface = createAutomationSurface(createHost({ store }));
      await expect(surface.request({
        command: "act",
        action: { kind: "console_submit", code: "1" },
      })).rejects.toThrow(/No Console/);
    });

    it("waits for a selector to appear", async () => {
      const surface = createAutomationSurface(createReadyHost());
      setTimeout(() => {
        const marker = document.createElement("div");
        marker.id = "late-marker";
        document.body.append(marker);
      }, 30);
      const value = await surface.request({
        command: "act",
        action: { kind: "wait", until: { selector: "#late-marker" }, timeout_ms: 2_000 },
      });
      expect(value).toEqual({ satisfied: true });
    });

    it("times out when wait conditions never hold", async () => {
      const surface = createAutomationSurface(createReadyHost());
      await expect(surface.request({
        command: "act",
        action: { kind: "wait", until: { selector: "#never" }, timeout_ms: 150 },
      })).rejects.toThrow(/not met within/);
    });

    it("waits for kernel idle via store subscription", async () => {
      const busyProjection = {
        ...READY_PROJECTION,
        kernel: {
          ...READY_PROJECTION.kernel,
          context: {
            ...READY_PROJECTION.kernel.context,
            active_operations: [{ operation_id: "op-1" }],
          },
        },
      } as unknown as WorkbenchProjection;
      const host = createReadyHost();
      host.store.publish({ status: "ready", source: "tauri", snapshot: busyProjection });
      const surface = createAutomationSurface(host);
      const pending = surface.request({
        command: "act",
        action: { kind: "wait", until: { kernel_idle: true }, timeout_ms: 2_000 },
      });
      await flush();
      host.store.publish(readyState);
      await expect(pending).resolves.toEqual({ satisfied: true });
    });

    it("waits for no active executions", async () => {
      const host = createReadyHost();
      host.store.listExecutions.mockResolvedValue([execution("running")]);
      const surface = createAutomationSurface(host);
      const pending = surface.request({
        command: "act",
        action: { kind: "wait", until: { no_active_executions: true }, timeout_ms: 2_000 },
      });
      await flush();
      host.store.listExecutions.mockResolvedValue([execution("completed")]);
      await expect(pending).resolves.toEqual({ satisfied: true });
    });

    it("clicks, types, and presses keys through DOM events", async () => {
      const host = createReadyHost();
      const surface = createAutomationSurface(host);
      const button = document.createElement("button");
      button.id = "act-click";
      document.body.append(button);
      const onClick = vi.fn();
      button.addEventListener("click", onClick);
      await surface.request({ command: "act", action: { kind: "click", selector: "#act-click" } });
      expect(onClick).toHaveBeenCalledTimes(1);

      const input = document.createElement("input");
      input.id = "act-type";
      document.body.append(input);
      const onInput = vi.fn();
      input.addEventListener("input", onInput);
      await surface.request({
        command: "act",
        action: { kind: "type", selector: "#act-type", text: "hello" },
      });
      expect(input.value).toBe("hello");
      expect(onInput).toHaveBeenCalledTimes(1);

      const onKey = vi.fn();
      document.body.addEventListener("keydown", onKey);
      await surface.request({ command: "act", action: { kind: "key", key: "Enter" } });
      expect(onKey).toHaveBeenCalledTimes(1);
      document.body.removeEventListener("keydown", onKey);
    });

    it("rejects click and type for missing targets", async () => {
      const surface = createAutomationSurface(createReadyHost());
      await expect(surface.request({
        command: "act",
        action: { kind: "click", selector: "#missing" },
      })).rejects.toThrow(/No element matches/);
      const div = document.createElement("div");
      div.id = "not-input";
      document.body.append(div);
      await expect(surface.request({
        command: "act",
        action: { kind: "type", selector: "#not-input", text: "x" },
      })).rejects.toThrow(/not an input or textarea/);
    });
  });

  describe("installAcceptanceAutomation", () => {
    function createBridge() {
      const handlers = new Map<string, (event: { payload: unknown }) => void>();
      const listen = vi.fn<(
        event: string,
        handler: (event: { payload: unknown }) => void,
      ) => Promise<() => void>>(async (event, handler) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      });
      const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<void>>(
        async () => undefined,
      );
      return { handlers, listen, invoke };
    }

    it("executes eval payloads and reports results through the bridge command", async () => {
      const bridge = createBridge();
      const uninstall = installAcceptanceAutomation({
        host: () => createReadyHost(),
        listen: bridge.listen,
        invoke: bridge.invoke,
      });
      await flush();
      expect(bridge.listen).toHaveBeenCalledWith(ACCEPTANCE_EVAL_EVENT, expect.any(Function));
      bridge.handlers.get(ACCEPTANCE_EVAL_EVENT)!({
        payload: { id: 7, js: JSON.stringify({ command: "ready" }) },
      });
      await flush();
      await flush();
      expect(bridge.invoke).toHaveBeenCalledWith("acceptance_bridge_result", expect.objectContaining({
        id: 7,
        ok: true,
        error: null,
      }));
      const result = bridge.invoke.mock.calls.at(-1)?.[1] as unknown as { value: { rsrReady: boolean } };
      expect(result.value.rsrReady).toBe(true);
      uninstall();
    });

    it("returns an error envelope for invalid requests", async () => {
      const bridge = createBridge();
      installAcceptanceAutomation({
        host: () => createReadyHost(),
        listen: bridge.listen,
        invoke: bridge.invoke,
      });
      await flush();
      bridge.handlers.get(ACCEPTANCE_EVAL_EVENT)!({ payload: { id: 9, js: "{broken" } });
      await flush();
      await flush();
      expect(bridge.invoke).toHaveBeenCalledWith("acceptance_bridge_result", expect.objectContaining({
        id: 9,
        ok: false,
        value: null,
      }));
      const result = bridge.invoke.mock.calls.at(-1)?.[1] as unknown as { error: string };
      expect(result.error).toMatch(/not valid JSON/);
    });

    it("exposes window.__rhoAutomation and removes it on uninstall", async () => {
      const bridge = createBridge();
      const uninstall = installAcceptanceAutomation({
        host: () => createReadyHost(),
        listen: bridge.listen,
        invoke: bridge.invoke,
      });
      expect(window.__rhoAutomation).toBeDefined();
      const ready = await window.__rhoAutomation!.request({ command: "ready" }) as { rsrReady: boolean };
      expect(ready.rsrReady).toBe(true);
      uninstall();
      expect(window.__rhoAutomation).toBeUndefined();
    });
  });
});
