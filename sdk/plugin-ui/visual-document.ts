/** Public visual declaration validation and value evaluation. No DOM, transport or execution.
 * Native package validation remains the immutable checkpoint authority. */
import type { VisualDocument, VisualNode, VisualNodeKind, VisualCondition, JsonValue } from '../plugin-protocol/index.js';
export const visualNodeKinds: VisualNodeKind[] = ['container','split','tabs','text','button','form','list','table','media','custom'];
const own = <T>(map: Record<string,T>, key: string): T | undefined => Object.hasOwn(map,key) ? map[key] : undefined;
const bytes = (text: string) => new TextEncoder().encode(text);
function require(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function object(value: any, label: string) { require(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`); }
function fields(value: any, required: string[], optional: string[] = []) {
  object(value,'Declaration');
  require(required.every(key=>Object.hasOwn(value,key)) && Object.keys(value).every(key=>required.includes(key)||optional.includes(key)),`Expected fields: ${[...required,...optional].join(', ')}.`);
}
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const name = (value:unknown) => typeof value==='string'&&/^[a-z][a-z0-9._-]{0,127}$/.test(value)&&!value.includes('..');
const boundedText=(value:unknown)=>typeof value==='string'&&value.trim().length>0&&bytes(value).length<=128&&!/\p{Cc}/u.test(value);
export function validateVisualSourcePath(value: string) {
  require(typeof value === 'string' && bytes(value).length <= 1024 && !/[\\:]/.test(value) && !/\p{Cc}/u.test(value) && !value.startsWith('/') &&
    value.split('/').every(part=>part && part!=='.' && part!=='..'&&!/[. ]$/.test(part)&&!part.startsWith(' ')) && value!=='dist' && !value.startsWith('dist/'),'Use a relative source path outside dist/.');
}
export function createVisualNode(kind: VisualNodeKind = 'container'): VisualNode {
  return {kind,children:[],properties:{},style_tokens:{},bindings:{},visible_when:null,events:{},component:null};
}
export function parseVisualDocument(text: string): VisualDocument {
  const doc = JSON.parse(text);
  fields(doc,['format_version','root','nodes','data_sources','components']);
  require(doc.format_version===1 && id(doc.root),'Unsupported document format or root.');
  for (const key of ['nodes','data_sources','components']) { object(doc[key],key); require(Object.keys(doc[key]).every(key==='nodes'?id:name),`Invalid ${key} identifier.`); }
  require(Object.keys(doc.nodes).length>0 && Object.keys(doc.nodes).length<=4096 && Object.keys(doc.data_sources).length<=256 && Object.keys(doc.components).length<=128,'The declaration exceeds its node, source or component limit.');
  const capability = (v:any) => { fields(v,['id','version']); require(name(v.id)&&Number.isInteger(v.version)&&v.version>0&&v.version<=0xffffffff,'Invalid capability.'); };
  const binding = (v:any) => { fields(v,['source','path']); require(name(v.source)&&own(doc.data_sources,v.source)&&Array.isArray(v.path)&&v.path.length<=32&&v.path.every((part:any)=>typeof part==='string'&&bytes(part).length<=256&&!['__proto__','prototype','constructor'].includes(part)),'Invalid binding source or property path.'); };
  const condition = (v:any,depth=0):void => {
    require(depth<=32,'Condition exceeds the depth limit.'); object(v,'Condition');
    switch(v.kind) {
      case 'exists': fields(v,['kind','binding']); binding(v.binding); break;
      case 'equals': fields(v,['kind','binding','value']); binding(v.binding); break;
      case 'not': fields(v,['kind','condition']); condition(v.condition,depth+1); break;
      case 'all': fields(v,['kind','conditions']); require(Array.isArray(v.conditions)&&v.conditions.length<=32,'Too many conditions.'); v.conditions.forEach((c:any)=>condition(c,depth+1)); break;
      default: throw Error('Unknown condition.');
    }
  };
  for(const source of Object.values(doc.data_sources) as any[]) { fields(source,['capability','arguments','subscribe']); capability(source.capability); require(typeof source.subscribe==='boolean','Subscribe must be a boolean.'); }
  for(const component of Object.values(doc.components) as any[]) {
    fields(component,['source','export','properties_schema','input_schema','output_schema']); validateVisualSourcePath(component.source);
    require(boundedText(component.export),'Invalid component export.');
    for(const key of ['properties_schema','input_schema','output_schema']) require(typeof component[key]==='boolean'||component[key]&&typeof component[key]==='object'&&!Array.isArray(component[key]),'A component schema must be an object or boolean.');
  }
  const visited = new Set<string>();
  function visit(key:string,depth:number) {
    require(depth<=64&&!visited.has(key),'A node has multiple parents, a cycle or excessive depth.'); visited.add(key);
    const n:any=own(doc.nodes,key); fields(n,['kind','children','properties','style_tokens','bindings','events'],['visible_when','component']);
    require(visualNodeKinds.includes(n.kind)&&Array.isArray(n.children)&&n.children.every(id),'Invalid node kind or children.');
    for(const field of ['properties','style_tokens','bindings','events']) object(n[field],field);
    require(Object.values(n.style_tokens).every(v=>typeof v==='string'),'Style tokens must be strings.');
    require(n.kind==='custom'?name(n.component)&&!!own(doc.components,n.component):n.component==null,'Only custom nodes reference a declared component.');
    Object.values(n.bindings).forEach(binding); if(n.visible_when!=null)condition(n.visible_when);
    for(const [event,actions] of Object.entries(n.events) as [string,any[]][]) {
      require(['click','submit','change','select'].includes(event)&&Array.isArray(actions)&&actions.length<=32,'Actions require an explicit user event, with at most 32 actions.');
      for(const action of actions) {
        object(action,'Action');
        switch(action.kind) {
          case 'invoke': fields(action,['kind','capability','arguments']); capability(action.capability); break;
          case 'open_view': fields(action,['kind','contribution'],['resource']); require(name(action.contribution),'Invalid view contribution.'); if(action.resource!=null)binding(action.resource); break;
          case 'set_state': fields(action,['kind','key','value']); require(boundedText(action.key),'Invalid state key.'); break;
          case 'refresh': fields(action,['kind','source']); require(name(action.source)&&own(doc.data_sources,action.source),'Unknown refresh source.'); break;
          default: throw Error('Unknown event action.');
        }
      }
    }
    n.children.forEach((child:string)=>visit(child,depth+1));
  }
  visit(doc.root,0); require(visited.size===Object.keys(doc.nodes).length,'The document contains unreachable nodes.');
  // Normalize optional nullable fields as in the native protocol, never execute them.
  for(const n of Object.values(doc.nodes) as any[]) { n.component??=null; n.visible_when??=null; }
  return doc;
}
function valueAt(data: JsonValue, path: string[]): JsonValue | undefined {
  let current:any=data;
  for(const key of path) { if(!current||typeof current!=='object'||['__proto__','prototype','constructor'].includes(key)||!Object.hasOwn(current,key))return; current=current[key]; }
  return current;
}

/** Evaluate captured values only; never query or dispatch declared actions. */
export function visualBindingValue(fixtures: Record<string, unknown>, binding: {source: string; path: string[]}) {
  const source=own(fixtures,binding.source);
  return source===undefined?undefined:valueAt(source as JsonValue,binding.path);
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
export function visualConditionMatches(fixtures: Record<string, unknown>, condition: VisualCondition): boolean {
  switch(condition.kind) {
    case 'exists': return visualBindingValue(fixtures,condition.binding)!==undefined;
    case 'equals': return same(visualBindingValue(fixtures,condition.binding),condition.value);
    case 'not': return !visualConditionMatches(fixtures,condition.condition);
    case 'all': return condition.conditions.every(item=>visualConditionMatches(fixtures,item));
  }
}
