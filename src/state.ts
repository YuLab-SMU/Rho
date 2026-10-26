import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { atomicJson, confined, digest, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
export interface SourceFolder { id: string; root: string; name: string }
export interface FolderSelection extends SourceFolder { principalId: string; expiresAt: number }
export interface Project { id: string; root: string; openedAt: string; nativeSelected?: true; name?: string; sources?: SourceFolder[]; workspace?: true; visibilityRoot?: string; creation?: { id: string; digest: string; author: string } }
export interface Principal { id: string; tokenHash: string; projectId?: string; methods: string[]; kind?: 'browser'; profile?: 'layered-business' | 'layered-presentation'; pluginFilter?: string[]; projectRoot?: string; selectedProjects?: string[]; expiresAt?: string; label?: string; conversationId?: string }
export async function lease(directory: string) {
  // Best effort: say who holds it when the platform can tell us. Never a failure.
  const holder = (file: string) => {
    try {
      const out = spawnSync('lsof', ['-nP', '-t', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
      const pid = out.stdout?.trim().split('\n').filter(Boolean)[0];
      return pid ? { pid: Number(pid) } : null;
    } catch { return null; }
  };
  const file = path.join(directory, 'service.lock');
  // Kernel advisory lock on a stable inode, held by an owned helper until pipe
  // EOF. A service crash closes the pipe; no PID-reuse or stale-unlink race.
  await confined(directory, 'service.lock', true);
  const helper = spawn(process.env.RHO_PYTHON ?? 'python3', ['-c', `import fcntl, os, sys
fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
try: fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(9)
print('locked', flush=True)
sys.stdin.buffer.read()
os.close(fd)
`, file], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { helper.kill(); reject(new Error('Local writer lock timed out.')); }, 5000);
    helper.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    helper.once('error', () => { clearTimeout(timer); reject(new Error('Python 3 is required for local writer locking.')); });
    helper.once('exit', code => {
      clearTimeout(timer);
      if (code === 9) {
        // Name what is held and how to find the holder: "another service" told an
        // operator nothing, and a second state directory looked like a broken service.
        try { requireThat(false, 'conflict', `Another Rho service holds ${directory}. Stop it, or select a different --state-dir. Its writer lock is ${file}.`, { stateDirectory: directory, lockFile: file, remedy: 'Stop the service that owns this state directory, or start this one with a different --state-dir.', holder: holder(file) }); }
        catch (e) { reject(e); }
      }
      else if (code !== 0) reject(new Error('Local writer lock is unavailable.'));
    });
  });
  return async () => { const exited = once(helper, 'exit'); helper.stdin.end(); await exited; };
}
export class State {
  projects: Project[] = []; principals: Principal[] = [];
  private folderSelections: FolderSelection[] = [];
  private releases: (() => Promise<void>)[] = [];
  private principalWrites: Promise<void> = Promise.resolve();
  constructor(public root: string, public directory: string) {}
  async init() {
    this.root = await fs.realpath(this.root);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await fs.realpath(this.directory);
    this.releases.push(await lease(this.directory));
    this.projects = await readJson(path.join(this.directory, 'projects.json'), []);
    this.principals = await readJson(path.join(this.directory, 'principals.json'), []);
  }
  private persistPrincipals() {
    // Agent grants and browser pairing use different request queues, but share
    // one durable principal list. A late write must not overwrite a newer grant.
    const write = this.principalWrites.catch(() => {}).then(() => atomicJson(path.join(this.directory, 'principals.json'), this.principals));
    this.principalWrites = write; return write;
  }
  async addPrincipal(principal: Principal) { this.principals.push(principal); await this.persistPrincipals(); }
  async revokeBrowser(id: string) {
    // This machine's own identity is not a session to revoke: the person can simply reopen the
    // url. Refusing keeps one typo from locking the page out until the service restarts.
    requireThat(id !== 'browser:local', 'scope', 'This machine is not a revocable session. Close the tab instead.');
    const previous = this.principals.find(p => p.id === id && p.kind === 'browser');
    this.principals = this.principals.filter(p => p !== previous);
    await this.persistPrincipals();
    return { sessionId: id, revoked: !!previous };
  }
  private liveBrowser(principal: Principal, method: string) {
    // The local person's access does not expire; a linked tab's does.
    requireThat(this.principals.includes(principal) && principal.kind === 'browser' && principal.methods.includes(method) && (!principal.expiresAt || Date.parse(principal.expiresAt) > Date.now()), 'unauthorized', 'This tab no longer has access. No folder was added.');
  }
  private async selectedSource(root: string): Promise<SourceFolder> {
    root = await fs.realpath(root);
    requireThat(!root.split(path.sep).some(p => ['.rho', '.git'].includes(p)) && root !== this.directory && !root.startsWith(this.directory + path.sep) && !this.directory.startsWith(root + path.sep) && (await fs.stat(root)).isDirectory(), 'scope', 'Choose a source folder that does not contain Rho service credentials or internal state.');
    return { id: digest(root).slice(0, 32), root, name: path.basename(root) || root };
  }
  async selectFolder(root: string, principal: Principal, ttl: number, maximum: number) {
    this.liveBrowser(principal, 'project.source.pick');
    const source = await this.selectedSource(root);
    this.folderSelections = this.folderSelections.filter(s => s.expiresAt > Date.now());
    const existing = this.folderSelections.find(s => s.principalId === principal.id && s.root === source.root);
    if (existing) { existing.expiresAt = Date.now() + ttl; return { selectionId: existing.id, ...source }; }
    requireThat(this.folderSelections.filter(s => s.principalId === principal.id).length < maximum, 'limit', 'Too many pending folder choices. Existing projects are retained.', { limit: 'nativeFolders.maxSelections', maximum });
    const selection = { ...source, id: randomUUID(), principalId: principal.id, expiresAt: Date.now() + ttl };
    this.folderSelections.push(selection);
    return { selectionId: selection.id, ...source };
  }
  async createWorkspace(name: string, selectionIds: string[], changeId: string, principal: Principal, maximum: number, maxSources: number) {
    this.liveBrowser(principal, 'project.createWorkspace');
    const inputDigest = digest(JSON.stringify({ name, selectionIds }));
    const retained = this.projects.find(p => p.creation?.id === changeId && p.creation.author === principal.id);
    if (retained) {
      requireThat(retained.creation?.digest === inputDigest, 'conflict', 'The original project creation has different content.');
      await atomicJson(path.join(this.directory, 'projects.json'), this.projects);
      principal.selectedProjects = [...new Set([...(principal.selectedProjects ?? []), retained.id])];
      await this.persistPrincipals(); return retained;
    }
    const chosen = selectionIds.map(id => this.folderSelections.find(s => s.id === id && s.principalId === principal.id && s.expiresAt > Date.now()));
    requireThat(chosen.every(Boolean), 'stale', 'A folder choice expired. Choose that folder again.');
    const sources: SourceFolder[] = [];
    for (const selected of chosen) { const source = await this.selectedSource(selected!.root); if (!sources.some(s => s.id === source.id)) sources.push(source); }
    requireThat(sources.length <= maxSources, 'limit', 'The project exceeds its source-folder limit. Existing folders are retained.', { limit: 'nativeFolders.maxSources', maximum: maxSources });
    requireThat(this.projects.filter(p => p.workspace && p.visibilityRoot === principal.projectRoot).length < maximum, 'limit', 'The project limit is full; existing projects are retained.', { limit: 'nativeFolders.maxProjects', maximum });
    this.liveBrowser(principal, 'project.createWorkspace');
    const id = randomUUID().replaceAll('-', ''), root = path.join(this.directory, 'workspaces', id);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const project: Project = { id, root, name: name.trim(), sources, workspace: true, visibilityRoot: principal.projectRoot, openedAt: new Date().toISOString(), creation: { id: changeId, digest: inputDigest, author: principal.id } };
    await this.acquire(project); this.projects.push(project);
    await atomicJson(path.join(this.directory, 'projects.json'), this.projects);
    principal.selectedProjects = [...new Set([...(principal.selectedProjects ?? []), project.id])];
    await this.persistPrincipals();
    this.folderSelections = this.folderSelections.filter(s => !selectionIds.includes(s.id));
    return project;
  }
  async addSource(project: Project, root: string, principal: Principal, maximum: number) {
    this.liveBrowser(principal, 'project.source.add');
    const source = await this.selectedSource(root);
    const sources = project.sources ?? [{ id: digest(project.root).slice(0, 32), root: project.root, name: path.basename(project.root) }];
    if (!sources.some(s => s.id === source.id)) {
      requireThat(sources.length < maximum, 'limit', 'This project has reached its source-folder limit. Existing folders remain available.', { limit: 'nativeFolders.maxSources', maximum });
      sources.push(source);
    }
    this.liveBrowser(principal, 'project.source.add'); project.sources = sources;
    await atomicJson(path.join(this.directory, 'projects.json'), this.projects);
    return project;
  }
  async open(relative: string) {
    requireThat(!relative.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Internal owner state is not a project.');
    const root = await confined(this.root, relative);
    return this.openRoot(root);
  }
  // Trusted native-dialog result only; never called with an HTTP-supplied path.
  async openSelected(root: string, principal: Principal, maxProjects: number) {
    // The local person's access does not expire; a linked tab's does. Demanding an expiry here
    // refused every folder this machine's own tab picked, after the person had chosen it.
    requireThat(this.principals.includes(principal) && principal.kind === 'browser' && principal.methods.includes('project.pick') && (!principal.expiresAt || Date.parse(principal.expiresAt) > Date.now()), 'unauthorized', 'This tab no longer has access. No selected folder was opened.');
    const selected = principal.selectedProjects ?? [];
    const canonical = await fs.realpath(root), id = digest(canonical).slice(0, 32);
    requireThat(selected.includes(id) || selected.length < maxProjects, 'limit', 'This tab has reached its selected-project limit. Existing projects remain available.', { limit: 'nativeFolders.maxProjects', maximum: maxProjects });
    const project = await this.openRoot(canonical, true);
    // Grant exactly this project, never its parent, siblings or descendants as projects.
    principal.selectedProjects = [...new Set([...selected, project.id])];
    await this.persistPrincipals();
    return project;
  }
  private async openRoot(root: string, nativeSelected = false) {
    requireThat(!root.split(path.sep).some(p => ['.rho', '.git'].includes(p)), 'scope', 'Internal owner state is not a project.');
    requireThat(root !== this.directory && !root.startsWith(this.directory + path.sep) && !this.directory.startsWith(root + path.sep) && (await fs.stat(root)).isDirectory(), 'scope', 'Select a project directory that does not contain service credentials or internal state.');
    const id = digest(root).slice(0, 32);
    let project = this.projects.find(p => p.id === id);
    if (!project) {
      project = { id, root, openedAt: new Date().toISOString(), ...(nativeSelected ? { nativeSelected: true as const } : {}) };
      await this.acquire(project);
      this.projects.push(project);
      await atomicJson(path.join(this.directory, 'projects.json'), this.projects);
    } else await this.acquire(project);
    return project;
  }
  visible(project: Project, principal: Principal) {
    return (!principal.projectId || principal.projectId === project.id) && (!principal.projectRoot || project.root === principal.projectRoot || project.root.startsWith(principal.projectRoot + path.sep) || !!principal.selectedProjects?.includes(project.id));
  }
  private acquired = new Set<string>();
  private async acquire(project: Project) {
    if (!this.acquired.has(project.id)) {
      const directory = await stateDirectory(project.root, '.rho/rho');
      this.releases.push(await lease(directory)); this.acquired.add(project.id);
    }
  }
  async project(id: string, principal: Principal) {
    requireThat(!principal.projectId || principal.projectId === id, 'scope', 'Credential belongs to a different project.');
    const project = this.projects.find(p => p.id === id);
    requireThat(project, 'not_found', 'Project is not registered.');
    requireThat(this.visible(project, principal), 'scope', 'Project is outside this credential’s selected folders.');
    if (principal.projectRoot && !principal.selectedProjects?.includes(project.id)) await confined(principal.projectRoot, path.relative(principal.projectRoot, project.root) || '.');
    if (project.nativeSelected || project.workspace) requireThat(await fs.realpath(project.root) === project.root, 'scope', 'The selected project folder changed. Select it again in the system dialog.');
    // A project opened at the service root has no relative path; '.' is that same place.
    else await confined(this.root, path.relative(this.root, project.root) || '.');
    await this.acquire(project); return project;
  }
  async close() { for (const release of this.releases.splice(0).reverse()) await release(); this.acquired.clear(); }
}
