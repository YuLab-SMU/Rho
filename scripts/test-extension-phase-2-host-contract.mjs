import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");

export function validatePhase2HostContract(value) {
  assert.match(
    value.workspace,
    /wasmtime = \{ version = "=38\.0\.4", default-features = false, features = \["cranelift", "runtime", "std"\] \}/,
    "Wasmtime version/features changed",
  );
  assert.match(value.workspace, /wat = \{ version = "=1\.257\.1", default-features = false \}/);
  assert.match(value.crate, /^wasmtime\.workspace = true$/m);
  assert.match(value.crate, /\[dev-dependencies\][\s\S]*^wat\.workspace = true$/m);
  assert.doesNotMatch(value.crate.split("[dev-dependencies]")[0], /\bwat\b/);

  for (const marker of [
    "pub struct WasmPluginHost",
    "pub struct WasmHostIdentity",
    "module.imports().next().is_some()",
    "StoreLimitsBuilder::new()",
    ".memory_size(MAX_WASM_MEMORY_BYTES)",
    ".consume_fuel(true)",
    ".epoch_interruption(true)",
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
  ]) assert.ok(value.desktop.includes(marker), `packaged P2-1 smoke lost ${marker}`);

  assert.ok(
    (value.compatibility.match(/--smoke-test/g) ?? []).length >= 6,
    "all packaged platform legs must retain candidate/legacy smoke",
  );
  assert.match(
    value.spec,
    /Status: implemented and accepted for Phase 2 integration[\s\S]*32456281744/,
  );
  assert.match(value.spec, /default features, WASI[\s\S]*excluded from the production build/);
  assert.match(value.spec, /P2-1 defines no imports at all/);
  assert.match(value.spec, /one Engine\/Store\/Instance per/);
  assert.match(value.licenses, /Wasmtime \/ Cranelift[\s\S]*Apache-2\.0 WITH LLVM-exception/);
}

function fixture() {
  return {
    workspace: 'wasmtime = { version = "=38.0.4", default-features = false, features = ["cranelift", "runtime", "std"] }\nwat = { version = "=1.257.1", default-features = false }',
    crate: '[dependencies]\nwasmtime.workspace = true\n[dev-dependencies]\nwat.workspace = true',
    host: 'pub struct WasmPluginHost\npub struct WasmHostIdentity\nmodule.imports().next().is_some()\nStoreLimitsBuilder::new()\n.memory_size(MAX_WASM_MEMORY_BYTES)\n.consume_fuel(true)\n.epoch_interruption(true)\n.wasm_memory64(false)\n.wasm_multi_memory(false)\n.wasm_simd(false)\n.wasm_bulk_memory(false)\nP2_1_WASI_IMPORT_SMOKE_WASM\nTrap::OutOfFuel\nTrap::Interrupt if cancellation_requested\npub fn quarantine_for_timeout',
    desktop: 'fn smoke_wasm_plugin_host(\n"runtime": "wasmtime-38.0.4"\n"guest_abi": 1\n"guest_echo": true\n"wasi_rejected": true\n"imports_exposed": 0',
    compatibility: "--smoke-test\n".repeat(6),
    spec: "Status: implemented and accepted for Phase 2 integration\n32456281744\ndefault features, WASI excluded from the production build\nP2-1 defines no imports at all\none Engine/Store/Instance per",
    licenses: "Wasmtime / Cranelift Apache-2.0 WITH LLVM-exception",
  };
}

function selfTest() {
  validatePhase2HostContract(fixture());
  for (const [name, mutate] of [
    ["default features", (value) => { value.workspace = value.workspace.replace("default-features = false", "default-features = true"); }],
    ["WASI import", (value) => { value.host += "\nwasmtime_wasi"; }],
    ["no import check", (value) => { value.host = value.host.replace("module.imports().next().is_some()", ""); }],
    ["installed probe", (value) => { value.desktop = value.desktop.replace('"wasi_rejected": true', ""); }],
    ["platform leg", (value) => { value.compatibility = "--smoke-test\n".repeat(5); }],
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
    desktop: read("desktop/src-tauri/src/main.rs"),
    compatibility: read(".github/workflows/rust-compatibility.yml"),
    spec: read("docs/plans/active-2026-08-20-p2-1-wasm-isolated-host-spec.md"),
    licenses: read("LICENSES.md"),
  });
}

console.log("extension Phase 2 Wasm host contract passed");
