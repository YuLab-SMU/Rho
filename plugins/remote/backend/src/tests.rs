use crate::{
    owner::Owner,
    source::{self, Qualification},
};
use rho_plugin_sdk::{ResourceClient, protocol::*};
use rho_remote_api::*;
use serde_json::{Value, json};
use tokio::sync::watch;

fn identity() -> InstanceRef {
    serde_json::from_value(json!({"plugin":"org.rho.remote","instance":"new-remote","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap()
}
fn query(id: &str, arguments: Value) -> PluginCall {
    PluginCall {
        request: RequestId::new("query").unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new(id).unwrap(),
                version: if id == "remote.status" { 1 } else { 2 },
            },
            provider: identity(),
            project: ProjectId::new("project").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal").unwrap(),
        scopes: source::scopes(id),
        arguments,
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: None,
    }
}
fn fixture(configured: bool) -> (tempfile::TempDir, Owner) {
    let directory = tempfile::Builder::new()
        .prefix("rho-remote-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = directory
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let channel = ResourceChannel {
        version: 1,
        socket: format!("{root}/put.sock"),
        token: "a".repeat(64),
    };
    let target = configured.then(|| RemoteTarget {
        host_alias: "fixture".into(),
        project_root: "/scratch/project".into(),
        slurm_cluster: Some("cluster_a".into()),
    });
    let owner = Owner::new(
        BackendEnvironment {
            project_root: root.clone(),
            data_root: root,
        },
        json!(RemoteConfiguration { target }),
        ResourceClient::new(channel).unwrap(),
    )
    .unwrap();
    (directory, owner)
}
fn prepare_query(id: &str, operation: &str, arguments: Value) -> PluginCall {
    query(
        id,
        json!({"capability":{"id":operation,"version":2},"arguments":arguments,"target":null,"preconditions":null}),
    )
}
fn invocation(id: &str, operation: &str, prepared: Value) -> PluginCall {
    let mut call = query(operation, prepared["arguments"].clone());
    call.request = RequestId::new(format!("request-{id}")).unwrap();
    call.operation_id = Some(id.into());
    call.binding.target = Some(prepared["target"].as_str().unwrap().into());
    call.owner_context = prepared["owner_context"].clone();
    call
}
fn settle(call: &PluginCall, outcome: PluginOutcome) -> OperationSettlement {
    OperationSettlement {
        operation_id: OperationId::new(call.operation_id.clone().unwrap()).unwrap(),
        binding: call.binding.clone(),
        outcome,
    }
}
fn original(owner: &Owner) -> Value {
    let prepared = owner
        .query(&prepare_query(
            "slurm.prepare_submit",
            source::SUBMIT,
            json!({"body":"printf hello"}),
        ))
        .unwrap();
    let mut call = invocation("original-submission", source::SUBMIT, prepared);
    call.binding.provider.instance = PluginInstanceId::new("old-remote").unwrap();
    call.binding.provider.revision = RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap();
    json!({"status":"ready","completeness":"complete","data":{"record":{"status":"uncertain","operation":{
        "operation_id":call.operation_id,"idempotency_scope":call.owner_context["project_root"],"capability":call.binding.capability,
        "normalized_arguments":{"binding":call.binding,"arguments":call.arguments},
        "admission":{"owner_context":{"binding":call.binding,"qualification":call.owner_context}}
    }}}})
}
#[test]
fn default_instance_is_disconnected_and_manifest_has_no_privileged_path() {
    let manifest = crate::manifest::manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.default_configuration, json!({"target":null}));
    assert_eq!(manifest.capabilities.len(), 10);
    assert_eq!(manifest.requires.len(), 1);
    let (_directory, owner) = fixture(false);
    let status = owner.query(&query("remote.status", json!({}))).unwrap();
    assert!(status["target"].is_null());
    assert!(status["target_key"].is_null());
    assert_eq!(status["activities"], json!([]));
    assert!(
        owner
            .query(&prepare_query(
                source::PREPARE_RUN,
                source::RUN,
                json!({"program":"printf"})
            ))
            .is_err()
    );
    assert!(owner.ready_to_release());
}
#[tokio::test]
async fn preflight_captures_target_and_settlement_cannot_promote_or_retarget() {
    let (_directory, owner) = fixture(true);
    let prepare = prepare_query(
        source::PREPARE_RUN,
        source::RUN,
        json!({"program":"printf","args":["literal"]}),
    );
    let prepared = owner.query(&prepare).unwrap();
    assert!(
        prepared["target"]
            .as_str()
            .unwrap()
            .starts_with("ssh:sha256:")
    );
    let mut missing = prepare.clone();
    missing.scopes.remove("remote.execute");
    assert!(owner.query(&missing).is_err());
    let call = invocation("cancel-before-start", source::RUN, prepared);
    let mut altered = call.clone();
    altered.owner_context["remote_target"]["host_alias"] = json!("foreign");
    assert!(owner.admit(&altered).is_err());
    let mut extra = call.clone();
    extra.arguments["host_alias"] = json!("foreign");
    assert!(owner.admit(&extra).is_err());
    owner.admit(&call).unwrap();
    assert!(owner.admit(&call).is_err());
    assert!(
        owner
            .settle(&settle(&call, PluginOutcome::Cancelled))
            .is_err()
    );
    let plan = owner.execute(&call, watch::channel(true).1).await;
    assert_eq!(plan.outcome, PluginOutcome::Cancelled);
    assert!(plan.cancellation_confirmed);
    assert!(!owner.ready_to_release());
    assert!(
        owner
            .settle(&settle(&call, PluginOutcome::Succeeded))
            .is_err()
    );
    let mut foreign = settle(&call, PluginOutcome::Cancelled);
    foreign.binding.provider.instance = PluginInstanceId::new("replacement").unwrap();
    assert!(owner.settle(&foreign).is_err());
    owner
        .settle(&settle(&call, PluginOutcome::Cancelled))
        .unwrap();
    assert!(owner.ready_to_release());
}
#[tokio::test]
async fn unsupported_scheduler_cancellation_still_exits_before_work_on_channel_loss() {
    let (_directory, owner) = fixture(true);
    let prepared = owner
        .query(&prepare_query(
            "slurm.prepare_submit",
            source::SUBMIT,
            json!({"body":"printf hello"}),
        ))
        .unwrap();
    let call = invocation("not-started", source::SUBMIT, prepared);
    owner.admit(&call).unwrap();
    let plan = owner.execute(&call, watch::channel(true).1).await;
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    assert!(!plan.cancellation_confirmed);
    assert!(plan.output.is_none());
    owner.settle(&settle(&call, PluginOutcome::Failed)).unwrap();
    assert!(owner.ready_to_release());
}
#[tokio::test]
async fn old_submission_scope_survives_a_new_instance_without_rewriting_source() {
    let (_directory, owner) = fixture(true);
    let observation = original(&owner);
    let call = prepare_query(
        "slurm.prepare_reconcile",
        source::RECONCILE,
        json!({"submission_operation_id":"original-submission"}),
    );
    let prepared = owner
        .complete_source(&call, observation.clone())
        .await
        .unwrap();
    let qualification: Qualification =
        serde_json::from_value(prepared["owner_context"].clone()).unwrap();
    assert_eq!(
        qualification
            .source
            .unwrap()
            .binding
            .provider
            .instance
            .as_str(),
        "old-remote"
    );
    assert_eq!(observation["data"]["record"]["status"], "uncertain");
    let mut invoke = invocation("new-recovery", source::RECONCILE, prepared);
    invoke.arguments["submission_operation_id"] = json!("substitute");
    assert!(owner.admit(&invoke).is_err());
}
#[tokio::test]
async fn active_originals_are_read_only_busy_and_cannot_qualify_mutations() {
    let (_directory, owner) = fixture(true);
    let mut observation = original(&owner);
    observation["data"]["record"]["status"] = json!("running");
    let snapshot = query(
        source::SNAPSHOT,
        json!({"submission_operation_id":"original-submission"}),
    );
    let read = owner
        .complete_source(&snapshot, observation.clone())
        .await
        .unwrap();
    assert_eq!(read["status"], "busy");
    assert!(read["lookup"].is_null());
    let mutation = prepare_query("slurm.prepare_cancel", source::CANCEL, snapshot.arguments);
    assert!(owner.complete_source(&mutation, observation).await.is_err());
}
#[tokio::test]
async fn malformed_foreign_or_unqualified_sources_never_reach_native_work() {
    let (_directory, owner) = fixture(true);
    let original = original(&owner);
    let call = prepare_query(
        "slurm.prepare_cancel",
        source::CANCEL,
        json!({"submission_operation_id":"original-submission"}),
    );
    for (pointer, replacement) in [
        ("/status", json!("unavailable")),
        ("/completeness", json!("partial")),
        ("/data/record", Value::Null),
        ("/data/record/operation/operation_id", json!("other")),
        (
            "/data/record/operation/idempotency_scope",
            json!("/foreign"),
        ),
        ("/data/record/operation/capability/version", json!(1)),
        (
            "/data/record/operation/normalized_arguments/binding/project",
            json!("foreign"),
        ),
        (
            "/data/record/operation/normalized_arguments/binding/provider/plugin",
            json!("org.other.remote"),
        ),
        (
            "/data/record/operation/normalized_arguments/binding/target",
            json!("another-target"),
        ),
        (
            "/data/record/operation/admission/owner_context/qualification/remote_target/host_alias",
            json!("foreign"),
        ),
        (
            "/data/record/operation/admission/owner_context/qualification/remote_target/slurm_cluster",
            json!("foreign"),
        ),
        (
            "/data/record/operation/admission/owner_context/binding/provider/instance",
            json!("replacement"),
        ),
        (
            "/data/record/operation/normalized_arguments/arguments/body",
            json!(""),
        ),
    ] {
        let mut observation = original.clone();
        *observation.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            owner.complete_source(&call, observation).await.is_err(),
            "accepted {pointer}"
        );
    }
    let mut missing = call.clone();
    missing.scopes.remove("operation.read");
    assert!(owner.source_request(&missing).is_err());
    let mut supplied = call;
    supplied.arguments["arguments"]["job_id"] = json!("42");
    assert!(owner.source_request(&supplied).is_err());
    assert!(owner.ready_to_release());
}
