import index from './previews/index.json';

// Pictures of the real views, captured by scripts/plugin-previews.mjs from the shipped
// example project at the component version named in each record. Nothing is drawn by
// hand; a view without a capture simply has no picture.
const urls = import.meta.glob('./previews/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export interface ViewPreview { component: string; version: string; package?: string; packageVersion?: string; shows: string; capturedAt: string; image: string }
export function viewPreview(component: string, version: string): (ViewPreview & { url: string }) | null {
  const record = (index as ViewPreview[]).find(r => r.component === component && r.version === version);
  const url = record && urls['./previews/' + record.image];
  return record && url ? { ...record, url } : null;
}
