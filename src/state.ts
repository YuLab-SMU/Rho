import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, confined, digest, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
export interface Project { id: string; root: string; openedAt: string }
export interface Principal { id: string; tokenHash: string; projectId?: string; methods: string[]; kind?: 'browser'; profile?: 'layered-business' | 'layered-presentation'; pluginFilter?: string[]; projectRoot?: string; expiresAt?: string }
export async function lease(directory: string) {
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
    helper.once('exit', code => { clearTimeout(timer); if (code === 9) { try { requireThat(false, 'conflict', 'Another local service holds this state directory.'); } catch (e) { reject(e); } } else if (code !== 0) reject(new Error('Local writer lock is unavailable.')); });
  });
  return async () => { const exited = once(helper, 'exit'); helper.stdin.end(); await exited; };
}
export class State {
  projects: Project[] = []; principals: Principal[] = [];
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
    const previous = this.principals.find(p => p.id === id && p.kind === 'browser');
    this.principals = this.principals.filter(p => p !== previous);
    await this.persistPrincipals();
    return { sessionId: id, revoked: !!previous };
  }
  async open(relative: string) {
    requireThat(!relative.split('/').some(p => ['.rho', '.git'].includes(p)), 'scope', 'Internal owner state is not a project.');
    const root = await confined(this.root, relative);
    requireThat(root !== this.directory && !root.startsWith(this.directory + path.sep) && !this.directory.startsWith(root + path.sep) && (await fs.stat(root)).isDirectory(), 'scope', 'Select a project directory that does not contain service credentials or internal state.');
    const id = digest(root).slice(0, 32);
    let project = this.projects.find(p => p.id === id);
    if (!project) {
      project = { id, root, openedAt: new Date().toISOString() };
      await this.acquire(project);
      this.projects.push(project);
      await atomicJson(path.join(this.directory, 'projects.json'), this.projects);
    } else await this.acquire(project);
    return project;
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
    if (principal.projectRoot) await confined(principal.projectRoot, path.relative(principal.projectRoot, project.root) || '.');
    await confined(this.root, path.relative(this.root, project.root));
    await this.acquire(project); return project;
  }
  async close() { for (const release of this.releases.splice(0).reverse()) await release(); this.acquired.clear(); }
}
