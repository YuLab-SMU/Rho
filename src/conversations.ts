import { projectPath, commandFiles, buildWorkGraph } from './work-graph.js';
import { notesInstructions, projectNotesPath } from './project-notes.js';
import { uiContextPrompt, type UiContext, type UiLocation } from './ui-context.js';
import { addSpend, describeLimits, describable, fileFacts, figureContext, raster, type Cost, type FileDescription, type MadeStep, type Spend, type Strategy } from './file-describer.js';
import { agentTurnLimit, displayCommand, toolActivity } from './conversation-presentation.js';
import {privateEvidencePath, type CapturePort, type TurnEvidence} from './evidence-capture.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConversation, AgentPermission, ConversationStep, ConversationEvent, ClaudeAcpOptions, CodexAcpOptions, SessionObservation, ConfigOption, ClaudeAcpConversation } from '@rho-workspace/plugin-agent/conversation';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, canonical, digest, Fault, now, readJson, requireThat } from '@rho-workspace/plugin-contracts';
import { acpEnvironment, installedAcpAgents, knownAcpAgent, locate, missingClient } from '@rho-workspace/plugin-agent/acp-command';
import type { Project } from './state.js';

// Rho holds user messages and their original identities. The selected Agent plugin
// owns the connection, native session and protocol. Reads never start a driver.
// A new Claude Code session opens in Manual mode unless the person's Claude settings name another.
// Rho prefers Auto ("Claude handles permission decisions"); a mode chosen in Rho or in those
// settings stays, and a model without Auto falls back to Accept edits with the adapter's warning.
const claudePreferred = { mode: { value: 'auto', replaces: ['default'] } };
export const conversationLimits = {
  // Per-message interface observations: omit and count extra views; refuse an
  // observation still larger than the byte budget before sending the message.
  maxUiContextBytes: 16384, maxUiContextViews: 32,
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
  // Claude Code's own step limit (--max-turns) for one message. None unless configured: a long
  // analysis stopped at 64 steps midway (P3, 2026-11-02), and the person stops a message at will.
  maxAgentTurns: undefined as number | undefined,
  // One message's wall time; past it cancellation is requested, then confirmed or unknown. None
  // unless configured, for the same reason.
  turnWallMs: undefined as number | undefined,
  // What Claude Code may write for one message, and in one record; past either it is stopped.
  maxOutputBytes: 33554432, maxLineBytes: 4194304,
  // Between asking a process to stop and forcing it.
  stopGraceMs: 5000,
  // Settings chosen for one Agent or one conversation, and the length of one chosen value;
  // more are refused.
  maxChoices: 12, maxChoiceChars: 512,
  // ACP Agents the person adds in Rho, kept in this service's Agent settings and offered in every
  // project; adding another is refused until one is removed.
  maxAddedAgents: 16,
  // Files compared on disk before and after a message, to record which changed during it; past
  // this many the comparison stops and the record says it is partial. Changes kept per message;
  // more are counted.
  maxComparedFiles: 20000, maxChangedFiles: 200, maxCaptureFiles: 64, maxCaptureBytes: 33554432, maxSnapshotBytes: 8388608, maxCaptureConcurrent: 2
};
type StopReason = 'person' | 'closing' | 'wall-limit' | 'output-limit' | 'line-limit' | 'identity';
// A tool step also keeps when it started (see observe); its `at` is its latest report.
type Step = ConversationStep & { startedAt?: string };
interface Permission extends AgentPermission { state: 'pending' | 'selected' | 'cancelled'; selected?: string }
export interface ConversationConfig { settingsFile?: string; backend?: 'claude-acp' | 'codex-acp' | 'claude-cli' | 'acp'; acpCommand?: { file: string; args: string[] }; codex?: string; codexAcp?: Omit<CodexAcpOptions, 'cwd' | 'mcpServers' | 'limits' | 'sessionId' | 'codex' | 'observation' | 'observe'>; claudeAcp?: Omit<ClaudeAcpOptions, 'cwd' | 'mcpServers' | 'limits' | 'sessionId' | 'claude' | 'observation' | 'observe'> }
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
  uiContext?: UiContext;
  decisions?: Decision[];
  // An Agent session that has gone leaves the messages Rho kept. The next message then runs in a
  // new session told what was said before, and the turn says which session it replaced.
  continued?: { at: string; earlier: string };
  // An explicit new message linked to a previous, confirmed Agent limit.
  continuationOf?: string;
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
  format: 1 | 2; backend?: Backend | 'claude-cli'; acpSessionId?: string; adapter?: { name: string; version?: string }; protocolVersion?: number; id: string; changeId: string; requestDigest: string; createdAt: string; createdBy: string; updatedAt: string; version: number;
  client: 'claude-code' | 'codex' | 'acp'; nativeSessionId: string | null; confirmed: boolean; principal: string | null; title: string; turns: Turn[];
  observation?: SessionObservation;
  // The person's choices among the settings this conversation's Agent offers, applied each
  // time its session is opened.
  config?: Choices;
  // Moved to the trash by the person: kept whole, not listed with the project's conversations,
  // and not continued until restored.
  trashedAt?: string | null; trashedBy?: string | null;
  // The Agent session this conversation continues, started outside Rho, and the session it
  // copies when it continues a copy (ACP session/fork) until its own session exists.
  origin?: { producer: string; sessionId: string; where: string; copy: boolean }; forkFrom?: string;
  // The command an ACP Agent other than Claude Code or Codex was started with, kept so the same
  // Agent continues the conversation whatever is added, removed or named at a later start.
  acpCommand?: Command;
}
// An Agent Rho starts: Claude Code or Codex through their adapters, the ACP command named when
// this service started ('acp'), or an ACP Agent the person added in Rho ('acp:' and a name).
type Backend = 'claude-acp' | 'codex-acp' | 'acp' | `acp:${string}`;
const builtIn: Backend[] = ['claude-acp', 'codex-acp', 'acp'];
const addedName = /^acp:[a-z0-9][a-z0-9-]{0,39}$/;
const backendName = (value: unknown): value is Backend => typeof value === 'string' && (builtIn.includes(value as Backend) || addedName.test(value));
const generic = (backend: string | undefined): backend is 'acp' | `acp:${string}` => backend === 'acp' || !!backend?.startsWith('acp:');
type Command = { file: string; args: string[] };
const sameCommand = (a: Command, b: Command) => a.file === b.file && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i]);
// DeepSeek Harness's own ACP command, which continues the sessions Harness keeps in this folder.
const harnessCommand = (command?: Command) => !!command && (knownAcpAgent(command)?.id === 'dsh' || [command.file, ...command.args].some(part => /(^|[\\/])dsh(\.[a-z]+)?$/i.test(part)));
// An ACP Agent the person added: its name, the command Rho starts and when it was added.
interface AddedAgent { backend: `acp:${string}`; name: string; command: Command; addedAt: string }
type Choices = Record<string, string | boolean>;
// What one Agent offered when a session last opened without the person's choices: a check
// (an explicit action that starts the Agent and sends nothing) or a conversation's first session.
interface Offered { at: string; source: 'check' | 'conversation'; adapter: { name: string; version?: string } | null; options: ConfigOption[]; omitted: number }
// The person's Agent and settings for new conversations, kept by this service for every project.
// `describe`: whether a model describes the files a message writes (on unless switched off).
interface AgentSettings { format: 1; version: number; updatedAt: string | null; backend: Backend | null; choices: Partial<Record<Backend, Choices>>; offered: Partial<Record<Backend, Offered>>; describe?: { enabled: boolean }; added?: AddedAgent[] }
const blankSettings = (): AgentSettings => ({ format: 1, version: 0, updatedAt: null, backend: null, choices: {}, offered: {} });
type AcpDriver = Pick<ClaudeAcpConversation, 'configure' | 'inspect' | 'connected'>;
const acpDriver = (driver: AgentConversation | undefined): driver is AgentConversation & AcpDriver => !!driver && 'configure' in driver;
interface Summary {
  conversationId: string; changeId: string; requestDigest: string; title: string; client: string; principal: string | null; createdAt: string; updatedAt: string; version: number; turns: number; state: string; lastAt: string;
  // What a list shows without reading each record: the Agent's own name for the session, the
  // Agent and its adapter, the last model, the person's choices, what the session reported
  // using and costing, its session identity and whether it is in the trash.
  listed?: 1 | 2; turnLimit?: boolean; waitingPermission?: boolean; backend?: string; agentTitle?: string | null; adapter?: { name: string; version?: string } | null; model?: string | null; config?: Choices;
  usage?: { used: number; size: number; cost: { amount: number; currency: string } | null } | null; costUsd?: number | null; sessionId?: string | null; trashedAt?: string | null;
  origin?: { producer: string; where: string; copyOf?: string } | null;
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
  uiContext?(project: Project, location: UiLocation, limits: typeof conversationLimits): Promise<UiContext>;
  // One sentence on what a file holds, from the model the conversation's Agent uses, and what
  // models.dev lists about that model.
  describe?(project: Project, request: DescribeRequest): Promise<{ text: string; model: string | null; cost: Cost }>;
  modelFacts?(model: string): Promise<{ images: boolean; listed: string } | null>;
  // Whether the project's live R and Python sessions are selected, which the session is told about.
  notebook?(): boolean;
  // The Agent's own record of this session: a live process holding it open (a terminal, an editor,
  // the Agent's own app, or Rho's own connection) and when it last changed. Rho does not write
  // into a session another process holds.
  nativeSession?(project: Project, producer: 'claude-code' | 'codex', sessionId: string): Promise<{ open: { where: string; since?: string; pid?: number } | null; lastAt: string } | null>;
}
// A session started elsewhere that this conversation continues: in place, or as a copy.
export interface ContinueSession { producer: 'claude-code' | 'codex' | 'dsh'; sessionId: string; title: string; where: string; copy: boolean; backend: Backend }
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
// Some Agents (Kimi Code) title a session with the start of its first prompt, which carries the
// interface context Rho appends to the person's words; the title keeps the person's words.
const agentTitleOf = (title: string | null | undefined) => title ? title.split(/\s*Rho interface context for this message:/)[0].trim() || null : null;
function titleOf(text: string) { const line = text.trim().split('\n')[0].trim(); return line.length > 80 ? line.slice(0, 79) + '…' : line; }
// An Agent reports a session it no longer has, in its own words: the ACP load answers "Resource
// not found", Claude Code says the session does not exist, and a load that cannot run at all says
// so plainly. Only those are taken as a session that ended; anything else is a real failure.
const sessionGone = /resource not found|session .*not found|no such session|unknown session|cannot load the original session|does not exist/i;
function lostSession(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return sessionGone.test(message);
}
// What this conversation already said, for a new Agent session that inherits it: the person's
// words and the Agent's own replies, newest last, within a fixed budget so a long conversation
// cannot crowd out the message being sent now.
export function earlierQuestions(turns: Turn[], limits: { maxTextBytes: number }, budget = 12_000) {
  const said: string[] = [];
  for (const turn of turns) {
    const reply = turn.steps.filter(step => step.kind === 'text' && step.text).map(step => step.text!.trim()).join('\n').trim();
    said.push('The person said: ' + turn.text.trim() + (reply ? '\nYou answered: ' + reply : ''));
  }
  let text = said.join('\n\n'), cutAt = false;
  if (Buffer.byteLength(text) > budget) {
    // Keep the most recent exchanges, the ones a follow-up is most likely to build on.
    const lines = said.slice().reverse();
    let kept: string[] = [];
    for (const line of lines) { if (Buffer.byteLength([line, ...kept].join('\n\n')) > budget) { cutAt = true; break; } kept = [line, ...kept]; }
    text = kept.join('\n\n');
  }
  if (!text) return '';
  return 'This message continues a conversation in this project. The Agent session that ran it has ended, so this is a new session; what was said before is kept by Rho and given here'
    + (cutAt ? ' (the earliest exchanges are left out for length)' : '') + ':\n\n' + text + '\n';
}

