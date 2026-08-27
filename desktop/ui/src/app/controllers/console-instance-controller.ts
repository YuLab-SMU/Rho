import type {
  RuntimeDescriptor,
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecutionSourceContext,
  RuntimeOutputChunk,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  SurfaceInstance,
} from "../../transport";
import type { RuntimeOutputEvent } from "../../transport/types";
import { projectConsoleEvents, type ConsoleProjectionBlock } from "../console-output";
import { runtimeOutputChunkBlock } from "../runtime-output-presentation";
import type { ConsoleExecutionAdmission } from "./console-execution-router";

export const CONSOLE_VIEW_STATE_VERSION = 3;
export const MAX_CONSOLE_TRANSCRIPT_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_CONSOLE_COMMAND_HISTORY_BYTES = 1024 * 1024;
const MAX_CONSOLE_RECORDS = 100;
const MAX_CONSOLE_OUTPUT_WINDOW_BYTES = 512 * 1024;
const MAX_PERSISTED_FILTER_BYTES = 8 * 1024;

export interface ConsoleOutputRecord {
  readonly execution_id: string;
  readonly runtime_instance_id: string;
  readonly run_id?: string;
  readonly code: string;
  readonly started_at?: string;
  readonly finished_at?: string | null;
  readonly blocks: readonly ConsoleProjectionBlock[];
  readonly status?: RuntimeExecution["status"];
  readonly output_state?: RuntimeExecution["output_state"];
  readonly first_sequence?: number;
  readonly last_sequence?: number;
  readonly has_older?: boolean;
  readonly newer_output_omitted?: boolean;
}

export interface ConsoleTranscriptCursor {
  readonly execution_id: string;
  readonly started_at: string;
}

export interface ConsoleReadCursor {
  readonly execution_id: string;
  readonly sequence: number;
}

export interface ConsoleViewState {
  readonly draft: string;
  readonly history: readonly string[];
  readonly history_cursor: number | null;
  readonly filter: string;
  readonly scroll_top: number;
  readonly follow_tail: boolean;
  readonly transcript_start_after: ConsoleTranscriptCursor | null;
  readonly read_cursor: ConsoleReadCursor | null;
  readonly outputs: readonly ConsoleOutputRecord[];
  readonly released_output_count: number;
}

export interface ConsolePersistentViewState {
  readonly schema_version: typeof CONSOLE_VIEW_STATE_VERSION;
  readonly filter: string;
  readonly scroll_top: number;
  readonly follow_tail: boolean;
  readonly transcript_start_after: ConsoleTranscriptCursor | null;
  readonly read_cursor: ConsoleReadCursor | null;
}

export interface ConsoleInstancePorts {
  readonly runtime: RuntimeDescriptor | null;
  readonly start: (
    runtime: RuntimeDescriptor,
    code: string,
    sourceContext?: RuntimeExecutionSourceContext,
  ) => Promise<RuntimeExecutionStartResponse>;
  readonly follow: (
    executionId: string,
    afterSequence: number,
    listener: (frame: RuntimeOutputFollowFrame) => void,
  ) => Promise<void>;
  readonly list: () => Promise<readonly RuntimeExecution[]>;
  readonly page: (executionId: string, afterSequence: number) => Promise<RuntimeOutputPage>;
  readonly pageBefore: (executionId: string, beforeSequence: number) => Promise<RuntimeOutputPage>;
  readonly persist: (viewState: ConsolePersistentViewState) => Promise<void>;
  readonly reportError: (cause: unknown) => void;
}

export interface ConsoleInstanceSnapshot {
  readonly state: ConsoleViewState;
  readonly running: boolean;
}

const EMPTY_PORTS: ConsoleInstancePorts = {
  runtime: null,
  start: async () => { throw new Error("This Console is not attached to a Runtime."); },
  follow: async () => undefined,
  list: async () => [],
  page: async () => { throw new Error("Runtime output is unavailable."); },
  pageBefore: async () => { throw new Error("Runtime output is unavailable."); },
  persist: async () => undefined,
  reportError: () => undefined,
};

const UTF8 = new TextEncoder();

