#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FINDING_STATES = new Set([
  "observed", "triaged", "active", "verifying", "resolved", "deferred", "needs_authorization",
]);
const PACKAGE_STATES = new Set([
  "proposed", "ready", "active", "verifying", "implemented", "paused", "blocked",
]);
const FINDING_TRANSITIONS = new Map([
  ["observed", new Set(["triaged", "deferred", "needs_authorization"])],
  ["triaged", new Set(["active", "deferred", "needs_authorization"])],
  ["active", new Set(["verifying", "triaged", "deferred", "needs_authorization"])],
  ["verifying", new Set(["resolved", "active", "needs_authorization"])],
  ["resolved", new Set()],
  ["deferred", new Set(["triaged", "needs_authorization"])],
  ["needs_authorization", new Set(["triaged", "deferred"])],
]);
const PACKAGE_TRANSITIONS = new Map([
  ["proposed", new Set(["ready", "blocked"])],
  ["ready", new Set(["active", "blocked"])],
  ["active", new Set(["verifying", "paused", "blocked"])],
  ["verifying", new Set(["implemented", "active", "blocked"])],
  ["implemented", new Set()],
  ["paused", new Set(["active", "blocked"])],
  ["blocked", new Set(["ready"])],
]);
const RECORD_TYPES = new Set(["program", "finding", "work_package", "decision", "evidence"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{7,40}|WORKTREE)$/u;

export class ProgramValidationError extends Error {
  constructor(errors) {
    super(`Architecture program validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ProgramValidationError";
    this.errors = errors;
  }
}

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

export function parseRecord(file, root = process.cwd()) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^# [^\n]+\n\n```json\n([\s\S]*?)\n```(?:\n|$)/u);
  if (match == null) {
    throw new Error(`${normalizePath(path.relative(root, file))}: first fenced block must be strict JSON immediately after the H1`);
  }
  let metadata;
  try {
    metadata = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${normalizePath(path.relative(root, file))}: invalid JSON metadata: ${error.message}`);
  }
  if (metadata == null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new Error(`${normalizePath(path.relative(root, file))}: JSON metadata must be an object`);
  }
  return { ...metadata, _file: normalizePath(path.relative(root, file)) };
}

export function loadProgram(root = process.cwd()) {
  const programFile = path.join(
    root,
    "docs/architecture/active-2026-08-24-architecture-modernization-program.md",
  );
  const files = [
    programFile,
    ...markdownFiles(path.join(root, "docs/architecture/modernization")),
  ];
  const records = [];
  const errors = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      errors.push(`${normalizePath(path.relative(root, file))}: required record is missing`);
      continue;
    }
    try {
      records.push(parseRecord(file, root));
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length > 0) throw new ProgramValidationError(errors);
  return records.sort((left, right) => left._file.localeCompare(right._file));
}

function present(record, field) {
  return Object.hasOwn(record, field) && record[field] !== null && record[field] !== "";
}

function requireFields(record, fields, errors) {
  for (const field of fields) {
    if (!present(record, field)) errors.push(`${record._file}: missing required field ${field}`);
  }
}

function requireArray(record, field, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(record[field])) {
    errors.push(`${record._file}: ${field} must be an array`);
  } else if (nonEmpty && record[field].length === 0) {
    errors.push(`${record._file}: ${field} must not be empty`);
  }
}

function validateHistory(record, states, transitions, errors) {
  if (!Array.isArray(record.status_history) || record.status_history.length === 0) {
    errors.push(`${record._file}: status_history must be a non-empty array`);
    return;
  }
  let previous = null;
  for (const [index, entry] of record.status_history.entries()) {
    if (entry == null || Array.isArray(entry) || typeof entry !== "object") {
      errors.push(`${record._file}: status_history[${index}] must be an object`);
      continue;
    }
    if (!states.has(entry.status)) errors.push(`${record._file}: unknown history status ${entry.status}`);
    if (!DATE_PATTERN.test(entry.at ?? "")) errors.push(`${record._file}: history ${entry.status ?? index} has invalid date`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(`${record._file}: history ${entry.status ?? index} requires a reason`);
    }
    if (previous != null && !transitions.get(previous)?.has(entry.status)) {
      errors.push(`${record._file}: illegal status transition ${previous} -> ${entry.status}`);
    }
    previous = entry.status;
  }
  if (previous !== record.status) {
    errors.push(`${record._file}: final history status ${previous} does not match ${record.status}`);
  }
}

