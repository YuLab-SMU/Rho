// Local macOS preview assembly. No installation or publication.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {verifyBundle, arm64Executable} from './rho-bundle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options});
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--bundle', '--out', '--ark', '--r-home'].includes(process.argv[i]) && process.argv[i + 1] && !options[process.argv[i]],
    'Usage: build-preview-app.mjs --bundle DIR --out NEW_APP --ark FILE --r-home DIR');
  options[process.argv[i]] = process.argv[i + 1];
}
assert.equal(Object.keys(options).length, 4);
const bundle = fs.realpathSync(options['--bundle']), output = path.resolve(options['--out']);
assert.ok(output.endsWith('.app') && !fs.existsSync(output), 'Choose a new .app destination');
const runtime = {ark: fs.realpathSync(options['--ark']), r_home: fs.realpathSync(options['--r-home'])};
fs.accessSync(runtime.ark, fs.constants.X_OK);
run(path.join(runtime.r_home, 'bin/Rscript'), ['--vanilla', '-e', 'stopifnot(requireNamespace("jsonlite",quietly=TRUE),requireNamespace("rlang",quietly=TRUE))']);
const verified = verifyBundle({directory: bundle});
const commit = run('git', ['rev-parse', 'HEAD']).trim(), dirty = !!run('git', ['status', '--porcelain']).trim();
const resources = path.join(output, 'Contents/Resources'), executable = path.join(output, 'Contents/MacOS/Rho');
fs.mkdirSync(resources, {recursive: true}); fs.mkdirSync(path.dirname(executable));
fs.cpSync(bundle, path.join(resources, 'bundle'), {recursive: true, filter: source => source === bundle || fs.statSync(source).isFile()});
for (const name of ['service.mjs', 'workspace.mjs']) fs.copyFileSync(path.join(root, 'scripts/preview', name), path.join(resources, name));
const node = fs.realpathSync(process.execPath);
arm64Executable(node);
const libraries = run('/usr/bin/otool', ['-L', node]).trim().split('\n').slice(1).map(line => line.trim().split(' (')[0]);
assert.ok(libraries.every(file => file.startsWith('/System/Library/') || file.startsWith('/usr/lib/')), 'Node needs unbundled libraries');
fs.copyFileSync(node, path.join(resources, 'node')); fs.chmodSync(path.join(resources, 'node'), 0o755);
const index = JSON.parse(fs.readFileSync(path.join(bundle, 'plugin-set.json')));
const derivedSources = [];
for (const key of ['manager', 'files']) {
  const entry = index.packages.find(item => item.plugin === `org.rho.${key}`);
  const archive = JSON.parse(fs.readFileSync(path.join(bundle, entry.file)));
  const artifact = archive.artifacts.find(item => item.id === entry.artifacts[0].id);
  for (const [relative, file] of Object.entries(key === 'manager' ? artifact.files : {})) {
    if (!relative.startsWith('dist/')) continue;
    assert.ok(!relative.split('/').includes('..'));
    const bytes = Buffer.from(archive.blobs[file.digest], 'base64');
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.digest);
    const target = path.join(resources, key, relative); fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes, {mode: file.executable ? 0o755 : 0o644});
  }
  if (key === 'files') {
    // Files ships a browser bundle. Compile its exact archived owner models for
    // the launcher; never substitute source from the assembly checkout.
    const require = createRequire(new URL('../ui/package.json', import.meta.url));
    const ts = require('typescript'), visited = new Set();
    const compile = relative => {
      if (visited.has(relative)) return;
      assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'));
      visited.add(relative);
      const source = relative.replace(/\.js$/, '.ts'), file = archive.revision.files[source];
      assert.ok(file, `Missing archived Files source: ${source}`);
      const bytes = Buffer.from(archive.blobs[file.digest], 'base64');
      assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.digest);
      const result = ts.transpileModule(bytes.toString('utf8'), {fileName: source,
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}});
      const target = path.join(resources, key, 'dist', relative);
      fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, result.outputText);
      derivedSources.push({plugin: entry.plugin, revision: entry.revision, source, digest: file.digest, typescript: ts.version});
      const tree = ts.createSourceFile(relative, result.outputText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
      for (const statement of tree.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
          const dependency = statement.moduleSpecifier.text;
          assert.ok(dependency.startsWith('.'), `Unexpected Files runtime dependency: ${dependency}`);
          compile(path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency)));
        }
      }
    };
    compile('src/connection.js'); compile('src/actions.js');
  }
  fs.mkdirSync(path.join(resources, key), {recursive: true});
  fs.writeFileSync(path.join(resources, key, 'package.json'), '{"type":"module"}\n');
}
fs.writeFileSync(path.join(resources, 'preview-profile.json'), JSON.stringify({format: 1, runtime, source_commit: commit}, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Rho</string><key>CFBundleIdentifier</key><string>org.rho.local-preview</string>
<key>CFBundleName</key><string>Rho Preview</string><key>CFBundleDisplayName</key><string>Rho Preview</string>
<key>CFBundleVersion</key><string>2</string><key>CFBundleShortVersionString</key><string>0.1.0-preview.2</string>
<key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/>
<key>CFBundleIconFile</key><string>Rho.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>\n`);
const started = performance.now();
run('/usr/bin/swiftc', ['-O', '-framework', 'AppKit', path.join(root, 'scripts/preview/PreviewApp.swift'), '-o', executable]);
const buildSeconds = (performance.now() - started) / 1000;
const iconset = path.join(path.dirname(output), '.Rho.iconset');
assert.ok(!fs.existsSync(iconset), 'Icon staging already exists');
run(executable, ['--write-icon', iconset]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Rho.icns')]);
fs.rmSync(iconset, {recursive: true});
const walk = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const manifest = {format: 1, kind: 'local-preview', target: 'aarch64-apple-darwin', source_commit: commit, dirty,
  core: verified.manifest.files.find(item => item.file === 'rho'), plugins: index.packages,
  launcher_before_bundle_signing_sha256: digest(fs.readFileSync(executable)),
  info_plist_sha256: digest(fs.readFileSync(path.join(output, 'Contents/Info.plist'))),
  node_version: process.version, runtime, swift_build_seconds: buildSeconds, derived_sources: derivedSources,
  files: walk(resources).map(file => {const bytes = fs.readFileSync(file); return {file: path.relative(resources, file), bytes: bytes.length, sha256: digest(bytes)};})};
fs.writeFileSync(path.join(resources, 'preview-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
// Local ad hoc identity only; do not rewrite the retained core or plugin bytes.
run('/usr/bin/codesign', ['--force', '--sign', '-', output]);
run('/usr/bin/codesign', ['--verify', '--strict', output]);
const files = walk(output), total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const tree = files.sort().map(file => ({file: path.relative(output, file), bytes: fs.statSync(file).size,
  mode: fs.statSync(file).mode & 0o777, sha256: digest(fs.readFileSync(file))}));
const receipt = {app: output, source_commit: commit, dirty, bytes: total, signing: 'local ad hoc',
  app_tree_sha256: digest(Buffer.from(JSON.stringify(tree))), files: tree};
const receiptFile = output.replace(/\.app$/, '.receipt.json');
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({app: output, source_commit: commit, dirty, bytes: total, swift_build_seconds: buildSeconds,
  manifest_sha256: digest(fs.readFileSync(path.join(resources, 'preview-manifest.json'))),
  app_tree_sha256: receipt.app_tree_sha256, receipt: receiptFile, signing: 'local ad hoc'}));
