import { projectPath, commandFiles, buildWorkGraph } from './work-graph.js';
import { notesInstructions, projectNotesPath } from './project-notes.js';
import { addSpend, describeLimits, describable, fileFacts, figureContext, raster, type Cost, type FileDescription, type MadeStep, type Spend, type Strategy } from './file-describer.js';
import { toolActivity } from './conversation-presentation.js';
import {privateEvidencePath, type CapturePort, type TurnEvidence} from './evidence-capture.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConversation, AgentPermission, ConversationStep, ConversationEvent, ClaudeAcpOptions, CodexAcpOptions, SessionObservation, ConfigOption, ClaudeAcpConversation } from '@rho-workspace/plugin-agent/conversation';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, canonical, digest, Fault, now, readJson, requireThat } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';

// Rho holds user messages and their original identities. The selected Agent plugin
// owns the connection, native session and protocol. Reads never start a driver.
export const conversationLimits = {
  // Conversations kept per project, not counting the trash; starting or restoring another is
  // refused. The trash keeps as many again; past that, moving one there is refused.
  maxConversations: 64,
  // Deleted conversations remembered by request identity, so repeating the request that
  // started one is refused rather than started again; past this the oldest are forgotten.
  maxDeleted: 256,
  // Messages kept per conversation; sending another is refused.
  maxTurns: 200,
  // A person's decisions kept on one answer, each superseding the one before; past this one more is refused.
  maxDecisions: 32,
  // One message from the person, in UTF-8 bytes.
  maxMessageBytes: 16384,
  // One conversation record on disk; past it, new messages are refused.
  maxRecordBytes: 8388608,
  // One session projection, independent of turn retention; an oversized update
  // closes observation and preserves the last retained projection.
  maxObservationBytes: 524288,
  // Text and tool steps kept for one message; later ones are counted, not kept.
  maxTurnBytes: 262144,
  // One kept text block; a longer one keeps its start and says it was cut.
  maxTextBytes: 65536,
  // Messages being answered at once by this service; another is refused until one ends.
  maxRunning: 4,
  // Owned connections, including idle ones; evict an idle connection or refuse.
  maxConnections: 4, idleMs: 300000, connectTimeoutMs: 60000,
  // Permission requests kept per message; later requests are declined.
  maxPermissions: 32,
  // Claude Code's own step limit (--max-turns) for one message.
  maxAgentTurns: 64,
  // One message's wall time; past it cancellation is requested, then confirmed or unknown.
  turnWallMs: 1800000,
  // What Claude Code may write for one message, and in one record; past either it is stopped.
  maxOutputBytes: 33554432, maxLineBytes: 4194304,
  // Between asking a process to stop and forcing it.
  stopGraceMs: 5000,
  // Settings chosen for one Agent or one conversation, and the length of one chosen value;
  // more are refused.
  maxChoices: 12, maxChoiceChars: 512,
  // Files compared on disk before and after a message, to record which changed during it; past
  // this many the comparison stops and the record says it is partial. Changes kept per message;
  // more are counted.
  maxComparedFiles: 20000, maxChangedFiles: 200, maxCaptureFiles: 64, maxCaptureBytes: 33554432, maxSnapshotBytes: 8388608, maxCaptureConcurrent: 2
};
type StopReason = 'person' | 'closing' | 'wall-limit' | 'output-limit' | 'line-limit' | 'identity';
// A tool step also keeps when it started (see observe); its `at` is its latest report.
type Step = ConversationStep & { startedAt?: string };
interface Permission extends AgentPermission { state: 'pending' | 'selected' | 'cancelled'; selected?: string }
export interface ConversationConfig { settingsFile?: string; backend?: 'claude-acp' | 'codex-acp' | 'claude-cli'; codex?: string; codexAcp?: Omit<CodexAcpOptions, 'cwd' | 'mcpServers' | 'limits' | 'sessionId' | 'codex' | 'observation' | 'observe'>; claudeAcp?: Omit<ClaudeAcpOptions, 'cwd' | 'mcpServers' | 'limits' | 'sessionId' | 'claude' | 'observation' | 'observe'> }
interface Turn {
  id: string; changeId: string; requestDigest: string; by: string; text: string; sentAt: string;
  state: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'; startedAt: string | null; endedAt: string | null; pid: number | null; model: string | null;
  stop: { requestedAt: string; by: string; reason: StopReason } | null; exit: { code: number | null; signal: string | null } | null;
  steps: Step[]; omitted: number; retry: { attempt: number | null; of: number | null; status: number | null; at: string } | null;
  result: { isError: boolean; kind: string | null; reason: string | null; steps: number | null; durationMs: number | null; costUsd: number | null; message: string | null } | null;
  problem: string | null; permissions?: Permission[];
  // Project files that changed on disk between the message's start and end, compared by time and
  // size. It says what changed meanwhile, not what made the change.
  files?: { changed: FileChange[]; omitted: number; partial: boolean };
  evidence?: TurnEvidence;
  // What the files it wrote hold, read while it ran (see file-describer.ts); files past the
  // limit are counted.
  descriptions?: FileDescription[]; descriptionsOmitted?: number; descriptionSpend?: Spend;
  contexts?: string[];
  decisions?: Decision[];
}
// The person's word on an answer: use it, or it needs changes and why. It holds for the file
// versions this message kept when it was given, and says nothing of later versions. Each new
// decision supersedes the one before; none is removed.
interface Decision { changeId: string; requestDigest: string; decision: 'accepted' | 'needs-changes'; note: string | null; by: string; at: string; supersedes: string | null; results: Array<{ path: string; resource: { id: string; version: string } }> }
interface FileChange { path: string; change: 'added' | 'modified' | 'removed'; modifiedAt: string | null; bytes: number | null }
interface Disk { files: Map<string, { modified: number; bytes: number }>; partial: boolean }
// A file's first bytes and the digest of all of it, the version they belong to.
async function readHead(file: string, maxBytes: number, maxDigestBytes: number) {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    if ((await handle.stat()).size > maxDigestBytes) return null;
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024), head: Buffer[] = [];
    let bytes = 0, kept = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (!bytesRead) break;
      const part = chunk.subarray(0, bytesRead); hash.update(part); bytes += bytesRead;
      if (kept < maxBytes) { const take = part.subarray(0, maxBytes - kept); head.push(Buffer.from(take)); kept += take.length; }
    }
    return { data: Buffer.concat(head), bytes, version: hash.digest('hex') };
  } finally { await handle.close(); }
}
// The project's files, without Rho's own state or Git's, up to a limit.
async function disk(root: string, limit: number): Promise<Disk> {
  const files: Disk['files'] = new Map(), folders = [''];
  while (folders.length) {
    const folder = folders.shift()!;
    const names = (await fs.readdir(path.join(root, folder)).catch(() => [] as string[])).filter(name => !['.rho', '.git', '.DS_Store'].includes(name)).sort();
    const stats = await Promise.all(names.map(name => fs.lstat(path.join(root, folder, name)).catch(() => null)));
    for (const [index, stat] of stats.entries()) {
      const relative = (folder ? folder + '/' : '') + names[index];
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) folders.push(relative);
      else if (stat.isFile()) {
        if (files.size >= limit) return { files, partial: true };
        files.set(relative, { modified: stat.mtimeMs, bytes: stat.size });
      }
    }
  }
  return { files, partial: false };
}
function compare(before: Disk, after: Disk, limit: number): NonNullable<Turn['files']> {
  const changed: FileChange[] = [], partial = before.partial || after.partial;
  for (const [file, now] of after.files) {
    const was = before.files.get(file);
    if (!was && partial) continue;
    if (!was || was.modified !== now.modified || was.bytes !== now.bytes) changed.push({ path: file, change: was ? 'modified' : 'added', modifiedAt: new Date(now.modified).toISOString(), bytes: now.bytes });
  }
  if (!partial) for (const file of before.files.keys()) if (!after.files.has(file)) changed.push({ path: file, change: 'removed', modifiedAt: null, bytes: null });
  changed.sort((a, b) => (a.modifiedAt ?? '\uffff').localeCompare(b.modifiedAt ?? '\uffff') || a.path.localeCompare(b.path));
  return { changed: changed.slice(0, limit), omitted: Math.max(0, changed.length - limit), partial };
}
interface Conversation {
  format: 1 | 2; backend?: 'claude-acp' | 'codex-acp' | 'claude-cli'; acpSessionId?: string; adapter?: { name: string; version?: string }; protocolVersion?: number; id: string; changeId: string; requestDigest: string; createdAt: string; createdBy: string; updatedAt: string; version: number;
  client: 'claude-code' | 'codex'; nativeSessionId: string | null; confirmed: boolean; principal: string | null; title: string; turns: Turn[];
  observation?: SessionObservation;
  // The person's choices among the settings this conversation's Agent offers, applied each
  // time its session is opened.
  config?: Choices;
  // Moved to the trash by the person: kept whole, not listed with the project's conversations,
  // and not continued until restored.
  trashedAt?: string | null; trashedBy?: string | null;
}
type Backend = 'claude-acp' | 'codex-acp';
const backends: Backend[] = ['claude-acp', 'codex-acp'];
type Choices = Record<string, string | boolean>;
// What one Agent offered when a session last opened without the person's choices: a check
// (an explicit action that starts the Agent and sends nothing) or a conversation's first session.
interface Offered { at: string; source: 'check' | 'conversation'; adapter: { name: string; version?: string } | null; options: ConfigOption[]; omitted: number }
// The person's Agent and settings for new conversations, kept by this service for every project.
// `describe`: whether a model describes the files a message writes (on unless switched off).
interface AgentSettings { format: 1; version: number; updatedAt: string | null; backend: Backend | null; choices: Partial<Record<Backend, Choices>>; offered: Partial<Record<Backend, Offered>>; describe?: { enabled: boolean } }
const blankSettings = (): AgentSettings => ({ format: 1, version: 0, updatedAt: null, backend: null, choices: {}, offered: {} });
type AcpDriver = Pick<ClaudeAcpConversation, 'configure' | 'inspect' | 'connected'>;
const acpDriver = (driver: AgentConversation | undefined): driver is AgentConversation & AcpDriver => !!driver && 'configure' in driver;
interface Summary {
  conversationId: string; changeId: string; requestDigest: string; title: string; client: string; principal: string | null; createdAt: string; updatedAt: string; version: number; turns: number; state: string; lastAt: string;
  // What a list shows without reading each record: the Agent's own name for the session, the
  // Agent and its adapter, the last model, the person's choices, what the session reported
  // using and costing, its session identity and whether it is in the trash.
  listed?: 1; backend?: string; agentTitle?: string | null; adapter?: { name: string; version?: string } | null; model?: string | null; config?: Choices;
  usage?: { used: number; size: number; cost: { amount: number; currency: string } | null } | null; costUsd?: number | null; sessionId?: string | null; trashedAt?: string | null;
}
interface Index { format: 1; conversations: Summary[]; deleted?: Array<{ conversationId: string; changeId: string; requestDigest: string; deletedAt: string; deletedBy: string }> }
interface Live { project: Project; conversation: Conversation; turn: Turn; controller: AbortController; stop(reason: StopReason, by: string): void; done: Promise<void>; before?: Disk | null; captures?: Promise<void>[]; attempts?: number; seen?: Map<string, string>; tried?: Set<string>;
  // Describing the files it writes: the check under way, when each file was last given to the
  // model, how many times the model was asked, what a model is given of each file, and the
  // files counted past the limit.
  describing?: Promise<void>; asked?: Map<string, number>; calls?: number; shown?: Map<string, { version: string; excerpt: string; textual: boolean }>; uncounted?: Set<string>;
  // The model that wrote the first sentence when the conversation named none, and why its
  // figures are no longer sent as images.
  describer?: string; noImages?: string }
