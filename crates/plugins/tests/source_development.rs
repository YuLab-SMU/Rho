use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Arc, Barrier},
};

fn fixture(path: &Path) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(path.join("main.ts"), "document.title = '研究';").unwrap();
    fs::write(path.join("data.bin"), [0u8, 255, 10, 128].repeat(150_000)).unwrap();
    fs::write(path.join("empty"), "").unwrap();
    fs::write(path.join("deps.lock"), "no external dependencies").unwrap();
    fs::write(
        path.join("BUILD.md"),
        "Build with an explicitly provided toolchain.",
    )
    .unwrap();
    fs::write(
        path.join("dist/index.html"),
        "<html>Original artifact</html>",
    )
    .unwrap();
    fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.source","name":"Source fixture","version":"1.0.0","description":"Independent package", "license":"MIT",
        "source":{"files":["main.ts","data.bin","empty"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":[],"views":[{"id":"view","title":"View","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
        "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
fn put(bytes: &[u8]) -> PluginSourceEdit {
    PluginSourceEdit::Put {
        content_base64: STANDARD.encode(bytes),
        executable: false,
    }
}
fn edit(branch: &BranchId, parent: &RevisionId, bytes: &[u8]) -> CheckpointPlugin {
    CheckpointPlugin {
        branch: branch.clone(),
        expected_head: parent.clone(),
        changes: BTreeMap::from([(PackagePath::new("main.ts").unwrap(), put(bytes))]),
    }
}
fn inventory(repo: &PluginRepository) -> (u64, u64, u64, u64) {
    let db = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    db.query_row("SELECT (SELECT COUNT(*) FROM revisions),(SELECT COUNT(*) FROM blobs),(SELECT COUNT(*) FROM source_files),(SELECT COUNT(*) FROM revision_refs)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}

#[test]
fn source_pages_binary_chunks_and_branch_origins_are_bounded_pure_observations() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let first_branch = repo
        .create_branch(&package.revision.id, "研究 branch")
        .unwrap();
    repo.create_branch(&package.revision.id, "Other").unwrap();
    let before = inventory(&repo);
    let reader = PluginRepository::observe(repo.root()).unwrap().unwrap();
    let mut cursor = None;
    let mut files = BTreeMap::new();
    loop {
        let page = reader
            .source_page(&ListPluginSource {
                revision: package.revision.id.clone(),
                after: cursor,
                limit: 2,
            })
            .unwrap();
        assert!(page.files.len() <= 2);
        assert_eq!(page.total, package.revision.files.len() as u64);
        files.extend(page.files);
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(files, package.revision.files);
    let mut request = ReadPluginSource {
        revision: package.revision.id.clone(),
        path: PackagePath::new("data.bin").unwrap(),
        offset: 0,
        limit: 65536,
    };
    let mut bytes = vec![];
    loop {
        let chunk = reader.read_source(&request).unwrap();
        assert_eq!(chunk.offset, request.offset);
        let part = STANDARD.decode(chunk.content_base64).unwrap();
        assert!(part.len() <= 65536);
        bytes.extend(part);
        if let Some(next) = chunk.next_offset {
            request.offset = next;
        } else {
            break;
        }
    }
    assert_eq!(
        bytes,
        fs::read(temp.path().join("package/data.bin")).unwrap()
    );
    request.offset = bytes.len() as u64;
    assert!(
        reader
            .read_source(&request)
            .unwrap()
            .content_base64
            .is_empty()
    );
    request.offset += 1;
    assert!(reader.read_source(&request).is_err());
    request.path = PackagePath::new("empty").unwrap();
    request.offset = 0;
    assert!(reader.read_source(&request).unwrap().next_offset.is_none());
    for limit in [0, 65537] {
        request.limit = limit;
        assert!(reader.read_source(&request).is_err());
    }
    request.limit = 65536;
    request.path = PackagePath::new("dist/index.html").unwrap();
    assert!(reader.read_source(&request).is_err());
    for limit in [0, 101] {
        assert!(
            reader
                .source_page(&ListPluginSource {
                    revision: package.revision.id.clone(),
                    after: None,
                    limit
                })
                .is_err()
        );
    }
    let mut args = ListPluginBranches {
        plugin: package.revision.manifest.id.clone(),
        after: None,
        limit: 1,
    };
    let page = reader.branches(&args).unwrap();
    assert_eq!(page.branches.len(), 1);
    assert!(page.next.is_some());
    args.after = page.next;
    let last = reader.branches(&args).unwrap();
    assert!(last.next.is_none());
    let branches: Vec<_> = page.branches.into_iter().chain(last.branches).collect();
    assert!(
        branches
            .iter()
            .any(|b| b.id == first_branch && b.name == "研究 branch")
    );
    assert!(
        branches
            .iter()
            .all(|b| b.origin.as_ref() == Some(&package.revision.id))
    );
    args.plugin = PluginId::new("example.absent").unwrap();
    args.after = None;
    assert!(reader.branches(&args).unwrap().branches.is_empty());
    assert_eq!(inventory(&repo), before);
}

#[test]
fn source_digest_checks_include_bytes_outside_the_requested_chunk() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let path = PackagePath::new("data.bin").unwrap();
    let file = &package.revision.files[&path];
    let request = ReadPluginSource {
        revision: package.revision.id.clone(),
        path,
        offset: 0,
        limit: 1,
    };
    let db = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    let mut bytes = STANDARD.decode(&package.blobs[&file.digest]).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    db.execute(
        "UPDATE blobs SET bytes=? WHERE digest=?",
        rusqlite::params![bytes, file.digest.as_str()],
    )
    .unwrap();
    assert!(
        repo.read_source(&request)
            .unwrap_err()
            .to_string()
            .contains("digest")
    );
    db.execute(
        "UPDATE blobs SET bytes=? WHERE digest=?",
        rusqlite::params![b"wrong length".as_slice(), file.digest.as_str()],
    )
    .unwrap();
    assert!(
        repo.read_source(&request)
            .unwrap_err()
            .to_string()
            .contains("length")
    );
}

#[test]
fn checkpoints_preserve_old_artifacts_and_restore_as_a_new_source_only_child() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let branch = repo.create_branch(&package.revision.id, "Editing").unwrap();
    let request = edit(
        &branch,
        &package.revision.id,
        "const text = '编辑 → checkpoint';".as_bytes(),
    );
    let before = inventory(&repo);
    let prepared = repo.prepare_checkpoint(&request).unwrap();
    assert_eq!(inventory(&repo), before);
    assert!(repo.revision(&prepared.revision.id).is_err());
    let checkpoint = repo.checkpoint(&request).unwrap();
    assert_eq!(checkpoint.revision, prepared.revision.id);
    assert_eq!(repo.export(&package.revision.id).unwrap(), package);
    assert!(
        repo.inspect(&checkpoint.revision)
            .unwrap()
            .artifacts
            .is_empty()
    );
    assert!(matches!(
        repo.checkpoint(&request),
        Err(PluginError::Conflict)
    ));
    let mut restore = edit(&branch, &checkpoint.revision, b"unused");
    restore.changes.insert(
        PackagePath::new("main.ts").unwrap(),
        PluginSourceEdit::Copy {
            revision: package.revision.id.clone(),
            path: PackagePath::new("main.ts").unwrap(),
        },
    );
    let restored = repo.checkpoint(&restore).unwrap();
    assert_ne!(restored.revision, package.revision.id);
    assert_eq!(restored.parent, checkpoint.revision);
    let restored_source = repo.revision(&restored.revision).unwrap();
    assert_eq!(restored_source.files, package.revision.files);
    assert!(
        repo.export(&restored.revision)
            .unwrap()
            .artifacts
            .is_empty()
    );
    assert_eq!(
        repo.branches(&ListPluginBranches {
            plugin: package.revision.manifest.id.clone(),
            after: None,
            limit: 10
        })
        .unwrap()
        .branches[0]
            .origin,
        Some(package.revision.id.clone())
    );
    assert!(matches!(
        repo.remove(&package.revision.id),
        Err(PluginError::Referenced(_))
    ));
}

#[test]
fn invalid_edits_and_transaction_failure_leave_no_checkpoint_or_partial_blobs() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let branch = repo.create_branch(&package.revision.id, "Editing").unwrap();
    let before = inventory(&repo);
    let request = edit(&branch, &package.revision.id, b"valid new text");
    let mut invalid = request.clone();
    invalid
        .changes
        .insert(PackagePath::new("plugin.json").unwrap(), put(b"{invalid"));
    assert!(repo.checkpoint(&invalid).is_err());
    let mut manifest = serde_json::to_value(&package.revision.manifest).unwrap();
    manifest["id"] = json!("example.other");
    invalid.changes.insert(
        PackagePath::new("plugin.json").unwrap(),
        put(&serde_json::to_vec(&manifest).unwrap()),
    );
    assert!(repo.checkpoint(&invalid).is_err());
    invalid = request.clone();
    invalid.changes.insert(
        PackagePath::new("data.bin").unwrap(),
        PluginSourceEdit::Remove,
    );
    assert!(repo.checkpoint(&invalid).is_err());
    invalid = request.clone();
    invalid
        .changes
        .insert(PackagePath::new("unlisted.ts").unwrap(), put(b"undeclared"));
    assert!(repo.checkpoint(&invalid).is_err());
    invalid = request.clone();
    invalid.changes.insert(
        PackagePath::new("dist/index.html").unwrap(),
        put(b"artifact"),
    );
    assert!(repo.checkpoint(&invalid).is_err());
    invalid = edit(
        &branch,
        &package.revision.id,
        &vec![0; MAX_SOURCE_EDIT_BYTES + 1],
    );
    assert!(repo.checkpoint(&invalid).is_err());
    invalid = request.clone();
    invalid.changes.insert(
        PackagePath::new("empty").unwrap(),
        PluginSourceEdit::Put {
            content_base64: "bad%%%".into(),
            executable: false,
        },
    );
    assert!(repo.checkpoint(&invalid).is_err());
    // Invalid visual declarations cannot become accepted immutable source revisions.
    manifest = serde_json::to_value(&package.revision.manifest).unwrap();
    manifest["source"]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!("views/canvas.json"));
    invalid = request.clone();
    invalid.changes.insert(
        PackagePath::new("plugin.json").unwrap(),
        put(&serde_json::to_vec(&manifest).unwrap()),
    );
    invalid.changes.insert(PackagePath::new("views/canvas.json").unwrap(),put(br#"{"format_version":1,"root":"missing","nodes":{},"data_sources":{},"components":{}}"#));
    assert!(repo.checkpoint(&invalid).is_err());
    assert_eq!(inventory(&repo), before);
    assert_eq!(repo.branch_head(&branch).unwrap(), package.revision.id);
    let db = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_branch_ref BEFORE INSERT ON revision_refs WHEN NEW.owner_kind='branch' BEGIN SELECT RAISE(FAIL,'reference failure'); END;").unwrap();
    assert!(repo.checkpoint(&request).is_err());
    assert_eq!(inventory(&repo), before);
    assert_eq!(repo.branch_head(&branch).unwrap(), package.revision.id);
    db.execute_batch("DROP TRIGGER fail_branch_ref").unwrap();
    db.execute_batch("CREATE TRIGGER ignore_branch_head BEFORE UPDATE OF head ON branches BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(matches!(
        repo.checkpoint(&request),
        Err(PluginError::Conflict)
    ));
    assert_eq!(inventory(&repo), before);
    assert_eq!(repo.branch_head(&branch).unwrap(), package.revision.id);
    db.execute_batch("DROP TRIGGER ignore_branch_head").unwrap();
    assert!(repo.checkpoint(&request).is_ok());
}

#[test]
fn concurrent_native_writers_only_store_the_winning_child() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let root = temp.path().join("repo");
    let mut repo = PluginRepository::open(&root).unwrap();
    repo.import(&package).unwrap();
    let branch = repo.create_branch(&package.revision.id, "Editing").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
        .into_iter()
        .map(|bytes| {
            let request = edit(&branch, &package.revision.id, bytes);
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut writer = PluginRepository::open(&root).unwrap();
                barrier.wait();
                writer.checkpoint(&request)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(PluginError::Conflict)))
            .count(),
        1
    );
    assert_eq!(inventory(&repo).0, 2);
}

