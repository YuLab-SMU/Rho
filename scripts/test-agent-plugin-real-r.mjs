// Frozen generic Host harness, independent ordinary Agent and R source packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildAgentPlugin} from './build-agent-plugin.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME, 'Set RHO_ARK and RHO_R_HOME for disposable R acceptance');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-science-')));
const env = {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2'};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const tests = ['agent_plugin', 'agent_plugin_real_r'];
  const output = execFileSync('cargo', ['test', '-p', 'rho-host', ...tests.flatMap(name => ['--test', name]), '--locked', '--offline', '--no-run', '--message-format=json'], {cwd:root, env, encoding:'utf8', stdio:['ignore','pipe','inherit'], maxBuffer:16*1024*1024});
  const artifacts = output.trim().split('\n').map(line=>JSON.parse(line));
  const harnesses = tests.map(name => {
    const executable = artifacts.find(item=>item.reason==='compiler-artifact' && item.target.name===name && item.executable)?.executable;
    assert.ok(executable, `Cargo did not identify ${name}`);
    return {name, executable, original: digest(executable)};
  });
  const agent = process.env.RHO_AGENT_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_AGENT_PLUGIN_PACKAGE) : buildAgentPlugin(path.join(directory,'agent'));
  const r = process.env.RHO_R_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_R_PLUGIN_PACKAGE) : path.join(directory,'r');
  if (!process.env.RHO_R_PLUGIN_PACKAGE) execFileSync(process.execPath,[path.join(root,'scripts/build-r-plugin.mjs'),r],{cwd:root,env,stdio:'inherit'});
  for (const {name, executable, original} of harnesses) {
    assert.equal(digest(executable),original);
    execFileSync(executable,['--ignored','--nocapture'],{cwd:root,env:{...env,RHO_AGENT_PLUGIN_PACKAGE:agent,RHO_R_PLUGIN_PACKAGE:r},stdio:'inherit'});
    assert.equal(digest(executable),original);
    console.log(`${name} passed against independent Agent/R packages. Host harness SHA256 ${original}`);
  }
} finally { fs.rmSync(directory,{recursive:true,force:true}); }
