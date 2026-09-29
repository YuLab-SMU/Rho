import {expect,it,vi} from 'vitest';
import {PluginWindowViews} from '../src/plugin-window-views';
import type {PluginViewRecord,PluginViewConnection,PluginWindowLayout} from '../../sdk/plugin-protocol/index.js';
const layout:PluginWindowLayout={window:'window',project:'project',principal:'principal',version:1,layout:{kind:'tabs',id:'main',views:['view'],selected:'view'}};
const view:PluginViewRecord={view:'view',purpose:'runtime',window:'window',project:'project',principal:'principal',instance:{instance:'instance',plugin:'third-party',revision:'revision',artifact:'artifact'},contribution:'custom',configuration:{},state:{},state_version:0,closed:false};
const connection:PluginViewConnection={view,connection:'connection',next_sequence:1,asset_token:'private-asset',call_token:'private-call',entrypoint:'index.html',grants:[]};
function fixture(){const ports={connect:vi.fn(async()=>structuredClone(connection)),inspect:vi.fn(async()=>structuredClone(view)),title:vi.fn(async()=> 'Custom View')};return{ports,owner:new PluginWindowViews('window',ports)};}
it('uses exact window identity and keeps credentials out of render snapshots',async()=>{
 const f=fixture();f.owner.observe(layout);await f.owner.connect('view');expect(f.owner.getSnapshot().get('view')).toMatchObject({title:'Custom View',connected:true});
 expect(JSON.stringify([...f.owner.getSnapshot()])).not.toContain('private');expect(f.owner.connection('view')?.call_token).toBe('private-call');
 await f.owner.connect('view');expect(f.ports.connect).toHaveBeenCalledOnce();expect(()=>f.owner.observe({...layout,window:'foreign'})).toThrow('scope');f.owner.stop();
});
it('hides without releasing a live document and requires confirmed closure before discarding it',async()=>{
 const f=fixture();f.owner.observe(layout);await f.owner.connect('view');f.owner.observe({...layout,layout:{kind:'empty'}});await f.owner.inspectHidden();
 expect(f.owner.getSnapshot().get('view')).toMatchObject({visible:false,connected:true});f.ports.inspect.mockRejectedValueOnce(new Error('offline'));await f.owner.inspectHidden();expect(f.owner.connection('view')).not.toBeNull();expect(f.owner.getSnapshot().get('view')?.error).toBe('');
 f.ports.inspect.mockResolvedValue({...view,closed:true});await f.owner.inspectHidden();expect(f.owner.getSnapshot().has('view')).toBe(false);expect(f.owner.connection('view')).toBeNull();f.owner.stop();
});
it('refuses foreign or retargeted records and never silently replaces a failed original',async()=>{
 const f=fixture();f.owner.observe(layout);f.ports.connect.mockResolvedValueOnce({...connection,view:{...view,principal:'foreign'}});
 await expect(f.owner.connect('view')).rejects.toThrow('authority');expect(f.owner.connection('view')).toBeNull();await f.owner.connect('view');
 f.owner.failed('view','frame stopped');f.ports.inspect.mockResolvedValueOnce({...view,instance:{...view.instance,revision:'new-version'}});
 await expect(f.owner.retry('view')).rejects.toThrow('original plugin identity');expect(f.owner.connection('view')?.view.instance.revision).toBe('revision');f.owner.stop();
});
it('joins one connection attempt and ignores a reply after the window stops',async()=>{
 const f=fixture();let finish!:(value:PluginViewConnection)=>void;f.ports.connect.mockImplementation(()=>new Promise(resolve=>finish=resolve));f.owner.observe(layout);
 const pending=f.owner.connect('view');expect(f.owner.connect('view')).toBe(pending);await Promise.resolve();f.owner.stop();finish(connection);await pending;expect(f.owner.connection('view')).toBeNull();
});
it('names a detached saved tab from scoped metadata without reconnecting or concealing its failure',async()=>{
 const f=fixture();f.ports.connect.mockRejectedValue(new Error('Instance suspended'));f.owner.observe(layout);
 await expect(f.owner.connect('view')).rejects.toThrow('Instance suspended');
 expect(f.owner.getSnapshot().get('view')).toMatchObject({title:'Custom View',connected:false,error:'Instance suspended'});
 expect(f.owner.connection('view')).toBeNull();expect(f.ports.connect).toHaveBeenCalledOnce();expect(f.ports.inspect).toHaveBeenCalledWith('view');f.owner.stop();
});
it('does not borrow a detached title from another authority or publish it after disposal',async()=>{
 const f=fixture();f.ports.connect.mockRejectedValue(new Error('Detached'));f.ports.inspect.mockResolvedValue({...view,project:'foreign'});f.owner.observe(layout);
 await expect(f.owner.connect('view')).rejects.toThrow('Detached');expect(f.ports.title).not.toHaveBeenCalled();expect(f.owner.getSnapshot().get('view')?.title).toBe('view');f.owner.stop();
 const g=fixture();g.ports.connect.mockRejectedValue(new Error('Detached'));let finish!:(title:string)=>void;
 g.ports.title.mockImplementation(()=>new Promise(resolve=>finish=resolve));g.owner.observe(layout);
 const pending=g.owner.connect('view');await vi.waitFor(()=>expect(g.ports.title).toHaveBeenCalledOnce());g.owner.stop();finish('Late title');
 await expect(pending).rejects.toThrow('Detached');expect(g.owner.getSnapshot().get('view')?.title).toBe('view');
});
it('refuses to reinterpret the same retained view as a different instance purpose',async()=>{
 const f=fixture();f.owner.observe(layout);await f.owner.connect('view');f.owner.failed('view','frame stopped');
 f.ports.inspect.mockResolvedValueOnce({...view,purpose:'fixture_preview'});
 await expect(f.owner.retry('view')).rejects.toThrow('original plugin identity');
 expect(f.owner.connection('view')?.view.purpose).toBe('runtime');f.owner.stop();
});
