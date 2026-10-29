import { useEffect, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
export function Snapshot({
  client,
  projectId,
  resource,
  path = 'Snapshot'
}: {
  client: BrowserClient;
  projectId: string;
  resource: { id: string; version: string };
  path?: string;
}) {
  const [read, setRead] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true,
      url: string | undefined;
    setRead(null);
    setError('');
    (async () => {
      const first = await client.call('resource.read', {
        projectId,
        resource,
        offset: 0
      });
      const metadata = first.resource;
      if (metadata.kind === 'table') {
        const p = await client.call('data.page', {
          projectId,
          resource,
          offset: 0,
          limit: 100
        });
        if (live) setRead({ table: p });
        return;
      }
      let data = atob(first.data),
        page = first;
      while (page.more && data.length < 8388608) {
        page = await client.call('resource.read', {
          projectId,
          resource,
          offset: page.nextOffset
        });
        data += atob(page.data);
      }
      const bytes = Uint8Array.from(data, (c) => c.charCodeAt(0)),
        type =
          typeof metadata.format === 'object'
            ? String(metadata.format.mimeType ?? 'text/plain')
            : 'text/plain';
      if (
        metadata.kind === 'media' &&
        /^image\/(png|jpeg|svg\+xml)$/.test(type)
      ) {
        url = URL.createObjectURL(new Blob([bytes], { type }));
        if (live) setRead({ image: url });
      } else if (live && metadata.kind === 'media')
        setRead({
          message:
            'This version is retained. Export the evidence package to open its original bytes.'
        });
      else if (live)
        setRead({
          text: new TextDecoder().decode(bytes.slice(0, 65536), {
            stream: bytes.length > 65536
          }),
          cut: bytes.length > 65536
        });
    })().catch((e) => live && setError(e.message));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [resource.id, resource.version]);
  return (
    <section className="snapshot-view" aria-label={'Captured ' + path}>
      <p>Captured version {resource.version.slice(0, 12)} · read only</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !read ? (
        <p>Reading captured bytes…</p>
      ) : read.message ? (
        <p>{read.message}</p>
      ) : read.image ? (
        <img src={read.image} alt={path} />
      ) : read.table ? (
        <>
          <p>
            First {read.table.rows.length} of {read.table.total} rows
          </p>
          <div className="review-table-scroll">
            <table>
              <thead>
                <tr>
                  {read.table.columns.map((c: any) => (
                    <th key={c.name}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {read.table.rows.map((row: any, i: number) => (
                  <tr key={i}>
                    {read.table.columns.map((c: any) => (
                      <td key={c.name}>
                        {row[c.name] === null
                          ? 'Missing value'
                          : String(row[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <pre>{read.text}</pre>
          {read.cut && (
            <p>
              Preview limited to 64 KiB. The captured file is retained in full.
            </p>
          )}
        </>
      )}
    </section>
  );
}
