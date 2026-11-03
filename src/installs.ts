// What an Agent's command installed, read the way a person reads it: "Installed pandas 2.2.3,
// statsmodels 0.15.0 (uv)". The command names the packages and the tool; what it printed, when
// kept, gives the versions that were installed. Anything else is not an install.
export interface Installed { tool: string; packages: Array<{ name: string; version: string | null }>; more: number; from: string | null }

// One command line split into its commands and words, honouring quotes. Pipes, `&&`, `||`, `;`,
// new lines and a subshell's parentheses separate commands.
function commands(line: string): string[][] {
  const out: string[][] = []; let words: string[] = [], word = '', quote = '', has = false;
  const end = () => { if (has) words.push(word); word = ''; has = false; };
  const next = () => { end(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = ''; else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    // A backslash before a new line continues the command; before anything else it escapes it.
    if (c === '\\' && line[i + 1] === '\n') { end(); i++; continue; }
    if (c === '\\' && i + 1 < line.length) { word += line[++i]; has = true; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { next(); if ((c === '|' || c === '&') && line[i + 1] === c) i++; continue; }
    if (c === ' ' || c === '\t') { end(); continue; }
    word += c; has = true;
  }
  next();
  return out;
}
const base = (word: string) => word.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
// Options of these tools that take the next word as their value, so it is not a package.
const valued = new Set(['-e', '--editable', '-r', '--requirement', '-c', '--constraint', '--channel', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '-p', '--python', '-n', '--name', '--group', '--optional', '--extra', '--index', '--default-index', '--cache-dir', '--directory', '--project', '--package', '--override', '--build-constraint']);
// A package as an installer names it (pandas, pandas==2.2.3, pandas[excel]>=2, conda-forge::pandas);
// a path, a URL or a file is not one.
const spec = (raw: string) => {
  const word = raw.includes('::') ? raw.slice(raw.lastIndexOf('::') + 2) : raw;
  if (/[\\/]|^\.|:\/\/|\.(txt|toml|in|cfg|whl|gz|zip)$/i.test(word)) return null;
  const name = word.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0];
  if (!name) return null;
  return { name, version: word.slice(name.length).match(/^(?:\[[^\]]*\])?={1,2}([^,;\s=<>!~*]+)$/)?.[1] ?? null };
};
// A Python installer's words after `install` (or uv's `add`): its packages and a requirements file.
function pythonArgs(words: string[]) {
  const packages: Installed['packages'] = []; let from: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '-r' || word === '--requirement') { from = words[i + 1] ?? null; i++; continue; }
    if (word.startsWith('--requirement=')) { from = word.slice(14); continue; }
    if (valued.has(word)) { i++; continue; }
    if (word.startsWith('-')) continue;
    const found = spec(word); if (found) packages.push(found);
  }
  return { packages, from };
}
// R code's install calls: install.packages("a"), install.packages(c("a", "b")), BiocManager::install(...).
function rInstalls(code: string) {
  const found: Array<{ tool: string; names: string[] }> = [];
  for (const match of code.matchAll(/\b(?:(utils)::)?(install\.packages|(BiocManager|pak|remotes|renv)::(?:install|pkg_install|install_github|install_cran))\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const names = [...(match[4] ?? '').matchAll(/["']([A-Za-z0-9._/@-]+)["']/g)].map(m => m[1]!).filter(name => !/^(https?|cran|repos)/i.test(name));
    if (names.length) found.push({ tool: match[3] ?? 'R', names });
  }
  return found;
}

export function readInstall(command: string, printed?: string | null): Installed | null {
  let tool: string | null = null, from: string | null = null;
  const packages: Installed['packages'] = [];
  for (const raw of commands(command)) {
    let words = raw.slice();
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ['rtk', 'proxy', 'sudo', 'env', 'command', 'exec', 'time', 'nohup', '{', '}', '!', 'then', 'else', 'do'].includes(words[0]!))) words = words.slice(1);
    const head = base(words[0] ?? ''), rest = words.slice(1);
    let args: string[] | null = null, by: string | null = null;
    if (head === 'uv' && rest[0] === 'pip' && rest[1] === 'install') { args = rest.slice(2); by = 'uv'; }
    else if (head === 'uv' && rest[0] === 'add') { args = rest.slice(1); by = 'uv'; }
    else if (/^pip3?(\.\d+)?$/.test(head) && rest[0] === 'install') { args = rest.slice(1); by = 'pip'; }
    else if (/^python(\d(\.\d+)?)?$/.test(head) && rest[0] === '-m' && rest[1] === 'pip' && rest[2] === 'install') { args = rest.slice(3); by = 'pip'; }
    else if (/^(conda|mamba|micromamba)$/.test(head) && rest[0] === 'install') { args = rest.slice(1); by = head; }
    else if (/^(Rscript|R)$/.test(head)) {
      const code = rest.filter((_, i) => rest[i - 1] === '-e' || rest[i - 1] === '--expr').join('\n');
      for (const call of rInstalls(code)) { by ??= call.tool; for (const name of call.names) packages.push({ name: name.split('/').pop()!.split('@')[0]!, version: null }); }
      if (by) tool ??= by;
      continue;
    }
    if (!args || !by) continue;
    tool ??= by;
    const read = pythonArgs(args); packages.push(...read.packages); from ??= read.from;
  }
  if (!tool || !packages.length && !from) return null;
  // What was installed, as the tool printed it: pip's "Successfully installed a-1.0 b-2.0" and
  // uv's " + a==1.0" lines. Names compare as package indexes compare them.
  const key = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
  const versions = new Map<string, string>();
  for (const line of (printed ?? '').split('\n')) {
    const pip = line.match(/Successfully installed (.+)$/);
    if (pip) for (const item of pip[1]!.trim().split(/\s+/)) { const at = item.lastIndexOf('-'); if (at > 0) versions.set(key(item.slice(0, at)), item.slice(at + 1)); }
    const uv = line.match(/^\s*\+\s+([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)/);
    if (uv) versions.set(key(uv[1]!), uv[2]!);
  }
  const named = new Set(packages.map(p => key(p.name)));
  const seen = new Set<string>(), listed = packages.filter(p => !seen.has(key(p.name)) && seen.add(key(p.name)))
    .map(p => ({ name: p.name, version: versions.get(key(p.name)) ?? p.version }));
  return { tool, packages: listed, more: [...versions.keys()].filter(name => !named.has(name)).length, from };
}

// "pandas 2.2.3, statsmodels 0.15.0 and 6 more (uv)", or "packages from requirements.txt (pip)".
export function installText(installed: Installed) {
  const names = installed.packages.map(p => p.version ? `${p.name} ${p.version}` : p.name);
  const what = names.length ? names.join(', ') : `packages from ${installed.from}`;
  return `${what}${installed.more ? ` and ${installed.more} more` : ''} (${installed.tool})`;
}
