use std::path::Path;

use wit_component::{ComponentEncoder, StringEncoding, embed_component_metadata};
use wit_parser::Resolve;

pub const COMPLETE_STEP_BODY: &str = "i32.const 64 i32.const 1 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 local.get $json-ptr i32.store i32.const 80 local.get $json-len i32.store i32.const 64";
pub const CANCEL_TRUE_BODY: &str =
    "i32.const 96 i32.const 0 i32.store8 i32.const 100 i32.const 1 i32.store8 i32.const 96";
pub const YIELD_STEP_BODY: &str = "i32.const 64 i32.const 0 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 i32.const 256 i32.store i32.const 80 i32.const 71 i32.store i32.const 84 i32.const 352 i32.store i32.const 88 i32.const 15 i32.store i32.const 92 i32.const 384 i32.store i32.const 96 i32.const 15 i32.store i32.const 100 i32.const 416 i32.store i32.const 104 i32.const 2 i32.store i32.const 64";
pub const INVALID_STEP_BODY: &str = "i32.const 64 i32.const 0 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 i32.const 416 i32.store i32.const 80 i32.const 2 i32.store i32.const 84 i32.const 352 i32.store i32.const 88 i32.const 15 i32.store i32.const 92 i32.const 384 i32.store i32.const 96 i32.const 15 i32.store i32.const 100 i32.const 416 i32.store i32.const 104 i32.const 2 i32.store i32.const 64";

pub fn component_fixture(activate_body: &str, dispose_body: &str, memory_pages: u32) -> Vec<u8> {
    component_fixture_with_calls(
        activate_body,
        dispose_body,
        memory_pages,
        COMPLETE_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    )
}

pub fn component_fixture_with_calls(
    activate_body: &str,
    dispose_body: &str,
    memory_pages: u32,
    begin_body: &str,
    resume_body: &str,
    cancel_body: &str,
) -> Vec<u8> {
    let mut resolve = Resolve::default();
    let (package, _) = resolve
        .push_path(Path::new(env!("CARGO_MANIFEST_DIR")).join("wit"))
        .unwrap();
    let world = resolve.select_world(&[package], Some("plugin")).unwrap();
    let module_wat = format!(
        r#"
(module
  (memory (export "cm32p2_memory") {memory_pages})
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
  (data (i32.const 256) "handle.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  (data (i32.const 352) "project.fs.read")
  (data (i32.const 384) "project.fs.read")
  (data (i32.const 416) "{{}}")

  (func (export "cm32p2|rho:plugin/lifecycle@1|activate") (param i64) (result i32)
    {activate_body})
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
  (func (export "cm32p2|rho:plugin/lifecycle@1|dispose") (result i32)
    {dispose_body})
  (func (export "cm32p2|rho:plugin/lifecycle@1|dispose_post") (param i32))

  (func (export "cm32p2|rho:plugin/guest-calls@1|begin")
    (param $call-ptr i32) (param $call-len i32) (param $json-ptr i32) (param $json-len i32) (result i32)
    {begin_body})
  (func (export "cm32p2|rho:plugin/guest-calls@1|begin_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume")
    (param $call-ptr i32) (param $call-len i32) (param $json-ptr i32) (param $json-len i32) (result i32)
    {resume_body})
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|cancel") (param i32 i32) (result i32)
    {cancel_body})
  (func (export "cm32p2|rho:plugin/guest-calls@1|cancel_post") (param i32))
)
"#
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
