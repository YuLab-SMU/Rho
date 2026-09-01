#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerRoot = path.join(root, "programs/rho-rebuild");
const manifestPath = path.join(ledgerRoot, "MANIFEST.json");
const progressPath = path.join(ledgerRoot, "PROGRESS.json");
const statusPath = path.join(ledgerRoot, "STATUS.md");
const allowedStatuses = new Set(["pending", "ready", "active", "blocked", "done"]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate values`);
}

function validate() {
  const manifest = readJson(manifestPath);
  const progress = readJson(progressPath);
  assert.equal(manifest.schema_version, 2, "unsupported rebuild manifest schema");
  assert.equal(progress.schema_version, 2, "unsupported rebuild progress schema");
  assert.equal(manifest.program_id, progress.program_id, "program identity drift");
  assert.equal(manifest.revision_id, progress.revision_id, "program revision drift");
  assert.equal(manifest.status, progress.status, "program status drift");

  const packages = manifest.work_packages;
  assert.ok(Array.isArray(packages) && packages.length > 0, "manifest has no work packages");
  const ids = packages.map(({ id }) => id);
  unique(ids, "work package IDs");
  const known = new Set(ids);
  assert.deepEqual(
    Object.keys(progress.work_packages).sort(),
    [...ids].sort(),
    "manifest/progress package sets differ",
  );

  const projectIds = manifest.projects.map(({ id }) => id);
  unique(projectIds, "project IDs");
  const knownProjects = new Set(projectIds);
  for (const project of manifest.projects) {
    assert.ok(
      fs.existsSync(path.join(root, project.document)),
      `missing project document ${project.document}`,
    );
    unique(project.packages, `${project.id} package list`);
    for (const id of project.packages) {
      assert.ok(known.has(id), `${project.id} references unknown package ${id}`);
      assert.equal(
        packages.find((candidate) => candidate.id === id)?.project,
        project.id,
        `${id} project ownership drift`,
      );
    }
  }
  for (const document of manifest.documents) {
    assert.ok(fs.existsSync(path.join(root, document)), `missing ledger document ${document}`);
  }
  assert.ok(fs.existsSync(statusPath), "missing STATUS.md");

  for (const pkg of packages) {
    assert.ok(knownProjects.has(pkg.project), `${pkg.id} has unknown project ${pkg.project}`);
    assert.ok(typeof pkg.exit === "string" && pkg.exit.trim(), `${pkg.id} has no exit condition`);
    unique(pkg.depends_on, `${pkg.id} dependencies`);
    for (const dependency of pkg.depends_on) {
      assert.ok(known.has(dependency), `${pkg.id} depends on unknown package ${dependency}`);
      assert.notEqual(dependency, pkg.id, `${pkg.id} depends on itself`);
    }
    const record = progress.work_packages[pkg.id];
    assert.ok(allowedStatuses.has(record.status), `${pkg.id} has invalid status ${record.status}`);
    if (record.status === "done") {
      assert.ok(
        Array.isArray(record.evidence) && record.evidence.length > 0,
        `${pkg.id} is done without evidence`,
      );
    }
    if (record.status === "active" || record.status === "ready") {
      for (const dependency of pkg.depends_on) {
        assert.equal(
          progress.work_packages[dependency].status,
          "done",
          `${pkg.id} is ${record.status} before ${dependency} is done`,
        );
      }
    }
    for (const blocker of record.blocked_by ?? []) {
      assert.ok(known.has(blocker), `${pkg.id} names unknown blocker ${blocker}`);
      assert.notEqual(
        progress.work_packages[blocker].status,
        "done",
        `${pkg.id} retains completed blocker ${blocker}`,
      );
    }
  }

  const active = ids.filter((id) => progress.work_packages[id].status === "active");
  const ready = ids.filter((id) => progress.work_packages[id].status === "ready");
  assert.deepEqual([...progress.active_packages].sort(), active.sort(), "active package index drift");
  assert.deepEqual([...progress.ready_packages].sort(), ready.sort(), "ready package index drift");
  if (progress.status === "complete") {
    assert.ok(
      ids.every((id) => progress.work_packages[id].status === "done"),
      "complete program has unfinished packages",
    );
  } else {
    assert.ok(
      ids.some((id) => progress.work_packages[id].status !== "done"),
      "active program has no unfinished package",
    );
  }
  return { active, ids, manifest, progress, ready };
}

function printStatus(state) {
  const counts = Object.fromEntries([...allowedStatuses].map((status) => [status, 0]));
  for (const record of Object.values(state.progress.work_packages)) counts[record.status] += 1;
  console.log(`${state.manifest.program_id}@${state.manifest.revision_id}: ${state.progress.status}`);
  console.log(
    `packages: ${state.ids.length}; done ${counts.done}; active ${counts.active}; ready ${counts.ready}; pending ${counts.pending}; blocked ${counts.blocked}`,
  );
  console.log(`active: ${state.active.join(", ") || "none"}`);
  console.log(`ready: ${state.ready.join(", ") || "none"}`);
}

const command = process.argv[2] ?? "validate";
const state = validate();
if (command === "status") {
  printStatus(state);
} else if (command === "validate") {
  console.log(
    `Rebuild ledger valid: ${state.ids.length} packages across ${state.manifest.projects.length} projects`,
  );
} else {
  throw new Error(`Unknown rebuild ledger command: ${command}`);
}
