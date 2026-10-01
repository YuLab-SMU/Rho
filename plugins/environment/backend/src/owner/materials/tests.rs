use super::*;
use crate::tests::{fixture, invoke, original, query, settlement};

#[tokio::test]
async fn material_queries_require_original_scope_and_preserve_unconfirmed_native_files() {
    let (directory, owner, mut reads) = fixture(true);
    let original = original(&owner).await;
    let stage = owner
        .native()
        .unwrap()
        .material_reference_paths("original-plan", MaterialKind::Plan, None)
        .unwrap()
        .remove(0);
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(Path::new(&stage).join("retained"), "original bytes").unwrap();
    let call = query(source::RETENTION, json!({"operation_id":"original-plan"}));
    assert_eq!(
        owner.source_request(&call).unwrap().unwrap().as_str(),
        "original-plan"
    );
    for status in [
        "succeeded",
        "accepted",
        "running",
        "uncertain",
        "failed",
        "cancelled",
    ] {
        let mut record = original.clone();
        record["data"]["record"]["status"] = json!(status);
        let view: RetentionView =
            serde_json::from_value(owner.complete_source(&call, record).await.unwrap()).unwrap();
        assert!(!view.can_quarantine && !view.can_restore && !view.can_purge);
        assert_eq!(view.material.stage.as_ref().unwrap().path, stage);
        assert!(
            view.retained_reasons
                .iter()
                .any(|reason| reason.contains("native reference"))
        );
        if !matches!(status, "failed" | "cancelled") {
            assert!(
                view.retained_reasons
                    .iter()
                    .any(|reason| reason.contains("uncertain recovery"))
            );
        }
    }
    for changed in ["project", "scope", "binding", "identity", "version"] {
        let mut record = original.clone();
        let op = &mut record["data"]["record"]["operation"];
        match changed {
            "project" => op["idempotency_scope"] = json!("/another"),
            "scope" => {
                op["admission"]["owner_context"]["qualification"]["scope"]["storage_root"] =
                    json!("/another")
            }
            "binding" => {
                op["admission"]["owner_context"]["binding"]["provider"]["instance"] =
                    json!("another")
            }
            "identity" => op["operation_id"] = json!("another"),
            _ => {
                op["capability"]["version"] = json!(1);
                op["normalized_arguments"]["binding"]["capability"]["version"] = json!(1);
                op["admission"]["owner_context"]["binding"]["capability"]["version"] = json!(1);
            }
        }
        assert!(
            owner.complete_source(&call, record).await.is_err(),
            "{changed}"
        );
    }
    assert!(
        reads.try_recv().is_err(),
        "A known retention reason needs no broader reference reads"
    );
    assert!(!directory.path().join("materials/recovery").exists());
    assert_eq!(
        std::fs::read_to_string(Path::new(&stage).join("retained")).unwrap(),
        "original bytes"
    );
}

#[tokio::test]
async fn changed_material_source_is_refused_before_native_effect_and_settlement_is_preserved() {
    let (_directory, owner, mut reads) = fixture(true);
    let mut record = original(&owner).await;
    record["data"]["record"]["status"] = json!("failed");
    let args = json!({"operation_id":"original-plan","expected_fingerprint":format!("sha256:{}","0".repeat(64))});
    let observing = query(source::RETENTION, json!({"operation_id":"original-plan"}));
    let qualified = owner
        .material_source(&observing, source::CLEANUP, &args, record.clone())
        .await
        .unwrap();
    let prepared = json!(PluginPreflightResult {
        arguments: args,
        target: owner.target.clone(),
        owner_context: json!(qualified)
    });
    let call = invoke("quarantine", source::CLEANUP, prepared);
    owner.admit(&call).unwrap();
    let responder = tokio::spawn(async move {
        let request = reads.recv().await.unwrap();
        assert_eq!(request.capability.id.as_str(), "operation.get");
        assert_eq!(request.arguments["operation_id"], "original-plan");
        record["data"]["record"]["status"] = json!("succeeded");
        request.reply.send(Ok(record)).unwrap();
    });
    let result = owner.execute(&call, watch::channel(false).1).await;
    responder.await.unwrap();
    assert_eq!(result.outcome, PluginOutcome::Failed);
    assert!(
        result
            .error
            .as_deref()
            .unwrap()
            .contains("qualification changed")
    );
    assert!(!result.cancellation_confirmed);
    assert!(!owner.ready_to_release());
    assert!(
        owner
            .settle(&settlement(&call, PluginOutcome::Succeeded))
            .is_err()
    );
    owner
        .settle(&settlement(&call, PluginOutcome::Failed))
        .unwrap();
    assert!(owner.ready_to_release());
}

#[tokio::test]
async fn original_uncertain_quarantine_requires_the_same_admitted_source_chain() {
    for changed in [false, true] {
        let (_directory, owner, mut reads) = fixture(true);
        let mut source_record = original(&owner).await;
        source_record["data"]["record"]["status"] = json!("failed");
        let arguments = json!({"operation_id":"original-plan","expected_fingerprint":format!("sha256:{}","0".repeat(64))});
        let observing = query(source::RETENTION, json!({"operation_id":"original-plan"}));
        let mut admitted = owner
            .material_source(
                &observing,
                source::CLEANUP,
                &arguments,
                source_record.clone(),
            )
            .await
            .unwrap();
        if changed {
            admitted.source.binding.provider.revision =
                RevisionId::new(format!("sha256:{}", "e".repeat(64))).unwrap();
        }
        let cleanup_call = invoke(
            "original-quarantine",
            source::CLEANUP,
            json!(PluginPreflightResult {
                arguments: arguments.clone(),
                target: owner.target.clone(),
                owner_context: json!(admitted)
            }),
        );
        let cleanup = json!({"status":"ready","completeness":"complete","data":{"record":{"status":"uncertain","output":null,"operation":{
            "operation_id":"original-quarantine","idempotency_scope":owner.root,"capability":cleanup_call.binding.capability,
            "normalized_arguments":{"binding":cleanup_call.binding,"arguments":arguments},
            "admission":{"owner_context":{"binding":cleanup_call.binding,"qualification":cleanup_call.owner_context}}
        }}}});
        let query = query(
            source::CLEANUP_STATUS,
            json!({"cleanup_operation_id":"original-quarantine"}),
        );
        let responder = tokio::spawn(async move {
            let read = reads.recv().await.unwrap();
            assert_eq!(read.arguments["operation_id"], "original-plan");
            read.reply.send(Ok(source_record)).unwrap();
        });
        let result = owner.complete_source(&query, cleanup).await;
        responder.await.unwrap();
        if changed {
            assert!(result.unwrap_err().contains("source changed"));
        } else {
            let view: RetentionView = serde_json::from_value(result.unwrap()).unwrap();
            assert_eq!(view.source_operation_id, "original-plan");
            assert!(!view.can_restore && !view.can_purge);
        }
    }
}
