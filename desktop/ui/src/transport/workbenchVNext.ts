import type {
  HotCursor,
  WorkbenchCommandResponseVNext,
  WorkbenchReconnectResponseVNext,
} from "../contracts/workbenchVNext";

export const WORKBENCH_TRANSPORT_CONTRACT = "rho.ui.workbench.vnext.v1" as const;
export const MAX_WORKBENCH_COMMAND_BYTES = 64 * 1024;
export const MAX_WORKBENCH_SUBSCRIPTIONS = 8;

export type WorkbenchCommandEnvelopeVNext = {
  contract: typeof WORKBENCH_TRANSPORT_CONTRACT;
  contract_major: 1;
  command:
    | { command: "submit_goal"; goal_id: string; text: string; expected_snapshot_revision: number }
    | { command: "approval_decision"; approval_id: string; decision: "approve" | "deny" | "cancel"; exact_effect_hash: string }
    | { command: "cancel"; activity_id: string }
    | { command: "configure_provider"; provider_config_id: string; provider_label: string; data_egress: string; read_only_external_observer: boolean }
    | { command: "open_artifact"; artifact_id: string; digest: string }
    | { command: "query_job"; job_id: string; cursor: HotCursor | null };
  bounded_arguments: Record<string, unknown>;
};

export type WorkbenchLiveEventVNext =
  | { cursor: HotCursor; payload: { kind: "activity_changed"; activity_id: string; state: string } }
  | { cursor: HotCursor; payload: { kind: "progress"; key: string; label: string; value: number } }
  | { cursor: HotCursor; payload: { kind: "gap"; requested_after: HotCursor; oldest_available: HotCursor; latest: HotCursor } }
  | { cursor: HotCursor; payload: { kind: "snapshot_invalidated"; snapshot_revision: number } };

export interface WorkbenchTransportBackend {
  command(envelope: WorkbenchCommandEnvelopeVNext): Promise<WorkbenchCommandResponseVNext>;
  reconnect(after: HotCursor): Promise<WorkbenchReconnectResponseVNext>;
  subscribe(after: HotCursor, listener: (event: WorkbenchLiveEventVNext) => void): Promise<() => void>;
}

export class WorkbenchVNextTransport {
  private activeSubscriptions = 0;
  private lastCursor: HotCursor = { cursor: 0 };

  constructor(private readonly backend: WorkbenchTransportBackend) {}

  async command(envelope: WorkbenchCommandEnvelopeVNext): Promise<WorkbenchCommandResponseVNext> {
    const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    if (bytes > MAX_WORKBENCH_COMMAND_BYTES) {
      return { status: "rejected", reason_code: "command_too_large" };
    }
    if (envelope.contract !== WORKBENCH_TRANSPORT_CONTRACT || envelope.contract_major !== 1) {
      return { status: "rejected", reason_code: "unsupported_contract" };
    }
    return this.backend.command(envelope);
  }

  async reconnect(): Promise<WorkbenchReconnectResponseVNext> {
    const response = await this.backend.reconnect(this.lastCursor);
    this.lastCursor = response.hot_cursor;
    return response;
  }

  async subscribe(listener: (event: WorkbenchLiveEventVNext) => void): Promise<() => void> {
    if (this.activeSubscriptions >= MAX_WORKBENCH_SUBSCRIPTIONS) {
      throw new Error("workbench_subscription_limit");
    }
    this.activeSubscriptions += 1;
    let closed = false;
    const unsubscribeBackend = await this.backend.subscribe(this.lastCursor, (event) => {
      if (closed) return;
      this.lastCursor = event.cursor;
      listener(event);
    });
    return () => {
      if (closed) return;
      closed = true;
      this.activeSubscriptions -= 1;
      unsubscribeBackend();
    };
  }

  cursor(): HotCursor {
    return { ...this.lastCursor };
  }
}

export function createBrowserMockWorkbenchHandlers(
  fixture: WorkbenchReconnectResponseVNext,
): WorkbenchTransportBackend {
  const committedByKey = new Map<string, WorkbenchCommandResponseVNext>();
  const listeners = new Set<(event: WorkbenchLiveEventVNext) => void>();
  return {
    async command(envelope) {
      const key = commandIdentity(envelope);
      const prior = committedByKey.get(key);
      if (prior !== undefined) return structuredClone(prior);
      const operationId = `operation_${key}`;
      const response: WorkbenchCommandResponseVNext = {
        status: "committed",
        operation_id: operationId,
        event_id: `event_${key}`,
        snapshot_revision: fixture.snapshot.snapshot_revision + 1,
      };
      committedByKey.set(key, response);
      return structuredClone(response);
    },
    async reconnect(after) {
      const response = structuredClone(fixture);
      response.replayed_token_history = false;
      if (after.cursor < fixture.hot_cursor.cursor - 32) {
        response.gap = {
          requested_after: after,
          oldest_available: { cursor: fixture.hot_cursor.cursor - 32 },
          latest: fixture.hot_cursor,
        };
      }
      return response;
    },
    async subscribe(_after, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function commandIdentity(envelope: WorkbenchCommandEnvelopeVNext): string {
  const command = envelope.command;
  switch (command.command) {
    case "submit_goal":
      return command.goal_id;
    case "approval_decision":
      return command.approval_id;
    case "cancel":
      return command.activity_id;
    case "configure_provider":
      return command.provider_config_id;
    case "open_artifact":
      return `${command.artifact_id}_${command.digest.slice(7, 19)}`;
    case "query_job":
      return command.job_id;
  }
}
