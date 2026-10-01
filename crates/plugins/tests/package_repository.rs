use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::json;
use std::{fs, path::Path};

fn fixture(path: &Path) {
    fs::create_dir_all(path.join("src")).unwrap();
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(
        path.join("src/view.ts"),
        "document.body.textContent = 'Independent plugin';",
    )
    .unwrap();
    fs::write(
        path.join("deps.lock"),
        "No third-party dependencies. JavaScript ES2022.\n",
    )
    .unwrap();
    fs::write(
        path.join("BUILD.md"),
        "Build: copy src/view.ts to dist/view.js; include index.html.\n",
    )
    .unwrap();
    fs::write(
        path.join("dist/index.html"),
        "<!doctype html><html><body>Independent plugin</body></html>",
    )
    .unwrap();
    fs::write(path.join("plugin.json"), serde_json::to_vec_pretty(&json!({
        "protocol_version": 1, "id": "example.independent", "name": "Independent Viewer",
        "version": "1.0.0", "description": "A plugin created outside the Rho source tree", "license": "MIT",
        "source": { "files": ["src/view.ts"], "lockfiles": ["deps.lock"], "build_instructions": "BUILD.md", "build": null },
        "dependencies": {}, "requires": [], "capabilities": [], "contexts": [], "backend": null,
        "views": [{ "id": "report", "title": "Report", "entrypoint": "dist/index.html",
            "state_schema": {"type":"object"}, "configuration_schema": {"type":"object"}, "resource_kinds": [] }],
        "configuration_schema": {"type":"object", "additionalProperties":false}, "default_configuration": {}
    })).unwrap()).unwrap();
}

fn scenario_request(name: &str) -> SaveScenario {
    serde_json::from_value(
        json!({"scenario":name,"expected_head":null,"name":format!("研究 {name}"),
        "instances":{},"providers":[],"layout":{"kind":"empty"}}),
    )
    .unwrap()
}

