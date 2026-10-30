// What a file the Agent writes holds, while the work goes on: facts read from the file at once,
// then one sentence from a model. Facts are observed from the bytes; the sentence is generated
// and says which version it read, which model wrote it, what it was given and what it cost.
// A figure is shown to a model that models.dev lists as taking images; another model is given
// what made the figure instead. The person can switch the sentences off; the facts stay.
// Neither checks the work.
//
// The protected resources are the person's model budget, the service's disk reads and the
// message record. While a message runs, its project is compared with the start every
// `everyMs`; a file is read once it has rested `settleMs`, and at most `maxFactBytes` of it
// for facts; a file larger than `maxDigestBytes` is not read at all, and a figure larger than
// `maxImageBytes` is described from what made it. A message describes at most `maxPerMessage` files, and asks the model at most
// `maxCalls` times, a file again no sooner than `againMs` unless the message has ended. Past a
// limit the file keeps the facts it has, or is counted as not described. A sentence is kept
// for a later version whose facts are the same; the model is asked again when they change.
export const describeLimits = { everyMs: 5000, settleMs: 2000, againMs: 60000, maxPerMessage: 24, maxCalls: 24, maxFactBytes: 4 * 1024 * 1024, maxDigestBytes: 256 * 1024 * 1024, maxImageBytes: 3.5 * 1024 * 1024, excerptBytes: 4096, maxFactChars: 400 };

// How the model was given the file: its first lines, the image itself, or what made it.
export type Strategy = 'text' | 'image' | 'context';
// One call's cost: Claude Code's own figure when it knows the model's price, an estimate from
// models.dev's listed price, or unknown; `note` says which.
export interface Cost { usd: number | null; basis: 'reported' | 'estimated' | 'unknown'; note: string }
// `from`: the files whose lines a model was given for a figure it was not shown; `why`: why it
// was not shown the figure.
export interface Sentence { text: string; version: string; model: string | null; at: string; facts?: string; strategy?: Strategy; from?: string[]; why?: string; cost?: Cost }
// What a message's descriptions spent: model calls, the dollars known, and how many of those
// calls were estimated or are not known.
export interface Spend { calls: number; usd: number; estimated: number; unknown: number }
export const addSpend = (spend: Spend | undefined, cost: Cost | null): Spend => {
  const s = spend ?? { calls: 0, usd: 0, estimated: 0, unknown: 0 };
  return { calls: s.calls + 1, usd: s.usd + (cost?.usd ?? 0), estimated: s.estimated + (cost?.basis === 'estimated' ? 1 : 0), unknown: s.unknown + (!cost || cost.usd === null ? 1 : 0) };
};
export const raster = (file: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const)[file.split('.').at(-1)!.toLowerCase() as 'png'] ?? null;

export interface FileDescription {
  path: string;
  // The version these facts were read from: the digest of the whole file.
  version: string; bytes: number; modifiedAt: string; observedAt: string;
  facts: string; partial?: boolean;
  // The model's sentence, the version it read, which may be earlier than `version`, the facts
  // it was given, how it was given the file (and from which files, for a figure it did not
  // see), and what the call cost.
  sentence: Sentence | null;
  state: 'describing' | 'described' | 'facts' | 'failed' | 'unknown';
  reason?: string;
}

// Files worth describing: the kinds a person reads, not Rho's notes or anything private.
export const describable = (file: string) => /\.(?:R|r|Rmd|qmd|py|jl|sh|sql|md|txt|json|csv|tsv|png|jpe?g|gif|svg|pdf|html|ya?ml|toml|log)$/.test(file);

const languages: Record<string, string> = { py: 'Python script', r: 'R script', rmd: 'R Markdown document', qmd: 'Quarto document', jl: 'Julia script', sh: 'Shell script', sql: 'SQL script' };
const size = (bytes: number) => bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB' : (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
const count = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

