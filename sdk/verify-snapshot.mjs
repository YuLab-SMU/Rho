// Public dependency verifier. Consumer copies are generated; edit only in rho-core.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function verifySnapshot(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'core-sdk.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(JSON.stringify(manifest.files)), manifest.sha256, 'SDK inventory digest changed');
  const names = new Set();
  for (const file of manifest.files) {
    assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').some(p => ['', '.', '..'].includes(p)));
    assert.ok(!names.has(file.path), 'Duplicate dependency path'); names.add(file.path);
    const location = path.join(root, file.path), stat = fs.lstatSync(location);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Invalid dependency: ${file.path}`);
    assert.equal(fs.realpathSync(location), path.join(fs.realpathSync(root), file.path), 'Dependency escapes through a parent symlink');
    const bytes = fs.readFileSync(location);
    assert.equal(bytes.length, file.bytes, `SDK size changed: ${file.path}`);
    assert.equal(hash(bytes), file.sha256, `SDK content changed: ${file.path}`);
    assert.equal(Boolean(stat.mode & 0o111), file.executable, `SDK mode changed: ${file.path}`);
  }
  const actual = new Set(['CORE-LICENSE']);
  function inventory(relative) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').some(p => ['', '.', '..'].includes(p)));
    const location = path.join(root, relative), stat = fs.lstatSync(location);
    assert.ok(!stat.isSymbolicLink(), `SDK directory contains a symlink: ${relative}`);
    if (path.basename(relative) === '.DS_Store' && stat.isFile()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(location)) inventory(`${relative}/${name}`);
    else { assert.ok(stat.isFile()); actual.add(relative); }
  }
  for (const directory of manifest.roots) inventory(directory);
  assert.deepEqual([...actual].sort(), [...names].sort(), 'SDK contains missing or unlisted files');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const manifest = verifySnapshot(root);
  console.log(`Public SDK verified: ${manifest.source_revision} (${manifest.files.length} files)`);
}