#[test]
fn scenario_history_cas_restore_and_scoped_pages_are_durable() {
    let temp = tempfile::tempdir().unwrap();
    let mut repo = PluginRepository::open(temp.path()).unwrap();
    let project = ProjectId::new("project").unwrap();
    let principal = PrincipalId::new("principal").unwrap();
    let foreign = PrincipalId::new("foreign").unwrap();
    let other = ProjectId::new("other").unwrap();
    let page = ListScenarios {
        after: None,
        limit: 1,
    };
    assert!(
        repo.scenarios(&project, &principal, &page)
            .unwrap()
            .scenarios
            .is_empty()
    );
    let original = scenario_request("alpha");
    let a = repo.save_scenario(&project, &principal, &original).unwrap();
    assert!(matches!(
        repo.save_scenario(&project, &principal, &original),
        Err(PluginError::Conflict)
    ));
    let mut next = original.clone();
    next.expected_head = Some(a.id.clone());
    next.name = "Changed".into();
    // Two writers share the same native head precondition; only the winner saves.
    let mut second = PluginRepository::open(temp.path()).unwrap();
    second
        .prepare_scenario(&project, &principal, &next)
        .unwrap();
    let b = repo.save_scenario(&project, &principal, &next).unwrap();
    assert!(matches!(
        second.save_scenario(&project, &principal, &next),
        Err(PluginError::Conflict)
    ));
    let mut restore = original.clone();
    restore.expected_head = Some(b.id.clone());
    let c = repo.save_scenario(&project, &principal, &restore).unwrap();
    assert_eq!(c.parent, Some(b.id.clone()));
    assert_ne!(c.id, a.id);
    assert_eq!(
        repo.scenario_revision(&project, &principal, &a.id).unwrap(),
        a
    );
    assert_eq!(
        repo.scenario_revision(&project, &principal, &b.id)
            .unwrap()
            .parent,
        Some(a.id.clone())
    );
    assert!(repo.scenario_revision(&project, &foreign, &a.id).is_err());
    assert!(repo.scenario_revision(&other, &principal, &a.id).is_err());
    let f = repo.save_scenario(&project, &foreign, &original).unwrap();
    assert_eq!(f.id, a.id); // Equal content never grants cross-principal access.
    let p = repo.save_scenario(&other, &principal, &original).unwrap();
    assert_ne!(p.id, a.id);
    let beta = repo
        .save_scenario(&project, &principal, &scenario_request("beta"))
        .unwrap();
    let observer = PluginRepository::observe(temp.path()).unwrap().unwrap();
    let first = observer.scenarios(&project, &principal, &page).unwrap();
    assert_eq!(first.scenarios.len(), 1);
    assert_eq!(first.scenarios[0].revision, c.id);
    let last = observer
        .scenarios(
            &project,
            &principal,
            &ListScenarios {
                after: first.next,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(last.scenarios[0].revision, beta.id);
    assert!(last.next.is_none());
    assert!(
        observer
            .scenarios(
                &project,
                &principal,
                &ListScenarios {
                    after: None,
                    limit: 0
                }
            )
            .is_err()
    );
    assert!(
        observer
            .scenarios(
                &project,
                &principal,
                &ListScenarios {
                    after: None,
                    limit: 101
                }
            )
            .is_err()
    );
    let connection = rusqlite::Connection::open(temp.path().join("catalog-v1.sqlite3")).unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM plugin_scenario_revisions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 6); // Reads and stale writes created no extra checkpoint.
}

#[test]
fn scenario_history_protects_coexisting_missing_and_resource_owner_revisions() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let first = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    fs::write(temp.path().join("src/view.ts"), "different source").unwrap();
    let second = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&first).unwrap(); // Keep the second exact revision missing initially.
    let project = ProjectId::new("project").unwrap();
    let principal = PrincipalId::new("user").unwrap();
    let mut args = scenario_request("compare");
    for (alias, package) in [("old", &first), ("new", &second)] {
        args.instances.insert(
            InstanceAlias::new(alias).unwrap(),
            ScenarioInstance {
                plugin: package.revision.manifest.id.clone(),
                revision: package.revision.id.clone(),
                artifact: package.artifacts[0].id.clone(),
                configuration: json!({}),
                dependencies: Default::default(),
                optional_capabilities: vec![],
            },
        );
    }
    let source_revision = RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap();
    args.layout = ScenarioLayout::Tabs {
        id: NodeId::new("group").unwrap(),
        selected: None,
        views: vec![ScenarioView {
            id: ViewInstanceId::new("result").unwrap(),
            instance: InstanceAlias::new("old").unwrap(),
            contribution: ContributionId::new("report").unwrap(),
            configuration: json!({}),
            state: json!({}),
            state_revision: first.revision.id.clone(),
            resource: Some(ResourceReference {
                owner: InstanceRef {
                    instance: PluginInstanceId::new("source").unwrap(),
                    plugin: PluginId::new("example.source").unwrap(),
                    revision: source_revision.clone(),
                    artifact: first.artifacts[0].id.clone(),
                },
                resource: ResourceId::new("resource").unwrap(),
                digest: content_digest(b""),
                bytes: 0,
                media_type: "text/plain".into(),
            }),
        }],
    };
    let saved = repo.save_scenario(&project, &principal, &args).unwrap();
    assert_eq!(repo.references(&source_revision).unwrap().len(), 1);
    repo.import(&second).unwrap();
    let mut empty = scenario_request("compare");
    empty.expected_head = Some(saved.id.clone());
    repo.save_scenario(&project, &principal, &empty).unwrap();
    for package in [&first, &second] {
        assert!(matches!(
            repo.remove(&package.revision.id),
            Err(PluginError::Referenced(_))
        ));
    }
    assert_eq!(
        repo.scenario_revision(&project, &principal, &saved.id)
            .unwrap(),
        saved
    );
    assert!(
        repo.recorded_instances_scoped(None, 10, Some((&project, &principal)))
            .unwrap()
            .instances
            .is_empty()
    );
}

