import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root, run, applicationInputs, treeFiles, saveJson} from './components.mjs';
import {verifySnapshot} from '../sdk/verify-snapshot.mjs';
const mode = process.argv[2] ?? 'check';
assert.ok(['check', 'build'].includes(mode), 'Use build or check; contract generation belongs to rho-core');
verifySnapshot(root);
run(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '-p', 'ui/tsconfig.json', '--noEmit']);
if (mode === 'build') {
  const inputs = applicationInputs();
  const {build} = await import('../ui/node_modules/vite/dist/node/index.js');
  const output = path.join(root, 'target/app-assets');
  await build({configFile: path.join(root, 'ui/vite.config.ts'), build: {outDir: output, watch: null}});
  fs.copyFileSync(path.join(root, 'ui/index.html'), path.join(output, 'index.html'));
  assert.equal(applicationInputs(), inputs, 'Application inputs changed during build');
  saveJson(path.join(root, 'target/app-assets.json'), {inputs, files: treeFiles(output)});
  console.log(`Application assets: ${output}; no Cargo invocation or core rebuild.`);
} else console.log('Application types and pinned public SDK verified; no Cargo invocation.');
