import { workbenchFailureMessage } from "../../workbench-failure";

const INTERNAL_ID_KEY = /\b(?:approval|artifact|block|check|conversation|execution|instance|operation|page|project|request|run|surface|task|turn|workspace)[_-]?id\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9:._-]*/giu;
const TYPED_INTERNAL_ID = /\b(?:agent-(?:conversation|turn)|approval|artifact|block|check|conversation|execution|instance|operation|page|project|request|run|surface|task|turn|workspace):[A-Za-z0-9][A-Za-z0-9:._-]*/giu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const INTERNAL_TOKEN = /\b[A-Za-z0-9._-]*internal(?:[_-][A-Za-z0-9._:-]+)+\b/giu;
const ADDITIONAL_LOCAL_PATH = /(?:\\\\[A-Za-z0-9._-]+\\[^\s"'<>]+|\/(?:Applications|Library|System|Volumes|data|etc|mnt|root|srv|usr)\/[^\s"'<>]+)/gu;

function preRedactAdditionalPaths(cause: unknown): unknown {
  if (cause instanceof Error) return cause.message.replace(ADDITIONAL_LOCAL_PATH, "[local path]");
  if (typeof cause === "string") return cause.replace(ADDITIONAL_LOCAL_PATH, "[local path]");
  if (typeof cause === "object" && cause != null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string") return message.replace(ADDITIONAL_LOCAL_PATH, "[local path]");
  }
  return cause;
}

/**
 * Keep the shared Workbench error boundary while applying Vibe's stricter
 * promise that scientific correspondence never exposes implementation IDs.
 */
export function vibeFailureMessage(cause: unknown, fallback: string): string {
  return workbenchFailureMessage(preRedactAdditionalPaths(cause), fallback)
    .replace(INTERNAL_ID_KEY, "[internal reference]")
    .replace(TYPED_INTERNAL_ID, "[internal reference]")
    .replace(UUID, "[internal reference]")
    .replace(INTERNAL_TOKEN, "[internal reference]");
}
