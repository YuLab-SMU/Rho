import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, parseSkillFile } from '@rho-workspace/plugin-contracts';
import { rhoWorkspaceSkill, personFilesSkill, analysisRunSkillDeclaration, taskMapSkill } from '../dist/capabilities.js';
import { screenCheckSkill } from '../dist/screen-check-skill.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const declared = [rhoWorkspaceSkill, personFilesSkill, analysisRunSkillDeclaration, taskMapSkill, screenCheckSkill];

test('Rho operation declarations load their canonical SKILL.md files', async () => {
  for (const skill of declared) {
    const file = path.join(root, 'skills', 'rho', 'operations', skill.id.replace('.', '-'), 'SKILL.md');
    const parsed = parseSkillFile(file, await fs.readFile(file, 'utf8'));
    assert.equal(parsed.name, skill.id.replace('.', '-'));
    assert.equal(parsed.body, skill.content, `${skill.id} is served from its SKILL.md body`);
    assert.equal(digest(parsed.body), skill.digest, `${skill.id} is digested from its SKILL.md body`);
  }
});

test('the installed integration Skill is a standard package Skill', async () => {
  const file = path.join(root, 'skills', 'rho', 'SKILL.md');
  const parsed = parseSkillFile(file, await fs.readFile(file, 'utf8'));
  assert.equal(parsed.name, 'rho');
  assert.ok(parsed.description.length > 0);
  assert.match(parsed.body, /^#\s+\S/m);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('skills/README.md'));
  assert.ok(manifest.files.includes('skills/rho'));
});
