// The acceptance matrix: the same journeys against a source build and against a packed
// install. A claim about "the application" is only as wide as the columns actually run.
//
//   node scripts/matrix.mjs                  # source build only
//   node scripts/matrix.mjs --install DIR    # also run against an installed package
//
// The install directory is the package root (contains dist/, vendor/rho-core).
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = process.argv.indexOf('--install');
const install = arg > 0 ? path.resolve(process.argv[arg + 1]) : null;
const evidence = path.resolve(process.env.RHO_MATRIX_EVIDENCE ?? path.join(root, 'work/matrix-' + Date.now()));
await fs.mkdir(evidence, { recursive: true });

const driver = fileURLToPath(import.meta.resolve('@playwright/test'));
const columns = [{ id: 'source', packageRoot: root, core: process.env.RHO_CORE_BINARY }];
if (install) {
  const vendor = path.join(install, 'vendor/rho-core');
  const hasVendor = await fs.access(vendor).then(() => true, () => false);
  columns.push({ id: 'installed', packageRoot: install, core: hasVendor ? vendor : process.env.RHO_CORE_BINARY });
}

const journeys = [
  { id: 'person', script: 'scripts/person-files-acceptance.mjs', needsR: false },
  { id: 'execution', script: 'scripts/execution-acceptance.mjs', needsR: true },
  { id: 'walkthrough', script: 'scripts/skill-walkthrough.mjs', needsR: true },
  { id: 'ui', script: 'scripts/ui-acceptance.mjs', needsR: false }
];

const report = { startedAt: new Date().toISOString(), columns: {}, passed: false };
for (const column of columns) {
  report.columns[column.id] = { packageRoot: column.packageRoot, core: column.core ?? null, rows: {} };
  for (const journey of journeys) {
    const env = {
      ...process.env,
      RHO_PACKAGE_ROOT: column.packageRoot,
      RHO_UI_PLAYWRIGHT_MODULE: driver,
      RHO_EVIDENCE: evidence,
      ...(column.core ? { RHO_CORE_BINARY: column.core } : {}),
      ...(journey.needsR ? { RHO_RSCRIPT: process.env.RHO_RSCRIPT ?? '/usr/local/bin/Rscript' } : {})
    };
    // A journey that needs R reports exit 2 when no Rscript is selected; that is a skip,
    // not a pass, and it is recorded as such.
    const run = spawnSync(process.execPath, [path.join(column.packageRoot === root ? root : root, journey.script)], { env, encoding: 'utf8', cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const output = (run.stdout ?? '') + (run.stderr ?? '');
    const parsed = output.trim().split('\n').reverse().map(line => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
    const state = run.status === 2 ? 'skipped' : run.status === 0 && parsed?.passed ? 'passed' : 'failed';
    report.columns[column.id].rows[journey.id] = { state, exitCode: run.status, detail: parsed ?? null, outputTail: output.trim().split('\n').slice(-6).join('\n') };
    process.stdout.write(`${column.id}/${journey.id}: ${state}\n`);
  }
}

report.passed = Object.values(report.columns).every(column => Object.values(column.rows).every(row => row.state === 'passed'));
report.finishedAt = new Date().toISOString();
const file = path.join(evidence, 'matrix.json');
await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ passed: report.passed, columns: Object.keys(report.columns), report: file }) + '\n');
if (!report.passed) process.exit(1);
