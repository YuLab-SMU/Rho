// What a session's section of the project notes says about its work: the question, the data
// and method, what was found and on which files it rests, the choices taken with what the other
// option gives, what each file holds, and what is left to do. These are statements by whoever
// wrote them; nothing here checks that they are true. Each statement can be traced to the kept
// version of the notes it first appeared in, and the files it names to their versions then.
import { notesSections, type NotesSection } from './project-notes.js';

export type StatementKind = 'question' | 'method' | 'finding' | 'figure' | 'choice' | 'file' | 'todo';
export interface Option { text: string; source: string; links: string[] }
export interface Statement {
  kind: StatementKind; text: string; source: string; line: number; links: string[];
  done?: boolean;
  // A choice: the options not taken, each with what it gives and the files that show it.
  alternatives?: Option[];
  // A figure on the line right after a finding: the index of that finding, which it shows.
  of?: number;
}
export interface SessionMeaning { conversationId: string | null; title: string; line: number; statements: Statement[] }

// The subsections a section keeps, by the names the session is asked to use, with the names a
// person or an Agent writing in another language tends to give them.
const parts: Array<[StatementKind, RegExp]> = [
  ['question', /^(questions?|aims?|问题|研究问题)$/i],
  ['method', /^(data\s*(&|and)\s*methods?|data|methods?|数据与方法|数据和方法|方法)$/i],
  ['finding', /^(key\s+results?|results?|findings?|关键结果|主要结果|结果)$/i],
  ['choice', /^((analysis\s+)?choices?|decisions?|选择|分析选择)$/i],
  ['file', /^(files?|outputs?|文件|输出)$/i],
  ['todo', /^(to\s*-?\s*dos?|next\s+steps?|待办(事项)?)$/i],
];
const partOf = (heading: string) => parts.find(([, name]) => name.test(heading.replace(/[*_`:：]/g, '').trim()))?.[0] ?? null;

// A link's target as the project names it, relative to the project root where the notes live.
// Web addresses, anchors and paths that leave the project name no project file.
export function notesPath(target: string): string | null {
  let value = target.trim().replace(/^<|>$/g, '');
  if (!value || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  value = value.replace(/[?#].*$/, '');
  // A folder is no file.
  if (value.endsWith('/')) return null;
  try { value = decodeURIComponent(value); } catch { /* kept as written */ }
  value = value.replace(/^\.?\//, '').replace(/\/+$/, '');
  if (!value || value.split('/').some(part => part === '..' || part === '.git' || part === '.rho')) return null;
  return value;
}
const linkPattern = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// Inline code that names a file: a path with an extension, as Agents often write them. Code
// such as `summary.glm` or `np.mean` names a function, so a bare name counts only with an
// extension files of an analysis have.
const codePath = /`([\w@.\/-]+\.[A-Za-z0-9]{1,6})`/g;
const fileExtension = /\.(csv|tsv|txt|json|jsonl|ya?ml|toml|md|qmd|rmd|ipynb|html?|pdf|png|jpe?g|gif|svg|webp|tiff?|py|r|jl|sh|js|mjs|ts|sql|xlsx?|parquet|feather|rds|rdata|h5|h5ad|hdf5|npy|npz|pkl|log|gz|zip|bam|sam|vcf|bed|gtf|gff3?|fasta|fa|fastq|fq|mtx|nc)$/i;
function linksOf(source: string): string[] {
  const found: string[] = [];
  const add = (target: string) => { const path = notesPath(target); if (path && !found.includes(path)) found.push(path); };
  for (const m of source.matchAll(linkPattern)) add(m[3]!);
  for (const m of source.replace(linkPattern, ' ').matchAll(codePath)) if (m[1]!.includes('/') || fileExtension.test(m[1]!)) add(m[1]!);
  return found;
}
// The statement as a person reads it: link labels, image descriptions and code without marks.
export function plainText(source: string): string {
  const unmarked = source.replace(linkPattern, (_, _image, label) => label).replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '');
  // Emphasis outside code, which may span a code span; an underscore inside a word, as in a file
  // name, is not emphasis. Code spans are set aside first so their contents stay as written.
  const code: string[] = [];
  const held = unmarked.replace(/`([^`]*)`/g, (_, inner) => '\u0000' + (code.push(inner) - 1) + '\u0000');
  const plain = held.replace(/(\*{1,3})(?=\S)([^*]+?)(?<=\S)\1/g, '$2').replace(/(^|[^\w])(_{1,3})(?=\S)([^_]+?)(?<=\S)\2(?![\w])/g, '$1$3');
  return plain.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]!).replace(/\s+/g, ' ').trim();
}

export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// What a choice is about, when the notes lead with it ("q5 model: …", "Dunnett family = …"),
// and what was taken.
export function topicOf(text: string): { topic: string | null; rest: string } {
  const m = /^(.{2,48}?)\s*(?:=|:)\s+(\S[\s\S]*)$/.exec(text);
  if (!m || m[1]!.split(/\s+/).length > 6 || /[.!?]\s/.test(m[1]!)) return { topic: null, rest: text };
  return { topic: m[1]!, rest: capital(m[2]!) };
}
// The paths a sentence ends with, as the notes write a link's label, are shown as the files
// under it instead.
export function withoutPaths(text: string, links: string[]) {
  let out = text.trim(), end = '';
  const quoted = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let found = true; found;) {
    found = false;
    for (const path of links) {
      const hit = new RegExp('[\\s,;]*\\(?' + quoted(path) + '\\)?([.;]?)$').exec(out);
      if (hit) { out = out.slice(0, hit.index); end ||= hit[1]!; found = true; }
    }
  }
  out = out.replace(/[\s,;]+$/, '');
  return end && !/[.!?;:]$/.test(out) ? out + end : out;
}

const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const imageOnly = /^\s*!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)\s*$/;
const alternativeWord = /^(alternatives?|instead|other(wise)?|或者|备选|替代)\b\s*[:：-]?\s*/i;
// An option written in the choice's own sentence rather than under it: "… Alternative: …".
const inlineAlternative = /(?<=[.;!?)\]—])\s+(?=(?:\*\*|__)?(?:alternatives?|instead|otherwise|备选|替代)(?:\*\*|__)?\s*[:：])/i;

