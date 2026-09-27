import type { Studio } from './model.js';
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (value: string) => value.startsWith('sha256:') ? value.slice(7, 15) : value;
export function backendTestPanel(studio: Studio, run: (work: () => Promise<unknown>) => void, changed: () => void, frozen: () => boolean) {
  const dev=studio.development, testing=dev.testing;
  get('configure-test').onclick=()=>run(async()=>{
    const input=dev.data.inputs;
    if (!input?.artifact || !studio.plugin || studio.document?.dirty) throw Error('Choose a built checkpoint first.');
    await testing.configure(studio.plugin,input.revision,input.artifact,JSON.parse(input.configuration));
    get<HTMLDetailsElement>('test-settings').open=true;
  });
  get('create-test').onclick=()=>run(async()=>{
    const input=dev.data.inputs;
    if (!input?.artifact || studio.document?.dirty) throw Error('Choose a built checkpoint first.');
    await testing.create(input.revision,input.artifact);
    if (!testing.data.pending) get<HTMLDetailsElement>('test-settings').open=false;
  });
  get('inspect-test').onclick=()=>run(()=>testing.inspect());
  get('open-test-view').onclick=()=>run(async()=>{
    const input=dev.data.inputs, subject=testing.data.project?.project.instances.subject;
    if (!input?.contribution || subject?.revision!==input.revision || subject.artifact!==input.artifact) throw Error('Select the retained test subject’s checkpoint and artifact first.');
    await testing.openView(input.contribution,JSON.parse(input.viewConfiguration),JSON.parse(input.viewState));
  });
  // No observation or save precedes this gesture. The private container still
  // validates the original live child and focused gesture before navigation.
  get('open-test-window').onclick=()=>run(()=>testing.openWindow());
  get('close-test-view').onclick=()=>run(()=>testing.closeView());
  get('retain-test-view').onclick=()=>run(()=>testing.closeView(true));
  get('stop-test').onclick=()=>run(()=>testing.stop());
  get('inspect-test-request').onclick=()=>run(()=>testing.recover());
  get('retry-test-request').onclick=()=>run(()=>testing.dispatch());
  for (const [id,field] of [['test-name','name'],['test-instances','instances']] as const) get<HTMLInputElement|HTMLTextAreaElement>(id).oninput=()=>{
    if (frozen() || dev.data.pending || testing.data.pending || !testing.data.inputs) return;
    testing.data.inputs[field]=get<HTMLInputElement|HTMLTextAreaElement>(id).value;changed();
  };
  return()=>{
    const data=testing.data, observed=data.project, project=observed?.project, input=dev.data.inputs;
    const disabled=frozen() || !!dev.data.pending || !!data.pending;
    const active=!!observed?.observed_in_this_host && ['ready','failed'].includes(project!.state);
    const subject=project?.instances.subject;
    get<HTMLButtonElement>('configure-test').disabled=disabled || !input?.artifact || !!studio.document?.dirty;
    get<HTMLButtonElement>('create-test').disabled=disabled || !input?.artifact || !data.inputs || !!studio.document?.dirty || !!project && project.state!=='stopped';
    for (const [id,field] of [['test-name','name'],['test-instances','instances']] as const) {
      const item=get<HTMLInputElement|HTMLTextAreaElement>(id);if (document.activeElement!==item) item.value=data.inputs?.[field]??'';item.disabled=disabled || !data.inputs;
    }
    get('test-lifecycle').hidden=!project;
    get('test-project').textContent=project?`${project.selection.name} · ${project.id} · ${project.state}${observed?.observed_in_this_host?' · live in this Host':' · recorded, unavailable in this Host'}${subject?` · source ${short(subject.revision)} · artifact ${short(subject.artifact)}`:''}${data.view?` · view ${data.view.closed?'closed':'open'}`:''}`:'';
    get('test-diagnostic').textContent=project?.diagnostic??'';
    get<HTMLButtonElement>('inspect-test').disabled=disabled || !project;
    get<HTMLButtonElement>('open-test-window').disabled=disabled || !active;
    get<HTMLButtonElement>('open-test-view').disabled=disabled || !active || !subject || !!data.view&&!data.view.closed || !input?.contribution || input.revision!==subject?.revision || input.artifact!==subject?.artifact;
    for (const id of ['close-test-view','retain-test-view']) get<HTMLButtonElement>(id).disabled=disabled || !active || !data.view || data.view.closed;
    get<HTMLButtonElement>('stop-test').disabled=disabled || !project || project.state==='stopped' || !!data.view&&!data.view.closed;
    get('test-pending').hidden=!data.pending;
    get('test-request').textContent=data.pending?`${data.pending.intent.capability.id} · ${data.pending.testProject??'source project'} · ${data.pending.intent.operation??data.pending.intent.request}`:'';
    get<HTMLButtonElement>('inspect-test-request').disabled=frozen() || !!dev.data.pending || !data.pending;
    get<HTMLButtonElement>('retry-test-request').disabled=frozen() || !!dev.data.pending || !data.pending || data.pending.intent.view!==studio.client.view.view;
    get('test-result').hidden=!data.last;
    get('test-evidence').textContent=data.last?JSON.stringify(data.last,null,2):'';
  };
}
