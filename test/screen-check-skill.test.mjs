import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@rho-workspace/plugin-contracts';
import { RhoService } from '../dist/server.js';
import { screenCheckSkill } from '../dist/screen-check-skill.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';

// The Skill text exists twice on purpose: Rho serves it, and skills/rho carries it for an Agent that
// has the Skill installed. These tests keep the two copies the same and keep the Skill's commands true.
const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const script = path.join(root, 'scripts', 'screen-check.mjs');

test('the reference in skills/rho carries the served Skill text verbatim', async () => {
  const reference = await fs.readFile(path.join(root, 'skills', 'rho', 'references', 'screen-check.md'), 'utf8');
  assert.ok(reference.includes(screenCheckSkill.content), 'the reference includes the served text exactly');
  assert.equal(screenCheckSkill.digest, digest(screenCheckSkill.content));
});

test('every option the Skill names is one the command accepts', async () => {
  const { stdout } = await run(process.execPath, [script, '--help']);
  const named = new Set(screenCheckSkill.content.match(/--[a-z][a-z-]*/g));
  assert.ok(named.size >= 5, 'the Skill names the options');
  for (const option of named) assert.ok(stdout.includes(option), `help lists ${option}`);
});

test('every failure kind the Skill names is one the command emits', async () => {
  const source = await fs.readFile(script, 'utf8');
  assert.ok(screenCheckSkill.failureRecipes?.length >= 3);
  for (const recipe of screenCheckSkill.failureRecipes) {
    assert.ok(source.includes(`'${recipe.kind}'`), `the command emits ${recipe.kind}`);
    assert.ok(recipe.message && recipe.next, `${recipe.kind} says what happened and what to do`);
  }
});

test('the setup page downloads the reference, and the Skill routes to it', async () => {
  const setup = await fs.readFile(path.join(root, 'SETUP.md'), 'utf8');
  assert.equal(setup.match(/references\/screen-check\.md/g)?.length, 2, 'both the Bash and the PowerShell download lists name it');
  const skill = await fs.readFile(path.join(root, 'skills', 'rho', 'SKILL.md'), 'utf8');
  assert.match(skill, /\[references\/screen-check\.md\]\(references\/screen-check\.md\)/);
});

test('the service lists the Skill with the same text, digest and verify command as the module', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-screen-skill-'));
  await fs.mkdir(path.join(dir, 'work'));
  const service = await new RhoService({ root: dir, stateDir: path.join(dir, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const project = await operator.call('project.open', { path: 'work' });
    const skills = await operator.call('skill.list', { projectId: project.id });
    const served = skills.find(skill => skill.id === 'rho.screen-check');
    assert.ok(served, 'rho.screen-check is listed for the project');
    assert.equal(served.content, screenCheckSkill.content);
    assert.equal(served.digest, screenCheckSkill.digest);
    assert.equal(served.verify.command, screenCheckSkill.verify.command);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
