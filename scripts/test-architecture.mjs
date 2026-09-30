import assert from "node:assert/strict";
import { assertAgentEngineBoundary } from "./check-architecture.mjs";

for (const dependency of ["rig", "rig-core", "rig-agent"]) {
  assert.doesNotThrow(() => assertAgentEngineBoundary({ name: "rho-agent-engine", dependencies: [{ name: dependency }] }));
  for (const owner of ["rho-contract", "rho-sqlite", "rho-host", "rho-r-api", "rho-r-engine", "rho-workbench"]) {
    assert.throws(() => assertAgentEngineBoundary({ name: owner, dependencies: [{ name: dependency }] }), /outside rho-agent-engine/);
  }
}
assert.doesNotThrow(() => assertAgentEngineBoundary({ name: "rho-r-engine", dependencies: [{ name: "rho-r-api" }] }));
console.log("Agent engine allow/reject dependency fixtures passed.");
