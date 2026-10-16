#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PluginId } from './plugins.js';
import { RhoService } from './server.js';
import { runtime } from './runtime.js';
import * as fs from 'node:fs/promises';
const { values } = parseArgs({ options: { root: { type: 'string' }, 'state-dir': { type: 'string' }, core: { type: 'string' }, rscript: { type: 'string' }, port: { type: 'string' }, limits: { type: 'string' }, plugins: { type: 'string' } } });
if (!values.root || !values['state-dir']) {
  process.stderr.write('Usage: rho --root PROJECTS_DIRECTORY --state-dir SERVICE_STATE [--core ABSOLUTE_CORE_BINARY] [--rscript ABSOLUTE_RSCRIPT] [--port 0] [--limits JSON_FILE] [--plugins documents,files,...]\n'); process.exit(2);
}
const limits = values.limits ? JSON.parse(await fs.readFile(values.limits, 'utf8')) : {};
const allowed = new Set(['maxRequestBytes', 'maxEventBytes', 'eventRetention', 'maxSubscriptions', 'maxQueue', 'maxContexts', 'maxBindings', 'maxActivities', 'maxContextBytes', 'maxRetainedMetadataBytes', 'maxConcurrentActions', 'maxOperations', 'maxLogPageBytes', 'maxCodeBytes', 'documents', 'resources', 'workspace']);
if (Object.keys(limits).some(k => !allowed.has(k))) throw new Error('Unknown service budget in --limits file.');
const service = await new RhoService({ ...limits, root: path.resolve(values.root), stateDir: path.resolve(values['state-dir']), ...await runtime(values.core, values.rscript), port: Number(values.port ?? 0), ...(values.plugins !== undefined ? { plugins: values.plugins ? values.plugins.split(',') as PluginId[] : [] } : {}) }).start();
process.stdout.write(JSON.stringify({ ready: { url: service.url, connectionFile: path.join(service.state.directory, 'connection.json'), apiVersion: '2.0' } }) + '\n');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { if (closing) return; closing = true; const reports = await service.close(); process.stdout.write(JSON.stringify({ shutdown: reports }) + '\n'); });
