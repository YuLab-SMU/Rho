// The website demo is the application's own WebUI build with one addition: replay.js runs
// first and answers API requests from the recording, so no backend is needed. A relative
// base lets the same build serve from /Rho/demo/ or any local folder.
//
//   RHO_WEB_OUTPUT=site/.pages/demo npx vite build --config site/demo/vite.config.ts
import fs from 'node:fs';
import path from 'node:path';
import { mergeConfig } from 'vite';
import application from '../../vite.config.ts';

const replay = fs.readFileSync(path.resolve('site/demo/replay.js'), 'utf8');
const recording = path.resolve('site/demo/recording.json');

export default mergeConfig(application, {
  base: './',
  plugins: [{
    name: 'rho-demo-replay',
    transformIndexHtml: html => ({
      html: html.replace(/<title>[^<]*<\/title>/, '<title>Rho demo · PA14 quorum sensing</title>'),
      tags: [{ tag: 'script', children: replay, injectTo: 'head-prepend' }],
    }),
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'demo-data/recording.json', source: fs.readFileSync(recording) }); },
  }],
});
