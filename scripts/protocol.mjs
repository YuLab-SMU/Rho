import { writeFile, mkdir } from 'node:fs/promises';
import { protocol } from '../dist/protocol.js';
await mkdir(new URL('../protocol/', import.meta.url), { recursive: true });
await writeFile(new URL('../protocol/v2.json', import.meta.url), JSON.stringify(protocol, null, 2) + '\n');
