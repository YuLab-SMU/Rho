import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {agentPluginBuildEnvironment, buildAgentPlugin} from './build-agent-plugin.mjs';
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-backend-')));
try {
  const source = buildAgentPlugin(path.join(directory, 'package'));
  assert.ok(fs.existsSync(path.join(source, 'dist/rho-agent-backend')));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'));
  assert.ok(manifest.source.files.includes('backend/src/server.rs'));
  assert.ok(manifest.source.files.includes('public/plugin-sdk/src/host_calls.rs'));
  const env = agentPluginBuildEnvironment();
  execFileSync(env.RHO_PLUGIN_CARGO, ['test', '-p', 'rho-agent-backend', '--test', 'metadata', '--locked', '--offline'], {
    cwd: source, env, stdio: 'inherit',
  });
  console.log('Independent Agent backend built with public dependencies and passed its framed metadata, Control and synthetic model diagnostic fixtures.');
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
