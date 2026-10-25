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
// Everything outside the `:root` blocks, where tokens are defined rather than used.
const rules = file => read(file).replace(/:root\s*\{[^}]*\}/g, '');
const declarations = file => [...rules(file).matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].map(([, prop, value]) => ({ prop, value: value.trim() }));
const root = Object.fromEntries([...read(path.join(web, 'theme.css')).match(/:root\s*\{[^}]*\}/)[0].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));

test('every token a web stylesheet reads is declared by one of them', () => {
  const missing = sheets.flatMap(file => [...read(file).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]).filter(name => !declared.has(name)).map(name => `${path.relative(web, file)} ${name}`));
  assert.deepEqual([...new Set(missing)], []);
});

test('colour literals live only in :root, where they become tokens', () => {
  const found = sheets.flatMap(file => (rules(file).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map(hex => `${path.relative(web, file)} ${hex}`));
  assert.deepEqual(found, []);
});

// Type, spacing and radius come from one scale each. A value off the scale is a literal
// someone tuned by hand; that is how 17 font sizes and 28 spacings accumulated.
test('type, spacing and radii use the scale tokens only', () => {
  const lengths = /-?\d*\.?\d+(px|rem|em)\b/;
  const off = [];
  for (const file of sheets) for (const { prop, value } of declarations(file)) {
    const where = `${path.relative(web, file)} ${prop}: ${value}`;
    if (prop === 'font-size' && !/^var\(--font-size-[a-z0-9]+\)$/.test(value)) off.push(where);
    if (prop === 'line-height' && !/^var\(--line-height-[a-z0-9]+\)$/.test(value)) off.push(where);
    if (prop === 'font' && value !== 'inherit' && !/var\(--font-size-[a-z0-9]+\)\/var\(--line-height-[a-z0-9]+\)/.test(value)) off.push(where);
    if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?$/.test(prop) && lengths.test(value.replace(/var\(--space-\d+\)/g, ''))) off.push(where);
    if (/^border(-[a-z]+)*-radius$/.test(prop) && !value.split(/\s+/).every(v => /^var\(--radius-[a-z0-9]+\)$/.test(v) || v === '0' || v === '50%')) off.push(where);
  }
  assert.deepEqual(off, []);
  const px = name => Object.keys(root).filter(k => k.startsWith(name)).map(k => parseFloat(root[k]));
  assert.deepEqual(px('--font-size-'), [12, 13, 15, 20, 28]);
  assert.deepEqual(px('--line-height-'), [16, 18, 22, 28, 34]);
  assert.deepEqual(px('--space-'), [2, 4, 6, 8, 12, 16, 24, 32, 48, 64]);
});

// The layers are numbers, not impressions: the panel stands off the canvas, and each
// overlay reads the same on either. WCAG relative luminance; overlays are composited first.
test('surfaces and state overlays are distinguishable on every layer', () => {
  const rgba = hex => { const h = hex.replace('#', ''), full = h.length <= 4 ? [...h].map(c => c + c).join('') : h; return [0, 2, 4, 6].map(i => parseInt(full.slice(i, i + 2) || 'ff', 16) / (i === 6 ? 255 : 1)); };
  const over = (top, under) => { const [r, g, b, a] = rgba(top); return [r, g, b].map((v, i) => v * a + under[i] * (1 - a)); };
  const lum = c => c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const token = name => { let v = root[name]; while (v.startsWith('var(')) v = root[v.slice(4, -1)]; return v; };
  const canvas = over(token('--color-canvas'), [255, 255, 255]), surface = over(token('--color-surface'), [255, 255, 255]);
  assert.ok(ratio(surface, canvas) >= 1.15, `surface on canvas ${ratio(surface, canvas).toFixed(2)}:1`);
  for (const [name, least] of [['--color-hover', 1.08], ['--color-selected', 1.15], ['--color-pressed', 1.25], ['--color-accent-soft', 1.15]]) {
    for (const [layer, base] of [['canvas', canvas], ['surface', surface]]) {
      const r = ratio(over(token(name), base), base);
      assert.ok(r >= least, `${name} on the ${layer} ${r.toFixed(2)}:1 < ${least}:1`);
    }
  }
  // Secondary text stays at 4.5:1 on the darkest state it sits on.
  for (const text of ['--color-muted', '--color-meta']) {
    const r = ratio(over(token(text), canvas), over(token('--color-selected'), canvas));
    assert.ok(r >= 4.5, `${text} on a selected canvas row ${r.toFixed(2)}:1`);
  }
});
