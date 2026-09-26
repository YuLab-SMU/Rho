import type { InstanceRef, PluginInspection, PluginInstanceObservations } from '../public/plugin-protocol/index.js';
import { type Client, json, same } from './operations.js';
import { validProvider } from './r-actions.js';
import { bytes } from './text.js';

export interface SessionChoice { provider: InstanceRef; label: string; state: string; session: string | null; }
export interface SessionPage { items: SessionChoice[]; next: string | null; }
const token = (value: unknown): value is string => typeof value === 'string' && !!value && bytes(value).length <= 160 && !value.includes('\0');
export async function observeSession(client: Client, provider: InstanceRef): Promise<{ state: string; session: string | null }> {
  if (!validProvider(provider)) throw new Error('The selected R provider has no exact identity.');
  const reply = await client.query<{ status: string; data?: { state?: unknown; session_id?: unknown } }>({ id: 'r.session', version: 1 },
    json({ binding: { capability: { id: 'r.session', version: 1 }, provider, project: client.view.project, target: null }, arguments: {} }));
  const state = reply.data?.state, session = reply.data?.session_id;
  if (reply.status !== 'ready' || !token(state) || !(session === null || token(session))) throw new Error('The selected R session could not be observed.');
  return { state, session };
}
/** One bounded catalog page. Only active exact instances advertising the R
 * contracts are observed; none is activated, started, resumed or evaluated. */
export async function readSessions(client: Client, after: string | null = null): Promise<SessionPage> {
  const reply = await client.query<{ status: string; data?: PluginInstanceObservations }>({ id: 'plugins.instances', version: 1 }, { after, limit: 20 });
  const page = reply.data;
  if (reply.status !== 'ready' || !page || !Array.isArray(page.instances) || page.instances.length > 20 ||
    !(page.next === null || token(page.next) && page.next !== after)) throw new Error('The session catalog is unavailable or incomplete.');
  const items: SessionChoice[] = [], inspected = new Map<string, PluginInspection>();
  for (const observed of page.instances) {
    const instance = observed?.instance;
    if (!instance || instance.project !== client.view.project || instance.principal !== client.view.principal || !validProvider(instance.identity) || !token(instance.alias))
      throw new Error('The session catalog contains another project or an invalid instance.');
    if (!observed.observed_in_this_host || instance.state !== 'active') continue;
    const identity = instance.identity;
    let inspection = inspected.get(identity.revision);
    if (!inspection) {
      const result = await client.query<{ status: string; data?: PluginInspection }>({ id: 'plugins.inspect', version: 1 }, { revision: identity.revision });
      inspection = result.data;
      if (result.status !== 'ready' || !inspection || inspection.summary.revision !== identity.revision || inspection.manifest.id !== identity.plugin || !Array.isArray(inspection.manifest.capabilities))
        throw new Error('An exact provider revision could not be inspected.');
      inspected.set(identity.revision, inspection);
    }
    if (inspection.manifest.id !== identity.plugin) throw new Error('The provider identity differs from its inspected revision.');
    if (![{ id: 'r.session', version: 1, kind: 'query' }, { id: 'r.execute', version: 2, kind: 'operation' }, { id: 'r.format', version: 1, kind: 'operation' }].every(required =>
      inspection.manifest.capabilities.some(item => same(item.capability, { id: required.id, version: required.version }) && item.kind === required.kind))) continue;
    try { items.push({ provider: structuredClone(identity), label: instance.alias, ...await observeSession(client, identity) }); }
    catch { items.push({ provider: structuredClone(identity), label: instance.alias, state: 'unavailable', session: null }); }
  }
  return { items, next: page.next };
}
