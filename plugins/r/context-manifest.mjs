// Context identities/inclusions are owned by R; the envelopes are public SDK
// contracts generated alongside the R API. No Host-private DTOs are embedded.
export function contextContributions(schema) {
  const owner = {plugin:'org.rho.r',instance:'copy-original-r-instance',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
  const files = name => [1,2,3,4].map(index => ({path:`original-${name}-${index}`,digest:'copy-original-file-digest'}));
  const sources = [{id:'plots',title:'Saved plots',scopes:['workspace.read','operation.read','resources.read'],
    description:'Search original terminal R outputs. Explicitly include one or two original PNG/JPEG images up to 2 MiB each, or artifact metadata only. Rechecks original operation, session, output and digest. Never starts R, rerenders a plot or captures panel transforms.',
    choices:[['Original images','images'],['Artifact metadata only','metadata']],
    selector:{plots:[{operation:'copy-original-operation',sequence:1,session:'copy-original-native-session',reference:{owner,resource:'copy-original-resource',digest:'sha256:'+'c'.repeat(64),media_type:'image/png',bytes:100}}]}},
    {id:'objects',title:'Observed objects',scopes:['workspace.read'],
    description:'Search up to 100 previously opened object observations. Preview rechecks the exact native handle, session and structural path; never starts R, evaluates a binding or observes a replacement. Includes bounded metadata and recognition sample, not the whole object.',
    choices:[['Metadata and recognition sample','summary']],
    selector:{session:'copy-original-native-session',name:'copy-original-object-name',object_ref:'copy-original-object-reference',observed_path:[],path:[]}},
    {id:'help',title:'Observed Help topics',scopes:['workspace.read'],
    description:'Search up to 100 previously observed topics from this R instance. Preview rechecks the exact native session, package observation and static index/help file identities. Never starts R, loads a namespace or selects another installed copy.',
    choices:[['Topic text','text'],['First 12 lines','excerpt']],
    selector:{session:'copy-original-native-session',observation:'copy-original-package-observation',package:'base',library:'/original/library',topic:'sum',index_files:files('index'),help_files:files('help')}},
    {id:'viewer',title:'Saved HTML outputs',scopes:['workspace.read','operation.read','resources.read'],
      description:'Search visible original terminal R operations from this exact provider. Preview rechecks the original result and retained resource identity without starting R. Text is inert HTML source; metadata describes the saved record only. Browser selection, zoom and filter state are not captured.',
      choices:[['HTML source','text'],['Artifact record','metadata']],
      selector:{operation:'copy-original-operation',sequence:1,session:'copy-original-native-session',reference:{owner,resource:'copy-original-resource',digest:'sha256:'+'c'.repeat(64),media_type:'text/html',bytes:100}}}];
  const capabilities = sources.flatMap(source => {
    const key = action => ({id:`r.context.${source.id}.${action}`,version:1});
    const preview = structuredClone(schema('preview-context'));
    preview.properties.inclusion = {oneOf:source.choices.map(([title,kind]) => ({title,const:{kind}}))};
    const base = {kind:'query',description:source.description,required_scopes:source.scopes,recovery_schema:true,effects:[],cancellation:'unsupported',preflight:null};
    return [
      {...base,capability:key('search'),title:`Find ${source.title}`,input_schema:schema('context-search'),output_schema:schema('context-page'),
        examples:[{window:'copy-original-window',text:'',after:null,limit:20}]},
      {...base,capability:key('preview'),title:`Preview ${source.title}`,input_schema:preview,output_schema:schema('context-preview'),
        examples:[{reference:{provider:owner,contribution:source.id,window:'copy-original-window',selector:source.selector},inclusion:{kind:source.choices[0][1]},max_bytes:16384}]},
    ];
  });
  return {capabilities,contexts:sources.map(source=>({id:source.id,title:source.title,search:{id:`r.context.${source.id}.search`,version:1},preview:{id:`r.context.${source.id}.preview`,version:1}}))};
}
