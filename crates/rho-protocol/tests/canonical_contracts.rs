use chrono::{TimeZone, Utc};
use rho_protocol::*;
use serde::Serialize;
use serde_json::json;

fn id<T>(value: &str) -> T
where
    T: TryFrom<String>,
    T::Error: std::fmt::Debug,
{
    T::try_from(value.to_string()).unwrap()
}

fn expected_revisions() -> ExpectedRevisions {
    ExpectedRevisions {
        workspace_id: id("workspace_main"),
        kernel_instance_id: id("kernel_a"),
        state_revision: StateRevision(42),
        project_revision: ProjectRevision(7),
    }
}

fn causality() -> Causality {
    Causality {
        correlation_id: id("correlation_goal_1"),
        causation_id: Some(id("causation_turn_1")),
        trace_id: id("trace_full_1"),
    }
}

#[test]
fn ids_are_non_interchangeable_strings_and_reject_empty_values() {
    let project_id = ProjectId::new("project_alpha").unwrap();
    let workspace_id = WorkspaceId::new("project_alpha").unwrap();

    assert_eq!(
        serde_json::to_string(&project_id).unwrap(),
        "\"project_alpha\""
    );
    assert_eq!(workspace_id.as_str(), "project_alpha");
    assert!(serde_json::from_str::<ProjectId>("\"\"").is_err());
    assert!(serde_json::from_str::<WorkspaceId>("\" workspace \"").is_err());

    fn accepts_project(_: ProjectId) {}
    accepts_project(project_id);
    // `workspace_id` has the same serialized bytes, but a distinct Rust type.
    // Passing it to `accepts_project` would fail to compile.
    assert_eq!(
        serde_json::to_string(&workspace_id).unwrap(),
        "\"project_alpha\""
    );
}

#[test]
fn run_r_declares_workspace_mutation_and_non_idempotent_retry() {
    let descriptor = run_r_descriptor();

    assert_eq!(descriptor.id.as_str(), RUN_R_CAPABILITY);
    assert_eq!(descriptor.schema_version, CANONICAL_SCHEMA_VERSION);
    assert_eq!(RUN_R_EFFECT_CLASS, EffectClass::WorkspaceMutation);
    assert_eq!(RUN_R_RETRY_CLASS, RetryClass::NonIdempotent);
    assert_eq!(descriptor.effect_class, RUN_R_EFFECT_CLASS);
    assert_eq!(descriptor.retry_class, RUN_R_RETRY_CLASS);
    assert_eq!(descriptor.target_class, TargetClass::Workspace);
    assert_eq!(descriptor.allowed_executors, vec![ExecutorKind::Workspace]);
    assert!(descriptor.requires_workspace);
    assert_eq!(descriptor.input_schema["required"], json!(["code"]));
}

#[test]
fn unknown_schema_version_is_rejected_before_body_deserialization() {
    let payload = json!({
        "schema_version": 99,
        "body": {"not": "a capability descriptor"}
    });

    let error = decode_versioned_value::<CapabilityDescriptor>(payload).unwrap_err();
    assert!(matches!(
        error,
        VersionError::UnsupportedSchemaVersion {
            actual: 99,
            expected: CANONICAL_SCHEMA_VERSION,
        }
    ));
}

#[test]
fn canonical_event_records_causality_revisions_and_uncertain_outcome() {
    let result = OperationResult {
        operation_id: id("operation_exec_1"),
        outcome: OperationOutcome::Uncertain,
        reason: Some("desktop crashed after submit acknowledgement".to_string()),
    };
    let mut event = CanonicalEventEnvelope::new(
        id("event_1"),
        CanonicalEventType::ExecutionStateChanged,
        EventPriority::P1,
        id("stream_session_1"),
        StreamSeq(3),
        Actor {
            kind: ActorKind::Executor,
            id: "local-process".to_string(),
        },
        id("correlation_goal_1"),
        id("trace_full_1"),
        serde_json::to_value(result).unwrap(),
    );
    event.occurred_at = Utc.with_ymd_and_hms(2026, 8, 30, 0, 0, 0).unwrap();
    event.workspace_id = Some(id("workspace_main"));
    event.kernel_instance_id = Some(id("kernel_a"));
    event.operation_id = Some(id("operation_exec_1"));
    event.execution_id = Some(id("execution_1"));
    event.job_id = Some(id("job_1"));
    event.causation_id = Some(id("causation_submit_ack"));
    event.state_revision_before = Some(StateRevision(42));
    event.state_revision_after = Some(StateRevision(43));
    event.project_revision_before = Some(ProjectRevision(7));
    event.project_revision_after = Some(ProjectRevision(7));

    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["payload"]["outcome"], "uncertain");
    assert_eq!(value["state_revision_before"], 42);
    assert_eq!(value["state_revision_after"], 43);
    assert_eq!(value["causation_id"], "causation_submit_ack");
    assert_eq!(value["trace_id"], "trace_full_1");

    let decoded: CanonicalEventEnvelope = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.operation_id.unwrap().as_str(), "operation_exec_1");
}

