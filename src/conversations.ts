import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConversation, AgentPermission, ConversationStep, ConversationEvent, ClaudeAcpOptions, CodexAcpOptions, SessionObservation, ConfigOption, ClaudeAcpConversation } from '@rho-workspace/plugin-agent/conversation';
import { randomBytes, randomUUID } from 'node:crypto';
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
  maxComparedFiles: 20000, maxChangedFiles: 200
};
type StopReason = 'person' | 'closing' | 'wall-limit' | 'output-limit' | 'line-limit' | 'identity';
type Step = ConversationStep;
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
}
interface FileChange { path: string; change: 'added' | 'modified' | 'removed'; modifiedAt: string | null; bytes: number | null }
interface Disk { files: Map<string, { modified: number; bytes: number }>; partial: boolean }
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
interface AgentSettings { format: 1; version: number; updatedAt: string | null; backend: Backend | null; choices: Partial<Record<Backend, Choices>>; offered: Partial<Record<Backend, Offered>> }
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
interface Live { project: Project; conversation: Conversation; turn: Turn; controller: AbortController; stop(reason: StopReason, by: string): void; done: Promise<void>; before?: Disk | null }
export interface ConversationPorts {
  // The project's Agent grant for this conversation, written to a private connection file.
  grant(project: Project, conversation: { id: string; title: string; client: string }): Promise<{ file: string; principal: string }>;
  directory(project: Project): Promise<string>;
  changed(project: Project, conversationId: string): Promise<void>;
  // Local Claude Code plugin directories a Claude session loads: skills and hooks of the selected plugins.
  claudePlugins?(project: Project): Promise<string[]>;
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
  constructor(private ports: ConversationPorts, public binary = 'claude', limits: Partial<typeof conversationLimits> = {}, private config: ConversationConfig = {}) {
    this.limits = { ...conversationLimits, ...limits };
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
    if (turn.state !== 'running' || this.liveTurn(project, c, turn)) return turn;
    return { ...turn, permissions: turn.permissions?.map(p => p.state === 'pending' ? { ...p, state: 'cancelled' as const } : p), state: 'unknown' as const, problem: turn.problem ?? 'Rho stopped before this message was answered. Steps after the last one shown are not known, and the message was not sent again.' };
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
  async start(project: Project, by: string, input: { changeId: string; text: string; backend?: Backend; config?: Choices }) {
    requireThat(!input.backend || backends.includes(input.backend), 'invalid', 'Choose Claude Code or Codex.');
    if (input.config) this.choices(input.config);
    const text = this.message(input.text), requestDigest = digest(canonical({ text, ...(input.backend ? { backend: input.backend } : {}), ...(input.config ? { config: input.config } : {}) }));
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
      const turn = this.turn(input.changeId, requestDigest, by, text, 1);
      c.turns.push(turn);
      // Recorded before the process starts, so a crash in between leaves an unknown message, never a resend.
      await this.write(project, c);
      this.launch(project, c, turn);
      return this.reply(project, c, turn);
    });
  }
  async send(project: Project, by: string, input: { conversationId: string; changeId: string; text: string }) {
    const text = this.message(input.text), requestDigest = digest(canonical({ text }));
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
      const turn = this.turn(input.changeId, requestDigest, by, text, c.turns.length + 1);
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
    return { version: s.version, updatedAt: s.updatedAt, backend: s.backend, serviceBackend: service, choices: s.choices, offered: s.offered, checking: [...this.checks.keys()] };
  }
  async settings() { return this.settingsView(await this.readSettings()); }
  // The person's Agent and settings for new conversations. Each Agent's choices are replaced as a
  // whole and must be among the values it last offered; a stale version is refused.
  async updateSettings(input: { expectedVersion: number; backend?: Backend | null; choices?: Partial<Record<Backend, Choices>> }) {
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
    this.live.set(key, live);
    live.done = this.run(live).catch(() => { turn.problem ??= 'Rho lost track of this message. Received steps were kept; it was not sent again.'; })
      .finally(async () => {
        if (turn.state === 'running') turn.state = 'unknown';
        turn.endedAt ??= now();
        if (live.before) {
          const after = await disk(project.root, this.limits.maxComparedFiles).catch(() => null);
          if (after) turn.files = compare(live.before, after, this.limits.maxChangedFiles);
        }
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
        // A first session opened without the person's choices shows what the Agent offers by default.
        if (learned) void this.offer(c.backend as Backend, { at: config.at, source: 'conversation', adapter: c.adapter ?? null, options: config.options, omitted: config.omitted }).catch(() => {});
      } };
      const common = { cwd: project.root, mcpServers, limits: this.limits, sessionId: c.acpSessionId, config: c.config, ...observed };
      const driver = c.backend === 'codex-acp'
        ? new CodexAcpConversation({ ...this.config.codexAcp, ...common, codex: this.config.codex })
        : c.backend === 'claude-acp'
          ? new ClaudeAcpConversation({ ...this.config.claudeAcp, ...common, claude: this.binary, plugins: [...this.config.claudeAcp?.plugins ?? [], ...await this.ports.claudePlugins?.(project) ?? []] })
          : new ClaudeCliConversation({ cwd: project.root, binary: this.binary, sessionId: c.nativeSessionId!, confirmed: c.confirmed, projectName: project.name ?? path.basename(project.root), mcpServers, limits: this.limits });
      this.drivers.set(key, { driver, project, conversation: c }); return driver;
    });
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
      const next = { ...existing, ...incoming };
      if (incoming.text !== undefined) Object.assign(next, cut((event.append && existing ? existing.text ?? '' : '') + incoming.text, this.limits.maxTextBytes));
      const size = Buffer.byteLength(JSON.stringify({ steps: turn.steps, permissions: turn.permissions })) - (existing ? Buffer.byteLength(JSON.stringify(existing)) : 0);
      if (size + Buffer.byteLength(JSON.stringify(next)) > this.limits.maxTurnBytes) turn.omitted++;
      else if (existing) Object.assign(existing, next); else turn.steps.push(next);
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
    try {
      const completion = await driver.run({ text: turn.text, signal: controller.signal,
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
    } finally { clearTimeout(wall); }
  }
}
