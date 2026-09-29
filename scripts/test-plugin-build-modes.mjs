// Exercise the actual assembly entry points, stopping at the native-build boundary.
// No compiler or independent package builder runs in this check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-build-modes-')));
const preload = path.join(directory, 'observe.cjs');
fs.writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path');
require('node:child_process').execFileSync = (file, args, options) => {
  if (file === 'rustup' && args[0] === 'which') return process.execPath;
  if (args[0] === '-vV') return 'host: fixture-platform\\n';
  if (args[0] === 'metadata') {
    const packages = JSON.parse(process.env.RHO_TEST_PACKAGES).map(name => ({
      id: name, name, manifest_path: path.join(options.cwd, name, 'Cargo.toml'), dependencies: [],
    }));
    return JSON.stringify({workspace_members: packages.map(p => p.id), packages});
  }
  const kind = args[0] === 'build' ? 'workspace' : args[0] === path.join(options.cwd, 'build.mjs') ? 'independent' : null;
  if (!kind) throw Error('Unexpected subprocess: ' + JSON.stringify([file, args]));
  fs.writeFileSync(process.env.RHO_TEST_MARKER, JSON.stringify({kind, args, cwd: options.cwd}));
  throw Error('Observed build dispatch; no native tool ran');
};
require('node:module').syncBuiltinESMExports();
`);
const packages = {
  agent: ['rho-agent-api','rho-agent-backend','rho-agent-client','rho-agent-engine','rho-agent-native','rho-agent-owner','rho-agent-store','rho-plugin-protocol','rho-plugin-sdk','rho-r-api'],
  r: ['rho-environment-api','rho-plugin-protocol','rho-plugin-sdk','rho-process-api','rho-r-api','rho-r-backend','rho-r-engine'],
  files: ['rho-files-api','rho-files-backend','rho-files-engine','rho-files-owner','rho-plugin-protocol','rho-plugin-sdk','rho-process-engine'],
};
try {
  for (const [plugin, names] of Object.entries(packages)) {
    const script = path.join(root, `scripts/build-${plugin}-plugin.mjs`);
    const cases = [[], ['--workspace'], ['--independent'], ['--workspace','--independent'], ['--independent','--independent'], ['--typo']];
    for (const [index, flags] of cases.entries()) {
      const output = path.join(directory, `${plugin}-${index}`), marker = `${output}.dispatch.json`;
      const result = spawnSync(process.execPath, ['--require', preload, script, output, ...flags], {
        env: {...process.env, RHO_TEST_PACKAGES: JSON.stringify(names), RHO_TEST_MARKER: marker},
        encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      if (index >= 3) {
        assert.match(result.stderr, /Usage:/);
        assert.ok(!fs.existsSync(output), 'Invalid mode must fail before copying source');
        assert.ok(!fs.existsSync(marker), 'Invalid mode must not start a build');
      } else {
        assert.match(result.stderr, /Observed build dispatch/);
        const observed = JSON.parse(fs.readFileSync(marker, 'utf8'));
        const independent = flags.includes('--independent');
        assert.equal(observed.kind, independent ? 'independent' : 'workspace');
        assert.equal(observed.cwd, independent ? output : root);
        if (!independent) assert.ok(observed.args.includes(`rho-${plugin}-backend`));
      }
    }
  }
  // The library default follows development, while the explicit acceptance
  // --build path must continue proving independent-source compilation.
  for (const independent of [false, true]) {
    const marker = path.join(directory, `agent-api-${independent}.json`);
    const invocation = independent ? 'prepareAgentAcceptance({build:true})'
      : `buildAgentPlugin(${JSON.stringify(path.join(directory, 'agent-api-package'))})`;
    const source = `import {buildAgentPlugin,prepareAgentAcceptance} from ${JSON.stringify(path.join(root, 'scripts/build-agent-plugin.mjs'))}; ${invocation};`;
    const result = spawnSync(process.execPath, ['--require', preload, '--input-type=module', '--eval', source], {
      env: {...process.env, TMPDIR: directory, RHO_TEST_PACKAGES: JSON.stringify(packages.agent), RHO_TEST_MARKER: marker},
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Observed build dispatch/);
    const observed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(observed.kind, independent ? 'independent' : 'workspace');
    if (!independent) assert.equal(observed.cwd, root);
  }
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
console.log('Agent/R/Files default to workspace builds; independent builds require an explicit flag; invalid modes stop before assembly. No native tools ran.');
