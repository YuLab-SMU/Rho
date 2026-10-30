import { createContext, useContext } from 'react';
import type { WorkGraph } from '../src/work-graph.js';
import type { StudioFile } from '../src/studio-layout.js';
import { fileKey } from './canvas.js';

// What one conversation's Studio shares with the views in it: the work as it stood at the
// replay moment (null is now), the files by role, and how to move that moment. Views outside a
// conversation's Studio see no process and behave as they always do.
export interface Process {
  conversationId: string;
  // The work at the moment shown, and the whole record for what comes after it.
  graph: WorkGraph; whole: WorkGraph;
  // The files by role as they stood then, and as the whole record has them.
  at: number | null; files: StudioFile[]; every: StudioFile[];
  setAt(at: number | null): void;
  // Brings the view of a project file forward, when Studio shows one.
  showPath(path: string): void;
}
export const ProcessContext = createContext<Process | null>(null);
// A file has one view in a conversation's Studio, named from its path: a view's properties hold
// only what its component declares, so the file is found again from the view's id.
export const studioViewId = (path: string) => 'studio-' + fileKey(path).slice(5, 17);
export const useProcess = () => useContext(ProcessContext);