// Each section's statements, read subsection by subsection. A top-level bullet or paragraph is
// one statement; lines indented under it continue it, and under a choice each nested bullet is
// an option not taken. An image on its own line is a figure.
export function notesMeaning(text: string): SessionMeaning[] {
  const lines = text.split('\n'), sections = notesSections(text);
  return sections.map((section: NotesSection, index) => {
    const end = index + 1 < sections.length ? sections[index + 1]!.line : nextTopHeading(lines, section.line);
    const statements: Statement[] = [];
    let part: StatementKind | null = null, open: Statement | null = null, fence: string | null = null;
    // A choice's own lines, apart from the options under it.
    let own = '';
    // Closes the statement being read; its index once kept, if it was.
    const close = (): number | undefined => {
      const done = open;
      open = null;
      if (!done) return undefined;
      // Agents write an option under the choice as asked, or in the same sentence; both count.
      if (done.kind === 'choice' && !done.alternatives!.length) {
        const [first, ...rest] = own.split(inlineAlternative);
        if (rest.length) { own = first!; done.alternatives = rest.map(source => ({ text: '', source, links: [] })); }
      }
      const said = done.kind === 'choice' ? own : done.source;
      done.text = plainText(said);
      done.links = linksOf(said);
      for (const option of done.alternatives ?? []) { option.text = plainText(option.source.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')).replace(alternativeWord, ''); option.links = linksOf(option.source); }
      if (!done.text && !done.links.length) return undefined;
      statements.push(done);
      return statements.length - 1;
    };
    for (let i = section.line + 1; i < end; i++) {
      const line = lines[i]!;
      const fenced = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenced) { close(); fence = fence === null ? fenced[1]![0]! : fence === fenced[1]![0] ? null : fence; continue; }
      if (fence !== null) continue;
      const heading = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) { close(); part = partOf(heading[1]!); continue; }
      if (!part || /^\s*<!--.*-->\s*$/.test(line)) continue;
      if (!line.trim()) { if (open && !bullet.test(lines[i + 1] ?? '') && !/^\s+\S/.test(lines[i + 1] ?? '')) close(); continue; }
      const image = imageOnly.exec(line);
      if (image) {
        const finding = (open as Statement | null)?.kind === 'finding', index = close();
        const path = notesPath(image[2]!);
        if (path) statements.push({ kind: 'figure', text: image[1]!.trim(), source: line.trim(), line: i, links: [path], ...(finding && index !== undefined ? { of: index } : {}) });
        continue;
      }
      const item = bullet.exec(line);
      if (item && item[1]!.length <= 1) {
        close();
        const task = /^\[([ xX])\]\s+/.exec(item[3]!);
        open = { kind: part === 'todo' || (task && part !== 'choice') ? 'todo' : part, text: '', source: line.trim(), line: i, links: [], ...(task ? { done: task[1] !== ' ' } : {}) };
        if (open.kind === 'choice') { open.alternatives = []; own = line.trim(); }
        continue;
      }
      // Under a choice a nested bullet is an option not taken; the lines after it continue it.
      if (open && open.kind === 'choice') {
        const options = open.alternatives!;
        if (item) options.push({ text: '', source: line.trim(), links: [] });
        else if (options.length) options.at(-1)!.source += '\n' + line.trim();
        else own += '\n' + line.trim();
        open.source += '\n' + line.trim();
        continue;
      }
      if (open) { open.source += '\n' + line.trim(); continue; }
      open = { kind: part, text: '', source: line.trim(), line: i, links: [] };
      if (open.kind === 'choice') { open.alternatives = []; own = line.trim(); }
    }
    close();
    return { conversationId: section.conversationId, title: section.title, line: section.line, statements };
  });
}
function nextTopHeading(lines: string[], from: number) {
  let fence: string | null = null;
  for (let i = from + 1; i < lines.length; i++) {
    const fenced = /^\s*(`{3,}|~{3,})/.exec(lines[i]!);
    if (fenced) { fence = fence === null ? fenced[1]![0]! : fence === fenced[1]![0] ? null : fence; continue; }
    if (fence === null && /^#{1,2}\s/.test(lines[i]!)) return i;
  }
  return lines.length;
}

// What each file holds, in the words of the notes: a Files entry first, then a figure's
// description, then the data and method statement that names it.
export interface Described { text: string; statement: Statement; session: SessionMeaning }
export function fileDescriptions(meanings: SessionMeaning[]): Map<string, Described> {
  const out = new Map<string, Described>();
  const rank = (s: Statement) => s.kind === 'file' ? 0 : s.kind === 'figure' ? 1 : s.kind === 'method' ? 2 : 3;
  for (const session of meanings) for (const statement of session.statements) {
    if (rank(statement) > 2) continue;
    for (const path of statement.links) {
      const text = statement.kind === 'figure' ? statement.text : describedAs(statement, path);
      if (!text) continue;
      const known = out.get(path);
      if (!known || rank(statement) < rank(known.statement)) out.set(path, { text, statement, session });
    }
  }
  return out;
}
// "[results/x.csv](results/x.csv) — per-group summaries" says what that file holds. A statement
// describes only the first file it names; the others it only mentions.
function describedAs(statement: Statement, path: string) {
  if (statement.links[0] !== path) return '';
  const whole = statement.source.replace(/\s*\n\s*/g, ' ');
  const after = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?(?:\[[^\]]*\]\([^)]*\)|`[^`]+`)\s*(?:[—–:：-]+\s*)(.+)$/.exec(whole);
  if (after) return plainText(after[1]!);
  const text = statement.text.replace(new RegExp('\\b' + path.split('/').at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'), '').replace(/^[\s:—–-]+|[\s:—–-]+$/g, '');
  return text.length >= 3 ? text : '';
}

// Where a statement came from. The kept versions of the notes are read oldest first: the first
// that holds the statement's lines says who wrote it and when. Each file it names is the version
// kept then; a later version means the statement was written about an earlier one.
export interface NotesVersion { text: string; at: number; turn: string; conversationId: string; resource: { id: string; version: string } }
export interface KeptVersion { at: number; resource: { id: string; version: string } }
export interface Trace {
  // Null when no kept version of the notes holds it: the person or another program wrote it,
  // or the Agent's record kept no version since.
  written: { at: number; turn: string; conversationId: string; version: number; of: number } | null;
  // Later: a newer version was kept since, or the file was written again on disk since (its
  // bytes may or may not differ; only a kept version says what it holds).
  files: Array<{ path: string; kept: KeptVersion | null; later: false | 'kept' | 'written' }>;
}
const norm = (line: string) => line.replace(/\s+/g, ' ').trim();
export function traceStatement(statement: Pick<Statement, 'source' | 'links'>, versions: NotesVersion[], keptOf: (path: string) => KeptVersion[], changedAt: (path: string) => number | null, settleMs = 2500): Trace {
  const wanted = statement.source.split('\n').map(norm).filter(Boolean);
  const ordered = [...versions].sort((a, b) => a.at - b.at);
  const index = ordered.findIndex(v => { const have = new Set(v.text.split('\n').map(norm)); return wanted.every(line => have.has(line)); });
  const first = index >= 0 ? ordered[index]! : null;
  const files = statement.links.map(path => {
    const kept = [...keptOf(path)].sort((a, b) => a.at - b.at);
    const bound = first ? [...kept].reverse().find(k => k.at <= first.at + 1000) ?? null : kept.at(-1) ?? null;
    const changed = changedAt(path);
    // A later capture of the same bytes is the same version; a write on disk after the last
    // capture is named only as a write, since nothing kept says what it holds.
    const last = kept.at(-1);
    const later: Trace['files'][number]['later'] = !bound ? false : kept.some(k => k.at > bound.at + 1000 && k.resource.version !== bound.resource.version) ? 'kept'
      : changed !== null && last && changed > last.at + settleMs ? 'written' : false;
    return { path, kept: bound, later };
  });
  return { written: first ? { at: first.at, turn: first.turn, conversationId: first.conversationId, version: index + 1, of: ordered.length } : null, files };
}
