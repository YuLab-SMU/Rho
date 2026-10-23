#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PluginId } from './plugins.js';
import { RhoService } from './server.js';
import { runtime } from './runtime.js';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
const { values } = parseArgs({ options: { root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' }, pair: { type: 'string' }, open: { type: 'boolean' } } });
// The one-time code rides in the fragment, which browsers send in no request or Referer; the page redeems and removes it.
const link = (url: string, code: string) => url + '/#pair=' + code;
function openBrowser(target: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => process.stderr.write('Could not open a browser. Open openUrl from the output instead.\n')).unref();
}
if (values.pair) {
  const { RhoClient } = await import('./client.js');
  const client = await RhoClient.fromFile(path.resolve(values.pair));
  const pairing = await client.call('session.browser.pair', values.root ? { path: values.root } : {});
  const openUrl = link(client.connection.url, pairing.code);
  process.stdout.write(JSON.stringify({ url: client.connection.url, openUrl, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }) + '\n');
  if (values.open) openBrowser(openUrl);
  process.exit(0);
}
if (!values.root || !values['state-dir']) {
  process.stderr.write('Usage: rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--port 0] [--limits JSON_FILE] [--plugins documents,files,...] [--open]\nAnother connected browser tab: rho --pair PRIVATE_CONNECTION_FILE [--root PROJECTS_RELATIVE_DIRECTORY] [--open]\n--open opens the printed one-time openUrl in the default browser.\n'); process.exit(2);
}
const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'maxReconciled', 'documents', 'resources', 'workspace', 'r', 'annotations', 'interactions', 'capabilityLimits', 'browser', 'nativeFolders']);
if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
const service = await new RhoService({ ...limits, root: path.resolve(values.root), stateDir: path.resolve(values['state-dir']), ...await runtime(values.core, values.rscript), port: Number(values.port ?? 0), ...(values.plugins !== undefined ? { plugins: values.plugins ? values.plugins.split(',') as PluginId[] : [] } : {}) }).start();
const pairing = await service.browser.createPairing();
// The narrow conclusion a person needs on one line: what was selected, where state
// lives, and how to open it. It stays inside `ready` so a parser reading line one is
// unaffected.
const rscript = values.rscript ?? process.env.RHO_RSCRIPT ?? 'Rscript';
process.stdout.write(JSON.stringify({ ready: {
  url: service.url, connectionFile: path.join(service.state.directory, 'connection.json'), apiVersion: '2.0',
  openUrl: link(service.url, pairing.code), pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt,
  startup: {
    projects: path.resolve(values.root), state: path.resolve(values['state-dir']),
    core: service.bridge.binary, rscript: service.bridge.rscript,
    note: 'Open openUrl to connect this browser tab. Execution stays off until an Agent submits a run; project.doctor answers what is missing.'
  }
} }) + '\n');
if (values.open) openBrowser(link(service.url, pairing.code));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (closing) return; closing = true; const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports }) + '\n'); });
