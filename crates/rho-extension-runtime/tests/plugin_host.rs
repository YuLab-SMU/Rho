use std::collections::BTreeMap;
use std::sync::Arc;

use rho_extension_runtime::{
    ActivationGeneration, BoundedJsonSchema, BrokerCallIdSource, CapabilityId,
    ContributionCallOutcome, ContributionCallRequest, ContributionCallSession, ContributionClock,
    ContributionDeclaration, ContributionInstanceIdentity, ContributionInvocationOrigin,
    ContributionKind, ContributionStore, GuestStep, HOST_PROTOCOL_VERSION, HostFrame,
    HostInstanceId, HostInstanceState, HostMessage, HostProtocolErrorCode, HostRequestId,
    HostResponse, PackageDigest, PluginGuestHost, PluginId, RuntimeAbi, ScopeId, WasmHostIdentity,
};
use serde_json::{Value, json};

#[allow(dead_code)]
#[path = "support/component_fixture.rs"]
mod component_fixture_support;
use component_fixture_support::{
    CANCEL_TRUE_BODY, COMPLETE_STEP_BODY, YIELD_STEP_BODY, component_fixture,
    component_fixture_with_calls,
};

#[derive(Debug)]
struct FixedCallId(u64);

impl BrokerCallIdSource for FixedCallId {
    fn next_call_id(&self) -> u64 {
        self.0
    }
}

#[derive(Debug)]
struct FixedClock;

impl ContributionClock for FixedClock {
    fn now_millis(&self) -> u64 {
        1_000
    }
}

fn identity(project: &str, plugin: &str, digest: char, instance: &str) -> WasmHostIdentity {
    WasmHostIdentity::new(
        ScopeId::new(project).unwrap(),
        PluginId::new(plugin).unwrap(),
        PackageDigest::parse(digest.to_string().repeat(64)).unwrap(),
        ActivationGeneration::new(1).unwrap(),
        HostInstanceId::new(instance).unwrap(),
    )
}

fn frame(host: &PluginGuestHost, message: HostMessage) -> HostFrame {
    HostFrame {
        instance_id: host.identity().host_instance_id().clone(),
        message,
    }
}

fn activate(host: &mut PluginGuestHost) {
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

fn wat_data(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("\\{byte:02x}"))
        .collect()
}

fn core_fixture(begin_step: &str, resume_step: &str, cancel_status: i32) -> Vec<u8> {
    let begin_pointer = 1_024_u64;
    let resume_pointer = 4_096_u64;
    let begin_packed = (begin_pointer << 32) | begin_step.len() as u64;
    let resume_packed = (resume_pointer << 32) | resume_step.len() as u64;
    wat::parse_str(format!(
        r#"(module
            (memory (export "memory") 1 1)
            (data (i32.const {begin_pointer}) "{}")
            (data (i32.const {resume_pointer}) "{}")
            (func (export "rho_activate") (param $abi i32) (result i32)
              local.get $abi i32.const 2 i32.ne)
            (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
            (func (export "rho_heartbeat") (result i32) i32.const 0)
            (func (export "rho_quiesce") (result i32) i32.const 0)
            (func (export "rho_dispose") (result i32) i32.const 0)
            (func (export "rho_begin") (param i32 i32) (result i64) i64.const {begin_packed})
            (func (export "rho_resume") (param i32 i32) (result i64) i64.const {resume_packed})
            (func (export "rho_cancel") (param i32 i32) (result i32) i32.const {cancel_status}))"#,
        wat_data(begin_step),
        wat_data(resume_step),
    ))
    .unwrap()
}

fn complete_step(call_id: &str, result: Value) -> String {
    json!({
        "type": "complete",
        "call_id": call_id,
        "result": result,
    })
    .to_string()
}

fn yield_step(call_id: &str) -> String {
    json!({
        "type": "broker_request",
        "call_id": call_id,
        "handle_id": format!("handle.{}", "a".repeat(64)),
        "permission": "project.fs.read",
        "operation": "project.fs.read",
        "args": {},
    })
    .to_string()
}