function utf8Bytes(value: unknown): number {
  const encoded = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return UTF8.encode(encoded).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function finiteScrollTop(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function transcriptCursor(value: unknown): ConsoleTranscriptCursor | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.execution_id === "string" && typeof candidate.started_at === "string"
    ? { execution_id: candidate.execution_id, started_at: candidate.started_at }
    : null;
}

function readCursor(value: unknown): ConsoleReadCursor | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.execution_id === "string"
      && typeof candidate.sequence === "number"
      && Number.isSafeInteger(candidate.sequence)
      && candidate.sequence >= 0
    ? { execution_id: candidate.execution_id, sequence: candidate.sequence }
    : null;
}

export function consolePersistentViewState(state: ConsoleViewState): ConsolePersistentViewState {
  return {
    schema_version: CONSOLE_VIEW_STATE_VERSION,
    filter: truncateUtf8(state.filter, MAX_PERSISTED_FILTER_BYTES),
    scroll_top: finiteScrollTop(state.scroll_top),
    follow_tail: state.follow_tail,
    transcript_start_after: state.transcript_start_after,
    read_cursor: state.read_cursor,
  };
}

export function consolePersistentViewStateBytes(state: ConsoleViewState): number {
  return utf8Bytes(consolePersistentViewState(state));
}

export function needsConsoleStateCompaction(instance: SurfaceInstance): boolean {
  const candidate = instance.view_state;
  if (typeof candidate !== "object" || candidate == null || Array.isArray(candidate)) return true;
  const value = candidate as Readonly<Record<string, unknown>>;
  if (value.schema_version !== CONSOLE_VIEW_STATE_VERSION) return true;
  if (Object.keys(value).some((key) => ![
    "schema_version", "filter", "scroll_top", "follow_tail", "transcript_start_after", "read_cursor",
  ].includes(key))) return true;
  const expected = {
    schema_version: CONSOLE_VIEW_STATE_VERSION,
    filter: truncateUtf8(typeof value.filter === "string" ? value.filter : "", MAX_PERSISTED_FILTER_BYTES),
    scroll_top: finiteScrollTop(value.scroll_top),
    follow_tail: typeof value.follow_tail === "boolean" ? value.follow_tail : true,
    transcript_start_after: transcriptCursor(value.transcript_start_after),
    read_cursor: readCursor(value.read_cursor),
  };
  return JSON.stringify(candidate) !== JSON.stringify(expected);
}

function runtimeEvents(value: unknown): readonly RuntimeOutputEvent[] {
  return Array.isArray(value)
    ? value.filter((item): item is RuntimeOutputEvent => typeof item === "object" && item != null)
    : [];
}

function normalizeOutput(value: unknown): ConsoleOutputRecord | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.execution_id !== "string"
    || typeof record.runtime_instance_id !== "string"
    || typeof record.code !== "string") return null;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.filter((item): item is ConsoleProjectionBlock => (
      typeof item === "object" && item != null
      && typeof (item as ConsoleProjectionBlock).kind === "string"
      && typeof (item as ConsoleProjectionBlock).text === "string"
    ))
    : projectConsoleEvents(runtimeEvents(record.events));
  return {
    execution_id: record.execution_id,
    runtime_instance_id: record.runtime_instance_id,
    ...(typeof record.run_id === "string" ? { run_id: record.run_id } : {}),
    code: record.code,
    ...(typeof record.started_at === "string" ? { started_at: record.started_at } : {}),
    ...(typeof record.finished_at === "string" || record.finished_at === null
      ? { finished_at: record.finished_at as string | null }
      : {}),
    blocks,
  };
}

function boundHistory(history: readonly string[]): readonly string[] {
  const retained: string[] = [];
  let bytes = 0;
  for (const entry of history.slice(-MAX_CONSOLE_RECORDS).reverse()) {
    const entryBytes = utf8Bytes(entry);
    if (retained.length > 0 && bytes + entryBytes > MAX_CONSOLE_COMMAND_HISTORY_BYTES) break;
    retained.push(entry);
    bytes += entryBytes;
  }
  return retained.reverse();
}

function boundOutputs(
  outputs: readonly ConsoleOutputRecord[],
): { readonly outputs: readonly ConsoleOutputRecord[]; readonly released: number } {
  const candidates = outputs.slice(-MAX_CONSOLE_RECORDS);
  const retained: ConsoleOutputRecord[] = [];
  let bytes = 0;
  for (const output of [...candidates].reverse()) {
    const outputBytes = utf8Bytes(output);
    if (retained.length > 0 && bytes + outputBytes > MAX_CONSOLE_TRANSCRIPT_CACHE_BYTES) break;
    retained.push(output);
    bytes += outputBytes;
  }
  const bounded = retained.reverse();
  return { outputs: bounded, released: outputs.length - bounded.length };
}

