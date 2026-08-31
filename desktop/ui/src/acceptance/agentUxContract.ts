export type AgentSurfaceState =
  | "loading"
  | "empty"
  | "ready"
  | "streaming"
  | "blocked"
  | "denied"
  | "stale"
  | "uncertain"
  | "reconnecting"
  | "cancelled";

export type ActivityStatus =
  | "pending"
  | "streaming"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "reconnecting";

export type PlanState = "proposed" | "active" | "completed" | "stale" | "replaced";
export type JobState =
  | "prepared"
  | "queued"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "reconciling";

export interface RevisionRef {
  workspace_id: string;
  kernel_instance_id: string;
  state_revision: number;
  project_revision: number;
}

export interface AuthoritativeCommitRef {
  event_id: string;
  revision: RevisionRef;
}

export interface ActivityProjection {
  activity_id: string;
  kind:
    | "message"
    | "plan_transition"
    | "capability_request"
    | "approval"
    | "execution_job"
    | "revision"
    | "artifact"
    | "recovery";
  status: ActivityStatus;
  label: string;
  authoritative_commit: AuthoritativeCommitRef | null;
  transport_acknowledged: boolean;
}

export interface PlanProjection {
  plan_id: string;
  state: PlanState;
  visual_component: string;
  steps: {
    step_id: string;
    label: string;
    state: "pending" | "running" | "completed" | "blocked" | "denied" | "stale";
    stale_after: RevisionRef | null;
  }[];
}

export interface JobProjection {
  job_id: string;
  execution_id: string;
  state: JobState;
  visual_component: string;
  revision: RevisionRef;
  terminal_event: AuthoritativeCommitRef | null;
}

export interface AgentUxFixture {
  contract: "rho.ui.agent-ux.v1";
  contract_major: 1;
  surface_state: AgentSurfaceState;
  permission_posture: "ask_before_changes" | "auto_within_policy";
  data_egress:
    | "deny"
    | "configured_provider_only"
    | "allowlisted_destinations"
    | "ask_for_unrestricted_destination";
  goal: {
    goal_id: string;
    text: string;
    state: AgentSurfaceState;
  };
  messages: {
    message_id: string;
    role: "user" | "agent" | "system";
    state: AgentSurfaceState;
    visibility: "user_visible" | "observable_reasoning_artifact" | "private_reasoning_redacted";
    content_preview: string;
    authoritative_commit: AuthoritativeCommitRef | null;
  }[];
  plan: PlanProjection;
  activities: ActivityProjection[];
  approvals: {
    approval_id: string;
    state: "pending" | "approved" | "denied" | "cancelled";
    exact_effect: {
      capability_id: string;
      effect_class: "read" | "workspace_mutation" | "project_mutation" | "external_effect";
      destination:
        | "local_workspace"
        | "local_sandbox"
        | "configured_provider"
        | "allowlisted_domain"
        | "unrestricted_network"
        | "remote_executor";
      expected_revision: RevisionRef;
      normalized_arguments: Record<string, unknown>;
      reversible: boolean;
      risk_label: string;
    };
    authoritative_commit: AuthoritativeCommitRef | null;
  }[];
  jobs: JobProjection[];
  artifacts: {
    artifact_id: string;
    digest: string;
    producer_id: string;
    revision: RevisionRef;
  }[];
  recovery: {
    recovery_id: string;
    state: AgentSurfaceState;
    object: string;
    known_truth: string;
    safe_next_step: string;
  }[];
  provider: {
    provider_snapshot_id: string;
    provider_label: string;
    capability_ids: string[];
    read_only_external_observer: boolean;
    writable_controls_visible: boolean;
  };
  layout_acceptance: {
    keyboard_navigation: boolean;
    screen_reader_labels: boolean;
    narrow_width: boolean;
    long_output: boolean;
  };
}

export const REQUIRED_AGENT_SURFACE_STATES = [
  "loading",
  "empty",
  "streaming",
  "blocked",
  "denied",
  "stale",
  "uncertain",
  "reconnecting",
  "cancelled",
] as const satisfies readonly AgentSurfaceState[];

