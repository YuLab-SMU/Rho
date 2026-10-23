// Records what this checkout actually verified, so Status can cite numbers instead of
// restating them. Each entry names the command, the result and the commit it ran on.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'docs/VERIFICATION.json');

// Each check declares how its count is read out of the tool's own summary lines.
const checks = [
  { id: 'rho-tests', command: 'node --test test/*.test.mjs', cwd: root, env: { RHO_CORE_BINARY: process.env.RHO_CORE_BINARY ?? '' }, pattern: /^# tests (\d+)$/m, passing: /^# pass (\d+)$/m },
  { id: 'plugin-tests', command: 'node --test test/*.test.mjs', cwd: path.join(root, '..', 'Rho-plugins'), pattern: /^# tests (\d+)$/m, passing: /^# pass (\d+)$/m }
];

const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
const commit = git(['rev-parse', 'HEAD']) ?? 'unknown';
const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter(line => line && !line.endsWith('web/theme.css')).length > 0;

const results = {};
for (const check of checks) {
  const [bin, ...args] = check.command.split(' ');
  let output = '', code = 0;
  try {
    output = execFileSync(bin, args, { cwd: check.cwd, encoding: 'utf8', env: { ...process.env, ...check.env }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = String(error.stdout ?? '') + String(error.stderr ?? '');
    code = error.status ?? 1;
  }
  const total = Number(output.match(check.pattern)?.[1] ?? NaN);
  const passing = Number(output.match(check.passing)?.[1] ?? NaN);
  results[check.id] = { command: check.command, checkedAt: new Date().toISOString(), commit, exitCode: code, tests: total, passing, passed: code === 0 && total === passing };
  process.stdout.write(`${check.id}: ${passing}/${total} exit ${code}\n`);
}

const ledger = { schemaVersion: 1, commit, workingTreeDirty: dirty, checks: results };
await fs.writeFile(out, JSON.stringify(ledger, null, 2) + '\n');
process.stdout.write(`wrote ${path.relative(root, out)} for ${commit}${dirty ? ' (dirty tree)' : ''}\n`);
if (!Object.values(results).every(result => result.passed)) process.exit(1);
