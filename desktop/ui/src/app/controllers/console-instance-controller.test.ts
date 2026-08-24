import { describe, expect, it, vi } from "vitest";

import type { RuntimeDescriptor, RuntimeExecution, RuntimeExecutionStartResponse, RuntimeOutputChunk, SurfaceInstance } from "../../transport";
import type { ConsoleInstancePorts, ConsoleViewState } from "./console-instance-controller";
import {
  CONSOLE_VIEW_STATE_VERSION,
  MAX_CONSOLE_TRANSCRIPT_CACHE_BYTES,
  ConsoleInstanceController,
  consoleTranscriptOutputs,
  consolePersistentViewStateBytes,
  initialConsoleState,
  needsConsoleStateCompaction,
} from "./console-instance-controller";

const EMPTY_STATE: ConsoleViewState = {
  draft: "draft()",
  history: [],
  history_cursor: null,
  filter: "",
  scroll_top: 0,
  follow_tail: true,
  transcript_start_after: null,
  read_cursor: null,
  outputs: [],
  released_output_count: 0,
};

function surface(viewState: unknown): SurfaceInstance {
  return {
    instance_id: "console:a",
    surface_id: "rho.console",
    project_id: "project:a",
    origin: { kind: "application", component_id: "rho.desktop" },
    activation_generation: 1,
    surface_revision: 1,
    mode_id: null,
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: viewState,
    lifecycle_state: "active",
  };
}

function runtime(status: RuntimeDescriptor["status"] = "ready"): RuntimeDescriptor {
  return {
    runtime_provider_id: "rho.workspace-r",
    runtime_instance_id: "runtime:r",
    runtime_kind: "r",
    project_id: "project:a",
    activation_generation: 1,
    state_revision: 2,
    status,
    attach_capabilities: ["console.attach"],
    persistence_class: "project_persistent",
    display_label: "Workspace R",
    primary_scientific_runtime: true,
  };
}

function execution(code = "1 + 1", status: RuntimeExecution["status"] = "completed"): RuntimeExecution {
  return {
    execution_id: `execution:${code}`,
    project_root: "/project",
    run_id: `execution:${code}`,
    runtime_provider_id: "rho.workspace-r",
    runtime_instance_id: "runtime:r",
    runtime_activation_generation: 1,
    console_instance_id: "console:a",
    submitted_code: code,
    workspace_id: "workspace:a",
    source_path: null,
    execution_mode: "console",
    document_version: null,
    status,
    terminal_reason: null,
    output_state: status === "completed" ? "complete" : "collecting",
    last_sequence: 0,
    output_bytes: 0,
    started_at: "2026-08-24T00:00:00Z",
    finished_at: status === "completed" ? "2026-08-24T00:00:01Z" : null,
  };
}

function result(code = "1 + 1"): RuntimeExecutionStartResponse {
  return { execution: execution(code, "admitted"), committed_through: 0 };
}

function chunk(sequence: number, text: string): RuntimeOutputChunk {
  return {
    execution_id: "execution:gap()",
    project_root: "/project",
    sequence,
    producer_sequence: sequence,
    projection_slot: 0,
    source_kind: "workspace.value",
    presentation_kind: "value",
    media_type: "text/plain",
    storage_kind: "inline_text",
    text_payload: text,
    json_payload: null,
    reference_kind: null,
    reference_id: null,
    payload_bytes: text.length,
    payload_sha256: "a".repeat(64),
    created_at: "2026-08-24T00:00:00Z",
  };
}

function ports(overrides: Partial<ConsoleInstancePorts> = {}): ConsoleInstancePorts {
  return {
    runtime: runtime(),
    start: vi.fn(async (_runtime, code) => result(code)),
    follow: vi.fn(async (executionId, _after, listener) => listener({
      type: "terminal",
      project_id: "project:a",
      execution_id: executionId,
      committed_through: 0,
      execution: execution(executionId.replace("execution:", "")),
    })),
    list: vi.fn(async () => []),
    page: vi.fn(async () => { throw new Error("No recovery page expected"); }),
    pageBefore: vi.fn(async () => { throw new Error("No reverse recovery page expected"); }),
    persist: vi.fn(async () => undefined),
    reportError: vi.fn(),
    ...overrides,
  };
}

