import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The shell renders Screen and owner records; it does not decide attention (docs/WORKSPACE-PLAN.md
// W1). It may reach the rules only through the live adapter, and never the frozen workspace.
const shell = new URL('../web/shell/', import.meta.url).pathname;
const allowed = new Set(['browser', 'expression', 'live-workspace', 'shell-layout', 'ui-contract', 'plugin-presentation', 'execution-facts']);
const legacy = ['workspace', 'frame', 'expression', 'artifact', 'agent-map/ui'];
const files = fs.readdirSync(shell, { recursive: true }).map(String).filter(f => /\.(ts|tsx)$/.test(f));

test('the shell imports only the allowed rule and contract modules', () => {
  assert.ok(files.length > 0);
  const found = files.flatMap(file => [...fs.readFileSync(path.join(shell, file), 'utf8').matchAll(/from '((?:\.\.\/)+)src\/([a-z-]+)\.js'/g)].map(m => [file, m[2]]));
  assert.deepEqual(found.filter(([, name]) => !allowed.has(name)), []);
});

test('the shell does not reach into the frozen workspace', () => {
  const found = files.flatMap(file => [...fs.readFileSync(path.join(shell, file), 'utf8').matchAll(/from '\.\.\/([a-z/-]+)\.js'/g)].map(m => [file, m[1]]));
  assert.deepEqual(found.filter(([, name]) => legacy.includes(name)), []);
});

test('expression is used for its types only', () => {
  const values = files.filter(file => /^import \{[^}]*\} from '(?:\.\.\/)+src\/expression\.js'/m.test(fs.readFileSync(path.join(shell, file), 'utf8')));
  assert.deepEqual(values, [], 'import type from expression.js');
});
