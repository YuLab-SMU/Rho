import * as fs from 'node:fs';
import path from 'node:path';
const readAll = base => {
  const idx = JSON.parse(fs.readFileSync(base + '/index.json', 'utf8'));
  return { idx, ops: Object.fromEntries(Object.entries(idx.operations).map(([m, e]) => [m, JSON.parse(fs.readFileSync(base + '/' + e.path, 'utf8'))])) };
};
const A = JSON.parse(fs.readFileSync('/tmp/rho-before/index.json', 'utf8'));
const B = JSON.parse(fs.readFileSync('protocol/index.json', 'utf8'));
const get = (idx, base, m) => JSON.parse(fs.readFileSync(base + '/' + (base.endsWith('flat') ? path.basename(idx.operations[m].path) : idx.operations[m].path), 'utf8'));
const canon = (v, key) => {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) {
    const items = v.map(x => canon(x, key)).sort((a, b) => a.localeCompare(b));
    return '[' + items.join(',') + ']';
  }
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k], k)).join(',') + '}';
  return JSON.stringify(v);
};
const diffs = [];
function walk(a, b, p, out) {
  const ca = canon(a), cb = canon(b);
  if (ca === cb) return;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) { out.push(p + ': ' + String(ca).slice(0, 120) + '  =>  ' + String(cb).slice(0, 120)); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p + '/' + k, out);
}
for (const m of Object.keys(A.operations).sort()) {
  const before = get(A, '/tmp/rho-before-flat', m), after = get(B, 'protocol', m);
  for (const part of ['inputSchema', 'outputSchema', 'description']) {
    const out = []; walk(before[part], after[part], part, out);
    if (out.length) diffs.push([m, out]);
  }
}
console.log('semantic changes:', diffs.length);
for (const [m, out] of diffs.slice(0, 6)) { console.log('== ' + m); console.log(out.slice(0, 6).join('\n')); }
