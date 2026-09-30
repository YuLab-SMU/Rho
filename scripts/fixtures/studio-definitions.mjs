import assert from 'node:assert/strict';
export function testDefinitions(StudioDocument,definitionDraft,source) {
 const doc=new StudioDocument(source.snapshot);doc.data.selected='views/panel.json';
 doc.changeVisual(d=>{
  d.nodes.title.bindings={text:{source:'rows',path:['title']}};
  d.nodes.title.visible_when={kind:'all',conditions:[{kind:'exists',binding:{source:'rows',path:[]}},{kind:'not',condition:{kind:'equals',binding:{source:'rows',path:['hidden']},value:true}}]};
  d.nodes.title.events={click:[{kind:'refresh',source:'rows'},{kind:'open_view',contribution:'report',resource:{source:'rows',path:['resource']}}]};
 });
 const initial=doc.current.text,old=doc.canvas.data_sources.rows;
 doc.updateDefinition('data_sources','rows','observations',{...old,arguments:{caption:'中文 Ω'}},JSON.stringify(old));
 assert.equal(doc.canvas.nodes.title.bindings.text.source,'observations');
 assert.equal(doc.canvas.nodes.title.visible_when.conditions[1].condition.binding.source,'observations');
 assert.equal(doc.canvas.nodes.title.events.click[0].source,'observations');assert.equal(doc.canvas.nodes.title.events.click[1].resource.source,'observations');
 const changed=doc.current.text;doc.undo();assert.equal(doc.current.text,initial);doc.undo(true);assert.equal(doc.current.text,changed);
 const history=doc.data.past.length;assert.throws(()=>doc.removeDefinition('data_sources','observations',JSON.stringify(doc.canvas.data_sources.observations)),/still referenced/);assert.equal(doc.current.text,changed);assert.equal(doc.data.past.length,history);
 assert.throws(()=>doc.updateDefinition('data_sources','observations','rows',old,JSON.stringify(old)),/changed in the declaration/);
 doc.updateDefinition('data_sources',null,'unused',old,null);const beforeInvalid=doc.current.text;
 assert.throws(()=>doc.updateDefinition('data_sources','observations','unused',old,JSON.stringify(doc.canvas.data_sources.observations)),/already exists/);
 assert.throws(()=>doc.updateDefinition('data_sources',null,'bad', {...old,capability:{id:'../escape',version:1}},null));assert.equal(doc.current.text,beforeInvalid);
 doc.removeDefinition('data_sources','unused',JSON.stringify(old));assert.equal(doc.canvas.data_sources.unused,undefined);doc.undo();assert.deepEqual(doc.canvas.data_sources.unused,old);
 const component=doc.canvas.components.chart,code=doc.data.buffers['src/custom.ts'].text;
 doc.updateDefinition('components','chart','chart-next',{...component,properties_schema:{type:'object',properties:{label:{type:'string'}}}},JSON.stringify(component));
 assert.equal(doc.canvas.nodes.custom.component,'chart-next');assert.equal(doc.data.buffers['src/custom.ts'].text,code);
 assert.throws(()=>doc.removeDefinition('components','chart-next',JSON.stringify(doc.canvas.components['chart-next'])),/still referenced/);
 assert.throws(()=>doc.updateDefinition('components',null,'missing',{...component,source:'src/missing.ts'},null),/Add the custom source file/);
 const retained=definitionDraft('data_sources','observations',doc.canvas.data_sources.observations);retained.fields.arguments='{ "caption": "unfinished 中文';
 doc.retainDefinitionDraft('data_sources',retained);const restored=new StudioDocument(doc.snapshot);
 assert.deepEqual(restored.snapshot.definitionDrafts,doc.snapshot.definitionDrafts);assert.equal(restored.current.text,doc.current.text,'unapplied invalid form never changes declaration');
 const corrupt=doc.snapshot;corrupt.definitionDrafts['views/panel.json'].data_sources.baseline='{}';assert.throws(()=>new StudioDocument(corrupt));
 const valid=doc.current.text;doc.edit(doc.data.selected,valid.slice(0,-5));const invalid=doc.current.text;
 assert.throws(()=>doc.updateDefinition('components',null,'another',component,null));assert.equal(doc.current.text,invalid);assert.equal(doc.canvas.components['chart-next'].source,'src/custom.ts');
 console.log('Definition edits: atomic reference rewrites/shared undo, referenced removal and stale-baseline refusal, opaque source, invalid form recovery and invalid-source preservation passed.');
}
