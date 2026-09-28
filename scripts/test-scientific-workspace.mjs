/** One real scientific window, using explicitly supplied native artifacts.
 * No Cargo, install, publication or implicit native package rebuild. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv.length === 2 || process.argv.length === 4 && process.argv[2] === '--packages', 'Usage: node scripts/test-scientific-workspace.mjs --packages /absolute/native-packages.json');
const selected = process.argv[3] ?? process.env.RHO_SCIENTIFIC_PACKAGES;
assert.ok(selected, 'Supply --packages or RHO_SCIENTIFIC_PACKAGES; native artifacts are never built implicitly');
const selection = fs.realpathSync(selected), packages = JSON.parse(fs.readFileSync(selection, 'utf8'));
for (const key of ['r', 'files', 'editor']) {
  assert.ok(path.isAbsolute(packages[key] ?? ''), `Supply the absolute ${key} package directory`);
  const manifest = JSON.parse(fs.readFileSync(path.join(packages[key], 'plugin.json'), 'utf8'));
  assert.equal(manifest.id, `org.rho.${key}`);
  assert.ok(fs.statSync(path.join(packages[key], manifest.backend.executable)).isFile());
  if (key === 'files') assert.ok(manifest.views[0].configuration_schema.properties.runtime, 'Build the Files integration change before this acceptance');
}
assert.ok(process.env.RHO_ARK && process.env.RHO_R_HOME, 'Select existing RHO_ARK and RHO_R_HOME for a disposable R session');
execFileSync('npm', ['run', 'test:browser', '--prefix', 'ui', '--', 'scientific-workspace.spec.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, RHO_SCIENTIFIC_PACKAGES: selection },
});
