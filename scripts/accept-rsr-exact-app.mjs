import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  runningRhoDesktopProcesses,
  sameCheckoutDebugBinaries,
} from "./rsr-process-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "target", "debug", "rho-desktop");
const manifestPath = path.join(root, "desktop", "dist", "asset-manifest.json");
const buildIdentityPath = path.join(root, "desktop", "dist", "build-identity.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const buildIdentity = JSON.parse(readFileSync(buildIdentityPath, "utf8"));
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
if (typeof buildIdentity.build_id !== "string" || !/^[a-f0-9]{12}$/u.test(buildIdentity.build_id)) {
  throw new Error("desktop/dist has no valid deterministic frontend build identity");
}

const running = runningRhoDesktopProcesses(binary, sameCheckoutDebugBinaries(binary));
if (running.length > 0) {
  throw new Error([
    "Rho is already running, so this checker cannot prove which process owns the visible window.",
    ...running.map((process) => `${process.pid} ${process.command}`),
    "Quit the listed Rho process and run the exact-app check again.",
  ].join("\n"));
}

console.log(JSON.stringify({
  executable: binary,
  bytes: metadata.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  frontend_entry: frontendEntry,
  frontend_build_id: buildIdentity.build_id,
  identity: "binary-and-frontend-only",
}, null, 2));