export interface ConversationPorts {
  // The project's Agent grant for this conversation, written to a private connection file.
  grant(project: Project, conversation: { id: string; title: string; client: string }): Promise<{ file: string; principal: string }>;
  directory(project: Project): Promise<string>;
  changed(project: Project, conversationId: string): Promise<void>;
  // Local Claude Code plugin directories a Claude session loads: skills and hooks of the selected plugins.
  claudePlugins?(project: Project): Promise<string[]>;
  capture?: CapturePort;
  context?(project: Project, contextId: string): Promise<unknown>;
  // One sentence on what a file holds, from the model the conversation's Agent uses, and what
  // models.dev lists about that model.
  describe?(project: Project, request: DescribeRequest): Promise<{ text: string; model: string | null; cost: Cost }>;
  modelFacts?(model: string): Promise<{ images: boolean; listed: string } | null>;
  // Whether the project's live R and Python sessions are selected, which the session is told about.
  notebook?(): boolean;
}
export interface DescribeRequest {
  path: string; facts: string; request: string; model: string | null; strategy: Strategy;
  excerpt?: string; context?: string; image?: { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: Buffer };
}
const identity = /^c-[a-f0-9]{16}$/;
function cut(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return { text };
  // Cut on a character boundary; the cut is reported, never silent.
  return { text: Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/�+$/, ''), cut: true };
}
function titleOf(text: string) { const line = text.trim().split('\n')[0].trim(); return line.length > 80 ? line.slice(0, 79) + '…' : line; }

export class Conversations {
  limits: typeof conversationLimits;
  private live = new Map<string, Live>();
  private queues = new Map<string, Promise<unknown>>();
  private flushes = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  private drivers = new Map<string, { driver: AgentConversation; project: Project; conversation: Conversation; timer?: ReturnType<typeof setTimeout> }>();
  private permissions = new Map<string, { permission: Permission; resolve(choice: string | null): void }>();
  private checks = new Map<Backend, Promise<void>>();
  // Descriptions being written by a model now, by project, conversation, message and file.
  private writing = new Set<string>();
  describing = { ...describeLimits };
  constructor(private ports: ConversationPorts, public binary = 'claude', limits: Partial<typeof conversationLimits> = {}, private config: ConversationConfig = {}) {
    this.limits = { ...conversationLimits, ...limits };
    for (const key of ['maxCaptureFiles','maxCaptureBytes','maxSnapshotBytes','maxCaptureConcurrent'] as const) requireThat(Number.isSafeInteger(this.limits[key]) && this.limits[key]>0 && this.limits[key]<=conversationLimits[key], 'invalid', 'Capture budgets must be positive integers no greater than the supported defaults.', {limit:key,maximum:conversationLimits[key]});
    requireThat(!config.backend || ['claude-acp', 'codex-acp', 'claude-cli'].includes(config.backend), 'invalid', 'Choose claude-acp, codex-acp or claude-cli.');
  }

