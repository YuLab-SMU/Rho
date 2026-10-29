// The languages Rho highlights, chosen by file name for the editor and by name for code in a
// rendered document, each loaded the first time it is needed. Both mark tokens with the same
// classes, coloured in theme.css from Rho's tokens. A file or block Rho has no language for
// stays plain text, as does one whose language fails to load. Markdown also highlights
// fenced Python and R code, including R Markdown's {r} chunks.
import type { Extension } from '@codemirror/state';
import type { Highlighter } from '@lezer/highlight';
import type { Language, LanguageSupport } from '@codemirror/language';

export type LanguageKind = 'python' | 'r' | 'markdown';
const byExtension: Record<string, LanguageKind> = { py: 'python', pyw: 'python', r: 'r', md: 'markdown', markdown: 'markdown', rmd: 'markdown', qmd: 'markdown' };
const byName: Record<string, LanguageKind> = { python: 'python', py: 'python', python3: 'python', r: 'r' };
export function languageOf(path: string): LanguageKind | null {
  const name = path.split('/').pop() ?? '';
  if (name === '.Rprofile') return 'r';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? byExtension[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

const once = <T>(load: () => Promise<T>) => { let p: Promise<T> | null = null; return () => p ??= load().catch(error => { p = null; throw error; }); };
const highlighter = once(async (): Promise<Highlighter> => {
  const { tagHighlighter, tags: t } = await import('@lezer/highlight');
  return tagHighlighter([
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.self], class: 'rho-tok-keyword' },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'rho-tok-string' },
    { tag: [t.number, t.bool, t.null, t.atom], class: 'rho-tok-number' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'rho-tok-comment' },
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.className), t.standard(t.variableName), t.className], class: 'rho-tok-function' },
    { tag: [t.heading, t.strong], class: 'rho-tok-strong' },
    { tag: t.emphasis, class: 'rho-tok-emphasis' },
    { tag: t.strikethrough, class: 'rho-tok-strike' },
    { tag: [t.link, t.url], class: 'rho-tok-link' },
    { tag: t.monospace, class: 'rho-tok-number' },
    { tag: [t.processingInstruction, t.contentSeparator, t.meta, t.labelName], class: 'rho-tok-mark' },
    { tag: t.quote, class: 'rho-tok-quote' },
    { tag: t.invalid, class: 'rho-tok-invalid' },
  ]);
});
const python = once(async () => (await import('@codemirror/lang-python')).python());
const r = once(async () => {
  const [{ StreamLanguage }, { r }] = await Promise.all([import('@codemirror/language'), import('@codemirror/legacy-modes/mode/r')]);
  return StreamLanguage.define(r) as Language;
});
const languageOfKind = async (kind: 'python' | 'r'): Promise<Language> => kind === 'python' ? (await python()).language : r();

async function load(kind: LanguageKind): Promise<Extension[]> {
  const [{ syntaxHighlighting, LanguageDescription, LanguageSupport }, marks] = await Promise.all([import('@codemirror/language'), highlighter()]);
  const style = syntaxHighlighting(marks);
  if (kind === 'python') return [await python(), style];
  if (kind === 'r') return [await r(), style];
  const { markdown, markdownLanguage } = await import('@codemirror/lang-markdown');
  const code = [LanguageDescription.of({ name: 'Python', alias: ['py', 'python3'], load: python }),
    LanguageDescription.of({ name: 'R', alias: ['r'], load: async (): Promise<LanguageSupport> => new LanguageSupport(await r()) })];
  // A fence names its language as `python` or, in R Markdown and Quarto, as `{r label, …}`;
  // CodeMirror passes only its first word, so `{r` arrives without the closing brace.
  const fenced = (info: string) => LanguageDescription.matchLanguageName(code, info.replace(/^\{\s*/, '').replace(/[\s,}].*$/, ''), true);
  return [markdown({ base: markdownLanguage, codeLanguages: fenced }), style];
}

const loading = new Map<LanguageKind, Promise<Extension[]>>();
// The extensions for a path: the same array for every file of one kind, none when Rho has
// no language for it. A load that failed is tried again for the next file of that kind.
export function languageExtensions(path: string): Promise<Extension[]> {
  const kind = languageOf(path);
  if (!kind) return Promise.resolve([]);
  let pending = loading.get(kind);
  if (!pending) { pending = load(kind); loading.set(kind, pending); pending.catch(() => loading.delete(kind)); }
  return pending;
}

// Code in a rendered document, named by its fence, as text and marked spans.
export async function highlight(code: string, language: string): Promise<DocumentFragment | null> {
  const kind = byName[language.toLowerCase()];
  if (kind !== 'python' && kind !== 'r') return null;
  const [{ highlightCode }, marks, lang] = await Promise.all([import('@lezer/highlight'), highlighter(), languageOfKind(kind)]);
  const out = document.createDocumentFragment();
  highlightCode(code, lang.parser.parse(code), marks, (text, classes) => {
    if (!classes) { out.append(text); return; }
    const span = document.createElement('span'); span.className = classes; span.textContent = text; out.append(span);
  }, () => out.append('\n'));
  return out;
}
