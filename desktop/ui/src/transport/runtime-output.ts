import { Channel } from "@tauri-apps/api/core";

import {
  createRuntimeOutputCommands,
  type RuntimeExecution as GeneratedRuntimeExecution,
  type RuntimeExecutionDeleteResult as GeneratedRuntimeExecutionDeleteResult,
  type RuntimeExecutionStatus,
  type RuntimeOutputChunk as GeneratedRuntimeOutputChunk,
  type RuntimeOutputFollowFrame as GeneratedRuntimeOutputFollowFrame,
  type RuntimeOutputPage as GeneratedRuntimeOutputPage,
  type RuntimeOutputPageRequest as GeneratedRuntimeOutputPageRequest,
  type RuntimeOutputPolicy as GeneratedRuntimeOutputPolicy,
  type RuntimeOutputPolicyUpdate as GeneratedRuntimeOutputPolicyUpdate,
  type RuntimeOutputPolicyView as GeneratedRuntimeOutputPolicyView,
  type RuntimeOutputPresentationKind,
  type RuntimeOutputPruneResult as GeneratedRuntimeOutputPruneResult,
  type RuntimeOutputReference as GeneratedRuntimeOutputReference,
  type RuntimeOutputReferenceKind,
  type RuntimeOutputSearchHit as GeneratedRuntimeOutputSearchHit,
  type RuntimeOutputSearchRequest as GeneratedRuntimeOutputSearchRequest,
  type RuntimeOutputSearchResult as GeneratedRuntimeOutputSearchResult,
  type RuntimeOutputState,
  type RuntimeOutputStorageKind,
  type RuntimeOutputInvoke,
} from "./generated/runtime-output";

export type {
  RuntimeExecutionStatus,
  RuntimeOutputPresentationKind,
  RuntimeOutputReferenceKind,
  RuntimeOutputState,
  RuntimeOutputStorageKind,
};

export type RuntimeExecution = Readonly<GeneratedRuntimeExecution>;
export type RuntimeOutputChunk = Readonly<GeneratedRuntimeOutputChunk>;
export type RuntimeOutputFollowFrame = GeneratedRuntimeOutputFollowFrame;
export type RuntimeOutputPage = Omit<Readonly<GeneratedRuntimeOutputPage>, "chunks"> & {
  readonly chunks: readonly RuntimeOutputChunk[];
};
export type RuntimeOutputSearchHit = Readonly<GeneratedRuntimeOutputSearchHit>;
export type RuntimeOutputSearchResult = Omit<Readonly<GeneratedRuntimeOutputSearchResult>, "hits"> & {
  readonly hits: readonly RuntimeOutputSearchHit[];
};
export type RuntimeOutputPolicy = Omit<Readonly<GeneratedRuntimeOutputPolicy>, "auto_prune_enabled"> & {
  readonly auto_prune_enabled: false;
};
export type RuntimeOutputPolicyView = Omit<Readonly<GeneratedRuntimeOutputPolicyView>, "policy"> & {
  readonly policy: RuntimeOutputPolicy;
};
export type RuntimeOutputPolicyUpdate = Omit<GeneratedRuntimeOutputPolicyUpdate, "auto_prune_enabled"> & {
  readonly auto_prune_enabled: false;
};
export type RuntimeOutputPruneResult = Readonly<GeneratedRuntimeOutputPruneResult>;
export type RuntimeOutputReference = Readonly<GeneratedRuntimeOutputReference>;
export type RuntimeExecutionDeleteResult = Readonly<GeneratedRuntimeExecutionDeleteResult>;

export type RuntimeOutputPageRequest = Omit<
  GeneratedRuntimeOutputPageRequest,
  "before_sequence" | "page_size" | "byte_limit"
> & {
  readonly before_sequence?: number;
  readonly page_size?: number;
  readonly byte_limit?: number;
};

export type RuntimeOutputSearchRequest = Omit<
  GeneratedRuntimeOutputSearchRequest,
  "console_instance_id" | "started_after" | "limit"
> & {
  readonly console_instance_id?: string;
  readonly started_after?: string;
  readonly limit?: number;
};