  private serial<T>(key: string, run: () => Promise<T>) {
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(key, task);
    return task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }
  private async folder(project: Project) {
    const directory = path.join(await this.ports.directory(project), 'conversations');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); return directory;
  }
  private async index(project: Project) {
    return readJson<Index>(path.join(await this.folder(project), 'index.json'), { format: 1, conversations: [] });
  }
  private async load(project: Project, id: string): Promise<Conversation> {
    requireThat(identity.test(id), 'not_found', 'No conversation has that identity in this project.');
    for (const live of this.live.values()) if (live.project.id === project.id && live.conversation.id === id) return live.conversation;
    const retained = this.drivers.get(project.id + '/' + id);
    if (retained) return retained.conversation;
    const file = path.join(await this.folder(project), id + '.json');
    const stat = await fs.stat(file).catch((e: any) => { if (e.code === 'ENOENT') throw new Fault('not_found', 'No conversation has that identity in this project.'); throw e; });
    requireThat(stat.size <= this.limits.maxRecordBytes + 1048576, 'limit', 'This conversation record is larger than Rho reads; it is kept as it is.', { limit: 'maxRecordBytes' });
    const value = await readJson<Conversation>(file);
    requireThat([1, 2].includes(value?.format) && value.id === id && Array.isArray(value.turns), 'storage', 'This conversation record is unreadable; it is kept as it is.');
    return value;
  }
  private summary(c: Conversation): Summary {
    const last = c.turns.at(-1), usage = c.observation?.usage;
    const costs = c.turns.map(t => t.result?.costUsd).filter((v): v is number => typeof v === 'number');
    return { conversationId: c.id, changeId: c.changeId, requestDigest: c.requestDigest, title: c.title, client: c.client, principal: c.principal, createdAt: c.createdAt, updatedAt: c.updatedAt, version: c.version, turns: c.turns.length, state: last?.state ?? 'idle', lastAt: last?.endedAt ?? last?.sentAt ?? c.createdAt,
      listed: 1, backend: c.backend ?? 'claude-cli', agentTitle: c.observation?.info?.title ?? null, adapter: c.adapter ?? null, model: [...c.turns].reverse().find(t => t.model)?.model ?? null, config: c.config ?? {},
      usage: usage ? { used: usage.used, size: usage.size, cost: usage.cost ?? null } : null, costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      sessionId: c.acpSessionId ?? c.nativeSessionId ?? null, trashedAt: c.trashedAt ?? null };
  }
  private async write(project: Project, c: Conversation) {
    const directory = await this.folder(project);
    c.version++; c.updatedAt = now();
    await atomicJson(path.join(directory, c.id + '.json'), c);
    const index = await this.index(project);
    await atomicJson(path.join(directory, 'index.json'), { ...index, conversations: [...index.conversations.filter(x => x.conversationId !== c.id), this.summary(c)] });
    await this.ports.changed(project, c.id).catch(() => {});
  }
  private schedule(project: Project, c: Conversation) {
    const key = project.id + '/' + c.id;
    if (this.flushes.has(key)) return;
    const timer = setTimeout(() => { this.flushes.delete(key); void this.serial(project.id, () => this.write(project, c)).catch(() => {}); }, 250);
    timer.unref(); this.flushes.set(key, timer);
  }
  private liveTurn(project: Project, c: Conversation, turn: Turn) { const live = this.live.get(project.id + '/' + c.id + '/' + turn.id); return live?.turn === turn ? live : undefined; }
  // A message recorded as running that this service is not answering was being answered when
  // Rho last stopped. What Claude Code did after the last kept step is not known, and nothing
  // is sent again on its behalf.
  private view(project: Project, c: Conversation, turn: Turn) {
    const lost = turn.descriptions?.some(d => d.state === 'describing' && !this.writing.has(project.id + '/' + c.id + '/' + turn.id + '/' + d.path));
    if (lost) turn = { ...turn, descriptions: turn.descriptions!.map(d => d.state === 'describing' && !this.writing.has(project.id + '/' + c.id + '/' + turn.id + '/' + d.path) ? { ...d, state: 'unknown' as const, reason: 'Rho stopped before the description arrived.' } : d) };
    if (turn.state !== 'running' || this.liveTurn(project, c, turn)) return !this.liveTurn(project,c,turn) && turn.evidence?.records.some(r => r.state === 'pending') ? { ...turn, evidence: { ...turn.evidence, records: turn.evidence.records.map(r => r.state === 'pending' ? { ...r, state: 'interrupted' as const, reason: 'Rho stopped before the capture was confirmed.' } : r) } } : turn;
    return { ...turn, permissions: turn.permissions?.map(p => p.state === 'pending' ? { ...p, state: 'cancelled' as const } : p), evidence: turn.evidence ? { ...turn.evidence, records: turn.evidence.records.map(r => r.state === 'pending' ? { ...r, state: 'interrupted' as const, reason: 'Rho stopped before this capture was confirmed.' } : r) } : undefined, state: 'unknown' as const, problem: turn.problem ?? 'Rho stopped before this message was answered. Steps after the last one shown are not known, and the message was not sent again.' };
  }
  private reply(project: Project, c: Conversation, turn: Turn) { return { conversation: this.listed(project, this.summary(c)), turn: this.view(project, c, turn) }; }
  private listed(project: Project, s: Summary) {
    const live = [...this.live.values()].some(x => x.project.id === project.id && x.conversation.id === s.conversationId);
    const { changeId, requestDigest, listed, ...shown } = s;
    return { ...shown, state: s.state === 'running' && !live ? 'unknown' : s.state };
  }
  private message(text: string) {
    requireThat(typeof text === 'string' && text.trim().length > 0, 'invalid', 'Write a message first.');
    requireThat(Buffer.byteLength(text) <= this.limits.maxMessageBytes, 'limit', `A message holds at most ${this.limits.maxMessageBytes} bytes.`, { limit: 'maxMessageBytes', maximum: this.limits.maxMessageBytes });
    return text;
  }
  private capacity() {
    requireThat(!this.closing, 'unavailable', 'Rho is closing. Nothing was sent.');
    requireThat(this.live.size < this.limits.maxRunning, 'limit', `Agents are already answering ${this.live.size} messages here. Wait for one to finish.`, { limit: 'maxRunning', maximum: this.limits.maxRunning });
  }
  private turn(changeId: string, requestDigest: string, by: string, text: string, index: number): Turn {
    return { id: 't' + index, changeId, requestDigest, by, text, sentAt: now(), state: 'running', startedAt: null, endedAt: null, pid: null, model: null, stop: null, exit: null, steps: [], omitted: 0, retry: null, result: null, problem: null };
  }

  // The project's conversations, or those in its trash.
  async list(project: Project, input: { trashed?: boolean } = {}) {
    let index = await this.index(project);
    if (index.conversations.some(s => !s.listed)) index = await this.serial(project.id, () => this.relist(project));
    return index.conversations.filter(s => !!s.trashedAt === !!input.trashed).map(s => this.listed(project, s)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  // Summaries written before lists carried their fields are rebuilt from the records once.
  private async relist(project: Project) {
    const index = await this.index(project);
    if (!index.conversations.some(s => !s.listed)) return index;
    const conversations = await Promise.all(index.conversations.map(async s => s.listed ? s
      : await this.load(project, s.conversationId).then(c => this.summary(c), () => ({ ...s, listed: 1 as const }))));
    const next = { ...index, conversations };
    await atomicJson(path.join(await this.folder(project), 'index.json'), next);
    return next;
  }
  async reviewEvidence(project: Project, annotationId: string) {
    const list = await this.list(project), turns: any[] = [], selected: any[] = []; let omitted = Math.max(0,list.length - 6);
    for (const summary of list.slice(0,6)) {
      const c = await this.load(project,summary.conversationId); omitted += Math.max(0,c.turns.length - 8);
      for (const turn of c.turns.slice(-8)) for (const contextId of turn.contexts ?? []) {
        const context = await this.ports.context?.(project,contextId) as any;
        if (context?.annotations?.some((a:any)=>a.annotationId === annotationId)) { turns.push({ conversationId:c.id,turnId:turn.id,contexts:turn.contexts,evidence:this.view(project,c,turn).evidence ?? null }); selected.push({conversationId:c.id,conversationTitle:c.title,agent:c.backend,turn:this.view(project,c,turn)}); break; }
      }
    }
    const graph=buildWorkGraph({turns:selected,files:[],project,kindOf:()=>null,now:Date.now()});
    const model={nodes:graph.nodes.map(n=>({id:n.id,kind:n.kind,...(n.path?{path:n.path}:{}),...(n.resource?{resource:n.resource,capturedAt:n.capturedAt}:{}),...(n.gap?{gap:n.gap}:{})})),edges:graph.edges.map(e=>({from:e.from,to:e.to,label:e.label,basis:e.basis,at:e.at})),omittedTurns:graph.omittedTurns,omittedNodes:graph.omittedNodes??0};
    return {turns,omitted,model};
  }
  // Moving a conversation to the trash keeps it whole and frees its place among the project's
  // conversations; it cannot be continued until restored. An idle connection to its Agent ends.
  async trash(project: Project, by: string, input: { conversationId: string }) {
    const result = await this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId);
      if (c.trashedAt) return { conversation: this.listed(project, this.summary(c)) };
      requireThat(![...this.live.values()].some(x => x.project.id === project.id && x.conversation.id === c.id), 'conflict', 'The Agent is answering in this conversation. Stop it before moving the conversation to the trash.');
      const index = await this.index(project);
      requireThat(index.conversations.filter(s => s.trashedAt).length < this.limits.maxConversations, 'limit', `The trash keeps at most ${this.limits.maxConversations} conversations. Delete some there first.`, { limit: 'maxConversations', maximum: this.limits.maxConversations });
      c.trashedAt = now(); c.trashedBy = by;
      await this.write(project, c);
      return { conversation: this.listed(project, this.summary(c)) };
    });
    const key = project.id + '/' + input.conversationId;
    if (this.drivers.has(key)) await this.serial('driver-pool', () => this.retire(key)).catch(() => {});
    return result;
  }
  async restore(project: Project, input: { conversationId: string }) {
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId);
      if (!c.trashedAt) return { conversation: this.listed(project, this.summary(c)) };
      const index = await this.index(project);
      requireThat(index.conversations.filter(s => !s.trashedAt).length < this.limits.maxConversations, 'limit', `This project keeps at most ${this.limits.maxConversations} conversations started in Rho. Move one to the trash first.`, { limit: 'maxConversations', maximum: this.limits.maxConversations });
      c.trashedAt = null; c.trashedBy = null;
      await this.write(project, c);
      return { conversation: this.listed(project, this.summary(c)) };
    });
  }
  // Deleting removes Rho's record of a conversation in the trash. The Agent's own copy of the
  // session (Claude Code's or Codex's files) is theirs and stays. The request that started it is
  // remembered, so repeating it is refused rather than starting the conversation again.
  async delete(project: Project, by: string, input: { conversationId: string }) {
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId);
      requireThat(c.trashedAt, 'conflict', 'Move the conversation to the trash before deleting it.');
      requireThat(!this.drivers.has(project.id + '/' + c.id), 'conflict', 'Rho is still closing this conversation\'s Agent. Try again in a moment.');
      const directory = await this.folder(project), index = await this.index(project);
      const deleted = [...(index.deleted ?? []), { conversationId: c.id, changeId: c.changeId, requestDigest: c.requestDigest, deletedAt: now(), deletedBy: by }].slice(-this.limits.maxDeleted);
      await atomicJson(path.join(directory, 'index.json'), { ...index, conversations: index.conversations.filter(x => x.conversationId !== c.id), deleted });
      await fs.rm(path.join(directory, c.id + '.json'), { force: true });
      await this.ports.changed(project, c.id).catch(() => {});
      return { conversationId: c.id, deleted: true as const };
    });
  }
  async read(project: Project, input: { conversationId: string; before?: number; limit?: number }) {
    const c = await this.load(project, input.conversationId);
    const end = Math.min(input.before ?? c.turns.length, c.turns.length), start = Math.max(0, end - (input.limit ?? 50));
    return { conversation: this.listed(project, this.summary(c)), observation: this.sessionObservation(project, c), config: c.config ?? {}, first: start, turns: c.turns.slice(start, end).map(t => this.view(project, c, t)) };
  }
  private sessionObservation(project: Project, c: Conversation): SessionObservation | null {
    return c.observation ? { ...c.observation, connected: !!this.drivers.get(project.id + '/' + c.id)?.driver.connected } : null;
  }
  async work(project: Project, limit = 8) {
    const list = await this.list(project), sessions = [];
    for (const summary of list.slice(0, limit)) {
      const c = await this.load(project, summary.conversationId);
      sessions.push({ ...this.listed(project, this.summary(c)), backend: c.backend ?? 'claude-cli', sessionId: c.acpSessionId ?? c.nativeSessionId, observation: this.sessionObservation(project, c) });
    }
    return { sessions, omitted: Math.max(0, list.length - sessions.length) };
  }
  // The caller holds the request identity: a repeat with the same words returns the original
  // conversation or message and starts nothing; changed words under that identity are refused.
  // Without an Agent or settings named in the request, the person's saved ones are used and
  // recorded with the conversation.
  async start(project: Project, by: string, input: { changeId: string; text: string; contexts?: string[]; backend?: Backend; config?: Choices }) {
    requireThat(!input.backend || backends.includes(input.backend), 'invalid', 'Choose Claude Code or Codex.');
    if (input.config) this.choices(input.config);
    const text = this.message(input.text), requestDigest = digest(canonical({ text, ...(input.contexts?.length ? { contexts: input.contexts } : {}), ...(input.backend ? { backend: input.backend } : {}), ...(input.config ? { config: input.config } : {}) }));
    return this.serial(project.id, async () => {
      const index = await this.index(project), existing = index.conversations.find(x => x.changeId === input.changeId);
      requireThat(!index.deleted?.some(x => x.changeId === input.changeId), 'conflict', 'That request started a conversation that was later deleted. It is not started again.');
      if (existing) {
        requireThat(existing.requestDigest === requestDigest, 'conflict', 'That request identity already started a different conversation.');
        const c = await this.load(project, existing.conversationId); return this.reply(project, c, c.turns[0]);
      }
      requireThat(index.conversations.filter(x => !x.trashedAt).length < this.limits.maxConversations, 'limit', `This project keeps at most ${this.limits.maxConversations} conversations started in Rho. Move one to the trash to start another.`, { limit: 'maxConversations', maximum: this.limits.maxConversations });
      this.capacity();
      const saved = await this.readSettings();
      const backend = input.backend ?? saved.backend ?? this.config.backend ?? 'claude-acp';
      const config = backend === 'claude-cli' ? undefined : input.config ?? saved.choices[backend];
      const at = now(), c: Conversation = { format: 2, backend, id: 'c-' + randomBytes(8).toString('hex'), changeId: input.changeId, requestDigest, createdAt: at, createdBy: by, updatedAt: at, version: 0, client: backend === 'codex-acp' ? 'codex' : 'claude-code', nativeSessionId: backend === 'claude-cli' ? randomUUID() : null, confirmed: false, principal: null, title: titleOf(text), turns: [], ...(config && Object.keys(config).length ? { config } : {}) };
      for (const id of input.contexts ?? []) await this.ports.context?.(project, id);
      const turn = this.turn(input.changeId, requestDigest, by, text, 1);
      if (input.contexts?.length) turn.contexts = [...input.contexts];
      c.turns.push(turn);
      // Recorded before the process starts, so a crash in between leaves an unknown message, never a resend.
      await this.write(project, c);
      this.launch(project, c, turn);
      return this.reply(project, c, turn);
    });
  }
  async send(project: Project, by: string, input: { conversationId: string; changeId: string; text: string; contexts?: string[] }) {
    const text = this.message(input.text), requestDigest = digest(canonical({ text, ...(input.contexts?.length ? { contexts: input.contexts } : {}) }));
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), existing = c.turns.find(t => t.changeId === input.changeId);
      if (existing) {
        requireThat(existing.requestDigest === requestDigest, 'conflict', 'That request identity already sent a different message.');
        return this.reply(project, c, existing);
      }
      requireThat(!c.trashedAt, 'conflict', 'This conversation is in the trash. Restore it to continue.');
      const last = c.turns.at(-1);
      requireThat(!last || last.state !== 'running' || !this.liveTurn(project, c, last), 'conflict', 'The Agent is still answering the previous message. Wait for it, or stop it, before sending another.');
      if (last?.state === 'running' && last.pid) {
        let alive = false; try { process.kill(last.pid, 0); alive = true; } catch {}
        requireThat(!alive, 'conflict', `The Agent from before Rho restarted may still be answering (process ${last.pid}). End that process before sending another message.`);
      }
      requireThat(c.turns.length < this.limits.maxTurns, 'limit', `A conversation keeps at most ${this.limits.maxTurns} messages. Start a new conversation.`, { limit: 'maxTurns', maximum: this.limits.maxTurns });
      requireThat(Buffer.byteLength(JSON.stringify({ ...c, observation: undefined })) + this.limits.maxObservationBytes + this.limits.maxTurnBytes + this.limits.maxMessageBytes <= this.limits.maxRecordBytes, 'limit', 'This conversation has reached the size Rho keeps. Start a new conversation.', { limit: 'maxRecordBytes', maximum: this.limits.maxRecordBytes });
      this.capacity();
      for (const old of c.turns) if (old.state === 'running') Object.assign(old, this.view(project, c, old));
      for (const id of input.contexts ?? []) await this.ports.context?.(project, id);
      const turn = this.turn(input.changeId, requestDigest, by, text, c.turns.length + 1);
      if (input.contexts?.length) turn.contexts = [...input.contexts];
      c.turns.push(turn);
      await this.write(project, c);
      this.launch(project, c, turn);
      return this.reply(project, c, turn);
    });
  }
  // A setting for the messages that follow. An open session changes now; otherwise the choice is
  // recorded and applied when the session next opens. Never while a message is being answered.
  async configure(project: Project, by: string, input: { conversationId: string; configId: string; value: string | boolean }) {
    this.choices({ [input.configId]: input.value });
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), last = c.turns.at(-1);
      requireThat(c.backend === 'claude-acp' || c.backend === 'codex-acp', 'unavailable', 'This conversation\'s Agent has no settings Rho can change.');
      requireThat(!c.trashedAt, 'conflict', 'This conversation is in the trash. Restore it to change its settings.');
      requireThat(!last || last.state !== 'running' || !this.liveTurn(project, c, last), 'conflict', 'The Agent is answering. Change its settings after this message.');
      const driver = this.drivers.get(project.id + '/' + c.id)?.driver;
      if (acpDriver(driver) && driver.connected) {
        try { await driver.configure(input.configId, input.value); }
        catch (error) { throw new Fault('invalid', error instanceof Error ? error.message : 'The Agent did not accept this setting.'); }
      } else {
        const offered = c.observation?.config?.options ?? (await this.readSettings()).offered[c.backend]?.options;
        requireThat(offered, 'unavailable', 'The Agent has not reported its settings yet. Check what it offers first.');
        this.offers(offered, input.configId, input.value);
      }
      c.config = { ...c.config, [input.configId]: input.value };
      await this.write(project, c);
      return { conversation: this.listed(project, this.summary(c)), observation: this.sessionObservation(project, c), config: c.config };
    });
  }
  private choices(values: Choices) {
    requireThat(values && typeof values === 'object' && Object.keys(values).length <= this.limits.maxChoices, 'limit', `Choose at most ${this.limits.maxChoices} settings.`, { limit: 'maxChoices', maximum: this.limits.maxChoices });
    for (const [id, value] of Object.entries(values)) requireThat(id.length > 0 && id.length <= this.limits.maxChoiceChars && (typeof value === 'boolean' || (typeof value === 'string' && value.length > 0 && value.length <= this.limits.maxChoiceChars)), 'invalid', 'A setting is one offered value.', { limit: 'maxChoiceChars' });
    return values;
  }
  private offers(options: ConfigOption[], id: string, value: string | boolean) {
    const option = options.find(o => o.id === id);
    requireThat(option, 'invalid', `The Agent does not offer the setting ${id}.`);
    requireThat(option.type === 'boolean' ? typeof value === 'boolean' : (option.values ?? []).some(v => v.value === value), 'invalid', `The Agent does not offer ${String(value)} for ${option.name}.`);
  }
  private async readSettings(): Promise<AgentSettings> {
    if (!this.config.settingsFile) return blankSettings();
    const value = await readJson<AgentSettings>(this.config.settingsFile, blankSettings());
    requireThat(value?.format === 1 && value.choices && value.offered, 'storage', 'The Agent settings file is unreadable; it is kept as it is.');
    return value;
  }
  private settingsView(s: AgentSettings) {
    const service = this.config.backend ?? 'claude-acp';
    return { version: s.version, updatedAt: s.updatedAt, backend: s.backend, serviceBackend: service, choices: s.choices, offered: s.offered, checking: [...this.checks.keys()], describe: { enabled: s.describe?.enabled !== false } };
  }
  async settings() { return this.settingsView(await this.readSettings()); }
  // The person's Agent and settings for new conversations. Each Agent's choices are replaced as a
  // whole and must be among the values it last offered; a stale version is refused.
  async updateSettings(input: { expectedVersion: number; backend?: Backend | null; choices?: Partial<Record<Backend, Choices>>; describe?: { enabled: boolean } }) {
    requireThat(this.config.settingsFile, 'unavailable', 'This service keeps no Agent settings.');
    requireThat(input.backend == null || backends.includes(input.backend), 'invalid', 'Choose Claude Code or Codex.');
    return this.serial('settings', async () => {
      const s = await this.readSettings();
      requireThat(s.version === input.expectedVersion, 'conflict', 'The Agent settings changed in another tab. Read them again.', { version: s.version });
      for (const [backend, values] of Object.entries(input.choices ?? {}) as Array<[Backend, Choices]>) {
        requireThat(backends.includes(backend), 'invalid', 'Choose Claude Code or Codex.');
        this.choices(values);
        const offered = s.offered[backend]?.options;
        requireThat(offered || !Object.keys(values).length, 'unavailable', 'Check what this Agent offers first.');
        for (const [id, value] of Object.entries(values)) this.offers(offered!, id, value);
        s.choices[backend] = values;
      }
      if (input.backend !== undefined) s.backend = input.backend;
      if (input.describe) { requireThat(typeof input.describe.enabled === 'boolean', 'invalid', 'Say whether files are described.'); s.describe = { enabled: input.describe.enabled }; }
      s.version++; s.updatedAt = now();
      await atomicJson(this.config.settingsFile!, s);
      return this.settingsView(s);
    });
  }
  // Starts the Agent in this project to read the settings it offers, then removes that session and
  // ends the process; no message is sent. The protected resource is local Agent processes: one
  // check per Agent at a time (a second request waits for the same one), each bounded by connectTimeoutMs.
  async check(project: Project, input: { backend: Backend }) {
    requireThat(backends.includes(input.backend), 'invalid', 'Choose Claude Code or Codex.');
    requireThat(this.config.settingsFile, 'unavailable', 'This service keeps no Agent settings.');
    requireThat(!this.closing, 'unavailable', 'Rho is closing. Nothing was started.');
    let pending = this.checks.get(input.backend);
    if (!pending) {
      pending = this.inspect(project, input.backend).finally(() => this.checks.delete(input.backend));
      this.checks.set(input.backend, pending);
    }
    await pending;
    return this.settings();
  }
  private async inspect(project: Project, backend: Backend) {
    const { ClaudeAcpConversation, CodexAcpConversation } = await import('@rho-workspace/plugin-agent/conversation');
    const common = { cwd: project.root, mcpServers: [], limits: this.limits };
    const driver = backend === 'codex-acp' ? new CodexAcpConversation({ ...this.config.codexAcp, ...common, codex: this.config.codex }) : new ClaudeAcpConversation({ ...this.config.claudeAcp, ...common, claude: this.binary });
    let found: Awaited<ReturnType<typeof driver.inspect>>;
    try { found = await driver.inspect(); }
    catch (error) { throw new Fault('unavailable', error instanceof Error ? error.message : 'The Agent could not be started.'); }
    await this.offer(backend, { at: now(), source: 'check', adapter: found.adapter, options: found.options, omitted: found.omitted });
  }
  private offer(backend: Backend, offered: Offered) {
    if (!this.config.settingsFile) return Promise.resolve();
    return this.serial('settings', async () => {
      const s = await this.readSettings();
      if (offered.source === 'conversation' && (s.offered[backend]?.at ?? '') > offered.at) return;
      s.offered[backend] = offered;
      await atomicJson(this.config.settingsFile!, s);
    });
  }

  // A stop is a request until the driver confirms it; what was already done stays done.
  async stop(project: Project, by: string, input: { conversationId: string; turnId: string }) {
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), turn = c.turns.find(t => t.id === input.turnId);
      requireThat(turn, 'not_found', 'No message has that identity in this conversation.');
      const live = this.liveTurn(project, c, turn);
      if (live) { live.stop('person', by); await this.write(project, c); }
      return this.reply(project, c, turn);
    });
  }
  async decide(project: Project, by: string, input: { conversationId: string; turnId: string; changeId: string; decision: Decision['decision']; note?: string }) {
    const note = input.note?.trim() || null, requestDigest = digest(canonical({ turnId: input.turnId, decision: input.decision, note }));
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), turn = c.turns.find(t => t.id === input.turnId);
      requireThat(turn, 'not_found', 'No message has that identity in this conversation.');
      const known = turn.decisions?.find(d => d.changeId === input.changeId);
      if (known) { requireThat(known.requestDigest === requestDigest, 'conflict', 'That request identity already recorded a different decision.'); return this.reply(project, c, turn); }
      requireThat(turn.state !== 'running', 'condition', 'The Agent is still answering this message. Decide when it has finished.');
      requireThat(input.decision !== 'needs-changes' || note, 'invalid', 'Say what needs to change.');
      requireThat((turn.decisions?.length ?? 0) < this.limits.maxDecisions, 'limit', `An answer keeps at most ${this.limits.maxDecisions} decisions.`, { limit: 'maxDecisions', maximum: this.limits.maxDecisions });
      // The newest version this message kept of each file it captured.
      const kept = new Map<string, { id: string; version: string }>();
      for (const record of turn.evidence?.records ?? []) if (record.state === 'captured' && record.snapshots.length) kept.set(record.path, record.snapshots.at(-1)!.resource);
      const previous = turn.decisions?.at(-1);
      turn.decisions = [...turn.decisions ?? [], { changeId: input.changeId, requestDigest, decision: input.decision, note, by, at: now(), supersedes: previous?.changeId ?? null, results: [...kept].map(([path, resource]) => ({ path, resource })) }];
      await this.write(project, c);
      return this.reply(project, c, turn);
    });
  }
  async permission(project: Project, by: string, input: { conversationId: string; turnId: string; permissionId: string; optionId: string }) {
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), turn = c.turns.find(t => t.id === input.turnId);
      const permission = turn?.permissions?.find(p => p.id === input.permissionId);
      requireThat(turn && permission, 'not_found', 'No Agent permission request has that identity.');
      if (permission.state === 'selected') {
        requireThat(permission.selected === input.optionId, 'conflict', 'That request already has a different choice.');
        return this.reply(project, c, turn);
      }
      const pending = this.permissions.get(project.id + '/' + c.id + '/' + permission.id);
      requireThat(permission.state === 'pending' && pending && this.liveTurn(project, c, turn), 'unavailable', 'This Agent request is no longer waiting for a choice.');
      requireThat(permission.options.some(x => x.id === input.optionId), 'invalid', 'Choose an option offered by this Agent request.');
      permission.state = 'selected'; permission.selected = input.optionId;
      try { await this.write(project, c); }
      catch (error) { permission.state = 'pending'; delete permission.selected; throw error; }
      pending.resolve(input.optionId);
      return this.reply(project, c, turn);
    });
  }
  async close() {
    this.closing = true;
    for (const live of this.live.values()) live.stop('closing', 'rho');
    await Promise.all([...this.live.values()].map(live => live.done));
    for (const key of [...this.drivers.keys()]) await this.retire(key);
    await Promise.all([...this.queues.values()].map(task => task.catch(() => {})));
  }
  private async retire(key: string) {
    const entry = this.drivers.get(key); if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    await entry.driver.close();
    const timer = this.flushes.get(key);
    if (timer) { clearTimeout(timer); this.flushes.delete(key); }
    // Keep the cached object through the final idle/disconnect write, so a next
    // turn cannot load an older object and later be overwritten by its flush.
    await this.serial(entry.project.id, () => this.write(entry.project, entry.conversation));
    if (this.drivers.get(key) === entry) this.drivers.delete(key);
  }
  private cancelPermissions(project: Project, c: Conversation) {
    const prefix = project.id + '/' + c.id + '/';
    for (const [key, pending] of this.permissions) if (key.startsWith(prefix)) {
      if (pending.permission.state === 'pending') pending.permission.state = 'cancelled';
      pending.resolve(null); this.permissions.delete(key);
    }
  }
  private launch(project: Project, c: Conversation, turn: Turn) {
    const key = project.id + '/' + c.id + '/' + turn.id, controller = new AbortController();
    const live: Live = { project, conversation: c, turn, controller, done: Promise.resolve(), stop: (reason, by) => {
      if (turn.stop) return;
      turn.stop = { requestedAt: now(), by, reason };
      controller.abort(); this.cancelPermissions(project, c);
    } };
    if (this.ports.capture) turn.evidence = { records: [], omitted: 0, bytes: 0, snapshots: 0 };
    this.live.set(key, live);
    live.done = this.run(live).catch(() => { turn.problem ??= 'Rho lost track of this message. Received steps were kept; it was not sent again.'; })
      .finally(async () => {
        if (turn.state === 'running') turn.state = 'unknown';
        turn.endedAt ??= now();
        if (live.before) {
          const after = await disk(project.root, this.limits.maxComparedFiles).catch(() => null);
          if (after) {
            turn.files = compare(live.before, after, this.limits.maxChangedFiles);
            for (const file of turn.files.changed) if (file.change !== 'removed') this.capture(live, file.path, 'turn-end');
            await live.describing; await this.describe(live, true);
          }
        }
        await Promise.all(live.captures ?? []);
        for (const step of turn.steps) if (step.kind === 'tool' && step.outcome === 'requested') step.outcome = 'unknown';
        this.cancelPermissions(project, c);
        const pending = this.flushes.get(project.id + '/' + c.id); if (pending) { clearTimeout(pending); this.flushes.delete(project.id + '/' + c.id); }
        await this.serial(project.id, () => this.write(project, c)).catch(() => {});
        this.live.delete(key);
        const entry = this.drivers.get(project.id + '/' + c.id);
        if (entry) { entry.timer = setTimeout(() => void this.serial('driver-pool', async () => {
          if ([...this.live.values()].some(x => x.project.id === project.id && x.conversation.id === c.id)) return;
          if (this.drivers.get(project.id + '/' + c.id) === entry) await this.retire(project.id + '/' + c.id);
        }).catch(() => {}), this.limits.idleMs); entry.timer.unref(); }
      });
  }
  private async driver(project: Project, c: Conversation) {
    return this.serial('driver-pool', async () => {
      const key = project.id + '/' + c.id, old = this.drivers.get(key);
      if (old?.timer) clearTimeout(old.timer);
      if (old?.driver.connected) return old.driver;
      if (old) await this.retire(key);
      if (this.drivers.size >= this.limits.maxConnections) {
        const idle = [...this.drivers].find(([k]) => ![...this.live.values()].some(x => x.project.id + '/' + x.conversation.id === k));
        requireThat(idle, 'limit', 'All Agent connections are busy. Wait for one to finish.', { limit: 'maxConnections' });
        await this.retire(idle[0]);
      }
      const grant = await this.ports.grant(project, c); c.principal = grant.principal;
      const mcpServers = [{ name: 'rho', command: process.execPath, args: [fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))], env: [{ name: 'RHO_AGENT_CONNECTION', value: grant.file }] }];
      const { ClaudeAcpConversation, CodexAcpConversation, ClaudeCliConversation } = await import('@rho-workspace/plugin-agent/conversation');
      const observed = { observation: c.observation, observe: (observation: SessionObservation) => {
        requireThat(observation.sessionId === c.acpSessionId, 'conflict', 'The observed Agent session differs from the retained identity.');
        requireThat(Buffer.byteLength(JSON.stringify(observation)) <= this.limits.maxObservationBytes, 'limit', 'The session projection exceeded maxObservationBytes; prior observations were kept.');
        const config = observation.config, learned = config && config.at !== c.observation?.config?.at && config.origin === 'initial' && !c.config && (c.backend === 'claude-acp' || c.backend === 'codex-acp');
        c.observation = observation; this.schedule(project, c);
        for (const live of this.live.values()) if (live.project.id === project.id && live.conversation.id === c.id) {
          for (const tool of observation.tools ?? []) if (tool.origin !== 'history' && Date.parse(tool.at) >= Date.parse(live.turn.sentAt)) for (const location of tool.locations ?? []) this.capture(live, location.path, 'tool:' + tool.id + ':' + tool.outcome);
        }
        // A first session opened without the person's choices shows what the Agent offers by default.
        if (learned) void this.offer(c.backend as Backend, { at: config.at, source: 'conversation', adapter: c.adapter ?? null, options: config.options, omitted: config.omitted }).catch(() => {});
      } };
      // Every session started here is told about the project's shared notes and its section.
      const instructions = notesInstructions(c.id, { notebook: !!this.ports.notebook?.() });
      const common = { cwd: project.root, mcpServers, limits: this.limits, sessionId: c.acpSessionId, config: c.config, instructions, ...observed };
      const driver = c.backend === 'codex-acp'
        ? new CodexAcpConversation({ ...this.config.codexAcp, ...common, codex: this.config.codex })
        : c.backend === 'claude-acp'
          ? new ClaudeAcpConversation({ ...this.config.claudeAcp, ...common, claude: this.binary, plugins: [...this.config.claudeAcp?.plugins ?? [], ...await this.ports.claudePlugins?.(project) ?? []] })
          : new ClaudeCliConversation({ cwd: project.root, binary: this.binary, sessionId: c.nativeSessionId!, confirmed: c.confirmed, projectName: project.name ?? path.basename(project.root), mcpServers, limits: this.limits, instructions });
      this.drivers.set(key, { driver, project, conversation: c }); return driver;
    });
  }
  // A message keeps the versions of its files it saw. Seeing the same bytes again adds nothing:
  // a step that finds a file exactly as an earlier capture of this message kept it leaves no
  // record and spends no budget, and a write's file that does not exist yet is not looked for.
  // A quarter of the record, snapshot and byte budget waits for the files the message changed,
  // captured when it ends, so a script rewritten many times cannot crowd out its results.
  // Looking is bounded too: at most four times the record budget of attempts per message.
  private capture(live: Live, reported: string, phase: string) {
    const file = projectPath(reported, live.project), evidence = live.turn.evidence;
    if (!file || !evidence || !this.ports.capture || !/\.(?:R|r|Rmd|qmd|py|md|txt|json|csv|tsv|png|jpe?g|svg|pdf|sql|sh|js|mjs|cjs|ts|tsx|jsx|css|html|yaml|yml|toml)$/.test(file)) return;
    const key = phase + ':' + file, tried = live.tried ??= new Set<string>();
    // A step is reported again with each update; once looked at, it is not looked at again.
    if (tried.has(key) || evidence.records.some(r => r.key === key)) return;
    tried.add(key);
    const final = phase === 'turn-end', files = Math.min(this.limits.maxCaptureFiles, 64);
    // A capture of this file still waiting its turn will read it no earlier than now.
    if (!final && evidence.records.some(r => r.path === file && r.state === 'pending')) return;
    const reserve = final ? 0 : Math.floor(files / 4), reserveBytes = final ? 0 : Math.floor(this.limits.maxCaptureBytes / 4);
    if (!final) live.attempts = (live.attempts ?? 0) + 1;
    if (evidence.records.length >= files - reserve || (!final && live.attempts! > files * 4)) { evidence.omitted++; return; }
    const record: TurnEvidence['records'][number] = { key, path: file, phase, requestedAt: now(), state: 'pending', snapshots: [] };
    evidence.records.push(record);
    if(privateEvidencePath(file)){record.state='unavailable';record.reason='Known connection or credential location excluded from automatic evidence.';this.schedule(live.project,live.conversation);return;}
    // Persist the pending observation before acquiring bytes. Read/reconnect never runs this.
    const lanes = live.captures ??= [], lane = 0;
    lanes[lane] = (lanes[lane] ?? Promise.resolve()).then(async () => {
      await this.serial(live.project.id, () => this.write(live.project, live.conversation));
      const drop = () => { evidence.records.splice(evidence.records.indexOf(record), 1); };
      // The file as the last capture of this message saw it, by size and modification time.
      const seen = live.seen ??= new Map<string, string>();
      const stat = file.startsWith('@') ? null : await fs.stat(path.join(live.project.root, file)).catch(() => undefined);
      if (stat === undefined && phase.endsWith(':requested')) { drop(); this.schedule(live.project, live.conversation); return; }
      const shape = stat ? stat.size + ':' + stat.mtimeMs : '';
      if (shape && seen.get(file) === shape) { drop(); this.schedule(live.project, live.conversation); return; }
      if (evidence.bytes >= this.limits.maxCaptureBytes - reserveBytes || evidence.snapshots >= this.limits.maxCaptureFiles - reserve) { record.state = 'unavailable'; record.reason = 'The turn snapshot budget was reached.'; return; }
      try {
        const captured = await this.ports.capture!(live.project, file, Math.min(this.limits.maxSnapshotBytes, this.limits.maxCaptureBytes - reserveBytes - evidence.bytes), this.limits.maxCaptureFiles - reserve - evidence.snapshots);
        const kept = new Set(evidence.records.filter(r => r !== record).flatMap(r => r.snapshots.map(s => s.resource.id + '@' + s.resource.version)));
        const fresh = captured.snapshots.filter(s => !kept.has(s.resource.id + '@' + s.resource.version));
        // Only a file with no unsaved buffer beside it is known by its size and time alone.
        if (shape && captured.snapshots.length && captured.snapshots.every(s => s.source.kind === 'disk')) seen.set(file, shape);
        if (captured.snapshots.length && !fresh.length) { drop(); this.schedule(live.project, live.conversation); return; }
        record.snapshots = captured.snapshots; record.reason = captured.reason;
        record.state = captured.snapshots.length ? 'captured' : 'unavailable';
        evidence.bytes += fresh.reduce((n, r) => n + r.bytes, 0); evidence.snapshots += fresh.length;
      } catch (error) { record.state = 'unavailable'; record.reason = error instanceof Fault ? error.message : 'The file could not be captured; earlier snapshots are kept.'; }
      this.schedule(live.project, live.conversation);
    }).catch(() => { record.state = 'interrupted'; record.reason = 'The capture could not be confirmed.'; });
  }
  private observe(live: Live, event: ConversationEvent) {
    const { project, conversation: c, turn } = live;
    if (event.type === 'started') { turn.pid = event.pid; turn.startedAt ??= now(); }
    if (event.type === 'model') turn.model = event.model;
    if (event.type === 'retry') turn.retry = event.retry;
    if (event.type === 'limit') live.stop(event.reason, 'rho');
    if (event.type === 'step') {
      const incoming = event.step;
      const existing = incoming.kind === 'tool' && incoming.id ? turn.steps.find(s => s.kind === 'tool' && s.id === incoming.id)
        : event.append && turn.steps.at(-1)?.kind === 'text' && turn.steps.at(-1)?.id === incoming.id ? turn.steps.at(-1) : undefined;
      // A tool step starts with the Agent's last description of it before any result: an Agent
      // reports a call while the model is still writing its input, so that time is not part of
      // how long it ran. Progress reports describe nothing and do not move it.
      const describing = (incoming.detail !== undefined || incoming.title !== undefined) && !incoming.output && !existing?.output && (incoming.outcome ?? 'requested') === 'requested' && (existing?.outcome ?? 'requested') === 'requested';
      const startedAt = describing ? incoming.at : existing?.startedAt ?? existing?.at ?? incoming.at;
      const next: Step = { ...existing, ...incoming, ...(incoming.kind === 'tool' ? { startedAt } : {}) };
      if (incoming.text !== undefined) Object.assign(next, cut((event.append && existing ? existing.text ?? '' : '') + incoming.text, this.limits.maxTextBytes));
      const size = Buffer.byteLength(JSON.stringify({ steps: turn.steps, permissions: turn.permissions })) - (existing ? Buffer.byteLength(JSON.stringify(existing)) : 0);
      const fits = (step: Step) => size + Buffer.byteLength(JSON.stringify(step)) <= this.limits.maxTurnBytes;
      // A command's printed output is the first thing given up when the message is full.
      const kept = fits(next) ? next : next.output && fits({ ...next, output: undefined }) ? { ...next, output: undefined } : null;
      if (incoming.kind === 'tool') {
        const action = toolActivity(incoming as any, null, project.root);
        if (action.targetKind === 'path' && (action.location || incoming.detail)) this.capture(live, action.location ?? incoming.detail!, 'step:' + incoming.id + ':' + incoming.outcome);
        if (action.targetKind === 'command' && action.target) for (const file of commandFiles(action.target, project)) this.capture(live, file, 'command:' + incoming.id + ':' + incoming.outcome);
      }
      if (!kept) turn.omitted++;
      else if (existing) Object.assign(existing, kept); else turn.steps.push(kept);
    }
    this.schedule(project, c);
  }
  private async run(live: Live) {
    const { project, conversation: c, turn, controller } = live;
    if (turn.stop) { turn.state = 'stopped'; return; }
    live.before = await disk(project.root, this.limits.maxComparedFiles).catch(() => null);
    let driver: AgentConversation;
    try { driver = await this.driver(project, c); }
    catch (e) { turn.state = 'failed'; turn.problem = e instanceof Fault ? e.message : 'Rho could not connect this conversation to the project.'; return; }
    const wall = setTimeout(() => live.stop('wall-limit', 'rho'), this.limits.turnWallMs); wall.unref();
    const ticking = setInterval(() => void this.describe(live), this.describing.everyMs); ticking.unref();
    try {
      const completion = await driver.run({ text: turn.text + (turn.contexts?.length ? '\n\nRead these exact frozen review contexts with context.read before responding: ' + turn.contexts.join(', ') + '. Reply with annotation.reply and explicit result resource versions.' : ''), signal: controller.signal,
        session: identity => this.serial(project.id, async () => {
          requireThat(!identity.acpSessionId || !c.acpSessionId || identity.acpSessionId === c.acpSessionId, 'conflict', 'The original ACP session identity changed.');
          requireThat(!identity.nativeSessionId || !c.nativeSessionId || identity.nativeSessionId === c.nativeSessionId, 'conflict', 'The original native session identity changed.');
          Object.assign(c, identity); c.confirmed = true; await this.write(project, c);
        }),
        event: event => this.observe(live, event),
        permission: async request => {
          let resolve!: (choice: string | null) => void;
          const answer = new Promise<string | null>(r => { resolve = r; }), key = project.id + '/' + c.id + '/' + request.id;
          await this.serial(project.id, async () => {
            if (controller.signal.aborted) { resolve(null); return; }
            const permission: Permission = { ...request, state: 'pending' };
            requireThat((turn.permissions?.length ?? 0) < this.limits.maxPermissions && Buffer.byteLength(JSON.stringify({ steps: turn.steps, permissions: [...(turn.permissions ?? []), permission] })) < this.limits.maxTurnBytes, 'limit', 'This message has reached its retained permission limit.');
            (turn.permissions ??= []).push(permission); this.permissions.set(key, { permission, resolve });
            await this.write(project, c);
          });
          try { return await answer; } finally { this.permissions.delete(key); }
        }
      });
      Object.assign(turn, completion); turn.retry = null; turn.endedAt = now();
    } finally { clearTimeout(wall); clearInterval(ticking); }
  }
  // While a message runs, what each file it writes holds: facts as soon as the file rests, then
  // the model's sentence. Checked again when the message ends; a sentence still being written
  // then is kept when it arrives.
  private describe(live: Live, final = false): Promise<void> {
    if (!live.before) return Promise.resolve();
    if (live.describing) return live.describing;
    const { project } = live;
    live.describing = (async () => {
      // The person's switch, read once per check: off keeps the facts and asks no model.
      const enabled = (await this.readSettings().catch(() => blankSettings())).describe?.enabled !== false;
      const changes = final ? live.turn.files?.changed ?? [] : compare(live.before!, await disk(project.root, this.limits.maxComparedFiles), this.limits.maxChangedFiles).changed;
      for (const change of changes) if (change.change !== 'removed' && change.modifiedAt) await this.describeFile(live, change, final, enabled).catch(() => {});
    })().catch(() => {}).finally(() => { live.describing = undefined; });
    return live.describing;
  }
  private async describeFile(live: Live, change: FileChange, final: boolean, enabled: boolean) {
    const { project, conversation: c, turn } = live, file = change.path, limits = this.describing;
    if (!describable(file) || file === projectNotesPath || file.startsWith('@') || privateEvidencePath(file)) return;
    if (!final && Date.now() - Date.parse(change.modifiedAt!) < limits.settleMs) return;
    const records = turn.descriptions ??= [], key = project.id + '/' + c.id + '/' + turn.id + '/' + file;
    let record = records.find(d => d.path === file);
    if (!record && records.length >= limits.maxPerMessage) {
      if (!(live.uncounted ??= new Set()).has(file)) { live.uncounted.add(file); turn.descriptionsOmitted = (turn.descriptionsOmitted ?? 0) + 1; this.schedule(project, c); }
      return;
    }
    const shown = (live.shown ??= new Map());
    if (!record || record.bytes !== change.bytes || record.modifiedAt !== change.modifiedAt || !shown.has(file)) {
      const read = await readHead(path.join(project.root, file), limits.maxFactBytes, limits.maxDigestBytes);
      if (!read) return;
      const facts = fileFacts(file, read.data, read.bytes);
      shown.set(file, { version: read.version, excerpt: facts.excerpt, textual: facts.textual });
      if (!record) { record = { path: file, version: read.version, bytes: read.bytes, modifiedAt: change.modifiedAt!, observedAt: now(), facts: facts.facts, sentence: null, state: 'facts' }; records.push(record); }
      else if (record.version !== read.version) {
        Object.assign(record, { version: read.version, bytes: read.bytes, observedAt: now(), facts: facts.facts });
        if (!this.writing.has(key)) { record.state = record.sentence?.facts === facts.facts ? 'described' : 'facts'; delete record.reason; }
      }
      record.modifiedAt = change.modifiedAt!;
      if (facts.partial) record.partial = true; else delete record.partial;
      this.schedule(project, c);
    }
    if (record.sentence && (record.sentence.version === record.version || record.sentence.facts === record.facts) || this.writing.has(key)) return;
    const given = shown.get(file)!;
    const reason = !enabled ? 'Descriptions by a model are switched off; the facts are kept.'
      : c.backend === 'codex-acp' ? 'Descriptions are written with Claude Code; this session\'s Agent is Codex.'
      : !this.ports.describe ? 'No model is set up to describe files.' : null;
    const keep = (why: string) => { if (record!.reason !== why) { record!.state = record!.sentence ? 'described' : 'facts'; record!.reason = why; this.schedule(project, c); } };
    if (reason) { keep(reason); return; }
    const asked = (live.asked ??= new Map()).get(file);
    if (!final && asked !== undefined && Date.now() - asked < limits.againMs) return;
    if ((live.calls ?? 0) >= limits.maxCalls) { keep('This message reached its model description limit (maxCalls); the facts are kept.'); return; }
    const model = turn.model ?? (typeof c.config?.model === 'string' ? c.config.model : null) ?? live.describer ?? null;
    let request: DescribeRequest = { path: file, facts: record.facts, request: turn.text, model, strategy: 'text', excerpt: given.excerpt }, version = given.version, why: string | undefined, from: string[] | undefined;
    // A figure: the image itself to a model that takes images, else what made it.
    const madeIt = async (because: string) => {
      const made = await this.madeContext(live, change);
      if (!made) return false;
      request = { ...request, strategy: 'context', image: undefined, context: made.context }; from = made.from; why = because;
      return true;
    };
    if (!given.textual) {
      const kind = raster(file), listed = model && this.ports.modelFacts ? await this.ports.modelFacts(model).catch(() => null) : null;
      const image = kind && listed?.images && !live.noImages ? await readHead(path.join(project.root, file), limits.maxImageBytes, limits.maxDigestBytes) : null;
      if (image && image.bytes <= limits.maxImageBytes) { request = { ...request, strategy: 'image', image: { mediaType: kind!, data: image.data } }; version = image.version; }
      else if (!await madeIt(!kind ? 'Only PNG, JPEG, GIF and WebP figures are sent as images.' : live.noImages ?? (!model ? 'The conversation names no model to look up.'
        : !listed ? `models.dev does not list ${model}.` : !listed.images ? `models.dev lists ${listed.listed} as taking text only.` : 'The image is larger than maxImageBytes.'))) {
        keep('Nothing in the record shows what made this figure, and it is not sent as an image; its facts are kept.'); return;
      }
    }
    live.calls = (live.calls ?? 0) + 1; live.asked.set(file, Date.now()); this.writing.add(key);
    const described = record, facts = record.facts;
    described.state = 'describing'; delete described.reason; this.schedule(project, c);
    const ask = () => this.serial('describe:' + project.id, () => this.ports.describe!(project, request));
    void ask().catch(async error => {
      // A model that did not take the image is given what made the figure, once; its other
      // figures in this message are not sent as images again.
      if (request.strategy !== 'image') throw error;
      const message = error instanceof Error ? error.message : 'unknown error';
      live.noImages = 'The model did not take an image earlier in this message: ' + message;
      turn.descriptionSpend = addSpend(turn.descriptionSpend, null);
      if (!await madeIt('The model did not take the image: ' + message) || (live.calls ?? 0) >= limits.maxCalls) throw error;
      live.calls = (live.calls ?? 0) + 1; version = given.version;
      return ask();
    })
      .then(said => {
        described.sentence = { text: said.text, version, model: said.model, at: now(), facts, strategy: request.strategy, ...(from ? { from } : {}), ...(why ? { why } : {}), cost: said.cost };
        described.state = 'described'; delete described.reason;
        turn.descriptionSpend = addSpend(turn.descriptionSpend, said.cost);
        if (!model && said.model) live.describer = said.model;
      }, error => {
        described.state = 'failed'; described.reason = error instanceof Error ? error.message : 'The description could not be written.';
        turn.descriptionSpend = addSpend(turn.descriptionSpend, null);
      })
      .finally(() => { this.writing.delete(key); this.schedule(project, c); });
  }
  // What made a figure, from this message's steps and the scripts its command ran.
  private madeContext(live: Live, change: FileChange) {
    return figureContext(change.path, change.modifiedAt!, live.turn.steps as MadeStep[], async (file, maxBytes) => {
      const read = await readHead(path.join(live.project.root, file), maxBytes, maxBytes);
      return read && read.bytes <= maxBytes ? read.data.toString('utf8') : null;
    }, command => commandFiles(command, live.project));
  }
}
