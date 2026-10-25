import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const web = new URL('../web/', import.meta.url).pathname;
const sheets = fs.readdirSync(web, { recursive: true }).filter(f => String(f).endsWith('.css')).map(f => path.join(web, String(f)));
const read = file => fs.readFileSync(file, 'utf8');
const declared = new Set(sheets.flatMap(file => [...read(file).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])));

test('every token a web stylesheet reads is declared by one of them', () => {
  const missing = sheets.flatMap(file => [...read(file).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]).filter(name => !declared.has(name)).map(name => `${path.relative(web, file)} ${name}`));
  assert.deepEqual([...new Set(missing)], []);
});
