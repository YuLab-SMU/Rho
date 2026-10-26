import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, canonical, digest, Fault, now, readJson, requireThat } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';

// A conversation the person starts in Rho. Rho holds its input: the person writes in the Agent
// panel, and Rho runs the person's own Claude Code CLI in the project folder, one process per
// message, with this project's Agent grant and no other tools. The conversation is Claude Code's
// session under its native id, kept in Claude Code's own store; each later message resumes that
// id. Rho keeps what the person sent, what the Agent wrote back (never hidden reasoning), the
// tools it called and how each message ended. A session started outside Rho keeps its own window
// as its entry; Rho only shows its work.
export const conversationLimits = {
  // Conversations kept per project; starting another is refused.
  maxConversations: 64,
  // Messages kept per conversation; sending another is refused.
  maxTurns: 200,
  // One message from the person, in UTF-8 bytes.
  maxMessageBytes: 16384,
  // One conversation record on disk; past it, new messages are refused.
  maxRecordBytes: 8388608,
  // Text and tool steps kept for one message; later ones are counted, not kept.
  maxTurnBytes: 262144,
  // One kept text block; a longer one keeps its start and says it was cut.
  maxTextBytes: 65536,
  // Messages being answered at once by this service; another is refused until one ends.
  maxRunning: 4,
  // Claude Code's own step limit (--max-turns) for one message.
  maxAgentTurns: 64,
  // One message's wall time; past it the process is stopped and the stop recorded.
  turnWallMs: 1800000,
  // What Claude Code may write for one message, and in one record; past either it is stopped.
  maxOutputBytes: 33554432, maxLineBytes: 4194304,
  // Between asking a process to stop and forcing it.
  stopGraceMs: 5000
};
const rhoTools = ['rho_index', 'rho_resolve', 'rho_call', 'rho_read'];
type StopReason = 'person' | 'closing' | 'wall-limit' | 'output-limit' | 'line-limit' | 'identity';
interface Step { kind: 'text' | 'tool' | 'error'; at: string; text?: string; cut?: boolean; id?: string; tool?: string; operation?: string; outcome?: 'requested' | 'returned' | 'rejected' | 'unknown' }
interface Turn {
  id: string; changeId: string; requestDigest: string; by: string; text: string; sentAt: string;
  state: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'; startedAt: string | null; endedAt: string | null; pid: number | null; model: string | null;
  stop: { requestedAt: string; by: string; reason: StopReason } | null; exit: { code: number | null; signal: string | null } | null;
  steps: Step[]; omitted: number; retry: { attempt: number | null; of: number | null; status: number | null; at: string } | null;
  result: { isError: boolean; kind: string | null; reason: string | null; steps: number | null; durationMs: number | null; costUsd: number | null; message: string | null } | null;
  problem: string | null;
}
interface Conversation {
  format: 1; id: string; changeId: string; requestDigest: string; createdAt: string; createdBy: string; updatedAt: string; version: number;
  client: 'claude-code'; nativeSessionId: string; confirmed: boolean; principal: string | null; title: string; turns: Turn[];
}
interface Summary { conversationId: string; changeId: string; requestDigest: string; title: string; client: string; principal: string | null; createdAt: string; updatedAt: string; version: number; turns: number; state: string; lastAt: string }
interface Live { project: Project; conversation: Conversation; turn: Turn; child: ChildProcess | null; stop(reason: StopReason, by: string): void; done: Promise<void> }
export interface ConversationPorts {
  // The project's Agent grant for this conversation, written to a private connection file.
  grant(project: Project, conversation: { id: string; title: string }): Promise<{ file: string; principal: string }>;
  directory(project: Project): Promise<string>;
  changed(project: Project, conversationId: string): Promise<void>;
}
const identity = /^c-[a-f0-9]{16}$/;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const word = (value: unknown) => typeof value === 'string' && value ? value : null;
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
  constructor(private ports: ConversationPorts, public binary = 'claude', limits: Partial<typeof conversationLimits> = {}) { this.limits = { ...conversationLimits, ...limits }; }

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
    return readJson<{ format: 1; conversations: Summary[] }>(path.join(await this.folder(project), 'index.json'), { format: 1, conversations: [] });
  }
  private async load(project: Project, id: string): Promise<Conversation> {
    requireThat(identity.test(id), 'not_found', 'No conversation has that identity in this project.');
    for (const live of this.live.values()) if (live.project.id === project.id && live.conversation.id === id) return live.conversation;
    const file = path.join(await this.folder(project), id + '.json');
    const stat = await fs.stat(file).catch((e: any) => { if (e.code === 'ENOENT') throw new Fault('not_found', 'No conversation has that identity in this project.'); throw e; });
    requireThat(stat.size <= this.limits.maxRecordBytes + 1048576, 'limit', 'This conversation record is larger than Rho reads; it is kept as it is.', { limit: 'maxRecordBytes' });
    const value = await readJson<Conversation>(file);
    requireThat(value?.format === 1 && value.id === id && Array.isArray(value.turns), 'storage', 'This conversation record is unreadable; it is kept as it is.');
    return value;
  }
  private summary(c: Conversation): Summary {
    const last = c.turns.at(-1);
    return { conversationId: c.id, changeId: c.changeId, requestDigest: c.requestDigest, title: c.title, client: c.client, principal: c.principal, createdAt: c.createdAt, updatedAt: c.updatedAt, version: c.version, turns: c.turns.length, state: last?.state ?? 'idle', lastAt: last?.endedAt ?? last?.sentAt ?? c.createdAt };
  }
  private async write(project: Project, c: Conversation) {
    const directory = await this.folder(project);
    c.version++; c.updatedAt = now();
    await atomicJson(path.join(directory, c.id + '.json'), c);
    const index = await this.index(project);
    await atomicJson(path.join(directory, 'index.json'), { format: 1, conversations: [...index.conversations.filter(x => x.conversationId !== c.id), this.summary(c)] });
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
    return { ...turn, state: 'unknown' as const, problem: turn.problem ?? 'Rho stopped before this message was answered. Steps after the last one shown are not known, and the message was not sent again.' };
  }
  private reply(project: Project, c: Conversation, turn: Turn) { return { conversation: this.listed(project, this.summary(c)), turn: this.view(project, c, turn) }; }
  private listed(project: Project, s: Summary) {
    const live = [...this.live.values()].some(x => x.project.id === project.id && x.conversation.id === s.conversationId);
    const { changeId, requestDigest, ...shown } = s;
    return { ...shown, state: s.state === 'running' && !live ? 'unknown' : s.state };
  }
  private message(text: string) {
    requireThat(typeof text === 'string' && text.trim().length > 0, 'invalid', 'Write a message first.');
    requireThat(Buffer.byteLength(text) <= this.limits.maxMessageBytes, 'limit', `A message holds at most ${this.limits.maxMessageBytes} bytes.`, { limit: 'maxMessageBytes', maximum: this.limits.maxMessageBytes });
    return text;
  }
  private capacity() {
    requireThat(!this.closing, 'unavailable', 'Rho is closing. Nothing was sent.');
    requireThat(this.live.size < this.limits.maxRunning, 'limit', `Claude Code is already answering ${this.live.size} messages here. Wait for one to finish.`, { limit: 'maxRunning', maximum: this.limits.maxRunning });
  }
  private turn(changeId: string, requestDigest: string, by: string, text: string, index: number): Turn {
    return { id: 't' + index, changeId, requestDigest, by, text, sentAt: now(), state: 'running', startedAt: null, endedAt: null, pid: null, model: null, stop: null, exit: null, steps: [], omitted: 0, retry: null, result: null, problem: null };
  }

  async list(project: Project) {
    const index = await this.index(project);
    return index.conversations.map(s => this.listed(project, s)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async read(project: Project, input: { conversationId: string; before?: number; limit?: number }) {
    const c = await this.load(project, input.conversationId);
    const end = Math.min(input.before ?? c.turns.length, c.turns.length), start = Math.max(0, end - (input.limit ?? 50));
    return { conversation: this.listed(project, this.summary(c)), first: start, turns: c.turns.slice(start, end).map(t => this.view(project, c, t)) };
  }
  // The caller holds the request identity: a repeat with the same words returns the original
  // conversation or message and starts nothing; changed words under that identity are refused.
  async start(project: Project, by: string, input: { changeId: string; text: string }) {
    const text = this.message(input.text), requestDigest = digest(canonical({ text }));
    return this.serial(project.id, async () => {
      const index = await this.index(project), existing = index.conversations.find(x => x.changeId === input.changeId);
      if (existing) {
        requireThat(existing.requestDigest === requestDigest, 'conflict', 'That request identity already started a different conversation.');
        const c = await this.load(project, existing.conversationId); return this.reply(project, c, c.turns[0]);
      }
      requireThat(index.conversations.length < this.limits.maxConversations, 'limit', `This project keeps at most ${this.limits.maxConversations} conversations started in Rho.`, { limit: 'maxConversations', maximum: this.limits.maxConversations });
      this.capacity();
      const at = now(), c: Conversation = { format: 1, id: 'c-' + randomBytes(8).toString('hex'), changeId: input.changeId, requestDigest, createdAt: at, createdBy: by, updatedAt: at, version: 0, client: 'claude-code', nativeSessionId: randomUUID(), confirmed: false, principal: null, title: titleOf(text), turns: [] };
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
      const last = c.turns.at(-1);
      requireThat(!last || last.state !== 'running' || !this.liveTurn(project, c, last), 'conflict', 'Claude Code is still answering the previous message. Wait for it, or stop it, before sending another.');
      if (last?.state === 'running' && last.pid) {
        let alive = false; try { process.kill(last.pid, 0); alive = true; } catch {}
        requireThat(!alive, 'conflict', `Claude Code from before Rho restarted may still be answering (process ${last.pid}). End that process before sending another message.`);
      }
      requireThat(c.turns.length < this.limits.maxTurns, 'limit', `A conversation keeps at most ${this.limits.maxTurns} messages. Start a new conversation.`, { limit: 'maxTurns', maximum: this.limits.maxTurns });
      requireThat(Buffer.byteLength(JSON.stringify(c)) + this.limits.maxTurnBytes + this.limits.maxMessageBytes <= this.limits.maxRecordBytes, 'limit', 'This conversation has reached the size Rho keeps. Start a new conversation.', { limit: 'maxRecordBytes', maximum: this.limits.maxRecordBytes });
      this.capacity();
      for (const old of c.turns) if (old.state === 'running') Object.assign(old, this.view(project, c, old));
      const turn = this.turn(input.changeId, requestDigest, by, text, c.turns.length + 1);
      c.turns.push(turn);
      await this.write(project, c);
      this.launch(project, c, turn);
      return this.reply(project, c, turn);
    });
  }
  // A stop is a request until the process is seen to end; what was already done stays done.
  async stop(project: Project, by: string, input: { conversationId: string; turnId: string }) {
    return this.serial(project.id, async () => {
      const c = await this.load(project, input.conversationId), turn = c.turns.find(t => t.id === input.turnId);
      requireThat(turn, 'not_found', 'No message has that identity in this conversation.');
      const live = this.liveTurn(project, c, turn);
      if (live) { live.stop('person', by); await this.write(project, c); }
      return this.reply(project, c, turn);
    });
  }
  async close() {
    this.closing = true;
    for (const live of this.live.values()) live.stop('closing', 'rho');
    await Promise.all([...this.live.values()].map(live => live.done));
    await Promise.all([...this.queues.values()].map(task => task.catch(() => {})));
  }

  private launch(project: Project, c: Conversation, turn: Turn) {
    const key = project.id + '/' + c.id + '/' + turn.id;
    const live: Live = { project, conversation: c, turn, child: null, done: Promise.resolve(), stop: (reason, by) => {
      if (turn.stop) return;
      turn.stop = { requestedAt: now(), by, reason };
      const signal = (name: NodeJS.Signals) => { if (live.child?.pid) try { process.kill(-live.child.pid, name); } catch {} };
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), this.limits.stopGraceMs).unref();
    } };
    this.live.set(key, live);
    live.done = this.run(live).catch(e => { turn.problem ??= 'Rho lost track of this message: ' + (e instanceof Error ? e.message : String(e)); })
      .finally(async () => {
        if (turn.state === 'running') turn.state = 'unknown';
        turn.endedAt ??= now();
        const pending = this.flushes.get(project.id + '/' + c.id); if (pending) { clearTimeout(pending); this.flushes.delete(project.id + '/' + c.id); }
        // The message stays held until its ending is written, so closing waits for that write.
        await this.serial(project.id, () => this.write(project, c)).catch(() => {});
        this.live.delete(key);
      });
  }
  private async run(live: Live) {
    const { project, conversation: c, turn } = live;
    let grant;
    try { grant = await this.ports.grant(project, c); }
    catch (e) {
      turn.state = 'failed'; turn.endedAt = now();
      turn.problem = 'Rho could not give this conversation access to the project. ' + (e instanceof Error ? e.message : ''); return;
    }
    c.principal = grant.principal;
    // Stopped before Claude Code started: nothing ran for this message.
    if (turn.stop) { turn.state = 'stopped'; turn.endedAt = now(); return; }
    const mcp = JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/mcp'))], env: { RHO_AGENT_CONNECTION: grant.file } } } });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(c.confirmed ? ['--resume', c.nativeSessionId] : ['--session-id', c.nativeSessionId]),
      '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', ...rhoTools.map(name => 'mcp__rho__' + name),
      '--permission-mode', 'dontAsk', '--max-turns', String(this.limits.maxAgentTurns),
      '--append-system-prompt', `You were started from Rho by the person working in the Rho project "${project.name ?? path.basename(project.root)}". They read your replies in Rho's Agent panel, next to the project's files, documents, tables, figures and runs. Work on the project through the rho tools: rho_index finds operations, rho_resolve gives their contracts, rho_call calls one and rho_read reads a large result. Keep results in this project and say what you changed or ran.`];
    const child = spawn(this.binary, args, { cwd: project.root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    live.child = child;
    turn.startedAt = now(); turn.pid = child.pid ?? null;
    const ended = new Promise<{ code: number | null; signal: string | null; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(turn.text);
    let bytes = 0, stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > this.limits.maxOutputBytes) live.stop('output-limit', 'rho'); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }), read = once(lines, 'close');
    lines.on('line', line => {
      if (Buffer.byteLength(line) > this.limits.maxLineBytes) return live.stop('line-limit', 'rho');
      let record: any; try { record = JSON.parse(line); } catch { return; }
      if (this.observe(c, turn, record)) this.schedule(project, c);
      else live.stop('identity', 'rho');
    });
    const wall = setTimeout(() => live.stop('wall-limit', 'rho'), this.limits.turnWallMs); wall.unref();
    const end = await ended; clearTimeout(wall);
    await Promise.race([read, new Promise(resolve => setTimeout(resolve, 1000).unref())]);
    turn.exit = { code: end.code, signal: end.signal }; turn.endedAt = now(); turn.retry = null;
    for (const step of turn.steps) if (step.kind === 'tool' && step.outcome === 'requested') step.outcome = 'unknown';
    if (turn.result) turn.state = turn.result.isError ? 'failed' : 'completed';
    else if (turn.stop) turn.state = 'stopped';
    else {
      turn.state = 'failed';
      const said = stderr.trim().split('\n').filter(Boolean).at(-1);
      turn.problem ??= end.error ? `Claude Code could not be started (${(end.error as NodeJS.ErrnoException).code ?? end.error.message}). Install it, or start Rho with --claude pointing to it.`
        : `Claude Code ended (${end.signal ?? 'exit ' + end.code}) without finishing this message.${said ? ' It said: ' + cut(said, 1024).text : ''}`;
    }
  }
  // Returns false when the record names another native session: the conversation's identity is
  // the session Rho started, and a stream about a different one is not this conversation.
  private observe(c: Conversation, turn: Turn, record: any) {
    if (typeof record?.session_id === 'string' && record.session_id !== c.nativeSessionId) {
      turn.problem = 'Claude Code reported a different session, so Rho stopped this message to keep the conversation as it was.'; return false;
    }
    const add = (step: Step) => {
      const size = turn.steps.reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s)), 0);
      if (size + Buffer.byteLength(JSON.stringify(step)) > this.limits.maxTurnBytes) turn.omitted++; else turn.steps.push(step);
    };
    if (record?.type === 'system' && record.subtype === 'init') { c.confirmed = true; turn.model = word(record.model); return true; }
    if (record?.type === 'system' && record.subtype === 'api_retry') { turn.retry = { attempt: number(record.attempt), of: number(record.max_retries), status: number(record.error_status), at: now() }; return true; }
    const content: any[] = Array.isArray(record?.message?.content) ? record.message.content : [];
    if (record?.type === 'assistant') {
      // A provider failure arrives as a synthetic assistant message; it is not the Agent's words.
      if (record.is_api_error_message || record.message?.model === '<synthetic>') {
        for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') add({ kind: 'error', at: now(), ...cut(block.text, 4096) });
        return true;
      }
      turn.retry = null;
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) add({ kind: 'text', at: now(), ...cut(block.text, this.limits.maxTextBytes) });
        if (block?.type === 'tool_use') {
          const operation = block.name === 'mcp__rho__rho_call' && typeof block.input?.operation === 'string' ? block.input.operation : undefined;
          add({ kind: 'tool', at: now(), id: String(block.id), tool: String(block.name), ...(operation ? { operation } : {}), outcome: 'requested' });
        }
      }
      return true;
    }
    if (record?.type === 'user') {
      for (const block of content) if (block?.type === 'tool_result') {
        const step = turn.steps.find(s => s.kind === 'tool' && s.id === block.tool_use_id);
        if (step) step.outcome = block.is_error ? 'rejected' : 'returned';
      }
      return true;
    }
    if (record?.type === 'result') turn.result = { isError: record.is_error === true, kind: word(record.subtype), reason: word(record.terminal_reason), steps: number(record.num_turns), durationMs: number(record.duration_ms), costUsd: number(record.total_cost_usd), message: record.is_error === true ? cut(String(record.result ?? ''), 4096).text : null };
    return true;
  }
}
