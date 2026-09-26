use crate::{host_reads::HostReads, owner::Owner, source};
use rho_environment_api::*;
use rho_plugin_sdk::{ResourceClient, protocol::*};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
fn identity() -> InstanceRef {
    serde_json::from_value(json!({"plugin":"org.rho.environment","instance":"current","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap()
}
fn query(id: &str, args: Value) -> PluginCall {
    PluginCall {
        request: RequestId::new("query").unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new(id).unwrap(),
                version: if id == source::STATUS { 1 } else { 2 },
            },
            provider: identity(),
            project: ProjectId::new("project").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal").unwrap(),
        scopes: source::scopes(id),
        arguments: args,
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: None,
    }
}
fn prepare(operation: &str, args: Value) -> PluginCall {
    query(
        &format!(
            "environment.prepare_{}",
            operation.strip_prefix("environment.").unwrap()
        ),
        json!({"capability":{"id":operation,"version":2},"arguments":args,"target":null,"preconditions":null}),
    )
}
fn invoke(id: &str, operation: &str, prepared: Value) -> PluginCall {
    let mut call = query(operation, prepared["arguments"].clone());
    call.request = RequestId::new(format!("request-{id}")).unwrap();
    call.operation_id = Some(id.into());
    call.binding.target = Some(prepared["target"].as_str().unwrap().into());
    call.owner_context = prepared["owner_context"].clone();
    call
}
fn settlement(call: &PluginCall, outcome: PluginOutcome) -> OperationSettlement {
    OperationSettlement {
        operation_id: OperationId::new(call.operation_id.clone().unwrap()).unwrap(),
        binding: call.binding.clone(),
        outcome,
    }
}
fn fixture(
    configured: bool,
) -> (
    tempfile::TempDir,
    Owner,
    mpsc::Receiver<crate::host_reads::ReadRequest>,
) {
    let directory = tempfile::Builder::new()
        .prefix("rho-environment-rpc-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("materials")).unwrap();
    let rscript = root.join("Rscript");
    std::fs::write(&rscript, b"must never execute in these tests").unwrap();
    let (sender, receiver) = mpsc::channel(32);
    let owner = Owner::new(
        BackendEnvironment {
            project_root: root.to_str().unwrap().into(),
            data_root: root.join("materials").to_str().unwrap().into(),
        },
        json!(EnvironmentConfiguration {
            rscript: configured.then(|| rscript.to_str().unwrap().into()),
            ..Default::default()
        }),
        ResourceClient::new(ResourceChannel {
            version: 1,
            socket: root.join("absent.sock").to_str().unwrap().into(),
            token: "a".repeat(64),
        })
        .unwrap(),
        HostReads(sender),
    )
    .unwrap();
    (directory, owner, receiver)
}
async fn original(owner: &Owner) -> Value {
    let prepared = owner
        .query(&prepare(
            source::PLAN,
            json!({"manager":"pak","packages":["local::pkg"]}),
        ))
        .await
        .unwrap();
    let mut call = invoke("original-plan", source::PLAN, prepared);
    call.binding.provider.instance = PluginInstanceId::new("previous").unwrap();
    call.binding.provider.revision = RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap();
    let reference = json!({"owner":call.binding.provider,"resource":"plan-resource","digest":format!("sha256:{}","d".repeat(64)),"media_type":"application/json","bytes":128});
    json!({"status":"ready","completeness":"complete","data":{"record":{"status":"succeeded","output":{"operation":"original-plan","kind":"plan","report":reference,"verified":null},"operation":{
        "operation_id":call.operation_id,"idempotency_scope":call.owner_context["scope"]["project_root"],"capability":call.binding.capability,
        "normalized_arguments":{"binding":call.binding,"arguments":call.arguments},"admission":{"owner_context":{"binding":call.binding,"qualification":call.owner_context}}
    }}}})
}
#[tokio::test]
async fn disconnected_activation_and_native_queries_do_not_start_r() {
    let manifest = crate::manifest::manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.capabilities.len(), 13);
    assert_eq!(manifest.requires.len(), 2);
    let (_directory, owner, _reads) = fixture(false);
    let status = owner
        .query(&query(source::STATUS, json!({})))
        .await
        .unwrap();
    assert!(status["target_key"].is_null());
    assert!(
        owner
            .query(&prepare(source::REFRESH, json!({})))
            .await
            .is_err()
    );
    let (directory, owner, _reads) = fixture(true);
    let before = std::fs::read(directory.path().join("Rscript")).unwrap();
    let observation = owner
        .query(&query(source::OBSERVE, json!({})))
        .await
        .unwrap();
    assert_eq!(observation["status"], "unavailable");
    assert!(observation["observation"].is_null());
    assert_eq!(
        std::fs::read(directory.path().join("Rscript")).unwrap(),
        before
    );
    assert!(!directory.path().join("materials/recovery").exists());
    let mut denied = query(source::OBSERVE, json!({}));
    denied.scopes.remove("environment.read");
    assert!(owner.query(&denied).await.is_err());
}
#[tokio::test]
async fn admission_and_settlement_pin_target_and_original_cancellation() {
    let (_directory, owner, _reads) = fixture(true);
    let prepared = owner
        .query(&prepare(
            source::PLAN,
            json!({"manager":"pak","packages":["local::pkg"]}),
        ))
        .await
        .unwrap();
    let call = invoke("cancel-before-start", source::PLAN, prepared);
    let mut changed = call.clone();
    changed.owner_context["scope"]["storage_root"] = json!("/other");
    assert!(owner.admit(&changed).is_err());
    owner.admit(&call).unwrap();
    assert!(owner.admit(&call).is_err());
    assert!(
        owner
            .settle(&settlement(&call, PluginOutcome::Cancelled))
            .is_err()
    );
    let result = owner.execute(&call, watch::channel(true).1).await;
    assert_eq!(result.outcome, PluginOutcome::Cancelled);
    assert!(result.cancellation_confirmed);
    assert!(!owner.ready_to_release());
    assert!(
        owner
            .settle(&settlement(&call, PluginOutcome::Succeeded))
            .is_err()
    );
    let mut wrong = settlement(&call, PluginOutcome::Cancelled);
    wrong.binding.provider.instance = PluginInstanceId::new("other").unwrap();
    assert!(owner.settle(&wrong).is_err());
    owner
        .settle(&settlement(&call, PluginOutcome::Cancelled))
        .unwrap();
    assert!(owner.ready_to_release());
}
#[tokio::test]
async fn source_qualification_preserves_previous_instance_and_refuses_substitutions() {
    let (_directory, owner, _reads) = fixture(true);
    let record = original(&owner).await;
    let call = prepare(
        source::REALIZE,
        json!({"plan_operation_id":"original-plan"}),
    );
    assert_eq!(
        owner.source_request(&call).unwrap().unwrap().as_str(),
        "original-plan"
    );
    let prepared = owner.complete_source(&call, record.clone()).await.unwrap();
    assert_eq!(
        prepared["owner_context"]["source"]["binding"]["provider"]["instance"],
        "previous"
    );
    let mut changed = invoke("new-realize", source::REALIZE, prepared.clone());
    changed.arguments["plan_operation_id"] = json!("another-plan");
    assert!(owner.admit(&changed).is_err());
    let original = invoke("new-realize", source::REALIZE, prepared);
    owner.admit(&original).unwrap();
    let result = owner.execute(&original, watch::channel(true).1).await;
    assert_eq!(result.outcome, PluginOutcome::Cancelled);
    owner
        .settle(&settlement(&original, PluginOutcome::Cancelled))
        .unwrap();
    for (pointer, value) in [
        ("/status", json!("unavailable")),
        ("/completeness", json!("partial")),
        ("/data/record/status", json!("uncertain")),
        ("/data/record/operation/operation_id", json!("another-plan")),
        ("/data/record/operation/idempotency_scope", json!("/other")),
        (
            "/data/record/operation/admission/owner_context/qualification/scope/storage_root",
            json!("/other"),
        ),
        ("/data/record/output/operation", json!("another-plan")),
        ("/data/record/output/kind", json!("realization")),
        (
            "/data/record/output/report/owner/instance",
            json!("substitute"),
        ),
        ("/data/record/output/report/bytes", json!(4194305)),
    ] {
        let mut invalid = record.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(
            owner.complete_source(&call, invalid).await.is_err(),
            "accepted {pointer}"
        );
    }
}
#[tokio::test]
async fn channel_loss_abandons_unsupported_reconciliation_before_native_recovery() {
    let (_directory, owner, _reads) = fixture(true);
    let mut record = original(&owner).await;
    record["data"]["record"]["status"] = json!("uncertain");
    record["data"]["record"]["output"] = Value::Null;
    let call = prepare(source::RECONCILE, json!({"operation_id":"original-plan"}));
    let prepared = owner.complete_source(&call, record.clone()).await.unwrap();
    let call = invoke("new-recovery", source::RECONCILE, prepared);
    owner.admit(&call).unwrap();
    let result = owner.execute(&call, watch::channel(true).1).await;
    assert_eq!(result.outcome, PluginOutcome::Failed);
    assert!(!result.cancellation_confirmed);
    owner
        .settle(&settlement(&call, PluginOutcome::Failed))
        .unwrap();
    record["data"]["record"]["status"] = json!("reconciling");
    assert!(
        owner
            .complete_source(
                &prepare(source::RECONCILE, json!({"operation_id":"original-plan"})),
                record
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn source_resources_use_scoped_host_pages_and_reject_incomplete_or_changed_bytes() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    for fault in ["none", "offset", "digest", "partial", "cancel", "directory"] {
        let (directory, owner, mut reads) = fixture(true);
        let mut record = original(&owner).await;
        // A valid bounded report from another instance, deliberately belonging to
        // another native project: even the good transfer stops before launching R.
        let bytes=serde_json::to_vec(&json!({"project_root":"/foreign","manager":"pak","lock_path":"/missing","lock_digest":"unused","r_version":"4.5","platform":"fixture","packages":[],"local_sources":[],"padding":"x".repeat(300000)})).unwrap();
        record["data"]["record"]["output"]["report"]["bytes"] = json!(bytes.len());
        record["data"]["record"]["output"]["report"]["digest"] =
            json!(format!("sha256:{:x}", Sha256::digest(&bytes)));
        let prepared = owner
            .complete_source(
                &prepare(
                    source::REALIZE,
                    json!({"plan_operation_id":"original-plan"}),
                ),
                record,
            )
            .await
            .unwrap();
        let call = invoke("read-original", source::REALIZE, prepared);
        owner.admit(&call).unwrap();
        let (cancel, cancellation) = watch::channel(false);
        let respond = async {
            let count = if matches!(fault, "offset" | "partial") {
                1
            } else {
                2
            };
            for index in 0..count {
                let read = reads.recv().await.unwrap();
                if fault == "cancel" {
                    cancel.send_replace(true);
                }
                assert_eq!(read.parent, call.request);
                assert_eq!(read.capability.id.as_str(), "resources.read");
                let offset = read.arguments["offset"].as_u64().unwrap() as usize;
                assert_eq!(offset, index * MAX_RESOURCE_READ_BYTES as usize);
                assert_eq!(read.arguments["reference"]["owner"]["instance"], "previous");
                let end = (offset + MAX_RESOURCE_READ_BYTES as usize).min(bytes.len());
                let mut chunk = bytes[offset..end].to_vec();
                if fault == "directory" && index == 1 {
                    let root = directory.path().canonicalize().unwrap();
                    std::fs::rename(root.join("materials"), root.join("moved-materials")).unwrap();
                    std::fs::create_dir(root.join("materials")).unwrap();
                    std::fs::rename(
                        root.join("moved-materials/.rho-environment-owner.lock"),
                        root.join("materials/.rho-environment-owner.lock"),
                    )
                    .unwrap();
                }
                if fault == "digest" {
                    chunk[0] = b'!';
                }
                read.reply.send(Ok(json!({"status":"ready","completeness":if fault=="partial" {"partial"} else {"complete"},"data":{
                    "reference":read.arguments["reference"],"offset":if fault=="offset" {offset+1}else{offset},"base64":base64::engine::general_purpose::STANDARD.encode(chunk),"next":(end<bytes.len()).then_some(end)
                }}))).unwrap();
            }
        };
        let (result, ()) = tokio::join!(owner.execute(&call, cancellation), respond);
        let expected = if fault == "cancel" {
            PluginOutcome::Cancelled
        } else {
            PluginOutcome::Failed
        };
        assert_eq!(result.outcome, expected);
        assert_eq!(result.cancellation_confirmed, fault == "cancel");
        assert!(
            result.error.as_ref().unwrap().contains(match fault {
                "none" => "another project",
                "offset" => "chunk changed",
                "digest" => "digest changed",
                "cancel" => "before consuming",
                "directory" => "directory was replaced",
                _ => "incomplete",
            }),
            "{result:?}"
        );
        owner.settle(&settlement(&call, expected)).unwrap();
    }
}
#[tokio::test]
async fn lost_resource_ack_preserves_uncertainty_and_lane_until_original_settlement() {
    let (_directory, owner, _reads) = fixture(true);
    let mut record = original(&owner).await;
    record["data"]["record"]["status"] = json!("uncertain");
    record["data"]["record"]["output"] = Value::Null;
    let prepared = owner
        .complete_source(
            &prepare(source::RECONCILE, json!({"operation_id":"original-plan"})),
            record,
        )
        .await
        .unwrap();
    let call = invoke("native-inspection", source::RECONCILE, prepared);
    owner.admit(&call).unwrap();
    // No native marker exists. Inspection returns an unconfirmed report without
    // starting R; its resource transport intentionally has no listener.
    let result = owner.execute(&call, watch::channel(false).1).await;
    assert_eq!(result.outcome, PluginOutcome::Uncertain);
    assert!(result.output.is_none());
    assert_eq!(
        result.recovery.as_ref().unwrap()["automatic_reexecution"],
        false
    );
    assert_eq!(
        owner
            .query(&query(source::OBSERVE, json!({})))
            .await
            .unwrap()["status"],
        "busy"
    );
    assert!(
        owner
            .settle(&settlement(&call, PluginOutcome::Succeeded))
            .is_err()
    );
    owner
        .settle(&settlement(&call, PluginOutcome::Uncertain))
        .unwrap();
    assert_eq!(
        owner
            .query(&query(source::OBSERVE, json!({})))
            .await
            .unwrap()["status"],
        "unavailable"
    );
}

#[tokio::test]
async fn library_selection_checks_current_bytes_and_keeps_original_and_current_providers() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (directory, owner, mut reads) = fixture(true);
    let root = directory.path().canonicalize().unwrap();
    let library = root.join("materials/realized-library");
    std::fs::create_dir(&library).unwrap();
    let mut observation = original(&owner).await;
    let record = &mut observation["data"]["record"];
    let mut binding = record["operation"]["normalized_arguments"]["binding"].clone();
    binding["capability"]["id"] = json!(source::REALIZE);
    record["operation"]["operation_id"] = json!("original-realization");
    record["operation"]["capability"] = binding["capability"].clone();
    record["operation"]["normalized_arguments"] =
        json!({"binding":binding,"arguments":{"plan_operation_id":"original-plan"}});
    record["operation"]["admission"]["owner_context"]["binding"] = binding.clone();
    let receipt = json!({"project_root":root,"plan_operation_id":"original-plan","manager":"pak","lock_digest":"unused","library_path":library,"library_digest":format!("sha256:{:x}",Sha256::digest([])),"renv_lockfile":"unused","r_version":"4.5","platform":"fixture","packages":[],"probes":[],"verified":true,"restart_required":true,"activation":"available_not_active"});
    let bytes = serde_json::to_vec(&receipt).unwrap();
    let reference = json!({"owner":binding["provider"],"resource":"realization-resource","digest":format!("sha256:{:x}",Sha256::digest(&bytes)),"media_type":"application/json","bytes":bytes.len()});
    record["output"] = json!({"operation":"original-realization","kind":"realization","report":reference,"verified":true});
    let call = query(
        source::LIBRARY,
        json!({"realization_operation_id":"original-realization"}),
    );
    assert_eq!(
        owner.source_request(&call).unwrap().unwrap().as_str(),
        "original-realization"
    );
    for changed in [false, true] {
        if changed {
            std::fs::write(library.join("changed"), "new content").unwrap();
        }
        let respond = async {
            let request = reads.recv().await.unwrap();
            assert_eq!(request.capability.id.as_str(), "resources.read");
            assert_eq!(request.arguments["reference"], reference);
            request.reply.send(Ok(json!({"status":"ready","completeness":"complete","data":{"reference":reference,"offset":0,"next":null,"base64":base64::engine::general_purpose::STANDARD.encode(&bytes)}}))).unwrap();
        };
        let (result, ()) = tokio::join!(owner.complete_source(&call, observation.clone()), respond);
        if changed {
            assert!(result.unwrap_err().contains("bytes changed"));
        } else {
            let selected: EnvironmentLibrary = serde_json::from_value(result.unwrap()).unwrap();
            assert_eq!(selected.binding.provider, identity());
            assert_eq!(selected.source.provider.instance.as_str(), "previous");
            assert_eq!(selected.report.owner, selected.source.provider);
            assert_eq!(selected.realization.as_str(), "original-realization");
            assert_eq!(selected.binding.target, selected.source.target);
            assert_eq!(selected.library_path, library.to_str().unwrap());
        }
    }
    assert!(
        !root.join("materials/recovery").exists(),
        "Selection must never start native R"
    );
}