#[test]
fn scenario_invalid_metadata_and_corruption_never_replace_a_head() {
    let temp = tempfile::tempdir().unwrap();
    let mut repo = PluginRepository::open(temp.path()).unwrap();
    let project = ProjectId::new("project").unwrap();
    let principal = PrincipalId::new("user").unwrap();
    let args = scenario_request("main");
    let saved = repo.save_scenario(&project, &principal, &args).unwrap();
    let mut wrong = args.clone();
    wrong.expected_head = Some(saved.id.clone());
    wrong.name = " ".into();
    assert!(repo.save_scenario(&project, &principal, &wrong).is_err());
    wrong.name = "valid".into();
    wrong.layout = ScenarioLayout::Split {
        id: NodeId::new("root").unwrap(),
        direction: SplitDirection::Horizontal,
        weights: vec![f64::MAX, f64::MAX],
        children: vec![ScenarioLayout::Empty; 2],
    };
    assert!(repo.save_scenario(&project, &principal, &wrong).is_err());
    wrong.layout = ScenarioLayout::Empty;
    wrong.instances.insert(InstanceAlias::new("large").unwrap(),serde_json::from_value(json!({"plugin":"example.large",
        "revision":format!("sha256:{}","0".repeat(64)),"artifact":format!("sha256:{}","0".repeat(64)),"configuration":{"text":"x".repeat(256*1024)},"dependencies":{}})).unwrap());
    assert!(repo.save_scenario(&project, &principal, &wrong).is_err());
    assert_eq!(
        repo.scenarios(
            &project,
            &principal,
            &ListScenarios {
                after: None,
                limit: 10
            }
        )
        .unwrap()
        .scenarios[0]
            .revision,
        saved.id
    );
    let connection = rusqlite::Connection::open(temp.path().join("catalog-v1.sqlite3")).unwrap();
    let mut damaged = saved.clone();
    damaged.name = "forged".into();
    connection
        .execute(
            "UPDATE plugin_scenario_revisions SET document=?",
            [serde_json::to_string(&damaged).unwrap()],
        )
        .unwrap();
    assert!(
        repo.scenario_revision(&project, &principal, &saved.id)
            .is_err()
    );
    let mut next = args;
    next.expected_head = Some(saved.id);
    assert!(repo.save_scenario(&project, &principal, &next).is_err());
}

#[test]
fn scenario_reference_write_failure_rolls_back_the_checkpoint_and_head() {
    let temp = tempfile::tempdir().unwrap();
    let mut repo = PluginRepository::open(temp.path()).unwrap();
    let project = ProjectId::new("project").unwrap();
    let principal = PrincipalId::new("user").unwrap();
    let mut args = scenario_request("atomic");
    let revision = RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap();
    args.instances.insert(InstanceAlias::new("missing").unwrap(),serde_json::from_value(json!({
        "plugin":"example.missing","revision":revision,"artifact":format!("sha256:{}","b".repeat(64)),"configuration":{},"dependencies":{}})).unwrap());
    let connection = rusqlite::Connection::open(temp.path().join("catalog-v1.sqlite3")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER refuse_scenario_reference BEFORE INSERT ON revision_refs
        WHEN NEW.owner_kind='scenario' BEGIN SELECT RAISE(ABORT,'test reference failure'); END;",
        )
        .unwrap();
    let candidate = repo.prepare_scenario(&project, &principal, &args).unwrap();
    assert!(repo.save_scenario(&project, &principal, &args).is_err());
    assert!(
        repo.scenario_revision(&project, &principal, &candidate.id)
            .is_err()
    );
    assert!(
        repo.scenarios(
            &project,
            &principal,
            &ListScenarios {
                after: None,
                limit: 10
            }
        )
        .unwrap()
        .scenarios
        .is_empty()
    );
    assert!(repo.references(&revision).unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER refuse_scenario_reference;")
        .unwrap();
    assert_eq!(
        repo.save_scenario(&project, &principal, &args).unwrap(),
        candidate
    );
    assert_eq!(repo.references(&revision).unwrap().len(), 1);
}

#[test]
fn external_package_export_remove_reimport_has_identical_identity_and_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("external");
    fixture(&source);
    let archive = snapshot_directory(&source, None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    let installed = repo.import(&archive).unwrap();
    assert_eq!(repo.import(&archive).unwrap(), installed);
    assert_eq!(repo.list().unwrap().len(), 1);
    repo.export_file(&installed.revision, &temp.path().join("plugin.rho-plugin"))
        .unwrap();
    assert!(
        repo.export_file(&installed.revision, &temp.path().join("plugin.rho-plugin"))
            .is_err()
    );
    repo.remove(&installed.revision).unwrap();
    assert!(repo.list().unwrap().is_empty());
    assert!(
        repo.blob(&archive.revision.files.values().next().unwrap().digest)
            .is_err()
    );
    let imported = read_archive(&temp.path().join("plugin.rho-plugin")).unwrap();
    assert_eq!(repo.import(&imported).unwrap(), installed);
    assert_eq!(repo.export(&installed.revision).unwrap(), archive);
    assert!(
        repo.revision(&installed.revision)
            .unwrap()
            .manifest
            .requires
            .is_empty()
    );
}

#[test]
fn source_and_artifacts_have_independent_immutable_identity() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let original = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    fs::write(
        temp.path().join("dist/index.html"),
        "<body>Second build</body>",
    )
    .unwrap();
    let rebuilt = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    assert_eq!(original.revision.id, rebuilt.revision.id);
    assert_ne!(original.artifacts[0].id, rebuilt.artifacts[0].id);
    fs::write(
        temp.path().join("src/view.ts"),
        "document.body.textContent = 'User branch';",
    )
    .unwrap();
    let modified =
        snapshot_directory(temp.path(), Some(original.revision.id.clone()), "ui-web").unwrap();
    assert_ne!(original.revision.id, modified.revision.id);
    assert_eq!(original.revision.manifest.id, modified.revision.manifest.id);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&original).unwrap();
    repo.import(&rebuilt).unwrap();
    repo.import(&modified).unwrap();
    assert_eq!(
        repo.inspect(&original.revision.id).unwrap().artifacts.len(),
        2
    );
    assert_eq!(repo.list().unwrap().len(), 2);
    // Immutable snapshots do not follow subsequent edits in the development tree.
    assert_eq!(
        repo.blob(&original.revision.files[&PackagePath::new("src/view.ts").unwrap()].digest)
            .unwrap(),
        b"document.body.textContent = 'Independent plugin';"
    );
}