function validateFinding(record, errors) {
  requireFields(record, [
    "id", "title", "severity", "category", "discovered_at", "discovered_in", "impact",
    "disposition_work_package", "target_wave", "status",
  ], errors);
  requireArray(record, "evidence", errors, { nonEmpty: true });
  requireArray(record, "tests", errors, { nonEmpty: true });
  requireArray(record, "commits", errors);
  if (!/^AM-F-\d{4}$/u.test(record.id ?? "")) errors.push(`${record._file}: invalid finding id ${record.id}`);
  if (!new Set(["critical", "high", "medium", "low"]).has(record.severity)) {
    errors.push(`${record._file}: invalid severity ${record.severity}`);
  }
  if (!DATE_PATTERN.test(record.discovered_at ?? "")) errors.push(`${record._file}: invalid discovered_at`);
  if (!Number.isInteger(record.target_wave) || record.target_wave < 0) {
    errors.push(`${record._file}: target_wave must be a non-negative integer`);
  }
  if (!FINDING_STATES.has(record.status)) errors.push(`${record._file}: invalid finding status ${record.status}`);
  validateHistory(record, FINDING_STATES, FINDING_TRANSITIONS, errors);
}

function validateWorkPackage(record, errors) {
  requireFields(record, [
    "id", "title", "status", "wave", "change_class", "risk", "lane", "base_commit",
    "version_decision", "news_decision",
  ], errors);
  for (const field of [
    "depends_on", "integration_dependencies", "owned_paths", "shared_write_paths", "findings",
    "contracts", "validation_commands", "residual_risks", "evidence", "commits",
  ]) requireArray(record, field, errors);
  if (!/^AM-W\d+-\d{2}$/u.test(record.id ?? "")) errors.push(`${record._file}: invalid work-package id ${record.id}`);
  if (!PACKAGE_STATES.has(record.status)) errors.push(`${record._file}: invalid package status ${record.status}`);
  if (!/^D[0-4]$/u.test(record.change_class ?? "")) errors.push(`${record._file}: invalid change_class ${record.change_class}`);
  if (!/^R[0-4]$/u.test(record.risk ?? "")) errors.push(`${record._file}: invalid risk ${record.risk}`);
  if (!new Set(["feature", "integration"]).has(record.lane)) errors.push(`${record._file}: invalid lane ${record.lane}`);
  if (!Number.isInteger(record.wave) || record.wave < 0) errors.push(`${record._file}: wave must be a non-negative integer`);
  if (!COMMIT_PATTERN.test(record.base_commit ?? "")) errors.push(`${record._file}: invalid base_commit`);
  validateHistory(record, PACKAGE_STATES, PACKAGE_TRANSITIONS, errors);
  if (["ready", "active", "verifying", "implemented"].includes(record.status) && record.validation_commands.length === 0) {
    errors.push(`${record._file}: ${record.status} package requires validation_commands`);
  }
  if (["verifying", "implemented"].includes(record.status) && record.evidence.length === 0) {
    errors.push(`${record._file}: ${record.status} package requires evidence`);
  }
  if (record.status === "implemented" && record.commits.length === 0) {
    errors.push(`${record._file}: implemented package requires at least one commit`);
  }
}

