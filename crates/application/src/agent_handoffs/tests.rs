use super::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn same_wire<N: Serialize + DeserializeOwned, P: Serialize + DeserializeOwned>(value: Value) {
    let native: N = serde_json::from_value(value).unwrap();
    let public: P = wire(&native).unwrap();
    let native_bytes = serde_json::to_vec(&native).unwrap();
    let public_bytes = serde_json::to_vec(&public).unwrap();
    assert_eq!(native_bytes, public_bytes);
    let roundtrip: N = wire(&public).unwrap();
    assert_eq!(serde_json::to_vec(&roundtrip).unwrap(), native_bytes);
}

#[test]
fn handoff_public_boundary_retains_digests_controller_and_draft_fields() {
    let selection = json!({"source":"files", "label":"分析 🧪", "reference":{"path":"analysis.R","sha256":"a".repeat(64)}, "inclusion":"text"});
    let source = json!({"kind":"native", "task_id":"source"});
    let target = json!({"kind":"rho", "conversation_id":"target"});
    let window = json!({"window_id":"window", "incarnation":"original-life"});
    let request = json!({
        "project_root":"/project", "window":window, "request_id":"handoff-request",
        "source":source, "source_revision":"source-revision", "target":target,
        "target_draft_version":9, "target_control_generation":null,
        "body":"已确认的目标", "context":[selection]
    });
    same_wire::<AgentHandoffCommand, rho_agent_api::handoff::AgentHandoffCommand>(request.clone());
    same_wire::<AgentHandoffSourceSnapshot, rho_agent_api::handoff::AgentHandoffSourceSnapshot>(
        json!({
            "source":source,"title":"Source", "body":"Reviewed body", "context":[selection],
            "revision":"material-revision", "truncated":true, "notices":["Partial observation"]
        }),
    );
    same_wire::<AgentHandoffTargetSnapshot, rho_agent_api::handoff::AgentHandoffTargetSnapshot>(
        json!({
            "target":target,"title":"Target", "draft":{"text":"Existing draft","assets":["asset-1"],"context":[selection]},
            "draft_version":9,"controller":window,"control_generation":7,"writable":false,"reason":"The controller changed"
        }),
    );
    same_wire::<StoredAgentHandoff, public::StoredAgentHandoff>(json!({
        "input_digest":"original-request-digest","receipt":{
            "request_id":"handoff-request","source":source,"target":target,"target_draft_version":10,"created_at_ms":123
        }
    }));
    let native: AgentHandoffCommand = serde_json::from_value(request.clone()).unwrap();
    let public: rho_agent_api::handoff::AgentHandoffCommand = wire(&native).unwrap();
    assert_eq!(
        crate::component_digest(&native).unwrap(),
        rho_agent_owner::component::component_digest(&public).unwrap()
    );
    let mut forged = request;
    forged["send_turn"] = json!(true);
    assert!(serde_json::from_value::<AgentHandoffCommand>(forged.clone()).is_err());
    assert!(serde_json::from_value::<rho_agent_api::handoff::AgentHandoffCommand>(forged).is_err());
    let expired = handoff_source_expired();
    assert!(
        matches!(expired, ApplicationError::Diagnostic(ref diagnostic)
        if diagnostic.code == DiagnosticCode::ObservationExpired
        && diagnostic.continuation == DiagnosticContinuation::RefreshObservation)
    );
}
