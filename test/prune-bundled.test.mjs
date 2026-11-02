import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneBundled } from '../scripts/prune-bundled.mjs';

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-prune-'));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await fs.writeFile(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const exists = file => fs.access(file).then(() => true, () => false);

test('third-party files Node never loads leave the package; entries, licenses, first-party and reached declarations stay', async () => {
  const root = await tree({
    'dist/client.d.ts': "import type { Schema } from 'typed';\n",
    'node_modules/@rho-workspace/plugin-x/package.json': { name: '@rho-workspace/plugin-x' },
    'node_modules/@rho-workspace/plugin-x/README.md': 'read at runtime',
    'node_modules/@rho-workspace/plugin-x/dist/index.d.ts': "export * from 'chained';\n",
    'node_modules/typed/package.json': { name: 'typed', main: 'index.js' },
    'node_modules/typed/index.js': '', 'node_modules/typed/index.d.ts': '', 'node_modules/typed/index.js.map': '',
    'node_modules/chained/package.json': { name: 'chained' }, 'node_modules/chained/index.d.ts': "export * from 'deeper';\n",
    'node_modules/deeper/package.json': { name: 'deeper' }, 'node_modules/deeper/index.d.cts': '',
    'node_modules/lib/package.json': { name: 'lib', exports: { '.': { source: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } }, bin: { lib: 'bin/cli.js' } },
    'node_modules/lib/dist/index.js': '', 'node_modules/lib/dist/index.cjs': '', 'node_modules/lib/bin/cli.js': '',
    'node_modules/lib/dist/index.d.ts': '', 'node_modules/lib/dist/index.js.map': '', 'node_modules/lib/src/index.ts': '',
    'node_modules/lib/README.md': '', 'node_modules/lib/LICENSE.md': '', 'node_modules/lib/LICENSE': '',
    'node_modules/lib/.eslintrc': '', 'node_modules/lib/tsconfig.json': '', 'node_modules/lib/.github/FUNDING.yml': '',
    'node_modules/lib/test/index.js': '', 'node_modules/lib/dist/examples/server.js': '',
    'node_modules/lib/node_modules/nested/package.json': { name: 'nested' }, 'node_modules/lib/node_modules/nested/index.js': '', 'node_modules/lib/node_modules/nested/CHANGELOG.md': '',
  });
  try {
    const result = await pruneBundled(root);
    assert.deepEqual(result.typed, ['chained', 'deeper', 'typed']);
    for (const kept of ['dist/client.d.ts', 'node_modules/@rho-workspace/plugin-x/README.md', 'node_modules/@rho-workspace/plugin-x/dist/index.d.ts',
      'node_modules/typed/index.js', 'node_modules/typed/index.d.ts', 'node_modules/chained/index.d.ts', 'node_modules/deeper/index.d.cts',
      'node_modules/lib/package.json', 'node_modules/lib/dist/index.js', 'node_modules/lib/dist/index.cjs', 'node_modules/lib/bin/cli.js',
      'node_modules/lib/LICENSE.md', 'node_modules/lib/LICENSE', 'node_modules/lib/node_modules/nested/index.js']) assert.ok(await exists(path.join(root, kept)), kept + ' stays');
    for (const removed of ['node_modules/typed/index.js.map', 'node_modules/lib/dist/index.d.ts', 'node_modules/lib/dist/index.js.map', 'node_modules/lib/src/index.ts',
      'node_modules/lib/README.md', 'node_modules/lib/.eslintrc', 'node_modules/lib/tsconfig.json', 'node_modules/lib/.github/FUNDING.yml',
      'node_modules/lib/test/index.js', 'node_modules/lib/dist/examples/server.js', 'node_modules/lib/node_modules/nested/CHANGELOG.md']) assert.equal(await exists(path.join(root, removed)), false, removed + ' leaves');
    assert.equal(result.removed, 11);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a file a package names as a Node entry is refused rather than pruned', async () => {
  const root = await tree({
    'dist/client.js': '',
    'node_modules/odd/package.json': { name: 'odd', exports: { '.': { import: './test/index.js' } } },
    'node_modules/odd/test/index.js': '',
  });
  try {
    await assert.rejects(pruneBundled(root), /odd names test.index\.js as an entry/);
    assert.ok(await exists(path.join(root, 'node_modules/odd/test/index.js')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