#[test]
fn every_reference_blocks_removal_and_query_never_creates_storage() {
    let temp = tempfile::tempdir().unwrap();
    let absent = temp.path().join("missing");
    assert!(PluginRepository::observe(&absent).unwrap().is_none());
    assert!(!absent.exists());
    fixture(temp.path());
    let archive = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    for kind in [
        "instance",
        "operation",
        "scenario",
        "document",
        "checkpoint",
    ] {
        repo.retain(kind, "original-identity", &archive.revision.id)
            .unwrap();
        match repo.remove(&archive.revision.id).unwrap_err() {
            PluginError::Referenced(refs) => {
                assert_eq!(refs, vec![format!("{kind}:original-identity")])
            }
            error => panic!("wrong error: {error}"),
        }
        repo.release_reference(kind, "original-identity", &archive.revision.id)
            .unwrap();
    }
    let observer = PluginRepository::observe(repo.root()).unwrap().unwrap();
    assert_eq!(observer.list().unwrap().len(), 1);
    repo.remove(&archive.revision.id).unwrap();
}

#[test]
fn branch_checkpoint_compare_and_stale_update_keep_original_revision() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let original = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&original).unwrap();
    let branch = repo
        .create_branch(&original.revision.id, "My controls")
        .unwrap();
    assert!(matches!(
        repo.remove(&original.revision.id),
        Err(PluginError::Referenced(_))
    ));
    fs::write(
        temp.path().join("src/view.ts"),
        "document.body.textContent = 'Modified';",
    )
    .unwrap();
    let changed =
        snapshot_directory(temp.path(), Some(original.revision.id.clone()), "ui-web").unwrap();
    repo.import(&changed).unwrap();
    repo.advance_branch(&branch, &original.revision.id, &changed.revision.id)
        .unwrap();
    assert!(matches!(
        repo.advance_branch(&branch, &original.revision.id, &changed.revision.id),
        Err(PluginError::Conflict)
    ));
    assert_eq!(repo.branch_head(&branch).unwrap(), changed.revision.id);
    let difference = repo
        .compare(&original.revision.id, &changed.revision.id)
        .unwrap();
    assert_eq!(difference.files.len(), 1);
    assert_eq!(difference.files[0].path.as_str(), "src/view.ts");
    assert_eq!(repo.export(&original.revision.id).unwrap(), original);
    assert!(
        repo.references(&original.revision.id)
            .unwrap()
            .contains(&format!("revision:{}", changed.revision.id))
    );
}

#[test]
fn tampering_and_validation_failures_leave_no_partial_installation() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let archive = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    let mut tampered = archive.clone();
    tampered.revision.manifest.name = "Altered".into();
    assert!(repo.import(&tampered).is_err());
    let mut tampered = archive.clone();
    *tampered.blobs.values_mut().next().unwrap() = "YQ==".into();
    assert!(repo.import(&tampered).is_err());
    let mut tampered = archive.clone();
    tampered.artifacts[0].revision = RevisionId::new(format!("sha256:{}", "b".repeat(64))).unwrap();
    assert!(repo.import(&tampered).is_err());
    assert!(repo.list().unwrap().is_empty());
    // A forged delivery-origin flag is not a way to obtain different validation.
    let mut json = serde_json::to_value(&archive).unwrap();
    json["revision"]["manifest"]["bundled"] = json!(true);
    assert!(serde_json::from_value::<PluginArchive>(json).is_err());
    let mut tampered = archive;
    tampered.revision.files.values_mut().next().unwrap().bytes = u64::MAX;
    tampered.revision.id = revision_digest(&tampered.revision).unwrap();
    assert!(repo.import(&tampered).is_err());
}

