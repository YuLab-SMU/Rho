import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(root, candidate);
      if (!entry.isFile()) return [];
      return [relative(root, candidate).replaceAll("\\", "/")];
    })
    .sort();
}

export function buildIdentityInputs(root = repositoryRoot) {
  const desktopRoot = join(root, "desktop");
  const declared = [
    join(desktopRoot, "package.json"),
    join(desktopRoot, "package-lock.json"),
    join(desktopRoot, "ui", "index.html"),
    join(desktopRoot, "ui", "vite.config.mts"),
    join(root, "scripts", "rsr-build-identity.mjs"),
  ];
  const trees = [
    join(desktopRoot, "ui", "src"),
    join(desktopRoot, "legal"),
  ];
  const inputs = declared.filter((candidate) => existsSync(candidate));
  for (const tree of trees) {
    if (!existsSync(tree) || !statSync(tree).isDirectory()) continue;
    inputs.push(...filesUnder(tree).map((path) => join(tree, path)));
  }
  return inputs.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export function computeBuildIdentity(root = repositoryRoot) {
  const hash = createHash("sha256");
  const inputs = buildIdentityInputs(root);
  for (const input of inputs) {
    const name = relative(root, input).replaceAll("\\", "/");
    const bytes = readFileSync(input);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return {
    id: hash.digest("hex").slice(0, 12),
    inputCount: inputs.length,
    inputs: inputs.map((input) => relative(root, input).replaceAll("\\", "/")),
  };
}

export const currentBuildIdentity = computeBuildIdentity(repositoryRoot);
