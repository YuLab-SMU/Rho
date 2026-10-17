#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PluginId } from './plugins.js';
import { RhoService } from './server.js';
import { runtime } from './runtime.js';
import * as fs from 'node:fs/promises';
const { values } = parseArgs({ options: { root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' }, pair: { type: 'string' } } });
if (values.pair) {
  const { RhoClient } = await import('./client.js');
  const client = await RhoClient.fromFile(path.resolve(values.pair));
  const pairing = await client.call('session.browser.pair', values.root ? { path: values.root } : {});
  process.stdout.write(JSON.stringify({ url: client.connection.url, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt }) + '\n'); process.exit(0);
}
if (!values.root || !values['state-dir']) {
  process.stderr.write('Usage: rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--port 0] [--limits JSON_FILE] [--plugins documents,files,...]\nNew browser pairing: rho --pair PRIVATE_CONNECTION_FILE [--root PROJECTS_RELATIVE_DIRECTORY]\n'); process.exit(2);
}
const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'documents', 'resources', 'workspace', 'r', 'annotations', 'interactions', 'capabilityLimits', 'browser']);
if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
const service = await new RhoService({ ...limits, root: path.resolve(values.root), stateDir: path.resolve(values['state-dir']), ...await runtime(values.core, values.rscript), port: Number(values.port ?? 0), ...(values.plugins !== undefined ? { plugins: values.plugins ? values.plugins.split(',') as PluginId[] : [] } : {}) }).start();
const pairing = await service.browser.createPairing();
process.stdout.write(JSON.stringify({ ready: { url: service.url, connectionFile: path.join(service.state.directory, 'connection.json'), apiVersion: '2.0', pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt } }) + '\n');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (closing) return; closing = true; const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports }) + '\n'); });
