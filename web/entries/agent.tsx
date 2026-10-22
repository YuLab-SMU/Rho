import { AgentNote, agentNoteEntry } from '@rho-workspace/plugin-agent/ui';
import type { UiContribution } from '../../src/ui-contract.js';
export const entry: UiContribution = { ...agentNoteEntry, entryVersion: '0.1-draft', packageVersion: '0.4.3', commands: [], View: AgentNote };
