use crate::owner::Owner;
use rho_plugin_sdk::{ResourceClient, protocol::*, read_resource_header, write_resource_header};
use rho_process_api::{ProcessReport, ProcessRunRecovery, ProcessRunResult};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    sync::watch,
};

fn identity() -> InstanceRef {
    serde_json::from_value(json!({"plugin":"org.rho.process","instance":"process-test","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap()
}
fn query(id: &str, version: u32, arguments: Value) -> PluginCall {
    PluginCall {
        request: RequestId::new("request-query").unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new(id).unwrap(),
                version,
            },
            provider: identity(),
            project: ProjectId::new("project").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal").unwrap(),
        scopes: ["project.read".into(), "process.run_local".into()].into(),
        arguments,
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: None,
    }
}
fn prepare(owner: &Owner, id: &str, arguments: Value) -> PluginCall {
    let prepared = owner.query(&query("process.prepare_local", 2, json!({"capability":{"id":"process.run_local","version":2},"arguments":arguments,"target":null,"preconditions":null}))).unwrap();
    let mut call = query("process.run_local", 2, prepared["arguments"].clone());
    call.request = RequestId::new(format!("request-{id}")).unwrap();
    call.binding.target = Some(prepared["target"].as_str().unwrap().into());
    call.owner_context = prepared["owner_context"].clone();
    call.operation_id = Some(id.into());
    call
}
fn fixture() -> (tempfile::TempDir, Arc<Owner>, ResourceChannel) {
    let directory = tempfile::Builder::new()
        .prefix("rho-proc-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    let channel = ResourceChannel {
        version: 1,
        socket: root.join("put.sock").to_str().unwrap().into(),
        token: "a".repeat(64),
    };
    let owner = Owner::new(
        BackendEnvironment {
            project_root: root.to_str().unwrap().into(),
            data_root: root.to_str().unwrap().into(),
        },
        json!({}),
        ResourceClient::new(channel.clone()).unwrap(),
    )
    .unwrap();
    (directory, Arc::new(owner), channel)
}
fn settlement(call: &PluginCall, outcome: PluginOutcome) -> OperationSettlement {
    OperationSettlement {
        operation_id: OperationId::new(call.operation_id.as_ref().unwrap()).unwrap(),
        binding: call.binding.clone(),
        outcome,
    }
}

#[tokio::test]
async fn original_binary_report_uses_verified_resource_and_holds_native_settlement() {
    let (_directory, owner, channel) = fixture();
    let listener = UnixListener::bind(&channel.socket).unwrap();
    let text = "\0研究🙂".repeat(9000);
    let expected = text.as_bytes().to_vec();
    let call = prepare(
        &owner,
        "op_binary",
        json!({"program":"/bin/cat","stdin":text,"output_limit_bytes":131072}),
    );
    let parent = call.request.clone();
    let upload = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request: ResourceTransferRequest = read_resource_header(&mut socket).await.unwrap();
        assert_eq!(request.parent_request, parent);
        assert_eq!(request.token, channel.token);
        let ResourceTransfer::Put(declaration) = request.transfer else {
            panic!("expected original report")
        };
        let mut bytes = vec![];
        socket.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes.len() as u64, declaration.bytes);
        assert_eq!(
            declaration.digest.as_str(),
            format!("sha256:{:x}", Sha256::digest(&bytes))
        );
        let report: ProcessReport = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(report.stdout.bytes, expected);
        assert!(!report.stdout.truncated);
        assert!(report.stdout.eof);
        let reference = ResourceReference {
            owner: identity(),
            resource: ResourceId::new("report-one").unwrap(),
            digest: declaration.digest,
            media_type: declaration.media_type,
            bytes: declaration.bytes,
        };
        write_resource_header(
            &mut socket,
            &ResourceTransferResponse::Stored(reference.clone()),
        )
        .await
        .unwrap();
        socket.shutdown().await.unwrap();
        reference
    });
    owner.admit(&call).unwrap();
    let (_keep, cancellation) = watch::channel(false);
    let plan = owner.execute(&call, cancellation).await;
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    let result: ProcessRunResult = serde_json::from_value(plan.output.unwrap()).unwrap();
    assert_eq!(result.report, upload.await.unwrap());
    assert_eq!(plan.evidence, vec![result.report]);
    assert!(!owner.ready_to_release());
    assert!(
        owner
            .settle(&settlement(&call, PluginOutcome::Cancelled))
            .is_err()
    );
    let mut wrong = settlement(&call, PluginOutcome::Succeeded);
    wrong.binding.provider.instance = PluginInstanceId::new("other").unwrap();
    assert!(owner.settle(&wrong).is_err());
    owner
        .settle(&settlement(&call, PluginOutcome::Succeeded))
        .unwrap();
    assert!(owner.ready_to_release());
}

