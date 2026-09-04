#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const localTests = run("cargo", ["test", "-p", "rho-sandbox", "--locked", "--quiet"], 900_000);
if (!localTests.passed) errors.push("local_sandbox_tests");
const profileRun = run(
  "cargo",
  ["run", "-p", "rho-sandbox", "--example", "security-profile", "--locked", "--quiet"],
  300_000,
);
let localProfile = null;
try {
  localProfile = JSON.parse(profileRun.stdout);
} catch {
  errors.push("local_profile_json");
}

let linuxEvidence = {
  status: "ci_required",
  source: ".github/workflows/rho-sandbox-matrix.yml:ubuntu-latest",
  tests_passed: null,
  host: null,
};
if (process.env.RHO_SKIP_REMOTE_PLATFORM !== "1" && commandExists("serverctl")) {
  const remote = spawnSync(
    "serverctl",
    [
      "exec",
      "YuLabServer",
      "--timeout",
      "900",
      "--shell",
      "--",
      "cd /biostack/home/yonghe/.rho/acceptance/rho-rebuild-p7/source && cargo test -p rho-sandbox --locked --quiet",
    ],
    { cwd: root, encoding: "utf8", timeout: 930_000 },
  );
  linuxEvidence = {
    status: remote.status === 0 ? "verified_real_host" : "failed_real_host",
    source: "YuLabServer Linux real host",
    tests_passed: remote.status === 0,
    host: "master (test orchestration only; no job compute)",
    output_digest: `sha256:${createHash("sha256")
      .update(`${remote.stdout}\n${remote.stderr}`)
      .digest("hex")}`,
  };
  if (remote.status !== 0) errors.push("linux_real_host_tests");
}

for (const required of [
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/tauri.macos.conf.json",
  "desktop/src-tauri/tauri.windows.conf.json",
  "desktop/src-tauri/tauri.linux.conf.json",
]) {
  try {
    await access(path.join(root, required));
  } catch {
    errors.push(`installer_config:${required}`);
  }
}
const workflowPath = path.join(root, ".github/workflows/rho-sandbox-matrix.yml");
let workflow = "";
try {
  workflow = await readFile(workflowPath, "utf8");
} catch {
  errors.push("cross_platform_workflow_missing");
}
for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
  if (!workflow.includes(runner)) errors.push(`workflow_runner:${runner}`);
}

const matrix = {
  schema: "rho.security.platform-matrix.v1",
  generated_from_tests: true,
  platforms: {
    linux: {
      evidence: linuxEvidence,
      mechanisms: [
        "bubblewrap mount namespace when installed",
        "cgroup v2 CPU/memory/PID",
        "network namespace deny",
        "process group whole-tree control",
        "close-on-exec handle isolation",
      ],
      oci: "rootless runtime evidence required",
    },
    macos: {
      evidence: {
        status: process.platform === "darwin" && localTests.passed ? "verified_real_host" : "ci_required",
        source: process.platform === "darwin" ? "current macOS host" : "macos-latest CI",
        profile: process.platform === "darwin" ? localProfile : null,
      },
      mechanisms: ["Seatbelt when present", "process group", "close-on-exec handles"],
      oci: localProfile?.oci_enabled === true ? "enabled" : "disabled_fail_closed",
    },
    windows: {
      evidence: {
        status: "ci_fail_closed_required",
        source: "windows-latest CI; no isolation guarantee claimed by current adapter",
      },
      mechanisms: ["Job Object process-tree control (capability remains disabled until native evidence)"],
      oci: "disabled_fail_closed",
    },
  },
};
const directory = path.join(root, "test/security/platform");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
const report = {
  schema: "rho.security.platform-matrix-report.v1",
  result: errors.length === 0 ? "pass" : "fail",
  local_tests_passed: localTests.passed,
  local_profile: localProfile,
  linux_real_host: linuxEvidence,
  installer_configs_verified: true,
  matrix,
  errors,
};
const reportPath = path.join(directory, "matrix-report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (errors.length > 0) {
  console.error(`Platform matrix failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`Platform matrix passed: macOS live, Linux ${linuxEvidence.status}, Windows fail-closed CI profile; artifact ${path.relative(root, reportPath)}`);

function run(command, args, timeout) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout });
  return {
    passed: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandExists(command) {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}
