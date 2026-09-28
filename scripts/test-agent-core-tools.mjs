// Freeze the generic Host first, then accept an independent Agent package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareAgentAcceptance} from './build-agent-plugin.mjs';
import {agentAcceptanceOptions, verifyAgentBuild} from './agent-plugin-artifact.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = agentAcceptanceOptions(process.argv.slice(2));
if (!options.build) verifyAgentBuild(options.packagePath);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-core-')));
const env = {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2', RHO_AGENT_NATIVE_CORE_FIXTURE:'1'};
const nativeBin = path.join(directory, 'native-bin');
fs.mkdirSync(nativeBin);
fs.writeFileSync(path.join(nativeBin, 'rho-science-fixture'), 'disposable');
for (const [source, target] of [['agent-science.cjs','kimi'],['agent-core-tools.cjs','agent-core-tools.cjs']])
  fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures', source), path.join(nativeBin,target));
fs.chmodSync(path.join(nativeBin, 'kimi'), 0o700);
env.PATH = `${nativeBin}${path.delimiter}${env.PATH}`;
env.KIMI_CODE_HOME = path.join(directory, 'native-home');
fs.mkdirSync(env.KIMI_CODE_HOME);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const targets = ['agent_plugin', 'agent_plugin_core'];
  const output = execFileSync('cargo', ['test','-p','rho-host',...targets.flatMap(name=>['--test',name]),'--locked','--offline','--no-run','--message-format=json'], {cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:16*1024*1024});
  const artifacts = output.trim().split('\n').map(line=>JSON.parse(line));
  const harnesses = targets.map(name=>{
    const executable = artifacts.find(item=>item.reason==='compiler-artifact' && item.target.name===name && item.executable)?.executable;
    assert.ok(executable, `Cargo must identify ${name}`);
    return {executable,original:digest(executable),name};
  });
  const agent = prepareAgentAcceptance(options);
  assert.ok(!agent.startsWith(root+path.sep), 'Use an independently assembled Agent package');
  for (const {name,executable,original} of harnesses) {
    assert.equal(digest(executable),original);
    execFileSync(executable,['--ignored','--nocapture'],{cwd:root,env:{...env,RHO_AGENT_PLUGIN_PACKAGE:agent},stdio:'inherit'});
    assert.equal(digest(executable),original);
    console.log(`${name} passed with an independent Agent package. Frozen harness SHA256 ${original}`);
  }
} finally { fs.rmSync(directory,{recursive:true,force:true}); }
