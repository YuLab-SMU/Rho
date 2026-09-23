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