function validateDecision(record, errors) {
  requireFields(record, ["id", "title", "status", "decided_at", "decision", "rationale"], errors);
  requireArray(record, "consequences", errors, { nonEmpty: true });
  if (!/^AM-D-\d{4}$/u.test(record.id ?? "")) errors.push(`${record._file}: invalid decision id ${record.id}`);
  if (!new Set(["proposed", "accepted", "superseded"]).has(record.status)) {
    errors.push(`${record._file}: invalid decision status ${record.status}`);
  }
  if (!DATE_PATTERN.test(record.decided_at ?? "")) errors.push(`${record._file}: invalid decided_at`);
}

function validateEvidence(record, errors) {
  requireFields(record, ["id", "work_package_id", "status", "platform", "source_commit", "recorded_at"], errors);
  requireArray(record, "commands", errors, { nonEmpty: true });
  requireArray(record, "unrun_checks", errors);
  if (!/^AM-E-\d{4}$/u.test(record.id ?? "")) errors.push(`${record._file}: invalid evidence id ${record.id}`);
  if (!new Set(["partial", "passed", "failed"]).has(record.status)) errors.push(`${record._file}: invalid evidence status ${record.status}`);
  if (!COMMIT_PATTERN.test(record.source_commit ?? "")) errors.push(`${record._file}: invalid source_commit`);
  if (!DATE_PATTERN.test(record.recorded_at ?? "")) errors.push(`${record._file}: invalid recorded_at`);
  for (const [index, command] of (record.commands ?? []).entries()) {
    if (command == null || typeof command !== "object" || Array.isArray(command)) {
      errors.push(`${record._file}: commands[${index}] must be an object`);
      continue;
    }
    if (typeof command.command !== "string" || command.command === "") errors.push(`${record._file}: commands[${index}] requires command`);
    if (!new Set(["passed", "failed", "not_run"]).has(command.result)) errors.push(`${record._file}: commands[${index}] has invalid result`);
  }
}

function checkReferences({ root, program, findings, packages, decisions, evidence }, errors) {
  const findingIds = new Set(findings.map(({ id }) => id));
  const packageIds = new Set(packages.map(({ id }) => id));
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  for (const id of program.active_work_packages ?? []) {
    const workPackage = packages.find((candidate) => candidate.id === id);
    if (workPackage == null) errors.push(`${program._file}: unknown active work package ${id}`);
    else if (workPackage.status !== "active") errors.push(`${program._file}: ${id} is listed active but has status ${workPackage.status}`);
  }
  const activeIds = packages.filter(({ status }) => status === "active").map(({ id }) => id).sort();
  const declaredActive = [...(program.active_work_packages ?? [])].sort();
  if (JSON.stringify(activeIds) !== JSON.stringify(declaredActive)) {
    errors.push(`${program._file}: active_work_packages does not match active package records`);
  }
  for (const workPackage of packages) {
    for (const dependency of [...workPackage.depends_on, ...workPackage.integration_dependencies]) {
      if (!packageIds.has(dependency)) errors.push(`${workPackage._file}: unknown dependency ${dependency}`);
      if (dependency === workPackage.id) errors.push(`${workPackage._file}: package cannot depend on itself`);
    }
    for (const finding of [...workPackage.findings, ...workPackage.residual_risks]) {
      if (!findingIds.has(finding)) errors.push(`${workPackage._file}: unknown finding ${finding}`);
    }
    for (const evidenceId of workPackage.evidence) {
      if (!evidenceIds.has(evidenceId)) errors.push(`${workPackage._file}: unknown evidence ${evidenceId}`);
    }
    for (const contract of workPackage.contracts) {
      if (!fs.existsSync(path.join(root, contract))) errors.push(`${workPackage._file}: contract path does not exist: ${contract}`);
    }
    if (["ready", "active", "verifying", "implemented"].includes(workPackage.status)) {
      for (const dependency of workPackage.depends_on) {
        const owner = packages.find(({ id }) => id === dependency);
        if (owner != null && owner.status !== "implemented") {
          errors.push(`${workPackage._file}: ${workPackage.status} package depends on non-implemented ${dependency}`);
        }
      }
    }
  }
  for (const finding of findings) {
    const disposition = packages.find(({ id }) => id === finding.disposition_work_package);
    if (disposition == null) errors.push(`${finding._file}: unknown disposition package ${finding.disposition_work_package}`);
    else if (!disposition.findings.includes(finding.id) && !(finding.related_work_packages ?? []).includes(disposition.id)) {
      errors.push(`${finding._file}: disposition package ${disposition.id} does not list ${finding.id}`);
    }
    for (const related of finding.related_work_packages ?? []) {
      if (!packageIds.has(related)) errors.push(`${finding._file}: unknown related package ${related}`);
    }
    if (finding.target_wave < program.current_wave && !["resolved", "deferred", "needs_authorization"].includes(finding.status)) {
      errors.push(`${finding._file}: finding is overdue for wave ${finding.target_wave}`);
    }
    if (finding.status === "resolved" && finding.commits.length === 0) {
      errors.push(`${finding._file}: resolved finding requires at least one commit`);
    }
  }
  for (const record of evidence) {
    if (!packageIds.has(record.work_package_id)) errors.push(`${record._file}: unknown work_package_id ${record.work_package_id}`);
  }
  for (const workPackage of packages.filter(({ status }) => status === "implemented")) {
    const blocking = workPackage.findings
      .map((id) => findings.find((finding) => finding.id === id))
      .filter((finding) => finding != null && ["critical", "high"].includes(finding.severity) && finding.status !== "resolved");
    if (blocking.length > 0) {
      errors.push(`${workPackage._file}: implemented package retains blocking findings ${blocking.map(({ id }) => id).join(", ")}`);
    }
  }
  const ratchet = decisions.find(({ id }) => id === "AM-D-0001");
  if (ratchet == null || ratchet.line_budget == null) errors.push(`AM-D-0001 line-budget decision is required`);
  else validateRatchetReferences(ratchet, { program, findingIds, packageIds }, errors);
}