// A delimited line's fields, honouring double quotes.
function fields(line: string, delimiter: string) {
  const out: string[] = []; let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) { if (c === '"' && line[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true; else if (c === delimiter) { out.push(field); field = ''; } else field += c;
  }
  out.push(field);
  return out.map(f => f.trim());
}
const lineCount = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;

function imageSize(ext: string, data: Buffer): [number, number] | null {
  if (ext === 'png' && data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (ext === 'gif' && data.length >= 10 && data.toString('latin1', 0, 4) === 'GIF8') return [data.readUInt16LE(6), data.readUInt16LE(8)];
  if ((ext === 'jpg' || ext === 'jpeg') && data[0] === 0xff && data[1] === 0xd8) {
    for (let i = 2; i + 9 < data.length;) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
      i += 2 + data.readUInt16BE(i + 2);
    }
  }
  if (ext === 'svg') {
    const tag = /<svg\b[^>]*>/i.exec(data.toString('utf8', 0, Math.min(data.length, 8192)))?.[0] ?? '';
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)`, 'i').exec(tag)?.[1];
    const box = /\bviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    const w = attr('width') ?? box?.[1], h = attr('height') ?? box?.[2];
    if (w && h) return [Math.round(Number(w)), Math.round(Number(h))];
  }
  return null;
}

// Facts read from a file's first bytes, or all of it when it fits: what kind of file, its
// size and shape, and for text its first lines for a model to read. Nothing is interpreted.
export function fileFacts(file: string, data: Buffer, total: number) {
  const ext = file.split('.').at(-1)!.toLowerCase(), partial = data.length < total;
  const at = (n: number) => partial ? 'at least ' + n : String(n);
  const text = () => data.toString('utf8').replace(/�+$/, '');
  const excerpt = (body: string, lines = 40) => { const head = body.slice(0, describeLimits.excerptBytes).split('\n').slice(0, lines); return head.join('\n'); };
  let facts: string, textual = true, body = '';
  if (ext === 'csv' || ext === 'tsv') {
    body = text();
    const lines = body.split('\n').filter(l => l.trim()), names = lines.length ? fields(lines[0]!.replace(/\r$/, ''), ext === 'tsv' ? '\t' : ',') : [];
    const shown = names.slice(0, 8).map(n => clip(n || '(unnamed)', 24)).join(', ') + (names.length > 8 ? `, … (${names.length - 8} more)` : '');
    facts = `${partial ? 'at least ' : ''}${count(Math.max(0, lines.length - 1), 'row')} × ${count(names.length, 'column')}${names.length ? ': ' + shown : ''}`;
  } else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) {
    const dims = imageSize(ext, data); textual = false;
    facts = `${ext === 'jpg' ? 'JPEG' : ext.toUpperCase()} image${dims ? `, ${dims[0]} × ${dims[1]} px` : ''}, ${size(total)}`;
  } else if (ext === 'pdf') {
    textual = false;
    const pages = (data.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    facts = `PDF${pages ? ', ' + at(pages) + (pages === 1 && !partial ? ' page' : ' pages') : ''}, ${size(total)}`;
  } else if (ext === 'json') {
    body = text();
    let shape = '';
    if (!partial) try {
      const value = JSON.parse(body);
      shape = Array.isArray(value) ? `array of ${count(value.length, 'item')}${value[0] && typeof value[0] === 'object' && !Array.isArray(value[0]) ? ' with keys ' + Object.keys(value[0]).slice(0, 8).join(', ') : ''}`
        : value && typeof value === 'object' ? 'object with keys ' + Object.keys(value).slice(0, 8).join(', ') + (Object.keys(value).length > 8 ? ', …' : '') : typeof value;
    } catch { shape = 'not valid JSON'; }
    facts = `JSON${shape ? ' ' + shape : ''}, ${size(total)}`;
  } else if (['md', 'rmd', 'qmd', 'txt', 'log', 'html'].includes(ext) && !languages[ext]) {
    body = text();
    const heading = ext === 'md' ? /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] : undefined;
    facts = `${ext === 'md' ? 'Markdown' : ext === 'html' ? 'HTML' : 'Text'}, ${at(lineCount(body))} lines${heading ? `; first heading “${clip(heading, 60)}”` : ''}`;
  } else if (languages[ext]) {
    body = text();
    const functions = ext === 'py' ? (body.match(/^\s*def\s+\w+/gm) ?? []).length : ext === 'r' ? (body.match(/[\w.]+\s*(?:<-|=)\s*function\s*\(/g) ?? []).length : 0;
    facts = `${languages[ext]}, ${at(lineCount(body))} lines${functions ? ', ' + count(functions, 'function') : ''}`;
  } else {
    body = text();
    facts = `${ext.toUpperCase()} file, ${at(lineCount(body))} lines, ${size(total)}`;
  }
  return { facts: clip(facts, describeLimits.maxFactChars), partial, textual, excerpt: textual ? excerpt(body) : '' };
}

// The newest description of each file across messages, newest message last in `turns`.
export function describedFiles(turns: Array<{ conversationId: string; turn: { id: string; descriptions?: FileDescription[] } }>) {
  const out = new Map<string, FileDescription & { conversationId: string; turnId: string }>();
  for (const { conversationId, turn } of turns) for (const d of turn.descriptions ?? []) {
    const seen = out.get(d.path);
    if (!seen || Date.parse(d.observedAt) >= Date.parse(seen.observedAt)) out.set(d.path, { ...d, conversationId, turnId: turn.id });
  }
  return out;
}

export type Described = FileDescription & { conversationId: string; turnId: string };
// What a file holds as a person reads it: the notes' words first, written by the Agent or the
// person; else the model's sentence; else the facts. Each says where it comes from. At a past
// moment only what had been read or written by then counts.
export interface Holds {
  text: string; source: 'notes' | 'model' | 'facts';
  // The facts read from the file, whichever text leads.
  facts?: string;
  // The model that wrote the sentence and when, and whether it read an earlier version whose
  // facts differ from those shown; and whether a sentence is being written now.
  model?: string | null; at?: number; earlier?: boolean; writing?: boolean;
  // How the model was given the file, and what the sentence cost.
  strategy?: Strategy; from?: string[]; why?: string; cost?: Cost;
}
export function holdsOf(path: string, notes: Map<string, { text: string }>, described: Map<string, Described>, at: number | null = null): Holds | undefined {
  const said = notes.get(path), seen = described.get(path), d = seen && (at === null || Date.parse(seen.observedAt) <= at) ? seen : undefined;
  const sentence = d?.sentence && (at === null || Date.parse(d.sentence.at) <= at) ? d.sentence : null;
  const writing = at === null && d?.state === 'describing';
  if (said) return { text: said.text, source: 'notes', ...(d ? { facts: d.facts } : {}) };
  if (sentence) return { text: sentence.text, source: 'model', facts: d!.facts, model: sentence.model, at: Date.parse(sentence.at), earlier: sentence.version !== d!.version && sentence.facts !== d!.facts, writing,
    ...(sentence.strategy ? { strategy: sentence.strategy } : {}), ...(sentence.from ? { from: sentence.from } : {}), ...(sentence.why ? { why: sentence.why } : {}), ...(sentence.cost ? { cost: sentence.cost } : {}) };
  if (d) return { text: d.facts, source: 'facts', facts: d.facts, at: Date.parse(d.observedAt), writing };
  return undefined;
}
// A model's name as a person reads it: the provider prefix and context-size marks dropped.
export const modelName = (model: string | null | undefined) => model ? model.replace(/^.*\//, '').replace(/\[[^\]]*\]$/, '') : 'a model';

// What made a figure, for a model that is not shown it: the command that was running when the
// figure was written, the lines of the scripts it ran (or of the command itself) around the
// place that names the figure, and the Agent's last words before it. At most `contextBytes`;
// nothing when the record shows nothing that made it.
export const contextLimits = { contextBytes: 6144, scriptBytes: 262144, before: 25, after: 3, words: 600 };
export interface MadeStep { kind: string; at: string; startedAt?: string; detail?: string; text?: string; toolKind?: string; tool?: string }
export async function figureContext(file: string, modifiedAt: string, steps: MadeStep[], read: (path: string, maxBytes: number) => Promise<string | null>, filesOf: (command: string) => string[]) {
  const written = Date.parse(modifiedAt), base = file.split('/').at(-1)!, stem = base.replace(/\.[^.]+$/, '');
  const commands = steps.filter(s => s.kind === 'tool' && s.detail && (s.toolKind === 'execute' || /^(bash|shell|terminal)$/i.test(s.tool ?? '')));
  const during = commands.filter(s => Date.parse(s.startedAt ?? s.at) <= written + 1000 && written <= Date.parse(s.at) + 2000).at(-1)
    ?? commands.filter(s => Date.parse(s.startedAt ?? s.at) <= written + 1000).at(-1);
  if (!during) return null;
  const command = during.detail!, parts: string[] = [`Made while this command ran: ${command.split('\n')[0]!.slice(0, 300)}`], from: string[] = [];
  // Lines around each place that names the figure, else around the last line that saves a plot.
  const around = (text: string) => {
    const lines = text.split('\n');
    let marks = lines.flatMap((l, i) => l.includes(base) || new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l) ? [i] : []);
    if (!marks.length) marks = lines.flatMap((l, i) => /savefig|ggsave|dev\.off|png\(|pdf\(|jpeg\(|svg\(|write_image|to_file/.test(l) ? [i] : []).slice(-1);
    const keep = new Set<number>();
    for (const m of marks) for (let i = Math.max(0, m - contextLimits.before); i <= Math.min(lines.length - 1, m + contextLimits.after); i++) keep.add(i);
    let last = -2, out = '';
    for (const i of [...keep].sort((a, b) => a - b)) { out += (i !== last + 1 && out ? '…\n' : '') + lines[i] + '\n'; last = i; }
    return out;
  };
  if (command.includes('\n') || command.includes(base)) { const lines = around(command); if (lines) { parts.push('From the command:\n' + lines); from.push('the command'); } }
  for (const script of filesOf(command).filter(p => /\.(?:py|r|R|jl|sh|Rmd|rmd|qmd|m|js|mjs)$/.test(p))) {
    const text = await read(script, contextLimits.scriptBytes);
    const lines = text ? around(text) : '';
    if (lines) { parts.push(`From ${script}:\n` + lines); from.push(script); }
  }
  const said = steps.filter(s => s.kind === 'text' && s.text && Date.parse(s.at) <= written + 1000).at(-1)?.text;
  if (said) parts.push('The Agent said before it: ' + said.slice(-contextLimits.words));
  if (!from.length && !said) return null;
  const context = parts.join('\n');
  return { context: Buffer.byteLength(context) > contextLimits.contextBytes ? Buffer.from(context).subarray(0, contextLimits.contextBytes).toString('utf8').replace(/�+$/, '') + '\n[cut]' : context, from };
}