#[cfg(unix)]
#[test]
fn symlinks_missing_source_case_collisions_and_effectful_queries_are_rejected() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private"), "outside").unwrap();
    symlink(
        outside.path().join("private"),
        temp.path().join("dist/escape"),
    )
    .unwrap();
    assert!(snapshot_directory(temp.path(), None, "ui-web").is_err());
    fs::remove_file(temp.path().join("dist/escape")).unwrap();
    fs::remove_file(temp.path().join("src/view.ts")).unwrap();
    assert!(snapshot_directory(temp.path(), None, "ui-web").is_err());
    fixture(temp.path());
    let archive = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut collision = archive.clone();
    let file = collision.artifacts[0]
        .files
        .values()
        .next()
        .unwrap()
        .clone();
    collision.artifacts[0]
        .files
        .insert(PackagePath::new("dist/INDEX.html").unwrap(), file);
    collision.artifacts[0].id = artifact_digest(&collision.artifacts[0]).unwrap();
    assert!(validate_archive(&collision).is_err());
    let mut manifest = archive.revision.manifest;
    manifest.backend = Some(BackendEntrypoint {
        executable: PackagePath::new("dist/backend").unwrap(),
        arguments: vec![],
    });
    manifest.capabilities.push(CapabilityContribution {
        preflight: None,
        capability: CapabilityKey {
            id: ContributionId::new("example.read").unwrap(),
            version: 1,
        },
        kind: CapabilityKind::Query,
        title: "Read".into(),
        description: "Read without starting work".into(),
        input_schema: json!({}),
        examples: vec![json!({})],
        output_schema: json!({}),
        recovery_schema: json!({}),
        required_scopes: Default::default(),
        effects: ["start-runtime".to_string()].into(),
        cancellation: CancellationSupport::Unsupported,
    });
    assert!(manifest.validate().is_err());
}

#[test]
fn native_code_and_build_recipes_are_not_executed_during_snapshot_or_import() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let path = temp.path().join("plugin.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["source"]["build"] =
        json!({"command":["definitely-not-an-installed-toolchain", "--install"]});
    fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let archive = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    assert_eq!(repo.list().unwrap().len(), 1);
}

#[test]
fn catalog_pagination_is_bounded_and_an_incompatible_store_is_not_modified() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let root = temp.path().join("store");
    let mut repo = PluginRepository::open(&root).unwrap();
    for index in 0..5 {
        fs::write(
            temp.path().join("src/view.ts"),
            format!("document.body.textContent='{index}';"),
        )
        .unwrap();
        repo.import(&snapshot_directory(temp.path(), None, "ui-web").unwrap())
            .unwrap();
    }
    assert!(repo.list_page(None, 0).is_err());
    assert!(repo.list_page(None, 101).is_err());
    let mut after = None;
    let mut ids = vec![];
    loop {
        let page = repo.list_page(after.as_ref(), 2).unwrap();
        assert_eq!(page.total, 5);
        assert!(page.revisions.len() <= 2);
        ids.extend(page.revisions.into_iter().map(|v| v.revision));
        after = page.next;
        if after.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 5);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    let incompatible = temp.path().join("incompatible");
    fs::create_dir(&incompatible).unwrap();
    let connection = rusqlite::Connection::open(incompatible.join("catalog-v1.sqlite3")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE plugin_schema(version INTEGER); INSERT INTO plugin_schema VALUES(2);",
        )
        .unwrap();
    assert!(PluginRepository::open(&incompatible).is_err());
    let count: usize = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='revisions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn storage_failure_rolls_back_source_artifacts_and_blobs_together() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path());
    let archive = snapshot_directory(temp.path(), None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    let injection = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    injection.execute_batch("CREATE TRIGGER fail_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;").unwrap();
    assert!(matches!(
        repo.import(&archive),
        Err(PluginError::Database(_))
    ));
    assert!(repo.list().unwrap().is_empty());
    assert!(
        repo.blob(&archive.revision.files.values().next().unwrap().digest)
            .is_err()
    );
    injection
        .execute_batch("DROP TRIGGER fail_artifact;")
        .unwrap();
    repo.import(&archive).unwrap();
    assert_eq!(repo.export(&archive.revision.id).unwrap(), archive);
}
