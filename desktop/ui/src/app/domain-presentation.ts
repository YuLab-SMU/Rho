import type { DomainSurfaceItem } from "../transport";

export type DomainPresentationKind = "timeline" | "outputs" | "stream" | "claims" | "git" | "help";
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

function sourceLocation(record: Readonly<Record<string, unknown>> | null, fallback: string | null): string | null {
  const source = value(record, ["source_path", "path"]) ?? fallback;
  if (source == null) return null;
  const line = value(record, ["line_number", "start_line"]);
  return line == null ? source : `${source}:${line}`;
}

function compactMoment(input: string | null): string | null {
  if (input == null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(input);
  return match == null ? input : `${match[1]} ${match[2]}`;
}

function hasExecutablePreview(record: Readonly<Record<string, unknown>> | null): boolean {
  const preview = value(record, ["code_preview"]);
  if (preview == null) return true;
  return preview.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

function runOriginLabel(record: Readonly<Record<string, unknown>> | null): string | null {
  const source = value(record, ["source_path"]);
  const mode = value(record, ["execution_mode"]);
  if (source === "<console>" || mode === "console") return "R Console";
  if (source != null && !source.startsWith("<")) {
    if (mode === "selection") return "Source selection";
    if (mode === "expression") return "Source expression";
    return "Source editor";
  }
  const origin = value(record, ["origin"]);
  if (origin === "agent") return "Agent";
  if (origin === "plugin" || origin === "extension") return "Project component";
  return origin;
}

export function domainPresentationKind(surfaceId: string): DomainPresentationKind {
  if (surfaceId === "rho.runs" || surfaceId === "rho.render-jobs") return "timeline";
  if (surfaceId === "rho.plots") return "outputs";
  if (surfaceId === "rho.problems" || surfaceId === "rho.logs") return "stream";
  if (surfaceId === "rho.evidence") return "claims";
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
  if (surfaceId === "rho.runs") {
    return items.filter((item) => {
      const record = parseDetail(item);
      if (record == null) return true;
      const origin = value(record, ["origin"]);
      const operationClass = value(record, ["operation_class"]);
      return origin !== "system" && operationClass !== "probe" && hasExecutablePreview(record);
    });
  }
  if (surfaceId === "rho.plots" && modeId === "single") return items.slice(0, 1);
  return items;
}

function derivedStatus(surfaceId: string, item: DomainSurfaceItem, record: Readonly<Record<string, unknown>> | null): string {
  if (surfaceId === "rho.git") {
    if (isGitCommit(item)) return "commit";
    const dirty = flag(record, "dirty");
    return dirty == null ? item.status ?? "working tree" : dirty ? "changed" : "clean";
  }
  if (surfaceId === "rho.evidence" && item.status == null) {
    const linked = record?.linked_evidence_ids;
    return Array.isArray(linked) && linked.length > 0 ? "linked" : "unlinked";
  }
  if (surfaceId === "rho.plots" && flag(record, "provenance_complete") === false) {
    return "incomplete";
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
  let title = item.title;
  let code: string | null = null;
  const plain = record == null ? item.detail?.trim() || null : null;
  let description: string | null = plain;
  let meta: readonly string[] = compact([item.subtitle]);
  let disclosureLabel: string | null = null;
  let disclosureText: string | null = null;

  if (surfaceId === "rho.runs" || surfaceId === "rho.render-jobs") {
    if (surfaceId === "rho.runs") {
      const source = value(record, ["source_path"]);
      const originLabel = runOriginLabel(record);
      title = source != null && !source.startsWith("<")
        ? source
        : originLabel ?? "Project execution";
      code = value(record, ["code_preview"]);
    }
    description = value(record, ["error_message", "terminal_reason"]) ?? plain;
    meta = compact([
      surfaceId === "rho.runs" ? runOriginLabel(record) : sourceLocation(record, item.subtitle),
      compactMoment(value(record, ["started_at"])),
    ]);
  } else if (surfaceId === "rho.plots") {
    description = plain;
    meta = compact([
      value(record, ["media_type"]), sourceLocation(record, item.subtitle), value(record, ["created_at"]),
    ]);
  } else if (surfaceId === "rho.problems") {
    description = value(record, ["call"]) ?? plain;
    meta = compact([sourceLocation(record, item.subtitle), value(record, ["started_at"])]);
  } else if (surfaceId === "rho.logs") {
    description = record == null ? null : value(record, ["summary"]);
    disclosureLabel = "Open diagnostic text";
    disclosureText = value(record, ["detail", "message"]) ?? plain;
    meta = compact([item.subtitle]);
  } else if (surfaceId === "rho.evidence") {
    description = value(record, ["source_excerpt"]) ?? plain;
    const linked = record?.linked_evidence_ids;
    meta = compact([
      value(record, ["kind", "anchor_kind"]), sourceLocation(record, item.subtitle),
      Array.isArray(linked) ? `${linked.length} linked ${linked.length === 1 ? "source" : "sources"}` : null,
    ]);
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
  const active = presentations.filter((item) => item.tone === "active").length;
  const countLabel = `${items.length}`;
  switch (surfaceId) {
    case "rho.runs": return { title: attention > 0 ? `${attention} ${attention === 1 ? "execution needs" : "executions need"} attention` : `${countLabel} recent ${items.length === 1 ? "execution" : "executions"}`, subtitle: active > 0 ? `${active} currently active` : "Project execution history" };
    case "rho.render-jobs": return { title: active > 0 ? `${active} ${active === 1 ? "render is" : "renders are"} active` : `${countLabel} render ${items.length === 1 ? "job" : "jobs"}`, subtitle: attention > 0 ? `${attention} need attention` : "Document output history" };
    case "rho.plots": return { title: `${countLabel} session ${items.length === 1 ? "plot" : "plots"}`, subtitle: "Most recent visual outputs" };
    case "rho.problems": return { title: items.length === 0 ? "No recorded problems" : `${countLabel} ${items.length === 1 ? "problem" : "problems"}`, subtitle: attention > 0 ? `${attention} need attention` : "Run diagnostics" };
    case "rho.logs": return { title: items.length === 0 ? "No diagnostic entries" : "Workbench diagnostics", subtitle: `${countLabel} current ${items.length === 1 ? "entry" : "entries"}` };
    case "rho.evidence": return { title: `${countLabel} evidence ${items.length === 1 ? "claim" : "claims"}`, subtitle: attention > 0 ? `${attention} need linked support` : "Claims linked to project sources" };
    case "rho.git": return { title: items[0]?.title ?? "Working tree", subtitle: attention > 0 ? "Local changes present" : items.length === 0 ? "No entries in this view" : "Repository state" };
    default: return { title: "Rho help", subtitle: `${countLabel} contextual ${items.length === 1 ? "entry" : "entries"}` };
  }
}

export function domainEmptyState(surfaceId: string, filtered: boolean): { readonly title: string; readonly detail: string } {
  if (filtered) return { title: "No matching results", detail: "Try a title, status, source, or date." };
  switch (surfaceId) {
    case "rho.runs": return { title: "No history yet", detail: "Source, Console, Agent, and project-component executions will appear here." };
    case "rho.render-jobs": return { title: "No render jobs yet", detail: "Document renders will appear here when they run." };
    case "rho.plots": return { title: "No session plots yet", detail: "Plots produced by Workspace R will appear here." };
    case "rho.problems": return { title: "No recorded problems", detail: "Run warnings and errors will appear here." };
    case "rho.logs": return { title: "No diagnostic entries", detail: "Workbench diagnostics will appear when available." };
    case "rho.evidence": return { title: "No evidence claims yet", detail: "Source-backed claims will appear here." };
    case "rho.git": return { title: "No repository entries", detail: "This mode has no working-tree or history entries." };
    default: return { title: "No contextual help", detail: "Available commands and build information will appear here." };
  }
}
