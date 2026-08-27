import type { AgentTurnEvent } from "./agent-turn";
import type { Listen } from "./tauri";
import type { Unsubscribe } from "./types";

/// Live projection of one Agent turn mutation, forwarded from the store
/// executor's broadcast channel as `agent://turn-event`. Frames are a
/// replayable notification layer: the durable turn detail remains the source
/// of truth and subscribers reconcile through the existing queries on gaps.
export type AgentTurnUpdateFrame = Readonly<{
  status: string;
  final_message: string | null;
  error_message: string | null;
  terminal_reason: string | null;
}>;

export type AgentTurnEventFrame = Readonly<{
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
        void pending.then((unsubscribe) => unsubscribe());
      };
    },
  };
}
