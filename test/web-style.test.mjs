import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// One visual system: a style either uses a token the shell declares or it is a literal
// someone has to keep in step by hand. docs/WORKSPACE-PLAN.md, ruler M7.
const web = new URL('../web/', import.meta.url).pathname;
const sheets = fs.readdirSync(web, { recursive: true }).filter(f => String(f).endsWith('.css')).map(f => path.join(web, String(f)));
const read = file => fs.readFileSync(file, 'utf8');
const declared = new Set(sheets.flatMap(file => [...read(file).matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])));
const hexes = file => (read(file).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
// The frozen legacy workspace (removed in W6) reads these undeclared names; the list may only shrink.
const legacyUndeclared = { 'expression.css': ['--border', '--surface', '--text', '--text-muted'] };

test('every token a web stylesheet reads is declared by one of them', () => {
  const missing = sheets.flatMap(file => [...read(file).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]).filter(name => !name.startsWith('--dv-') && !declared.has(name) && !legacyUndeclared[path.relative(web, file)]?.includes(name)).map(name => `${path.relative(web, file)} ${name}`));
  assert.deepEqual([...new Set(missing)], []);
});

test('the shell has no colour literals, and no other sheet gains any', () => {
  for (const file of sheets.filter(f => path.relative(web, f).startsWith('shell' + path.sep))) assert.equal(hexes(file), 0, `${path.relative(web, file)} has colour literals`);
  // Literals today, mostly fallbacks for tokens that exist; these may only go down.
  const ceiling = { 'expression.css': 16, 'agent-map/map.css': 31, 'frame.css': 15, 'plugins.css': 7 };
  for (const [name, most] of Object.entries(ceiling)) if (fs.existsSync(path.join(web, name))) assert.ok(hexes(path.join(web, name)) <= most, `${name}: ${hexes(path.join(web, name))} colour literals, ceiling ${most}`);
});
