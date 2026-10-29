import fs from 'node:fs/promises';
import { privateEvidencePath } from './evidence-capture.js';
import path from 'node:path';
import {
  atomicBytes,
  atomicJson,
  canonical,
  confined,
  digest,
  requireThat,
  stateDirectory
} from '@rho-workspace/plugin-contracts';
import type { Resource } from '@rho-workspace/plugin-contracts';
export const evidenceExportLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 128,
  maxMetadataBytes: 4 * 1024 * 1024
};
type Ref = { id: string; version: string };
interface Sources {
  thread(id: string): Promise<any>;
  resources(): Promise<Resource[]>;
  bytes(ref: Ref): Promise<{ r: Resource; data: Buffer }>;
  observations(
    id: string
  ): Promise<{ turns: any[]; omitted: number; model?: any }>;
  table?(ref: Ref): Promise<any>;
}
const escape = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );
const readableName = (file: any) =>
  file.provenance?.transform?.fields ? 'Table differences' : file.path;
const columnName = (file: any, name: string) => {
  const fields = file.provenance?.transform?.fields,
    part = /^(before|after|delta)_(\d+)$/.exec(name);
  if (fields && part) {
    const field = fields[Number(part[2])];
    if (field)
      return part[1] === 'before'
        ? field.leftField + ' before'
        : part[1] === 'after'
          ? field.rightField + ' after'
          : 'Change in ' + field.leftField;
  }
  return name;
};
const same = (a: Ref, b: Ref) => a.id === b.id && a.version === b.version;
export class EvidenceExporter {
  private limits: typeof evidenceExportLimits;
  constructor(
    private root: string,
    private sources: Sources,
    limits: Partial<typeof evidenceExportLimits> = {}
  ) {
    this.limits = { ...evidenceExportLimits, ...limits };
    for (const [key, value] of Object.entries(this.limits))
      requireThat(
        Number.isSafeInteger(value) &&
          value > 0 &&
          value <=
            evidenceExportLimits[key as keyof typeof evidenceExportLimits],
        'invalid',
        'Evidence budgets must be positive integers no greater than the supported defaults.'
      );
  }
  async preview(annotationId: string) {
    const thread = await this.sources.thread(annotationId),
      resources = await this.sources.resources(),
      observations = await this.sources.observations(annotationId);
    const selected: Ref[] = [],
      gaps: string[] = [];
    const add = (r: Ref) => {
      const source = resources.find((f) => same(f, r));
      const sourcePath = source?.provenance.originalPath ?? source?.path;
      if (sourcePath && privateEvidencePath(sourcePath)) {
        gaps.push(
          sourcePath +
            ': known connection or credential file excluded from the default selection.'
        );
        return;
      }
      if (!selected.some((x) => same(x, r))) {
        if (selected.length >= this.limits.maxFiles) {
          gaps.push(
            'Further explicitly referenced resources exceed the 128 file limit.'
          );
          return;
        }
        selected.push({ id: r.id, version: r.version });
      }
    };
    if (thread.anchor.resource) add(thread.anchor.resource);
    for (const message of thread.messages)
      for (const ref of message.resources ?? []) add(ref);
    for (const turn of observations.turns)
      for (const record of turn.evidence?.records ?? []) {
        for (const s of record.snapshots) add(s.resource);
        if (record.state !== 'captured' || record.reason)
          gaps.push(record.path + ': ' + (record.reason ?? record.state));
      }
    if (observations.omitted)
      gaps.push(
        observations.omitted +
          ' older conversation records were outside the observation window.'
      );
    for (let i = 0; i < selected.length; i++) {
      const r = resources.find((r) => same(r, selected[i]));
      for (const input of r?.provenance.inputs ?? [])
        if (input?.id && input?.version) add(input);
    }
    // These transforms carry explicit owner-declared input references and field mappings.
    for (const r of resources)
      if (
        r.provenance.transform?.fields &&
        r.provenance.inputs?.length === 2 &&
        r.provenance.inputs.every((ref: Ref) =>
          selected.some((x) => same(x, ref))
        )
      )
        add(r);
    const files: Array<{
      resource: Ref;
      path: string;
      bytes: number;
      kind: string;
      provenance: any;
      coverage: any;
    }> = [];
    let bytes = 0;
    for (const ref of selected) {
      const r = resources.find((r) => same(r, ref));
      if (!r) {
        gaps.push(
          'Selected resource ' + ref.id + '@' + ref.version + ' is unavailable.'
        );
        continue;
      }
      bytes += r.bytes;
      requireThat(
        bytes <= this.limits.maxBytes,
        'limit',
        'Selected evidence exceeds the 512 MiB export budget.'
      );
      files.push({
        resource: ref,
        path:
          r.provenance.originalPath ??
          r.provenance.restoredFrom?.path ??
          r.path,
        bytes: r.bytes,
        kind: r.kind,
        provenance: {
          source: r.provenance.source,
          originalPath: r.provenance.originalPath,
          observation: r.provenance.observation,
          producerConfirmed: r.provenance.producerConfirmed,
          inputs: r.provenance.inputs,
          transform: r.provenance.transform,
          operationId: r.provenance.operationId,
          codeDigest: r.provenance.codeDigest
        },
        coverage: r.coverage
      });
    }
    if (!files.some((f) => /\.(R|r|py|qmd|Rmd|sh|sql)$/.test(f.path)))
      gaps.push(
        'No code version was explicitly retained or linked for this selection.'
      );
    if (!observations.turns.length)
      gaps.push(
        'No captured Rho conversation turn explicitly references this review. Historical native activity is not reconstructed.'
      );
    const selection = {
      format: 'rho.evidence-selection/1',
      annotationId,
      thread,
      files,
      observations,
      gaps: [...new Set(gaps)]
    };
    requireThat(
      Buffer.byteLength(JSON.stringify(selection)) <=
        this.limits.maxMetadataBytes,
      'limit',
      'Selected evidence metadata exceeds 4 MiB.'
    );
    return { ...selection, bytes, digest: digest(canonical(selection)) };
  }
  async export(input: {
    annotationId: string;
    exportId: string;
    expectedDigest: string;
  }) {
    requireThat(
      /^[A-Za-z0-9._:@-]{1,128}$/.test(input.exportId),
      'invalid',
      'Invalid export identity.'
    );
    const directory = await stateDirectory(
        this.root,
        '.rho/rho/evidence-exports'
      ),
      receiptPath = path.join(directory, input.exportId + '.json');
    const original = await fs
      .readFile(receiptPath, 'utf8')
      .then(JSON.parse, (e: any) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    const requestDigest = digest(canonical(input));
    if (original) {
      requireThat(
        original.requestDigest === requestDigest,
        'conflict',
        'This export identity names a different selection.'
      );
      if (original.result) return original.result;
      requireThat(
        original.manifestDigest,
        'condition',
        'The original export is incomplete. Its files are retained; a new export must be deliberately selected.'
      );
      const target = await confined(this.root, original.destination),
        manifestBytes = await fs.readFile(
          await confined(target, 'evidence.json')
        );
      requireThat(
        digest(manifestBytes) === original.manifestDigest,
        'condition',
        'The original export manifest differs from its retained identity.'
      );
      await verifyEvidence(target);
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const result = {
        destination: original.destination,
        state: 'complete',
        files: manifest.inventory.length,
        manifestDigest: original.manifestDigest,
        gaps: manifest.selection.gaps
      };
      await atomicJson(receiptPath, { ...original, state: 'complete', result });
      return result;
    }
    const selection = await this.preview(input.annotationId);
    requireThat(
      selection.digest === input.expectedDigest,
      'stale',
      'The review or selected evidence changed. Preview it again before exporting.'
    );
    const destination = 'exports/' + input.exportId,
      target = await confined(this.root, destination, true);
    await atomicJson(receiptPath, {
      requestDigest,
      destination,
      selectionDigest: selection.digest,
      state: 'preparing'
    });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(target);
    await fs.mkdir(path.join(target, 'files'));
    const exportGaps: string[] = [],
      inventory: any[] = [],
      contents: Array<{ file: any; data: Buffer; href: string; table?: any }> =
        [];
    const put = async (relative: string, data: Buffer | string) => {
      const bytes = Buffer.from(data);
      const total = inventory.reduce((n, f) => n + f.bytes, 0) + bytes.length;
      requireThat(
        total <= this.limits.maxBytes,
        'limit',
        'Export exceeds 512 MiB; the unfinished directory is retained.'
      );
      await atomicBytes(path.join(target, relative), bytes);
      inventory.push({
        path: relative,
        bytes: bytes.length,
        sha256: digest(bytes)
      });
    };
    for (const f of selection.files) {
      const { data } = await this.sources.bytes(f.resource);
      requireThat(
        digest(data) === f.resource.version,
        'condition',
        'Selected evidence failed byte verification.'
      );
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(f.path)?.[0] ?? '.bin',
        href = 'files/' + f.resource.id + ext;
      await put(href, data);
      let table;
      if (f.kind === 'table') {
        if (this.sources.table) {
          try {
            table = await this.sources.table(f.resource);
          } catch {
            exportGaps.push(
              f.path +
                ': typed table preview was unavailable; original bytes are retained.'
            );
          }
        } else
          exportGaps.push(
            f.path +
              ': Tables is unavailable for a typed preview; original bytes are retained.'
          );
      }
      contents.push({ file: f, data, href, table });
    }
    const exportedSelection = {
      ...selection,
      gaps: [...selection.gaps, ...exportGaps]
    };
    await put('index.html', render(exportedSelection, contents));
    const manifest = {
      format: 'rho.evidence/1',
      complete: true,
      createdAt: new Date().toISOString(),
      selectionDigest: selection.digest,
      selection: exportedSelection,
      inventory,
      scope:
        'Read-only selected observations and human decisions. No scientific correctness, authorship signature, complete execution history or replay claim.'
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    requireThat(
      manifestBytes.length <= this.limits.maxMetadataBytes,
      'limit',
      'Evidence manifest exceeds 4 MiB.'
    );
    requireThat(
      inventory.reduce((n, f) => n + f.bytes, 0) + manifestBytes.length <=
        this.limits.maxBytes,
      'limit',
      'Package including its manifest exceeds 512 MiB.'
    );
    await atomicJson(receiptPath, {
      requestDigest,
      destination,
      selectionDigest: selection.digest,
      state: 'writing-manifest',
      manifestDigest: digest(manifestBytes)
    });
    await atomicBytes(path.join(target, 'evidence.json'), manifestBytes);
    const result = {
      destination,
      state: 'complete',
      files: inventory.length,
      manifestDigest: digest(manifestBytes),
      gaps: exportedSelection.gaps
    };
    await atomicJson(receiptPath, {
      requestDigest,
      destination,
      selectionDigest: selection.digest,
      state: 'complete',
      result
    });
    return result;
  }
}
function render(
  selection: any,
  contents: Array<{ file: any; data: Buffer; href: string; table?: any }>
) {
  const body = contents
    .map(({ file, data, href, table }) => {
      let preview = '';
      if (table) {
        const columns = table.columns.slice(0, 20);
        preview =
          '<p>First ' +
          Math.min(table.rows.length, 200) +
          ' of ' +
          table.total +
          ' rows; ' +
          columns.length +
          ' of ' +
          table.columns.length +
          ' columns.</p><div class="scroll"><table><thead><tr>' +
          columns
            .map(
              (c: any) => '<th>' + escape(columnName(file, c.name)) + '</th>'
            )
            .join('') +
          '</tr></thead><tbody>' +
          table.rows
            .slice(0, 200)
            .map(
              (r: any) =>
                '<tr>' +
                columns
                  .map(
                    (c: any) =>
                      '<td>' +
                      escape(r[c.name] === null ? 'Missing value' : r[c.name]) +
                      '</td>'
                  )
                  .join('') +
                '</tr>'
            )
            .join('') +
          '</tbody></table></div>';
      } else if (/\.(png|jpe?g|svg)$/i.test(href))
        preview =
          '<img src="' + escape(href) + '" alt="' + escape(file.path) + '">';
      else if (/\.(R|r|py|md|txt|json|csv|tsv|qmd|Rmd|sh|sql)$/i.test(href))
        preview =
          '<pre>' +
          escape(
            new TextDecoder().decode(data.subarray(0, 65536), {
              stream: data.length > 65536
            })
          ) +
          '</pre>' +
          (data.length > 65536
            ? '<p>Text preview limited to 64 KiB; the linked file is complete.</p>'
            : '');
      return (
        '<section><h2>' +
        escape(readableName(file)) +
        '</h2><p><a href="' +
        escape(href) +
        '">Open original bytes</a> · ' +
        file.bytes +
        ' bytes · SHA-256 ' +
        escape(file.resource.version) +
        '</p><p>Captured: ' +
        escape(file.coverage?.observedAt ?? 'not recorded') +
        ' · ' +
        escape(file.provenance?.observation?.kind ?? 'owner resource') +
        '</p><details><summary>Version and source</summary><pre>' +
        escape(
          JSON.stringify(
            {
              resource: file.resource,
              path: file.path,
              provenance: file.provenance
            },
            null,
            2
          )
        ) +
        '</pre></details>' +
        preview +
        '</section>'
      );
    })
    .join('');
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'self\' data:; base-uri \'none\'"><title>Rho evidence</title><style>*{box-sizing:border-box}body{overflow-wrap:anywhere;min-width:0;font:16px/1.6 system-ui;margin:0 auto;padding:32px;max-width:1100px;color:#18342b;background:#fff}h1{font-size:28px}h2{font-size:20px}section{border-top:1px solid #dce4df;margin:28px 0;padding-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#f4f7f5;padding:16px}img{max-width:100%;height:auto}.scroll{overflow:auto}table{border-collapse:collapse;white-space:nowrap}th,td{border-bottom:1px solid #dce4df;padding:8px 12px;text-align:right}p,li{overflow-wrap:anywhere}a{color:#176448}@media(max-width:600px){body{padding:16px}}</style><h1>Selected research evidence</h1><p>This package contains selected recorded versions. An accepted human decision is not a scientific validity check.</p><h2>Question and replies</h2>' +
    selection.thread.messages
      .map(
        (m: any, i: number) =>
          '<article><h3>' +
          (i === 0
            ? 'Question'
            : m.author.startsWith('agent:')
              ? 'Agent reply'
              : 'Reply') +
          '</h3><pre>' +
          escape(m.draft.text) +
          '</pre></article>'
      )
      .join('') +
    '<h2>Human decisions</h2>' +
    ((selection.thread.decisions ?? [])
      .map(
        (d: any) =>
          '<article><strong>' +
          escape(d.status) +
          '</strong><p>' +
          escape(d.reason) +
          '</p><small>' +
          escape(d.at) +
          ' · ' +
          d.resources.map((r: Ref) => escape(r.version)).join(', ') +
          '</small></article>'
      )
      .join('') || '<p>No decision recorded.</p>') +
    '<h2>Recorded relationships</h2><p>Reported, named or observed links in the selected review window; no inferred producer relationship.</p><ul>' +
    (selection.observations.model?.edges ?? [])
      .map((e: any) => {
        const nodes = selection.observations.model.nodes;
        const name = (id: string) => {
          const n = nodes.find((n: any) => n.id === id);
          return (
            n?.path ??
            (n?.kind === 'question' ? 'Question' : 'Recorded command')
          );
        };
        return (
          '<li>' +
          escape(name(e.from)) +
          ' → ' +
          escape(name(e.to)) +
          ': ' +
          escape(e.label) +
          ' (' +
          escape(e.basis) +
          ')</li>'
        );
      })
      .join('') +
    '</ul><h2>Evidence gaps</h2><ul>' +
    selection.gaps.map((g: string) => '<li>' + escape(g) + '</li>').join('') +
    '</ul>' +
    body +
    '<p><a href="evidence.json">Machine-readable manifest</a> · Files can be checked with rho --verify-evidence PATH. This is not a workspace restore or executable analysis package.</p></html>'
  );
}
export async function verifyEvidence(directory: string) {
  const root = await fs.realpath(directory),
    manifestFile = await confined(root, 'evidence.json');
  requireThat(
    (await fs.stat(manifestFile)).size <= evidenceExportLimits.maxMetadataBytes,
    'limit',
    'Manifest exceeds 4 MiB.'
  );
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  requireThat(
    manifest.format === 'rho.evidence/1' &&
      manifest.complete === true &&
      Array.isArray(manifest.inventory) &&
      manifest.inventory.length <= evidenceExportLimits.maxFiles + 1,
    'invalid',
    'Unsupported or incomplete evidence package.'
  );
  requireThat(
    new Set(manifest.inventory.map((f: any) => f.path)).size ===
      manifest.inventory.length,
    'invalid',
    'Duplicate evidence paths.'
  );
  requireThat(
    manifest.inventory.some((f: any) => f.path === 'index.html') &&
      Array.isArray(manifest.selection?.files),
    'invalid',
    'Evidence package lacks its reader or selection.'
  );
  for (const selected of manifest.selection.files) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(selected.path)?.[0] ?? '.bin';
    requireThat(
      manifest.inventory.some(
        (f: any) =>
          f.path === 'files/' + selected.resource.id + ext &&
          f.sha256 === selected.resource.version &&
          f.bytes === selected.bytes
      ),
      'invalid',
      'Selected resource is missing from the verified inventory.'
    );
  }
  let total = (await fs.stat(manifestFile)).size;
  for (const item of manifest.inventory) {
    requireThat(
      typeof item.path === 'string' &&
        !path.isAbsolute(item.path) &&
        !item.path
          .split(/[\\/]/)
          .some((p: string) => ['..', '.rho', '.git'].includes(p)) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0 &&
        /^[a-f0-9]{64}$/.test(item.sha256),
      'invalid',
      'Invalid evidence inventory.'
    );
    total += item.bytes;
    requireThat(
      total <= evidenceExportLimits.maxBytes,
      'limit',
      'Package exceeds 512 MiB.'
    );
    const file = await confined(root, item.path);
    requireThat(
      (await fs.realpath(file)) === file &&
        (await fs.lstat(file)).isFile() &&
        (await fs.stat(file)).size === item.bytes,
      'condition',
      'Evidence size or file type mismatch.'
    );
    requireThat(
      digest(await fs.readFile(file)) === item.sha256,
      'condition',
      'Evidence digest mismatch.',
      { file: item.path }
    );
  }
  return {
    verified: true,
    files: manifest.inventory.length,
    bytes: total,
    scope:
      'Inventory byte integrity only; no scientific validity or authorship claim.'
  };
}
