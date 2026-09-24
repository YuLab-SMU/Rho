import type { ResourceIdentity } from "../resource-ports.js";
export function sameScope(before: ResourceIdentity, now: ResourceIdentity, native = false) {
  return before.epoch === now.epoch && before.project === now.project && (!native || before.session === now.session);
}
export const terminal = (status: string) => ["succeeded", "failed", "cancelled", "uncertain"].includes(status);
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
