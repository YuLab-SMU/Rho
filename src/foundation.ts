import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const foundationSchemaVersion = 1;
export const defaultFoundationBudgets = {
  tempMaxEntries: 10000,
  tempMaxBytes: 1024 * 1024 * 1024,
  tempTtlMs: 7 * 24 * 60 * 60 * 1000,
  cacheMaxBytes: 2 * 1024 * 1024 * 1024,
  logMaxBytes: 10 * 1024 * 1024,
  logFiles: 5,
  doctorMaxEntries: 10000,
  doctorMaxDepth: 4,
  doctorMaxMs: 30000,
} as const;

export type FoundationPathKey = 'config' | 'data' | 'state' | 'runtime' | 'cache' | 'logs' | 'projects' | 'manifest' | 'hosts';
export interface FoundationPaths {
  product: 'Rho';
  platform: NodeJS.Platform;
  home: string;
  app: string;
  config: string;
  configFile: string;
  data: string;
  state: string;
  runtime: string;
  cache: string;
  logs: string;
  projects: string;
  manifest: string;
  hosts: string;
  legacy: string[];
}

export interface FoundationManifest {
  schemaVersion: number;
  product: 'Rho';
  installationId: string;
  package?: { name: string; version: string; root: string; prefix?: string; digest?: string; owner: 'rho'; source: string; active: boolean };
  paths: Partial<Record<FoundationPathKey, string>>;
  bins: { name: string; path: string; target?: string; owner: 'rho'; digest?: string; deletion: 'remove-if-matches'; restore?: string }[];
  profiles: Record<string, { root: string; state: string; port?: number; logs?: string; plugins?: string[]; limits?: Record<string, unknown>; pid?: number; endpoint?: string; createdAt: string; updatedAt: string }>;
  hosts: { host: string; file: string; digest: string; entries: number; owner: 'rho'; pending?: boolean; updatedAt: string }[];
  operations: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FoundationStateEnvelope {
  schemaVersion: number;
  installationId: string;
  createdAt: string;
  owner: 'rho';
  source: string;
}

export interface FoundationProcessRecord {
  pid: number;
  kind: 'service' | 'worker' | 'helper';
  profile?: string;
  state?: string;
  endpoint?: string;
  command: string;
  args?: string[];
  parentPid?: number;
  workerDir?: string;
  startedAt: string;
  owner: 'rho';
}

export interface FoundationOperation {
  operationId: string;
  kind: string;
  state: 'planned' | 'running' | 'completed' | 'failed' | 'unknown' | 'rolled-back';
  createdAt: string;
  updatedAt: string;
  input?: unknown;
  stages: { name: string; state: 'planned' | 'running' | 'completed' | 'failed'; at: string; detail?: unknown }[];
  error?: string;
}

export interface FoundationCheck {
  id: string;
  state: 'ok' | 'warn' | 'fail' | 'unknown' | 'omitted';
  detail: string;
  remedy?: string;
  evidence?: unknown;
}

export interface HostCleanupReport {
  hostRoot: string;
  dryRun: boolean;
  files: { path: string; digestBefore: string; digestAfter?: string; removed: number; changed: boolean; error?: string }[];
  removed: number;
  skipped: number;
}

export interface FoundationHostEntry {
  host: string;
  kind: string;
  path: string;
  key?: string;
  owner: 'rho';
  package?: { name?: string; version?: string };
  digest?: string;
  createdAt?: string;
  reversible: boolean;
}

// Host integrations use this small ownership boundary.  The generic JSON adapter is deliberately
// conservative: it can discover and remove entries carrying an explicit Rho owner marker, while a
// connector can provide stricter key and digest checks without changing uninstall orchestration.
export interface FoundationHostAdapter {
  id: string;
  detect(paths: FoundationPaths): Promise<boolean>;
  listOwned(paths: FoundationPaths): Promise<FoundationHostEntry[]>;
  install(paths: FoundationPaths, entry: FoundationHostEntry): Promise<FoundationHostEntry>;
  uninstall(paths: FoundationPaths, entry: FoundationHostEntry): Promise<{ removed: boolean; pending?: boolean }>;
  verify(paths: FoundationPaths, entry: FoundationHostEntry): Promise<{ ok: boolean; detail: string }>;
  repair(paths: FoundationPaths, entry: FoundationHostEntry): Promise<{ repaired: boolean; detail: string }>;
}

const iso = () => new Date().toISOString();
const resolve = (value: string) => path.resolve(value);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const isWindows = (platform: NodeJS.Platform) => platform === 'win32';

export function foundationHome(env: NodeJS.ProcessEnv = process.env) {
  const platform = (env.RHO_PLATFORM as NodeJS.Platform | undefined) ?? process.platform;
  const value = env.RHO_HOME ?? (isWindows(platform) ? env.USERPROFILE : env.HOME) ?? os.homedir();
  return resolve(value);
}

function pathOverride(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  return env[name] ? resolve(env[name]!) : fallback;
}

export function foundationPaths(env: NodeJS.ProcessEnv = process.env): FoundationPaths {
  const home = foundationHome(env), platform = (env.RHO_PLATFORM as NodeJS.Platform | undefined) ?? process.platform;
  let app: string, config: string, data: string, state: string, runtime: string, cache: string, logs: string;
  if (platform === 'darwin') {
    app = path.join(home, 'Library', 'Application Support', 'Rho');
    config = app;
    data = app;
    state = path.join(app, 'state');
    runtime = path.join(app, 'runtime');
    cache = path.join(home, 'Library', 'Caches', 'Rho');
    logs = path.join(home, 'Library', 'Logs', 'Rho');
  } else if (platform === 'win32') {
    const appData = env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA) : path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA ? resolve(env.APPDATA) : path.join(home, 'AppData', 'Roaming');
    app = path.join(appData, 'Rho');
    config = path.join(roaming, 'Rho');
    data = app;
    state = path.join(app, 'state');
    runtime = path.join(app, 'runtime');
    cache = path.join(app, 'cache');
    logs = path.join(app, 'logs');
  } else {
    const configHome = resolve(env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
    const stateHome = resolve(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'));
    const dataHome = resolve(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'));
    const cacheHome = resolve(env.XDG_CACHE_HOME ?? path.join(home, '.cache'));
    const runtimeHome = env.XDG_RUNTIME_DIR ? resolve(env.XDG_RUNTIME_DIR) : path.join(stateHome, 'runtime');
    app = path.join(dataHome, 'rho');
    config = path.join(configHome, 'rho');
    data = app;
    state = path.join(stateHome, 'rho');
    runtime = path.join(runtimeHome, 'rho');
    cache = path.join(cacheHome, 'rho');
    logs = path.join(state, 'logs');
  }
  app = pathOverride(env, 'RHO_APP_DIR', app);
  config = pathOverride(env, 'RHO_CONFIG_DIR', config);
  data = pathOverride(env, 'RHO_DATA_DIR', env.RHO_DATA_ROOT ? resolve(env.RHO_DATA_ROOT) : data);
  state = pathOverride(env, 'RHO_STATE_DIR', state);
  runtime = pathOverride(env, 'RHO_RUNTIME_DIR', runtime);
  cache = pathOverride(env, 'RHO_CACHE_DIR', cache);
  logs = pathOverride(env, 'RHO_LOG_DIR', logs);
  const projects = pathOverride(env, 'RHO_PROJECTS_DIR', path.join(home, '.rho'));
  const manifest = path.join(state, 'install-manifest.json');
  const hosts = pathOverride(env, 'RHO_HOST_ROOT', path.join(data, 'hosts'));
  return {
    product: 'Rho', platform, home, app, config, configFile: path.join(config, 'config.json'), data,
    state, runtime, cache, logs, projects, manifest, hosts,
    legacy: [path.join(home, 'Rho'), path.join(home, 'rho-local-play'), path.join(home, '.rho-app'), path.join(home, '.rho-state')],
  };
}

export function foundationPathsForState(stateDirectory: string, projectsDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  const defaults = foundationPaths(env);
  if (path.resolve(stateDirectory) === path.resolve(defaults.state) && path.resolve(projectsDirectory) === path.resolve(defaults.projects)) return defaults;
  const base = path.join(path.dirname(path.resolve(stateDirectory)), '.rho-app');
  return foundationPaths({ ...env, RHO_APP_DIR: base, RHO_CONFIG_DIR: path.join(base, 'config'), RHO_DATA_DIR: base, RHO_STATE_DIR: path.resolve(stateDirectory), RHO_RUNTIME_DIR: path.join(base, 'runtime'), RHO_CACHE_DIR: path.join(base, 'cache'), RHO_LOG_DIR: path.join(base, 'logs'), RHO_PROJECTS_DIR: path.resolve(projectsDirectory), RHO_HOST_ROOT: path.join(base, 'hosts') });
}

export async function ensureFoundationPaths(paths: FoundationPaths, includeProjects = true) {
  const folders = [paths.app, paths.config, paths.data, paths.state, paths.runtime, paths.cache, paths.logs, paths.hosts];
  if (includeProjects) folders.push(paths.projects);
  for (const folder of folders) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const folder of folders) await fs.chmod(folder, 0o700).catch(() => {});
  return paths;
}

async function writeAtomic(file: string, value: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, value, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function operationDirectory(paths: FoundationPaths) {
  // Keep lifecycle evidence beside the application namespace rather than inside state that
  // `uninstall --purge` is allowed to remove.  This leaves the journal and receipt available for
  // a later doctor or support report after a failed or completed purge.
  return path.join(paths.data, 'operations');
}

export async function writeFoundationJson(file: string, value: unknown) {
  await writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function readFoundationJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch { return fallback; }
}

export async function readSecretInput(name: string, env: NodeJS.ProcessEnv = process.env) {
  const fileName = `${name}_FILE`;
  if (env[fileName]) {
    const file = resolve(env[fileName]!);
    const stat = await fs.stat(file);
    const privateFile = process.platform === 'win32'
      ? (() => {
        const acl = spawnSync('icacls.exe', [file], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
        if (acl.status !== 0) return false;
        const text = `${acl.stdout ?? ''}\n${acl.stderr ?? ''}`;
        return !/(?:Everyone|Authenticated Users|\\Users\b|S-1-1-0|S-1-5-11|S-1-5-32-545)/i.test(text);
      })()
      : (stat.mode & 0o077) === 0;
    if (!privateFile) throw Object.assign(new Error(`${fileName} must point to a private file (mode 0600 or stricter).`), { kind: 'security', path: file });
    return { value: (await fs.readFile(file, 'utf8')).trimEnd(), source: fileName, path: file };
  }
  if (env[name]) return { value: env[name]!, source: name };
  return undefined;
}

export async function pathExists(file: string) {
  return fs.access(file).then(() => true, () => false);
}

export async function registerFoundationProcess(paths: FoundationPaths, record: Omit<FoundationProcessRecord, 'owner' | 'startedAt'> & Partial<Pick<FoundationProcessRecord, 'owner' | 'startedAt'>>) {
  const value: FoundationProcessRecord = { ...record, owner: 'rho', startedAt: record.startedAt ?? iso() };
  const file = path.join(paths.runtime, 'processes', `${record.pid}.json`);
  await writeFoundationJson(file, value);
  return { file, record: value };
}

export async function unregisterFoundationProcess(paths: FoundationPaths, pid: number) {
  const file = path.join(paths.runtime, 'processes', `${pid}.json`);
  await fs.rm(file, { force: true });
  return file;
}

export async function listFoundationProcesses(paths: FoundationPaths) {
  const records: FoundationProcessRecord[] = [];
  for (const entry of await fs.readdir(path.join(paths.runtime, 'processes'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readFoundationJson<FoundationProcessRecord | null>(path.join(paths.runtime, 'processes', entry.name), null);
    if (record?.owner === 'rho' && Number.isInteger(record.pid)) records.push(record);
  }
  return records;
}

export async function ensureManifest(paths: FoundationPaths, packageInfo?: { name: string; version: string; root: string }) {
  await ensureFoundationPaths(paths, false);
  const current = await readFoundationJson<FoundationManifest | null>(paths.manifest, null);
  const manifest: FoundationManifest = current?.product === 'Rho' && current.schemaVersion === foundationSchemaVersion ? current : {
    schemaVersion: foundationSchemaVersion,
    product: 'Rho',
    installationId: randomUUID(),
    paths: {}, bins: [], profiles: {}, hosts: [], operations: [], createdAt: iso(), updatedAt: iso(),
  };
  manifest.paths = { ...manifest.paths, config: paths.config, data: paths.data, state: paths.state, runtime: paths.runtime, cache: paths.cache, logs: paths.logs, projects: paths.projects, manifest: paths.manifest, hosts: paths.hosts };
  if (packageInfo) {
    const declared = await readFoundationJson<{ bin?: Record<string, string> | string }>(path.join(packageInfo.root, 'package.json'), {});
    const bins = typeof declared.bin === 'string' ? { rho: declared.bin } : declared.bin ?? {};
    const prefix = process.env.npm_config_prefix ?? (packageInfo.root.includes(`${path.sep}lib${path.sep}node_modules`) ? packageInfo.root.split(`${path.sep}lib${path.sep}node_modules`)[0] : undefined);
    const binRoot = prefix ? paths.platform === 'win32' ? prefix : path.join(prefix, 'bin') : undefined;
    const packageFile = path.join(packageInfo.root, 'package.json');
    const packageDigest = await fs.readFile(packageFile).then(bytes => digest(bytes)).catch(() => undefined);
    manifest.package = { ...packageInfo, prefix, digest: packageDigest, owner: 'rho', source: packageInfo.root, active: true };
    if (binRoot) manifest.bins = Object.entries(bins).map(([name, target]) => ({ name, path: path.join(binRoot, paths.platform === 'win32' ? name + '.cmd' : name), target: path.resolve(packageInfo.root, target), owner: 'rho', digest: undefined, deletion: 'remove-if-matches' }));
  }
  manifest.updatedAt = iso();
  await writeFoundationJson(paths.manifest, manifest);
  const stateEnvelopeFile = path.join(paths.state, 'state-meta.json');
  const stateEnvelope = await readFoundationJson<FoundationStateEnvelope | null>(stateEnvelopeFile, null);
  if (!stateEnvelope || stateEnvelope.installationId !== manifest.installationId || stateEnvelope.schemaVersion !== foundationSchemaVersion)
    await writeFoundationJson(stateEnvelopeFile, { schemaVersion: foundationSchemaVersion, installationId: manifest.installationId, createdAt: stateEnvelope?.createdAt ?? iso(), owner: 'rho', source: packageInfo?.root ?? stateEnvelope?.source ?? 'rho' } satisfies FoundationStateEnvelope);
  await syncCacheConfig(paths);
  return manifest;
}

export async function syncCacheConfig(paths: FoundationPaths) {
  const configDigest = await fs.readFile(paths.configFile).then(bytes => digest(bytes)).catch(() => undefined);
  const file = path.join(paths.cache, 'config-schema.json');
  const previous = await readFoundationJson<{ configDigest?: string } | null>(file, null);
  const changed = !!previous?.configDigest && previous.configDigest !== configDigest;
  await writeFoundationJson(file, { schemaVersion: 1, owner: 'rho', configDigest, previousDigest: previous?.configDigest, changedAt: changed ? iso() : undefined, updatedAt: iso() });
  return { file, configDigest, previousDigest: previous?.configDigest, changed };
}

export async function updateManifest(paths: FoundationPaths, update: (manifest: FoundationManifest) => FoundationManifest | void) {
  const manifest = await ensureManifest(paths);
  const result = update(manifest) ?? manifest;
  result.updatedAt = iso();
  await writeFoundationJson(paths.manifest, result);
  return result;
}

export async function beginFoundationOperation(paths: FoundationPaths, kind: string, input?: unknown) {
  await ensureFoundationPaths(paths, false);
  const operationId = `${kind}-${randomUUID()}`;
  const operation: FoundationOperation = { operationId, kind, state: 'planned', createdAt: iso(), updatedAt: iso(), input, stages: [] };
  await writeFoundationJson(path.join(operationDirectory(paths), operationId + '.json'), operation);
  await updateManifest(paths, manifest => { manifest.operations = [...new Set([...manifest.operations, operationId])]; });
  return operation;
}

export async function updateFoundationOperation(paths: FoundationPaths, operation: FoundationOperation, update: Partial<FoundationOperation>) {
  const next = { ...operation, ...update, updatedAt: iso() };
  await writeFoundationJson(path.join(operationDirectory(paths), operation.operationId + '.json'), next);
  return next;
}

export async function readFoundationOperation(paths: FoundationPaths, operationId: string) {
  return readFoundationJson<FoundationOperation | null>(path.join(operationDirectory(paths), operationId + '.json'), null);
}

export async function addFoundationStage(paths: FoundationPaths, operation: FoundationOperation, name: string, state: FoundationOperation['stages'][number]['state'], detail?: unknown) {
  const next: FoundationOperation = { ...operation, stages: [...operation.stages, { name, state, at: iso(), ...(detail === undefined ? {} : { detail }) }] };
  return updateFoundationOperation(paths, next, { state: state === 'failed' ? 'failed' : state === 'completed' && next.stages.every(stage => stage.state === 'completed') ? 'completed' : 'running' });
}

async function walk(root: string, options: { maxEntries: number; maxDepth: number; maxBytes?: number; maxMs?: number; startedAt?: number }, relative = '', out: { path: string; kind: string; bytes: number; mtimeMs: number }[] = []) {
  if (out.length >= options.maxEntries || relative.split(path.sep).filter(Boolean).length > options.maxDepth || (options.maxMs && Date.now() - (options.startedAt ?? Date.now()) > options.maxMs)) return out;
  for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= options.maxEntries || (options.maxMs && Date.now() - (options.startedAt ?? Date.now()) > options.maxMs)) break;
    const file = path.join(root, entry.name), rel = path.join(relative, entry.name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat) continue;
    const bytes = entry.isFile() ? stat.size : 0;
    out.push({ path: rel.split(path.sep).join('/'), kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file', bytes, mtimeMs: stat.mtimeMs });
    if (entry.isDirectory()) await walk(file, options, rel, out);
  }
  return out;
}

async function treeDigest(root: string): Promise<string> {
  const items: string[] = [];
  async function visit(folder: string, relative = '') {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name), rel = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) { items.push(`${rel}/`); await visit(file, rel); }
      else if (entry.isFile()) items.push(`${rel}:${digest(await fs.readFile(file))}`);
      else if (entry.isSymbolicLink()) items.push(`${rel}->${await fs.readlink(file).catch(() => '')}`);
    }
  }
  await visit(root);
  return digest(items.join('\n'));
}

export interface QuickStartProjectMigration {
  schemaVersion: 1;
  kind: 'quick-start-project-migration';
  source: string;
  target: string;
  moved: string[];
  conflicts: string[];
  sourceDigest: string;
  mode: 'silent-move';
  completedAt: string;
}

// A no-flag quick start adopts the old project collection without asking a second question.
// Each entry is moved atomically when possible; a cross-device copy is verified before its old
// entry is removed. Existing target names are left in place and recorded as conflicts.
export async function migrateQuickStartProjects(paths = foundationPaths()): Promise<QuickStartProjectMigration | null> {
  const source = path.join(paths.home, 'Rho', 'projects'), target = paths.projects;
  if (path.resolve(source) === path.resolve(target) || !await pathExists(source)) return null;
  await ensureFoundationPaths(paths);
  const moved: string[] = [], conflicts: string[] = [];
  for (const entry of (await fs.readdir(source, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (await pathExists(to)) { conflicts.push(entry.name); continue; }
    try {
      await fs.rename(from, to);
      moved.push(entry.name);
      continue;
    } catch {
      if (await pathExists(to)) { conflicts.push(entry.name); continue; }
    }
    const before = await treeDigest(from);
    try {
      await fs.cp(from, to, { recursive: true, dereference: false });
      if (before !== await treeDigest(to)) throw new Error(`quick-start migration verification failed for ${entry.name}`);
      await fs.rm(from, { recursive: true, force: true });
      moved.push(entry.name);
    } catch {
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      conflicts.push(entry.name);
    }
  }
  const receipt: QuickStartProjectMigration = {
    schemaVersion: 1, kind: 'quick-start-project-migration', source, target, moved, conflicts,
    sourceDigest: await treeDigest(source), mode: 'silent-move', completedAt: iso(),
  };
  await writeFoundationJson(path.join(paths.state, 'quick-start-project-migration.json'), receipt);
  return receipt;
}

export async function summarizePath(root: string, options = defaultFoundationBudgets) {
  const stat = await fs.lstat(root).catch(() => null);
  if (stat?.isFile()) return { path: root, exists: true, entries: 1, bytes: stat.size, truncated: false };
  const entries = await walk(root, { maxEntries: options.doctorMaxEntries, maxDepth: options.doctorMaxDepth, maxMs: options.doctorMaxMs, startedAt: Date.now() });
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return { path: root, exists: await pathExists(root), entries: entries.length, bytes, truncated: entries.length >= options.doctorMaxEntries };
}

export async function reportFoundationPaths(paths = foundationPaths()) {
  const entries = {} as Record<FoundationPathKey, { path: string; exists: boolean; entries: number; bytes: number; truncated: boolean; owner: string; deletable: boolean }>;
  for (const key of ['config', 'data', 'state', 'runtime', 'cache', 'logs', 'projects', 'manifest', 'hosts'] as FoundationPathKey[]) {
    const file = key === 'manifest' ? paths.manifest : key === 'config' ? paths.config : paths[key];
    entries[key] = { ...await summarizePath(file), owner: key === 'projects' ? 'selected-project' : 'rho', deletable: key !== 'projects' };
  }
  const legacy = [];
  for (const candidate of paths.legacy) if (await pathExists(candidate)) legacy.push(await summarizePath(candidate));
  return { product: paths.product, platform: paths.platform, home: paths.home, paths: entries, legacy, generatedAt: iso() };
}

function packageRootFromModule() {
  const moduleFile = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  return moduleFile;
}

export async function packageIdentity() {
  const root = packageRootFromModule();
  const packageFile = path.join(root, 'package.json');
  const packageInfo = await readFoundationJson<{ name?: string; version?: string } | null>(packageFile, null);
  return packageInfo?.name && packageInfo.version ? { name: packageInfo.name, version: packageInfo.version, root } : undefined;
}

function check(id: string, state: FoundationCheck['state'], detail: string, remedy?: string, evidence?: unknown): FoundationCheck {
  return { id, state, detail, ...(remedy ? { remedy } : {}), ...(evidence === undefined ? {} : { evidence }) };
}

export async function doctorFoundation(paths = foundationPaths(), options: { scan?: boolean; repair?: boolean } = {}) {
  const checks: FoundationCheck[] = [];
  const report = await reportFoundationPaths(paths);
  const manifest = await readFoundationJson<FoundationManifest | null>(paths.manifest, null);
  const identity = await packageIdentity();
  checks.push(identity ? check('package', 'ok', `${identity.name}@${identity.version} is loaded from ${identity.root}.`, undefined, identity) : check('package', 'warn', 'The package identity could not be read from this checkout.', 'Run doctor from an installed package or source checkout with package.json.'));
  checks.push(manifest ? check('manifest', 'ok', `Installation manifest ${paths.manifest} is readable.`, undefined, { installationId: manifest.installationId, updatedAt: manifest.updatedAt }) : check('manifest', 'warn', `No installation manifest exists at ${paths.manifest}.`, 'Run rho install or rho doctor --repair.'));
  if (manifest?.bins?.length) {
    const missing = [] as string[], mismatched = [] as string[];
    for (const bin of manifest.bins) {
      const link = await fs.readlink(bin.path).catch(() => null);
      const actual = await fs.realpath(bin.path).catch(() => link ? path.resolve(path.dirname(bin.path), link) : null);
      if (!actual) missing.push(bin.path);
      else if (bin.target && path.resolve(actual) !== path.resolve(bin.target)) mismatched.push(bin.path);
    }
    const state = mismatched.length ? 'fail' : missing.length ? 'warn' : 'ok';
    checks.push(check('bins', state, `${manifest.bins.length} manifest shim(s): ${manifest.bins.length - missing.length - mismatched.length} aligned, ${missing.length} missing, ${mismatched.length} mismatched.`, state !== 'ok' ? 'Run rho doctor --repair to reconcile only manifest-owned shims.' : undefined, { missing, mismatched }));
  }
  for (const [key, value] of Object.entries(report.paths)) {
    const mode = value.exists ? await fs.stat(value.path).then(stat => stat.mode & 0o077).catch(() => 0) : 0;
    const state = value.exists ? mode ? 'fail' : 'ok' : key === 'projects' ? 'warn' : 'fail';
    checks.push(state === 'ok' ? check(`path:${key}`, 'ok', `${key} is present at ${value.path} with ${value.entries} entries and ${value.bytes} bytes.`, undefined, { ...value, mode: value.exists ? mode : undefined }) : check(`path:${key}`, state, value.exists ? `${key} is group/world accessible at ${value.path}.` : `${key} is missing at ${value.path}.`, value.exists ? 'Restrict Rho application directories to the current user.' : `Run rho install or create the path through rho start.`, { ...value, mode: value.exists ? mode : undefined }));
  }
  if (report.legacy.length) checks.push(check('legacy', 'warn', `${report.legacy.length} legacy root(s) remain discoverable.`, 'Run rho migrate --dry-run, then rho migrate --apply after reviewing the report.', report.legacy));
  else checks.push(check('legacy', 'ok', 'No known legacy Rho root is present under the selected HOME.'));
  const notesDir = path.join(paths.runtime, 'running');
  const notes = await summarizePath(notesDir);
  checks.push(notes.exists ? check('runtime', 'ok', `Runtime registry is present at ${notesDir}.`, undefined, notes) : check('runtime', 'warn', `Runtime registry has not been created at ${notesDir}.`, 'Start a profile to create it.', notes));
  const processes = await listFoundationProcesses(paths), staleProcesses = processes.filter(record => !processAlive(record.pid));
  checks.push(staleProcesses.length ? check('processes', 'warn', `${staleProcesses.length} stale Rho process record(s) remain.`, 'Run rho doctor --repair to quarantine stale process records.', { processes, staleProcesses }) : check('processes', 'ok', `${processes.length} registered Rho process(es) are live.`, undefined, processes));
  const host = await hostScan(paths, options.scan ? 10000 : 2000);
  checks.push(host.files.length ? check('hosts', 'warn', `${host.files.length} host JSON file(s) contain Rho-owned entries.`, 'Run rho host cleanup --dry-run, then rho host cleanup after reviewing the report.', host) : check('hosts', 'ok', 'No Rho-owned host entries were found.', undefined, host));
  const pendingHost = await readFoundationJson<{ state?: string; files?: unknown[] } | null>(path.join(paths.data, 'pending-host-cleanup.json'), null);
  if (pendingHost?.state === 'pending') checks.push(check('host-pending', 'warn', 'A host cleanup operation is pending because one or more host files were unavailable or changed.', 'Run rho host cleanup, then rho doctor --repair.', pendingHost));
  const secretFiles = [] as { name: string; path: string; state: 'ok' | 'warn' | 'fail'; detail: string }[];
  for (const name of ['RHO_API_KEY_FILE', 'RHO_CONNECTION_FILE']) {
    const file = process.env[name];
    if (!file) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) secretFiles.push({ name, path: file, state: 'fail', detail: 'secret file is missing' });
    else if ((stat.mode & 0o077) !== 0) secretFiles.push({ name, path: file, state: 'fail', detail: 'secret file is group/world accessible' });
    else secretFiles.push({ name, path: file, state: 'ok', detail: 'secret file exists with private mode' });
  }
  if (secretFiles.length) checks.push(check('secrets', secretFiles.some(item => item.state === 'fail') ? 'fail' : 'ok', `${secretFiles.length} secret-file input(s) were checked.`, secretFiles.some(item => item.state === 'fail') ? 'Use a 0600 secret file and do not put its value on the command line.' : undefined, secretFiles));
  const temp = await temporaryReport(paths);
  const tempState = temp.entries > defaultFoundationBudgets.tempMaxEntries || temp.bytes > defaultFoundationBudgets.tempMaxBytes ? 'fail' : temp.entries > 0 ? 'warn' : 'ok';
  checks.push(check('temporary', tempState, `${temp.entries} temporary entries use ${temp.bytes} bytes.`, tempState === 'fail' ? 'Run rho cache prune before creating more temporary work.' : undefined, temp));
  const cache = await cacheReport(paths);
  const cacheState = cache.bytes > defaultFoundationBudgets.cacheMaxBytes ? 'fail' : cache.bytes > 0 ? 'warn' : 'ok';
  checks.push(check('cache', cacheState, `${cache.entries} rebuildable cache files use ${cache.bytes} bytes.`, cacheState === 'fail' ? 'Run rho cache prune before creating more cached work.' : undefined, cache));
  const pluginRoot = process.env.RHO_PLUGINS_ROOT;
  const plugins = pluginRoot ? await readFoundationJson<{ name?: string; version?: string } | null>(path.join(pluginRoot, 'package.json'), null) : null;
  checks.push(check('components', identity || plugins || process.env.RHO_CORE_BINARY ? 'ok' : 'unknown', `Rho${identity ? ` ${identity.version}` : ''}${plugins ? `, Plugins ${plugins.version ?? 'unknown'}` : ''}${process.env.RHO_CORE_BINARY ? `, Core ${path.resolve(process.env.RHO_CORE_BINARY)}` : ''}.`, identity || plugins || process.env.RHO_CORE_BINARY ? undefined : 'Set RHO_CORE_BINARY/RHO_PLUGINS_ROOT or run from the selected component composition.', { rho: identity, plugins, core: process.env.RHO_CORE_BINARY ?? null }));
  const result = { ok: checks.every(item => !['fail', 'unknown'].includes(item.state)), checks, paths: report, manifest, generatedAt: iso() };
  if (options.repair) await repairFoundation(paths, result);
  return result;
}

export async function repairFoundation(paths: FoundationPaths, diagnosis?: Awaited<ReturnType<typeof doctorFoundation>>) {
  const report = diagnosis ?? await doctorFoundation(paths);
  await ensureFoundationPaths(paths, false);
  const repaired: string[] = [];
  const existingManifest = await readFoundationJson<FoundationManifest | null>(paths.manifest, null);
  const packageInfo = existingManifest?.package ?? (existingManifest ? undefined : await packageIdentity());
  const manifest = await ensureManifest(paths, packageInfo);
  if (!manifest.bins.length) repaired.push('manifest');
  for (const bin of manifest.bins) {
    const expected = bin.target ? path.resolve(bin.target) : '';
    const link = await fs.readlink(bin.path).catch(() => null);
    const actual = await fs.realpath(bin.path).catch(() => link ? path.resolve(path.dirname(bin.path), link) : null);
    if (actual && expected && path.resolve(actual) !== expected) continue;
    if (actual) continue;
    if (expected && await pathExists(expected)) {
      await fs.mkdir(path.dirname(bin.path), { recursive: true, mode: 0o700 });
      if (paths.platform === 'win32') await fs.writeFile(bin.path, `@ECHO OFF\r\n"${process.execPath}" "${expected}" %*\r\n`, { mode: 0o700 });
      else await fs.symlink(path.relative(path.dirname(bin.path), expected), bin.path);
      repaired.push('bin:' + bin.name);
    }
  }
  const stale = path.join(paths.runtime, 'running');
  await fs.mkdir(stale, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(stale).catch(() => [])) {
    const file = path.join(stale, name), item = await readFoundationJson<{ pid?: number } | null>(file, null);
    if (item?.pid && !processAlive(item.pid)) { await fs.rename(file, path.join(paths.state, 'quarantine-' + name)).catch(() => {}); repaired.push('stale:' + name); }
  }
  for (const processRecord of await listFoundationProcesses(paths)) {
    if (processAlive(processRecord.pid)) continue;
    const file = path.join(paths.runtime, 'processes', `${processRecord.pid}.json`);
    await fs.rename(file, path.join(paths.state, 'quarantine-process-' + processRecord.pid + '.json')).catch(() => {});
    repaired.push('process:' + processRecord.pid);
  }
  if (report.checks.some(item => item.id === 'temporary' && item.state === 'fail')) { await pruneTemporary(paths); repaired.push('temporary'); }
  return { repaired, report: await doctorFoundation(paths) };
}

const processAlive = (pid: number) => { try { process.kill(pid, 0); if (process.platform === 'linux') { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); if (/\)\s+Z(?:\s|$)/.test(stat)) return false; } return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

export async function temporaryDirectory(paths: FoundationPaths, operation: string, owner: string, ttlMs = defaultFoundationBudgets.tempTtlMs) {
  const current = await temporaryReport(paths);
  if (current.entries >= defaultFoundationBudgets.tempMaxEntries || current.bytes >= defaultFoundationBudgets.tempMaxBytes) {
    await pruneTemporary(paths);
    const afterPrune = await temporaryReport(paths);
    if (afterPrune.entries >= defaultFoundationBudgets.tempMaxEntries || afterPrune.bytes >= defaultFoundationBudgets.tempMaxBytes)
      throw Object.assign(new Error(`Rho temporary-resource budget is full (${afterPrune.entries} entries, ${afterPrune.bytes} bytes). Existing output was retained; run rho cache prune or remove a pinned item.`), { kind: 'limit', limit: 'temporary' });
  }
  const id = `${operation}-${randomUUID()}`;
  const directory = path.join(paths.cache, 'temporary', id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const configDigest = await fs.readFile(paths.configFile).then(bytes => digest(bytes)).catch(() => undefined);
  await writeFoundationJson(path.join(directory, 'meta.json'), { schemaVersion: 1, id, operation, owner, profile: process.env.RHO_PROFILE ?? 'default', configDigest, cleanupPolicy: 'ttl', createdAt: iso(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), state: 'active', pinned: false });
  return directory;
}

export async function createTemporaryHome(paths: FoundationPaths, operation: string, owner: string, sourceHome: string, allowlist: string[] = [], ttlMs = defaultFoundationBudgets.tempTtlMs) {
  const directory = await temporaryDirectory(paths, operation, owner, ttlMs), home = path.join(directory, 'home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const copied: string[] = [], skipped: string[] = [];
  for (const relative of allowlist) {
    if (/(^|\/)(?:connection|principals|credentials|auth|\.env)(?:\.json|\..*)?$/i.test(relative)) { skipped.push(relative); continue; }
    const source = path.join(sourceHome, relative), target = path.join(home, relative);
    if (!await pathExists(source)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.cp(source, target, { recursive: true, dereference: false }); copied.push(relative);
  }
  await writeFoundationJson(path.join(directory, 'meta.json'), { schemaVersion: 1, operation, owner, createdAt: iso(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), cleanupPolicy: 'ttl', allowlist, copied, skipped, state: 'active', pinned: false });
  return { directory, home, copied, skipped };
}

export async function temporaryReport(paths: FoundationPaths) {
  const root = path.join(paths.cache, 'temporary');
  const entries = await walk(root, { maxEntries: defaultFoundationBudgets.doctorMaxEntries, maxDepth: 3, maxMs: defaultFoundationBudgets.doctorMaxMs, startedAt: Date.now() });
  const systemTemp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? os.tmpdir();
  const external = [] as typeof entries;
  for (const name of (await fs.readdir(systemTemp, { withFileTypes: true }).catch(() => [])).filter(entry => entry.name.startsWith('rho-'))) {
    const stat = await fs.lstat(path.join(systemTemp, name.name)).catch(() => null);
    if (stat) external.push({ path: path.join(systemTemp, name.name), kind: name.isDirectory() ? 'directory' : 'file', bytes: name.isFile() ? stat.size : 0, mtimeMs: stat.mtimeMs });
  }
  return { path: root, entries: entries.filter(entry => entry.kind === 'directory').length + external.filter(entry => entry.kind === 'directory').length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) + external.reduce((sum, entry) => sum + entry.bytes, 0), files: entries, external };
}

export async function cacheReport(paths: FoundationPaths) {
  const entries = await walk(paths.cache, { maxEntries: defaultFoundationBudgets.doctorMaxEntries, maxDepth: defaultFoundationBudgets.doctorMaxDepth, maxMs: defaultFoundationBudgets.doctorMaxMs, startedAt: Date.now() });
  const files = entries.filter(entry => entry.kind === 'file' && !entry.path.startsWith('temporary/'));
  return { path: paths.cache, entries: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), files, truncated: entries.length >= defaultFoundationBudgets.doctorMaxEntries };
}

export async function logsReport(paths: FoundationPaths) {
  const files: { path: string; bytes: number; modifiedAt: string; owner: 'rho'; retentionDays: number }[] = [];
  for (const entry of await fs.readdir(paths.logs, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/^rho(?:\.[0-9]+|\.previous)?\.log$/.test(entry.name)) continue;
    const file = path.join(paths.logs, entry.name), stat = await fs.stat(file).catch(() => null);
    if (stat) files.push({ path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), owner: 'rho', retentionDays: 30 });
  }
  return { directory: paths.logs, files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), bytes: files.reduce((sum, file) => sum + file.bytes, 0), limit: 100 * 1024 * 1024, retentionDays: 30 };
}

export async function pruneLogs(paths: FoundationPaths, nowMs = Date.now()) {
  const before = await logsReport(paths), removed: string[] = [];
  let total = before.bytes;
  for (const file of [...before.files].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))) {
    if (file.path.endsWith('rho.log')) continue;
    if (total <= before.limit && nowMs - Date.parse(file.modifiedAt) <= 30 * 24 * 60 * 60 * 1000) continue;
    await fs.rm(file.path, { force: true }); total -= file.bytes; removed.push(file.path);
  }
  return { removed, before, after: await logsReport(paths) };
}

export async function pruneCache(paths: FoundationPaths, maxBytes = defaultFoundationBudgets.cacheMaxBytes) {
  const report = await cacheReport(paths);
  const schema = await syncCacheConfig(paths);
  let remaining = report.bytes;
  const removed: string[] = [];
  for (const entry of [...report.files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (remaining <= maxBytes) break;
    const metadata = await readFoundationJson<{ pinned?: boolean; configDigest?: string } | null>(path.join(path.dirname(path.join(paths.cache, entry.path)), 'meta.json'), null);
    if (metadata?.pinned && (!metadata.configDigest || metadata.configDigest === schema.configDigest)) continue;
    const file = path.join(paths.cache, entry.path);
    await fs.rm(file, { force: true }); remaining -= entry.bytes; removed.push(file);
  }
  return { removed, before: report, after: await cacheReport(paths), limit: maxBytes };
}

export async function pruneTemporary(paths: FoundationPaths, nowMs = Date.now()) {
  const root = path.join(paths.cache, 'temporary');
  const removed: string[] = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    const directory = path.join(root, name), meta = await readFoundationJson<{ expiresAt?: string; state?: string } | null>(path.join(directory, 'meta.json'), null);
    if (meta?.expiresAt && Date.parse(meta.expiresAt) <= nowMs) { await fs.rm(directory, { recursive: true, force: true }); removed.push(name); }
  }
  const systemTemp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? os.tmpdir();
  for (const entry of (await fs.readdir(systemTemp, { withFileTypes: true }).catch(() => [])).filter(candidate => candidate.name.startsWith('rho-'))) {
    const file = path.join(systemTemp, entry.name), stat = await fs.lstat(file).catch(() => null);
    // A system temporary directory is eligible only when Rho wrote its registry metadata.  This
    // prevents a broad `rho-*` prefix from deleting another tool's abandoned directory.
    const metadata = await readFoundationJson<{ expiresAt?: string; owner?: string } | null>(path.join(file, 'meta.json'), null);
    if (stat && metadata?.owner && metadata.expiresAt && Date.parse(metadata.expiresAt) <= nowMs) { await fs.rm(file, { recursive: true, force: true }); removed.push(file); }
  }
  return { removed, report: await temporaryReport(paths), cache: await cacheReport(paths) };
}

async function jsonFiles(root: string, maximum: number, out: string[] = []) {
  if (out.length >= maximum) return out;
  for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= maximum) break;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await jsonFiles(file, maximum, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(file);
  }
  return out;
}

