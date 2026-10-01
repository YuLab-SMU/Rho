/** Inert fixture rendering: no client, capability dispatcher, code evaluator or remote media. */
import type { VisualDocument } from '../public/plugin-protocol/index.js';
import { own, fixtureValue, fixtureVisible } from './visual.js';
const element=(tag:string,text='')=>{const item=document.createElement(tag);item.textContent=text;return item;};
const shown=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value)??'';
export function renderCanvas(host:HTMLElement,doc:VisualDocument,fixtures:Record<string,unknown>,selected:string,select:(id:string)=>void) {
  host.replaceChildren();
  const tokens:Record<string,string>={'color.text':'var(--color-text)','color.muted':'var(--color-muted)','color.surface':'var(--color-surface)','color.subtle':'var(--color-subtle)','color.accent':'var(--color-accent)','space.1':'4px','space.2':'8px','space.3':'12px','space.4':'16px','space.6':'24px','space.8':'32px'};
  const styles:Record<string,string>={color:'color',background:'background-color',padding:'padding',gap:'gap',font_size:'font-size',border_radius:'border-radius'};
  function draw(id:string):HTMLElement {
    const node=doc.nodes[id]!,box=element('div');box.className=`canvas-node kind-${node.kind}`;box.dataset.node=id;box.tabIndex=0;
    box.setAttribute('role','group');box.setAttribute('aria-label',`${node.kind} ${id}`);box.setAttribute('aria-current',String(id===selected));
    box.onclick=event=>{event.stopPropagation();select(id);};box.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();select(id);}};
    const props:Record<string,unknown>=Object.fromEntries(Object.entries(node.properties));
    for(const [key,value] of Object.entries(node.bindings))Object.defineProperty(props,key,{value:fixtureValue(fixtures,value),enumerable:true,writable:true,configurable:true});
    for(const [key,value] of Object.entries(node.style_tokens)) {
      const property=own(styles,key),token=own(tokens,value);
      // Token names, bounded numeric lengths and literal hex colors only. No URL or CSS execution.
      if(property&&(token||/^(?:\d{1,3}(?:px|rem|%)|#[a-fA-F0-9]{3,8})$/.test(value)))box.style.setProperty(property,token??value);
    }
    if(node.visible_when&&!fixtureVisible(fixtures,node.visible_when)) { box.classList.add('condition-hidden');box.append(element('small','Hidden by fixture condition')); }
    if(node.kind==='split') {box.style.flexDirection=props.direction==='vertical'?'column':'row';}
    if(node.kind==='text')box.append(element('span',shown(props.text??'Text')));
    if(node.kind==='button') {const button=element('button',shown(props.label??'Button')) as HTMLButtonElement;button.type='button';button.tabIndex=-1;box.append(button);}
    if(node.kind==='form') {const label=element('label',shown(props.label??'Form field')),input=element('input') as HTMLInputElement;input.readOnly=true;input.tabIndex=-1;input.value=shown(props.value??'');label.append(input);box.append(label);}
    if(node.kind==='list') {const list=element('ul');for(const item of (Array.isArray(props.items)?props.items:[]).slice(0,100))list.append(element('li',shown(item)));if(!list.childElementCount)list.append(element('li','List · supply fixture items'));box.append(list);}
    if(node.kind==='table') {
      const table=element('table'),rows=Array.isArray(props.rows)?props.rows.slice(0,100):[];
      for(const row of rows){const tr=element('tr');for(const cell of (Array.isArray(row)?row:Object.values(row&&typeof row==='object'?row:{value:row})).slice(0,20))tr.append(element('td',shown(cell)));table.append(tr);}
      box.append(rows.length?table:element('p','Table · supply fixture rows'));
    }
    if(node.kind==='media')box.append(element('p',`Media · ${shown(props.alt??'asset placeholder')}`));
    if(node.kind==='custom') {const component=doc.components[node.component!]!;box.append(element('strong',`${node.component} · custom code`),element('code',`${component.source} / ${component.export}`),element('small','Source is preserved. The editor does not execute this component.'));}
    if(node.kind==='tabs')box.append(element('small','Tabs · all child structures shown for editing'));
    if(node.children.length===0&&['container','split'].includes(node.kind))box.append(element('small',`${node.kind} · add a node`));
    for(const child of node.children)box.append(draw(child));
    if(Object.keys(node.events).length)box.append(element('small',`Declared events: ${Object.keys(node.events).join(', ')} · inactive in editor`));
    return box;
  }
  host.append(draw(doc.root));
}
