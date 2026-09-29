// Assemble existing artifacts only: no Cargo, signing, installation or publication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyPluginSet} from './plugin-set.mjs';
import {bundleFiles, sha256, regular, arm64Executable, deliveryIndex} from './rho-bundle.mjs';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildRhoBundle({rho, plugins, destination}) {
  rho = fs.realpathSync(rho); plugins = fs.realpathSync(plugins); destination = path.resolve(destination);
  assert.ok(!fs.existsSync(destination), 'Destination already exists; choose a new directory');
  arm64Executable(rho);
  const coreDigest = sha256(fs.readFileSync(rho));
  const indexDigest = sha256(fs.readFileSync(path.join(plugins, 'plugin-set.json')));
  const set = deliveryIndex(plugins);
  // Check relocation prerequisites before running the supplied core. Runtime
  // artifacts already have their own package closure and archive validation.
  const libraries = execFileSync('/usr/bin/otool', ['-L', rho], {encoding: 'utf8'}).trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
  assert.ok(libraries.length && libraries.every(file => file.startsWith('/System/Library/') || file.startsWith('/usr/lib/')), 'Core has unbundled dynamic-library dependencies');
  verifyPluginSet({rho, directory: plugins});
  fs.mkdirSync(destination); // Preserve prior deliveries and failed attempts.
  const copy = (source, name) => {
    regular(source); fs.copyFileSync(source, path.join(destination, name), fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(destination, name), name === 'rho' ? 0o755 : 0o644);
  };
  copy(rho, 'rho'); copy(path.join(plugins, 'plugin-set.json'), 'plugin-set.json');
  for (const entry of set.packages) copy(path.join(plugins, entry.file), entry.file);
  for (const file of ['rho-bundle.mjs', 'plugin-set.mjs']) copy(path.join(repository, 'scripts', file), file);
  for (const file of ['LICENSE', 'LICENSES.md']) copy(path.join(repository, file), file);
  fs.writeFileSync(path.join(destination, 'GETTING-STARTED.md'), `# Rho local development bundle\n\nThis directory contains the retained macOS arm64 core and sixteen ordinary plugin\narchives with their first-party source, lockfiles and build instructions. It can be\nmoved as a directory. This is an internal development delivery, not a signed or\nnotarized release. No signing, runtime acquisition or publication was performed.\nThe assembly checkout is recorded separately from artifact identity; the retained\ncore's source commit is unknown. LICENSES.md is not a complete public redistribution\nnotice bundle. Do not interpret this development package as a release provenance or\nlicensing audit.\n\nUse an existing Node.js 22+ for verification and explicit plugin import. Node.js,\nR and Ark are not installed or bundled. The core runs without Node after import.\nFrom this directory:\n\n\`\`\`sh\nnode rho-bundle.mjs verify\nnode rho-bundle.mjs install --database /absolute/state/rho.sqlite\n./rho --database /absolute/state/rho.sqlite workbench\n\`\`\`\n\nUse the same absolute database path in install and launch. Choose an existing\nproject in the browser, open Plugins, and choose Scenarios → New R workspace.\nSelect existing Ark/R paths and the desired installed tools; Prepare workspace,\nthen Switch to R workspace. Start R explicitly in Console. Agent tools begin\nunchecked; Send, native runtime configuration and Studio application remain explicit.\n\nVerification writes only owned temporary files. Installation validates the whole\nset before using ordinary repository imports; it creates no running instances or\nscenario. If an import reply is lost, retain its attempted revision and acknowledged\nimports. Retry the same explicit install to inspect/complete the idempotent imports.\nIt does not claim rollback. Daily startup never calls the installer or reinstalls\nremoved plugins. Import never deletes existing tasks, instances, versions or work.\n\nThe core remains available even after every feature plugin is removed. Use\n\`./rho --database /absolute/state/rho.sqlite plugins list\` for catalog recovery,\nand explicitly import an archive or run the installer again only when restoration\nis intended. Retained references can protect a revision from removal.\n\nThe checksums detect changed payload bytes; they do not authenticate the publisher.\nNative backends and these scripts are trusted local code, not an OS sandbox.\n`);
  const files = [...bundleFiles, ...set.packages.map(entry => entry.file)].map(file => {
    const bytes = fs.readFileSync(path.join(destination, file));
    return {file, bytes: bytes.length, sha256: sha256(bytes), executable: file === 'rho'};
  });
  assert.equal(files.find(file => file.file === 'rho').sha256, coreDigest, 'Core changed during assembly');
  assert.equal(files.find(file => file.file === 'plugin-set.json').sha256, indexDigest, 'Index changed during assembly');
  // Match the bytes actually copied, not the earlier source-directory observation.
  for (const entry of set.packages) {
    const copied = files.find(file => file.file === entry.file);
    assert.equal(copied.bytes, entry.bytes); assert.equal(copied.sha256, entry.sha256);
  }
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], {cwd: repository, encoding: 'utf8'}).trim();
  const manifest = {format: 1, target: 'aarch64-apple-darwin', kind: 'local-development',
    assembly_checkout: {commit: checkout, dirty}, core_source_commit: null, files};
  fs.writeFileSync(path.join(destination, 'rho-bundle.json'), JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
  return {directory: destination, manifest, core_libraries: libraries};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    assert.equal(args.length, 6, 'Usage: build-rho-bundle.mjs --rho PATH --set DIR --out NEW_DIR');
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--rho','--set','--out'].includes(args[i]) && !(args[i] in options) && args[i + 1] && !args[i + 1].startsWith('--'));
      options[args[i]] = args[i + 1];
    }
    console.log(JSON.stringify(buildRhoBundle({rho:options['--rho'],plugins:options['--set'],destination:options['--out']})));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
