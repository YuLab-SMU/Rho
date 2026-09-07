import { useSyncExternalStore } from 'react';
import { Studio } from './studio';
import { HostClient } from './host-client';

export const studio = new Studio(HostClient.fromLocation());
export function useStudio() { useSyncExternalStore(studio.subscribe,studio.snapshot); return studio; }
