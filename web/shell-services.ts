import { createContext, createElement } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { ShellServices } from '../src/ui-contract.js';
import type { Entry } from './project.js';
import { highlight, languageExtensions } from './languages.js';
import { codeBox } from './code-box.js';
import { readFile, readImage } from './previews.js';
import { AgentMarkdown } from './markdown.js';
import { SemanticFigure, type FigureAsk } from '@rho-workspace/plugin-figures/ui';

// The services the shell gives every view on the project screen (see ShellServices).
export const ShellContext = createContext<ShellServices | undefined>(undefined);
// Read through `current` so the services stay one object while the project changes.
export function shellServices(client: BrowserClient, current: () => { snapshot: WorkspaceSnapshot | null; files: Entry[] }, openPath: (path: string) => void, openReview?: ShellServices['openReview'], askFigure?: (ask: FigureAsk) => void): ShellServices {
  return {
    // A page that does not say who kept a selection (the answer board, a file) names them as the
    // Notebook does: you, or the Agent of the conversation whose principal it is.
    figure: slot => createElement(SemanticFigure, { author: by => {
      if (by === 'browser:local') return { name: 'You', mine: true };
      const c = (current().snapshot?.conversations as Array<{ principal?: string | null; client?: string | null }> | undefined)?.find(x => x.principal === by);
      return { name: c?.client === 'codex' ? 'Codex' : c?.client === 'claude-code' ? 'Claude Code' : 'Agent', mine: false };
    }, ...slot, onAsk: askFigure }),
    openPath, openReview,
    imageUrl(path) {
      const { snapshot, files } = current(), file = files.find(f => f.path === path);
      return snapshot ? readImage(client, snapshot, { path, bytes: file?.bytes ?? null, modifiedAt: file?.modifiedAt ?? null }) : Promise.resolve(null);
    },
    fileBytes(path, maxBytes) {
      const { snapshot, files } = current(), file = files.find(f => f.path === path);
      return snapshot ? readFile(client, snapshot, { path, bytes: file?.bytes ?? null, modifiedAt: file?.modifiedAt ?? null }, maxBytes) : Promise.resolve(null);
    },
    pageFrame: '/frame.html',
    languageExtensions,
    highlight,
    codeBox,
    markdown: text => createElement(AgentMarkdown, { text, streaming: false }),
  };
}
