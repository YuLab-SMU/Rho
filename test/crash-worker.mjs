// Disposable-process fault injector. Production has no fault injection route.
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { runtime } from '../dist/runtime.js';
const [root, stage] = process.argv.slice(2);
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime() }).start();
const hold = async at => { process.send({ checkpoint: at }); await new Promise(() => {}); };
if (stage === 'before-host') service.bridge.ensureOwnedHost = async () => hold(stage);
const call = service.bridge.call.bind(service.bridge);
service.bridge.call = async (...args) => {
  if (args[1] === 'submit' && stage === 'before-cli') await hold(stage);
  const result = await call(...args);
  if (args[1] === 'submit' && stage === 'after-cli') await hold(stage);
  return result;
};
process.send({ ready: { url: service.url, token: service.adminToken } });
