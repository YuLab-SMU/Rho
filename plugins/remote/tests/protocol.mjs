// Run with an independently built backend. This creates no real SSH connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRemoteFixture} from './ssh-slurm.mjs';
const binary = path.resolve(process.argv[2]);
assert.ok(fs.existsSync(binary));
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-remote-wire-')));
let passed = false;
try {
  const fixture = createRemoteFixture(directory);
  const target = {host_alias:'fixture',project_root:fs.realpathSync(fixture.remote),slurm_cluster:'fixture_cluster'};
  const result = spawnSync('python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'protocol.py'), binary, fixture.project, JSON.stringify(target)],
    {env:{...fixture.env,RHO_TEST_DROP_SUBMIT:'1',RHO_TEST_NODE:process.execPath},stdio:'inherit'});
  assert.equal(result.status, 0, result.error?.message ?? result.signal);
  passed = true;
} finally {
  if (passed) fs.rmSync(directory,{recursive:true,force:true});
  else console.error(`Remote framed-RPC evidence retained at ${directory}`);
}
