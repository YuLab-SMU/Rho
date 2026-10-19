// Metadata only; catalog pages do not load editor/grid implementations.
import { rendered } from 'virtual:rho-ui-registry-meta';
export { rendered };
export const renders = (component: string, version: string) => rendered.some(r => r.component === component && r.version === version);
