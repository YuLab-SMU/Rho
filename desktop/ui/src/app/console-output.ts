import type { RuntimeOutputEvent } from "../transport/types";

export type ConsoleProjectionKind = "stdout" | "value" | "message" | "warning" | "error" | "status";

export interface ConsoleProjectionBlock {
  readonly kind: ConsoleProjectionKind;
  readonly label: string | null;
  readonly text: string;
  readonly reference?: {
    readonly kind: "plot" | "artifact";
    readonly id: string;
    readonly media_type: string | null;
    readonly sha256: string;
  };
}

const MAX_CONSOLE_BLOCK_CHARACTERS = 32_000;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded === "string") text = decoded;
    } catch {
      // It is ordinary Console text that happens to begin with a quote.
    }
  }
  text = text.replace(/^\n+|\n+$/g, "");
  if (!text.trim()) return null;
  return text.length > MAX_CONSOLE_BLOCK_CHARACTERS
    ? `${text.slice(0, MAX_CONSOLE_BLOCK_CHARACTERS)}…`
    : text;
}

function itemText(value: unknown): string | null {
  const direct = boundedText(value);
  if (direct != null) return direct;
  const valueRecord = record(value);
  if (valueRecord == null) return null;
  return boundedText(valueRecord.message) ?? boundedText(valueRecord.text);
}

function listText(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    const single = itemText(value);
    return single == null ? [] : [single];
  }
  return value.flatMap((item) => {
    const text = itemText(item);
    return text == null ? [] : [text];
  });
}

function block(
  kind: ConsoleProjectionKind,
  text: string | null,
  label: string | null = null,
): ConsoleProjectionBlock | null {
  return text == null ? null : { kind, label, text };
}

function workspaceBlocks(payload: unknown): readonly ConsoleProjectionBlock[] {
  const envelope = record(payload);
  const execution = record(envelope?.execution);
  if (execution == null) {
    return [{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }];
  }

  const projected: ConsoleProjectionBlock[] = [];
  const stdout = block("stdout", boundedText(execution.stdout));
  const value = block("value", itemText(execution.value));
  if (stdout != null) projected.push(stdout);
  if (value != null && value.text !== stdout?.text) projected.push(value);
  for (const text of listText(execution.messages)) {
    projected.push({ kind: "message", label: "Message", text });
  }
  for (const text of listText(execution.warnings)) {
    projected.push({ kind: "warning", label: "Warning", text });
  }

  const error = record(execution.error);
  const errorMessage = itemText(execution.error);
  if (errorMessage != null) {
    const call = boundedText(error?.call);
    projected.push({
      kind: "error",
      label: "Error",
      text: call == null ? errorMessage : `${errorMessage}\nIn: ${call}`,
    });
  }
  const help = block("message", boundedText(execution.help), "Help");
  if (help != null) projected.push(help);

  if (projected.length > 0) return projected;
  if (execution.ok === true) return [{ kind: "status", label: null, text: "Completed" }];
  if (execution.ok === false) return [{ kind: "error", label: "Error", text: "Execution failed." }];
  return [{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }];
}

function kernelBlocks(payload: unknown): readonly ConsoleProjectionBlock[] {
  const event = record(payload);
  if (event == null || typeof event.type !== "string") {
    return [{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }];
  }
  switch (event.type) {
    case "stream": {
      const stream = block(event.name === "stderr" ? "warning" : "stdout", boundedText(event.text), event.name === "stderr" ? "Warning" : null);
      return stream == null ? [] : [stream];
    }
    case "display_data": {
      const data = record(event.data);
      const text = boundedText(data?.["text/plain"])
        ?? boundedText(data?.["text/markdown"]);
      return text == null
        ? [{ kind: "status", label: null, text: "Rich output produced." }]
        : [{ kind: "value", label: null, text }];
    }
    case "error": {
      const error = itemText(event.traceback) ?? itemText(event.message);
      return [{ kind: "error", label: "Error", text: error ?? "Runtime execution failed." }];
    }
    case "banner": {
      const banner = block("message", boundedText(event.text), "Runtime");
      return banner == null ? [] : [banner];
    }
    case "input_request": {
      const prompt = boundedText(event.prompt);
      return [{
        kind: "warning",
        label: "Input needed",
        text: prompt ?? "The Runtime requested interactive input.",
      }];
    }
    case "interrupt_requested":
      return [{ kind: "status", label: null, text: "Interrupt requested" }];
    case "kernel_exited":
      return [{ kind: "error", label: "Error", text: "The Runtime stopped unexpectedly." }];
    case "idle":
    case "busy":
    case "execute_input":
    case "execute_reply":
    case "other":
      return [];
    default:
      return [{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }];
  }
}

function genericBlocks(event: RuntimeOutputEvent): readonly ConsoleProjectionBlock[] {
  if (event.kind === "cancelled") {
    return [{ kind: "status", label: null, text: "Execution interrupted" }];
  }
  const payload = record(event.payload);
  const text = boundedText(event.payload)
    ?? boundedText(payload?.text)
    ?? boundedText(payload?.message)
    ?? boundedText(payload?.value);
  if (text == null) {
    return [{ kind: "status", label: null, text: "Runtime returned an unrecognized output." }];
  }
  const normalizedKind = event.kind.toLowerCase();
  if (normalizedKind.includes("error") || normalizedKind.includes("fail")) {
    return [{ kind: "error", label: "Error", text }];
  }
  if (normalizedKind.includes("warning") || normalizedKind.includes("stderr")) {
    return [{ kind: "warning", label: "Warning", text }];
  }
  if (normalizedKind.includes("message")) {
    return [{ kind: "message", label: "Message", text }];
  }
  return [{ kind: "value", label: null, text }];
}

export function projectConsoleEvents(events: readonly RuntimeOutputEvent[]): readonly ConsoleProjectionBlock[] {
  const projected = events.flatMap((event) => {
    if (event.kind === "workspace_result") return workspaceBlocks(event.payload);
    if (event.kind === "kernel_event") return kernelBlocks(event.payload);
    return genericBlocks(event);
  });
  const deduplicated = projected.filter((current, index) => {
    const previous = projected[index - 1];
    return previous == null || previous.kind !== current.kind || previous.label !== current.label || previous.text !== current.text;
  });
  return deduplicated.length > 0
    ? deduplicated
    : [{ kind: "status", label: null, text: "Completed" }];
}

export function consoleProjectionText(code: string, events: readonly RuntimeOutputEvent[]): string {
  return consoleProjectionBlocksText(code, projectConsoleEvents(events));
}

export function consoleProjectionBlocksText(
  code: string,
  blocks: readonly ConsoleProjectionBlock[],
): string {
  return [code, ...blocks.flatMap((item) => item.label == null
    ? [item.text]
    : [item.label, item.text])].join("\n");
}
