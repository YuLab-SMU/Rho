use std::path::Path;

use wit_component::{ComponentEncoder, StringEncoding, embed_component_metadata};
use wit_parser::Resolve;

const CANCEL_TRUE_BODY: &str =
    "i32.const 96 i32.const 0 i32.store8 i32.const 100 i32.const 1 i32.store8 i32.const 96";

pub(super) fn complete_component() -> Vec<u8> {
    component_fixture(false)
}

pub(super) fn file_broker_component() -> Vec<u8> {
    component_fixture(true)
}

fn component_fixture(yields_file_request: bool) -> Vec<u8> {
    let handle = format!("handle.{}", "07".repeat(32));
    let permission = "project.fs.read";
    let operation = "project.fs.read";
    let args = serde_json::json!({
        "project_relative_path": "data/input.csv",
        "max_bytes": 1024,
        "expected_project_revision": 3,
    })
    .to_string();
    let completed = serde_json::json!({"received": true}).to_string();

    let complete_body = format!(
        "i32.const 64 i32.const 1 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 i32.const 768 i32.store i32.const 80 i32.const {} i32.store i32.const 64",
        completed.len(),
    );
    let begin_body = if yields_file_request {
        format!(
            "i32.const 64 i32.const 0 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 i32.const 256 i32.store i32.const 80 i32.const {} i32.store i32.const 84 i32.const 384 i32.store i32.const 88 i32.const {} i32.store i32.const 92 i32.const 416 i32.store i32.const 96 i32.const {} i32.store i32.const 100 i32.const 512 i32.store i32.const 104 i32.const {} i32.store i32.const 64",
            handle.len(),
            permission.len(),
            operation.len(),
            args.len(),
        )
    } else {
        complete_body.clone()
    };

    let mut resolve = Resolve::default();
    let wit_root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/rho-extension-runtime/wit");
    let (package, _) = resolve.push_path(&wit_root).unwrap();
    let world = resolve.select_world(&[package], Some("plugin")).unwrap();
    let module_wat = format!(
        r#"
(module
  (memory (export "cm32p2_memory") 1)
  (global $heap (mut i32) (i32.const 8192))
  (func (export "cm32p2_realloc")
    (param i32 i32 i32) (param $new-size i32) (result i32)
    (local $ptr i32)
    local.get $new-size
    i32.eqz
    if (result i32)
      i32.const 0
    else
      global.get $heap
      local.set $ptr
      global.get $heap
      local.get $new-size
      i32.add
      global.set $heap
      local.get $ptr
    end)
  (func (export "cm32p2_initialize"))
  (data (i32.const 128) "denied")
  (data (i32.const 256) "{}")
  (data (i32.const 384) "{}")
  (data (i32.const 416) "{}")
  (data (i32.const 512) "{}")
  (data (i32.const 768) "{}")

  (func (export "cm32p2|rho:plugin/lifecycle@1|activate") (param i64) (result i32)
    i32.const 0)
  (func (export "cm32p2|rho:plugin/lifecycle@1|activate_post") (param i32))
  (func (export "cm32p2|rho:plugin/lifecycle@1|echo") (param $ptr i32) (param $len i32) (result i32)
    i32.const 16 i32.const 0 i32.store8
    i32.const 20 local.get $ptr i32.store
    i32.const 24 local.get $len i32.store
    i32.const 16)
  (func (export "cm32p2|rho:plugin/lifecycle@1|echo_post") (param i32))
  (func (export "cm32p2|rho:plugin/lifecycle@1|heartbeat") (result i32) i32.const 0)
  (func (export "cm32p2|rho:plugin/lifecycle@1|heartbeat_post") (param i32))
  (func (export "cm32p2|rho:plugin/lifecycle@1|quiesce") (result i32) i32.const 0)
  (func (export "cm32p2|rho:plugin/lifecycle@1|quiesce_post") (param i32))
  (func (export "cm32p2|rho:plugin/lifecycle@1|dispose") (result i32) i32.const 0)
  (func (export "cm32p2|rho:plugin/lifecycle@1|dispose_post") (param i32))

  (func (export "cm32p2|rho:plugin/guest-calls@1|begin")
    (param $call-ptr i32) (param $call-len i32) (param i32 i32) (result i32)
    {begin_body})
  (func (export "cm32p2|rho:plugin/guest-calls@1|begin_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume")
    (param $call-ptr i32) (param $call-len i32) (param i32 i32) (result i32)
    {complete_body})
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|cancel") (param i32 i32) (result i32)
    {CANCEL_TRUE_BODY})
  (func (export "cm32p2|rho:plugin/guest-calls@1|cancel_post") (param i32))
)
"#,
        wat_data(&handle),
        wat_data(permission),
        wat_data(operation),
        wat_data(&args),
        wat_data(&completed),
    );
    let mut module = wat::parse_str(module_wat).unwrap();
    embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8).unwrap();
    ComponentEncoder::default()
        .module(&module)
        .unwrap()
        .validate(true)
        .encode()
        .unwrap()
}

fn wat_data(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("\\{byte:02x}"))
        .collect()
}
