import { describe, expect, it } from "vitest";

import type { RuntimeOutputChunk } from "../transport";
import { runtimeOutputChunkBlock } from "./runtime-output-presentation";

describe("Runtime output presentation", () => {
  it("keeps rich output as an actionable typed record reference", () => {
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

    expect(runtimeOutputChunkBlock(chunk)).toEqual({
      kind: "value",
      label: "Plot",
      text: "plot:42",
      reference: {
        kind: "plot",
        id: "plot:42",
        media_type: "image/png",
        sha256: "a".repeat(64),
      },
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
