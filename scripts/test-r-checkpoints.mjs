#!/usr/bin/env node
// Builds a private native component for the selected R; never installs an R package.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const r = process.env.RHO_CHECKPOINT_R || 'R';
function run(args, cwd = root) {
  const result = spawnSync(r, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`${r} ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const info = JSON.parse(run(['--vanilla','--slave','-e','cat(jsonlite::toJSON(list(r_executable=normalizePath(file.path(R.home("bin"),"R")),r_home=R.home(),r_version=as.character(getRversion()),platform=R.version$platform,extension=.Platform$dynlib.ext),auto_unbox=TRUE))']));
const directory = join(root,'target','rho-checkpoint',`${info.r_version}-${info.platform}`);
mkdirSync(directory,{recursive:true});
copyFileSync(join(root,'r/checkpoint/checkpoint.c'),join(directory,'checkpoint.c'));
const library = join(directory,`rho_checkpoint${info.extension}`);
run(['CMD','SHLIB','checkpoint.c','-o',library],directory);
const sha256 = `sha256:${createHash('sha256').update(readFileSync(library)).digest('hex')}`;
writeFileSync(join(directory,'manifest.json'),JSON.stringify({...info,library,sha256},null,2)+'\n');
// Callers that need RHO_CHECKPOINT_HELPER read the bare path; the manifest beside it is verified too.
const printLibrary = process.argv.includes('--print-library');
if (printLibrary) console.log(library);
else console.log(`Built verified native provider: ${library}`);
const buildOnly = process.argv.includes('--build-only') || printLibrary;
if (!buildOnly) {
  const output = spawnSync(r,['--vanilla','--slave','-f',join(root,'r/checkpoint/tests.R')],{cwd:root,encoding:'utf8',env:{...process.env,RHO_CHECKPOINT_TEST_LIBRARY:library}});
  process.stdout.write(output.stdout); process.stderr.write(output.stderr);
  if (output.status !== 0) process.exit(output.status || 1);
}

if (!buildOnly) {
  const fixture = mkdtempSync(join(root,'target','checkpoint-roundtrip-'));
  try {
    for (const phase of ['capture','restore']) {
      const result = spawnSync(r,['--vanilla','--slave','-f',join(root,'r/checkpoint/roundtrip.R')],{cwd:root,encoding:'utf8',env:{...process.env,RHO_CHECKPOINT_TEST_LIBRARY:library,RHO_CHECKPOINT_FIXTURE_DIRECTORY:fixture,RHO_CHECKPOINT_FIXTURE_PHASE:phase}});
      process.stdout.write(result.stdout);process.stderr.write(result.stderr);
      if (result.status!==0) process.exit(result.status||1);
    }
  } finally { rmSync(fixture,{recursive:true,force:true}); }
}
