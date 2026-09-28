use super::*;
use sha2::{Digest, Sha256};
fn input(task: &StoredAgentTask, bytes: &[u8]) -> AgentResourceAssetUpload {
    serde_json::from_value(serde_json::json!({
        "request_id":uuid::Uuid::new_v4().to_string(), "control":control(task), "name":"Unicode 数据.txt",
        "reference":{"owner":origin().binding.provider,"resource":"fixture-resource",
        "digest":format!("sha256:{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"media_type":"text/plain"}
    })).unwrap()
}
#[test]
fn resource_asset_admission_retains_exact_identity_without_bytes_and_observes_after_reopen() {
    let (directory, store, owner, created) = setup();
    let bytes = b"private attachment content";
    let input = input(&created.task, bytes);
    let controller = created.task.attachment.controller.clone();
    assert!(
        owner
            .prepare_asset_import(&scope(), &input, &controller)
            .unwrap()
            .is_none()
    );
    let (_, admitted) = owner
        .admit_asset_import(&scope(), input.clone(), controller.clone(), bytes, 2)
        .unwrap();
    assert!(admitted.native && !admitted.repeated);
    let capture = store
        .agent_asset_import(&scope(), &input.request_id)
        .unwrap()
        .unwrap();
    assert_eq!(capture.input, input);
    assert!(
        !serde_json::to_string(&capture)
            .unwrap()
            .contains("private attachment content")
    );
    assert!(
        store
            .agent_native_admission(&scope(), &input.request_id)
            .unwrap()
            .is_none()
    );
    let repeat = owner
        .prepare_asset_import(&scope(), &input, &controller)
        .unwrap()
        .unwrap();
    assert!(repeat.repeated && !repeat.native);
    assert_eq!(
        repeat.receipt.request_digest,
        admitted.receipt.request_digest
    );
    let mut changed = input.clone();
    changed.reference.resource =
        serde_json::from_value(serde_json::json!("different-resource")).unwrap();
    assert!(matches!(
        owner.prepare_asset_import(&scope(), &changed, &controller),
        Err(AgentTaskError::RequestConflict)
    ));
    let mut changed_controller = controller.clone();
    changed_controller.incarnation.push_str("-replacement");
    assert!(matches!(
        owner.prepare_asset_import(&scope(), &input, &changed_controller),
        Err(AgentTaskError::RequestConflict)
    ));
    let mut stranger = scope();
    stranger.principal.push_str("-other");
    assert!(
        store
            .agent_asset_import(&stranger, &input.request_id)
            .unwrap()
            .is_none()
    );
    assert!(
        owner
            .prepare_asset_import(&stranger, &input, &controller)
            .is_err()
    );
    drop(owner);
    drop(store);
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let owner = AgentTaskOwner::new(store.clone());
    let original = owner
        .prepare_asset_import(&scope(), &input, &controller)
        .unwrap()
        .unwrap();
    assert!(!original.native);
    assert_eq!(original.receipt.status, "prepared");
    assert!(
        store
            .agent_assets(&scope(), &input.control.task_id)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn resource_asset_admission_rolls_back_capture_receipt_and_task_together() {
    let (_directory, store, owner, created) = setup();
    let input = input(&created.task, b"content");
    let controller = created.task.attachment.controller.clone();
    store.0.lock().unwrap().execute_batch("CREATE TRIGGER fail_attachment BEFORE UPDATE ON agent_tasks BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;").unwrap();
    assert!(
        owner
            .admit_asset_import(&scope(), input.clone(), controller.clone(), b"content", 2)
            .is_err()
    );
    assert!(
        store
            .agent_asset_import(&scope(), &input.request_id)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_receipt(&scope(), &input.request_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .agent_task(&scope(), &input.control.task_id)
            .unwrap()
            .unwrap()
            .revision,
        created.task.revision
    );
    store
        .0
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_attachment;")
        .unwrap();
    owner
        .admit_asset_import(&scope(), input.clone(), controller, b"content", 3)
        .unwrap();
    assert!(
        store
            .agent_asset_import(&scope(), &input.request_id)
            .unwrap()
            .is_some()
    );
}
#[test]
fn resource_asset_admission_refuses_wrong_bytes_limits_and_changed_control() {
    let (_directory, store, owner, created) = setup();
    let input = input(&created.task, b"content");
    let controller = created.task.attachment.controller.clone();
    assert!(
        owner
            .admit_asset_import(&scope(), input.clone(), controller.clone(), b"replaced", 2)
            .is_err()
    );
    let mut wrong = input.clone();
    wrong.reference.bytes = 8 * 1024 * 1024 + 1;
    assert!(
        owner
            .prepare_asset_import(&scope(), &wrong, &controller)
            .is_err()
    );
    let mut wrong = input.clone();
    wrong.request_id = "NOT-A-UUID".into();
    assert!(
        owner
            .prepare_asset_import(&scope(), &wrong, &controller)
            .is_err()
    );
    let mut wrong = input.clone();
    wrong.control.generation += 1;
    assert!(matches!(
        owner.prepare_asset_import(&scope(), &wrong, &controller),
        Err(AgentTaskError::Conflict)
    ));
    let mut wrong_controller = controller.clone();
    wrong_controller.window_id = "another-window".into();
    assert!(
        owner
            .prepare_asset_import(&scope(), &input, &wrong_controller)
            .is_err()
    );
    owner
        .admit(
            &scope(),
            &request(AgentTaskCommand::Archive {
                control: control(&created.task),
                archived: true,
            }),
            3,
        )
        .unwrap();
    assert!(
        owner
            .prepare_asset_import(&scope(), &input, &controller)
            .is_err()
    );
    assert!(
        owner
            .admit_asset_import(&scope(), input.clone(), controller, b"content", 4)
            .is_err()
    );
    assert!(
        store
            .agent_asset_import(&scope(), &input.request_id)
            .unwrap()
            .is_none()
    );
}
