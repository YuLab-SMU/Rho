import type { ResourceIdentity } from "../resource-ports.js";
export function sameScope(before: ResourceIdentity, now: ResourceIdentity) { return before.epoch === now.epoch && before.project === now.project; }
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const terminal = (status: string) => ["succeeded", "failed", "cancelled", "uncertain"].includes(status);
