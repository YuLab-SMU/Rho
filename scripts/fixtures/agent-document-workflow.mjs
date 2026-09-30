// Current scoped-tool acceptance. Real Host/Agent/Editor/Files/R/Annotations;
// deterministic model peer, never a claim about third-party model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export const documentWorkflowCases = [
  {id:'documents',value:'nrow(clean)',expected:1704},
  {id:'project',value:'length(unique(clean$country))',expected:142,readFile:true},
  {id:'repair-document',value:'as.integer(round(summary(model)$r.squared * 1e6))',expected:703984},
  {id:'repair-plot',value:'nrow(coefficient_table)',expected:6,plot:true},
  {id:'generic-new-task',value:'max(clean$year)',expected:2007,path:'new-analysis.R'},
  {id:'objects-script',value:'as.integer(round(summary(model)$r.squared * 1e6))',expected:703984,object:true,note:true},
];
const objects=value=>{
  if(typeof value==='string'){try{return objects(JSON.parse(value));}catch{return[];}}
  if(!value||typeof value!=='object')return[];
  return [value,...Object.values(value).flatMap(objects)];
};
const evidence=(body,predicate)=>{
  for(const message of [...body.messages].reverse().filter(m=>m.role==='tool')){
    const found=objects(message.content).find(predicate);if(found)return found;
  }
  throw Error('The deterministic model peer did not receive the preceding owner evidence');
};
const reference=body=>{
  for(const message of [...body.messages].reverse().filter(m=>m.role==='tool')){
    const values=objects(message.content),updated=values.find(v=>v.output?.reference?.provider?.plugin==='org.rho.editor');
    if(updated)return updated.output.reference;
    const found=values.find(v=>v.provider?.plugin==='org.rho.editor'&&v.contribution==='documents'&&v.selector?.draft);if(found)return found;
  }
  throw Error('No captured Editor reference reached the model');
};
const operation=(name,args)=>[name,{arguments:args,preconditions:null}];
export async function documentWorkflow({project,page,getFrame,pq,api,setPlan,report,save,directory}) {
  const attempts=report.document_workflow={model:'deterministic streaming peer; native effects are real',cases:[],complete:false};save();
  let filename='analysis.R';
  for(const scenario of documentWorkflowCases){
    const current={id:scenario.id,status:'running'};attempts.cases.push(current);save();
    const code=`clean <- transform(read.csv("gapminder.csv"), log_gdp = log(gdpPercap))\nmodel <- lm(lifeExp ~ log_gdp + continent, data = clean)\ncoefficient_table <- data.frame(term = names(coef(model)), estimate = unname(coef(model)))\nworkflow_value <- ${scenario.value}\n${scenario.plot?'plot(clean$log_gdp, clean$lifeExp, xlab="Log income per person", ylab="Life expectancy", main="Gapminder regression context")\n':''}cat("${scenario.id}\\n", file="workflow-effects.txt", append=TRUE)\nprint(workflow_value)\n`;
    const steps=[
      ...(scenario.readFile?[()=>['files_read_text',{path:'notes.txt',start_line:1,limit_lines:10}]]:[]),
      ...(scenario.object?[()=>['r_observe_object',{name:'model'}]]:[]),
      ()=>['editor_context_search',{text:filename,after:null,limit:20}],
      body=>['editor_context_preview',{reference:reference(body),inclusion:{kind:'document'},max_bytes:16384}],
      body=>operation('editor_edit',{reference:reference(body),code}),
      body=>operation('editor_save',{reference:reference(body),...(scenario.path?{path:scenario.path}:{})}),
      body=>operation('editor_run',{reference:reference(body)}),
      body=>['editor_run_inspect',{operation:evidence(body,v=>typeof v.operation_id==='string'&&v.output?.capture).operation_id}],
      ()=>['r_observe_object',{name:'workflow_value'}],
      body=>['r_read_object',{object_ref:evidence(body,v=>typeof v.object_ref==='string').object_ref,kind:'values',start:1,limit:1,column_limit:1}],
    ];
    if(scenario.note)steps.push(
      body=>operation('annotations_document_freeze',{request_id:'workflow-freeze',reference:reference(body),inclusion:{kind:'document'},anchor:{kind:'whole_item'}}),
      body=>operation('annotations_write',{request_id:'workflow-note',command:{kind:'create',evidence_id:evidence(body,v=>typeof v.evidence_id==='string').evidence_id,note:'Gapminder: association is not causation; preserve the fitted specification and inspect residuals before interpreting coefficients. 中文研究记录',labels:['gapminder'],marks:[],continued_from:null}}),
      body=>['annotations_read',{kind:'read',annotation:evidence(body,v=>v.outcome?.annotation).outcome.annotation}],
    );
    const plan=setPlan(steps,`Confirmed ${scenario.id} native value ${scenario.expected}; captured result and judgment retained.`);
    await page.getByRole('tab',{name:'Agent',exact:true}).click();let ui=await getFrame('Agent message');
    await ui.getByRole('button',{name:'New task',exact:true}).click();await ui.getByRole('button',{name:'Rho',exact:true}).click();
    await ui.getByRole('button',{name:'Tools',exact:true}).click();await ui.getByLabel('Read, edit and run in workspace',{exact:true}).check();await ui.getByRole('button',{name:'Tools',exact:true}).click();
    await ui.getByLabel('Agent message',{exact:true}).fill(`Verify ${scenario.id}: use the open ${filename}, preserve the actual captured script and report the native Gapminder result.${scenario.note?' Save the stated non-causal research judgment with its original document evidence.':''}`);
    await ui.getByRole('button',{name:'Send message',exact:true}).click();
    let run;const deadline=Date.now()+180000;
    while(Date.now()<deadline){
      // The view's own selected conversation is authoritative even after completion.
      const view=await api.query('views.inspect',{view:report.agent_view}),id=view.state.rho?.selected;
      if(id){const history=await pq('agent','agent.model.history',{conversation_id:id,before:null,limit:5});if(history.runs[0]){run=await pq('agent','agent.model.run.get',{run_id:history.runs[0].run_id});if(['completed','failed','interrupted','stopped'].includes(run.state))break;}}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    current.run=run;save();assert.equal(run?.state,'completed',run?.reason??'Document workflow did not finish');assert.equal(plan.sent,steps.length+1);
    const receipts=await pq('agent','agent.model.run.tools',{run_id:run.run_id});current.receipts=receipts;save();
    for(const cap of ['editor.edit','editor.save','editor.run']){const found=receipts.filter(t=>t.capability===cap);assert.equal(found.length,1);assert.equal(found[0].result.status,'succeeded',JSON.stringify(found[0]));}
    const tool=receipts.find(t=>t.capability==='editor.run');const inspection=await pq('editor','editor.run.inspect',{operation:tool.operation_id});
    assert.equal(inspection.parent.status,'succeeded');assert.equal(inspection.execution.status,'succeeded');assert.equal(inspection.execution.operation.causation_id,tool.operation_id);
    assert.equal(inspection.execution.operation.normalized_arguments.arguments.run.code,code);
    const value=await pq('r','r.observe_object',{expected_session:report.session,name:'workflow_value'});
    const native=await pq('r','r.read_object',{expected_session:report.session,object_ref:value.data.object_ref,kind:'values',start:1,limit:1,column_limit:1});
    assert.equal(native.data.values[0].number,scenario.expected);current.native_value=native;current.execution=inspection.execution.operation.operation_id;
    filename=scenario.path??filename;assert.equal(fs.readFileSync(path.join(project,filename),'utf8'),code);
    const effects=fs.readFileSync(path.join(project,'workflow-effects.txt'),'utf8').trim().split('\n');assert.deepEqual(effects,attempts.cases.map(c=>c.id));
    if(scenario.plot){assert.ok(inspection.execution.output.outputs?.some(item=>item.reference?.media_type?.startsWith('image/')),JSON.stringify(inspection.execution.output));current.outputs=inspection.execution.output.outputs;}
    if(scenario.note){const reads=receipts.filter(t=>t.capability==='annotations.read');assert.equal(reads.length,1);assert.match(JSON.stringify(reads[0].result),/association is not causation/);current.judgment=reads[0].result;}
    await page.getByRole('tab',{name:'Editor',exact:true}).click();ui=await getFrame('Code Editor');
    await ui.locator('#external-status').filter({hasText:'succeeded'}).waitFor();
    await page.reload();ui=await getFrame('Code Editor');await ui.locator('#external-status').filter({hasText:'succeeded'}).waitFor();
    assert.equal(plan.sent,steps.length+1,'Reload cannot send another model request');assert.deepEqual(fs.readFileSync(path.join(project,'workflow-effects.txt'),'utf8').trim().split('\n'),effects);
    current.status='passed';save();
    if(scenario.id==='objects-script')await page.screenshot({path:path.join(directory,'gapminder-captured-run.png')});
  }
  attempts.complete=true;save();
}
