// Local native ACP peer for Studio acceptance. All scientific/management effects
// still go through the actual Agent plugin's private MCP and public Host ports.
module.exports = async ({cwd, sendRequest, catalog, rpc, save, session, prompts}) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const {randomUUID} = require('node:crypto');
  const input = JSON.parse(fs.readFileSync(path.join(cwd, 'native-studio-input.json'), 'utf8'));
  const tools = catalog.structuredContent.tools;
  const expected = [
    ['inspect_checkpoint','plugins.inspect',{revision:input.revision}],
    ['list_source','plugins.source_tree',{revision:input.revision}],
    ['read_source','plugins.read_source',{revision:input.revision}],
    ['read_branch_head','plugins.branch_head',{branch:input.branch}],
    ['check_source_changes','plugins.check_source',{branch:input.branch,expected_head:input.revision}],
    ['create_checkpoint','plugins.checkpoint',{branch:input.branch,expected_head:input.revision}],
  ];
  assert.deepEqual(tools.map(tool => tool.selection.name), expected.map(([name]) => name));
  for (let i=0;i<expected.length;i++) {
    const [name,id,fixed]=expected[i],tool=tools[i];
    assert.equal(tool.selection.name,name);assert.equal(tool.selection.target.type,'host');
    assert.deepEqual(tool.selection.target.capability,{id,version:1});assert.deepEqual(tool.selection.target.fixed_arguments,fixed);
    for(const key of Object.keys(fixed)){assert.equal(tool.input_schema.properties[key],undefined);assert.ok(!tool.input_schema.required?.includes(key));}
  }
  const invocation=(tool,args)=>({send_request:sendRequest,tool_request:randomUUID(),tool,arguments:args,preconditions:null});
  const call=async(tool,args)=>{
    const result=await rpc('tools/call',{name:'rho_call',arguments:invocation(tool,args)});assert.notEqual(result.isError,true);return result.structuredContent.result;
  };
  assert.equal((await call('inspect_checkpoint',{})).data.summary.revision,input.revision);
  const tree=(await call('list_source',{after:null,limit:100})).data;
  assert.equal(tree.revision,input.revision);assert.ok(tree.files[input.path]);assert.equal(tree.next,null);
  const source=(await call('read_source',{path:input.path,offset:0,limit:65536})).data;
  assert.equal(source.revision,input.revision);assert.equal(Buffer.from(source.content_base64,'base64').toString(),input.original);
  assert.equal((await call('read_branch_head',{})).data.revision,input.revision);
  for(const extra of [{branch:input.other_branch},{expected_head:'sha256:'+'f'.repeat(64)}]) {
    const error=await rpc('tools/call',{name:'rho_call',arguments:invocation('create_checkpoint',{changes:input.changes,...extra})},randomUUID(),-32602);
    assert.match(error.message,/Model arguments cannot replace a captured Host field/);
  }
  const proposal=(await call('check_source_changes',{changes:input.changes})).data;
  assert.equal(proposal.branch,input.branch);assert.equal(proposal.parent,input.revision);
  const originalRequest=invocation('create_checkpoint',{changes:input.changes});
  save({session,prompts,invocation:originalRequest});
  const original=await rpc('tools/call',{name:'rho_call',arguments:originalRequest});
  assert.notEqual(original.isError,true);assert.equal(original.structuredContent.result.status,'succeeded');
  assert.deepEqual(original.structuredContent.result.output,proposal);
  assert.deepEqual(await rpc('tools/call',{name:'rho_call',arguments:originalRequest}),original);
  save({session,prompts,invocation:originalRequest,result:original.structuredContent,proposal,rejected_branch_replacement:true,rejected_head_replacement:true});
};
