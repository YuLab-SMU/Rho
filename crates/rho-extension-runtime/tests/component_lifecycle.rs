use std::path::Path;

use rho_extension_runtime::{
    ActivationGeneration, ComponentPluginHost, HOST_PROTOCOL_VERSION, HostFrame, HostInstanceId,
    HostInstanceState, HostMessage, HostProtocolErrorCode, HostRequestId, HostResponse,
    PackageDigest, PluginId, ScopeId, WasmHostIdentity,
};
use wit_component::{ComponentEncoder, StringEncoding, embed_component_metadata};
use wit_parser::Resolve;

fn component_fixture(activate_body: &str, dispose_body: &str, memory_pages: u32) -> Vec<u8> {
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
    i32.const 64 i32.const 1 i32.store8
    i32.const 68 local.get $call-ptr i32.store
    i32.const 72 local.get $call-len i32.store
    i32.const 76 local.get $json-ptr i32.store
    i32.const 80 local.get $json-len i32.store
    i32.const 64)
  (func (export "cm32p2|rho:plugin/guest-calls@1|begin_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume")
    (param $call-ptr i32) (param $call-len i32) (param $json-ptr i32) (param $json-len i32) (result i32)
    i32.const 64 i32.const 1 i32.store8
    i32.const 68 local.get $call-ptr i32.store
    i32.const 72 local.get $call-len i32.store
    i32.const 76 local.get $json-ptr i32.store
    i32.const 80 local.get $json-len i32.store
    i32.const 64)
  (func (export "cm32p2|rho:plugin/guest-calls@1|resume_post") (param i32))
  (func (export "cm32p2|rho:plugin/guest-calls@1|cancel") (param i32 i32) (result i32)
    i32.const 96 i32.const 0 i32.store8
    i32.const 100 i32.const 1 i32.store8
    i32.const 96)
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

fn successful_component() -> Vec<u8> {
    component_fixture("i32.const 0", "i32.const 0", 1)
}

fn identity(project: &str, digest: char) -> WasmHostIdentity {
    WasmHostIdentity::new(
        ScopeId::new(project).unwrap(),
        PluginId::new("org.example.component").unwrap(),
        PackageDigest::parse(digest.to_string().repeat(64)).unwrap(),
        ActivationGeneration::new(1).unwrap(),
        HostInstanceId::generate(),
    )
}

fn frame(host: &ComponentPluginHost, message: HostMessage) -> HostFrame {
    HostFrame {
        instance_id: host.identity().host_instance_id().clone(),
        message,
    }
}

