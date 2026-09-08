#!/usr/bin/env node
// Real external Codex acceptance only. Never builds, installs, or starts a user Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {FixtureHost,exec,json,digest,discoverSkills,skillOverrides} from './agent-interface/runtime.mjs';
import {RecordingProxy} from './agent-interface/proxy.mjs';
import {runAgent,EXPECTED_VERSION} from './agent-interface/agent.mjs';
import {createScenario,CORE_CASES,ADDITIONAL_CASES} from './agent-interface/scenarios.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const option=(name,fallback)=>{const index=process.argv.indexOf(name);assert.ok(index<0||process.argv[index+1],`Missing ${name} value`);return index<0?fallback:process.argv[index+1];};
if(process.argv.includes('--help')) {console.log(`Usage: node scripts/test-agent-interface.mjs --binary PATH --ark PATH --r-home PATH [--codex PATH] [--final]\n  --final: clean fixed tree, all ten cases x 3 plus native/Rho Skill equivalence and two adaptive cases; every run must pass\n  --filter category[,category] --runs N: debugging only; never acceptance\n  --evidence DIR: artifact parent (default target/agent-interface/acceptance)\n  --keep-fixtures: retain private temporary projects for debugging; default removes them\n  --list: list task categories without a model run\n  --self-test: validate harness parsers/assertions only; never acceptance\nRequires prebuilt current Rho+Ark, installed R, Chrome, UI node_modules, authenticated exact Codex CLI ${EXPECTED_VERSION}. Model is fixed gpt-6-astra/high. Does not build or install prerequisites.`);process.exit(0);}
if(process.argv.includes('--list')){console.log([...CORE_CASES,...ADDITIONAL_CASES].join('\n'));process.exit(0);}
if(process.argv.includes('--self-test')){await import('./agent-interface/self-test.mjs');process.exit(0);}
const filter=option('--filter',null)?.split(',');const runs=Number(option('--runs','3'));assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=3,'runs must be 1..3');
const final=process.argv.includes('--final');if(final){assert.equal(filter,undefined,'Final acceptance cannot filter cases');assert.equal(runs,3,'Final acceptance requires exactly three runs per core category');}
const binary=path.resolve(option('--binary',path.join(root,'target/debug/rho')));const ark=path.resolve(option('--ark',process.env.RHO_ARK||path.join(root,'target/debug/ark')));const codex=path.resolve(option('--codex','/Users/xiayh/.npm-global/bin/codex'));
for(const file of [binary,ark,codex])assert.ok(fs.statSync(file).isFile(),`Required prebuilt executable missing: ${file}`);
const rHome=option('--r-home',process.env.RHO_R_HOME)||exec('Rscript',['--vanilla','-e','cat(R.home())']);assert.ok(fs.existsSync(path.join(rHome,'bin','Rscript')),'Selected real R is required; no skipped/fallback pass');
const codexVersion=exec(codex,['--version']);assert.equal(codexVersion,EXPECTED_VERSION,'Use the exact preflight Codex CLI; model/version fallback is prohibited');
const commit=exec('git',['rev-parse','HEAD'],{cwd:root});const tree=exec('git',['rev-parse','HEAD^{tree}'],{cwd:root});const status=exec('git',['status','--porcelain'],{cwd:root});const sourceDiff=digest(exec('git',['diff','--binary','HEAD'],{cwd:root,maxBuffer:64*1024*1024}));if(final)assert.equal(status,'','Final acceptance requires a committed clean source tree');
const artifactRoot=path.resolve(option('--evidence',path.join(root,'target/agent-interface/acceptance')));const evidence=path.join(artifactRoot,`${commit.slice(0,12)}-${Date.now()}-${randomUUID().slice(0,8)}`);fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const options={root,binary,ark,rHome,codex,codexVersion,chromeChannel:option('--chrome-channel','chrome')};
const startManifest={schema_version:1,acceptance:final,started_at:new Date().toISOString(),commit,tree,source_status:status,source_diff_sha256:sourceDiff,model:'gpt-6-astra',reasoning_effort:'high',codex_version:codexVersion,limits:{tool_calls:80,text_return_utf8_bytes:1048576,wall_ms:600000},binaries:{rho:{path:binary,sha256:digest(fs.readFileSync(binary))},ark:{path:ark,sha256:digest(fs.readFileSync(ark))},codex:{path:codex,sha256:digest(fs.readFileSync(fs.realpathSync(codex)))},r_home:rHome},cases:[]};
json(path.join(evidence,'manifest.json'),startManifest);console.log(`Evidence: ${evidence}`);
const selected=[...CORE_CASES.flatMap(id=>Array.from({length:runs},(_,i)=>({id,repetition:i+1}))),...ADDITIONAL_CASES.map(id=>({id,repetition:1}))].filter(test=>!filter||filter.includes(test.id));assert.ok(selected.length,'No matching cases');
let failures=0;
for(const test of selected) {
  const caseEvidence=path.join(evidence,`${test.id}-${test.repetition}`);fs.mkdirSync(caseEvidence,{mode:0o700});
  const scientific=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-agent-science-')));const agentCwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rho-agent-isolated-')));assert.ok(!agentCwd.startsWith(root)&&!agentCwd.startsWith(scientific));
  const scenario=createScenario(test.id,test.repetition,scientific,caseEvidence);const host=new FixtureHost({...options,evidence:caseEvidence},scientific);let proxy,agent;const result={...test,passed:false,evidence:caseEvidence,errors:[]};
  console.log(`Starting ${test.id} ${test.repetition}/${CORE_CASES.includes(test.id)?runs:1}`);
  const heartbeat=setInterval(()=>console.log(`Running ${test.id}-${test.repetition}: ${proxy?.calls.length??0} tool calls, ${proxy?.textBytes??0} text bytes`),45000);
  try {
    assert.equal(exec(codex,['--version']),codexVersion,'Codex version changed during the fixed-version evaluation');scenario.prepareSkills?.(agentCwd);
    const initialDiscovery=await discoverSkills(codex,agentCwd);
    const allowed=scenario.allowedSkillFiles.filter(file=>path.basename(file)==='SKILL.md');
    const selectedRoots=[...allowed,...(scenario.disabledSkill?[scenario.disabledSkill]:[])];
    for(const file of selectedRoots)assert.ok(initialDiscovery.skills.some(skill=>path.resolve(skill.path)===file),`Standard Skill not present in actual Codex native discovery: ${file}`);
    const override=skillOverrides(initialDiscovery,allowed);
    const discovered=selectedRoots.length?await discoverSkills(codex,agentCwd,[override]):initialDiscovery;
    json(path.join(caseEvidence,'native-discovery.json'),discovered);
    let manifestFile=null;
    if(selectedRoots.length){
      const actual=discovered.skills.filter(skill=>selectedRoots.includes(path.resolve(skill.path)));
      const manifest={provider_id:'codex-cli',skills:actual.map(skill=>({source_key:`native-${digest(skill.path).slice(7)}`,root_path:path.dirname(fs.realpathSync(skill.path)),source_kind:skill.pluginId?'plugin':skill.scope==='user'?'user':'project',enablement:skill.enabled?'enabled':'disabled',reason:skill.enabled?null:'Disabled in this actual Codex discovery configuration.'}))};
      manifestFile=path.join(scientific,'host-skills.json');json(manifestFile,manifest);json(path.join(caseEvidence,'host-skills-manifest.json'),manifest);
      result.skill_resources=scenario.allowedSkillFiles.map(file=>({resource:path.relative(scenario.skillRoot,file),sha256:digest(fs.readFileSync(file))}));
      if(scenario.disabledSkill)assert.equal(actual.find(skill=>skill.path===scenario.disabledSkill)?.enabled,false,'Original method must really be disabled in platform discovery');
    }
    await host.start(scenario.project,manifestFile);await scenario.setup(host);
    json(path.join(caseEvidence,'private-fixture-truth.json'),{expected:scenario.expected,seed_operations:host.seedRecords,native_session:host.session,project:host.project,marker:scenario.marker});
    await host.screenshot('before.png');proxy=await new RecordingProxy(host,scenario,caseEvidence).start();
    agent=await runAgent({...options,evidence:caseEvidence},scenario,proxy,agentCwd,override);
    Object.assign(result,{facts:agent.report?.facts??null,tokens:agent.tokens,thread_id:agent.thread_id,calls:proxy.calls.length,text_bytes:proxy.textBytes,image_bytes:proxy.images.reduce((sum,image)=>sum+image.bytes,0),elapsed_ms:agent.elapsed_ms});
    assert.deepEqual(agent.violations,[],'Agent boundary/token/run violations');assert.ok(agent.report,'Real Codex final JSON is required');
    assert.ok(agent.report.complete,'Agent did not finish the requested task');await scenario.verify(agent.report,host,proxy,agent);await verifyScientificHistory(host,scenario,proxy,caseEvidence);
    proxy.assertNoDuplicateExecution();assert.deepEqual(proxy.violations,[],'Transport/scientific mechanical violations');
    assert.ok(proxy.calls.length+agent.nativeSkillReads.length<=80);assert.ok(proxy.textBytes+agent.native_text_bytes<=1048576);
    result.passed=true;
  } catch(error) {failures++;result.errors.push(error.stack??String(error));console.error(`FAILED ${test.id}-${test.repetition}: ${error.message}`);}
  finally {clearInterval(heartbeat);if(host.origin&&!fs.existsSync(path.join(caseEvidence,'authoritative-operations.json')))await captureScientificHistory(host,caseEvidence).catch(error=>result.errors.push(`history capture: ${error.message}`));await proxy?.close().catch(error=>result.errors.push(`proxy cleanup: ${error.message}`));await host.close().catch(error=>result.errors.push(`Host cleanup: ${error.message}`));if(result.errors.length&&result.passed){result.passed=false;failures++;}json(path.join(caseEvidence,'result.json'),result);startManifest.cases.push(result);json(path.join(evidence,'manifest.json'),startManifest);if(!process.argv.includes('--keep-fixtures')){fs.rmSync(scientific,{recursive:true,force:true});fs.rmSync(agentCwd,{recursive:true,force:true});}else result.private_fixture_roots={scientific,agent:agentCwd};}
  console.log(`${result.passed?'PASS':'FAIL'} ${test.id}-${test.repetition}`);
}
let equivalence={checked:false};const native=startManifest.cases.find(c=>c.id==='skill_native');const rho=startManifest.cases.find(c=>c.id==='skill_rho');
if(native&&rho){try{assert.ok(native.passed&&rho.passed);assert.deepEqual(native.skill_resources,rho.skill_resources,'Native and Rho must read byte-identical standard Skill resources');const core=run=>run.facts.map(({key,value})=>({key,value})).sort((a,b)=>a.key.localeCompare(b.key));assert.deepEqual(core(native),core(rho),'Native and Rho standard method results must agree');equivalence={checked:true,passed:true};}catch(error){failures++;equivalence={checked:true,passed:false,error:error.message};}}
const endCommit=exec('git',['rev-parse','HEAD'],{cwd:root});const endStatus=exec('git',['status','--porcelain'],{cwd:root});
const fixedTree=commit===endCommit&&status===endStatus&&sourceDiff===digest(exec('git',['diff','--binary','HEAD'],{cwd:root,maxBuffer:64*1024*1024}))&&exec(codex,['--version'])===codexVersion&&digest(fs.readFileSync(fs.realpathSync(codex)))===startManifest.binaries.codex.sha256&&digest(fs.readFileSync(binary))===startManifest.binaries.rho.sha256&&digest(fs.readFileSync(ark))===startManifest.binaries.ark.sha256;if(!fixedTree){failures++;startManifest.fixed_tree_error='Source or native binary changed during evaluation';}
const coreRuns=startManifest.cases.filter(c=>CORE_CASES.includes(c.id));
startManifest.completed_at=new Date().toISOString();startManifest.fixed_tree=fixedTree;startManifest.skill_equivalence=equivalence;startManifest.failures=failures;startManifest.core_total=coreRuns.length;startManifest.core_passed=coreRuns.filter(c=>c.passed).length;startManifest.passed=failures===0&&(!final||(coreRuns.length===30&&startManifest.cases.length===34&&equivalence.passed));
startManifest.artifacts=hashArtifacts(evidence);json(path.join(evidence,'manifest.json'),startManifest);
console.log(`${startManifest.passed?'PASS':'FAIL'}: ${startManifest.core_passed}/${startManifest.core_total} core runs, ${startManifest.cases.length-coreRuns.length} extra runs; ${failures} failures. ${final?'Final acceptance':'Debug run; not final acceptance'}.`);if(!startManifest.passed)process.exitCode=1;
function hashArtifacts(directory,prefix='') {return fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const relative=path.join(prefix,entry.name);if(relative==='manifest.json')return [];const full=path.join(directory,entry.name);return entry.isDirectory()?hashArtifacts(full,relative):[{path:relative,bytes:fs.statSync(full).size,sha256:digest(fs.readFileSync(full))}];});}