function validateRatchetReferences(decision, { program, findingIds, packageIds }, errors) {
  const config = decision.line_budget;
  for (const field of ["production_roots", "production_extensions", "generated_segments", "test_segments", "exceptions"]) {
    if (!Array.isArray(config[field])) errors.push(`${decision._file}: line_budget.${field} must be an array`);
  }
  for (const field of ["production_suggested_lines", "production_hard_lines", "test_hard_lines"]) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) errors.push(`${decision._file}: line_budget.${field} must be positive`);
  }
  const paths = new Set();
  for (const exception of config.exceptions ?? []) {
    if (paths.has(exception.path)) errors.push(`${decision._file}: duplicate line-budget exception ${exception.path}`);
    paths.add(exception.path);
    if (!findingIds.has(exception.finding)) errors.push(`${decision._file}: exception ${exception.path} has unknown finding ${exception.finding}`);
    if (!packageIds.has(exception.removal_work_package)) errors.push(`${decision._file}: exception ${exception.path} has unknown removal package ${exception.removal_work_package}`);
    if (!Number.isInteger(exception.max_lines) || !Number.isInteger(exception.target_lines) || exception.target_lines >= exception.max_lines) {
      errors.push(`${decision._file}: exception ${exception.path} requires integer target_lines below max_lines`);
    }
    if (!Number.isInteger(exception.expires_wave) || exception.expires_wave < program.current_wave) {
      errors.push(`${decision._file}: exception ${exception.path} expired in wave ${exception.expires_wave}`);
    }
  }
}

