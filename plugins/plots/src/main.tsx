import {componentInputDialog} from "../public/agent-input/dialog.js";
import {plotContext} from "./agent-source.js";
import type {SavedPlot} from "./outputs.js";
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
import {PlotsExport} from './export.js';
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
 const exporting=new PlotsExport(client,reference=>connection.history.find(reference));
 let closingSource=false,asking:SavedPlot[]=[];
 const sender=componentInputDialog({client,saved:connection.savedAgent,persist:state=>connection.saveAgent(state),
  guard:()=>{if(closingSource)throw Error('Plots is closing. The original request is retained.');},
  modes:[{value:'images',label:'Original images'},{value:'metadata',label:'Artifact metadata only'}],
  capture:kind=>plotContext(connection.source,client.view.window,asking,kind)});
 const closing=await client.installCloseHandler({async flush(){closingSource=true;if(sender.busy)throw Error("Wait for the current Agent request before closing.");connection.pause();await actions.settled();await connection.flush();},resume(){closingSource=false;connection.resume();}});
 const ignore=(promise:Promise<unknown>)=>{void promise.catch(()=>undefined);};
 function App(){
  const download=useSyncExternalStore(exporting.subscribe,exporting.getSnapshot),state=useSyncExternalStore(connection.subscribe,connection.getSnapshot),action=useSyncExternalStore(actions.subscribe,actions.getSnapshot),close=useSyncExternalStore(closing.subscribe,closing.getSnapshot);
  return <PlotViewContext.Provider value={{connection,cache,agent:{annotate:plots=>{asking=structuredClone(plots??connection.selectedForAgent);sender.annotate();},ask:plots=>{asking=structuredClone(plots??connection.selectedForAgent);sender.open();}},navigation:{blocked:close.preparing||action.working||!!action.pending||download.busy,
   openComparison:reference=>ignore(actions.openComparison(reference)),exportAvailable:client.initialization.features?.includes('resource_download_v1')===true,exportStatus:download,exportOriginal:reference=>ignore(exporting.original(reference))}}}>
   <main className="plots-root"><PlotPanel/>
    {(download.busy||download.error||download.notice||state.notice||state.saveError||close.error||action.error||action.pending||action.receipt)&&<aside className="plots-status" aria-label="Plots status">
     {download.busy&&<p role="status">Collecting original plot…</p>}{download.notice&&<p role="status">{download.notice}</p>}{download.error&&<p role="alert">{download.error}</p>}
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
 window.addEventListener('pagehide',()=>{clearInterval(polling);closingSource=true;sender.dispose();exporting.stop();actions.stop();connection.stop();cache.stop();client.dispose();root.unmount();},{once:true});
}catch(error){root.render(<div className="empty" role="alert">{error instanceof Error?error.message:String(error)}</div>);}
