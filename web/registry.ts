import type { UiRegistry } from '../src/ui-contract.js';

// U1 ships no owner renderer. Never execute a catalog/Agent-provided module URL.
export const registry: UiRegistry = { entries: [] };
