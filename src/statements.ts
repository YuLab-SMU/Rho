// The code a person runs from a script with ⌘/Ctrl+Enter, as the R and Python consoles take it
// from an editor: the whole top-level statement the cursor is in, however many lines it spans (a
// call broken over lines, a pipe, a function, a Python block with its decorators and else/except
// parts), and the line where the next one starts. Strings and comments are read as such, so a
// bracket or an operator inside them changes nothing. A blank or comment line runs nothing.
import type { Language } from './explore-code.js';

export interface Statement { from: number; to: number; code: string }
interface Logical { from: number; to: number; indent: number; head: string; tail: string; blank: boolean; open?: boolean }

// R continues a line that ends with an operator, or with a header (`function (x)`, `if (a)`)
// whose body is on the next line.
function rContinues(code: string) {
  if (/(?:[-+*/^,|&=<>!~:$@]|%[^%\s]*%)$/.test(code) || /\b(?:else|repeat)$/.test(code)) return true;
  for (const match of code.matchAll(/(?:\b(?:function|if|for|while)\s*|\\)\(/g)) {
    let depth = 0, end = -1;
    for (let j = match.index! + match[0].length - 1; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')' && --depth === 0) { end = j; break; }
    }
    if (end === code.length - 1) return true;
  }
  return false;
}
const pythonClauses = /^(?:elif\b|else\b|except\b|finally\b)/;

// Physical lines joined into logical ones: open brackets, strings and continuations join the
// lines after them. `head` is the first line's code, `tail` the last line's code without its
// comment.
function logicalLines(text: string, language: Language): Logical[] {
  const lines = text.split('\n'), out: Logical[] = [];
  let depth = 0, quote = '', current: Logical | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!current && !line.trim()) { out.push({ from: i + 1, to: i + 1, indent: 0, head: '', tail: '', blank: true }); continue; }
    if (!current && /^\s*#/.test(line)) { out.push({ from: i + 1, to: i + 1, indent: 0, head: '', tail: '', blank: true }); continue; }
    let code = '';
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!;
      if (quote) {
        code += c;
        if (c === '\\') { code += line[j + 1] ?? ''; j++; continue; }
        if (line.startsWith(quote, j)) { code += quote.slice(1); j += quote.length - 1; quote = ''; }
        continue;
      }
      if (c === '#') break;
      if (language === 'python' && (line.startsWith('"""', j) || line.startsWith("'''", j))) { quote = line.slice(j, j + 3); code += quote; j += 2; continue; }
      if (c === '"' || c === "'" || (language === 'r' && c === '`')) { quote = c; code += c; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      code += c;
    }
    const tail = code.trimEnd();
    if (!current) current = { from: i + 1, to: i + 1, indent: line.length - line.trimStart().length, head: tail.trim(), tail, blank: false };
    else { current.to = i + 1; if (tail.trim()) current.tail = tail; }
    // A single-quoted string ends at its line in Python; R strings may run over lines.
    if (quote.length === 1 && language === 'python') quote = '';
    const open = depth > 0 || !!quote || (language === 'python' ? current.tail.endsWith('\\') : rContinues(current.tail.trim()));
    if (!open || i === lines.length - 1) { out.push({ ...current, open }); current = null; }
  }
  return out;
}

// The top-level statements of a script, in order, with the lines each covers.
export function statements(text: string, language: Language): Array<{ from: number; to: number }> {
  const logical = logicalLines(text, language), out: Array<{ from: number; to: number }> = [];
  for (let k = 0; k < logical.length; k++) {
    const first = logical[k]!;
    if (first.blank) continue;
    let last = first;
    if (language === 'python') {
      // Decorators belong to what they decorate; a block header takes its indented body and
      // the else/elif/except/finally parts at its own indentation.
      let header = first;
      while (header.head.startsWith('@') && logical[k + 1] && !logical[k + 1]!.blank) header = logical[++k]!;
      last = header;
      let block = header.tail.trimEnd().endsWith(':');
      for (let n = k + 1; n < logical.length; n++) {
        const line = logical[n]!;
        if (line.blank) continue;
        if (block && line.indent > first.indent) { last = line; k = n; }
        else if (line.indent === first.indent && pythonClauses.test(line.head)) { last = line; k = n; block = line.tail.trimEnd().endsWith(':'); }
        else break;
      }
    }
    out.push({ from: first.from, to: last.to });
  }
  return out;
}

const dedent = (code: string) => {
  const lines = code.split('\n'), indents = lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length), cut = indents.length ? Math.min(...indents) : 0;
  return cut ? lines.map(l => l.slice(Math.min(cut, l.length - l.trimStart().length))).join('\n') : code;
};
// The statement on a line (1-based), or null on a blank or comment line, and the line the next
// statement starts on, where the cursor goes after running it (null at the end of the script).
export function statementAt(text: string, line: number, language: Language): { statement: Statement | null; next: number | null } {
  const all = statements(text, language), lines = text.split('\n');
  const at = all.find(s => s.from <= line && line <= s.to) ?? null;
  const next = all.find(s => s.from > (at ? at.to : line))?.from ?? null;
  if (!at) return { statement: null, next };
  const code = lines.slice(at.from - 1, at.to).join('\n');
  return { statement: { from: at.from, to: at.to, code: language === 'python' ? dedent(code) : code }, next };
}
// Whether code typed at a console prompt is still unfinished, so Enter goes on to another line
// instead of running it: an open bracket or string, a line ending in an operator, or in Python
// a block that has not yet had its empty line.
export function unfinished(code: string, language: Language) {
  if (!code.trim()) return false;
  const logical = logicalLines(code.replace(/\n+$/, ''), language), last = logical.filter(l => !l.blank).at(-1);
  if (!last) return false;
  if (last.open) return true;
  if (language !== 'python' || /\n[ \t]*$/.test(code)) return false;
  const all = statements(code, language), final = all.at(-1);
  if (!final) return false;
  const lines = code.split('\n').slice(final.from - 1, final.to);
  return lines.some(l => /:\s*(#.*)?$/.test(l)) && lines.length >= 1 && /:\s*(#.*)?$|^\s+\S/.test(lines.at(-1)!);
}
// Selected text runs as it is; Python's is moved left so an indented part of a block runs.
export const selectionCode = (code: string, language: Language) => language === 'python' ? dedent(code) : code;
// How the cell names where its code came from: the script and its lines.
export const runPurpose = (path: string, from: number, to: number) => `${path.split('/').at(-1)} · ${from === to ? 'line ' + from : `lines ${from}–${to}`}`;