function removeOwned(value: unknown): { value: unknown; removed: number } {
  if (Array.isArray(value)) {
    const next: unknown[] = []; let removed = 0;
    for (const item of value) { const result = removeOwned(item); if (result.value === undefined) removed += 1; else { next.push(result.value); removed += result.removed; } }
    return { value: next, removed };
  }
  if (!value || typeof value !== 'object') return { value, removed: 0 };
  const record = value as Record<string, unknown>;
  if (record.owner === 'rho' || record.owner === 'Rho' || record.source === 'rho') return { value: undefined, removed: 1 };
  const next: Record<string, unknown> = {}; let removed = 0;
  for (const [key, item] of Object.entries(record)) { const result = removeOwned(item); if (result.value !== undefined) next[key] = result.value; removed += result.removed; }
  return { value: next, removed };
}

export async function hostScan(paths = foundationPaths(), maximum = 2000) {
  const files = [] as { path: string; digest: string; entries: number }[];
  for (const file of await jsonFiles(paths.hosts, maximum)) {
    const bytes = await fs.readFile(file).catch(() => null); if (!bytes) continue;
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      const result = removeOwned(parsed);
      if (result.removed) files.push({ path: file, digest: digest(bytes), entries: result.removed });
    } catch { /* diagnosis records only JSON host state */ }
  }
  return { hostRoot: paths.hosts, files, count: files.reduce((sum, file) => sum + file.entries, 0) };
}