async function captureScientificHistory(host,evidence) {
  const records=[];let cursor;
  for(let page=0;page<16;page++) {
    const snapshot=await host.query('operation.list_recent',{limit:100,...(cursor?{before_cursor:cursor}:{})});
    assert.equal(snapshot.status,'ready');
    for(const summary of snapshot.data.operations)records.push(await host.get(summary.operation_id));
    cursor=snapshot.data.next_cursor;if(!cursor)break;
    assert.ok(page<15,'Scientific history exceeded acceptance inspection budget');
  }
  json(path.join(evidence,'authoritative-operations.json'),records);return records;
}
async function verifyScientificHistory(host,scenario,proxy,evidence) {
  const records=await captureScientificHistory(host,evidence);
  const byRequest=new Map();const byCode=new Map();
  for(const record of records){const op=record.operation;if(host.seedRecords.includes(op.operation_id))continue;
    assert.equal(op.principal.kind,'human','principal mixup');assert.equal(op.principal.id,'local-user','principal mixup');assert.equal(op.caller.kind,'agent','Agent scientific actor was lost');assert.equal(op.caller.id,'local-mcp','Agent scientific actor was replaced by the Studio bridge');
    const previous=byRequest.get(op.client_request_id);assert.ok(!previous||previous===op.operation_id,'duplicate client request produced independent scientific execution');byRequest.set(op.client_request_id,op.operation_id);
    if(op.capability.id==='workspace.run_r') {assert.ok(!scenario.prohibitR,'task executed prohibited R through an indirect path');const code=op.normalized_arguments.code;assert.ok(!byCode.has(code)||byCode.get(code)===op.operation_id,'duplicate scientific execution under a fresh identity');byCode.set(code,op.operation_id);}
  }
}
