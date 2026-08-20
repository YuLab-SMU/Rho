use chrono::{Duration, Utc};
use rho_store::{
    PluginPermissionDecision, PluginPermissionDecisionDraft, PluginPermissionMutationOutcome,
    PluginPermissionMutationService, PluginPermissionQueryService, PluginPermissionRequestDraft,
    Store,
};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn request(id: &str, project_root: &str) -> PluginPermissionRequestDraft {
    let constraints_json = r#"{"maxBytes":1024,"paths":["data/**/*.csv"]}"#.to_string();
    PluginPermissionRequestDraft {
        request_id: id.to_string(),
        project_root: project_root.to_string(),
        plugin_id: "org.example.plugin".to_string(),
        plugin_version: "1.0.0".to_string(),
        package_digest: "a".repeat(64),
        runtime_kind: "wasm".to_string(),
        permission: "project.fs.read".to_string(),
        constraints_digest: format!("{:x}", Sha256::digest(constraints_json.as_bytes())),
        constraints_json,
        purpose_text: Some("Read CSV metadata".to_string()),
        expected_project_revision: 3,
    }
}

fn allow(id: &str, project_root: &str) -> PluginPermissionDecisionDraft {
    PluginPermissionDecisionDraft {
        request_id: id.to_string(),
        project_root: project_root.to_string(),
        expected_project_revision: 3,
        decision: PluginPermissionDecision::AllowOnce,
        reason_code: None,
        grant_id: Some(format!("grant.{id}")),
        policy_revision: Some(1),
        expires_at: Some((Utc::now() + Duration::minutes(4)).to_rfc3339()),
    }
}

#[test]
fn scenario_plugin_permission_service_isolates_two_projects_and_reopens() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("rho.sqlite");
    let mut store = Store::open(&database).unwrap();
    for (id, project) in [("request.a", "D:/project/a"), ("request.b", "D:/project/b")] {
        PluginPermissionMutationService::new(&mut store)
            .create_request(project, &request(id, project))
            .unwrap();
    }
    assert!(
        PluginPermissionQueryService::new(&store)
            .get_request("D:/project/b", "request.a")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        PluginPermissionMutationService::new(&mut store)
            .resolve_request("D:/project/a", &allow("request.a", "D:/project/a"))
            .unwrap(),
        PluginPermissionMutationOutcome::Applied
    );
    assert_eq!(
        PluginPermissionQueryService::new(&store)
            .list_grants("D:/project/a", None, Some("active"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        PluginPermissionQueryService::new(&store)
            .list_grants("D:/project/b", None, None)
            .unwrap()
            .is_empty()
    );
    drop(store);

    let reopened = Store::open(&database).unwrap();
    assert_eq!(
        PluginPermissionQueryService::new(&reopened)
            .list_grants("D:/project/a", None, Some("active"))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        PluginPermissionQueryService::new(&reopened)
            .list_requests("D:/project/b", None, Some("pending"))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn scenario_plugin_permission_service_rejects_blank_and_mismatched_projects() {
    let directory = tempdir().unwrap();
    let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
    assert!(
        PluginPermissionMutationService::new(&mut store)
            .create_request("", &request("request.a", "D:/project/a"))
            .is_err()
    );
    assert!(
        PluginPermissionMutationService::new(&mut store)
            .create_request("D:/project/b", &request("request.a", "D:/project/a"))
            .is_err()
    );
    assert!(
        PluginPermissionQueryService::new(&store)
            .list_requests("D:/project/a", None, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn scenario_plugin_permission_service_foreign_mutations_are_truthful_noops() {
    let directory = tempdir().unwrap();
    let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
    PluginPermissionMutationService::new(&mut store)
        .create_request("D:/project/a", &request("request.a", "D:/project/a"))
        .unwrap();
    assert_eq!(
        PluginPermissionMutationService::new(&mut store)
            .cancel_request("D:/project/b", "request.a", 3, "project_switched")
            .unwrap(),
        PluginPermissionMutationOutcome::NotFound
    );
    assert_eq!(
        PluginPermissionQueryService::new(&store)
            .get_request("D:/project/a", "request.a")
            .unwrap()
            .unwrap()
            .status,
        "pending"
    );
}