export function jsonHostAdapter(id = 'json-owned-records'): FoundationHostAdapter {
  return {
    id,
    async detect(paths) { return pathExists(paths.hosts); },
    async listOwned(paths) {
      const scan = await hostScan(paths);
      return scan.files.map(file => ({ host: id, kind: 'json', path: file.path, owner: 'rho' as const, digest: file.digest, reversible: true, createdAt: iso() }));
    },
    async install(_paths, entry) { return { ...entry, owner: 'rho', reversible: true }; },
    async uninstall(paths, entry) {
      const report = await hostCleanup(paths);
      const file = report.files.find(item => item.path === entry.path);
      return { removed: !!file && file.changed, ...(file?.error ? { pending: true } : {}) };
    },
    async verify(paths, entry) {
      const found = (await hostScan(paths)).files.find(file => file.path === entry.path);
      return found ? { ok: true, detail: `${found.entries} owned record(s) remain in ${entry.path}.` } : { ok: true, detail: `No owned records remain in ${entry.path}.` };
    },
    async repair(paths, entry) {
      const result = await hostCleanup(paths);
      return { repaired: result.files.some(file => file.path === entry.path && file.changed), detail: `Host cleanup removed ${result.removed} owned record(s).` };
    },
  };
}

export async function hostCleanup(paths = foundationPaths(), options: { dryRun?: boolean; maximum?: number } = {}): Promise<HostCleanupReport> {
  const dryRun = options.dryRun ?? false;
  const report: HostCleanupReport = { hostRoot: paths.hosts, dryRun, files: [], removed: 0, skipped: 0 };
  for (const file of await jsonFiles(paths.hosts, options.maximum ?? 2000)) {
    const bytes = await fs.readFile(file).catch(() => null); if (!bytes) continue;
    try {
      const parsed = JSON.parse(bytes.toString('utf8')), result = removeOwned(parsed);
      if (!result.removed) continue;
      const item = { path: file, digestBefore: digest(bytes), removed: result.removed, changed: !dryRun } as HostCleanupReport['files'][number];
      if (!dryRun) { await writeFoundationJson(file, result.value); item.digestAfter = digest(await fs.readFile(file)); }
      report.files.push(item); report.removed += result.removed;
    } catch (error) { report.files.push({ path: file, digestBefore: digest(bytes), removed: 0, changed: false, error: error instanceof Error ? error.message : String(error) }); report.skipped += 1; }
  }
  if (!dryRun && report.files.length) await updateManifest(paths, manifest => {
    manifest.hosts = [...manifest.hosts.filter(entry => !report.files.some(file => file.path === entry.file)), ...report.files.filter(file => file.changed).map(file => ({ host: path.basename(paths.hosts), file: file.path, digest: file.digestAfter ?? file.digestBefore, entries: file.removed, owner: 'rho' as const, updatedAt: iso() }))];
  });
  if (!dryRun && report.skipped) await writeFoundationJson(path.join(paths.data, 'pending-host-cleanup.json'), { schemaVersion: 1, owner: 'rho', hostRoot: paths.hosts, files: report.files.filter(file => file.error), createdAt: iso(), state: 'pending' });
  else if (!dryRun && !report.skipped) await fs.rm(path.join(paths.data, 'pending-host-cleanup.json'), { force: true }).catch(() => {});
  return report;
}

