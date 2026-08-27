import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");

export function validatePhase2HostContract(value) {
  assert.match(
    value.workspace,
    /wasmtime = \{ version = "=38\.0\.4", default-features = false, features = \["component-model", "cranelift", "runtime", "std"\] \}/,
    "Wasmtime version/features changed",
  );
  assert.match(value.workspace, /wat = \{ version = "=1\.257\.1", default-features = false, features = \["component-model"\] \}/);
  assert.match(value.workspace, /wit-component = \{ version = "=0\.239\.0", default-features = false \}/);
  assert.match(value.workspace, /^wit-parser = "=0\.239\.0"$/m);
  assert.match(value.crate, /^wasmtime\.workspace = true$/m);
  assert.match(value.crate, /\[dev-dependencies\][\s\S]*^wat\.workspace = true$/m);
  assert.match(value.crate, /\[dev-dependencies\][\s\S]*^wit-component\.workspace = true$/m);
  assert.match(value.crate, /\[dev-dependencies\][\s\S]*^wit-parser\.workspace = true$/m);
  assert.doesNotMatch(
    value.crate.split("[dev-dependencies]")[0],
    /\bwat\b|\bwit-component\b|\bwit-parser\b/,
    "test-only Wasm fixture tooling leaked into production dependencies",
  );

  for (const marker of [
    "pub struct WasmPluginHost",
    "pub struct WasmHostIdentity",
    "module.imports().next().is_some()",
    "StoreLimitsBuilder::new()",
    ".memory_size(MAX_WASM_MEMORY_BYTES)",
    ".instances(1)",
    ".tables(1)",
    ".memories(1)",
    "let engine = build_engine()?;",
    "let mut store = Store::new(&engine",
    "let linker = Linker::new(&engine);",
    "linker.instantiate(&mut store, &module)",
    ".consume_fuel(true)",
    ".epoch_interruption(true)",
    ".wasm_component_model(true)",
    ".wasm_memory64(false)",
    ".wasm_multi_memory(false)",
    ".wasm_simd(false)",
    ".wasm_bulk_memory(false)",
    "P2_1_WASI_IMPORT_SMOKE_WASM",
    "Trap::OutOfFuel",
    "Trap::Interrupt if cancellation_requested",
    "pub fn quarantine_for_timeout",
  ]) assert.ok(value.host.includes(marker), `P2-1 host contract lost ${marker}`);
  assert.doesNotMatch(
    value.host,
    /func_wrap|wasmtime_wasi|wasi_common|WasiCtx|std::fs|reqwest|Command::new|std::env|tauri::/,
    "P2-1 Wasm host gained an ambient or privileged import surface",
  );

  for (const marker of [
    "fn smoke_wasm_plugin_host(",
    '"runtime": "wasmtime-38.0.4"',
    '"guest_abi": 1',
    '"guest_echo": true',
    '"wasi_rejected": true',
    '"imports_exposed": 0',
  ]) assert.ok(value.smoke.includes(marker), `packaged P2-1 smoke lost ${marker}`);

  assert.ok(
    (value.candidateWorkflow.match(/--smoke-test/g) ?? []).length >= 6,
    "all packaged platform legs must retain candidate/legacy smoke",
  );
  assert.match(
    value.compatibilityWorkflow,
    /^\s*node scripts\/test-extension-phase-2-host-contract\.mjs --test$/m,
    "compatibility workflow lost the host contract self-test",
  );
  assert.match(
    value.compatibilityWorkflow,
    /^\s*node scripts\/test-extension-phase-2-host-contract\.mjs$/m,
    "compatibility workflow lost the host contract source check",
  );
  assert.match(value.licenses, /Wasmtime \/ Cranelift[\s\S]*Apache-2\.0 WITH LLVM-exception/);
}

function fixture() {
  return {
    workspace: 'wasmtime = { version = "=38.0.4", default-features = false, features = ["component-model", "cranelift", "runtime", "std"] }\nwat = { version = "=1.257.1", default-features = false, features = ["component-model"] }\nwit-component = { version = "=0.239.0", default-features = false }\nwit-parser = "=0.239.0"',
    crate: '[dependencies]\nwasmtime.workspace = true\n[dev-dependencies]\nwat.workspace = true\nwit-component.workspace = true\nwit-parser.workspace = true',
    host: 'pub struct WasmPluginHost\npub struct WasmHostIdentity\nmodule.imports().next().is_some()\nStoreLimitsBuilder::new()\n.memory_size(MAX_WASM_MEMORY_BYTES)\n.instances(1)\n.tables(1)\n.memories(1)\nlet engine = build_engine()?;\nlet mut store = Store::new(&engine\nlet linker = Linker::new(&engine);\nlinker.instantiate(&mut store, &module)\n.consume_fuel(true)\n.epoch_interruption(true)\n.wasm_component_model(true)\n.wasm_memory64(false)\n.wasm_multi_memory(false)\n.wasm_simd(false)\n.wasm_bulk_memory(false)\nP2_1_WASI_IMPORT_SMOKE_WASM\nTrap::OutOfFuel\nTrap::Interrupt if cancellation_requested\npub fn quarantine_for_timeout',
    smoke: 'fn smoke_wasm_plugin_host(\n"runtime": "wasmtime-38.0.4"\n"guest_abi": 1\n"guest_echo": true\n"wasi_rejected": true\n"imports_exposed": 0',
    candidateWorkflow: "--smoke-test\n".repeat(6),
    compatibilityWorkflow: "node scripts/test-extension-phase-2-host-contract.mjs --test\nnode scripts/test-extension-phase-2-host-contract.mjs",
    licenses: "Wasmtime / Cranelift Apache-2.0 WITH LLVM-exception",
  };
}

function selfTest() {
  validatePhase2HostContract(fixture());
  for (const [name, mutate] of [
    ["default features", (value) => { value.workspace = value.workspace.replace("default-features = false", "default-features = true"); }],
    ["WASI import", (value) => { value.host += "\nwasmtime_wasi"; }],
    ["no import check", (value) => { value.host = value.host.replace("module.imports().next().is_some()", ""); }],
    ["single instance bound", (value) => { value.host = value.host.replace(".instances(1)", ""); }],
    ["installed probe", (value) => { value.smoke = value.smoke.replace('"wasi_rejected": true', ""); }],
    ["platform leg", (value) => { value.candidateWorkflow = "--smoke-test\n".repeat(5); }],
    ["workflow source check", (value) => { value.compatibilityWorkflow = value.compatibilityWorkflow.replace("\nnode scripts/test-extension-phase-2-host-contract.mjs", ""); }],
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validatePhase2HostContract(value), undefined, name);
  }
}

if (process.argv.includes("--test")) {
  selfTest();
} else {
  validatePhase2HostContract({
    workspace: read("Cargo.toml"),
    crate: read("crates/rho-extension-runtime/Cargo.toml"),
    host: read("crates/rho-extension-runtime/src/wasm_host.rs"),
    smoke: read("desktop/src-tauri/src/smoke/plugin_host.rs"),
    candidateWorkflow: read(".github/workflows/candidate-build-draft.yml"),
    compatibilityWorkflow: read(".github/workflows/rust-compatibility.yml"),
    licenses: read("LICENSES.md"),
  });
}

console.log("extension Phase 2 Wasm host contract passed");
