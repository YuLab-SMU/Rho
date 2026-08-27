import { describe, expect, it } from "vitest";

import type { RuntimeOutputChunk } from "../transport";
import { consoleProjectionBlocksText } from "./console-output";
import { runtimeOutputChunkBlock } from "./runtime-output-presentation";

describe("Runtime output presentation", () => {
  it("keeps rich output actionable without exposing its opaque reference identity", () => {
    const chunk: RuntimeOutputChunk = {
      execution_id: "runtime-execution:plot",
      project_root: "/project",
      sequence: 4,
      producer_sequence: 3,
      projection_slot: 1,
      source_kind: "workspace.plot",
      presentation_kind: "display_ref",
      media_type: "image/png",
      storage_kind: "record_ref",
      text_payload: null,
      json_payload: null,
      reference_kind: "plot",
      reference_id: "plot:42",
      payload_bytes: 8192,
      payload_sha256: "a".repeat(64),
      created_at: "2026-08-24T00:00:00Z",
    };

    const plot = runtimeOutputChunkBlock(chunk);
    expect(plot).toEqual({
      kind: "value",
      label: "Plot",
      text: "Ready to inspect.",
      reference: {
        kind: "plot",
        id: "plot:42",
        media_type: "image/png",
        sha256: "a".repeat(64),
      },
    });
    expect(consoleProjectionBlocksText("plot(1:3)", [plot])).not.toContain("plot:42");

    const artifact = runtimeOutputChunkBlock({
      ...chunk,
      execution_id: "runtime-execution:artifact",
      reference_kind: "artifact",
      reference_id: "artifact:internal-99",
      media_type: "text/csv",
      payload_sha256: "c".repeat(64),
    });
    expect(artifact).toEqual({
      kind: "value",
      label: "Artifact",
      text: "Ready to inspect.",
      reference: {
        kind: "artifact",
        id: "artifact:internal-99",
        media_type: "text/csv",
        sha256: "c".repeat(64),
      },
    });
    expect(consoleProjectionBlocksText("write.csv(result)", [artifact]))
      .not.toContain("artifact:internal-99");
  });

  it("fails closed when a referenced output identity is incomplete or unsupported", () => {
    const chunk: RuntimeOutputChunk = {
      execution_id: "runtime-execution:missing-reference",
      project_root: "/project",
      sequence: 1,
      producer_sequence: 1,
      projection_slot: 0,
      source_kind: "workspace.plot",
      presentation_kind: "display_ref",
      media_type: "image/png",
      storage_kind: "record_ref",
      text_payload: null,
      json_payload: null,
      reference_kind: "plot",
      reference_id: null,
      payload_bytes: 0,
      payload_sha256: "d".repeat(64),
      created_at: "2026-08-24T00:00:00Z",
    };

    expect(runtimeOutputChunkBlock(chunk)).toEqual({
      kind: "value",
      label: "Plot",
      text: "Referenced output is unavailable.",
    });
    expect(runtimeOutputChunkBlock({
      ...chunk,
      reference_kind: null,
      reference_id: "plot:must-not-open",
    })).toEqual({
      kind: "value",
      label: "Output",
      text: "Referenced output is unavailable.",
    });
    expect(runtimeOutputChunkBlock({
      ...chunk,
      reference_id: "   ",
    })).toEqual({
      kind: "value",
      label: "Plot",
      text: "Referenced output is unavailable.",
    });
    expect(runtimeOutputChunkBlock({
      ...chunk,
      reference_kind: "table",
      reference_id: "table:must-not-open",
    } as unknown as RuntimeOutputChunk)).toEqual({
      kind: "value",
      label: "Output",
      text: "Referenced output is unavailable.",
    });
  });

  it("renders capture and prune tombstones without exposing raw metadata", () => {
    const base: RuntimeOutputChunk = {
      execution_id: "runtime-execution:tombstone",
      project_root: "/project",
      sequence: 1,
      producer_sequence: 1,
      projection_slot: 0,
      source_kind: "runtime.capture",
      presentation_kind: "status",
      media_type: "application/json",
      storage_kind: "tombstone",
      text_payload: null,
      json_payload: JSON.stringify({ reason: "capture_limit_reached", private_path: "/tmp/private" }),
      reference_kind: null,
      reference_id: null,
      payload_bytes: 80,
      payload_sha256: "b".repeat(64),
      created_at: "2026-08-24T00:00:00Z",
    };
    const block = runtimeOutputChunkBlock(base);
    expect(block.text).toContain("configured storage limit");
    expect(block.text).not.toContain("private_path");
  });
});
