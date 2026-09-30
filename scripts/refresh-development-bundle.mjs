// Explicit milestone refresh. Reuse unaffected archives; all exports use the
// ordinary CLI. Builds are serial and this never installs into a user catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pluginCommand} from './plugin-set.mjs';
import {buildRhoBundle} from './build-rho-bundle.mjs';
import {sha256} from './rho-bundle.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  assert.ok(['--previous','--rho','--out','--evidence'].includes(args[i])&&!options[args[i]]&&args[i+1]);
  options[args[i]]=path.resolve(args[i+1]);
}
for(const key of ['--previous','--rho','--out','--evidence'])assert.ok(options[key],`Missing ${key}`);
const previous=options['--previous'],rho=fs.realpathSync(options['--rho']),out=options['--out'];
assert.ok(!fs.existsSync(out)&&!fs.existsSync(`${out}-set`),'Preserve earlier attempts; choose a new destination');
const staging=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-development-refresh-')));
const report={status:'running',source_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  previous,staging,core_sha256:sha256(fs.readFileSync(rho)),builds:[],packages:[],reused:[]};
const save=()=>fs.writeFileSync(options['--evidence'],JSON.stringify(report,null,2)+'\n');
const started=Date.now();save();
try {
  const prior=JSON.parse(fs.readFileSync(path.join(previous,'plugin-set.json')));
  // These native packages do not consume plugin-ui. Guard their actual source
  // and build dependencies against the previous bundle's recorded checkout.
  const baseline=JSON.parse(fs.readFileSync(path.join(previous,'rho-bundle.json'))).assembly_checkout.commit;
  const unchanged=['plugins/environment','plugins/process','plugins/remote','plugins/r/api','crates/process-engine',
    'crates/plugin-sdk','crates/plugin-protocol','Cargo.toml','Cargo.lock','LICENSE',
    'scripts/build-environment-plugin.mjs','scripts/build-process-plugin.mjs','scripts/build-remote-plugin.mjs'];
  assert.equal(execFileSync('git',['diff',baseline,'--',...unchanged],{cwd:root,encoding:'utf8'}),'','Retained native package inputs changed');
  const setDirectory=`${out}-set`;fs.mkdirSync(setDirectory);
  const set={...prior,name:'Current visual runtime and annotation foundation',assembly_cli_sha256:report.core_sha256,packages:[]};
  for(const old of prior.packages){
    const name=old.plugin.replace('org.rho.',''),archive=path.join(setDirectory,old.file);
    if(['environment','process','remote'].includes(name)){
      const bytes=fs.readFileSync(path.join(previous,old.file));assert.equal(sha256(bytes),old.sha256);
      fs.writeFileSync(archive,bytes,{flag:'wx'});set.packages.push(old);report.reused.push(old);save();continue;
    }
    const buildName=name==='annotations'?'annotation':name,directory=path.join(staging,name),begin=Date.now();
    const log=path.join(staging,`${name}-build.log`),fd=fs.openSync(log,'w');
    const stage={name,directory,log,status:'building'};report.builds.push(stage);save();
    try {execFileSync(process.execPath,[path.join(root,`scripts/build-${buildName}-plugin.mjs`),directory],
      {cwd:root,stdio:['ignore',fd,fd]});} finally {fs.closeSync(fd);stage.seconds=(Date.now()-begin)/1000;save();}
    stage.status='built';save();console.log(JSON.stringify(stage));
    const target=old.artifacts[0].target,database=path.join(staging,'assembly.sqlite');
    const snapshot=pluginCommand(rho,database,'snapshot',directory,'--target',target);
    pluginCommand(rho,database,'export',snapshot.revision,archive);
    const bytes=fs.readFileSync(archive),value=JSON.parse(bytes);
    assert.equal(value.revision.manifest.id,old.plugin);
    const entry={file:old.file,bytes:bytes.length,sha256:sha256(bytes),plugin:old.plugin,revision:value.revision.id,
      artifacts:value.artifacts.map(a=>({id:a.id,target:a.target}))};
    set.packages.push(entry);report.packages.push({name,version:value.revision.manifest.version,old,new:entry,directory});save();
  }
  fs.copyFileSync(path.join(root,'scripts/plugin-set.mjs'),path.join(setDirectory,'plugin-set.mjs'));
  fs.writeFileSync(path.join(setDirectory,'plugin-set.json'),JSON.stringify(set,null,2)+'\n');
  // buildRhoBundle validates every archive before copying it.
  const assembled=buildRhoBundle({rho,plugins:setDirectory,destination:out});
  assert.equal(sha256(fs.readFileSync(path.join(out,'rho'))),report.core_sha256);
  report.set=setDirectory;report.bundle=out;report.manifest=assembled.manifest;
  report.manifest_sha256=sha256(fs.readFileSync(path.join(out,'rho-bundle.json')));
  report.total_bytes=fs.readdirSync(out).reduce((sum,file)=>sum+fs.statSync(path.join(out,file)).size,0);
  report.status='assembled_and_archive_validated';report.seconds=(Date.now()-started)/1000;save();
  console.log(JSON.stringify({status:report.status,bundle:out,bytes:report.total_bytes,seconds:report.seconds}));
} catch(error){report.status='failed';report.error=String(error.stack??error);report.seconds=(Date.now()-started)/1000;save();throw error;}
