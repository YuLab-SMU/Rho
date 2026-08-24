import type { DomainSurfaceItem } from "../transport";

export type EnvironmentMode = "packages" | "requests";
export type EnvironmentTone = "ready" | "attention" | "active" | "neutral";

const ATTENTION_STATES = new Set([
  "blocked", "degraded", "error", "failed", "incompatible", "missing", "rejected",
]);
const ACTIVE_STATES = new Set([
  "active", "approved", "pending", "queued", "requested", "running", "waiting",
]);
const READY_STATES = new Set([
  "available", "completed", "current", "installed", "ready", "succeeded",
]);

function normalizedStatus(item: DomainSurfaceItem): string {
  return item.status?.trim().toLowerCase() ?? "";
}

export function environmentTone(item: DomainSurfaceItem): EnvironmentTone {
  const status = normalizedStatus(item);
  if (ATTENTION_STATES.has(status)) return "attention";
  if (ACTIVE_STATES.has(status)) return "active";
  if (READY_STATES.has(status)) return "ready";
  return "neutral";
}

export function isEnvironmentRequest(item: DomainSurfaceItem): boolean {
  const identity = `${item.id} ${item.title}`.toLowerCase();
  if (item.id.toLowerCase().startsWith("package:")) return false;
  if (identity.includes("request") || identity.includes("operation")) return true;
  if (environmentTone(item) === "active") return true;
  const detail = item.detail?.trim();
  return detail?.startsWith("{") === true && /"(?:request_id|operation|operation_type)"\s*:/.test(detail);
}

export function environmentItemsForMode(
  items: readonly DomainSurfaceItem[],
  mode: EnvironmentMode,
): readonly DomainSurfaceItem[] {
  return items.filter((item) => mode === "requests" ? isEnvironmentRequest(item) : !isEnvironmentRequest(item));
}

export function environmentDetail(item: DomainSurfaceItem): string | null {
  const detail = item.detail?.trim();
  if (!detail) return null;
  if (!detail.startsWith("{") && !detail.startsWith("[")) return detail;
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const facts: string[] = [];
    const append = (label: string, keys: readonly string[]) => {
      const key = keys.find((candidate) => typeof record[candidate] === "string" || typeof record[candidate] === "number");
      if (key != null) facts.push(`${label}: ${String(record[key])}`);
    };
    append("Installed", ["installed_version", "installed"]);
    append("Required", ["required_version", "required"]);
    append("Package", ["package", "package_name"]);
    append("Operation", ["operation", "operation_type", "kind"]);
    append("Requested", ["requested_at", "created_at"]);
    return facts.length === 0 ? null : facts.join(" · ");
  } catch {
    return null;
  }
}

export function environmentMatches(item: DomainSurfaceItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [item.title, item.subtitle, item.status, environmentDetail(item)]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

export function environmentSummary(
  items: readonly DomainSurfaceItem[],
  mode: EnvironmentMode,
): { readonly title: string; readonly subtitle: string } {
  const attention = items.filter((item) => environmentTone(item) === "attention").length;
  const active = items.filter((item) => environmentTone(item) === "active").length;
  if (mode === "requests") {
    return {
      title: active > 0 ? `${active} active ${active === 1 ? "operation" : "operations"}` : "No active operations",
      subtitle: `${items.length} ${items.length === 1 ? "request" : "requests"} recorded`,
    };
  }
  return {
    title: attention > 0 ? `${attention} ${attention === 1 ? "package needs" : "packages need"} attention` : "Project library ready",
    subtitle: `${items.length} ${items.length === 1 ? "package" : "packages"} in this project`,
  };
}
