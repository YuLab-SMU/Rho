import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { explorableTable, loadCode, projectPath, scriptLanguage, sourceCode, valueName } from '../dist/explore-code.js';

test('a table loads into a new value named from its file, never one the session has', () => {
  assert.equal(valueName('results/model_fit.csv', 'r', new Set()), 'model_fit');
  assert.equal(valueName('results/model_fit.csv', 'r', new Set(['model_fit', 'model_fit_2'])), 'model_fit_3');
  assert.equal(valueName('2024 counts (raw).tsv.gz', 'python', new Set()), 'table_2024_counts_raw');
  assert.equal(valueName('data.csv', 'r', new Set()), 'data_table');
  assert.equal(valueName('pd.csv', 'python', new Set()), 'pd_table');
  assert.equal(valueName('表.csv', 'r', new Set()), 'table');
  assert.ok(explorableTable('a/b.csv') && explorableTable('b.tsv.gz') && !explorableTable('@src/b.csv') && !explorableTable('b.xlsx'));
  assert.equal(scriptLanguage('analysis.R'), 'r'); assert.equal(scriptLanguage('fit.py'), 'python'); assert.equal(scriptLanguage('@src/fit.py'), null);
  // A kept version is read by the project path it was kept from.
  assert.equal(projectPath({ path: '.rho/plugins/restored/x/y', provenance: { originalPath: 'model_fit.csv' } }), 'model_fit.csv');
});

// The code is what the person sees and runs; it must load the file as written, in each language.
test('the written code reads the table and runs the script in R and Python', async t => {
  const dir = await fs.mkdtemp('/tmp/rho-explore-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'fit "one".csv'), 'model,AIC\nage,104.1\nBMI,111.8\n');
  await fs.writeFile(path.join(dir, 'fit.tsv'), 'model\tAIC\nage\t104.1\n');
  await fs.writeFile(path.join(dir, 'made.R'), 'made <- nrow(read.csv("fit \\"one\\".csv"))\n');
  await fs.writeFile(path.join(dir, 'made.py'), 'import os\nmade = os.path.basename(__file__)\n');
  const rscript = process.env.RHO_RSCRIPT ?? 'Rscript', python = process.env.RHO_PYTHON ?? 'python3';
  const r = execFileSync(rscript, ['-e', [loadCode('fit "one".csv', 'r', 'fit'), loadCode('fit.tsv', 'r', 'tsv'), sourceCode('made.R', 'r'), 'cat("\\nloaded", nrow(fit), ncol(tsv), made, "\\n")'].join('\n')], { cwd: dir, encoding: 'utf8' });
  assert.match(r, /loaded 2 2 2/);
  let pandas = true;
  try { execFileSync(python, ['-c', 'import pandas'], { stdio: 'ignore' }); } catch { pandas = false; }
  if (!pandas) { t.diagnostic('pandas is not installed for ' + python + '; the Python table load was not run'); return; }
  const code = [loadCode('fit "one".csv', 'python', 'fit'), loadCode('fit.tsv', 'python', 'tsv'), sourceCode('made.py', 'python'), 'print("loaded", len(fit), tsv.shape[1], made)'].join('\n');
  assert.match(execFileSync(python, ['-c', code], { cwd: dir, encoding: 'utf8' }), /loaded 2 2 made\.py/);
});
