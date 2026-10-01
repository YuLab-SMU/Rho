import type { MediaReference } from "../public/r-protocol/index.js";
export const mediaKey = (reference: MediaReference) => `${reference.operation_id}:${reference.sequence}:${reference.sha256}`;
/** Presentation uses the original native output identity. The package's output
 * reader must separately retain the qualified resource/provider reference. */
export interface OutputSnapshot { readonly media: readonly MediaReference[]; }
export interface PlotsDependencies {
  outputs: { getSnapshot(): Readonly<OutputSnapshot>; subscribe(listener: () => void): () => void; };
  changed?(): void;
  openPlot?(id: string, name: string): void;
  showPlots?(): void;
  newId?(): string;
}
