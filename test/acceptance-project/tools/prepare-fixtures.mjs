#!/usr/bin/env node

// Cross-platform visual acceptance fixture generator. This is the Node.js port
// of prepare-manual-fixtures.ps1 and produces an identical fixture set:
// a git-initialized working project, a project with a staged UU merge conflict
// in examples/git-review-demo.txt, a copy under a path with Unicode characters
// and spaces (no git init), a 2100-file large project, and an oversized file
// project containing a sparse 9 MiB file. The output root must not exist when
// the script runs; remove or rename it explicitly before regenerating.
//
// Usage: node prepare-fixtures.mjs [--output <dir>]
// Default output: <repo-root>/test/generated-manual-fixtures (gitignored)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceProject = path.resolve(scriptDir, "..");

// The default matches the ps1: $PSScriptRoot is tools/, so the ps1's
// '..\..\generated-manual-fixtures' resolves to <repo>/test/generated-manual-fixtures,
// which is also the path anchored in the repository .gitignore.
function parseArgs(argv) {
  let outputRoot = path.resolve(
    scriptDir,
    "..",
    "..",
    "generated-manual-fixtures",
  );
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --output <dir>");
      }
      outputRoot = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { outputRoot };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Runs git with execFileSync (no shell). On failure the thrown error carries
// the full stderr, and runGit rethrows with it embedded in the message.
function runGitAllowFailure(repository, gitArguments) {
  try {
    const stdout = execFileSync("git", ["-C", repository, ...gitArguments], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    if (typeof error.status !== "number") {
      // Spawn failure (e.g. git not on PATH) — nothing to recover from here.
      throw error;
    }
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { status: error.status, output };
  }
}

function runGit(repository, gitArguments) {
  const result = runGitAllowFailure(repository, gitArguments);
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArguments.join(" ")} failed in ${repository}: ${result.output}`,
    );
  }
  return result.output;
}

function initializeFixtureRepository(repository) {
  runGit(repository, ["init"]);
  runGit(repository, ["branch", "-M", "main"]);
  runGit(repository, ["config", "user.name", "Rho Acceptance"]);
  runGit(repository, ["config", "user.email", "acceptance@rho.local"]);
  runGit(repository, ["add", "--all"]);
  runGit(repository, ["commit", "-m", "test: acceptance project baseline"]);
}

function expectConflictMerge(repository, branch) {
  const merge = runGitAllowFailure(repository, ["merge", branch]);
  if (merge.status === 0) {
    throw new Error(`Expected merge conflict was not created in ${repository}`);
  }
  const status = runGitAllowFailure(repository, ["status", "--porcelain"]);
  if (
    status.status !== 0 ||
    !status.output.includes("UU examples/git-review-demo.txt")
  ) {
    throw new Error(
      `Merge failed without the expected conflict in ${repository}: ${merge.output}`,
    );
  }
}

function main() {
  const { outputRoot: resolvedRoot } = parseArgs(process.argv.slice(2));
  const resolvedParent = path.dirname(resolvedRoot);

  if (fs.existsSync(resolvedRoot)) {
    fail(
      `Fixture root already exists: ${resolvedRoot}\n` +
        "Remove or rename it explicitly before generating a fresh set.",
    );
  }

  fs.mkdirSync(resolvedParent, { recursive: true });
  fs.mkdirSync(resolvedRoot, { recursive: true });

  const workingProject = path.join(resolvedRoot, "working-project");
  fs.cpSync(sourceProject, workingProject, { recursive: true });
  initializeFixtureRepository(workingProject);

  const conflictProject = path.join(resolvedRoot, "conflict-project");
  fs.cpSync(sourceProject, conflictProject, { recursive: true });
  initializeFixtureRepository(conflictProject);
  const conflictFile = path.join(
    conflictProject,
    "examples",
    "git-review-demo.txt",
  );
  const baselineText = fs.readFileSync(conflictFile, "utf8");
  runGit(conflictProject, ["checkout", "-b", "acceptance-conflict"]);
  fs.writeFileSync(
    conflictFile,
    baselineText.replace(
      "The mitochondrial review threshold is 20 percent.",
      "The branch proposes an 18 percent review threshold.",
    ),
  );
  runGit(conflictProject, ["add", "examples/git-review-demo.txt"]);
  runGit(conflictProject, [
    "commit",
    "-m",
    "test: conflicting threshold proposal",
  ]);
  runGit(conflictProject, ["checkout", "main"]);
  fs.writeFileSync(
    conflictFile,
    baselineText.replace(
      "The mitochondrial review threshold is 20 percent.",
      "The main branch retains a 20 percent review threshold.",
    ),
  );
  runGit(conflictProject, ["add", "examples/git-review-demo.txt"]);
  runGit(conflictProject, ["commit", "-m", "test: retain baseline threshold"]);
  expectConflictMerge(conflictProject, "acceptance-conflict");

  // "路径 含 空格" — built from code points to mirror the ps1 generator.
  const unicodeAndSpaces = [
    String.fromCharCode(0x8def),
    String.fromCharCode(0x5f84),
    " ",
    String.fromCharCode(0x542b),
    " ",
    String.fromCharCode(0x7a7a),
    String.fromCharCode(0x683c),
  ].join("");
  const unicodeProject = path.join(
    resolvedRoot,
    unicodeAndSpaces,
    "acceptance-project",
  );
  fs.mkdirSync(path.dirname(unicodeProject), { recursive: true });
  fs.cpSync(sourceProject, unicodeProject, { recursive: true });

  const largeProject = path.join(resolvedRoot, "large-project-2100");
  fs.mkdirSync(largeProject, { recursive: true });
  fs.writeFileSync(
    path.join(largeProject, "large-project.Rproj"),
    "Version: 1.0\r\nEncoding: UTF-8\r\n",
  );
  for (let index = 1; index <= 2100; index += 1) {
    const fileName = `fixture-${String(index).padStart(4, "0")}.R`;
    fs.writeFileSync(
      path.join(largeProject, fileName),
      `fixture_value <- ${index}\r\n`,
    );
  }

  const oversizedProject = path.join(resolvedRoot, "oversized-file-project");
  fs.mkdirSync(oversizedProject, { recursive: true });
  fs.writeFileSync(
    path.join(oversizedProject, "oversized-file-project.Rproj"),
    "Version: 1.0\r\nEncoding: UTF-8\r\n",
  );
  const largeFilePath = path.join(oversizedProject, "over-8MiB.txt");
  const fd = fs.openSync(largeFilePath, "wx");
  try {
    fs.ftruncateSync(fd, 9 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }

  console.log(`Visual acceptance fixtures created at: ${resolvedRoot}`);
  console.log(`Primary working project: ${workingProject}`);
  console.log(`Conflict project: ${conflictProject}`);
  console.log(`Unicode/spaces project: ${unicodeProject}`);
  console.log(`Large project: ${largeProject}`);
  console.log(`Oversized file project: ${oversizedProject}`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
