import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
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

export function checkOverlap(
  packages,
  { root = process.cwd(), workPackageId = null, changed = [], baseCommit = null } = {},
) {
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
  const forbiddenSharedWrites = [];
  if (target != null) {
    for (const file of changed.map(normalizePath).sort()) {
      if (target.owned_paths.some((pattern) => pathMatchesPattern(file, pattern))) continue;
      if (target.shared_write_paths.some((pattern) => pathMatchesPattern(file, pattern))) {
        if (target.lane === "integration") integrationWrites.push(file);
        else forbiddenSharedWrites.push(file);
      } else undeclared.push(file);
    }
  }
  const baseMismatch = target != null && baseCommit != null && target.base_commit !== baseCommit
    ? { declared: target.base_commit, actual: baseCommit }
    : null;
  return {
    work_package: workPackageId,
    registered_base_commit: target?.base_commit ?? null,
    base_mismatch: baseMismatch,
    unknown_work_package: workPackageId != null && target == null,
    collisions: collisions.sort((left, right) => left.packages.join().localeCompare(right.packages.join())),
    undeclared_paths: undeclared,
    integration_lane_paths: integrationWrites,
    forbidden_shared_paths: forbiddenSharedWrites,
  };
}