fn negotiate_and_activate(host: &mut ComponentPluginHost) {
    assert_eq!(
        host.handle_frame(frame(
            host,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .unwrap(),
        Some(HostResponse::Ready {
            api_version: HOST_PROTOCOL_VERSION,
        })
    );
    assert_eq!(
        host.handle_frame(frame(host, HostMessage::Activate))
            .unwrap(),
        Some(HostResponse::Activated)
    );
}

#[test]
fn typed_component_runs_the_complete_lifecycle() {
    let bytes = successful_component();
    let mut host = ComponentPluginHost::from_bytes(identity("project.a", 'a'), &bytes).unwrap();
    assert_eq!(host.state(), HostInstanceState::Created);

    negotiate_and_activate(&mut host);
    let request_id = HostRequestId::new("request.echo").unwrap();
    assert_eq!(
        host.handle_frame(frame(
            &host,
            HostMessage::Echo {
                request_id: request_id.clone(),
                payload: "héllo component".to_string(),
            },
        ))
        .unwrap(),
        Some(HostResponse::EchoResult {
            request_id,
            payload: "héllo component".to_string(),
        })
    );
    assert_eq!(
        host.handle_frame(frame(&host, HostMessage::Heartbeat))
            .unwrap(),
        Some(HostResponse::HeartbeatAck)
    );
    assert_eq!(
        host.handle_frame(frame(&host, HostMessage::Quiesce))
            .unwrap(),
        Some(HostResponse::Quiesced)
    );
    assert_eq!(
        host.handle_frame(frame(&host, HostMessage::Dispose))
            .unwrap(),
        Some(HostResponse::Disposed)
    );
    assert_eq!(host.state(), HostInstanceState::Disposed);
}

#[test]
fn typed_export_mismatch_fails_before_guest_execution() {
    let empty = wat::parse_str("(component)").unwrap();
    let error = ComponentPluginHost::from_bytes(identity("project.a", 'a'), &empty).unwrap_err();

    assert_eq!(error.code, HostProtocolErrorCode::InvalidExport);
}

#[test]
fn guest_rejection_and_dispose_trap_are_truthful_and_non_routable() {
    let rejected = component_fixture(
        "i32.const 0 i32.const 1 i32.store8 i32.const 4 i32.const 128 i32.store i32.const 8 i32.const 6 i32.store i32.const 0",
        "i32.const 0",
        1,
    );
    let mut rejected_host =
        ComponentPluginHost::from_bytes(identity("project.a", 'a'), &rejected).unwrap();
    rejected_host
        .handle_frame(frame(
            &rejected_host,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .unwrap();
    let error = rejected_host
        .handle_frame(frame(&rejected_host, HostMessage::Activate))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::GuestRejected);
    assert_eq!(rejected_host.state(), HostInstanceState::Quarantined);

    let dispose_trap = component_fixture("i32.const 0", "unreachable", 1);
    let mut dispose_host =
        ComponentPluginHost::from_bytes(identity("project.a", 'b'), &dispose_trap).unwrap();
    negotiate_and_activate(&mut dispose_host);
    let error = dispose_host
        .handle_frame(frame(&dispose_host, HostMessage::Dispose))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::GuestTrap);
    assert_eq!(dispose_host.state(), HostInstanceState::Quarantined);
}

#[test]
fn trap_and_fuel_exhaustion_quarantine_only_the_exact_project() {
    let trap = component_fixture("unreachable", "i32.const 0", 1);
    let mut host_a = ComponentPluginHost::from_bytes(identity("project.a", 'a'), &trap).unwrap();
    host_a
        .handle_frame(frame(
            &host_a,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .unwrap();
    let error = host_a
        .handle_frame(frame(&host_a, HostMessage::Activate))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::GuestTrap);
    assert_eq!(host_a.state(), HostInstanceState::Quarantined);

    let mut host_b =
        ComponentPluginHost::from_bytes(identity("project.b", 'b'), &successful_component())
            .unwrap();
    negotiate_and_activate(&mut host_b);
    assert_eq!(host_b.state(), HostInstanceState::Active);

    let infinite = component_fixture("(loop $spin br $spin) i32.const 0", "i32.const 0", 1);
    let mut fuel_host =
        ComponentPluginHost::from_bytes(identity("project.c", 'c'), &infinite).unwrap();
    fuel_host
        .handle_frame(frame(
            &fuel_host,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .unwrap();
    let error = fuel_host
        .handle_frame(frame(&fuel_host, HostMessage::Activate))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::FuelExhausted);
    assert_eq!(fuel_host.state(), HostInstanceState::Quarantined);
    assert_eq!(host_b.state(), HostInstanceState::Active);
}

#[test]
fn component_memory_minimum_cannot_exceed_the_store_limit() {
    let oversized_memory = component_fixture("i32.const 0", "i32.const 0", 33);
    let error =
        ComponentPluginHost::from_bytes(identity("project.a", 'a'), &oversized_memory).unwrap_err();

    assert_eq!(error.code, HostProtocolErrorCode::ResourceLimit);

    let grow = component_fixture(
        "i32.const 32 memory.grow drop i32.const 0",
        "i32.const 0",
        1,
    );
    let mut grow_host = ComponentPluginHost::from_bytes(identity("project.a", 'b'), &grow).unwrap();
    grow_host
        .handle_frame(frame(
            &grow_host,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .unwrap();
    let error = grow_host
        .handle_frame(frame(&grow_host, HostMessage::Activate))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::ResourceLimit);
    assert_eq!(grow_host.state(), HostInstanceState::Quarantined);
}

#[test]
fn component_host_is_send_and_timeout_is_idempotent() {
    fn assert_send<T: Send>() {}
    assert_send::<ComponentPluginHost>();

    let mut host =
        ComponentPluginHost::from_bytes(identity("project.a", 'a'), &successful_component())
            .unwrap();
    assert!(host.quarantine_for_timeout());
    assert_eq!(host.state(), HostInstanceState::Quarantined);
    assert!(!host.quarantine_for_timeout());
}
