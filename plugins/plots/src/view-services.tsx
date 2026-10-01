import {createContext,useContext,useSyncExternalStore} from 'react';
import type {MediaReference} from '../public/r-protocol/index.js';
import type {PlotsConnection} from './connection.js';
import type {MediaCache} from './media-cache.js';
export const PlotViewContext=createContext<{connection:PlotsConnection;cache:MediaCache;agent?:{ask(plots?:import("./outputs.js").SavedPlot[]):void;annotate?(plots?:import("./outputs.js").SavedPlot[]):void;};navigation:{blocked:boolean;exportAvailable:boolean;exportStatus?:{busy:boolean;notice:string;error:string};openComparison(reference:MediaReference):void;exportOriginal(reference:MediaReference):void}}|null>(null);
export function usePlotServices(){const services=useContext(PlotViewContext);if(!services)throw new Error('Plots services are unavailable.');return services;}
export function usePlots(){const value=usePlotServices().connection.plots;useSyncExternalStore(value.subscribe,value.getSnapshot);return value;}
export function useOutputs(){const value=usePlotServices().connection.history;useSyncExternalStore(value.subscribe,value.getSnapshot);return value;}
export function useMediaCache(){const value=usePlotServices().cache;useSyncExternalStore(value.subscribe,value.getSnapshot);return value;}
