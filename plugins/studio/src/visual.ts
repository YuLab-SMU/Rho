/** Studio editing uses the same public declaration model as executable plugins. */
export {
  parseVisualDocument as parseVisual,
  createVisualNode as node,
  visualNodeKinds as kinds,
  visualBindingValue as fixtureValue,
  visualConditionMatches as fixtureVisible,
  validateVisualSourcePath as sourcePath,
} from '../public/plugin-ui/index.js';
export const own = <T>(map: Record<string,T>, key: string): T | undefined => Object.hasOwn(map,key) ? map[key] : undefined;
export function put<T>(map: Record<string,T>, key: string, value: NoInfer<T>) { Object.defineProperty(map,key,{value,writable:true,enumerable:true,configurable:true}); }
export const bytes = (text: string) => new TextEncoder().encode(text);
export const isVisual = (path:string) => path.startsWith('views/')&&path.endsWith('.json');
export function diagnostic(error: unknown) { return error instanceof Error ? error.message : String(error); }
