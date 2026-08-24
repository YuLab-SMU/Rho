import { describe, expect, it } from "vitest";

import type { RuntimeOutputEvent } from "../transport/types";
import { consoleProjectionText, projectConsoleEvents } from "./console-output";

function event(kind: string, payload: unknown, sequence = 1): RuntimeOutputEvent {
  return {
    sequence,
    runtime_instance_id: "runtime:workspace-r",
    console_instance_id: "instance:console-a",
    kind,
    payload,
  };
}

describe("Console output projection", () => {
  it("projects a Workspace result without exposing its bridge envelope", () => {
    const events = [event("workspace_result", {
      execution_id: "exec_internal_123",
      artifact_id: "artifact_internal_456",
      artifact_media_type: null,
      execution: {
        ok: true,
        code: "library(ggplot2)",
        stdout: "attached package: ggplot2\n",
        value: "[1] \"ggplot2\" \"stats\"",
        messages: ["Loading required package: scales"],
        warnings: ["package was built under R 4.6.1"],
        error: null,
        traceback: [],
        calls: [],
        timestamp: "2026-08-22T19:16:00Z",
      },
      events: [{
        parent_id: "kernel_parent_789",
        type: "execute_input",
        code: "local({ bridge wrapper that must stay hidden })",
      }],
      workspace: { workspace_id: "workspace_internal_012" },
    })];

    expect(projectConsoleEvents(events)).toEqual([
      { kind: "stdout", label: null, text: "attached package: ggplot2" },
      { kind: "value", label: null, text: "[1] \"ggplot2\" \"stats\"" },
      { kind: "message", label: "Message", text: "Loading required package: scales" },
      { kind: "warning", label: "Warning", text: "package was built under R 4.6.1" },
    ]);
    const text = consoleProjectionText("library(ggplot2)", events);
    expect(text).toContain("library(ggplot2)");
    expect(text).toContain("attached package: ggplot2");
    expect(text).not.toContain("exec_internal_123");
    expect(text).not.toContain("kernel_parent_789");
    expect(text).not.toContain("bridge wrapper");
    expect(text).not.toContain("workspace_internal_012");
    expect(text).not.toContain("artifact_internal_456");
  });

  it("shows a quiet completion for a successful result without visible output", () => {
    expect(projectConsoleEvents([event("workspace_result", {
      execution: {
        ok: true,
        stdout: "",
        value: null,
        messages: [],
        warnings: [],
        error: null,
      },
    })])).toEqual([
      { kind: "status", label: null, text: "Completed" },
    ]);
  });

  it("projects R errors and keeps traceback and calls out of the default transcript", () => {
    const blocks = projectConsoleEvents([event("workspace_result", {
      execution: {
        ok: false,
        stdout: "before failure",
        value: null,
        messages: [],
        warnings: [],
        error: { message: "object 'missing_value' not found", call: "print(missing_value)" },
        traceback: ["private_bridge_call()"],
        calls: ["local(private_wrapper())"],
      },
    })]);
    expect(blocks).toEqual([
      { kind: "stdout", label: null, text: "before failure" },
      { kind: "error", label: "Error", text: "object 'missing_value' not found\nIn: print(missing_value)" },
    ]);
    expect(blocks.map((block) => block.text).join("\n")).not.toContain("private_wrapper");
  });

  it("projects supported kernel streams, displays, errors and lifecycle events", () => {
    expect(projectConsoleEvents([
      event("kernel_event", { parent_id: "p1", type: "stream", name: "stdout", text: "hello\n" }, 1),
      event("kernel_event", { parent_id: "p1", type: "display_data", data: { "text/plain": "[1] 42" } }, 2),
      event("kernel_event", { parent_id: "p1", type: "error", traceback: "Error: bad input" }, 3),
      event("kernel_event", { parent_id: "p1", type: "execute_input", code: "private wrapper" }, 4),
      event("cancelled", "Execution interrupted by the Runtime owner.", 5),
    ])).toEqual([
      { kind: "stdout", label: null, text: "hello" },
      { kind: "value", label: null, text: "[1] 42" },
      { kind: "error", label: "Error", text: "Error: bad input" },
      { kind: "status", label: null, text: "Execution interrupted" },
    ]);
  });

  it("uses bounded text-bearing fallback and never raw-stringifies unknown payloads", () => {
    expect(projectConsoleEvents([
      event("mock_result", { text: "Mock evaluation: 1 + 1" }, 1),
      event("future_result", { secret_internal_key: "must not render" }, 2),
    ])).toEqual([
      { kind: "value", label: null, text: "Mock evaluation: 1 + 1" },
      { kind: "status", label: null, text: "Runtime returned an unrecognized output." },
    ]);

    const long = "x".repeat(70_000);
    const [block] = projectConsoleEvents([event("mock_result", { text: long })]);
    expect(block?.text.length).toBeLessThanOrEqual(32_001);
    expect(block?.text.endsWith("…")).toBe(true);
  });

  it("handles malformed Workspace payloads truthfully", () => {
    expect(projectConsoleEvents([event("workspace_result", { execution: "not-an-object" })]))
      .toEqual([{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }]);
  });
});
