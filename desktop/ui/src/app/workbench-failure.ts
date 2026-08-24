export type WorkbenchFailureKind =
  | "user_input"
  | "admission"
  | "conflict"
  | "runtime_execution"
  | "runtime_infrastructure"
  | "transport"
  | "unknown";

export type WorkbenchFailureScope = "inline" | "surface" | "workbench";

export interface WorkbenchFailure {
  readonly kind: WorkbenchFailureKind;
  readonly message: string;
  readonly operation_id: string | null;
  readonly retryable: boolean;
  readonly scope: WorkbenchFailureScope;
}

export interface WorkbenchFailureContext {
  readonly fallback: string;
  readonly defaultKind?: WorkbenchFailureKind;
  readonly operationId?: string | null;
  readonly retryable?: boolean;
  readonly scope?: WorkbenchFailureScope;
}

const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/u;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|private|opt|workspace)\/)[^\s"'<>]+/gu;

function stripControlCharacters(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("");
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value != null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function rawMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  const message = recordValue(cause, "message");
  return typeof message === "string" ? message : "";
}

export function sanitizeFailureMessage(message: string, fallback: string): string {
  const clean = stripControlCharacters(message)
    .replace(ABSOLUTE_PATH, "[local path]")
    .replace(/\s+/gu, " ")
    .trim();
  const safeFallback = stripControlCharacters(fallback).trim() || "Operation failed.";
  return (clean || safeFallback).slice(0, 512);
}

function classify(message: string, fallback: WorkbenchFailureKind): WorkbenchFailureKind {
  const lower = message.toLocaleLowerCase();
  if (/\b(?:stale|revision|conflict|changed while|belongs to another project)\b/u.test(lower)) return "conflict";
  if (/\b(?:busy|not attached|cannot accept|not admitted|admission|paused|recovering|restarting)\b/u.test(lower)) return "admission";
  if (/\b(?:runtime|kernel|bridge|rscript|ark)\b/u.test(lower) && /\b(?:unavailable|failed|launch|start|contact|connection|closed)\b/u.test(lower)) {
    return "runtime_infrastructure";
  }
  if (/\b(?:tauri|transport|network|ipc|invoke|channel|connection)\b/u.test(lower)) return "transport";
  if (/\b(?:empty|invalid|missing|required|unsupported)\b/u.test(lower)) return "user_input";
  return fallback;
}

export function normalizeWorkbenchFailure(
  cause: unknown,
  context: WorkbenchFailureContext,
): WorkbenchFailure {
  const message = sanitizeFailureMessage(rawMessage(cause), context.fallback);
  const suppliedId = context.operationId ?? recordValue(cause, "operation_id");
  const operationId = typeof suppliedId === "string" && SAFE_OPERATION_ID.test(suppliedId)
    ? suppliedId
    : null;
  const kind = classify(message, context.defaultKind ?? "unknown");
  return {
    kind,
    message,
    operation_id: operationId,
    retryable: context.retryable ?? (kind === "transport" || kind === "runtime_infrastructure"),
    scope: context.scope ?? "workbench",
  };
}

export function workbenchFailureMessage(cause: unknown, fallback: string): string {
  return normalizeWorkbenchFailure(cause, { fallback }).message;
}
