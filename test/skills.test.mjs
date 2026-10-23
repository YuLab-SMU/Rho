import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { operations } from '../dist/protocol.js';
import { Ajv } from 'ajv';

// A Skill that describes a path nobody runs drifts from the code. Every available
// Skill that declares machine-readable parts must agree with the shipped contracts:
// its example validates, the methods it names exist, and the command it points at is
// a real script of this application.
const require = createRequire(import.meta.url);
const app = require('../package.json');

export async function skillsFor() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-skills-'));
  await fs.mkdir(path.join(root, 'work'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  const skills = await operator.call('skill.list', { projectId: p.id });
  return { root, service, p, operator, skills, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('every machine-readable Skill part matches a real operation and a real command', async () => {
  const f = await skillsFor();
  try {
    assert.ok(f.skills.length > 0, 'the project exposes at least one Skill');
    const named = new Set(Object.keys(operations));
    const problems = [];
    for (const skill of f.skills) {
      for (const method of skill.requires ?? []) if (!named.has(method)) problems.push(`${skill.id}: requires unknown operation ${method}`);
      if (skill.example && !named.has(skill.example.method)) problems.push(`${skill.id}: example names unknown operation ${skill.example.method}`);
      if (skill.verify) {
        const command = skill.verify.command.replace(/^npm run /, '');
        if (!app.scripts?.[command]) problems.push(`${skill.id}: verify command ${command} is not an application script`);
        else {
          // The advertised command must name a file this checkout actually contains.
          const script = app.scripts[command].split(' ').filter(part => part.endsWith('.mjs'))[0];
          if (script) await fs.access(path.join(process.cwd(), script)).catch(() => problems.push(`${skill.id}: verify script ${script} is missing`));
        }
        if (!skill.verify.description) problems.push(`${skill.id}: verify has no description`);
      }
      for (const recipe of skill.failureRecipes ?? []) {
        if (!recipe.kind || !recipe.message || !recipe.next) problems.push(`${skill.id}: incomplete failure recipe`);
      }
    }
    assert.deepEqual(problems, []);
  } finally { await f.cleanup(); }
});

test('a declared example validates against the operation it illustrates', async () => {
  const f = await skillsFor();
  try {
    const withExample = f.skills.filter(skill => skill.example);
    assert.ok(withExample.length > 0, 'at least one Skill carries an example to check');
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const skill of withExample) {
      const schema = operations[skill.example.method];
      assert.ok(schema, `${skill.id} illustrates a shipped operation`);
      // projectId is supplied by every caller, so the example may omit it.
      const body = { projectId: 'example', ...skill.example.input };
      const validate = ajv.compile(schema);
      assert.equal(validate(body), true, `${skill.id} example is valid: ${JSON.stringify(validate.errors)}`);
    }
  } finally { await f.cleanup(); }
});

test('prose-only Skills are reported, so the remaining debt stays visible', async () => {
  const f = await skillsFor();
  try {
    const bare = f.skills.filter(skill => !skill.verify).map(skill => skill.id);
    // Not a failure: converting every Skill is planned work. It is printed so the
    // count cannot quietly grow while the plan claims Skills are contracts.
    process.stdout.write(`skills without a verify command: ${bare.length}/${f.skills.length} (${bare.join(', ')})\n`);
    assert.ok(f.skills.length - bare.length >= 3, 'the converted Skills stay converted');
  } finally { await f.cleanup(); }
});
