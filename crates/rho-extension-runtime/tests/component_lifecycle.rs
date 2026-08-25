use std::sync::Arc;

use rho_extension_runtime::{
    ActivationGeneration, BrokerCallIdSource, ComponentPluginHost, GuestStep,
    HOST_PROTOCOL_VERSION, HostFrame, HostInstanceId, HostInstanceState, HostMessage,
    HostProtocolErrorCode, HostRequestId, HostResponse, MAX_GUEST_BROKER_RESULT_BYTES,
    PackageDigest, PluginId, ScopeId, WasmHostIdentity,
};
#[path = "support/component_fixture.rs"]
mod component_fixture_support;
use component_fixture_support::{
    CANCEL_TRUE_BODY, COMPLETE_STEP_BODY, INVALID_STEP_BODY, YIELD_STEP_BODY, component_fixture,
    component_fixture_with_calls,
};

#[derive(Debug)]
struct FixedCallId(u64);

impl BrokerCallIdSource for FixedCallId {
    fn next_call_id(&self) -> u64 {
        self.0
    }
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

#[test]
fn typed_guest_steps_complete_yield_resume_and_cancel() {
    let bytes = successful_component();
    let mut complete_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'a'),
        &bytes,
        Arc::new(FixedCallId(42)),
    )
    .unwrap();
    negotiate_and_activate(&mut complete_host);
    let complete_request = HostRequestId::new("request.complete").unwrap();
    assert_eq!(
        complete_host
            .begin_broker_call(
                complete_request,
                serde_json::json!({"operation": "inspect"}),
            )
            .unwrap(),
        GuestStep::Complete {
            call_id: "call.000000000000002a".to_string(),
            result: serde_json::json!({"operation": "inspect"}),
        }
    );
    assert!(!complete_host.broker_call_active());

    let yielded = component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        YIELD_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    );
    let mut yielded_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'b'),
        &yielded,
        Arc::new(FixedCallId(7)),
    )
    .unwrap();
    negotiate_and_activate(&mut yielded_host);
    let request_id = HostRequestId::new("request.yield").unwrap();
    let step = yielded_host
        .begin_broker_call(request_id.clone(), serde_json::json!({"path": "data.csv"}))
        .unwrap();
    assert!(matches!(
        step,
        GuestStep::BrokerRequest {
            ref call_id,
            ref permission,
            ref operation,
            ref args,
            ..
        } if call_id == "call.0000000000000007"
            && permission == "project.fs.read"
            && operation == "project.fs.read"
            && args == &serde_json::json!({})
    ));
    assert_eq!(
        yielded_host.active_broker_request_id(),
        Some(request_id.clone())
    );
    assert_eq!(
        yielded_host
            .resume_broker_call(&request_id, &serde_json::json!({"bytes": 12}), 12)
            .unwrap(),
        GuestStep::Complete {
            call_id: "call.0000000000000007".to_string(),
            result: serde_json::json!({"bytes": 12}),
        }
    );
    assert!(!yielded_host.broker_call_active());

    let mut cancel_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'c'),
        &yielded,
        Arc::new(FixedCallId(8)),
    )
    .unwrap();
    negotiate_and_activate(&mut cancel_host);
    let cancel_request = HostRequestId::new("request.guest-cancel").unwrap();
    cancel_host
        .begin_broker_call(cancel_request.clone(), serde_json::json!({}))
        .unwrap();
    assert!(cancel_host.cancel_broker_call(&cancel_request).unwrap());
    assert!(!cancel_host.broker_call_active());
    assert_eq!(cancel_host.state(), HostInstanceState::Active);
}

