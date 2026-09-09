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
const TOOL_ITEM_TYPES = new Set(['command_execution','file_change','web_search','mcp_tool_call','collab_tool_call','computer_tool_call']);
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function callKey(tool,args) {return JSON.stringify([tool,canonical(args??{})]);}
function errorMessage(error) {return typeof error==='string'?error:typeof error?.message==='string'?error.message:error?JSON.stringify(error):'';}
function replyStrings(value,strings=[]) {
  if(typeof value==='string')strings.push(value);
  else if(Array.isArray(value))for(const child of value)replyStrings(child,strings);
  else if(value&&typeof value==='object')for(const child of Object.values(value))replyStrings(child,strings);
  return strings;
}

/** Exact-argument, one-to-one occurrence matching. Codex JSONL item IDs and MCP
 * _meta.itemId use different identity spaces, so neither is guessed from the other.
 * Unmatched resources/retries still consume the budget; matched calls count once.
 */
export function recomputeToolAccounting(items,transportCalls,transportResponses,transportTextBytes,nativeTextBytes=0) {
  const attempts=[...items];const pools=new Map();
  for(const attempt of attempts.filter(item=>item.type==='mcp_tool_call'&&item.server==='rho')) {
    const key=callKey(attempt.tool,attempt.arguments);const pool=pools.get(key)??[];pool.push(attempt);pools.set(key,pool);
  }
  // For identical concurrent arguments prefer completed transport successes over
  // known client-side failures. Matching counts remain a multiset intersection.
  for(const pool of pools.values())pool.sort((a,b)=>Number(!!a.error)-Number(!!b.error));
  const matched=new Map();let matchedTransportCalls=0;
  for(const call of transportCalls) {
    if(call.rpc?.method!=='tools/call')continue;
    const pool=pools.get(callKey(call.rpc.params?.name,call.rpc.params?.arguments));
    const attempt=pool?.shift();if(!attempt)continue;
    matchedTransportCalls++;matched.set(attempt.id,call.sequence);
  }
  let clientErrorTextBytes=0;
  for(const attempt of attempts) {
    const message=errorMessage(attempt.error);if(!message)continue;
    const sequence=matched.get(attempt.id);
    const replies=sequence===undefined?[]:transportResponses.filter(response=>response.call?.sequence===sequence);
    let mirroredBytes=0;
    for(const response of replies) {
      // Count any additional client wrapper text, but not an identical server
      // error/body which already contributed to the proxy's UTF-8 byte total.
      for(const text of replyStrings({error:response.error,result:response.result})) {
        if(text&&message.includes(text))mirroredBytes=Math.max(mirroredBytes,Buffer.byteLength(text));
      }
    }
    clientErrorTextBytes+=Math.max(0,Buffer.byteLength(message)-mirroredBytes);
  }
  const unmatchedTransportCalls=transportCalls.length-matchedTransportCalls;
  return {model_tool_attempts:attempts.length,transport_calls:transportCalls.length,
    matched_transport_calls:matchedTransportCalls,unmatched_transport_calls:unmatchedTransportCalls,
    client_error_text_bytes:clientErrorTextBytes,total_tool_attempts:attempts.length+unmatchedTransportCalls,
    total_text_return_bytes:transportTextBytes+nativeTextBytes+clientErrorTextBytes};
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
  const events=[];const violations=[];const nativeSkillReads=[];let finalText='';let threadId=null;const usage=[];const seenTools=new Set();const attempts=new Map();const completedNative=new Set();let planUpdates=0;let nativeBytes=0;
  let killed=false;const stop=reason=>{if(!violations.includes(reason))violations.push(reason);if(!killed&&child.exitCode===null&&child.signalCode===null){killed=true;child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500).unref();}};
  proxy.onViolation=stop;
  const accounting=()=>recomputeToolAccounting(attempts.values(),proxy.calls,proxy.responses,proxy.textBytes,nativeBytes);
  const enforceBudgets=()=>{const current=accounting();if(current.total_tool_attempts>80)stop('tool_call_budget_exceeded');if(current.total_text_return_bytes>1024*1024)stop('text_tool_return_budget_exceeded');return current;};
  const previousAccountingChange=proxy.onAccountingChange;proxy.onAccountingChange=()=>{previousAccountingChange?.();enforceBudgets();};
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return stop('invalid_codex_jsonl');}events.push(event);
    if(event.type==='thread.started'){if(threadId&&threadId!==event.thread_id)stop('multiple_agent_sessions_in_one_task');threadId=event.thread_id;}
    if(event.type==='turn.completed')usage.push(event.usage);
    if(event.type==='turn.failed'||event.type==='error')violations.push(`codex_${event.type}:${JSON.stringify(event).slice(0,1000)}`);
    const item=event.item;if(!item)return;
    if(TOOL_ITEM_TYPES.has(item.type))attempts.set(item.id,{id:item.id,type:item.type,server:item.server,tool:item.tool,arguments:item.arguments,error:item.error,status:item.status});
    if(item.type==='todo_list'&&['item.started','item.updated'].includes(event.type)){const id=`${item.id}:plan-update:${++planUpdates}`;attempts.set(id,{id,type:'plan_update',error:null});}
    enforceBudgets();
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
    if(item.type==='command_execution'&&event.type==='item.completed'&&!completedNative.has(item.id)){completedNative.add(item.id);const read=nativeReadPath(item.command??'',scenario.skillMode==='native'?scenario.allowedSkillFiles:[]);if(read){if(item.exit_code!==0||item.aggregated_output!==fs.readFileSync(read,'utf8'))stop('native_skill_read_not_exact');else nativeSkillReads.push(read);}nativeBytes+=Buffer.byteLength(item.aggregated_output??'');enforceBudgets();}
  });
  const started=Date.now();const timer=setTimeout(()=>stop('task_deadline_exceeded'),600000);const accountingTimer=setInterval(enforceBudgets,100);
  const prompt=scenario.prompt();fs.writeFileSync(path.join(options.evidence,'prompt.txt'),prompt);child.stdin.end(prompt);
  const [exitCode,signal]=await ended;clearTimeout(timer);clearInterval(accountingTimer);lines.close();await Promise.all([stdout.writableFinished?Promise.resolve():once(stdout,'finish'),stderr.writableFinished?Promise.resolve():once(stderr,'finish')]);
  if(fs.existsSync(outputFile))finalText=fs.readFileSync(outputFile,'utf8');
  let report=null;try{report=JSON.parse(finalText);}catch{violations.push('final_response_not_JSON');}
  if(exitCode!==0)violations.push(`codex_exit:${exitCode}/${signal}`);
  const fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'];
  const tokens=Object.fromEntries(fields.map(field=>[field,usage.length&&usage.every(turn=>Number.isFinite(turn?.[field]))?usage.reduce((sum,turn)=>sum+turn[field],0):null]));
  if(['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].some(field=>tokens[field]===null))violations.push('actual_token_usage_missing');
  const result={thread_id:threadId,exit_code:exitCode,signal,elapsed_ms:Date.now()-started,model:'gpt-6-astra',reasoning_effort:'high',tokens,raw_usage:usage,violations,nativeSkillReads,native_text_bytes:nativeBytes,...enforceBudgets(),report};
  Object.defineProperty(result,'finalizeAccounting',{enumerable:false,value:()=>{Object.assign(result,enforceBudgets());json(path.join(options.evidence,'agent-result.json'),result);return result;}});
  result.finalizeAccounting();
  // Non-secret reproducibility inputs, with the transport token intentionally absent.
  json(path.join(options.evidence,'codex-invocation.json'),{executable:options.codex,version:options.codexVersion,model:result.model,reasoning_effort:result.reasoning_effort,ephemeral:true,ignore_user_config:true,sandbox:'read-only',mcp_preauthorization:{server:'rho',mode:'approve',scope:'User-authorized isolated acceptance operations; proxy enforces each task boundary.'},policy,final_schema_sha256:digest(JSON.stringify(FINAL_SCHEMA)),prompt_sha256:digest(prompt),cwd_is_outside_scientific_project:true});
  return result;
}
