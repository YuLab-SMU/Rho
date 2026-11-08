import { useState } from 'react';
import { createPortal } from 'react-dom';
import { MediaView } from '@rho-workspace/plugin-media/ui';
import type { UiContribution, UiViewProps } from '../../src/ui-contract.js';

// The full form of registered media: the bytes of this exact version, read in bounded
// chunks and shown. A produced figure becomes visible here; nothing is written. The
// figure fits the card by default; its own size is one press away.
function Media(props: UiViewProps) {
  const ref = props.view.bindings.data as { id?: string; version?: string } | undefined;
  const resource = props.snapshot.resources.find(r => r.id === ref?.id && r.version === ref?.version);
  const mimeType = typeof resource?.format === 'object' && typeof resource.format.mimeType === 'string' ? resource.format.mimeType : undefined;
  const [fit, setFit] = useState(true), [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const media = <MediaView view={props.view} projectId={props.projectId} client={props.client} active={props.active} fit={fit} onSize={setSize}
    maxReadBytes={(props.snapshot.limits.resources as { maxReadBytes?: number } | undefined)?.maxReadBytes} mimeType={mimeType} />;
  // A version is the SHA-256 of its bytes: a picture a Notebook cell saved as a figure (ggsave) is
  // drawn from its record, its marks selectable; any other stays the picture it is.
  // The bytes' digest alone finds the figure; the resource's path is where Files keeps its snapshot,
  // and the figure names the project file the cell saved.
  const sha256 = ref?.version, title = String(props.view.props.title ?? 'figure');
  const figure = props.active && props.shell?.figure && sha256 && /^[a-f0-9]{64}$/.test(sha256) && /\.(png|jpe?g|svg|tiff?|webp)$/i.test(title)
    ? props.shell.figure({ client: props.client, projectId: props.projectId, file: { sha256 }, label: title, name: title, fit, fallback: media }) : null;
  return <>
    {props.headerTarget && size && createPortal(<span className="media-controls">
      <span className="media-size">{size.width} × {size.height}</span>
      <span className="segmented" role="group" aria-label="Figure size">
        <button aria-pressed={fit} onClick={() => setFit(true)}>Fit</button>
        <button aria-pressed={!fit} aria-label="Actual size" onClick={() => setFit(false)}>100%</button>
      </span>
    </span>, props.headerTarget)}
    {figure ?? media}
  </>;
}

export const entry: UiContribution = {
  entryVersion: '0.1-draft',
  owner: 'rho-plugins.media',
  package: '@rho-workspace/plugin-media',
  packageVersion: '0.4.0',
  component: 'rho.media',
  componentVersion: '0.2.0',
  propsSchema: { type: 'object', properties: { title: { type: 'string' } } },
  bindings: { data: 'resource' },
  requiredOperations: ['resource.read'],
  commands: [],
  selection: [],
  View: Media
};
