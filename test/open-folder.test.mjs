import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RhoClient } from '../dist/client.js';
import { BrowserClient } from '../dist/browser.js';

// "Start this project with Rho": one command makes the folder a project where it is, for the person
// at this machine only, and opens its page; an Agent then calls Rho's tools from its shell.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('rho open starts Rho, opens a folder outside its projects folder for the person alone, and rho tool calls the Agent tools', { timeout: 180000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'rho-open-')));
  const env = { ...process.env, RHO_RUNNING_DIR: path.join(root, 'running') };
  const rho = (args, options = {}) => new Promise(resolve => {
    const child = execFile(process.execPath, [cli, ...args], { timeout: 90000, windowsHide: true, env, ...options }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
  const state = path.join(root, 'state'), projects = path.join(root, 'projects'), folder = path.join(root, 'elsewhere', '气道 study');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'notes.md'), '# Notes\n');
  const where = ['--state-dir', state, '--root', projects, '--example', 'off', '--port', '0', '--no-browser', '--json'];
  try {
    assert.deepEqual((await rho(['open', path.join(root, 'absent'), ...where])), { code: 1, stdout: '', stderr: `There is no folder ${path.join(root, 'absent')}.\n` });
    const first = await rho(['open', folder, ...where]);
    assert.equal(first.code, 0, first.stderr);
    const { open } = JSON.parse(first.stdout);
    assert.deepEqual([open.folder, open.state, open.started, open.browser.opened], [folder, state, true, false]);
    assert.match(open.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/#project=${open.projectId}$`));
    // The folder stays where it is and is the person's: their tab lists it, kept across a restart.
    assert.deepEqual(await fs.readdir(folder), ['.rho', 'notes.md']);
    // Where an Agent looks first, a note sends it to Rho's commands instead of the state files.
    assert.match(await fs.readFile(path.join(folder, '.rho', 'README.md'), 'utf8'), /rho tool index --as NAME/);
    const person = async () => JSON.parse(await fs.readFile(path.join(state, 'principals.json'), 'utf8')).find(p => p.id === 'browser:local');
    assert.deepEqual((await person()).selectedProjects, [open.projectId]);
    const again = await rho(['open', ...where], { cwd: path.join(folder) });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual([JSON.parse(again.stdout).open.projectId, JSON.parse(again.stdout).open.started], [open.projectId, false]);
    // Text for the Agent to pass on.
    const text = await rho(['open', folder, '--state-dir', state, '--no-browser']);
    assert.match(text.stdout, /Rho is a workspace in their web browser/);
    assert.ok(text.stdout.includes(open.url));

    // A full path is the person's own credential's to name; a tab or an Agent names folders inside its root.
    const operator = await RhoClient.fromFile(path.join(state, 'connection.json'));
    const tab = new BrowserClient({ url: operator.connection.url });
    assert.ok((await tab.call('project.list', {})).some(p => p.id === open.projectId), 'the person\'s tab lists the folder');
    await assert.rejects(tab.call('project.open', { path: path.join(root, 'elsewhere') }), e => e.error?.kind === 'scope');

    // rho tool: the four tools from a shell, under the session's own grant.
    const tool = (args, input) => rho(['tool', ...args, '--as', 'shell-agent', '--project', folder, '--state-dir', state], { input });
    const index = await tool(['index']);
    assert.equal(index.code, 0, index.stderr);
    const listed = JSON.parse(index.stdout);
    assert.equal(listed.ok, true); assert.equal(listed.value.scopeHint.projectId, open.projectId);
    const resolved = JSON.parse((await tool(['resolve', JSON.stringify({ catalogRef: listed.value.catalogRef, selected: ['project.entries'] })])).stdout);
    const contract = resolved.value.items.find(item => item.kind === 'contract' && item.content.method === 'project.entries');
    const read = await tool(['call', '-'], JSON.stringify({ operation: 'project.entries', contractRef: contract.ref, input: {} }));
    assert.equal(read.code, 0, read.stdout + read.stderr);
    assert.ok(JSON.stringify(JSON.parse(read.stdout).value).includes('notes.md'));
    const schemas = JSON.parse((await tool(['list'])).stdout);
    assert.deepEqual(schemas.tools.map(t => t.tool), ['index', 'resolve', 'call', 'read']);
    const wrong = await tool(['resolve', '{"operation":"project.entries"}']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /rho tool list --as shell-agent shows it/);
    assert.equal((await tool(['nothing'])).code, 2);
    // The same name keeps the same grant: one Agent connection, however often it is called.
    assert.equal((await fs.readdir(state)).filter(f => /^agent-.*\.json$/.test(f)).length, 1);

    // After a restart the person's tab still has the folder.
    assert.equal((await rho(['--stop', '--state-dir', state])).code, 0);
    const restarted = await rho(['open', folder, ...where]);
    assert.equal(JSON.parse(restarted.stdout).open.projectId, open.projectId);
    assert.deepEqual((await person()).selectedProjects, [open.projectId]);
  } finally {
    await rho(['--stop', '--state-dir', state]);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