#[tokio::test]
async fn transfer_failure_preserves_evidence_and_waiting_cancel_never_starts_the_command() {
    let (directory, owner, _) = fixture();
    let first = prepare(
        &owner,
        "op_first",
        json!({"program":"/usr/bin/printf","args":["native captured"]}),
    );
    owner.admit(&first).unwrap();
    let (_keep, cancellation) = watch::channel(false);
    let plan = owner.execute(&first, cancellation).await;
    assert_eq!(plan.outcome, PluginOutcome::Uncertain);
    let recovery: ProcessRunRecovery = serde_json::from_value(plan.recovery.unwrap()).unwrap();
    assert!(!recovery.report_transfer_confirmed);
    assert!(!recovery.automatic_reexecution);
    assert_eq!(recovery.stdout.unwrap().bytes, b"native captured");
    assert!(recovery.report_digest.is_some());
    assert!(
        owner
            .settle(&settlement(&first, PluginOutcome::Succeeded))
            .is_err()
    );
    let marker = directory.path().join("must-not-start");
    let second = prepare(
        &owner,
        "op_second",
        json!({"program":"/usr/bin/touch","args":[marker]}),
    );
    owner.admit(&second).unwrap();
    let (cancel, cancellation) = watch::channel(false);
    let running = owner.clone();
    let captured = second.clone();
    let task = tokio::spawn(async move { running.execute(&captured, cancellation).await });
    tokio::task::yield_now().await;
    assert!(!marker.exists());
    let status = owner.query(&query("process.status", 1, json!({}))).unwrap();
    assert_eq!(status["activities"][0]["phase"], "awaiting_settlement");
    assert_eq!(status["activities"][1]["phase"], "waiting");
    cancel.send_replace(true);
    let cancelled = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.outcome, PluginOutcome::Cancelled);
    assert!(cancelled.cancellation_confirmed);
    assert!(!marker.exists());
    owner
        .settle(&settlement(&first, PluginOutcome::Uncertain))
        .unwrap();
    owner
        .settle(&settlement(&second, PluginOutcome::Cancelled))
        .unwrap();
    assert!(owner.ready_to_release());
}

#[test]
fn preflight_scopes_native_target_and_qualifications_are_not_caller_substitutable() {
    let (_directory, owner, _) = fixture();
    let call = prepare(
        &owner,
        "op_scope",
        json!({"program":"/usr/bin/printf","args":["no execution"]}),
    );
    for field in ["scope", "target", "context", "precondition"] {
        let mut changed = call.clone();
        match field {
            "scope" => {
                changed.scopes.remove("process.run_local");
            }
            "target" => changed.binding.target = Some("/".into()),
            "context" => changed.owner_context = Value::Null,
            _ => changed.preconditions = json!({"ignore":true}),
        }
        assert!(owner.admit(&changed).is_err());
    }
    assert!(owner.ready_to_release());
    let manifest = crate::manifest::manifest();
    manifest.validate().unwrap();
    assert!(manifest.views.is_empty());
    assert!(manifest.requires.is_empty());
}
