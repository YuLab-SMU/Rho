import { writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { protocol } from '../dist/protocol.js';
import { protocolArtifacts } from './protocol-artifact.mjs';
const root = new URL('../protocol/', import.meta.url);
await mkdir(new URL('operations/', root), { recursive: true });
const files = protocolArtifacts(protocol);
// Retire files this contract no longer publishes, and any directory left by an
// earlier layout, so the folder always describes exactly one contract.
for (const name of await readdir(new URL('operations/', root))) if (name.endsWith('.json') && !files.has('operations/' + name)) await rm(new URL('operations/' + name, root));
for (const name of ['v2.json', 'v1.json', 'v2']) await rm(new URL(name, root), { recursive: true, force: true });
for (const [name, body] of files) await writeFile(new URL(name, root), body);
