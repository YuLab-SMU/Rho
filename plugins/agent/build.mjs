import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function agentPackageManifest(root) {
  const walk = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Package sources must not contain symlinks');
    if (['target', 'dist', 'compiled', 'node_modules', '.git'].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(location) : [path.relative(root, location).split(path.sep).join('/')];
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  manifest.source.files = walk(root).filter(file => file !== 'plugin.json' && !manifest.source.lockfiles.includes(file)).sort();
  const encoded = JSON.stringify(manifest) + '\n';
  // Match the public protocol's 256 KiB raw manifest limit after adding sources.
  assert.ok(Buffer.byteLength(encoded) <= 256 * 1024, 'Agent manifest exceeds the public protocol byte limit');
  return encoded;
}
// Package the same immutable source/UI/native artifact after either the normal
// standalone build or a workspace build used for rapid integration.
export function assembleAgentArtifact(root, target, env = process.env) {
  assert.ok(fs.existsSync(path.join(root, 'Cargo.toml')), 'Assemble the standalone Agent source package before building.');
  execFileSync(path.join(target, 'debug/export-agent-manifest'), [path.join(root, 'plugin.json')], {cwd: root, env, stdio: 'inherit'});
  const encoded = agentPackageManifest(root);
  fs.writeFileSync(path.join(root, 'plugin.json'), encoded);
  execFileSync(process.execPath, [path.join(root, 'build-ui.mjs')], {cwd: root, env, stdio: 'inherit'});
  fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
  fs.copyFileSync(path.join(target, 'debug/rho-agent-backend'), path.join(root, 'dist/rho-agent-backend'));
  fs.chmodSync(path.join(root, 'dist/rho-agent-backend'), 0o755);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  assert.ok(fs.existsSync(path.join(root, 'Cargo.toml')), 'Assemble the standalone Agent source package before building.');
  execFileSync(process.env.RHO_PLUGIN_CARGO ?? 'cargo', ['build', '--locked', '--offline', '-p', 'rho-agent-backend', '--bins'], {cwd: root, stdio: 'inherit'});
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
  assembleAgentArtifact(root, target);
}
