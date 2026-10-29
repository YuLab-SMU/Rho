import { TextComparison } from '@rho-workspace/plugin-documents/ui';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { ReviewPanel } from '@rho-workspace/plugin-annotations/ui';
import { TableComparison } from '@rho-workspace/plugin-tables/ui';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { AgentMarkdown } from './markdown.js';
import { Snapshot } from './snapshot.js';
export default function Reviews({
  client,
  snapshot,
  principalId,
  annotationId,
  initialAnchor,
  onSent,
  onGraph
}: {
  client: BrowserClient;
  snapshot: WorkspaceSnapshot;
  principalId?: string;
  annotationId?: string;
  initialAnchor?: any;
  onSent: (id: string) => void;
  onGraph: (ref: { id: string; version: string }) => void;
}) {
  const [selected, setSelected] = useState<{
      id: string;
      version: string;
    } | null>(null),
    [exporting, setExporting] = useState('');
  return (
    <>
      <ReviewPanel
        client={client}
        projectId={snapshot.project.id}
        principalId={principalId}
        annotationId={annotationId}
        initialAnchor={initialAnchor}
        threads={snapshot.annotations}
        resources={snapshot.resources}
        conversations={snapshot.conversations ?? []}
        contexts={snapshot.contexts}
        onSent={onSent}
        onOpenResource={setSelected}
        onGraphResource={onGraph}
        renderText={(text) => <AgentMarkdown text={text} streaming={false} />}
        renderCodeChanges={(id) => (
          <CodeChanges
            client={client}
            projectId={snapshot.project.id}
            annotationId={id}
            cursor={snapshot.cursor}
          />
        )}
        renderComparison={(left, right) => (
          <TableComparison
            key={left.id + right.id}
            client={client}
            projectId={snapshot.project.id}
            left={left}
            right={right}
          />
        )}
        onExport={setExporting}
      />
      {selected && (
        <ReviewDialog label="Captured result" onClose={() => setSelected(null)}>
          <button onClick={() => setSelected(null)}>
            Close captured result
          </button>
          <Snapshot
            client={client}
            projectId={snapshot.project.id}
            resource={selected}
          />
        </ReviewDialog>
      )}
      {exporting && (
        <EvidenceExport
          client={client}
          projectId={snapshot.project.id}
          annotationId={exporting}
          onClose={() => setExporting('')}
        />
      )}
    </>
  );
}
function EvidenceExport({
  client,
  projectId,
  annotationId,
  onClose
}: {
  client: BrowserClient;
  projectId: string;
  annotationId: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function inspect() {
    setBusy(true);
    try {
      setPreview(
        await client.call('evidence.preview', { projectId, annotationId })
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      let intent;
      const key = 'rho.evidence.export:' + projectId + ':' + annotationId;
      try {
        intent = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      } catch {}
      if (!intent) {
        intent = {
          projectId,
          annotationId,
          expectedDigest: preview.digest,
          exportId: 'evidence-' + crypto.randomUUID()
        };
        sessionStorage.setItem(key, JSON.stringify(intent));
      }
      setResult(await client.call('evidence.export', intent));
      sessionStorage.removeItem(key);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReviewDialog label="Export evidence" onClose={onClose}>
      <button onClick={onClose}>Close export</button>
      <h2>Export read-only evidence</h2>
      <p>
        Only this question, its replies, decisions and explicitly linked
        captured files are included. Completeness of the analysis evidence is not established.
      </p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void inspect()}>
        Preview included evidence
      </button>
      {preview && (
        <>
          <h3>Question and replies</h3>
          {preview.thread.messages.map((m: any) => (
            <div key={m.id}>
              <AgentMarkdown text={m.draft.text} streaming={false} />
            </div>
          ))}
          <h3>Human decisions</h3>
          {(preview.thread.decisions ?? []).map((d: any) => (
            <p key={d.id}>
              {d.status} · {d.reason}
            </p>
          ))}
          <h3>Selected files</h3>
          <p>
            {preview.files.length} files · {preview.bytes} bytes
          </p>
          <ul>
            {preview.files.map((f: any) => (
              <li key={f.resource.id}>
                <button onClick={() => setSelected(f.resource)}>
                  {f.provenance?.transform?.fields
                    ? 'Table differences'
                    : f.path}
                </button>{' '}
                · {f.bytes} bytes · {f.resource.version.slice(0, 12)}
              </li>
            ))}
          </ul>
          {selected && (
            <Snapshot
              client={client}
              projectId={projectId}
              resource={selected}
            />
          )}
          <h3>Evidence gaps</h3>
          <ul>
            {preview.gaps.map((g: string, i: number) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
          <button disabled={busy || !!result} onClick={() => void save()}>
            Export this selection
          </button>
        </>
      )}
      {result && (
        <p role="status">
          Saved to {result.destination}. Open index.html to read it offline.
        </p>
      )}
    </ReviewDialog>
  );
}

function CodeChanges({
  client,
  projectId,
  annotationId,
  cursor
}: {
  client: BrowserClient;
  projectId: string;
  annotationId: string;
  cursor: number;
}) {
  const [files, setFiles] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    client.call('evidence.preview', { projectId, annotationId }).then(
      (value) => {
        if (active)
          setFiles(
            (value.files as any[])
              .map((f) => ({
                ...f,
                sourceKind: f.provenance?.observation?.kind ?? 'disk'
              }))
              .filter((f) => /\.(R|r|py|qmd|Rmd|sh|sql)$/.test(f.path))
          );
      },
      (e) => active && setError(e.message)
    );
    return () => {
      active = false;
    };
  }, [annotationId, cursor]);
  const paths = [...new Set(files.map((f) => f.path + ' · ' + f.sourceKind))];
  return (
    <section>
      <h2>Code observations</h2>
      {error && <p role="alert">{error}</p>}
      {!paths.length && (
        <p>No code versions were explicitly retained for this review.</p>
      )}
      {paths.map((path) => {
        const versions = files.filter(
          (f) => f.path + ' · ' + f.sourceKind === path
        );
        return (
          <article key={path}>
            <h3>{path}</h3>
            {versions.length > 1 ? (
              <TextComparison
                client={client}
                projectId={projectId}
                before={versions[0].resource}
                after={versions.at(-1).resource}
              />
            ) : (
              <p>
                Only one captured version is available. An earlier code version
                was not retained.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}

function ReviewDialog({
  label,
  onClose,
  children
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      className="review-overlay"
      ref={dialog}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
