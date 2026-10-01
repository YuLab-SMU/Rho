/** Executable components for an ordinary plugin document. No Studio or Host internals. */
import type { JsonValue, VisualDocument, VisualAction, VisualDataSource, CustomComponent } from '../plugin-protocol/index.js';
import { parseVisualDocument, visualBindingValue, visualConditionMatches } from './visual-document.js';
import { readResource, isResourceReference, type ResourceReader } from './resources.js';

export interface VisualEventContext {
  node: string;
  event: 'click' | 'submit' | 'change' | 'select';
  /** One explicit gesture; retain this identity with the original caller before invoking. */
  requestId: string;
  value: JsonValue;
  values: Record<string, JsonValue>;
}
export interface VisualCustomInstance {
  update(properties: Record<string, JsonValue>): void;
  dispose(): void;
}
export interface VisualCustomRegistration {
  source: string;
  export: string;
  mount(element: HTMLElement, declaration: CustomComponent): VisualCustomInstance;
}
export interface VisualRuntimeOptions {
  reader: ResourceReader;
  /** These callbacks own durable intent/receipt handling and public SDK writes.
   * Rendering never invents a second Operation journal or automatically replays. */
  action?: (action: Exclude<VisualAction, { kind: 'refresh' }>, context: VisualEventContext) => Promise<void>;
  /** Provider-specific read observation adapter. Must return its cleanup synchronously.
   * Values have the same shape as query results. There is no implicit polling. */
  subscribe?: (source: VisualDataSource, receive: (value: JsonValue) => void, fail: (error: unknown) => void) => () => void;
  components?: Record<string, VisualCustomRegistration>;
  /** Named, compiled CSS values; declaration values select keys, never arbitrary CSS. */
  tokens?: Record<string, string>;
  onError?: (error: unknown, location: string) => void;
}
const display = (value: unknown) => value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const styleProperties: Record<string, string> = { gap: 'gap', padding: 'padding', color: 'color', background: 'background-color', font_size: 'font-size', border_radius: 'border-radius' };
const own = (object: object, key: string): unknown => Object.prototype.hasOwnProperty.call(object, key) ? (object as Record<string, unknown>)[key] : undefined;
const object = (value: unknown): value is Record<string, JsonValue> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Mount a validated declaration in an owned empty container. Keep this handle for
 * refresh/disposal. Replacing a declaration is an explicit dispose + mount. */
