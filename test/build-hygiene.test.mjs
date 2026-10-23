import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
// Compiled output must mirror the sources exactly. `tsc` never deletes output for a
// removed source, so without this check a renamed module keeps its old file in
// dist/, stays importable, and can be shipped or imported by tests under a name the
// sources no longer define.
const names = async (url, extension) => (await fs.readdir(url))
  .filter(name => name.endsWith(extension)).map(name => name.slice(0, -extension.length)).sort();
test('compiled service output mirrors the source tree in both directions', async () => {
  const sources = await names(new URL('../src/', import.meta.url), '.ts');
  const emitted = await names(new URL('../dist/', import.meta.url), '.js');
  const declared = await names(new URL('../dist/', import.meta.url), '.d.ts');
  assert.deepEqual(emitted, sources, 'dist/*.js names must match src/*.ts names');
  assert.deepEqual(declared, sources, 'dist/*.d.ts names must match src/*.ts names');
});
