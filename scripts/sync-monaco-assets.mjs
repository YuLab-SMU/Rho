import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(repoRoot, "desktop", "node_modules", "monaco-editor", "min", "vs");
const targetDir = path.join(repoRoot, "desktop", "dist", "vendor", "monaco", "vs");

if (!fs.existsSync(sourceDir)) {
  console.error(`Monaco source directory was not found: ${sourceDir}`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Synced Monaco assets to ${targetDir}`);
