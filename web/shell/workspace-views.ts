import { createContext } from 'react';
import type { Prepared, SessionScope } from '@rho-workspace/plugin-kernel/ui';

// What a page of views offers the views on it, beyond the shell's services: opening a live value
// or a server's file as a view of this page, code waiting for the Notebook's line, saving a view's
// own props with the page, which views the page has, and in a conversation's Studio which share
// of the live sessions it shows. The application's entries hand these to the plugins' views.
export interface WorkspaceViews {
  openValue?(language: 'r' | 'python', name: string): void;
  openRemote?(placeId: string, path: string): void;
  toNotebook?(language: 'r' | 'python', code: string, from: string): void;
  prepared: Prepared | null;
  taken(): void;
  setProps?(viewId: string, props: Record<string, unknown>): void;
  has(component: string): boolean;
  // The notebook that takes what another view sends, and each named notebook of the project.
  notebookTarget?: string | null;
  notebookNames?: Readonly<Record<string, string>>;
  scope?: SessionScope;
  openConversation?(conversationId: string): void;
  // The sessions' views bring each other forward on this page, adding the one asked for when the
  // page has none: a plot in Plots, a cell in the Notebook that lists it, the processes in Sessions.
  showPlot?(cellId: string, plot: number): void;
  showCell?(cellId: string, notebook: string | null): void;
  showSessions?(): void;
}
export const WorkspaceViewsContext = createContext<WorkspaceViews | null>(null);