#[test]
fn typed_guest_steps_reject_invalid_sequence_and_result_budgets() {
    let invalid = component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        INVALID_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    );
    let mut invalid_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'a'),
        &invalid,
        Arc::new(FixedCallId(1)),
    )
    .unwrap();
    negotiate_and_activate(&mut invalid_host);
    let error = invalid_host
        .begin_broker_call(
            HostRequestId::new("request.invalid").unwrap(),
            serde_json::json!({}),
        )
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::InvalidBrokerStep);
    assert_eq!(invalid_host.state(), HostInstanceState::Quarantined);

    let yielded = component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        YIELD_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    );
    let mut wrong_request_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'd'),
        &yielded,
        Arc::new(FixedCallId(4)),
    )
    .unwrap();
    negotiate_and_activate(&mut wrong_request_host);
    let exact_request = HostRequestId::new("request.exact").unwrap();
    wrong_request_host
        .begin_broker_call(exact_request, serde_json::json!({}))
        .unwrap();
    let error = wrong_request_host
        .resume_broker_call(
            &HostRequestId::new("request.wrong").unwrap(),
            &serde_json::json!({}),
            0,
        )
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::BrokerSequenceViolation);
    assert_eq!(wrong_request_host.state(), HostInstanceState::Quarantined);

    let repeated = component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        YIELD_STEP_BODY,
        YIELD_STEP_BODY,
        CANCEL_TRUE_BODY,
    );
    let mut repeated_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'b'),
        &repeated,
        Arc::new(FixedCallId(2)),
    )
    .unwrap();
    negotiate_and_activate(&mut repeated_host);
    let repeated_request = HostRequestId::new("request.repeated").unwrap();
    repeated_host
        .begin_broker_call(repeated_request.clone(), serde_json::json!({}))
        .unwrap();
    let error = repeated_host
        .resume_broker_call(&repeated_request, &serde_json::json!({"ok": true}), 1)
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::BrokerSequenceViolation);
    assert_eq!(repeated_host.state(), HostInstanceState::Quarantined);

    let mut budget_host = ComponentPluginHost::from_bytes_with_call_id_source(
        identity("project.a", 'c'),
        &yielded,
        Arc::new(FixedCallId(3)),
    )
    .unwrap();
    negotiate_and_activate(&mut budget_host);
    let budget_request = HostRequestId::new("request.budget").unwrap();
    budget_host
        .begin_broker_call(budget_request.clone(), serde_json::json!({}))
        .unwrap();
    let error = budget_host
        .resume_broker_call(
            &budget_request,
            &serde_json::json!({}),
            MAX_GUEST_BROKER_RESULT_BYTES + 1,
        )
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::BrokerResultLimit);
    assert_eq!(budget_host.state(), HostInstanceState::Quarantined);
}

#[test]
fn exact_component_cancellation_prevents_dispatch_and_interrupts_active_call() {
    let yielded = component_fixture_with_calls(
        "i32.const 0",
        "i32.const 0",
        1,
        YIELD_STEP_BODY,
        COMPLETE_STEP_BODY,
        CANCEL_TRUE_BODY,
    );
    let mut pending_host =
        ComponentPluginHost::from_bytes(identity("project.a", 'a'), &yielded).unwrap();
    negotiate_and_activate(&mut pending_host);
    let pending = HostRequestId::new("request.pending").unwrap();
    assert_eq!(
        pending_host
            .handle_frame(frame(
                &pending_host,
                HostMessage::Cancel {
                    request_id: pending.clone(),
                },
            ))
            .unwrap(),
        None
    );
    let error = pending_host
        .begin_broker_call(pending, serde_json::json!({}))
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::Cancelled);
    assert_eq!(pending_host.state(), HostInstanceState::Active);

    let mut active_host =
        ComponentPluginHost::from_bytes(identity("project.a", 'b'), &yielded).unwrap();
    negotiate_and_activate(&mut active_host);
    let active = HostRequestId::new("request.active").unwrap();
    active_host
        .begin_broker_call(active.clone(), serde_json::json!({}))
        .unwrap();
    let handle = active_host.cancellation_handle();
    assert!(!handle.cancel_inflight(&HostRequestId::new("request.wrong").unwrap()));
    assert!(handle.is_inflight(&active));
    assert!(handle.cancel_inflight(&active));
    let error = active_host
        .resume_broker_call(&active, &serde_json::json!({"late": true}), 1)
        .unwrap_err();
    assert_eq!(error.code, HostProtocolErrorCode::Cancelled);
    assert_eq!(active_host.state(), HostInstanceState::Quarantined);

    let mut sibling =
        ComponentPluginHost::from_bytes(identity("project.b", 'c'), &successful_component())
            .unwrap();
    negotiate_and_activate(&mut sibling);
    assert_eq!(sibling.state(), HostInstanceState::Active);
}
