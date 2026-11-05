// A process boundary for crashes/timeouts, NOT an OS sandbox. An installed host
// has this user's native permissions. Never send it service credentials.
import { pathToFileURL } from 'node:url';
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 0;
process.on('message', async (message: any) => {
  if (message.type === 'reply') {
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.value);
  }
  if (message.type !== 'start') return;
  try {
    const plugin = await import(pathToFileURL(message.entry).href);
    if (typeof plugin.run !== 'function') throw new Error('The plugin host must export run(operation, input, context).');
    const value = await plugin.run(message.operation, message.input, {
      projectRoot: message.projectRoot,
      invocationId: message.invocationId,
      changeId: (label: string) => 'ext:' + message.invocationId + ':' + String(label).slice(0, 40),
      call: (method: string, body: unknown) => new Promise((resolve, reject) => {
        const id = ++next; pending.set(id, { resolve, reject }); process.send?.({ type: 'call', id, method, body });
      }),
    });
    process.send?.({ type: 'result', value }, () => process.exit(0));
  } catch (error) { process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1)); }
});