export class Conversations {
  limits: typeof conversationLimits;
  private live = new Map<string, Live>();
  private queues = new Map<string, Promise<unknown>>();
  private flushes = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  private drivers = new Map<string, { driver: AgentConversation; project: Project; conversation: Conversation; timer?: ReturnType<typeof setTimeout> }>();
  private permissions = new Map<string, { permission: Permission; resolve(choice: string | null): void }>();
  private checks = new Map<Backend, Promise<void>>();
  // Agents being added, by command: a second request for the same command waits for the first.
  private adding = new Map<string, Promise<ReturnType<Conversations['settingsView']>>>();
  // Descriptions being written by a model now, by project, conversation, message and file.
  private writing = new Set<string>();
  describing = { ...describeLimits };
  constructor(private ports: ConversationPorts, public binary = 'claude', limits: Partial<typeof conversationLimits> = {}, private config: ConversationConfig = {}) {
    this.limits = { ...conversationLimits, ...limits };
    for (const key of ['maxCaptureFiles','maxCaptureBytes','maxSnapshotBytes','maxCaptureConcurrent'] as const) requireThat(Number.isSafeInteger(this.limits[key]) && this.limits[key]>0 && this.limits[key]<=conversationLimits[key], 'invalid', 'Capture budgets must be positive integers no greater than the supported defaults.', {limit:key,maximum:conversationLimits[key]});
    requireThat(!config.backend || ['claude-acp', 'codex-acp', 'claude-cli', 'acp'].includes(config.backend), 'invalid', 'Choose claude-acp, codex-acp, claude-cli or acp.');
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
      listed: 2, turnLimit: !!last && agentTurnLimit(last), waitingPermission: last?.state === 'running' && !!last.permissions?.some(p => p.state === 'pending'), backend: c.backend ?? 'claude-cli', agentTitle: agentTitleOf(c.observation?.info?.title), adapter: c.adapter ?? null, model: [...c.turns].reverse().find(t => t.model)?.model ?? null, config: c.config ?? {},
      usage: usage ? { used: usage.used, size: usage.size, cost: usage.cost ?? null } : null, costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      sessionId: c.acpSessionId ?? c.nativeSessionId ?? null, trashedAt: c.trashedAt ?? null,
      origin: c.origin ? { producer: c.origin.producer, where: c.origin.where, ...(c.origin.copy ? { copyOf: c.origin.sessionId } : {}) } : null };
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
  // A project taken off Rho's list keeps no connection to an Agent: each idle one ends, as it
  // would by itself after idleMs. One still answering is stopped first, by its own stop.
  async release(projectId: string) {
    for (const key of [...this.drivers.keys()]) if (key.startsWith(projectId + '/')) await this.serial('driver-pool', () => this.retire(key)).catch(() => {});
  }
  // The messages being answered in a project now, by this service.
  answering(projectId: string) { return [...this.live.values()].filter(l => l.project.id === projectId).map(l => ({ conversationId: l.conversation.id, turnId: l.turn.id })); }
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
    return { ...shown, state: s.state === 'running' && !live ? 'unknown' : s.state, waitingPermission: live && !!s.waitingPermission };
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
    if (index.conversations.some(s => s.listed !== 2)) index = await this.serial(project.id, () => this.relist(project));
    return index.conversations.filter(s => !!s.trashedAt === !!input.trashed).map(s => this.listed(project, s)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  // Summaries written before lists carried their fields are rebuilt from the records once.
  private async relist(project: Project) {
    const index = await this.index(project);
    if (!index.conversations.some(s => s.listed !== 2)) return index;
    const conversations = await Promise.all(index.conversations.map(async s => s.listed === 2 ? s
      : await this.load(project, s.conversationId).then(c => this.summary(c), () => ({ ...s, listed: 2 as const }))));
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
    const model={nodes:graph.nodes.map(n=>({id:n.id,kind:n.kind,...(n.path?{path:n.path}:{}),...(n.resource?{resource:n.resource,capturedAt:n.capturedAt}:{}),...(n.gap?{gap:n.gap}:{})})),edges:graph.edges.map(e=>({from:e.from,to:e.to,label:e.label,basis:e.basis,at:e.at})),omittedTurns:0,omittedNodes:0};
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
  async start(project: Project, by: string, input: { changeId: string; text: string; contexts?: string[]; uiContext?: UiLocation; backend?: Backend; config?: Choices; continue?: ContinueSession }) {
    requireThat(!input.backend || backendName(input.backend), 'invalid', 'Choose an Agent Rho starts.');
    if (input.config) this.choices(input.config);
    const from = input.continue;
    const text = this.message(input.text), requestDigest = digest(canonical({ text, ...(input.contexts?.length ? { contexts: input.contexts } : {}), ...(input.backend ? { backend: input.backend } : {}), ...(input.config ? { config: input.config } : {}),
      ...(input.uiContext ? { uiContext: input.uiContext } : {}), ...(from ? { continue: { producer: from.producer, sessionId: from.sessionId, copy: from.copy } } : {}) }));
    return this.serial(project.id, async () => {
      const index = await this.index(project), existing = index.conversations.find(x => x.changeId === input.changeId);
      requireThat(!index.deleted?.some(x => x.changeId === input.changeId), 'conflict', 'That request started a conversation that was later deleted. It is not started again.');
      if (existing) {
        requireThat(existing.requestDigest === requestDigest, 'conflict', 'That request identity already started a different conversation.');
        const c = await this.load(project, existing.conversationId); return this.reply(project, c, c.turns[0]);
      }
      requireThat(index.conversations.filter(x => !x.trashedAt).length < this.limits.maxConversations, 'limit', `This project keeps at most ${this.limits.maxConversations} conversations started in Rho. Move one to the trash to start another.`, { limit: 'maxConversations', maximum: this.limits.maxConversations });
      if (from && !from.copy) {
        const already = index.conversations.find(x => x.sessionId === from.sessionId);
        requireThat(!already, 'conflict', already?.trashedAt ? 'This session is a conversation in the trash. Restore it to continue.' : 'This session already continues as a conversation here. Open it to send your message.');
        await this.notHeld(project, from.producer, from.sessionId, false);
      }
      this.capacity();
      const saved = await this.readSettings();
      // A saved Agent the person has since removed is not used; the service's own is.
      const savedBackend = saved.backend && (!saved.backend.startsWith('acp:') || this.commandOf(saved.backend, saved)) ? saved.backend : null;
      const backend = from?.backend ?? input.backend ?? savedBackend ?? this.config.backend ?? 'claude-acp';
      const command = generic(backend) ? this.commandOf(backend, saved) : undefined;
      requireThat(!generic(backend) || command, 'unavailable', backend === 'acp' ? 'No ACP command was named when Rho started. Add the Agent under Agents in Rho. Nothing was sent.' : 'That Agent is not added in Rho. Add it under Agents first. Nothing was sent.');
      const config = backend === 'claude-cli' ? undefined : input.config ?? saved.choices[backend];
      const at = now(), c: Conversation = { format: 2, backend, id: 'c-' + randomBytes(8).toString('hex'), changeId: input.changeId, requestDigest, createdAt: at, createdBy: by, updatedAt: at, version: 0, client: backend === 'codex-acp' ? 'codex' : generic(backend) ? 'acp' : 'claude-code', nativeSessionId: backend === 'claude-cli' ? randomUUID() : null, confirmed: false, principal: null, title: titleOf(text), turns: [], ...(config && Object.keys(config).length ? { config } : {}), ...(command ? { acpCommand: command } : {}) };
      for (const id of input.contexts ?? []) await this.ports.context?.(project, id);
      if (from) {
        c.origin = { producer: from.producer, sessionId: from.sessionId, where: from.where, copy: from.copy };
        if (from.copy) c.forkFrom = from.sessionId; else c.acpSessionId = from.sessionId;
        c.title = from.title;
      }
      const turn = this.turn(input.changeId, requestDigest, by, text, 1);
      if (input.contexts?.length) turn.contexts = [...input.contexts];
      if (input.uiContext) turn.uiContext = await this.ports.uiContext?.(project, input.uiContext, this.limits);
      c.turns.push(turn);
      // Recorded before the process starts, so a crash in between leaves an unknown message, never a resend.
      await this.write(project, c);
      this.launch(project, c, turn);
      return this.reply(project, c, turn);
    });
  }
  /** Whether a process holding a session open is Rho's own connection to this conversation: the
   * Agent its adapter started. Codex names no holding process, but it lets one writer open a
   * thread at a time; while this conversation's own connection is open, that writer is Rho's. */
  async owns(project: Project, conversationId: string, pid: number | undefined, producer?: string) {
    const driver = this.drivers.get(project.id + '/' + conversationId)?.driver as { pid?: number | null; connected?: boolean } | undefined, adapter = driver?.pid;
    if (!adapter) return false;
    if (!pid && producer === 'codex') return !!driver.connected;
    if (!pid || process.platform === 'win32') return false;
    const { execFile } = await import('node:child_process');
    let current = pid;
    for (let depth = 0; depth < 4 && current > 1; depth++) {
      const parent = await new Promise<number>(resolve => execFile('ps', ['-o', 'ppid=', '-p', String(current)], { timeout: 2000 }, (error, out) => resolve(error ? 0 : Number(String(out).trim()))));
      if (parent === adapter) return true;
      current = parent;
    }
    return false;
  }
  private async notHeld(project: Project, producer: string, sessionId: string, existing: boolean, conversationId?: string) {
    if (producer !== 'claude-code' && producer !== 'codex') return;
    const found = await this.ports.nativeSession?.(project, producer, sessionId) ?? null;
    const holder = found?.open && !(conversationId && await this.owns(project, conversationId, found.open.pid, producer)) ? found.open : null;
    requireThat(!holder, 'condition', `This session is open in ${holder?.where ?? 'another window'}. Close it there to continue here${existing ? '' : ', or continue a copy'}. Nothing was sent.`, { heldBy: holder?.where ?? null });
  }
  async send(project: Project, by: string, input: { conversationId: string; changeId: string; text: string; contexts?: string[]; uiContext?: UiLocation; continuationOf?: string }) {
    const text = this.message(input.text), requestDigest = digest(canonical({ text, ...(input.contexts?.length ? { contexts: input.contexts } : {}), ...(input.uiContext ? { uiContext: input.uiContext } : {}), ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}) }));
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), existing = c.turns.find(t => t.changeId === input.changeId);
      if (existing) {
        requireThat(existing.requestDigest === requestDigest, 'conflict', 'That request identity already sent a different message.');
        return this.reply(project, c, existing);
      }
      requireThat(!c.trashedAt, 'conflict', 'This conversation is in the trash. Restore it to continue.');
      const last = c.turns.at(-1);
      if (input.continuationOf) requireThat(last?.id === input.continuationOf && agentTurnLimit(last), 'condition', 'That message is not the latest confirmed Agent turn-limit stop. Nothing was continued.');
      requireThat(!last || last.state !== 'running' || !this.liveTurn(project, c, last), 'conflict', 'The Agent is still answering the previous message. Wait for it, or stop it, before sending another.');
      if (last?.state === 'running' && last.pid) {
        let alive = false; try { process.kill(last.pid, 0); alive = true; } catch {}
        requireThat(!alive, 'conflict', `The Agent from before Rho restarted may still be answering (process ${last.pid}). End that process before sending another message.`);
      }
      requireThat(c.turns.length < this.limits.maxTurns, 'limit', `A conversation keeps at most ${this.limits.maxTurns} messages. Start a new conversation.`, { limit: 'maxTurns', maximum: this.limits.maxTurns });
      // A session continued in a terminal or another app may be open there now.
      if (c.acpSessionId && (c.client === 'claude-code' || c.client === 'codex')) await this.notHeld(project, c.client, c.acpSessionId, true, c.id);
      requireThat(Buffer.byteLength(JSON.stringify({ ...c, observation: undefined })) + this.limits.maxObservationBytes + this.limits.maxTurnBytes + this.limits.maxMessageBytes <= this.limits.maxRecordBytes, 'limit', 'This conversation has reached the size Rho keeps. Start a new conversation.', { limit: 'maxRecordBytes', maximum: this.limits.maxRecordBytes });
      this.capacity();
      for (const old of c.turns) if (old.state === 'running') Object.assign(old, this.view(project, c, old));
      for (const id of input.contexts ?? []) await this.ports.context?.(project, id);
      const turn = this.turn(input.changeId, requestDigest, by, text, c.turns.length + 1);
      if (input.continuationOf) turn.continuationOf = input.continuationOf;
      if (input.contexts?.length) turn.contexts = [...input.contexts];
      if (input.uiContext) turn.uiContext = await this.ports.uiContext?.(project, input.uiContext, this.limits);
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
      requireThat(c.backend === 'claude-acp' || c.backend === 'codex-acp' || generic(c.backend), 'unavailable', 'This conversation\'s Agent has no settings Rho can change.');
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
    const service = this.config.backend ?? 'claude-acp', added = s.added ?? [];
    return { version: s.version, updatedAt: s.updatedAt, backend: s.backend, serviceBackend: service, choices: s.choices, offered: s.offered, checking: [...this.checks.keys()], describe: { enabled: s.describe?.enabled !== false }, agents: this.agents(s),
      added: added.map(a => ({ backend: a.backend, name: a.name, command: [a.command.file, ...a.command.args], addedAt: a.addedAt })),
      // The ACP Agents Rho knows that are installed here and not yet added. Finding them reads PATH.
      installed: installedAcpAgents(process.env).filter(i => !(this.config.acpCommand && sameCommand(i.command, this.config.acpCommand)) && !added.some(a => sameCommand(a.command, i.command)))
        .map(i => ({ id: i.id, name: i.name, command: [i.command.file, ...i.command.args] })) };
  }
  // The command that starts an ACP Agent other than Claude Code or Codex: one the person added, or
  // the one named when this service started.
  private commandOf(backend: Backend, s: AgentSettings): Command | undefined {
    return backend === 'acp' ? this.config.acpCommand : s.added?.find(a => a.backend === backend)?.command;
  }
  // Which Agents this service can start: the person's installed clients, found as the adapters
  // find them, the ACP command named when it started and the ACP Agents the person added. Looking
  // starts nothing. The named command's Agent is named as Rho knows it, else as it named itself the
  // last time it answered, else by its program.
  private agents(s: AgentSettings) {
    const found = (problem: string | null) => problem ? { found: false, problem } : { found: true };
    const command = this.config.acpCommand, reported = s.offered.acp?.adapter?.name;
    return {
      // A command the embedding names is its own choice and is not looked for, as the adapters do.
      'claude-acp': found(this.config.claudeAcp?.command ? null : missingClient('claude', acpEnvironment('claude', { ...process.env }, this.binary))),
      'codex-acp': found(this.config.codexAcp?.command ? null : missingClient('codex', acpEnvironment('codex', { ...process.env }, this.config.codex))),
      acp: command ? { found: true, name: knownAcpAgent(command)?.name ?? (harnessCommand(command) ? 'DeepSeek Harness' : reported || path.basename(command.file).replace(/\.(exe|cmd)$/i, '')) } : { found: false, problem: 'No ACP command was named when Rho started.' },
      ...Object.fromEntries((s.added ?? []).map(a => [a.backend, locate(a.command.file, process.env) ? { found: true, name: a.name }
        : { found: false, name: a.name, problem: `${a.name} is no longer at ${a.command.file}. Install it again, or remove it and add it again.` }]))
    };
  }
  // The Agent that continues DeepSeek Harness's sessions: Harness's own ACP command, named when
  // Rho started or added by the person.
  async harness(): Promise<Backend | null> {
    if (harnessCommand(this.config.acpCommand)) return 'acp';
    return (await this.readSettings()).added?.find(a => harnessCommand(a.command))?.backend ?? null;
  }
  async settings() { return this.settingsView(await this.readSettings()); }
  // The person's Agent and settings for new conversations. Each Agent's choices are replaced as a
  // whole and must be among the values it last offered; a stale version is refused.
  async updateSettings(input: { expectedVersion: number; backend?: string | null; choices?: Partial<Record<string, Choices>>; describe?: { enabled: boolean } }) {
    requireThat(this.config.settingsFile, 'unavailable', 'This service keeps no Agent settings.');
    return this.serial('settings', async () => {
      const s = await this.readSettings();
      requireThat(s.version === input.expectedVersion, 'conflict', 'The Agent settings changed in another tab. Read them again.', { version: s.version });
      const startable = (backend: unknown) => backendName(backend) && (builtIn.includes(backend) || !!this.commandOf(backend, s));
      requireThat(input.backend == null || startable(input.backend), 'invalid', 'Choose an Agent Rho starts.');
      for (const [backend, values] of Object.entries(input.choices ?? {}) as Array<[Backend, Choices]>) {
        requireThat(startable(backend), 'invalid', 'Choose an Agent Rho starts.');
        this.choices(values);
        const offered = s.offered[backend]?.options;
        requireThat(offered || !Object.keys(values).length, 'unavailable', 'Check what this Agent offers first.');
        for (const [id, value] of Object.entries(values)) this.offers(offered!, id, value);
        s.choices[backend] = values;
      }
      if (input.backend !== undefined) s.backend = input.backend as Backend | null;
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
    requireThat(backendName(input.backend), 'invalid', 'Choose an Agent Rho starts.');
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
    const { ClaudeAcpConversation, CodexAcpConversation, GenericAcpConversation } = await import('@rho-workspace/plugin-agent/conversation');
    const common = { cwd: project.root, mcpServers: [], limits: this.limits };
    const command = generic(backend) ? this.commandOf(backend, await this.readSettings()) : undefined;
    requireThat(!generic(backend) || command, 'unavailable', backend === 'acp' ? 'No ACP command was named when Rho started.' : 'That Agent is not added in Rho.');
    const driver = backend === 'codex-acp' ? new CodexAcpConversation({ ...this.config.codexAcp, ...common, codex: this.config.codex }) : command ? new GenericAcpConversation({ ...common, command }) : new ClaudeAcpConversation({ preferred: claudePreferred, ...this.config.claudeAcp, ...common, claude: this.binary });
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

  // An ACP Agent the person adds for new conversations in every project. Rho starts its command once
  // in this project, as a check does (it opens a session, reads what the Agent offers and removes
  // the session; no message is sent), and keeps it only when the Agent answered. The command is
  // the person's own: a program on PATH or a path to one, and its arguments. Adding the same
  // command again checks it again; one start per command runs at a time.
  async addAgent(project: Project, input: { command: string[] }) {
    requireThat(this.config.settingsFile, 'unavailable', 'This service keeps no Agent settings.');
    requireThat(!this.closing, 'unavailable', 'Rho is closing. Nothing was started.');
    const [program, ...args] = input.command;
    const file = locate(program, process.env);
    requireThat(file, 'unavailable', `${program} was not found ${/[\\/]/.test(program) ? 'there' : 'on PATH'}. Install it, or give the path of its program.`);
    const command = { file: path.resolve(file), args }, key = JSON.stringify(command);
    let pending = this.adding.get(key);
    if (!pending) { pending = this.addOnce(project, command).finally(() => this.adding.delete(key)); this.adding.set(key, pending); }
    return pending;
  }
  private async addOnce(project: Project, command: Command) {
    const known = knownAcpAgent(command), label = known?.name ?? path.basename(command.file);
    const room = (s: AgentSettings) => requireThat(s.added?.some(a => sameCommand(a.command, command)) || (s.added?.length ?? 0) < this.limits.maxAddedAgents, 'limit',
      `Rho keeps at most ${this.limits.maxAddedAgents} added Agents. Remove one first. Nothing was started.`, { limit: 'maxAddedAgents', maximum: this.limits.maxAddedAgents });
    room(await this.readSettings());
    const { GenericAcpConversation } = await import('@rho-workspace/plugin-agent/conversation');
    let found: Awaited<ReturnType<InstanceType<typeof GenericAcpConversation>['inspect']>>;
    try { found = await new GenericAcpConversation({ cwd: project.root, mcpServers: [], limits: this.limits, command }).inspect(); }
    catch (error) { throw new Fault('unavailable', `${label} did not start as an ACP Agent (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}). Nothing was added.`); }
    return this.serial('settings', async () => {
      const s = await this.readSettings(), added = s.added ?? [], existing = added.find(a => sameCommand(a.command, command));
      room(s);
      const name = existing?.name ?? known?.name ?? found.adapter?.name ?? label;
      const backend = existing?.backend ?? this.newName(known?.id ?? found.adapter?.name ?? label, added);
      if (!existing) s.added = [...added, { backend, name, command, addedAt: now() }];
      s.offered[backend] = { at: now(), source: 'check', adapter: found.adapter, options: found.options, omitted: found.omitted };
      s.version++; s.updatedAt = now();
      await atomicJson(this.config.settingsFile!, s);
      return this.settingsView(s);
    });
  }
  private newName(seed: string, added: AddedAgent[]): `acp:${string}` {
    const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
    for (let n = 1; ; n++) { const name = `acp:${base}${n > 1 ? '-' + n : ''}` as const; if (!added.some(a => a.backend === name)) return name; }
  }
  // Removing an added Agent takes it out of every Agent menu. Its conversations stay, each with
  // the command it started with, so they can still be read and continued.
  async removeAgent(input: { backend: string }) {
    requireThat(this.config.settingsFile, 'unavailable', 'This service keeps no Agent settings.');
    return this.serial('settings', async () => {
      const s = await this.readSettings(), backend = input.backend as Backend;
      requireThat(s.added?.some(a => a.backend === backend), 'not_found', 'No Agent added in Rho has that name.');
      s.added = s.added!.filter(a => a.backend !== backend);
      delete s.choices[backend]; delete s.offered[backend];
      if (s.backend === backend) s.backend = null;
      s.version++; s.updatedAt = now();
      await atomicJson(this.config.settingsFile!, s);
      return this.settingsView(s);
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
  private async changedElsewhere(project: Project, c: Conversation) {
    if (!c.acpSessionId || (c.client !== 'claude-code' && c.client !== 'codex')) return false;
    const previous = c.turns.at(-2), found = await this.ports.nativeSession?.(project, c.client, c.acpSessionId).catch(() => null);
    return !!found && !!previous?.endedAt && Date.parse(found.lastAt) > Date.parse(previous.endedAt) + 5000;
  }
  private async driver(project: Project, c: Conversation) {
    return this.serial('driver-pool', async () => {
      const key = project.id + '/' + c.id, old = this.drivers.get(key);
      if (old?.timer) clearTimeout(old.timer);
      // An open connection keeps the session as it last saw it. When the session went on in
      // another window since, it is opened again from the Agent's own record.
      if (old?.driver.connected && !await this.changedElsewhere(project, c)) return old.driver;
      if (old) await this.retire(key);
      if (this.drivers.size >= this.limits.maxConnections) {
        const idle = [...this.drivers].find(([k]) => ![...this.live.values()].some(x => x.project.id + '/' + x.conversation.id === k));
        requireThat(idle, 'limit', 'All Agent connections are busy. Wait for one to finish.', { limit: 'maxConnections' });
        await this.retire(idle[0]);
      }
      const grant = await this.ports.grant(project, c); c.principal = grant.principal;
      const mcpServers = [{ name: 'rho', command: process.execPath, args: [fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))], env: [{ name: 'RHO_AGENT_CONNECTION', value: grant.file }] }];
      const { ClaudeAcpConversation, CodexAcpConversation, ClaudeCliConversation, GenericAcpConversation } = await import('@rho-workspace/plugin-agent/conversation');
      const observed = { observation: c.observation, observe: (observation: SessionObservation) => {
        requireThat(observation.sessionId === c.acpSessionId, 'conflict', 'The observed Agent session differs from the retained identity.');
        requireThat(Buffer.byteLength(JSON.stringify(observation)) <= this.limits.maxObservationBytes, 'limit', 'The session projection exceeded maxObservationBytes; prior observations were kept.');
        const config = observation.config, learned = config && config.at !== c.observation?.config?.at && config.origin === 'initial' && !c.config && (c.backend === 'claude-acp' || c.backend === 'codex-acp' || generic(c.backend));
        c.observation = observation; this.schedule(project, c);
        for (const live of this.live.values()) if (live.project.id === project.id && live.conversation.id === c.id) {
          for (const tool of observation.tools ?? []) if (tool.origin !== 'history' && Date.parse(tool.at) >= Date.parse(live.turn.sentAt)) for (const location of tool.locations ?? []) this.capture(live, location.path, 'tool:' + tool.id + ':' + tool.outcome);
        }
        // A first session opened without the person's choices shows what the Agent offers by default.
        if (learned) void this.offer(c.backend as Backend, { at: config.at, source: 'conversation', adapter: c.adapter ?? null, options: config.options, omitted: config.omitted }).catch(() => {});
      } };
      // Every session started here is told about the project's shared notes and its section.
      const instructions = notesInstructions(c.id, { notebook: !!this.ports.notebook?.() });
      const common = { cwd: project.root, mcpServers, limits: this.limits, sessionId: c.acpSessionId, ...(!c.acpSessionId && c.forkFrom ? { forkFrom: c.forkFrom } : {}), config: c.config, instructions, ...observed };
      // A conversation started before Rho kept its ACP command uses the one named at this start.
      const command = generic(c.backend) ? c.acpCommand ?? (c.backend === 'acp' ? this.config.acpCommand : undefined) : undefined;
      requireThat(!generic(c.backend) || command, 'unavailable', 'This conversation\'s ACP Agent was named when Rho started, and this start names none. Start Rho with the same --acp-command to continue it.');
      const driver = c.backend === 'codex-acp'
        ? new CodexAcpConversation({ ...this.config.codexAcp, ...common, codex: this.config.codex })
        : c.backend === 'claude-acp'
          ? new ClaudeAcpConversation({ preferred: claudePreferred, ...this.config.claudeAcp, ...common, claude: this.binary, plugins: [...this.config.claudeAcp?.plugins ?? [], ...await this.ports.claudePlugins?.(project) ?? []] })
          : command
            ? new GenericAcpConversation({ ...common, command })
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
        // A command's files are captured however its row reads (an install names its packages).
        if (action.action === 'execute' && incoming.detail) for (const file of commandFiles(displayCommand(incoming.detail), project)) this.capture(live, file, 'command:' + incoming.id + ':' + incoming.outcome);
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
    const wall = this.limits.turnWallMs === undefined ? undefined : setTimeout(() => live.stop('wall-limit', 'rho'), this.limits.turnWallMs); wall?.unref();
    const ticking = setInterval(() => void this.describe(live), this.describing.everyMs); ticking.unref();
    try {
      let attached = false;
      const send = (utterance: string) => driver.run({ text: utterance, signal: controller.signal,
        session: identity => this.serial(project.id, async () => {
          requireThat(!identity.acpSessionId || !c.acpSessionId || identity.acpSessionId === c.acpSessionId, 'conflict', 'The original ACP session identity changed.');
          requireThat(!identity.nativeSessionId || !c.nativeSessionId || identity.nativeSessionId === c.nativeSessionId, 'conflict', 'The original native session identity changed.');
          Object.assign(c, identity); c.confirmed = true; await this.write(project, c); attached = true;
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
      const utterance = turn.text + uiContextPrompt(turn.uiContext) + (turn.continuationOf ? '\n\nOriginal task:\n' + c.turns[0].text : '') + (turn.contexts?.length ? '\n\nRead these exact frozen review contexts with context.read before responding: ' + turn.contexts.join(', ') + '. Reply with annotation.reply and explicit result resource versions.' : '');
      // The Agent's session ended with its process: after Rho restarts, and on a machine that
      // never ran the session a project was copied from. The messages Rho kept are the record, so
      // the message runs in a new session told what was said before. Nothing is resent as a new
      // request, and the turn names the session it replaced. An Agent reports a session it no
      // longer has as a failed completion rather than a thrown request, so both are read alike.
      const stale = (completion: { state?: string | null; problem?: string | null }) =>
        !!c.acpSessionId && !attached && !controller.signal.aborted && completion.state === 'failed' && lostSession(completion.problem ?? '');
      const again = async () => {
        const earlier = c.acpSessionId!;
        await this.retire(project.id + '/' + c.id);
        c.acpSessionId = undefined; delete c.observation;
        turn.continued = { at: now(), earlier }; turn.problem = null; this.schedule(project, c);
        driver = await this.driver(project, c);
        return send(earlierQuestions(c.turns.filter(t => t.id !== turn.id), this.limits) + '\n\n' + utterance);
      };
      let completion;
      try {
        completion = await send(utterance);
        if (stale(completion)) completion = await again();
        else if (attached && completion.state === 'failed' && lostSession(completion.problem ?? '')) {
          completion = { ...completion, state: 'unknown', problem: 'The Agent reported that its session was unavailable after this message was sent. The outcome is unknown; the message was not sent again.' };
        }
      } catch (error) {
        if (!c.acpSessionId || attached || !lostSession(error) || controller.signal.aborted) throw error;
        completion = await again();
      }
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
      : generic(c.backend) ? 'Descriptions are written with Claude Code; this session\'s Agent is another ACP Agent.'
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
