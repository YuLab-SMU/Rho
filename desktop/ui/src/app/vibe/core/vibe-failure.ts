import { workbenchFailureMessage } from "../../workbench-failure";

const INTERNAL_ID_ASSIGNMENT = /["']?\b(?:approval|artifact|block|check|conversation|credential|execution|instance|operation|page|profile|project|request|resource|route|run|scene|surface|task|turn|view|workspace)[_-]?id\b["']?\s*[:=]\s*(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[A-Za-z0-9](?:[A-Za-z0-9:._-]*[A-Za-z0-9_-])?)/giu;
const TYPED_INTERNAL_ID = /\b(?:agent-(?:conversation|turn)|approval|artifact|block|check|conversation|credential|execution|instance|operation|page|profile|project|request|resource|route|run|scene|surface|task|turn|view|workspace):[A-Za-z0-9][A-Za-z0-9:._-]*\b/giu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const INTERNAL_TOKEN = /\b[A-Za-z0-9._-]*internal(?:[_-][A-Za-z0-9._:-]+)+\b/giu;
const QUOTED_RAW_URI = /(["'])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\r\n<>]*?\1/gu;
const RAW_URI = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu;
const WINDOWS_FILE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n"'<>;,]+[\\/])(?:[^\\/\r\n"'<>;,]+[\\/])*[^\\/\r\n"'<>;,]*\.[\p{L}\p{N}]{1,12}(?=$|[\s),;:!?}\]])/gu;
const WINDOWS_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n"'<>;,]+[\\/])(?:[^\\/\r\n"'<>;,]+[\\/])*[^\\/\s"'<>),;:!?}\]]+/gu;
const POSIX_FILE_PATH = /(?<![\p{L}\p{N}_:/])\/(?:[^/\r\n"'<>;,]+\/)*[^/\r\n"'<>;,]*\.[\p{L}\p{N}]{1,12}(?=$|[\s),;:!?}\]])/gu;
const POSIX_ABSOLUTE_PATH = /(?<![\p{L}\p{N}_:/])\/(?:[^/\r\n"'<>;,]+\/)+[^/\s"'<>),;:!?}\]]+/gu;
const SECRET_ASSIGNMENT = /["']?\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|private[_-]?key|secret|token)\b["']?\s*[:=]\s*(?:Bearer\s+)?(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}\]]+)/giu;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu;
const KNOWN_SECRET_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu;

function redactDelimitedValue(match: string, replacement: string): string {
  const trailing = match.match(/[),.;!?]+$/u)?.[0] ?? "";
  return `${replacement}${trailing}`;
}

function redactQuotedUri(match: string): string {
  const quote = match[0] ?? '"';
  return `${quote}[internal reference]${quote}`;
}

function redactVibeSensitiveText(message: string): string {
  return message
    // URI must be removed before its slash-delimited suffix can resemble a
    // local path and leave the scheme or authority visible.
    .replace(QUOTED_RAW_URI, redactQuotedUri)
    .replace(RAW_URI, (match) => redactDelimitedValue(match, "[internal reference]"))
    .replace(WINDOWS_FILE_PATH, (match) => redactDelimitedValue(match, "[local path]"))
    .replace(WINDOWS_ABSOLUTE_PATH, (match) => redactDelimitedValue(match, "[local path]"))
    .replace(POSIX_FILE_PATH, (match) => redactDelimitedValue(match, "[local path]"))
    .replace(POSIX_ABSOLUTE_PATH, (match) => redactDelimitedValue(match, "[local path]"))
    .replace(SECRET_ASSIGNMENT, "[secret]")
    .replace(BEARER_SECRET, "[secret]")
    .replace(KNOWN_SECRET_TOKEN, "[secret]")
    .replace(INTERNAL_ID_ASSIGNMENT, "[internal reference]")
    .replace(TYPED_INTERNAL_ID, "[internal reference]")
    .replace(UUID, "[internal reference]")
    .replace(INTERNAL_TOKEN, "[internal reference]");
}

function preRedactVibeFailure(cause: unknown): unknown {
  if (cause instanceof Error) return redactVibeSensitiveText(cause.message);
  if (typeof cause === "string") return redactVibeSensitiveText(cause);
  if (typeof cause === "object" && cause != null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string") return redactVibeSensitiveText(message);
  }
  return cause;
}

/**
 * Keep the shared Workbench error boundary while applying Vibe's stricter
 * promise that scientific correspondence never exposes implementation IDs.
 */
export function vibeFailureMessage(cause: unknown, fallback: string): string {
  // Redact both before the shared 512-character boundary (so truncation can
  // never split a sensitive assignment) and after it (so fallback text is
  // held to the same Vibe-only boundary).
  return redactVibeSensitiveText(workbenchFailureMessage(preRedactVibeFailure(cause), fallback));
}
