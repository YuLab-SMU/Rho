import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installText, readInstall } from '../dist/installs.js';
import { activitySummary, toolActivity } from '../dist/conversation-presentation.js';

// What uv and pip print when they install, as the Agent's command step keeps it (its last lines).
const uvPrinted = `Resolved 10 packages in 812ms
Prepared 3 packages in 1.21s
Installed 10 packages in 64ms
 + numpy==2.3.4
 + packaging==25.0
 + pandas==2.2.3
 + patsy==1.0.2
 + python-dateutil==2.9.0.post0
 + pytz==2025.2
 + scipy==1.16.3
 + six==1.17.0
 + statsmodels==0.14.5
 + tzdata==2025.2`;
const pipPrinted = `Installing collected packages: interface_meta, patsy, formulaic, statsmodels
Successfully installed formulaic-1.2.2 interface_meta-2.0.1 patsy-1.0.3 statsmodels-0.15.0`;

test('an install command reads as the packages it installed, with the versions it printed and the tool', () => {
  const uv = readInstall('cd "plant growth" && uv venv && uv pip install --python .venv/bin/python pandas statsmodels', uvPrinted);
  assert.deepEqual(uv, { tool: 'uv', packages: [{ name: 'pandas', version: '2.2.3' }, { name: 'statsmodels', version: '0.14.5' }], more: 8, from: null });
  assert.equal(installText(uv), 'pandas 2.2.3, statsmodels 0.14.5 and 8 more (uv)');
  assert.equal(installText(readInstall('.venv/bin/python -m pip install -q statsmodels', pipPrinted)), 'statsmodels 0.15.0 and 3 more (pip)');
  assert.equal(installText(readInstall('rtk pip install "pandas==2.2.*" scikit-learn[all]>=1.5')), 'pandas, scikit-learn (pip)', 'a range is not a version');
  assert.equal(installText(readInstall('uv add polars==1.31.0')), 'polars 1.31.0 (uv)', 'an exact pin is the version when nothing was printed');
  assert.equal(installText(readInstall('source .venv/bin/activate && pip install -r requirements.txt')), 'packages from requirements.txt (pip)');
  assert.equal(installText(readInstall('conda install -y -c conda-forge -n analysis conda-forge::statsmodels')), 'statsmodels (conda)');
  assert.equal(installText(readInstall(`Rscript -e 'install.packages(c("ggplot2", "patchwork"), repos = "https://cloud.r-project.org")'`)), 'ggplot2, patchwork (R)');
  assert.equal(installText(readInstall(`Rscript -e 'BiocManager::install("DESeq2")'`)), 'DESeq2 (BiocManager)');
  assert.equal(installText(readInstall('python3 -m pip install \\\n  numpy')), 'numpy (pip)', 'a continued line is one command');
  // The command a Rho-started Claude Code ran in the episode: uv when present, else venv and pip.
  assert.equal(installText(readInstall('cd "plant growth"; (command -v uv && uv venv .venv && uv pip install --python .venv/bin/python pandas statsmodels) || (python3 -m venv .venv && .venv/bin/pip install -q pandas statsmodels); .venv/bin/python -c "import statsmodels"', uvPrinted)),
    'pandas 2.2.3, statsmodels 0.14.5 and 8 more (uv)');
  assert.equal(installText(readInstall('(pip install numpy)')), 'numpy (pip)', 'a subshell is a command');
  assert.equal(installText(readInstall('if [ -d .venv ]; then .venv/bin/pip install scipy; fi')), 'scipy (pip)');
  assert.equal(readInstall('command -v uv'), null);
});

test('commands that install nothing stay commands', () => {
  for (const command of ['uv venv .venv', 'pip list', 'pip install -e .', 'pip install ./dist/pkg-1.0.whl', 'python3 analysis.py', 'echo "pip install pandas"', 'uv pip compile requirements.in', 'Rscript -e "library(ggplot2)"'])
    assert.equal(readInstall(command), null, command);
});

test('the Agent panel shows an install as what it installed, and keeps its command in the details', () => {
  const step = extra => ({ id: 's1', at: '2026-11-03T08:00:00Z', tool: 'Bash', toolKind: 'execute', detail: 'uv pip install pandas statsmodels', ...extra });
  const done = toolActivity(step({ outcome: 'returned', exitCode: 0, output: { text: uvPrinted, lines: 13, cut: false } }), null, '/tmp/project');
  assert.deepEqual([done.action, done.verb, done.target, done.targetKind], ['execute', 'Installed', 'pandas 2.2.3, statsmodels 0.14.5 and 8 more (uv)', 'packages']);
  assert.equal(done.step.detail, 'uv pip install pandas statsmodels');
  assert.equal(toolActivity(step({ outcome: 'requested' }), null).verb, 'Installing');
  const failed = toolActivity(step({ outcome: 'returned', exitCode: 1, output: { text: 'error: No virtual environment found', lines: 1, cut: false } }), null);
  assert.deepEqual([failed.verb, failed.outcome, failed.target], ['Tried to install', 'failed', 'pandas, statsmodels (uv)']);
  assert.equal(toolActivity(step({ detail: 'uv venv', outcome: 'returned', exitCode: 0 }), null).verb, 'Ran');
  // The folded work names what was installed and counts the other commands.
  const venv = toolActivity(step({ id: 's0', detail: 'uv venv', outcome: 'returned', exitCode: 0 }), null);
  const more = toolActivity(step({ id: 's2', detail: 'uv pip install pandas scipy matplotlib', outcome: 'returned', exitCode: 0 }), null);
  assert.equal(activitySummary([venv, done, more]), 'Ran 1 command · Installed pandas, statsmodels, scipy and 1 more');
  assert.equal(activitySummary([done, failed]), 'Installed pandas, statsmodels · Tried to install pandas, statsmodels · 1 failed');
});
