import {useEffect} from 'react';
import type {MediaReference} from '../public/r-protocol/index.js';
import {useMediaCache,useOutputs} from './view-services.js';
import {mediaKey} from './output-ports.js';
export function MediaImage({reference,priority=false,onLoad}:{reference:MediaReference;priority?:boolean;onLoad?(image:HTMLImageElement):void}){
 const cache=useMediaCache(),outputs=useOutputs(),plot=outputs.find(reference),key=mediaKey(reference),state=cache.getSnapshot(),url=state.urls.get(key),error=state.errors.get(key);
 useEffect(()=>{if(plot)cache.load(plot,priority);},[cache,key,priority]);
 return <div className="media-image">{url?<img src={url} alt={`Plot ${reference.sequence}`} draggable={false} onLoad={event=>onLoad?.(event.currentTarget)} onError={()=>{if(plot)cache.reportDecodeError(plot,url);}}/>:!error&&<span className="muted">Loading original…</span>}
 {error&&<span className="error" role="status">{error}{plot&&<button onClick={()=>cache.retry(plot)}>Retry Image</button>}</span>}</div>;
}
