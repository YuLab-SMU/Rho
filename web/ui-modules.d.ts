/// <reference types="vite/client" />
declare module 'virtual:rho-ui-registry' { export const registry: import('../src/ui-contract.js').UiRegistry; }
declare module 'virtual:rho-ui-registry-meta' { export const rendered: readonly { component: string; version: string }[]; }