function validateDependencyCycles(packages, errors) {
  const byId = new Map(packages.map((workPackage) => [workPackage.id, workPackage]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      errors.push(`work-package dependency cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      if (byId.has(dependency)) visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id, []);
}

function patternRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

export function pathMatchesPattern(file, pattern) {
  return patternRegex(normalizePath(pattern)).test(normalizePath(file));
}

function staticPrefix(pattern) {
  const normalized = normalizePath(pattern);
  const wildcard = normalized.search(/[?*]/u);
  return wildcard === -1 ? normalized : normalized.slice(0, wildcard);
}

function patternsMayOverlap(left, right) {
  if (left === "**" || right === "**") return true;
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function enumerateFiles(directory, root = directory) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "target"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...enumerateFiles(entryPath, root));
    else if (entry.isFile()) output.push(normalizePath(path.relative(root, entryPath)));
  }
  return output;
}

export function checkOverlap(packages, { root = process.cwd(), workPackageId = null, changed = [] } = {}) {
  const candidates = workPackageId == null
    ? packages.filter(({ status }) => status === "active")
    : packages.filter(({ id, status }) => id === workPackageId || status === "active");
  const target = workPackageId == null ? null : packages.find(({ id }) => id === workPackageId);
  const files = enumerateFiles(root);
  const collisions = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (left.id === right.id) continue;
      const witnesses = files.filter((file) =>
        left.owned_paths.some((pattern) => pathMatchesPattern(file, pattern)) &&
        right.owned_paths.some((pattern) => pathMatchesPattern(file, pattern))
      );
      const declared = [];
      for (const leftPattern of left.owned_paths) {
        for (const rightPattern of right.owned_paths) {
          if (patternsMayOverlap(leftPattern, rightPattern)) declared.push(`${leftPattern} <-> ${rightPattern}`);
        }
      }
      if (witnesses.length > 0 || declared.length > 0) {
        collisions.push({
          packages: [left.id, right.id].sort(),
          patterns: [...new Set(declared)].sort(),
          files: [...new Set(witnesses)].sort().slice(0, 20),
        });
      }
    }
  }
  const undeclared = [];
  const integrationWrites = [];
  if (target != null) {
    for (const file of changed.map(normalizePath).sort()) {
      if (target.owned_paths.some((pattern) => pathMatchesPattern(file, pattern))) continue;
      if (target.shared_write_paths.some((pattern) => pathMatchesPattern(file, pattern))) {
        integrationWrites.push(file);
      } else undeclared.push(file);
    }
  }
  return {
    work_package: workPackageId,
    collisions: collisions.sort((left, right) => left.packages.join().localeCompare(right.packages.join())),
    undeclared_paths: undeclared,
    integration_lane_paths: integrationWrites,
  };
}

function sourceFiles(root, config) {
  const files = [];
  for (const declaredRoot of config.production_roots) {
    const absoluteRoot = path.join(root, declaredRoot);
    for (const file of enumerateFiles(absoluteRoot, root)) {
      if (!config.production_extensions.includes(path.extname(file))) continue;
      const searchable = `/${normalizePath(file)}`;
      if (config.generated_segments.some((segment) => searchable.includes(segment))) continue;
      files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

export function countLines(text) {
  if (text === "") return 0;
  const count = text.split("\n").length;
  return text.endsWith("\n") ? count - 1 : count;
}

export function checkLineBudget(root, config) {
  const exceptions = new Map(config.exceptions.map((exception) => [normalizePath(exception.path), exception]));
  const failures = [];
  const warnings = [];
  const measurements = [];
  for (const file of sourceFiles(root, config)) {
    const lines = countLines(fs.readFileSync(path.join(root, file), "utf8"));
    const isTest = config.test_segments.some((segment) => `/${file}`.includes(segment));
    const exception = exceptions.get(file);
    const hardLimit = isTest ? config.test_hard_lines : config.production_hard_lines;
    measurements.push({ path: file, lines, kind: isTest ? "test" : "production" });
    if (exception != null) {
      if (lines > exception.max_lines) failures.push(`${file}: ${lines} lines exceeds ratchet ceiling ${exception.max_lines}`);
      continue;
    }
    if (lines > hardLimit) failures.push(`${file}: ${lines} lines exceeds hard limit ${hardLimit} without an exception`);
    else if (!isTest && lines > config.production_suggested_lines) {
      warnings.push(`${file}: ${lines} lines exceeds suggested limit ${config.production_suggested_lines}`);
    }
  }
  for (const [file] of exceptions) {
    if (!fs.existsSync(path.join(root, file))) warnings.push(`${file}: exception can be removed because the file no longer exists`);
  }
  return { failures: failures.sort(), warnings: warnings.sort(), measurements };
}

export function validateProgram(records, { root = process.cwd(), lineBudget = true } = {}) {
  const errors = [];
  const warnings = [];
  const ids = new Map();
  for (const record of records) {
    if (!RECORD_TYPES.has(record.record_type)) {
      errors.push(`${record._file}: unknown record_type ${record.record_type}`);
      continue;
    }
    if (record.schema_version !== 1) errors.push(`${record._file}: unsupported schema_version ${record.schema_version}`);
    const id = record.record_type === "program" ? record.program_id : record.id;
    if (typeof id !== "string" || id === "") errors.push(`${record._file}: record ID is missing`);
    else if (ids.has(id)) errors.push(`${record._file}: duplicate record ID ${id} also in ${ids.get(id)}`);
    else ids.set(id, record._file);
    if (record.record_type !== "program" && path.basename(record._file, ".md") !== id) {
      errors.push(`${record._file}: filename must match record ID ${id}`);
    }
    if (record.record_type === "finding") validateFinding(record, errors);
    else if (record.record_type === "work_package") validateWorkPackage(record, errors);
    else if (record.record_type === "decision") validateDecision(record, errors);
    else if (record.record_type === "evidence") validateEvidence(record, errors);
  }
  const programs = records.filter(({ record_type }) => record_type === "program");
  if (programs.length !== 1) errors.push(`exactly one program record is required; found ${programs.length}`);
  const program = programs[0];
  if (program != null) {
    requireFields(program, [
      "program_id", "status", "current_wave", "authorized_at", "authorized_by",
      "authorization_source", "integration_lane", "base_commit",
    ], errors);
    requireArray(program, "active_work_packages", errors);
    if (program.program_id !== "AM-2026") errors.push(`${program._file}: unexpected program_id ${program.program_id}`);
    if (program.status !== "active") errors.push(`${program._file}: program must remain active until final acceptance`);
    if (!Number.isInteger(program.current_wave) || program.current_wave < 0) errors.push(`${program._file}: invalid current_wave`);
    if (!DATE_PATTERN.test(program.authorized_at ?? "")) errors.push(`${program._file}: invalid authorized_at`);
    if (!COMMIT_PATTERN.test(program.base_commit ?? "")) errors.push(`${program._file}: invalid base_commit`);
  }
  const context = {
    root,
    program,
    findings: records.filter(({ record_type }) => record_type === "finding").sort((a, b) => a.id.localeCompare(b.id)),
    packages: records.filter(({ record_type }) => record_type === "work_package").sort((a, b) => a.id.localeCompare(b.id)),
    decisions: records.filter(({ record_type }) => record_type === "decision").sort((a, b) => a.id.localeCompare(b.id)),
    evidence: records.filter(({ record_type }) => record_type === "evidence").sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (program != null) {
    checkReferences(context, errors);
    validateDependencyCycles(context.packages, errors);
    const overlap = checkOverlap(context.packages, { root });
    for (const collision of overlap.collisions) {
      errors.push(`active ownership overlap ${collision.packages.join(" / ")}: ${collision.patterns[0] ?? collision.files[0]}`);
    }
    if (lineBudget) {
      const ratchet = context.decisions.find(({ id }) => id === "AM-D-0001");
      if (ratchet?.line_budget != null) {
        const result = checkLineBudget(root, ratchet.line_budget);
        errors.push(...result.failures);
        warnings.push(...result.warnings);
      }
    }
  }
  if (errors.length > 0) throw new ProgramValidationError(errors.sort());
  return { ...context, warnings: warnings.sort() };
}

function tally(records, field) {
  const counts = {};
  for (const record of records) counts[record[field]] = (counts[record[field]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function statusPayload(context) {
  return {
    program: {
      id: context.program.program_id,
      status: context.program.status,
      current_wave: context.program.current_wave,
      base_commit: context.program.base_commit,
      active_work_packages: [...context.program.active_work_packages].sort(),
    },
    summary: {
      findings: context.findings.length,
      finding_statuses: tally(context.findings, "status"),
      work_packages: context.packages.length,
      work_package_statuses: tally(context.packages, "status"),
      evidence_records: context.evidence.length,
    },
    findings: context.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      status: finding.status,
      target_wave: finding.target_wave,
      disposition_work_package: finding.disposition_work_package,
    })),
    work_packages: context.packages.map((workPackage) => ({
      id: workPackage.id,
      wave: workPackage.wave,
      status: workPackage.status,
      lane: workPackage.lane,
      depends_on: [...workPackage.depends_on].sort(),
    })),
    warnings: [...context.warnings],
  };
}

export function nextPayload(context) {
  const implemented = new Set(context.packages.filter(({ status }) => status === "implemented").map(({ id }) => id));
  const eligible = context.packages
    .filter(({ status, depends_on }) => status === "proposed" && depends_on.every((dependency) => implemented.has(dependency)))
    .map(({ id }) => id)
    .sort();
  return {
    active: context.packages.filter(({ status }) => status === "active").map(({ id }) => id).sort(),
    verifying: context.packages.filter(({ status }) => status === "verifying").map(({ id }) => id).sort(),
    ready: context.packages.filter(({ status }) => status === "ready").map(({ id }) => id).sort(),
    eligible_for_ready: eligible,
  };
}

function humanStatus(payload) {
  const lines = [
    `${payload.program.id} | ${payload.program.status} | wave ${payload.program.current_wave}`,
    `Active: ${payload.program.active_work_packages.join(", ") || "none"}`,
    `Findings: ${payload.summary.findings} (${Object.entries(payload.summary.finding_statuses).map(([key, value]) => `${key}=${value}`).join(", ")})`,
    `Work packages: ${payload.summary.work_packages} (${Object.entries(payload.summary.work_package_statuses).map(([key, value]) => `${key}=${value}`).join(", ")})`,
  ];
  if (payload.warnings.length > 0) lines.push(`Warnings: ${payload.warnings.length}`);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const command = argv[0] ?? "status";
  const options = { root: process.cwd(), json: false, output: null, workPackageId: null, changed: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--root") options.root = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--work-package") options.workPackageId = argv[++index];
    else if (argument === "--changed") options.changed.push(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { command, options };
}

function emit(value, options, human = null) {
  const output = options.json || human == null ? `${JSON.stringify(value, null, 2)}\n` : human(value);
  if (options.output != null) {
    const destination = path.resolve(options.root, options.output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, output);
  }
  process.stdout.write(output);
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const records = loadProgram(options.root);
  const context = validateProgram(records, { root: options.root });
  if (command === "validate") {
    emit({
      valid: true,
      records: records.length,
      findings: context.findings.length,
      work_packages: context.packages.length,
      warnings: context.warnings,
    }, options, (value) => `Architecture program valid: ${value.records} records, ${value.findings} findings, ${value.work_packages} work packages, ${value.warnings.length} warnings\n`);
  } else if (command === "status") emit(statusPayload(context), options, humanStatus);
  else if (command === "next") emit(nextPayload(context), options);
  else if (command === "overlap") {
    const result = checkOverlap(context.packages, {
      root: options.root,
      workPackageId: options.workPackageId,
      changed: options.changed,
    });
    emit(result, options);
    if (result.collisions.length > 0 || result.undeclared_paths.length > 0) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