function boundBlocksFromStart(blocks: readonly ConsoleProjectionBlock[]): {
  readonly blocks: readonly ConsoleProjectionBlock[];
  readonly omitted: number;
} {
  const retained: ConsoleProjectionBlock[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const blockBytes = utf8Bytes(block);
    if (retained.length > 0 && bytes + blockBytes > MAX_CONSOLE_OUTPUT_WINDOW_BYTES) break;
    retained.push(block);
    bytes += blockBytes;
  }
  return { blocks: retained, omitted: blocks.length - retained.length };
}

function boundBlocksFromEnd(blocks: readonly ConsoleProjectionBlock[]): {
  readonly blocks: readonly ConsoleProjectionBlock[];
  readonly omitted: number;
} {
  const retained: ConsoleProjectionBlock[] = [];
  let bytes = 0;
  for (const block of [...blocks].reverse()) {
    const blockBytes = utf8Bytes(block);
    if (retained.length > 0 && bytes + blockBytes > MAX_CONSOLE_OUTPUT_WINDOW_BYTES) break;
    retained.push(block);
    bytes += blockBytes;
  }
  retained.reverse();
  return { blocks: retained, omitted: blocks.length - retained.length };
}

function runtimeRecord(execution: RuntimeExecution, chunks: readonly RuntimeOutputChunk[]): ConsoleOutputRecord {
  return {
    execution_id: execution.execution_id,
    runtime_instance_id: execution.runtime_instance_id,
    ...(execution.run_id == null ? {} : { run_id: execution.run_id }),
    code: execution.submitted_code,
    started_at: execution.started_at,
    finished_at: execution.finished_at,
    blocks: chunks.map(runtimeOutputChunkBlock),
    status: execution.status,
    output_state: execution.output_state,
    first_sequence: chunks.at(0)?.sequence ?? execution.last_sequence + 1,
    last_sequence: chunks.at(-1)?.sequence ?? 0,
    has_older: (chunks.at(0)?.sequence ?? 1) > 1,
    newer_output_omitted: false,
  };
}

export function initialConsoleState(instance: SurfaceInstance): ConsoleViewState {
  const candidate = instance.view_state;
  if (typeof candidate !== "object" || candidate == null) {
    return {
      draft: "", history: [], history_cursor: null, filter: "", scroll_top: 0,
      follow_tail: true, transcript_start_after: null, read_cursor: null,
      outputs: [], released_output_count: 0,
    };
  }
  const value = candidate as Partial<ConsoleViewState> & { readonly schema_version?: unknown };
  const legacy = value.schema_version !== CONSOLE_VIEW_STATE_VERSION;
  const normalizedOutputs = legacy && Array.isArray(value.outputs)
    ? value.outputs.flatMap((item) => {
      const output = normalizeOutput(item);
      return output == null ? [] : [output];
    })
    : [];
  const boundedOutputs = boundOutputs(normalizedOutputs);
  return {
    draft: legacy && typeof value.draft === "string" ? value.draft : "",
    history: legacy && Array.isArray(value.history)
      ? boundHistory(value.history.filter((item): item is string => typeof item === "string"))
      : [],
    history_cursor: legacy && typeof value.history_cursor === "number" ? value.history_cursor : null,
    filter: typeof value.filter === "string" ? value.filter : "",
    scroll_top: finiteScrollTop(value.scroll_top),
    follow_tail: typeof value.follow_tail === "boolean" ? value.follow_tail : true,
    transcript_start_after: transcriptCursor(value.transcript_start_after),
    read_cursor: readCursor(value.read_cursor),
    outputs: boundedOutputs.outputs,
    released_output_count: boundedOutputs.released,
  };
}

export function consoleTranscriptOutputs(state: ConsoleViewState): readonly ConsoleOutputRecord[] {
  const cursor = state.transcript_start_after;
  if (cursor == null) return state.outputs;
  const exactIndex = state.outputs.findIndex((output) => output.execution_id === cursor.execution_id);
  if (exactIndex >= 0) return state.outputs.slice(exactIndex + 1);
  return state.outputs.filter((output) => output.started_at != null && output.started_at > cursor.started_at);
}

