import type { CSSProperties } from 'react';
import { agentIcon, agentIconById, agentName } from '@rho-workspace/plugin-agent-icons';
import './brand-marks.css';

// The marks of the Agents and model makers Rho names come from the Agent icons plugin: its
// catalog says which words in a name identify an Agent or maker. A name is whatever the Agent
// or its client called itself (an ACP agentInfo, an MCP clientInfo, a session name it chose).
// Any other name shows its initial on one of the theme's hues, chosen from the name so it stays
// the same everywhere.
export type Brand = string;
export function brandOf(name: string): Brand | null {
  return agentIcon(name)?.id ?? null;
}
// The Agent's product name when the catalog knows the Agent, else the name as it was given.
export function agentDisplayName(name: string) {
  return agentName(name);
}

// A one-colour mark takes the theme's ink, so it shows on light and dark alike; a coloured
// mark is drawn as its maker made it. Either way it is an image, never markup in the page.
export function BrandMark({ brand, size = 18 }: { brand: Brand; size?: number }) {
  const icon = agentIconById(brand);
  if (!icon) return null;
  const style = { width: size, height: size, ...(icon.ink ? { '--mark': `url("${icon.src}")` } : { backgroundImage: `url("${icon.src}")` }) } as CSSProperties;
  return <span className={'maker-mark maker-' + icon.id + (icon.ink ? ' ink' : '')} style={style} aria-hidden="true" />;
}

const hues = ['moss', 'iris', 'sky', 'clay', 'rose'] as const;
function hueOf(name: string) { let h = 0; for (const char of name) h = (h * 31 + char.codePointAt(0)!) >>> 0; return hues[h % hues.length]; }
// A provider's own mark when the catalog has it, otherwise its initial.
export function ProviderMark({ name, size = 18 }: { name: string; size?: number }) {
  const brand = brandOf(name);
  if (brand) return <BrandMark brand={brand} size={size} />;
  const initial = [...name.trim()][0]?.toUpperCase() ?? '·';
  return <span className={'provider-mark hue-' + hueOf(name)} style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }} aria-hidden="true">{initial}</span>;
}
