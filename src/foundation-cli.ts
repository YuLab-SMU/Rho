import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  addFoundationStage,
  beginFoundationOperation,
  defaultFoundationBudgets,
  doctorFoundation,
  ensureFoundationPaths,
  ensureManifest,
  foundationConfigSchema,
  foundationPaths,
  hostCleanup,
  hostScan,
  jsonHostAdapter,
  migrateLegacy,
  packageIdentity,
  pathExists,
  foundationPathsForState,
  rollbackMigration,
  profileList,
  profileRemove,
  profileWrite,
  cacheReport,
  logsReport,
  pruneLogs,
  pruneCache,
  pruneTemporary,
  readFoundationJson,
  readFoundationOperation,
  reportFoundationPaths,
  temporaryReport,
  updateFoundationOperation,
  writeFoundationJson,
} from './foundation.js';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const fail = (message: string, code = 1) => { process.stderr.write(message.trimEnd() + '\n'); return code; };
const json = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const currentCli = fileURLToPath(new URL('./cli.js', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const processAlive = (pid: number) => { try { process.kill(pid, 0); if (process.platform === 'linux') { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); if (/\)\s+Z(?:\s|$)/.test(stat)) return false; } return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

async function stopProfile(state: string) {
  const lock = path.join(state, 'service.lock');
  if (!await pathExists(lock)) return true;
  await fs.writeFile(path.join(state, 'service.stop'), 'rho uninstall\n', { mode: 0o600 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!await pathExists(lock)) return true;
    const owner = await readFoundationJson<{ pid?: number } | null>(lock, null);
    if (owner?.pid && !processAlive(owner.pid)) return true;
    await sleep(250);
  }
  return false;
}

async function readPackage(file: string) {
  return readFoundationJson<{ name?: string; version?: string } | null>(file, null);
}

async function packageCandidates() {
  const paths = foundationPaths(), identity = await packageIdentity(), candidates = new Set<string>();
  if (identity) candidates.add(identity.root);
  const prefix = process.env.npm_config_prefix;
  if (prefix) {
    candidates.add(path.join(prefix, 'lib', 'node_modules', '@rho-workspace', 'rho'));
    candidates.add(path.join(prefix, 'node_modules', '@rho-workspace', 'rho'));
  }
  candidates.add(path.join(paths.app, 'node_modules', '@rho-workspace', 'rho'));
  candidates.add(path.join(paths.home, '.rho-app', 'node_modules', '@rho-workspace', 'rho'));
  candidates.add(path.join(paths.home, '.rho-app'));
  candidates.add(path.join(paths.home, 'Rho', 'rho-fixed-0.5.10'));
  const versions = [] as { root: string; package?: { name?: string; version?: string }; active: boolean }[];
  for (const root of candidates) {
    const packageInfo = await readPackage(path.join(root, 'package.json'));
    if (packageInfo) versions.push({ root, package: packageInfo, active: identity?.root === root });
  }
  return versions;
}

async function npmPrefixFor(packageRoot: string) {
  if (process.env.npm_config_prefix) {
    const prefix = path.resolve(process.env.npm_config_prefix);
    if (path.resolve(packageRoot).startsWith(path.join(prefix, 'lib', 'node_modules') + path.sep) || path.resolve(packageRoot).startsWith(path.join(prefix, 'node_modules') + path.sep)) return prefix;
  }
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}@rho-workspace${path.sep}rho`;
  const index = packageRoot.indexOf(marker);
  if (index >= 0) return packageRoot.slice(0, index);
  const windowsMarker = `${path.sep}node_modules${path.sep}@rho-workspace${path.sep}rho`;
  const windowsIndex = packageRoot.indexOf(windowsMarker);
  return windowsIndex >= 0 ? packageRoot.slice(0, windowsIndex) : null;
}

async function binEntries(packageRoot: string) {
  const packageInfo = await readFoundationJson<{ name?: string; bin?: Record<string, string> | string }>(path.join(packageRoot, 'package.json'), {});
  const bin = typeof packageInfo.bin === 'string' ? { [packageInfo.name?.split('/').at(-1) ?? 'rho']: packageInfo.bin } : packageInfo.bin ?? {};
  const prefix = await npmPrefixFor(packageRoot);
  if (!prefix) return [];
  const platform = foundationPaths().platform;
  const binRoot = platform === 'win32' ? path.join(prefix) : path.join(prefix, 'bin');
  return Object.entries(bin).map(([name, target]) => ({ name, path: path.join(binRoot, platform === 'win32' ? name + '.cmd' : name), target: path.resolve(packageRoot, target) }));
}

async function runNpm(args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function runProgram(program: string, args: string[], cwd = process.cwd()) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function linkedSystemdUserUnit(registration: string, fallbackHome: string) {
  const environment = await runProgram('systemctl', ['--user', 'show-environment']);
  const values = Object.fromEntries(environment.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ''];
  }));
  const configHome = values.XDG_CONFIG_HOME || path.join(values.HOME || fallbackHome, '.config');
  return path.join(configHome, 'systemd', 'user', path.basename(registration));
}

const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const systemdEscape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
const safeServiceName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'default';

function serviceDefinition(paths: ReturnType<typeof foundationPaths>, profile: string) {
  const safe = safeServiceName(profile), label = paths.platform === 'darwin' ? `com.rho.workspace.${safe}` : `rho-${safe}`;
  const descriptorDir = path.join(paths.config, 'services');
  const metadata = path.join(descriptorDir, safe + (paths.platform === 'darwin' ? '.plist.json' : paths.platform === 'win32' ? '.task.json' : '.service.json'));
  const native = path.join(descriptorDir, safe + (paths.platform === 'darwin' ? '.plist' : paths.platform === 'win32' ? '.xml' : '.service'));
  const registration = paths.platform === 'darwin'
    ? path.join(paths.home, 'Library', 'LaunchAgents', label + '.plist')
    : paths.platform === 'win32'
      ? path.join(paths.config, 'tasks', label + '.xml')
      // systemd --user only searches the XDG user unit directory.  Keep the Rho
      // application namespace under `$XDG_CONFIG_HOME/rho`, but register the
      // unit beside it at `$XDG_CONFIG_HOME/systemd/user` so a real user
      // manager can discover it.
      : path.join(process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(paths.home, '.config'), 'systemd', 'user', label + '.service');
  const command = process.execPath, cliPath = currentCli;
  const args = [cliPath, 'start', '--profile', profile];
  const environment = { RHO_HOME: paths.home, RHO_CONFIG_DIR: paths.config, RHO_DATA_DIR: paths.data, RHO_STATE_DIR: paths.state, RHO_RUNTIME_DIR: paths.runtime, RHO_CACHE_DIR: paths.cache, RHO_LOG_DIR: paths.logs, RHO_PROJECTS_DIR: paths.projects, RHO_HOST_ROOT: paths.hosts };
  const content = paths.platform === 'darwin'
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${[command, ...args].map(value => `<string>${xmlEscape(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`
    : paths.platform === 'win32'
      ? `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Rho ${xmlEscape(profile)} workspace</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions Context="Author"><Exec><Command>${xmlEscape(command)}</Command><Arguments>${xmlEscape(args.map(value => `"${value}"`).join(' '))}</Arguments></Exec></Actions></Task>\n`
      : `[Unit]\nDescription=Rho ${profile} workspace\nAfter=network.target\n[Service]\nType=simple\n${Object.entries(environment).map(([key, value]) => `Environment=${key}="${systemdEscape(value)}"`).join('\n')}\nExecStart=${[command, ...args].map(value => JSON.stringify(value)).join(' ')}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`;
  return { profile, label, metadata, native, registration, command, args, content, platform: paths.platform };
}

async function writeServiceText(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const value = process.platform === 'win32' && path.extname(file).toLowerCase() === '.xml'
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
    : content;
  await fs.writeFile(temporary, value, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function installCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { json: { type: 'boolean' }, profile: { type: 'string' }, root: { type: 'string' }, 'state-dir': { type: 'string' }, port: { type: 'string' }, logs: { type: 'string' }, plugins: { type: 'string' } } });
  const paths = parsed.values.root || parsed.values['state-dir'] ? foundationPathsForState(String(parsed.values['state-dir'] ?? foundationPaths().state), String(parsed.values.root ?? foundationPaths().projects)) : foundationPaths();
  await ensureFoundationPaths(paths);
  const identity = await packageIdentity();
  const manifest = await ensureManifest(paths, identity);
  const preflight = { node: process.version, npmPrefix: process.env.npm_config_prefix ?? null, packageRoot: identity?.root ?? null, writable: await fs.access(paths.app, fsConstants.W_OK).then(() => true, () => false) };
  if (parsed.values.profile) {
    const profilePaths = foundationPaths();
    await profileWrite(profilePaths, String(parsed.values.profile), { root: paths.projects, state: paths.state, ...(parsed.values.port ? { port: Number(parsed.values.port) } : {}), ...(parsed.values.logs ? { logs: path.resolve(String(parsed.values.logs)) } : {}), ...(parsed.values.plugins ? { plugins: String(parsed.values.plugins).split(',').filter(Boolean) } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const result = { installed: { manifest: paths.manifest, paths, package: identity, preflight } };
  if (parsed.values.json) json(result); else process.stdout.write(`Rho installation recorded at ${paths.manifest}.\n`);
  return 0;
}

async function versionsCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const activeIdentity = await packageIdentity(), versions = await packageCandidates();
  const pluginsRoot = process.env.RHO_PLUGINS_ROOT ?? path.resolve(path.dirname(activeIdentity?.root ?? process.cwd()), '..', 'Rho-plugins');
  const pluginsPackage = await readPackage(path.join(pluginsRoot, 'package.json'));
  const core = process.env.RHO_CORE_BINARY ? { binary: path.resolve(process.env.RHO_CORE_BINARY), source: 'environment' } : null;
  const result = { active: versions.find(item => item.active) ?? null, versions, components: { core, plugins: pluginsPackage ? { root: pluginsRoot, package: pluginsPackage, source: 'checkout' } : null, adapters: [] }, schemaVersion: 1, generatedAt: new Date().toISOString() };
  if (parsed.values.json) json(result); else for (const item of versions) process.stdout.write(`${item.active ? '* ' : '  '}${item.package?.name ?? 'package'}@${item.package?.version ?? 'unknown'} ${item.root}\n`);
  return 0;
}

async function upgradeCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, package: { type: 'string' }, json: { type: 'boolean' } } });
  const identity = await packageIdentity(), prefix = identity ? await npmPrefixFor(identity.root) : null;
  const candidates = await packageCandidates();
  const plan = { current: identity, prefix, package: parsed.values.package ?? identity?.name ?? '@rho-workspace/rho', candidates, preserve: ['profiles', 'state', 'projects', 'host registrations'] };
  if (!parsed.values.apply) { const value = { upgrade: { dryRun: true, plan } }; if (parsed.values.json) json(value); else process.stdout.write(JSON.stringify(value, null, 2) + '\n'); return 0; }
  if (!prefix) return fail('Cannot determine the npm prefix for the active package. Run upgrade from an npm installation or pass an explicit package prefix.');
  const operation = await beginFoundationOperation(foundationPaths(), 'upgrade', plan);
  let journal = await addFoundationStage(foundationPaths(), operation, 'discover', 'completed', plan);
  const packageResult = await runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', String(parsed.values.package ?? identity?.name ?? '@rho-workspace/rho')], path.dirname(identity?.root ?? process.cwd()));
  journal = await addFoundationStage(foundationPaths(), journal, 'package', packageResult.code === 0 ? 'completed' : 'failed', { package: packageResult });
  await updateFoundationOperation(foundationPaths(), journal, { state: packageResult.code === 0 ? 'completed' : 'failed' });
  const value = { upgrade: { operationId: operation.operationId, package: packageResult, plan } };
  if (parsed.values.json) json(value); else process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return packageResult.code === 0 ? 0 : 1;
}

async function uninstallCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { 'dry-run': { type: 'boolean' }, purge: { type: 'boolean' }, resume: { type: 'string' }, 'skip-package': { type: 'boolean' }, json: { type: 'boolean' } } });
  const paths = foundationPaths(), identity = await packageIdentity(), bins = identity ? await binEntries(identity.root) : [];
  const receipt = path.join(path.dirname(paths.app), 'Rho-uninstall-receipt.json');
  const previousReceipt = await readFoundationJson<Record<string, unknown> | null>(receipt, null);
  if (previousReceipt && !parsed.values.resume) { const value = { uninstall: { alreadyCompleted: true, receipt, result: previousReceipt } }; if (parsed.values.json) json(value); else process.stdout.write(JSON.stringify(value, null, 2) + '\n'); return 0; }
  const manifest = await readFoundationJson<{ profiles?: Record<string, { state?: string }> } | null>(paths.manifest, null);
  const profileStates = Object.values(manifest?.profiles ?? {}).map(profile => profile.state).filter((state): state is string => !!state);
  const hosts = await hostScan(paths);
  const legacy = (await reportFoundationPaths(paths)).legacy;
  const staging = identity ? (await fs.readdir(path.dirname(identity.root), { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^\.rho-[A-Za-z0-9]+$/.test(entry.name)).map(entry => path.join(path.dirname(identity.root), entry.name)) : [];
  const plan = { package: identity, bins, hosts, legacy, staging, profiles: profileStates, state: paths.state, cache: paths.cache, logs: paths.logs, projects: paths.projects };
  if (parsed.values['dry-run']) { if (parsed.values.json) json({ uninstall: { dryRun: true, plan } }); else process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return 0; }
  const stopped = [] as string[], pending = [] as string[];
  for (const state of profileStates) (await stopProfile(state) ? stopped : pending).push(state);
  if (pending.length) { if (parsed.values.json) json({ uninstall: { pending, stopped } }); else process.stderr.write(`Rho profiles did not stop within 30 seconds: ${pending.join(', ')}\n`); return 1; }
  let resumeOperation = parsed.values.resume ? await readFoundationOperation(paths, String(parsed.values.resume)) : null;
  if (!resumeOperation && !parsed.values.resume) {
    const operationRoot = path.join(paths.data, 'operations');
    const candidates = [] as import('./foundation.js').FoundationOperation[];
    for (const entry of await fs.readdir(operationRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.name.startsWith('uninstall-') || !entry.name.endsWith('.json')) continue;
      const candidate = await readFoundationJson<import('./foundation.js').FoundationOperation | null>(path.join(operationRoot, entry.name), null);
      if (candidate && ['failed', 'running', 'unknown'].includes(candidate.state)) candidates.push(candidate);
    }
    resumeOperation = candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }
  if (parsed.values.resume && !resumeOperation) return fail(`Uninstall operation ${parsed.values.resume} was not found.`);
  const operation = resumeOperation ?? await beginFoundationOperation(paths, 'uninstall', { ...plan, resumedFrom: parsed.values.resume ?? undefined });
  let journal = await addFoundationStage(paths, operation, 'stop', 'completed', { stopped });
  const quarantined: string[] = [];
  for (const candidate of staging) {
    const target = path.join(paths.state, 'quarantine', 'npm', path.basename(candidate));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.rename(candidate, target).then(() => quarantined.push(target)).catch(() => {});
  }
  journal = await addFoundationStage(paths, journal, 'quarantine', 'completed', { quarantined });
  const removedBins: string[] = [];
  for (const bin of bins) {
    const target = await fs.realpath(bin.path).catch(async () => {
      const link = await fs.readlink(bin.path).catch(() => null);
      return link ? path.resolve(path.dirname(bin.path), link) : null;
    });
    if (target && path.resolve(target) === path.resolve(bin.target!)) { await fs.rm(bin.path, { force: true }); removedBins.push(bin.path); }
  }
  journal = await addFoundationStage(paths, journal, 'bins', 'completed', { removedBins });
  const host = await hostCleanup(paths);
  journal = await addFoundationStage(paths, journal, 'hosts', 'completed', { host });
  const removablePrefix = identity ? await npmPrefixFor(identity.root) : null;
  const packageResult = identity && removablePrefix && !parsed.values['skip-package'] ? await runNpm(['uninstall', '--global', '--prefix', removablePrefix, '--ignore-scripts', '--no-audit', '--no-fund', identity.name], path.dirname(identity.root)) : { code: 0, stdout: '', stderr: 'package step skipped' };
  journal = await addFoundationStage(paths, journal, 'package', packageResult.code === 0 ? 'completed' : 'failed', { package: packageResult });
  if (parsed.values.purge) {
    journal = await addFoundationStage(paths, journal, 'purge', 'running', { folders: [paths.cache, paths.logs, paths.runtime, paths.state] });
    for (const folder of [paths.cache, paths.logs, paths.runtime, paths.state]) await fs.rm(folder, { recursive: true, force: true });
    journal = await addFoundationStage(paths, journal, 'purge', 'completed', { folders: [paths.cache, paths.logs, paths.runtime, paths.state] });
  }
  journal = await updateFoundationOperation(paths, journal, { state: packageResult.code === 0 ? 'completed' : 'failed' });
  const result = { completedAt: new Date().toISOString(), operationId: operation.operationId, journal: path.join(paths.data, 'operations', operation.operationId + '.json'), receipt, package: packageResult, stopped, removedBins, quarantined, host, purged: !!parsed.values.purge, plan };
  await fs.mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 }); await writeFoundationJson(receipt, result);
  if (parsed.values.json) json({ uninstall: result }); else process.stdout.write(`Rho uninstall completed. Receipt ${receipt}.\n`);
  return packageResult.code === 0 ? 0 : 1;
}

async function migrateCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, rollback: { type: 'string' }, purge: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (parsed.values.rollback) {
    const result = await rollbackMigration(foundationPaths(), String(parsed.values.rollback));
    if (parsed.values.json) json({ migrate: result }); else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.skipped.length ? 1 : 0;
  }
  if (!parsed.values['dry-run'] && !parsed.values.apply) return fail('Choose --dry-run, --apply or --rollback OPERATION_ID.');
  const result = await migrateLegacy(foundationPaths(), { dryRun: !!parsed.values['dry-run'], purge: !!parsed.values.purge });
  if (parsed.values.json) json({ migrate: result }); else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

async function profileCommand(args: string[]) {
  const action = args[0] ?? 'list', rest = args.slice(1), paths = foundationPaths();
  if (action === 'list') { json({ profiles: await profileList(paths) }); return 0; }
  const parsed = parseArgs({ args: rest, allowPositionals: true, options: { root: { type: 'string' }, 'state-dir': { type: 'string' }, port: { type: 'string' }, logs: { type: 'string' }, plugins: { type: 'string' }, limits: { type: 'string' } } });
  const name = parsed.positionals[0]; if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) return fail('Give a profile name.');
  if (action === 'remove') { json({ profiles: await profileRemove(paths, name) }); return 0; }
  if (action !== 'create') return fail('Choose profile list, create or remove.');
  const now = new Date().toISOString();
  const limits = parsed.values.limits ? JSON.parse(await fs.readFile(String(parsed.values.limits), 'utf8')) : undefined;
  json({ profiles: await profileWrite(paths, name, { root: path.resolve(String(parsed.values.root ?? paths.projects)), state: path.resolve(String(parsed.values['state-dir'] ?? paths.state)), ...(parsed.values.port ? { port: Number(parsed.values.port) } : {}), ...(parsed.values.logs ? { logs: path.resolve(String(parsed.values.logs)) } : {}), ...(parsed.values.plugins ? { plugins: String(parsed.values.plugins).split(',').filter(Boolean) } : {}), ...(limits ? { limits } : {}), createdAt: now, updatedAt: now }) });
  return 0;
}

async function configCommand(args: string[]) {
  const action = args[0] ?? 'show', paths = foundationPaths();
  if (action === 'schema') { json(foundationConfigSchema()); return 0; }
  if (action === 'path') { json({ config: paths.config, file: paths.configFile }); return 0; }
  if (action !== 'show') return fail('Choose config show, path or schema.');
  const raw = await readFoundationJson<Record<string, unknown> | null>(paths.configFile, null);
  const redact = (value: unknown, key = ''): unknown => {
    if (/token|secret|password|credential|api.?key/i.test(key)) return '[redacted]';
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redact(item, name)]));
    return value;
  };
  const value = redact(raw);
  json({ file: paths.configFile, value }); return 0;
}

async function cacheCommand(args: string[]) {
  const action = args[0] ?? 'list', paths = foundationPaths();
  if (action === 'list') { json({ temporary: await temporaryReport(paths), cache: await cacheReport(paths) }); return 0; }
  if (action === 'prune') { json({ temporary: await pruneTemporary(paths), cache: await pruneCache(paths), logs: await pruneLogs(paths) }); return 0; }
  return fail('Choose cache list or prune.');
}

async function logsCommand(args: string[]) {
  const parsed = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const result = await logsReport(foundationPaths());
  if (parsed.values.json) json(result); else for (const file of result.files) process.stdout.write(`${file.bytes}\t${file.modifiedAt}\t${file.path}\n`);
  return 0;
}

async function hostCommand(args: string[]) {
  const action = args[0] ?? 'scan', parsed = parseArgs({ args: args.slice(1), options: { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  if (action === 'scan') { const paths = foundationPaths(), adapter = jsonHostAdapter(); json({ hosts: await hostScan(paths), adapters: [{ id: adapter.id, detected: await adapter.detect(paths), owned: await adapter.listOwned(paths) }] }); return 0; }
  if (action !== 'cleanup') return fail('Choose host scan or cleanup.');
  const result = await hostCleanup(foundationPaths(), { dryRun: !!parsed.values['dry-run'] }); json({ cleanup: result }); return 0;
}

async function serviceCommand(args: string[]) {
  const action = args[0] ?? 'status', paths = foundationPaths(), profile = args[1] ?? 'default';
  const parsed = parseArgs({ args: args.slice(2), options: { apply: { type: 'boolean' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  const definition = serviceDefinition(paths, profile);
  const metadata = await readFoundationJson<Record<string, unknown> | null>(definition.metadata, null);
  const result = async (value: unknown) => { json(value); return 0; };
  if (action === 'status') {
    return result({ service: { profile, platform: paths.platform, installed: !!metadata, file: definition.metadata, descriptor: definition.native, registration: definition.registration, registered: await pathExists(definition.registration), metadata: definition.metadata, ...(metadata ? { state: metadata.state } : {}) } });
  }
  await fs.mkdir(path.dirname(definition.metadata), { recursive: true, mode: 0o700 });
  if (action === 'uninstall') {
    const apply = !!parsed.values.apply && !process.env.RHO_SERVICE_NO_APPLY;
    let manager = { code: 0, stdout: '', stderr: '' };
    if (apply) {
      if (paths.platform === 'darwin') manager = await runProgram('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${definition.label}`]);
      else if (paths.platform === 'linux') {
        manager = await runProgram('systemctl', ['--user', 'disable', '--now', `${definition.label}.service`]);
        if (manager.code === 0) {
          // `systemctl link` has no matching `unlink` verb.  Disable removes
          // the target.wants entry; remove the manager's linked unit itself and
          // reload so a later status cannot observe a dangling registration.
          await fs.rm(await linkedSystemdUserUnit(definition.registration, paths.home), { force: true }).catch(() => {});
          await runProgram('systemctl', ['--user', 'daemon-reload']);
        }
      }
      else if (paths.platform === 'win32') manager = await runProgram('schtasks.exe', ['/Delete', '/TN', definition.label, '/F']);
    }
    await fs.rm(definition.registration, { force: true }).catch(() => {});
    await fs.rm(definition.native, { force: true });
    await fs.rm(definition.metadata, { force: true });
    const value = { service: { profile, platform: paths.platform, installed: false, file: definition.metadata, descriptor: definition.native, registration: definition.registration, applied: apply, manager } };
    return result(value);
  }
  if (action !== 'install') return fail('Choose service install, uninstall or status.');
  const apply = !!parsed.values.apply && !process.env.RHO_SERVICE_NO_APPLY;
  const unit = { schemaVersion: 1, profile, label: definition.label, command: definition.command, args: definition.args, descriptor: definition.native, registration: definition.registration, generatedAt: new Date().toISOString(), platform: definition.platform, applyRequested: apply, state: 'descriptor' as string };
  if (!parsed.values['dry-run']) {
    await writeServiceText(definition.native, definition.content);
    if (apply) {
      await fs.mkdir(path.dirname(definition.registration), { recursive: true, mode: 0o700 });
      await writeServiceText(definition.registration, definition.content);
      let manager;
      if (paths.platform === 'darwin') manager = await runProgram('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, definition.registration]);
      else if (paths.platform === 'linux') {
        // The disposable episode and a custom XDG_CONFIG_HOME can put the unit
        // outside the manager's own search path. `link` makes that absolute
        // unit path discoverable without copying it into a user directory.
        const linked = await runProgram('systemctl', ['--user', 'link', definition.registration]);
        if (linked.code) manager = linked;
        else {
          const reloaded = await runProgram('systemctl', ['--user', 'daemon-reload']);
          manager = reloaded.code ? reloaded : await runProgram('systemctl', ['--user', 'enable', '--now', `${definition.label}.service`]);
        }
      } else manager = await runProgram('schtasks.exe', ['/Create', '/TN', definition.label, '/XML', definition.registration, '/F']);
      unit.state = manager.code === 0 ? 'registered' : 'pending';
      (unit as Record<string, unknown>).manager = manager;
    }
    await writeFoundationJson(definition.metadata, unit);
  }
  return result({ service: { ...unit, file: definition.metadata } });
}

