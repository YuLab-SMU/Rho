use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::*;
use serde_json::json;

fn fixture() -> ExecutionSpec {
    decode_execution_spec_v1(
        include_bytes!("fixtures/execution-spec-v1.json"),
        &BTreeSet::new(),
    )
    .unwrap()
}

#[test]
fn execution_spec_v1_golden_fixture_validates_and_digest_is_stable() {
    let spec = fixture();
    assert_eq!(spec.schema_version, EXECUTION_SPEC_V1);
    assert_eq!(spec.executor, ExecutorKind::LocalProcess);
    assert_eq!(spec.retry_class, RetryClass::NonIdempotent);
    let digest = spec.digest(&BTreeSet::new()).unwrap();
    assert!(digest.as_str().starts_with("sha256:"));
    assert_eq!(digest, spec.digest(&BTreeSet::new()).unwrap());
}

#[test]
fn execution_spec_digest_ignores_json_field_order_input_and_normalizes_path_representation() {
    let spec = fixture();
    let reordered = json!({
        "submit_semantics": "query_operation_marker_after_ack_loss",
        "prepare_semantics": "safe_to_retry_before_spawn",
        "retry_class": "non_idempotent",
        "provenance": spec.provenance,
        "expected_outputs": spec.expected_outputs,
        "resources": spec.resources,
        "network": "deny",
        "environment": spec.environment,
        "working_set": spec.working_set,
        "argv": spec.argv,
        "executor": "local_process",
        "idempotency_key": spec.idempotency_key,
        "operation_id": spec.operation_id,
        "execution_id": spec.execution_id,
        "schema_version": 1
    });
    let decoded =
        decode_execution_spec_v1(&serde_json::to_vec(&reordered).unwrap(), &BTreeSet::new())
            .unwrap();
    let mut path_variant = decoded.clone();
    path_variant.working_set.relative_working_directory = Some("./analysis//".to_string());
    path_variant.expected_outputs[0].path_hint = "./results//summary.json".to_string();
    assert_eq!(
        decoded.digest(&BTreeSet::new()).unwrap(),
        path_variant.digest(&BTreeSet::new()).unwrap()
    );
}

#[test]
fn execution_spec_contains_secret_refs_not_values_host_paths_shell_scripts_or_acp_types() {
    let mut spec = fixture();
    spec.environment.secret_env.push(EnvVarRef {
        name: "PROVIDER_TOKEN".to_string(),
        secret_ref: SecretRef::new(
            SecretId::new("secret_execution").unwrap(),
            SecretPurpose::ProviderCredential,
            DestinationClass::ConfiguredProvider,
        ),
    });
    let encoded = serde_json::to_string(&spec).unwrap();
    assert!(encoded.contains("secret_execution"));
    for forbidden in [
        "CANARY_PLAINTEXT_SECRET",
        "host_project_path",
        "/Users/example/project",
        "acp_method",
        "login_script",
        "shell_command",
    ] {
        assert!(
            !encoded
                .to_ascii_lowercase()
                .contains(&forbidden.to_ascii_lowercase())
        );
    }
    spec.working_set.relative_working_directory = Some("/Users/example/project".to_string());
    assert_eq!(
        spec.validate(&BTreeSet::new()).unwrap_err(),
        ExecutionSpecError::UnsafePath
    );
}

#[test]
fn execution_spec_unknown_fields_extensions_versions_depth_and_sizes_fail_closed() {
    let mut unknown_field: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/execution-spec-v1.json")).unwrap();
    unknown_field["draft_v2_field"] = json!(true);
    assert_eq!(
        decode_execution_spec_v1(
            &serde_json::to_vec(&unknown_field).unwrap(),
            &BTreeSet::new()
        )
        .unwrap_err(),
        ExecutionSpecError::Encoding
    );

    let mut spec = fixture();
    spec.schema_version = 2;
    assert_eq!(
        spec.validate(&BTreeSet::new()).unwrap_err(),
        ExecutionSpecError::Version(2)
    );
    let mut spec = fixture();
    spec.extensions = BTreeMap::from([("scheduler.experimental".to_string(), json!({"x":1}))]);
    assert_eq!(
        spec.validate(&BTreeSet::new()).unwrap_err(),
        ExecutionSpecError::UnknownExtension("scheduler.experimental".to_string())
    );
    spec.validate(&BTreeSet::from(["scheduler.experimental".to_string()]))
        .unwrap();

    let mut deep = json!(null);
    for _ in 0..=MAX_EXECUTION_JSON_DEPTH {
        deep = json!({"nested":deep});
    }
    spec.extensions
        .insert("scheduler.experimental".to_string(), deep);
    assert_eq!(
        spec.validate(&BTreeSet::from(["scheduler.experimental".to_string()]))
            .unwrap_err(),
        ExecutionSpecError::DepthBounds
    );
    assert_eq!(
        decode_execution_spec_v1(&vec![b'x'; MAX_EXECUTION_SPEC_BYTES + 1], &BTreeSet::new())
            .unwrap_err(),
        ExecutionSpecError::ByteBounds
    );
}

#[test]
fn execution_spec_resource_partition_account_and_count_bounds_are_explicit() {
    let mut spec = fixture();
    spec.resources.as_mut().unwrap().partition = Some("bad partition; rm".to_string());
    assert_eq!(
        spec.validate(&BTreeSet::new()).unwrap_err(),
        ExecutionSpecError::ResourceRequest
    );
    let mut spec = fixture();
    spec.argv = (0..=MAX_EXECUTION_ARGV_ITEMS)
        .map(|index| format!("arg_{index}"))
        .collect();
    assert_eq!(
        spec.validate(&BTreeSet::new()).unwrap_err(),
        ExecutionSpecError::ArgvBounds
    );
}
