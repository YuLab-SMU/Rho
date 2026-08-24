import { describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import {
  createTauriResourceTransport,
  type ResourceContent,
  type ResourceRegistrySnapshot,
  type ResourceResolveRequest,
  type ResourceTarget,
  type ResourceTransport,
} from "./resource";

const descriptor = {
  resource_provider_id: "rho.project-files",
  project_id: "project-a",
  resource_kind: "project_file",
  resource_id: "analysis.R",
  resource_revision: 3,
  label: "analysis.R",
  capabilities: ["resource.read", "resource.write"],
  status: "ready",
  media_type: "text/x-r-source",
  size_bytes: 32,
  content_sha256: "a".repeat(64),
} as const;

const registry = {
  contract: "rho.ui.resource-registry.snapshot.v1",
  contract_major: 1,
  snapshot_revision: 5,
  project_id: "project-a",
  project_revision: 7,
  providers: [],
  resources: [descriptor],
} satisfies ResourceRegistrySnapshot;

const content = {
  contract: "rho.ui.resource-content.v1",
  descriptor,
  consistency: "shared_document",
  document_revision: 11,
  base_resource_revision: 3,
  dirty: false,
  stale: false,
  content_encoding: "utf8",
  content: "model <- lm(y ~ x)\n",
} satisfies ResourceContent;

const target = {
  project_id: "project-a",
  resource_provider_id: "rho.project-files",
  resource_kind: "project_file",
  resource_id: "analysis.R",
  expected_project_revision: 7,
  expected_resource_revision: 3,
} satisfies ResourceTarget;

describe("Resource generated transport", () => {
  it("owns all eight command identities and preserves exact request nesting", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return (["resource_list", "resource_resolve", "resource_rename", "resource_delete"]
        .includes(command) ? registry : content) as T;
    };
    const transport = createTauriResourceTransport(invoke);
    const resolve = {
      project_id: "project-a",
      resource_provider_id: "rho.project-files",
      resource_kind: "project_file",
      resource_id: "analysis.R",
      expected_project_revision: 7,
      expected_snapshot_revision: 5,
    } satisfies ResourceResolveRequest;
    const read = { target, consistency: "shared_document" } as const;
    const draft = { target, expected_document_revision: 11, content: "x <- 1\n" } as const;
    const save = { target, expected_document_revision: 11 } as const;
    const reload = { ...save, discard_dirty: true } as const;
    const rename = {
      target,
      expected_document_revision: 11,
      new_resource_id: "R/analysis.R",
    } as const;
    const deletion = { target, expected_document_revision: null, discard_dirty: false } as const;

    await transport.loadResources();
    await transport.resolveResource(resolve);
    await transport.readResource(read);
    await transport.updateResourceDraft(draft);
    await transport.saveResource(save);
    await transport.reloadResource(reload);
    await transport.renameResource(rename);
    await transport.deleteResource(deletion);

    expect(calls).toEqual([
      { command: "resource_list" },
      { command: "resource_resolve", args: { request: resolve } },
      { command: "resource_read", args: { request: read } },
      { command: "resource_update_draft", args: { request: draft } },
      { command: "resource_save", args: { request: save } },
      { command: "resource_reload", args: { request: reload } },
      { command: "resource_rename", args: { request: rename } },
      { command: "resource_delete", args: { request: deletion } },
    ]);
  });

  it("preserves rejection semantics and rejects unknown response contracts", async () => {
    const rejected = createTauriResourceTransport(async () => {
      throw new Error("resource document revision is stale");
    });
    await expect(rejected.saveResource({ target, expected_document_revision: 10 }))
      .rejects.toThrow("resource document revision is stale");

    const incompatible = createTauriResourceTransport(async <T,>() => ({
      ...registry,
      contract_major: 2,
    }) as T);
    await expect(incompatible.loadResources()).rejects.toThrow("unsupported contract version");
  });

  it("keeps browser/mock mode assignable to the narrow Resource facet", async () => {
    const transport: ResourceTransport = createMockUiKernelTransport();
    await expect(transport.loadResources()).resolves.toMatchObject({
      contract: "rho.ui.resource-registry.snapshot.v1",
    });
  });
});
