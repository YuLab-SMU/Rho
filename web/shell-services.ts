import { createContext } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { ShellServices } from '../src/ui-contract.js';
import type { Entry } from './project.js';
import { highlight, languageExtensions } from './languages.js';
import { readImage } from './previews.js';

// The services the shell gives every view on the project screen (see ShellServices).
export const ShellContext = createContext<ShellServices | undefined>(undefined);
// Read through `current` so the services stay one object while the project changes.
export function shellServices(client: BrowserClient, current: () => { snapshot: WorkspaceSnapshot | null; files: Entry[] }, openPath: (path: string) => void, openReview?: ShellServices['openReview']): ShellServices {
  return {
    openPath, openReview,
    imageUrl(path) {
      const { snapshot, files } = current(), file = files.find(f => f.path === path);
      return snapshot ? readImage(client, snapshot, { path, bytes: file?.bytes ?? null, modifiedAt: file?.modifiedAt ?? null }) : Promise.resolve(null);
    },
    languageExtensions,
    highlight,
  };
}