export class ConsoleInstanceController {
  readonly #listeners = new Set<() => void>();
  #ports = EMPTY_PORTS;
  #snapshot: ConsoleInstanceSnapshot;
  #persistTail: Promise<void> = Promise.resolve();
  #frameTail: Promise<void> = Promise.resolve();
  #execution: Promise<void> | null = null;
  #recoveryStarted = false;
  #disposed = false;

  constructor(initialState: ConsoleViewState) {
    this.#snapshot = { state: initialState, running: false };
  }

  readonly getSnapshot = (): ConsoleInstanceSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  configure(ports: ConsoleInstancePorts): void {
    this.#ports = ports;
    if (!this.#recoveryStarted) {
      this.#recoveryStarted = true;
      void this.#recover(ports).catch((cause: unknown) => {
        if (!this.#disposed) ports.reportError(cause);
      });
    }
  }

  replaceState(next: ConsoleViewState): void {
    if (this.#disposed || next === this.#snapshot.state) return;
    this.#publish({ ...this.#snapshot, state: next });
  }

  commit(next: ConsoleViewState): Promise<void> {
    this.replaceState(next);
    return this.#persist(next, this.#ports);
  }

  persistCurrent(): Promise<void> {
    return this.#persist(this.#snapshot.state, this.#ports);
  }

  submit(
    code: string,
    clearDraft: boolean,
    sourceContext?: RuntimeExecutionSourceContext,
  ): ConsoleExecutionAdmission {
    if (!code.trim()) return { accepted: false, message: "Code has no executable content." };
    const ports = this.#ports;
    const runtime = ports.runtime;
    if (runtime == null) {
      return { accepted: false, message: "This Console is not attached to a Runtime." };
    }
    if (this.#snapshot.running || runtime.status === "busy") {
      return { accepted: false, message: `${runtime.display_label} is busy. Wait or stop it before running more code.` };
    }
    if (runtime.status === "restarting" || runtime.status === "starting") {
      return { accepted: false, message: `${runtime.display_label} is recovering. Wait until it is ready.` };
    }
    if (runtime.status !== "ready") {
      return { accepted: false, message: `${runtime.display_label} is ${runtime.status} and cannot run code.` };
    }

    this.#publish({ ...this.#snapshot, running: true });
    this.#execution = this.#execute(ports, runtime, code, clearDraft, sourceContext).finally(() => {
      this.#execution = null;
    });
    return { accepted: true, message: null };
  }

  async settled(): Promise<void> {
    await this.#execution;
    await this.#persistTail.catch(() => undefined);
  }

  async loadOlder(executionId: string): Promise<void> {
    const ports = this.#ports;
    const output = this.#snapshot.state.outputs.find((candidate) => candidate.execution_id === executionId);
    const beforeSequence = output?.first_sequence ?? 0;
    if (output == null || beforeSequence <= 1 || output.has_older === false) return;
    const page = await ports.pageBefore(executionId, beforeSequence);
    if (this.#disposed || page.chunks.length === 0) return;
    const merged = [...page.chunks.map(runtimeOutputChunkBlock), ...output.blocks];
    const bounded = boundBlocksFromStart(merged);
    const outputs = this.#snapshot.state.outputs.map((candidate) => candidate.execution_id === executionId
      ? {
          ...candidate,
          blocks: bounded.blocks,
          first_sequence: page.previous_sequence,
          has_older: page.has_older,
          newer_output_omitted: candidate.newer_output_omitted === true || bounded.omitted > 0,
        }
      : candidate);
    this.replaceState({ ...this.#snapshot.state, outputs, follow_tail: false });
  }

  async loadLatest(executionId: string): Promise<void> {
    const ports = this.#ports;
    const output = this.#snapshot.state.outputs.find((candidate) => candidate.execution_id === executionId);
    if (output == null) return;
    const committedThrough = output.last_sequence ?? 0;
    const page = committedThrough > 0
      ? await ports.pageBefore(executionId, committedThrough + 1)
      : null;
    if (this.#disposed) return;
    const outputs = this.#snapshot.state.outputs.map((candidate) => candidate.execution_id === executionId
      ? {
          ...candidate,
          blocks: page?.chunks.map(runtimeOutputChunkBlock) ?? [],
          first_sequence: page?.previous_sequence ?? committedThrough + 1,
          has_older: page?.has_older ?? false,
          newer_output_omitted: false,
        }
      : candidate);
    this.replaceState({ ...this.#snapshot.state, outputs, follow_tail: true });
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #execute(
    ports: ConsoleInstancePorts,
    runtime: RuntimeDescriptor,
    code: string,
    clearDraft: boolean,
    sourceContext?: RuntimeExecutionSourceContext,
  ): Promise<void> {
    try {
      const admitted = await ports.start(runtime, code, sourceContext);
      if (this.#disposed) return;
      const current = this.#snapshot.state;
      const nextOutputs = boundOutputs([...current.outputs, {
        execution_id: admitted.execution.execution_id,
        runtime_instance_id: admitted.execution.runtime_instance_id,
        code,
        started_at: admitted.execution.started_at,
        finished_at: admitted.execution.finished_at,
        blocks: [],
        status: admitted.execution.status,
        output_state: admitted.execution.output_state,
        first_sequence: admitted.committed_through + 1,
        last_sequence: admitted.committed_through,
        has_older: false,
        newer_output_omitted: false,
      }]);
      const nextState = {
        ...current,
        draft: clearDraft ? "" : current.draft,
        history: boundHistory([...current.history, code]),
        history_cursor: null,
        outputs: nextOutputs.outputs,
        released_output_count: current.released_output_count + nextOutputs.released,
      };
      this.replaceState(nextState);
      await this.#persist(nextState, ports);
      await ports.follow(
        admitted.execution.execution_id,
        admitted.committed_through,
        (frame) => this.#enqueueFrame(frame, ports),
      );
      await this.#frameTail;
    } catch (cause: unknown) {
      if (!this.#disposed) ports.reportError(cause);
    } finally {
      if (!this.#disposed) this.#publish({ ...this.#snapshot, running: false });
    }
  }

  #enqueueFrame(frame: RuntimeOutputFollowFrame, ports: ConsoleInstancePorts): void {
    this.#frameTail = this.#frameTail
      .catch(() => undefined)
      .then(() => this.#applyFrame(frame, ports))
      .catch((cause: unknown) => {
        if (!this.#disposed) ports.reportError(cause);
      });
  }

  #lastSequence(executionId: string): number {
    return this.#snapshot.state.outputs.find((output) => output.execution_id === executionId)?.last_sequence ?? 0;
  }

  #appendChunks(executionId: string, chunks: readonly RuntimeOutputChunk[]): void {
    if (this.#disposed || chunks.length === 0) return;
    const outputs = this.#snapshot.state.outputs.map((output) => {
      if (output.execution_id !== executionId) return output;
      let lastSequence = output.last_sequence ?? 0;
      const appended: RuntimeOutputChunk[] = [];
      for (const chunk of chunks) {
        if (chunk.sequence <= lastSequence) continue;
        if (chunk.sequence !== lastSequence + 1) {
          throw new Error(`Runtime output is missing sequence ${lastSequence + 1}.`);
        }
        appended.push(chunk);
        lastSequence = chunk.sequence;
      }
      if (appended.length === 0) return output;
      const combined = [...output.blocks, ...appended.map(runtimeOutputChunkBlock)];
      const bounded = output.newer_output_omitted === true
        ? { blocks: output.blocks, omitted: 0 }
        : boundBlocksFromEnd(combined);
      return {
        ...output,
        blocks: bounded.blocks,
        first_sequence: bounded.omitted > 0
          ? Math.max(1, lastSequence - bounded.blocks.length + 1)
          : output.first_sequence ?? appended[0]?.sequence ?? 1,
        has_older: output.has_older === true || bounded.omitted > 0,
        last_sequence: lastSequence,
      };
    });
    this.replaceState({ ...this.#snapshot.state, outputs });
  }

  async #repairGap(
    executionId: string,
    committedThrough: number,
    ports: ConsoleInstancePorts,
  ): Promise<void> {
    let cursor = this.#lastSequence(executionId);
    for (let pageCount = 0; cursor < committedThrough && pageCount < 100; pageCount += 1) {
      const page = await ports.page(executionId, cursor);
      if (this.#disposed) return;
      const chunks = page.chunks.filter((chunk) => chunk.sequence > cursor);
      if (chunks.length === 0) {
        throw new Error(`Runtime output gap after sequence ${cursor} could not be repaired from durable History.`);
      }
      if (chunks[0]!.sequence !== cursor + 1) {
        throw new Error(`Runtime output History is missing sequence ${cursor + 1}.`);
      }
      this.#appendChunks(executionId, chunks);
      const next = this.#lastSequence(executionId);
      if (next <= cursor) throw new Error("Runtime output gap repair made no progress.");
      cursor = next;
      if (!page.has_more && cursor < committedThrough) {
        throw new Error(`Runtime output History stopped at sequence ${cursor}; ${committedThrough} was committed.`);
      }
    }
    if (cursor < committedThrough) {
      throw new Error("Runtime output gap repair exceeded its bounded page budget.");
    }
  }

  async #applyFrame(
    frame: RuntimeOutputFollowFrame,
    ports: ConsoleInstancePorts,
  ): Promise<void> {
    if (this.#disposed) return;
    const currentOutput = this.#snapshot.state.outputs.find((output) => output.execution_id === frame.execution_id);
    if (currentOutput == null) return;
    if (frame.type === "admitted") {
      const outputs = this.#snapshot.state.outputs.map((output) => output.execution_id === frame.execution_id
        ? { ...output, status: frame.execution.status, output_state: frame.execution.output_state }
        : output);
      this.replaceState({ ...this.#snapshot.state, outputs });
      return;
    }
    if (frame.type === "gap") {
      await this.#repairGap(frame.execution_id, frame.committed_through, ports);
      return;
    }
    if (frame.type === "checkpoint") {
      if (frame.committed_through > this.#lastSequence(frame.execution_id)) {
        await this.#repairGap(frame.execution_id, frame.committed_through, ports);
      }
      return;
    }
    if (frame.type === "chunks") {
      const lastSequence = this.#lastSequence(frame.execution_id);
      if (frame.first_sequence > lastSequence + 1) {
        await this.#repairGap(frame.execution_id, frame.first_sequence - 1, ports);
      }
      this.#appendChunks(frame.execution_id, frame.chunks);
      return;
    }
    if (frame.committed_through > this.#lastSequence(frame.execution_id)) {
      await this.#repairGap(frame.execution_id, frame.committed_through, ports);
    }
    const outputs = this.#snapshot.state.outputs.map((output) => output.execution_id === frame.execution_id
      ? {
          ...output,
          ...(frame.execution.run_id == null ? {} : { run_id: frame.execution.run_id }),
          status: frame.execution.status,
          output_state: frame.execution.output_state,
          finished_at: frame.execution.finished_at,
          last_sequence: frame.committed_through,
        }
      : output);
    this.#publish({ state: { ...this.#snapshot.state, outputs }, running: false });
  }

  async #recover(ports: ConsoleInstancePorts): Promise<void> {
    const executions = await ports.list();
    const recovered: ConsoleOutputRecord[] = [];
    for (const execution of [...executions].reverse()) {
      if (this.#disposed) return;
      const page = execution.last_sequence > 0
        ? await ports.pageBefore(execution.execution_id, execution.last_sequence + 1)
        : null;
      const record = runtimeRecord(execution, page?.chunks ?? []);
      recovered.push({
        ...record,
        ...(page == null ? {} : { first_sequence: page.previous_sequence }),
        has_older: page?.has_older ?? false,
      });
    }
    if (this.#disposed || recovered.length === 0) return;
    const current = this.#snapshot.state;
    const liveIds = new Set(current.outputs.map((output) => output.execution_id));
    const merged = boundOutputs([
      ...recovered.filter((output) => !liveIds.has(output.execution_id)),
      ...current.outputs,
    ]);
    this.replaceState({
      ...current,
      outputs: merged.outputs,
      released_output_count: current.released_output_count + merged.released,
    });
    const active = executions.find((execution) => ["admitted", "running"].includes(execution.status));
    if (active != null) {
      this.#publish({ ...this.#snapshot, running: true });
      this.#execution = ports.follow(
        active.execution_id,
        this.#lastSequence(active.execution_id),
        (frame) => this.#enqueueFrame(frame, ports),
      ).then(() => this.#frameTail).catch((cause: unknown) => {
        if (!this.#disposed) ports.reportError(cause);
      }).finally(() => {
        if (!this.#disposed) this.#publish({ ...this.#snapshot, running: false });
        this.#execution = null;
      });
    }
  }

  #persist(state: ConsoleViewState, ports: ConsoleInstancePorts): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const task = this.#persistTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.#disposed) await ports.persist(consolePersistentViewState(state));
      });
    this.#persistTail = task;
    return task.catch((cause: unknown) => {
      if (!this.#disposed) ports.reportError(cause);
    });
  }

  #publish(snapshot: ConsoleInstanceSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
