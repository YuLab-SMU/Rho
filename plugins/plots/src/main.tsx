import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import {useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {connectPluginView} from '../public/plugin-ui/index.js';
import type {InstanceRef} from '../public/plugin-protocol/index.js';
import type {PlotSelection} from './outputs.js';
import {PlotsConnection} from './connection.js';
import {MediaCache} from './media-cache.js';
import {PlotsActions} from './actions.js';
import {PlotViewContext} from './view-services.js';
import {PlotPanel} from './plot-panel.js';
import './style.css';
const root=createRoot(document.getElementById('root')!);
try{
 const client=await connectPluginView();
 if(client.view.contribution!=='plots')throw new Error('The Plots contribution is missing.');
 const configuration=client.view.configuration as unknown as {source:InstanceRef;selection:PlotSelection|null;pinned:boolean;plot_group:string|null};
 const connection=new PlotsConnection(client,configuration.source,configuration.selection,configuration.pinned);
 const cache=new MediaCache(client,{create:(bytes,mime)=>URL.createObjectURL(new Blob([bytes],{type:mime})),revoke:url=>URL.revokeObjectURL(url)});
 const actions=new PlotsActions(client,connection,configuration.plot_group);
 const closing=await client.installCloseHandler({async flush(){connection.pause();await actions.settled();await connection.flush();},resume(){connection.resume();}});
 const ignore=(promise:Promise<unknown>)=>{void promise.catch(()=>undefined);};
 function App(){
  const state=useSyncExternalStore(connection.subscribe,connection.getSnapshot),action=useSyncExternalStore(actions.subscribe,actions.getSnapshot),close=useSyncExternalStore(closing.subscribe,closing.getSnapshot);
  return <PlotViewContext.Provider value={{connection,cache,navigation:{blocked:close.preparing||action.working||!!action.pending,
   openComparison:reference=>ignore(actions.openComparison(reference)),exportAvailable:false,exportOriginal:()=>undefined}}}>
   <main className="plots-root"><PlotPanel/>
    {(state.notice||state.saveError||close.error||action.error||action.pending||action.receipt)&&<aside className="plots-status" aria-label="Plots status">
     {state.notice&&<p role="status">{state.notice}</p>}{close.error&&<p role="alert">{close.error}</p>}
     {state.saveError&&<p role="alert">{state.saveError}<button onClick={()=>ignore(connection.flush())}>Retry Save</button></p>}
     {action.error&&<p role="alert">{action.error}</p>}
     {action.pending&&<p>Comparison unconfirmed · <code>{action.pending.request}</code><button disabled={action.working} onClick={()=>ignore(actions.retry())}>Retry Original Request</button><button disabled={action.working} onClick={()=>ignore(actions.inspectPending())}>Find Original Operation</button></p>}
     {action.receipt&&<p>Open comparison: {action.receipt.status} · <code>{action.receipt.id}</code><button disabled={action.working} onClick={()=>ignore(actions.inspect())}>Inspect Operation</button>{action.receipt.error&&<span className="error"> {action.receipt.error}</span>}</p>}
    </aside>}
   </main>
  </PlotViewContext.Provider>;
 }
 root.render(<App/>);ignore(connection.initialize());
 const polling=setInterval(()=>ignore(connection.refresh()),3000);
 window.addEventListener('pagehide',()=>{clearInterval(polling);actions.stop();connection.stop();cache.stop();client.dispose();root.unmount();},{once:true});
}catch(error){root.render(<div className="empty" role="alert">{error instanceof Error?error.message:String(error)}</div>);}
