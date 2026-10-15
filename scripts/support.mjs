import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
export const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
export const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')));
export const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
export const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')));
export const native = await runtime();