#[test]
fn capability_request_carries_expected_revision_and_destination() {
    let request = CapabilityRequest::new(
        id(RUN_R_CAPABILITY),
        OperationContext {
            operation_id: id("operation_run_r_2"),
            expected_revisions: expected_revisions(),
            causality: causality(),
        },
        json!({"code": "summary(sce)"}),
    );

    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["schema_version"], CANONICAL_SCHEMA_VERSION);
    assert_eq!(value["capability_id"], RUN_R_CAPABILITY);
    assert_eq!(
        value["operation"]["expected_revisions"]["state_revision"],
        42
    );
    assert_eq!(value["destination"], "local_workspace");
}

#[test]
fn execution_spec_and_job_observation_represent_uncertain_as_terminal_truth() {
    let spec = ExecutionSpec::new(
        id("execution_1"),
        id("operation_exec_1"),
        ExecutorKind::LocalProcess,
        vec!["Rscript".to_string(), "analysis.R".to_string()],
    );
    let observation = JobObservation {
        job_id: id("job_1"),
        execution_id: spec.execution_id.clone(),
        state: ExecutionState::Uncertain,
        scheduler_id: None,
        message: Some("process supervisor crashed after submit".to_string()),
    };

    assert!(observation.state.is_terminal());
    assert_eq!(
        serde_json::to_value(observation).unwrap()["state"],
        "uncertain"
    );
}

#[test]
fn artifact_manifest_identity_is_digest_not_mutable_path() {
    let digest = ArtifactDigest::new(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    assert!(ArtifactDigest::new("analysis/output.png").is_err());

    let manifest = ArtifactManifest::new(
        id("artifact_1"),
        digest.clone(),
        128,
        "image/png",
        ArtifactProducer {
            run_id: Some(id("run_1")),
            execution_id: Some(id("execution_1")),
            job_id: Some(id("job_1")),
        },
        RevisionStamp {
            workspace_id: id("workspace_main"),
            kernel_instance_id: id("kernel_a"),
            state_revision: StateRevision(43),
            project_revision: ProjectRevision(7),
        },
    );

    let value = serde_json::to_value(manifest).unwrap();
    assert_eq!(value["digest"], digest.as_str());
    assert!(value.get("path").is_none());
    assert!(value.get("output_path").is_none());
}

#[test]
fn secret_ref_serializes_but_secret_value_is_redacted_and_not_a_contract_payload() {
    fn assert_serializable<T: Serialize>() {}
    assert_serializable::<SecretRef>();

    let secret_ref = SecretRef {
        schema_version: CANONICAL_SCHEMA_VERSION,
        secret_id: id("secret_provider_key"),
        purpose: SecretPurpose::ProviderCredential,
        provider: Some(id("provider_aisdk")),
        destination_scope: DestinationClass::ConfiguredProvider,
        expires_at: Some(Utc.with_ymd_and_hms(2026, 8, 30, 1, 0, 0).unwrap()),
    };
    let value = serde_json::to_value(secret_ref).unwrap();
    assert_eq!(value["secret_id"], "secret_provider_key");
    assert_eq!(value["destination_scope"], "configured_provider");
    assert!(value.get("value").is_none());

    let secret_value = SecretValue::new(b"do-not-serialize".to_vec());
    assert_eq!(format!("{secret_value:?}"), "SecretValue(REDACTED)");
    assert_eq!(secret_value.expose_to_secret_backend().len(), 16);
    // `SecretValue` intentionally does not implement Serialize/Deserialize/Clone.
    // Calling `assert_serializable::<SecretValue>()` would fail to compile.
}

#[test]
fn protocol_crate_has_no_adapter_or_runtime_dependencies() {
    let manifest = std::fs::read_to_string(format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR")))
        .expect("rho-protocol manifest is readable");
    let forbidden = [
        "rusqlite",
        "tauri",
        "tokio-rusqlite",
        "rho-agent-transport",
        "rho-server",
        "acp",
        "aisdk",
    ];
    for name in forbidden {
        assert!(
            !manifest.contains(name),
            "rho-protocol must not depend on adapter/runtime crate {name}"
        );
    }
}
