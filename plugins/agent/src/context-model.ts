import type { AgentContextSelection, ComponentAgentRun, ComponentSourceSnapshot } from '../sdk/index.js';
import type { CapabilityKey, ContextContribution, ContextPage, ContextPreview, ContextReference,
  InstanceRef, JsonValue, PluginInspection, PluginInstanceObservations } from '../public/plugin-protocol/index.js';
import { type Client, json, same } from './operations.js';

export interface Inclusion { title: string; value: JsonValue; }
export interface ContextSource { provider: InstanceRef; title: string; contribution: ContextContribution; inclusions: Inclusion[]; }
export interface CapturedContext { selection: AgentContextSelection; title: string; description: string; text: string; data: JsonValue; images?: JsonValue[]; }
export interface CapturedHistory {
  kind: 'conversation' | 'continuation'; truncated: boolean; notice: string;
  previous_run_id?: string; recovery?: JsonValue; tools?: JsonValue[]; tools_truncated?: boolean;
  prior_sources?: ComponentSourceSnapshot[]; prior_sources_truncated?: boolean;
  turns: { run_id: string; state: string; user_text: string; assistant_text: string;
    history_gap: boolean; text_truncated: boolean; references: JsonValue[]; references_truncated: boolean }[];
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function contextInputIssue(preview: ContextPreview): string | null {
  if (preview.truncated) return 'Choose a complete text and image inclusion before adding.';
  if (preview.resources.length > 2 || preview.resources.some(resource => !resource ||
    !same(resource.owner, preview.item?.reference?.provider) || !['image/png', 'image/jpeg'].includes(resource.media_type) ||
    !Number.isSafeInteger(resource.bytes) || resource.bytes < 1 || resource.bytes > 2 * 1024 * 1024 ||
    typeof resource.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(resource.digest)))
    return 'Choose complete text or up to two PNG/JPEG images, each at most 2 MiB.';
  return null;
}

/** Owners declare finite inclusion values in their public query schema. Never
 * infer document/selection semantics from a plugin name or source kind. */
export function inclusionChoices(input: unknown): Inclusion[] {
  const root = object(object(input)?.properties), inclusion = object(root?.inclusion);
  const variants = inclusion?.oneOf ?? inclusion?.anyOf ?? (inclusion ? [inclusion] : []);
  if (!Array.isArray(variants) || variants.length > 20) return [];
  return variants.flatMap(value => {
    const variant = object(value);
    if (!variant || typeof variant.title !== 'string' || !variant.title.trim()) return [];
    let capture: unknown;
    if (Object.hasOwn(variant, 'const')) capture = variant.const;
    else {
      const properties = object(variant.properties);
      if (variant.type !== 'object' || !properties || !Array.isArray(variant.required) || !variant.required.length ||
        !variant.required.every(key => typeof key === 'string' && object(properties[key]) && Object.hasOwn(properties[key] as object, 'const')) ||
        Object.values(properties).some(property => !object(property) || !Object.hasOwn(property as object, 'const'))) return [];
      capture = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, object(property)!.const]));
    }
    if (capture === undefined || bytes(JSON.stringify(capture)) > 4096) return [];
    return [{ title: variant.title, value: json(capture) }];
  });
}

