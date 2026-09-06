// Acceptance-only relay. Authentication stays with the installed serverctl.
// No remote command or scheduler result is mocked. Not a production provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
assert.equal(args[0], "-T");
assert.ok(separator > 0);
assert.equal(args.length, separator + 3);
assert.equal(args[separator + 1], process.env.RHO_ACCEPTANCE_HOST);
for (const required of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ControlPath=none"])
  assert.ok(args.includes(required), `missing OpenSSH option ${required}`);
const command = args.at(-1);
const discard = process.env.RHO_ACCEPTANCE_DROP_RECEIPT;
if (discard) assert.ok(command.includes("sbatch"), "fault injection only applies to the test submission");

const child = spawn(process.env.RHO_ACCEPTANCE_SERVERCTL, [
  "exec", args[separator + 1], "--stdin-binary", "--reuse", "300", "--timeout", "30",
  "--", "sh", "-c", command,
], {
  // Otherwise serverctl's own OpenSSH lookup would recurse into this relay.
  env: { ...process.env, PATH: process.env.RHO_ACCEPTANCE_BASE_PATH },
  stdio: ["pipe", "pipe", "inherit"],
});
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 255; });
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
const receipt = [];
let size = 0;
if (discard) child.stdout.on("data", (data) => {
  size += data.length;
  if (size <= 4096) receipt.push(data);
});
else child.stdout.pipe(process.stdout);
child.on("close", (code) => {
  if (discard && code === 0) {
    process.exitCode = 255; // Real submission happened, but Rho loses the receipt.
    try {
      assert.ok(size <= 4096, "submission receipt exceeded its test bound");
      fs.writeFileSync(discard, Buffer.concat(receipt), { flag: "wx", mode: 0o600 });
    } catch (error) { process.stderr.write(`receipt preservation failed: ${error.message}\n`); }
  } else {
    // Reserved client failures overlap remote codes; preserve uncertainty.
    process.exitCode = code === null || [2, 124, 127, 255].includes(code) ? 255 : code;
  }
});
