import { describe, expect, it } from "vitest";

import {
  AGENT_UX_SUCCESS_FIXTURE,
  REQUIRED_AGENT_SURFACE_STATES,
  validateAgentUxFixture,
} from "./agentUxContract";
import type { AgentSurfaceState, AgentUxFixture } from "./agentUxContract";

function cloneFixture(): AgentUxFixture {
  return structuredClone(AGENT_UX_SUCCESS_FIXTURE) as AgentUxFixture;
}

describe("UX_CONTRACT_TEST Agent UX contract fixtures", () => {
  it("cover loading, empty, streaming, blocked, denied, stale, uncertain, reconnecting and cancelled states", () => {
    const required: readonly AgentSurfaceState[] = [
      "loading",
      "empty",
      "streaming",
      "blocked",
      "denied",
      "stale",
      "uncertain",
      "reconnecting",
      "cancelled",
    ];
    expect(REQUIRED_AGENT_SURFACE_STATES).toEqual(required);
  });

  it("keep Plan and Job identities, state machines and visual components separate", () => {
    const fixture = cloneFixture();
    expect(fixture.plan.plan_id).not.toBe(fixture.jobs[0]?.job_id);
    expect(fixture.plan.state).toBe("active");
    expect(fixture.jobs[0]?.state).toBe("running");
    expect(fixture.plan.visual_component).toBe("agent-plan-card");
    expect(fixture.jobs[0]?.visual_component).toBe("agent-job-card");
    expect(validateAgentUxFixture(fixture)).toEqual([]);

    const identityCollision = cloneFixture();
    identityCollision.jobs[0] = {
      ...identityCollision.jobs[0]!,
      job_id: identityCollision.plan.plan_id,
    };
    expect(validateAgentUxFixture(identityCollision)).toContain("plan_job_identity_collision");

    const visualCollision = cloneFixture();
    visualCollision.jobs[0] = {
      ...visualCollision.jobs[0]!,
      visual_component: visualCollision.plan.visual_component,
    };
    expect(validateAgentUxFixture(visualCollision)).toContain("plan_job_visual_collision");
  });

  it("requires exact-effect approval review before workspace mutation", () => {
    const approval = AGENT_UX_SUCCESS_FIXTURE.approvals[0];
    expect(approval?.exact_effect).toMatchObject({
      capability_id: "workspace.run_r",
      effect_class: "workspace_mutation",
      destination: "local_workspace",
      reversible: false,
    });
    expect(approval?.exact_effect.normalized_arguments).toHaveProperty("code");
    expect(approval?.exact_effect.expected_revision).toMatchObject({
      workspace_id: "workspace_main",
      kernel_instance_id: "kernel_a",
      state_revision: 842,
      project_revision: 15,
    });
  });

  it("does not let a transport acknowledgement become success without authoritative event and revision", () => {
    const fixture = cloneFixture();
    fixture.activities[1] = {
      ...fixture.activities[1]!,
      status: "succeeded",
      transport_acknowledged: true,
      authoritative_commit: null,
    };
    expect(validateAgentUxFixture(fixture)).toContain(
      "activity_run_r:success_without_authoritative_commit",
    );
  });

  it("keeps ACP/provider-private details and private thinking out of the UI fixture", () => {
    const serialized = JSON.stringify(AGENT_UX_SUCCESS_FIXTURE).toLowerCase();
    for (const forbidden of [
      "acp_method",
      "provider_enum",
      "provider_method",
      "private_thinking",
      "chain_of_thought",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });

  it("hides writable controls for read-only external observers", () => {
    const fixture = cloneFixture();
    fixture.provider.read_only_external_observer = true;
    fixture.provider.writable_controls_visible = true;
    expect(validateAgentUxFixture(fixture)).toContain(
      "read_only_external_observer_has_writable_controls",
    );

    fixture.provider.writable_controls_visible = false;
    expect(validateAgentUxFixture(fixture)).toEqual([]);
  });

  it("includes keyboard, screen-reader, narrow-width and long-output acceptance cases", () => {
    expect(AGENT_UX_SUCCESS_FIXTURE.layout_acceptance).toEqual({
      keyboard_navigation: true,
      screen_reader_labels: true,
      narrow_width: true,
      long_output: true,
    });
  });
});
