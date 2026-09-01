import type { DomainSurfaceItem } from "../transport";

export type DomainPresentationKind = "stream" | "git" | "help";
export type DomainPresentationTone = "ready" | "attention" | "active" | "neutral";

export interface DomainItemPresentation {
  readonly title: string;
  readonly status: string;
  readonly tone: DomainPresentationTone;
  readonly code: string | null;
  readonly description: string | null;
  readonly meta: readonly string[];
  readonly disclosureLabel: string | null;
  readonly disclosureText: string | null;
}

const ATTENTION = new Set(["blocked", "cancelled", "degraded", "error", "failed", "incomplete", "missing", "warning"]);
const ACTIVE = new Set(["active", "pending", "queued", "rendering", "running", "waiting"]);
const READY = new Set(["available", "clean", "completed", "current", "linked", "ready", "succeeded"]);

function parseDetail(item: DomainSurfaceItem): Readonly<Record<string, unknown>> | null {
  const detail = item.detail?.trim();
  if (!detail?.startsWith("{")) return null;
  try {
    const value = JSON.parse(detail) as unknown;
    return typeof value === "object" && value != null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
}

function value(record: Readonly<Record<string, unknown>> | null, keys: readonly string[]): string | null {
  if (record == null) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }
  return null;
}

function count(record: Readonly<Record<string, unknown>> | null, key: string): number | null {
  const candidate = record?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function flag(record: Readonly<Record<string, unknown>> | null, key: string): boolean | null {
  const candidate = record?.[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0))];
}

export function domainPresentationKind(surfaceId: string): DomainPresentationKind {
  if (surfaceId === "rho.logs") return "stream";
  if (surfaceId === "rho.git") return "git";
  return "help";
}

function isGitCommit(item: DomainSurfaceItem): boolean {
  const record = parseDetail(item);
  return value(record, ["hash"]) != null || /^commit:|^git-log:/.test(item.id);
}

export function domainItemsForMode(
  surfaceId: string,
  modeId: string | null,
  items: readonly DomainSurfaceItem[],
): readonly DomainSurfaceItem[] {
  if (surfaceId === "rho.git") {
    return items.filter((item) => modeId === "history" ? isGitCommit(item) : !isGitCommit(item));
  }
  return items;
}

function derivedStatus(surfaceId: string, item: DomainSurfaceItem, record: Readonly<Record<string, unknown>> | null): string {
  if (surfaceId === "rho.git") {
    if (isGitCommit(item)) return "commit";
    const dirty = flag(record, "dirty");
    return dirty == null ? item.status ?? "working tree" : dirty ? "changed" : "clean";
  }
  return item.status?.trim().toLowerCase() || (surfaceId === "rho.logs" ? "current" : "record");
}

function toneFor(status: string): DomainPresentationTone {
  if (ATTENTION.has(status) || status === "changed" || status === "incompatible" || status === "unlinked") return "attention";
  if (ACTIVE.has(status)) return "active";
  if (READY.has(status) || status === "installed") return "ready";
  return "neutral";
}

export function domainItemPresentation(surfaceId: string, item: DomainSurfaceItem): DomainItemPresentation {
  const record = parseDetail(item);
  const status = derivedStatus(surfaceId, item, record);
  const title = item.title;
  const code: string | null = null;
  const plain = record == null ? item.detail?.trim() || null : null;
  let description: string | null = plain;
  let meta: readonly string[] = compact([item.subtitle]);
  let disclosureLabel: string | null = null;
  let disclosureText: string | null = null;

  if (surfaceId === "rho.logs") {
    description = record == null ? null : value(record, ["summary"]);
    disclosureLabel = "Open diagnostic text";
    disclosureText = value(record, ["detail", "message"]) ?? plain;
    meta = compact([item.subtitle]);
  } else if (surfaceId === "rho.git") {
    if (isGitCommit(item)) {
      description = plain;
      meta = compact([value(record, ["author"]), value(record, ["date"]), value(record, ["hash"])]);
    } else {
      const staged = count(record, "staged");
      const modified = count(record, "modified");
      const untracked = count(record, "untracked");
      const ahead = count(record, "ahead");
      const behind = count(record, "behind");
      description = compact([
        staged == null ? null : `${staged} staged`,
        modified == null ? null : `${modified} modified`,
        untracked == null ? null : `${untracked} untracked`,
      ]).join(" · ") || plain;
      meta = compact([
        ahead == null || ahead === 0 ? null : `${ahead} ahead`,
        behind == null || behind === 0 ? null : `${behind} behind`,
      ]);
    }
  } else if (surfaceId === "rho.help") {
    description = value(record, ["summary", "purpose"]) ?? plain;
    const buildDetail = value(record, ["detail"]);
    if (buildDetail != null) {
      disclosureLabel = "Build details";
      disclosureText = buildDetail;
    }
    meta = compact([item.subtitle]);
  }

  return { title, status, tone: toneFor(status), code, description, meta, disclosureLabel, disclosureText };
}

export function domainMatches(surfaceId: string, item: DomainSurfaceItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const projected = domainItemPresentation(surfaceId, item);
  return [projected.title, projected.status, projected.code, projected.description, ...projected.meta]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

export function domainSummary(surfaceId: string, items: readonly DomainSurfaceItem[]): { readonly title: string; readonly subtitle: string } {
  const presentations = items.map((item) => domainItemPresentation(surfaceId, item));
  const attention = presentations.filter((item) => item.tone === "attention").length;
  const countLabel = `${items.length}`;
  switch (surfaceId) {
    case "rho.logs": return { title: items.length === 0 ? "No diagnostic entries" : "Workbench diagnostics", subtitle: `${countLabel} current ${items.length === 1 ? "entry" : "entries"}` };
    case "rho.git": return { title: items[0]?.title ?? "Working tree", subtitle: attention > 0 ? "Local changes present" : items.length === 0 ? "No entries in this view" : "Repository state" };
    default: return { title: "Rho help", subtitle: `${countLabel} contextual ${items.length === 1 ? "entry" : "entries"}` };
  }
}

export function domainEmptyState(surfaceId: string, filtered: boolean): { readonly title: string; readonly detail: string } {
  if (filtered) return { title: "No matching results", detail: "Try a title, status, source, or date." };
  switch (surfaceId) {
    case "rho.logs": return { title: "No diagnostic entries", detail: "Workbench diagnostics will appear when available." };
    case "rho.git": return { title: "No repository entries", detail: "This mode has no working-tree or history entries." };
    default: return { title: "No contextual help", detail: "Available commands and build information will appear here." };
  }
}
