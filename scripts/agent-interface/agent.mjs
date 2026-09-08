import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import readline from 'node:readline';
import {json,digest} from './runtime.mjs';
import {FINAL_SCHEMA,REPORT_INSTRUCTION} from './scenarios.mjs';
const EXPECTED_VERSION='codex-cli 0.153.4';
export {EXPECTED_VERSION};
export function nativeReadPath(command,allowed) {
  // Permit only a single literal cat of an exact supplied standard Skill
  // resource. No glob, expansion, redirect, pipeline, shell script or extra path.
  const shell=command.match(/^(?:\/[^ ]+\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/);
  if(shell) {
    const wrapped=shell[1];
    if(wrapped[0]==="'"&&wrapped.at(-1)==="'")command=wrapped.slice(1,-1).replaceAll("'\\''", "'");
    else if(wrapped[0]==='"'&&wrapped.at(-1)==='"') {try{command=JSON.parse(wrapped);}catch{return null;}}
    else return null;
  }
  for(const file of allowed)for(const candidate of [`cat ${file}`,`cat '${file.replaceAll("'","'\\''")}'`,`cat ${JSON.stringify(file)}`,`cat -- ${file}`,`cat -- '${file}'`,`cat -- ${JSON.stringify(file)}`])if(command.trim()===candidate)return file;
  return null;
}
export async function runAgent(options,scenario,proxy,cwd,skillsOverride) {
  const schemaFile=path.join(options.evidence,'final.schema.json');json(schemaFile,FINAL_SCHEMA);
  const outputFile=path.join(options.evidence,'final.json');
  const policy=`Scientific facts and actions for this task must come exclusively through the rho MCP server. Do not use shell, filesystem, web, other MCP servers, process commands, browser tools, or external services to access scientific data. Do not read Rho source, acceptance artifacts, fixture constructors, answer files, or hidden local paths. Do not ask the harness for answers. ${scenario.prohibitR?'workspace.run_r is prohibited for this task. Explicit help rendering is permitted only when requested.':''} ${scenario.skillMode==='native'?`The only filesystem exception is reading these exact standard Skill resources, one literal cat command per resource: ${scenario.allowedSkillFiles.join(', ')}. These resources contain methods, not scientific data. Do not execute their scripts locally.`:'Read Skill resources through Rho if needed; native filesystem reads are prohibited.'} Use up to 80 actual tool/resource calls and 1 MiB UTF-8 textual tool results. Native images are recorded separately. Finish within ten minutes. Preserve identities, uncertainty and concurrent user work. ${REPORT_INSTRUCTION}`;
  const overrides=[
    'model_reasoning_effort="high"','approval_policy="never"','web_search="disabled"','features.apps=false','features.hooks=false','features.multi_agent=false','features.goals=false','features.skill_mcp_dependency_install=false',
    `features.shell_tool=${scenario.skillMode==='native'}`,'features.unified_exec=false','features.shell_snapshot=false','features.code_mode.enabled=false',
    `developer_instructions=${JSON.stringify(policy)}`,skillsOverride,
    `mcp_servers.rho.url=${JSON.stringify(proxy.url)}`,'mcp_servers.rho.bearer_token_env_var="RHO_ACCEPTANCE_MCP_TOKEN"','mcp_servers.rho.default_tools_approval_mode="approve"','mcp_servers.rho.required=true','mcp_servers.rho.startup_timeout_sec=30','mcp_servers.rho.tool_timeout_sec=90',
  ];
  const args=['exec','--ignore-user-config','--ignore-rules','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-m','gpt-6-astra','-C',cwd,'--output-schema',schemaFile,'--output-last-message',outputFile,...overrides.flatMap(value=>['-c',value]),'-'];
  // Process-local bearer only; no persisted Codex configuration or auth changes.
  const child=spawn(options.codex,args,{cwd,env:{...process.env,RHO_ACCEPTANCE_MCP_TOKEN:proxy.token},stdio:['pipe','pipe','pipe']});
  const ended=once(child,'exit');const stdout=fs.createWriteStream(path.join(options.evidence,'codex.jsonl'),{mode:0o600});const stderr=fs.createWriteStream(path.join(options.evidence,'codex.stderr.log'),{mode:0o600});child.stderr.pipe(stderr);child.stdout.pipe(stdout);
  const events=[];const violations=[];const nativeSkillReads=[];let finalText='';let threadId=null;const usage=[];const seenTools=new Set();let nativeBytes=0;
  let killed=false;const stop=reason=>{if(!violations.includes(reason))violations.push(reason);if(!killed){killed=true;child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1500).unref();}};
  proxy.onViolation=stop;
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return stop('invalid_codex_jsonl');}events.push(event);
    if(event.type==='thread.started'){if(threadId&&threadId!==event.thread_id)stop('multiple_agent_sessions_in_one_task');threadId=event.thread_id;}
    if(event.type==='turn.completed')usage.push(event.usage);
    if(event.type==='turn.failed'||event.type==='error')violations.push(`codex_${event.type}:${JSON.stringify(event).slice(0,1000)}`);
    const item=event.item;if(!item)return;
    if(!['agent_message','reasoning','todo_list','error','mcp_tool_call','command_execution'].includes(item.type))stop(`unapproved_agent_item:${item.type}`);
    if(item.type==='agent_message'&&event.type==='item.completed')finalText=item.text;
    if(['command_execution','file_change','web_search','mcp_tool_call','collab_tool_call','computer_tool_call'].includes(item.type)&&!seenTools.has(item.id)) {
      seenTools.add(item.id);
      if(item.type==='command_execution') {
        const read=nativeReadPath(item.command??'',scenario.skillMode==='native'?scenario.allowedSkillFiles:[]);
        if(!read)stop(`non_rho_shell_access:${item.command}`);
      } else if(item.type==='mcp_tool_call') {if(item.server!=='rho')stop(`non_rho_MCP:${item.server}`);}
      else stop(`non_rho_tool:${item.type}`);
    }
    if(item.type==='command_execution'&&event.type==='item.completed'){const read=nativeReadPath(item.command??'',scenario.skillMode==='native'?scenario.allowedSkillFiles:[]);if(read){if(item.exit_code!==0||item.aggregated_output!==fs.readFileSync(read,'utf8'))stop('native_skill_read_not_exact');else nativeSkillReads.push(read);}nativeBytes+=Buffer.byteLength(item.aggregated_output??'');if(proxy.textBytes+nativeBytes>1024*1024)stop('text_tool_return_budget_exceeded');if(proxy.calls.length+nativeSkillReads.length>80)stop('tool_call_budget_exceeded');}
  });
  const started=Date.now();const timer=setTimeout(()=>stop('task_deadline_exceeded'),600000);
  const prompt=scenario.prompt();fs.writeFileSync(path.join(options.evidence,'prompt.txt'),prompt);child.stdin.end(prompt);
  const [exitCode,signal]=await ended;clearTimeout(timer);lines.close();await Promise.all([stdout.writableFinished?Promise.resolve():once(stdout,'finish'),stderr.writableFinished?Promise.resolve():once(stderr,'finish')]);
  if(fs.existsSync(outputFile))finalText=fs.readFileSync(outputFile,'utf8');
  let report=null;try{report=JSON.parse(finalText);}catch{violations.push('final_response_not_JSON');}
  if(exitCode!==0)violations.push(`codex_exit:${exitCode}/${signal}`);
  const fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'];
  const tokens=Object.fromEntries(fields.map(field=>[field,usage.length&&usage.every(turn=>Number.isFinite(turn?.[field]))?usage.reduce((sum,turn)=>sum+turn[field],0):null]));
  if(['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].some(field=>tokens[field]===null))violations.push('actual_token_usage_missing');
  const result={thread_id:threadId,exit_code:exitCode,signal,elapsed_ms:Date.now()-started,model:'gpt-6-astra',reasoning_effort:'high',tokens,raw_usage:usage,violations,nativeSkillReads,native_text_bytes:nativeBytes,report};
  json(path.join(options.evidence,'agent-result.json'),result);
  // Non-secret reproducibility inputs, with the transport token intentionally absent.
  json(path.join(options.evidence,'codex-invocation.json'),{executable:options.codex,version:options.codexVersion,model:result.model,reasoning_effort:result.reasoning_effort,ephemeral:true,ignore_user_config:true,sandbox:'read-only',mcp_preauthorization:{server:'rho',mode:'approve',scope:'User-authorized isolated acceptance operations; proxy enforces each task boundary.'},policy,final_schema_sha256:digest(JSON.stringify(FINAL_SCHEMA)),prompt_sha256:digest(prompt),cwd_is_outside_scientific_project:true});
  return result;
}
