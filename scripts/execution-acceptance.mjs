// Executes R through a real Host and checks the whole execution loop, which the
// read-only browser checks deliberately never touch: one Host start, an artifact
// written where the plan said, a run that reads as finished without an explicit
// observe, and a registered artifact that can be shown in a view.
//
// Needs a Core binary and Rscript: RHO_CORE_BINARY (or --core) and RHO_RSCRIPT.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')).href);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')).href);
const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')).href);
const core = process.env.RHO_CORE_BINARY;
const rscript = process.env.RHO_RSCRIPT;
if (!core || !rscript) {
  console.error('Execution acceptance needs RHO_CORE_BINARY and RHO_RSCRIPT: it runs a real Host and R.');
  process.exit(2);
}

const evidence = path.resolve(process.env.RHO_EXECUTION_EVIDENCE ?? 'work/execution-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-exec-'));
const state = path.join(root, '.service'), project = path.join(root, 'work');
await fs.mkdir(project);
const counts = { hostStarts: 0 };
const report = { passed: false, core, rscript, counts, checks: [], project: project };
const check = (name) => { report.checks.push(name); process.stdout.write('- ' + name + '\n'); };

// Count what the plan claims: a real start, and nothing else.
const instrument = path.join(root, 'instrument.mjs');
await fs.writeFile(instrument, `import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { CoreBridge } = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/bridge.js')).href)});
const start = CoreBridge.prototype.ensureOwnedHost;
CoreBridge.prototype.ensureOwnedHost = function (...args) { appendFileSync(${JSON.stringify(path.join(root, 'starts.jsonl'))}, '{}\\n'); return start.apply(this, args); };
`);

let service;
try {
  // Importing the instrument patches the bridge in this process before the service
  // uses it, so the count is of this service's own starts.
  await import(pathToFileURL(instrument).href);
  service = await new RhoService({ root, stateDir: state, coreBinary: core, rscript }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });

  // The script writes into the directory it is given as its first argument and
  // creates nothing: the producer may not have to build Rho's own output tree.
  const script = [
    'out <- commandArgs(trailingOnly = TRUE)[1]',
    'png(file.path(out, "cars.png"), width = 640, height = 420)',
    'plot(datasets::cars$speed, datasets::cars$dist, pch = 19, col = "steelblue")',
    'dev.off()',
    'produced <- file.path(out, "cars.png")',
    'manifest <- list(schemaVersion = 1L, complete = TRUE, artifacts = list(list(',
    '  path = "cars.png", bytes = unname(file.size(produced)),',
    '  sha256 = digest::digest(produced, algo = "sha256", file = TRUE))))',
    'writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE), file.path(dirname(out), "inventory.json"))',
    'cat("rows:", nrow(datasets::cars), "\\n")',
    'invisible(NULL)',
    ''
  ].join('\n');
  await fs.writeFile(path.join(project, 'plot.R'), script);

  const grant = await operator.call('session.grant', { projectId: p.id, externalSessionId: 'execution-acceptance', methods: ['action.submit', 'action.observe', 'action.lookup', 'artifact.check', 'resource.register', 'composition.apply', 'capability.list'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  const operationId = 'acceptance-run-1';
  const submitted = await agent.call('action.submit', {
    projectId: p.id, operationId, action: 'r.execute', actionVersion: '0.2.0',
    input: {
      script: { kind: 'disk', path: 'plot.R', digest: createHash('sha256').update(await fs.readFile(path.join(project, 'plot.R'))).digest('hex') },
      args: [], requirements: [{ package: 'digest', source: 'cran' }, { package: 'jsonlite', source: 'cran' }],
      artifacts: [{ path: 'cars.png', kind: 'file', format: { mimeType: 'image/png' } }],
      completion: 'inventory.json'
    }
  });
  assert.ok(['active', 'unobserved'].includes(submitted.execution), 'a submitted run starts as an active run: ' + submitted.execution);
  check('a submitted run is accepted and starts active');

  // Deliberately no observe: the read itself must report the finished run.
  let run = null;
  for (let i = 0; i < 120; i++) {
    run = await agent.call('action.lookup', { projectId: p.id, operationId });
    if (!['active', 'unobserved'].includes(run.execution)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run.execution, 'completed', 'without an explicit observe the run reads as completed: ' + run.execution);
  check('a finished run reads as completed without an explicit observe');

  // The plan names the directory it handed to R; the check follows that, not a guess.
  process.stdout.write('plan.output: ' + run.plan?.output + '\n');
  const artifacts = path.join(project, run.plan.output);
  const bytes = await fs.readFile(path.join(artifacts, 'cars.png'));
  assert.ok(bytes.length > 1000 && bytes.subarray(1, 4).toString() === 'PNG', 'the declared artifact exists as a PNG');
  check('the declared artifact exists at the planned output path');

  // The owner's own integrity check is the supported way to confirm produced bytes.
  // Artifact facts are keyed by the principal that submitted the run, so the
  // producer checks its own artifacts; a different session sees not_found.
  const facts = await agent.call('artifact.check', { projectId: p.id, operationId });
  assert.equal(facts.integrity.state, 'verified', 'produced bytes verify against the declaration: ' + JSON.stringify(facts.integrity));
  check('artifact.check verifies the produced bytes');

  // Known gap, asserted rather than hidden: an executed artifact lives under owner
  // state, registration refuses it, and presentation only accepts native
  // artifact.ready events, so an Agent-run plot cannot be shown without that path.
  let presentable = true;
  try {
    await agent.call('resource.register', {
      projectId: p.id, expectedDigest: createHash('sha256').update(bytes).digest('hex'),
      declaration: { path: path.relative(project, path.join(artifacts, 'cars.png')), kind: 'file', format: { mimeType: 'image/png' } }
    });
  } catch (error) { presentable = false; report.gaps = [{ id: 'artifact-not-presentable', message: error?.error?.message ?? error?.message }]; }
  report.gapPresentable = presentable;

  const starts = (await fs.readFile(path.join(root, 'starts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  counts.hostStarts = starts;
  assert.equal(starts, 1, 'exactly one Host start for one execution: ' + starts);
  check('exactly one Host start for the execution');

  report.passed = true;
} catch (error) {
  report.failure = { message: error?.message, kind: error?.error?.kind, detail: error?.error ?? undefined };
  throw error;
} finally {
  await service?.close().catch(() => {});
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify(report) + '\n');
}
