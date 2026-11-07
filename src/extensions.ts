import { extensionDirectory } from './extension-directory.js';
import { ExtensionMarkets, marketLimits, type MarketSelection, type MarketChange } from './extension-markets.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { Ajv } from 'ajv';
import { atomicJson, canonical, digest, requireThat } from '@rho-workspace/plugin-contracts';

export const extensionLimits = { ...marketLimits, maxPlugins: 32, maxVersions: 128, maxFiles: 20000, maxPackageBytes: 128 * 1024 * 1024, maxContentBytes: 512 * 1024, maxReceipts: 2000, maxResultBytes: 1024 * 1024, maxRunning: 4, maxDelegations: 32, timeoutMs: 30000, installTimeoutMs: 180000 };
export interface ExtensionManifest {
  apiVersion: 1; id: string; title: string; description: string; host?: string;
  operations: { id: string; title: string; description: string; effect: 'read' | 'native'; methods: string[]; inputSchema: Record<string, any> }[];
  skills: { id: string; title: string; file: string }[];
  views: { id: string; title: string; file: string }[];
}
export interface InstalledExtension { id: string; name: string; version: string; title: string; description: string; digest: string; source: string; sourceCommit?: string; market?: { id: string; title: string; url: string; digest: string; keywords?: string[] }; enabled: boolean; installedAt: string; manifest: ExtensionManifest }
interface Receipt { invocationId: string; caller: string; projectId: string; pluginId: string; packageDigest: string; operation: string; requestDigest: string; state: 'pending' | 'completed' | 'unknown'; startedAt: string; endedAt?: string; value?: unknown; error?: string; delegations?: { method: string; request: unknown; state: 'pending' | 'completed' | 'unknown'; value?: unknown; error?: string }[] }
const ajv = new Ajv({ strict: false, allErrors: true });
const identifier = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const relativeFile = (v: unknown): v is string => typeof v === 'string' && v.length < 512 && !path.isAbsolute(v) && !v.includes('\\') && v.split('/').every(p => p !== '..' && p !== '.' && p !== '');
const boundedText = (v: unknown, maximum = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= maximum;

async function command(file: string, args: string[], cwd: string, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, npm_config_ignore_scripts: 'true', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + chunk).slice(-8192); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 && !killed ? resolve(output) : reject(new Error(killed ? `Package staging exceeded installTimeoutMs (${timeout} ms). The selected package was kept.` : `${file} failed (${code}): ${output}`)); });
  });
}

