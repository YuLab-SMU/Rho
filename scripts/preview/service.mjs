import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {PreviewHost, prepareWorkspace, saveJson} from './workspace.mjs';
import {installBundle} from './bundle/rho-bundle.mjs';

const resources = path.dirname(fileURLToPath(import.meta.url));
const requestedState = path.resolve(process.env.RHO_PREVIEW_STATE || path.join(os.homedir(), 'Library/Application Support/Rho/Preview'));
fs.mkdirSync(requestedState, {recursive: true, mode: 0o700});
// macOS can resolve an existing parent with a different case or through a link.
// The Host authorizes the canonical root, so use that same identity everywhere.
const state = fs.realpathSync.native(requestedState);
const liveFile = path.join(state, 'live.json'), lock = path.join(state, 'launcher.lock');
const profile = JSON.parse(fs.readFileSync(path.join(resources, 'preview-profile.json')));
const project = path.join(state, 'Demo'), database = path.join(state, 'rho.sqlite');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const status = message => emit({type: 'status', message});
let host = null, child = null, childExit = null, owned = false, busy = false, stopping = false;
const alive = pid => {try {process.kill(pid, 0); return true;} catch {return false;}};
async function existing(requireReady = false) {
  if (!fs.existsSync(liveFile)) return null;
  const live = JSON.parse(fs.readFileSync(liveFile));
  if (requireReady && !live.ready) return null;
  if (live.project !== project || !/^http:\/\/127\.0\.0\.1:\d+\//.test(live.url)) throw Error('The saved preview connection has a different project or address.');
  const prior = new PreviewHost(live.url, project, path.join(state, 'workspace.json'));
  try {const info = await prior.http('/api/info'); return info.project_root === project ? prior : null;} catch {return null;}
}
function releaseLock() {
  if (owned) {fs.rmSync(lock, {recursive: true}); owned = false;}
}
async function acquire() {
  try {fs.mkdirSync(lock); owned = true; saveJson(path.join(lock, 'owner.json'), {pid: process.pid});}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await existing(true);
    if (prior) {emit({type: 'ready', url: prior.browserUrl(), project, state, reused: true}); return false;}
    const ownerPath = path.join(lock, 'owner.json');
    const owner = fs.existsSync(ownerPath) ? JSON.parse(fs.readFileSync(ownerPath)) : null;
    if (!owner || alive(owner.pid)) throw Error('Rho is already preparing this preview. Return to its launch window.');
    fs.renameSync(lock, `${lock}.stale-${Date.now()}`);
    return acquire();
  }
  const prior = await existing();
  if (prior) {
    const live = JSON.parse(fs.readFileSync(liveFile));
    if (live.ready) {releaseLock(); emit({type: 'ready', url: prior.browserUrl(), project, state, reused: true}); return false;}
    // The prior launcher ended during composition. Keep the authenticated Host
    // and recover the same journal instead of spawning a competing project owner.
    host = prior;
  }
  return true;
}
async function start() {
  if (busy || stopping) return;
  busy = true;
  try {
    const runtimeFile = path.join(state, 'runtime.json');
    if (!fs.existsSync(runtimeFile)) saveJson(runtimeFile, profile.runtime);
    const runtime = JSON.parse(fs.readFileSync(runtimeFile));
    for (const file of [runtime.ark, path.join(runtime.r_home, 'bin/R')]) fs.accessSync(file, fs.constants.X_OK);
    if (!child && !host) {
      status('Checking your local R environment…');
      execFileSync(path.join(runtime.r_home, 'bin/Rscript'), ['--vanilla', '-e',
        'stopifnot(requireNamespace("jsonlite", quietly=TRUE), requireNamespace("rlang", quietly=TRUE))'],
      {encoding: 'utf8', timeout: 15000, env: {...process.env, R_HOME: runtime.r_home}});
      const installed = path.join(state, 'installed.json');
      if (!fs.existsSync(installed)) {
        status('Preparing the included tools for first use…');
        const result = installBundle({directory: path.join(resources, 'bundle'), database});
        saveJson(installed, {digest: result.digest, imported: result.imported.map(item => item.revision)});
      }
      status('Starting Rho…');
      const urlFile = path.join(state, 'private-launch-url'); fs.rmSync(urlFile, {force: true});
      const log = fs.openSync(path.join(state, 'host.log'), 'a', 0o600);
      child = spawn(path.join(resources, 'bundle/rho'), ['--database', database, '--demo-project', 'workbench', '--url-file', urlFile],
        {cwd: state, env: {...process.env, RHO_DEMO_PROJECT: project}, stdio: ['ignore', log, log]});
      fs.closeSync(log);
      childExit = new Promise(resolve => {child.once('exit', resolve); child.once('error', resolve);});
      child.once('error', error => {child = null; emit({type: 'error', message: error.message, state});});
      child.once('exit', (code, signal) => {
        fs.rmSync(liveFile, {force: true});
        if (!stopping) {child = null; host = null; emit({type: 'error', message: `Rho stopped (${code ?? signal}). Open logs for details, or retry.`, state});}
      });
      const deadline = Date.now() + 60000;
      while (!fs.existsSync(urlFile)) {
        if (!child || child.exitCode !== null || child.signalCode !== null) throw Error('Rho could not start. Open logs for the reason.');
        if (Date.now() > deadline) throw Error('Rho startup is still unconfirmed. Its process and log are retained; do not start another preview.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      host = new PreviewHost(fs.readFileSync(urlFile, 'utf8').trim(), project, path.join(state, 'workspace.json'));
      saveJson(liveFile, {url: host.browserUrl(), project, pid: child.pid, service: process.pid, ready: false});
    }
    if (!host) throw Error('Startup is unconfirmed. Inspect the retained Host log before retrying.');
    const url = await prepareWorkspace(host, resources, {...profile, runtime}, status);
    saveJson(liveFile, {url, project, pid: child?.pid ?? JSON.parse(fs.readFileSync(liveFile)).pid, service: process.pid, ready: true});
    emit({type: 'ready', url, project, state, reused: false});
  } catch (error) {
    fs.appendFileSync(path.join(state, 'launcher.log'), `${new Date().toISOString()} ${error.stack}\n`, {mode: 0o600});
    emit({type: 'error', message: error.message, state});
  } finally {busy = false;}
}
async function stop() {
  if (busy) {emit({type: 'blocked', message: 'Workspace preparation is still in progress. Wait for it to finish before quitting.'}); return;}
  try {
    if (child && !host) throw Error('Rho startup is unconfirmed. Open its retained log before stopping the launcher.');
    if (host) {
      status('Finishing accepted work and closing Rho…');
      stopping = true;
      await host.http('/api/quit', {project_root: project});
      if (childExit) await childExit;
    }
    releaseLock(); emit({type: 'stopped'}); process.exit(0);
  } catch (error) {stopping = false; emit({type: 'blocked', message: error.message});}
}

if (process.argv.includes('--stop')) {
  try {
    host = await existing();
    if (host) await host.http('/api/quit', {project_root: project});
    emit({type: 'stopped'});
  } catch (error) {emit({type: 'blocked', message: error.message}); process.exitCode = 1;}
} else {
  try {
    if (await acquire()) {
      const input = readline.createInterface({input: process.stdin});
      input.on('line', line => {if (line === 'quit') void stop(); else if (line === 'retry') void start();});
      process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
      await start();
    }
  } catch (error) {releaseLock(); emit({type: 'error', message: error.message, state}); process.exitCode = 1;}
}
