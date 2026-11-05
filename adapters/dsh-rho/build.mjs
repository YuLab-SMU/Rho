import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

await build({
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
  entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-rho",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