describe("Console instance controller", () => {
  it("rejects blank, unattached, busy, recovering and failed submissions truthfully", () => {
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({ runtime: null }));
    expect(controller.submit("  ", true)).toEqual({ accepted: false, message: "Code has no executable content." });
    expect(controller.submit("1", true).message).toContain("not attached");
    for (const status of ["busy", "starting", "restarting", "failed"] as const) {
      controller.configure(ports({ runtime: runtime(status) }));
      expect(controller.submit("1", true).accepted).toBe(false);
    }
  });

  it("admits one ready composer execution, clears its draft and persists the result", async () => {
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    const configured = ports();
    controller.configure(configured);
    expect(controller.submit("1 + 1", true)).toEqual({ accepted: true, message: null });
    expect(controller.getSnapshot().running).toBe(true);
    await controller.settled();
    expect(controller.getSnapshot()).toMatchObject({
      running: false,
      state: { draft: "", history: ["1 + 1"], history_cursor: null },
    });
    expect(controller.getSnapshot().state.outputs[0]).toMatchObject({ code: "1 + 1", execution_id: "execution:1 + 1" });
    expect(configured.persist).toHaveBeenCalledTimes(1);
    expect(configured.persist).toHaveBeenCalledWith({
      schema_version: CONSOLE_VIEW_STATE_VERSION,
      filter: "",
      scroll_top: 0,
      follow_tail: true,
      transcript_start_after: null,
      read_cursor: null,
    });
    expect(JSON.stringify(vi.mocked(configured.persist).mock.calls[0]?.[0])).not.toContain("outputs");
  });

  it("preserves the composer draft for source-origin execution", async () => {
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports());
    expect(controller.submit("source_call()", false)).toMatchObject({ accepted: true });
    await controller.settled();
    expect(controller.getSnapshot().state.draft).toBe("draft()");
  });

  it("suppresses a rapid duplicate while execution is pending", async () => {
    let release: ((value: RuntimeExecutionStartResponse) => void) | undefined;
    const start = vi.fn(() => new Promise<RuntimeExecutionStartResponse>((resolve) => { release = resolve; }));
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({ start }));
    expect(controller.submit("slow()", true).accepted).toBe(true);
    expect(controller.submit("slow()", true).message).toContain("busy");
    expect(start).toHaveBeenCalledTimes(1);
    release?.(result("slow()"));
    await controller.settled();
  });

  it("reports thrown execution and recovers admission", async () => {
    const reportError = vi.fn();
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({
      start: vi.fn()
        .mockRejectedValueOnce(new Error("Runtime transport failed"))
        .mockResolvedValueOnce(result("retry()")),
      reportError,
    }));
    expect(controller.submit("first()", true).accepted).toBe(true);
    await controller.settled();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Runtime transport failed" }));
    expect(controller.submit("retry()", true).accepted).toBe(true);
    await controller.settled();
    expect(controller.getSnapshot().state.history).toEqual(["retry()"]);
  });

  it("serializes persistence and recovers after a rejected write", async () => {
    const order: string[] = [];
    const reportError = vi.fn();
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({
      persist: vi.fn()
        .mockImplementationOnce(async () => { order.push("first"); throw new Error("stale revision"); })
        .mockImplementationOnce(async () => { order.push("second"); }),
      reportError,
    }));
    const first = controller.commit({ ...EMPTY_STATE, filter: "one" });
    const second = controller.commit({ ...EMPTY_STATE, filter: "two" });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state.filter).toBe("two");
  });

  it("bounds history and outputs to the newest 100 records", async () => {
    const history = Array.from({ length: 100 }, (_, index) => `old-${index}`);
    const outputs = history.map((code) => ({
      execution_id: code,
      runtime_instance_id: "runtime:r",
      code,
      blocks: [],
    }));
    const controller = new ConsoleInstanceController({ ...EMPTY_STATE, history, outputs });
    controller.configure(ports());
    controller.submit("newest", true);
    await controller.settled();
    expect(controller.getSnapshot().state.history).toHaveLength(100);
    expect(controller.getSnapshot().state.history[0]).toBe("old-1");
    expect(controller.getSnapshot().state.outputs.at(-1)?.code).toBe("newest");
    expect(controller.getSnapshot().state.released_output_count).toBe(1);
  });

  it("recovers a legacy transcript once, then exposes a compact versioned persistence shape", () => {
    const legacy = surface({
      draft: "pending()",
      history: ["old()"],
      filter: "warning",
      scroll_top: 42,
      outputs: [{
        execution_id: "execution:legacy",
        runtime_instance_id: "runtime:r",
        code: "old()",
        events: [{
          sequence: 1,
          runtime_instance_id: "runtime:r",
          console_instance_id: "console:a",
          kind: "mock_result",
          payload: { text: "legacy result" },
        }],
      }],
    });
    const recovered = initialConsoleState(legacy);
    expect(recovered).toMatchObject({ draft: "pending()", history: ["old()"], filter: "warning" });
    expect(recovered.outputs[0]?.blocks[0]?.text).toBe("legacy result");
    expect(needsConsoleStateCompaction(legacy)).toBe(true);

    const compact = surface({
      schema_version: CONSOLE_VIEW_STATE_VERSION,
      filter: "warning",
      scroll_top: 42,
      follow_tail: false,
      transcript_start_after: { execution_id: "execution:old", started_at: "2026-08-23T00:00:00Z" },
      read_cursor: { execution_id: "execution:new", sequence: 8 },
    });
    expect(needsConsoleStateCompaction(compact)).toBe(false);
    expect(initialConsoleState(compact)).toMatchObject({
      draft: "",
      history: [],
      outputs: [],
      filter: "warning",
      scroll_top: 42,
      follow_tail: false,
      transcript_start_after: { execution_id: "execution:old", started_at: "2026-08-23T00:00:00Z" },
      read_cursor: { execution_id: "execution:new", sequence: 8 },
    });
  });

  it("releases older live transcript records by encoded bytes while preserving the newest complete entry", () => {
    const outputs = Array.from({ length: 4 }, (_, index) => ({
      execution_id: `execution:${index}`,
      runtime_instance_id: "runtime:r",
      code: `command_${index}()`,
      blocks: [{ kind: "stdout" as const, label: null, text: `${index}${"测🙂".repeat(450_000)}` }],
    }));
    const recovered = initialConsoleState(surface({ outputs, history: [], filter: "", scroll_top: 0 }));
    expect(recovered.outputs.at(-1)?.execution_id).toBe("execution:3");
    expect(recovered.released_output_count).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(recovered.outputs)).byteLength)
      .toBeLessThanOrEqual(MAX_CONSOLE_TRANSCRIPT_CACHE_BYTES);
  });

  it("keeps persisted metadata comfortably below the Surface contract for large Unicode filters", () => {
    const state = { ...EMPTY_STATE, filter: "警告🙂".repeat(100_000), scroll_top: Number.POSITIVE_INFINITY };
    expect(consolePersistentViewStateBytes(state)).toBeLessThan(9 * 1024);
    expect(consolePersistentViewStateBytes({ ...state, filter: "\u0000".repeat(100_000) }))
      .toBeLessThan(64 * 1024);
  });

  it("starts a transcript with a durable cursor without deleting older executions", () => {
    const outputs = [
      { execution_id: "execution:old", runtime_instance_id: "runtime:r", code: "old()", started_at: "2026-08-24T00:00:00Z", blocks: [] },
      { execution_id: "execution:new", runtime_instance_id: "runtime:r", code: "new()", started_at: "2026-08-24T00:01:00Z", blocks: [] },
    ];
    const anchored = {
      ...EMPTY_STATE,
      outputs,
      transcript_start_after: { execution_id: "execution:old", started_at: "2026-08-24T00:00:00Z" },
    };
    expect(consoleTranscriptOutputs(anchored).map((output) => output.execution_id)).toEqual(["execution:new"]);
    expect(anchored.outputs).toHaveLength(2);

    const recoveredWithoutAnchor = { ...anchored, outputs: [outputs[1]!] };
    expect(consoleTranscriptOutputs(recoveredWithoutAnchor).map((output) => output.execution_id)).toEqual(["execution:new"]);
  });

  it("repairs a missing live frame from the durable output page before projecting later chunks", async () => {
    const first = chunk(1, "first");
    const second = chunk(2, "second");
    const page = vi.fn(async () => ({
      execution_id: "execution:gap()",
      project_root: "/project",
      status: "completed" as const,
      output_state: "complete" as const,
      total_output_bytes: 11,
      after_sequence: 0,
      before_sequence: null,
      previous_sequence: 1,
      next_sequence: 2,
      has_older: false,
      has_more: false,
      chunks: [first, second],
    }));
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({
      page,
      follow: vi.fn(async (executionId, _after, listener) => {
        listener({
          type: "chunks",
          project_id: "project:a",
          execution_id: executionId,
          first_sequence: 2,
          last_sequence: 2,
          chunks: [second],
        });
        listener({
          type: "terminal",
          project_id: "project:a",
          execution_id: executionId,
          committed_through: 2,
          execution: { ...execution("gap()"), last_sequence: 2, output_bytes: 11 },
        });
      }),
    }));
    expect(controller.submit("gap()", true).accepted).toBe(true);
    await controller.settled();
    expect(page).toHaveBeenCalledWith("execution:gap()", 0);
    expect(controller.getSnapshot().state.outputs[0]?.blocks.map((block) => block.text))
      .toEqual(["first", "second"]);
  });

  it("mounts the durable tail and pages earlier output upward without duplicating sequence order", async () => {
    const first = chunk(1, "first");
    const second = chunk(2, "second");
    const third = chunk(3, "third");
    const historic = {
      ...execution("gap()"),
      execution_id: "execution:gap()",
      last_sequence: 3,
      output_bytes: 16,
    };
    const pageBefore = vi.fn(async (_executionId: string, beforeSequence: number) => beforeSequence === 4
      ? {
          execution_id: "execution:gap()",
          project_root: "/project",
          status: "completed" as const,
          output_state: "complete" as const,
          total_output_bytes: 16,
          after_sequence: 0,
          before_sequence: 4,
          previous_sequence: 3,
          next_sequence: 3,
          has_older: true,
          has_more: false,
          chunks: [third],
        }
      : {
          execution_id: "execution:gap()",
          project_root: "/project",
          status: "completed" as const,
          output_state: "complete" as const,
          total_output_bytes: 16,
          after_sequence: 0,
          before_sequence: 3,
          previous_sequence: 1,
          next_sequence: 2,
          has_older: false,
          has_more: true,
          chunks: [first, second],
        });
    const controller = new ConsoleInstanceController(EMPTY_STATE);
    controller.configure(ports({
      list: vi.fn(async () => [historic]),
      pageBefore,
    }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(controller.getSnapshot().state.outputs[0]?.blocks.map((block) => block.text)).toEqual(["third"]);
    expect(controller.getSnapshot().state.outputs[0]?.has_older).toBe(true);

    await controller.loadOlder("execution:gap()");
    expect(controller.getSnapshot().state.outputs[0]?.blocks.map((block) => block.text))
      .toEqual(["first", "second", "third"]);
    expect(controller.getSnapshot().state.outputs[0]?.has_older).toBe(false);
    expect(controller.getSnapshot().state.follow_tail).toBe(false);
    expect(pageBefore.mock.calls.map((call) => call[1])).toEqual([4, 3]);
  });
});