export const AGENT_UX_SUCCESS_FIXTURE: AgentUxFixture = {
  contract: "rho.ui.agent-ux.v1",
  contract_major: 1,
  surface_state: "streaming",
  permission_posture: "ask_before_changes",
  data_egress: "configured_provider_only",
  goal: {
    goal_id: "goal_cluster_compare",
    text: "Compare cluster 3 and cluster 7 while controlling sample effects",
    state: "streaming",
  },
  messages: [{
    message_id: "message_observation_1",
    role: "agent",
    state: "ready",
    visibility: "observable_reasoning_artifact",
    content_preview: "Observation: cluster 7 is enriched for sample B",
    authoritative_commit: {
      event_id: "event_message_completed_1",
      revision: {
        workspace_id: "workspace_main",
        kernel_instance_id: "kernel_a",
        state_revision: 842,
        project_revision: 15,
      },
    },
  }],
  plan: {
    plan_id: "plan_current",
    state: "active",
    visual_component: "agent-plan-card",
    steps: [
      {
        step_id: "step_inspect_composition",
        label: "Inspect cluster composition",
        state: "completed",
        stale_after: null,
      },
      {
        step_id: "step_control_sample_effect",
        label: "Control for sample effect",
        state: "running",
        stale_after: {
          workspace_id: "workspace_main",
          kernel_instance_id: "kernel_a",
          state_revision: 842,
          project_revision: 15,
        },
      },
    ],
  },
  activities: [
    {
      activity_id: "activity_observe",
      kind: "revision",
      status: "succeeded",
      label: "Observation committed",
      authoritative_commit: {
        event_id: "event_observe_1",
        revision: {
          workspace_id: "workspace_main",
          kernel_instance_id: "kernel_a",
          state_revision: 842,
          project_revision: 15,
        },
      },
      transport_acknowledged: false,
    },
    {
      activity_id: "activity_run_r",
      kind: "approval",
      status: "waiting_approval",
      label: "run_r waiting for approval",
      authoritative_commit: null,
      transport_acknowledged: true,
    },
  ],
  approvals: [{
    approval_id: "approval_run_r_1",
    state: "pending",
    exact_effect: {
      capability_id: "workspace.run_r",
      effect_class: "workspace_mutation",
      destination: "local_workspace",
      expected_revision: {
        workspace_id: "workspace_main",
        kernel_instance_id: "kernel_a",
        state_revision: 842,
        project_revision: 15,
      },
      normalized_arguments: {
        code: "model <- fit_sample_adjusted_de(sce, cluster=c(3, 7))",
        timeout_ms: 30000,
      },
      reversible: false,
      risk_label: "Workspace mutation; not infrastructure-replayable",
    },
    authoritative_commit: null,
  }],
  jobs: [{
    job_id: "job_workspace_run_1",
    execution_id: "execution_workspace_run_1",
    state: "running",
    visual_component: "agent-job-card",
    revision: {
      workspace_id: "workspace_main",
      kernel_instance_id: "kernel_a",
      state_revision: 842,
      project_revision: 15,
    },
    terminal_event: null,
  }],
  artifacts: [{
    artifact_id: "artifact_de_plot",
    digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    producer_id: "execution_workspace_run_1",
    revision: {
      workspace_id: "workspace_main",
      kernel_instance_id: "kernel_a",
      state_revision: 843,
      project_revision: 15,
    },
  }],
  recovery: [{
    recovery_id: "recovery_reconnect_1",
    state: "reconnecting",
    object: "Workspace job",
    known_truth: "Execution submitted; terminal outcome not yet reconciled",
    safe_next_step: "Reconnect to durable snapshot and observe job truth",
  }],
  provider: {
    provider_snapshot_id: "provider_snapshot_1",
    provider_label: "Configured provider",
    capability_ids: ["workspace.inspect", "workspace.run_r"],
    read_only_external_observer: false,
    writable_controls_visible: true,
  },
  layout_acceptance: {
    keyboard_navigation: true,
    screen_reader_labels: true,
    narrow_width: true,
    long_output: true,
  },
};

export function validateAgentUxFixture(fixture: AgentUxFixture): readonly string[] {
  const errors: string[] = [];
  if (fixture.contract !== "rho.ui.agent-ux.v1") errors.push("contract");
  if (fixture.contract_major !== 1) errors.push("contract_major");
  if (fixture.plan.plan_id.length === 0) errors.push("plan_id");
  if (fixture.jobs.some((job) => job.job_id === fixture.plan.plan_id)) {
    errors.push("plan_job_identity_collision");
  }
  if (fixture.jobs.some((job) => job.visual_component === fixture.plan.visual_component)) {
    errors.push("plan_job_visual_collision");
  }
  for (const activity of fixture.activities) {
    if (activity.status === "succeeded" && activity.authoritative_commit === null) {
      errors.push(`${activity.activity_id}:success_without_authoritative_commit`);
    }
  }
  for (const approval of fixture.approvals) {
    const effect = approval.exact_effect;
    if (!effect.capability_id || !effect.destination || effect.expected_revision.state_revision <= 0) {
      errors.push(`${approval.approval_id}:incomplete_exact_effect`);
    }
  }
  for (const artifact of fixture.artifacts) {
    if (!artifact.digest.startsWith("sha256:")) {
      errors.push(`${artifact.artifact_id}:mutable_artifact_identity`);
    }
  }
  if (fixture.provider.read_only_external_observer && fixture.provider.writable_controls_visible) {
    errors.push("read_only_external_observer_has_writable_controls");
  }
  const layout = fixture.layout_acceptance;
  if (!layout.keyboard_navigation || !layout.screen_reader_labels || !layout.narrow_width || !layout.long_output) {
    errors.push("incomplete_layout_acceptance");
  }
  return errors;
}
