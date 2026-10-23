import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Status cites numbers. A cited number that no check produced is a claim, not evidence,
// and it drifts the moment a test is added. This holds the two together: the ledger is
// written by running the checks, and the line Status points at must agree with it.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ledger = JSON.parse(await fs.readFile(path.join(root, 'docs/VERIFICATION.json'), 'utf8'));

test('the ledger records a result for every check it claims', () => {
  assert.equal(ledger.schemaVersion, 1);
  // No commit field: it would name its own parent and be stale by construction.
  assert.equal(ledger.commit, undefined);
  for (const [id, result] of Object.entries(ledger.checks)) {
    assert.ok(result.command, `${id} names its command`);
    assert.ok(Number.isSafeInteger(result.tests) && result.tests > 0, `${id} recorded a test count`);
    assert.equal(result.passed, result.exitCode === 0 && result.tests === result.passing, `${id} agrees with itself`);
    assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/, `${id} records when it ran`);
  }
});

test('Status cites the ledger numbers, not numbers of its own', async () => {
  const status = await fs.readFile(path.join(root, 'docs/STATUS.md'), 'utf8');
  assert.match(status, /\]\(VERIFICATION\.json\)/, 'Status links the ledger');
  // Every current count in Status must be traceable to a ledger value.
  const counts = [...status.matchAll(/(?:Rho|Plugins) (\d+)\/(\d+)/g)].map(match => ({ total: Number(match[2]) }));
  const known = new Set(Object.values(ledger.checks).map(check => check.tests));
  // Historical sections may cite counts from past accepted runs; the current line must
  // cite one the ledger supports.
  const current = status.split('\n').find(line => line.includes('](VERIFICATION.json)'));
  assert.ok(current, 'Status has a current verification line');
  const cited = Number(current.match(/(\d+)\/(\d+)/)?.[2]);
  assert.ok(known.has(cited), `the current count ${cited} is one the ledger recorded (${[...known].join(', ')})`);
  assert.ok(counts.length > 0);
});
