import { writeFile, mkdir, readdir, rm, readFile } from 'node:fs/promises';
import { protocol } from '../dist/protocol.js';
import { protocolArtifacts } from './protocol-artifact.mjs';
const root = new URL('../protocol/', import.meta.url);
const files = protocolArtifacts(protocol);
// `--check` compares what the contract would publish with what is on disk and writes
// nothing: a stale artifact, an operation missing from disk or an operation left over
// from an earlier contract all fail the check.
if (process.argv.includes('--check')) {
  const problems = [];
  const onDisk = new Set((await readdir(new URL('operations/', root)).catch(() => [])).filter(name => name.endsWith('.json')).map(name => 'operations/' + name));
  for (const [name, body] of files) {
    const current = await readFile(new URL(name, root), 'utf8').catch(() => null);
    if (current !== body) problems.push(name + (current === null ? ' is missing' : ' is out of date'));
    if (name.startsWith('operations/')) onDisk.delete(name);
  }
  for (const name of onDisk) problems.push(name + ' is not part of the contract');
  if (problems.length) {
    console.error('The published contract artifact does not match its source:\n' + problems.join('\n') + '\nRun: npm run build:protocol-artifact');
    process.exitCode = 1;
  } else console.log('Published contract artifact is current (' + (files.size - 1) + ' operations, one index).');
} else {
  await mkdir(new URL('operations/', root), { recursive: true });
  // Drop operations this contract no longer publishes, so the folder always
  // describes exactly one contract instead of accumulating earlier revisions.
  for (const name of await readdir(new URL('operations/', root))) if (name.endsWith('.json') && !files.has('operations/' + name)) await rm(new URL('operations/' + name, root));
  for (const [name, body] of files) await writeFile(new URL(name, root), body);
  console.log('Published contract artifact: ' + (files.size - 2) + ' operations, one index.');
}
