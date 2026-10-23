import { readdir, rm } from 'node:fs/promises';
// `tsc` writes output but never removes output for a source file that no longer
// exists. A renamed or deleted module therefore stays importable from dist/ until
// something deletes it, and a packaging step would ship the retired name. Each
// service build starts from a clean service tree instead.
//
// Only the flat service output is cleaned. The browser bundle in dist/web is owned
// by vite (`emptyOutDir`), so it survives a lone service build that the shell and
// the packer still expect to find.
const root = new URL('../dist/', import.meta.url);
let entries;
try { entries = await readdir(root); } catch (e) { if (e.code === 'ENOENT') process.exit(0); throw e; }
for (const name of entries) if (name !== 'web') await rm(new URL(name, root), { recursive: true, force: true });
