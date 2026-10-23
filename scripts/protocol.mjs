import { writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { protocol } from '../dist/protocol.js';
import { protocolArtifacts } from './protocol-artifact.mjs';
await mkdir(new URL('../protocol/v2/', import.meta.url), { recursive: true });
const files = protocolArtifacts(protocol);
for (const name of await readdir(new URL('../protocol/v2/', import.meta.url))) if (name.endsWith('.json') && !files.has('v2/' + name)) await rm(new URL('../protocol/v2/' + name, import.meta.url));
for (const [name, body] of files) await writeFile(new URL('../protocol/' + name, import.meta.url), body);
