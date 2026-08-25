import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import type {
  ResourceContent,
  ResourceDescriptor,
  ResourceReadConsistency,
  ResourceRegistrySnapshot,
  SurfaceInstance,
} from "../transport";
import { MenuPopover } from "./MenuPopover";
import { SourceEditor } from "./SourceEditor";
import type { SourceEditorHandle } from "./SourceEditor";
import type { SourceExecutionSubmission } from "./source-execution";
import { workbenchFailureMessage } from "./workbench-failure";

export interface FileResourceViewProps {
  readonly instance: SurfaceInstance;
  readonly registry: ResourceRegistrySnapshot | null;
  readonly read: (
    descriptor: ResourceDescriptor,
    consistency: ResourceReadConsistency,
    resourceRevision: number,
  ) => Promise<ResourceContent>;
  readonly updateDraft: (content: ResourceContent, value: string) => Promise<ResourceContent>;
  readonly save: (content: ResourceContent) => Promise<ResourceContent>;
  readonly reload: (content: ResourceContent, discardDirty: boolean) => Promise<ResourceContent>;
  readonly rename: (content: ResourceContent | null, nextId: string) => Promise<void>;
  readonly removeResource: (
    content: ResourceContent | null,
    discardDirty: boolean,
  ) => Promise<void>;
  readonly refreshBinding: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly setViewGroup: (viewGroupId: string | null) => Promise<void>;
  readonly persistViewState: (viewState: unknown) => Promise<void>;
  readonly runSourceExecution: (execution: SourceExecutionSubmission) => Promise<boolean>;
  readonly reportError: (error: unknown) => void;
}

function fileViewState(instance: SurfaceInstance) {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  return {
    cursorStart: typeof candidate.cursor_start === "number" ? candidate.cursor_start : 0,
    cursorEnd: typeof candidate.cursor_end === "number" ? candidate.cursor_end : 0,
    scrollTop: typeof candidate.scroll_top === "number" ? candidate.scroll_top : 0,
  };
}

function resourceMarkup(content: ResourceContent): { html?: string; text?: string; image?: string } {
  const mediaType = content.descriptor.media_type ?? "text/plain";
  if (content.content_encoding === "base64" && mediaType.startsWith("image/")) {
    return { image: `data:${mediaType};base64,${content.content}` };
  }
  if (mediaType === "text/markdown" || mediaType === "text/x-r-markdown") {
    const rendered = marked.parse(content.content, { async: false }) as string;
    return { html: DOMPurify.sanitize(rendered) };
  }
  if (mediaType === "text/html") {
    return { html: DOMPurify.sanitize(content.content) };
  }
  return { text: content.content };
}

