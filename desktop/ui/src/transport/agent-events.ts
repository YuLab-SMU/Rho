import type { AgentTurnEvent } from "./agent-turn";
import type { Listen } from "./tauri";
import type { Unsubscribe } from "./types";

/**
 * Live projection of a durable Agent turn mutation. The frame is only a
 * notification layer: consumers must reconcile from Agent turn detail when a
 * frame is truncated or a sequence cannot be applied safely.
 */
export type AgentTurnUpdateFrame = Readonly<{
  status: string;
  final_message: string | null;
  error_message: string | null;
  terminal_reason: string | null;
}>;

export type AgentTurnEventFrame = Readonly<{
  project_root: string;
  turn_id: string;
  event: AgentTurnEvent | null;
  turn_update: AgentTurnUpdateFrame | null;
  payload_truncated: boolean;
}>;

export interface AgentEventsTransport {
  subscribeAgentTurnEvents(listener: (frame: AgentTurnEventFrame) => void): Unsubscribe;
}

export function createTauriAgentEventsTransport(listen: Listen): AgentEventsTransport {
  return {
    subscribeAgentTurnEvents: (listener) => {
      const pending = listen<AgentTurnEventFrame>("agent://turn-event", (event) => {
        listener(event.payload);
      });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        void pending.then((unsubscribe) => unsubscribe()).catch(() => undefined);
      };
    },
  };
}