export interface RuntimeExecutionCursor {
  readonly started_at: string;
  readonly execution_id: string;
}

export interface RuntimeOutputTransport {
  getRuntimeExecution(executionId: string): Promise<RuntimeExecution>;
  listRuntimeExecutions(
    limit?: number,
    before?: RuntimeExecutionCursor,
  ): Promise<readonly RuntimeExecution[]>;
  loadRuntimeOutputPage(request: RuntimeOutputPageRequest): Promise<RuntimeOutputPage>;
  searchRuntimeOutput(request: RuntimeOutputSearchRequest): Promise<RuntimeOutputSearchResult>;
  getRuntimeOutputPolicy(): Promise<RuntimeOutputPolicyView>;
  updateRuntimeOutputPolicy(request: RuntimeOutputPolicyUpdate): Promise<RuntimeOutputPolicyView>;
  createRuntimeOutputReference(
    executionId: string,
    startSequence?: number,
    endSequence?: number,
  ): Promise<RuntimeOutputReference>;
  pruneRuntimeOutput(executionId: string): Promise<RuntimeOutputPruneResult>;
  deleteRuntimeExecution(executionId: string): Promise<RuntimeExecutionDeleteResult>;
  followRuntimeOutput(
    executionId: string,
    afterSequence: number,
    listener: (frame: RuntimeOutputFollowFrame) => void,
  ): Promise<void>;
}

function checkedPolicyView(view: GeneratedRuntimeOutputPolicyView): RuntimeOutputPolicyView {
  if (view.policy.auto_prune_enabled) {
    throw new Error("Runtime output automatic pruning is not supported by this client.");
  }
  return view as RuntimeOutputPolicyView;
}

export function createTauriRuntimeOutputTransport(
  invoke: RuntimeOutputInvoke,
  createChannel: () => Channel<RuntimeOutputFollowFrame> = () => (
    new Channel<RuntimeOutputFollowFrame>()
  ),
): RuntimeOutputTransport {
  const commands = createRuntimeOutputCommands(invoke);
  return {
    getRuntimeExecution: (executionId) => commands.runtimeExecutionGet({
      execution_id: executionId,
    }),
    listRuntimeExecutions: (limit = 50, before) => commands.runtimeExecutionList({
      limit,
      before_started_at: before?.started_at ?? null,
      before_execution_id: before?.execution_id ?? null,
    }),
    loadRuntimeOutputPage: (request) => commands.runtimeOutputPage({
      execution_id: request.execution_id,
      ...(request.after_sequence === undefined ? {} : {
        after_sequence: request.after_sequence,
      }),
      before_sequence: request.before_sequence ?? null,
      page_size: request.page_size ?? null,
      byte_limit: request.byte_limit ?? null,
    }),
    searchRuntimeOutput: (request) => commands.runtimeOutputSearch({
      query: request.query,
      console_instance_id: request.console_instance_id ?? null,
      started_after: request.started_after ?? null,
      limit: request.limit ?? null,
    }),
    getRuntimeOutputPolicy: () => commands.runtimeOutputPolicyGet().then(checkedPolicyView),
    updateRuntimeOutputPolicy: (request) => (
      commands.runtimeOutputPolicyUpdate(request).then(checkedPolicyView)
    ),
    createRuntimeOutputReference: (executionId, startSequence, endSequence) => (
      commands.runtimeOutputReference({
        execution_id: executionId,
        start_sequence: startSequence ?? null,
        end_sequence: endSequence ?? null,
      })
    ),
    pruneRuntimeOutput: (executionId) => commands.runtimeOutputPrune({
      execution_id: executionId,
    }),
    deleteRuntimeExecution: (executionId) => commands.runtimeExecutionDelete({
      execution_id: executionId,
    }),
    followRuntimeOutput: async (executionId, afterSequence, listener) => {
      const channel = createChannel();
      channel.onmessage = listener;
      await commands.runtimeOutputFollow({
        execution_id: executionId,
        after_sequence: afterSequence,
      }, channel);
    },
  };
}
