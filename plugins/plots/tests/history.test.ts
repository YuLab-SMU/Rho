import {expect,it} from 'vitest';
import {PlotHistory} from '../src/history.js';
const owner={instance:'r',plugin:'org.rho.r',revision:'sha256:'+'a'.repeat(64),artifact:'sha256:'+'b'.repeat(64)};
it('continues bounded recent scans past unrelated state writes without returning to the first page',async()=>{
 const cursors:any[]=[];
 const reader={query:async<T>(cap:any,args:any)=>{cursors.push(args.before_cursor);const before=args.before_cursor??100;
   return {data:{operations:[{operation_id:`state-${before}`,capability:{id:'views.update',version:1},status:'succeeded'}],next_cursor:before===10?null:before-10}} as T;}};
 const history=new PlotHistory(reader,owner);await history.refresh();expect(cursors).toEqual([null,90,80,70]);expect(history.getSnapshot().scanning).toBe(true);
 await history.refresh();expect(cursors.slice(4)).toEqual([60,50,40,30]);await history.refresh();expect(cursors.slice(8)).toEqual([20,10]);expect(history.getSnapshot().scanning).toBe(false);
 await history.refresh();expect(cursors.slice(10)).toEqual([null]);expect(history.getSnapshot().hasEarlier).toBe(false);history.stop();
});
it('keeps a failed continuation and ignores an observation arriving after disposal',async()=>{
 let fail=true;const cursors:any[]=[];
 const history=new PlotHistory({query:async<T>(_cap:any,args:any)=>{cursors.push(args.before_cursor);if(args.before_cursor===30&&fail)throw new Error('unavailable');return {data:{operations:[],next_cursor:args.before_cursor===null?30:null}} as T;}},owner);
 await expect(history.refresh()).rejects.toThrow('unavailable');expect(history.getSnapshot().historyError).toBe('unavailable');fail=false;await history.refresh();expect(cursors).toEqual([null,30,30]);
 let finish!:(value:any)=>void;const late=new PlotHistory({query:async<T>()=>await new Promise<T>(resolve=>finish=resolve)},owner);
 const task=late.refresh();await Promise.resolve();late.stop();finish({data:{operations:[],next_cursor:null}});await task;expect(late.getSnapshot().plots).toEqual([]);history.stop();
});
