import type { UiExtension } from '../src/ui-extension.js';
export interface SelectedUiEntry { plugin: string; package: string; packageVersion?: string; entry: string; component: string; version: string; source: string; directory?: string; extension?: UiExtension; localOverride?: boolean; entrySha256?: string; manifestSha256?: string }
export function selectedUiEntries(): SelectedUiEntry[];
export function contributionMetadata(entry: SelectedUiEntry): Record<string, unknown>;
