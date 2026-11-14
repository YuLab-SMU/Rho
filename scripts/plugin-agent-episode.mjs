// Run the one-sentence plugin authoring episode against an owned temporary Rho service.
// The model can be selected with RHO_EXPERIMENT_MODEL. The default targets the Magpie
// DeepSeek route requested by the plugin-authoring episode.
//
//   npm run build && RHO_EXPERIMENT_MODEL=magpie-server/deepseek-v4.1-flash node scripts/plugin-agent-episode.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Extensions } from '../dist/extensions.js';
import { RhoClient } from '../dist/client.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = process.env.RHO_EXPERIMENT_MODEL ?? 'magpie-server/deepseek-v4.1-flash';
const evidence = path.resolve(process.env.RHO_PLUGIN_AGENT_EVIDENCE ?? 'work/plugin-agent');
const prompt = '请在当前 Rho 项目里创建一个实时任务面板插件，让我能随时打开它查看任务、Agent 工作状态和最近的进展，并把它接入工作区；请自行完成开发、验证和接入。';
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-plugin-agent-'));
const home = path.join(base, 'home'), projects = path.join(base, 'projects'), state = path.join(base, 'state'), bin = path.join(base, 'bin');
await fs.mkdir(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
await fs.mkdir(projects, { recursive: true });
await fs.mkdir(state, { recursive: true });
await fs.mkdir(bin, { recursive: true });
const sourceSettings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
const settings = { ...sourceSettings, model, permissions: { ...(sourceSettings.permissions ?? {}), defaultMode: 'acceptEdits' } };
await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
await fs.mkdir(path.join(home, 'Rho'), { recursive: true });
await fs.symlink(state, path.join(home, 'Rho', 'state'));
await fs.writeFile(path.join(bin, 'rho'), `#!/bin/sh\nexec ${process.execPath} ${path.join(repo, 'dist/cli.js')} "$@"\n`, { mode: 0o700 });

const env = {
  ...process.env,
  ...(sourceSettings.env ?? {}),
  HOME: home,
  PATH: [bin, path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', path.dirname(process.execPath)].join(':'),
  ANTHROPIC_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_DEFAULT_FABLE_MODEL: model,
  RHO_AGENT_BACKEND: 'claude-cli',
  RHO_RSCRIPT: '/missing/Rscript'
};

await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(evidence, 'prompt.txt'), prompt + '\n');
const serviceLog = path.join(evidence, 'service.log');
const service = spawn(process.execPath, [path.join(repo, 'dist/cli.js'), '--root', projects, '--state-dir', state, '--example', 'off', '--port', '0', '--agent-backend', 'claude-cli', '--rscript', '/missing/Rscript'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serviceOutput = await fs.open(serviceLog, 'w');
let readyLine = '';
service.stdout.on('data', bytes => { const text = bytes.toString(); if (!readyLine) readyLine += text; serviceOutput.write(bytes); });
service.stderr.on('data', bytes => serviceOutput.write(bytes));
try {
  for (let i = 0; i < 300 && !readyLine.includes('\n'); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!readyLine.includes('\n')) throw new Error('Rho did not start.');
  const ready = JSON.parse(readyLine.split('\n')[0]).ready;
  const operator = await RhoClient.fromFile(ready.connectionFile);
  const project = await operator.call('project.create', { name: 'task-panel-project' });
  const claudeLog = path.join(evidence, 'claude-stream.jsonl');
  const claudeError = path.join(evidence, 'claude-stderr.txt');
  const output = await fs.open(claudeLog, 'w'), errors = await fs.open(claudeError, 'w');
  const claude = spawn(path.join(os.homedir(), '.local', 'bin', 'claude'), [
    '--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--add-dir', project.root,
    '--allowedTools', 'Bash(rho --help)', 'Bash(rho plugin --help)', 'Bash(rho plugin create *)',
    'Bash(rho plugin check *)', 'Bash(rho plugin dev *)', 'Bash(rho plugin list)',
    'Read', 'Write', 'Edit', 'Glob', 'Grep', '--max-turns', '40', prompt
  ], { cwd: project.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  claude.stdout.on('data', bytes => output.write(bytes));
  claude.stderr.on('data', bytes => errors.write(bytes));
  const exitCode = await new Promise(resolve => claude.once('close', resolve));
  await output.close();
  await errors.close();

  const pluginRoots = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.rho' || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === 'rho-plugin.json') pluginRoots.push(dir);
    }
  }
  await walk(project.root);
  const plugins = [];
  for (const root of pluginRoots) {
    const manager = new Extensions('');
    try {
      const checked = await manager.check(root);
      plugins.push({ root, valid: true, runtime: await manager.checkRuntime(root, checked) });
    } catch (error) {
      plugins.push({ root, valid: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ model, prompt, base, projectRoot: project.root, serviceUrl: ready.url, exitCode, plugins }, null, 2) + '\n');
  console.log(JSON.stringify({ model, exitCode, plugins, evidence }, null, 2));
} finally {
  service.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (service.exitCode === null) service.kill('SIGKILL');
  await serviceOutput.close();
}