export class ContextPicker {
  sources: ContextSource[] = [];
  nextInstances: string | null = null;
  notices: string[] = [];
  private cursors = new Set<string>();
  private discovery = 0;
  constructor(private client: Client) {}
  private async read<T>(capability: CapabilityKey, arguments_: unknown, complete = true) {
    const result = await this.client.query<{ status: string; completeness: string; data: T }>(capability, json(arguments_));
    if (result.status !== 'ready' || complete && result.completeness !== 'complete' || !result.data)
      throw Error('This source is not fully available. The draft is retained.');
    return result;
  }
  private async inspect(provider: InstanceRef) {
    const { data } = await this.read<PluginInspection>({ id: 'plugins.inspect', version: 1 }, { revision: provider.revision });
    if (data.summary.revision !== provider.revision || data.manifest.id !== provider.plugin || !data.artifacts.some(a => a.id === provider.artifact))
      throw Error('The source differs from its selected plugin version.');
    return data;
  }
  private source(provider: InstanceRef, inspection: PluginInspection, contribution: ContextContribution): ContextSource {
    const search = inspection.manifest.capabilities.find(c => same(c.capability, contribution.search) && c.kind === 'query');
    const preview = inspection.manifest.capabilities.find(c => same(c.capability, contribution.preview) && c.kind === 'query');
    if (!search || !preview) throw Error('This source does not declare readable search and preview queries.');
    return { provider: structuredClone(provider), title: contribution.title, contribution: structuredClone(contribution), inclusions: inclusionChoices(preview.input_schema) };
  }
  async discover(more = false) {
    if (more && !this.nextInstances) return;
    if (!more) { this.discovery++; this.sources = []; this.notices = []; this.nextInstances = null; this.cursors.clear(); }
    const discovery = this.discovery;
    const after = more ? this.nextInstances : null;
    const { data } = await this.read<PluginInstanceObservations>({ id: 'plugins.instances', version: 1 }, { after, limit: 20, include_previews: false });
    if (discovery !== this.discovery) return;
    if (!Array.isArray(data.instances) || data.instances.length > 20 || data.next && (data.next === after || this.cursors.has(data.next)))
      throw Error('The source listing did not return a bounded next page.');
    if (data.next) this.cursors.add(data.next);
    this.nextInstances = data.next;
    for (const observation of data.instances) {
      const instance = observation.instance;
      if (!observation.observed_in_this_host || instance.project !== this.client.view.project || instance.state !== 'active' || instance.purpose === 'fixture_preview') continue;
      try {
        const inspection = await this.inspect(instance.identity);
        if (discovery !== this.discovery) return;
        for (const contribution of inspection.manifest.contexts) {
          const source = this.source(instance.identity, inspection, contribution);
          if (!this.sources.some(old => same(old.provider, source.provider) && old.contribution.id === contribution.id)) this.sources.push(source);
        }
      } catch (error) { if (discovery === this.discovery) this.notices.push(`${instance.alias}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  private arguments(source: ContextSource, capability: CapabilityKey, args: unknown) {
    return { binding: { project: this.client.view.project, provider: source.provider, capability, target: null }, arguments: args, preconditions: null };
  }
  async search(source: ContextSource, text: string, after: JsonValue | null = null): Promise<ContextPage> {
    if (bytes(text) > 1024) throw Error('Shorten this search to 1 KiB.');
    const args = { window: this.client.view.window, text, after, limit: 20 };
    const { data, completeness } = await this.read<ContextPage>(source.contribution.search, this.arguments(source, source.contribution.search, args), false);
    if (!Array.isArray(data.items) || data.items.length > 20 || !Array.isArray(data.notices) ||
      data.items.some(item => !same(item.reference.provider, source.provider) || item.reference.contribution !== source.contribution.id || item.reference.window !== args.window) ||
      data.next !== null && same(data.next, after)) throw Error('The source returned a different or unbounded selection.');
    return { ...data, notices: [...data.notices, ...(completeness === 'complete' ? [] : ['Partial source listing'])] };
  }
  async preview(source: ContextSource, reference: ContextReference, inclusion: JsonValue): Promise<ContextPreview> {
    if (!same(reference.provider, source.provider) || reference.contribution !== source.contribution.id)
      throw Error('The context reference belongs to another source.');
    if (!source.inclusions.some(choice => same(choice.value, inclusion))) throw Error('This inclusion is not declared by the source.');
    const args = { reference: structuredClone(reference), inclusion: structuredClone(inclusion), max_bytes: 16384 };
    const { data } = await this.read<ContextPreview>(source.contribution.preview, this.arguments(source, source.contribution.preview, args));
    if (!same(data.item.reference, reference) || typeof data.text !== 'string' || bytes(data.text) > 16384 ||
      typeof data.truncated !== 'boolean' || !Array.isArray(data.resources)) throw Error('The preview differs from the selected source.');
    return data;
  }
  async imagePreviews(preview: ContextPreview): Promise<Blob[]> {
    const issue = contextInputIssue(preview); if (issue) throw Error(issue);
    const images: Blob[] = [];
    for (const reference of preview.resources) {
      const bytes = new Uint8Array(reference.bytes); let offset = 0;
      while (offset < bytes.length) {
        const { data } = await this.read<{ reference: unknown; offset: number; base64: string; next: number | null }>({ id: 'resources.read', version: 1 }, { reference, offset, limit: 65536 });
        const expected = Math.min(65536, bytes.length - offset), end = offset + expected;
        if (!same(data.reference, reference) || data.offset !== offset || data.next !== (end < bytes.length ? end : null) || typeof data.base64 !== 'string' || data.base64.length > Math.ceil(expected / 3) * 4)
          throw Error('The image preview differs from its selected source.');
        const part = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
        if (part.length !== expected) throw Error('The image preview is incomplete.');
        bytes.set(part, offset); offset = end;
      }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      if ('sha256:' + digest !== reference.digest) throw Error('The image preview failed its content check.');
      images.push(new Blob([bytes], { type: reference.media_type }));
    }
    return images;
  }
  async retained(selection: AgentContextSelection) {
    if (selection.source !== 'plugin') throw Error('This saved source is not available in the plugin picker.');
    const reference = selection.reference as ContextReference;
    if (!reference?.provider || typeof reference.contribution !== 'string') throw Error('The saved source reference is incomplete.');
    const inspected = await this.inspect(reference.provider);
    const contribution = inspected.manifest.contexts.find(c => c.id === reference.contribution);
    if (!contribution) throw Error('The selected version no longer declares this source.');
    const source = this.source(reference.provider, inspected, contribution), inclusion = JSON.parse(selection.inclusion) as JsonValue;
    return { source, inclusion, preview: await this.preview(source, reference, inclusion) };
  }
  async original(task: string, request: string): Promise<CapturedContext[]> {
    const capability = { id: 'agent.native.context', version: 1 };
    const { data } = await this.read<{ request_id: string; task_id: string; contexts: CapturedContext[] }>(capability, {
      binding: { project: this.client.view.project, provider: this.client.view.instance, capability, target: null },
      arguments: { request_id: request }, preconditions: null,
    });
    if (data.request_id !== request || data.task_id !== task || !Array.isArray(data.contexts) || data.contexts.length > 20 || bytes(JSON.stringify(data.contexts)) > 65536 ||
      data.contexts.some(value => typeof value.title !== 'string' || typeof value.description !== 'string' || typeof value.text !== 'string' || bytes(value.text) > 16384 || !value.selection))
      throw Error('The saved context does not match this original message.');
    return data.contexts;
  }
  async originalRho(task: string, run: string): Promise<{ sources: CapturedContext[]; history: CapturedHistory | null }> {
    const capability = { id: 'agent.model.run.get', version: 1 };
    const { data } = await this.read<ComponentAgentRun>(capability, {
      binding: { project: this.client.view.project, provider: this.client.view.instance, capability, target: null },
      arguments: { run_id: run }, preconditions: null,
    });
    const sources = data.context?.sources ?? [], history = data.context?.history;
    const references = data.request.sources ?? [], assets = data.request.assets ?? [];
    const attachments = sources.slice(references.length);
    if (data.run_id !== run || data.request.conversation_id !== task || !Array.isArray(sources) || sources.length > 16 || bytes(JSON.stringify(data.context ?? null)) > 65536 ||
      sources.length !== references.length + assets.length || !same(sources.slice(0, references.length).map(value => value.selection), references) ||
      sources.some((value, index) => value.truncated || typeof value.text !== 'string' || bytes(value.text) > (index < references.length ? 16384 : 32768)) ||
      attachments.some((source, index) => {
        const evidence = source.evidence?.[0];
        if (source.evidence?.length !== 1 || evidence?.kind !== 'attachment') return true;
        const asset = evidence.asset, image = ['image/png', 'image/jpeg'].includes(asset.mime_type);
        return evidence.conversation_id !== task || asset.asset_id !== assets[index] || source.title !== asset.name ||
          source.selection.source !== 'attachments' || source.selection.label !== asset.name ||
          source.selection.inclusion !== (image ? 'image' : 'text') || (!image && asset.mime_type !== 'text/plain') ||
          !same(source.selection.reference, { conversation_id: task, asset_id: asset.asset_id, sha256: asset.sha256 });
      }))
      throw Error('The saved context does not match this original Rho message.');
    if (history !== null && history !== undefined) {
      const value = object(history);
      if (!value || !['conversation', 'continuation'].includes(String(value.kind)) || typeof value.truncated !== 'boolean' || typeof value.notice !== 'string' ||
        bytes(JSON.stringify(history)) > (value.kind === 'continuation' ? 49152 : 24576) || !Array.isArray(value.turns) || value.turns.length > 8 ||
        value.turns.some(turn => !object(turn) || typeof turn.run_id !== 'string' || typeof turn.state !== 'string' ||
          typeof turn.user_text !== 'string' || bytes(turn.user_text) > 2048 || typeof turn.assistant_text !== 'string' || bytes(turn.assistant_text) > 4096 ||
          typeof turn.history_gap !== 'boolean' || typeof turn.text_truncated !== 'boolean' || typeof turn.references_truncated !== 'boolean' ||
          !Array.isArray(turn.references) || turn.references.length > 8))
        throw Error('The retained conversation input is incomplete or exceeds its bounds.');
      if (value.kind === 'continuation' && (typeof value.previous_run_id !== 'string' || value.previous_run_id !== data.request.continuation?.run_id || !object(value.recovery) || object(value.recovery)?.digest !== data.request.continuation?.recovery_digest ||
        !Array.isArray(value.tools) || value.tools.length > 16 || typeof value.tools_truncated !== 'boolean' ||
        !Array.isArray(value.prior_sources) || value.prior_sources.length > 16 || typeof value.prior_sources_truncated !== 'boolean' ||
        value.prior_sources.some(source => !object(source) || !source.selection || typeof source.title !== 'string' || typeof source.description !== 'string' || typeof source.text !== 'string' || bytes(source.text) > (object(source.selection)?.source === 'attachments' ? 32768 : 16384) || source.truncated !== false)))
        throw Error('The retained continuation does not match its original task.');
    }
    return { sources: sources.map(({ selection, title, description, text, native_data }) => ({ selection, title, description, text, data: native_data })), history: (history ?? null) as CapturedHistory | null };
  }
  selection(source: ContextSource, preview: ContextPreview, inclusion: JsonValue): AgentContextSelection {
    const issue = contextInputIssue(preview); if (issue) throw Error(issue);
    if (!same(preview.item.reference.provider, source.provider) || preview.item.reference.contribution !== source.contribution.id || !source.inclusions.some(i => same(i.value, inclusion)))
      throw Error('Preview this exact source and inclusion before adding it.');
    return { source: 'plugin', label: `${source.title} · ${preview.item.title}`, reference: json(structuredClone(preview.item.reference)), inclusion: JSON.stringify(inclusion) };
  }
}
