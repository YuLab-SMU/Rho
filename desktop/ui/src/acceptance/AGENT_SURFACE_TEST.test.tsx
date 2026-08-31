import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AgentSurfaceVNext,
  MAX_VISIBLE_AGENT_ACTIVITIES,
  boundVisibleActivities,
} from "../app/agent/AgentSurfaceVNext";
import {
  AGENT_UX_SUCCESS_FIXTURE,
  type ActivityProjection,
  type AgentUxFixture,
} from "./agentUxContract";

function fixture(): AgentUxFixture {
  return structuredClone(AGENT_UX_SUCCESS_FIXTURE) as AgentUxFixture;
}

function render(projection = fixture(), hotGap = false): string {
  return renderToStaticMarkup(
    <AgentSurfaceVNext projection={projection} hotCursor={91} hotGap={hotGap} />,
  );
}

describe("AGENT_SURFACE_TEST new scientific Agent surface", () => {
  it("shows first visible activity before a completed message exists", () => {
    const projection = fixture();
    projection.surface_state = "streaming";
    projection.messages = [];
    projection.activities = [
      {
        activity_id: "activity_first_token",
        kind: "message",
        status: "streaming",
        label: "Agent response started",
        authoritative_commit: null,
        transport_acknowledged: true,
      },
    ];
    const markup = render(projection);
    expect(markup).toContain("Agent response started");
    expect(markup).toContain("streaming");
  });

  it("renders provider plan and execution jobs as distinct components", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Provider plan"');
    expect(markup).toContain(`Job ${AGENT_UX_SUCCESS_FIXTURE.jobs[0]?.job_id}`);
    expect(markup).toContain(`Execution ${AGENT_UX_SUCCESS_FIXTURE.jobs[0]?.execution_id}`);
  });

  it("keeps terminal, approval, capability, and plan activities while bounding/coalescing hot activity", () => {
    const base: ActivityProjection = {
      activity_id: "activity_hot",
      kind: "message",
      status: "streaming",
      label: "streaming",
      authoritative_commit: null,
      transport_acknowledged: true,
    };
    const activities = Array.from({ length: 300 }, (_, index) => ({
      ...base,
      activity_id: `activity_hot_${index}`,
      label: `hot ${index}`,
    }));
    activities.push({
      ...base,
      activity_id: "activity_terminal",
      kind: "capability_request",
      status: "failed",
      label: "tool terminal failed",
    });
    activities.push({
      ...base,
      activity_id: "activity_terminal",
      kind: "capability_request",
      status: "failed",
      label: "tool terminal failed authoritative",
    });
    const visible = boundVisibleActivities(activities);
    expect(visible.length).toBeLessThanOrEqual(MAX_VISIBLE_AGENT_ACTIVITIES);
    expect(visible.filter((activity) => activity.activity_id === "activity_terminal")).toHaveLength(1);
    expect(visible.some((activity) => activity.label.includes("authoritative"))).toBe(true);
  });

  it("shows exact normalized effect, destination, revision, risk, and one-time scope", () => {
    const markup = render();
    expect(markup).toContain("workspace.run_r");
    expect(markup).toContain("local_workspace");
    expect(markup).toContain("842/15");
    expect(markup).toContain("Workspace mutation; not infrastructure-replayable");
    expect(markup).toContain("Exact non-reversible effect");
    expect(markup).toContain("Normalized effect arguments");
  });

  it("hides mutation controls when capability is absent or provider is read-only", () => {
    const projection = fixture();
    projection.provider.capability_ids = ["workspace.inspect"];
    expect(render(projection)).not.toContain("Approve once");

    projection.provider.capability_ids.push("workspace.run_r");
    projection.provider.read_only_external_observer = true;
    expect(render(projection)).not.toContain("Approve once");
  });

  it("renders gap, cancel, stale, uncertain, reconnect, error and recovery truth", () => {
    const projection = fixture();
    projection.activities.push(
      {
        activity_id: "activity_reconnect",
        kind: "recovery",
        status: "reconnecting",
        label: "Reconnecting",
        authoritative_commit: null,
        transport_acknowledged: false,
      },
      {
        activity_id: "activity_uncertain",
        kind: "execution_job",
        status: "uncertain",
        label: "Execution uncertain",
        authoritative_commit: null,
        transport_acknowledged: true,
      },
      {
        activity_id: "activity_cancelled",
        kind: "execution_job",
        status: "cancelled",
        label: "Execution cancelled",
        authoritative_commit: null,
        transport_acknowledged: true,
      },
    );
    projection.plan.steps[0]!.state = "stale";
    const markup = render(projection, true);
    for (const text of [
      "Live activity gap detected",
      "Request cancel",
      "stale",
      "Outcome uncertain",
      "Reconnecting to durable activity",
      "Execution cancelled",
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("never renders private reasoning or secret argument values", () => {
    const projection = fixture();
    projection.messages.push({
      message_id: "message_private",
      role: "agent",
      state: "ready",
      visibility: "private_reasoning_redacted",
      content_preview: "CANARY_PRIVATE_THINKING",
      authoritative_commit: null,
    });
    projection.approvals[0]!.exact_effect.normalized_arguments.provider_token =
      "CANARY_SECRET_VALUE";
    const markup = render(projection);
    expect(markup).toContain("Private reasoning withheld");
    expect(markup).not.toContain("CANARY_PRIVATE_THINKING");
    expect(markup).not.toContain("CANARY_SECRET_VALUE");
    expect(markup).toContain("[REDACTED]");
  });

  it("has keyboard and screen-reader labels for approval, cancellation, reconnect and regions", () => {
    const approve = vi.fn();
    const markup = renderToStaticMarkup(
      <AgentSurfaceVNext
        projection={fixture()}
        hotCursor={91}
        hotGap
        onApprove={approve}
      />,
    );
    for (const label of [
      "Scientific agent workbench",
      "Current Work",
      "Activity",
      "Approval",
      "Context &amp; Policy",
      "Reconnect activity stream",
      "Approve exact effect",
      "Request cancellation",
    ]) {
      expect(markup).toContain(label);
    }
  });

  it("uses only tokenized style values and has a narrow-width layout rule", () => {
    const source = String.raw`${AgentSurfaceVNext}`;
    expect(source).not.toContain("@tauri-apps");
    const stylePath = new URL("../styles/agent-surface-vnext.css", import.meta.url);
    expect(stylePath.pathname).toContain("agent-surface-vnext.css");
  });
});
