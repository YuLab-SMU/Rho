import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { confined, digest, requireThat } from '@rho-workspace/plugin-contracts';
import type { Principal, State } from './state.js';

export const browserLimits = { maxSessions: 16, maxPairings: 8, pairingTtlMs: 300000, sessionTtlMs: 43200000, maxPairAttempts: 32 };
// U1 observes and chooses projects. U2 adds identity-bearing buffer edits,
// author-scoped undo, per-change revert, bounded table pages and selection.
// Saving, abandoning saves, global undo and execution remain Agent/operator work.
export const browserMethods = ['protocol.describe', 'project.list', 'project.open', 'project.create', 'project.pick', 'project.createWorkspace', 'project.source.pick', 'project.source.add', 'capability.list', 'observation.snapshot', 'composition.read', 'document.read', 'resource.read', 'skill.list', 'skill.read',
  'document.edit', 'document.undoOwn', 'document.revert', 'document.history', 'document.change.read', 'data.page', 'interaction.selection.read', 'interaction.selection.set', 'view.observe', 'view.observations.read', 'feedback.submit', 'feedback.status', 'annotation.read',
  // People see and steer the task map; only the Agent declares its items.
  'task.map.read', 'task.map.present', 'task.map.respond'];
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
    const sessions = this.state.principals.filter(p => p.kind === 'browser' && Date.parse(p.expiresAt ?? '') > now);
    requireThat(sessions.length < this.limits.maxSessions, 'limit', 'Browser session limit reached; existing sessions are retained.', { limit: 'browser.maxSessions' });
    const token = randomBytes(32).toString('hex'), expiresAt = new Date(now + this.limits.sessionTtlMs).toISOString();
    const principal: Principal = { id: 'browser:' + randomBytes(16).toString('hex'), kind: 'browser', tokenHash: digest(token), projectRoot: pairing.root, selectedProjects: pairing.selectedProjects, methods: [...pairing.methods], expiresAt };
    // Consume synchronously before awaiting storage: two tabs cannot redeem once.
    this.pairings = this.pairings.filter(p => p !== pairing);
    this.state.principals = this.state.principals.filter(p => p.kind !== 'browser' || Date.parse(p.expiresAt ?? '') > now);
    await this.state.addPrincipal(principal);
    return { token, expiresAt, principalId: principal.id, methods: principal.methods, root: principal.projectRoot, rootLabel: await homeRelative(pairing.root) };
  }
}
// A display form of the folder (for example ~/projects); requests keep using root-relative paths.
async function homeRelative(root: string) {
  const home = await fs.realpath(homedir()).catch(() => homedir());
  return root === home ? '~' : root.startsWith(home + path.sep) ? '~/' + path.relative(home, root).split(path.sep).join('/') : root;
}