export async function migrateLegacy(paths = foundationPaths(), options: { dryRun?: boolean; purge?: boolean } = {}) {
  const report = await reportFoundationPaths(paths);
  const sources = report.legacy;
  if (options.dryRun) return { operationId: `migrate-dry-${randomUUID()}`, dryRun: true, sources, conflicts: [], copied: [], removed: [] };
  const operation = await beginFoundationOperation(paths, 'migrate', { dryRun: false, purge: options.purge ?? false });
  let current = await addFoundationStage(paths, operation, 'discover', 'completed', { sources });
  await ensureFoundationPaths(paths, false);
  const copied: string[] = [], copiedEntries: { path: string; digest?: string; kind: 'file' | 'directory' }[] = [], conflicts: string[] = [], removed: string[] = [];
  current = await addFoundationStage(paths, current, 'copy', 'running');
  for (const source of sources) {
    const name = path.basename(source.path);
    const target = path.join(paths.state, 'legacy-import', name);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of (await fs.readdir(source.path, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const from = path.join(source.path, entry.name), to = path.join(target, entry.name);
      if (await pathExists(to)) { conflicts.push(to); continue; }
      await fs.cp(from, to, { recursive: true, dereference: false }); copied.push(to);
      const copiedStat = await fs.lstat(to).catch(() => null);
      if (copiedStat?.isFile()) copiedEntries.push({ path: to, kind: 'file', digest: digest(await fs.readFile(to)) });
      else if (copiedStat?.isDirectory()) copiedEntries.push({ path: to, kind: 'directory', digest: await treeDigest(to) });
    }
    if (name === 'Rho' || name === '.rho-state') {
      const oldState = name === 'Rho' ? path.join(source.path, 'state') : source.path;
      for (const file of (await fs.readdir(oldState, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile() && /^(projects|principals|removed-projects|connection|agent-|models-dev|agent-settings)/.test(entry.name))) {
        const from = path.join(oldState, file.name), to = path.join(paths.state, file.name);
        if (await pathExists(to)) { conflicts.push(to); continue; }
        await fs.mkdir(paths.state, { recursive: true, mode: 0o700 }); await fs.copyFile(from, to); copied.push(to); copiedEntries.push({ path: to, kind: 'file', digest: digest(await fs.readFile(to)) });
      }
      if (name === 'Rho') {
        const projectsRoot = path.join(source.path, 'projects');
        for (const projectEntry of await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
          if (!projectEntry.isDirectory()) continue;
          const projectRoot = path.join(projectsRoot, projectEntry.name), oldLock = path.join(projectRoot, '.rho', 'rho', 'service.lock'), newLock = path.join(projectRoot, '.rho', 'service.lock');
          if (await pathExists(oldLock) && !await pathExists(newLock)) {
            await fs.mkdir(path.dirname(newLock), { recursive: true, mode: 0o700 });
            await fs.copyFile(oldLock, newLock); copied.push(newLock); copiedEntries.push({ path: newLock, kind: 'file', digest: digest(await fs.readFile(newLock)) });
            await writeFoundationJson(path.join(projectRoot, '.rho', 'foundation-migration.json'), { schemaVersion: 1, from: '.rho/rho', lock: { from: oldLock, to: newLock }, migratedAt: iso() });
          }
        }
      }
    }
  }
  current = await addFoundationStage(paths, current, 'copy', 'completed', { copied, copiedEntries, conflicts });
  current = await addFoundationStage(paths, current, 'verify', 'running', { entries: copiedEntries.length });
  const mismatches: string[] = [];
  for (const entry of copiedEntries) {
    const stat = await fs.lstat(entry.path).catch(() => null);
    const actual = stat?.isFile() ? digest(await fs.readFile(entry.path)) : stat?.isDirectory() ? await treeDigest(entry.path) : undefined;
    if (entry.digest && actual !== entry.digest) mismatches.push(entry.path);
  }
  if (mismatches.length) {
    current = await addFoundationStage(paths, current, 'verify', 'failed', { mismatches });
    await updateFoundationOperation(paths, current, { state: 'failed', error: `Migration verification failed for ${mismatches.join(', ')}` });
    return { operationId: current.operationId, dryRun: false, sources, conflicts, copied, copiedEntries, removed, mismatches };
  }
  current = await addFoundationStage(paths, current, 'verify', 'completed', { entries: copiedEntries.length });
  current = await addFoundationStage(paths, current, 'switch', 'running');
  const sourceRecords: { path: string; digest: string }[] = [];
  for (const source of sources) sourceRecords.push({ path: source.path, digest: await treeDigest(source.path) });
  await writeFoundationJson(path.join(paths.state, 'migration-source.json'), { schemaVersion: 1, owner: 'rho', operationId: current.operationId, sources: sourceRecords, switchedAt: iso() });
  current = await addFoundationStage(paths, current, 'switch', 'completed', { state: paths.state });
  if (options.purge) {
    current = await addFoundationStage(paths, current, 'clean', 'running');
    for (const source of sources) {
      const name = path.basename(source.path);
      if (name === 'Rho') {
        for (const child of ['state', 'running']) { const target = path.join(source.path, child); if (await pathExists(target)) { await fs.rm(target, { recursive: true, force: true }); removed.push(target); } }
        for (const child of await fs.readdir(source.path).catch(() => [])) if (/^tutorial-state-|\.log$/.test(child)) { await fs.rm(path.join(source.path, child), { recursive: true, force: true }); removed.push(path.join(source.path, child)); }
      } else if (name !== 'rho-local-play') { await fs.rm(source.path, { recursive: true, force: true }); removed.push(source.path); }
    }
    current = await addFoundationStage(paths, current, 'clean', 'completed', { removed });
  }
  await updateFoundationOperation(paths, current, { state: 'completed' });
  return { operationId: current.operationId, dryRun: false, sources, conflicts, copied, copiedEntries, removed };
}

export async function rollbackMigration(paths = foundationPaths(), operationId: string) {
  const operation = await readFoundationOperation(paths, operationId);
  if (!operation || operation.kind !== 'migrate') throw new Error(`Migration operation ${operationId} was not found.`);
  const purge = [...operation.stages].reverse().find(stage => stage.name === 'purge' || stage.name === 'clean');
  const removed = purge?.detail && typeof purge.detail === 'object' && Array.isArray((purge.detail as { removed?: unknown }).removed)
    ? (purge.detail as { removed: unknown[] }).removed : [];
  if (removed.length) throw Object.assign(new Error(`Migration ${operationId} purged source paths and cannot be rolled back automatically. Restore from its retained backup before retrying.`), { kind: 'condition', operationId });
  const copy = [...operation.stages].reverse().find(stage => stage.name === 'copy')?.detail;
  const copied = copy && typeof copy === 'object' && Array.isArray((copy as { copiedEntries?: unknown }).copiedEntries)
    ? (copy as { copiedEntries: { path?: unknown; digest?: unknown; kind?: unknown }[] }).copiedEntries : [];
  const rollback = await beginFoundationOperation(paths, 'migrate-rollback', { operationId });
  let current = await addFoundationStage(paths, rollback, 'discover', 'completed', { operationId, copied: copied.length });
  const removedTargets: string[] = [], skipped: string[] = [];
  current = await addFoundationStage(paths, current, 'remove', 'running');
  for (const entry of [...copied].sort((a, b) => String(b.path).length - String(a.path).length)) {
    const target = typeof entry.path === 'string' ? entry.path : '';
    if (!target) continue;
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat) continue;
    if (entry.digest) {
      const actual = stat.isFile() ? digest(await fs.readFile(target)) : stat.isDirectory() ? await treeDigest(target) : '';
      if (actual !== entry.digest) { skipped.push(target); continue; }
    }
    await fs.rm(target, { recursive: true, force: true }); removedTargets.push(target);
  }
  const importedRoot = path.join(paths.state, 'legacy-import');
  for (const target of [...removedTargets].sort((a, b) => b.length - a.length)) {
    let parent = path.dirname(target);
    while (parent.startsWith(importedRoot + path.sep)) {
      const children = await fs.readdir(parent).catch(() => [] as string[]);
      if (children.length) break;
      await fs.rmdir(parent).catch(() => {});
      parent = path.dirname(parent);
    }
  }
  current = await addFoundationStage(paths, current, 'remove', 'completed', { removed: removedTargets, skipped });
  current = await updateFoundationOperation(paths, current, { state: skipped.length ? 'unknown' : 'completed' });
  await updateFoundationOperation(paths, operation, { state: 'rolled-back', error: skipped.length ? `Some copied entries changed: ${skipped.join(', ')}` : undefined });
  return { operationId, rollbackOperationId: current.operationId, removed: removedTargets, skipped, state: current.state };
}

export async function profileList(paths = foundationPaths()) {
  const file = path.join(paths.config, 'profiles.json');
  return readFoundationJson<FoundationManifest['profiles']>(file, {});
}

export async function profileWrite(paths: FoundationPaths, name: string, profile: FoundationManifest['profiles'][string]) {
  const profiles = await profileList(paths); profiles[name] = profile; await writeFoundationJson(path.join(paths.config, 'profiles.json'), profiles); return profiles;
}

export async function profileRemove(paths: FoundationPaths, name: string) {
  const profiles = await profileList(paths); delete profiles[name]; await writeFoundationJson(path.join(paths.config, 'profiles.json'), profiles); return profiles;
}

export function foundationConfigSchema() {
  return { schemaVersion: 1, precedence: ['cli', 'environment', 'profile', 'user', 'platform-default'], paths: ['RHO_HOME', 'RHO_CONFIG_DIR', 'RHO_DATA_DIR', 'RHO_DATA_ROOT', 'RHO_STATE_DIR', 'RHO_RUNTIME_DIR', 'RHO_CACHE_DIR', 'RHO_LOG_DIR', 'RHO_PROJECTS_DIR', 'RHO_HOST_ROOT'], limits: defaultFoundationBudgets, secretInputs: ['RHO_API_KEY_FILE', 'RHO_CONNECTION_FILE', 'stdin', 'keychain'] };
}