fn host(
    abi: RuntimeAbi,
    identity: WasmHostIdentity,
    bytes: &[u8],
    call_id: u64,
) -> PluginGuestHost {
    PluginGuestHost::from_runtime_abi_with_call_id_source(
        abi,
        identity,
        bytes,
        Arc::new(FixedCallId(call_id)),
    )
    .unwrap()
}

fn component_complete_fixture() -> Vec<u8> {
    component_fixture("i32.const 0", "i32.const 0", 1)
}

fn component_empty_complete_fixture() -> Vec<u8> {
    const EMPTY_COMPLETE_STEP_BODY: &str = "i32.const 64 i32.const 1 i32.store8 i32.const 68 local.get $call-ptr i32.store i32.const 72 local.get $call-len i32.store i32.const 76 i32.const 416 i32.store i32.const 80 i32.const 2 i32.store i32.const 64";
    component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        EMPTY_COMPLETE_STEP_BODY,
        EMPTY_COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    )
}

fn component_yield_fixture() -> Vec<u8> {
    component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        YIELD_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    )
}

#[test]
fn manifest_abi_selects_exact_runtime_without_byte_probing_or_fallback() {
    let call_id = "call.000000000000002a";
    let core = core_fixture(
        &complete_step(call_id, json!({"ok": true})),
        &complete_step(call_id, json!({"ok": true})),
        0,
    );
    let component = component_complete_fixture();

    let core_host = host(
        RuntimeAbi::CoreV2,
        identity("project.core", "org.example.core", 'a', "instance.core"),
        &core,
        42,
    );
    let component_host = host(
        RuntimeAbi::ComponentV1,
        identity(
            "project.component",
            "org.example.component",
            'b',
            "instance.component",
        ),
        &component,
        42,
    );
    assert_eq!(core_host.runtime_abi(), RuntimeAbi::CoreV2);
    assert_eq!(component_host.runtime_abi(), RuntimeAbi::ComponentV1);

    let component_error = PluginGuestHost::from_runtime_abi_with_call_id_source(
        RuntimeAbi::ComponentV1,
        identity("project.core", "org.example.core", 'a', "instance.wrong-a"),
        &core,
        Arc::new(FixedCallId(42)),
    )
    .unwrap_err();
    assert_eq!(component_error.code, HostProtocolErrorCode::InvalidModule);

    let core_error = PluginGuestHost::from_runtime_abi_with_call_id_source(
        RuntimeAbi::CoreV2,
        identity(
            "project.component",
            "org.example.component",
            'b',
            "instance.wrong-b",
        ),
        &component,
        Arc::new(FixedCallId(42)),
    )
    .unwrap_err();
    assert_eq!(core_error.code, HostProtocolErrorCode::InvalidModule);
}

#[test]
fn both_facade_variants_forward_the_same_lifecycle_and_exact_identity() {
    let call_id = "call.000000000000002a";
    let core = core_fixture(
        &complete_step(call_id, json!({})),
        &complete_step(call_id, json!({})),
        0,
    );
    let component = component_complete_fixture();
    let identities = [
        identity("project.core", "org.example.core", 'a', "instance.core"),
        identity(
            "project.component",
            "org.example.component",
            'b',
            "instance.component",
        ),
    ];
    let mut hosts = [
        host(RuntimeAbi::CoreV2, identities[0].clone(), &core, 42),
        host(
            RuntimeAbi::ComponentV1,
            identities[1].clone(),
            &component,
            42,
        ),
    ];

    for (host, expected_identity) in hosts.iter_mut().zip(identities) {
        assert_eq!(host.identity(), &expected_identity);
        assert!(host.supports_guest_calls());
        assert_eq!(host.state(), HostInstanceState::Created);
        activate(host);
        assert_eq!(
            host.handle_frame(frame(host, HostMessage::Heartbeat))
                .unwrap(),
            Some(HostResponse::HeartbeatAck)
        );
        assert_eq!(
            host.handle_frame(frame(host, HostMessage::Quiesce))
                .unwrap(),
            Some(HostResponse::Quiesced)
        );
        assert_eq!(
            host.handle_frame(frame(host, HostMessage::Dispose))
                .unwrap(),
            Some(HostResponse::Disposed)
        );
        assert_eq!(host.state(), HostInstanceState::Disposed);
    }
}