export function FileResourceView({
  instance, registry, read, updateDraft, save, reload, rename, removeResource,
  refreshBinding, setViewGroup, persistViewState, runSourceExecution, reportError,
}: FileResourceViewProps) {
  const binding = instance.resource_binding;
  const descriptor = registry?.resources.find((candidate) =>
    candidate.resource_provider_id === binding?.resource_provider_id &&
    candidate.resource_kind === binding?.resource_kind &&
    candidate.resource_id === binding.resource_id
  ) ?? null;
  const source = instance.surface_id === "rho.file-source";
  const [content, setContent] = useState<ResourceContent | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [localDirty, setLocalDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceRunPending, setSourceRunPending] = useState(false);
  const [viewGroup, setViewGroupInput] = useState(instance.view_group_id ?? "");
  const [renamePath, setRenamePath] = useState(binding?.resource_id ?? "");
  const contentRef = useRef<ResourceContent | null>(content);
  const editorValueRef = useRef(editorValue);
  const localDirtyRef = useRef(localDirty);
  const draftCommitRef = useRef<Promise<ResourceContent | null> | null>(null);
  const sourceEditorRef = useRef<SourceEditorHandle>(null);
  contentRef.current = content;
  editorValueRef.current = editorValue;
  localDirtyRef.current = localDirty;
  const view = fileViewState(instance);
  const bindingRevision = binding?.resource_revision ?? descriptor?.resource_revision ?? 0;
  const staleBinding = descriptor != null && bindingRevision !== descriptor.resource_revision;
  const sourceRefreshRevision = source ? registry?.snapshot_revision ?? 0 : 0;

  useEffect(() => {
    if (descriptor == null || binding == null || descriptor.status !== "ready") return;
    let active = true;
    setError(null);
    void read(
      descriptor,
      source ? "shared_document" : "immutable_snapshot",
      bindingRevision,
    ).then((next) => {
      if (!active) return;
      setContent(next);
      contentRef.current = next;
      if (!localDirtyRef.current) {
        setEditorValue(next.content);
        editorValueRef.current = next.content;
      }
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(workbenchFailureMessage(cause, "Resource read failed."));
    });
    return () => { active = false; };
  }, [binding?.resource_id, bindingRevision, descriptor?.status, read, source, sourceRefreshRevision]);

  useEffect(() => {
    setViewGroupInput(instance.view_group_id ?? "");
  }, [instance.view_group_id]);
  useEffect(() => {
    setRenamePath(binding?.resource_id ?? "");
  }, [binding?.resource_id]);

  const commitDraft = (): Promise<ResourceContent | null> => {
    if (!source || contentRef.current == null || !localDirtyRef.current) {
      return Promise.resolve(contentRef.current);
    }
    if (draftCommitRef.current != null) return draftCommitRef.current;
    const base = contentRef.current;
    const value = editorValueRef.current;
    const operation: Promise<ResourceContent | null> = updateDraft(base, value).then((next) => {
      contentRef.current = next;
      setContent(next);
      if (editorValueRef.current === value) {
        editorValueRef.current = next.content;
        localDirtyRef.current = false;
        setEditorValue(next.content);
        setLocalDirty(false);
      }
      return next;
    }).finally(() => {
      if (draftCommitRef.current === operation) draftCommitRef.current = null;
    });
    draftCommitRef.current = operation;
    return operation;
  };
  const saveCurrent = async () => {
    const current = localDirtyRef.current ? await commitDraft() : contentRef.current;
    if (current == null || !current.dirty) return;
    const next = await save(current);
    contentRef.current = next;
    editorValueRef.current = next.content;
    localDirtyRef.current = false;
    setContent(next);
    setEditorValue(next.content);
    setLocalDirty(false);
  };
  const reloadCurrent = async () => {
    const current = contentRef.current;
    if (current == null) return;
    const next = await reload(current, current.dirty);
    contentRef.current = next;
    editorValueRef.current = next.content;
    localDirtyRef.current = false;
    setContent(next);
    setEditorValue(next.content);
    setLocalDirty(false);
  };
  const mode = instance.mode_id ?? (source ? "source" : "preview");
  const fileName = binding?.resource_id.split("/").filter(Boolean).pop() ?? "No file";
  const dirty = localDirty || content?.dirty === true;
  const outline = editorValue.split("\n").flatMap((line, index) => {
    const match = line.match(/^\s*(?:#+\s+(.+)|([A-Za-z.][\w.]*)\s*<-\s*function\b)/u);
    return match == null ? [] : [{ line: index + 1, label: match[1] ?? match[2] ?? line.trim() }];
  });
  const markup = !source && content != null ? resourceMarkup(content) : null;

  return (
    <div className="rho-file-resource">
      <div className="rho-file-commandbar">
        <span className={`rho-resource-state rho-resource-${descriptor?.status ?? "missing"}`}>
          {descriptor?.status ?? "unresolved"}
        </span>
        <strong className="rho-file-name" title={binding?.resource_id ?? "No Resource bound"}>{fileName}</strong>
        {dirty && <span className="rho-resource-dirty">Unsaved</span>}
        {(content?.stale || staleBinding) && <span className="rho-resource-stale">stale</span>}
        <span className="rho-file-command-spacer" />
        {staleBinding && descriptor != null && (
          <button type="button" onClick={() => void refreshBinding(descriptor).catch(reportError)}>
            Refresh
          </button>
        )}
        {source && content != null && <>
          <button
            type="button"
            className="rho-file-run"
            disabled={sourceRunPending}
            aria-busy={sourceRunPending || undefined}
            aria-label="Run selection or current R expression in Console"
            title="Run selection or current R expression in Console · Ctrl/⌘ + Enter"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => { void sourceEditorRef.current?.runSelectionOrCurrentLine(); }}
          >{sourceRunPending
              ? <><span className="rho-preparation-spinner" aria-hidden="true" /> Preparing…</>
              : <><span aria-hidden="true">▶</span> Run</>}</button>
          <button
            type="button"
            className={`rho-file-save ${dirty ? "rho-primary-action" : ""}`.trim()}
            disabled={!dirty}
            onClick={() => void saveCurrent().catch(reportError)}
          >Save</button>
          <button type="button" className="rho-file-reload" onClick={() => void reloadCurrent().catch(reportError)}>
            {dirty ? "Discard & reload" : "Reload"}
          </button>
        </>}
        <MenuPopover label={`File information for ${fileName}`} glyph={<span aria-hidden="true">i</span>}>
          <div className="rho-menu-heading">
            <strong>{fileName}</strong>
            <code>{binding?.resource_id ?? "No Resource bound"}</code>
          </div>
          <dl className="rho-menu-facts">
            <div><dt>Status</dt><dd>{descriptor?.status ?? "unresolved"}</dd></div>
            <div><dt>Media type</dt><dd>{descriptor?.media_type ?? "unknown"}</dd></div>
            <div><dt>Resource revision</dt><dd>{descriptor?.resource_revision ?? "—"}</dd></div>
            <div><dt>Document revision</dt><dd>{content?.document_revision ?? "—"}</dd></div>
            <div><dt>View group</dt><dd>{instance.view_group_id ?? "Independent"}</dd></div>
          </dl>
        </MenuPopover>
        <MenuPopover label={`More file actions for ${fileName}`} glyph={<span aria-hidden="true">•••</span>} panelClassName="rho-file-more-menu">
          <div className="rho-menu-heading"><strong>File options</strong></div>
          <label className="rho-menu-field">
            <span>View group</span>
            <input value={viewGroup} onChange={(event) => setViewGroupInput(event.target.value)} placeholder="Independent" />
          </label>
          <button type="button" data-menu-close onClick={() => void setViewGroup(viewGroup.trim() || null).catch(reportError)}>Apply view group</button>
          <div className="rho-menu-separator" />
          <label className="rho-menu-field">
            <span>Path</span>
            <input value={renamePath} onChange={(event) => setRenamePath(event.target.value)} />
          </label>
          <button type="button" data-menu-close disabled={binding == null || renamePath === binding.resource_id} onClick={() => {
            void rename(contentRef.current, renamePath).catch(reportError);
          }}>Rename file</button>
          <div className="rho-menu-separator" />
          <button type="button" data-menu-close disabled={binding == null || dirty} onClick={() => {
            void removeResource(contentRef.current, false).catch(reportError);
          }}>Delete file</button>
          {dirty && <button type="button" data-menu-close onClick={() => {
            void removeResource(contentRef.current, true).catch(reportError);
          }}>Discard changes &amp; delete</button>}
        </MenuPopover>
      </div>
      {descriptor?.status === "missing" && <div className="rho-resource-placeholder">This Resource no longer exists. Its Surface placement remains.</div>}
      {descriptor?.status === "unsupported" && <div className="rho-resource-placeholder">No compatible provider claims this Resource.</div>}
      {error != null && <p className="rho-resource-error" role="alert">{error}</p>}
      {source && mode === "source" && descriptor?.status === "ready" && (
        <SourceEditor
          ref={sourceEditorRef}
          ariaLabel={`Source ${binding?.resource_id ?? instance.instance_id}`}
          value={editorValue}
          viewState={{
            cursor_start: view.cursorStart,
            cursor_end: view.cursorEnd,
            scroll_top: view.scrollTop,
          }}
          onChange={(value) => {
            editorValueRef.current = value;
            localDirtyRef.current = true;
            setEditorValue(value);
            setLocalDirty(true);
          }}
          onBlur={(nextView) => {
            void commitDraft().catch(reportError);
            void persistViewState(nextView).catch(reportError);
          }}
          onViewStateChange={(nextView) => {
            void persistViewState(nextView).catch(reportError);
          }}
          onRun={async (execution) => {
            const current = localDirtyRef.current ? await commitDraft() : contentRef.current;
            if (binding == null || current == null) {
              throw new Error("The Source document is not ready for execution.");
            }
            return runSourceExecution({
              ...execution,
              source_path: binding.resource_id,
              document_version: current.document_revision,
            });
          }}
          onRunPendingChange={setSourceRunPending}
          onRunRejected={(message) => reportError(new Error(message))}
        />
      )}
      {source && mode === "diff" && (
        <div className="rho-file-analysis"><strong>Working document</strong><p>{content?.dirty ? "The shared document differs from its disk revision." : "No unsaved difference."}</p><pre>{editorValue}</pre></div>
      )}
      {source && mode === "outline" && (
        <ol className="rho-file-outline">{outline.length === 0 ? <li>No structural symbols found.</li> : outline.map((item) => <li key={`${item.line}:${item.label}`}><span>{item.line}</span>{item.label}</li>)}</ol>
      )}
      {!source && content != null && (
        <div className="rho-file-preview-body">
          {markup?.image != null && <img src={markup.image} alt={content.descriptor.label} />}
          {markup?.html != null && <div className="rho-rendered-document" dangerouslySetInnerHTML={{ __html: markup.html }} />}
          {markup?.text != null && <pre>{markup.text}</pre>}
        </div>
      )}
    </div>
  );
}
