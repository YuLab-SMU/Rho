// Preview delivery orchestration. Scientific composition remains the delivered
// Manager recipe; file navigation remains the delivered Files owner.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MessageChannel} from 'node:worker_threads';
import assert from 'node:assert/strict';

export const saveJson = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const terminal = record => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(record.status);
export const viewIds = node => node.kind === 'tabs' ? node.views : node.kind === 'split' ? node.children.flatMap(viewIds) : [];

export class PreviewHost {
  constructor(url, project, receiptFile) {
    this.url = new URL(url); this.project = project; this.receiptFile = receiptFile;
    const present = fs.existsSync(receiptFile);
    this.receipt = present ? JSON.parse(fs.readFileSync(receiptFile))
      : {format: 1, project, window: `preview-${crypto.randomUUID()}`, steps: {}};
    assert.equal(this.receipt.format, 1); assert.equal(this.receipt.project, project);
    this.window = this.receipt.window; if (!present) this.save();
  }
  save() { saveJson(this.receiptFile, this.receipt); }
  async http(endpoint, body) {
    const response = await fetch(new URL(endpoint, this.url), {method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${new URLSearchParams(this.url.hash.slice(1)).get('token')}`,
        'Content-Type': 'application/json', 'X-Rho-Studio-Window': this.window},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60000)});
    const reply = await response.json();
    if (!response.ok) throw Error(reply.error || `Rho returned HTTP ${response.status}`);
    return reply;
  }
  async port(method, params) {
    const reply = await this.http('/api/host', {project_root: this.project,
      frame: {id: crypto.randomUUID(), request: {method, params}}});
    if (!reply.ok) throw Error(reply.error || 'The original Host request is unconfirmed.');
    return reply.result;
  }
  async query(id, args = {}) {
    const snapshot = await this.port('query_snapshot', {capability: {id, version: 1}, arguments: args});
    if (snapshot.status !== 'ready' || snapshot.data == null) throw Error(snapshot.notices?.join('\n') || `${id} is unavailable.`);
    return snapshot.data;
  }
  async once(key, id, args) {
    let step = this.receipt.steps[key];
    if (!step) {
      step = {request: {client_request_id: crypto.randomUUID(), capability: {id, version: 1}, arguments: args, preconditions: []}};
      this.receipt.steps[key] = step; this.save();
    }
    assert.equal(step.request.capability.id, id);
    // Retain original preconditions/arguments after a lost acknowledgement.
    let record = step.operation ? await this.port('get_operation', {operation_id: step.operation}) : null;
    if (!record) record = await this.port('invoke', step.request);
    const check = value => {
      assert.equal(value.operation.client_request_id, step.request.client_request_id);
      assert.equal(canonical(value.operation.capability), canonical(step.request.capability));
      assert.equal(canonical(value.operation.normalized_arguments), canonical(step.request.arguments));
      assert.equal(canonical(value.operation.preconditions), '[]');
      if (step.operation) assert.equal(value.operation.operation_id, step.operation);
      return value;
    };
    check(record); step.operation = record.operation.operation_id; this.save();
    const deadline = Date.now() + 60000;
    while (!terminal(record) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      record = check(await this.port('get_operation', {operation_id: step.operation}));
    }
    if (record.status !== 'succeeded' || record.outcome !== 'succeeded')
      throw Error(record.error || `Original request is ${record.status}; its identity has been retained.`);
    return record.output;
  }
  async resume(instance) {
    const observed = await this.query('plugins.instance', {instance});
    if (observed.observed_in_this_host && observed.instance.state === 'active') return;
    if (observed.instance.state !== 'suspended' || !observed.instance.suspension)
      throw Error(`The original ${instance.plugin} instance needs recovery (${observed.instance.state}).`);
    await this.once(`resume:${instance.instance}:${observed.instance.suspension}`, 'plugins.resume',
      {instance, suspension: observed.instance.suspension});
  }
  async reconnect(view) {
    const record = await this.query('views.inspect', {view});
    if (record.closed) return;
    const presence = await this.query('views.presence', {view});
    if (presence.state === 'attached') return;
    if (presence.state !== 'detached') throw Error('A saved view is still closing; inspect its original request.');
    await this.once(`reconnect:${this.url.origin}:${view}:${record.state_version}`, 'views.reconnect', {view, expected_version: record.state_version});
  }
  browserUrl() {
    const url = new URL(this.url); url.searchParams.set('window', this.window); return url.href;
  }
}

/** The same public SDK and framing as a contributed document. It is used only
 * before opening the browser, then disposed so the browser gets the next sequence. */
async function connectView(host, view, sdk) {
  const connection = await host.query('views.connection', {view});
  const {port1, port2} = new MessageChannel();
  let sequence = connection.next_sequence - 1, replies = 0;
  port2.on('message', async message => {
    try {
      const reply = await host.http('/api/plugin-view', {project_root: host.project,
        call_token: connection.call_token, message: {...message, sequence: ++sequence}});
      port2.postMessage({protocol_version: 1, connection: connection.connection, view, sequence: ++replies,
        request: message.request, ok: reply.ok, result: reply.result, error: reply.error, diagnostic: reply.diagnostic});
    } catch (error) {
      port2.postMessage({protocol_version: 1, connection: connection.connection, view, sequence: ++replies,
        request: message.request, ok: false, error: error.message});
    }
  });
  const client = new sdk.PluginViewClient(port1, {protocol_version: 1, connection: connection.connection, view: connection.view});
  return {client, close() { client.dispose(); port2.close(); }};
}

export async function prepareWorkspace(host, resources, profile, status) {
  const imported = relative => import(pathToFileURL(path.join(resources, relative)).href);
  const sdk = await imported('manager/dist/public/plugin-ui/index.js');
  const {Manager, initial} = await imported('manager/dist/src/model.js');
  const {scientificWorkspace, workspacePlugins} = await imported('manager/dist/src/scientific-workspace.js');
  const index = JSON.parse(fs.readFileSync(path.join(resources, 'bundle/plugin-set.json')));
  const managerPackage = index.packages.find(item => item.plugin === 'org.rho.manager');
  const receipt = host.receipt;
  if (!receipt.manager) {
    status('Preparing your scientific workspace…');
    const identity = (await host.once('manager', 'plugins.activate', {revision: managerPackage.revision,
      artifact: managerPackage.artifacts[0].id, target: 'ui-web', alias: 'preview-manager', configuration: {}})).instance.identity;
    await host.resume(identity);
    const layout = await host.query('windows.layout', {window: host.window});
    const opened = await host.once('manager-view', 'windows.open_view', {expected_layout_version: layout.version, group: null,
      view: {instance: identity, window: host.window, contribution: 'manager', configuration: {}, state: {}}});
    receipt.manager = opened.view.view; host.save();
  }
  let managerRecord = await host.query('views.inspect', {view: receipt.manager});
  // A user's closed management tab is not reopened on routine starts.
  if (!receipt.prepared) {
    await host.resume(managerRecord.instance); await host.reconnect(receipt.manager);
    const bridge = await connectView(host, receipt.manager, sdk);
    try {
      const manager = new Manager(bridge.client, {...initial(), ...bridge.client.view.state});
      if (manager.state.pending) await manager.recover();
      for (const instance of Object.values(manager.state.workspace?.instances ?? manager.state.preparation?.request.instances ?? {})) await host.resume(instance);
      for (const view of Object.values(manager.state.preparation?.request.views ?? {})) await host.reconnect(view);
      if (!manager.state.workspace && !manager.state.preparation) {
        const choices = {};
        for (const key of workspacePlugins) {
          const entry = index.packages.find(item => item.plugin === `org.rho.${key}`);
          choices[key] = {inspection: await host.query('plugins.inspect', {revision: entry.revision}), artifact: entry.artifacts[0].id};
        }
        const layout = await host.query('windows.layout', {window: host.window});
        await manager.startWorkspace(scientificWorkspace(choices, 'aarch64-apple-darwin', profile.runtime,
          layout.version, 'rho-preview-demo', 'Rho Demo'));
      }
      if (manager.state.workspace) await manager.prepareWorkspace();
      const prep = manager.state.preparation;
      assert.ok(prep, 'Retain the original workspace preparation for recovery.');
      const applied = await host.query('windows.scenario', {window: host.window});
      if (applied.scenario?.revision !== prep.request.revision) await manager.apply();
      receipt.prepared = true; host.save();
    } finally { bridge.close(); }
  }
  status('Restoring your saved workspace…');
  const scene = await host.query('windows.scenario', {window: host.window});
  assert.ok(scene.scenario, 'This window has no saved scientific scenario.');
  const records = await Promise.all(viewIds(scene.layout.layout).map(view => host.query('views.inspect', {view})));
  const instances = new Map(Object.values(scene.scenario.instances).map(instance => [instance.instance, instance]));
  for (const record of records) instances.set(record.instance.instance, record.instance);
  for (const instance of instances.values()) await host.resume(instance);
  for (const record of records) await host.reconnect(record.view);

  if (!receipt.demoOpened) {
    const exists = records.find(record => record.contribution === 'editor' && record.configuration.file?.path === 'run_demo.R');
    if (!exists) {
      status('Opening the demo script…');
      const files = await imported('files/dist/src/connection.js');
      const {FilesActions} = await imported('files/dist/src/actions.js');
      const bridge = await connectView(host, scene.scenario.views.files, sdk);
      const owner = new files.FilesConnection(bridge.client);
      try {
        await owner.refresh(); await owner.pause();
        const config = bridge.client.view.configuration;
        const actions = new FilesActions(bridge.client, owner, config.editor_group, config.editor, config.runtime);
        if (actions.getSnapshot().pending) await actions.retry();
        else await actions.openDocument('run_demo.R');
        await owner.flush();
      } finally { owner.stop(); bridge.close(); }
    }
    receipt.demoOpened = true; host.save();
  }
  return host.browserUrl();
}