#[test]
fn both_facade_variants_complete_yield_resume_and_cancel_with_the_same_contract() {
    let call_id = "call.000000000000002a";
    let core_complete = core_fixture(
        &complete_step(call_id, json!({"complete": true})),
        &complete_step(call_id, json!({"complete": true})),
        0,
    );
    let component_complete = component_complete_fixture();
    let core_yield = core_fixture(
        &yield_step(call_id),
        &complete_step(call_id, json!({"resumed": true})),
        0,
    );
    let component_yield = component_yield_fixture();

    for (abi, bytes, digest, instance) in [
        (
            RuntimeAbi::CoreV2,
            core_complete.as_slice(),
            'a',
            "instance.core-complete",
        ),
        (
            RuntimeAbi::ComponentV1,
            component_complete.as_slice(),
            'b',
            "instance.component-complete",
        ),
    ] {
        let mut host = host(
            abi,
            identity("project.complete", "org.example.complete", digest, instance),
            bytes,
            42,
        );
        activate(&mut host);
        assert!(matches!(
            host.begin_broker_call(
                HostRequestId::new("request.complete").unwrap(),
                json!({"complete": true}),
            )
            .unwrap(),
            GuestStep::Complete { ref call_id, .. }
                if call_id == "call.000000000000002a"
        ));
        assert!(!host.broker_call_active());
    }

    for (abi, bytes, digest, instance) in [
        (
            RuntimeAbi::CoreV2,
            core_yield.as_slice(),
            'c',
            "instance.core-yield",
        ),
        (
            RuntimeAbi::ComponentV1,
            component_yield.as_slice(),
            'd',
            "instance.component-yield",
        ),
    ] {
        let mut host = host(
            abi,
            identity("project.yield", "org.example.yield", digest, instance),
            bytes,
            42,
        );
        activate(&mut host);
        let request_id = HostRequestId::new("request.yield").unwrap();
        assert!(matches!(
            host.begin_broker_call(request_id.clone(), json!({})).unwrap(),
            GuestStep::BrokerRequest {
                ref call_id,
                ref permission,
                ref operation,
                ref args,
                ..
            } if call_id == "call.000000000000002a"
                && permission == "project.fs.read"
                && operation == "project.fs.read"
                && args == &json!({})
        ));
        assert_eq!(host.active_broker_request_id(), Some(request_id.clone()));
        assert!(matches!(
            host.resume_broker_call(&request_id, &json!({"resumed": true}), 16)
                .unwrap(),
            GuestStep::Complete { ref call_id, .. }
                if call_id == "call.000000000000002a"
        ));
        assert!(!host.broker_call_active());
    }

    for (abi, bytes, digest, instance) in [
        (
            RuntimeAbi::CoreV2,
            core_yield.as_slice(),
            'e',
            "instance.core-cancel",
        ),
        (
            RuntimeAbi::ComponentV1,
            component_yield.as_slice(),
            'f',
            "instance.component-cancel",
        ),
    ] {
        let mut host = host(
            abi,
            identity("project.cancel", "org.example.cancel", digest, instance),
            bytes,
            42,
        );
        activate(&mut host);
        let request_id = HostRequestId::new("request.cancel").unwrap();
        host.begin_broker_call(request_id.clone(), json!({}))
            .unwrap();
        assert!(host.cancel_broker_call(&request_id).unwrap());
        assert!(!host.broker_call_active());
        assert_eq!(host.state(), HostInstanceState::Active);
    }
}

