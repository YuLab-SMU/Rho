// Builds the WorkBuddy connector package for Rho: the files in connector/ plus the references of
// skills/rho, checked against the rules WorkBuddy's open platform states for a CLI connector, in
// OUT/rho-workspace/, and, when `zip` exists, OUT/rho-workspace-<version>.zip with that folder at
// its root. That zip is what is uploaded at https://open.workbuddy.cn/.
//   node adapters/workbuddy-rho/build.mjs [OUT]          (OUT defaults to work/workbuddy-rho)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const out = path.resolve(process.argv[2] ?? path.join(repo, 'work/workbuddy-rho'));
const platforms = ['darwin', 'linux', 'win32'];
const problems = [];
const need = (ok, message) => { if (!ok) problems.push(message); };
const semver = v => v.split('.').map(Number);
const atLeast = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return true; };

const meta = JSON.parse(await fs.readFile(path.join(here, 'connector/connector-meta.json'), 'utf8'));
const cli = JSON.parse(await fs.readFile(path.join(here, 'connector/cli.json'), 'utf8'));
const rho = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));

for (const key of ['name', 'name_en', 'description', 'description_zh', 'description_en', 'source', 'examples_zh', 'examples_en']) need(meta[key]?.length, `connector-meta.json lacks ${key}`);
need(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.source), 'source must be kebab-case');
need(meta.type === 'cli', 'a CLI connector must say "type": "cli"');
need(/^\d+\.\d+\.\d+$/.test(meta.version ?? ''), 'version must be a semantic version');
for (const key of ['examples_zh', 'examples_en']) need(meta[key]?.length >= 2 && meta[key].length <= 5, `${key} needs 2 to 5 examples`);
// cli.json versionCheck needs WorkBuddy 4.24.0, a Node runtime 4.22.0.
need(meta.minWorkbuddyVersion && atLeast(meta.minWorkbuddyVersion, '4.24.0'), 'versionCheck needs minWorkbuddyVersion 4.24.0 or later');
for (const key of ['init', 'status', 'unAuth']) for (const p of platforms) need(cli[key]?.[p], `cli.json lacks ${key}.${p}`);
for (const p of platforms) need(cli.versionCheck?.command?.[p], `cli.json lacks versionCheck.command.${p}`);
need(cli.runtime?.type === 'node' && cli.runtime.version === rho.engines?.node, `runtime.version must be Rho's engines.node (${rho.engines?.node})`);
need(atLeast(rho.version, cli.versionCheck.minVersion), `Rho ${rho.version} is older than versionCheck.minVersion ${cli.versionCheck.minVersion}`);
need(new RegExp(cli.statusMatch).test(rho.version + '\n'), 'statusMatch does not match what rho --version prints');
for (const p of platforms) need(cli.init[p].includes(rho.name), `init.${p} does not install ${rho.name}`);

// The package: connector/ as it is, and the shared references beside the WorkBuddy SKILL.md.
const target = path.join(out, meta.source);
await fs.rm(target, { recursive: true, force: true });
await fs.cp(path.join(here, 'connector'), target, { recursive: true });
await fs.cp(path.join(repo, 'skills/rho/references'), path.join(target, 'skills/rho/references'), { recursive: true, filter: s => !path.basename(s).startsWith('.') });

const files = (await fs.readdir(target, { recursive: true })).map(f => String(f).split(path.sep).join('/')).filter(f => !f.endsWith('/') && !f.split('/').some(part => part.startsWith('.')));
const regular = [];
for (const f of files.sort()) if ((await fs.stat(path.join(target, f))).isFile()) regular.push(f);
need(regular.includes('icon.svg'), 'the package needs icon.svg');
const skill = await fs.readFile(path.join(target, 'skills/rho/SKILL.md'), 'utf8');
const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
need(/^name: rho$/m.test(front), 'SKILL.md needs name: rho');
need(/^description: .{80,}/m.test(front), 'SKILL.md needs a description');
for (const f of regular.filter(f => f.endsWith('.md'))) {
  // Links in code are examples of what an Agent writes, not links of the package.
  const text = (await fs.readFile(path.join(target, f), 'utf8')).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const [, link] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(link)) continue;
    need(regular.includes(path.posix.normalize(path.posix.join(path.posix.dirname(f), link))), `${f} links to ${link}, which the package lacks`);
  }
}
// Nothing of the machine that built it: its home folder, or a credential.
const home = os.homedir();
for (const f of regular) {
  const text = await fs.readFile(path.join(target, f), 'utf8');
  need(!text.includes(home) && !text.includes(home.split(path.sep).join('/')), `${f} names this machine's home folder`);
  need(!/npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|"token"\s*:\s*"[^"]{12,}/.test(text), `${f} looks like it holds a credential`);
}
if (problems.length) { console.error(problems.map(p => '- ' + p).join('\n')); process.exit(1); }

let zip = null;
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
  zip = path.join(out, `${meta.source}-${meta.version}.zip`);
  await fs.rm(zip, { force: true });
  execFileSync('zip', ['-X', '-r', '-q', zip, meta.source, '-x', '*/.*'], { cwd: out });
} catch (error) { if (error.code !== 'ENOENT') throw error; zip = null; }
const report = { connector: { source: meta.source, version: meta.version, rho: rho.version, minRho: cli.versionCheck.minVersion }, folder: target, files: regular,
  ...(zip ? { zip, sha256: createHash('sha256').update(await fs.readFile(zip)).digest('hex') } : {}) };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
