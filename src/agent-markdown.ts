// The Agent writes Markdown; the panel reads it as prose, lists and code. This
// parser produces a small token tree with no raw HTML. Links are limited to an
// explicit http(s)/mailto target; everything else stays text. Unicode is preserved.
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };
export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; text: string; language: string | null }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

export function safeHref(value: string) {
  const url = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}
function findClosing(source: string, from: number, marker: string) {
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (!source.startsWith(marker, i)) continue;
    if (i === from) return -1;
    // A closing underscore followed by an identifier character still belongs to it.
    if (marker === '_' && /[A-Za-z0-9]/.test(source[i + marker.length] ?? '')) continue;
    return i;
  }
  return -1;
}
export function inlineMarkdown(source: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ type: 'text', text }); text = ''; } };
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!>]/.test(source[i + 1])) { text += source[i + 1]; i += 2; continue; }
    if (char === '\n') { flush(); out.push({ type: 'break' }); i++; continue; }
    if (char === '`') {
      const ticks = /^`+/.exec(source.slice(i))![0], end = source.indexOf(ticks, i + ticks.length);
      if (end >= 0) { flush(); out.push({ type: 'code', text: source.slice(i + ticks.length, end) }); i = end + ticks.length; continue; }
    }
    if (char === '*' || char === '_') {
      // An underscore inside an identifier is not an emphasis opener.
      if (char === '_' && /[A-Za-z0-9]/.test(source[i - 1] ?? '')) { text += char; i++; continue; }
      const double = source[i + 1] === char, marker = double ? char + char : char;
      const end = findClosing(source, i + marker.length, marker);
      if (end >= 0) {
        flush();
        const children = inlineMarkdown(source.slice(i + marker.length, end));
        out.push(double ? { type: 'strong', children } : { type: 'em', children });
        i = end + marker.length; continue;
      }
    }
    if (char === '[') {
      const close = source.indexOf(']', i + 1);
      if (close > i && source[close + 1] === '(') {
        // Balance parentheses so a URL target may itself contain them.
        let end = close + 2, depth = 1;
        for (; end < source.length; end++) {
          if (source[end] === '(') depth++;
          else if (source[end] === ')' && --depth === 0) break;
        }
        if (depth === 0) {
          const href = safeHref(source.slice(close + 2, end)), children = inlineMarkdown(source.slice(i + 1, close));
          flush();
          // An unsafe target is shown as its label, never as a live link.
          if (href) out.push({ type: 'link', href, children }); else out.push(...children);
          i = end + 1; continue;
        }
      }
    }
    text += char; i++;
  }
  flush();
  return out;
}
// A table row's cells: split on pipes outside code spans, without the outer pipes.
function cells(line: string) {
  const out: string[] = [];
  let cell = '', ticks = 0;
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (char === '`') ticks = ticks ? 0 : 1;
    if (char === '|' && !ticks) { out.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  out.push(cell.trim());
  return out;
}
const delimiter = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// A header row with pipes, then a row of dashes with as many cells.
const startsTable = (line: string, next: string | undefined) => line.includes('|') && next !== undefined && delimiter.test(next) && next.includes('-') && cells(line).length === cells(next).length;
const startsBlock = (line: string) => /^(#{1,6})\s+/.test(line) || /^(```+|~~~+)/.test(line) || /^ {0,3}>/.test(line) || /^ {0,3}([-*+]|\d+[.)])\s+/.test(line) || /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
// A fence that has not been closed yet is still code: streaming shows the block
// as it arrives rather than flashing raw backticks until the last chunk.
export function markdownBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n'), blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^(```+|~~~+)\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      // The closing fence must use at least as many of the same characters.
      const close = new RegExp('^' + (fence[1][0] === '`' ? '`' : '~') + '{' + fence[1].length + ',}\\s*$'), body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: body.join('\n'), language: fence[2] || null });
      continue;
    }
    if (startsTable(line, lines[i + 1])) {
      const head = cells(line), width = head.length;
      const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' as const : c.endsWith(':') ? 'right' as const : c.startsWith(':') ? 'left' as const : null);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i]);
        rows.push(Array.from({ length: width }, (_, c) => inlineMarkdown(row[c] ?? '')));
        i++;
      }
      blocks.push({ type: 'table', align, head: head.map(c => inlineMarkdown(c)), rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, children: inlineMarkdown(heading[2].trim()) }); i++; continue; }
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) { body.push(lines[i].replace(/^ {0,3}>\s?/, '')); i++; }
      blocks.push({ type: 'quote', children: inlineMarkdown(body.join('\n')) });
      continue;
    }
    const item = /^ {0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /^\d/.test(item[1]), items: Inline[][] = [];
      while (i < lines.length) {
        const next = /^ {0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        const parts = [next[2]];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { parts.push(lines[i].trim()); i++; }
        items.push(inlineMarkdown(parts.join('\n')));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const body = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !startsTable(lines[i], lines[i + 1])) { body.push(lines[i].trim()); i++; }
    blocks.push({ type: 'paragraph', children: inlineMarkdown(body.join('\n')) });
  }
  return blocks;
}
