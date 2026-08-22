import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repositoryRoot, "desktop");
const viteBinary = join(
  desktopRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite",
);
const viteConfig = join(desktopRoot, "ui", "vite.config.mts");
const temporaryRoot = mkdtempSync(join(tmpdir(), "rho-rsr-assets-"));

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
    })
    .sort();
}

function inventory(root) {
  return Object.fromEntries(
    filesUnder(root).map((path) => {
      const bytes = readFileSync(join(root, path));
      return [
        path.replaceAll("\\", "/"),
        { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      ];
    }),
  );
}

function build(output) {
  execFileSync(viteBinary, ["build", "--config", viteConfig, "--outDir", output], {
    cwd: desktopRoot,
    stdio: "pipe",
  });
}

try {
  const first = join(temporaryRoot, "first");
  const second = join(temporaryRoot, "second");
  build(first);
  build(second);
  const firstInventory = inventory(first);
  const secondInventory = inventory(second);
  if (JSON.stringify(firstInventory) !== JSON.stringify(secondInventory)) {
    throw new Error("RSR production assets are not byte-for-byte deterministic");
  }
  if (!("index.html" in firstInventory) || !("asset-manifest.json" in firstInventory)) {
    throw new Error("RSR asset inventory is missing index.html or asset-manifest.json");
  }
  for (const path of Object.keys(firstInventory)) {
    if (path.endsWith(".map") || path.startsWith("/") || path.includes("..")) {
      throw new Error(`Unsafe generated asset path: ${path}`);
    }
    const metadata = statSync(join(first, path));
    if (!metadata.isFile()) throw new Error(`Generated asset is not a file: ${path}`);
    if (path.endsWith(".html") || path.endsWith(".css")) {
      const source = readFileSync(join(first, path), "utf8");
      if (/(?:src|href)=["'](?:https?:)?\/\//i.test(source) || /url\(\s*["']?(?:https?:)?\/\//i.test(source)) {
        throw new Error(`Generated asset loads a network resource: ${path}`);
      }
    }
    if (path.endsWith(".js")) {
      const source = readFileSync(join(first, path), "utf8");
      if (/\b(?:fetch|import)\(\s*["']https?:\/\//i.test(source)) {
        throw new Error(`Generated JavaScript loads a network module or resource: ${path}`);
      }
    }
  }
  process.stdout.write(`${JSON.stringify(firstInventory, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
