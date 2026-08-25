#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CATEGORIES = new Map([
  ["added", "Added"],
  ["improved", "Improved"],
  ["fixed", "Fixed"],
]);
const EXPECTED_FIELDS = new Set([
  "schema_version",
  "record_type",
  "id",
  "work_package_id",
  "category",
  "title",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export class ChangeFragmentError extends Error {
  constructor(errors) {
    super(`Change fragment validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ChangeFragmentError";
    this.errors = errors;
  }
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export function parseFragment(file, root = process.cwd()) {
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/^# ([^\n]+)\n\n```json\n([\s\S]*?)\n```\n\n([\s\S]*\S)\n?$/u);
  if (match == null) {
    throw new Error(`${relative(root, file)}: expected H1, strict JSON metadata and a non-empty Markdown body`);
  }
  let metadata;
  try {
    metadata = JSON.parse(match[2]);
  } catch (error) {
    throw new Error(`${relative(root, file)}: invalid JSON metadata: ${error.message}`);
  }
  if (metadata == null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new Error(`${relative(root, file)}: JSON metadata must be an object`);
  }
  return {
    ...metadata,
    heading: match[1],
    body: match[3].trim(),
    file: relative(root, file),
  };
}

function fragmentFiles(root) {
  const directory = path.join(root, ".changes");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function validateOne(fragment, root, errors) {
  const label = fragment.file;
  for (const field of Object.keys(fragment).filter((field) => !["heading", "body", "file"].includes(field))) {
    if (!EXPECTED_FIELDS.has(field)) errors.push(`${label}: unknown metadata field ${field}`);
  }
  for (const field of EXPECTED_FIELDS) {
    if (!Object.hasOwn(fragment, field)) errors.push(`${label}: missing metadata field ${field}`);
  }
  if (fragment.schema_version !== 1) errors.push(`${label}: schema_version must be 1`);
  if (fragment.record_type !== "change_fragment") {
    errors.push(`${label}: record_type must be change_fragment`);
  }
  if (!/^AM-C-\d{4}$/u.test(fragment.id ?? "")) errors.push(`${label}: invalid fragment id ${fragment.id}`);
  if (path.basename(label) !== `${fragment.id}.md`) {
    errors.push(`${label}: filename must be ${fragment.id}.md`);
  }
  if (!/^AM-W\d+-\d{2}$/u.test(fragment.work_package_id ?? "")) {
    errors.push(`${label}: invalid work_package_id ${fragment.work_package_id}`);
  } else {
    const owner = path.join(
      root,
      "docs/architecture/modernization/work-packages",
      `${fragment.work_package_id}.md`,
    );
    if (!fs.existsSync(owner)) errors.push(`${label}: unknown work package ${fragment.work_package_id}`);
  }
  if (!CATEGORIES.has(fragment.category)) errors.push(`${label}: invalid category ${fragment.category}`);
  if (
    typeof fragment.title !== "string" ||
    fragment.title.trim() !== fragment.title ||
    fragment.title.length === 0 ||
    fragment.title.length > 120 ||
    /[\r\n\p{Cc}]/u.test(fragment.title)
  ) errors.push(`${label}: title must be one safe trimmed line of at most 120 characters`);
  if (fragment.heading !== fragment.title) errors.push(`${label}: H1 must exactly match metadata title`);
  if (fragment.body.length === 0 || Buffer.byteLength(fragment.body, "utf8") > 4096) {
    errors.push(`${label}: body must contain at most 4096 UTF-8 bytes`);
  }
}

export function validateFragments(root = process.cwd()) {
  const errors = [];
  const fragments = [];
  for (const file of fragmentFiles(root)) {
    try {
      const fragment = parseFragment(file, root);
      validateOne(fragment, root, errors);
      fragments.push(fragment);
    } catch (error) {
      errors.push(error.message);
    }
  }
  const ids = new Map();
  for (const fragment of fragments) {
    const previous = ids.get(fragment.id);
    if (previous != null) errors.push(`${fragment.file}: duplicate fragment id ${fragment.id} also used by ${previous}`);
    else ids.set(fragment.id, fragment.file);
  }
  if (errors.length > 0) throw new ChangeFragmentError(errors.sort());
  return fragments.sort((left, right) =>
    [...CATEGORIES.keys()].indexOf(left.category) - [...CATEGORIES.keys()].indexOf(right.category) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

export function renderNewsSection(fragments, { version, date }) {
  if (!VERSION_PATTERN.test(version ?? "")) throw new Error(`Invalid candidate version: ${version}`);
  if (!DATE_PATTERN.test(date ?? "")) throw new Error(`Invalid candidate date: ${date}`);
  const lines = [`## ${version} - ${date}`, ""];
  for (const [category, heading] of CATEGORIES) {
    const group = fragments.filter((fragment) => fragment.category === category);
    if (group.length === 0) continue;
    lines.push(`### ${heading}`, "");
    for (const fragment of group) lines.push(`#### ${fragment.title}`, "", fragment.body, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseArguments(argv) {
  const command = argv[0] ?? "validate";
  const options = { root: process.cwd(), version: null, date: null, output: null };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = path.resolve(argv[++index]);
    else if (argument === "--version") options.version = argv[++index];
    else if (argument === "--date") options.date = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { command, options };
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  const fragments = validateFragments(options.root);
  if (command === "validate") {
    process.stdout.write(`Change fragments valid: ${fragments.length}\n`);
    return;
  }
  if (command !== "compose") throw new Error(`Unknown command: ${command}`);
  const output = renderNewsSection(fragments, options);
  if (options.output == null) process.stdout.write(output);
  else {
    const destination = path.resolve(options.root, options.output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, output);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
