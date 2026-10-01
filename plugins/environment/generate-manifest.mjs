import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url)), check = process.argv.includes('--check');
assert.ok(process.argv.slice(2).every(arg => arg === '--check'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-environment-manifest-'));
try {
  const output = path.join(temporary, 'plugin.json');
  execFileSync(process.env.RHO_PLUGIN_CARGO ?? 'cargo', ['run', '--manifest-path', path.join(root, 'backend/Cargo.toml'), '-p', 'rho-environment-backend', '--bin', 'export-environment-manifest', '--locked', '--offline', '--', output], { cwd: root, stdio: 'inherit' });
  const contents = fs.readFileSync(output, 'utf8');
  if (check) assert.equal(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'), contents, 'Stale Environment manifest');
  else fs.writeFileSync(path.join(root, 'plugin.json'), contents);
  console.log(`Environment contributed schemas and manifest ${check ? 'verified' : 'generated'}.`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
