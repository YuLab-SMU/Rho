import type { RuntimeExecution, RuntimeOutputChunk } from "../transport";
import type { ConsoleProjectionBlock } from "./console-output";

export function runtimeOutputChunkBlock(chunk: RuntimeOutputChunk): ConsoleProjectionBlock {
  const kind = chunk.presentation_kind === "display_ref" ? "value" : chunk.presentation_kind;
  const label = kind === "message" ? "Message"
    : kind === "warning" ? "Warning"
      : kind === "error" ? "Error"
        : null;
  if (chunk.storage_kind === "record_ref") {
    const referenceKind = chunk.reference_kind ?? "artifact";
    return {
      kind: "value",
      label: referenceKind === "plot" ? "Plot" : "Artifact",
      text: chunk.reference_id ?? "Referenced output is unavailable.",
      ...(chunk.reference_id == null ? {} : { reference: {
        kind: referenceKind,
        id: chunk.reference_id,
        media_type: chunk.media_type,
        sha256: chunk.payload_sha256,
      } }),
    };
  }
  if (chunk.storage_kind === "tombstone") {
    let reason = "Some output is unavailable.";
    try {
      const metadata = JSON.parse(chunk.json_payload ?? "{}") as Readonly<Record<string, unknown>>;
      if (metadata.reason === "capture_limit_reached") {
        reason = "Output capture reached its configured storage limit. The computation continued, but this transcript is partial.";
      } else if (metadata.reason === "pruned") {
        reason = "This output payload was pruned. The execution record and provenance remain available.";
      }
    } catch {
      // Optional tombstone metadata must never hide the durable omission marker.
    }
    return { kind: "status", label: null, text: reason };
  }
  return {
    kind,
    label,
    text: chunk.text_payload ?? chunk.json_payload ?? "Output is unavailable.",
  };
}

export function runtimeExecutionStateLabel(execution: Pick<RuntimeExecution, "status" | "output_state">): string {
  const outputSuffix = ["collecting", "complete"].includes(execution.output_state)
    ? ""
    : ` · ${execution.output_state}`;
  return `${execution.status}${outputSuffix}`;
}
