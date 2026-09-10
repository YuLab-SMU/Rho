use rho_contract::{
    ApplicationMethodBinding, BindMethodRequest, CapabilityRef, HostDiscoveredSkill,
    HostDiscoveredSkills, HostRequest, HostSkillSourceKind, QueryRequest, QueryStatus,
    ResolvedSkillContext, SkillEnablement, SkillListPage, SkillReadPage,
};
use rho_host::{HostProfile, NextHost, RuntimeConfiguration};
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
fn profile(database: &Path, manifest: Option<&Path>) -> HostProfile {
    HostProfile {
        database: database.into(),
        runtime: RuntimeConfiguration::Project,
        remote: None,
        host_skills: manifest.map(Path::to_path_buf),
    }
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

#[tokio::test]
async fn host_profile_uses_exact_native_skill_roots_and_detects_updates() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir(&project).unwrap();
    let native = create_skill(
        &dir.path().join("native-platform"),
        "rho-native-host-fixture",
    );
    create_skill(
        &dir.path().join("native-platform"),
        "rho-must-not-be-discovered",
    );
    let manifest_path = dir.path().join("native-skills.json");
    let manifest = HostDiscoveredSkills {
        provider_id: "codex-host-fixture".into(),
        skills: vec![HostDiscoveredSkill {
            source_key: "plugin/exact-fixture".into(),
            root_path: native.to_string_lossy().into(),
            source_kind: HostSkillSourceKind::Plugin,
            enablement: SkillEnablement::Enabled,
            reason: None,
        }],
    };
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let host = profile(&dir.path().join("state/next.sqlite"), Some(&manifest_path))
        .open(&project)
        .await
        .unwrap();
    let listed: SkillListPage = serde_json::from_value(
        query(
            &host,
            "skill.list",
            json!({"source_id":"codex-host-fixture"}),
        )
        .await,
    )
    .unwrap();
    assert_eq!(listed.skills.len(), 1);
    let skill = &listed.skills[0];
    assert_eq!(skill.metadata.name, "rho-native-host-fixture");
    let body:SkillReadPage=serde_json::from_value(query(&host,"skill.read",json!({"skill_ref":skill.skill_ref,"expected_digest":skill.skill_digest,"limit_bytes":65536})).await).unwrap();
    assert_eq!(
        body.text.unwrap().as_bytes(),
        fs::read(native.join("SKILL.md")).unwrap()
    );
    fs::write(native.join("scripts/check.R"), "changed original script\n").unwrap();
    assert!(
        host.query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("skill.read", 1).unwrap(),
                arguments: json!({"skill_ref":skill.skill_ref,"expected_digest":skill.skill_digest})
            }
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn invalid_declared_sources_fail_before_replacing_or_reserving_a_host() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original");
    let target = dir.path().join("target");
    fs::create_dir(&original).unwrap();
    fs::create_dir(&target).unwrap();
    let old = NextHost::open_project(dir.path().join("old/next.sqlite"), &original)
        .await
        .unwrap();
    let manifest_path = dir.path().join("invalid-source.json");
    let manifest = HostDiscoveredSkills {
        provider_id: "codex-invalid-fixture".into(),
        skills: vec![HostDiscoveredSkill {
            source_key: "missing".into(),
            root_path: dir.path().join("not-installed").to_string_lossy().into(),
            source_kind: HostSkillSourceKind::Plugin,
            enablement: SkillEnablement::Enabled,
            reason: None,
        }],
    };
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let error = profile(
        &dir.path().join("future/state.sqlite"),
        Some(&manifest_path),
    )
    .reserve(&target)
    .err()
    .expect("invalid source must fail preflight");
    assert!(error.contains("Invalid host Skill source"));
    assert!(!target.join(".rho").exists());
    assert!(!dir.path().join("future").exists());
    let observations = query(&old, "host.overview", json!({})).await;
    assert_eq!(
        observations["project_root"],
        original.canonicalize().unwrap().to_str().unwrap()
    );
}
