import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runningRhoDesktopProcesses,
  sameCheckoutDebugBinaries,
  stopExactDebugProcesses,
} from "./rsr-process-identity.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repositoryRoot, "desktop");
const binary = join(repositoryRoot, "target", "debug", process.platform === "win32" ? "rho-desktop.exe" : "rho-desktop");
const developmentBinaries = sameCheckoutDebugBinaries(binary);

const launcherArgs = process.argv.slice(2);
const noRestart = launcherArgs.includes("--no-restart");
const childArgs = launcherArgs.filter((argument) => argument !== "--no-restart");
const listProcesses = () => runningRhoDesktopProcesses(binary, developmentBinaries);
const running = listProcesses();
if (noRestart && running.length > 0) {
  throw new Error([
    "Rho is already running and --no-restart was requested.",
    ...running.map((process) => `${process.pid} ${process.command}`),
    "Quit those windows or run npm run rsr:dev:desktop without --no-restart.",
  ].join("\n"));
}
if (!noRestart && running.length > 0) {
  process.stdout.write(`Restarting ${running.length} existing Rho development process${running.length === 1 ? "" : "es"}…\n`);
  const stopped = await stopExactDebugProcesses({ listProcesses });
  process.stdout.write(stopped.length === 0
    ? "The existing Rho development process exited before restart. Building the current checkout…\n"
    : `Stopped Rho development process${stopped.length === 1 ? "" : "es"} ${stopped.join(", ")}. Building the current checkout…\n`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error != null) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "rsr:build"], desktopRoot);
run("cargo", ["build", "--manifest-path", join(desktopRoot, "src-tauri", "Cargo.toml"), "--bin", "rho-desktop"], repositoryRoot);
run(process.execPath, [join(repositoryRoot, "scripts", "accept-rsr-exact-app.mjs")], repositoryRoot);

const child = spawn(binary, childArgs, {
  cwd: repositoryRoot,
  detached: true,
  stdio: "ignore",
});
child.unref();
process.stdout.write(`Started Rho development binary ${binary} (pid ${child.pid}). The Rho menu shows its frontend build identity.\n`);
