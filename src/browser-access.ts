import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { confined, digest, requireThat } from '@rho-workspace/plugin-contracts';
import type { Principal, State } from './state.js';

export const browserLimits = { maxSessions: 16, maxPairings: 8, pairingTtlMs: 300000, sessionTtlMs: 43200000, maxPairAttempts: 32 };
// U1 observes and chooses projects. U2 adds identity-bearing buffer edits,
// author-scoped undo, per-change revert, bounded table pages and selection.
// The person who selected a folder may also list it and open one of its text files
// in their own layout; registering resources and execution stay
// Agent/operator work.
export const browserMethods = ['protocol.describe', 'protocol.validate', 'project.list', 'project.open', 'project.create', 'project.pick', 'project.createWorkspace', 'project.source.pick', 'project.source.add', 'project.entries', 'project.openFile', 'project.doctor', 'project.runs', 'capability.list', 'observation.snapshot', 'composition.read', 'document.read', 'resource.read', 'skill.list', 'skill.read',
  'document.edit', 'document.save', 'document.undoOwn', 'document.revert', 'document.history', 'document.change.read', 'data.page', 'interaction.selection.read', 'interaction.selection.set', 'view.observe', 'view.observations.read', 'feedback.submit', 'feedback.status', 'annotation.read',
  // A person may prepare a context naming one exact object and version: that is how
  // they point the Agent at the thing they are asking about. It writes only that
  // reference, starts nothing, and the Agent's fetch stays a separate fact.
  'context.create', 'document.open', 'annotation.create', 'annotation.decide', 'resource.capture', 'data.compare',
  // People see and steer the task map; only the Agent declares its items.
  'task.map.read', 'task.map.present', 'task.map.respond',
  // A person runs an action from the form an Agent proposed, reads a run's bounded output,
  // and may stop a run of a project this pairing includes.
  'action.submit', 'action.output', 'action.cancel',
  // The person's own layout commands (split, move, close, divider, undo), conditional on the
  // version they saw; protected views stay protected.
  'composition.apply', 'composition.undo',
  // A chart's points: the same rows data.page already reads, bounded and read-only.
  'data.plot',
  // A run's script, outputs and provenance written as ordinary files in a new project folder.
  'action.export',
  // The files a run declared, registered so a person can open them, and checked against the
  // inventory the run wrote. Both read bytes and record facts; neither runs anything.
  'resource.list', 'artifact.check',
  // Read the project's selected observation namespace; capture only the exact
  // current file version chosen by the person. No Agent/Host lifecycle authority.
  'agent.activity.read', 'agent.activity.outputs', 'agent.activity.capture'];
// Only the person at this machine talks to a conversation Rho starts: it runs their own Claude
// Code with their model credentials. Only they add Rho to their own Agent's configuration. A
// narrower, expiring link never receives these.
export const conversationMethods = ['session.connect', 'conversation.start', 'conversation.send', 'conversation.stop', 'conversation.read', 'conversation.list', 'conversation.trash', 'conversation.restore', 'conversation.delete', 'conversation.permission', 'conversation.configure', 'conversation.settings.read', 'conversation.settings.update', 'conversation.settings.check', 'project.work.read', 'evidence.preview', 'evidence.export'];
// The person at this machine. A tab this service served is authorized by the request itself:
// same origin, loopback only, no link, no code and no expiry. `--pair` stays an explicit,
// narrower grant for a shared or subfolder-scoped tab.
export const localBrowserId = 'browser:local';
export function localBrowserPrincipal(root: string): Principal {
  // The empty token hash can never match a request digest, so no header impersonates this
  // identity: it is chosen because the request carried no credential at all.
  return { id: localBrowserId, kind: 'browser', tokenHash: '', projectRoot: root, methods: [...browserMethods, ...conversationMethods] };
}
interface Pairing { hash: string; root: string; methods: string[]; expires: number; selectedProjects: string[] }
export class BrowserAccess {
  limits: typeof browserLimits;
  private pairings: Pairing[] = [];
  private attempts: number[] = [];
  constructor(private state: State, limits: Partial<typeof browserLimits> = {}) { this.limits = { ...browserLimits, ...limits }; }
  async createPairing(root = this.state.root, methods = browserMethods) {
    const selectedRoot = await fs.realpath(root);
    await confined(this.state.root, path.relative(this.state.root, selectedRoot) || '.');
    requireThat((await fs.stat(selectedRoot)).isDirectory(), 'scope', 'Select a project directory root.');
    requireThat(methods.length > 0 && new Set(methods).size === methods.length && methods.every(m => browserMethods.includes(m)), 'scope', 'Browser grants cannot exceed the reviewed browser operation scope.');
    const now = Date.now(); this.pairings = this.pairings.filter(p => p.expires > now);
    requireThat(this.pairings.length < this.limits.maxPairings, 'limit', 'Pending browser pairing limit reached; existing sessions are retained.', { limit: 'browser.maxPairings' });
    const code = randomBytes(24).toString('base64url'), expires = now + this.limits.pairingTtlMs;
    this.pairings.push({ hash: digest(code), root: selectedRoot, methods: [...methods], expires, selectedProjects: this.state.projects.filter(p => p.workspace && p.visibilityRoot === selectedRoot).map(p => p.id) });
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  async pair(code: unknown) {
    const now = Date.now(); this.attempts = this.attempts.filter(t => t > now - 60000);
    requireThat(this.attempts.length < this.limits.maxPairAttempts, 'limit', 'Browser pairing attempt limit reached. Wait one minute; no existing session is changed.', { limit: 'browser.maxPairAttempts' });
    this.attempts.push(now);
    requireThat(typeof code === 'string' && /^[A-Za-z0-9_-]{32}$/.test(code), 'unauthorized', 'Pairing code is invalid, expired or already used.');
    const pairing = this.pairings.find(p => p.hash === digest(code) && p.expires > now);
    requireThat(pairing, 'unauthorized', 'Pairing code is invalid, expired or already used.');
    const sessions = this.state.principals.filter(p => p.kind === 'browser' && p.id !== localBrowserId && Date.parse(p.expiresAt ?? '') > now);
    requireThat(sessions.length < this.limits.maxSessions, 'limit', 'Browser session limit reached; existing sessions are retained.', { limit: 'browser.maxSessions' });
    const token = randomBytes(32).toString('hex'), expiresAt = new Date(now + this.limits.sessionTtlMs).toISOString();
    const principal: Principal = { id: 'browser:' + randomBytes(16).toString('hex'), kind: 'browser', tokenHash: digest(token), projectRoot: pairing.root, selectedProjects: pairing.selectedProjects, methods: [...pairing.methods], expiresAt };
    // Consume synchronously before awaiting storage: two tabs cannot redeem once.
    this.pairings = this.pairings.filter(p => p !== pairing);
    // Pruning expired tabs never touches the machine's own identity, which has no expiry.
    this.state.principals = this.state.principals.filter(p => p.id === localBrowserId || p.kind !== 'browser' || Date.parse(p.expiresAt ?? '') > now);
    await this.state.addPrincipal(principal);
    return { token, expiresAt, principalId: principal.id, methods: principal.methods, root: principal.projectRoot, rootLabel: await homeRelative(pairing.root) };
  }
}
// A display form of the folder (for example ~/projects); requests keep using root-relative paths.
async function homeRelative(root: string) {
  const home = await fs.realpath(homedir()).catch(() => homedir());
  return root === home ? '~' : root.startsWith(home + path.sep) ? '~/' + path.relative(home, root).split(path.sep).join('/') : root;
}
