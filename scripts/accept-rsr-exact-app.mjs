import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "target", "debug", "rho-desktop");
const manifestPath = path.join(root, "desktop", "dist", "asset-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const frontendEntry = manifest["index.html"]?.file;
if (typeof frontendEntry !== "string" || frontendEntry.length === 0) {
  throw new Error("desktop/dist has no generated frontend entry");
}

const metadata = statSync(binary);
if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
  throw new Error(`${binary} is not an executable file`);
}
const bytes = readFileSync(binary);
if (!bytes.includes(Buffer.from(frontendEntry))) {
  throw new Error(`the exact debug binary does not embed ${frontendEntry}; rebuild rho-desktop`);
}

if (process.platform === "darwin") {
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const foreign = processes.split("\n").map((line) => line.trim()).filter((line) => {
    if (!line || line.includes("accept-rsr-exact-app")) return false;
    const command = line.replace(/^\d+\s+/, "");
    return /\/rho-desktop(?:\s|$)/.test(command) && !command.startsWith(binary);
  });
  if (foreign.length > 0) {
    throw new Error(`another Rho desktop can steal the org.yulab.rho window identity:\n${foreign.join("\n")}`);
  }
}

console.log(JSON.stringify({
  executable: binary,
  bytes: metadata.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  frontend_entry: frontendEntry,
  identity: "exact",
}, null, 2));
