import { strict as assert } from "node:assert";

import {
  parseRhoDesktopProcesses,
  sameCheckoutDebugBinaries,
  stopExactDebugProcesses,
} from "./rsr-process-identity.mjs";

const expected = "/workspace/Rho/target/debug/rho-desktop";
const processes = parseRhoDesktopProcesses([
  `101 ${expected}`,
  "102 /Applications/Rho.app/Contents/MacOS/rho-desktop --project /tmp/demo",
  "103 /usr/bin/node accept-rsr-exact-app.mjs",
  "104 /tmp/rho-desktop-helper",
].join("\n"), expected, 999);

assert.equal(processes.length, 2);
assert.equal(processes[0]?.expected, true);
assert.equal(processes[1]?.expected, false);
assert.equal(processes[1]?.pid, 102);

const debugBundle = "/workspace/Rho/target/debug/bundle/macos/Rho.app/Contents/MacOS/rho-desktop";
assert.deepEqual(sameCheckoutDebugBinaries(expected, "darwin"), [expected, debugBundle]);
assert.deepEqual(sameCheckoutDebugBinaries(expected, "linux"), [expected]);
const developmentProcesses = parseRhoDesktopProcesses([
  `105 ${expected}`,
  `106 ${debugBundle}`,
  "107 /Applications/Rho.app/Contents/MacOS/rho-desktop",
].join("\n"), expected, 999, sameCheckoutDebugBinaries(expected, "darwin"));
assert.deepEqual(
  developmentProcesses.map((candidate) => [candidate.pid, candidate.expected]),
  [[105, true], [106, true], [107, false]],
);

const owned = (pid) => ({
  pid,
  command: `${expected} --test`,
  executable: expected,
  expected: true,
});
const foreign = (pid) => ({
  pid,
  command: "/Applications/Rho.app/Contents/MacOS/rho-desktop",
  executable: "/Applications/Rho.app/Contents/MacOS/rho-desktop",
  expected: false,
});

{
  let signalled = 0;
  const stopped = await stopExactDebugProcesses({
    listProcesses: () => [],
    signalProcess: () => { signalled += 1; },
    wait: () => Promise.resolve(),
  });
  assert.deepEqual(stopped, []);
  assert.equal(signalled, 0);
}

{
  let live = [owned(201), owned(202)];
  const requested = new Set();
  const stopped = await stopExactDebugProcesses({
    listProcesses: () => live,
    signalProcess: (pid) => { requested.add(pid); },
    wait: async () => { live = live.filter((candidate) => !requested.has(candidate.pid)); },
    timeoutMs: 4,
    pollIntervalMs: 1,
  });
  assert.deepEqual(stopped, [201, 202]);
  assert.deepEqual([...requested], [201, 202]);
}

{
  let listings = 0;
  let signalled = 0;
  const stopped = await stopExactDebugProcesses({
    listProcesses: () => (++listings === 1 ? [owned(203)] : []),
    signalProcess: () => { signalled += 1; },
    wait: () => Promise.resolve(),
  });
  assert.deepEqual(stopped, [203]);
  assert.equal(signalled, 0);
}

{
  let signalled = 0;
  await assert.rejects(
    stopExactDebugProcesses({
      listProcesses: () => [owned(204), foreign(205)],
      signalProcess: () => { signalled += 1; },
      wait: () => Promise.resolve(),
    }),
    /outside this checkout/u,
  );
  assert.equal(signalled, 0);
}

{
  await assert.rejects(
    stopExactDebugProcesses({
      listProcesses: () => [owned(206)],
      signalProcess: () => { throw new Error("permission denied"); },
      wait: () => Promise.resolve(),
    }),
    /Could not stop Rho development process 206: permission denied/u,
  );
}

{
  let waits = 0;
  await assert.rejects(
    stopExactDebugProcesses({
      listProcesses: () => [owned(207)],
      signalProcess: () => undefined,
      wait: async () => { waits += 1; },
      timeoutMs: 2,
      pollIntervalMs: 1,
    }),
    /No force-kill was attempted/u,
  );
  assert.equal(waits, 2);
}
process.stdout.write("RSR process identity parsing passed\n");
