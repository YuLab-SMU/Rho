import { useMemo } from "react";

import type { AgentTurnDetail } from "../../transport";
import { computeLineDiff } from "./diff";

export interface AgentFileProposal {
  readonly path: string;
  readonly operation: "replace_selection" | "insert_at_cursor" | "append" | "create";
  readonly content: string;
}

export interface AgentFileUndoState {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_after_sha256: string;
  readonly before_content: string;
  readonly created: boolean;
}

export interface AgentFileProposalReview {
  readonly before_content: string;
  readonly expected_disk_sha256: string | null;
}

export type AgentProposalDiffState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly before: string;
      readonly expected_disk_sha256: string | null;
    };

export function parseAgentFileProposal(
  event: AgentTurnDetail["events"][number],
): AgentFileProposal | null {
  if (event.event_type !== "tool.call_completed" || event.tool !== "propose_file_edit") return null;
  const parse = (value: string | null) => {
    if (value == null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed != null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };
  let proposal = parse(event.body);
  if (proposal?.kind !== "rho.file_edit_proposal") {
    const details = parse(event.details_json);
    const argumentsValue = details?.success === true && typeof details.arguments === "object" && details.arguments != null
      ? details.arguments as Record<string, unknown>
      : null;
    proposal = argumentsValue == null ? null : { kind: "rho.file_edit_proposal", ...argumentsValue };
  }
  const operation = proposal?.operation;
  if (
    typeof proposal?.path !== "string" || typeof proposal.content !== "string" ||
    (operation !== "replace_selection" && operation !== "insert_at_cursor" && operation !== "append" && operation !== "create")
  ) return null;
  return { path: proposal.path, operation, content: proposal.content };
}

export function agentFileProposalOutcome(detail: AgentTurnDetail, proposalEventId: number) {
  for (const event of detail.events) {
    if (!event.event_type.startsWith("file_edit.")) continue;
    try {
      const envelope = JSON.parse(event.details_json) as Record<string, unknown>;
      if (Number(envelope.proposal_event_id) !== proposalEventId) continue;
      if (event.event_type === "file_edit.applied") return "applied";
      if (event.event_type === "file_edit.undone") return "undone";
      if (event.event_type.includes("stale")) return "stale";
      if (event.event_type.includes("failed") || event.event_type.includes("cancelled")) return "not applied";
    } catch { /* malformed diagnostics stay visible as raw events */ }
  }
  return null;
}

function AgentLineDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const diff = useMemo(() => computeLineDiff(before, after), [before, after]);
  if (diff == null) return (<>
    <p className="rho-agent-diff-note">This file is too large to diff here; showing the proposed content.</p>
    <pre>{after}</pre>
  </>);
  if (diff.hunks.length === 0) return <p className="rho-agent-diff-note">No line changes.</p>;
  return <div className="rho-agent-diff" role="group" aria-label="Proposed diff">
    <div className="rho-agent-diff-summary">+{diff.additions} −{diff.removals}</div>
    {diff.hunks.map((hunk, hunkIndex) => <div className="rho-agent-diff-hunk" key={hunkIndex}>
      {hunkIndex > 0 && <div className="rho-agent-diff-gap" aria-hidden="true">⋮</div>}
      <div className="rho-agent-diff-hunk-header">@@ -{hunk.beforeStart} +{hunk.afterStart} @@</div>
      <div className="rho-agent-diff-lines">{hunk.lines.map((line, lineIndex) => <div
        className={"rho-agent-diff-line rho-agent-diff-" + line.kind}
        key={lineIndex}
      >
        <span className="rho-agent-diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
        <span className="rho-agent-diff-text">{line.text}</span>
      </div>)}</div>
    </div>)}
  </div>;
}

export function AgentProposalDiff({ proposal, state }: {
  readonly proposal: AgentFileProposal;
  readonly state: AgentProposalDiffState | undefined;
}) {
  if (proposal.operation !== "append" && proposal.operation !== "create") return (<>
    <p className="rho-agent-diff-note">This edit depends on the current editor selection, so only the proposed content can be shown.</p>
    <pre>{proposal.content}</pre>
  </>);
  if (state == null) return <pre>{proposal.content}</pre>;
  if (state.status === "loading") return <p className="rho-agent-diff-note">Loading current content…</p>;
  if (state.status === "unavailable") return (<>
    <p className="rho-agent-diff-note">Current content is unavailable; showing the proposed content.</p>
    <pre>{proposal.content}</pre>
  </>);
  const after = proposal.operation === "append" ? state.before + proposal.content : proposal.content;
  return <AgentLineDiff before={state.before} after={after} />;
}
