use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::json;
use std::{collections::BTreeMap, fs, path::Path};

fn package(root: &Path, plugin: &str, dependency: Option<&PluginArchive>) -> PluginArchive {
    fs::create_dir_all(root.join("dist")).unwrap();
    fs::write(root.join("source.js"), "export const value = 1;\n").unwrap();
    fs::write(
        root.join("dependencies.lock"),
        "No external dependencies.\n",
    )
    .unwrap();
    fs::write(
        root.join("BUILD.md"),
        "Copy the declared source and HTML.\n",
    )
    .unwrap();
    fs::write(
        root.join("dist/index.html"),
        "<!doctype html><p>Test project fixture</p>",
    )
    .unwrap();
    let dependencies = dependency
        .map(|p| json!({"base":{"plugin":p.revision.manifest.id,"revision":p.revision.id}}))
        .unwrap_or(json!({}));
    fs::write(root.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":plugin,"name":"Test project fixture","version":"1.0.0","description":"Independent source","license":"MIT",
        "source":{"files":["source.js"],"lockfiles":["dependencies.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":dependencies,"requires":[],"capabilities":[],"contexts":[],"backend":null,
        "views":[{"id":"view","title":"View","entrypoint":"dist/index.html","state_schema":{},"configuration_schema":{},"resource_kinds":[]}],
        "configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(root, None, "ui-web").unwrap()
}
fn chosen(package: &PluginArchive) -> ScenarioInstance {
    ScenarioInstance {
        plugin: package.revision.manifest.id.clone(),
        revision: package.revision.id.clone(),
        artifact: package.artifacts[0].id.clone(),
        configuration: json!({}),
        dependencies: BTreeMap::new(),
        optional_capabilities: vec![],
    }
}
fn record(repo: &PluginRepository, package: &PluginArchive, name: &str) -> PluginTestProject {
    let id = TestProjectId::new(name).unwrap();
    let directory = repo
        .test_project_directory(&id)
        .to_string_lossy()
        .into_owned();
    PluginTestProject {
        id,
        source_project: ProjectId::new("source-project").unwrap(),
        principal: PrincipalId::new("user").unwrap(),
        source_operation_id: OperationId::new(format!("create/{name}")).unwrap(),
        project: plugin_project_id(&directory),
        directory,
        selection: CreatePluginTestProject {
            name: "临时测试 Ω".into(),
            instances: BTreeMap::from([(InstanceAlias::new("subject").unwrap(), chosen(package))]),
        },
        version: 0,
        state: PluginTestProjectState::Preparing,
        instances: BTreeMap::new(),
        activation_operations: BTreeMap::new(),
        diagnostic: None,
    }
}
fn ready(record: &PluginTestProject) -> PluginTestProject {
    let mut next = record.clone();
    next.version += 1;
    next.state = PluginTestProjectState::Ready;
    let alias = InstanceAlias::new("subject").unwrap();
    let selected = &next.selection.instances[&alias];
    next.instances.insert(
        alias.clone(),
        InstanceRef {
            plugin: selected.plugin.clone(),
            revision: selected.revision.clone(),
            artifact: selected.artifact.clone(),
            instance: PluginInstanceId::new("native-test-instance").unwrap(),
        },
    );
    next.activation_operations
        .insert(alias, OperationId::new("child/activate").unwrap());
    next
}

#[test]
fn recorded_test_projects_keep_scope_history_and_native_presence_separate() {
    let temp = tempfile::tempdir().unwrap();
    let package = package(&temp.path().join("source"), "example.test", None);
    let mut repo = PluginRepository::open(&temp.path().join("repository")).unwrap();
    repo.import(&package).unwrap();
    let a = record(&repo, &package, "test-a");
    let b = record(&repo, &package, "test-b");
    repo.register_test_project(&a).unwrap();
    repo.register_test_project(&b).unwrap();
    assert!(
        !Path::new(&a.directory).exists(),
        "registration only retains metadata, never starts or materializes a project"
    );
    assert!(matches!(
        repo.remove(&package.revision.id),
        Err(PluginError::Referenced(_))
    ));
    let mut foreign = a.clone();
    foreign.id = TestProjectId::new("foreign").unwrap();
    foreign.principal = PrincipalId::new("other").unwrap();
    foreign.directory = repo
        .test_project_directory(&foreign.id)
        .to_string_lossy()
        .into_owned();
    foreign.project = plugin_project_id(&foreign.directory);
    repo.register_test_project(&foreign).unwrap();
    let reader = PluginRepository::observe(repo.root()).unwrap().unwrap();
    let first = reader
        .recorded_test_projects(
            &a.source_project,
            &a.principal,
            &ListPluginTestProjects {
                after: None,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(first.projects[0].project, a);
    assert!(!first.projects[0].observed_in_this_host);
    let second = reader
        .recorded_test_projects(
            &a.source_project,
            &a.principal,
            &ListPluginTestProjects {
                after: first.next,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(second.projects[0].project, b);
    assert!(second.next.is_none());
    assert!(
        reader
            .recorded_test_project(&a.source_project, &foreign.principal, &a.id)
            .is_err()
    );
    assert!(
        reader
            .recorded_test_project(
                &ProjectId::new("other-project").unwrap(),
                &a.principal,
                &a.id
            )
            .is_err()
    );
    assert!(
        reader
            .recorded_test_projects(
                &a.source_project,
                &a.principal,
                &ListPluginTestProjects {
                    after: None,
                    limit: 0
                }
            )
            .is_err()
    );
    let active = ready(&a);
    repo.record_test_project(0, &active).unwrap();
    assert!(matches!(
        repo.record_test_project(0, &active),
        Err(PluginError::Conflict)
    ));
    let mut stopped = active.clone();
    stopped.version += 1;
    stopped.state = PluginTestProjectState::Stopped;
    assert!(
        repo.record_test_project(active.version, &stopped).is_err(),
        "release cannot skip native stopping qualification"
    );
    stopped.state = PluginTestProjectState::Stopping;
    repo.record_test_project(active.version, &stopped).unwrap();
    let old = stopped.version;
    stopped.version += 1;
    stopped.state = PluginTestProjectState::Stopped;
    repo.record_test_project(old, &stopped).unwrap();
    assert!(
        !repo
            .references(&package.revision.id)
            .unwrap()
            .contains(&format!("test_project:{}", a.id))
    );
    let mut resurrect = stopped.clone();
    resurrect.version += 1;
    resurrect.state = PluginTestProjectState::Ready;
    assert!(
        repo.record_test_project(stopped.version, &resurrect)
            .is_err()
    );
    assert_eq!(
        reader
            .recorded_test_project(&a.source_project, &a.principal, &a.id)
            .unwrap(),
        stopped
    );
}

#[test]
fn exact_dependency_selection_and_managed_directory_are_required_before_registration() {
    let temp = tempfile::tempdir().unwrap();
    let base = package(&temp.path().join("base"), "example.base", None);
    let dependent = package(
        &temp.path().join("dependent"),
        "example.dependent",
        Some(&base),
    );
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&base).unwrap();
    repo.import(&dependent).unwrap();
    let mut value = record(&repo, &dependent, "test-dependencies");
    assert!(repo.register_test_project(&value).is_err());
    let subject = InstanceAlias::new("subject").unwrap();
    let base_alias = InstanceAlias::new("z-base").unwrap();
    value
        .selection
        .instances
        .get_mut(&subject)
        .unwrap()
        .dependencies
        .insert(InstanceAlias::new("base").unwrap(), base_alias.clone());
    value
        .selection
        .instances
        .insert(base_alias.clone(), chosen(&base));
    assert_eq!(
        repo.validate_test_selection(&value.selection).unwrap(),
        vec![base_alias.clone(), subject.clone()]
    );
    let mut wrong = value.clone();
    wrong
        .selection
        .instances
        .get_mut(&base_alias)
        .unwrap()
        .revision = dependent.revision.id.clone();
    assert!(repo.register_test_project(&wrong).is_err());
    wrong = value.clone();
    wrong.directory = temp
        .path()
        .join("existing-analysis")
        .to_string_lossy()
        .into_owned();
    wrong.project = plugin_project_id(&wrong.directory);
    assert!(repo.register_test_project(&wrong).is_err());
    wrong = value.clone();
    wrong
        .selection
        .instances
        .get_mut(&subject)
        .unwrap()
        .artifact = base.artifacts[0].id.clone();
    assert!(repo.register_test_project(&wrong).is_err());
    wrong = value.clone();
    wrong
        .selection
        .instances
        .get_mut(&subject)
        .unwrap()
        .configuration = json!("not an object");
    assert!(repo.register_test_project(&wrong).is_err());
    assert!(TestProjectId::new("..").is_err());
    assert!(TestProjectId::new("../analysis").is_err());
    let mut forged = serde_json::to_value(&value.selection).unwrap();
    forged["project_root"] = json!("/existing-analysis");
    assert!(serde_json::from_value::<CreatePluginTestProject>(forged).is_err());
    repo.register_test_project(&value).unwrap();
    assert_eq!(
        repo.references(&base.revision.id).unwrap(),
        vec![
            format!("dependency:{}", dependent.revision.id),
            format!("test_project:{}", value.id),
        ]
    );
    assert_eq!(
        repo.references(&dependent.revision.id).unwrap(),
        vec![format!("test_project:{}", value.id)]
    );
    assert!(!Path::new(&value.directory).exists());
}

#[test]
fn test_project_pin_and_lifecycle_writes_roll_back_together() {
    let temp = tempfile::tempdir().unwrap();
    let package = package(&temp.path().join("source"), "example.atomic", None);
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let value = record(&repo, &package, "test-atomic");
    let db = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_test_pin BEFORE INSERT ON revision_refs WHEN NEW.owner_kind='test_project' BEGIN SELECT RAISE(ABORT,'fixture pin failure'); END;").unwrap();
    assert!(repo.register_test_project(&value).is_err());
    assert!(
        repo.recorded_test_project(&value.source_project, &value.principal, &value.id)
            .is_err()
    );
    assert!(repo.references(&package.revision.id).unwrap().is_empty());
    db.execute_batch("DROP TRIGGER fail_test_pin").unwrap();
    repo.register_test_project(&value).unwrap();
    let mut stopping = value.clone();
    stopping.version = 1;
    stopping.state = PluginTestProjectState::Stopping;
    repo.record_test_project(0, &stopping).unwrap();
    let mut stopped = stopping.clone();
    stopped.version = 2;
    stopped.state = PluginTestProjectState::Stopped;
    db.execute_batch("CREATE TRIGGER fail_test_release BEFORE DELETE ON revision_refs WHEN OLD.owner_kind='test_project' BEGIN SELECT RAISE(ABORT,'fixture release failure'); END;").unwrap();
    assert!(repo.record_test_project(1, &stopped).is_err());
    assert_eq!(
        repo.recorded_test_project(&value.source_project, &value.principal, &value.id)
            .unwrap(),
        stopping
    );
    assert!(!repo.references(&package.revision.id).unwrap().is_empty());
    db.execute_batch("DROP TRIGGER fail_test_release").unwrap();
    repo.record_test_project(1, &stopped).unwrap();
    repo.remove(&package.revision.id).unwrap();
    assert_eq!(
        repo.recorded_test_project(&value.source_project, &value.principal, &value.id)
            .unwrap(),
        stopped,
        "terminal metadata remains readable after source removal"
    );
}

#[test]
fn lifecycle_pages_keep_large_configurations_inside_the_public_frame_budget() {
    let temp = tempfile::tempdir().unwrap();
    let package = package(&temp.path().join("source"), "example.large", None);
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let mut reference = None;
    for index in 0..4 {
        let mut value = record(&repo, &package, &format!("test-large-{index}"));
        value
            .selection
            .instances
            .values_mut()
            .next()
            .unwrap()
            .configuration = json!({"text":"x".repeat(220_000)});
        repo.register_test_project(&value).unwrap();
        reference = Some(value);
    }
    let value = reference.unwrap();
    let first = repo
        .recorded_test_projects(
            &value.source_project,
            &value.principal,
            &ListPluginTestProjects {
                after: None,
                limit: 100,
            },
        )
        .unwrap();
    assert_eq!(first.projects.len(), 3);
    assert!(serde_json::to_vec(&first).unwrap().len() < MAX_CONTROL_BYTES);
    let second = repo
        .recorded_test_projects(
            &value.source_project,
            &value.principal,
            &ListPluginTestProjects {
                after: first.next,
                limit: 100,
            },
        )
        .unwrap();
    assert_eq!(second.projects.len(), 1);
    assert_eq!(second.projects[0].project.id, value.id);
    assert!(second.next.is_none());
}