export class Extensions {
  readonly limits: typeof extensionLimits;
  readonly markets: ExtensionMarkets;
  private installed: InstalledExtension[] = [];
  private running = new Map<string, Promise<Receipt>>();
  private workers = new Set<ReturnType<typeof fork>>();
  private receiptCount = 0;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, limits: Partial<typeof extensionLimits> = {}) {
    this.limits = { ...extensionLimits, ...limits };
    for (const [key, value] of Object.entries(this.limits)) requireThat(Number.isSafeInteger(value) && value > 0, 'invalid', `Invalid extensions.${key}.`);
    this.markets = new ExtensionMarkets(directory, this.limits);
  }
  async init() {
    await fs.mkdir(path.join(this.directory, 'versions'), { recursive: true });
    await fs.mkdir(path.join(this.directory, 'receipts'), { recursive: true });
    await this.markets.init();
    try { this.installed = JSON.parse(await fs.readFile(path.join(this.directory, 'installed.json'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const receipts = await fs.readdir(path.join(this.directory, 'receipts')); this.receiptCount = receipts.length;
    for (const file of receipts) {
      const receipt: Receipt = JSON.parse(await fs.readFile(path.join(this.directory, 'receipts', file), 'utf8'));
      if (receipt.state === 'pending') await atomicJson(path.join(this.directory, 'receipts', file), { ...receipt, state: 'unknown', endedAt: new Date().toISOString(), error: 'The service ended before the plugin result was retained. Observe the original native operation; do not repeat it under a new identity.' });
    }
  }
  close() { for (const child of this.workers) child.kill(); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.mutation.then(fn, fn); this.mutation = next.catch(() => {}); return next; }
  list() { return { directory: extensionDirectory, markets: this.markets.list(), plugins: this.installed.map(({ manifest, ...info }) => info), limits: this.limits }; }
  changeMarket(input: MarketChange) { return this.serial(async () => ({ markets: await this.markets.change(input) })); }
  describe(id: string) { const value = this.installed.find(p => p.id === id); requireThat(value, 'not_found', 'Plugin is not installed.'); return structuredClone(value); }
  private selected(id: string, expectedDigest: string) { const value = this.describe(id); requireThat(value.digest === expectedDigest, 'stale', 'The selected plugin changed. Read its descriptor again.'); return value; }
  private root(p: InstalledExtension) { return path.join(this.directory, 'versions', p.digest, 'node_modules', p.name); }
  private async file(root: string, relative: string) {
    requireThat(relativeFile(relative), 'invalid', 'Plugin entry must be a relative file within its package.');
    const resolved = await fs.realpath(path.join(root, relative));
    requireThat(resolved.startsWith(await fs.realpath(root) + path.sep) && (await fs.stat(resolved)).isFile(), 'scope', 'Plugin entry escapes its package or is not a file.'); return resolved;
  }
  private async hash(root: string) {
    root = await fs.realpath(root);
    const hash = createHash('sha256'); let bytes = 0, files = 0;
    const walk = async (dir: string) => {
      for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        requireThat(++files <= this.limits.maxFiles, 'limit', 'Plugin tree exceeds extensions.maxFiles; the selected package is kept.');
        const target = path.join(dir, item.name), relative = path.relative(root, target);
        if (item.isDirectory()) { hash.update('dir:' + relative + '\0'); await walk(target); }
        else if (item.isSymbolicLink()) {
          const resolved = await fs.realpath(target); requireThat(resolved.startsWith(root + path.sep) && (await fs.stat(resolved)).isFile(), 'scope', 'Package links must resolve to files within the installed tree.');
          hash.update('link:' + relative + '\0' + await fs.readlink(target) + '\0');
        } else {
          requireThat(item.isFile(), 'invalid', 'Only regular files and contained file links are supported.');
          bytes += (await fs.stat(target)).size; requireThat(bytes <= this.limits.maxPackageBytes, 'limit', 'Plugin tree exceeds extensions.maxPackageBytes; the selected package is kept.');
          hash.update('file:' + relative + '\0'); hash.update(await fs.readFile(target)); hash.update('\0');
        }
      }
    };
    await walk(root); return hash.digest('hex');
  }
  async check(root: string) {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    requireThat(boundedText(pkg.name, 214) && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name) && boundedText(pkg.version, 64), 'invalid', 'Plugin needs an npm package name and version.');
    requireThat(relativeFile(pkg.rhoPlugin), 'invalid', 'package.json must name its manifest in rhoPlugin.');
    const manifestPath = await this.file(root, pkg.rhoPlugin);
    requireThat((await fs.stat(manifestPath)).size <= 65536, 'limit', 'Plugin manifest exceeds 64 KiB.');
    const m: ExtensionManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    requireThat(m.apiVersion === 1 && typeof m.id === 'string' && identifier.test(m.id) && boundedText(m.title, 120) && boundedText(m.description), 'invalid', 'Plugin manifest needs apiVersion 1, id, title and description.');
    for (const [kind, maximum] of [['operations', 32], ['skills', 16], ['views', 16]] as const) {
      requireThat(Array.isArray(m[kind]) && m[kind].length <= maximum && new Set(m[kind].map(x => x.id)).size === m[kind].length, 'invalid', `Invalid or duplicate ${kind}.`);
      for (const entry of m[kind]) requireThat(typeof entry.id === 'string' && identifier.test(entry.id) && boundedText(entry.title, 120), 'invalid', `Invalid ${kind} entry.`);
    }
    if (m.operations.length) { requireThat(m.host, 'invalid', 'Operations need a host entry.'); await this.file(root, m.host); }
    for (const op of m.operations) {
      requireThat(boundedText(op.description) && ['read', 'native'].includes(op.effect) && Array.isArray(op.methods) && op.methods.length <= 16 && op.methods.every(x => typeof x === 'string' && /^[a-z][a-zA-Z.]+$/.test(x) && !x.startsWith('extension.') && !x.startsWith('session.') && !x.startsWith('project.')), 'invalid', 'Invalid operation effect or delegated Rho methods.');
      requireThat(op.inputSchema?.type === 'object', 'invalid', 'An operation inputSchema must describe an object.'); ajv.compile(op.inputSchema);
    }
    for (const entry of [...m.skills, ...m.views]) {
      const file = await this.file(root, entry.file); requireThat((await fs.stat(file)).size <= this.limits.maxContentBytes, 'limit', 'Plugin entry exceeds extensions.maxContentBytes.');
    }
    return { name: pkg.name as string, version: pkg.version as string, manifest: m };
  }
  private async verify(p: InstalledExtension) { requireThat(await this.hash(path.join(this.directory, 'versions', p.digest, 'node_modules')) === p.digest, 'conflict', 'Installed plugin bytes changed. Reinstall the package before use.'); }
  async content(id: string, expected: string, kind: 'skill' | 'view', entryId: string) {
    const p = this.selected(id, expected); if (kind === 'view') requireThat(p.enabled, 'unavailable', 'This plugin is disabled.');
    await this.verify(p); const entry = p.manifest[kind === 'skill' ? 'skills' : 'views'].find(x => x.id === entryId); requireThat(entry, 'not_found', 'Plugin entry not found.');
    return { pluginId: id, packageDigest: p.digest, entryId, kind, title: entry.title, text: await fs.readFile(await this.file(this.root(p), entry.file), 'utf8') };
  }
  install(source: string, replace?: string, expected?: string, market?: MarketSelection) {
    return this.serial(async () => {
      const selection = market ? this.markets.select(market, source) : undefined;
      requireThat(!!replace === !!expected, 'invalid', 'An update needs both replace and expectedDigest.');
      if (replace) this.selected(replace, expected ?? '');
      requireThat(replace || this.installed.length < this.limits.maxPlugins, 'limit', 'Installed plugins reached extensions.maxPlugins. Remove one before adding another.');
      const versions = await fs.readdir(path.join(this.directory, 'versions'));
      requireThat(versions.length < this.limits.maxVersions, 'limit', 'Retained package revisions reached extensions.maxVersions. Existing packages and receipts are kept; increase the configured limit before installing.');
      const stage = await fs.mkdtemp(path.join(this.directory, 'staging-'));
      try {
        let spec = source, sourceCommit: string | undefined;
        if (source.startsWith('git+https://')) {
          const [remote, selector = 'HEAD'] = source.slice(4).split('#');
          const [ref, subdir] = selector.split(':'); const url = new URL(remote);
          requireThat(!url.username && !url.password && !url.search && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && (!subdir || relativeFile(subdir)), 'invalid', 'Use a public HTTPS Git source with #ref:relative/package. Credentials and query strings are not accepted.');
          const sourceDirectory = path.join(stage, 'source'); await fs.mkdir(sourceDirectory); const repo = await fs.realpath(sourceDirectory);
          for (const args of [['init', '-q'], ['remote', 'add', 'origin', remote], ['fetch', '-q', '--depth=1', 'origin', ref], ['checkout', '-q', '--detach', 'FETCH_HEAD']]) await command('git', args, repo, this.limits.installTimeoutMs);
          sourceCommit = (await command('git', ['rev-parse', 'HEAD'], repo, this.limits.installTimeoutMs)).trim();
          spec = path.join(repo, subdir ?? ''); requireThat((await fs.realpath(spec)).startsWith(repo + path.sep) || spec === repo, 'scope', 'Git package escapes its source.');
        } else if (source.startsWith('https://')) {
          const url = new URL(source); requireThat(!url.username && !url.password && !url.search && url.pathname.endsWith('.tgz'), 'invalid', 'Use a public HTTPS .tgz without credentials or query strings.');
        } else {
          const local = source.startsWith('file:') ? source.slice(5) : source;
          const present = await fs.stat(path.resolve(local)).catch(() => null);
          if (present) { spec = path.resolve(local); source = spec; }
          else requireThat(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-zA-Z0-9.*^~+_-]+)?$/.test(source), 'invalid', 'Use an npm package, existing local folder/tarball, HTTPS .tgz, or git+https source.');
        }
        const install = path.join(stage, 'install'); await fs.mkdir(install);
        await atomicJson(path.join(install, 'package.json'), { name: 'rho-plugin-installation', version: '1.0.0', private: true });
        const npmCli = /npm-cli\.js$/.test(process.env.npm_execpath ?? '') ? process.env.npm_execpath : process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined;
        await command(npmCli ? process.execPath : 'npm', [...(npmCli ? [npmCli] : []), 'install', '--ignore-scripts', '--engine-strict', '--omit=dev', '--no-audit', '--no-fund', '--install-links', '--', spec], install, this.limits.installTimeoutMs);
        const pkg = JSON.parse(await fs.readFile(path.join(install, 'package.json'), 'utf8')), names = Object.keys(pkg.dependencies ?? {});
        requireThat(names.length === 1, 'invalid', 'Install exactly one plugin package.');
        const checked = await this.check(path.join(install, 'node_modules', names[0]));
        requireThat(!selection || (checked.manifest.id === selection.entry.id && checked.version === selection.entry.version), 'conflict', 'Package identity or version does not match the selected market entry. The installed selection was kept.');
        requireThat(!replace || checked.manifest.id === replace, 'conflict', 'An update must keep the plugin identity.');
        requireThat(replace || !this.installed.some(p => p.id === checked.manifest.id), 'conflict', 'Plugin is already installed. Use update with its current digest.');
        await fs.rm(path.join(install, 'node_modules', '.package-lock.json'), { force: true });
        const sha = await this.hash(path.join(install, 'node_modules'));
        const previous = replace ? this.describe(replace) : undefined;
        const origin = selection?.origin ?? (previous?.source === source && previous.version === checked.version ? previous.market : undefined);
        const selected: InstalledExtension = { id: checked.manifest.id, name: checked.name, version: checked.version, title: checked.manifest.title, description: checked.manifest.description, digest: sha, source, ...(sourceCommit ? { sourceCommit } : {}), ...(origin ? { market: origin } : {}), enabled: previous?.enabled ?? true, installedAt: new Date().toISOString(), manifest: checked.manifest };
        const destination = path.join(this.directory, 'versions', sha);
        if (!versions.includes(sha)) await fs.rename(install, destination);
        const next = [...this.installed.filter(p => p.id !== selected.id), selected];
        await atomicJson(path.join(this.directory, 'installed.json'), next); this.installed = next;
        return selected;
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    });
  }
  manage(id: string, expected: string, action: 'enable' | 'disable' | 'remove') {
    return this.serial(async () => {
      const p = this.selected(id, expected);
      const next = this.installed.filter(x => x.id !== id); if (action !== 'remove') next.push({ ...p, enabled: action === 'enable' });
      await atomicJson(path.join(this.directory, 'installed.json'), next); this.installed = next;
      return { pluginId: id, action, retained: 'Native sessions, project data, receipts and package revisions are retained.' };
    });
  }
  async read(invocationId: string, caller: string, projectId: string) {
    let receipt: Receipt;
    try { receipt = JSON.parse(await fs.readFile(path.join(this.directory, 'receipts', invocationId + '.json'), 'utf8')); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; requireThat(false, 'not_found', 'Plugin invocation not found.'); }
    requireThat(receipt.caller === caller && receipt.projectId === projectId, 'scope', 'This plugin invocation belongs to another caller or project.'); return receipt;
  }
  async call(b: { pluginId: string; expectedDigest: string; operation: string; input: any; changeId: string; projectId: string }, caller: string, projectRoot: string, dispatch: (method: string, body: any, effect: 'read' | 'native') => Promise<unknown>) {
    const invocationId = digest(canonical([caller, b.projectId, b.pluginId, b.changeId]));
    const requestDigest = digest(canonical(b));
    // Read the receipt before the selected package: an update or removal must not
    // turn a retry of an acknowledged write into another invocation.
    const earlier = await this.read(invocationId, caller, b.projectId).catch((e: any) => { if (e.kind !== 'not_found') throw e; return null; });
    if (earlier) { requireThat(earlier.requestDigest === requestDigest, 'conflict', 'changeId already names a different plugin request.'); return earlier; }
    const active = this.running.get(invocationId); if (active) { const receipt = await active; requireThat(receipt.requestDigest === requestDigest, 'conflict', 'changeId already names a different plugin request.'); return receipt; }
    const p = this.selected(b.pluginId, b.expectedDigest); requireThat(p.enabled, 'unavailable', 'This plugin is disabled.');
    const operation = p.manifest.operations.find(op => op.id === b.operation); requireThat(operation, 'not_found', 'Plugin operation not found.');
    const validate = ajv.compile(operation.inputSchema); requireThat(validate(b.input), 'invalid', 'Input does not match the plugin operation schema.', { problems: validate.errors });
    requireThat(this.running.size < this.limits.maxRunning, 'limit', 'Plugin calls reached extensions.maxRunning. Existing calls continue.');
    const retained = operation.effect !== 'read';
    if (retained) { requireThat(this.receiptCount < this.limits.maxReceipts, 'limit', 'Plugin receipts reached extensions.maxReceipts. Existing receipts are kept; increase the limit before another write.'); this.receiptCount++; }
    const run = async (): Promise<Receipt> => {
      await this.verify(p);
      const receipt: Receipt = { invocationId, caller, projectId: b.projectId, pluginId: p.id, packageDigest: p.digest, operation: b.operation, requestDigest, state: 'pending', startedAt: new Date().toISOString() };
      const filename = path.join(this.directory, 'receipts', invocationId + '.json');
      let writes: Promise<unknown> = Promise.resolve();
      const save = () => { const snapshot = structuredClone(receipt); const next = writes.then(() => atomicJson(filename, snapshot)); writes = next.catch(() => {}); return next; };
      if (retained) await save();
      const delegate = async (method: string, body: any) => {
        const entry: NonNullable<Receipt['delegations']>[number] = { method, request: body, state: 'pending' };
        const entries = [...(receipt.delegations ?? []), entry];
        requireThat(Buffer.byteLength(JSON.stringify({ ...receipt, delegations: entries })) <= this.limits.maxResultBytes, 'limit', 'Plugin receipt reached extensions.maxResultBytes before delegation. No further native request was submitted.');
        receipt.delegations = entries;
        if (retained) await save();
        try {
          const value = await dispatch(method, body, operation.effect);
          if (Buffer.byteLength(JSON.stringify({ ...receipt, candidate: value })) > this.limits.maxResultBytes) throw new Error('Native reply exceeds extensions.maxResultBytes. Its original request is retained; observe output with the native owner.');
          entry.value = value; entry.state = 'completed';
          if (retained) await save();
          return value;
        } catch (error) { entry.state = 'unknown'; entry.error = error instanceof Error ? error.message : String(error); if (retained) await save(); throw error; }
      };
      try {
        const value = await this.execute(p, operation, b.input, invocationId, projectRoot, delegate);
        requireThat(Buffer.byteLength(JSON.stringify({ ...receipt, value })) <= this.limits.maxResultBytes, 'limit', 'Plugin result exceeds extensions.maxResultBytes. Delegated native identities and available replies are retained.');
        receipt.value = value; receipt.state = 'completed';
      }
      catch (error) { receipt.state = 'unknown'; receipt.error = error instanceof Error ? error.message : String(error); }
      receipt.endedAt = new Date().toISOString(); if (retained) await save(); return receipt;
    };
    const promise = run(); this.running.set(invocationId, promise);
    try { return await promise; } finally { this.running.delete(invocationId); }
  }
  private async execute(p: InstalledExtension, operation: ExtensionManifest['operations'][number], input: any, invocationId: string, projectRoot: string, dispatch: (method: string, body: any) => Promise<unknown>) {
    const entry = await this.file(this.root(p), p.manifest.host!);
    return new Promise<unknown>((resolve, reject) => {
      const child = fork(new URL('./extension-worker.js', import.meta.url), [], { cwd: projectRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
      this.workers.add(child); let ended = false, calls = 0;
      const finish = (error?: Error, value?: unknown) => { if (ended) return; ended = true; clearTimeout(timer); this.workers.delete(child); child.kill(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error('Plugin exceeded extensions.timeoutMs. Its native operations may still be running; observe their original identities.')), this.limits.timeoutMs);
      child.on('error', error => finish(error)); child.on('exit', () => finish(new Error('Plugin exited before its result was received. The native outcome is unknown.')));
      child.on('message', async (message: any) => {
        if (ended) return;
        if (Buffer.byteLength(JSON.stringify(message)) > this.limits.maxResultBytes) return finish(new Error('Plugin exceeded extensions.maxResultBytes. Native output remains with its owner; the plugin result is unknown.'));
        if (message.type === 'result') return finish(undefined, message.value);
        if (message.type === 'error') return finish(new Error(String(message.error)));
        if (message.type === 'call') {
          try {
            requireThat(++calls <= this.limits.maxDelegations, 'limit', 'Plugin reached extensions.maxDelegations; no further Rho call was submitted.');
            requireThat(operation.methods.includes(message.method), 'scope', 'Plugin did not declare this Rho method.');
            const value = await dispatch(message.method, message.body);
            if (!ended && child.connected) child.send({ type: 'reply', id: message.id, value });
          } catch (error) { if (!ended && child.connected) child.send({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
        }
      });
      child.send({ type: 'start', entry, operation: operation.id, input, projectRoot, invocationId });
    });
  }
}