#[test]
fn declared_renames_copy_large_bytes_and_valid_visual_source_without_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture(&temp.path().join("package"));
    let mut repo = PluginRepository::open(&temp.path().join("repo")).unwrap();
    repo.import(&package).unwrap();
    let branch = repo
        .create_branch(&package.revision.id, "Renaming")
        .unwrap();
    let mut manifest = serde_json::to_value(&package.revision.manifest).unwrap();
    manifest["source"]["files"] = json!(["main.ts", "renamed.bin", "empty", "views/canvas.json"]);
    let visual = json!({"format_version":1,"root":"label","nodes":{"label":{"kind":"text","children":[],"properties":{"text":"研究"},"style_tokens":{},"bindings":{},"visible_when":null,"events":{},"component":null}},"data_sources":{},"components":{}});
    let request: CheckpointPlugin = serde_json::from_value(json!({"branch":branch,"expected_head":package.revision.id,"changes":{
        "data.bin":{"kind":"remove"},
        "renamed.bin":{"kind":"copy","revision":package.revision.id,"path":"data.bin"},
        "plugin.json":{"kind":"put","content_base64":STANDARD.encode(serde_json::to_vec(&manifest).unwrap()),"executable":false},
        "views/canvas.json":{"kind":"put","content_base64":STANDARD.encode(serde_json::to_vec(&visual).unwrap()),"executable":false}
    }})).unwrap();
    let saved = repo.checkpoint(&request).unwrap();
    let exported = repo.export(&saved.revision).unwrap();
    let original_file = &package.revision.files[&PackagePath::new("data.bin").unwrap()];
    assert!(original_file.bytes > MAX_SOURCE_EDIT_BYTES as u64);
    assert_eq!(
        &exported.revision.files[&PackagePath::new("renamed.bin").unwrap()],
        original_file
    );
    assert!(exported.artifacts.is_empty());
    assert_eq!(
        exported.blobs[&original_file.digest],
        package.blobs[&original_file.digest]
    );
    validate_archive(&exported).unwrap();
}
