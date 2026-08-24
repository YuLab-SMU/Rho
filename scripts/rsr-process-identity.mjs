import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, join, normalize, resolve } from "node:path";

function executableFromCommand(command) {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/u)[0] ?? "";
}

export function sameCheckoutDebugBinaries(expectedBinary, platform = process.platform) {
  const expected = normalize(resolve(expectedBinary));
  if (platform !== "darwin") return [expected];
  return [
    expected,
    normalize(join(
      dirname(expected),
      "bundle",
      "macos",
      "Rho.app",
      "Contents",
      "MacOS",
      basename(expected),
    )),
  ];
}

export function parseRhoDesktopProcesses(
  processListing,
  expectedBinary,
  currentPid = process.pid,
  acceptedBinaries = [expectedBinary],
) {
  const expected = normalize(resolve(expectedBinary));
  const accepted = new Set(acceptedBinaries.map((candidate) => normalize(resolve(candidate))));
  const expectedName = basename(expected).toLowerCase();
  return processListing.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (match == null || Number(match[1]) === currentPid) return [];
    const command = match[2];
    const executable = executableFromCommand(command);
    if (basename(executable).toLowerCase() !== expectedName) return [];
    const resolvedExecutable = normalize(resolve(executable));
    return [{
      pid: Number(match[1]),
      command,
      executable: resolvedExecutable,
      expected: accepted.has(resolvedExecutable),
    }];
  });
}

export function runningRhoDesktopProcesses(
  expectedBinary,
  acceptedBinaries = [expectedBinary],
) {
  if (process.platform === "win32") {
    const script = [
      "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'rho-desktop.exe' }",
      "$items | ForEach-Object { \"$($_.ProcessId) $($_.ExecutablePath)\" }",
    ].join("; ");
    const listing = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    return parseRhoDesktopProcesses(listing, expectedBinary, process.pid, acceptedBinaries);
  }
  const listing = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return parseRhoDesktopProcesses(listing, expectedBinary, process.pid, acceptedBinaries);
}

export function requestNonForceTermination(pid, platform = process.platform) {
  if (platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error != null) throw result.error;
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      throw new Error(detail === ""
        ? `Windows declined the non-force termination request for PID ${pid}.`
        : `Windows declined the non-force termination request for PID ${pid}: ${detail}`);
    }
    return;
  }
  process.kill(pid, "SIGTERM");
}

const defaultWait = (milliseconds) => new Promise((resolveWait) => {
  setTimeout(resolveWait, milliseconds);
});

export async function stopExactDebugProcesses({
  listProcesses,
  signalProcess = requestNonForceTermination,
  wait = defaultWait,
  timeoutMs = 8_000,
  pollIntervalMs = 100,
}) {
  const initial = await listProcesses();
  const foreign = initial.filter((candidate) => !candidate.expected);
  if (foreign.length > 0) {
    throw new Error([
      "Another Rho executable is running outside this checkout. It will not be stopped.",
      ...foreign.map((candidate) => `${candidate.pid} ${candidate.executable}`),
      "Quit that Rho application before starting the exact development build.",
    ].join("\n"));
  }
  const targets = initial.filter((candidate) => candidate.expected);
  for (const target of targets) {
    const current = (await listProcesses()).find((candidate) =>
      candidate.expected && candidate.pid === target.pid
    );
    if (current == null) continue;
    try {
      await signalProcess(target.pid);
    } catch (error) {
      const disappeared = !(await listProcesses()).some((candidate) =>
        candidate.expected && candidate.pid === target.pid
      );
      if (disappeared) continue;
      const detail = error instanceof Error && error.message.trim() !== ""
        ? error.message.trim()
        : "the operating system rejected the request";
      throw new Error(`Could not stop Rho development process ${target.pid}: ${detail}`);
    }
  }

  const targetPids = new Set(targets.map((target) => target.pid));
  const polls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt <= polls; attempt += 1) {
    const remaining = (await listProcesses()).filter((candidate) =>
      candidate.expected && targetPids.has(candidate.pid)
    );
    if (remaining.length === 0) return targets.map((target) => target.pid);
    if (attempt === polls) {
      throw new Error([
        `Rho did not exit within ${timeoutMs} ms after a non-force termination request.`,
        ...remaining.map((candidate) => `${candidate.pid} ${candidate.command}`),
        "No force-kill was attempted. Save and quit that window, then retry.",
      ].join("\n"));
    }
    await wait(pollIntervalMs);
  }
  return [];
}