export function mountVisualDocument(container: HTMLElement, input: VisualDocument, options: VisualRuntimeOptions) {
  const document = parseVisualDocument(JSON.stringify(input));
  for (const [id, source] of Object.entries(document.data_sources))
    if (source.subscribe && !options.subscribe) throw Error(`Data source ${id} requires an explicit observation subscription adapter.`);
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind !== 'custom') continue;
    const declared = document.components[node.component!], registered = options.components && own(options.components, node.component!) as VisualCustomRegistration | undefined;
    if (!registered || registered.source !== declared.source || registered.export !== declared.export)
      throw Error(`Custom component ${id} has no matching compiled registration.`);
  }
  if (container.childNodes.length) throw Error('Visual runtime requires an empty owned container.');
  const dom = container.ownerDocument, values: Record<string, JsonValue> = Object.create(null);
  const generations = new Map<string, number>(), cleanups: (() => void)[] = [], updates: (() => void)[] = [];
  let disposed = false, busy = false;
  // Large valid declarations must not exhaust the public channel's pending quota.
  let activeReads = 0;
  const queuedReads: { start(): void; reject(error: Error): void }[] = [];
  const drain = () => {
    while (queuedReads.length && (disposed || activeReads < 8)) {
      const next = queuedReads.shift()!;
      if (disposed) next.reject(Error('Visual runtime is disposed.'));
      else { activeReads++; next.start(); }
    }
  };
  const reader: ResourceReader = { query: <T>(capability: Parameters<ResourceReader['query']>[0], arguments_: JsonValue) => new Promise<T>((resolve, reject) => {
    queuedReads.push({ reject, start: () => {
      void Promise.resolve().then(() => { if (disposed) throw Error('Visual runtime is disposed.'); return options.reader.query<T>(capability, arguments_); }).then(resolve, reject).finally(() => { activeReads--; drain(); });
    } }); drain();
  }) };
  const content = dom.createElement('div'), diagnostic = dom.createElement('output');
  diagnostic.setAttribute('role', 'alert'); diagnostic.hidden = true;
  container.append(content, diagnostic);
  const error = (failure: unknown, location: string) => {
    if (disposed) return;
    diagnostic.hidden = false; diagnostic.textContent = `${location}: ${failure instanceof Error ? failure.message : String(failure)}`;
    try { options.onError?.(failure, location); } catch { /* Diagnostics cannot interrupt owned cleanup or create an unhandled action. */ }
  };
  const paint = () => { if (!disposed) for (const update of updates) { try { update(); } catch (e) { error(e, 'Render'); } } };
  const nextGeneration = (id: string) => { const next = (generations.get(id) ?? 0) + 1; generations.set(id, next); return next; };
  const refresh = async (id: string): Promise<void> => {
    if (disposed) throw Error('Visual runtime is disposed.');
    const source = own(document.data_sources, id) as VisualDataSource | undefined;
    if (!source) throw Error(`Unknown data source ${id}.`);
    const generation = nextGeneration(id);
    try {
      const result = await reader.query<JsonValue>(source.capability, structuredClone(source.arguments));
      if (disposed || generations.get(id) !== generation) return;
      values[id] = structuredClone(result); paint();
    } catch (e) { if (!disposed && generations.get(id) === generation) error(e, `Source ${id}`); throw e; }
  };
  const dispatch = async (id: string, event: VisualEventContext['event'], value: JsonValue, native: Event) => {
    if (disposed || busy || !native.isTrusted) return;
    const actions = document.nodes[id].events[event] ?? [];
    if (!actions.length) return;
    busy = true; content.setAttribute('aria-busy', 'true');
    const captured = structuredClone(values), gesture = crypto.randomUUID();
    try {
      for (const [index, action] of actions.entries()) {
        if (disposed) break;
        if (action.kind === 'refresh') await refresh(action.source);
        else {
          if (!options.action) throw Error(`No action adapter for ${action.kind}.`);
          await options.action(structuredClone(action), { node: id, event, value: structuredClone(value), values: structuredClone(captured), requestId: `${gesture}-${index}` });
        }
      }
    } catch (e) { error(e, `Action ${id}.${event}`); }
    finally { busy = false; content.removeAttribute('aria-busy'); }
  };
  function mount(id: string, parent: HTMLElement) {
    const node = document.nodes[id];
    const element = dom.createElement(node.kind === 'button' ? 'button' : node.kind === 'form' ? 'form' : 'div');
    element.dataset.visualNode = id; element.dataset.visualKind = node.kind;
    if (element instanceof HTMLButtonElement) element.type = 'button';
    parent.append(element);
    const props = (): Record<string, JsonValue> => {
      const result = Object.assign(Object.create(null), node.properties);
      for (const [key, binding] of Object.entries(node.bindings)) {
        const value = visualBindingValue(values, binding);
        if (value !== undefined) result[key] = value;
      }
      return result;
    };
    updates.push(() => {
      element.hidden = !!node.visible_when && !visualConditionMatches(values, node.visible_when);
      element.style.display = element.hidden ? 'none' : node.kind === 'container' || node.kind === 'split' ? 'flex' : '';
      const p = props();
      if (element instanceof HTMLButtonElement) element.disabled = p.disabled === true;
      for (const [property, token] of Object.entries(node.style_tokens)) {
        const css = own(styleProperties, property), value = options.tokens && own(options.tokens, token);
        if (typeof css === 'string' && typeof value === 'string') element.style.setProperty(css, value);
      }
    });
    const listen = (type: string, listener: EventListener) => { element.addEventListener(type, listener); cleanups.push(() => element.removeEventListener(type, listener)); };
    const local = (event: Event) => (event.target as Element)?.closest('[data-visual-node]') === element;
    listen('click', event => { if (local(event)) void dispatch(id, 'click', null, event); });
    listen('change', event => {
      if (!local(event)) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)
        void dispatch(id, 'change', target.value, event);
    });
    if (node.kind === 'text' || node.kind === 'button') {
      const label = dom.createElement('span'); element.append(label);
      updates.push(() => { const p = props(); label.textContent = display(p.text ?? p.label); });
    }
    if (node.kind === 'container' || node.kind === 'split') {
      updates.push(() => { element.style.flexDirection = props().direction === 'row' || node.kind === 'split' ? 'row' : 'column'; });
    }
    if (node.kind === 'form') {
      const inputs = new Map<string, HTMLInputElement>();
      const fields = node.properties.fields;
      if (Array.isArray(fields) && fields.length > 128) throw Error(`Form ${id} exceeds the 128-field presentation limit.`);
      if (Array.isArray(fields)) for (const field of fields) {
        if (!object(field) || typeof field.name !== 'string' || inputs.has(field.name)) continue;
        const label = dom.createElement('label'), input = dom.createElement('input');
        label.textContent = display(field.label ?? field.name); input.name = field.name;
        input.type = field.type === 'number' ? 'number' : 'text'; input.value = display(field.value);
        input.required = field.required === true; label.append(input); element.append(label); inputs.set(field.name, input);
      }
      const submit = dom.createElement('button'); submit.type = 'submit'; element.append(submit);
      updates.push(() => { submit.textContent = display(props().submit_label ?? 'Submit'); });
      // requestSubmit() produces a trusted submit event even without a user.
      // Require its originating trusted click/Enter in the same browser task.
      let submitGesture: Event | null = null;
      let clearGesture: ReturnType<typeof setTimeout> | undefined;
      const arm = (event: Event) => {
        if (!event.isTrusted) return;
        submitGesture = event; clearTimeout(clearGesture);
        clearGesture = setTimeout(() => { submitGesture = null; }, 0);
      };
      listen('click', event => { if (event.target === submit) arm(event); });
      listen('keydown', event => { if ((event as KeyboardEvent).key === 'Enter' && local(event)) arm(event); });
      cleanups.push(() => { clearTimeout(clearGesture); submitGesture = null; });
      listen('submit', event => {
        event.preventDefault(); const gesture = submitGesture; submitGesture = null;
        if (!local(event) || !gesture) return;
        const data: Record<string, JsonValue> = Object.create(null); for (const [name, input] of inputs) data[name] = input.value;
        void dispatch(id, 'submit', data, gesture);
      });
    }
    if (node.kind === 'list' || node.kind === 'table') {
      const body = dom.createElement(node.kind === 'list' ? 'ul' : 'table'), notice = dom.createElement('output'); element.append(body, notice);
      let previous = '';
      updates.push(() => {
        const p = props(), rows = Array.isArray(p.items) ? p.items.slice(0, 1000) : [], key = JSON.stringify([rows, p.columns]);
        notice.textContent = Array.isArray(p.items) && p.items.length > 1000 ? `Showing first 1000 of ${p.items.length} rows. ` : '';
        if (node.kind === 'table' && Array.isArray(p.columns) && p.columns.length > 64) notice.textContent += `Showing first 64 of ${p.columns.length} columns.`;
        if (key === previous) return; previous = key; body.replaceChildren();
        const columns = Array.isArray(p.columns) ? p.columns.filter(c => typeof c === 'string').slice(0, 64) as string[] : [];
        if (node.kind === 'table' && columns.length) {
          const header = dom.createElement('tr'); for (const column of columns) { const cell = dom.createElement('th'); cell.textContent = column; header.append(cell); } body.append(header);
        }
        for (const [index, row] of rows.entries()) {
          const line = dom.createElement(node.kind === 'list' ? 'li' : 'tr');
          const cell = node.kind === 'list' ? line : dom.createElement('td'), button = dom.createElement('button');
          button.type = 'button'; button.textContent = display(object(row) ? row.label ?? row : row);
          button.onclick = event => { event.stopPropagation(); void dispatch(id, 'select', { index, item: row }, event); };
          if (node.kind === 'table' && columns.length) {
            for (const [index, column] of columns.entries()) { const td = dom.createElement('td'); if (!index) { button.textContent = display(object(row) ? own(row, column) : row); td.append(button); } else td.textContent = display(object(row) ? own(row, column) : undefined); line.append(td); }
          } else { cell.append(button); if (cell !== line) line.append(cell); }
          body.append(line);
        }
      });
    }
    if (node.kind === 'media') {
      const img = dom.createElement('img'); element.append(img);
      let reference = '', url: string | undefined, abort: AbortController | undefined;
      const clear = () => { abort?.abort(); if (url) URL.revokeObjectURL(url); url = undefined; img.removeAttribute('src'); };
      cleanups.push(clear);
      updates.push(() => {
        const p = props(); img.alt = display(p.alt); const key = JSON.stringify(p.resource);
        if (key === reference) return; reference = key; clear();
        if (p.resource === undefined || p.resource === null) return;
        if (!isResourceReference(p.resource) || !['image/png', 'image/jpeg'].includes(p.resource.media_type)) throw Error(`Media ${id} requires a PNG/JPEG resource reference.`);
        const resource = p.resource, controller = new AbortController(); abort = controller;
        void readResource(reader, resource, { signal: controller.signal }).then(bytes => {
          if (disposed || controller.signal.aborted) return;
          url = URL.createObjectURL(new Blob([bytes], { type: resource.media_type })); img.src = url;
        }).catch(e => { if (!controller.signal.aborted) error(e, `Media ${id}`); });
      });
    }
    if (node.kind === 'custom') {
      const registration = options.components![node.component!], instance = registration.mount(element, structuredClone(document.components[node.component!]));
      cleanups.push(() => instance.dispose()); updates.push(() => instance.update(structuredClone(props())));
    }
    if (node.kind === 'tabs') {
      const bar = dom.createElement('div'); bar.setAttribute('role', 'tablist'); element.append(bar);
      const panels: HTMLElement[] = [], buttons: HTMLButtonElement[] = []; let selected = 0;
      const select = (index: number) => { selected = index; panels.forEach((p, i) => p.hidden = i !== selected); buttons.forEach((b, i) => { b.setAttribute('aria-selected', String(i === selected)); b.tabIndex = i === selected ? 0 : -1; }); };
      node.children.forEach((child, index) => {
        const panel = dom.createElement('div'), button = dom.createElement('button');
        panel.setAttribute('role', 'tabpanel'); panel.id = `visual-${crypto.randomUUID()}`;
        button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
        button.id = `visual-${crypto.randomUUID()}`; panel.setAttribute('aria-labelledby', button.id);
        button.textContent = display(document.nodes[child].properties.label ?? child);
        button.onclick = event => { event.stopPropagation(); select(index); void dispatch(id, 'select', child, event); };
        button.onkeydown = event => { const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : -1; if (next >= 0) { event.preventDefault(); select(next); buttons[next].focus(); void dispatch(id, 'select', node.children[next], event); } };
        bar.append(button); element.append(panel); panels.push(panel); buttons.push(button); mount(child, panel);
      }); select(0);
    } else for (const child of node.children) mount(child, element);
  }
  const dispose = () => {
    if (disposed) return; disposed = true; drain();
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch (e) { try { options.onError?.(e, 'Dispose'); } catch { /* Continue releasing the other instances. */ } } }
    content.remove(); diagnostic.remove();
  };
  try { mount(document.root, content); paint(); } catch (e) { dispose(); throw e; }
  // Start each query before attaching the observer; later observation delivery wins
  // over an outstanding initial read. Cleanup prevents callbacks after disposal.
  const reads = Object.keys(document.data_sources).map(id => refresh(id));
  try {
    for (const [id, source] of Object.entries(document.data_sources)) if (source.subscribe) {
      cleanups.push(options.subscribe!(structuredClone(source), value => {
        if (disposed) return; nextGeneration(id); values[id] = structuredClone(value); paint();
      }, failure => { nextGeneration(id); error(failure, `Subscription ${id}`); }));
    }
  } catch (e) { dispose(); void Promise.allSettled(reads); throw e; }
  return { ready: Promise.allSettled(reads), refresh, dispose };
}