export async function restartCommand(args: string[]) {
  const stateIndex = args.indexOf('--state-dir'), profileIndex = args.indexOf('--profile');
  let state = stateIndex >= 0 ? args[stateIndex + 1] : foundationPaths().state;
  if (stateIndex < 0 && profileIndex >= 0) {
    const profile = args[profileIndex + 1];
    const profiles = await readFoundationJson<Record<string, { state?: string }>>(path.join(foundationPaths().config, 'profiles.json'), {});
    state = profiles[profile ?? '']?.state ?? state;
  }
  const stopArgs = ['--stop', '--state-dir', state];
  await new Promise<void>(resolve => { const child = spawn(process.execPath, [currentCli, ...stopArgs], { stdio: 'inherit', windowsHide: true }); child.on('close', () => resolve()); });
  const startArgs = args.filter(arg => arg !== '--background');
  await new Promise<number>(resolve => { const child = spawn(process.execPath, [currentCli, '--background', ...startArgs, '--state-dir', state], { stdio: 'inherit', windowsHide: true }); child.on('close', code => resolve(code ?? 1)); }).then(code => { process.exitCode = code; });
  return process.exitCode ?? 0;
}

export async function foundationCli(command: string, args: string[]) {
  try {
    if (command === 'install') return installCommand(args);
    if (command === 'uninstall') return uninstallCommand(args);
    if (command === 'versions') return versionsCommand(args);
    if (command === 'upgrade') return upgradeCommand(args);
    if (command === 'migrate') return migrateCommand(args);
    if (command === 'profile') return profileCommand(args);
    if (command === 'config') return configCommand(args);
    if (command === 'cache') return cacheCommand(args);
    if (command === 'logs') return logsCommand(args);
    if (command === 'host') return hostCommand(args);
    if (command === 'service') return serviceCommand(args);
    if (command === 'paths') { json(await reportFoundationPaths(foundationPaths())); return 0; }
    if (command === 'doctor') {
      const parsed = parseArgs({ args, options: { repair: { type: 'boolean' }, scan: { type: 'boolean' }, json: { type: 'boolean' }, bundle: { type: 'string' } } });
      const result = parsed.values.repair ? await (await import('./foundation.js')).repairFoundation(foundationPaths()) : await doctorFoundation(foundationPaths(), { scan: !!parsed.values.scan });
      const diagnosis = 'report' in result ? result.report : result;
      if (parsed.values.bundle) {
        const redact = (value: unknown, key = ''): unknown => {
          if (/token|secret|password|credential|api.?key|authorization/i.test(key)) return '[redacted]';
          if (Array.isArray(value)) return value.map(item => redact(item));
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redact(item, name)]));
          return value;
        };
        await writeFoundationJson(path.resolve(parsed.values.bundle), { schemaVersion: 1, product: 'Rho', generatedAt: new Date().toISOString(), doctor: redact(result) });
      }
      if (parsed.values.json) json(result);
      else for (const item of diagnosis.checks) process.stdout.write(`${item.state.padEnd(7)} ${item.id} ${item.detail}${item.remedy ? ` Remedy: ${item.remedy}` : ''}\n`);
      return diagnosis.ok ? 0 : 1;
    }
    return fail(`Unknown foundation command ${command}.`);
  } catch (error) { return fail(messageOf(error)); }
}