fn contribution_registry(identity: &WasmHostIdentity) -> ContributionStore {
    let declaration = ContributionDeclaration {
        id: CapabilityId::new("tool.fixture.read").unwrap(),
        kind: ContributionKind::Tool,
        contract_major: 1,
        label: "Read fixture".to_string(),
        purpose: "Read bounded fixture metadata".to_string(),
        icon: None,
        input_schema: Some(
            BoundedJsonSchema::new(json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }))
            .unwrap(),
        ),
        output_schema: Some(
            BoundedJsonSchema::new(json!({"type": "object", "properties": {}})).unwrap(),
        ),
        media_types: Vec::new(),
        skill_path: None,
        panel_slot: None,
        surface: None,
    };
    let contribution_identity = ContributionInstanceIdentity::new(
        identity.project_id().clone(),
        identity.plugin_id().clone(),
        identity.package_digest().clone(),
        identity.activation_generation(),
        identity.host_instance_id().clone(),
    );
    let mut registry = ContributionStore::new();
    let candidate = ContributionStore::stage(contribution_identity, vec![declaration]).unwrap();
    registry.publish(candidate, None).unwrap();
    registry
}

#[test]
fn contribution_session_uses_one_admission_and_validation_path_for_both_abis() {
    let call_id = "call.000000000000002a";
    let core = core_fixture(
        &complete_step(call_id, json!({})),
        &complete_step(call_id, json!({})),
        0,
    );
    let component = component_empty_complete_fixture();

    for (abi, bytes, digest, instance) in [
        (
            RuntimeAbi::CoreV2,
            core.as_slice(),
            'a',
            "instance.core-contribution",
        ),
        (
            RuntimeAbi::ComponentV1,
            component.as_slice(),
            'b',
            "instance.component-contribution",
        ),
    ] {
        let identity = identity(
            "project.contribution",
            "org.example.contribution",
            digest,
            instance,
        );
        let registry = contribution_registry(&identity);
        let mut host = host(abi, identity.clone(), bytes, 42);
        activate(&mut host);
        let (mut session, step) = ContributionCallSession::begin(
            &registry,
            ContributionCallRequest {
                project_id: identity.project_id().clone(),
                contribution_id: CapabilityId::new("tool.fixture.read").unwrap(),
                origin: ContributionInvocationOrigin::UserCommand,
                input: json!({"path": "data.csv"}),
                supplied_handles: BTreeMap::new(),
            },
            &FixedClock,
            &mut host,
        )
        .unwrap();
        let outcome = session
            .finish(&registry, &step, &FixedClock, &mut host)
            .unwrap();
        assert!(matches!(outcome, ContributionCallOutcome::Completed { .. }));
    }
}

#[test]
fn timeout_and_cancellation_remain_scoped_to_the_exact_facade_instance() {
    let call_id = "call.000000000000002a";
    let core = core_fixture(&yield_step(call_id), &complete_step(call_id, json!({})), 0);
    let component = component_yield_fixture();
    let mut core_host = host(
        RuntimeAbi::CoreV2,
        identity("project.a", "org.example.plugin", 'a', "instance.a"),
        &core,
        42,
    );
    let mut component_host = host(
        RuntimeAbi::ComponentV1,
        identity("project.b", "org.example.plugin", 'b', "instance.b"),
        &component,
        42,
    );
    activate(&mut core_host);
    activate(&mut component_host);

    let request_id = HostRequestId::new("request.component").unwrap();
    component_host
        .begin_broker_call(request_id.clone(), json!({}))
        .unwrap();
    let cancellation = component_host.cancellation_handle();
    assert!(!cancellation.cancel_inflight(&HostRequestId::new("request.wrong").unwrap()));
    assert!(cancellation.is_inflight(&request_id));
    assert!(cancellation.cancel_inflight(&request_id));
    assert_eq!(core_host.state(), HostInstanceState::Active);

    assert!(core_host.quarantine_for_timeout());
    assert_eq!(core_host.state(), HostInstanceState::Quarantined);
    assert_eq!(component_host.state(), HostInstanceState::Active);
}
