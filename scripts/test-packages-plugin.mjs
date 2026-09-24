import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-packages-model-'));
try {
  fs.cpSync(path.join(root, 'plugins/packages'), temporary, { recursive: true });
  fs.cpSync(path.join(root, 'plugins/r/sdk'), path.join(temporary, 'public/r-protocol'), { recursive: true });
  for (const name of ['plugin-ui', 'plugin-protocol']) fs.cpSync(path.join(root, 'sdk', name), path.join(temporary, 'public', name), { recursive: true });
  fs.symlinkSync(path.join(root, 'ui/node_modules'), path.join(temporary, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}');
  execFileSync(process.execPath, [path.join(temporary, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck',
    '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    path.join(temporary, 'src/packages.ts'), path.join(temporary, 'src/connection.ts')], { cwd: temporary, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(temporary, 'node_modules/vitest/vitest.mjs'), 'run'], { cwd: temporary, stdio: 'inherit' });
  console.log('Independent Packages model and connection passed with public R/plugin contracts. Runtime package assembly remains separate.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
