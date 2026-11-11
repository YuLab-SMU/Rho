// Which of the Agent page's two lists shows: every conversation, or the Agents themselves. The
// sidebar has a row for each, so the choice is kept here, apart from the page that draws them.
export type AgentTab = 'conversations' | 'agents';
const tabKey = 'rho.agent.tab.v1';
// The list last shown in this browser tab.
export function storedAgentTab(): AgentTab { try { return /^(agents|outside)$/.test(sessionStorage.getItem(tabKey) ?? '') ? 'agents' : 'conversations'; } catch { return 'conversations'; } }
export function storeAgentTab(tab: AgentTab) { try { sessionStorage.setItem(tabKey, tab); } catch { /* The list is remembered only while storage works. */ } }
