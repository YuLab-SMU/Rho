import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
assert.ok(fs.existsSync(path.join(root, 'Cargo.toml')), 'Assemble the standalone Agent source package before building.');
execFileSync(process.env.RHO_PLUGIN_CARGO ?? 'cargo', ['build', '--locked', '--offline', '-p', 'rho-agent-backend', '--bins'], {cwd: root, stdio: 'inherit'});
const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
execFileSync(path.join(target, 'debug/export-agent-manifest'), [path.join(root, 'plugin.json')], {cwd: root, stdio: 'inherit'});
const walk = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
  assert.ok(!entry.isSymbolicLink(), 'Package sources must not contain symlinks');
  if (['target', 'dist', 'node_modules', '.git'].includes(entry.name)) return [];
  const location = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(location) : [path.relative(root, location).split(path.sep).join('/')];
});
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
manifest.source.files = walk(root).filter(file => file !== 'plugin.json' && !manifest.source.lockfiles.includes(file)).sort();
const encoded = JSON.stringify(manifest) + '\n';
// Match the public protocol's 256 KiB raw manifest limit after adding sources.
assert.ok(Buffer.byteLength(encoded) <= 256 * 1024, 'Agent manifest exceeds the public protocol byte limit');
fs.writeFileSync(path.join(root, 'plugin.json'), encoded);
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
fs.copyFileSync(path.join(target, 'debug/rho-agent-backend'), path.join(root, 'dist/rho-agent-backend'));
fs.chmodSync(path.join(root, 'dist/rho-agent-backend'), 0o755);
