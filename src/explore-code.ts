// The code Rho writes for a person exploring a file in a live session: a table loads into a
// new value named from the file, a script runs from its path. Both languages read the same
// string literals, so a path is written once as JSON.
export type Language = 'r' | 'python';
export const languageNames: Record<Language, string> = { r: 'R', python: 'Python' };
// The sessions run in the project folder; a file of an added source folder (@…) is outside it.
export const explorableTable = (path: string | undefined | null): path is string => !!path && !path.startsWith('@') && /\.(csv|tsv)(\.gz)?$/i.test(path);
// A table's project path: a kept version lives under .rho, and names the file it was kept from.
export function projectPath(resource: { path: string; provenance?: unknown }) {
  const from = resource.provenance as { originalPath?: string; observation?: { path?: string }; restoredFrom?: { path?: string } } | undefined;
  return from?.originalPath ?? from?.observation?.path ?? from?.restoredFrom?.path ?? resource.path;
}
export const scriptLanguage = (path: string | undefined | null): Language | null => !path || path.startsWith('@') ? null : /\.r$/i.test(path) ? 'r' : /\.py$/i.test(path) ? 'python' : null;

const reserved: Record<Language, Set<string>> = {
  r: new Set(['if', 'else', 'repeat', 'while', 'function', 'for', 'next', 'break', 'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA', 'in', 'T', 'F', 'c', 'data', 'df']),
  python: new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'pd', 'np']),
};
// A name from the file's own name that no value in the session has, so loading never replaces one.
export function valueName(path: string, language: Language, taken: Set<string>) {
  let base = (path.split('/').at(-1) ?? '').replace(/\.(csv|tsv)(\.gz)?$/i, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
  if (/^[0-9]/.test(base)) base = 'table_' + base;
  if (reserved[language].has(base)) base += '_table';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = base + '_' + n;
  return name;
}
// File names are written as string literals both languages read the same way.
export function loadCode(path: string, language: Language, name: string) {
  const file = JSON.stringify(path), tabs = /\.tsv(\.gz)?$/i.test(path);
  return language === 'r'
    ? `${name} <- ${tabs ? 'read.delim' : 'read.csv'}(${file})\ndim(${name})\nhead(${name})`
    : `import pandas as pd\n${name} = pd.read_csv(${file}${tabs ? ', sep="\\t"' : ''})\nprint(${name}.shape)\n${name}.head()`;
}
export function sourceCode(path: string, language: Language) {
  const file = JSON.stringify(path);
  return language === 'r' ? `source(${file})` : `__file__ = ${file}\nexec(compile(open(__file__).read(), __file__, "exec"))`;
}

