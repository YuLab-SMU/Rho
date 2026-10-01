// Local acceptance evidence, not a package format or a runtime cache. The receipt
// lives beside the external package, so it cannot enter the shipped source list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const agentSourceCopies = [
  ['plugins/agent', '.'], ['crates/plugin-protocol', 'public/plugin-protocol'],
  ['crates/plugin-sdk', 'public/plugin-sdk'], ['plugins/r/api', 'public/r-api'],
  ['sdk/plugin-ui', 'public/plugin-ui'], ['sdk/plugin-protocol', 'public/plugin-protocol'],
];
export const excludedAgentSource = source => /[\\/](?:target|dist|compiled|node_modules|\.git)(?:[\\/]|$)/.test(source);

function treeDigest(directory, entries, exclude = () => false) {
  const hash = createHash('sha256');
  function visit(relative) {
    const location = path.join(directory, relative);
    const stat = fs.lstatSync(location);
    assert.ok(!stat.isSymbolicLink(), `Source/artifact must not contain symlinks: ${relative}`);
    if (exclude(location)) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(location).sort()) visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile(), `Expected regular file: ${relative}`);
      // Frame names and file digests to avoid concatenation ambiguities.
      hash.update(JSON.stringify([relative.split(path.sep).join('/'), stat.mode & 0o111,
        createHash('sha256').update(fs.readFileSync(location)).digest('hex')]));
    }
  }
  for (const entry of entries) visit(entry);
  return hash.digest('hex');
}

export function agentBuildInputDigest(checkout = root) {
  return treeDigest(checkout, [...agentSourceCopies.map(([from]) => from),
    'Cargo.toml', 'Cargo.lock', 'LICENSE', 'rust-toolchain.toml',
    'scripts/build-agent-plugin.mjs', 'scripts/agent-plugin-artifact.mjs'], excludedAgentSource);
}

const receiptPath = packagePath => `${packagePath}.build.json`;
export function agentBuildMode(packagePath) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath(packagePath), 'utf8'));
  assert.equal(receipt.format, 1, 'Unknown Agent build receipt');
  assert.ok(['workspace', 'independent'].includes(receipt.build_mode), 'Agent receipt must identify its build mode');
  return receipt.build_mode;
}
export function recordAgentBuild(packagePath, inputDigest, checkout = root, mode = 'independent') {
  assert.ok(['workspace', 'independent'].includes(mode), 'Unknown Agent build mode');
  assert.equal(agentBuildInputDigest(checkout), inputDigest, 'Agent build inputs changed during the build; rebuild before acceptance');
  const receipt = {format: 1, build_mode: mode, inputs: inputDigest, platform: process.platform, arch: process.arch,
    package_sha256: treeDigest(packagePath, ['.'])};
  fs.writeFileSync(receiptPath(packagePath), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  return receipt;
}

export function verifyAgentBuild(packagePath, checkout = root) {
  const resolved = fs.realpathSync(packagePath), project = fs.realpathSync(checkout);
  assert.ok(resolved !== project && !resolved.startsWith(project + path.sep), 'Use an external Agent package');
  assert.ok(fs.existsSync(receiptPath(resolved)), 'Agent package has no build receipt; use --build once for milestone acceptance');
  const receipt = JSON.parse(fs.readFileSync(receiptPath(resolved), 'utf8'));
  assert.equal(receipt.format, 1, 'Unknown Agent build receipt');
  agentBuildMode(resolved);
  assert.equal(receipt.platform, process.platform, 'Agent package platform changed');
  assert.equal(receipt.arch, process.arch, 'Agent package architecture changed');
  assert.equal(receipt.inputs, agentBuildInputDigest(checkout), 'Agent sources changed; use focused workspace tests while iterating, then --build at the milestone');
  assert.equal(receipt.package_sha256, treeDigest(resolved, ['.']), 'Agent package changed after its build');
  return resolved;
}

export function agentAcceptanceOptions(argv, {environment = process.env, framed = false, evidence = false, browser = false} = {}) {
  const options = {build: false, packagePath: environment.RHO_AGENT_PLUGIN_PACKAGE ?? null, skipFramed: false, evidence: null, browser: false};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    assert.ok(!seen.has(arg), `Repeated option: ${arg}`); seen.add(arg);
    if (arg === '--build') options.build = true;
    else if (arg === '--browser' && browser) options.browser = true;
    else if (arg === '--skip-framed' && framed) options.skipFramed = true;
    else if (arg === '--package' || (arg === '--evidence' && evidence)) {
      const value = argv[++index];
      assert.ok(value && !value.startsWith('--'), `${arg} requires a path`);
      options[arg === '--package' ? 'packagePath' : 'evidence'] = path.resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.build !== Boolean(options.packagePath),
    'Milestone acceptance requires --build (one retained external build) OR --package <path> / RHO_AGENT_PLUGIN_PACKAGE (reuse). For iteration use focused workspace tests.');
  assert.ok(!options.browser || !options.build, 'Browser integration requires a retained --package; it never starts another build');
  return options;
}
