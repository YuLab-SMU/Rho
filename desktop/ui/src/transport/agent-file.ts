import {
  createAgentFileCommands,
  type AgentFileApplyRequest as AgentFileApplyRequestWire,
  type AgentFileInvoke,
  type AgentFileMutationResponse as AgentFileMutationResponseWire,
  type AgentFileUndoRequest as AgentFileUndoRequestWire,
} from "./generated/agent-file";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentFileApplyRequest = DeepReadonly<{
  turn_id: AgentFileApplyRequestWire["turnId"];
  proposal_event_id: AgentFileApplyRequestWire["proposalEventId"];
  path: AgentFileApplyRequestWire["path"];
  expected_disk_sha256: AgentFileApplyRequestWire["expectedDiskSha256"];
  before_content: AgentFileApplyRequestWire["beforeContent"];
}>;

export type AgentFileUndoRequest = DeepReadonly<{
  turn_id: AgentFileUndoRequestWire["turnId"];
  proposal_event_id: AgentFileUndoRequestWire["proposalEventId"];
  path: AgentFileUndoRequestWire["path"];
  expected_after_sha256: AgentFileUndoRequestWire["expectedAfterSha256"];
  before_content: AgentFileUndoRequestWire["beforeContent"];
  created: AgentFileUndoRequestWire["created"];
}>;

export type AgentFileMutationResponse = DeepReadonly<
  Omit<AgentFileMutationResponseWire, "afterSha256"> & {
    after_sha256: AgentFileMutationResponseWire["afterSha256"];
  }
>;

export interface AgentFileTransport {
  applyAgentFileEdit(request: AgentFileApplyRequest): Promise<AgentFileMutationResponse>;
  undoAgentFileEdit(request: AgentFileUndoRequest): Promise<AgentFileMutationResponse>;
}

function normalizeResponse(
  response: AgentFileMutationResponseWire,
): AgentFileMutationResponse {
  const { afterSha256, ...rest } = response;
  return { ...rest, after_sha256: afterSha256 };
}

export function createTauriAgentFileTransport(invoke: AgentFileInvoke): AgentFileTransport {
  const commands = createAgentFileCommands(invoke);
  return {
    applyAgentFileEdit: async (request) => normalizeResponse(await commands.applyAgentFileEdit({
      turnId: request.turn_id,
      proposalEventId: request.proposal_event_id,
      path: request.path,
      expectedDiskSha256: request.expected_disk_sha256,
      beforeContent: request.before_content,
    })),
    undoAgentFileEdit: async (request) => normalizeResponse(await commands.undoAgentFileEdit({
      turnId: request.turn_id,
      proposalEventId: request.proposal_event_id,
      path: request.path,
      expectedAfterSha256: request.expected_after_sha256,
      beforeContent: request.before_content,
      created: request.created,
    })),
  };
}
