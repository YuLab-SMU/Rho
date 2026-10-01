/** Shared public verification; this plugin retains its own durable intent. */
import type { JsonValue } from '../public/plugin-protocol/index.js';
import type { PluginViewClient } from '../public/plugin-ui/index.js';
export type Client = Pick<PluginViewClient, 'view' | 'query' | 'control' | 'invoke' | 'operation' | 'cancel' | 'setState' | 'testProject' | 'openTestWorkspace' | 'downloadArchive'>;
export type { OperationIntent as Intent, OriginalOperationRecord as RecordReply } from '../public/plugin-ui/index.js';
export { inspectOriginalOperation as inspectOriginal, verifyOriginalOperation as verifyOriginal, isTerminalOperation as terminal, canonicalOperationValue as canonical, sameOperationValue as same } from '../public/plugin-ui/index.js';
export const json = (value: unknown) => value as JsonValue;
