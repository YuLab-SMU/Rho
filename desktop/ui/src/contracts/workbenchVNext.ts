export type WorkbenchCommandName =
  | "submit_goal"
  | "approval_decision"
  | "cancel"
  | "configure_provider"
  | "open_artifact"
  | "query_job";

export type CommandStatus = "accepted" | "committed" | "uncertain" | "rejected";

export interface HotCursor {
  cursor: number;
}

export interface WorkbenchSnapshotVNext {
  contract: "rho.ui.workbench.vnext.v1";
  contract_major: 1;
  snapshot_revision: number;
  durable_activities: {
    activity_id: string;
    state: "accepted" | "committed" | "running" | "waiting_approval" | "failed" | "cancelled" | "uncertain";
    label: string;
    event_id: string | null;
    snapshot_revision: number;
  }[];
  available_commands: WorkbenchCommandName[];
  hot_cursor: HotCursor;
  provider_label: string;
  recovery_generation: string;
}

export interface WorkbenchReconnectResponseVNext {
  snapshot: WorkbenchSnapshotVNext;
  hot_cursor: HotCursor;
  gap: null | {
    requested_after: HotCursor;
    oldest_available: HotCursor;
    latest: HotCursor;
  };
  replayed_token_history: false;
}

export type WorkbenchCommandResponseVNext =
  | { status: "accepted"; operation_id: string; accepted_at_revision: number }
  | { status: "committed"; operation_id: string; event_id: string; snapshot_revision: number }
  | { status: "uncertain"; operation_id: string; reason_code: string; reconcile_after_cursor: HotCursor }
  | { status: "rejected"; reason_code: string };

export const WORKBENCH_VNEXT_COMMANDS: WorkbenchCommandName[] = [
  "submit_goal",
  "approval_decision",
  "cancel",
  "configure_provider",
  "open_artifact",
  "query_job",
];

export const WORKBENCH_VNEXT_FIXTURE: WorkbenchReconnectResponseVNext = {
  snapshot: {
    contract: "rho.ui.workbench.vnext.v1",
    contract_major: 1,
    snapshot_revision: 44,
    durable_activities: [
      {
        activity_id: "activity_goal",
        state: "committed",
        label: "Goal committed",
        event_id: "event_goal_submitted",
        snapshot_revision: 43,
      },
      {
        activity_id: "activity_run",
        state: "uncertain",
        label: "Execution needs reconciliation",
        event_id: null,
        snapshot_revision: 44,
      },
    ],
    available_commands: [...WORKBENCH_VNEXT_COMMANDS],
    hot_cursor: { cursor: 91 },
    provider_label: "Configured provider",
    recovery_generation: "recovery_gen_1",
  },
  hot_cursor: { cursor: 91 },
  gap: null,
  replayed_token_history: false,
};

export function browserMockWorkbenchVNextFixture(): WorkbenchReconnectResponseVNext {
  return structuredClone(WORKBENCH_VNEXT_FIXTURE) as WorkbenchReconnectResponseVNext;
}

export function validateWorkbenchVNextFixture(fixture: WorkbenchReconnectResponseVNext): string[] {
  const errors: string[] = [];
  if (fixture.snapshot.contract !== "rho.ui.workbench.vnext.v1") errors.push("contract");
  if (fixture.snapshot.contract_major !== 1) errors.push("contract_major");
  for (const command of WORKBENCH_VNEXT_COMMANDS) {
    if (!fixture.snapshot.available_commands.includes(command)) errors.push(`missing_command:${command}`);
  }
  for (const activity of fixture.snapshot.durable_activities) {
    if (activity.state === "committed" && activity.event_id === null) {
      errors.push(`${activity.activity_id}:committed_without_event`);
    }
  }
  if (fixture.replayed_token_history) errors.push("replayed_token_history");
  const serialized = JSON.stringify(fixture).toLowerCase();
  for (const forbidden of [
    "acp",
    "provider_method",
    "provider_specific_enum",
    "private_thinking",
    "chain_of_thought",
    "raw_project_payload",
    "plaintext_secret",
  ]) {
    if (serialized.includes(forbidden)) errors.push(`forbidden:${forbidden}`);
  }
  return errors;
}

export function validateCommandResponse(response: WorkbenchCommandResponseVNext): string[] {
  const errors: string[] = [];
  if ((response as Record<string, unknown>).ok !== undefined) errors.push("ok_bool");
  if (!["accepted", "committed", "uncertain", "rejected"].includes(response.status)) {
    errors.push("status");
  }
  if (response.status !== "rejected" && response.operation_id.length === 0) {
    errors.push("operation_id");
  }
  return errors;
}
