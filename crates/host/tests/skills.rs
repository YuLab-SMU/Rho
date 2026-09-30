use rho_contract::{
    ApplicationMethodBinding, BindMethodRequest, CapabilityRef, HostRequest, QueryRequest, QueryStatus,
    ResolvedSkillContext, SkillListPage, SkillReadPage,
};
use rho_host::NextHost;
use serde_json::{Value, json};
use std::{fs, path::Path};

fn create_skill(root: &Path, name: &str) -> std::path::PathBuf {
    let directory = root.join(name);
    fs::create_dir_all(directory.join("scripts")).unwrap();
    fs::write(directory.join("SKILL.md"),format!("---\nname: {name}\ndescription: Isolated Host integration method\n---\nInvestigate user evidence.\n")).unwrap();
    fs::write(
        directory.join("scripts/check.R"),
        "stop('Skill discovery must not execute scripts')\n",
    )
    .unwrap();
    directory
}
async fn query(host: &NextHost, id: &str, args: Value) -> Value {
    let response = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new(id, 1).unwrap(),
                arguments: args,
            },
        )
        .await
        .unwrap();
    assert_eq!(response.status, QueryStatus::Ready);
    response.data.unwrap()
}
#[tokio::test]
async fn project_only_host_shares_skill_queries_receipts_and_binding_control() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    create_skill(&project.join(".agents/skills"), "rho-host-fixture-method");
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &project)
        .await
        .unwrap();
    let listed: SkillListPage = serde_json::from_value(
        query(
            &host,
            "skill.list",
            json!({"working_directory":".","filter":"rho-host-fixture-method"}),
        )
        .await,
    )
    .unwrap();
    assert_eq!(listed.skills.len(), 1);
    let skill = &listed.skills[0];
    let instances = query(&host, "runtime.instances", json!({"limit":50})).await;
    assert!(
        instances["instances"]
            .as_array()
            .unwrap()
            .iter()
            .all(|instance| instance["native_session_id"].is_null()),
        "a project-only host must not start R: {instances}"
    );
    let text:SkillReadPage=serde_json::from_value(query(&host,"skill.read",json!({"working_directory":".","skill_ref":skill.skill_ref,"expected_digest":skill.skill_digest,"external_task_ref":"host-fixture-task","limit_bytes":65536})).await).unwrap();
    assert!(text.complete);
    assert!(text.text.unwrap().contains("Investigate user evidence"));
    let binding = ApplicationMethodBinding {
        binding_id: "host-fixture-binding".into(),
        version: "v1".into(),
        working_directory: ".".into(),
        external_goal_ref: None,
        external_task_ref: Some("host-fixture-task".into()),
        external_actor_ref: Some("associated-actor".into()),
        skill_ref: skill.skill_ref.clone(),
        source_ref: skill.source.source_ref.clone(),
        resources: vec![],
        modules: vec!["workspace".into()],
        capabilities: vec![],
        required_capabilities: vec![],
        target: None,
        excluded: false,
    };
    let saved = host
        .dispatch(
            &NextHost::local_context(),
            HostRequest::BindMethod(BindMethodRequest {
                expected_version: None,
                binding: binding.clone(),
            }),
        )
        .await
        .unwrap();
    let saved: ApplicationMethodBinding = serde_json::from_value(saved).unwrap();
    assert_eq!(saved, binding);
    let resolved: ResolvedSkillContext = serde_json::from_value(
        query(
            &host,
            "host.resolve_context",
            json!({"working_directory":".","external_task_ref":"host-fixture-task"}),
        )
        .await,
    )
    .unwrap();
    let selected = resolved
        .methods
        .iter()
        .find(|m| m.binding_id == binding.binding_id)
        .unwrap();
    assert!(selected.valid);
    assert_eq!(
        selected.binding.external_actor_ref.as_deref(),
        Some("associated-actor")
    );
    let retried = host
        .dispatch(
            &NextHost::local_context(),
            HostRequest::BindMethod(BindMethodRequest {
                expected_version: None,
                binding: binding.clone(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_value::<ApplicationMethodBinding>(retried).unwrap(),
        binding
    );
    let mut moved = binding.clone();
    moved.version = "moved-version".into();
    moved.working_directory = "different-scope".into();
    assert!(
        host.dispatch(
            &NextHost::local_context(),
            HostRequest::BindMethod(BindMethodRequest {
                expected_version: Some(binding.version.clone()),
                binding: moved,
            })
        )
        .await
        .is_err()
    );
    let mut denied = NextHost::local_context();
    denied.scopes.remove("skill.read");
    assert!(
        host.dispatch(
            &denied,
            HostRequest::BindMethod(BindMethodRequest {
                expected_version: Some("v1".into()),
                binding
            })
        )
        .await
        .is_err()
    );
    assert!(
        query(&host, "operation.list_recent", json!({"limit":10})).await["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
